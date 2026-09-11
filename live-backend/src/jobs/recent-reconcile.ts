import type { Db } from "../db.js";
import { exec, json } from "../db.js";
import { nowIso } from "../shared/score.js";
import type { JobStatus } from "./queue.js";

export const RECENT_RECONCILE_JOB_TYPE = "reconcile_user_recent_scores";
// One priority for the whole schedule. The old split (repairs at 150, live
// follow-ups at 25) starved the follow-ups behind a permanent stream of
// repairs: on prod they ran a median 37 minutes late and most expired unrun.
// With a single job per user and a budget-paced cadence, oldest-due-first is
// the fair order and nothing needs to outrank anything.
export const RECENT_RECONCILE_REPAIR_PRIORITY = 150;

export const RECENT_RECONCILE_MIN_INTERVAL_MS = 2 * 60_000;

// osu! serves a user's passed plays from the last 24 hours, at most 100 of
// them. That window is what makes completeness cheap: one poll inside it sees
// every play since the previous poll, so liveness (how soon a graveyard play
// shows up) and completeness (whether it shows up at all) are separate
// budgets. Live polls run while the session is on, spaced by how many
// sessions share the live budget; the closing poll, well inside the window,
// is the guarantee, and it repeats daily for as long as the user keeps
// appearing in their own recent list.
export const RECENT_LIVE_MIN_INTERVAL_MS = 3 * 60_000;
export const RECENT_LIVE_MAX_INTERVAL_MS = 20 * 60_000;
export const RECENT_SESSION_QUIET_MS = 30 * 60_000;
export const RECENT_CLOSING_DELAY_MS = 18 * 60 * 60_000;
const RECENT_UNCHANGED_POLL_CAP = 3;

export type RecentReconcileKind = "gap_repair" | "follow_up" | "closing";

export interface RecentReconcilePayload {
  kind?: RecentReconcileKind;
  userId: number;
  source?: string;
  processLeaderboardFeatures?: boolean;
  unchangedPolls?: number;
  latestScoreAt?: string;
}

// Spread the live budget evenly over the sessions currently open, clamped so
// a quiet site polls every three minutes and a busy one never falls below one
// poll per twenty minutes (which cannot overflow the 100-play page either).
export function liveRecentIntervalMs(openSessions: number, budgetPerMinute: number): number {
  const sessions = Math.max(0, Math.floor(openSessions));
  const budget = Math.max(0, budgetPerMinute);
  const spread = budget > 0 ? (sessions / budget) * 60_000 : RECENT_LIVE_MAX_INTERVAL_MS;
  return Math.min(RECENT_LIVE_MAX_INTERVAL_MS, Math.max(RECENT_LIVE_MIN_INTERVAL_MS, Math.round(spread)));
}

export interface RecentPollObservation {
  now: number;
  responseCount: number;
  pageLimit: number;
  responseNewestAtMs: number | null;
  responseOldestAtMs: number | null;
  // The newest play the feed itself saw in the last 30 minutes: a play can be
  // on the feed before osu!'s recent list shows it.
  trackedNewestAtMs: number | null;
  changed: boolean;
  previousUnchangedPolls: number | undefined;
  liveIntervalMs: number;
}

export interface RecentPollPlan {
  // null ends the schedule: nothing polls this user again until the feed
  // sees a play of theirs.
  kind: "follow_up" | "closing" | null;
  unchangedPolls: number;
  delayMs: number;
  reason: "session_live" | "session_quiet" | "page_full" | "no_recent_plays";
}

export function planNextRecentPoll(o: RecentPollObservation): RecentPollPlan {
  const newestAtMs = Math.max(o.responseNewestAtMs ?? -Infinity, o.trackedNewestAtMs ?? -Infinity);
  const sinceNewestMs = Number.isFinite(newestAtMs) ? o.now - newestAtMs : Infinity;
  let plan: RecentPollPlan;
  if (sinceNewestMs <= RECENT_SESSION_QUIET_MS) {
    // The first unchanged poll keeps the base spacing (delayed replay and id
    // corrections land within it), then the spacing doubles up to the cap.
    const unchangedPolls = o.changed ? 0 : Math.min(RECENT_UNCHANGED_POLL_CAP, Math.max(0, Math.floor(o.previousUnchangedPolls ?? 0)) + 1);
    const delayMs = Math.min(RECENT_LIVE_MAX_INTERVAL_MS, o.liveIntervalMs * 2 ** Math.max(0, unchangedPolls - 1));
    plan = { kind: "follow_up", unchangedPolls, delayMs, reason: "session_live" };
  } else if (o.responseCount > 0) {
    plan = { kind: "closing", unchangedPolls: 0, delayMs: RECENT_CLOSING_DELAY_MS, reason: "session_quiet" };
  } else {
    return { kind: null, unchangedPolls: 0, delayMs: 0, reason: "no_recent_plays" };
  }
  // A full page means plays may already be falling off the far end. Poll
  // again within half the span the page covers, whatever the schedule said.
  if (o.responseCount >= o.pageLimit && o.responseNewestAtMs != null && o.responseOldestAtMs != null) {
    const tightMs = Math.max(RECENT_LIVE_MIN_INTERVAL_MS, Math.floor((o.responseNewestAtMs - o.responseOldestAtMs) / 2));
    if (tightMs < plan.delayMs) return { kind: "follow_up", unchangedPolls: plan.unchangedPolls, delayMs: tightMs, reason: "page_full" };
  }
  return plan;
}

// Sessions currently open: every pending poll that is not a closing
// appointment. Drives the live spacing above.
export async function countOpenRecentSessions(db: Db): Promise<number> {
  const row = (await exec(
    db,
    `select count(*) as count from jobs
     where type = ?
       and status in ('queued', 'failed', 'running', 'deferred_pressure')
       and coalesce(json_extract(payload_json, '$.kind'), '') != 'closing'`,
    [RECENT_RECONCILE_JOB_TYPE],
  )).rows[0];
  return Number(row?.count ?? 0);
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

// Lift every pending poll, including leased jobs inherited from the previous
// worker, to the schedule's one priority. Rows written under the old
// repair/follow-up split otherwise keep starving in priority-desc
// reactivation. Priority alone never preempts a lease; every job, deadline,
// cooldown and attempt is kept.
export async function prioritizePendingRecentRepairs(db: Db): Promise<number> {
  const result = await exec(db,
    `update jobs set priority = ?
     where type = ? and status in ('queued', 'failed', 'deferred_pressure', 'running')
       and priority < ?`,
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
