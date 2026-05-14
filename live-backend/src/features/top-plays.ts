import type { Db } from "../db.js";
import { exec, json, parseJson } from "../db.js";
import type { JobQueue } from "../jobs/queue.js";
import { calculateApproxPpGainMap, calculateReplacementPpGain, calculateWeightedPp, getScoreTimestamp, nowIso, scoreHasPublicLeaderboard } from "../shared/score.js";
import type { CountryTopPlay, OscScore } from "../shared/types.js";
import type { LiveEventLog } from "../live/event-log.js";
import type { OsuApiClient } from "../osu/client.js";

export async function maybeEnqueueTopPlayRefresh(
  db: Db,
  queue: JobQueue,
  country: string,
  score: OscScore,
  marginPp: number,
): Promise<void> {
  if (score.pp == null || score.pp <= 0) return;
  if (!scoreHasPublicLeaderboard(score)) return;
  const row = (await exec(db, "select top_play_min_pp from users where user_id = ?", [score.user_id])).rows[0];
  const threshold = Math.max(0, Number(row?.top_play_min_pp ?? 0) - marginPp);
  if (score.pp >= threshold) {
    const confirmationScoreId = getTopPlayConfirmationScoreId(score);
    await queue.enqueue("refresh_user_top_scores", `top:${score.user_id}:${confirmationScoreId}`, { userId: score.user_id, scoreId: confirmationScoreId, country }, { priority: 50 });
  }
}

export async function confirmTopPlay(
  db: Db,
  events: LiveEventLog,
  osu: Pick<OsuApiClient, "getBeatmapUserScoresAll" | "getUserBestScores">,
  payload: { userId: number; scoreId: number; country: string },
): Promise<boolean> {
  const bestScores = await osu.getUserBestScores(payload.userId, "job:refresh_user_top_scores");
  const refreshedAt = nowIso();
  await exec(db, "delete from user_top_scores where user_id = ?", [payload.userId]);
  for (let index = 0; index < bestScores.length; index++) {
    const score = bestScores[index];
    if (score.id == null || score.pp == null) continue;
    await exec(
      db,
      `insert into user_top_scores (user_id, score_id, position, score_json, pp, weighted_pp, ended_at, refreshed_at)
       values (?, ?, ?, ?, ?, ?, ?, ?)`,
      [payload.userId, score.id, index, json(score), score.pp, calculateWeightedPp(score.pp, index), score.ended_at ?? score.created_at ?? null, refreshedAt],
    );
  }
  const scoreIdCandidates = await getTopPlayConfirmationScoreIdCandidates(db, payload);
  const confirmedIndex = bestScores.findIndex((score) => scoreIdCandidates.has(score.id));
  if (confirmedIndex < 0) return false;
  const score = bestScores[confirmedIndex];
  if (score.pp == null || !score.user) return false;
  const confirmedScoreId = score.id;
  const ppGain = await calculateTopPlayPpGain(osu, bestScores, score);
  const event: CountryTopPlay = {
    user: { id: score.user_id, username: score.user.username, avatar_url: score.user.avatar_url },
    score,
    pp: score.pp,
    weightedPP: calculateWeightedPp(score.pp, confirmedIndex),
    ppGain,
    time: score.ended_at ?? score.created_at ?? refreshedAt,
  };
  const inserted = await exec(
    db,
    `insert or ignore into top_play_events (country, score_id, user_id, pp, weighted_pp, pp_gain, payload_json, detected_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    [payload.country, confirmedScoreId, payload.userId, event.pp, event.weightedPP, event.ppGain, json(event), refreshedAt],
  );
  if (inserted.rowsAffected === 0) return false;
  await events.append("top_play", payload.country, event, `top_play:${payload.country}:${confirmedScoreId}`);
  return true;
}

function getTopPlayConfirmationScoreId(score: Pick<OscScore, "id" | "legacy_score_id">): number {
  return score.legacy_score_id ?? score.id;
}

async function getTopPlayConfirmationScoreIdCandidates(
  db: Db,
  payload: { userId: number; scoreId: number; country: string },
): Promise<Set<number>> {
  const candidates = new Set<number>([payload.scoreId]);
  const rows = (await exec(
    db,
    `select score_id, legacy_score_id from score_events
     where country = ? and user_id = ? and (score_id = ? or legacy_score_id = ?)
     limit 5`,
    [payload.country, payload.userId, payload.scoreId, payload.scoreId],
  )).rows;
  for (const row of rows) {
    const scoreId = Number(row.score_id);
    const legacyScoreId = Number(row.legacy_score_id);
    if (Number.isFinite(scoreId) && scoreId > 0) candidates.add(scoreId);
    if (Number.isFinite(legacyScoreId) && legacyScoreId > 0) candidates.add(legacyScoreId);
  }
  return candidates;
}

async function calculateTopPlayPpGain(
  osu: Pick<OsuApiClient, "getBeatmapUserScoresAll">,
  bestScores: OscScore[],
  score: OscScore,
): Promise<number> {
  const beatmapId = score.beatmap_id ?? score.beatmap?.id;
  if (!beatmapId) return calculateApproxPpGainMap(bestScores)[score.id] ?? 0;

  try {
    const history = await osu.getBeatmapUserScoresAll(beatmapId, score.user_id, "job:refresh_user_top_scores:pp_gain");
    return calculateReplacementPpGain(bestScores, score.id, getPreviousBeatmapBestScore(history, score));
  } catch (error) {
    console.warn("[top-plays] failed to fetch same-beatmap score history for pp gain", {
      beatmapId,
      scoreId: score.id,
      userId: score.user_id,
      error: error instanceof Error ? error.message : String(error),
    });
    return calculateApproxPpGainMap(bestScores)[score.id] ?? 0;
  }
}

function getPreviousBeatmapBestScore(scores: OscScore[], target: OscScore): OscScore | null {
  const targetTimestampMs = new Date(getScoreTimestamp(target)).getTime();
  if (!Number.isFinite(targetTimestampMs) || targetTimestampMs <= 0) return null;

  const olderScores = scores
    .filter((score) => score.id !== target.id)
    .filter((score) => {
      const timestampMs = new Date(getScoreTimestamp(score)).getTime();
      return Number.isFinite(timestampMs) && timestampMs > 0 && timestampMs < targetTimestampMs;
    })
    .filter((score) => score.pp != null && score.pp > 0);

  if (olderScores.length === 0) return null;

  olderScores.sort((a, b) => {
    const ppDiff = (b.pp ?? 0) - (a.pp ?? 0);
    if (ppDiff !== 0) return ppDiff;
    return new Date(getScoreTimestamp(b)).getTime() - new Date(getScoreTimestamp(a)).getTime();
  });

  return olderScores[0];
}

export async function getTopPlaysSnapshot(db: Db, country: string, window: string): Promise<{ popoffs: CountryTopPlay[]; scannedAt: number; window: string }> {
  const windowMs = window === "24h" ? 86_400_000 : window === "3d" ? 259_200_000 : window === "30d" ? 2_592_000_000 : 604_800_000;
  const cutoff = new Date(Date.now() - windowMs).toISOString();
  const rows = (await exec(
    db,
    `select payload_json from top_play_events
     where country = ? and detected_at >= ?
     order by pp desc, detected_at desc
     limit 200`,
    [country, cutoff],
  )).rows;
  return {
    popoffs: rows.map((row) => parseJson<CountryTopPlay>(row.payload_json, {} as CountryTopPlay)),
    scannedAt: Date.now(),
    window,
  };
}
