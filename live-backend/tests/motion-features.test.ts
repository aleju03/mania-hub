import { describe, expect, it } from "vitest";
import { motionFeatures } from "../src/dan/motion-features.js";
import type { ManiaNote } from "../src/dan/beatmap-parser.js";

// Synthetic charts, one shape each, so the feature that is supposed to fire is
// the only one that can. 125ms spacing is 120bpm 16ths, well inside the window
// the weighting cares about.
const STEP_MS = 125;
const note = (column: number, time: number): ManiaNote => ({ column, time, endTime: time, isHold: false });
const fromColumns = (columns: number[]): ManiaNote[] => columns.map((column, index) => note(column, index * STEP_MS));
const repeat = (pattern: number[], times: number): number[] => Array.from({ length: times }, () => pattern).flat();

describe("motionFeatures", () => {
  it("reads a one-hand trill as one-hand oscillation, not as a roll", () => {
    const features = motionFeatures(fromColumns(repeat([0, 1], 60)), 4)!;
    expect(features.oneHandTrill).toBeGreaterThan(0.9);
    expect(features.crossHandTrill).toBe(0);
    expect(features.roll4).toBe(0);
    expect(features.sameHand).toBeGreaterThan(0.9);
  });

  it("reads a two-column trill across the hands as cross-hand oscillation", () => {
    const features = motionFeatures(fromColumns(repeat([1, 2], 60)), 4)!;
    expect(features.crossHandTrill).toBeGreaterThan(0.9);
    expect(features.oneHandTrill).toBe(0);
    expect(features.sameHand).toBe(0);
  });

  it("reads a four-column roll as a roll and as nothing else", () => {
    const features = motionFeatures(fromColumns(repeat([0, 1, 2, 3], 30)), 4)!;
    // A cycled staircase tops out near 0.25: one window in four starts on the
    // 0 and the other three wrap round it, so this is the shape's ceiling.
    expect(features.roll4).toBeGreaterThan(0.2);
    expect(features.oneHandTrill).toBe(0);
    expect(features.crossHandTrill).toBe(0);
    expect(features.miniJack).toBe(0);
  });

  it("reads a repeated column as a minijack", () => {
    const features = motionFeatures(fromColumns(repeat([0, 0, 2, 2], 30)), 4)!;
    expect(features.miniJack).toBeGreaterThan(0.4);
    expect(features.oneHandTrill).toBe(0);
  });

  it("counts a broken rhythm only where the gap ratio is unmusical", () => {
    const even = motionFeatures(fromColumns(repeat([0, 2, 1, 3], 30)), 4)!;
    expect(even.rhythmBreak).toBe(0);
    // Same columns, but every third gap is 1.7x the last: not 1:1, 2:1 or 1:2.
    const uneven: ManiaNote[] = [];
    let time = 0;
    for (let index = 0; index < 120; index++) {
      uneven.push(note([0, 2, 1, 3][index % 4], time));
      time += index % 3 === 2 ? Math.round(STEP_MS * 1.7) : STEP_MS;
    }
    expect(motionFeatures(uneven, 4)!.rhythmBreak).toBeGreaterThan(0.4);
  });

  it("does not move when the same chart is played faster", () => {
    // The shares are ratios of like-weighted windows, which is what lets the
    // block be stored once per chart rather than once per rate.
    const base = fromColumns(repeat([0, 1, 2, 1], 40));
    const rated = base.map((hit) => note(hit.column, Math.round(hit.time / 1.5)));
    const a = motionFeatures(base, 4)!;
    const b = motionFeatures(rated, 4)!;
    for (const key of ["sameHand", "miniJack", "oneHandTrill", "crossHandTrill", "roll4"] as const) {
      expect(b[key]).toBeCloseTo(a[key], 3);
    }
  });

  it("refuses anything that is not a measurable 4K chart", () => {
    expect(motionFeatures(fromColumns(repeat([0, 1, 2, 3], 30)), 7)).toBeNull();
    expect(motionFeatures(fromColumns([0, 1, 2, 3]), 4)).toBeNull();
  });

  it("keeps every share inside [0, 1]", () => {
    const features = motionFeatures(fromColumns(repeat([0, 1, 1, 2, 3, 3, 0, 2], 30)), 4)!;
    for (const [key, value] of Object.entries(features)) {
      expect(Number.isFinite(value), key).toBe(true);
      if (key === "densitySwing") expect(value).toBeGreaterThanOrEqual(0);
      else expect(value, key).toBeGreaterThanOrEqual(0), expect(value, key).toBeLessThanOrEqual(1);
    }
  });
});
