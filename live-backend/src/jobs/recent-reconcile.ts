import type { Db } from "../db.js";
import { exec, json } from "../db.js";
import { nowIso } from "../shared/score.js";
import type { JobStatus } from "./queue.js";

export const RECENT_RECONCILE_JOB_TYPE = "reconcile_user_recent_scores";

export interface RecentReconcilePayload {
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

// A fresh score means the user's recent-score list is worth refreshing now:
// osu! can flip fields such as has_replay shortly after oSC emits the score.
export async function promotePendingRecentReconcileJobs(db: Db, userId: number, priority = 70): Promise<number> {
  const safeUserId = Math.floor(userId);
  if (!Number.isFinite(safeUserId) || safeUserId <= 0) return 0;
  const now = nowIso();
  const result = await exec(
    db,
    `update jobs
     set status = 'queued',
         priority = max(priority, ?),
         run_after = ?,
         locked_by = null,
         locked_until = null,
         last_error = null,
         payload_json = json_set(payload_json, '$.unchangedPolls', 0),
         updated_at = ?
     where type = ?
       and status in ('queued', 'failed', 'deferred_pressure')
       and (payload_json = ? or dedupe_key = ? or dedupe_key like ?)`,
    [
      priority,
      now,
      now,
      RECENT_RECONCILE_JOB_TYPE,
      json({ userId: safeUserId }),
      `recent:user:${safeUserId}`,
      `recent:user:${safeUserId}:%`,
    ],
  );
  return Number(result.rowsAffected ?? 0);
}

// Pressure-deferred jobs only reactivate when queue depth drops below the
// recovery threshold, which a busy queue can fail to reach for hours. A fresh
// score from the user is a stronger signal: revive their parked reconcile so
// the catch-up chain (which picks up plays oSC does not carry) keeps running.
export async function requeueDeferredRecentReconcileJobs(db: Db, userId: number): Promise<number> {
  const safeUserId = Math.floor(userId);
  if (!Number.isFinite(safeUserId) || safeUserId <= 0) return 0;
  const now = nowIso();
  const result = await exec(
    db,
    `update jobs
     set status = 'queued',
         run_after = ?,
         last_error = null,
         updated_at = ?
     where type = ?
       and status = 'deferred_pressure'
       and (payload_json = ? or dedupe_key = ? or dedupe_key like ?)`,
    [
      now,
      now,
      RECENT_RECONCILE_JOB_TYPE,
      json({ userId: safeUserId }),
      `recent:user:${safeUserId}`,
      `recent:user:${safeUserId}:%`,
    ],
  );
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
