// Storyboard bundle for the replay viewer: one zip holding the set's root
// .osb (deflated; command text shrinks ~4x) plus every image the storyboard
// references, keyed by normalized path under files/. An empty zip is the
// durable "this set has no storyboard" marker, so cold negative lookups only
// ever hit the mirrors once per set.
//
// The path collector below intentionally parses only element declarations
// (Sprite/Animation) plus [Variables]; command playback lives in the
// frontend's full parser (src/lib/storyboard/).

import type { Config } from "../config.js";
import { logWarn } from "../logger.js";
import { extractBeatmapArchiveStoryboard } from "./beatmap-archive.js";
import { buildStoredZip, type ZipBundleFile } from "./hitsound-bundle.js";
import {
  getCachedBeatmapAudioAsset,
  isBeatmapAudioStorageConfigured,
  readCachedBeatmapAudioAsset,
  uploadBeatmapAudioAsset,
} from "./r2-assets.js";

export const STORYBOARD_BUNDLE_MIME_TYPE = "application/zip";
// Bump when the bundle layout changes; the R2 objects are immutable per name.
export const STORYBOARD_BUNDLE_STORAGE_FILENAME = "storyboard-bundle-v1.zip";
export const STORYBOARD_BUNDLE_OSB_PATH = "storyboard.osb";
export const STORYBOARD_BUNDLE_FILE_PREFIX = "files/";

const BUNDLE_CACHE_TTL = 15 * 60 * 1000;
const BUNDLE_CACHE_MAX_ENTRIES = 4;
const BUNDLE_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const MAX_ANIMATION_FRAMES = 1_000;

export type PreparedStoryboardBundle = {
  buffer: Buffer | null;
  sizeBytes: number;
  publicUrl: string | null;
};

type BundleCacheEntry = {
  expiresAt: number;
  lastAccessedAt: number;
  sizeBytes: number;
  value: PreparedStoryboardBundle;
};

const bundleCache = new Map<string, BundleCacheEntry>();
const bundlePromises = new Map<string, Promise<PreparedStoryboardBundle>>();

export function normalizeStoryboardPath(path: string): string {
  let p = path.trim();
  if (p.length >= 2 && p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
  p = p.replace(/\\/g, "/").toLowerCase();
  while (p.startsWith("./")) p = p.slice(2);
  while (p.startsWith("/")) p = p.slice(1);
  return p;
}

// Comma split that keeps quoted file paths (which may contain commas) intact.
function splitStoryboardLine(line: string): string[] {
  if (!line.includes('"')) return line.split(",");
  const parts: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
    } else if (ch === "," && !inQuotes) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

function* iterateLines(text: string): Generator<string> {
  let start = 0;
  if (text.charCodeAt(0) === 0xfeff) start = 1;
  while (start <= text.length) {
    const nl = text.indexOf("\n", start);
    if (nl === -1) {
      if (start < text.length) yield text.slice(start);
      return;
    }
    yield text.slice(start, nl);
    start = nl + 1;
  }
}

function addAnimationFrames(paths: Set<string>, basePath: string, frameCount: number): void {
  const count = Math.min(Math.max(1, Math.floor(frameCount)), MAX_ANIMATION_FRAMES);
  const dot = basePath.lastIndexOf(".");
  const slash = basePath.lastIndexOf("/");
  const stem = dot > slash ? basePath.slice(0, dot) : basePath;
  const ext = dot > slash ? basePath.slice(dot) : "";
  for (let i = 0; i < count; i++) paths.add(`${stem}${i}${ext}`);
}

// Collects normalized image paths declared by Sprite/Animation events,
// expanding [Variables] and animation frame sequences.
export function collectStoryboardImagePathsFromText(text: string, into: Set<string>): void {
  let section: "events" | "variables" | "other" = "other";
  const variables: [string, string][] = [];
  let variablesSorted = false;

  for (const rawLine of iterateLines(text)) {
    let line = rawLine;
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line.length === 0) continue;

    const first = line.charCodeAt(0);
    if (first === 91 /* [ */) {
      const trimmed = line.trim();
      section = trimmed === "[Events]" ? "events" : trimmed === "[Variables]" ? "variables" : "other";
      continue;
    }
    if (section === "variables") {
      if (first === 36 /* $ */) {
        const eq = line.indexOf("=");
        if (eq > 1) {
          variables.push([line.slice(0, eq).trim(), line.slice(eq + 1).trim()]);
          variablesSorted = false;
        }
      }
      continue;
    }
    if (section !== "events") continue;
    if (first === 32 || first === 95 || (first === 47 && line.charCodeAt(1) === 47)) continue;

    if (variables.length > 0 && line.includes("$")) {
      if (!variablesSorted) {
        variables.sort((a, b) => b[0].length - a[0].length);
        variablesSorted = true;
      }
      for (const [name, value] of variables) {
        if (line.includes(name)) line = line.split(name).join(value);
      }
    }

    const parts = splitStoryboardLine(line);
    const type = parts[0].trim();
    if ((type === "Sprite" || type === "4") && parts.length >= 4) {
      const path = normalizeStoryboardPath(parts[3]);
      if (path) into.add(path);
    } else if ((type === "Animation" || type === "6") && parts.length >= 7) {
      const path = normalizeStoryboardPath(parts[3]);
      const frameCount = parseInt(parts[6], 10);
      if (path && Number.isFinite(frameCount)) addAnimationFrames(into, path, frameCount);
    }
  }
}

export function osuTextHasStoryboardElements(osuText: string): boolean {
  let inEvents = false;
  for (const line of iterateLines(osuText)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) {
      inEvents = trimmed === "[Events]";
      continue;
    }
    if (!inEvents || trimmed.length === 0 || trimmed.startsWith("//")) continue;
    if (
      trimmed.startsWith("Sprite,") ||
      trimmed.startsWith("Animation,") ||
      trimmed.startsWith("4,") ||
      trimmed.startsWith("6,")
    ) {
      return true;
    }
  }
  return false;
}

export function collectStoryboardImagePaths(osbText: string | null, osuTexts: string[]): Set<string> {
  const paths = new Set<string>();
  if (osbText) collectStoryboardImagePathsFromText(osbText, paths);
  for (const osuText of osuTexts) collectStoryboardImagePathsFromText(osuText, paths);
  return paths;
}

export async function getPreparedStoryboardBundle(
  config: Config,
  beatmapsetId: string,
): Promise<PreparedStoryboardBundle> {
  const cacheKey = beatmapsetId;

  const memoryCached = getBundleMemoryCache(cacheKey);
  if (memoryCached) return memoryCached;

  const cachedAsset = await getCachedBeatmapAudioAsset(config, beatmapsetId, STORYBOARD_BUNDLE_STORAGE_FILENAME);
  if (cachedAsset?.publicUrl) {
    return { buffer: null, sizeBytes: cachedAsset.sizeBytes, publicUrl: cachedAsset.publicUrl };
  }
  if (cachedAsset) {
    const object = await readCachedBeatmapAudioAsset(config, beatmapsetId, STORYBOARD_BUNDLE_STORAGE_FILENAME);
    if (object) {
      const value = { buffer: object.buffer, sizeBytes: object.buffer.length, publicUrl: object.publicUrl };
      setBundleMemoryCache(cacheKey, value);
      return value;
    }
  }

  let promise = bundlePromises.get(cacheKey);
  if (!promise) {
    promise = prepareStoryboardBundle(config, beatmapsetId, cacheKey).finally(() => {
      bundlePromises.delete(cacheKey);
    });
    bundlePromises.set(cacheKey, promise);
  }
  return promise;
}

async function prepareStoryboardBundle(
  config: Config,
  beatmapsetId: string,
  cacheKey: string,
): Promise<PreparedStoryboardBundle> {
  const { osbText, images, dropped } = await extractBeatmapArchiveStoryboard(
    beatmapsetId,
    {
      osuTextHasStoryboard: osuTextHasStoryboardElements,
      collectImagePaths: collectStoryboardImagePaths,
    },
    { maxArchiveBytes: config.beatmapArchiveMaxBytes },
  );
  if (dropped > 0) {
    logWarn("storyboard bundle dropped images over caps", {
      beatmapsetId,
      included: images.length,
      dropped,
    });
  }

  const files: ZipBundleFile[] = [];
  if (osbText) {
    files.push({ path: STORYBOARD_BUNDLE_OSB_PATH, data: Buffer.from(osbText, "utf8"), deflate: true });
  }
  for (const image of images) {
    files.push({ path: `${STORYBOARD_BUNDLE_FILE_PREFIX}${image.path}`, data: image.data });
  }
  const buffer = buildStoredZip(files);

  if (isBeatmapAudioStorageConfigured(config)) {
    try {
      const uploaded = await uploadBeatmapAudioAsset(
        config,
        beatmapsetId,
        STORYBOARD_BUNDLE_STORAGE_FILENAME,
        STORYBOARD_BUNDLE_MIME_TYPE,
        buffer,
      );
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

function getBundleMemoryCache(cacheKey: string, now = Date.now()): PreparedStoryboardBundle | null {
  const entry = bundleCache.get(cacheKey);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    bundleCache.delete(cacheKey);
    return null;
  }
  entry.lastAccessedAt = now;
  return entry.value;
}

function setBundleMemoryCache(cacheKey: string, value: PreparedStoryboardBundle, now = Date.now()): void {
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
