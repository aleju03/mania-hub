import { getModAcronyms, getScoreIdentity, getScoreSpeedBucket, getScoreTimeMs } from "./score";
import type { LeanTrackerScore } from "./types";

// Scores from one multiplayer lobby round land on the same beatmap for every
// player at (nearly) the same moment: the round ends for everyone when the map
// does, and submissions reach osu! within seconds of each other. Clustering
// same-map scores whose end timestamps chain within this window is therefore a
// strong lobby signal; requiring the same speed bucket (DT/HT/normal) filters
// the coincidental case of two players farming the same map at different rates.
export const TRACKER_MULTI_WINDOW_MS = 15_000;

export interface TrackerMultiInfo {
  /** Distinct players in the suspected lobby, including the row's own player. */
  playerCount: number;
  /** Usernames of the other players in the group, ordered by finish time. */
  others: string[];
}

function getScoreBeatmapId(score: LeanTrackerScore): number | null {
  return score.beatmap?.id ?? score.beatmap_id ?? null;
}

/**
 * Detect suspected multiplayer-lobby plays in a tracker score pool.
 * Returns a map keyed by score identity; scores absent from the map are solo.
 */
export function detectTrackerMultis(scores: LeanTrackerScore[]): Map<string, TrackerMultiInfo> {
  // The pool may merge overlapping sources (SSE feed + page snapshots).
  const byIdentity = new Map<string, LeanTrackerScore>();
  for (const score of scores) {
    if (getScoreBeatmapId(score) == null || getScoreTimeMs(score) <= 0) continue;
    byIdentity.set(getScoreIdentity(score), score);
  }

  const byLane = new Map<string, LeanTrackerScore[]>();
  for (const score of byIdentity.values()) {
    const lane = `${getScoreBeatmapId(score)}:${getScoreSpeedBucket(getModAcronyms(score.mods))}`;
    const list = byLane.get(lane);
    if (list) list.push(score);
    else byLane.set(lane, [score]);
  }

  const result = new Map<string, TrackerMultiInfo>();
  for (const list of byLane.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => getScoreTimeMs(a) - getScoreTimeMs(b));
    let clusterStart = 0;
    for (let i = 1; i <= list.length; i++) {
      const gap = i < list.length ? getScoreTimeMs(list[i]) - getScoreTimeMs(list[i - 1]) : Number.POSITIVE_INFINITY;
      if (gap <= TRACKER_MULTI_WINDOW_MS) continue;
      emitCluster(list.slice(clusterStart, i), result);
      clusterStart = i;
    }
  }
  return result;
}

function emitCluster(cluster: LeanTrackerScore[], out: Map<string, TrackerMultiInfo>) {
  const usernamesById = new Map<number, string>();
  for (const score of cluster) {
    if (!usernamesById.has(score.user_id)) {
      usernamesById.set(score.user_id, score.user?.username ?? `user ${score.user_id}`);
    }
  }
  // A lone player retrying the same map in quick succession is not a lobby.
  if (usernamesById.size < 2) return;
  for (const score of cluster) {
    out.set(getScoreIdentity(score), {
      playerCount: usernamesById.size,
      others: [...usernamesById.entries()].filter(([id]) => id !== score.user_id).map(([, name]) => name),
    });
  }
}
