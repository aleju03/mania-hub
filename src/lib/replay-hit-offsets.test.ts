import { describe, expect, it } from "vitest";
import {
  REPLAY_HIT_OFFSET_BINS,
  REPLAY_HIT_OFFSET_TIMELINE_ROWS,
  ReplayHitOffsetHistogram,
  buildReplayHitOffsetDots,
  buildReplayHitOffsets,
  countReplayHitOffsetDotsAt,
  countReplayHitsAt,
  replayHitOffsetBucket,
} from "./replay-hit-offsets";

describe("replay hit offsets", () => {
  const events = [
    { judgment: 1, offsetMs: -10, time: 100 },
    { judgment: 6, offsetMs: 151, time: 150 },
    { judgment: null, offsetMs: 0, time: 160 },
    { judgment: 3, offsetMs: 40, time: 200 },
    { judgment: 5, offsetMs: 500, time: 300 },
  ];

  it("keeps judged hits short of a miss, in time order", () => {
    const hits = buildReplayHitOffsets([...events].reverse(), 120);
    expect(Array.from(hits.times)).toEqual([100, 200, 300]);
    expect(Array.from(hits.offsets)).toEqual([-10, 40, 500]);
    expect(countReplayHitsAt(hits, 199)).toBe(1);
  });

  it("clamps offsets past the range into the end buckets", () => {
    expect(replayHitOffsetBucket(-1000, 120, REPLAY_HIT_OFFSET_BINS)).toBe(0);
    expect(replayHitOffsetBucket(0, 120, REPLAY_HIT_OFFSET_BINS)).toBe(REPLAY_HIT_OFFSET_BINS / 2);
    expect(replayHitOffsetBucket(1000, 120, REPLAY_HIT_OFFSET_BINS)).toBe(REPLAY_HIT_OFFSET_BINS - 1);
  });

  it("follows playback forwards and backwards", () => {
    const histogram = new ReplayHitOffsetHistogram(buildReplayHitOffsets(events, 120));
    expect(histogram.advanceTo(50)).toBe(false);
    expect(histogram.advanceTo(250)).toBe(true);
    expect(histogram.total).toBe(2);
    expect(histogram.mean).toBe(15);
    histogram.advanceTo(1000);
    expect(histogram.counts[REPLAY_HIT_OFFSET_BINS - 1]).toBe(1);
    histogram.advanceTo(0);
    expect(histogram.total).toBe(0);
    expect(histogram.counts.every((count) => count === 0)).toBe(true);
  });

  it("keeps one dot per timeline cell", () => {
    const hits = buildReplayHitOffsets([
      { judgment: 1, offsetMs: 0, time: 0 },
      { judgment: 1, offsetMs: 0.5, time: 1 },
      { judgment: 1, offsetMs: 60, time: 2 },
      { judgment: 1, offsetMs: 0, time: 900 },
    ], 120);
    const dots = buildReplayHitOffsetDots(hits, 1000);
    expect(Array.from(dots.times)).toEqual([0, 2, 900]);
    expect(dots.rows[0]).toBe(REPLAY_HIT_OFFSET_TIMELINE_ROWS / 2);
    expect(dots.rows[1]).toBeGreaterThan(dots.rows[0]);
    expect(countReplayHitOffsetDotsAt(dots, 500)).toBe(2);
  });
});
