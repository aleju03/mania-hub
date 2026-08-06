import type { Db } from "../db.js";
import { exec } from "../db.js";
import type { JobQueue } from "../jobs/queue.js";
import { logInfo } from "../logger.js";
import { OsuApiError, PACK_WARM_CALLER, type OsuApiClient } from "../osu/client.js";
import { markUserMissing } from "../users.js";
import { fetchAndStoreProfileSnapshotShared } from "./player-profiles.js";

export const PROFILE_POOL_WARM_JOB = "warm_profile_pool";

/* A pack reveal blocks on a live osu! fetch only for players with no stored
   best scores at all (never-fetched profile snapshot AND an empty
   user_top_scores projection). This sweep drains that set once, a few
   players per run, so pack opens converge to pure local DB reads. Staleness
   is not the sweep's problem: an existing snapshot of any age already serves
   instantly, and active players are refreshed by the score pipeline. */
const POOL_WARM_BATCH_SIZE = 3;
// ~3 players x ~3 osu! calls per 2.5 minutes: under 10% of the API budget,
// draining a fully cold ~6k pool in a few days.
const POOL_WARM_CHAIN_DELAY_MS = 150_000;
const POOL_WARM_JOB_PRIORITY = -8;

export interface ProfilePoolWarmResult {
  warmed: number;
  markedMissing: number;
  done: boolean;
}

/* Pool players (ranked roster members plus manual opt-ins, the same set pack
   draws come from) with no stored best scores anywhere. pp desc so the top
   slices (elite and legend packs) go warm first. */
export async function selectColdPoolUserIds(db: Db, limit: number): Promise<number[]> {
  const rows = (await exec(
    db,
    `select u.user_id
     from users u
     where u.pp is not null
       and coalesce(u.is_active, 1) = 1
       and exists (
         select 1 from country_rosters ro
         where ro.user_id = u.user_id and ro.is_tracked = 1
           and (ro.rank is not null or ro.source = 'manual')
       )
       and not exists (select 1 from profile_snapshots ps where ps.user_id = u.user_id)
       and not exists (select 1 from user_top_scores uts where uts.user_id = u.user_id)
     order by u.pp desc
     limit ?`,
    [Math.max(1, Math.floor(limit))],
  )).rows;
  return rows
    .map((row) => Number(row.user_id))
    .filter((userId) => Number.isSafeInteger(userId) && userId > 0);
}

export async function runProfilePoolWarmJob(
  db: Db,
  queue: JobQueue,
  osu: Pick<OsuApiClient, "getUserByKey" | "getUserBestScoresWindow">,
  payload: { seq?: number },
): Promise<ProfilePoolWarmResult> {
  const userIds = await selectColdPoolUserIds(db, POOL_WARM_BATCH_SIZE);
  if (userIds.length === 0) {
    logInfo("profile_pool_warm_done", {});
    return { warmed: 0, markedMissing: 0, done: true };
  }

  let warmed = 0;
  let markedMissing = 0;
  for (const userId of userIds) {
    try {
      await fetchAndStoreProfileSnapshotShared(db, osu, String(userId), "userId", PACK_WARM_CALLER);
      warmed += 1;
    } catch (error) {
      if (error instanceof OsuApiError && error.status === 404) {
        // Banned/restricted: untrack so neither the sweep nor future pack
        // draws select this user again (same soft-delete the 404 path of the
        // other user jobs uses).
        await markUserMissing(db, userId, `${PROFILE_POOL_WARM_JOB}: ${error.message}`);
        markedMissing += 1;
        continue;
      }
      // Transient (API down, 429): fail the job so its backoff retries the
      // batch; every player warmed so far is already stored.
      throw error;
    }
  }

  logInfo("profile_pool_warm_batch", { warmed, marked_missing: markedMissing });
  const seq = Math.floor(Number(payload?.seq ?? 0)) || 0;
  await enqueueProfilePoolWarm(queue, seq + 1, new Date(Date.now() + POOL_WARM_CHAIN_DELAY_MS));
  return { warmed, markedMissing, done: false };
}

/* Scheduler tick: (re)start the chain only when no link of it is pending, so
   a watchdog restart never accelerates the chain's pacing. Skips enqueueing
   entirely while the pool has nothing cold. */
export async function enqueueProfilePoolWarmIfIdle(db: Db, queue: JobQueue): Promise<boolean> {
  const pending = (await exec(
    db,
    `select 1 from jobs
     where type = ? and status in ('queued', 'running', 'failed', 'deferred_pressure')
     limit 1`,
    [PROFILE_POOL_WARM_JOB],
  )).rows[0];
  if (pending) return false;
  const cold = await selectColdPoolUserIds(db, 1);
  if (cold.length === 0) return false;
  // Seed the chain's sequence from the clock so a fresh chain never collides
  // with a finished chain's done rows.
  await enqueueProfilePoolWarm(queue, Date.now(), new Date());
  return true;
}

function enqueueProfilePoolWarm(queue: JobQueue, seq: number, runAfter: Date): Promise<void> {
  return queue.enqueue(
    PROFILE_POOL_WARM_JOB,
    `${PROFILE_POOL_WARM_JOB}:${seq}`,
    { seq },
    { priority: POOL_WARM_JOB_PRIORITY, runAfter, replaceDone: true },
  );
}
