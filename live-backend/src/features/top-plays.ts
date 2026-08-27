import { countryScopeSql, resolveCountryScope } from "../countries.js";
import type { Db } from "../db.js";
import { exec, json, parseJson } from "../db.js";
import type { JobQueue } from "../jobs/queue.js";
import { calculateApproxPpGainMap, calculateReplacementPpGain, calculateWeightedPp, calculateWeightedPpTotal, getScoreTimestamp, nowIso, scoreHasPublicLeaderboard } from "../shared/score.js";
import { evaluatePpGoals } from "./goals.js";
import { compactScoreForStorage, hydrateScoresDisplayMetadata, persistScoresDisplayMetadata, readStoredUserTopScores, replaceUserTopScores } from "../shared/score-storage.js";
import type { CountryTopPlay, OscScore, ScoreUser } from "../shared/types.js";
import type { LiveEventLog } from "../live/event-log.js";
import type { OsuApiClient } from "../osu/client.js";
import { recordMapsFarmedScore } from "./maps.js";
import { isRankedRosterMember } from "../rosters/country-rosters.js";
import { isUserKnownInactive } from "../user-status.js";

const TOP_PLAY_CONFIRMATION_PENDING_MS = 30 * 60_000;
const TOP_PLAYS_DEFAULT_PAGE_SIZE = 200;
const TOP_PLAYS_MAX_PAGE_SIZE = 200;
const TOP_PLAYS_PP_GAIN_LIMIT = 500;
// Filters and sorts run on the materialized columns (score_time,
// score_beatmap_id, key_count - see migrateTopPlayEventsHotColumns), never on
// json_extract over payload_json: the GLOBAL 30d window is ~60k multi-KB
// payloads and parsing them per request blocked the serving loop for seconds.
// score_time is non-null (backfilled with a detected_at fallback, always set on
// insert), so bare-column predicates keep the score_time indexes usable.
const TOP_PLAY_TIME_EXPR = "e.score_time";

export type TopPlaysSnapshotSort = "recent" | "pp" | "gain";
export type TopPlaysSnapshotDirection = "asc" | "desc";
export type TopPlaysSnapshotKeyFilter = "all" | "4k" | "other";

export interface TopPlaysSnapshotOptions {
  sort?: TopPlaysSnapshotSort;
  dir?: TopPlaysSnapshotDirection;
  keys?: TopPlaysSnapshotKeyFilter;
  page?: number;
  pageSize?: number;
  includePpGains?: boolean;
  userIds?: number[];
}

export interface TopPlaysPpGainSummary {
  id: number;
  username: string;
  avatar_url: string;
  country_code?: string;
  totalGain: number;
}

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
  // Top-play events are a ranking/feed surface: only ranked roster members generate them.
  if (!await isRankedRosterMember(db, country, score.user_id)) return;
  const row = (await exec(db, "select top_play_min_pp from users where user_id = ?", [score.user_id])).rows[0];
  const threshold = Math.max(0, Number(row?.top_play_min_pp ?? 0) - marginPp);
  if (score.pp >= threshold) {
    const confirmationScoreId = getTopPlayConfirmationScoreId(score);
    await queue.enqueue("refresh_user_top_scores", `top:${score.user_id}:${confirmationScoreId}`, { userId: score.user_id, scoreId: confirmationScoreId, country }, { priority: 50 });
  }
}

export interface TopPlayConfirmationBatch {
  queue: Pick<JobQueue, "listPendingByDedupePrefix" | "resolvePending">;
  signal?: AbortSignal;
}

type TopPlayConfirmationOutcome = "confirmed" | "unconfirmed" | "pending";

interface TopPlayScoreWindow {
  bestScores: OscScore[];
  previousTopScores: OscScore[];
  refreshedAt: string;
}

export async function confirmTopPlay(
  db: Db,
  events: LiveEventLog,
  osu: Pick<OsuApiClient, "getBeatmapUserScoresAll" | "getUserBestScores"> & Partial<Pick<OsuApiClient, "getUserBestScoresWindow">>,
  payload: { userId: number; scoreId: number; country: string },
  batch?: TopPlayConfirmationBatch,
): Promise<boolean> {
  if (await isUserKnownInactive(db, payload.userId)) return false;
  const bestScores = dedupeScoresById(await getUserBestScoresForPpGain(osu, payload.userId));
  // The request can outlive an admin wipe. Re-check before the first durable
  // write so an already-running confirmation cannot restore top-score rows.
  if (await isUserKnownInactive(db, payload.userId)) return false;
  const refreshedAt = nowIso();
  // Snapshot the projection before replaceUserTopScores overwrites it: osu!
  // unpreserves (and hides from the score-history endpoint) a same-map best
  // the moment a new score supersedes it, so by confirmation time this stored
  // copy can be the only surviving record of the score the pp gain must be
  // measured against.
  const previousTopScores = await readStoredUserTopScores(db, payload.userId);
  await updateUserTopPlayThreshold(db, payload.userId, bestScores, refreshedAt);
  // The window was fetched anyway, so store it: user_top_scores is what lets
  // cached profile snapshots and pack cards serve this player's best scores
  // without their own osu! API fetch. Persisted before the confirmation
  // checks so even an unconfirmed refresh leaves the projection populated.
  await persistScoresDisplayMetadata(db, bestScores, refreshedAt);
  await replaceUserTopScores(db, payload.userId, bestScores, refreshedAt);
  const window: TopPlayScoreWindow = { bestScores, previousTopScores, refreshedAt };
  const outcome = await confirmTopPlayAgainstWindow(db, events, osu, payload, window);
  // Siblings ride the window this job already paid for; before the pending
  // rethrow so a not-yet-processed primary never starves them.
  await confirmPendingSiblingTopPlays(db, events, osu, payload, window, batch);
  if (outcome === "pending") throw new TopPlayConfirmationPendingError(payload.scoreId);
  return outcome === "confirmed";
}

async function confirmTopPlayAgainstWindow(
  db: Db,
  events: LiveEventLog,
  osu: Pick<OsuApiClient, "getBeatmapUserScoresAll">,
  payload: { userId: number; scoreId: number; country: string },
  window: TopPlayScoreWindow,
): Promise<TopPlayConfirmationOutcome> {
  if (await isUserKnownInactive(db, payload.userId)) return "unconfirmed";
  const { bestScores, previousTopScores, refreshedAt } = window;
  const confirmation = await getTopPlayConfirmationScoreIdCandidates(db, payload);
  const confirmedIndex = bestScores.findIndex((score) => confirmation.ids.has(score.id));
  if (confirmedIndex < 0) {
    if (isFreshScoreEvent(confirmation.latestReceivedAt, refreshedAt)) {
      return "pending";
    }
    return "unconfirmed";
  }
  const score = bestScores[confirmedIndex];
  if (score.pp == null || !score.user) return "unconfirmed";
  const confirmedScoreId = score.id;
  const ppGain = await calculateTopPlayPpGain(osu, bestScores, score, previousTopScores);
  if (await isUserKnownInactive(db, payload.userId)) return "unconfirmed";
  await upsertTopPlayUser(db, score.user, refreshedAt);
  const event: CountryTopPlay = {
    user: { id: score.user_id, username: score.user.username, avatar_url: score.user.avatar_url, country_code: score.user.country_code },
    score,
    pp: score.pp,
    weightedPP: calculateWeightedPp(score.pp, confirmedIndex),
    ppGain,
    time: score.ended_at ?? score.created_at ?? refreshedAt,
  };
  const scoreBeatmapId = readPositiveIntegerField(score.beatmap_id ?? score.beatmap?.id);
  const scoreKeyCount = readPositiveNumberField(score.beatmap?.cs);
  const inserted = await exec(
    db,
    `insert or ignore into top_play_events (country, score_id, user_id, pp, weighted_pp, pp_gain, payload_json, detected_at, score_time, score_beatmap_id, key_count)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [payload.country, confirmedScoreId, payload.userId, event.pp, event.weightedPP, event.ppGain, json(toStoredTopPlayEvent(event)), refreshedAt, event.time, scoreBeatmapId, scoreKeyCount],
  );
  if (inserted.rowsAffected === 0) return "unconfirmed";
  // A fresh top play is what moves overall pp, so this is the natural moment to settle "reach N pp"
  // goals. The weighted top-200 total reflects the new score immediately (and slightly under-counts
  // by omitting bonus pp, so it never completes a goal early); fall back to the stored pp if higher.
  try {
    const observedPp = Math.max(
      Number((await exec(db, "select pp from users where user_id = ?", [payload.userId])).rows[0]?.pp ?? 0),
      calculateWeightedPpTotal(bestScores),
    );
    await evaluatePpGoals(db, events, payload.userId, observedPp, payload.country);
  } catch {
    // never let goal settling block a confirmed top play
  }
  const farmedUpdate = await recordMapsFarmedScore(db, payload.country, score, refreshedAt);
  await events.append("top_play", payload.country, event, `top_play:${payload.country}:${confirmedScoreId}`);
  if (farmedUpdate) {
    await events.append(
      "maps_farmed_update",
      payload.country,
      farmedUpdate,
      `maps_farmed_update:${payload.country}:${confirmedScoreId}`,
    );
  }
  return "confirmed";
}

// One running confirmation absorbs this many pending siblings for the same
// user: they share one best-scores window fetch, so an extra score costs at
// most a pp-gain history call (and none at all once the user has a stored
// projection). Bounded so a burst still finishes well inside the lane
// watchdog even with the token bucket saturated.
const TOP_PLAY_BATCH_SIBLING_LIMIT = 10;

/**
 * Confirm the user's other pending confirmation jobs against the window the
 * primary job already fetched, then mark the absorbed jobs done so they never
 * spend their own osu! API calls. A sibling whose score is not in the window
 * but is still fresh keeps its job: osu! may simply not have processed the
 * score yet, and that retry needs a fresh window. Failures here never fail
 * the primary confirmation - an unabsorbed sibling just runs on its own.
 */
async function confirmPendingSiblingTopPlays(
  db: Db,
  events: LiveEventLog,
  osu: Pick<OsuApiClient, "getBeatmapUserScoresAll">,
  payload: { userId: number; scoreId: number; country: string },
  window: TopPlayScoreWindow,
  batch: TopPlayConfirmationBatch | undefined,
): Promise<void> {
  if (!batch) return;
  let siblings;
  try {
    siblings = await batch.queue.listPendingByDedupePrefix(
      "refresh_user_top_scores",
      `top:${payload.userId}:`,
      TOP_PLAY_BATCH_SIBLING_LIMIT,
    );
  } catch (error) {
    console.warn("[top-plays] failed to list sibling confirmations for batching", {
      userId: payload.userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  for (const job of siblings) {
    if (batch.signal?.aborted) return;
    const sibling = readSiblingConfirmationPayload(job.payload);
    if (!sibling || sibling.userId !== payload.userId || sibling.scoreId === payload.scoreId) continue;
    try {
      const outcome = await confirmTopPlayAgainstWindow(db, events, osu, sibling, window);
      if (outcome === "pending") continue;
      await batch.queue.resolvePending(job.id, `absorbed by top:${payload.userId}:${payload.scoreId}`);
    } catch (error) {
      console.warn("[top-plays] batched sibling confirmation failed; leaving its job pending", {
        userId: sibling.userId,
        scoreId: sibling.scoreId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function readSiblingConfirmationPayload(payload: unknown): { userId: number; scoreId: number; country: string } | null {
  if (payload == null || typeof payload !== "object") return null;
  const { userId, scoreId, country } = payload as { userId?: unknown; scoreId?: unknown; country?: unknown };
  if (typeof userId !== "number" || !Number.isFinite(userId)) return null;
  if (typeof scoreId !== "number" || !Number.isFinite(scoreId)) return null;
  if (typeof country !== "string" || country.length === 0) return null;
  return { userId, scoreId, country };
}

/**
 * Fetch-and-store a user's best-scores window through the same path
 * confirmTopPlay uses (budgeted client, threshold update, display metadata,
 * user_top_scores replacement), without the confirmation/event side. Used by
 * the one-time top-scores backfill sweep to populate the projection for
 * roster members who never had a confirmed top play.
 */
export async function refreshUserTopScoresProjection(
  db: Db,
  osu: Pick<OsuApiClient, "getUserBestScores"> & Partial<Pick<OsuApiClient, "getUserBestScoresWindow">>,
  userId: number,
): Promise<{ scoreCount: number; refreshedAt: string }> {
  const bestScores = dedupeScoresById(await getUserBestScoresForPpGain(osu, userId));
  const refreshedAt = nowIso();
  await updateUserTopPlayThreshold(db, userId, bestScores, refreshedAt);
  await persistScoresDisplayMetadata(db, bestScores, refreshedAt);
  await replaceUserTopScores(db, userId, bestScores, refreshedAt);
  return { scoreCount: bestScores.length, refreshedAt };
}

async function getUserBestScoresForPpGain(
  osu: Pick<OsuApiClient, "getUserBestScores"> & Partial<Pick<OsuApiClient, "getUserBestScoresWindow">>,
  userId: number,
): Promise<OscScore[]> {
  if (osu.getUserBestScoresWindow) {
    return osu.getUserBestScoresWindow(userId, 200, "job:refresh_user_top_scores");
  }
  return osu.getUserBestScores(userId, "job:refresh_user_top_scores");
}

async function upsertTopPlayUser(db: Db, user: ScoreUser, updatedAt: string): Promise<void> {
  await exec(
    db,
    `insert into users (user_id, username, avatar_url, country_code, profile_json, updated_at)
     values (?, ?, ?, ?, ?, ?)
     on conflict(user_id) do update set
       username = excluded.username,
       avatar_url = excluded.avatar_url,
       country_code = coalesce(excluded.country_code, users.country_code),
       profile_json = case
         when json_valid(users.profile_json)
          and json_type(users.profile_json, '$.statistics') is not null
          and not (json_valid(excluded.profile_json) and json_type(excluded.profile_json, '$.statistics') is not null)
         then json_set(
           users.profile_json,
           '$.id', excluded.user_id,
           '$.username', excluded.username,
           '$.avatar_url', excluded.avatar_url,
           '$.country_code', coalesce(excluded.country_code, users.country_code)
         )
         else excluded.profile_json
       end,
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
  previousTopScores: OscScore[],
): Promise<number> {
  const beatmapId = score.beatmap_id ?? score.beatmap?.id;
  if (!beatmapId) return calculateApproxPpGainMap(bestScores)[score.id] ?? 0;

  // The stored projection is the last full best-scores window osu! returned,
  // so it already holds every previous same-map score that can materially move
  // the gain: a same-map best below the top-200 cutoff would enter the
  // hypothetical set at weight 0.95^199, which rounds to nothing. The
  // score-history endpoint adds no information on top of that (it only returns
  // preserved scores, and osu! drops the preserve flag from a same-map best as
  // soon as the new score beats it, so by confirmation time the projection is
  // the better source), so a populated projection skips the API call entirely.
  const storedSameMap = previousTopScores.filter((stored) => (stored.beatmap_id ?? stored.beatmap?.id) === beatmapId);
  if (previousTopScores.length > 0) {
    return calculateReplacementPpGain(bestScores, score.id, getPreviousBeatmapBestScore(storedSameMap, score));
  }

  // No stored projection (a user the backfill sweep has not reached yet): the
  // history endpoint is the only source for a previous same-map best.
  try {
    const history = await osu.getBeatmapUserScoresAll(beatmapId, score.user_id, "job:refresh_user_top_scores:pp_gain");
    return calculateReplacementPpGain(bestScores, score.id, getPreviousBeatmapBestScore(dedupeScoresById(history), score));
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

export async function getTopPlaysSnapshot(db: Db, country: string, window: string, options: TopPlaysSnapshotOptions = {}): Promise<{ popoffs: CountryTopPlay[]; scannedAt: number; window: string; total: number; page: number; pageSize: number; ppGains?: TopPlaysPpGainSummary[] }> {
  const windowMs = window === "24h" ? 86_400_000 : window === "3d" ? 259_200_000 : window === "30d" ? 2_592_000_000 : 604_800_000;
  const cutoff = new Date(Date.now() - windowMs).toISOString();
  const page = Math.max(1, Math.floor(options.page ?? 1));
  const pageSize = Math.max(1, Math.min(TOP_PLAYS_MAX_PAGE_SIZE, Math.floor(options.pageSize ?? TOP_PLAYS_DEFAULT_PAGE_SIZE)));
  const offset = (page - 1) * pageSize;
  // Global aggregates every tracked country's detected top plays; a region
  // narrows to its member countries at read time. The window cuts on
  // score_time (when the play happened), not detected_at, so backfill
  // catch-up after downtime doesn't surface days-old plays under "24 hours".
  const scopeSql = countryScopeSql(resolveCountryScope(country), "e.country");
  const where = scopeSql ? [scopeSql.clause, "e.score_time >= ?"] : ["e.score_time >= ?"];
  where.push("not exists (select 1 from users suppressed where suppressed.user_id = e.user_id and suppressed.is_active = 0)");
  const args: Array<string | number> = scopeSql ? [...scopeSql.args, cutoff] : [cutoff];
  if (options.keys === "4k") {
    where.push("e.key_count = 4");
  } else if (options.keys === "other") {
    where.push("e.key_count is not null", "e.key_count != 4");
  }
  const userIds = (options.userIds ?? [])
    .map((id) => Math.floor(Number(id)))
    .filter((id) => Number.isFinite(id) && id > 0);
  if (userIds.length > 0) {
    where.push(`e.user_id in (${userIds.map(() => "?").join(",")})`);
    args.push(...userIds);
  }
  const whereSql = where.join(" and ");
  const totalRows = (await exec(
    db,
    `select count(*) as count
     from top_play_events e
     where ${whereSql}`,
    args,
  )).rows;
  const rows = (await exec(
    db,
    `select e.payload_json, u.username, u.avatar_url, u.country_code
     from top_play_events e
     left join users u on u.user_id = e.user_id
     where ${whereSql}
     order by ${topPlaysSnapshotOrderBy(options)}
     limit ? offset ?`,
    [...args, pageSize, offset],
  )).rows;
  return {
    popoffs: await hydrateTopPlayEvents(db, rows),
    scannedAt: Date.now(),
    window,
    total: Number(totalRows[0]?.count ?? 0),
    page,
    pageSize,
    ppGains: options.includePpGains ? await getTopPlaysPpGains(db, country, cutoff, options) : undefined,
  };
}

async function getTopPlaysPpGains(db: Db, country: string, cutoff: string, options: TopPlaysSnapshotOptions): Promise<TopPlaysPpGainSummary[]> {
  const scopeSql = countryScopeSql(resolveCountryScope(country), "e.country");
  // With no country predicate SQLite prefers idx_top_play_events_user_pp for
  // the GROUP BY and walks the entire all-time feed, even for a 24h snapshot.
  // GLOBAL must start at the cutoff instead: this covering index reduces the
  // input to the requested window before grouping and keeps pp_gain/user_id off
  // the table's payload pages. Concrete/region scopes already choose the
  // country+time index from their country predicate.
  const eventsSource = scopeSql
    ? "top_play_events e"
    : "top_play_events e indexed by idx_top_play_events_score_time";
  const where = scopeSql
    ? [scopeSql.clause, "e.score_time >= ?", "e.pp_gain >= 0.05"]
    : ["e.score_time >= ?", "e.pp_gain >= 0.05"];
  where.push("not exists (select 1 from users suppressed where suppressed.user_id = e.user_id and suppressed.is_active = 0)");
  const args: Array<string | number> = scopeSql ? [...scopeSql.args, cutoff] : [cutoff];
  if (options.keys === "4k") {
    where.push("e.key_count = 4");
  } else if (options.keys === "other") {
    where.push("e.key_count is not null", "e.key_count != 4");
  }
  // No payload_json here: the users join carries the display fields, and
  // max(payload_json) forced multi-KB string comparisons across the window.
  const rows = (await exec(
    db,
    `select e.user_id, sum(e.pp_gain) as total_gain,
            u.username, u.avatar_url, u.country_code
     from ${eventsSource}
     left join users u on u.user_id = e.user_id
     where ${where.join(" and ")}
     group by e.user_id
     having total_gain >= 0.05
     order by total_gain desc
     limit ${TOP_PLAYS_PP_GAIN_LIMIT}`,
    args,
  )).rows;
  return rows
    .map((row) => hydrateTopPlayPpGain(row))
    .filter((entry): entry is TopPlaysPpGainSummary => entry !== null);
}

// Guarded reads for the materialized columns: compact API beatmap objects can
// omit cs entirely, and a coalesced 0 would poison the 4K/other filters.
function readPositiveIntegerField(value: unknown): number | null {
  const numberValue = Number(value);
  return Number.isInteger(numberValue) && numberValue > 0 ? numberValue : null;
}

function readPositiveNumberField(value: unknown): number | null {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : null;
}

function topPlaysSnapshotOrderBy(options: TopPlaysSnapshotOptions): string {
  const dir = options.dir === "asc" ? "asc" : "desc";
  switch (options.sort) {
    case "recent":
      return `${TOP_PLAY_TIME_EXPR} ${dir}, e.detected_at ${dir}, e.pp desc`;
    case "gain":
      return `e.pp_gain ${dir}, ${TOP_PLAY_TIME_EXPR} desc, e.detected_at desc`;
    case "pp":
    default:
      return `e.pp ${dir}, ${TOP_PLAY_TIME_EXPR} desc, e.detected_at desc`;
  }
}

function toStoredTopPlayEvent(event: CountryTopPlay): CountryTopPlay {
  const { user: _user, score, ...stored } = event;
  return {
    ...stored,
    user: undefined as unknown as CountryTopPlay["user"],
    score: compactScoreForStorage(score),
  };
}

async function hydrateTopPlayEvents(db: Db, rows: Record<string, unknown>[]): Promise<CountryTopPlay[]> {
  const parsed = rows.map((row) => parseJson<CountryTopPlay>(row.payload_json, {} as CountryTopPlay));
  const rawScores = parsed.map((event) => event.score ?? null);
  const hydratedScores = await hydrateScoresDisplayMetadata(db, rawScores.filter((score): score is OscScore => !!score));
  let scoreIndex = 0;
  return rows.map((row, index) => {
    const score = rawScores[index] ? hydratedScores[scoreIndex++] : undefined;
    return hydrateTopPlayEvent(row, parsed[index], score);
  });
}

function hydrateTopPlayEvent(row: Record<string, unknown>, event: CountryTopPlay, hydratedScore?: OscScore): CountryTopPlay {
  const username = row.username == null ? "" : String(row.username);
  const avatarUrl = row.avatar_url == null ? "" : String(row.avatar_url);
  const countryCode = row.country_code == null ? "" : String(row.country_code);
  const eventScore = hydratedScore ?? event.score;
  const eventUser = event.user ?? eventScore?.user;
  if (!eventUser && (!username && !avatarUrl)) return { ...event, score: eventScore };

  const user = {
    id: Number(row.user_id ?? eventUser?.id ?? eventScore?.user_id ?? 0),
    username: username || eventUser?.username || "",
    avatar_url: avatarUrl || eventUser?.avatar_url || "",
    country_code: countryCode || eventUser?.country_code || "",
  };
  const scoreUser = eventScore?.user
    ? {
        ...eventScore.user,
        username: user.username,
        avatar_url: user.avatar_url,
        country_code: user.country_code || eventScore.user.country_code,
      }
    : user.id > 0 ? user : eventScore?.user;
  return {
    ...event,
    user,
    score: scoreUser && eventScore ? { ...eventScore, user: scoreUser } : eventScore,
  };
}

function hydrateTopPlayPpGain(row: Record<string, unknown>): TopPlaysPpGainSummary | null {
  const id = Number(row.user_id);
  const totalGain = Number(row.total_gain ?? 0);
  if (!Number.isFinite(id) || id <= 0 || !Number.isFinite(totalGain) || totalGain < 0.05) return null;
  return {
    id,
    username: row.username == null ? "" : String(row.username),
    avatar_url: row.avatar_url == null ? "" : String(row.avatar_url),
    country_code: row.country_code == null ? "" : String(row.country_code),
    totalGain,
  };
}
