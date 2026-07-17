import {
  beatmapScoreLookupPartialKey,
  beatmapScoreLookupStatusKey,
  sortBeatmapScores
} from "../beatmap-score-progress";
import { setPersistentCache } from "../api";
import type {
  BeatmapScoreLookupStatus,
  OsuScore
} from "../types";
import {
  BEATMAP_SCORE_LOOKUP_STATUS_TTL,
  beatmapScoreLookupLastWriteByKey
} from "./constants";

export function writeBeatmapScoreLookupStatus(
  beatmapId: number,
  country: string,
  status: Omit<BeatmapScoreLookupStatus, "updatedAt">,
  options: { force?: boolean } = {},
): void {
  const key = beatmapScoreLookupStatusKey(beatmapId, country);
  const now = Date.now();
  const last = beatmapScoreLookupLastWriteByKey.get(key) ?? 0;
  if (!options.force && now - last < 350) return;
  beatmapScoreLookupLastWriteByKey.set(key, now);
  // Fire-and-forget: status updates must not block the scan, and a failed
  // write just means the client briefly sees stale status.
  void setPersistentCache(key, { ...status, updatedAt: now }, BEATMAP_SCORE_LOOKUP_STATUS_TTL);
}

export function writePartialBeatmapScores(beatmapId: number, country: string, scores: OsuScore[]): void {
  void setPersistentCache(
    beatmapScoreLookupPartialKey(beatmapId, country),
    sortBeatmapScores(scores),
    BEATMAP_SCORE_LOOKUP_STATUS_TTL,
  );
}

export function clearBeatmapScoreLookupStatus(beatmapId: number, country: string): void {
  const key = beatmapScoreLookupStatusKey(beatmapId, country);
  beatmapScoreLookupLastWriteByKey.delete(key);
  // Overwrite with a 1s-TTL marker so the client's next poll sees it gone.
  void setPersistentCache(key, null, 1000);
}
