import {
  getModDisplayList,
  getScoreDisplayValues,
  getScoreTimestamp
} from "../score";
import type {
  LeanHomeScore,
  LeanRankingEntry,
  OsuGradeCounts,
  OsuScore,
  OsuUser
} from "../types";

// Raw shape returned by the osu! API's /rankings endpoint. We never expose
// this off of the server — `getRankings` trims each user down to
// `LeanRankingEntry` before responding or caching.
export interface RawRankingsResponse {
  cursor: { page: number } | null;
  ranking: Array<{
    user: OsuUser;
    hit_accuracy: number;
    play_count: number;
    pp: number;
    global_rank: number;
    ranked_score: number;
    grade_counts: OsuGradeCounts;
  }>;
  total: number;
}

export function toLeanRankingEntry(raw: RawRankingsResponse["ranking"][number]): LeanRankingEntry {
  return {
    user: {
      id: raw.user.id,
      username: raw.user.username,
      avatar_url: raw.user.avatar_url,
      cover_url: raw.user.cover?.url ?? raw.user.cover_url ?? "",
      country_code: raw.user.country_code,
      is_online: raw.user.is_online,
      is_active: raw.user.is_active,
    },
    hit_accuracy: raw.hit_accuracy,
    play_count: raw.play_count,
    pp: raw.pp,
    global_rank: raw.global_rank,
    ranked_score: raw.ranked_score,
    grade_counts: raw.grade_counts,
  };
}

export function toLeanHomeScore(
  score: OsuScore,
  fallbackUser?: { id?: number; username?: string; avatar_url?: string },
): LeanHomeScore {
  const display = getScoreDisplayValues(score);
  const user = {
    id: score.user?.id ?? fallbackUser?.id ?? score.user_id,
    username: score.user?.username ?? fallbackUser?.username ?? "Unknown",
    avatar_url: score.user?.avatar_url ?? fallbackUser?.avatar_url ?? "",
  };
  return {
    id: score.id,
    pp: score.pp,
    displayAcc: display.accuracy,
    displayRank: display.rank,
    isLazer: display.isLazer,
    mods: getModDisplayList(score.mods),
    timestamp: getScoreTimestamp(score),
    title: score.beatmapset?.title ?? "",
    version: score.beatmap?.version ?? "",
    keyCount: Number(score.beatmap?.cs) || 0,
    beatmapsetId: score.beatmapset?.id,
    user,
  };
}
