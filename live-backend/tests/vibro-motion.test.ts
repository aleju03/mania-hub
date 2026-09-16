import { describe, expect, it } from "vitest";
import { parseManiaBeatmap } from "../src/dan/beatmap-parser.js";
import { analyzeVibroSections } from "../src/dan/vibro-sections.js";
import { scanFingerRateCeiling, scanHandActionCeiling, scanSplitHandDoubles } from "../src/dan/vibro-motion.js";
import { buildVibroOsu } from "./vibro-fixtures.js";

type Note = [number, number, number];
const chart = (notes: Note[]) => parseManiaBeatmap(buildVibroOsu([...notes].sort((a, b) => a[0] - b[0])));
const seconds = (intervals: Array<{ startTime: number; endTime: number }>, rate = 1) =>
  intervals.reduce((total, one) => total + (one.endTime - one.startTime), 0) / rate / 1000;

/** Ordinary material the hands can obviously deliver, to pad a chart out. */
function filler(from: number, rows: number, gapMs = 150): Note[] {
  return Array.from({ length: rows }, (_, row) => [from + row * gapMs, row % 4, -1] as Note);
}

/** One column repeating at a fixed rate, with the rest of the chart quiet. */
function jack(from: number, rows: number, gapMs: number, column = 0): Note[] {
  return Array.from({ length: rows }, (_, row) => [from + row * gapMs, column, -1] as Note);
}

describe("per-finger rate ceiling", () => {
  it("fires above the ranked ceiling and not below it", () => {
    // 71ms is 14.1 hits/s; 83ms is 12.0, inside what ranked charts ask.
    expect(seconds(scanFingerRateCeiling(chart(jack(1000, 60, 71)), 1))).toBeGreaterThan(3);
    expect(scanFingerRateCeiling(chart(jack(1000, 60, 83)), 1)).toHaveLength(0);
  });

  it("reads the played rate, not the file", () => {
    const map = chart(jack(1000, 60, 100));
    expect(scanFingerRateCeiling(map, 1)).toHaveLength(0);
    expect(seconds(scanFingerRateCeiling(map, 1.5), 1.5)).toBeGreaterThan(2);
    // A baked edit and the equivalent rate mod have to agree.
    const baked = chart(jack(1000, 60, 100 / 1.5));
    expect(seconds(scanFingerRateCeiling(baked, 1))).toBeCloseTo(seconds(scanFingerRateCeiling(map, 1.5), 1.5), 2);
  });

  it("covers only the seconds that breach, never the material beside them", () => {
    const map = chart([...filler(1000, 200), ...jack(40_000, 40, 71), ...filler(50_000, 200)]);
    const covered = scanFingerRateCeiling(map, 1);
    expect(covered.length).toBeGreaterThan(0);
    for (const interval of covered) {
      expect(interval.startTime).toBeGreaterThanOrEqual(40_000);
      expect(interval.endTime).toBeLessThanOrEqual(40_000 + 40 * 71);
    }
  });
});

describe("per-hand action rate ceiling", () => {
  // Two notes at one instant are one action. Two 40ms apart are two motions.
  const alternating = (rows: number, gapMs: number): Note[] =>
    Array.from({ length: rows }, (_, row) => [1000 + row * gapMs, row % 2, -1] as Note);
  const chorded = (rows: number, gapMs: number): Note[] =>
    Array.from({ length: rows }, (_, row) => [1000 + row * gapMs, 0, -1] as Note)
      .concat(Array.from({ length: rows }, (_, row) => [1000 + row * gapMs, 1, -1] as Note));

  it("separates a hand alternating its fingers from the same hand striking chords", () => {
    // 40ms apart is 25 actions/s alternating, past the ceiling. The same note
    // count delivered as chords is 12.5 actions/s, which is a jack.
    expect(seconds(scanHandActionCeiling(chart(alternating(120, 40)), 1))).toBeGreaterThan(3);
    expect(scanHandActionCeiling(chart(chorded(60, 80)), 1)).toHaveLength(0);
  });

  it("leaves a fast but chord-delivered hand alone even when its note rate is high", () => {
    // 25 notes/s on one hand, all of it in chords: one motion per chord.
    const map = chart(chorded(120, 80));
    expect(scanHandActionCeiling(map, 1)).toHaveLength(0);
    expect(analyzeVibroSections(map, 1).sections.every((s) => !s.reasons.includes("hand_action_ceiling"))).toBe(true);
  });
});

describe("split-hand doubles", () => {
  it("counts a small nonzero gap and never an exact chord", () => {
    const split: Note[] = [];
    const exact: Note[] = [];
    for (let row = 0; row < 40; row++) {
      const time = 1000 + row * 70;
      split.push([time, 0, -1], [time + 20, 1, -1]);
      exact.push([time, 0, -1], [time, 1, -1]);
    }
    expect(scanSplitHandDoubles(chart(split), 1).length).toBeGreaterThan(0);
    expect(scanSplitHandDoubles(chart(exact), 1)).toHaveLength(0);
  });
});

describe("the motion arms resist the shapes that bypass row rules", () => {
  const wall = (rows: number, gapMs: number): Note[] =>
    Array.from({ length: rows }, (_, row) => [1000 + row * gapMs, 0, -1] as Note)
      .concat(Array.from({ length: rows }, (_, row) => [1000 + row * gapMs, 1, -1] as Note));

  it("is not bypassed by adding accompaniment to a breaching run", () => {
    // A row-identity rule loses a wall entirely when one note every eighth row
    // breaks the shape. A rate does not care what the other hand is doing.
    const plain = chart(wall(60, 71));
    const accompanied = chart([...wall(60, 71),
      ...Array.from({ length: 8 }, (_, i) => [1000 + i * 8 * 71, 3, -1] as Note)]);
    expect(seconds(scanFingerRateCeiling(plain, 1))).toBeGreaterThan(3);
    expect(seconds(scanFingerRateCeiling(accompanied, 1)))
      .toBeCloseTo(seconds(scanFingerRateCeiling(plain, 1)), 2);
  });

  it("is not diluted by padding the chart with easy material", () => {
    const burst = wall(60, 71);
    const short = chart([...filler(1000, 100), ...burst]);
    const padded = chart([...filler(1000, 100), ...burst, ...filler(60_000, 2000)]);
    expect(seconds(scanFingerRateCeiling(short, 1))).toBeCloseTo(seconds(scanFingerRateCeiling(padded, 1)), 2);
  });

  it("still sees a long run cut into short bursts, in proportion", () => {
    const one = chart(wall(90, 71));
    const split: Note[] = [];
    for (let piece = 0; piece < 3; piece++) split.push(...wall(30, 71).map(([t, c, h]) => [t + piece * 30_000, c, h] as Note));
    // Three 30-row pieces are each too short to hold a breaching second, which
    // is the honest answer: the demand is real but it is no longer sustained.
    expect(seconds(scanFingerRateCeiling(one, 1))).toBeGreaterThan(5);
    expect(seconds(scanFingerRateCeiling(chart(split), 1))).toBeLessThan(seconds(scanFingerRateCeiling(one, 1)));
  });

  it("never reads chart identity", () => {
    const map = chart([...filler(1000, 300), ...wall(60, 71)]);
    const renamed = { ...map, title: "unrelated", creator: "unrelated", od: 3 };
    const mirrored = { ...map, notes: map.notes.map((note) => ({ ...note, column: 3 - note.column })) };
    expect(analyzeVibroSections(renamed, 1)).toEqual(analyzeVibroSections(map, 1));
    expect(analyzeVibroSections(mirrored, 1).noteShare).toBe(analyzeVibroSections(map, 1).noteShare);
  });
});
