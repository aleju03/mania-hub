import type { Db } from "../db.js";
import { exec, json, parseJson } from "../db.js";
import type { LimiterLane, SharedLimiter } from "./client.js";

const WINDOW_MS = 60_000;
const PRUNE_AFTER_MS = 5 * 60_000;
const PAUSE_KEY = "control:osu_rate_limit_paused_until";

export interface SqliteSharedRateLimiterOptions {
  provider?: string;
  targetPerMinute: number;
  hardPerMinute: number;
}

export class SqliteSharedRateLimiter implements SharedLimiter {
  private readonly provider: string;
  private readonly targetPerMinute: number;
  private readonly hardPerMinute: number;
  private reservationTail: Promise<void> = Promise.resolve();

  constructor(private readonly db: Db, options: SqliteSharedRateLimiterOptions) {
    this.provider = options.provider ?? "osu";
    this.targetPerMinute = Math.max(1, Math.floor(options.targetPerMinute));
    this.hardPerMinute = Math.max(1, Math.floor(options.hardPerMinute));
  }

  async reserve(caller: string, path: string, lane: LimiterLane): Promise<number> {
    for (;;) {
      const waitMs = await this.withReservationLock(() => this.tryReserve(caller, path, lane));
      if (waitMs <= 0) return Date.now();
      await sleep(waitMs);
    }
  }

  async pause(ms: number): Promise<void> {
    if (!Number.isFinite(ms) || ms <= 0) return;
    const pausedUntil = Date.now() + Math.ceil(ms);
    await exec(
      this.db,
      `insert into live_meta (key, value_json, updated_at)
       values (?, ?, ?)
       on conflict(key) do update set
         value_json = case
           when cast(json_extract(live_meta.value_json, '$') as integer) > ? then live_meta.value_json
           else excluded.value_json
         end,
         updated_at = excluded.updated_at`,
      [PAUSE_KEY, json(pausedUntil), new Date().toISOString(), pausedUntil],
    ).catch(() => undefined);
  }

  async state(): Promise<{ usedLastMinute: number; pausedMs: number; targetPerMinute: number; hardPerMinute: number }> {
    const now = Date.now();
    const row = (await exec(
      this.db,
      "select count(*) as count from api_rate_limit_reservations where provider = ? and started_at_ms > ?",
      [this.provider, now - WINDOW_MS],
    )).rows[0];
    return {
      usedLastMinute: Number(row?.count ?? 0),
      pausedMs: Math.max(0, await this.readPausedUntil() - now),
      targetPerMinute: this.targetPerMinute,
      hardPerMinute: this.hardPerMinute,
    };
  }

  private async tryReserve(caller: string, path: string, lane: LimiterLane): Promise<number> {
    const now = Date.now();
    await exec(
      this.db,
      "delete from api_rate_limit_reservations where provider = ? and started_at_ms < ?",
      [this.provider, now - PRUNE_AFTER_MS],
    );

    const pausedUntil = await this.readPausedUntil();
    let waitMs = pausedUntil > now ? pausedUntil - now : 0;

    const windowRows = (await exec(
      this.db,
      `select count(*) as count, min(started_at_ms) as oldest
       from api_rate_limit_reservations
       where provider = ? and started_at_ms > ?`,
      [this.provider, now - WINDOW_MS],
    )).rows[0];
    const used = Number(windowRows?.count ?? 0);
    const oldest = Number(windowRows?.oldest ?? 0);
    if (used >= this.hardPerMinute && Number.isFinite(oldest) && oldest > 0) {
      waitMs = Math.max(waitMs, oldest + WINDOW_MS + 1 - now);
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

  private async readPausedUntil(): Promise<number> {
    const row = (await exec(this.db, "select value_json from live_meta where key = ?", [PAUSE_KEY])).rows[0];
    return parseJson<number>(row?.value_json, 0);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(1, Math.ceil(ms)));
    timer.unref?.();
  });
}
