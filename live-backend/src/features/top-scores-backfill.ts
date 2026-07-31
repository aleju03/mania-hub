import type { Db } from "../db.js";
import { exec, json, parseJson } from "../db.js";
import type { JobQueue } from "../jobs/queue.js";
import { logInfo, logWarn, errorContext } from "../logger.js";
import { OsuApiError, type OsuApiClient } from "../osu/client.js";
import { nowIso } from "../shared/score.js";
import { throwIfAborted } from "../shared/abort.js";
import { markUserMissing } from "../users.js";
import { refreshUserTopScoresProjection } from "./top-plays.js";
import { enqueueSkillBaselineIfDue } from "./skill-baseline.js";

// ── One-time top-scores backfill sweep ───────────────────────────────────────
// user_top_scores is only populated when a player's live score triggers a
// refresh_user_top_scores confirmation, so most tracked roster members have no
// stored top-plays projection at all and the skill-baseline sweep (which
// enumerates user_top_scores) cannot see them: the skill percentile population
// covers less than half the roster. This boot-seeded sweep fetches the best-
// scores window once for every tracked roster member with an empty projection,
// through the same code path the confirmation job uses (budgeted osu! client,
// threshold update, display metadata, projection replacement).
//
// Chunked, self-chaining, done-key-in-live_meta playbook like the DT sweep,
// with the profile-pool warm's pacing model: each invocation processes a small
// user chunk (one osu! API call per user), then chains the next chunk with a
// long runAfter so the sweep averages a few percent of the token-bucket budget.
// ~4,850 eligible users at 25 per chunk every 15 minutes is ~2 days of quiet
// background work. The cursor only ever advances (users whose fetch returns
// zero scores or 404s are passed over, never revisited), so no failed-attempt
// markers are needed; a chunk retry after a transient API error reselects only
// the users that still have no stored rows.
//
// When no eligible users remain the sweep writes the done key and force-checks
// the skill-baseline refresh (interval 0) so the newly stored projections
// enter the percentile curves immediately instead of waiting a week. Boots
// with the done key present schedule nothing.

export const TOP_SCORES_BACKFILL_JOB = "backfill_user_top_scores_sweep";
export const TOP_SCORES_BACKFILL_DONE_META_KEY = "top_scores_backfill_done:v1";
export const TOP_SCORES_BACKFILL_PROGRESS_META_KEY = "top_scores_backfill_progress:v1";

// 25 users x 1 osu! API call per chunk, one chunk per 15 minutes: ~1.7
// calls/min on average (under 4% of the ~45/min budget), and a full-budget
// chunk finishes in ~35s, far under the 10-minute job watchdog.
const TOP_SCORES_BACKFILL_CHUNK = 25;
const TOP_SCORES_BACKFILL_CHAIN_DELAY_MS = 15 * 60_000;
// Below every other background sweep (skill baseline / DT sweep at -10, pool
// warm at -8) so the shared fast lane always prefers interactive work.
const TOP_SCORES_BACKFILL_JOB_PRIORITY = -15;

/**
 * Progress introspection blob stored under TOP_SCORES_BACKFILL_PROGRESS_META_KEY:
 * {
 *   cursor:    number  - last roster user_id the sweep advanced past
 *   processed: number  - users attempted (fetch completed or 404)
 *   fetched:   number  - users whose fetch stored at least one top score
 *   missing:   number  - users the osu! API 404'd (marked missing/untracked)
 *   failed:    number  - chunk-level transient failures (job retried via backoff)
 *   updatedAt: string  - ISO timestamp of the last write
 * }
 */
export interface TopScoresBackfillProgress {
  cursor: number;
  processed: number;
  fetched: number;
  missing: number;
  failed: number;
  updatedAt: string;
}

export async function readTopScoresBackfillProgress(db: Db): Promise<TopScoresBackfillProgress> {
  const row = (await exec(db, "select value_json from live_meta where key = ? limit 1", [TOP_SCORES_BACKFILL_PROGRESS_META_KEY])).rows[0];
  const stored = parseJson<Partial<TopScoresBackfillProgress> | null>(String(row?.value_json ?? ""), null);
  return {
    cursor: Math.max(0, Math.floor(Number(stored?.cursor ?? 0)) || 0),
    processed: Math.max(0, Math.floor(Number(stored?.processed ?? 0)) || 0),
    fetched: Math.max(0, Math.floor(Number(stored?.fetched ?? 0)) || 0),
    missing: Math.max(0, Math.floor(Number(stored?.missing ?? 0)) || 0),
    failed: Math.max(0, Math.floor(Number(stored?.failed ?? 0)) || 0),
    updatedAt: typeof stored?.updatedAt === "string" ? stored.updatedAt : "",
  };
}

async function writeTopScoresBackfillProgress(db: Db, progress: TopScoresBackfillProgress): Promise<void> {
  const now = nowIso();
  await exec(
    db,
    `insert into live_meta (key, value_json, updated_at) values (?, ?, ?)
     on conflict(key) do update set value_json = excluded.value_json, updated_at = excluded.updated_at`,
    [TOP_SCORES_BACKFILL_PROGRESS_META_KEY, json({ ...progress, updatedAt: now }), now],
  );
}

/**
 * Next eligible users past the cursor: tracked roster members (any country)
 * with no stored top-plays projection and not soft-deleted. The correlated
 * NOT EXISTS seeks the user_top_scores PK per candidate; DISTINCT collapses
 * multi-country roster rows.
 */
export async function selectBackfillUserIds(db: Db, cursor: number, limit: number): Promise<number[]> {
  const rows = (await exec(
    db,
    `select distinct r.user_id
     from country_rosters r
     where r.is_tracked = 1
       and r.user_id > ?
       and not exists (select 1 from user_top_scores uts where uts.user_id = r.user_id)
       and not exists (select 1 from users u where u.user_id = r.user_id and u.is_active = 0)
     order by r.user_id
     limit ?`,
    [Math.max(0, Math.floor(cursor)), Math.max(1, Math.floor(limit))],
  )).rows;
  return rows
    .map((row) => Number(row.user_id))
    .filter((userId) => Number.isSafeInteger(userId) && userId > 0);
}

export interface TopScoresBackfillChunkResult {
  nextCursor: number;
  processed: number;
  fetched: number;
  missing: number;
  done: boolean;
}

export async function runTopScoresBackfillJob(
  db: Db,
  queue: JobQueue,
  osu: Pick<OsuApiClient, "getUserBestScores"> & Partial<Pick<OsuApiClient, "getUserBestScoresWindow">>,
  payload: { cursor?: number } | undefined,
  signal?: AbortSignal,
): Promise<TopScoresBackfillChunkResult> {
  const cursor = Math.max(0, Math.floor(Number(payload?.cursor ?? 0)));
  const userIds = await selectBackfillUserIds(db, cursor, TOP_SCORES_BACKFILL_CHUNK);
  const progress = await readTopScoresBackfillProgress(db);
  progress.cursor = Math.max(progress.cursor, cursor);

  // One user at a time, nothing accumulated: each iteration is a bounded fetch
  // plus upserts, so the chunk's memory footprint stays flat on the shared VPS.
  let nextCursor = cursor;
  let processed = 0;
  let fetched = 0;
  let missing = 0;
  for (const userId of userIds) {
    throwIfAborted(signal);
    try {
      const result = await refreshUserTopScoresProjection(db, osu, userId);
      processed += 1;
      if (result.scoreCount > 0) fetched += 1;
    } catch (error) {
      if (error instanceof OsuApiError && error.status === 404) {
        // Banned/restricted: untrack (same soft-delete the other user jobs'
        // 404 path uses) so neither this sweep nor other jobs reselect them.
        await markUserMissing(db, userId, `${TOP_SCORES_BACKFILL_JOB}: ${error.message}`);
        processed += 1;
        missing += 1;
        nextCursor = Math.max(nextCursor, userId);
        continue;
      }
      // Transient (API down, 429): persist what this chunk got through, then
      // fail the job so its backoff retries the chunk. Users already stored
      // drop out of the eligibility query on the retry.
      progress.cursor = Math.max(progress.cursor, nextCursor);
      progress.processed += processed;
      progress.fetched += fetched;
      progress.missing += missing;
      progress.failed += 1;
      await writeTopScoresBackfillProgress(db, progress);
      logWarn("top_scores_backfill_chunk_failed", { cursor, user_id: userId, processed, ...errorContext(error) });
      throw error;
    }
    nextCursor = Math.max(nextCursor, userId);
  }

  progress.cursor = Math.max(progress.cursor, nextCursor);
  progress.processed += processed;
  progress.fetched += fetched;
  progress.missing += missing;
  await writeTopScoresBackfillProgress(db, progress);

  const done = userIds.length < TOP_SCORES_BACKFILL_CHUNK;
  logInfo("top_scores_backfill_chunk", {
    cursor,
    next_cursor: nextCursor,
    processed,
    fetched,
    missing,
    done,
  });
  if (done) {
    const now = nowIso();
    await exec(
      db,
      "insert or replace into live_meta (key, value_json, updated_at) values (?, ?, ?)",
      [TOP_SCORES_BACKFILL_DONE_META_KEY, json({
        finishedAt: now,
        processed: progress.processed,
        fetched: progress.fetched,
        missing: progress.missing,
        failed: progress.failed,
      }), now],
    );
    logInfo("top_scores_backfill_done", {
      processed: progress.processed,
      fetched: progress.fetched,
      missing: progress.missing,
      failed: progress.failed,
    });
    // The whole point of the sweep: fold the new projections into the skill
    // percentile curves now, not at the weekly interval. intervalMs 0 forces
    // the staleness check; the chain still no-ops if one is already pending.
    if (progress.fetched > 0) {
      await enqueueSkillBaselineIfDue(db, queue, 0);
    }
    return { nextCursor, processed, fetched, missing, done: true };
  }

  await enqueueTopScoresBackfillChunk(queue, nextCursor, new Date(Date.now() + TOP_SCORES_BACKFILL_CHAIN_DELAY_MS));
  return { nextCursor, processed, fetched, missing, done: false };
}

/**
 * Boot watchdog: seed the sweep once per done-key version, resume if a chain
 * died mid-way (the persisted progress cursor is the resume point). No-op when
 * the done key exists or a chain link is already pending.
 */
export async function ensureTopScoresBackfillSeeded(db: Db, queue: JobQueue): Promise<void> {
  const done = (await exec(db, "select 1 from live_meta where key = ? limit 1", [TOP_SCORES_BACKFILL_DONE_META_KEY])).rows[0];
  if (done) return;
  const pending = (await exec(
    db,
    "select 1 from jobs where type = ? and status in ('queued', 'running', 'failed', 'deferred_pressure') limit 1",
    [TOP_SCORES_BACKFILL_JOB],
  )).rows[0];
  if (pending) return;
  const progress = await readTopScoresBackfillProgress(db);
  await enqueueTopScoresBackfillChunk(queue, progress.cursor, new Date());
}

function enqueueTopScoresBackfillChunk(queue: JobQueue, cursor: number, runAfter: Date): Promise<void> {
  return queue.enqueue(
    TOP_SCORES_BACKFILL_JOB,
    `${TOP_SCORES_BACKFILL_JOB}:${cursor}`,
    { cursor },
    { priority: TOP_SCORES_BACKFILL_JOB_PRIORITY, runAfter, replaceDone: true },
  );
}
