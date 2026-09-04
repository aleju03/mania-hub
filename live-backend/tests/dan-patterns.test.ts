import { describe, expect, it } from "vitest";
import type { ManiaBeatmap, ManiaNote } from "../src/dan/beatmap-parser.js";
import { analyzeManiaPatterns, SUPPORTED_MANIA_PATTERN_IDS } from "../src/dan/dan-estimator/patterns.js";
import type { ManiaPatternId } from "../src/dan/dan-estimator/types.js";

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

  // Scored on every chart, but only surfaced as a visible axis when the chart
  // actually holds something. Until the two copies of this analyzer were merged
  // the frontend's copy appended the axis unconditionally, which stamped a
  // score-0 ln entry onto every rice chart; the backend's guard is what won.
  it("exposes LN as a visible pattern only when the chart has holds", () => {
    const rice = analyzeManiaPatterns(makeMap(7, repeatRows([[0], [2], [4], [6], [3], [1]], 20)));
    const ln = analyzeManiaPatterns(makeLnMap(7, repeatRows([[0], [2], [4], [6], [3], [1]], 20)));
    const denseLn = analyzeManiaPatterns(makeLnMap(7, chordedDelayRows(), 55, 700));

    expect(rice.patterns.map((pattern) => pattern.id)).not.toContain("ln");
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
    // Tails long enough that the release is its own action, landing three rows
    // later so each one lands on another column's head while two more holds are
    // still down. The same column is not re-pressed until 600ms after the
    // release, so none of it reads as inverse.
    const releaseRows = Array.from({ length: 7 * 36 }, (_, index) => [
      { column: index % 7, holdMs: 450 },
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
    expect(analyzeManiaPatterns(makeMixedMap(7, releaseRows, 150)).primary?.id).toBe("lnrelease");
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

    // 4K never mints lnrelease: the release ramps are measured on 7K, where the
    // scene names the skillset, and no 4K surface offers a release axis to
    // fill. The same shape at 7K still resolves to lnrelease.
    const releaseRows = (keyCount: number) => Array.from({ length: keyCount * 36 }, (_, index) => [
      { column: index % keyCount, holdMs: 450 },
    ]);
    const release4k = analyzeManiaPatterns(makeMixedMap(4, releaseRows(4), 150));
    const release7k = analyzeManiaPatterns(makeMixedMap(7, releaseRows(7), 150));
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

  it("drops the LN General tag once a specialty carries the chart", () => {
    // General is the LN chart that is none of the specialties. The old damper
    // floored at 0.35, so a saturated release chart still carried a visible
    // LN General tag next to LN Release.
    const releaseRows = Array.from({ length: 7 * 36 }, (_, index) => [
      { column: index % 7, holdMs: 450 },
    ]);
    const analysis = analyzeManiaPatterns(makeMixedMap(7, releaseRows, 150));
    expect(analysis.primary?.id).toBe("lnrelease");
    expect(analysis.allPatterns.find((pattern) => pattern.id === "lngeneral")?.score).toBeLessThan(0.2);
    expect(analysis.patterns.map((pattern) => pattern.id)).not.toContain("lngeneral");
  });

  it("tags 7K inverse from inverse sections when rice elsewhere breaks the whole-chart ceiling", () => {
    // 25s of inverse followed by 18s of LN mixed with taps. Over the whole
    // chart the release gaps still read inverse, but a fifth of the rows are
    // mixed, past the 16% ceiling the whole-chart leg allows; the windowed leg
    // sees three inverse windows out of five and tags it anyway.
    const inverseRows = Array.from({ length: 7 * 36 }, (_, index) => [
      { column: index % 7, holdMs: 610 },
    ]);
    const mixedRows = Array.from({ length: 180 }, (_, index) => (index % 2 === 0
      ? [{ column: index % 7, holdMs: 250 }, (index + 3) % 7]
      : [(index + 5) % 7]));
    const sectioned = analyzeManiaPatterns(makeMixedMap(7, [...inverseRows, ...mixedRows], 100));
    const inverse = sectioned.allPatterns.find((pattern) => pattern.id === "lninverse");
    expect(inverse?.score).toBeGreaterThanOrEqual(0.5);
    expect(inverse?.evidence).toContain("60% of the chart in inverse sections");
    expect(sectioned.patterns.map((pattern) => pattern.id)).toContain("lninverse");
    // The mixed tail on its own is not inverse, so the tag comes from the
    // sections, not from the tail's shape leaking through the looser gap rule.
    const tail = analyzeManiaPatterns(makeMixedMap(7, mixedRows, 100));
    expect(tail.allPatterns.find((pattern) => pattern.id === "lninverse")?.score).toBe(0);
  });

  it("tags 7K release on half-beat tails when the release lands under other holds", () => {
    // Rows every 100ms cycling the columns; 55% of the holds outlast the next
    // row's head so their release lands under it, the rest let go into empty
    // space. Tails of 80-120ms are what the dan release charts run at 175+
    // BPM, far under the slow leg's 150-330ms ramp, so only the dense leg can
    // see this, and its old 0.6 start sat above these charts.
    const rows = Array.from({ length: 7 * 40 }, (_, index) => [
      { column: index % 7, holdMs: index % 20 < 11 ? 120 : 80 },
    ]);
    const analysis = analyzeManiaPatterns(makeMixedMap(7, rows, 100));
    const release = analysis.allPatterns.find((pattern) => pattern.id === "lnrelease");
    expect(release?.score).toBeGreaterThanOrEqual(0.3);
    expect(analysis.patterns.map((pattern) => pattern.id)).toContain("lnrelease");
    expect(analysis.allPatterns.find((pattern) => pattern.id === "lninverse")?.score).toBe(0);
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
    // 1/8 rows on makeMap's 150 BPM grid; the same roll at 1/4 (100ms) is stream, not delay.
    expect(analyzeManiaPatterns(makeMap(7, repeatRows([[0], [2], [4], [6], [3], [1]], 35), 50)).patterns.map((pattern) => pattern.id)).toContain("delay");
    expect(patternIds(7, repeatRows([[0], [2], [4], [6], [3], [1]], 35))).not.toContain("delay");
    expect(analyzeManiaPatterns(makeMap(7, chordedDelayRows(), 55)).primary?.id).toBe("delay");
    expect(patternIds(7, repeatRows([[0, 1, 3], [2, 4, 5]], 60))).toContain("bracket");
    expect(patternIds(7, repeatRows([[0], [1, 3], [2], [4, 6], [5], [1, 4]], 35))).toContain("chordstream");
    expect(patternIds(7, repeatRows([[0, 2, 4], [0, 2, 4], [1, 3, 5], [1, 3, 5]], 30))).toContain("chordjack");
    expect(patternIds(7, repeatRows([[0], [1, 3, 5], [2], [1, 2], [6], [0, 4, 5]], 35))).toContain("tech");
  });

  it("does not tag chord-tech that carries one finger between chords as chordjack", () => {
    // Chords of three moving to a neighbouring chord of three share one column
    // every time, which saturates the any-column overlap gate, but the chord
    // is never jacked: no pair re-hits two columns, the chords come two at a
    // time between singles, and the single-note re-hits sit under the jack
    // line. Terminal 11 Technical Pack's [7K] Miserable Bastard is this shape
    // and filed as Chordjack 0.92 over Tech 0.52.
    const rows = repeatRows([[0, 1, 3], [3, 4, 6], [0], [1, 2, 5], [0, 5, 6], [4]], 40);
    const analysis = analyzeManiaPatterns(makeMap(7, rows, 100));
    expect(analysis.allPatterns.find((pattern) => pattern.id === "chordjack")?.score ?? 0).toBeLessThan(0.2);
    expect(analysis.primary?.id).not.toBe("chordjack");
    // The same chords jacked in place keep the tag.
    expect(patternIds(7, repeatRows([[0, 1, 3], [0, 1, 3], [0], [1, 2, 5], [1, 2, 5], [4]], 40))).toContain("chordjack");
  });

  it("does not tag dense hand-alternating files as chordjack", () => {
    // Dense 7K chord motion: every row is a hand chord, but consecutive chords
    // never share a column - chord density without chord-jack repetition. The
    // density-driven chordjack score used to fire on this shape (the two
    // misclassified community reports).
    expect(patternIds(7, repeatRows([[0, 1, 2], [4, 5, 6], [1, 2, 3], [4, 5, 6]], 30))).not.toContain("chordjack");
  });

  it("counts bracket content as chord runs that neither jack nor roll", () => {
    // Interleaved chords: consecutive rows overlap in column range but share no
    // column, which is the vendored engine's own bracket window.
    expect(patternIds(7, repeatRows([[0, 1, 3], [2, 4, 5]], 60))).toContain("bracket");
    // Hands jumping clean past each other is a roll, not bracket content: the
    // column ranges never overlap.
    expect(patternIds(7, repeatRows([[0, 1, 2], [4, 5, 6]], 60))).not.toContain("bracket");
    // Chords that re-hit their columns are jacks, not bracket content.
    expect(patternIds(7, repeatRows([[0, 1, 3], [0, 1, 3], [2, 4, 5], [2, 4, 5]], 30))).not.toContain("bracket");
    // Two-note rows count. Upstream's primitive demands 3+ notes per row, which
    // refused files built on two-note brackets: one such chart scored 0.018
    // against 0.128 for its sibling by the same mapper carrying the same tags.
    expect(patternIds(7, repeatRows([[0, 2], [1, 3]], 120))).toContain("bracket");
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

  it("does not tag near-certain chordjack charts as delay", () => {
    // Delay's ingredients are density, entropy and low row repetition, and
    // dense chordjack saturates all three, so CJ files were scoring delay on
    // nothing but being hard ("[7K] JACK Another" carried delay 0.62 with
    // chordjack 1.00, and a CJ chart topped a profile's Delay skill list).
    const rows = Array.from({ length: 320 }, (_, index) => {
      const base = index % 4;
      return [base, base + 1, base + 3].sort((a, b) => a - b);
    });
    const analysis = analyzeManiaPatterns(makeMap(7, rows, 40));
    const score = (id: ManiaPatternId) => analysis.allPatterns.find((pattern) => pattern.id === id)?.score ?? 0;
    expect(score("chordjack")).toBeGreaterThanOrEqual(0.8);
    expect(score("delay")).toBe(0);
    // The veto is aimed at chordjack, not at delay charts in general.
    expect(analyzeManiaPatterns(makeMap(7, chordedDelayRows(), 55)).primary?.id).toBe("delay");
  });
});
