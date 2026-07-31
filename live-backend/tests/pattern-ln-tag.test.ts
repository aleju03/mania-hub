import { describe, expect, it } from "vitest";
import type { ManiaBeatmap, ManiaNote } from "../src/dan/beatmap-parser.js";
import { analyzeManiaPatterns } from "../src/dan/dan-estimator/patterns.js";

// Regression suite for the bogus `ln` pattern tag: the analyzer used to
// force-append its ln candidate to the visible pattern list even at score 0,
// so every rice chart's classification carried an ln entry that leaked into
// pattern_tags downstream. The append must now require a real LN signal.

function makeMap(keyCount: number, rows: number[][], intervalMs = 100): ManiaBeatmap {
  const notes: ManiaNote[] = [];
  rows.forEach((columns, index) => {
    for (const column of columns) {
      notes.push({
        column,
        time: index * intervalMs,
        endTime: index * intervalMs,
        isHold: false,
      });
    }
  });
  return {
    title: "Synthetic",
    artist: "Test",
    version: `${keyCount}K`,
    creator: "mania-hub",
    keyCount,
    od: 8,
    bpm: 150,
    notes,
    totalLength: rows.length * intervalMs,
    audioFilename: "",
    previewTime: 0,
    backgroundFilename: "",
    breakPeriods: [],
    scrollVelocities: [],
  };
}

function repeatRows(pattern: number[][], times: number): number[][] {
  return Array.from({ length: times }).flatMap(() => pattern);
}

function withHolds(map: ManiaBeatmap, holdMs: number): ManiaBeatmap {
  return {
    ...map,
    notes: map.notes.map((note) => ({ ...note, endTime: note.time + holdMs, isHold: true })),
  };
}

describe("analyzeManiaPatterns ln visibility", () => {
  const riceRows = repeatRows([[0], [2], [4], [6], [3], [1]], 20);

  it("does not append a score-0 ln pattern on a chart with zero long notes", () => {
    const rice = analyzeManiaPatterns(makeMap(7, riceRows));
    expect(rice.patterns.map((pattern) => pattern.id)).not.toContain("ln");
    // The candidate still exists in the full list with its honest zero score.
    expect(rice.allPatterns.find((pattern) => pattern.id === "ln")?.score).toBe(0);
  });

  it("still surfaces the LN axis on hold-bearing charts", () => {
    const ln = analyzeManiaPatterns(withHolds(makeMap(7, riceRows), 300));
    expect(ln.patterns.map((pattern) => pattern.id)).toContain("ln");
    expect(ln.allPatterns.find((pattern) => pattern.id === "ln")?.score).toBeGreaterThan(0.5);
  });

  it("keeps the ln entry visible for charts with only a handful of holds", () => {
    // One short hold in a rice chart: holdRatio > 0 even though the LN score
    // rounds to ~0, so the axis stays exposed for hold-bearing charts.
    const map = makeMap(4, repeatRows([[0], [1], [2], [3]], 40));
    map.notes[0] = { ...map.notes[0], endTime: map.notes[0].time + 200, isHold: true };
    const analysis = analyzeManiaPatterns(map);
    expect(analysis.patterns.map((pattern) => pattern.id)).toContain("ln");
  });
});
