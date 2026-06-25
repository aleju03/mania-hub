import type { Db } from "../db.js";
import { exec, json, parseJson } from "../db.js";
import { nowIso } from "../shared/score.js";

// When serving and ingest/workers run in separate processes, the serving
// process cannot see the worker's in-memory status (worker lanes, OSC feed,
// osu! rate limiter). The worker mirrors that state to a live_meta row on an
// interval; the serving process reads it for the admin dashboard. Pause/resume
// flows the other way through a control flag the worker polls.

const RUNTIME_STATUS_KEY = "runtime:status";
const WORKERS_PAUSED_KEY = "control:workers_paused";

export interface RuntimeStatusSnapshot {
  worker: unknown;
  osc: unknown;
  osuRate: unknown;
  scoresFallbackRate: unknown;
  updatedAt: string;
}

export async function writeRuntimeStatus(db: Db, status: Pick<RuntimeStatusSnapshot, "worker" | "osc" | "osuRate" | "scoresFallbackRate">): Promise<void> {
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
  snapshot: () => Pick<RuntimeStatusSnapshot, "worker" | "osc" | "osuRate" | "scoresFallbackRate">,
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
