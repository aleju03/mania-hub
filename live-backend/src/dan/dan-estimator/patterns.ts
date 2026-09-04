import type { ManiaBeatmap, ManiaNote } from "../beatmap-parser.js";
import { extractDanFeatures } from "./features.js";
import { getInputRate } from "./labels.js";
import { clamp01, minGate, quantile } from "./math.js";
import type { DanEstimateInput, DanFeatureExtractionResult, ManiaPatternAnalysis, ManiaPatternHit, ManiaPatternId } from "./types.js";

export const MANIA_PATTERN_ANALYZER_LABELS: Record<ManiaPatternId, string> = {
  jack: "Jack",
  chordjack: "Chordjack",
  speedjack: "Speedjack",
  handjack: "Handjack",
  tech: "Tech",
  stream: "Stream",
  dumpstream: "Dumpstream",
  jumpstream: "Jumpstream",
  handstream: "Handstream",
  quadstream: "Quadstream",
  delay: "Delay",
  bracket: "Bracket",
  chordstream: "Chordstream",
  ln: "LN",
  lngeneral: "LN General",
  lnrelease: "LN Release",
  lninverse: "LN Inverse",
  lntech: "LN Tech",
};

export const SUPPORTED_MANIA_PATTERN_IDS: ManiaPatternId[] = [
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
];

// The LN axis subfamilies, as opposed to the primary rice families. Fired on 4K
// and 7K only; see the subtype gate in analyzeManiaPatterns.
const LN_SUBTYPE_IDS = new Set<string>(["lngeneral", "lnrelease", "lninverse", "lntech"]);

interface RowPatternStats {
  rowCount: number;
  chordRows: number;
  twoNoteRows: number;
  threeNoteRows: number;
  fourPlusRows: number;
  threePlusRows: number;
  singleRows: number;
  repeatedChordRows: number;
  bracketWindowRows: number;
  averageChordSize: number;
  // Consecutive chord rows under a second apart, and how many of those pairs
  // re-hit two or more columns: the chord itself being jacked, as opposed to
  // one finger held over from the previous chord.
  chordPairs: number;
  multiOverlapChordPairs: number;
  // Runs of consecutive chord rows (broken by any single-note row). Mean run
  // length is chordRows / chordRuns.
  chordRuns: number;
}

interface LnPatternStats {
  inverseReleaseRatio: number;
  sameColumnReleaseGapP50: number;
  releaseOnlyRatio: number;
  headTailSwitchRatio: number;
  mixedRowRatio: number;
  tapWhileHoldingRatio: number;
  // Release-shape stats, all over every hold in the chart. A release is
  // "active" when letting go is its own action rather than the off-half of an
  // inverse re-press; the other two say what the hand is doing at that moment.
  activeReleaseRatio: number;
  coordinatedReleaseRatio: number;
  heldWhileReleaseRatio: number;
  holdDurationP50: number;
  // Share of 8-second windows (with enough same-column hold pairs to judge)
  // whose holds are mostly re-pressed within their own length of the release.
  // Sections carry the inverse tag where the whole-chart ratio would average
  // them away under rice.
  inverseWindowCoverage: number;
}

// Windowed inverse: the whole-chart inverseReleaseRatio averages an inverse
// section against everything around it, so an LN coordination chart whose
// FLN passages are a third of its length reads as 30-40% inverse and never
// tags. Per window the question is looser on purpose: the release gap only
// has to fit inside the hold's own length (1/4-spaced inverse has gap == hold,
// which the 0.7 chart-level rule rejects), and a window counts once most of
// its same-column pairs look like that. Ramps measured 2026-09-03 over 1158
// 7K charts whose title/diff/tags say inverse or FLN against 14.3k unlabelled
// 7K LN charts: coverage at the 0.65 window cut is AUC 0.964, labelled p10
// 0.78, unlabelled p75 0.09 / p90 0.28.
const INVERSE_WINDOW_MS = 8000;
const INVERSE_WINDOW_MIN_PAIRS = 20;
const INVERSE_WINDOW_MIN_WINDOWS = 3;
const INVERSE_WINDOW_RATIO = 0.65;

function rowColumns(rowNotes: ManiaNote[]): number[] {
  return [...new Set(rowNotes.map((note) => note.column))].sort((a, b) => a - b);
}

function isRollBetween(previous: number[], current: number[]): boolean {
  if (!previous.length || !current.length) return false;
  return previous[0] > current[current.length - 1] || previous[previous.length - 1] < current[0];
}

function sharedColumnCount(previous: number[], current: number[]): number {
  let shared = 0;
  for (const column of current) if (previous.includes(column)) shared++;
  return shared;
}

function getRowPatternStats(orderedRows: Array<[number, ManiaNote[]]>, keyCount: number): RowPatternStats {
  let chordRows = 0;
  let twoNoteRows = 0;
  let threeNoteRows = 0;
  let fourPlusRows = 0;
  let threePlusRows = 0;
  let singleRows = 0;
  let repeatedChordRows = 0;
  let bracketWindowRows = 0;
  let totalChordSize = 0;
  let chordPairs = 0;
  let multiOverlapChordPairs = 0;
  let chordRuns = 0;
  let previousChordMask: number | null = null;
  let previousRowMask = 0;
  let previousRowSize = 0;
  let previousRowTime = Number.NEGATIVE_INFINITY;
  let previousColumns: number[] = [];
  let beforePreviousColumns: number[] = [];

  for (const [time, rowNotes] of orderedRows) {
    const columns = rowColumns(rowNotes);
    const size = columns.length;
    let mask = 0;
    for (const column of columns) mask |= 1 << column;

    if (size <= 1) singleRows++;
    if (size >= 2) {
      chordRows++;
      totalChordSize += size;
      if (mask === previousChordMask) repeatedChordRows++;
      previousChordMask = mask;
      if (previousRowSize < 2) chordRuns++;
      if (previousRowSize >= 2 && time - previousRowTime < 1000) {
        chordPairs++;
        if (bitCount(mask & previousRowMask) >= 2) multiOverlapChordPairs++;
      }
    } else {
      previousChordMask = null;
    }
    previousRowMask = mask;
    previousRowSize = size;
    previousRowTime = time;
    if (size === 2) twoNoteRows++;
    if (size === 3) threeNoteRows++;
    if (size >= 4) fourPlusRows++;
    if (size >= 3) threePlusRows++;
    // Three chords in a row that neither jack nor roll. This is the vendored
    // engine's own bracket primitive (CHORDSTREAM_7K_BRACKETS) with both of its
    // size conditions dropped: it demands every row carry 3+ notes and their
    // sum exceed 9, which between them refuse the two shapes brackets are
    // actually charted in - runs of exactly-three-note chords (3+3+3 is not
    // > 9) and two-note brackets. Measured 2026-08-17 over 361 charts whose
    // mapper tags say bracket: a file at 37% two-note rows scored 0.018 under
    // upstream's rule against 0.128 for its sibling by the same mapper with the
    // same tags, and dropping the floors separates tagged charts from random
    // 7K ones at AUC 0.79 (0.89 against chordjack-tagged) versus 0.72 / 0.74.
    // Requiring the two-note rows to be same-hand adjacent pairs - the literal
    // bracket shape - measured no better than upstream (0.73), which is the
    // same result shape carries everywhere else in this detector.
    if (
      keyCount >= 6 && size >= 2
      && beforePreviousColumns.length >= 2 && previousColumns.length >= 2
      && !isRollBetween(beforePreviousColumns, previousColumns)
      && !isRollBetween(previousColumns, columns)
      && sharedColumnCount(beforePreviousColumns, previousColumns) === 0
      && sharedColumnCount(previousColumns, columns) === 0
    ) {
      bracketWindowRows++;
    }
    beforePreviousColumns = previousColumns;
    previousColumns = columns;
  }

  return {
    rowCount: orderedRows.length,
    chordRows,
    twoNoteRows,
    threeNoteRows,
    fourPlusRows,
    threePlusRows,
    singleRows,
    repeatedChordRows,
    bracketWindowRows,
    averageChordSize: chordRows ? totalChordSize / chordRows : 0,
    chordPairs,
    multiOverlapChordPairs,
    chordRuns,
  };
}

function bitCount(mask: number): number {
  let count = 0;
  while (mask) {
    count += 1;
    mask &= mask - 1;
  }
  return count;
}

// Single-note jack content for the 6K/7K jack tag, where the chordjack
// detector is blind: it counts repeated chords, so a chart built on
// single-note minijacks and trills (Ningen Shikkaku [Zenx's 7K Miscreation],
// chordjack 0.35) reads as tech/chordstream. Two shapes, both measured as a
// share of notes:
//
// - jack1Share: notes whose column was also hit on the immediately previous
//   row, within 400ms. Row-relative on purpose: an absolute repeat window
//   cannot tell jack from dense 7K stream (same-column re-hits under 180ms
//   sit at p50 0.36 on the jack corpus and 0.39 on the stream corpus), while
//   "re-hit one row back" is the jack motion itself. The 400ms cap is what
//   keeps out slow filler jacks between real content, the shape the cluster
//   share's false positives took (jacks at exactly half the chordstream BPM).
// - trillRunShare: notes inside strict two-row alternations (the same two
//   column sets A/B repeating for 6+ rows, each row gap <= 200ms), the
//   full-trill spam charts are built on. Nearly binary in practice: every
//   corpus (jack included) sits at p90 <= 0.026 while trill charts carry
//   0.1+, so the arm fires on almost nothing but its own class.
function getSingleJackStats(orderedRows: Array<[number, ManiaNote[]]>): { jack1Share: number; trillRunShare: number } {
  const masks: number[] = [];
  const times: number[] = [];
  let noteCount = 0;
  let jack1 = 0;
  for (const [time, rowNotes] of orderedRows) {
    let mask = 0;
    for (const note of rowNotes) mask |= 1 << note.column;
    noteCount += rowNotes.length;
    const last = masks.length - 1;
    if (last >= 0 && time - times[last] <= 400) {
      let overlap = mask & masks[last];
      while (overlap) {
        jack1 += 1;
        overlap &= overlap - 1;
      }
    }
    masks.push(mask);
    times.push(time);
  }
  const popcount = (mask: number): number => {
    let count = 0;
    while (mask) {
      count += 1;
      mask &= mask - 1;
    }
    return count;
  };
  let trillNotes = 0;
  let i = 0;
  while (i < masks.length - 5) {
    const a = masks[i];
    const b = masks[i + 1];
    if (a === 0 || b === 0 || a === b || times[i + 1] - times[i] > 200) {
      i += 1;
      continue;
    }
    let j = i + 2;
    while (j < masks.length && masks[j] === ((j - i) % 2 === 0 ? a : b) && times[j] - times[j - 1] <= 200) j += 1;
    if (j - i >= 6) {
      for (let m = i; m < j; m += 1) trillNotes += popcount(masks[m]);
      i = j;
    } else {
      i += 1;
    }
  }
  return {
    jack1Share: noteCount > 0 ? jack1 / noteCount : 0,
    trillRunShare: noteCount > 0 ? trillNotes / noteCount : 0,
  };
}

// Inverse charting joins consecutive notes in a column with LNs, leaving only
// a small release gap charted as a beat fraction (1/8 to 1/4 beat). A fixed
// millisecond cutoff misreads slow charts: at 79 BPM a 1/6-beat inverse gap is
// 127ms, which a 120ms cap counts as not-inverse (JJ's 7K dan 6th missed the
// lninverse tag with every gap at 126-127ms). Scale the cap with tempo, floored
// at the old 120ms for fast charts and ceilinged so very slow charts don't
// count half-second release gaps as inverse holds.
function inverseGapCapMs(beatLengthMs: number): number {
  if (!Number.isFinite(beatLengthMs) || beatLengthMs <= 0) return 120;
  return Math.min(250, Math.max(120, beatLengthMs * 0.27));
}

function getLnPatternStats(
  notes: ManiaNote[],
  orderedRows: Array<[number, ManiaNote[]]>,
  keyCount: number,
  beatLengthMs: number,
): LnPatternStats {
  const releaseRows = new Map<number, ManiaNote[]>();
  const headTimes = new Set<number>();
  const holdEvents: Array<{ time: number; delta: number }> = [];
  const holdSpans: ManiaNote[] = [];
  const notesByColumn = Array.from({ length: Math.max(1, keyCount) }, () => [] as ManiaNote[]);

  for (const note of notes) {
    if (note.column >= 0 && note.column < notesByColumn.length) notesByColumn[note.column].push(note);
    if (!note.isHold || note.endTime <= note.time) continue;
    holdSpans.push(note);

    const releaseRow = releaseRows.get(note.endTime);
    if (releaseRow) releaseRow.push(note);
    else releaseRows.set(note.endTime, [note]);
    holdEvents.push({ time: note.time, delta: 1 }, { time: note.endTime, delta: -1 });
  }

  holdEvents.sort((left, right) => left.time - right.time || right.delta - left.delta);

  let mixedRows = 0;
  let tapWhileHoldingRows = 0;
  let headTailSwitchRows = 0;
  let activeHolds = 0;
  let eventIndex = 0;

  for (const [time, rowNotes] of orderedRows) {
    headTimes.add(time);

    while (eventIndex < holdEvents.length && holdEvents[eventIndex].time < time) {
      activeHolds = Math.max(0, activeHolds + holdEvents[eventIndex].delta);
      eventIndex++;
    }

    const hasHold = rowNotes.some((note) => note.isHold);
    const hasTap = rowNotes.some((note) => !note.isHold);
    if (hasHold && hasTap) mixedRows++;
    if (hasTap && activeHolds > 0) tapWhileHoldingRows++;
    if (releaseRows.has(time)) headTailSwitchRows++;
  }

  let releaseOnlyRows = 0;
  for (const time of releaseRows.keys()) {
    if (!headTimes.has(time)) releaseOnlyRows++;
  }

  const sameColumnGaps: number[] = [];
  const gapCap = inverseGapCapMs(beatLengthMs);
  let inverseLikeHolds = 0;
  let sameColumnNextHolds = 0;

  // Prefix maximum of hold end times, ordered by hold start, so "is another
  // hold still down at time t" is a binary search instead of a scan.
  const holdsByStart = [...holdSpans].sort((left, right) => left.time - right.time);
  const holdStarts = holdsByStart.map((hold) => hold.time);
  const latestEndByStart: number[] = [];
  let latestEnd = -Infinity;
  for (const hold of holdsByStart) {
    latestEnd = Math.max(latestEnd, hold.endTime);
    latestEndByStart.push(latestEnd);
  }
  const heldThrough = (time: number): boolean => {
    let low = 0;
    let high = holdStarts.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (holdStarts[mid] < time) low = mid + 1;
      else high = mid;
    }
    return low > 0 && latestEndByStart[low - 1] > time;
  };

  let activeReleaseHolds = 0;
  let coordinatedReleaseHolds = 0;
  let heldWhileReleaseHolds = 0;
  const holdDurations: number[] = [];
  const windowPairs = new Map<number, { pairs: number; inverse: number }>();

  for (const columnNotes of notesByColumn) {
    columnNotes.sort((left, right) => left.time - right.time || left.endTime - right.endTime);
    for (let index = 0; index < columnNotes.length; index++) {
      const note = columnNotes[index];
      if (!note.isHold || note.endTime <= note.time) continue;

      const holdDuration = Math.max(1, note.endTime - note.time);
      holdDurations.push(holdDuration);

      const nextNote = index + 1 < columnNotes.length ? columnNotes[index + 1] : null;
      const gap = nextNote ? nextNote.time - note.endTime : Infinity;
      if (nextNote && gap >= 0) {
        sameColumnNextHolds++;
        sameColumnGaps.push(gap);
        const windowKey = Math.floor(note.time / INVERSE_WINDOW_MS);
        const window = windowPairs.get(windowKey) ?? { pairs: 0, inverse: 0 };
        window.pairs++;
        if (gap <= gapCap && gap <= holdDuration) window.inverse++;
        windowPairs.set(windowKey, window);
      }

      // The release doubles as the cue to press the same column again, so the
      // press carries the timing and the release rides along. Everything else
      // is a release the hand has to place on its own.
      if (gap >= 0 && gap <= gapCap && gap / holdDuration <= 0.7) {
        if (nextNote) inverseLikeHolds++;
        continue;
      }
      activeReleaseHolds++;
      if (headTimes.has(note.endTime)) coordinatedReleaseHolds++;
      if (heldThrough(note.endTime)) heldWhileReleaseHolds++;
    }
  }

  const rowCount = Math.max(1, orderedRows.length);
  const releaseRowCount = releaseRows.size;
  const holdCount = Math.max(1, holdDurations.length);

  let judgedWindows = 0;
  let inverseWindows = 0;
  for (const window of windowPairs.values()) {
    if (window.pairs < INVERSE_WINDOW_MIN_PAIRS) continue;
    judgedWindows++;
    if (window.inverse / window.pairs >= INVERSE_WINDOW_RATIO) inverseWindows++;
  }

  return {
    inverseReleaseRatio: sameColumnNextHolds ? inverseLikeHolds / sameColumnNextHolds : 0,
    sameColumnReleaseGapP50: quantile(sameColumnGaps, 0.5),
    releaseOnlyRatio: releaseRowCount ? releaseOnlyRows / releaseRowCount : 0,
    headTailSwitchRatio: headTailSwitchRows / rowCount,
    mixedRowRatio: mixedRows / rowCount,
    tapWhileHoldingRatio: tapWhileHoldingRows / rowCount,
    activeReleaseRatio: activeReleaseHolds / holdCount,
    coordinatedReleaseRatio: coordinatedReleaseHolds / holdCount,
    heldWhileReleaseRatio: heldWhileReleaseHolds / holdCount,
    holdDurationP50: quantile(holdDurations, 0.5),
    inverseWindowCoverage: judgedWindows >= INVERSE_WINDOW_MIN_WINDOWS ? inverseWindows / judgedWindows : 0,
  };
}

function ratio(count: number, total: number): number {
  return total > 0 ? count / total : 0;
}

function pressure(value: number, low: number, high: number): number {
  return clamp01((value - low) / Math.max(0.001, high - low));
}

function roundedScore(value: number): number {
  return Math.round(clamp01(value) * 1000) / 1000;
}

function hit(id: ManiaPatternId, score: number, dataConfidence: number, evidence: string): ManiaPatternHit {
  return {
    id,
    label: MANIA_PATTERN_ANALYZER_LABELS[id],
    score: roundedScore(score),
    confidence: roundedScore(score * dataConfidence),
    evidence,
  };
}

function compactPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function analyzeManiaPatterns(
  map: ManiaBeatmap,
  input: DanEstimateInput = {},
  precomputedFeatures?: DanFeatureExtractionResult,
): ManiaPatternAnalysis {
  const rate = getInputRate(input);
  const features = precomputedFeatures ?? extractDanFeatures(map, input, rate);
  const { metrics, orderedRows } = features;
  const stats = getRowPatternStats(orderedRows, metrics.keyCount);
  const rowCount = Math.max(1, stats.rowCount);
  const chordRatio = metrics.chordRatio;
  const twoNoteRatio = ratio(stats.twoNoteRows, rowCount);
  const threeNoteRatio = ratio(stats.threeNoteRows, rowCount);
  const threePlusRatio = ratio(stats.threePlusRows, rowCount);
  const fourPlusRatio = ratio(stats.fourPlusRows, rowCount);
  const repeatedChordRatio = ratio(stats.repeatedChordRows, Math.max(1, stats.chordRows - 1));
  const lowChordGate = clamp01((0.34 - chordRatio) / 0.3);
  const streamActivity = Math.max(
    pressure(metrics.streamPressure, 1.5, 5.5),
    pressure(metrics.sustainedNps10s, metrics.keyCount >= 6 ? 7 : 12, metrics.keyCount >= 6 ? 18 : 27),
  );
  const chordstreamGate = minGate(
    pressure(chordRatio, metrics.keyCount >= 6 ? 0.14 : 0.24, metrics.keyCount >= 6 ? 0.5 : 0.58),
    pressure(metrics.sustainedNps10s, metrics.keyCount >= 6 ? 6 : 11, metrics.keyCount >= 6 ? 17 : 25),
  );
  // Chord density alone is not chordjack: dense 7K bracket/jumpstream files
  // carry chordRatio 0.8+ with almost no consecutive-chord column re-hits.
  // The overlap gate demands actual chord-jack repetition (~0.1 on bracket
  // files vs 0.5-0.97 on true CJ; the 0.18-0.4 ramp sits in the empty band
  // between the two populations).
  const chordOverlapGate = pressure(metrics.chordColumnOverlapRatio, 0.18, 0.4);
  const chordjackBase = Math.max(
    minGate(pressure(chordRatio, 0.28, 0.64), pressure(metrics.chordjackPressure, 70, 185), chordOverlapGate),
    minGate(pressure(chordRatio, 0.36, 0.72), pressure(metrics.jackPressure, 80, 180), chordOverlapGate),
  );
  const techScore = Math.max(
    minGate(pressure(metrics.techPressure, 3.5, 8.5), pressure(metrics.rowPatternChangeRate, 0.34, 0.66)),
    minGate(
      pressure(metrics.chordSizeChangeRate, 0.25, 0.58),
      pressure(metrics.directionChangeRate, 0.35, 0.72),
      pressure(metrics.rowIntervalEntropy, 1.1, 2.4),
    ),
  );
  const dataConfidence = clamp01(0.35 + Math.min(0.4, metrics.noteCount / 2500) + Math.min(0.25, stats.rowCount / 900));
  const candidates: ManiaPatternHit[] = [];
  // Note times are already rate-scaled, so the beat length must be too.
  const beatLengthMs = Number.isFinite(map.bpm) && map.bpm > 0 ? 60000 / (map.bpm * rate) : 0;
  const lnStats = getLnPatternStats(features.notes, orderedRows, metrics.keyCount, beatLengthMs);
  const lnScore = Math.max(
    pressure(metrics.holdRatio, 0.03, 0.32),
    minGate(pressure(metrics.lnDensity, 0.02, 0.18), pressure(metrics.lnOverlapPressure, 0.4, 2.4)),
    minGate(pressure(metrics.lnReleasePressure, 1.2, 5.5), pressure(metrics.holdRatio, 0.015, 0.16)),
    minGate(pressure(metrics.lnChordPressure, 0.15, 0.65), pressure(metrics.holdRatio, 0.02, 0.18)),
  );
  // 4K and 7K both get LN subtypes; the shapes are real on 4 columns too. The
  // raw LN row stats are keymode-neutral, but their distributions are not, so
  // the individual subtypes re-ramp themselves below where 4 columns shift the
  // population (measured over the 63k cached 4K charts that carry long notes).
  const lnSubtypeKeys = metrics.keyCount === 7 || metrics.keyCount === 4;
  const lnSubtypeGate = lnSubtypeKeys ? pressure(lnScore, 0.18, 0.58) : 0;
  // Two ways in. The whole-chart leg is the original: most same-column
  // releases are inverse re-presses and the chart is nearly all LN (a 16%
  // mixed-row ceiling). The windowed leg is for charts that are inverse in
  // sections: enough 8s windows read as inverse, under a looser mixed-row
  // ceiling, since the rice sits in the other sections. At 0.35-0.75
  // coverage and the 0.2-0.45 mixed ramp the inverse-labelled corpus goes
  // 89% -> 96% tagged and unlabelled LN charts 4.8% -> 6.5% (2026-09-03).
  // 7K only: the window cut was measured there, and on 4K the looser gap rule
  // reads dense short-hold chording as inverse (a 100ms hold re-pressed 100ms
  // later in one of four columns is most of what 4K LN chords look like).
  const lnInverseShape = Math.max(
    pressure(lnStats.inverseReleaseRatio, 0.24, 0.62) * clamp01((0.16 - lnStats.mixedRowRatio) / 0.16),
    metrics.keyCount === 7
      ? pressure(lnStats.inverseWindowCoverage, 0.35, 0.75) * clamp01((0.45 - lnStats.mixedRowRatio) / 0.25)
      : 0,
  );
  const lnInverseScore = lnSubtypeGate * minGate(
    lnInverseShape,
    pressure(metrics.lnDensity, 0.12, 0.5),
    Math.max(
      pressure(metrics.lnOverlapPressure, 1.1, 3.1),
      pressure(metrics.lnHoldDurationP90, 260, 520),
    ),
  );
  // Release is about where the release lands, not how many of them there are.
  // The old gate asked for isolated release rows (no note head at the same
  // instant), 12+ releases/sec and hold tails under 520ms, and all three run
  // the wrong way: measured 2026-08-25 over 324 7K charts whose mapper tags,
  // diff name or pack name say release/coordination against 1977 random 7K LN
  // charts, isolated release rows score AUC 0.36, releases/sec 0.19 and short
  // tails 0.23 - release charts have FEWER isolated releases (you let go while
  // hitting something else), longer tails (p50 281ms against 130ms) and no
  // more density than any other LN chart. What it built was a difficulty tag:
  // it fired on 5% of the labelled charts, its median hit sat at 8.32*, and
  // only 15 charts in the whole index cleared it under 5*.
  //
  // What separates instead, on the same corpus: releases that are not the
  // off-half of an inverse re-press (AUC 0.76 against random LN, 0.85 against
  // inverse-labelled charts), tails long enough that letting go is its own
  // motor action rather than the tail of a flick (0.79), and the release
  // landing against something - a press in another column (0.74) or other
  // holds still down (0.72). Two shapes clear the last leg, because release
  // charts come in both: the slow one, where long tails release onto other
  // presses, and the dense all-LN one, where tails are short but every release
  // happens under other holds.
  //
  // The dense leg's ramps were lowered 2026-09-03: the 7K LN dan release
  // practice charts release on half-beat tails at 175-190 BPM (p50 95-180ms),
  // which the slow leg cannot see, and sit at 53-62% released under other
  // holds against the leg's old 0.6 start. Against 150 release-named charts
  // and 14.3k unlabelled 7K LN charts, 0.45-0.7 takes recall at 0.5 from 45%
  // to 51% (the pack's 6th-10th from 0.12-0.67 to 0.51-1.0) for +1.9 points
  // of unlabelled hits.
  //
  // A third shape, the release wall: nearly all LN, 32+ releases a second,
  // half of them under other holds, not inverse. The Zenith and Stellium dan
  // release diffs are this and nothing else scores them (active releases sit
  // at 0.62, under the 0.55-0.88 entry gate, because a third of their holds
  // are re-pressed within a quarter beat). The leg is allowed past that gate.
  // It costs 51 unlabelled charts, every one a 7-12 star LN wall.
  //
  // Still 7K-only, but no longer for the old reason (4K release-only rows were
  // manufactured by short-hold vibro): these ramps are measured on 7K, where
  // the scene names the skillset and the corpus exists, and neither the maps
  // picker nor the player skill buckets offer a 4K release axis to fill.
  const lnReleaseWall = minGate(
    pressure(metrics.holdRatio, 0.85, 0.97),
    pressure(lnStats.heldWhileReleaseRatio, 0.45, 0.65),
    pressure(metrics.lnReleasePressure, 32, 46),
    clamp01((0.5 - lnStats.inverseReleaseRatio) / 0.15),
  );
  const lnReleaseScore = metrics.keyCount === 7
    ? lnSubtypeGate * minGate(
      pressure(metrics.holdRatio, 0.2, 0.46),
      Math.max(pressure(lnStats.activeReleaseRatio, 0.55, 0.88), lnReleaseWall),
      // Low floor on purpose: enough releases that the chart puts them in front
      // of you, ramped under the labelled charts' p02 rather than over their
      // p90 the way the old 12/sec term was.
      pressure(metrics.lnReleasePressure, 2.5, 6),
      Math.max(
        minGate(
          pressure(lnStats.holdDurationP50, 150, 330),
          Math.max(
            pressure(lnStats.coordinatedReleaseRatio, 0.34, 0.68),
            pressure(lnStats.heldWhileReleaseRatio, 0.32, 0.62),
          ),
        ),
        minGate(
          pressure(lnStats.heldWhileReleaseRatio, 0.45, 0.7),
          pressure(metrics.holdRatio, 0.6, 0.85),
          pressure(lnStats.activeReleaseRatio, 0.7, 0.9),
        ),
        lnReleaseWall,
      ),
    )
    : 0;
  const lnTechBurst = Math.max(
    pressure(metrics.fastRowRatio, 0.18, 0.36),
    pressure(metrics.rowBurstPressure, 16, 26),
  );
  // 4K charts tap while holding at roughly half the 7K rate (corpus p50 0.117
  // vs 0.281) and the 7K ramp starts below both populations, so on 4K it
  // saturates and stops discriminating, leaving lntech decided by the burst and
  // tech terms alone. Re-ramped onto the 4K distribution, and the chord-size
  // leg dropped: it carries no LN signal, and it was admitting pure tech and
  // dump charts (Figue Folle, Canon Rock) as LN tech.
  const lnTechCoordination = metrics.keyCount === 4
    ? Math.max(
      pressure(lnStats.tapWhileHoldingRatio, 0.1, 0.25),
      pressure(lnStats.headTailSwitchRatio, 0.3, 0.55),
    )
    : Math.max(
      pressure(lnStats.tapWhileHoldingRatio, 0.04, 0.11),
      pressure(lnStats.headTailSwitchRatio, 0.52, 0.72),
      pressure(metrics.chordSizeChangeRate, 0.55, 0.78),
    );
  // A 4K hold leaves three free lanes, so tech-flavoured rice with a token LN
  // still clears the coordination term. Demand actual LN content as well.
  const lnTechContentFloor = metrics.keyCount === 4 ? pressure(metrics.holdRatio, 0.2, 0.4) : 1;
  const lnTechScore = lnSubtypeGate * minGate(
    lnTechBurst,
    lnTechCoordination,
    lnTechContentFloor,
    Math.max(
      pressure(metrics.techPressure, 4.2, 8.4),
      pressure(metrics.rowIntervalEntropy, 2.0, 2.45),
    ),
    clamp01((0.6 - lnStats.inverseReleaseRatio) / 0.34),
    clamp01((0.66 - lnStats.releaseOnlyRatio) / 0.22),
  );
  const lnGeneralCoverage = Math.max(
    minGate(
      pressure(metrics.holdRatio, 0.35, 0.82),
      pressure(metrics.lnChordPressure, 0.32, 0.66),
      pressure(lnStats.headTailSwitchRatio, 0.35, 0.62),
    ),
    minGate(
      pressure(metrics.lnDensity, 0.12, 0.42),
      pressure(metrics.lnReleasePressure, 8, 24),
      pressure(chordRatio, 0.28, 0.62),
    ),
  );
  // General is the LN chart that is not one of the specialties, so it yields
  // to them fully: the old damper floored at 0.35, which left a visible
  // (>= 0.2) LN General tag on every saturated release or inverse chart.
  // With this ramp a specialty at 0.62+ removes it; across 7K, charts with a
  // specialty at 0.5+ go from 44% to 4.5% co-tagged, and no LN chart loses
  // its only subtype (2026-09-03).
  const lnSpecialtyScore = Math.max(lnInverseScore, lnReleaseScore, lnTechScore);
  const lnGeneralScore = lnSubtypeGate
    * lnGeneralCoverage
    * clamp01((0.7 - lnSpecialtyScore) / 0.4);

  candidates.push(hit(
    "ln",
    metrics.keyCount === 7 ? lnScore * 0.62 : lnScore,
    dataConfidence,
    `${compactPercent(metrics.holdRatio)} holds, release pressure ${metrics.lnReleasePressure.toFixed(1)}`,
  ));
  if (lnSubtypeKeys) {
    candidates.push(
      hit("lngeneral", lnGeneralScore, dataConfidence, `${compactPercent(metrics.lnChordPressure)} LN chord rows, ${compactPercent(lnStats.headTailSwitchRatio)} head/tail switches`),
      hit("lninverse", lnInverseScore, dataConfidence, `${compactPercent(lnStats.inverseReleaseRatio)} short same-column release gaps, p50 gap ${Math.round(lnStats.sameColumnReleaseGapP50)}ms, ${compactPercent(lnStats.inverseWindowCoverage)} of the chart in inverse sections`),
      hit("lntech", lnTechScore, dataConfidence, `${compactPercent(lnStats.tapWhileHoldingRatio)} tap-with-hold rows, burst pressure ${metrics.rowBurstPressure.toFixed(1)}`),
    );
    if (metrics.keyCount === 7) {
      candidates.push(
        hit("lnrelease", lnReleaseScore, dataConfidence, `${compactPercent(lnStats.activeReleaseRatio)} releases timed on their own, p50 tail ${Math.round(lnStats.holdDurationP50)}ms, ${compactPercent(lnStats.heldWhileReleaseRatio)} released under other holds`),
      );
    }
  }

  if (metrics.keyCount === 4) {
    const jackScore = Math.max(
      pressure(metrics.jackPressure, 75, 185) * (0.55 + lowChordGate * 0.35),
      minGate(pressure(metrics.jackPressure, 110, 200), pressure(metrics.fastRowRatio, 0.05, 0.28)),
    );
    candidates.push(
      hit("jack", jackScore, dataConfidence, `same-lane pressure ${Math.round(metrics.jackPressure)}`),
      hit("chordjack", chordjackBase, dataConfidence, `${compactPercent(chordRatio)} chord rows, jack pressure ${Math.round(metrics.jackPressure)}`),
      hit("speedjack", chordjackBase * minGate(
        pressure(twoNoteRatio, 0.18, 0.42),
        pressure(metrics.jackPressure, 115, 205),
        clamp01((0.68 - threePlusRatio) / 0.35),
      ), dataConfidence, `${compactPercent(twoNoteRatio)} two-note rows, light dense jacks`),
      hit("handjack", chordjackBase * minGate(
        pressure(threePlusRatio, 0.08, 0.28),
        pressure(stats.averageChordSize, 2.15, 3.1),
        pressure(metrics.jackPressure, 95, 180),
      ), dataConfidence, `${compactPercent(threePlusRatio)} 3+ note rows in jack pressure`),
      hit("tech", techScore, dataConfidence, `pattern change ${compactPercent(metrics.rowPatternChangeRate)}, tech pressure ${metrics.techPressure.toFixed(1)}`),
      hit("stream", lowChordGate * streamActivity * clamp01((150 - metrics.jackPressure) / 120), dataConfidence, `${compactPercent(chordRatio)} chord rows, sustained flow`),
      hit("dumpstream", lowChordGate * streamActivity * minGate(
        pressure(metrics.rowPatternEntropy, 1.8, 3.5),
        pressure(metrics.rowIntervalEntropy, 1.2, 2.7),
        clamp01((0.75 - metrics.rhythmMotifRepeatRatio) / 0.45),
      ), dataConfidence, `irregular stream entropy ${metrics.rowIntervalEntropy.toFixed(1)}`),
      hit("jumpstream", minGate(
        pressure(twoNoteRatio, 0.14, 0.36),
        pressure(chordRatio, 0.24, 0.56),
        pressure(metrics.jumpstreamPressure, 8, 22),
      ), dataConfidence, `${compactPercent(twoNoteRatio)} two-note chord rows`),
      hit("handstream", minGate(
        pressure(threeNoteRatio, 0.06, 0.22),
        pressure(chordRatio, 0.32, 0.62),
        pressure(metrics.sustainedNps10s, 13, 27),
        clamp01((175 - metrics.jackPressure) / 120),
      ), dataConfidence, `${compactPercent(threeNoteRatio)} three-note rows in stream`),
      hit("quadstream", minGate(
        pressure(fourPlusRatio, 0.015, 0.08),
        pressure(chordRatio, 0.36, 0.72),
        pressure(metrics.sustainedNps10s, 12, 25),
      ), dataConfidence, `${compactPercent(fourPlusRatio)} quad rows in stream`),
    );
  } else if (metrics.keyCount >= 6 && metrics.keyCount <= 8) {
    // 8K joined this branch on 2026-09-02: its charts are 7K's vocabulary
    // (many are mapped as 7K+1 with a quiet scratch column), and the generic
    // branch below could never say bracket, delay or jack about them. [8K]
    // Abyss 8 (3992501) is the case that named it: a bracket file that stored
    // as chordstream 1.00 because the branch had no bracket detector.
    const nonLnFlowGate = clamp01((0.3 - metrics.holdRatio) / 0.22);
    const nonLnPatternGate = clamp01((0.68 - metrics.holdRatio) / 0.56);
    // Brackets are dense chords that move across the columns, so consecutive
    // chords re-hitting their columns is evidence against the tag: a chordjack
    // chart's chords are bracket-shaped row by row, and without this gate the
    // detector saturated on exactly the files it should refuse (a 260BPM 7K CJ
    // chart was the #1 "Bracket" play on profile skill cards). Measured over
    // the stored bracket-tagged 6K/7K corpus (2026-08-16): jack-family cluster
    // verdicts are ~0% below 0.4 overlap, 19% at 0.45-0.5, 56% at 0.55-0.6 and
    // 94%+ from 0.75, while nearly every saturated (>=0.95) bracket score sat
    // on a jack-family chart. The ramp starts above the chordstream population
    // and is closed before the CJ majority band.
    const bracketOverlapGate = clamp01((0.62 - metrics.chordColumnOverlapRatio) / 0.17);
    // Bracket content: how much of the chart is sustained chording that neither
    // jacks nor rolls (getRowPatternStats' bracketWindowRows). Bracket *shape*
    // is not usable on its own - on 7 columns a chord is adjacent-pair shaped
    // mostly by chance, so mapper-labelled bracket charts carry 0.199
    // bracket-shaped rows against 0.185 for random 7K charts (AUC 0.52), and
    // chordjack files outscore real bracket files on it. This window is the
    // only content term: the old row-shape and chord-size legs are gone, since
    // both measure density and on a file of two-note brackets only ever
    // subtracted true positives. What holds chordjack out is the overlap gate.
    //
    // Ramp measured 2026-08-17 against 361 charts whose mapper tags say bracket,
    // 500 random 7K charts, 502 chordjack-tagged ones and the 92 main diffs of
    // the BEST OF BRACKETS packs: at 0.18-0.38 the tag reaches every diff in
    // those packs and 56.5% of tag-labelled charts, while random charts sit at
    // 10.8% and chordjack-tagged ones at 2.0%.
    const bracketWindowRatio = ratio(stats.bracketWindowRows, rowCount);
    const wideChordstream = Math.max(
      chordstreamGate,
      minGate(pressure(chordRatio, 0.2, 0.62), pressure(metrics.chordSizeChangeRate, 0.18, 0.52)),
    );
    const singleJack = getSingleJackStats(orderedRows);
    // Chord-tech is not chordjack. The overlap gate above asks whether
    // consecutive chords share ANY column, and a 7K tech chart re-hits one
    // finger between chords all the time (a chord of three moving to a chord
    // of three next to it) without ever jacking the chord: [7K] Miserable
    // Bastard from the Terminal 11 Technical Pack (3537470) sits at 0.50
    // overlap, chordjack 0.92, and filed as Chordjack over tech 0.52. What
    // real chordjack has and chord-tech lacks is the chord itself repeating:
    // consecutive chords sharing two or more columns, single notes re-hit one
    // row back (the minijack content), or chords arriving in long unbroken
    // runs rather than two or three at a time between singles. Measured
    // 2026-09-03 over 7K rice charts filed Chordjack: 151 from chordjack-tagged
    // sets and jack packs against the 4 from tech-tagged sets and tech packs
    // (of 101). Multi-column overlap sits at p10 0.215 / p50 0.559 on the jack
    // side against 0.17-0.23 on the tech side; jack1Share p10 0.216 against
    // 0.12-0.18; mean chord run p10 4.8 against 2.4-6.6. Any one arm keeps the
    // tag. At these ramps 3 of the 4 tech-side charts move to Tech, 8 of the
    // 207 jack-family charts leave the family (7 of them files LeoBlack calls
    // chordstream, none it calls chordjack) and 13 of a random 974 change
    // primary (1.3%, 7 of them to Tech, 4 to Delay once the chordjack veto
    // on delay lets go).
    const chordRepeatGate = Math.max(
      pressure(ratio(stats.multiOverlapChordPairs, Math.max(1, stats.chordPairs)), 0.16, 0.26),
      pressure(singleJack.jack1Share, 0.16, 0.26),
      pressure(stats.chordRows / Math.max(1, stats.chordRuns), 4, 8),
    );
    const chordjackScore = nonLnPatternGate * chordRepeatGate * Math.max(
      chordjackBase,
      minGate(pressure(chordRatio, 0.34, 0.72), pressure(repeatedChordRatio, 0.04, 0.22)),
    );
    // Delay is the off-grid flow itself (offGridRowShare in features.ts):
    // 1/8 and 1/12 rows in the BMS delay packs, 1/6 in the 7777's practice
    // packs. The previous reading was density plus entropy plus low
    // repetition, which any hard broken stream saturates: a 192 BPM 1/4
    // minijack-chordstream chart with 0.3% off-grid rows scored 0.60 and was
    // one player's #1 Delay play. Ramp measured 2026-09-03 over 232
    // delay-named 7K charts (share p10 0.43 / p25 0.61) against 143 jack
    // (p90 0.12), 106 stream (p90 0.10), 51 tech (p50 0.18 / p90 0.45) and
    // 700 random 7K (p50 0.07 / p75 0.23 / p90 0.46). The 0.2-0.5 ramp puts
    // the 0.25 line player-skills reads at 27.5% of rows: a first pass at
    // 0.12-0.42 (19.5%) tagged a bracket chordstream chart carrying thirteen
    // seconds of 1/8 fills, which the user read as stream, not delay. At this
    // ramp the tag keeps 96% of the delay corpus (94% before) and reaches 1%
    // of stream (58% before), 0% of jack, 27% of tech and 8% of random (21%
    // before, 1/6 and 1/8 o2jam-style files). The speed packs split 34% /
    // 66%: their 1/4 streams at 200+ BPM are speed, not delay, and leave the
    // tag on purpose.
    //
    // Same veto the tech tag takes in player-skills, for the same reason: a
    // 1/8 chordjack file is jack, not delay. Narrow ramp rather than a cliff,
    // closed at the same 0.8 TECH_TAG_CHORDJACK_VETO uses.
    const delayChordjackVeto = clamp01((0.8 - chordjackScore) / 0.05);
    const delayScore = nonLnFlowGate * delayChordjackVeto * pressure(metrics.offGridRowShare, 0.2, 0.5);
    // Ramps measured 2026-08 against mapper-named 7K pack corpora (279 jack /
    // 78 tech / 136 stream / 150 delay charts) plus 700 random 7K charts:
    // jack1Share sits at p25 0.271 / p50 0.404 on the jack corpus against
    // p90 0.163 (tech), 0.162 (stream) and 0.129 (delay), so the 0.08-0.28
    // ramp puts the 0.5 tag line at 0.18, between those populations. The
    // trill arm's 0.03-0.12 ramp tags from 0.075, three times any corpus p90.
    const jackScore = nonLnPatternGate * Math.max(
      pressure(singleJack.jack1Share, 0.08, 0.28),
      pressure(singleJack.trillRunShare, 0.03, 0.12),
    );
    candidates.push(
      hit("delay", delayScore, dataConfidence, `${compactPercent(metrics.offGridRowShare)} rows off the 16th grid (1/6, 1/8, 1/12)`),
      hit("jack", jackScore, dataConfidence, `${compactPercent(singleJack.jack1Share)} consecutive-row column re-hits, ${compactPercent(singleJack.trillRunShare)} notes in two-row trill runs`),
      hit("chordjack", chordjackScore, dataConfidence, `${compactPercent(chordRatio)} chord rows, ${compactPercent(repeatedChordRatio)} repeated chord rows`),
      hit("tech", nonLnPatternGate * Math.max(
        techScore,
        wideChordstream * minGate(pressure(metrics.rowPatternChangeRate, 0.38, 0.72), pressure(metrics.fastRowRatio, 0.08, 0.36)),
      ), dataConfidence, `chord changes ${compactPercent(metrics.chordSizeChangeRate)}, tech pressure ${metrics.techPressure.toFixed(1)}`),
      hit("bracket", nonLnPatternGate * bracketOverlapGate * minGate(
        pressure(chordRatio, 0.28, 0.62),
        pressure(bracketWindowRatio, 0.18, 0.38),
      ), dataConfidence, `${compactPercent(bracketWindowRatio)} sustained non-jacking chord runs, ${compactPercent(metrics.chordColumnOverlapRatio)} consecutive-chord column re-hits`),
      hit("chordstream", nonLnPatternGate * wideChordstream * clamp01((165 - metrics.jackPressure) / 130), dataConfidence, `${compactPercent(chordRatio)} chord rows mixed into stream`),
    );
  } else {
    candidates.push(
      hit("stream", lowChordGate * streamActivity, dataConfidence, `${metrics.keyCount}K low-chord stream flow`),
      hit("chordstream", chordstreamGate, dataConfidence, `${compactPercent(chordRatio)} chord rows mixed into stream`),
      hit("chordjack", chordjackBase, dataConfidence, `${compactPercent(chordRatio)} chord rows, jack pressure ${Math.round(metrics.jackPressure)}`),
      hit("tech", techScore, dataConfidence, `pattern change ${compactPercent(metrics.rowPatternChangeRate)}`),
    );
  }

  const allPatterns = candidates
    .map((candidate) => ({ ...candidate, score: roundedScore(candidate.score), confidence: roundedScore(candidate.confidence) }))
    .sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
  const visiblePatterns = allPatterns.filter((pattern) => pattern.score >= 0.2).slice(0, 5);
  const lnPattern = allPatterns.find((pattern) => pattern.id === "ln");
  // Surface the LN axis alongside the visible patterns only when the chart has
  // a real LN signal (a nonzero score or any holds at all). Unconditionally
  // force-appending it stamped a score-0 ln entry onto every rice chart, which
  // leaked into stored classifications and pattern tags downstream.
  const hasLnSignal = lnPattern != null && (lnPattern.score > 0 || metrics.holdRatio > 0);
  const lnAxisPatterns = lnPattern && hasLnSignal && !visiblePatterns.some((pattern) => pattern.id === "ln")
    ? [...visiblePatterns, lnPattern]
    : visiblePatterns;
  // Same escape hatch for the LN subtypes. A 4K chart fields ten rice
  // candidates against 7K's eight and doesn't damp its ln score, so the top-5
  // slice was dropping a third of the 4K lngeneral tags that cleared the bar
  // (and ~1% of 7K's). A subtype is an attribute of the chart, not a claim on
  // its identity, so it shouldn't have to outrank the rice families to be
  // recorded. Appended after, so the primary is unaffected.
  const subtypeOverflow = allPatterns.filter((pattern) =>
    LN_SUBTYPE_IDS.has(pattern.id)
    && pattern.score >= 0.2
    && !lnAxisPatterns.some((visible) => visible.id === pattern.id));
  const patterns = subtypeOverflow.length > 0 ? [...lnAxisPatterns, ...subtypeOverflow] : lnAxisPatterns;

  return {
    keyCount: metrics.keyCount,
    primary: patterns[0] ?? allPatterns[0] ?? null,
    patterns,
    allPatterns,
    metrics,
    warnings: features.warnings,
  };
}
