import type { Db } from "../db.js";
import { exec, parseJson } from "../db.js";
import { toLeanTrackerScore } from "../shared/score.js";
import type { LeanTrackerScore, OscScore } from "../shared/types.js";

export async function getTrackerSnapshot(db: Db, country: string, limit: number): Promise<{ country: string; scores: LeanTrackerScore[]; gains: Record<number, number>; fetchedAt: number }> {
  const rows = (await exec(
    db,
    `select score_json from score_events
     where country = ?
     order by ended_at desc
     limit ?`,
    [country, limit],
  )).rows;
  const scores = rows
    .map((row) => parseJson<OscScore | null>(row.score_json, null))
    .filter((score): score is OscScore => !!score?.beatmap && !!score.beatmapset && !!score.user)
    .map(toLeanTrackerScore);
  const gainRows = (await exec(
    db,
    `select score_id, pp_gain from top_play_events
     where country = ? and score_id in (${scores.map(() => "?").join(",") || "null"})`,
    [country, ...scores.map((score) => score.id)],
  )).rows;
  const gains = Object.fromEntries(gainRows.map((row) => [Number(row.score_id), Number(row.pp_gain)]));
  return { country, scores, gains, fetchedAt: Date.now() };
}
