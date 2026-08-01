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
import type { ReplayStoryboardData } from "./storyboard/types";

// Matches the live backend's bundle layout (storyboard-bundle.ts).
const BUNDLE_OSB_PATH = "storyboard.osb";
const BUNDLE_FILE_PREFIX = "files/";

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
  signal?: AbortSignal;
}

function getImageMimeType(path: string): string {
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  return "application/octet-stream";
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
  if (!response.ok) return null;
  const bundleBytes = await response.arrayBuffer();
  if (bundleBytes.byteLength === 0) return null;

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
  if (!osbText && images.size === 0) return null;
  return { osbText, images };
}

export async function loadReplayStoryboard(options: LoadReplayStoryboardOptions): Promise<LoadedReplayStoryboard | null> {
  const { beatmapsetId, osuFileContent, signal } = options;
  const osuHasStoryboard = osuFileContent != null && osuFileHasStoryboardElements(osuFileContent);

  let bundle: { osbText: string | null; images: Map<string, Blob> } | null = null;
  if (beatmapsetId != null) {
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

  const parsed = await parseStoryboardTextsAsync(texts);
  if (signal?.aborted || parsed.sprites.length === 0) return null;

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
