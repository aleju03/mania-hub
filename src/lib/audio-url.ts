import { getLiveBackendUrl } from "./live-backend";

export function getBeatmapAudioUrl(beatmapsetId: number | string, filename: string): string {
  const path = `/api/audio?beatmapsetId=${encodeURIComponent(String(beatmapsetId))}&filename=${encodeURIComponent(filename)}`;
  const liveBackendUrl = getLiveBackendUrl();
  return liveBackendUrl ? `${liveBackendUrl}${path}` : path;
}

// Same clip as the public b.ppy.sh set preview, but served through the live
// backend so the browser can route it through a Web Audio analyser (b.ppy.sh
// sends no CORS headers, and a tainted element in an audio graph plays
// silence). Null when no live backend is configured.
export function getPreviewAudioProxyUrl(beatmapsetId: number | string): string | null {
  const liveBackendUrl = getLiveBackendUrl();
  if (!liveBackendUrl) return null;
  return `${liveBackendUrl}/api/preview-audio?beatmapsetId=${encodeURIComponent(String(beatmapsetId))}`;
}

// Zip bundle of the beatmapset's hitsound files; `exclude` keeps the music
// track out of the bundle. Only served by the live backend.
export function getBeatmapHitsoundsUrl(beatmapsetId: number | string, excludeFilename?: string | null): string | null {
  const liveBackendUrl = getLiveBackendUrl();
  if (!liveBackendUrl) return null;
  const exclude = excludeFilename ? `&exclude=${encodeURIComponent(excludeFilename)}` : "";
  return `${liveBackendUrl}/api/hitsounds?beatmapsetId=${encodeURIComponent(String(beatmapsetId))}${exclude}`;
}

// The same-origin, inline variant of an /api/background URL (or a community
// background, which redirects to storage the same way). Anything that
// turns the background into a WebGL texture or a canvas draw (the storyboard
// backdrop, the video exporter) needs the bytes rather than a 302 to signed
// storage. Non-background URLs pass through untouched.
export function getInlineBackgroundUrl(src: string | null): string | null {
  if (!src) return null;
  try {
    const url = new URL(src, window.location.origin);
    const isBackgroundRoute = url.pathname === "/api/background"
      || (url.pathname === "/api/community-beatmap-asset" && url.searchParams.get("kind") === "background");
    if (url.origin === window.location.origin && isBackgroundRoute) {
      url.searchParams.set("inline", "1");
      return `${url.pathname}${url.search}`;
    }
  } catch {
    // Fall through and try the original value.
  }
  return src;
}

// Zip bundle of the beatmapset's storyboard (root .osb plus referenced
// images). Only served by the live backend; an empty zip means no storyboard.
export function getStoryboardBundleUrl(beatmapsetId: number | string): string | null {
  const liveBackendUrl = getLiveBackendUrl();
  if (!liveBackendUrl) return null;
  return `${liveBackendUrl}/api/storyboard?beatmapsetId=${encodeURIComponent(String(beatmapsetId))}`;
}
