// How long each key press was held, per column, for the Hold times overlay.
// Durations are real milliseconds (divided by the rate mod), binned up to
// REPLAY_HOLD_TIME_MAX_MS; longer holds (long notes, mostly) are left out.
export const REPLAY_HOLD_TIME_MAX_MS = 200;
export const REPLAY_HOLD_TIME_BIN_MS = 4;
export const REPLAY_HOLD_TIME_BINS = REPLAY_HOLD_TIME_MAX_MS / REPLAY_HOLD_TIME_BIN_MS;

export interface ReplayHoldTimes {
  keyCount: number;
  /** Release time of each counted hold, in game time, ascending. */
  ends: Float64Array;
  /** Flat index (column * REPLAY_HOLD_TIME_BINS + bin) of each hold above. */
  slots: Uint16Array;
}

export function buildReplayHoldTimes(
  segments: ReadonlyArray<ReadonlyArray<{ start: number; end: number }>>,
  rate: number,
  openEnd: number,
): ReplayHoldTimes {
  const holds: Array<{ end: number; slot: number }> = [];
  const speed = Number.isFinite(rate) && rate > 0 ? rate : 1;
  segments.forEach((column, col) => {
    for (const { start, end } of column) {
      // A key still down when the replay ends was never released.
      if (end >= openEnd) continue;
      const held = (end - start) / speed;
      if (!(held >= 0) || held >= REPLAY_HOLD_TIME_MAX_MS) continue;
      holds.push({ end, slot: col * REPLAY_HOLD_TIME_BINS + Math.floor(held / REPLAY_HOLD_TIME_BIN_MS) });
    }
  });
  holds.sort((a, b) => a.end - b.end);
  return {
    keyCount: segments.length,
    ends: Float64Array.from(holds, (hold) => hold.end),
    slots: Uint16Array.from(holds, (hold) => hold.slot),
  };
}

/** Holds released at or before `time`. */
export function countReplayHoldsAt(holds: ReplayHoldTimes, time: number): number {
  let lo = 0;
  let hi = holds.ends.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (holds.ends[mid] <= time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// Running per-column counts that follow playback: forward steps add only the
// new releases, a backwards seek starts over.
export class ReplayHoldTimeHistogram {
  readonly counts: Uint32Array;
  private upTo = 0;

  constructor(private readonly holds: ReplayHoldTimes) {
    this.counts = new Uint32Array(holds.keyCount * REPLAY_HOLD_TIME_BINS);
  }

  /** Brings the counts to `time`; returns whether they changed. */
  advanceTo(time: number): boolean {
    const target = countReplayHoldsAt(this.holds, time);
    if (target === this.upTo) return false;
    if (target < this.upTo) {
      this.counts.fill(0);
      this.upTo = 0;
    }
    for (let i = this.upTo; i < target; i++) this.counts[this.holds.slots[i]]++;
    this.upTo = target;
    return true;
  }

  /** One column's counts with a light [1, 2, 1] smoothing, for drawing. */
  smoothedColumn(col: number, out: Float32Array = new Float32Array(REPLAY_HOLD_TIME_BINS)): Float32Array {
    const base = col * REPLAY_HOLD_TIME_BINS;
    for (let bin = 0; bin < REPLAY_HOLD_TIME_BINS; bin++) {
      const left = bin > 0 ? this.counts[base + bin - 1] : 0;
      const right = bin < REPLAY_HOLD_TIME_BINS - 1 ? this.counts[base + bin + 1] : 0;
      out[bin] = (left + 2 * this.counts[base + bin] + right) / 4;
    }
    return out;
  }
}
