// Loads a beatmapset's storyboard for the replay viewer: fetches the live
// backend's storyboard bundle (root .osb + referenced images), merges any
// storyboard embedded in the diff's own .osu [Events], and compiles it all
// into the renderer's ReplayStoryboardData. Image blobs live as object URLs
// owned by the returned handle; call dispose() when the viewer unmounts.

import { getStoryboardBundleUrl } from "./audio-url";
import {
  normalizeStoryboardPath,
  osuFileHasStoryboardElements,
  parseStoryboardTextsAsync,
} from "./storyboard/parser";
import {
  buildStoryboardHitsoundEvents,
  type StoryboardHitsoundSourceNote,
} from "./storyboard/triggers";
import { SB_LAYER_OVERLAY, type ReplayStoryboardData } from "./storyboard/types";

// Matches the live backend's bundle layout (storyboard-bundle.ts).
const BUNDLE_OSB_PATH = "storyboard.osb";
const BUNDLE_FILE_PREFIX = "files/";
const STORYBOARD_NEGATIVE_CACHE_KEY = "mania-hub-replay-storyboard-negatives-v1";
const STORYBOARD_NEGATIVE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const STORYBOARD_NEGATIVE_CACHE_MAX_ENTRIES = 128;

type StoryboardNegativeCache = Record<string, number>;

export interface LoadedReplayStoryboard {
  data: ReplayStoryboardData;
  spriteCount: number;
  segmentCount: number;
  hasVideo: boolean;
  hasSamples: boolean;
  dispose: () => void;
}

export interface LoadReplayStoryboardOptions {
  beatmapsetId: number | null;
  // Raw .osu text of the watched diff; carries the embedded storyboard (if
  // any) and the WidescreenStoryboard flag.
  osuFileContent: string | null;
  backgroundFilename: string | null;
  // URL the renderer should draw beneath the storyboard when the storyboard
  // does not reference the background image itself.
  backgroundImageUrl: string | null;
  // Parsed chart notes. HitSound-triggered command groups (a jumping sprite
  // keyed to a keysound, a per-column hit flash) fire off these; without them
  // those groups never run.
  notes?: readonly StoryboardHitsoundSourceNote[] | null;
  signal?: AbortSignal;
}

function readStoryboardNegativeCache(): StoryboardNegativeCache {
  if (typeof window === "undefined") return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORYBOARD_NEGATIVE_CACHE_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const entries = Object.entries(parsed as Record<string, unknown>)
      .filter(([key, value]) => /^\d+$/.test(key) && typeof value === "number" && Number.isFinite(value));
    return Object.fromEntries(entries) as StoryboardNegativeCache;
  } catch {
    return {};
  }
}

function writeStoryboardNegativeCache(cache: StoryboardNegativeCache): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORYBOARD_NEGATIVE_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // Availability hints are optional; quota/privacy failures only cost a
    // later empty storyboard request.
  }
}

export function isReplayStoryboardKnownUnavailable(beatmapsetId: number, now = Date.now()): boolean {
  const checkedAt = readStoryboardNegativeCache()[String(beatmapsetId)];
  return typeof checkedAt === "number" && now - checkedAt < STORYBOARD_NEGATIVE_CACHE_TTL_MS;
}

export function rememberReplayStoryboardUnavailable(beatmapsetId: number, now = Date.now()): void {
  const cache = readStoryboardNegativeCache();
  cache[String(beatmapsetId)] = now;
  const entries = Object.entries(cache)
    .filter(([, checkedAt]) => now - checkedAt < STORYBOARD_NEGATIVE_CACHE_TTL_MS)
    .sort(([, a], [, b]) => b - a)
    .slice(0, STORYBOARD_NEGATIVE_CACHE_MAX_ENTRIES);
  writeStoryboardNegativeCache(Object.fromEntries(entries));
}

export function forgetReplayStoryboardUnavailable(beatmapsetId: number): void {
  const cache = readStoryboardNegativeCache();
  if (!(String(beatmapsetId) in cache)) return;
  delete cache[String(beatmapsetId)];
  writeStoryboardNegativeCache(cache);
}

function getImageMimeType(path: string): string {
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  return "application/octet-stream";
}

const MAX_OPACITY_PROBE_BYTES = 4096;
const MAX_OPACITY_PROBE_PIXELS = 64;

async function isTinyOpaqueImage(blob: Blob): Promise<boolean> {
  if (blob.size > MAX_OPACITY_PROBE_BYTES) return false;
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") return false;

  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(blob);
    if (bitmap.width <= 0 || bitmap.height <= 0 || bitmap.width * bitmap.height > MAX_OPACITY_PROBE_PIXELS) return false;
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return false;
    context.drawImage(bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    for (let i = 3; i < pixels.length; i += 4) {
      if (pixels[i] !== 255) return false;
    }
    return true;
  } catch {
    return false;
  } finally {
    bitmap?.close();
  }
}

async function findOpaqueOverlayImagePaths(
  sprites: ReplayStoryboardData["sprites"],
  images: Map<string, Blob>,
): Promise<Set<string>> {
  const overlayPaths = new Set<string>();
  for (const sprite of sprites) {
    if (sprite.layer !== SB_LAYER_OVERLAY) continue;
    if (sprite.framePaths) {
      for (const path of sprite.framePaths) overlayPaths.add(path);
    } else {
      overlayPaths.add(sprite.filePath);
    }
  }

  const opaque = new Set<string>();
  await Promise.all([...overlayPaths].map(async (path) => {
    const blob = images.get(path);
    if (!blob) return;
    // JPEG has no alpha channel by definition. For PNG/WebP pixel textures,
    // decode only tiny files; solid 1x1 sprites are the common storyboard
    // idiom for an opaque screen or playfield cover.
    if (blob.type === "image/jpeg" || await isTinyOpaqueImage(blob)) opaque.add(path);
  }));
  return opaque;
}

export function readWidescreenStoryboardFlag(osuFileContent: string | null): boolean {
  if (!osuFileContent) return true;
  const match = /^WidescreenStoryboard\s*:\s*(\d+)/m.exec(osuFileContent);
  // The flag defaults to 0 in the file format; maps predating it are 4:3.
  return match ? match[1] !== "0" : false;
}

async function fetchStoryboardBundle(
  beatmapsetId: number,
  signal: AbortSignal | undefined,
): Promise<{ osbText: string | null; images: Map<string, Blob> } | null> {
  const url = getStoryboardBundleUrl(beatmapsetId);
  if (!url) return null;

  const response = await fetch(url, { signal });
  if (response.status === 204 || response.headers.get("x-mania-storyboard") === "none") {
    rememberReplayStoryboardUnavailable(beatmapsetId);
    return null;
  }
  if (!response.ok) return null;
  const bundleBytes = await response.arrayBuffer();
  if (bundleBytes.byteLength === 0) {
    rememberReplayStoryboardUnavailable(beatmapsetId);
    return null;
  }

  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(bundleBytes);

  let osbText: string | null = null;
  const images = new Map<string, Blob>();
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    if (entry.name === BUNDLE_OSB_PATH) {
      osbText = await entry.async("string");
    } else if (entry.name.startsWith(BUNDLE_FILE_PREFIX)) {
      const path = entry.name.slice(BUNDLE_FILE_PREFIX.length);
      const bytes = await entry.async("arraybuffer");
      images.set(path, new Blob([bytes], { type: getImageMimeType(path) }));
    }
  }
  if (!osbText && images.size === 0) {
    rememberReplayStoryboardUnavailable(beatmapsetId);
    return null;
  }
  forgetReplayStoryboardUnavailable(beatmapsetId);
  return { osbText, images };
}

export async function loadReplayStoryboard(options: LoadReplayStoryboardOptions): Promise<LoadedReplayStoryboard | null> {
  const { beatmapsetId, osuFileContent, signal } = options;
  const osuHasStoryboard = osuFileContent != null && osuFileHasStoryboardElements(osuFileContent);

  let bundle: { osbText: string | null; images: Map<string, Blob> } | null = null;
  if (beatmapsetId != null && (osuHasStoryboard || !isReplayStoryboardKnownUnavailable(beatmapsetId))) {
    try {
      bundle = await fetchStoryboardBundle(beatmapsetId, signal);
    } catch {
      // No live backend, offline, or a mirror miss. A .osu-embedded
      // storyboard can still render (textures degrade to invisible).
      bundle = null;
    }
  }
  if (signal?.aborted) return null;
  if (!bundle?.osbText && !osuHasStoryboard) return null;

  // .osb first, then the .osu fragment: beatmap-specific elements draw above
  // set-wide ones within the same layer.
  const texts: string[] = [];
  if (bundle?.osbText) texts.push(bundle.osbText);
  if (osuHasStoryboard && osuFileContent) texts.push(osuFileContent);

  const hitsoundEvents = options.notes ? buildStoryboardHitsoundEvents(options.notes) : undefined;
  const parsed = await parseStoryboardTextsAsync(texts, { hitsoundEvents });
  if (signal?.aborted || parsed.sprites.length === 0) return null;

  const opaqueImagePaths = bundle
    ? await findOpaqueOverlayImagePaths(parsed.sprites, bundle.images)
    : new Set<string>();
  if (signal?.aborted) return null;

  const imageUrls = new Map<string, string>();
  if (bundle) {
    for (const path of parsed.referencedPaths) {
      const blob = bundle.images.get(path);
      if (blob) imageUrls.set(path, URL.createObjectURL(blob));
    }
  }
  // Without a single loadable image the storyboard would render as invisible
  // sprites over a black backdrop; the normal background view is better.
  if (imageUrls.size === 0) return null;

  // osu! hides the regular background while the storyboard uses its image.
  const backgroundReferenced =
    options.backgroundFilename != null &&
    parsed.referencedPaths.has(normalizeStoryboardPath(options.backgroundFilename));

  const data: ReplayStoryboardData = {
    sprites: parsed.sprites,
    imageUrls,
    opaqueImagePaths,
    widescreen: readWidescreenStoryboardFlag(osuFileContent),
    backgroundImageUrl: backgroundReferenced ? null : options.backgroundImageUrl,
  };

  let disposed = false;
  return {
    data,
    spriteCount: parsed.sprites.length,
    segmentCount: parsed.segmentCount,
    hasVideo: parsed.videoCount > 0,
    hasSamples: parsed.sampleCount > 0,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const url of imageUrls.values()) URL.revokeObjectURL(url);
      imageUrls.clear();
    },
  };
}
