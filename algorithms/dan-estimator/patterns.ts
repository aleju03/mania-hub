// Pattern tags for a chart. Scores each pattern from 0 to 1 from the dan
// feature metrics and a few row and hold stats, and returns them ranked. 4K,
// 6K-8K and other keymodes get their own detectors. LN subtypes run on 4K and
// 7K only.

import type { ManiaBeatmap, ManiaNote } from "../chart/beatmap";
import { extractDanFeatures } from "./features";
import { getInputRate } from "./labels";
import { clamp01, minGate, quantile } from "./math";
import type { DanEstimateInput, DanFeatureExtractionResult, ManiaPatternAnalysis, ManiaPatternHit, ManiaPatternId } from "./types";

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

const LN_SUBTYPE_IDS = new Set<string>(["lngeneral", "lnrelease", "lninverse", "lntech"]);

// Windowed inverse, for charts that are inverse only in sections. In each 8s
// window a pair counts when its release gap fits inside the hold's length,
// and the window counts when most of its pairs do. Separates inverse-named
// 7K charts from other 7K LN at AUC 0.964.
const INVERSE_WINDOW_MS = 8000;
const INVERSE_WINDOW_MIN_PAIRS = 20;
const INVERSE_WINDOW_MIN_WINDOWS = 3;
const INVERSE_WINDOW_RATIO = 0.65;

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
  // re-hit two or more columns. Those are the chord being jacked.
  chordPairs: number;
  multiOverlapChordPairs: number;
  // Runs of consecutive chord rows, broken by any single-note row.
  chordRuns: number;
}

interface LnPatternStats {
  inverseReleaseRatio: number;
  sameColumnReleaseGapP50: number;
  releaseOnlyRatio: number;
  headTailSwitchRatio: number;
  mixedRowRatio: number;
  tapWhileHoldingRatio: number;
  // Release shape over every hold. An active release is one that is not the
  // off-half of an inverse re-press.
  activeReleaseRatio: number;
  coordinatedReleaseRatio: number;
  heldWhileReleaseRatio: number;
  holdDurationP50: number;
  // Share of 8s windows whose holds are mostly re-pressed within their own
  // length of the release.
  inverseWindowCoverage: number;
  // Share of column-time (chart span x columns) spent inside a hold body.
  heldTimeShare: number;
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
  // Chordjack needs consecutive chords to share columns. Dense 7K bracket
  // charts have chordRatio 0.8+ with overlap near 0.1. Real chordjack sits
  // at 0.5-0.97.
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
  // 0.35 to 1, growing with note and row count.
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
  // Some subtypes re-ramp on 4K, where the LN stats distribute differently.
  const lnSubtypeKeys = metrics.keyCount === 7 || metrics.keyCount === 4;
  const lnSubtypeGate = lnSubtypeKeys ? pressure(lnScore, 0.18, 0.58) : 0;
  // Two ways into inverse. The whole-chart leg needs most same-column
  // releases to be inverse re-presses and under 16% mixed rows. The windowed
  // leg catches charts inverse in sections. It is 7K only, since on 4K its
  // looser gap rule reads dense short-hold chording as inverse.
  const lnInverseShape = Math.max(
    pressure(lnStats.inverseReleaseRatio, 0.24, 0.62) * clamp01((0.16 - lnStats.mixedRowRatio) / 0.16),
    metrics.keyCount === 7
      ? pressure(lnStats.inverseWindowCoverage, 0.35, 0.75) * clamp01((0.45 - lnStats.mixedRowRatio) / 0.25)
      : 0,
  );
  // 4K inverse also needs the columns held down most of the time. The pair
  // rule cannot tell a short-hold LN burst in a rice chart from a fully held
  // chart. Inverse-named 4K charts start at 0.467 held share.
  const lnInverseHeldGate = metrics.keyCount === 4 ? pressure(lnStats.heldTimeShare, 0.4, 0.55) : 1;
  const lnInverseScore = lnSubtypeGate * minGate(
    lnInverseShape,
    pressure(metrics.lnDensity, 0.12, 0.5),
    Math.max(
      pressure(metrics.lnOverlapPressure, 1.1, 3.1),
      pressure(metrics.lnHoldDurationP90, 260, 520),
    ),
    lnInverseHeldGate,
  );
  // LN Release scores where releases land. Release charts have active
  // releases with long tails that land on a press in another column or under
  // other holds. A dense leg covers all-LN charts with short tails released
  // under other holds.
  //
  // The wall leg (nearly all LN, 32+ releases a second, half under other
  // holds) bypasses the active-release gate, which the top 7K LN release
  // courses sit under.
  //
  // 7K only. The ramps are fit on labelled 7K charts.
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
      // Ramped under the labelled charts' p02.
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
  // 4K taps while holding at about half the 7K rate, so it gets its own
  // ramps. It drops the chord-size leg, which lets pure tech and dump charts
  // in as LN tech.
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
  // A 4K hold leaves three free lanes, so tech rice with a token LN clears
  // the coordination term. This asks for real LN content too.
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
  // General is the LN chart with no specialty. A specialty at 0.62+ removes
  // it.
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
      hit("lninverse", lnInverseScore, dataConfidence, `${compactPercent(lnStats.inverseReleaseRatio)} short same-column release gaps, p50 gap ${Math.round(lnStats.sameColumnReleaseGapP50)}ms, ${compactPercent(lnStats.inverseWindowCoverage)} of the chart in inverse sections, columns held ${compactPercent(lnStats.heldTimeShare)} of the time`),
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
    // 8K shares this branch since many 8K charts are 7K plus a scratch
    // column. The generic branch has no bracket, delay or jack detector.
    const nonLnFlowGate = clamp01((0.3 - metrics.holdRatio) / 0.22);
    const nonLnPatternGate = clamp01((0.68 - metrics.holdRatio) / 0.56);
    // Brackets move across the columns, so consecutive chords re-hitting
    // their columns count against the tag. The ramp closes before the
    // chordjack majority band.
    const bracketOverlapGate = clamp01((0.62 - metrics.chordColumnOverlapRatio) / 0.17);
    // Bracket content is sustained chording that neither jacks nor rolls.
    // Bracket shape alone does not separate on 7 columns (AUC 0.52), where
    // chords are adjacent-pair shaped mostly by chance.
    const bracketWindowRatio = ratio(stats.bracketWindowRows, rowCount);
    const wideChordstream = Math.max(
      chordstreamGate,
      minGate(pressure(chordRatio, 0.2, 0.62), pressure(metrics.chordSizeChangeRate, 0.18, 0.52)),
    );
    const singleJack = getSingleJackStats(orderedRows);
    // Chordjack needs the chord itself to repeat. 7K tech re-hits one finger
    // between chords all the time, which passes the overlap gate. The arms
    // are chords sharing two or more columns, single notes re-hit one row
    // back, and long unbroken chord runs. Any one arm counts.
    const chordRepeatGate = Math.max(
      pressure(ratio(stats.multiOverlapChordPairs, Math.max(1, stats.chordPairs)), 0.16, 0.26),
      pressure(singleJack.jack1Share, 0.16, 0.26),
      pressure(stats.chordRows / Math.max(1, stats.chordRuns), 4, 8),
    );
    const chordjackScore = nonLnPatternGate * chordRepeatGate * Math.max(
      chordjackBase,
      minGate(pressure(chordRatio, 0.34, 0.72), pressure(repeatedChordRatio, 0.04, 0.22)),
    );
    // Delay reads the share of off-grid rows. Density and entropy readings
    // saturate on any hard broken stream. The ramp keeps the tag on 96% of
    // delay-named 7K charts. 1/4 speed streams at 200+ BPM stay out on
    // purpose.
    //
    // Strong chordjack vetoes delay, since a 1/8 chordjack chart is jack.
    const delayChordjackVeto = clamp01((0.8 - chordjackScore) / 0.05);
    const delayScore = nonLnFlowGate * delayChordjackVeto * pressure(metrics.offGridRowShare, 0.2, 0.5);
    // The ramp puts the 0.5 tag line at a jack1Share of 0.18. Tech, stream
    // and delay charts stay at 0.163 or less at p90.
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
  // The LN axis joins the visible patterns only when the chart has any LN
  // signal, so rice charts carry no score-0 LN entry.
  const hasLnSignal = lnPattern != null && (lnPattern.score > 0 || metrics.holdRatio > 0);
  const lnAxisPatterns = lnPattern && hasLnSignal && !visiblePatterns.some((pattern) => pattern.id === "ln")
    ? [...visiblePatterns, lnPattern]
    : visiblePatterns;
  // LN subtypes at 0.2+ are appended past the top-5 cut, since 4K's ten rice
  // candidates would otherwise crowd out a third of its LN General tags.
  // Appended after, so the primary is unaffected.
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
    // Three chords in a row (6K+) that neither jack nor roll. LeoBlack's
    // bracket primitive without its chord size conditions, which reject
    // three-note runs and two-note brackets. Dropping them lifts AUC against
    // random 7K charts from 0.72 to 0.79.
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

// Single-note jack content for the 6K/7K jack tag. The chordjack detector
// counts repeated chords, so it misses minijacks and trills. jack1Share is
// the share of notes re-hit from the previous row within 400ms. It is
// row-relative because an absolute repeat window reads dense 7K stream as
// jack. trillRunShare is the share of notes in two-row alternations of 6+
// rows at 200ms or less.
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
      jack1 += bitCount(mask & masks[last]);
    }
    masks.push(mask);
    times.push(time);
  }
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
      for (let m = i; m < j; m += 1) trillNotes += bitCount(masks[m]);
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

      // An inverse release is the cue to re-press the same column, so the
      // press carries its timing. Every other release is active.
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

  let heldMs = 0;
  for (const hold of holdSpans) heldMs += hold.endTime - hold.time;
  let firstTime = Infinity;
  let lastTime = -Infinity;
  for (const note of notes) {
    if (note.time < firstTime) firstTime = note.time;
    const end = note.isHold ? Math.max(note.time, note.endTime) : note.time;
    if (end > lastTime) lastTime = end;
  }
  const chartSpanMs = lastTime > firstTime ? lastTime - firstTime : 0;
  const heldTimeShare = chartSpanMs > 0 ? clamp01(heldMs / (chartSpanMs * Math.max(1, keyCount))) : 0;

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
    heldTimeShare,
  };
}

// Inverse release gaps are charted as beat fractions, so the cap scales with
// tempo. Floored at 120ms, and capped at 250ms so slow charts do not count
// half-second gaps as inverse.
function inverseGapCapMs(beatLengthMs: number): number {
  if (!Number.isFinite(beatLengthMs) || beatLengthMs <= 0) return 120;
  return Math.min(250, Math.max(120, beatLengthMs * 0.27));
}

function rowColumns(rowNotes: ManiaNote[]): number[] {
  return [...new Set(rowNotes.map((note) => note.column))].sort((a, b) => a - b);
}

/** True for a roll step, where one row sits entirely to one side of the other. */
function isRollBetween(previous: number[], current: number[]): boolean {
  if (!previous.length || !current.length) return false;
  return previous[0] > current[current.length - 1] || previous[previous.length - 1] < current[0];
}

function sharedColumnCount(previous: number[], current: number[]): number {
  let shared = 0;
  for (const column of current) if (previous.includes(column)) shared++;
  return shared;
}

function bitCount(mask: number): number {
  let count = 0;
  while (mask) {
    count += 1;
    mask &= mask - 1;
  }
  return count;
}

function ratio(count: number, total: number): number {
  return total > 0 ? count / total : 0;
}

/** 0 at low, 1 at high, linear between. */
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
