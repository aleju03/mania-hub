import { describe, expect, it } from "vitest";
import type { ManiaBeatmap, ManiaNote } from "../beatmap-parser";
import { analyzeManiaPatterns, SUPPORTED_MANIA_PATTERN_IDS } from "./patterns";
import type { ManiaPatternId } from "./types";

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

function makeLnMap(keyCount: number, rows: number[][], intervalMs = 100, holdMs = 300): ManiaBeatmap {
  const map = makeMap(keyCount, rows, intervalMs);
  map.notes = map.notes.map((note) => ({
    ...note,
    endTime: note.time + holdMs,
    isHold: true,
  }));
  return map;
}

function makeMixedMap(keyCount: number, rows: Array<Array<number | { column: number; holdMs?: number }>>, intervalMs = 100): ManiaBeatmap {
  const notes: ManiaNote[] = [];
  rows.forEach((row, index) => {
    const time = index * intervalMs;
    for (const entry of row) {
      const column = typeof entry === "number" ? entry : entry.column;
      const holdMs = typeof entry === "number" ? 0 : (entry.holdMs ?? 0);
      notes.push({
        column,
        time,
        endTime: time + holdMs,
        isHold: holdMs > 0,
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

// Uneven row gaps, with hold releases landing exactly on a later row. Fixed
// intervals can't express either, and LN tech needs both: rhythmic irregularity
// for the tech term, and head/tail switches to tell it apart from inverse
// (release then immediate re-press) and from release-only spam.
function makeUnevenLnMap(
  keyCount: number,
  gaps: number[],
  holds: Array<{ row: number; column: number; endRow: number }>,
  taps: number[][],
  units: number,
): ManiaBeatmap {
  const notes: ManiaNote[] = [];
  const unitMs = gaps.reduce((total, gap) => total + gap, 0);
  const rowTime = (unit: number, row: number) =>
    unit * unitMs + gaps.slice(0, row).reduce((total, gap) => total + gap, 0);
  for (let unit = 0; unit < units; unit++) {
    for (const hold of holds) {
      notes.push({
        column: hold.column,
        time: rowTime(unit, hold.row),
        endTime: rowTime(unit + Math.floor(hold.endRow / gaps.length), hold.endRow % gaps.length),
        isHold: true,
      });
    }
    taps.forEach((columns, row) => {
      for (const column of columns) {
        notes.push({ column, time: rowTime(unit, row), endTime: rowTime(unit, row), isHold: false });
      }
    });
  }
  const map = makeMap(keyCount, [], 100);
  map.notes = notes;
  map.totalLength = units * unitMs;
  return map;
}

function repeatRows(pattern: number[][], times: number): number[][] {
  return Array.from({ length: times }).flatMap(() => pattern);
}

function repeatMixedRows<T>(pattern: T[][], times: number): T[][] {
  return Array.from({ length: times }).flatMap(() => pattern);
}

function patternIds(keyCount: number, rows: number[][]): ManiaPatternId[] {
  return analyzeManiaPatterns(makeMap(keyCount, rows)).patterns.map((pattern) => pattern.id);
}

function chordedDelayRows(): number[][] {
  return Array.from({ length: 300 }, (_, index) => {
    const columns = index % 3 === 0
      ? [index % 7, (index + 3) % 7]
      : [index % 7];
    return [...new Set(columns)].sort((a, b) => a - b);
  });
}

describe("analyzeManiaPatterns", () => {
  it("supports the wiki 4K and 7K pattern vocabulary", () => {
    expect(SUPPORTED_MANIA_PATTERN_IDS).toEqual([
      "jack",
      "chordjack",
      "speedjack",
      "handjack",
      "tech",
      "stream",
      "dumpstream",
      "jumpstream",
      "handstream",
      "quadstream",
      "delay",
      "bracket",
      "chordstream",
      "ln",
      "lngeneral",
      "lnrelease",
      "lninverse",
      "lntech",
    ]);
  });

  it("always exposes LN as a pattern parameter", () => {
    const rice = analyzeManiaPatterns(makeMap(7, repeatRows([[0], [2], [4], [6], [3], [1]], 20)));
    const ln = analyzeManiaPatterns(makeLnMap(7, repeatRows([[0], [2], [4], [6], [3], [1]], 20)));
    const denseLn = analyzeManiaPatterns(makeLnMap(7, chordedDelayRows(), 55, 700));

    expect(rice.patterns.map((pattern) => pattern.id)).toContain("ln");
    expect(rice.allPatterns.find((pattern) => pattern.id === "ln")?.score).toBe(0);
    expect(ln.patterns.map((pattern) => pattern.id)).toContain("ln");
    expect(ln.allPatterns.find((pattern) => pattern.id === "ln")?.score).toBeGreaterThan(0.5);
    expect(denseLn.primary?.id).toMatch(/^ln/);
    expect(denseLn.allPatterns.find((pattern) => pattern.id === "delay")?.score).toBeLessThan(0.2);
  });

  it("detects 7K LN subtypes", () => {
    const inverseRows = Array.from({ length: 7 * 36 }, (_, index) => [
      { column: index % 7, holdMs: 610 },
    ]);
    const releaseRows = Array.from({ length: 7 * 36 }, (_, index) => [
      { column: index % 7, holdMs: 45 },
      { column: (index + 3) % 7, holdMs: 45 },
    ]);
    const generalRows = repeatRows([
      [0, 2],
      [1, 3, 5],
      [2, 4],
      [0, 5, 6],
      [1, 4],
      [2, 3, 6],
    ], 36).map((columns) => columns.map((column) => ({ column, holdMs: 100 })));
    const techRows = repeatMixedRows<number | { column: number; holdMs?: number }>([
      [{ column: 0, holdMs: 110 }, 4],
      [{ column: 2, holdMs: 55 }, { column: 5, holdMs: 55 }],
      [{ column: 1, holdMs: 110 }, 6],
      [{ column: 3, holdMs: 55 }, { column: 4, holdMs: 55 }],
      [{ column: 0, holdMs: 165 }, { column: 2, holdMs: 165 }, 5],
      [{ column: 1, holdMs: 55 }, { column: 6, holdMs: 55 }],
    ], 34);

    expect(analyzeManiaPatterns(makeMixedMap(7, inverseRows, 100)).primary?.id).toBe("lninverse");
    expect(analyzeManiaPatterns(makeMixedMap(7, releaseRows, 60)).primary?.id).toBe("lnrelease");
    expect(analyzeManiaPatterns(makeMixedMap(7, generalRows, 100)).primary?.id).toBe("lngeneral");
    expect(analyzeManiaPatterns(makeMixedMap(7, techRows, 55)).primary?.id).toBe("lntech");
  });

  it("detects 4K LN subtypes, minus release", () => {
    // Column period 520ms against a 420ms hold: a short same-column release gap
    // repeated across all four columns, which is what 4K inverse looks like.
    const inverseRows = Array.from({ length: 4 * 36 }, (_, index) => [
      { column: index % 4, holdMs: 420 },
    ]);
    const generalRows = repeatRows([
      [0, 2],
      [1, 3],
      [2, 3],
      [0, 1],
      [1, 2],
      [0, 3],
    ], 36).map((columns) => columns.map((column) => ({ column, holdMs: 100 })));
    const techMap = makeUnevenLnMap(
      4,
      [60, 55, 110, 55, 165, 55, 82, 110, 55, 137, 55, 96],
      [
        { row: 0, column: 0, endRow: 3 },
        { row: 1, column: 2, endRow: 4 },
        { row: 2, column: 1, endRow: 6 },
        { row: 5, column: 2, endRow: 9 },
        { row: 7, column: 0, endRow: 10 },
        { row: 8, column: 3, endRow: 11 },
      ],
      [[2], [3], [3], [1], [0, 3], [0], [0], [2], [1], [0], [1], [2]],
      30,
    );

    const inverse = analyzeManiaPatterns(makeMixedMap(4, inverseRows, 130));
    const general = analyzeManiaPatterns(makeMixedMap(4, generalRows, 100));
    const tech = analyzeManiaPatterns(techMap);
    expect(inverse.patterns.map((pattern) => pattern.id)).toContain("lninverse");
    expect(general.patterns.map((pattern) => pattern.id)).toContain("lngeneral");
    expect(tech.patterns.map((pattern) => pattern.id)).toContain("lntech");

    // 4K never mints lnrelease: on four columns the release-only signal is
    // manufactured by short-hold vibro spam, so the tag is 7K-only. The same
    // shape at 7K still resolves to lnrelease.
    const releaseRows = (keyCount: number, stride: number) => Array.from({ length: keyCount * 36 }, (_, index) => [
      { column: index % keyCount, holdMs: 45 },
      { column: (index + stride) % keyCount, holdMs: 45 },
    ]);
    const release4k = analyzeManiaPatterns(makeMixedMap(4, releaseRows(4, 2), 60));
    const release7k = analyzeManiaPatterns(makeMixedMap(7, releaseRows(7, 3), 60));
    expect(release4k.allPatterns.find((pattern) => pattern.id === "lnrelease")).toBeUndefined();
    expect(release7k.patterns.map((pattern) => pattern.id)).toContain("lnrelease");
  });

  it("keeps LN subtypes off keymodes they were never calibrated for", () => {
    const inverseRows = Array.from({ length: 6 * 36 }, (_, index) => [
      { column: index % 6, holdMs: 620 },
    ]);
    const analysis = analyzeManiaPatterns(makeMixedMap(6, inverseRows, 130));
    expect(analysis.allPatterns.filter((pattern) => pattern.id.startsWith("ln") && pattern.id !== "ln")).toEqual([]);
    expect(analysis.patterns.map((pattern) => pattern.id)).toContain("ln");
  });

  it("records an LN subtype the top-5 visible slice would otherwise drop", () => {
    // A busy 4K chart fields ten rice candidates, so a qualifying subtype can
    // score well and still miss the cut. It belongs in the tags regardless: a
    // subtype describes the chart, it doesn't have to outrank the rice families.
    const inverseRows = Array.from({ length: 4 * 36 }, (_, index) => [
      { column: index % 4, holdMs: 420 },
    ]);
    const analysis = analyzeManiaPatterns(makeMixedMap(4, inverseRows, 130));
    const inverse = analysis.allPatterns.find((pattern) => pattern.id === "lninverse");
    expect(inverse?.score).toBeGreaterThanOrEqual(0.2);
    expect(analysis.patterns.map((pattern) => pattern.id)).toContain("lninverse");
    // The primary is still whatever actually scored highest, not the overflow.
    expect(analysis.primary?.id).toBe(analysis.allPatterns[0]?.id);
  });

  it("detects slow-tempo LN inverse whose beat-fraction release gaps exceed 120ms", () => {
    // 1/4-beat inverse gaps at 80 BPM are 150ms+; the old fixed 120ms cap read
    // these charts as not-inverse (JJ's 7K dan 6th, 79 BPM, 127ms gaps).
    const slowInverseRows = Array.from({ length: 7 * 36 }, (_, index) => [
      { column: index % 7, holdMs: 760 },
    ]);
    const map = makeMixedMap(7, slowInverseRows, 130); // column period 910ms, gap 150ms
    map.bpm = 80;
    expect(analyzeManiaPatterns(map).primary?.id).toBe("lninverse");
  });

  it("does not read long release gaps on very slow charts as inverse", () => {
    // 400ms of true rest between holds is a sustain pattern, not inverse, even
    // at 40 BPM where 400ms is only ~1/4 beat: the cap ceilings at 250ms.
    const sustainRows = Array.from({ length: 7 * 36 }, (_, index) => [
      { column: index % 7, holdMs: 1000 },
    ]);
    const map = makeMixedMap(7, sustainRows, 200); // column period 1400ms, gap 400ms
    map.bpm = 40;
    const analysis = analyzeManiaPatterns(map);
    expect(analysis.allPatterns.find((pattern) => pattern.id === "lninverse")?.score).toBeLessThan(0.2);
  });

  it("detects 4K speedjack and handjack-style chordjack density", () => {
    expect(patternIds(4, repeatRows([[0, 2], [0, 2], [1, 3], [1, 3]], 30))).toContain("speedjack");
    expect(patternIds(4, repeatRows([[0, 1, 2], [0, 1, 2], [1, 2, 3], [1, 2, 3]], 30))).toContain("handjack");
  });

  it("detects 4K stream subtypes", () => {
    expect(patternIds(4, repeatRows([[0], [1], [2], [3], [2], [1]], 35))).toContain("stream");
    expect(patternIds(4, repeatRows([[0], [1, 2], [3], [0, 2], [1], [2, 3]], 35))).toContain("jumpstream");
    expect(patternIds(4, repeatRows([[0], [1, 2, 3], [2], [0, 1, 3]], 35))).toContain("handstream");
    expect(patternIds(4, repeatRows([[0], [0, 1, 2, 3], [2], [0, 1, 2, 3]], 35))).toContain("quadstream");
  });

  it("detects 7K delay, bracket, chordstream, chordjack, and tech", () => {
    expect(patternIds(7, repeatRows([[0], [2], [4], [6], [3], [1]], 35))).toContain("delay");
    expect(analyzeManiaPatterns(makeMap(7, chordedDelayRows(), 55)).primary?.id).toBe("delay");
    expect(patternIds(7, repeatRows([[0, 1, 2], [4, 5, 6], [1, 2, 3], [4, 5, 6]], 30))).toContain("bracket");
    expect(patternIds(7, repeatRows([[0], [1, 3], [2], [4, 6], [5], [1, 4]], 35))).toContain("chordstream");
    expect(patternIds(7, repeatRows([[0, 2, 4], [0, 2, 4], [1, 3, 5], [1, 3, 5]], 30))).toContain("chordjack");
    expect(patternIds(7, repeatRows([[0], [1, 3, 5], [2], [1, 2], [6], [0, 4, 5]], 35))).toContain("tech");
  });

  it("does not tag hand-alternating bracket files as chordjack", () => {
    // Dense 7K bracket motion: every row is a hand chord, but consecutive
    // chords never share a column - chord density without chord-jack
    // repetition. The density-driven chordjack score used to fire on this
    // shape (the two misclassified community reports).
    const ids = patternIds(7, repeatRows([[0, 1, 2], [4, 5, 6], [1, 2, 3], [4, 5, 6]], 30));
    expect(ids).toContain("bracket");
    expect(ids).not.toContain("chordjack");
  });

  it("does not tag chord-jacked bracket shapes as bracket", () => {
    // The mirror case: bracket-shaped rows jacked in place. Consecutive
    // chords re-hit their columns, which is chordjack; the shape-only bracket
    // score used to saturate on dense CJ files (a 260BPM 7K chordjack chart
    // topped a profile's Bracket skill list).
    const ids = patternIds(7, repeatRows([[0, 1, 2], [0, 1, 2], [1, 2, 3], [1, 2, 3]], 30));
    expect(ids).toContain("chordjack");
    expect(ids).not.toContain("bracket");
  });
});
