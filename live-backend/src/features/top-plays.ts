import type { Db } from "../db.js";
import { exec, json, parseJson } from "../db.js";
import type { JobQueue } from "../jobs/queue.js";
import { calculateApproxPpGainMap, calculateReplacementPpGain, calculateWeightedPp, getScoreTimestamp, nowIso, scoreHasPublicLeaderboard } from "../shared/score.js";
import type { CountryTopPlay, OscScore, ScoreUser } from "../shared/types.js";
import type { LiveEventLog } from "../live/event-log.js";
import type { OsuApiClient } from "../osu/client.js";

const TOP_PLAY_CONFIRMATION_PENDING_MS = 30 * 60_000;

export class TopPlayConfirmationPendingError extends Error {
  constructor(scoreId: number) {
    super(`top play confirmation pending for score ${scoreId}`);
    this.name = "TopPlayConfirmationPendingError";
  }
}

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
  const bestScores = dedupeScoresById(await osu.getUserBestScores(payload.userId, "job:refresh_user_top_scores"));
  const refreshedAt = nowIso();
  await updateUserTopPlayThreshold(db, payload.userId, bestScores, refreshedAt);
  const confirmation = await getTopPlayConfirmationScoreIdCandidates(db, payload);
  const confirmedIndex = bestScores.findIndex((score) => confirmation.ids.has(score.id));
  if (confirmedIndex < 0) {
    if (isFreshScoreEvent(confirmation.latestReceivedAt, refreshedAt)) {
      throw new TopPlayConfirmationPendingError(payload.scoreId);
    }
    return false;
  }
  const score = bestScores[confirmedIndex];
  if (score.pp == null || !score.user) return false;
  const confirmedScoreId = score.id;
  const ppGain = await calculateTopPlayPpGain(osu, bestScores, score);
  await upsertTopPlayUser(db, score.user, refreshedAt);
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

async function upsertTopPlayUser(db: Db, user: ScoreUser, updatedAt: string): Promise<void> {
  await exec(
    db,
    `insert into users (user_id, username, avatar_url, country_code, profile_json, updated_at)
     values (?, ?, ?, ?, ?, ?)
     on conflict(user_id) do update set
       username = excluded.username,
       avatar_url = excluded.avatar_url,
       country_code = excluded.country_code,
       profile_json = excluded.profile_json,
       updated_at = excluded.updated_at`,
    [user.id, user.username, user.avatar_url, user.country_code, json(user), updatedAt],
  );
}

function dedupeScoresById(scores: OscScore[]): OscScore[] {
  const seen = new Set<number>();
  const deduped: OscScore[] = [];
  for (const score of scores) {
    if (score.id == null) {
      deduped.push(score);
      continue;
    }
    if (seen.has(score.id)) continue;
    seen.add(score.id);
    deduped.push(score);
  }
  return deduped;
}

async function updateUserTopPlayThreshold(db: Db, userId: number, bestScores: OscScore[], refreshedAt: string): Promise<void> {
  const positivePps = bestScores
    .map((score) => score.pp)
    .filter((pp): pp is number => typeof pp === "number" && Number.isFinite(pp) && pp > 0);
  const topPlayMinPp = positivePps.length >= 100 ? Math.min(...positivePps) : 0;
  await exec(
    db,
    `update users
     set top_play_min_pp = ?, top_scores_refreshed_at = ?
     where user_id = ?`,
    [topPlayMinPp, refreshedAt, userId],
  );
}

function getTopPlayConfirmationScoreId(score: Pick<OscScore, "id" | "legacy_score_id">): number {
  return score.legacy_score_id != null && score.legacy_score_id > 0 ? score.legacy_score_id : score.id;
}

async function getTopPlayConfirmationScoreIdCandidates(
  db: Db,
  payload: { userId: number; scoreId: number; country: string },
): Promise<{ ids: Set<number>; latestReceivedAt: string | null }> {
  const ids = new Set<number>([payload.scoreId]);
  let latestReceivedAt: string | null = null;
  const rows = (await exec(
    db,
    `select score_id, legacy_score_id, score_json, received_at from score_events
     where (country = ? and user_id = ? and (score_id = ? or legacy_score_id = ?))
        or (country = ? and user_id = ? and score_json like ?)
     limit 5`,
    [payload.country, payload.userId, payload.scoreId, payload.scoreId, payload.country, payload.userId, `%"id":${payload.scoreId}%`],
  )).rows;
  for (const row of rows) {
    const scoreId = Number(row.score_id);
    const legacyScoreId = Number(row.legacy_score_id);
    if (Number.isFinite(scoreId) && scoreId > 0) ids.add(scoreId);
    if (Number.isFinite(legacyScoreId) && legacyScoreId > 0) ids.add(legacyScoreId);
    const score = parseJson<Partial<OscScore> & { best_id?: number | null } | null>(row.score_json, null);
    const jsonScoreId = Number(score?.id);
    const bestScoreId = Number(score?.best_id);
    if (Number.isFinite(jsonScoreId) && jsonScoreId > 0) ids.add(jsonScoreId);
    if (Number.isFinite(bestScoreId) && bestScoreId > 0) ids.add(bestScoreId);
    const receivedAt = row.received_at == null ? null : String(row.received_at);
    if (receivedAt && (!latestReceivedAt || receivedAt > latestReceivedAt)) latestReceivedAt = receivedAt;
  }
  return { ids, latestReceivedAt };
}

function isFreshScoreEvent(receivedAt: string | null, now: string): boolean {
  if (!receivedAt) return false;
  const receivedAtMs = new Date(receivedAt).getTime();
  const nowMs = new Date(now).getTime();
  if (!Number.isFinite(receivedAtMs) || !Number.isFinite(nowMs)) return false;
  return nowMs - receivedAtMs <= TOP_PLAY_CONFIRMATION_PENDING_MS;
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
    `select e.payload_json, u.username, u.avatar_url
     from top_play_events e
     left join users u on u.user_id = e.user_id
     where e.country = ? and e.detected_at >= ?
     order by e.pp desc, e.detected_at desc
     limit 200`,
    [country, cutoff],
  )).rows;
  return {
    popoffs: rows.map(hydrateTopPlayEvent),
    scannedAt: Date.now(),
    window,
  };
}

function hydrateTopPlayEvent(row: Record<string, unknown>): CountryTopPlay {
  const event = parseJson<CountryTopPlay>(row.payload_json, {} as CountryTopPlay);
  const username = row.username == null ? "" : String(row.username);
  const avatarUrl = row.avatar_url == null ? "" : String(row.avatar_url);
  if (!event.user || (!username && !avatarUrl)) return event;

  const user = {
    ...event.user,
    username: username || event.user.username,
    avatar_url: avatarUrl || event.user.avatar_url,
  };
  const scoreUser = event.score?.user
    ? {
        ...event.score.user,
        username: user.username,
        avatar_url: user.avatar_url,
      }
    : event.score?.user;
  return {
    ...event,
    user,
    score: scoreUser ? { ...event.score, user: scoreUser } : event.score,
  };
}
