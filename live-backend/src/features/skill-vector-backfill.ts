import type { Db } from "../db.js";
import { exec, json, parseJson } from "../db.js";
import type { JobQueue } from "../jobs/queue.js";
import { errorContext, logInfo, logWarn } from "../logger.js";
import type { OsuApiClient } from "../osu/client.js";
import { throwIfAborted } from "../shared/abort.js";
import { nowIso } from "../shared/score.js";
import { ACTIVITY_SKILL_ANALYSIS_VERSION, computeBeatmapActivitySkillVector } from "./activity.js";

// ── One-time skill-vector version backfill sweep ─────────────────────────────
// beatmap_skill_vectors only gets rows at the current ACTIVITY_SKILL_ANALYSIS_
// VERSION on demand (a player's activity page touching the map), so after a
// version bump the analyzed pool crawls back up one map at a time while the
// search index keeps serving rows derived from the previous version's vectors.
// This boot-seeded sweep proactively recomputes the current-version vector for
// every beatmap that is either in map_search_index or has a ready vector at an
// older version, through the exact compute path the interactive
// analyze_activity_beatmap job uses (cached .osu corpus, archive/osu! API
// fallback, ready/unavailable/failed statuses, incremental search-index upsert).
//
// Chunked, self-chaining, done-key-in-live_meta playbook like the DT-rate
// sweep: eligibility guarantees the map's .osu was fetched when its previous
// vector was computed (the beatmap_osu_files cache never expires), so the cost
// profile is local CPU (parse + dan-estimator features, ~0.1-0.3s per chart),
// not osu! API budget; a cache miss falling through to the API is the rare
// exception and rides the token bucket like any other call. Each chunk
// processes maps one at a time with event-loop yields in between (no
// accumulation, flat memory on the shared VPS) and chains immediately; the
// activity-analysis lane's poll interval paces the chain and the deep negative
// priority lets interactive analyze_activity_beatmap jobs jump every gap.
//
// Old-version rows are left in place when the new one lands: they are small,
// and pruning historical versions is the compaction scripts' business.
//
// The meta keys derive from ACTIVITY_SKILL_ANALYSIS_VERSION so a future
// version bump re-arms the sweep automatically; the admin sweeps monitor
// reads these exact key shapes.

export const SKILL_VECTOR_BACKFILL_JOB = "backfill_skill_vectors_sweep";
export const SKILL_VECTOR_BACKFILL_DONE_META_KEY = `skill_vector_backfill_done:v${ACTIVITY_SKILL_ANALYSIS_VERSION}`;
export const SKILL_VECTOR_BACKFILL_PROGRESS_META_KEY = `skill_vector_backfill_progress:v${ACTIVITY_SKILL_ANALYSIS_VERSION}`;

// 25 charts per invocation at ~0.1-0.3s of local CPU each keeps a chunk at
// ~3-8s, far under the 10-minute job watchdog, and bounds how long a queued
// interactive analysis waits behind the sweep to a single chunk.
const SKILL_VECTOR_BACKFILL_CHUNK = 25;
// Below every other background sweep (DT sweep and index build at -10) and
// matching the top-scores sweep's floor, so the shared lane always prefers
// interactive analyze_activity_beatmap work (priority 5).
const SKILL_VECTOR_BACKFILL_JOB_PRIORITY = -15;

/**
 * Progress introspection blob stored under SKILL_VECTOR_BACKFILL_PROGRESS_META_KEY:
 * {
 *   cursor:      number  - last beatmap_id the sweep advanced past
 *   processed:   number  - maps attempted (compute finished or failed)
 *   computed:    number  - maps whose current-version vector landed as ready
 *   unavailable: number  - maps whose .osu is terminally unfetchable
 *   failed:      number  - maps whose compute failed transiently (left as
 *                          status 'failed'; the on-demand path retries them)
 *   updatedAt:   string  - ISO timestamp of the last write
 * }
 */
export interface SkillVectorBackfillProgress {
  cursor: number;
  processed: number;
  computed: number;
  unavailable: number;
  failed: number;
  updatedAt: string;
}

export async function readSkillVectorBackfillProgress(db: Db): Promise<SkillVectorBackfillProgress> {
  const row = (await exec(db, "select value_json from live_meta where key = ? limit 1", [SKILL_VECTOR_BACKFILL_PROGRESS_META_KEY])).rows[0];
  const stored = parseJson<Partial<SkillVectorBackfillProgress> | null>(String(row?.value_json ?? ""), null);
  return {
    cursor: Math.max(0, Math.floor(Number(stored?.cursor ?? 0)) || 0),
    processed: Math.max(0, Math.floor(Number(stored?.processed ?? 0)) || 0),
    computed: Math.max(0, Math.floor(Number(stored?.computed ?? 0)) || 0),
    unavailable: Math.max(0, Math.floor(Number(stored?.unavailable ?? 0)) || 0),
    failed: Math.max(0, Math.floor(Number(stored?.failed ?? 0)) || 0),
    updatedAt: typeof stored?.updatedAt === "string" ? stored.updatedAt : "",
  };
}

async function writeSkillVectorBackfillProgress(db: Db, progress: SkillVectorBackfillProgress): Promise<void> {
  const now = nowIso();
  await exec(
    db,
    `insert into live_meta (key, value_json, updated_at) values (?, ?, ?)
     on conflict(key) do update set value_json = excluded.value_json, updated_at = excluded.updated_at`,
    [SKILL_VECTOR_BACKFILL_PROGRESS_META_KEY, json({ ...progress, updatedAt: now }), now],
  );
}

/**
 * Next eligible beatmaps past the cursor: everything searchable plus every map
 * with a ready vector at an older analysis version, minus maps whose
 * current-version row is already settled (ready or unavailable). A stale
 * 'failed' or wedged 'running' current-version row stays eligible: recomputing
 * it is idempotent and this sweep is its retry. The cursor is pushed into both
 * union branches so the scanned set shrinks as the sweep advances.
 */
export async function selectSkillVectorBackfillBeatmapIds(db: Db, cursor: number, limit: number): Promise<number[]> {
  const safeCursor = Math.max(0, Math.floor(cursor));
  const rows = (await exec(
    db,
    `select c.beatmap_id as beatmap_id
     from (
       select beatmap_id from map_search_index where beatmap_id > ?
       union
       select beatmap_id from beatmap_skill_vectors
       where status = 'ready' and analysis_version < ? and beatmap_id > ?
     ) c
     where not exists (
       select 1 from beatmap_skill_vectors v
       where v.beatmap_id = c.beatmap_id
         and v.analysis_version = ?
         and v.status in ('ready', 'unavailable')
     )
     order by c.beatmap_id asc
     limit ?`,
    [safeCursor, ACTIVITY_SKILL_ANALYSIS_VERSION, safeCursor, ACTIVITY_SKILL_ANALYSIS_VERSION, Math.max(1, Math.floor(limit))],
  )).rows;
  return rows
    .map((row) => Number(row.beatmap_id))
    .filter((beatmapId) => Number.isSafeInteger(beatmapId) && beatmapId > 0);
}

async function readCurrentVectorStatus(db: Db, beatmapId: number): Promise<string> {
  const row = (await exec(
    db,
    "select status from beatmap_skill_vectors where beatmap_id = ? and analysis_version = ? limit 1",
    [beatmapId, ACTIVITY_SKILL_ANALYSIS_VERSION],
  )).rows[0];
  return String(row?.status ?? "");
}

export interface SkillVectorBackfillChunkResult {
  nextCursor: number;
  processed: number;
  computed: number;
  unavailable: number;
  failed: number;
  done: boolean;
}

export async function runSkillVectorBackfillJob(
  db: Db,
  queue: JobQueue,
  osu: Pick<OsuApiClient, "getBeatmapFile">,
  payload: { cursor?: number } | undefined,
  signal?: AbortSignal,
): Promise<SkillVectorBackfillChunkResult> {
  const cursor = Math.max(0, Math.floor(Number(payload?.cursor ?? 0)));
  const beatmapIds = await selectSkillVectorBackfillBeatmapIds(db, cursor, SKILL_VECTOR_BACKFILL_CHUNK);
  const progress = await readSkillVectorBackfillProgress(db);
  progress.cursor = Math.max(progress.cursor, cursor);

  // One map at a time, nothing accumulated: each iteration parses one chart and
  // writes its row, so the chunk's memory footprint stays flat on the 4GB VPS.
  let nextCursor = cursor;
  let processed = 0;
  let computed = 0;
  let unavailable = 0;
  let failed = 0;
  for (const beatmapId of beatmapIds) {
    if (signal?.aborted) {
      // Watchdog abort: persist what this chunk got through, then fail the job
      // so its backoff retries the chunk. Maps already settled drop out of the
      // eligibility query on the retry.
      progress.cursor = Math.max(progress.cursor, nextCursor);
      progress.processed += processed;
      progress.computed += computed;
      progress.unavailable += unavailable;
      progress.failed += failed;
      await writeSkillVectorBackfillProgress(db, progress);
      throwIfAborted(signal);
    }
    try {
      await computeBeatmapActivitySkillVector(db, osu, { beatmapId });
      // The compute returns normally for both ready and unavailable (terminal
      // .osu fetch errors); read the row back to tell them apart.
      const status = await readCurrentVectorStatus(db, beatmapId);
      if (status === "ready") computed += 1;
      else if (status === "unavailable") unavailable += 1;
    } catch (error) {
      // Transient per-map failure: the pipeline already recorded status
      // 'failed' with the error, the on-demand path retries after its
      // cooldown. Never stall the chain over one map.
      failed += 1;
      logWarn("skill_vector_backfill_map_failed", { beatmap_id: beatmapId, ...errorContext(error) });
    }
    processed += 1;
    nextCursor = Math.max(nextCursor, beatmapId);
    // Yield between charts so ingest/SSE keep moving during the CPU bursts.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  progress.cursor = Math.max(progress.cursor, nextCursor);
  progress.processed += processed;
  progress.computed += computed;
  progress.unavailable += unavailable;
  progress.failed += failed;
  await writeSkillVectorBackfillProgress(db, progress);

  const done = beatmapIds.length < SKILL_VECTOR_BACKFILL_CHUNK;
  logInfo("skill_vector_backfill_chunk", {
    cursor,
    next_cursor: nextCursor,
    processed,
    computed,
    unavailable,
    failed,
    done,
  });
  if (done) {
    const now = nowIso();
    await exec(
      db,
      "insert or replace into live_meta (key, value_json, updated_at) values (?, ?, ?)",
      [SKILL_VECTOR_BACKFILL_DONE_META_KEY, json({
        finishedAt: now,
        processed: progress.processed,
        computed: progress.computed,
        unavailable: progress.unavailable,
        failed: progress.failed,
      }), now],
    );
    logInfo("skill_vector_backfill_done", {
      analysis_version: ACTIVITY_SKILL_ANALYSIS_VERSION,
      processed: progress.processed,
      computed: progress.computed,
      unavailable: progress.unavailable,
      failed: progress.failed,
    });
    return { nextCursor, processed, computed, unavailable, failed, done: true };
  }

  await enqueueSkillVectorBackfillChunk(queue, nextCursor);
  return { nextCursor, processed, computed, unavailable, failed, done: false };
}

/**
 * Boot watchdog: seed the sweep once per done-key version, resume if a chain
 * died mid-way (the persisted progress cursor is the resume point). No-op when
 * the done key exists or a chain link is already pending.
 */
export async function ensureSkillVectorBackfillSeeded(db: Db, queue: JobQueue): Promise<void> {
  const done = (await exec(db, "select 1 from live_meta where key = ? limit 1", [SKILL_VECTOR_BACKFILL_DONE_META_KEY])).rows[0];
  if (done) return;
  const pending = (await exec(
    db,
    "select 1 from jobs where type = ? and status in ('queued', 'running', 'failed', 'deferred_pressure') limit 1",
    [SKILL_VECTOR_BACKFILL_JOB],
  )).rows[0];
  if (pending) return;
  const progress = await readSkillVectorBackfillProgress(db);
  await enqueueSkillVectorBackfillChunk(queue, progress.cursor);
}

function enqueueSkillVectorBackfillChunk(queue: JobQueue, cursor: number): Promise<void> {
  return queue.enqueue(
    SKILL_VECTOR_BACKFILL_JOB,
    `${SKILL_VECTOR_BACKFILL_JOB}:${cursor}`,
    { cursor },
    { priority: SKILL_VECTOR_BACKFILL_JOB_PRIORITY, replaceDone: true },
  );
}
