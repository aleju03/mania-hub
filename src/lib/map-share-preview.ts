import { createServerFn } from "@tanstack/react-start";
import { getServerLiveBackendUrl, isLocalChartId, type LiveMapSearchEntry } from "./live-backend";
import { bridgeAuthHeaders } from "./live-backend-tokens";

/* What a shared /maps?map=<beatmapId> link needs for its embed: enough to name
   the map and point og:image at the set's osu! cover. */
export interface MapSharePreview {
  beatmapsetId: number;
  title: string;
  artist: string;
  creator: string;
  version: string;
  stars: number;
  hasCover: boolean;
}

// osu!'s cover@2x is always 1800x500.
export const MAP_COVER_WIDTH = 1800;
export const MAP_COVER_HEIGHT = 500;

export function mapCoverUrl(beatmapsetId: number): string {
  return `https://assets.ppy.sh/beatmaps/${beatmapsetId}/covers/cover@2x.jpg`;
}

export const fetchMapSharePreview = createServerFn({ method: "GET" })
  .validator((data: { beatmapId: number }) => ({ beatmapId: Math.max(0, Math.floor(Number(data?.beatmapId) || 0)) }))
  .handler(async ({ data }): Promise<MapSharePreview | null> => {
    // Local charts have no osu! set, so no cover to show.
    if (data.beatmapId <= 0 || isLocalChartId(data.beatmapId)) return null;
    const base = getServerLiveBackendUrl();
    if (!base) return null;
    try {
      const response = await fetch(
        `${base}/api/snapshots/map-search-entry?beatmapId=${data.beatmapId}`,
        { headers: bridgeAuthHeaders(), signal: AbortSignal.timeout(3000) },
      );
      if (!response.ok) return null;
      const body = (await response.json()) as { entry?: LiveMapSearchEntry };
      const entry = body.entry;
      if (!entry || !(entry.beatmapsetId > 0)) return null;
      return {
        beatmapsetId: entry.beatmapsetId,
        title: entry.title,
        artist: entry.artist,
        creator: entry.creator,
        version: entry.version,
        stars: entry.stars,
        hasCover: entry.covers != null,
      };
    } catch {
      return null;
    }
  });
