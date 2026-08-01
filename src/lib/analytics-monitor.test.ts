/* The traffic chart is only readable if its axis is: ticks have to land on round
   local clock times and stay clear of the range's own start/"now" labels. */
import { describe, expect, it } from "vitest";
import { buildAnalyticsTimelineTicks } from "./analytics-monitor";

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

// Wall-clock offset for a given instant, as milliseconds to add to UTC.
function localOffsetMs(ts: number): number {
  return -new Date(ts).getTimezoneOffset() * 60_000;
}

function stepsFromLocalMidnight(ts: number): number {
  return ts + localOffsetMs(ts);
}

describe("buildAnalyticsTimelineTicks", () => {
  it("picks a step that keeps the axis to a handful of labels", () => {
    const start = Date.UTC(2026, 6, 31, 3, 7);
    const hourTicks = buildAnalyticsTimelineTicks(start, start + HOUR);
    const dayTicks = buildAnalyticsTimelineTicks(start, start + DAY);
    const monthTicks = buildAnalyticsTimelineTicks(start, start + 30 * DAY);

    for (const ticks of [hourTicks, dayTicks, monthTicks]) {
      expect(ticks.length).toBeGreaterThan(0);
      expect(ticks.length).toBeLessThanOrEqual(5);
    }
    // An hour of traffic gets quarter-hour ticks, a day gets six-hour ones.
    expect(hourTicks[1].ts - hourTicks[0].ts).toBe(15 * 60_000);
    expect(dayTicks[1].ts - dayTicks[0].ts).toBe(6 * HOUR);
  });

  it("lands ticks on round local clock times, not on raw UTC multiples", () => {
    const start = Date.UTC(2026, 6, 31, 3, 7);
    const ticks = buildAnalyticsTimelineTicks(start, start + DAY);
    ticks.forEach((tick) => {
      expect(stepsFromLocalMidnight(tick.ts) % (6 * HOUR)).toBe(0);
    });
  });

  it("positions ticks inside the plot without crowding the edge labels", () => {
    const start = Date.UTC(2026, 6, 31, 0, 0);
    const ticks = buildAnalyticsTimelineTicks(start, start + DAY);
    ticks.forEach((tick) => {
      expect(tick.position).toBeGreaterThanOrEqual(0.04);
      expect(tick.position).toBeLessThanOrEqual(0.9);
      const expected = (tick.ts - start) / DAY;
      expect(tick.position).toBeCloseTo(expected, 10);
    });
  });

  it("returns nothing for a span it cannot plot", () => {
    expect(buildAnalyticsTimelineTicks(0, 0)).toEqual([]);
    expect(buildAnalyticsTimelineTicks(1_000, 500)).toEqual([]);
    expect(buildAnalyticsTimelineTicks(0, Number.NaN)).toEqual([]);
  });
});
