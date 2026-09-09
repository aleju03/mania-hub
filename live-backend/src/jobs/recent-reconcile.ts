import type { Db } from "../db.js";
import { exec, json } from "../db.js";
import { nowIso } from "../shared/score.js";
import type { JobStatus } from "./queue.js";

export const RECENT_RECONCILE_JOB_TYPE = "reconcile_user_recent_scores";
export const RECENT_RECONCILE_REPAIR_PRIORITY = 150;

export const RECENT_RECONCILE_MIN_INTERVAL_MS = 2 * 60_000;

export interface RecentReconcilePayload {
  kind?: "gap_repair" | "follow_up";
  userId: number;
  source?: string;
  processLeaderboardFeatures?: boolean;
  unchangedPolls?: number;
  latestScoreAt?: string;
}

export function nextRecentReconcileCadence(previous: number | undefined, changed: boolean): { unchangedPolls: number; delayMs: number } {
  const unchangedPolls = changed ? 0 : Math.min(3, Math.max(0, Math.floor(previous ?? 0)) + 1);
  // Keep the first unchanged follow-up at two minutes for delayed replay/id
  // corrections, then check at four/eight minutes until the activity TTL ends.
  return { unchangedPolls, delayMs: 2 * 60_000 * 2 ** Math.max(0, unchangedPolls - 1) };
}

// The durable gate survives restarts and dedupe-key changes. Reserve atomically
// before spending API budget, including retries and competing worker lanes.
export async function reserveRecentReconcileRequest(db: Db, userId: number, jobId?: number): Promise<number> {
  const now = Date.now();
  const key = `recent-reconcile:next-allowed:${userId}`;
  const result = await exec(db,
    `insert into live_meta (key, value_json, updated_at) values (?, ?, ?)
     on conflict(key) do update set value_json = excluded.value_json, updated_at = excluded.updated_at
     where json_extract(live_meta.value_json, '$.nextAllowedAt') <= ?
       and not exists (
         select 1 from jobs
         where id = json_extract(live_meta.value_json, '$.jobId')
           and status = 'running' and id != ?
       )`,
    [key, json({ nextAllowedAt: now + RECENT_RECONCILE_MIN_INTERVAL_MS, jobId: jobId ?? null }), nowIso(), now, jobId ?? -1]);
  if (result.rowsAffected > 0) return 0;
  const row = (await exec(db, "select json_extract(value_json, '$.nextAllowedAt') as next_allowed_at from live_meta where key = ?", [key])).rows[0];
  // If the request outlives its cooldown, its running job still owns the gate.
  return Math.max(30_000, Number(row.next_allowed_at) - Date.now());
}

export async function finishRecentReconcileRequest(db: Db, userId: number): Promise<void> {
  await exec(db,
    `update live_meta
     set value_json = json_set(value_json, '$.nextAllowedAt', max(json_extract(value_json, '$.nextAllowedAt'), ?), '$.jobId', null),
         updated_at = ? where key = ?`,
    [Date.now() + RECENT_RECONCILE_MIN_INTERVAL_MS, nowIso(), `recent-reconcile:next-allowed:${userId}`]);
}

// Fresh feed activity resets the cadence, but never bypasses the per-user
// cooldown, API retry backoff, or pressure admission. It also makes this gap
// repair mandatory: a delayed job must still recover those newly seen plays.
export async function promotePendingRecentReconcileJobs(db: Db, userId: number, priority = RECENT_RECONCILE_REPAIR_PRIORITY): Promise<number> {
  const safeUserId = Math.floor(userId);
  if (!Number.isFinite(safeUserId) || safeUserId <= 0) return 0;
  const now = nowIso();
  const result = await exec(
    db,
    `update jobs
     set priority = max(priority, ?),
         run_after = max(
           case when status = 'failed' then run_after else min(run_after, ?) end,
           coalesce((select strftime('%Y-%m-%dT%H:%M:%fZ', json_extract(value_json, '$.nextAllowedAt') / 1000.0, 'unixepoch')
                     from live_meta where key = ?),
                    case when dedupe_key like 'recent:user:%:next:%'
                      then strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+2 minutes')
                      else ? end)
         ),
         payload_json = json_set(payload_json, '$.unchangedPolls', 0, '$.kind', 'gap_repair'),
         updated_at = ?
     where type = ?
       and status in ('queued', 'failed', 'deferred_pressure')
       and (payload_json = ? or dedupe_key = ? or dedupe_key like ?)`,
    [priority, now, `recent-reconcile:next-allowed:${safeUserId}`, now, now,
      RECENT_RECONCILE_JOB_TYPE, json({ userId: safeUserId }),
      `recent:user:${safeUserId}`, `recent:user:${safeUserId}:%`],
  );
  return Number(result.rowsAffected ?? 0);
}

// Upgrade existing repairs as well as new feed work, including leased jobs
// inherited from the previous worker. Priority alone never preempts a lease.
// Keep every job, deadline, cooldown and attempt; optional follow-ups retain
// their cadence.
export async function prioritizePendingRecentRepairs(db: Db): Promise<number> {
  const result = await exec(db,
    `update jobs set priority = ?
     where type = ? and status in ('queued', 'failed', 'deferred_pressure', 'running')
       and priority < ?
       and (json_extract(payload_json, '$.kind') = 'gap_repair'
         or (json_extract(payload_json, '$.kind') is null
           and dedupe_key not like 'recent:user:%:next:%'))`,
    [RECENT_RECONCILE_REPAIR_PRIORITY, RECENT_RECONCILE_JOB_TYPE, RECENT_RECONCILE_REPAIR_PRIORITY]);
  return Number(result.rowsAffected ?? 0);
}

export async function hasPendingRecentReconcileJob(
  db: Db,
  userId: number,
  options: { excludeJobId?: number; statuses?: JobStatus[] } = {},
): Promise<boolean> {
  const safeUserId = Math.floor(userId);
  if (!Number.isFinite(safeUserId) || safeUserId <= 0) return false;
  const statuses = options.statuses ?? ["queued", "failed", "running", "deferred_pressure"];
  if (statuses.length === 0) return false;
  const excludeSql = options.excludeJobId == null ? "" : "and id != ?";
  const row = (await exec(
    db,
    `select 1
     from jobs
     where type = ?
       and status in (${statuses.map(() => "?").join(", ")})
       and (payload_json = ? or dedupe_key = ? or dedupe_key like ?)
       ${excludeSql}
     limit 1`,
    [
      RECENT_RECONCILE_JOB_TYPE,
      ...statuses,
      json({ userId: safeUserId }),
      `recent:user:${safeUserId}`,
      `recent:user:${safeUserId}:%`,
      ...(options.excludeJobId == null ? [] : [options.excludeJobId]),
    ],
  )).rows[0];
  return !!row;
}
