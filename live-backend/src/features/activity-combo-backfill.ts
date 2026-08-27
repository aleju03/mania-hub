/**
 * One-time sweep that refills combo on archived day-best rows.
 *
 * A tracked play listed on a profile shows what the day-best row stored, and
 * `best_max_combo` only started being written on 2026-08-26. Rows older than
 * that read a dash where every other row shows a combo, and the local sources
 * that could have supplied it are spent: `score_events` keeps raw payloads for
 * 14 days, and the board tables carry no combo column at all
 * (`activity-play-details-backfill.ts` already took everything they had).
 *
 * What is left is osu! itself, one call per row, which is affordable exactly
 * once and never on a page load. So this is shaped like the archived-mods
 * sweep beside it: a work list built once, walked by a self-chaining job at a
 * few calls a minute, checkpointed in live_meta, and reported on the admin
 * page's sweeps panel. It shares that sweep's id-space handling and row
 * verification, which is the part that must not be reimplemented.
 *
 * Only rows a profile can actually draw are worth a call, which is a good deal
 * fewer than the rows that lack combo. Three cuts, each measured: one row per
 * (player, map) rather than per day, since the list quotes the best day and
 * nothing else (300k -> 217k); nothing already inside the player's osu! top
 * 200, which renders from osu!'s own payload and has its combo either way
 * (217k -> 184k); and nothing whose keymode no mania table knows, which the
 * list drops before it ever reaches a row (184k -> 177k).
 *
 * What is left is still 177k rows over 4.9k players - 26 days at this sweep's
 * pace - so the list is capped on top of that. Players are taken by pp (the
 * profiles that get opened), each contributing its strongest missing rows (the
 * top of a keymode list is what anyone sees first), with pinned players taken
 * whole and sorted to the front. Everything outside the cap keeps its dash and
 * fills in the day that play is set again.
 */
import { readConfig } from "../config.js";
import type { Db } from "../db.js";
import { exec, json, parseJson } from "../db.js";
import type { JobQueue } from "../jobs/queue.js";
import { logInfo, logWarn, errorContext } from "../logger.js";
import type { OsuApiClient } from "../osu/client.js";
import { nowIso } from "../shared/score.js";
import {
  ACTIVITY_PLAY_DETAIL_SET_SQL,
  fetchVerifiedRowScore,
  readPlayDetailArgs,
  type ActivityRowIdentity,
} from "./activity-mods-backfill.js";
import { clearSupersededPlayDetails } from "./activity.js";
import { whenActivityPlayDetailsBackfilled } from "./activity-play-details-backfill.js";
import { activityMapBestRowOrder, activityMapNotBestRowSql } from "./keymode-pp.js";

export const ACTIVITY_COMBO_BACKFILL_PROGRESS_META_KEY = "activity_combo_backfill_progress:v1";
export const ACTIVITY_COMBO_BACKFILL_DONE_META_KEY = "activity_combo_backfill_done:v1";
export const ACTIVITY_COMBO_BACKFILL_JOB_TYPE = "backfill_activity_combo_sweep";
/** Below the archived-mods sweep, which can move a dan estimate; this one
    fills a display cell, so it yields to everything including that. */
const ACTIVITY_COMBO_BACKFILL_JOB_PRIORITY = -25;
/** 20 rows per link. With the default 150s chain that is ~8 calls/min against
    a 45/min target, and the caller string keeps them in the limiter's job lane
    so a page load or an admin action still preempts them. */
const ACTIVITY_COMBO_BACKFILL_CHUNK = 20;
/** Headroom the cap gets per pinned player, so pinning cannot evict ranked
    rows off the end of the limit. */
const PIN_ROW_ALLOWANCE = 250;

export interface ActivityComboBackfillRow extends ActivityRowIdentity {
  position: number;
  country: string;
  pp: number;
}

export interface ActivityComboBackfillProgress {
  /** Last work-list position processed; the chain walks upward from here. */
  cursor: number;
  /** Rows the sweep reached a verdict on. */
  processed: number;
  /** Rows whose combo (and replay button) were written. */
  filled: number;
  /** Rows osu! 404'd in both id spaces: the score is gone for good. */
  missing: number;
  /** Rows where the score that came back was not the one recorded. */
  mismatched: number;
  updatedAt: string;
}

export async function readActivityComboBackfillProgress(db: Db): Promise<ActivityComboBackfillProgress> {
  const row = (await exec(db, "select value_json from live_meta where key = ? limit 1", [ACTIVITY_COMBO_BACKFILL_PROGRESS_META_KEY])).rows[0];
  const stored = parseJson<Partial<ActivityComboBackfillProgress> | null>(String(row?.value_json ?? ""), null);
  return {
    cursor: countOf(stored?.cursor),
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

async function writeProgress(db: Db, progress: ActivityComboBackfillProgress): Promise<void> {
  const now = nowIso();
  await exec(
    db,
    `insert into live_meta (key, value_json, updated_at) values (?, ?, ?)
     on conflict(key) do update set value_json = excluded.value_json, updated_at = excluded.updated_at`,
    [ACTIVITY_COMBO_BACKFILL_PROGRESS_META_KEY, json({ ...progress, updatedAt: now }), now],
  );
}

/**
 * Build the work list. Idempotent: rebuilding replaces it wholesale, so it is
 * only ever built while the sweep is not mid-flight (the cursor is a position
 * in this exact list, and a reshuffle under it would skip and repeat rows).
 */
export async function buildActivityComboBackfillQueue(db: Db): Promise<number> {
  const config = readConfig();
  const pinned = config.activityComboBackfillPinUsers;
  // `in (null)` is never true, which is exactly the no-pins behaviour.
  const pinnedList = pinned.length > 0 ? pinned.map(() => "?").join(", ") : "null";
  const players = config.activityComboBackfillPlayers;
  const rowsPerPlayer = config.activityComboBackfillRowsPerPlayer;
  await exec(db, "delete from activity_combo_backfill_queue");
  try {
    await buildWindowPlaysTable(db);
    await exec(
      db,
      `insert into activity_combo_backfill_queue (position, country, user_id, day, beatmap_id, score_id, pp)
       with per_map as (
         select m.country, m.user_id, m.day, m.beatmap_id, m.best_score_id score_id, m.best_pp pp,
                m.best_max_combo combo,
                row_number() over (partition by m.user_id, m.beatmap_id order by ${activityMapBestRowOrder("m")}) day_rn
         from player_activity_maps m
         join country_rosters cr on cr.user_id = m.user_id and cr.is_tracked = 1
         where m.best_pp > 0 and m.best_score_id is not null and m.best_score_id > 0
       ),
       eligible as (
         select p.country, p.user_id, p.day, p.beatmap_id, p.score_id, p.pp,
                row_number() over (partition by p.user_id order by p.pp desc, p.beatmap_id) rn
         from per_map p
         left join maps_beatmaps mb on mb.beatmap_id = p.beatmap_id
         left join map_search_index si on si.beatmap_id = p.beatmap_id
         where p.day_rn = 1
           and p.combo is null
           -- Both key-count sources are mania-only, so this is also what keeps
           -- a convert out: the list never lists one either.
           and coalesce(mb.cs, si.key_count) is not null
           and not exists (
             select 1 from ${WINDOW_TABLE} w
             where w.user_id = p.user_id and w.beatmap_id = p.beatmap_id
           )
       ),
       -- Whose profile gets opened is the only thing that makes a dash visible,
       -- and pp is the best proxy the database has for that.
       chosen as (
         select e.user_id from eligible e
         join users u on u.user_id = e.user_id
         where e.rn = 1
         order by coalesce(u.pp, 0) desc, e.user_id
         limit ?
       )
       -- Pinned players sort to the front of the list, not just into it:
       -- pinning somebody is a request to fix their profile now.
       select row_number() over (order by (case when e.user_id in (${pinnedList}) then 0 else 1 end), e.user_id, e.rn),
              e.country, e.user_id, e.day, e.beatmap_id, e.score_id, e.pp
       from eligible e
       where e.user_id in (${pinnedList})
          or (e.user_id in (select user_id from chosen) and e.rn <= ?)
       limit ?`,
      [players, ...pinned, ...pinned, rowsPerPlayer, players * rowsPerPlayer + pinned.length * PIN_ROW_ALLOWANCE],
    );
  } finally {
    await exec(db, `drop table if exists ${WINDOW_TABLE}`).catch(() => {});
  }
  const size = Number((await exec(db, "select count(*) as n from activity_combo_backfill_queue")).rows[0]?.n ?? 0);
  logInfo("activity_combo_backfill_queue_built", { rows: size, players, rows_per_player: rowsPerPlayer, pinned: pinned.length });
  return size;
}

/* Every (player, map) currently inside a player's osu! top 200. Materialised
   and indexed rather than left as a subquery: the beatmap id lives inside the
   stored score payload, so matching it any other way is a json_extract over
   the whole table per row, which does not finish. */
const WINDOW_TABLE = "_activity_combo_window_plays";

async function buildWindowPlaysTable(db: Db): Promise<void> {
  await exec(db, `drop table if exists ${WINDOW_TABLE}`);
  await exec(db, `create table ${WINDOW_TABLE} (user_id integer not null, beatmap_id integer not null)`);
  await exec(
    db,
    `insert into ${WINDOW_TABLE} (user_id, beatmap_id)
     select user_id, json_extract(score_json, '$.beatmap_id') from user_top_scores
     where json_extract(score_json, '$.beatmap_id') is not null`,
  );
  await exec(db, `create index ${WINDOW_TABLE}_lookup on ${WINDOW_TABLE}(user_id, beatmap_id)`);
}

/** Rows still needing a call, in work-list order. A row filled by any other
    path (ordinary ingest re-writing that day) drops out on the join. */
export async function selectActivityComboBackfillRows(db: Db, cursor: number, limit: number): Promise<ActivityComboBackfillRow[]> {
  const rows = (await exec(
    db,
    `select q.position, q.country, q.user_id, q.day, q.beatmap_id, q.score_id, q.pp
     from activity_combo_backfill_queue q
     join player_activity_maps m
       on m.country = q.country and m.user_id = q.user_id and m.day = q.day and m.beatmap_id = q.beatmap_id
     -- The list records the row that was the map's best when it was built. A
     -- better play since then makes that row superseded, and the prune blanks
     -- its combo, which would otherwise read as "still needs a call" and buy a
     -- second copy of the map's details.
     where q.position > ? and m.best_max_combo is null and not ${activityMapNotBestRowSql("m")}
     order by q.position
     limit ?`,
    [cursor, Math.max(1, Math.floor(limit))],
  )).rows;
  return rows.map((row) => ({
    position: Number(row.position),
    country: String(row.country),
    userId: Number(row.user_id),
    day: String(row.day),
    beatmapId: Number(row.beatmap_id),
    scoreId: Number(row.score_id),
    pp: Number(row.pp),
  }));
}

export async function countActivityComboBackfillRemaining(db: Db, cursor: number): Promise<number> {
  const row = (await exec(
    db,
    `select count(*) as n
     from activity_combo_backfill_queue q
     join player_activity_maps m
       on m.country = q.country and m.user_id = q.user_id and m.day = q.day and m.beatmap_id = q.beatmap_id
     where q.position > ? and m.best_max_combo is null and not ${activityMapNotBestRowSql("m")}`,
    [cursor],
  )).rows[0];
  return Number(row?.n ?? 0);
}

export type ActivityComboRowOutcome = "filled" | "missing" | "mismatched";

/** Fetch one row's score and, if it verifies, write the play details it kept. */
export async function backfillActivityComboRow(
  db: Db,
  osu: Pick<OsuApiClient, "getScoreById">,
  row: ActivityComboBackfillRow,
  caller: string,
): Promise<ActivityComboRowOutcome> {
  const found = await fetchVerifiedRowScore(osu, row, caller);
  if (found.outcome !== "filled") return found.outcome;
  const details = readPlayDetailArgs(found.score);
  // A score with no combo in the payload would leave the row exactly as it
  // was, and the cursor would walk past it having spent a call for nothing;
  // that is still the right outcome to record, just not a fill.
  if (details[0] == null) return "mismatched";
  await exec(
    db,
    `update player_activity_maps
     set ${ACTIVITY_PLAY_DETAIL_SET_SQL}, updated_at = ?
     where country = ? and user_id = ? and day = ? and beatmap_id = ?`,
    [...details, nowIso(), row.country, row.userId, row.day, row.beatmapId],
  );
  // Belt to the selection's braces: a better play can land between choosing
  // the row and writing it, and one play per map keeps these columns.
  await clearSupersededPlayDetails(db, row.userId, row.beatmapId);
  return "filled";
}

export interface ActivityComboBackfillChunkResult {
  cursor: number;
  processed: number;
  filled: number;
  missing: number;
  mismatched: number;
  done: boolean;
}

/**
 * One chunk: walk the list in order, write what verifies, and advance the
 * cursor past every row that reached a verdict. A throw mid-chunk carries the
 * rows that did finish, so the retry starts after them rather than re-spending
 * their calls.
 */
export async function runActivityComboBackfillChunk(
  db: Db,
  osu: Pick<OsuApiClient, "getScoreById">,
  options: { cursor: number; limit: number; caller: string },
): Promise<ActivityComboBackfillChunkResult> {
  const rows = await selectActivityComboBackfillRows(db, options.cursor, options.limit);
  let cursor = options.cursor;
  let processed = 0;
  let filled = 0;
  let missing = 0;
  let mismatched = 0;
  for (const row of rows) {
    let outcome: ActivityComboRowOutcome;
    try {
      outcome = await backfillActivityComboRow(db, osu, row, options.caller);
    } catch (error) {
      logWarn("activity_combo_backfill_row_failed", {
        score_id: row.scoreId,
        user_id: row.userId,
        beatmap_id: row.beatmapId,
        ...errorContext(error),
      });
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
        comboPartial: { cursor, processed, filled, missing, mismatched, done: false },
      });
    }
    processed += 1;
    if (outcome === "filled") filled += 1;
    else if (outcome === "missing") missing += 1;
    else mismatched += 1;
    cursor = row.position;
  }
  const done = rows.length < options.limit;
  logInfo("activity_combo_backfill_chunk", { position: cursor, processed, filled, missing, mismatched, done });
  return { cursor, processed, filled, missing, mismatched, done };
}

/** The chunk result a mid-chunk throw carries, or null when the error came
    from somewhere else and says nothing about how far the chunk got. */
export function readComboChunkPartial(error: unknown): ActivityComboBackfillChunkResult | null {
  const partial = (error as { comboPartial?: unknown } | null | undefined)?.comboPartial;
  if (!partial || typeof partial !== "object") return null;
  const candidate = partial as ActivityComboBackfillChunkResult;
  return Number.isSafeInteger(candidate.cursor) && candidate.cursor >= 0 ? candidate : null;
}

async function applyChunkResult(
  db: Db,
  progress: ActivityComboBackfillProgress,
  result: ActivityComboBackfillChunkResult,
): Promise<void> {
  progress.cursor = result.cursor;
  progress.processed += result.processed;
  progress.filled += result.filled;
  progress.missing += result.missing;
  progress.mismatched += result.mismatched;
  await writeProgress(db, progress);
}

/** One chain link: run a chunk, then either write the done key or schedule the
    next link. */
export async function runActivityComboBackfillJob(
  db: Db,
  queue: JobQueue,
  osu: Pick<OsuApiClient, "getScoreById">,
  payload: { cursor?: number } | undefined,
): Promise<void> {
  const progress = await readActivityComboBackfillProgress(db);
  // The payload cursor is the chain's own hand-off; the stored one is the
  // resume point after a restart or a failed link. The stored one wins when it
  // is further along, so a retried link never re-spends calls.
  const payloadCursor = Number(payload?.cursor);
  const cursor = Number.isSafeInteger(payloadCursor) && payloadCursor > progress.cursor ? payloadCursor : progress.cursor;

  let result: ActivityComboBackfillChunkResult;
  try {
    result = await runActivityComboBackfillChunk(db, osu, {
      cursor,
      limit: ACTIVITY_COMBO_BACKFILL_CHUNK,
      caller: `job:${ACTIVITY_COMBO_BACKFILL_JOB_TYPE}`,
    });
  } catch (error) {
    const partial = readComboChunkPartial(error);
    if (partial) await applyChunkResult(db, progress, partial);
    throw error;
  }

  await applyChunkResult(db, progress, result);

  if (result.done) {
    const now = nowIso();
    await exec(
      db,
      "insert or replace into live_meta (key, value_json, updated_at) values (?, ?, ?)",
      [ACTIVITY_COMBO_BACKFILL_DONE_META_KEY, json({
        finishedAt: now,
        processed: progress.processed,
        filled: progress.filled,
        missing: progress.missing,
        mismatched: progress.mismatched,
      }), now],
    );
    logInfo("activity_combo_backfill_done", {
      processed: progress.processed,
      filled: progress.filled,
      missing: progress.missing,
      mismatched: progress.mismatched,
    });
    return;
  }

  await enqueueChunk(queue, result.cursor, new Date(Date.now() + readConfig().activityComboBackfillChainDelayMs));
}

/**
 * Boot watchdog: start the chain once per done-key version and resume it if a
 * link died. A no-op once the done key exists or a link is already pending, so
 * a restart mid-sweep costs nothing and a finished sweep never restarts.
 */
export async function ensureActivityComboBackfillSeeded(db: Db, queue: JobQueue): Promise<void> {
  const done = (await exec(db, "select 1 from live_meta where key = ? limit 1", [ACTIVITY_COMBO_BACKFILL_DONE_META_KEY])).rows[0];
  if (done) return;
  /* The local pass fills rows out of stored payloads for free, and it runs
     detached behind boot. Building the capped list before it lands would spend
     this sweep's limited slots on rows it is about to fill. A no-op once that
     pass has stamped itself done, which is every boot after the first. */
  await whenActivityPlayDetailsBackfilled();
  const pending = (await exec(
    db,
    "select 1 from jobs where type = ? and status in ('queued', 'running', 'failed', 'deferred_pressure') limit 1",
    [ACTIVITY_COMBO_BACKFILL_JOB_TYPE],
  )).rows[0];
  if (pending) return;
  const progress = await readActivityComboBackfillProgress(db);
  const existing = (await exec(db, "select count(*) as n from activity_combo_backfill_queue")).rows[0];
  if (Number(existing?.n ?? 0) === 0) {
    const size = await buildActivityComboBackfillQueue(db);
    if (size === 0) return;
  }
  await enqueueChunk(queue, progress.cursor, new Date());
}

function enqueueChunk(queue: JobQueue, cursor: number, runAfter: Date): Promise<void> {
  return queue.enqueue(
    ACTIVITY_COMBO_BACKFILL_JOB_TYPE,
    `${ACTIVITY_COMBO_BACKFILL_JOB_TYPE}:${cursor}`,
    { cursor },
    { priority: ACTIVITY_COMBO_BACKFILL_JOB_PRIORITY, runAfter, replaceDone: true },
  );
}
