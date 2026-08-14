import type { Db } from "../db.js";
import { exec, json, parseJson } from "../db.js";
import type { LimiterLane, SharedLimiter } from "./client.js";
import { INTERACTIVE_PAUSE_CAP_MS } from "./client.js";

const WINDOW_MS = 60_000;
const PRUNE_AFTER_MS = 5 * 60_000;
// How often the reservation table is actually swept. It used to be swept on
// every reservation ATTEMPT — which is not once per API call but once per
// wake-up of every caller waiting out its turn, so a saturated API budget
// produced a storm of write-lock acquisitions on the busiest database in the
// system exactly when it was already contended, each of them a durable write
// with the full busy-retry budget behind it. The rows only back a 60s window
// query and a 5-minute cutoff, so sweeping once a minute (best-effort, skipped
// the moment the writer is busy) is all this ever needed to be.
export const PRUNE_INTERVAL_MS = 60_000;
const PAUSE_KEY = "control:osu_rate_limit_paused_until";
// Reservation is a retry loop with no queue: every other caller (in this
// process or the sibling server/worker process) that lands a reservation
// pushes the next background slot further out, so under sustained API
// saturation one unlucky caller can starve indefinitely. That starvation
// parked a whole worker lane in prod (the lane awaits its job, the job awaits
// this reserve). Give up after this long instead; the caller's own retry
// machinery (job backoff, HTTP error) handles it far more gracefully than an
// await that never settles.
const DEFAULT_MAX_RESERVE_WAIT_MS = 10 * 60_000;

export interface SqliteSharedRateLimiterOptions {
  provider?: string;
  targetPerMinute: number;
  hardPerMinute: number;
  maxReserveWaitMs?: number;
  // Capacity interactive requests may not consume. Defaults to 20% of the
  // hard window (while always leaving at least one interactive slot).
  backgroundReservedPerMinute?: number;
}

export class SqliteSharedRateLimiter implements SharedLimiter {
  private readonly provider: string;
  private readonly targetPerMinute: number;
  private readonly hardPerMinute: number;
  private readonly backgroundReservedPerMinute: number;
  private readonly interactivePerMinute: number;
  private readonly maxReserveWaitMs: number;
  private reservationTail: Promise<void> = Promise.resolve();
  private lastPruneAtMs = 0;

  constructor(private readonly db: Db, options: SqliteSharedRateLimiterOptions) {
    this.provider = options.provider ?? "osu";
    this.targetPerMinute = Math.max(1, Math.floor(options.targetPerMinute));
    this.hardPerMinute = Math.max(1, Math.floor(options.hardPerMinute));
    const defaultReserve = this.hardPerMinute > 1
      ? Math.max(1, Math.floor(this.hardPerMinute * 0.2))
      : 0;
    const requestedReserve = Number.isFinite(options.backgroundReservedPerMinute)
      ? Math.floor(Number(options.backgroundReservedPerMinute))
      : defaultReserve;
    this.backgroundReservedPerMinute = Math.max(
      0,
      Math.min(
        this.hardPerMinute - 1,
        requestedReserve,
      ),
    );
    this.interactivePerMinute = this.hardPerMinute - this.backgroundReservedPerMinute;
    this.maxReserveWaitMs = Math.max(1, Math.floor(options.maxReserveWaitMs ?? DEFAULT_MAX_RESERVE_WAIT_MS));
  }

  async reserve(caller: string, path: string, lane: LimiterLane): Promise<number> {
    const deadline = Date.now() + this.maxReserveWaitMs;
    for (;;) {
      const waitMs = await this.withReservationLock(() => this.tryReserve(caller, path, lane));
      if (waitMs <= 0) return Date.now();
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new Error(`osu! API shared limiter starved ${caller} ${path} for ${this.maxReserveWaitMs}ms`);
      }
      await sleep(Math.min(waitMs, remainingMs));
    }
  }

  async pause(ms: number): Promise<void> {
    if (!Number.isFinite(ms) || ms <= 0) return;
    const now = Date.now();
    const pausedUntil = now + Math.ceil(ms);
    await exec(
      this.db,
      `insert into live_meta (key, value_json, updated_at)
       values (?, ?, ?)
       on conflict(key) do update set
         value_json = case
           when coalesce(json_extract(live_meta.value_json, '$.until'), cast(live_meta.value_json as integer)) > ? then live_meta.value_json
           else excluded.value_json
         end,
         updated_at = excluded.updated_at`,
      [PAUSE_KEY, json({ until: pausedUntil, at: now }), new Date().toISOString(), pausedUntil],
    ).catch(() => undefined);
  }

  async state(): Promise<{ usedLastMinute: number; pausedMs: number; targetPerMinute: number; hardPerMinute: number; backgroundReservedPerMinute: number }> {
    const now = Date.now();
    const row = (await exec(
      this.db,
      "select count(*) as count from api_rate_limit_reservations where provider = ? and started_at_ms > ?",
      [this.provider, now - WINDOW_MS],
    )).rows[0];
    return {
      usedLastMinute: Number(row?.count ?? 0),
      pausedMs: Math.max(0, (await this.readPause()).until - now),
      targetPerMinute: this.targetPerMinute,
      hardPerMinute: this.hardPerMinute,
      backgroundReservedPerMinute: this.backgroundReservedPerMinute,
    };
  }

  private async tryReserve(caller: string, path: string, lane: LimiterLane): Promise<number> {
    const now = Date.now();
    await this.pruneExpired(now);

    const pause = await this.readPause();
    // Interactive calls resume after a short cooldown instead of sitting out
    // the whole 429 pause (mirrors TokenBucketLimiter.nextWaitMs).
    const pausedUntil = lane === "interactive"
      ? Math.min(pause.until, pause.at + INTERACTIVE_PAUSE_CAP_MS)
      : pause.until;
    let waitMs = pausedUntil > now ? pausedUntil - now : 0;

    const windowRows = (await exec(
      this.db,
      `select
         count(*) as count,
         min(started_at_ms) as oldest,
         sum(case when lane = 'interactive' then 1 else 0 end) as interactive_count,
         min(case when lane = 'interactive' then started_at_ms end) as oldest_interactive
       from api_rate_limit_reservations
       where provider = ? and started_at_ms > ?`,
      [this.provider, now - WINDOW_MS],
    )).rows[0];
    const used = Number(windowRows?.count ?? 0);
    const oldest = Number(windowRows?.oldest ?? 0);
    const interactiveUsed = Number(windowRows?.interactive_count ?? 0);
    const oldestInteractive = Number(windowRows?.oldest_interactive ?? 0);
    if (used >= this.hardPerMinute && Number.isFinite(oldest) && oldest > 0) {
      waitMs = Math.max(waitMs, oldest + WINDOW_MS + 1 - now);
    }

    // Interactive traffic may burst above the paced target, but it may not
    // occupy the whole hard window. Leaving this slice unused by interactive
    // callers guarantees that a worker process can reserve a job slot after
    // target spacing even while the public server remains saturated.
    if (lane === "interactive"
      && interactiveUsed >= this.interactivePerMinute
      && Number.isFinite(oldestInteractive)
      && oldestInteractive > 0) {
      waitMs = Math.max(waitMs, oldestInteractive + WINDOW_MS + 1 - now);
    }

    if (lane !== "interactive") {
      const latestRow = (await exec(
        this.db,
        "select max(started_at_ms) as latest from api_rate_limit_reservations where provider = ?",
        [this.provider],
      )).rows[0];
      const latest = Number(latestRow?.latest ?? 0);
      if (Number.isFinite(latest) && latest > 0) {
        waitMs = Math.max(waitMs, latest + Math.ceil(WINDOW_MS / this.targetPerMinute) - now);
      }
    }

    if (waitMs > 0) return Math.ceil(waitMs);

    await exec(
      this.db,
      `insert into api_rate_limit_reservations
         (provider, started_at_ms, caller, path, lane, created_at_ms)
       values (?, ?, ?, ?, ?, ?)`,
      [this.provider, now, caller, path, lane, now],
    );
    return 0;
  }

  /* Housekeeping, deliberately off the reservation's critical path: the stamp
     is claimed before the await so concurrent reservations don't stack sweeps,
     and a busy writer skips it (the rows simply live a little longer). */
  private async pruneExpired(now: number): Promise<void> {
    if (now - this.lastPruneAtMs < PRUNE_INTERVAL_MS) return;
    this.lastPruneAtMs = now;
    await exec(
      this.db,
      "delete from api_rate_limit_reservations where provider = ? and started_at_ms < ?",
      [this.provider, now - PRUNE_AFTER_MS],
      { bestEffort: true },
    ).catch(() => undefined);
  }

  private async withReservationLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.reservationTail;
    let release!: () => void;
    this.reservationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async readPause(): Promise<{ until: number; at: number }> {
    const row = (await exec(this.db, "select value_json from live_meta where key = ?", [PAUSE_KEY])).rows[0];
    const value = parseJson<number | { until?: number; at?: number }>(row?.value_json, 0);
    if (typeof value === "number") {
      // Legacy shape: a bare pausedUntil timestamp. The pause start is unknown,
      // so assume the default 60s pause length.
      return { until: value, at: value - 60_000 };
    }
    return { until: Number(value?.until ?? 0), at: Number(value?.at ?? 0) };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(1, Math.ceil(ms)));
    timer.unref?.();
  });
}
