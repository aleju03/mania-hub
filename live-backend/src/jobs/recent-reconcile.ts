import type { Db } from "../db.js";
import { exec, json } from "../db.js";
import type { JobStatus } from "./queue.js";

export const RECENT_RECONCILE_JOB_TYPE = "reconcile_user_recent_scores";

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
