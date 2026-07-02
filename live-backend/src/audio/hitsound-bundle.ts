import crypto from "node:crypto";
import type { Config } from "../config.js";
import { logWarn } from "../logger.js";
import { extractBeatmapArchiveHitsounds, type BeatmapArchiveHitsoundFile } from "./beatmap-archive.js";
import {
  getCachedBeatmapAudioAsset,
  isBeatmapAudioStorageConfigured,
  readCachedBeatmapAudioAsset,
  uploadBeatmapAudioAsset,
} from "./r2-assets.js";

export const HITSOUND_BUNDLE_MIME_TYPE = "application/zip";

const BUNDLE_CACHE_TTL = 15 * 60 * 1000;
const BUNDLE_CACHE_MAX_ENTRIES = 6;
const BUNDLE_CACHE_MAX_BYTES = 100 * 1024 * 1024;
// 1980-01-01 in DOS date encoding; zero would be an invalid month/day.
const ZIP_DOS_DATE = (1 << 5) | 1;

export type PreparedHitsoundBundle = {
  buffer: Buffer | null;
  sizeBytes: number;
  publicUrl: string | null;
};

type BundleCacheEntry = {
  expiresAt: number;
  lastAccessedAt: number;
  sizeBytes: number;
  value: PreparedHitsoundBundle;
};

const bundleCache = new Map<string, BundleCacheEntry>();
const bundlePromises = new Map<string, Promise<PreparedHitsoundBundle>>();

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC32_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Store-only (uncompressed) zip: local file headers, central directory, EOCD.
// The entries are already-compressed audio, so deflating them again buys
// nothing. Sizes/counts stay far below any zip64 threshold.
export function buildStoredZip(files: BeatmapArchiveHitsoundFile[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;

  for (const file of files) {
    const nameBytes = Buffer.from(file.path, "utf8");
    // Flag the name as UTF-8 when it isn't plain ASCII.
    const flags = nameBytes.length === file.path.length ? 0 : 0x800;
    const checksum = crc32(file.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(0, 8); // method: store
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(ZIP_DOS_DATE, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(file.data.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    localParts.push(local, nameBytes, file.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(0, 10); // method: store
    central.writeUInt16LE(0, 12); // time
    central.writeUInt16LE(ZIP_DOS_DATE, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(file.data.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30); // extra length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(0, 38); // external attributes
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, nameBytes);

    localOffset += 30 + nameBytes.length + file.data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // central directory disk
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(localOffset, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localParts, centralDirectory, eocd]);
}

// The exclude filter is part of the cached object identity: the same set can
// legitimately be requested with different music filenames (multi-audio sets),
// so each exclusion variant gets its own storage key.
function getBundleStorageFilename(excludeBasename: string | null): string {
  if (!excludeBasename) return "hitsounds-bundle.zip";
  const hash = crypto.createHash("sha1").update(excludeBasename.toLowerCase()).digest("hex").slice(0, 8);
  return `hitsounds-bundle-${hash}.zip`;
}

export async function getPreparedHitsoundBundle(
  config: Config,
  beatmapsetId: string,
  excludeBasename: string | null,
): Promise<PreparedHitsoundBundle> {
  const storageFilename = getBundleStorageFilename(excludeBasename);
  const cacheKey = `${beatmapsetId}:${storageFilename}`;

  const memoryCached = getBundleMemoryCache(cacheKey);
  if (memoryCached) return memoryCached;

  const cachedAsset = await getCachedBeatmapAudioAsset(config, beatmapsetId, storageFilename);
  if (cachedAsset?.publicUrl) {
    return { buffer: null, sizeBytes: cachedAsset.sizeBytes, publicUrl: cachedAsset.publicUrl };
  }
  if (cachedAsset) {
    const object = await readCachedBeatmapAudioAsset(config, beatmapsetId, storageFilename);
    if (object) {
      const value = { buffer: object.buffer, sizeBytes: object.buffer.length, publicUrl: object.publicUrl };
      setBundleMemoryCache(cacheKey, value);
      return value;
    }
  }

  let promise = bundlePromises.get(cacheKey);
  if (!promise) {
    promise = prepareHitsoundBundle(config, beatmapsetId, excludeBasename, storageFilename, cacheKey)
      .finally(() => {
        bundlePromises.delete(cacheKey);
      });
    bundlePromises.set(cacheKey, promise);
  }
  return promise;
}

async function prepareHitsoundBundle(
  config: Config,
  beatmapsetId: string,
  excludeBasename: string | null,
  storageFilename: string,
  cacheKey: string,
): Promise<PreparedHitsoundBundle> {
  const { files, dropped } = await extractBeatmapArchiveHitsounds(beatmapsetId, { excludeBasename });
  if (dropped > 0) {
    logWarn("hitsound bundle dropped entries over caps", {
      beatmapsetId,
      included: files.length,
      dropped,
    });
  }
  const buffer = buildStoredZip(files);

  if (isBeatmapAudioStorageConfigured(config)) {
    try {
      const uploaded = await uploadBeatmapAudioAsset(config, beatmapsetId, storageFilename, HITSOUND_BUNDLE_MIME_TYPE, buffer);
      const value = {
        buffer: uploaded.publicUrl ? null : buffer,
        sizeBytes: buffer.length,
        publicUrl: uploaded.publicUrl,
      };
      if (!uploaded.publicUrl) setBundleMemoryCache(cacheKey, value);
      return value;
    } catch {
      // Serve directly if storage has a transient issue; the in-flight dedupe
      // still prevents duplicate archive work.
    }
  }

  const value = { buffer, sizeBytes: buffer.length, publicUrl: null };
  setBundleMemoryCache(cacheKey, value);
  return value;
}

function getBundleMemoryCache(cacheKey: string, now = Date.now()): PreparedHitsoundBundle | null {
  const entry = bundleCache.get(cacheKey);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    bundleCache.delete(cacheKey);
    return null;
  }
  entry.lastAccessedAt = now;
  return entry.value;
}

function setBundleMemoryCache(cacheKey: string, value: PreparedHitsoundBundle, now = Date.now()): void {
  if (!value.buffer) return;
  bundleCache.set(cacheKey, {
    expiresAt: now + BUNDLE_CACHE_TTL,
    lastAccessedAt: now,
    sizeBytes: value.sizeBytes,
    value,
  });
  pruneBundleMemoryCache(now);
}

function pruneBundleMemoryCache(now = Date.now()): void {
  for (const [key, entry] of bundleCache.entries()) {
    if (entry.expiresAt <= now) bundleCache.delete(key);
  }

  if (bundleCache.size > BUNDLE_CACHE_MAX_ENTRIES) {
    const entriesToRemove = [...bundleCache.entries()]
      .sort(([, a], [, b]) => a.lastAccessedAt - b.lastAccessedAt)
      .slice(0, bundleCache.size - BUNDLE_CACHE_MAX_ENTRIES);
    entriesToRemove.forEach(([key]) => {
      bundleCache.delete(key);
    });
  }

  let totalBytes = [...bundleCache.values()].reduce((sum, entry) => sum + entry.sizeBytes, 0);
  if (totalBytes <= BUNDLE_CACHE_MAX_BYTES) return;

  const entriesByAge = [...bundleCache.entries()]
    .sort(([, a], [, b]) => a.lastAccessedAt - b.lastAccessedAt);
  for (const [key, entry] of entriesByAge) {
    if (totalBytes <= BUNDLE_CACHE_MAX_BYTES) break;
    bundleCache.delete(key);
    totalBytes -= entry.sizeBytes;
  }
}
