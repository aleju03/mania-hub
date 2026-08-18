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
  let previousChordMask: number | null = null;
  let previousColumns: number[] = [];
  let beforePreviousColumns: number[] = [];

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
  const lnInverseScore = lnSubtypeGate * minGate(
    pressure(lnStats.inverseReleaseRatio, 0.24, 0.62),
    pressure(metrics.lnDensity, 0.12, 0.5),
    Math.max(
      pressure(metrics.lnOverlapPressure, 1.1, 3.1),
      pressure(metrics.lnHoldDurationP90, 260, 520),
    ),
    clamp01((0.16 - lnStats.mixedRowRatio) / 0.16),
  );
  // Release stays 7K-only. On 4 columns, short-hold vibro spam manufactures
  // release-only rows, so the highest-scoring 4K charts in the corpus were
  // vibro packs, vibro dan courses and jumptrill memes rather than anything
  // release-focused. The vibro flag catches under 5% of them, so there is no
  // cheap filter that rescues it.
  const lnReleaseScore = metrics.keyCount === 7
    ? lnSubtypeGate * minGate(
      pressure(lnStats.releaseOnlyRatio, 0.48, 0.68),
      pressure(metrics.lnReleasePressure, 12, 30),
      clamp01((0.45 - lnStats.inverseReleaseRatio) / 0.32),
      clamp01((520 - metrics.lnHoldDurationP90) / 260),
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
  if (lnSubtypeKeys) {
    candidates.push(
      hit("lngeneral", lnGeneralScore, dataConfidence, `${compactPercent(metrics.lnChordPressure)} LN chord rows, ${compactPercent(lnStats.headTailSwitchRatio)} head/tail switches`),
      hit("lninverse", lnInverseScore, dataConfidence, `${compactPercent(lnStats.inverseReleaseRatio)} short same-column release gaps, p50 gap ${Math.round(lnStats.sameColumnReleaseGapP50)}ms`),
      hit("lntech", lnTechScore, dataConfidence, `${compactPercent(lnStats.tapWhileHoldingRatio)} tap-with-hold rows, burst pressure ${metrics.rowBurstPressure.toFixed(1)}`),
    );
    if (metrics.keyCount === 7) {
      candidates.push(
        hit("lnrelease", lnReleaseScore, dataConfidence, `${compactPercent(lnStats.releaseOnlyRatio)} release-only rows, release pressure ${metrics.lnReleasePressure.toFixed(1)}`),
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
  } else if (metrics.keyCount === 6 || metrics.keyCount === 7) {
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
    const chordjackScore = nonLnPatternGate * Math.max(
      chordjackBase,
      minGate(pressure(chordRatio, 0.34, 0.72), pressure(repeatedChordRatio, 0.04, 0.22)),
    );
    // Same veto the tech tag takes in player-skills, for the same reason: the
    // delay ingredients are density, entropy and low repetition, all of which
    // dense chordjack saturates, so CJ files scored delay on nothing but being
    // hard. Measured 2026-08-16 over 250 delay-named and 700 random 7K charts,
    // the veto costs zero delay-named charts their tag at every cutoff from
    // 0.7 to 0.9 while dropping ones like "[7K] JACK Another" (delay 0.62,
    // chordjack 1.00). Narrow ramp rather than a cliff, closed at the same 0.8
    // TECH_TAG_CHORDJACK_VETO uses.
    const delayChordjackVeto = clamp01((0.8 - chordjackScore) / 0.05);
    const delayScore = nonLnFlowGate * delayChordjackVeto * Math.max(
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
