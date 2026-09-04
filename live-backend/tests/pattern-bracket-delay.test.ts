import { describe, expect, it } from "vitest";
import type { ManiaBeatmap, ManiaNote } from "../src/dan/beatmap-parser.js";
import { analyzeManiaPatterns } from "../src/dan/dan-estimator/patterns.js";
import type { ManiaPatternId } from "../src/dan/dan-estimator/types.js";

// The backend's copy of the analyzer decides the pattern tags stored in
// beatmap_chart_analysis, which are what the 6K/7K profile skill axes rank
// plays by. Both behaviours below were reported off those axes: mapper-labelled
// bracket charts never reached the Bracket list (they landed under Chordstream),
// and a pure chordjack chart topped the Delay list.

function makeMap(keyCount: number, rows: number[][], intervalMs = 100): ManiaBeatmap {
  const notes: ManiaNote[] = [];
  rows.forEach((columns, index) => {
    for (const column of columns) {
      notes.push({ column, time: index * intervalMs, endTime: index * intervalMs, isHold: false });
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

describe("7K bracket content", () => {
  const bracketIds = (rows: number[][], intervalMs = 30) =>
    analyzeManiaPatterns(makeMap(7, rows, intervalMs)).patterns.map((pattern) => pattern.id);

  it("tags chord runs that neither jack nor roll", () => {
    // Consecutive chords overlapping in column range but sharing no column:
    // the vendored engine's own bracket window, minus its `notes sum > 9`
    // cutoff, which discarded runs of exactly-three-note chords - the shape a
    // 7K bracket stream is actually charted in.
    expect(bracketIds(repeatRows([[0, 1, 3], [2, 4, 5]], 60))).toContain("bracket");
  });

  it("refuses hand rolls and chord jacks as bracket content", () => {
    // Hands jumping clean past each other: the column ranges never overlap.
    expect(bracketIds(repeatRows([[0, 1, 2], [4, 5, 6]], 60))).not.toContain("bracket");
    // Chords re-hitting their own columns are jacks.
    expect(bracketIds(repeatRows([[0, 1, 3], [0, 1, 3], [2, 4, 5], [2, 4, 5]], 30))).not.toContain("bracket");
  });

  it("counts two-note rows, which upstream's 3+ note floor refused", () => {
    // A file built on two-note brackets scored 0.018 under upstream's rule
    // against 0.128 for its sibling by the same mapper carrying the same tags.
    expect(bracketIds(repeatRows([[0, 2], [1, 3]], 120), 120)).toContain("bracket");
  });
});

describe("7K delay chordjack veto", () => {
  it("refuses the delay tag on a near-certain chordjack chart", () => {
    const rows = Array.from({ length: 320 }, (_, index) => {
      const base = index % 4;
      return [base, base + 1, base + 3].sort((a, b) => a - b);
    });
    const analysis = analyzeManiaPatterns(makeMap(7, rows, 40));
    const score = (id: ManiaPatternId) => analysis.allPatterns.find((pattern) => pattern.id === id)?.score ?? 0;
    expect(score("chordjack")).toBeGreaterThanOrEqual(0.8);
    expect(score("delay")).toBe(0);
  });

  it("still tags a broken-stream delay chart", () => {
    const rows = Array.from({ length: 300 }, (_, index) => {
      const columns = index % 3 === 0 ? [index % 7, (index + 3) % 7] : [index % 7];
      return [...new Set(columns)].sort((a, b) => a - b);
    });
    expect(analyzeManiaPatterns(makeMap(7, rows, 55)).primary?.id).toBe("delay");
  });
});

describe("7K delay reads the snap, not the density", () => {
  const delayScore = (map: ManiaBeatmap) =>
    analyzeManiaPatterns(map).allPatterns.find((pattern) => pattern.id === "delay")?.score ?? 0;
  // Single notes and light chords walking the columns, one row per interval.
  const flow = (rows: number) => Array.from({ length: rows }, (_, index) =>
    [...new Set(index % 4 === 0 ? [index % 7, (index + 3) % 7] : [index % 7])].sort((a, b) => a - b));

  it("refuses 1/4 chordstream at 192 BPM however dense it gets", () => {
    // 78ms rows on a 312.5ms beat: on the 16th grid, so not delay. This is
    // the shape that scored 0.60 under the density reading.
    const map = makeMap(7, flow(600), 78);
    map.bpm = 192;
    map.timingPoints = [{ time: 0, beatLength: 60000 / 192 }];
    expect(delayScore(map)).toBe(0);
  });

  it("tags 1/8 flow at 128 BPM and 1/6 flow at 158 BPM", () => {
    const eighths = makeMap(7, flow(600), Math.round(60000 / 128 / 8));
    eighths.bpm = 128;
    eighths.timingPoints = [{ time: 0, beatLength: 60000 / 128 }];
    expect(delayScore(eighths)).toBeGreaterThanOrEqual(0.9);
    const sixths = makeMap(7, flow(600), Math.round(60000 / 158 / 6));
    sixths.bpm = 158;
    sixths.timingPoints = [{ time: 0, beatLength: 60000 / 158 }];
    expect(delayScore(sixths)).toBeGreaterThanOrEqual(0.9);
  });

  it("follows the timing point in force, not the first one", () => {
    // 135 BPM intro, then the 192 BPM body: the body's 1/4 rows are 78ms,
    // which on the 135 BPM grid would read as an off-snap gap.
    const rows = flow(600);
    const map = makeMap(7, rows, 78);
    map.timingPoints = [{ time: -20000, beatLength: 60000 / 135 }, { time: 0, beatLength: 60000 / 192 }];
    expect(delayScore(map)).toBe(0);
  });
});
