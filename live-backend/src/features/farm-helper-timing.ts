// Optional stage-level timing for the Farm Helper serving path.
//
// A request only pays for this when a collector is threaded in. Every helper
// here takes `timings | undefined` and, when it is undefined, calls straight
// through without allocating a wrapper promise or a closure result - so the
// Discord, backtest and test callers that pass nothing keep the exact shape of
// the old call. The collector never touches the snapshot payload; it only
// feeds `Server-Timing` and the slow-request log.

export type FarmHelperCacheState = "hit" | "miss" | "expired" | "coalesced";

export interface FarmHelperTimingSubject {
  userId: number;
  keyMode: string;
  view: string;
  limit: number;
}

export class FarmHelperTimings {
  private readonly durations = new Map<string, number>();
  private readonly counters = new Map<string, number>();
  private cacheState: FarmHelperCacheState = "miss";
  private subject: FarmHelperTimingSubject | null = null;

  // Stages that run per keymode (two runs on the "any" view) accumulate, so a
  // stage total is the request's real spend on that kind of work.
  add(stage: string, durationMs: number): void {
    this.durations.set(stage, (this.durations.get(stage) ?? 0) + durationMs);
  }

  count(key: string, value: number): void {
    if (!Number.isFinite(value)) return;
    this.counters.set(key, (this.counters.get(key) ?? 0) + value);
  }

  setCacheState(state: FarmHelperCacheState): void {
    this.cacheState = state;
  }

  getCacheState(): FarmHelperCacheState {
    return this.cacheState;
  }

  // Which request this was, for the slow log. Identity only: never a profile
  // payload or score data.
  setSubject(subject: FarmHelperTimingSubject): void {
    this.subject = subject;
  }

  // `name;dur=1.2` segments for the Server-Timing header, in insertion order
  // (which follows the request's own stage order).
  toServerTiming(): string {
    const parts: string[] = [`fh_cache_${this.cacheState};dur=0`];
    for (const [stage, durationMs] of this.durations) {
      parts.push(`${stage};dur=${durationMs.toFixed(1)}`);
    }
    return parts.join(", ");
  }

  // Flat log fields: `stage_*` milliseconds plus the raw counters, for the
  // slow_http_request breakdown. Rounded so the log stays readable.
  toLogFields(): Record<string, number | string> {
    const fields: Record<string, number | string> = { fh_cache: this.cacheState };
    if (this.subject) {
      fields.fh_user_id = this.subject.userId;
      fields.fh_key_mode = this.subject.keyMode;
      fields.fh_view = this.subject.view;
      fields.fh_limit = this.subject.limit;
    }
    for (const [stage, durationMs] of this.durations) fields[`ms_${stage}`] = Math.round(durationMs);
    for (const [key, value] of this.counters) fields[`n_${key}`] = Math.round(value);
    return fields;
  }
}

export function timeStage<T>(
  timings: FarmHelperTimings | undefined,
  stage: string,
  run: () => Promise<T>,
): Promise<T> {
  if (!timings) return run();
  const startedAt = performance.now();
  const finish = () => timings.add(stage, performance.now() - startedAt);
  return run().then(
    (value) => {
      finish();
      return value;
    },
    (error) => {
      finish();
      throw error;
    },
  );
}

export function timeStageSync<T>(
  timings: FarmHelperTimings | undefined,
  stage: string,
  run: () => T,
): T {
  if (!timings) return run();
  const startedAt = performance.now();
  try {
    return run();
  } finally {
    timings.add(stage, performance.now() - startedAt);
  }
}
