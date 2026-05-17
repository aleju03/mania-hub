import { getLiveBackendUrl } from "./live-backend";

export function getBeatmapAudioUrl(beatmapsetId: number | string, filename: string): string {
  const path = `/api/audio?beatmapsetId=${encodeURIComponent(String(beatmapsetId))}&filename=${encodeURIComponent(filename)}`;
  const liveBackendUrl = getLiveBackendUrl();
  return liveBackendUrl ? `${liveBackendUrl}${path}` : path;
}
