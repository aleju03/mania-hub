import { fetchWithCacheLock } from "./api";
import { getCommunityBeatmapAssets, getCommunityBeatmapFile } from "./community-beatmap-store";
import { fetchUploadedReplayChartStandIn } from "./uploaded-replay-index";
import type { UploadedReplayChartStandIn } from "./uploaded-replay-payload";

// A bare .osu contribution has no song or background; an indexed map with the
// same notes at the same timing can lend its own (the viewer plays it, the
// upload cards draw its cover). Server-only: it reads R2 and the backend.

const STAND_IN_CACHE_TTL_MS = 30 * 60_000;

// Keyed by checksum, since the community copy for a checksum never changes. A
// backend outage comes back bare null, which the cache treats as a miss, so
// only real answers stick.
export async function lookupChartStandIn(checksum: string, content: string): Promise<UploadedReplayChartStandIn | null> {
  const cached = await fetchWithCacheLock(
    `uploaded-replay-stand-in:v1:${checksum.toLowerCase()}`,
    STAND_IN_CACHE_TTL_MS,
    async (): Promise<{ standIn: UploadedReplayChartStandIn | null } | null> => {
      const standIn = await fetchUploadedReplayChartStandIn(content);
      return standIn === undefined ? null : { standIn };
    },
  );
  return cached?.standIn ?? null;
}

/**
 * What an upload card of a map osu! doesn't know can draw: the background a
 * contributor supplied, else the cover of the stand-in's set. Null stand-in
 * means checked and none found.
 */
export async function resolveUnknownMapCover(checksum: string): Promise<{ communityBackground: boolean; standInBeatmapsetId: number | null }> {
  const assets = await getCommunityBeatmapAssets(checksum).catch(() => null);
  if (assets?.background) return { communityBackground: true, standInBeatmapsetId: null };
  const content = await getCommunityBeatmapFile(checksum).catch(() => null);
  const standIn = content ? await lookupChartStandIn(checksum, content).catch(() => null) : null;
  return { communityBackground: false, standInBeatmapsetId: standIn?.beatmapsetId ?? null };
}
