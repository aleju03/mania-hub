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
// Fallbacks for configs that predate the env vars (and for test configs that
// only fill in the fields they exercise).
const DEFAULT_BUNDLE_CACHE_MAX_ENTRIES = 6;
const DEFAULT_BUNDLE_CACHE_MAX_BYTES = 100 * 1024 * 1024;
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
  // Sized up front and written in place: concatenating the parts afterwards
  // would hold a second full copy of the bundle (up to ~24 MiB) at once.
  const names = files.map((file) => Buffer.from(file.path, "utf8"));
  let localSize = 0;
  let centralSize = 0;
  for (const [index, file] of files.entries()) {
    localSize += 30 + names[index].length + file.data.length;
    centralSize += 46 + names[index].length;
  }

  const out = Buffer.allocUnsafe(localSize + centralSize + 22);
  let localOffset = 0;
  let centralOffset = localSize;

  for (const [index, file] of files.entries()) {
    const nameBytes = names[index];
    // Flag the name as UTF-8 when it isn't plain ASCII.
    const flags = nameBytes.length === file.path.length ? 0 : 0x800;
    const checksum = crc32(file.data);
    const entryOffset = localOffset;

    out.writeUInt32LE(0x04034b50, localOffset);
    out.writeUInt16LE(20, localOffset + 4); // version needed
    out.writeUInt16LE(flags, localOffset + 6);
    out.writeUInt16LE(0, localOffset + 8); // method: store
    out.writeUInt16LE(0, localOffset + 10); // time
    out.writeUInt16LE(ZIP_DOS_DATE, localOffset + 12);
    out.writeUInt32LE(checksum, localOffset + 14);
    out.writeUInt32LE(file.data.length, localOffset + 18);
    out.writeUInt32LE(file.data.length, localOffset + 22);
    out.writeUInt16LE(nameBytes.length, localOffset + 26);
    out.writeUInt16LE(0, localOffset + 28); // extra length
    localOffset += 30;
    localOffset += nameBytes.copy(out, localOffset);
    localOffset += file.data.copy(out, localOffset);

    out.writeUInt32LE(0x02014b50, centralOffset);
    out.writeUInt16LE(20, centralOffset + 4); // version made by
    out.writeUInt16LE(20, centralOffset + 6); // version needed
    out.writeUInt16LE(flags, centralOffset + 8);
    out.writeUInt16LE(0, centralOffset + 10); // method: store
    out.writeUInt16LE(0, centralOffset + 12); // time
    out.writeUInt16LE(ZIP_DOS_DATE, centralOffset + 14);
    out.writeUInt32LE(checksum, centralOffset + 16);
    out.writeUInt32LE(file.data.length, centralOffset + 20);
    out.writeUInt32LE(file.data.length, centralOffset + 24);
    out.writeUInt16LE(nameBytes.length, centralOffset + 28);
    out.writeUInt16LE(0, centralOffset + 30); // extra length
    out.writeUInt16LE(0, centralOffset + 32); // comment length
    out.writeUInt16LE(0, centralOffset + 34); // disk number
    out.writeUInt16LE(0, centralOffset + 36); // internal attributes
    out.writeUInt32LE(0, centralOffset + 38); // external attributes
    out.writeUInt32LE(entryOffset, centralOffset + 42);
    centralOffset += 46;
    centralOffset += nameBytes.copy(out, centralOffset);
  }

  out.writeUInt32LE(0x06054b50, centralOffset);
  out.writeUInt16LE(0, centralOffset + 4); // disk number
  out.writeUInt16LE(0, centralOffset + 6); // central directory disk
  out.writeUInt16LE(files.length, centralOffset + 8);
  out.writeUInt16LE(files.length, centralOffset + 10);
  out.writeUInt32LE(centralSize, centralOffset + 12);
  out.writeUInt32LE(localSize, centralOffset + 16);
  out.writeUInt16LE(0, centralOffset + 20); // comment length

  return out;
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
      setBundleMemoryCache(config, cacheKey, value);
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
  const { files, dropped } = await extractBeatmapArchiveHitsounds(beatmapsetId, {
    excludeBasename,
    maxTotalBytes: config.hitsoundMaxTotalBytes,
    maxArchiveBytes: config.beatmapArchiveMaxBytes,
  });
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
      if (!uploaded.publicUrl) setBundleMemoryCache(config, cacheKey, value);
      return value;
    } catch {
      // Serve directly if storage has a transient issue; the in-flight dedupe
      // still prevents duplicate archive work.
    }
  }

  const value = { buffer, sizeBytes: buffer.length, publicUrl: null };
  setBundleMemoryCache(config, cacheKey, value);
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

function setBundleMemoryCache(config: Config, cacheKey: string, value: PreparedHitsoundBundle, now = Date.now()): void {
  if (!value.buffer) return;
  bundleCache.set(cacheKey, {
    expiresAt: now + BUNDLE_CACHE_TTL,
    lastAccessedAt: now,
    sizeBytes: value.sizeBytes,
    value,
  });
  pruneBundleMemoryCache(config, now);
}

function pruneBundleMemoryCache(config: Config, now = Date.now()): void {
  const maxEntries = config.hitsoundBundleCacheMaxEntries ?? DEFAULT_BUNDLE_CACHE_MAX_ENTRIES;
  const maxBytes = config.hitsoundBundleCacheMaxBytes ?? DEFAULT_BUNDLE_CACHE_MAX_BYTES;

  for (const [key, entry] of bundleCache.entries()) {
    if (entry.expiresAt <= now) bundleCache.delete(key);
  }

  if (bundleCache.size > maxEntries) {
    const entriesToRemove = [...bundleCache.entries()]
      .sort(([, a], [, b]) => a.lastAccessedAt - b.lastAccessedAt)
      .slice(0, bundleCache.size - maxEntries);
    entriesToRemove.forEach(([key]) => {
      bundleCache.delete(key);
    });
  }

  let totalBytes = [...bundleCache.values()].reduce((sum, entry) => sum + entry.sizeBytes, 0);
  if (totalBytes <= maxBytes) return;

  const entriesByAge = [...bundleCache.entries()]
    .sort(([, a], [, b]) => a.lastAccessedAt - b.lastAccessedAt);
  for (const [key, entry] of entriesByAge) {
    if (totalBytes <= maxBytes) break;
    bundleCache.delete(key);
    totalBytes -= entry.sizeBytes;
  }
}
