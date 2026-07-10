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

interface RowPatternStats {
  rowCount: number;
  chordRows: number;
  twoNoteRows: number;
  threeNoteRows: number;
  fourPlusRows: number;
  threePlusRows: number;
  singleRows: number;
  repeatedChordRows: number;
  bracketRows: number;
  averageChordSize: number;
}

interface LnPatternStats {
  inverseReleaseRatio: number;
  sameColumnReleaseGapP50: number;
  releaseOnlyRatio: number;
  headTailSwitchRatio: number;
  mixedRowRatio: number;
  tapWhileHoldingRatio: number;
}

function rowColumns(rowNotes: ManiaNote[]): number[] {
  return [...new Set(rowNotes.map((note) => note.column))].sort((a, b) => a - b);
}

function adjacentPairCount(columns: number[]): number {
  let pairs = 0;
  for (let index = 1; index < columns.length; index++) {
    if (columns[index] === columns[index - 1] + 1) pairs++;
  }
  return pairs;
}

function hasMiddleAdjacentPair(columns: number[], keyCount: number): boolean {
  const center = (keyCount - 1) / 2;
  for (let index = 1; index < columns.length; index++) {
    if (columns[index] !== columns[index - 1] + 1) continue;
    const midpoint = (columns[index] + columns[index - 1]) / 2;
    if (Math.abs(midpoint - center) <= 1.5) return true;
  }
  return false;
}

function getRowPatternStats(orderedRows: Array<[number, ManiaNote[]]>, keyCount: number): RowPatternStats {
  let chordRows = 0;
  let twoNoteRows = 0;
  let threeNoteRows = 0;
  let fourPlusRows = 0;
  let threePlusRows = 0;
  let singleRows = 0;
  let repeatedChordRows = 0;
  let bracketRows = 0;
  let totalChordSize = 0;
  let previousChordMask: number | null = null;

  for (const [, rowNotes] of orderedRows) {
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
    } else {
      previousChordMask = null;
    }
    if (size === 2) twoNoteRows++;
    if (size === 3) threeNoteRows++;
    if (size >= 4) fourPlusRows++;
    if (size >= 3) threePlusRows++;
    if (keyCount >= 6 && size >= 3) {
      const adjacentPairs = adjacentPairCount(columns);
      if (adjacentPairs >= 2 || (adjacentPairs >= 1 && hasMiddleAdjacentPair(columns, keyCount))) {
        bracketRows++;
      }
    }
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
    bracketRows,
    averageChordSize: chordRows ? totalChordSize / chordRows : 0,
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
  const notesByColumn = Array.from({ length: Math.max(1, keyCount) }, () => [] as ManiaNote[]);

  for (const note of notes) {
    if (note.column >= 0 && note.column < notesByColumn.length) notesByColumn[note.column].push(note);
    if (!note.isHold || note.endTime <= note.time) continue;

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

  for (const columnNotes of notesByColumn) {
    columnNotes.sort((left, right) => left.time - right.time || left.endTime - right.endTime);
    for (let index = 0; index < columnNotes.length - 1; index++) {
      const note = columnNotes[index];
      if (!note.isHold || note.endTime <= note.time) continue;

      const nextNote = columnNotes[index + 1];
      const gap = nextNote.time - note.endTime;
      if (gap < 0) continue;

      const holdDuration = Math.max(1, note.endTime - note.time);
      const gapRatio = gap / holdDuration;
      sameColumnNextHolds++;
      sameColumnGaps.push(gap);
      if (gap <= gapCap && gapRatio <= 0.7) inverseLikeHolds++;
    }
  }

  const rowCount = Math.max(1, orderedRows.length);
  const releaseRowCount = releaseRows.size;

  return {
    inverseReleaseRatio: sameColumnNextHolds ? inverseLikeHolds / sameColumnNextHolds : 0,
    sameColumnReleaseGapP50: quantile(sameColumnGaps, 0.5),
    releaseOnlyRatio: releaseRowCount ? releaseOnlyRows / releaseRowCount : 0,
    headTailSwitchRatio: headTailSwitchRows / rowCount,
    mixedRowRatio: mixedRows / rowCount,
    tapWhileHoldingRatio: tapWhileHoldingRows / rowCount,
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
  const bracketRatio = ratio(stats.bracketRows, rowCount);
  const lowChordGate = clamp01((0.34 - chordRatio) / 0.3);
  const streamActivity = Math.max(
    pressure(metrics.streamPressure, 1.5, 5.5),
    pressure(metrics.sustainedNps10s, metrics.keyCount >= 6 ? 7 : 12, metrics.keyCount >= 6 ? 18 : 27),
  );
  const chordstreamGate = minGate(
    pressure(chordRatio, metrics.keyCount >= 6 ? 0.14 : 0.24, metrics.keyCount >= 6 ? 0.5 : 0.58),
    pressure(metrics.sustainedNps10s, metrics.keyCount >= 6 ? 6 : 11, metrics.keyCount >= 6 ? 17 : 25),
  );
  const chordjackBase = Math.max(
    minGate(pressure(chordRatio, 0.28, 0.64), pressure(metrics.chordjackPressure, 70, 185)),
    minGate(pressure(chordRatio, 0.36, 0.72), pressure(metrics.jackPressure, 80, 180)),
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
  const lnSubtypeGate = metrics.keyCount === 7 ? pressure(lnScore, 0.18, 0.58) : 0;
  const lnInverseScore = lnSubtypeGate * minGate(
    pressure(lnStats.inverseReleaseRatio, 0.24, 0.62),
    pressure(metrics.lnDensity, 0.12, 0.5),
    Math.max(
      pressure(metrics.lnOverlapPressure, 1.1, 3.1),
      pressure(metrics.lnHoldDurationP90, 260, 520),
    ),
    clamp01((0.16 - lnStats.mixedRowRatio) / 0.16),
  );
  const lnReleaseScore = lnSubtypeGate * minGate(
    pressure(lnStats.releaseOnlyRatio, 0.48, 0.68),
    pressure(metrics.lnReleasePressure, 12, 30),
    clamp01((0.45 - lnStats.inverseReleaseRatio) / 0.32),
    clamp01((520 - metrics.lnHoldDurationP90) / 260),
  );
  const lnTechBurst = Math.max(
    pressure(metrics.fastRowRatio, 0.18, 0.36),
    pressure(metrics.rowBurstPressure, 16, 26),
  );
  const lnTechCoordination = Math.max(
    pressure(lnStats.tapWhileHoldingRatio, 0.04, 0.11),
    pressure(lnStats.headTailSwitchRatio, 0.52, 0.72),
    pressure(metrics.chordSizeChangeRate, 0.55, 0.78),
  );
  const lnTechScore = lnSubtypeGate * minGate(
    lnTechBurst,
    lnTechCoordination,
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
  const lnSpecialtyScore = Math.max(lnInverseScore, lnReleaseScore, lnTechScore);
  const lnGeneralScore = lnSubtypeGate
    * lnGeneralCoverage
    * (0.35 + 0.65 * clamp01((0.78 - lnSpecialtyScore) / 0.38));

  candidates.push(hit(
    "ln",
    metrics.keyCount === 7 ? lnScore * 0.62 : lnScore,
    dataConfidence,
    `${compactPercent(metrics.holdRatio)} holds, release pressure ${metrics.lnReleasePressure.toFixed(1)}`,
  ));
  if (metrics.keyCount === 7) {
    candidates.push(
      hit("lngeneral", lnGeneralScore, dataConfidence, `${compactPercent(metrics.lnChordPressure)} LN chord rows, ${compactPercent(lnStats.headTailSwitchRatio)} head/tail switches`),
      hit("lnrelease", lnReleaseScore, dataConfidence, `${compactPercent(lnStats.releaseOnlyRatio)} release-only rows, release pressure ${metrics.lnReleasePressure.toFixed(1)}`),
      hit("lninverse", lnInverseScore, dataConfidence, `${compactPercent(lnStats.inverseReleaseRatio)} short same-column release gaps, p50 gap ${Math.round(lnStats.sameColumnReleaseGapP50)}ms`),
      hit("lntech", lnTechScore, dataConfidence, `${compactPercent(lnStats.tapWhileHoldingRatio)} tap-with-hold rows, burst pressure ${metrics.rowBurstPressure.toFixed(1)}`),
    );
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
  } else if (metrics.keyCount === 6 || metrics.keyCount === 7) {
    const nonLnFlowGate = clamp01((0.3 - metrics.holdRatio) / 0.22);
    const nonLnPatternGate = clamp01((0.68 - metrics.holdRatio) / 0.56);
    const wideChordstream = Math.max(
      chordstreamGate,
      minGate(pressure(chordRatio, 0.2, 0.62), pressure(metrics.chordSizeChangeRate, 0.18, 0.52)),
    );
    const delayScore = nonLnFlowGate * Math.max(
      lowChordGate * streamActivity,
      minGate(
        pressure(metrics.sustainedNps10s, 14, 30),
        pressure(metrics.peakNps5s, 18, 34),
        Math.max(
          pressure(metrics.rowIntervalEntropy, 1.4, 2.8),
          pressure(metrics.fastRowRatio, 0.35, 0.9),
        ),
        pressure(metrics.rowPatternEntropy, 2.2, 5),
        clamp01((0.4 - metrics.repeatedRowPatternRatio) / 0.4),
      ),
    );
    candidates.push(
      hit("delay", delayScore, dataConfidence, `${metrics.keyCount}K dense broken-stream flow, entropy ${metrics.rowIntervalEntropy.toFixed(1)}`),
      hit("chordjack", nonLnPatternGate * Math.max(
        chordjackBase,
        minGate(pressure(chordRatio, 0.34, 0.72), pressure(repeatedChordRatio, 0.04, 0.22)),
      ), dataConfidence, `${compactPercent(chordRatio)} chord rows, ${compactPercent(repeatedChordRatio)} repeated chord rows`),
      hit("tech", nonLnPatternGate * Math.max(
        techScore,
        wideChordstream * minGate(pressure(metrics.rowPatternChangeRate, 0.38, 0.72), pressure(metrics.fastRowRatio, 0.08, 0.36)),
      ), dataConfidence, `chord changes ${compactPercent(metrics.chordSizeChangeRate)}, tech pressure ${metrics.techPressure.toFixed(1)}`),
      hit("bracket", nonLnPatternGate * minGate(
        pressure(bracketRatio, 0.035, 0.18),
        pressure(chordRatio, 0.28, 0.62),
        pressure(stats.averageChordSize, 2.4, 4),
      ), dataConfidence, `${compactPercent(bracketRatio)} bracket-like dense chord rows`),
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
  const patterns = lnPattern && !visiblePatterns.some((pattern) => pattern.id === "ln")
    ? [...visiblePatterns, lnPattern]
    : visiblePatterns;

  return {
    keyCount: metrics.keyCount,
    primary: patterns[0] ?? allPatterns[0] ?? null,
    patterns,
    allPatterns,
    metrics,
    warnings: features.warnings,
  };
}
