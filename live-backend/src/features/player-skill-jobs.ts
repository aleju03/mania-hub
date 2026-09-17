import { exec, type Db } from "../db.js";
import type { JobQueue } from "../jobs/queue.js";
import { logInfo, logWarn } from "../logger.js";

export interface PlayerSkillJobPayload {
  userId: number;
  /** How many revision retries this chain has already spent (see
   * revisionRetryDelayMs); absent on ordinary computes. */
  revisionRetries?: number;
  rateVibroPending?: number;
  calibrationPending?: number;
  danPending?: number;
  lnMigrationProgress?: string;
}

// The deployment has one worker process, with two slots sharing this handler.
// Keep the turn until the actual handler settles, including after a watchdog
// abort. Waiting callers must run again: their score may have arrived after
// the previous caller read its inputs.
const turns = new WeakMap<Db, Map<number, Promise<void>>>();

export async function withPlayerSkillTurn<T>(db: Db, userId: number, run: () => Promise<T>): Promise<T> {
  let users = turns.get(db);
  if (!users) turns.set(db, users = new Map());
  const previous = users.get(userId);
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  users.set(userId, current);
  await previous;
  try {
    return await run();
  } finally {
    release();
    if (users.get(userId) === current) users.delete(userId);
  }
}

export async function settlePlayerSkillContinuations(
  db: Db,
  queue: JobQueue,
  version: number,
  rateVersion: number,
  payload: PlayerSkillJobPayload,
  progress: { rateVibroPending: number; calibrationPending: number; lnPending: number; lnMigrationProgress: string; danPending?: number },
  startedAt: string,
): Promise<void> {
  const rateAdvanced = progress.rateVibroPending > 0
    && (payload.rateVibroPending == null || progress.rateVibroPending < payload.rateVibroPending);
  const calibrationAdvanced = progress.calibrationPending > 0
    && (payload.calibrationPending == null || progress.calibrationPending < payload.calibrationPending);
  const lnAdvanced = progress.lnPending > 0 && progress.lnMigrationProgress !== payload.lnMigrationProgress;
  const danPending = progress.danPending ?? 0;
  const danAdvanced = danPending > 0 && (payload.danPending == null || danPending < payload.danPending);
  const prefix = `player-skills:${version}:${payload.userId}:`;
  let nextKey = "";
  if (rateAdvanced || calibrationAdvanced || lnAdvanced || danAdvanced) {
    nextKey = `${prefix}continue:${progress.lnMigrationProgress}:${progress.calibrationPending}:${progress.rateVibroPending}${danPending ? `:dan:${danPending}` : ""}`;
    // Persist the replacement BEFORE retiring siblings. A failed enqueue or
    // process exit must leave the old work recoverable. All budgets advance
    // in the same compute, so they need only one continuation between them.
    await queue.enqueue("compute_player_skills", nextKey, {
      userId: payload.userId,
      rateVibroPending: progress.rateVibroPending,
      calibrationPending: progress.calibrationPending,
      lnMigrationProgress: progress.lnMigrationProgress,
      ...(danPending ? { danPending } : {}),
    }, {
      priority: rateAdvanced ? 5 : -5,
      runAfter: new Date(Date.now() + (rateAdvanced ? 60_000 : 0)),
      replaceDone: true,
    });
  } else if (progress.rateVibroPending > 0 || progress.calibrationPending > 0 || progress.lnPending > 0 || danPending > 0) {
    logWarn("player_skills_continuation_stalled", { userId: payload.userId, ...progress });
  }

  // Range predicates use the unique dedupe index. Never retire a base job
  // (profile view/session wakeup), a live lease, a different version, or work
  // enqueued after this compute started. The new continuation stays pending
  // even when timestamps happen to share the same millisecond.
  const prefixes = [prefix + "ln:", prefix + "wife:", prefix + "continue:",
    `player-skills-rate-vibro:${rateVersion}:${payload.userId}:`];
  // NOT INDEXED leaves the outer update using integer primary-key lookups;
  // otherwise SQLite chooses status/updated_at and scans the entire backlog.
  const retired = await exec(db, `update jobs not indexed
    set status = 'done', locked_by = null, locked_until = null,
      last_error = 'Superseded by a successful player skill computation', updated_at = ?
    where type = 'compute_player_skills' and status in ('queued', 'failed', 'deferred_pressure')
      and updated_at <= ? and dedupe_key != ?
      and id in (select id from jobs where ${prefixes.map(() => "(dedupe_key >= ? and dedupe_key < ?)").join(" or ")})`,
  [new Date().toISOString(), startedAt, nextKey, ...prefixes.flatMap((value) => [value, value + "\uffff"])]);
  if (retired.rowsAffected > 0) {
    logInfo("player_skills_continuations_coalesced", { userId: payload.userId, retired: retired.rowsAffected, continued: !!nextKey });
  }
}

const REVISION_RETRY_BASE_MS = 15 * 60_000;
const REVISION_RETRY_MAX_MS = 6 * 60 * 60_000;

/**
 * Delay before a compute retries a player whose charts are still waiting on
 * a revision verify. 15 minutes doubling to 6 hours: the verify queue can sit
 * at thousands of deferred rows for days, and a flat 15-minute retry per
 * affected player (2,200 of them on prod, 2026-09-17) asked the calc lane
 * for ~8,800 no-op computes an hour against ~600 it can do.
 */
export function revisionRetryDelayMs(retries: number): number {
  const n = Math.max(0, Math.min(20, Math.floor(Number(retries) || 0)));
  return Math.min(REVISION_RETRY_MAX_MS, REVISION_RETRY_BASE_MS * 2 ** n);
}
