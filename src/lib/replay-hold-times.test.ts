import { describe, expect, it } from "vitest";
import {
  REPLAY_HOLD_TIME_BINS,
  ReplayHoldTimeHistogram,
  buildReplayHoldTimes,
  countReplayHoldsAt,
} from "./replay-hold-times";

describe("replay hold times", () => {
  const segments = [
    [{ start: 0, end: 50 }, { start: 100, end: 400 }],
    [{ start: 10, end: 90 }, { start: 500, end: 1000 }],
  ];

  it("keeps released holds under the cap, sorted by release", () => {
    const holds = buildReplayHoldTimes(segments, 1, 1000);
    expect(Array.from(holds.ends)).toEqual([50, 90]);
    expect(Array.from(holds.slots)).toEqual([12, REPLAY_HOLD_TIME_BINS + 20]);
  });

  it("measures holds in real time under rate mods", () => {
    const holds = buildReplayHoldTimes([[{ start: 0, end: 150 }]], 1.5, 1000);
    expect(Array.from(holds.slots)).toEqual([25]);
  });

  it("follows playback forwards and backwards", () => {
    const holds = buildReplayHoldTimes(segments, 1, 1000);
    const histogram = new ReplayHoldTimeHistogram(holds);
    expect(countReplayHoldsAt(holds, 49)).toBe(0);
    expect(histogram.advanceTo(60)).toBe(true);
    expect(histogram.counts[12]).toBe(1);
    expect(histogram.advanceTo(70)).toBe(false);
    histogram.advanceTo(2000);
    expect(histogram.counts[REPLAY_HOLD_TIME_BINS + 20]).toBe(1);
    histogram.advanceTo(0);
    expect(histogram.counts.every((count) => count === 0)).toBe(true);
  });
});
