import { randomUUID } from "node:crypto";
import type { Db } from "../db.js";
import { exec, json, parseJson } from "../db.js";
import type { JobQueue } from "../jobs/queue.js";
import { getCachedBeatmapFile, markCachedBeatmapFileUnavailable } from "../osu/beatmap-file-cache.js";
import type { OsuApiClient } from "../osu/client.js";
import { nowIso } from "../shared/score.js";

export const BEATMAP_OSU_FILE_BACKFILL_JOB = "backfill_beatmap_osu_files";

const META_KEY = "beatmap_osu_file_backfill_state";
const BATCH_SIZE = 12;
const JOB_PRIORITY = -8;
const CACHE_COUNTS_TTL_MS = 15_000;

type BackfillRunStatus = "idle" | "queued" | "running" | "done" | "cancelled" | "failed";

interface BackfillState {
  runId: string | null;
  status: BackfillRunStatus;
  batchSize: number;
  processed: number;
  stored: number;
  failed: number;
  unavailable: number;
  lastBeatmapId: number;
  lastError: string | null;
  startedAt: string | null;
  updatedAt: string;
  finishedAt: string | null;
}

interface BackfillJobPayload {
  runId: string;
  cursor?: number;
}

interface CacheCounts {
  totalAnalyzed: number;
  cached: number;
  unavailable: number;
  missing: number;
}

interface CachedCacheCounts {
  expiresAt: number;
  value: CacheCounts;
}

interface JobCounts {
  queued: number;
  running: number;
  failed: number;
  deferred: number;
}

export interface BeatmapOsuFileBackfillStatus extends BackfillState, CacheCounts {
  active: boolean;
  stalled: boolean;
  percent: number;
  jobs: JobCounts;
}

const cacheCountsByDb = new WeakMap<Db, CachedCacheCounts>();

export async function getBeatmapOsuFileBackfillStatus(
  db: Db,
  options: { cacheCounts?: boolean } = {},
): Promise<BeatmapOsuFileBackfillStatus> {
  const [state, counts, jobs] = await Promise.all([
    readState(db),
    options.cacheCounts ? readCachedCacheCounts(db) : readCacheCounts(db),
    readJobCounts(db),
  ]);
  const activeJobs = jobs.queued + jobs.running + jobs.failed + jobs.deferred;
  const activeState = state.status === "queued" || state.status === "running";
  const active = activeState && counts.missing > 0;
  const stalled = active && activeJobs === 0;
  return {
    ...state,
    ...counts,
    active,
    stalled,
    percent: counts.totalAnalyzed > 0 ? Math.min(100, Math.max(0, (counts.cached + counts.unavailable) / counts.totalAnalyzed * 100)) : 100,
    jobs,
  };
}

export async function startBeatmapOsuFileBackfill(db: Db, queue: JobQueue): Promise<BeatmapOsuFileBackfillStatus> {
  const current = await getBeatmapOsuFileBackfillStatus(db);
  if (current.missing <= 0) {
    const now = nowIso();
    await writeState(db, {
      runId: current.runId,
      status: "done",
      batchSize: current.batchSize,
      processed: current.processed,
      stored: current.stored,
      failed: current.failed,
      unavailable: current.unavailable,
      lastBeatmapId: current.lastBeatmapId,
      lastError: current.lastError,
      startedAt: current.startedAt,
      finishedAt: current.finishedAt ?? now,
      updatedAt: now,
    });
    return getBeatmapOsuFileBackfillStatus(db);
  }

  if (current.active && !current.stalled) return current;

  const now = nowIso();
  const runId = current.active && current.runId ? current.runId : randomUUID();
  const cursor = current.active ? current.lastBeatmapId : 0;
  const nextState: BackfillState = current.active
    ? {
        runId,
        status: "queued",
        batchSize: BATCH_SIZE,
        processed: current.processed,
        stored: current.stored,
        failed: current.failed,
        unavailable: current.unavailable,
        lastBeatmapId: cursor,
        lastError: current.lastError,
        startedAt: current.startedAt ?? now,
        updatedAt: now,
        finishedAt: null,
      }
    : {
        runId,
        status: "queued",
        batchSize: BATCH_SIZE,
        processed: 0,
        stored: 0,
        failed: 0,
        unavailable: 0,
        lastBeatmapId: 0,
        lastError: null,
        startedAt: now,
        updatedAt: now,
        finishedAt: null,
      };
  await writeState(db, nextState);
  await enqueueBackfillJob(queue, runId, cursor);
  return getBeatmapOsuFileBackfillStatus(db);
}

export async function cancelBeatmapOsuFileBackfill(db: Db): Promise<BeatmapOsuFileBackfillStatus> {
  const current = await readState(db);
  const now = nowIso();
  await exec(
    db,
    `delete from jobs
     where type = ?
       and status in ('queued', 'failed', 'deferred_pressure')`,
    [BEATMAP_OSU_FILE_BACKFILL_JOB],
  );
  await writeState(db, {
    ...current,
    status: "cancelled",
    updatedAt: now,
    finishedAt: now,
  });
  return getBeatmapOsuFileBackfillStatus(db);
}

export async function runBeatmapOsuFileBackfillJob(
  db: Db,
  queue: JobQueue,
  osu: OsuApiClient,
  payload: BackfillJobPayload,
): Promise<void> {
  const state = await readState(db);
  if (!payload?.runId || state.runId !== payload.runId) return;
  if (state.status === "cancelled" || state.status === "done") return;

  await writeState(db, {
    ...state,
    status: "running",
    updatedAt: nowIso(),
    finishedAt: null,
  });

  let cursor = Math.max(0, Math.floor(Number(payload.cursor ?? state.lastBeatmapId ?? 0)));
  let beatmapIds = await selectMissingBeatmapIds(db, cursor, BATCH_SIZE);
  if (beatmapIds.length === 0 && cursor > 0) {
    cursor = 0;
    beatmapIds = await selectMissingBeatmapIds(db, cursor, BATCH_SIZE);
  }
  if (beatmapIds.length === 0) {
    await finishRun(db, payload.runId, "done", null);
    return;
  }

  let processed = 0;
  let stored = 0;
  let failed = 0;
  let unavailable = 0;
  let lastBeatmapId = cursor;
  let lastError: string | null = null;

  for (const beatmapId of beatmapIds) {
    const latest = await readState(db);
    if (latest.runId !== payload.runId || latest.status === "cancelled") {
      await writeState(db, {
        ...latest,
        status: "cancelled",
        updatedAt: nowIso(),
        finishedAt: latest.finishedAt ?? nowIso(),
      });
      return;
    }

    processed++;
    lastBeatmapId = beatmapId;
    try {
      await getCachedBeatmapFile(db, osu, beatmapId, "job:backfill_beatmap_osu_files");
      if (await hasCompressedCachedFile(db, beatmapId)) {
        stored++;
      } else {
        failed++;
        lastError = `Store failed for beatmap ${beatmapId}`;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isTerminalBeatmapFileError(message)) {
        await markCachedBeatmapFileUnavailable(db, beatmapId, {
          error: message,
          source: "unavailable",
        }).catch(() => {});
        unavailable++;
        lastError = message;
      } else {
        failed++;
        lastError = message;
      }
    }
  }

  const latest = await readState(db);
  if (latest.runId !== payload.runId) return;
  const updated: BackfillState = {
    ...latest,
    status: latest.status === "cancelled" ? "cancelled" : "running",
    processed: latest.processed + processed,
    stored: latest.stored + stored,
    failed: latest.failed + failed,
    unavailable: latest.unavailable + unavailable,
    lastBeatmapId,
    lastError: lastError ?? latest.lastError,
    updatedAt: nowIso(),
    finishedAt: latest.status === "cancelled" ? nowIso() : null,
  };
  await writeState(db, updated);
  if (updated.status === "cancelled") return;

  const counts = await readCacheCounts(db);
  if (counts.missing <= 0) {
    await finishRun(db, payload.runId, "done", null);
    return;
  }

  await enqueueBackfillJob(queue, payload.runId, lastBeatmapId);
}

async function finishRun(db: Db, runId: string, status: "done" | "failed", error: string | null): Promise<void> {
  const state = await readState(db);
  if (state.runId !== runId) return;
  const now = nowIso();
  await writeState(db, {
    ...state,
    status,
    lastError: error ?? state.lastError,
    updatedAt: now,
    finishedAt: now,
  });
}

async function enqueueBackfillJob(queue: JobQueue, runId: string, cursor: number): Promise<void> {
  const safeCursor = Math.max(0, Math.floor(Number(cursor) || 0));
  await queue.enqueue(
    BEATMAP_OSU_FILE_BACKFILL_JOB,
    `${BEATMAP_OSU_FILE_BACKFILL_JOB}:${runId}:${safeCursor}`,
    { runId, cursor: safeCursor },
    { priority: JOB_PRIORITY },
  );
}

async function readState(db: Db): Promise<BackfillState> {
  const row = (await exec(db, "select value_json from live_meta where key = ?", [META_KEY])).rows[0];
  return normalizeState(parseJson<Partial<BackfillState> | null>(row?.value_json, null));
}

async function writeState(db: Db, state: BackfillState): Promise<void> {
  await exec(
    db,
    `insert into live_meta (key, value_json, updated_at)
     values (?, ?, ?)
     on conflict(key) do update set value_json = excluded.value_json, updated_at = excluded.updated_at`,
    [META_KEY, json(state), state.updatedAt],
  );
}

async function readCacheCounts(db: Db): Promise<CacheCounts> {
  const rows = (await exec(
    db,
    `select
       count(*) as total,
       sum(case when f.content_blob is not null and f.compressed_bytes > 0 then 1 else 0 end) as cached,
       sum(case when f.source = 'unavailable' then 1 else 0 end) as unavailable
     from (
       select distinct beatmap_id
       from beatmap_skill_vectors
       where status = 'ready'
     ) v
     left join beatmap_osu_files f on f.beatmap_id = v.beatmap_id`,
  )).rows[0];
  const totalAnalyzed = Number(rows?.total ?? 0);
  const cached = Number(rows?.cached ?? 0);
  const unavailable = Number(rows?.unavailable ?? 0);
  return {
    totalAnalyzed,
    cached,
    unavailable,
    missing: Math.max(0, totalAnalyzed - cached - unavailable),
  };
}

async function readCachedCacheCounts(db: Db): Promise<CacheCounts> {
  const now = Date.now();
  const cached = cacheCountsByDb.get(db);
  if (cached && cached.expiresAt > now) return cached.value;
  const value = await readCacheCounts(db);
  cacheCountsByDb.set(db, { value, expiresAt: now + CACHE_COUNTS_TTL_MS });
  return value;
}

async function readJobCounts(db: Db): Promise<JobCounts> {
  const rows = (await exec(
    db,
    "select status, count(*) as count from jobs where type = ? group by status",
    [BEATMAP_OSU_FILE_BACKFILL_JOB],
  )).rows;
  const counts: JobCounts = { queued: 0, running: 0, failed: 0, deferred: 0 };
  for (const row of rows) {
    const status = String(row.status);
    const count = Number(row.count ?? 0);
    if (status === "queued") counts.queued += count;
    if (status === "running") counts.running += count;
    if (status === "failed") counts.failed += count;
    if (status === "deferred_pressure") counts.deferred += count;
  }
  return counts;
}

async function selectMissingBeatmapIds(db: Db, cursor: number, limit: number): Promise<number[]> {
  const rows = (await exec(
    db,
    `select v.beatmap_id
     from (
       select distinct beatmap_id
       from beatmap_skill_vectors
       where status = 'ready'
     ) v
     where v.beatmap_id > ?
       and not exists (
         select 1
         from beatmap_osu_files f
         where f.beatmap_id = v.beatmap_id
           and (
             (f.content_blob is not null and f.compressed_bytes > 0)
             or f.source = 'unavailable'
           )
       )
     order by v.beatmap_id asc
     limit ?`,
    [Math.max(0, Math.floor(cursor)), Math.max(1, Math.floor(limit))],
  )).rows;
  return rows.map((row) => Number(row.beatmap_id)).filter((beatmapId) => Number.isSafeInteger(beatmapId) && beatmapId > 0);
}

async function hasCompressedCachedFile(db: Db, beatmapId: number): Promise<boolean> {
  const row = (await exec(
    db,
    `select 1
     from beatmap_osu_files
     where beatmap_id = ?
       and content_blob is not null
       and compressed_bytes > 0
     limit 1`,
    [beatmapId],
  )).rows[0];
  return !!row;
}

function normalizeState(value: Partial<BackfillState> | null): BackfillState {
  const now = nowIso();
  const status = value?.status === "queued"
    || value?.status === "running"
    || value?.status === "done"
    || value?.status === "cancelled"
    || value?.status === "failed"
    ? value.status
    : "idle";
  return {
    runId: typeof value?.runId === "string" && value.runId ? value.runId : null,
    status,
    batchSize: normalizeNonNegativeInt(value?.batchSize, BATCH_SIZE),
    processed: normalizeNonNegativeInt(value?.processed, 0),
    stored: normalizeNonNegativeInt(value?.stored, 0),
    failed: normalizeNonNegativeInt(value?.failed, 0),
    unavailable: normalizeNonNegativeInt(value?.unavailable, 0),
    lastBeatmapId: normalizeNonNegativeInt(value?.lastBeatmapId, 0),
    lastError: typeof value?.lastError === "string" && value.lastError ? value.lastError : null,
    startedAt: typeof value?.startedAt === "string" ? value.startedAt : null,
    updatedAt: typeof value?.updatedAt === "string" ? value.updatedAt : now,
    finishedAt: typeof value?.finishedAt === "string" ? value.finishedAt : null,
  };
}

function normalizeNonNegativeInt(value: unknown, fallback: number): number {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function isTerminalBeatmapFileError(message: string): boolean {
  if (!message.startsWith("Failed to fetch .osu file for beatmap ")) return false;
  const separatorIndex = message.indexOf(": ");
  if (separatorIndex < 0) return false;
  const sourceErrors = message
    .slice(separatorIndex + 2)
    .split(";")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  return sourceErrors.length > 0 && sourceErrors.every((part) => part.includes("(404)") || part.includes("invalid .osu file"));
}
