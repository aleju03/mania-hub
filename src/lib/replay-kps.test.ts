import { describe, expect, it } from "vitest";
import { buildReplayPeakKps, replayPeakKpsAt } from "./replay-kps";

function slowPeak(presses: number[], time: number, windowMs: number, rate: number) {
  let peak = 0;
  for (let end = 0; end < presses.length && presses[end] <= time; end++) {
    const start = Math.max(0, presses[end] - windowMs * rate);
    const count = presses.slice(0, end + 1).filter((press) => press >= start).length;
    peak = Math.max(peak, count);
  }
  return peak * 1000 / windowMs;
}

describe("replay peak KPS", () => {
  it.each([0.75, 1, 1.25, 1.5, 2])("matches the full scan at rate %s across forward and backward seeks", (rate) => {
    const presses = [-20, 0, 0, 100, 200, 200, 800, 1000, 1600, 4000, 4000, 4100];
    const windowMs = 1000;
    const peaks = buildReplayPeakKps(presses, windowMs, rate);
    for (const time of [-100, 0, 100, 200, 2000, 9000, 100, 0, 4100, 1600]) {
      expect(replayPeakKpsAt(presses, peaks, time, windowMs)).toBe(slowPeak(presses, time, windowMs, rate));
    }
  });

  it("includes chords and the exact window boundary, retaining the maximum after silence", () => {
    const presses = [0, 0, 1000, 1000, 1001, 10000];
    const peaks = buildReplayPeakKps(presses, 1000, 1);
    expect(replayPeakKpsAt(presses, peaks, 1000, 1000)).toBe(4);
    expect(replayPeakKpsAt(presses, peaks, 20000, 1000)).toBe(4);
  });

  it("handles empty replays and rebuilds for a replaced preview", () => {
    expect(replayPeakKpsAt([], buildReplayPeakKps([], 1000, 1), 10000, 1000)).toBe(0);
    const replaced = [500];
    expect(replayPeakKpsAt(replaced, buildReplayPeakKps(replaced, 1000, 1.5), 10000, 1000)).toBe(1);
  });
});
