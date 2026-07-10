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
    expect(patternIds(7, repeatRows([[1, 2, 4], [1, 2, 4], [2, 4, 5], [2, 4, 5]], 30))).toContain("bracket");
    expect(patternIds(7, repeatRows([[0], [1, 3], [2], [4, 6], [5], [1, 4]], 35))).toContain("chordstream");
    expect(patternIds(7, repeatRows([[0, 2, 4], [0, 2, 4], [1, 3, 5], [1, 3, 5]], 30))).toContain("chordjack");
    expect(patternIds(7, repeatRows([[0], [1, 3, 5], [2], [1, 2], [6], [0, 4, 5]], 35))).toContain("tech");
  });
});
