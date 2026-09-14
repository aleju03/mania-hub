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

  it("reads a column carried into or out of a jump as an anchor, not a minijack", () => {
    // 12 -> 2 -> 23 -> 3 -> 34 -> 4 -> 14 -> 1: every pair shares a column
    // with a chord on one side.
    const chords = [[0, 1], [1], [1, 2], [2], [2, 3], [3], [0, 3], [0]];
    const notes: ManiaNote[] = [];
    repeat(chords, 30).forEach((columns, index) => { for (const column of columns) notes.push(note(column, index * STEP_MS)); });
    const features = motionFeatures(notes, 4)!;
    expect(features.anchor).toBeGreaterThan(0.9);
    expect(features.miniJack).toBe(0);
    // A jump repeated whole is a jack of a different kind and is not an anchor.
    const jumpJack: ManiaNote[] = [];
    repeat([[0, 1], [0, 1], [2, 3], [2, 3]], 30).forEach((columns, index) => { for (const column of columns) jumpJack.push(note(column, index * STEP_MS)); });
    expect(motionFeatures(jumpJack, 4)!.anchor).toBe(0);
  });

  it("counts a broken rhythm only where the gap ratio is unmusical", () => {
    const even = motionFeatures(fromColumns(repeat([0, 2, 1, 3], 30)), 4)!;
    expect(even.rhythmBreak).toBe(0);
    // Same columns, but every third gap is 1.3x the last: not 1:1, 2:1, 1:2
    // or 3:2.
    const uneven: ManiaNote[] = [];
    let time = 0;
    for (let index = 0; index < 120; index++) {
      uneven.push(note([0, 2, 1, 3][index % 4], time));
      time += index % 3 === 2 ? Math.round(STEP_MS * 1.3) : STEP_MS;
    }
    expect(motionFeatures(uneven, 4)!.rhythmBreak).toBeGreaterThan(0.4);
  });

  it("reads the chart's own pace and not the filler between its fast parts", () => {
    // A roll body at the pace with a break of triple jacks at half of it:
    // the shape of a speed chart's rest sections. The break runs at twice
    // the pace gap for a bar and more, so it is filler and does not count.
    const roll = repeat([0, 1, 2, 3], 40);
    const jacks = repeat([1, 1, 1, 3, 3, 3, 0, 0, 0, 2, 2, 2], 3);
    const build = (jackStep: number): ManiaNote[] => {
      const notes: ManiaNote[] = [];
      let time = 0;
      for (const column of roll) { notes.push(note(column, time)); time += STEP_MS; }
      for (const column of jacks) { notes.push(note(column, time)); time += jackStep; }
      for (const column of roll) { notes.push(note(column, time)); time += STEP_MS; }
      return notes;
    };
    expect(motionFeatures(build(STEP_MS * 2), 4)!.miniJack).toBe(0);
    // The same jacks at the pace are part of the chart and count.
    expect(motionFeatures(build(STEP_MS), 4)!.miniJack).toBeGreaterThan(0.05);
    // A jack written into the stream at half its snap is part of the stream
    // and counts too: the gate reads the surroundings, not the window.
    const embedded: ManiaNote[] = [];
    let time = 0;
    for (let index = 0; index < 40; index++) {
      for (const column of [0, 1, 2, 3]) { embedded.push(note(column, time)); time += STEP_MS; }
      embedded.push(note(3, time)); time += STEP_MS * 2;
    }
    expect(motionFeatures(embedded, 4)!.miniJack).toBeGreaterThan(0.05);
    // And the gate follows the chart: a whole chart at the slow step reads
    // its jacks, since that step is its pace.
    const slow = build(STEP_MS * 2).map((hit, index) => note(hit.column, index * STEP_MS * 2));
    expect(motionFeatures(slow, 4)!.miniJack).toBeGreaterThan(0.05);
  });

  it("does not move when the same chart is played faster", () => {
    // The shares are ratios of like-weighted windows and the pace gate is
    // relative to the chart, which is what lets the block be stored once per
    // chart rather than once per rate. Mixed pace on purpose: the slow tail
    // sits past the gate at every rate.
    const base = [
      ...fromColumns(repeat([0, 1, 2, 1], 40)),
      ...repeat([3, 3, 0, 0], 5).map((column, index) => note(column, 160 * STEP_MS + index * STEP_MS * 2)),
    ];
    const rated = base.map((hit) => note(hit.column, Math.round(hit.time / 1.5)));
    const a = motionFeatures(base, 4)!;
    const b = motionFeatures(rated, 4)!;
    for (const key of ["sameHand", "miniJack", "anchor", "oneHandTrill", "crossHandTrill", "roll4"] as const) {
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
