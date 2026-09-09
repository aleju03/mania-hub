import type { Db } from "../db.js";
import { exec, json, parseJson } from "../db.js";
import { getDisplayedRank, getDisplayedTotalScore, getScoreIdentity } from "../shared/score.js";
import type { OscScore, OsuScoreStatistics } from "../shared/types.js";

/** Small enough to retain with a rated play after its raw event expires. */
export interface PlayerSkillScoreDetails {
  statistics: OsuScoreStatistics | null;
  maxCombo: number | null;
  totalScore: number | null;
  rank: string | null;
  scoreUrl: string | null;
}

export function playerSkillScoreDetails(score: OscScore, previous?: PlayerSkillScoreDetails | null): PlayerSkillScoreDetails {
  const totalScore = getDisplayedTotalScore(score);
  return {
    statistics: score.statistics && Object.keys(score.statistics).length > 0 ? score.statistics : previous?.statistics ?? null,
    maxCombo: score.max_combo > 0 ? score.max_combo : previous?.maxCombo ?? null,
    totalScore: totalScore != null && totalScore > 0 ? totalScore : previous?.totalScore ?? null,
    rank: getDisplayedRank(score) || previous?.rank || null,
    // The identity prefers the legacy id, but a modern payload's id belongs
    // to the solo namespace even when the play used the stable client.
    scoreUrl: score.id > 0 && score.type != null
      ? `https://osu.ppy.sh/scores/${score.type === "solo_score" ? "" : "mania/"}${score.id}`
      : previous?.scoreUrl ?? null,
  };
}

interface SkillPlayRef {
  identity: string;
  beatmapId: number;
  score?: PlayerSkillScoreDetails | null;
}

/** Hydrate old skill caches from local records before returning the list. */
export async function loadPlayerSkillScoreDetails(db: Db, userId: number, plays: SkillPlayRef[]): Promise<Map<string, PlayerSkillScoreDetails>> {
  const details = new Map<string, PlayerSkillScoreDetails>();
  const missing = new Map<string, SkillPlayRef>();
  for (const play of plays) {
    if (play.score) details.set(play.identity, play.score);
    else missing.set(play.identity, play);
  }
  if (missing.size === 0) return details;
  const identities = json([...missing.keys()]);
  const ids = json([...missing.keys()].flatMap((identity) => {
    const match = /^official:(\d+)$/.exec(identity);
    return match ? [Number(match[1])] : [];
  }));
  const [events, tops, archived] = await Promise.all([
    exec(db, `select score_json from score_events where user_id = ?
      and score_identity in (select value from json_each(?))`, [userId, identities]),
    exec(db, "select score_json from user_top_scores where user_id = ?", [userId]),
    exec(db, `select beatmap_id, best_score_id, best_solo_score_id, best_statistics_json,
      best_max_combo, best_total_score, best_rank from player_activity_maps
      where user_id = ? and best_score_id in (select value from json_each(?))`, [userId, ids]),
  ]);
  for (const row of [...events.rows, ...tops.rows]) {
    const score = parseJson<OscScore | null>(row.score_json, null);
    if (!score || score.user_id !== userId) continue;
    const identity = getScoreIdentity(score);
    const play = missing.get(identity);
    if (!play || play.beatmapId !== (score.beatmap_id ?? score.beatmap?.id)) continue;
    details.set(identity, playerSkillScoreDetails(score));
  }
  for (const row of archived.rows) {
    const identity = `official:${row.best_score_id}`;
    const play = missing.get(identity);
    if (!play || play.beatmapId !== Number(row.beatmap_id) || details.has(identity)) continue;
    const solo = Number(row.best_solo_score_id);
    details.set(identity, {
      statistics: parseJson<OsuScoreStatistics | null>(row.best_statistics_json, null),
      maxCombo: row.best_max_combo == null ? null : Number(row.best_max_combo),
      totalScore: row.best_total_score == null ? null : Number(row.best_total_score),
      rank: row.best_rank == null ? null : String(row.best_rank),
      // Without the recorded solo id, the old identity cannot establish a
      // URL namespace. Leave it absent instead of linking a different play.
      scoreUrl: solo > 0 ? `https://osu.ppy.sh/scores/${solo}` : null,
    });
  }
  return details;
}
