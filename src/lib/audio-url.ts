import { getLiveBackendUrl } from "./live-backend";

export function getBeatmapAudioUrl(beatmapsetId: number | string, filename: string): string {
  const path = `/api/audio?beatmapsetId=${encodeURIComponent(String(beatmapsetId))}&filename=${encodeURIComponent(filename)}`;
  const liveBackendUrl = getLiveBackendUrl();
  return liveBackendUrl ? `${liveBackendUrl}${path}` : path;
}

// Zip bundle of the beatmapset's hitsound files; `exclude` keeps the music
// track out of the bundle. Only served by the live backend.
export function getBeatmapHitsoundsUrl(beatmapsetId: number | string, excludeFilename?: string | null): string | null {
  const liveBackendUrl = getLiveBackendUrl();
  if (!liveBackendUrl) return null;
  const exclude = excludeFilename ? `&exclude=${encodeURIComponent(excludeFilename)}` : "";
  return `${liveBackendUrl}/api/hitsounds?beatmapsetId=${encodeURIComponent(String(beatmapsetId))}${exclude}`;
}
