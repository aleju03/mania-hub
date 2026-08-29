import { readConfig } from "../config.js";
import type { Db } from "../db.js";
import { exec, json, parseJson } from "../db.js";
import type { JobQueue } from "../jobs/queue.js";
import { logInfo, logWarn, errorContext } from "../logger.js";
import { OsuApiError, type OsuApiClient } from "../osu/client.js";
import { getDisplayedTotalScore, getScoreTimestamp, nowIso } from "../shared/score.js";
import { clearSupersededPlayDetails } from "./activity.js";

// ── One-time archived-mods backfill ──────────────────────────────────────────
// player_activity_maps rows written before best_mods_json/best_statistics_json
// shipped (2026-07-20) kept the day-best accuracy and score id but lost the
// mods and the judgement counts. loadArchivedTrackedEvidence refuses to rate
// those rows at any rate - assuming 1.0x would credit an HT/DC original's
// accuracy against the full-speed chart - so every pre-2026-07-20 archived
// clear is invisible to the player dan estimate. Most dan practice packs are
// unranked, which makes archived day-bests the only path those clears ever
// had, so the hole lands squarely on the players who grind dan charts.
//
// The osu! API still serves those scores by id (including on graveyard sets:
// they carry preserve=true as the user's day best), and the response has both
// missing fields. This sweep walks the rows worth recovering and refills them.
//
// Ordered by the chart's dan rating descending, so if the run is stopped early
// the rows that can actually move an estimate are the ones already done.

/**
 * The two osu! score id spaces overlap: 661735936 resolves on BOTH
 * /scores/mania/{id} (a 2026 mania play) and /scores/{id} (an unrelated 2018
 * osu! play), and neither route 404s on the wrong one. Every fetched score is
 * therefore checked against the row that asked for it, and a mismatch is
 * discarded rather than written - a wrong write here would attribute another
 * player's mods to this one's clear. The observed split is clean (legacy ids
 * ~6.6e8, solo ids ~6.8e9+), so the guess below is right nearly always and the
 * other space is only tried when verification rejects the first answer.
 */
export const SOLO_SCORE_ID_FLOOR = 4_000_000_000;

export const ACTIVITY_MODS_BACKFILL_PROGRESS_META_KEY = "activity_mods_backfill_progress:v1";
export const ACTIVITY_MODS_BACKFILL_DONE_META_KEY = "activity_mods_backfill_done:v1";
/** Clear bar a row must already meet to be worth a call; the maintenance
 *  script's --min-accuracy default and what the admin panel counts against. */
export const ACTIVITY_MODS_BACKFILL_MIN_ACCURACY = 0.96;
/** Mirrors READY_RECOMPUTE_TTL_MS in player-skills.ts; kept here to avoid a
 *  cycle between the two modules. */
const PLAYER_SKILL_READY_TTL_MS = 12 * 60 * 60_000;
export const ACTIVITY_MODS_BACKFILL_JOB_TYPE = "backfill_activity_mods_sweep";
/** Lowest of the background sweeps: it has the largest scope of any of them
 *  and the least urgency, so anything else queued wins the lane. */
const ACTIVITY_MODS_BACKFILL_JOB_PRIORITY = -20;
// 30 rows per chunk on a 2-minute chain is ~15 calls/min. The caller string
// puts every request in the limiter's "job" lane, so a page load or an admin
// action still preempts it.
const ACTIVITY_MODS_BACKFILL_CHUNK = 30;

/**
 * Work-list sizing, and the whole reason this sweep is affordable.
 *
 * A player's dan is the 4th best credited clear, so recovering rows below what
 * they have already demonstrated cannot move it - only their highest-rated
 * unrecovered charts can. And a player only crosses the quorum if at least 4 of
 * their recovered rows verify: measured fill rate is ~67% (27 of 40 on the
 * first live run), so 8 rows yields ~5.4 expected fills and clears the bar with
 * margin, where 4 rows would yield ~2.7 and leave most players short. Half-
 * finished players are worse than uncovered ones - the calls are spent and the
 * dan still does not appear - so this deliberately covers fewer players
 * properly rather than more of them partially.
 *
 * Players are ranked by how far their dan could actually move (their 4th-best
 * eligible chart minus their current estimate), which puts the ones sitting at
 * no estimate at all first. 375 x 8 = 3000 rows, ~4.2k calls, a few hours on
 * the chain.
 */
const ACTIVITY_MODS_BACKFILL_PLAYERS = 375;
const ACTIVITY_MODS_BACKFILL_ROWS_PER_PLAYER = 8;
/** Hard ceiling on the ranked part, enforced on the insert regardless of what
 *  the ranking returns. */
export const ACTIVITY_MODS_BACKFILL_MAX_ROWS = ACTIVITY_MODS_BACKFILL_PLAYERS * ACTIVITY_MODS_BACKFILL_ROWS_PER_PLAYER;
/** Headroom the ceiling gets per pinned player, so pinning somebody cannot
 *  silently evict ranked rows off the end of the limit. */
const ACTIVITY_MODS_BACKFILL_PIN_ROW_ALLOWANCE = 100;

export interface ActivityModsBackfillCursor {
  /** Last work-list position processed; the chain walks upward from here. */
  position: number;
}

export const ACTIVITY_MODS_BACKFILL_START: ActivityModsBackfillCursor = { position: 0 };

export interface ActivityModsBackfillProgress {
  cursor: ActivityModsBackfillCursor;
  /** Rows the sweep reached a verdict on (filled, missing or mismatched). */
  processed: number;
  /** Rows whose mods and statistics were written. */
  filled: number;
  /** Rows the osu! API 404'd - the score was pruned and is unrecoverable. */
  missing: number;
  /** Rows where neither id space returned a score matching the row. */
  mismatched: number;
  updatedAt: string;
}

export async function readActivityModsBackfillProgress(db: Db): Promise<ActivityModsBackfillProgress> {
  const row = (await exec(db, "select value_json from live_meta where key = ? limit 1", [ACTIVITY_MODS_BACKFILL_PROGRESS_META_KEY])).rows[0];
  const stored = parseJson<Partial<ActivityModsBackfillProgress> | null>(String(row?.value_json ?? ""), null);
  const position = Number(stored?.cursor?.position);
  return {
    cursor: { position: Number.isSafeInteger(position) && position > 0 ? position : 0 },
    processed: countOf(stored?.processed),
    filled: countOf(stored?.filled),
    missing: countOf(stored?.missing),
    mismatched: countOf(stored?.mismatched),
    updatedAt: typeof stored?.updatedAt === "string" ? stored.updatedAt : "",
  };
}

function countOf(value: unknown): number {
  const parsed = Math.floor(Number(value ?? 0));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export async function writeActivityModsBackfillProgress(db: Db, progress: ActivityModsBackfillProgress): Promise<void> {
  const now = nowIso();
  await exec(
    db,
    `insert into live_meta (key, value_json, updated_at) values (?, ?, ?)
     on conflict(key) do update set value_json = excluded.value_json, updated_at = excluded.updated_at`,
    [ACTIVITY_MODS_BACKFILL_PROGRESS_META_KEY, json({ ...progress, updatedAt: now }), now],
  );
}

export interface ActivityModsBackfillRow {
  rowid: number;
  country: string;
  userId: number;
  day: string;
  beatmapId: number;
  scoreId: number;
  dan: number;
}

/**
 * Build the work list: the rows the sweep will spend calls on, ranked and
 * hard-capped. Idempotent - rebuilding replaces it wholesale.
 *
 * `eligible` is a row that could ever be dan evidence (mania, at the clear
 * accuracy bar, on a chart the analyzer rated) AND sits at or above what the
 * player has already demonstrated, so recovering it can actually change the
 * estimate. Players below quorum on eligible rows are dropped entirely: four
 * recoveries is the minimum that can form a new verdict, so a player with
 * three can only ever pad a clear count.
 */
export async function buildActivityModsBackfillQueue(db: Db, minAccuracy: number): Promise<number> {
  await exec(db, "delete from activity_mods_backfill_queue");
  const pinned = readConfig().activityModsBackfillPinUsers;
  // `in (null)` is never true, which is exactly the no-pins behaviour.
  const pinnedList = pinned.length > 0 ? pinned.map(() => "?").join(", ") : "null";
  await exec(
    db,
    `insert into activity_mods_backfill_queue (position, country, user_id, day, beatmap_id, score_id, dan)
     with est as (
       select r.user_id,
              max(coalesce(json_extract(md.value, '$.dan.rc.rawDan'), 0)) rc,
              max(coalesce(json_extract(md.value, '$.dan.ln.rawDan'), 0)) ln
       from player_skill_ratings r, json_each(json_extract(r.modes_json, '$.modes')) md
       where r.status = 'ready'
       group by r.user_id
     ),
     eligible as (
       select m.country, m.user_id, m.day, m.beatmap_id, m.best_score_id score_id, a.raw_dan,
              coalesce(min(e.rc, e.ln), 0) current_dan,
              row_number() over (partition by m.user_id order by a.raw_dan desc, m.rowid) rn,
              count(*) over (partition by m.user_id) eligible_count
       from player_activity_maps m
       join beatmaps b on b.beatmap_id = m.beatmap_id and b.mode = 'mania'
       join beatmap_chart_analysis a on a.beatmap_id = m.beatmap_id and a.status = 'ready' and a.raw_dan is not null
       join country_rosters cr on cr.user_id = m.user_id and cr.is_tracked = 1
       left join est e on e.user_id = m.user_id
       where m.best_mods_json is null
         and m.best_score_id is not null and m.best_score_id > 0
         and m.best_accuracy >= ?
         and a.raw_dan >= coalesce(min(e.rc, e.ln), 0) - 0.5
     ),
     -- The 4th-best eligible chart is the ceiling a fresh quorum could reach,
     -- so its distance from the current estimate is the headroom to rank on.
     headroom as (
       select user_id, raw_dan - current_dan gain from eligible where rn = 4 and eligible_count >= 4
     ),
     chosen as (
       select user_id from headroom order by gain desc, user_id limit ?
     )
     select row_number() over (order by e.user_id, e.rn), e.country, e.user_id, e.day, e.beatmap_id, e.score_id, e.raw_dan
     from eligible e
     where (
       -- Pinned players take all their eligible rows; ranked players take the
       -- per-player slice. Pinned rows are extra, not a slot someone else lost.
       e.user_id in (${pinnedList})
       or (e.user_id in (select user_id from chosen) and e.rn <= ?)
     )
     limit ?`,
    [
      minAccuracy,
      ACTIVITY_MODS_BACKFILL_PLAYERS,
      ...pinned,
      ACTIVITY_MODS_BACKFILL_ROWS_PER_PLAYER,
      ACTIVITY_MODS_BACKFILL_MAX_ROWS + pinned.length * ACTIVITY_MODS_BACKFILL_PIN_ROW_ALLOWANCE,
    ],
  );
  const row = (await exec(db, "select count(*) as n from activity_mods_backfill_queue")).rows[0];
  const size = Number(row?.n ?? 0);
  logInfo("activity_mods_backfill_queue_built", { rows: size, players: ACTIVITY_MODS_BACKFILL_PLAYERS, pinned: pinned.length });
  return size;
}

/** Rows still needing a call, in work-list order. Rows already filled by any
 *  other path (a manual --user run, ordinary ingest) drop out on the join. */
export async function selectActivityModsBackfillRows(
  db: Db,
  cursor: ActivityModsBackfillCursor,
  limit: number,
  _minAccuracy: number,
): Promise<ActivityModsBackfillRow[]> {
  const rows = (await exec(
    db,
    `select q.position, q.country, q.user_id, q.day, q.beatmap_id, q.score_id, q.dan
     from activity_mods_backfill_queue q
     join player_activity_maps m
       on m.country = q.country and m.user_id = q.user_id and m.day = q.day and m.beatmap_id = q.beatmap_id
     where q.position > ? and m.best_mods_json is null
     order by q.position
     limit ?`,
    [cursor.position, Math.max(1, Math.floor(limit))],
  )).rows;
  return rows.map((row) => ({
    rowid: Number(row.position),
    country: String(row.country),
    userId: Number(row.user_id),
    day: String(row.day),
    beatmapId: Number(row.beatmap_id),
    scoreId: Number(row.score_id),
    dan: Number(row.dan),
  }));
}

export async function countActivityModsBackfillRemaining(
  db: Db,
  cursor: ActivityModsBackfillCursor,
  _minAccuracy: number,
): Promise<number> {
  const row = (await exec(
    db,
    `select count(*) as n
     from activity_mods_backfill_queue q
     join player_activity_maps m
       on m.country = q.country and m.user_id = q.user_id and m.day = q.day and m.beatmap_id = q.beatmap_id
     where q.position > ? and m.best_mods_json is null`,
    [cursor.position],
  )).rows[0];
  return Number(row?.n ?? 0);
}

/** One player's eligible rows, for the maintenance script's --user mode. Not
 *  capped or ranked: an operator asking for one player wants all of them. */
export async function selectActivityModsRowsForUser(
  db: Db,
  userId: number,
  minAccuracy: number,
): Promise<ActivityModsBackfillRow[]> {
  const rows = (await exec(
    db,
    `select m.country, m.user_id, m.day, m.beatmap_id, m.best_score_id, a.raw_dan, m.rowid as rowid
     from player_activity_maps m
     join beatmaps b on b.beatmap_id = m.beatmap_id and b.mode = 'mania'
     join beatmap_chart_analysis a on a.beatmap_id = m.beatmap_id and a.status = 'ready' and a.raw_dan is not null
     where m.user_id = ? and m.best_mods_json is null
       and m.best_score_id is not null and m.best_score_id > 0
       and m.best_accuracy >= ?
     order by a.raw_dan desc`,
    [userId, minAccuracy],
  )).rows;
  return rows.map((row) => ({
    rowid: Number(row.rowid),
    country: String(row.country),
    userId: Number(row.user_id),
    day: String(row.day),
    beatmapId: Number(row.beatmap_id),
    scoreId: Number(row.best_score_id),
    dan: Number(row.raw_dan),
  }));
}

/** Local-day bucketing means the row's day and the score's UTC ended_at can sit
 *  up to a timezone apart, so the window is a day either side rather than equal. */
const DAY_WINDOW_MS = 36 * 60 * 60_000;

/**
 * Does this score actually belong to the row that asked for it?
 *
 * The id-space overlap makes this load-bearing rather than a sanity assert, and
 * every clause earns its place against a real way the wrong score gets here:
 *
 *  - ruleset/user/beatmap catch the observed failure. Asking /scores/{id} with
 *    a legacy id returns HTTP 200 with a stranger's osu!standard score
 *    (662374343 -> user 13117044 on beatmap 232720, where the row wanted user
 *    17013778 on 5269878).
 *  - the id clause catches a score that is about the right player and chart but
 *    is not the one this row recorded. Note it cannot stand alone: in the case
 *    above the foreign score's own `id` DID equal the requested integer.
 *  - the day window catches the only gap the first two leave - the same player's
 *    OTHER attempt on the same chart on a different day, which would otherwise
 *    pass everything and overwrite this day's mods with another day's.
 *
 * Accuracy is deliberately NOT compared: the stored day-best accuracy is the
 * oSC feed's displayed value and legitimately differs in the last decimals from
 * what the API reports, so matching on it would reject good rows.
 */
export type ActivityRowIdentity = Pick<ActivityModsBackfillRow, "userId" | "beatmapId" | "day" | "scoreId">;

export function scoreMatchesRow(score: Record<string, unknown> | null, row: ActivityRowIdentity): boolean {
  if (!score || typeof score !== "object") return false;
  if (Number(score.ruleset_id) !== 3) return false;
  if (Number(score.user_id) !== row.userId) return false;
  if (Number(score.beatmap_id) !== row.beatmapId) return false;
  // The score must BE the one the row recorded, under whichever id space it
  // was stored in (activity.ts prefers legacy_score_id when the score has one).
  if (Number(score.id) !== row.scoreId && Number(score.legacy_score_id) !== row.scoreId) return false;
  const endedAt = Date.parse(String(score.ended_at ?? ""));
  const day = Date.parse(`${row.day}T00:00:00Z`);
  if (!Number.isFinite(endedAt) || !Number.isFinite(day)) return false;
  return Math.abs(endedAt - day) <= DAY_WINDOW_MS;
}

export type ActivityModsRowOutcome = "filled" | "missing" | "mismatched";

/**
 * Fetch one row's score and, if it verifies, write back the two lost fields.
 * `mods: []` is a real value (a genuinely nomod play) and is stored as such -
 * it is the NULL that made the row unrateable, not the absence of mods.
 */
export async function backfillActivityModsRow(
  db: Db,
  osu: Pick<OsuApiClient, "getScoreById">,
  row: ActivityModsBackfillRow,
  caller: string,
): Promise<ActivityModsRowOutcome> {
  const found = await fetchVerifiedRowScore(osu, row, caller);
  if (found.outcome !== "filled") return found.outcome;
  const score = found.score;
  const mods = Array.isArray(score.mods) ? score.mods : [];
  const statistics = score.statistics && typeof score.statistics === "object" ? score.statistics : {};
  await exec(
    db,
    `update player_activity_maps
     set best_mods_json = json(?), best_statistics_json = json(?),
         ${ACTIVITY_PLAY_DETAIL_SET_SQL},
         updated_at = ?
     where country = ? and user_id = ? and day = ? and beatmap_id = ?`,
    [json(mods), json(statistics), ...readPlayDetailArgs(score), nowIso(), row.country, row.userId, row.day, row.beatmapId],
  );
  /* This sweep is ordered by dan rating, so the row it just filled is any day
     of that map, not necessarily the one a profile lists. The play details it
     wrote belong to one play per map, so hand them straight to the same prune
     ingest uses: if this row is not the map's best, they come off again. */
  await clearSupersededPlayDetails(db, row.userId, row.beatmapId);
  return "filled";
}

/**
 * The score a row recorded, fetched and verified, or why it could not be.
 *
 * Both archived sweeps go through this: the id-space overlap above is the
 * subtle part, and one copy of it is the only way both stay right.
 */
export async function fetchVerifiedRowScore(
  osu: Pick<OsuApiClient, "getScoreById">,
  row: ActivityRowIdentity,
  caller: string,
): Promise<{ outcome: "filled"; score: Record<string, unknown> } | { outcome: "missing" | "mismatched" }> {
  const spaces: Array<"solo" | "legacy"> = row.scoreId >= SOLO_SCORE_ID_FLOOR
    ? ["solo", "legacy"]
    : ["legacy", "solo"];
  let sawAnyScore = false;
  for (const space of spaces) {
    let score: Record<string, unknown> | null = null;
    try {
      score = await osu.getScoreById(row.scoreId, space, caller);
    } catch (error) {
      // 404 means this id does not exist in this space; the other space may
      // still hold it. Anything else is transient and belongs to the caller.
      if (error instanceof OsuApiError && error.status === 404) continue;
      throw error;
    }
    sawAnyScore = true;
    if (!scoreMatchesRow(score, row)) continue;
    return { outcome: "filled", score };
  }
  return { outcome: sawAnyScore ? "mismatched" : "missing" };
}

/* What a listed play shows beside its pp. Written by both sweeps because both
   already hold the payload it comes from, and never over a value ingest wrote:
   coalesce keeps whatever the row already knows. */
export const ACTIVITY_PLAY_DETAIL_SET_SQL = `best_max_combo = coalesce(best_max_combo, ?),
         best_has_replay = coalesce(best_has_replay, ?),
         best_solo_score_id = coalesce(best_solo_score_id, ?),
         best_total_score = coalesce(best_total_score, ?),
         best_played_at = coalesce(best_played_at, ?)`;

export type ActivityPlayDetailArgs = [number | null, number | null, number | null, number | null, string | null];

export function readPlayDetailArgs(score: Record<string, unknown>): ActivityPlayDetailArgs {
  const maxCombo = Number(score.max_combo);
  const soloScoreId = Number(score.id);
  const hasReplay = score.has_replay ?? score.replay;
  const playedAt = getScoreTimestamp(score as unknown as Parameters<typeof getScoreTimestamp>[0]);
  return [
    Number.isFinite(maxCombo) && maxCombo >= 0 ? maxCombo : null,
    hasReplay == null ? null : hasReplay ? 1 : 0,
    Number.isSafeInteger(soloScoreId) && soloScoreId > 0 ? soloScoreId : null,
    // Same preference the site displays a score by, so a tracked row's number
    // matches the one a window row shows.
    getDisplayedTotalScore(score as unknown as Parameters<typeof getDisplayedTotalScore>[0]),
    playedAt === "" ? null : playedAt,
  ];
}

/**
 * Force a recompute for players whose archive grew, so the recovered clears
 * reach their dan estimate instead of waiting on the 12h ready TTL and a
 * profile view. Same staleness trick the other player-skill sweeps use.
 */
export async function markPlayerSkillsStale(db: Db, userIds: Iterable<number>, staleComputedAt: string): Promise<number> {
  let marked = 0;
  for (const userId of new Set(userIds)) {
    const result = await exec(
      db,
      `update player_skill_ratings set computed_at = ?, updated_at = ?
       where user_id = ? and status = 'ready' and (computed_at is null or computed_at > ?)`,
      [staleComputedAt, nowIso(), userId, staleComputedAt],
    );
    marked += Number(result.rowsAffected ?? 0) > 0 ? 1 : 0;
  }
  return marked;
}

export interface ActivityModsBackfillChunkResult {
  cursor: ActivityModsBackfillCursor;
  processed: number;
  filled: number;
  missing: number;
  mismatched: number;
  users: number[];
  done: boolean;
}

/**
 * One chunk: fetch each row in dan order, write what verifies, and advance the
 * cursor past every row that reached a verdict. A throw mid-chunk carries the
 * rows that did finish on the error as `partial` (readChunkPartial); a caller
 * that checkpoints it resumes after them instead of re-spending their calls.
 */
export async function runActivityModsBackfillChunk(
  db: Db,
  osu: Pick<OsuApiClient, "getScoreById">,
  options: { cursor: ActivityModsBackfillCursor; limit: number; minAccuracy: number; caller: string },
): Promise<ActivityModsBackfillChunkResult> {
  const rows = await selectActivityModsBackfillRows(db, options.cursor, options.limit, options.minAccuracy);
  let cursor = options.cursor;
  let processed = 0;
  let filled = 0;
  let missing = 0;
  let mismatched = 0;
  const users = new Set<number>();
  for (const row of rows) {
    let outcome: ActivityModsRowOutcome;
    try {
      outcome = await backfillActivityModsRow(db, osu, row, options.caller);
    } catch (error) {
      logWarn("activity_mods_backfill_row_failed", {
        score_id: row.scoreId,
        user_id: row.userId,
        beatmap_id: row.beatmapId,
        ...errorContext(error),
      });
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
        partial: { cursor, processed, filled, missing, mismatched, users: [...users], done: false },
      });
    }
    processed += 1;
    if (outcome === "filled") {
      filled += 1;
      users.add(row.userId);
    } else if (outcome === "missing") {
      missing += 1;
    } else {
      mismatched += 1;
    }
    cursor = { position: row.rowid };
  }
  const done = rows.length < options.limit;
  logInfo("activity_mods_backfill_chunk", {
    position: cursor.position,
    processed,
    filled,
    missing,
    mismatched,
    done,
  });
  return { cursor, processed, filled, missing, mismatched, users: [...users], done };
}


/**
 * The chunk result a mid-chunk throw carries, or null when the error came from
 * somewhere else and says nothing about how far the chunk got.
 */
export function readChunkPartial(error: unknown): ActivityModsBackfillChunkResult | null {
  const partial = (error as { partial?: unknown } | null | undefined)?.partial;
  if (!partial || typeof partial !== "object") return null;
  const candidate = partial as ActivityModsBackfillChunkResult;
  if (!normalizeCursor(candidate.cursor)) return null;
  return candidate;
}

/**
 * Fold a chunk result into the stored progress and start the recomputes its
 * fills earned. Shared by the completed and the mid-chunk-failure paths so a
 * partial chunk checkpoints exactly like a whole one.
 */
async function applyChunkResult(
  db: Db,
  progress: ActivityModsBackfillProgress,
  result: ActivityModsBackfillChunkResult,
): Promise<void> {
  progress.cursor = result.cursor;
  progress.processed += result.processed;
  progress.filled += result.filled;
  progress.missing += result.missing;
  progress.mismatched += result.mismatched;
  await writeActivityModsBackfillProgress(db, progress);

  if (result.users.length > 0) {
    const staleComputedAt = new Date(Date.now() - PLAYER_SKILL_READY_TTL_MS - 60_000).toISOString();
    await markPlayerSkillsStale(db, result.users, staleComputedAt);
  }
}

/**
 * One chain link: run a chunk, mark the players it helped for recompute, then
 * either write the done key or schedule the next link.
 */
export async function runActivityModsBackfillJob(
  db: Db,
  queue: JobQueue,
  osu: Pick<OsuApiClient, "getScoreById">,
  payload: { cursor?: ActivityModsBackfillCursor } | undefined,
): Promise<void> {
  const progress = await readActivityModsBackfillProgress(db);
  // The payload cursor is the chain's own hand-off; the stored one is the
  // resume point after a restart or a failed link. The stored one wins when it
  // is further along, so a retried link never re-spends calls.
  const payloadCursor = normalizeCursor(payload?.cursor);
  const cursor = payloadCursor && isAheadOf(payloadCursor, progress.cursor) ? payloadCursor : progress.cursor;

  let result: ActivityModsBackfillChunkResult;
  try {
    result = await runActivityModsBackfillChunk(db, osu, {
      cursor,
      limit: ACTIVITY_MODS_BACKFILL_CHUNK,
      minAccuracy: ACTIVITY_MODS_BACKFILL_MIN_ACCURACY,
      caller: `job:${ACTIVITY_MODS_BACKFILL_JOB_TYPE}`,
    });
  } catch (error) {
    // The rows this chunk did finish are already paid for. Checkpoint them
    // before the failure reaches the queue's retry, so the next attempt starts
    // after them instead of re-spending up to a chunk's worth of calls.
    const partial = readChunkPartial(error);
    if (partial) await applyChunkResult(db, progress, partial);
    throw error;
  }

  await applyChunkResult(db, progress, result);

  if (result.done) {
    const now = nowIso();
    await exec(
      db,
      "insert or replace into live_meta (key, value_json, updated_at) values (?, ?, ?)",
      [ACTIVITY_MODS_BACKFILL_DONE_META_KEY, json({
        finishedAt: now,
        processed: progress.processed,
        filled: progress.filled,
        missing: progress.missing,
        mismatched: progress.mismatched,
      }), now],
    );
    logInfo("activity_mods_backfill_done", {
      processed: progress.processed,
      filled: progress.filled,
      missing: progress.missing,
      mismatched: progress.mismatched,
    });
    return;
  }

  await enqueueActivityModsBackfillChunk(queue, result.cursor, new Date(Date.now() + chainDelayMs()));
}

/**
 * Boot watchdog: start the chain once per done-key version and resume it if a
 * link died. No-op once the done key exists or a link is already pending, so a
 * restart mid-sweep costs nothing and a finished sweep never restarts.
 */
export async function ensureActivityModsBackfillSeeded(db: Db, queue: JobQueue): Promise<void> {
  const done = (await exec(db, "select 1 from live_meta where key = ? limit 1", [ACTIVITY_MODS_BACKFILL_DONE_META_KEY])).rows[0];
  if (done) return;
  const pending = (await exec(
    db,
    "select 1 from jobs where type = ? and status in ('queued', 'running', 'failed', 'deferred_pressure') limit 1",
    [ACTIVITY_MODS_BACKFILL_JOB_TYPE],
  )).rows[0];
  if (pending) return;
  const progress = await readActivityModsBackfillProgress(db);
  // Built once, on the first boot that finds it empty. Never rebuilt while the
  // sweep is mid-flight: the cursor is a position in this exact list, so a
  // reshuffle underneath it would skip and repeat rows.
  const existing = (await exec(db, "select count(*) as n from activity_mods_backfill_queue")).rows[0];
  if (Number(existing?.n ?? 0) === 0) {
    const size = await buildActivityModsBackfillQueue(db, ACTIVITY_MODS_BACKFILL_MIN_ACCURACY);
    if (size === 0) return;
  }
  await enqueueActivityModsBackfillChunk(queue, progress.cursor, new Date());
}

function enqueueActivityModsBackfillChunk(queue: JobQueue, cursor: ActivityModsBackfillCursor, runAfter: Date): Promise<void> {
  return queue.enqueue(
    ACTIVITY_MODS_BACKFILL_JOB_TYPE,
    `${ACTIVITY_MODS_BACKFILL_JOB_TYPE}:${cursor.position}`,
    { cursor },
    { priority: ACTIVITY_MODS_BACKFILL_JOB_PRIORITY, runAfter, replaceDone: true },
  );
}

function chainDelayMs(): number {
  return readConfig().activityModsBackfillChainDelayMs;
}

function normalizeCursor(cursor: ActivityModsBackfillCursor | undefined): ActivityModsBackfillCursor | null {
  const position = Number(cursor?.position);
  if (!Number.isSafeInteger(position) || position < 0) return null;
  return { position };
}

function isAheadOf(candidate: ActivityModsBackfillCursor, current: ActivityModsBackfillCursor): boolean {
  return candidate.position > current.position;
}
