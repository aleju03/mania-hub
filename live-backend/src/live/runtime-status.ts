import type { Db } from "../db.js";
import { exec, json, parseJson } from "../db.js";
import type { JobMemoryMetric } from "../shared/process-memory.js";
import { nowIso } from "../shared/score.js";

// When serving and ingest/workers run in separate processes, the serving
// process cannot see the worker's in-memory status (worker lanes, OSC feed,
// osu! rate limiter). The worker mirrors that state to a live_meta row on an
// interval; the serving process reads it for the admin dashboard. Pause/resume
// flows the other way through a control flag the worker polls.

const RUNTIME_STATUS_KEY = "runtime:status";
const WORKERS_PAUSED_KEY = "control:workers_paused";
const JOB_MEMORY_KEY_PREFIX = "metrics:job_memory:";

export interface RuntimeStatusSnapshot {
  worker: unknown;
  osc: unknown;
  osuRate: unknown;
  scoresFallbackRate: unknown;
  sqliteBusy: unknown;
  // Absent on rows written by a worker running older code, so every reader
  // must treat it as optional rather than assume a rolling deploy is atomic.
  memory?: unknown;
  // The worker process's event loop stalls (shared/event-loop.ts); same
  // optionality as memory.
  eventLoop?: unknown;
  updatedAt: string;
}

type RuntimeStatusFields = Pick<RuntimeStatusSnapshot, "worker" | "osc" | "osuRate" | "scoresFallbackRate" | "sqliteBusy" | "memory" | "eventLoop">;

export async function writeRuntimeStatus(db: Db, status: RuntimeStatusFields): Promise<void> {
  const payload: RuntimeStatusSnapshot = { ...status, updatedAt: nowIso() };
  await exec(
    db,
    `insert into live_meta (key, value_json, updated_at)
     values (?, ?, ?)
     on conflict(key) do update set value_json = excluded.value_json, updated_at = excluded.updated_at`,
    [RUNTIME_STATUS_KEY, json(payload), payload.updatedAt],
  ).catch(() => undefined);
}

export async function readRuntimeStatus(db: Db): Promise<RuntimeStatusSnapshot | null> {
  const row = (await exec(db, "select value_json from live_meta where key = ?", [RUNTIME_STATUS_KEY])).rows[0];
  if (!row) return null;
  return parseJson<RuntimeStatusSnapshot | null>(row.value_json, null);
}

// Mirror the worker's status to the DB on an interval. Returns a stop function.
export function startRuntimeStatusMirror(
  db: Db,
  snapshot: () => RuntimeStatusFields,
  intervalMs: number,
): () => void {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    await writeRuntimeStatus(db, snapshot());
    if (!stopped) setTimeout(tick, intervalMs).unref();
  };
  setTimeout(tick, 0).unref();
  return () => {
    stopped = true;
  };
}

// A job's memory profile is measured in the worker process but is only ever
// read on the admin dashboard, which the serving process answers. The 5s
// runtime:status mirror is too coarse to be trusted for a ~30s job, so the
// finished run is written to its own live_meta row instead: one key per job
// type (bounded by the number of types that opt in), never pruned by
// runRetention, so the last run survives a worker restart.
export interface JobMemoryRecord extends JobMemoryMetric {
  jobType: string;
  // Worker jobs in flight (this one included) when the sample was taken. Lanes
  // run concurrently, so anything above 1 means peakRssBytes is shared with
  // other work.
  concurrentJobs: number;
  // Travels with the numbers so whatever renders them cannot present the peak
  // as this job's own allocation.
  hint: string;
}

const JOB_MEMORY_HINT = "peakRssBytes is the whole worker process's RSS while this job ran, not the job's own allocation; concurrent lanes count toward it.";

export async function writeJobMemoryMetric(
  db: Db,
  jobType: string,
  metric: JobMemoryMetric,
  context: { concurrentJobs?: number } = {},
): Promise<void> {
  const record: JobMemoryRecord = {
    ...metric,
    jobType,
    concurrentJobs: Math.max(0, Math.floor(context.concurrentJobs ?? 0)),
    hint: JOB_MEMORY_HINT,
  };
  // Observability must never turn a successful job into a failed one, so a
  // write failure (locked DB, disk pressure) is swallowed exactly as the
  // runtime status mirror swallows its own.
  await exec(
    db,
    `insert into live_meta (key, value_json, updated_at)
     values (?, ?, ?)
     on conflict(key) do update set value_json = excluded.value_json, updated_at = excluded.updated_at`,
    [`${JOB_MEMORY_KEY_PREFIX}${jobType}`, json(record), nowIso()],
  ).catch(() => undefined);
}

export async function readJobMemoryMetric(db: Db, jobType: string): Promise<JobMemoryRecord | null> {
  const row = (await exec(db, "select value_json from live_meta where key = ?", [`${JOB_MEMORY_KEY_PREFIX}${jobType}`])).rows[0];
  if (!row) return null;
  return parseJson<JobMemoryRecord | null>(row.value_json, null);
}

export async function setWorkersPaused(db: Db, paused: boolean): Promise<void> {
  const now = nowIso();
  await exec(
    db,
    `insert into live_meta (key, value_json, updated_at)
     values (?, ?, ?)
     on conflict(key) do update set value_json = excluded.value_json, updated_at = excluded.updated_at`,
    [WORKERS_PAUSED_KEY, json(paused), now],
  );
}

export async function readWorkersPaused(db: Db): Promise<boolean> {
  const row = (await exec(db, "select value_json from live_meta where key = ?", [WORKERS_PAUSED_KEY])).rows[0];
  if (!row) return false;
  return parseJson<boolean>(row.value_json, false) === true;
}
