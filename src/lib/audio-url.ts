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
