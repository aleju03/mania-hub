// Hit offsets for the Hit offsets and Offsets over time overlays: every
// judged hit short of a miss, the same set the hit error bar draws, in the
// judge's own milliseconds. Offsets past `range` sit in the end bins.
export const REPLAY_HIT_OFFSET_BINS = 48;
export const REPLAY_HIT_OFFSET_TIMELINE_COLUMNS = 240;
export const REPLAY_HIT_OFFSET_TIMELINE_ROWS = 60;

export interface ReplayHitOffsets {
  range: number;
  /** Judgement time of each hit, ascending. */
  times: Float64Array;
  offsets: Float32Array;
}

export function buildReplayHitOffsets(
  events: ReadonlyArray<{ judgment: number | null; offsetMs: number; time: number }>,
  range: number,
): ReplayHitOffsets {
  const hits = events
    .filter((event) => event.judgment != null && event.judgment >= 1 && event.judgment <= 5 && Number.isFinite(event.offsetMs))
    .map((event) => ({ time: event.time, offset: event.offsetMs }))
    .sort((a, b) => a.time - b.time);
  return {
    range: range > 0 ? range : 1,
    times: Float64Array.from(hits, (hit) => hit.time),
    offsets: Float32Array.from(hits, (hit) => hit.offset),
  };
}

function countAtOrBefore(times: Float64Array, time: number): number {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (times[mid] <= time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Hits judged at or before `time`. */
export function countReplayHitsAt(hits: ReplayHitOffsets, time: number): number {
  return countAtOrBefore(hits.times, time);
}

/** Bucket of `offset` among `buckets` equal slices of [-range, range]. */
export function replayHitOffsetBucket(offset: number, range: number, buckets: number): number {
  const bucket = Math.floor(((offset + range) / (2 * range)) * buckets);
  return Math.max(0, Math.min(buckets - 1, bucket));
}

// Running counts that follow playback: forward steps add only the new hits,
// a backwards seek starts over.
export class ReplayHitOffsetHistogram {
  readonly counts = new Uint32Array(REPLAY_HIT_OFFSET_BINS);
  private upTo = 0;
  private sum = 0;

  constructor(private readonly hits: ReplayHitOffsets) {}

  get total(): number {
    return this.upTo;
  }

  get mean(): number {
    return this.upTo > 0 ? this.sum / this.upTo : 0;
  }

  /** Brings the counts to `time`; returns whether they changed. */
  advanceTo(time: number): boolean {
    const target = countReplayHitsAt(this.hits, time);
    if (target === this.upTo) return false;
    if (target < this.upTo) {
      this.counts.fill(0);
      this.upTo = 0;
      this.sum = 0;
    }
    for (let i = this.upTo; i < target; i++) {
      const offset = this.hits.offsets[i];
      this.counts[replayHitOffsetBucket(offset, this.hits.range, REPLAY_HIT_OFFSET_BINS)]++;
      this.sum += offset;
    }
    this.upTo = target;
    return true;
  }
}

// The scatter as grid cells over the whole play: only the first hit to land
// in each cell is kept, so a dense chart draws a few thousand dots at most
// instead of one per note.
export interface ReplayHitOffsetDots {
  times: Float64Array;
  columns: Uint16Array;
  /** 0 is the earliest row, REPLAY_HIT_OFFSET_TIMELINE_ROWS - 1 the latest. */
  rows: Uint8Array;
}

export function buildReplayHitOffsetDots(hits: ReplayHitOffsets, duration: number): ReplayHitOffsetDots {
  const columns = REPLAY_HIT_OFFSET_TIMELINE_COLUMNS;
  const rows = REPLAY_HIT_OFFSET_TIMELINE_ROWS;
  const span = duration > 0 ? duration : 1;
  const taken = new Uint8Array(columns * rows);
  const times: number[] = [];
  const dotColumns: number[] = [];
  const dotRows: number[] = [];
  for (let i = 0; i < hits.times.length; i++) {
    const column = Math.max(0, Math.min(columns - 1, Math.floor((hits.times[i] / span) * columns)));
    const row = replayHitOffsetBucket(hits.offsets[i], hits.range, rows);
    const cell = column * rows + row;
    if (taken[cell]) continue;
    taken[cell] = 1;
    times.push(hits.times[i]);
    dotColumns.push(column);
    dotRows.push(row);
  }
  return {
    times: Float64Array.from(times),
    columns: Uint16Array.from(dotColumns),
    rows: Uint8Array.from(dotRows),
  };
}

/** Dots whose hit was judged at or before `time`. */
export function countReplayHitOffsetDotsAt(dots: ReplayHitOffsetDots, time: number): number {
  return countAtOrBefore(dots.times, time);
}
