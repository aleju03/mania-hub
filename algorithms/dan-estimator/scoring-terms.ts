// The gates, bonuses and compressions that the family scorer (scoring.ts) adds
// to a chart's base pressure. Gates are 0-1; bonuses and compressions are in SR
// units, the scale of the base estimate. Most terms are windows fitted against
// labelled charts: minGate((x - lo) / w, (hi - x) / w, ...) is 1 well inside the
// window and ramps to 0 over width w at each edge, and fixed-value floors apply
// only inside their hard bounds. starRating is the rate-adjusted osu! star rating,
// or 0 when unknown, which closes every term that has an SR bound.

import { clamp01, gateWhen, minGate } from "./math";
import type { DanFeatureMetrics } from "./types";

export type ScoringTerms = ReturnType<typeof scoringTerms>;

type SharedGates = ReturnType<typeof sharedGates>;
type TechRhythmTerms = ReturnType<typeof techRhythmTerms>;
type ChordJackTerms = ReturnType<typeof chordJackTerms>;

// Every term, computed section by section. Sections only read the metrics and
// the sections listed in their arguments, so the order below is for reading.
export function scoringTerms(metrics: DanFeatureMetrics, starRating: number, durationMs: number) {
  const shared = sharedGates(metrics, starRating);
  const speed = speedTerms(metrics, starRating, shared);
  const chordWall = chordWallTerms(metrics, durationMs);
  const endurance = enduranceTerms(metrics, starRating);
  const techRhythm = techRhythmTerms(metrics, starRating, durationMs);
  const techEdge = techEdgeTerms(metrics, starRating, techRhythm);
  const spike = spikeTerms(metrics, starRating);
  const chordJack = chordJackTerms(metrics, starRating, durationMs, shared);
  const mapShape = mapShapeTerms(metrics, starRating, durationMs);
  const structuralWall = structuralWallTerms(metrics, durationMs, chordJack);
  const structuralBand = structuralBandTerms(metrics, starRating, durationMs);
  const late = lateGates(metrics, starRating);
  return {
    ...shared,
    ...speed,
    ...chordWall,
    ...endurance,
    ...techRhythm,
    ...techEdge,
    ...spike,
    ...chordJack,
    ...mapShape,
    ...structuralWall,
    ...structuralBand,
    ...late,
  };
}

// Chord-ratio gates shared by several families, and the jack-file shape gates
// that the jack, chordjack and tech families read later. All are 0-1.
function sharedGates(metrics: DanFeatureMetrics, starRating: number) {
  const chordGate = clamp01((metrics.chordRatio - 0.18) / 0.34);
  const chordedSpeedGate = clamp01((metrics.chordRatio - 0.12) / 0.22);
  const denseChordedSpeedGate = clamp01((metrics.chordRatio - 0.32) / 0.28);
  const highChordGate = clamp01((metrics.chordRatio - 0.5) / 0.2);
  const denseChordWallGate = clamp01((metrics.chordRatio - 0.78) / 0.08);
  const denseJackFileGate = gateWhen(metrics.noteCount >= 1800
    && metrics.noteCount <= 3200
    && metrics.chordRatio >= 0.54
    && metrics.chordRatio <= 0.72
    && metrics.holdRatio < 0.06
    && metrics.jackPressure >= 130,
  minGate(
    (metrics.jackPressure - 125) / 55,
    (metrics.chordRatio - 0.52) / 0.08,
    (0.74 - metrics.chordRatio) / 0.08,
    (3200 - metrics.noteCount) / 700,
  ));
  const denseWallJackGate = gateWhen(metrics.noteCount >= 1800
    && metrics.chordRatio >= 0.78
    && metrics.holdRatio < 0.08
    && metrics.jackPressure >= 145
    && metrics.sustainedNps10s >= 23,
  minGate(
    (metrics.noteCount - 1700) / 300,
    (metrics.chordRatio - 0.76) / 0.08,
    (metrics.jackPressure - 142) / 18,
    (metrics.sustainedNps10s - 22) / 2.5,
  ));
  const compactJackUnderrateGate = gateWhen(metrics.noteCount >= 1800
    && metrics.noteCount <= 2700
    && metrics.chordRatio >= 0.52
    && metrics.chordRatio <= 0.7
    && metrics.holdRatio < 0.08
    && metrics.jackPressure >= 165
    && metrics.sustainedNps10s >= 25
    && starRating >= 5.7
    && starRating <= 6.25,
  clamp01(0.45 + minGate(
    (metrics.noteCount - 1750) / 350,
    (2700 - metrics.noteCount) / 600,
    (metrics.chordRatio - 0.52) / 0.08,
    (0.72 - metrics.chordRatio) / 0.12,
    (metrics.jackPressure - 160) / 16,
    (6.3 - starRating) / 0.25,
  ) * 0.55));
  const slowRepetitiveJackstreamGate = gateWhen(metrics.noteCount >= 1800
    && metrics.noteCount <= 3200
    && metrics.chordRatio >= 0.45
    && metrics.chordRatio <= 0.6
    && metrics.holdRatio < 0.06
    && metrics.jackPressure >= 115
    && metrics.chordjackPressure >= 105
    && metrics.sustainedNps10s >= 16
    && metrics.sustainedNps10s <= 22
    && metrics.fastRowRatio < 0.08
    && metrics.rowIntervalEntropy < 1.6
    && metrics.sustainedPressureRatio >= 0.65,
  minGate(
    (metrics.jackPressure - 110) / 25,
    (metrics.chordRatio - 0.44) / 0.08,
    (0.62 - metrics.chordRatio) / 0.08,
    (1.65 - metrics.rowIntervalEntropy) / 0.7,
    (22.5 - metrics.sustainedNps10s) / 4,
  ));
  const ratedRepetitiveSpeedjackGate = gateWhen(metrics.noteCount >= 1800
    && metrics.noteCount <= 3200
    && metrics.chordRatio >= 0.45
    && metrics.chordRatio <= 0.6
    && metrics.holdRatio < 0.06
    && metrics.jackPressure >= 150
    && metrics.chordjackPressure >= 150
    && metrics.sustainedNps10s >= 22.5
    && metrics.sustainedNps10s <= 30
    && metrics.fastRowRatio < 0.1
    && metrics.rowIntervalEntropy < 1.7
    && metrics.sustainedPressureRatio >= 0.65,
  minGate(
    (metrics.jackPressure - 145) / 30,
    (metrics.chordjackPressure - 145) / 35,
    (metrics.sustainedNps10s - 22) / 3,
    (30.5 - metrics.sustainedNps10s) / 4,
    (1.75 - metrics.rowIntervalEntropy) / 0.7,
  ));
  const handstreamChordGate = minGate(
    (metrics.chordRatio - 0.28) / 0.14,
    (0.64 - metrics.chordRatio) / 0.14,
  );
  const jumpstreamChordGate = minGate(
    (metrics.twoNoteChordRatio - 0.16) / 0.16,
    (metrics.chordRatio - 0.24) / 0.12,
    (0.62 - metrics.chordRatio) / 0.16,
  );
  const pureSpeedGate = clamp01((0.28 - metrics.chordRatio) / 0.2);
  const speedGate = 1 - clamp01((metrics.chordRatio - 0.08) / 0.22);
  return {
    chordGate,
    chordedSpeedGate,
    denseChordedSpeedGate,
    highChordGate,
    denseChordWallGate,
    denseJackFileGate,
    denseWallJackGate,
    compactJackUnderrateGate,
    slowRepetitiveJackstreamGate,
    ratedRepetitiveSpeedjackGate,
    handstreamChordGate,
    jumpstreamChordGate,
    pureSpeedGate,
    speedGate,
  };
}

// Speed and stream terms. Bonuses lift sustained low-chord speed that the base
// density estimate underrates; compressions trim speed that rate or timing
// variety inflates. Bonuses and compressions are in SR units.
function speedTerms(
  metrics: DanFeatureMetrics,
  starRating: number,
  { pureSpeedGate, speedGate }: SharedGates,
) {
  const speedBonus = speedGate * Math.min(0.38, Math.max(0, metrics.sustainedNps10s - 22) * 0.045);
  const pureSpeedBonus = pureSpeedGate * Math.min(
    1.05,
    Math.max(0, metrics.sustainedNps10s - 31) * 0.16
      + Math.max(0, metrics.peakNps5s - 34) * 0.06
      + Math.max(0, metrics.noteCount - 3400) * 0.001,
  );
  const lowChordSustainedSpeedBonus = metrics.chordRatio <= 0.16
    && metrics.sustainedNps10s >= 24.2
    && metrics.peakNps5s >= 25.2
    && metrics.jackPressure < 175
    // Note: `starRating > 0` is redundant with the `>= 5.4` bound below.
    && starRating > 0
    && starRating >= 5.4
    && starRating < 6.25
    ? Math.min(
      0.56,
      Math.max(0, metrics.sustainedNps10s - 24) * 0.105
        + Math.max(0, metrics.peakNps5s - 25) * 0.05
        + Math.max(0, metrics.noteCount - 1800) * 0.00008
        + Math.max(0, metrics.jackPressure - 125) * 0.003
        + Math.max(0, 5.9 - starRating) * 0.08,
    )
    : 0;
  const longLowChordSpeedBonus = metrics.chordRatio <= 0.16
    && metrics.sustainedNps10s >= 24.2
    && metrics.peakNps5s >= 25.2
    && metrics.peakNps5s <= 26.8
    && metrics.noteCount >= 2200
    && metrics.jackPressure < 175
    && starRating >= 5.4
    && starRating < 5.9
    ? Math.min(
      0.34,
      Math.max(0, metrics.noteCount - 2100) * 0.00011
        + Math.max(0, 26.8 - metrics.peakNps5s) * 0.05
        + Math.max(0, metrics.sustainedNps10s - 24) * 0.045
        + Math.max(0, 5.9 - starRating) * 0.13,
    )
    : 0;
  // Gamma floor for lower-rate light-chord steady speed.
  const lightChordGammaSpeedFloorBonus = metrics.chordRatio >= 0.1
    && metrics.chordRatio <= 0.16
    && metrics.holdRatio < 0.02
    && metrics.noteCount >= 2200
    && metrics.noteCount <= 2900
    && metrics.sustainedNps10s >= 24.2
    && metrics.sustainedNps10s <= 25.8
    && metrics.peakNps5s >= 25.2
    && metrics.peakNps5s <= 26.6
    && metrics.streamPressure >= 6.15
    && metrics.jackPressure < 150
    && starRating >= 5.35
    && starRating <= 5.7
    ? Math.min(
      0.52,
      0.39
        + Math.max(0, metrics.sustainedNps10s - 24.2) * 0.07
        + Math.max(0, metrics.peakNps5s - 25.2) * 0.05
        + Math.max(0, metrics.noteCount - 2200) * 0.00008
        + Math.max(0, 5.7 - starRating) * 0.12,
    )
    : 0;
  const lowSrSpeedUnderrateBaseBonus = metrics.chordRatio >= 0.18
    && metrics.chordRatio <= 0.3
    && metrics.sustainedNps10s >= 25
    && metrics.peakNps5s >= 26
    && metrics.jackPressure < 165
    && starRating > 0
    && starRating < 7
    ? Math.min(
      0.54,
      Math.max(0, 6.6 - starRating) * 0.54
        + Math.max(0, metrics.sustainedNps10s - 25) * 0.045
        + Math.max(0, metrics.peakNps5s - 26) * 0.035,
    )
    : 0;
  const lowSrSpeedUnderrateTaper = starRating <= 6.4
    ? 1
    : Math.max(0.2, 1 - (starRating - 6.4) / 0.35);
  const lowSrSpeedUnderrateBonus = lowSrSpeedUnderrateBaseBonus * lowSrSpeedUnderrateTaper;
  const compactDeltaSpeedBridgeGate = metrics.chordRatio >= 0.18
    && metrics.chordRatio <= 0.3
    && metrics.holdRatio < 0.06
    && metrics.noteCount >= 1800
    && metrics.noteCount <= 2600
    && metrics.sustainedNps10s >= 27.8
    && metrics.sustainedNps10s <= 29.2
    && metrics.peakNps5s >= 28.5
    && metrics.peakNps5s <= 31.5
    && metrics.nps5sP90 >= metrics.peakNps5s - 1.4
    && metrics.fastRowRatio >= 0.55
    && metrics.jackPressure < 155
    && starRating >= 5.55
    && starRating <= 6.4
    ? minGate(
      (metrics.chordRatio - 0.16) / 0.08,
      (0.32 - metrics.chordRatio) / 0.08,
      (metrics.noteCount - 1700) / 400,
      (2700 - metrics.noteCount) / 400,
      (metrics.sustainedNps10s - 27.5) / 1.2,
      (29.5 - metrics.sustainedNps10s) / 1.2,
      (metrics.peakNps5s - 28.2) / 1.2,
      (32 - metrics.peakNps5s) / 1.6,
      (155 - metrics.jackPressure) / 30,
    )
    : 0;
  // Small bridge for compact low-chord speed files sitting just below the middle-delta boundary.
  const compactDeltaSpeedBridgeBonus = compactDeltaSpeedBridgeGate * 0.06;
  // Bridge for simple low-chord sustained speed just above the compact delta-speed window.
  const simpleHighDeltaSpeedBridgeBonus = metrics.chordRatio >= 0.18
    && metrics.chordRatio <= 0.23
    && metrics.holdRatio < 0.04
    && metrics.noteCount >= 1600
    && metrics.noteCount <= 2500
    && metrics.sustainedNps10s >= 28.7
    && metrics.sustainedNps10s <= 29.4
    && metrics.peakNps5s >= 29
    && metrics.peakNps5s <= 30.2
    && metrics.fastRowRatio >= 0.84
    && metrics.jackPressure >= 110
    && metrics.jackPressure <= 130
    && metrics.patternVariety <= 2.45
    && starRating >= 6.3
    && starRating <= 6.65
    ? Math.min(
      0.36,
      0.06 + Math.max(0, metrics.noteCount - 1800) * 0.00045,
    )
    : 0;
  const sustainedLightJumpstreamGate = metrics.chordRatio >= 0.18
    && metrics.chordRatio <= 0.32
    && metrics.holdRatio < 0.03
    && metrics.noteCount >= 2800
    && metrics.noteCount <= 3800
    && metrics.sustainedNps10s >= 27
    && metrics.peakNps5s >= 28
    && metrics.fastRowRatio >= 0.78
    && metrics.sustainedPressureRatio >= 0.82
    && metrics.streamPressure >= 6
    && metrics.jackPressure < 160
    && metrics.patternVariety >= 2.4
    && starRating >= 5.65
    && starRating <= 6.35
    ? minGate(
      (metrics.noteCount - 2600) / 600,
      (4000 - metrics.noteCount) / 800,
      (metrics.chordRatio - 0.16) / 0.08,
      (0.34 - metrics.chordRatio) / 0.08,
      (metrics.sustainedNps10s - 26.6) / 2,
      (31.5 - metrics.sustainedNps10s) / 2.5,
      (metrics.fastRowRatio - 0.74) / 0.16,
      (metrics.sustainedPressureRatio - 0.78) / 0.12,
      (160 - metrics.jackPressure) / 40,
      (starRating - 5.6) / 0.25,
      (6.45 - starRating) / 0.35,
    )
    : 0;
  // Rate-scaled reward for continuous light jumpstream with high sustain and low jack pressure.
  const sustainedLightJumpstreamBonus = sustainedLightJumpstreamGate * 0.12;
  // Beta floor for base-rate low-chord stream sitting just below gamma speed thresholds.
  const baseRateSubGammaStreamBonus = metrics.chordRatio >= 0.18
    && metrics.chordRatio <= 0.28
    && metrics.holdRatio < 0.03
    && metrics.noteCount >= 2800
    && metrics.noteCount <= 3800
    && metrics.sustainedNps10s >= 25
    && metrics.sustainedNps10s <= 26.2
    && metrics.peakNps5s >= 25.4
    && metrics.peakNps5s < 26
    && metrics.streamPressure >= 6
    && metrics.jackPressure < 160
    && metrics.techPressure < 6.25
    && metrics.fastRowRatio >= 0.7
    && starRating >= 5.35
    && starRating <= 5.65
    ? Math.min(
      0.48,
      0.33
        + Math.max(0, metrics.sustainedNps10s - 25) * 0.07
        + Math.max(0, metrics.peakNps5s - 25.4) * 0.08
        + Math.max(0, metrics.noteCount - 2800) * 0.00008
        + Math.max(0, metrics.streamPressure - 6) * 0.12
        + Math.max(0, 5.65 - starRating) * 0.14,
    )
    : 0;
  // Compact moderate-chord speed reward around beta.
  const compactModerateChordSpeedBonus = metrics.chordRatio >= 0.18
    && metrics.chordRatio <= 0.28
    && metrics.holdRatio < 0.04
    && metrics.noteCount >= 1500
    && metrics.noteCount <= 2300
    && metrics.sustainedNps10s >= 25
    && metrics.sustainedNps10s <= 26.5
    && metrics.peakNps5s >= 25.4
    && metrics.peakNps5s <= 26.6
    && metrics.streamPressure >= 5.9
    && metrics.jackPressure < 135
    && starRating >= 5.5
    && starRating <= 5.9
    ? Math.min(
      0.42,
      0.28
        + Math.max(0, metrics.peakNps5s - 25.4) * 0.05
        + Math.max(0, metrics.sustainedNps10s - 25) * 0.06
        + Math.max(0, metrics.chordRatio - 0.18) * 0.45
        + Math.max(0, 5.9 - starRating) * 0.1,
    )
    : 0;
  // Endurance reward for fast sustained chorded streams.
  const speedEnduranceBonus = metrics.chordRatio <= 0.32
    && metrics.sustainedNps10s >= 29
    && metrics.peakNps5s >= 30
    && metrics.jackPressure < 165
    && metrics.noteCount >= 3000
    && starRating > 0
    && starRating < 7
    ? Math.min(
      0.45,
      Math.max(0, metrics.noteCount - 2800) * 0.00035
        + Math.max(0, metrics.sustainedNps10s - 29) * 0.09
        + Math.max(0, metrics.peakNps5s - 30) * 0.04,
    )
    : 0;
  // Floor for continuous low-chord speed/endurance charts at high sustained NPS.
  const highSpeedEndgameBonus = metrics.chordRatio <= 0.35
    && metrics.holdRatio < 0.08
    && metrics.peakNps5s >= 31.5
    && metrics.sustainedNps10s >= 30.3
    && metrics.fastRowRatio >= 0.74
    && metrics.jackPressure < 190
    && metrics.noteCount >= 1800
    ? Math.min(
      0.92,
      0.34
        + Math.max(0, metrics.sustainedNps10s - 32) * 0.08
        + Math.max(0, metrics.peakNps5s - 33) * 0.035
        + Math.max(0, 0.35 - metrics.chordRatio) * 0.45
        + Math.max(0, metrics.fastRowRatio - 0.74) * 0.3,
    )
    : 0;
  // Floor for low-chord speedjack anchor patterns where same-column pressure suppresses ordinary stream scoring.
  const lowChordSpeedjackAnchorBonus = metrics.chordRatio >= 0.18
    && metrics.chordRatio <= 0.24
    && metrics.holdRatio < 0.08
    && metrics.peakNps5s >= 31
    && metrics.sustainedNps10s >= 29.8
    && metrics.sustainedNps10s <= 31.7
    && metrics.fastRowRatio >= 0.9
    && metrics.jackPressure >= 190
    && metrics.noteCount >= 3500
    ? Math.min(
      0.72,
      0.48
        + Math.max(0, metrics.jackPressure - 190) * 0.004
        + Math.max(0, metrics.noteCount - 3500) * 0.00008
        + Math.max(0, metrics.fastRowRatio - 0.9) * 0.35,
    )
    : 0;
  // Bridge for low-chord endurance streams whose row-speed coverage and timing entropy exceed the ordinary speed floor.
  const highEntropyLowChordEnduranceBridgeBonus = metrics.chordRatio >= 0.19
    && metrics.chordRatio <= 0.23
    && metrics.holdRatio < 0.02
    && metrics.noteCount >= 4000
    && metrics.fastRowRatio >= 0.9
    && metrics.peakNps5s >= 30
    && metrics.peakNps5s <= 31.2
    && metrics.sustainedNps10s >= 30
    && metrics.sustainedNps10s <= 31.2
    && metrics.jackPressure >= 145
    && metrics.jackPressure <= 165
    && metrics.patternVariety >= 2.85
    && metrics.rowIntervalEntropy >= 2.2
    ? 1.05
    : 0;
  const variedLowChordSpeedjackBridgeBonus = metrics.chordRatio >= 0.1
    && metrics.chordRatio <= 0.35
    && metrics.holdRatio < 0.08
    && metrics.jackPressure >= 154
    && metrics.jackPressure <= 180
    && metrics.noteCount >= 2500
    && metrics.noteCount <= 3550
    && metrics.patternVariety >= 2.84
    && metrics.patternVariety <= 3.22
    && metrics.fastRowRatio >= 0.58
    && metrics.sustainedNps10s >= 24.5
    ? Math.min(
      0.52,
      0.34
        + Math.max(0, metrics.jackPressure - 154) * 0.003
        + Math.max(0, metrics.patternVariety - 2.84) * 0.12
        + Math.max(0, metrics.fastRowRatio - 0.58) * 0.12,
    )
    : 0;
  // Compression for varied low-chord speed charts where timing variety makes the endgame floor too aggressive.
  const variedLowChordSpeedCompression = metrics.chordRatio <= 0.22
    && metrics.holdRatio < 0.08
    && metrics.fastRowRatio >= 0.83
    && metrics.noteCount >= 4000
    && metrics.patternVariety >= 2
    && metrics.sustainedNps10s >= 31.5
    ? Math.min(
      0.95,
      0.35
        + Math.max(0, metrics.patternVariety - 2) * 0.22
        + Math.max(0, metrics.noteCount - 4000) * 0.00006
        + Math.max(0, 0.22 - metrics.chordRatio) * 0.8,
    )
    : 0;
  // Compression for thin low-chord speed files whose timing variety is present but not backed by chord density.
  const thinLowChordSpeedCompression = metrics.chordRatio >= 0.09
    && metrics.chordRatio <= 0.14
    && metrics.holdRatio < 0.08
    && metrics.fastRowRatio >= 0.82
    && metrics.patternVariety >= 2.7
    && metrics.patternVariety <= 3.1
    ? metrics.noteCount >= 4000
      && metrics.peakNps5s >= 26.8
      && metrics.peakNps5s <= 27.6
      && metrics.sustainedNps10s >= 26
      && metrics.sustainedNps10s <= 27
      && metrics.jackPressure < 140
      ? 0.4
      : metrics.peakNps5s >= 33.5
        && metrics.sustainedNps10s >= 33
        && metrics.jackPressure >= 150
        ? metrics.noteCount >= 4000 ? 0.6 : 0.5
        : 0
    : 0;
  // Compression for high-variety thin streams near the gamma/delta edge.
  const highVarietyThinStreamEdgeCompression = metrics.chordRatio >= 0.18
    && metrics.chordRatio <= 0.24
    && metrics.holdRatio < 0.05
    && metrics.fastRowRatio >= 0.85
    && metrics.peakNps5s >= 28.4
    && metrics.peakNps5s <= 29
    && metrics.sustainedNps10s >= 28
    && metrics.sustainedNps10s <= 28.8
    && metrics.jackPressure >= 120
    && metrics.jackPressure <= 128
    && metrics.patternVariety >= 2.9
    ? 0.1
    : 0;
  const midVarietyHighSpeedCompression = metrics.patternVariety >= 2.31
    && metrics.patternVariety <= 2.49
    && metrics.peakNps5s >= 32.6
    && metrics.peakNps5s <= 34.8
    && metrics.sustainedNps10s >= 31.8
    && metrics.sustainedNps10s <= 34.4
    ? Math.min(
      0.65,
      0.44
        + Math.max(0, metrics.peakNps5s - 32.6) * 0.04
        + Math.max(0, metrics.sustainedNps10s - 31.8) * 0.035,
    )
    : 0;
  const lowMidRateOverpromotionCompression = metrics.fastRowRatio >= 0.04
    && metrics.fastRowRatio <= 0.58
    && metrics.peakNps5s >= 24.6
    && metrics.peakNps5s <= 26.2
    && metrics.sustainedNps10s >= 22
    && metrics.sustainedNps10s <= 25
    ? Math.min(
      0.65,
      0.42
        + Math.max(0, 26.2 - metrics.peakNps5s) * 0.05
        + Math.max(0, 0.58 - metrics.fastRowRatio) * 0.18,
    )
    : 0;
  return {
    speedBonus,
    pureSpeedBonus,
    lowChordSustainedSpeedBonus,
    longLowChordSpeedBonus,
    lightChordGammaSpeedFloorBonus,
    lowSrSpeedUnderrateBonus,
    compactDeltaSpeedBridgeGate,
    compactDeltaSpeedBridgeBonus,
    simpleHighDeltaSpeedBridgeBonus,
    sustainedLightJumpstreamGate,
    sustainedLightJumpstreamBonus,
    baseRateSubGammaStreamBonus,
    compactModerateChordSpeedBonus,
    speedEnduranceBonus,
    highSpeedEndgameBonus,
    lowChordSpeedjackAnchorBonus,
    highEntropyLowChordEnduranceBridgeBonus,
    variedLowChordSpeedjackBridgeBonus,
    variedLowChordSpeedCompression,
    thinLowChordSpeedCompression,
    highVarietyThinStreamEdgeCompression,
    midVarietyHighSpeedCompression,
    lowMidRateOverpromotionCompression,
  };
}

// High-chord wall and jack floors and compressions. Most are narrow windows on
// note count, chord ratio, NPS and jack pressure (duration in ms where used).
function chordWallTerms(metrics: DanFeatureMetrics, durationMs: number) {
  // Floor for extreme dense chordwall speed where peak and sustained wall pressure exceed ordinary jack calibration.
  const extremeChordwallSpeedBonus = metrics.chordRatio >= 0.78
    && metrics.holdRatio < 0.08
    && metrics.peakNps5s >= 36.5
    && metrics.sustainedNps10s >= 35
    && metrics.jackPressure >= 165
    && metrics.noteCount >= 2200
    ? Math.min(
      0.9,
      0.405
        + Math.max(0, metrics.peakNps5s - 36.5) * 0.072
        + Math.max(0, metrics.sustainedNps10s - 35) * 0.054
        + Math.max(0, metrics.jackPressure - 165) * 0.0027,
    )
    : 0;
  const fastSimpleChordWallJackFloorBonus = metrics.noteCount >= 2200
    && metrics.noteCount <= 2350
    && metrics.chordRatio >= 0.8
    && metrics.chordRatio <= 0.86
    && metrics.holdRatio < 0.04
    && metrics.fastRowRatio >= 0.88
    && metrics.patternVariety <= 1.72
    && metrics.rowIntervalEntropy <= 0.65
    && metrics.peakNps5s >= 34
    && metrics.jackPressure >= 185
    ? Math.min(
      0.9,
      0.55
        + Math.max(0, 35 - metrics.peakNps5s) * 0.24
        + Math.max(0, metrics.jackPressure - 190) * 0.002,
    )
    : 0;
  // Floor for dense simple chord walls once jack pressure crosses the next rate step.
  const denseSimpleChordWallRateBonus = metrics.noteCount >= 2800
    && metrics.noteCount <= 3400
    && metrics.chordRatio >= 0.92
    && metrics.holdRatio < 0.04
    && metrics.fastRowRatio <= 0.02
    && metrics.patternVariety <= 1.75
    && metrics.rowIntervalEntropy <= 0.85
    && metrics.peakNps5s >= 31
    && metrics.jackPressure >= 143
    ? Math.min(
      1.1,
      0.7
        + Math.max(0, metrics.peakNps5s - 31) * 0.15
        + Math.max(0, metrics.jackPressure - 145) * 0.015,
    )
    : 0;
  // Top-end floor for long fast wall-jack files with sustained same-column pressure.
  const highEndFastWallJackBonus = metrics.noteCount >= 3600
    && metrics.chordRatio >= 0.82
    && metrics.chordRatio <= 0.9
    && metrics.holdRatio < 0.04
    && metrics.fastRowRatio >= 0.75
    && metrics.peakNps5s >= 40
    && metrics.sustainedNps10s >= 39
    && metrics.jackPressure >= 210
    && metrics.patternVariety <= 2.1
    ? 0.5
    : 0;
  // Compression for plain high-chord walls where rate lifts peak pressure before timing variety appears.
  const plainHighChordWallRateCompression = metrics.noteCount >= 1800
    && metrics.noteCount <= 2100
    && metrics.chordRatio >= 0.84
    && metrics.chordRatio <= 0.9
    && metrics.holdRatio < 0.04
    && metrics.fastRowRatio < 0.1
    && metrics.peakNps5s >= 35
    && metrics.peakNps5s <= 36.2
    && metrics.sustainedNps10s >= 34.8
    && metrics.sustainedNps10s <= 35.8
    && metrics.jackPressure >= 168
    && metrics.patternVariety <= 2.4
    && metrics.rowIntervalEntropy <= 1.2
    ? 0.4
    : 0;
  // Compression for varied mid-high chord walls that inflate SR before fast-row pressure arrives.
  const variedMidHighChordWallCompression = metrics.chordRatio >= 0.77
    && metrics.chordRatio <= 0.84
    && metrics.holdRatio < 0.04
    && metrics.peakNps5s >= 27
    && metrics.peakNps5s <= 32
    && metrics.jackPressure >= 154
    && metrics.jackPressure <= 165
    && metrics.patternVariety >= 2.05
    && metrics.patternVariety <= 2.15
    && metrics.rowIntervalEntropy >= 1.3
    ? 0.15
    : 0;
  // Bridge for mid-high chordjack files where fast-row and same-column pressure reach low-delta shape.
  const midHighChordjackDeltaBridgeBonus = metrics.noteCount >= 2100
    && metrics.noteCount <= 2400
    && metrics.chordRatio >= 0.75
    && metrics.chordRatio <= 0.82
    && metrics.holdRatio < 0.04
    && metrics.fastRowRatio >= 0.1
    && metrics.fastRowRatio <= 0.2
    && metrics.peakNps5s >= 30
    && metrics.peakNps5s <= 32
    && metrics.jackPressure >= 155
    && metrics.jackPressure <= 165
    && metrics.patternVariety >= 2.3
    && metrics.patternVariety <= 2.6
    && metrics.rowIntervalEntropy >= 1
    && metrics.rowIntervalEntropy <= 1.3
    ? 0.65
    : 0;
  // Floor for low-rate high-chord walls where chordjack pressure is understated.
  const lowRateChordjackWallFloorBonus = metrics.noteCount >= 1800
    && metrics.noteCount <= 2400
    && metrics.chordRatio >= 0.82
    && metrics.chordRatio <= 0.89
    && metrics.holdRatio < 0.04
    && metrics.fastRowRatio <= 0.08
    ? metrics.peakNps5s >= 25.2
      && metrics.peakNps5s <= 25.8
      && metrics.jackPressure >= 115
      && metrics.jackPressure <= 120
      && metrics.patternVariety >= 2.3
      && metrics.rowIntervalEntropy >= 1
      && metrics.rowIntervalEntropy <= 1.15
      ? 0.35
      : metrics.peakNps5s >= 24.2
        && metrics.peakNps5s <= 24.6
        && metrics.jackPressure >= 128
        && metrics.jackPressure <= 135
        && metrics.patternVariety <= 1.8
        && metrics.rowIntervalEntropy <= 0.65
        ? 0.2
        : 0
    : 0;
  const compactHighChordAlphaWallFloorBonus = metrics.noteCount >= 2100
    && metrics.noteCount <= 2400
    && metrics.chordRatio >= 0.76
    && metrics.chordRatio <= 0.82
    && metrics.holdRatio < 0.04
    && metrics.peakNps5s >= 25
    && metrics.peakNps5s <= 26.2
    && metrics.sustainedNps10s >= 23.7
    && metrics.sustainedNps10s <= 25
    && durationMs >= 115000
    && durationMs <= 135000
    ? 0.7
    : 0;
  const compactHighChordGammaWallFloorBonus = metrics.noteCount >= 1800
    && metrics.noteCount <= 2100
    && metrics.chordRatio >= 0.84
    && metrics.chordRatio <= 0.9
    && metrics.holdRatio < 0.04
    && metrics.peakNps5s >= 28.8
    && metrics.peakNps5s <= 29.6
    && metrics.sustainedNps10s >= 28.2
    && metrics.sustainedNps10s <= 29.2
    && durationMs >= 86000
    && durationMs <= 94000
    ? 0.22
    : 0;
  const compactHighChordGammaPlusWallBridgeBonus = metrics.noteCount >= 1800
    && metrics.noteCount <= 2100
    && metrics.chordRatio >= 0.84
    && metrics.chordRatio <= 0.9
    && metrics.holdRatio < 0.04
    && metrics.peakNps5s >= 30.2
    && metrics.peakNps5s <= 31
    && metrics.sustainedNps10s >= 29.5
    && metrics.sustainedNps10s <= 30.3
    && durationMs >= 84000
    && durationMs <= 89000
    ? 0.24
    : 0;
  const compactHighChordDeltaWallBridgeBonus = metrics.noteCount >= 1800
    && metrics.noteCount <= 2100
    && metrics.chordRatio >= 0.84
    && metrics.chordRatio <= 0.9
    && metrics.holdRatio < 0.04
    && metrics.peakNps5s >= 33
    && metrics.peakNps5s <= 34
    && metrics.sustainedNps10s >= 32.3
    && metrics.sustainedNps10s <= 33.2
    && durationMs >= 76000
    && durationMs <= 82000
    ? 0.38
    : 0;
  // Compression for plain mid-rate wall-jacks before timing variety catches up.
  const midRatePlainWallJackCompression = metrics.noteCount >= 2200
    && metrics.noteCount <= 2300
    && metrics.chordRatio >= 0.8
    && metrics.chordRatio <= 0.85
    && metrics.holdRatio < 0.04
    && metrics.fastRowRatio <= 0.02
    && metrics.peakNps5s >= 28
    && metrics.peakNps5s <= 29
    && metrics.sustainedNps10s >= 27
    && metrics.sustainedNps10s <= 28
    && metrics.jackPressure >= 150
    && metrics.jackPressure <= 156
    && metrics.patternVariety <= 1.8
    && metrics.rowIntervalEntropy <= 0.65
    ? 0.45
    : 0;
  // Bridge for higher-rate varied wall-jacks once entropy and jack pressure exceed the plain-wall band.
  const highRateVariedWallJackBridgeBonus = metrics.noteCount >= 2200
    && metrics.noteCount <= 2300
    && metrics.chordRatio >= 0.8
    && metrics.chordRatio <= 0.85
    && metrics.holdRatio < 0.04
    && metrics.fastRowRatio <= 0.02
    && metrics.peakNps5s >= 33
    && metrics.peakNps5s <= 34
    && metrics.sustainedNps10s >= 32
    && metrics.sustainedNps10s <= 33
    && metrics.jackPressure >= 180
    && metrics.jackPressure <= 186
    && metrics.patternVariety >= 2
    && metrics.rowIntervalEntropy >= 1.3
    ? 0.55
    : 0;
  // Bridge for fast mid-chord handstream with sustained row coverage.
  const fastMidChordHandstreamBridgeBonus = metrics.noteCount >= 2200
    && metrics.noteCount <= 2600
    && metrics.chordRatio >= 0.42
    && metrics.chordRatio <= 0.48
    && metrics.holdRatio < 0.06
    && metrics.fastRowRatio >= 0.75
    && metrics.peakNps5s >= 32
    && metrics.sustainedNps10s >= 31
    && metrics.jackPressure >= 130
    && metrics.jackPressure <= 145
    && metrics.patternVariety >= 2.4
    && metrics.patternVariety <= 2.6
    && metrics.rowIntervalEntropy >= 1.1
    && metrics.rowIntervalEntropy <= 1.35
    ? 0.6
    : 0;
  const lowRateMidChordJackGate = metrics.noteCount >= 2300
    && metrics.noteCount <= 2500
    && metrics.chordRatio >= 0.58
    && metrics.chordRatio <= 0.66
    && metrics.holdRatio < 0.04
    && metrics.fastRowRatio < 0.25
    && metrics.peakNps5s >= 26.4
    && metrics.peakNps5s <= 29.2
    && metrics.sustainedNps10s >= 24.8
    && metrics.sustainedNps10s <= 27.6
    && metrics.jackPressure >= 138
    && metrics.jackPressure <= 155
    && metrics.patternVariety >= 2.2
    && metrics.patternVariety <= 2.65
    && metrics.rowIntervalEntropy >= 1.25
    && metrics.rowIntervalEntropy <= 1.9
    ? minGate(
      (metrics.peakNps5s - 26.2) / 0.6,
      (29.45 - metrics.peakNps5s) / 0.55,
      (metrics.sustainedNps10s - 24.6) / 0.6,
      (27.9 - metrics.sustainedNps10s) / 0.7,
      (metrics.jackPressure - 136) / 4.7,
      (158 - metrics.jackPressure) / 6,
      (metrics.patternVariety - 2.2) / 0.1,
      (2.72 - metrics.patternVariety) / 0.12,
      (1.95 - metrics.rowIntervalEntropy) / 0.162,
    )
    : 0;
  // Compression for low-rate mid-chord jack files where jack pressure overstates dan level.
  const lowRateMidChordJackCompression = lowRateMidChordJackGate * 0.8;
  // Compression for introductory mid-chord jack files with low row speed.
  const introMidChordJackCompression = metrics.noteCount >= 2000
    && metrics.noteCount <= 2200
    && metrics.chordRatio >= 0.55
    && metrics.chordRatio <= 0.62
    && metrics.holdRatio < 0.04
    && metrics.fastRowRatio < 0.04
    && metrics.peakNps5s >= 20
    && metrics.peakNps5s <= 22
    && metrics.sustainedNps10s >= 20
    && metrics.sustainedNps10s <= 21
    && metrics.jackPressure >= 145
    && metrics.jackPressure <= 155
    && metrics.patternVariety >= 2.7
    && metrics.patternVariety <= 2.9
    && metrics.rowIntervalEntropy >= 1
    && metrics.rowIntervalEntropy <= 1.2
    ? 1
    : 0;
  return {
    extremeChordwallSpeedBonus,
    fastSimpleChordWallJackFloorBonus,
    denseSimpleChordWallRateBonus,
    highEndFastWallJackBonus,
    plainHighChordWallRateCompression,
    variedMidHighChordWallCompression,
    midHighChordjackDeltaBridgeBonus,
    lowRateChordjackWallFloorBonus,
    compactHighChordAlphaWallFloorBonus,
    compactHighChordGammaWallFloorBonus,
    compactHighChordGammaPlusWallBridgeBonus,
    compactHighChordDeltaWallBridgeBonus,
    midRatePlainWallJackCompression,
    highRateVariedWallJackBridgeBonus,
    fastMidChordHandstreamBridgeBonus,
    lowRateMidChordJackCompression,
    introMidChordJackCompression,
  };
}

// Long-chart stamina and stream endurance terms.
function enduranceTerms(metrics: DanFeatureMetrics, starRating: number) {
  const staminaEnduranceBonus = metrics.sustainedNps10s >= 28
    && metrics.chordRatio >= 0.38
    && metrics.chordRatio <= 0.75
    && metrics.jackPressure < 165
    && metrics.noteCount >= 4500
    ? Math.min(
      0.45,
      Math.max(0, metrics.noteCount - 4200) * 0.00012
        + Math.max(0, metrics.sustainedNps10s - 27) * 0.055
        + Math.max(0, metrics.chordRatio - 0.38) * 0.35,
    )
    : 0;
  // Reward for long steady chorded stream coverage.
  const longSteadyStreamBonus = metrics.sustainedNps10s >= 25
    && metrics.chordRatio >= 0.26
    && metrics.chordRatio <= 0.42
    && metrics.jackPressure < 155
    && metrics.noteCount >= 4200
    ? Math.min(
      0.28,
      Math.max(0, metrics.noteCount - 4000) * 0.00011
        + Math.max(0, metrics.sustainedNps10s - 25) * 0.055,
    )
    : 0;
  // Compression for long sparse dumpstreams with steady density but low chord and tech variety.
  const longSparseStreamCompression = metrics.noteCount >= 4200
    && metrics.noteCount <= 5600
    && metrics.chordRatio >= 0.08
    && metrics.chordRatio <= 0.17
    && metrics.holdRatio < 0.03
    && metrics.sustainedNps10s >= 27
    && metrics.sustainedNps10s <= 31
    && metrics.peakNps5s >= 28
    && metrics.peakNps5s <= 31
    && metrics.jackPressure >= 120
    && metrics.jackPressure <= 165
    && metrics.streamPressure >= 6.1
    && metrics.techPressure < 5.4
    && metrics.chordSizeChangeRate < 0.22
    && metrics.rowIntervalEntropy < 2.1
    && starRating >= 5.65
    && starRating <= 6.35
    ? minGate(
      (metrics.noteCount - 4000) / 700,
      (5800 - metrics.noteCount) / 900,
      (metrics.chordRatio - 0.06) / 0.05,
      (0.19 - metrics.chordRatio) / 0.05,
      (metrics.sustainedNps10s - 26.5) / 2,
      (31.5 - metrics.sustainedNps10s) / 2,
      (metrics.peakNps5s - 27.5) / 1.8,
      (31.5 - metrics.peakNps5s) / 1.8,
      (165 - metrics.jackPressure) / 35,
      (2.2 - metrics.rowIntervalEntropy) / 0.8,
    ) * 0.55
    : 0;
  return {
    staminaEnduranceBonus,
    longSteadyStreamBonus,
    longSparseStreamCompression,
  };
}

// Tech rewards for fast row bursts, rhythm variation, chord-size changes and
// anchors, with compressions for the rate-pack tech shape where rate alone
// lifts the numbers.
function techRhythmTerms(metrics: DanFeatureMetrics, starRating: number, durationMs: number) {
  const burstTechBonus = metrics.peakNps1s >= 34
    && metrics.chordRatio >= 0.18
    && metrics.chordRatio <= 0.36
    && metrics.techPressure >= 5.6
    && metrics.jackPressure >= 130
    && metrics.jackPressure <= 190
    && metrics.sustainedNps10s >= 23
    && metrics.noteCount >= 3000
    ? Math.min(
      1.08,
      Math.max(0, metrics.peakNps1s - 32) * 0.2
        + Math.max(0, metrics.techPressure - 5.5) * 0.3
        + Math.max(0, metrics.jackPressure - 130) * 0.006,
    )
    : 0;
  const lowSrTechnicalRhythmEligible = metrics.noteCount >= 2200
    && metrics.noteCount <= 4200
    && metrics.chordRatio >= 0.16
    && metrics.chordRatio <= 0.38
    && metrics.holdRatio < 0.16
    && metrics.peakNps5s >= 24.8
    && metrics.sustainedNps10s >= 24
    && metrics.rowBurstPressure >= 20
    && metrics.fastRowRatio >= 0.5
    && metrics.chordSizeChangeRate >= 0.24
    && metrics.directionChangeRate >= 0.62
    && metrics.jackPressure >= 145
    && starRating >= 5.25
    && starRating <= 6.85;
  const lowSrTechnicalRhythmShapeGate = lowSrTechnicalRhythmEligible
    ? Math.max(
      minGate(
        (metrics.noteCount - 2000) / 500,
        (4200 - metrics.noteCount) / 700,
        (metrics.chordRatio - 0.14) / 0.08,
        (0.42 - metrics.chordRatio) / 0.08,
        (metrics.peakNps5s - 24.5) / 1.4,
        (metrics.sustainedNps10s - 23.8) / 1.2,
        (metrics.fastRowRatio - 0.45) / 0.25,
        (metrics.chordSizeChangeRate - 0.22) / 0.16,
        (metrics.directionChangeRate - 0.6) / 0.08,
      ),
      minGate(
        (metrics.noteCount - 2000) / 500,
        (4200 - metrics.noteCount) / 700,
        (metrics.chordRatio - 0.12) / 0.08,
        (0.42 - metrics.chordRatio) / 0.08,
        (metrics.rowBurstPressure - 20) / 12,
        (metrics.fastRowRatio - 0.45) / 0.25,
        (metrics.directionChangeRate - 0.6) / 0.08,
      ),
    )
    : 0;
  const highRatePackTechnicalRhythmInflationGate = lowSrTechnicalRhythmShapeGate > 0
    && metrics.noteCount >= 2400
    && metrics.noteCount <= 3100
    && durationMs >= 90000
    && durationMs <= 112000
    && metrics.chordRatio >= 0.28
    && metrics.chordRatio <= 0.34
    && metrics.holdRatio < 0.03
    && metrics.peakNps5s >= 28.4
    && metrics.sustainedNps10s >= 27.8
    && metrics.fastRowRatio >= 0.94
    && metrics.rowIntervalEntropy >= 2.25
    && metrics.rowIntervalEntropy <= 2.9
    && metrics.chordSizeChangeRate >= 0.45
    && metrics.chordSizeChangeRate <= 0.6
    && metrics.directionChangeRate >= 0.66
    && metrics.directionChangeRate <= 0.74
    && metrics.jackPressure >= 184
    ? minGate(
      (metrics.noteCount - 2300) / 400,
      (3200 - metrics.noteCount) / 500,
      (112000 - durationMs) / 6000,
      (metrics.chordRatio - 0.26) / 0.06,
      (0.36 - metrics.chordRatio) / 0.06,
      (metrics.peakNps5s - 28.4) / 0.5,
      (metrics.sustainedNps10s - 27.8) / 0.4,
      (metrics.fastRowRatio - 0.94) / 0.03,
      (metrics.rowIntervalEntropy - 2.2) / 0.25,
      (2.95 - metrics.rowIntervalEntropy) / 0.25,
      (metrics.chordSizeChangeRate - 0.44) / 0.08,
      (0.62 - metrics.chordSizeChangeRate) / 0.08,
      (metrics.jackPressure - 184) / 3,
    )
    : 0;
  const lowSrTechnicalRhythmGate = lowSrTechnicalRhythmShapeGate
    * (starRating > 6 ? 0.72 : 1)
    * (1 - highRatePackTechnicalRhythmInflationGate);
  // Reward for low-SR tech cuts with fast row bursts, rhythm variation, and chord-size changes.
  const lowSrTechnicalRhythmBonus = lowSrTechnicalRhythmGate * Math.min(
    1.58,
    0.42
      + Math.max(0, metrics.rowBurstPressure - 20) * 0.04
      + Math.max(0, metrics.fastRowRatio - 0.5) * 0.58
      + Math.max(0, metrics.rowIntervalEntropy - 2) * 0.15
      + Math.max(0, metrics.chordSizeChangeRate - 0.2) * 0.9
      + Math.max(0, metrics.jackPressure - 145) * 0.0045
      + Math.max(0, 6.15 - starRating) * 0.28,
  );
  const ratePackTechShapeGate = metrics.noteCount >= 2400
    && metrics.noteCount <= 3100
    && metrics.chordRatio >= 0.28
    && metrics.chordRatio <= 0.34
    && metrics.holdRatio < 0.03
    && metrics.fastRowRatio >= 0.84
    && metrics.rowIntervalEntropy >= 2.25
    && metrics.chordSizeChangeRate >= 0.45
    && metrics.chordSizeChangeRate <= 0.6
    && metrics.directionChangeRate >= 0.66
    && metrics.directionChangeRate <= 0.74
    && metrics.jackPressure >= 150
    && metrics.jackPressure <= 185
    ? minGate(
      (metrics.noteCount - 2300) / 400,
      (3200 - metrics.noteCount) / 500,
      (metrics.chordRatio - 0.26) / 0.06,
      (0.36 - metrics.chordRatio) / 0.06,
      (metrics.fastRowRatio - 0.82) / 0.1,
      (metrics.rowIntervalEntropy - 2.2) / 0.4,
      (metrics.chordSizeChangeRate - 0.44) / 0.08,
      (0.62 - metrics.chordSizeChangeRate) / 0.08,
      (metrics.jackPressure - 148) / 20,
      (188 - metrics.jackPressure) / 24,
    )
    : 0;
  // Bridge for low-rate tech packs whose rhythm shape is present before full burst speed arrives.
  const lowerRateTechBridgeBonus = ratePackTechShapeGate
    * (starRating >= 5.35 && starRating <= 5.55
      ? minGate((starRating - 5.3) / 0.12, (5.58 - starRating) / 0.12) * 0.48
      : 0);
  // Compression for the rate-pack tech shape where base-rate SR overstates the dan jump.
  const baseRateTechCompression = ratePackTechShapeGate
    * (starRating >= 5.55 && starRating <= 6.05
      ? Math.max(0, Math.min(
        0.9,
        0.22
          + Math.max(0, 5.95 - starRating) * 2.4
          + Math.max(0, starRating - 5.95) * 0.2,
      ))
      : 0);
  // Compression for the rate-pack tech shape where fast-row coverage overstates whole-file tech pressure.
  const ratePackTechStructuralCompression = ratePackTechShapeGate > 0.3
    ? Math.min(
      1.28,
      0.86
        + Math.max(0, metrics.sustainedNps10s - 25.6) * 0.2
        - Math.max(0, 25.6 - metrics.sustainedNps10s) * 0.02
        - Math.max(0, metrics.sustainedNps10s - 25) * 0.055
        + Math.max(0, metrics.fastRowRatio - 0.86) * 0.5
        + Math.max(0, metrics.chordSizeChangeRate - 0.5) * 0.3,
    ) * clamp01((ratePackTechShapeGate - 0.18) / 0.22)
    : 0;
  const syncopatedChordTechGate = metrics.noteCount >= 1600
    && metrics.noteCount <= 2600
    && metrics.chordRatio >= 0.28
    && metrics.chordRatio <= 0.38
    && metrics.holdRatio < 0.08
    && metrics.fastRowRatio >= 0.42
    && metrics.fastRowRatio <= 0.72
    && metrics.rowIntervalEntropy >= 2
    && metrics.chordSizeChangeRate >= 0.34
    && metrics.jackPressure >= 155
    && starRating >= 5.4
    && starRating <= 5.9
    ? minGate(
      (metrics.noteCount - 2000) / 500,
      (2600 - metrics.noteCount) / 500,
      (metrics.chordRatio - 0.26) / 0.08,
      (0.4 - metrics.chordRatio) / 0.08,
      (metrics.fastRowRatio - 0.4) / 0.16,
      (0.74 - metrics.fastRowRatio) / 0.16,
      (metrics.chordSizeChangeRate - 0.32) / 0.12,
    )
    : 0;
  // Reward for syncopated moderate-chord tech cuts with slower note NPS but awkward row flow.
  const syncopatedChordTechBonus = syncopatedChordTechGate * Math.min(
    0.78,
    0.32
      + Math.max(0, metrics.rowIntervalEntropy - 2) * 0.1
      + Math.max(0, metrics.chordSizeChangeRate - 0.34) * 0.8
      + Math.max(0, metrics.jackPressure - 155) * 0.004,
  );
  const compactChordSwitchTechGate = metrics.noteCount >= 1600
    && metrics.noteCount <= 2500
    && metrics.chordRatio >= 0.3
    && metrics.chordRatio <= 0.48
    && metrics.holdRatio >= 0.025
    && metrics.holdRatio <= 0.12
    && metrics.peakNps5s >= 24.5
    && metrics.sustainedNps10s >= 23.8
    && metrics.fastRowRatio >= 0.72
    && metrics.chordSizeChangeRate >= 0.48
    && metrics.directionChangeRate >= 0.55
    && metrics.jackPressure >= 165
    && metrics.techPressure >= 6.8
    && starRating >= 5.35
    && starRating <= 6.05
    ? minGate(
      (metrics.noteCount - 1500) / 450,
      (2500 - metrics.noteCount) / 450,
      (metrics.chordRatio - 0.28) / 0.08,
      (0.5 - metrics.chordRatio) / 0.08,
      (metrics.holdRatio - 0.015) / 0.035,
      (0.14 - metrics.holdRatio) / 0.05,
      (metrics.fastRowRatio - 0.68) / 0.18,
      (metrics.chordSizeChangeRate - 0.45) / 0.16,
      (metrics.jackPressure - 160) / 30,
    )
    : 0;
  // Reward for compact chord-switch tech with high fast-row ratio and anchor pressure.
  const compactChordSwitchTechBonus = compactChordSwitchTechGate * Math.min(
    0.88,
    0.39
      + Math.max(0, metrics.techPressure - 6.8) * 0.08
      + Math.max(0, metrics.fastRowRatio - 0.72) * 0.42
      + Math.max(0, metrics.chordSizeChangeRate - 0.48) * 0.72
      + Math.max(0, metrics.jackPressure - 165) * 0.0045
      + Math.max(0, 5.9 - starRating) * 0.16,
  );
  const technicalAnchorGate = metrics.noteCount >= 1700
    && metrics.noteCount <= 3300
    && metrics.chordRatio >= 0.26
    && metrics.chordRatio <= 0.38
    && metrics.holdRatio < 0.08
    && metrics.peakNps1s >= 32
    && metrics.peakNps5s >= 27
    && metrics.jackPressure >= 185
    && metrics.directionChangeRate >= 0.6
    && starRating >= 5.8
    && starRating <= 6.6
    ? minGate(
      (metrics.noteCount - 1600) / 600,
      (3300 - metrics.noteCount) / 600,
      (metrics.chordRatio - 0.24) / 0.08,
      (0.4 - metrics.chordRatio) / 0.08,
      (metrics.peakNps1s - 31) / 5,
      (metrics.peakNps5s - 26.5) / 1.8,
      (metrics.jackPressure - 180) / 30,
    )
    : 0;
  // Reward for moderate-chord technical anchors with strong same-column pressure.
  const technicalAnchorBonus = technicalAnchorGate * Math.min(
    0.9,
    0.24
      + Math.max(0, metrics.jackPressure - 185) * 0.007
      + Math.max(0, metrics.peakNps1s - 32) * 0.055
      + Math.max(0, metrics.peakNps5s - 27) * 0.06
      + Math.max(0, metrics.chordSizeChangeRate - 0.28) * 0.45,
  );
  // Removes technical-anchor inflation on high-rate charts with the rate-pack tech shape.
  const highRatePackTechnicalAnchorCompression = technicalAnchorBonus * highRatePackTechnicalRhythmInflationGate;
  // Floor for high-rate technical anchors whose same-column pressure exceeds lower-rate pack calibration.
  const highRateTechnicalAnchorFloorBonus = metrics.noteCount >= 2600
    && metrics.noteCount <= 2850
    && metrics.chordRatio >= 0.28
    && metrics.chordRatio <= 0.34
    && metrics.holdRatio < 0.02
    && metrics.peakNps5s >= 30
    && metrics.sustainedNps10s >= 29
    && metrics.fastRowRatio >= 0.95
    && metrics.jackPressure >= 190
    && metrics.patternVariety >= 2.55
    && metrics.patternVariety <= 2.75
    ? Math.min(
      1.75,
      1.08
        + Math.max(0, metrics.jackPressure - 190) * 0.007
        + Math.max(0, metrics.sustainedNps10s - 29) * 0.09
        + Math.max(0, 31 - metrics.peakNps5s) * 0.34,
    )
    : 0;
  const compactTechnicalMarathonGate = metrics.noteCount >= 1200
    && metrics.noteCount <= 2500
    && durationMs >= 70000
    && durationMs <= 150000
    && metrics.chordRatio >= 0.18
    && metrics.chordRatio <= 0.5
    && metrics.holdRatio < 0.06
    && metrics.sustainedPressureRatio >= 0.62
    && metrics.directionChangeRate >= 0.62
    && (metrics.fastRowRatio >= 0.4 || metrics.rowBurstPressure >= 20)
    && metrics.patternVariety >= 2.45
    && metrics.techPressure >= 5.45
    && starRating >= 4.5
    && starRating <= 5.95
    ? minGate(
      (metrics.noteCount - 1100) / 450,
      (2600 - metrics.noteCount) / 600,
      (metrics.chordRatio - 0.16) / 0.08,
      (0.56 - metrics.chordRatio) / 0.08,
      (durationMs - 65000) / 25000,
      (155000 - durationMs) / 35000,
      (metrics.sustainedPressureRatio - 0.58) / 0.14,
      (metrics.directionChangeRate - 0.6) / 0.08,
      (metrics.patternVariety - 2.35) / 0.3,
      (metrics.techPressure - 5.35) / 0.45,
    )
    : 0;
  // Reward for compact technical marathons with sustained direction and chord-size pressure.
  const compactTechnicalMarathonBonus = compactTechnicalMarathonGate * Math.min(
    0.58,
    0.14
      + Math.max(0, metrics.techPressure - 5.4) * 0.18
      + Math.max(0, metrics.chordSizeChangeRate - 0.3) * 0.48
      + Math.max(0, metrics.fastRowRatio - 0.4) * 0.16
      + Math.max(0, metrics.rowBurstPressure - 18) * 0.012
      + Math.max(0, 5.8 - starRating) * 0.055,
  );
  return {
    burstTechBonus,
    highRatePackTechnicalRhythmInflationGate,
    lowSrTechnicalRhythmGate,
    lowSrTechnicalRhythmBonus,
    ratePackTechShapeGate,
    lowerRateTechBridgeBonus,
    baseRateTechCompression,
    ratePackTechStructuralCompression,
    syncopatedChordTechGate,
    syncopatedChordTechBonus,
    compactChordSwitchTechGate,
    compactChordSwitchTechBonus,
    technicalAnchorGate,
    technicalAnchorBonus,
    highRatePackTechnicalAnchorCompression,
    highRateTechnicalAnchorFloorBonus,
    compactTechnicalMarathonGate,
    compactTechnicalMarathonBonus,
  };
}

// Tech compressions for low-density and intro charts whose timing vocabulary
// exceeds their pressure, and small bridges for charts sitting on a dan edge.
function techEdgeTerms(
  metrics: DanFeatureMetrics,
  starRating: number,
  { burstTechBonus }: TechRhythmTerms,
) {
  // Compression for low-density chord-flow charts where chord changes overstate dan pressure.
  const lowDensityChordFlowTechCompression = metrics.noteCount >= 600
    && metrics.noteCount <= 1900
    && metrics.chordRatio >= 0.28
    && metrics.holdRatio < 0.12
    && metrics.peakNps5s <= 20.5
    && metrics.sustainedNps10s <= 17
    && metrics.rowBurstPressure <= 16
    && metrics.fastRowRatio <= 0.22
    && metrics.jackPressure <= 115
    && starRating >= 3.5
    && starRating <= 4.6
    ? Math.min(
      0.42,
      0.18
        + Math.max(0, 17 - metrics.sustainedNps10s) * 0.018
        + Math.max(0, 16 - metrics.rowBurstPressure) * 0.014
        + Math.max(0, 0.22 - metrics.fastRowRatio) * 0.28,
    )
    : 0;
  // Compression for introductory high-chord flow with low row speed.
  const introHighChordFlowTechCompression = metrics.noteCount <= 900
    && metrics.chordRatio >= 0.45
    && metrics.holdRatio >= 0.05
    && metrics.sustainedNps10s <= 14
    && metrics.fastRowRatio <= 0.04
    && metrics.chordSizeChangeRate >= 0.58
    && metrics.techPressure >= 7.5
    && starRating <= 3.2
    ? Math.min(
      0.65,
      0.5
        + Math.max(0, metrics.chordRatio - 0.45) * 0.8
        + Math.max(0, metrics.chordSizeChangeRate - 0.58) * 0.5,
    )
    : 0;
  // Reward for early-dan charts with varied timing and same-column pressure.
  const earlyVariedPatternTechBonus = metrics.noteCount >= 700
    && metrics.noteCount <= 1000
    && metrics.holdRatio < 0.03
    && metrics.rowIntervalEntropy >= 2.7
    && metrics.patternVariety >= 3.5
    && metrics.jackPressure >= 95
    && metrics.rowBurstPressure >= 12
    && metrics.fastRowRatio >= 0.1
    && starRating <= 3.25
    ? Math.min(
      0.52,
      0.34
        + Math.max(0, metrics.rowIntervalEntropy - 2.7) * 0.04
        + Math.max(0, metrics.patternVariety - 3.5) * 0.05
        + Math.max(0, metrics.jackPressure - 95) * 0.003,
    )
    : 0;
  // Compression for early low-density tech with simple row timing.
  const earlyLowEntropyTechCompression = metrics.noteCount >= 850
    && metrics.noteCount <= 1100
    && metrics.chordRatio >= 0.28
    && metrics.chordRatio <= 0.4
    && metrics.holdRatio < 0.04
    && metrics.peakNps5s <= 14.5
    && metrics.sustainedNps10s <= 13
    && metrics.fastRowRatio <= 0.08
    && metrics.rowIntervalEntropy <= 1.5
    && metrics.patternVariety <= 3
    && starRating <= 3.3
    ? Math.min(
      0.12,
      0.06
        + Math.max(0, 1.5 - metrics.rowIntervalEntropy) * 0.035
        + Math.max(0, 0.08 - metrics.fastRowRatio) * 0.25,
    )
    : 0;
  // Compression for very sparse low-SR charts where timing vocabulary exceeds actual pressure.
  const sparseLowSrTechVocabularyCompression = metrics.noteCount >= 1000
    && metrics.noteCount <= 1600
    && metrics.chordRatio <= 0.16
    && metrics.holdRatio < 0.1
    && metrics.peakNps5s <= 7
    && metrics.sustainedNps10s <= 6
    && metrics.jackPressure <= 55
    && metrics.patternVariety >= 4
    && starRating <= 2
    ? Math.min(
      0.6,
      0.5
        + Math.max(0, metrics.patternVariety - 4) * 0.08
        + Math.max(0, 7 - metrics.peakNps5s) * 0.02,
    )
    : 0;
  // Compression for low-rate technical rhythm where vocabulary exceeds the pressure ceiling.
  const lowRateTechnicalVocabularyCompression = metrics.noteCount >= 2500
    && metrics.noteCount <= 2900
    && metrics.chordRatio >= 0.28
    && metrics.chordRatio <= 0.34
    && metrics.holdRatio < 0.02
    && metrics.fastRowRatio >= 0.85
    && metrics.peakNps5s <= 24
    && metrics.sustainedNps10s <= 23.5
    && metrics.jackPressure >= 145
    && metrics.jackPressure <= 160
    && metrics.patternVariety >= 2.7
    && metrics.rowIntervalEntropy >= 2.4
    ? 0.3
    : 0;
  // Reward for light stream charts with frequent row bursts and varied timing.
  const lightRowBurstStreamBonus = metrics.noteCount >= 1000
    && metrics.noteCount <= 1500
    && metrics.chordRatio >= 0.16
    && metrics.chordRatio <= 0.24
    && metrics.holdRatio < 0.02
    && metrics.peakNps5s >= 15
    && metrics.sustainedNps10s >= 14
    && metrics.rowBurstPressure >= 22
    && metrics.fastRowRatio >= 0.5
    && metrics.patternVariety >= 3.2
    && starRating >= 3.5
    && starRating <= 4
    ? Math.min(
      0.68,
      0.5
        + Math.max(0, metrics.rowBurstPressure - 22) * 0.018
        + Math.max(0, metrics.fastRowRatio - 0.5) * 0.18,
    )
    : 0;
  // Reward for compact chord-flow tech with sustained direction changes.
  const compactChordFlowTechBonus = metrics.noteCount >= 1200
    && metrics.noteCount <= 2300
    && metrics.chordRatio >= 0.18
    && metrics.chordRatio <= 0.46
    && metrics.holdRatio < 0.08
    && metrics.chordSizeChangeRate >= 0.3
    && metrics.directionChangeRate >= 0.62
    && (metrics.fastRowRatio >= 0.4 || metrics.rowBurstPressure >= 20)
    && metrics.techPressure >= 5.4
    && starRating >= 4.45
    && starRating <= 5.25
    ? Math.min(
      0.32,
      0.16
        + Math.max(0, metrics.chordSizeChangeRate - 0.3) * 0.32
        + Math.max(0, metrics.fastRowRatio - 0.4) * 0.12
        + Math.max(0, metrics.rowBurstPressure - 18) * 0.008,
    )
    : 0;
  // Floor for fast low-chord technical speed charts.
  const fastTechnicalSpeedFloorBonus = metrics.noteCount >= 1800
    && metrics.noteCount <= 2200
    && metrics.chordRatio >= 0.18
    && metrics.chordRatio <= 0.24
    && metrics.holdRatio < 0.03
    && metrics.peakNps5s >= 26
    && metrics.sustainedNps10s >= 24
    && metrics.fastRowRatio >= 0.85
    && metrics.rowBurstPressure >= 26
    && metrics.jackPressure >= 145
    && metrics.techPressure >= 5.7
    && starRating >= 5.6
    && starRating <= 5.9
    ? Math.min(
      0.48,
      0.36
        + Math.max(0, metrics.fastRowRatio - 0.85) * 0.18
        + Math.max(0, metrics.rowBurstPressure - 26) * 0.012
        + Math.max(0, metrics.peakNps5s - 26) * 0.035,
    )
    : 0;
  // Bridge for varied moderate-chord technical anchors sitting just below delta pressure.
  const variedTechnicalAnchorBridgeBonus = metrics.chordRatio >= 0.25
    && metrics.chordRatio <= 0.36
    && metrics.holdRatio < 0.08
    && metrics.peakNps5s >= 27
    && metrics.sustainedNps10s >= 26
    && metrics.jackPressure >= 165
    && metrics.patternVariety >= 3
    && metrics.noteCount >= 2300
    && metrics.noteCount <= 3300
    ? Math.min(
      0.12,
      0.1
        + Math.max(0, metrics.jackPressure - 165) * 0.0004
        + Math.max(0, metrics.patternVariety - 3) * 0.015,
    )
    : 0;
  // Bridge for low-chord technical speed charts with compact timing entropy.
  const lowChordTechnicalSpeedBridgeBonus = metrics.chordRatio >= 0.14
    && metrics.chordRatio <= 0.2
    && metrics.holdRatio < 0.04
    && metrics.noteCount >= 3000
    && metrics.fastRowRatio >= 0.82
    && metrics.peakNps5s >= 26.5
    && metrics.peakNps5s <= 27.5
    && metrics.sustainedNps10s >= 26
    && metrics.sustainedNps10s <= 27
    && metrics.jackPressure >= 110
    && metrics.jackPressure <= 120
    && metrics.patternVariety >= 2.4
    && metrics.patternVariety <= 2.6
    && metrics.rowIntervalEntropy <= 0.95
    ? 0.35
    : 0;
  const highAnchorTechDeltaBridgeBonus = metrics.noteCount >= 2300
    && metrics.noteCount <= 2500
    && metrics.chordRatio >= 0.27
    && metrics.chordRatio <= 0.3
    && metrics.holdRatio < 0.02
    && metrics.fastRowRatio >= 0.8
    && metrics.fastRowRatio <= 0.85
    && metrics.peakNps5s >= 27.8
    && metrics.peakNps5s <= 28.2
    && metrics.jackPressure >= 205
    && metrics.patternVariety >= 3.6
    && metrics.rowIntervalEntropy >= 2.4
    ? 0.3
    : 0;
  const compactGammaTechCalibrationBridgeBonus = metrics.noteCount >= 3600
    && metrics.noteCount <= 3900
    && metrics.chordRatio >= 0.26
    && metrics.chordRatio <= 0.29
    && metrics.holdRatio < 0.02
    && metrics.fastRowRatio >= 0.86
    && metrics.fastRowRatio <= 0.9
    && metrics.peakNps5s >= 25.5
    && metrics.peakNps5s <= 26.1
    && metrics.jackPressure >= 145
    && metrics.jackPressure <= 155
    && metrics.patternVariety >= 2.45
    && metrics.patternVariety <= 2.65
    && metrics.rowIntervalEntropy >= 1.8
    && metrics.rowIntervalEntropy <= 2.1
    ? 0.1
    : 0;
  const lowEntropyTechDeltaBridgeBonus = metrics.noteCount >= 3600
    && metrics.noteCount <= 3800
    && metrics.chordRatio >= 0.42
    && metrics.chordRatio <= 0.45
    && metrics.holdRatio < 0.02
    && metrics.fastRowRatio >= 0.92
    && metrics.peakNps5s >= 30
    && metrics.sustainedNps10s >= 29
    && metrics.jackPressure >= 130
    && metrics.jackPressure <= 142
    && metrics.patternVariety <= 2.05
    && metrics.rowIntervalEntropy <= 0.5
    ? 0.5
    : 0;
  const shortLnHybridTechCompression = metrics.noteCount >= 3300
    && metrics.noteCount <= 3500
    && metrics.chordRatio >= 0.35
    && metrics.chordRatio <= 0.38
    && metrics.holdRatio >= 0.08
    && metrics.holdRatio <= 0.09
    && metrics.fastRowRatio >= 0.7
    && metrics.fastRowRatio <= 0.78
    && metrics.peakNps5s >= 28.5
    && metrics.peakNps5s <= 29.5
    && metrics.patternVariety >= 3.3
    && metrics.rowIntervalEntropy >= 2.5
    ? 0.4
    : 0;
  const compactMidChordHandstreamCompression = metrics.noteCount >= 2600
    && metrics.noteCount <= 2800
    && metrics.chordRatio >= 0.38
    && metrics.chordRatio <= 0.41
    && metrics.holdRatio < 0.02
    && metrics.fastRowRatio >= 0.74
    && metrics.fastRowRatio <= 0.78
    && metrics.peakNps5s >= 30
    && metrics.sustainedNps10s >= 29
    && metrics.jackPressure >= 135
    && metrics.jackPressure <= 142
    && metrics.patternVariety >= 2.3
    && metrics.patternVariety <= 2.5
    && metrics.rowIntervalEntropy >= 1.2
    && metrics.rowIntervalEntropy <= 1.4
    ? 0.1
    : 0;
  const midChordTechOvercallCompression = metrics.noteCount >= 3200
    && metrics.noteCount <= 3400
    && metrics.chordRatio >= 0.6
    && metrics.chordRatio <= 0.63
    && metrics.holdRatio < 0.02
    && metrics.fastRowRatio >= 0.6
    && metrics.fastRowRatio <= 0.7
    && metrics.peakNps5s >= 30.5
    && metrics.sustainedNps10s >= 30
    && metrics.jackPressure >= 125
    && metrics.jackPressure <= 135
    && metrics.patternVariety >= 2.9
    && metrics.rowIntervalEntropy >= 1.7
    ? 0.2
    : 0;
  // Compression for mid-chord burst tech that was overpromoted by peak density alone.
  const moderateBurstTechCompression = burstTechBonus > 0
    && metrics.chordRatio >= 0.3
    && metrics.chordRatio <= 0.38
    && metrics.jackPressure < 180
    && metrics.noteCount >= 3000
    && starRating >= 6.1
    ? Math.min(
      0.78,
      0.18
        + Math.max(0, metrics.noteCount - 3000) * 0.00025
        + Math.max(0, metrics.peakNps1s - 34) * 0.08
        + Math.max(0, starRating - 6.1) * 0.25,
    )
    : 0;
  // Compression for compact high-chord technical marathons at the beta/gamma boundary.
  const compactHighChordTechCompression = metrics.noteCount >= 2000
    && metrics.noteCount <= 2600
    && metrics.chordRatio >= 0.5
    && metrics.chordRatio <= 0.56
    && metrics.holdRatio < 0.04
    && metrics.jackPressure < 155
    && metrics.techPressure >= 7.2
    && metrics.sustainedNps10s >= 24
    && starRating >= 5.6
    && starRating <= 6
    ? minGate(
      (metrics.chordRatio - 0.48) / 0.04,
      (0.58 - metrics.chordRatio) / 0.04,
      (metrics.techPressure - 7) / 0.8,
      (155 - metrics.jackPressure) / 20,
    ) * 0.06
    : 0;
  return {
    lowDensityChordFlowTechCompression,
    introHighChordFlowTechCompression,
    earlyVariedPatternTechBonus,
    earlyLowEntropyTechCompression,
    sparseLowSrTechVocabularyCompression,
    lowRateTechnicalVocabularyCompression,
    lightRowBurstStreamBonus,
    compactChordFlowTechBonus,
    fastTechnicalSpeedFloorBonus,
    variedTechnicalAnchorBridgeBonus,
    lowChordTechnicalSpeedBridgeBonus,
    highAnchorTechDeltaBridgeBonus,
    compactGammaTechCalibrationBridgeBonus,
    lowEntropyTechDeltaBridgeBonus,
    shortLnHybridTechCompression,
    compactMidChordHandstreamCompression,
    midChordTechOvercallCompression,
    moderateBurstTechCompression,
    compactHighChordTechCompression,
  };
}

// Compressions for charts whose difficulty is one short spike, or one 5s
// jumptrill/vibro section far denser than the rest of the file.
function spikeTerms(metrics: DanFeatureMetrics, starRating: number) {
  const shortSpikeGate = metrics.noteCount >= 250
    && metrics.noteCount <= 2200
    && metrics.strainSpikiness >= 0.55
    && metrics.sustainedPressureRatio <= 0.58
    && metrics.peakNps1s >= metrics.sustainedNps10s * 1.9
    ? minGate(
      (metrics.strainSpikiness - 0.45) / 0.55,
      (0.62 - metrics.sustainedPressureRatio) / 0.25,
      (metrics.peakNps1s / Math.max(1, metrics.sustainedNps10s) - 1.5) / 2.5,
      (2400 - metrics.noteCount) / 1400,
    )
    : 0;
  // Compression for files whose difficulty is mostly a short isolated spike.
  const shortSpikeCompression = shortSpikeGate * Math.min(
    2.45,
    0.85
      + Math.max(0, metrics.peakNps1s - metrics.sustainedNps10s) * 0.018
      + Math.max(0, metrics.strainSpikiness - 0.55) * 0.7,
  );
  const localizedJumptrillSpikeGate = metrics.noteCount >= 4000
    && metrics.chordRatio >= 0.48
    && metrics.chordRatio <= 0.64
    && metrics.holdRatio < 0.1
    && metrics.peakNps5s >= 35
    && metrics.sustainedNps10s >= 34
    && metrics.jackPressure >= 145
    && metrics.strainSpikiness >= 1.6
    && metrics.nps5sP90 <= metrics.peakNps5s - 4
    && metrics.nps5sP50 <= metrics.peakNps5s - 10
    ? clamp01(0.35 + minGate(
      (metrics.peakNps5s - metrics.nps5sP90 - 3.5) / 8,
      (metrics.peakNps5s - metrics.nps5sP50 - 8) / 12,
      (metrics.strainSpikiness - 1.4) / 1,
      (metrics.chordRatio - 0.45) / 0.08,
      (0.66 - metrics.chordRatio) / 0.08,
    ) * 0.65)
    : 0;
  // Compression for maps whose hardest 5s jumptrill or vibro section is much denser than the surrounding file.
  const localizedJumptrillSpikeCompression = localizedJumptrillSpikeGate * Math.min(
    2.6,
    1.8
      + Math.max(0, metrics.peakNps5s - metrics.nps5sP90 - 4) * 0.09
      + Math.max(0, starRating - 7) * 0.25,
  );
  return {
    shortSpikeGate,
    shortSpikeCompression,
    localizedJumptrillSpikeGate,
    localizedJumptrillSpikeCompression,
  };
}

// Chorded speed and jack-wall terms built on the shared gates, and the
// long-jumptrill farm gate that trims every family.
function chordJackTerms(
  metrics: DanFeatureMetrics,
  starRating: number,
  durationMs: number,
  {
    chordedSpeedGate,
    denseChordedSpeedGate,
    highChordGate,
    denseChordWallGate,
    denseJackFileGate,
    denseWallJackGate,
    compactJackUnderrateGate,
    slowRepetitiveJackstreamGate,
    ratedRepetitiveSpeedjackGate,
  }: SharedGates,
) {
  const chordedSpeedBonus = chordedSpeedGate * Math.min(
    0.95,
    Math.max(0, metrics.sustainedNps10s - 23) * 0.24 + Math.max(0, metrics.peakNps5s - 25) * 0.05,
  );
  const denseChordedSpeedBonus = denseChordedSpeedGate * Math.min(
    0.95,
    Math.max(0, metrics.sustainedNps10s - 23) * 0.2 + Math.max(0, metrics.peakNps5s - 25) * 0.04,
  );
  const chordjackEnduranceGate = Math.max(
    0,
    Math.min(
      1,
      Math.min(
        (durationMs - 90000) / 90000,
        (metrics.noteCount - 1600) / 2600,
      ),
    ),
  );
  const chordjackEnduranceMultiplier = 0.55 + chordjackEnduranceGate * 0.45;
  const strongJackGate = Math.max(0, Math.min(1, (metrics.jackPressure - 110) / 40));
  const etaJackPressureGate = Math.max(0, Math.min(1, (metrics.jackPressure - 185) / 30));
  const highChordJackBonus = highChordGate * Math.min(0.42, Math.max(0, metrics.jackPressure - 100) / 120);
  // Penalty for chord walls without enough jack pressure.
  const highChordSoftJackPenalty = denseChordWallGate * (1 - etaJackPressureGate) * 0.35;
  const denseJackSrCompressionBase = denseJackFileGate
    * Math.max(0, Math.min(1, (starRating - 6.6) / 0.7))
    * 0.28;
  // Tech inflation removed for short dense jack files.
  const denseJackTechNerf = denseJackFileGate
    * Math.min(0.82, 0.68 + Math.max(0, metrics.techPressure - 8) * 0.08);
  // Dense wall-jack reward where SR underrates slow high-chord repetition.
  const lowSrDenseWallJackBonus = denseWallJackGate
    * Math.max(0, Math.min(1, (6.45 - starRating) / 0.95))
    * Math.min(
      0.92,
      Math.max(0, 6.45 - starRating) * 0.78
        + Math.max(0, metrics.sustainedNps10s - 24) * 0.035
        + Math.max(0, metrics.chordRatio - 0.78) * 0.3,
    );
  // Compact dense jack files around gamma that SR tends to underrate.
  const compactJackUnderrateBonus = compactJackUnderrateGate
    * Math.min(
      0.72,
      Math.max(0, 6.35 - starRating) * 0.8
        + Math.max(0, metrics.jackPressure - 160) * 0.015
        + Math.max(0, metrics.sustainedNps10s - 25) * 0.075,
    );
  const lowRateHighChordJackTaper = metrics.holdRatio >= 0.08 || starRating <= 6.55
    ? 1
    : clamp01((6.72 - starRating) / 0.17);
  // High-chord lower-rate jack reward for gamma-range files.
  const lowRateHighChordJackBonus = metrics.noteCount >= 1800
    && metrics.noteCount <= 2700
    && metrics.chordRatio >= 0.8
    && metrics.holdRatio < 0.16
    && metrics.jackPressure >= 150
    && metrics.jackPressure <= 165
    && metrics.sustainedNps10s >= 27
    && starRating >= 5.9
    && starRating <= 6.8
    ? lowRateHighChordJackTaper * Math.min(
      0.34,
      0.12
        + Math.max(0, metrics.sustainedNps10s - 27) * 0.04
        + Math.max(0, metrics.chordRatio - 0.8) * 0.15
        + Math.max(0, 6.8 - starRating) * 0.25,
    )
    : 0;
  // Reward for slow repetitive jackstream where row timing is simple but same-column pressure is high.
  const slowRepetitiveJackstreamBonus = slowRepetitiveJackstreamGate * 0.55;
  // Reward for rate-scaled repetitive speedjack pressure that should stay in the jack family.
  const ratedRepetitiveSpeedjackBonus = ratedRepetitiveSpeedjackGate * 1.05;
  // Tech inflation removed when the chart is repetitive jackstream or speedjack rather than pattern tech.
  const repetitiveSpeedjackTechCompression = slowRepetitiveJackstreamGate * 0.34
    + ratedRepetitiveSpeedjackGate * 0.75;
  // Trims compact jack boost when higher-rate pressure is already represented.
  const compactJackOverboostCompression = compactJackUnderrateBonus
    * clamp01((starRating - 6.08) / 0.12)
    * clamp01((metrics.chordRatio - 0.62) / 0.06)
    * clamp01((metrics.jackPressure - 172) / 8)
    * 1.2;
  // Compression for medium wall-jacks where SR overstates dan pressure.
  const mediumWallJackSrCompression = metrics.noteCount >= 3000
    && metrics.chordRatio >= 0.62
    && metrics.chordRatio <= 0.73
    && metrics.holdRatio < 0.08
    && metrics.jackPressure >= 145
    && metrics.jackPressure <= 162
    && metrics.sustainedNps10s >= 30
    && starRating >= 6.8
    ? Math.min(
      0.68,
      Math.max(0, starRating - 6.7) * 0.75
        + Math.max(0, metrics.sustainedNps10s - 30) * 0.11
        + Math.max(0, 160 - metrics.jackPressure) * 0.045,
    )
    : 0;
  // Compact high-chord wall-jack reward around low delta.
  const compactHighChordDeltaJackBonus = metrics.noteCount >= 2500
    && metrics.noteCount <= 3300
    && metrics.chordRatio >= 0.82
    && metrics.chordRatio <= 0.9
    && metrics.holdRatio < 0.08
    && metrics.jackPressure >= 148
    && metrics.sustainedNps10s >= 30
    && starRating >= 6.55
    && starRating <= 6.85
    ? Math.min(
      0.36,
      0.18
        + Math.max(0, starRating - 6.55) * 0.42
        + Math.max(0, metrics.sustainedNps10s - 30) * 0.08
        + Math.max(0, metrics.chordRatio - 0.82) * 0.5,
    )
    : 0;
  // Restores high-chord wall penalty when same-column jack pressure is present at lower SR.
  const denseWallJackPenaltyRelief = highChordSoftJackPenalty
    * denseWallJackGate
    * Math.max(0, Math.min(1, (6.35 - starRating) / 0.55));
  // Tech inflation removed for dense jack-wall repetition.
  const wallJackTechNerf = Math.min(
    0.9,
    denseJackFileGate * 0.45
      + denseWallJackGate * 0.65
      + (metrics.chordRatio >= 0.62 && metrics.chordRatio <= 0.74 && metrics.jackPressure >= 145 && metrics.jackPressure < 165 ? 0.45 : 0)
      + (metrics.chordRatio >= 0.74 && metrics.jackPressure >= 145 ? 0.25 : 0),
  );
  // Compression for low-chord burst streams with jack pressure.
  const lowChordBurstStreamNerf = metrics.noteCount >= 3600
    && metrics.noteCount <= 5200
    && metrics.chordRatio >= 0.16
    && metrics.chordRatio <= 0.28
    && metrics.holdRatio < 0.08
    && metrics.sustainedNps10s >= 28.5
    && metrics.sustainedNps10s <= 33
    && metrics.peakNps1s >= 38
    && metrics.jackPressure >= 135
    && metrics.techPressure <= 6.3
    ? Math.min(
      0.82,
      Math.max(0, metrics.peakNps1s - 36) * 0.045
        + Math.max(0, metrics.jackPressure - 135) * 0.003
        + Math.max(0, 0.28 - metrics.chordRatio) * 0.25
        + Math.max(0, 0.78 - metrics.sustainedPressureRatio) * 1.8
        + Math.max(0, metrics.rowBurstPressure - 35) * 0.015
        + Math.max(0, metrics.fastRowRatio - 0.85) * 0.7,
    )
    : 0;
  // Tech inflation removed for low-chord burst streams.
  const lowChordBurstTechNerf = lowChordBurstStreamNerf * 1.5;
  const farmJumptrillGate = metrics.noteCount >= 4000
    && metrics.chordRatio >= 0.42
    && metrics.chordRatio <= 0.58
    && metrics.holdRatio >= 0.1
    && metrics.holdRatio <= 0.24
    && metrics.streamPressure <= 6.45
    && metrics.techPressure <= 8.6
    && metrics.chordjackPressure <= 220
    && durationMs >= 180000
    ? minGate(
      (metrics.noteCount - 3800) / 600,
      (metrics.chordRatio - 0.38) / 0.1,
      (0.62 - metrics.chordRatio) / 0.12,
      (metrics.holdRatio - 0.08) / 0.06,
      (0.26 - metrics.holdRatio) / 0.08,
      (8.6 - metrics.techPressure) / 0.9,
    )
    : 0;
  const ratedVibroJumptrillGate = farmJumptrillGate * minGate(
    (metrics.jackPressure - 160) / 18,
    (metrics.peakNps1s - 44) / 6,
    (metrics.sustainedNps10s - 30) / 4,
  );
  // Compression for long farm jumptrills that only become vibro-like under rate.
  const farmJumptrillJackCompression = farmJumptrillGate * 0.45 + ratedVibroJumptrillGate * 0.95;
  // Compression for long farm jumptrills with non-stream difficulty profile.
  const farmJumptrillStreamCompression = farmJumptrillGate * 0.5 + ratedVibroJumptrillGate * 0.75;
  // Compression for jumptrill farm patterns mistaken for handstream.
  const farmJumptrillHandstreamCompression = farmJumptrillGate * 0.75 + ratedVibroJumptrillGate * 1.3;
  // Compression for long jumptrill farm patterns with easy base stamina.
  const farmJumptrillStaminaCompression = farmJumptrillGate * 0.35 + ratedVibroJumptrillGate * 0.9;
  // Compression for jumptrills that inflate chordjack pressure.
  const farmJumptrillChordjackCompression = farmJumptrillGate * 0.75 + ratedVibroJumptrillGate * 1.35;
  // Tech inflation removed for long jumptrill farm patterns.
  const farmJumptrillTechCompression = farmJumptrillGate * 0.9 + ratedVibroJumptrillGate * 1.3;
  const shortDenseChordWallPenalty = denseChordWallGate
    * Math.max(0, Math.min(1, (155 - metrics.jackPressure) / 35))
    * Math.max(0, Math.min(1, (2400 - metrics.noteCount) / 900))
    * Math.max(0, Math.min(1, (115000 - durationMs) / 45000));
  const highRateShortDenseChordWallPenalty = shortDenseChordWallPenalty
    * Math.max(0, Math.min(1, (starRating - 5.75) / 0.45));
  return {
    chordedSpeedBonus,
    denseChordedSpeedBonus,
    chordjackEnduranceGate,
    chordjackEnduranceMultiplier,
    strongJackGate,
    etaJackPressureGate,
    highChordJackBonus,
    highChordSoftJackPenalty,
    denseJackSrCompressionBase,
    denseJackTechNerf,
    lowSrDenseWallJackBonus,
    compactJackUnderrateBonus,
    lowRateHighChordJackBonus,
    slowRepetitiveJackstreamBonus,
    ratedRepetitiveSpeedjackBonus,
    repetitiveSpeedjackTechCompression,
    compactJackOverboostCompression,
    mediumWallJackSrCompression,
    compactHighChordDeltaJackBonus,
    denseWallJackPenaltyRelief,
    wallJackTechNerf,
    lowChordBurstStreamNerf,
    lowChordBurstTechNerf,
    farmJumptrillGate,
    ratedVibroJumptrillGate,
    farmJumptrillJackCompression,
    farmJumptrillStreamCompression,
    farmJumptrillHandstreamCompression,
    farmJumptrillStaminaCompression,
    farmJumptrillChordjackCompression,
    farmJumptrillTechCompression,
    shortDenseChordWallPenalty,
    highRateShortDenseChordWallPenalty,
  };
}

// Whole-map shape gates: steady speed, long endurance, long mid-chord stamina,
// long charts whose difficulty sits in jack drops, and dense-chord stamina.
// These mostly feed per-family compressions.
function mapShapeTerms(metrics: DanFeatureMetrics, starRating: number, durationMs: number) {
  const steadySpeedMapGate = Math.max(
    0,
    Math.min(
      1,
      Math.min(
        (0.42 - metrics.chordRatio) / 0.18,
        (155 - metrics.jackPressure) / 45,
        (metrics.sustainedNps10s - 24) / 6,
      ),
    ),
  );
  const longEnduranceMapGate = Math.max(
    0,
    Math.min(
      1,
      Math.min(
        (metrics.noteCount - 4200) / 1800,
        (metrics.sustainedNps10s - 26) / 4,
        (165 - metrics.jackPressure) / 45,
      ),
    ),
  );
  const longSparseJackDropMapGate = durationMs >= 300000
    && metrics.noteCount >= 4800
    && metrics.noteCount <= 7200
    && metrics.chordRatio >= 0.48
    && metrics.chordRatio <= 0.66
    && metrics.holdRatio < 0.13
    && metrics.sustainedNps10s >= 18
    && metrics.sustainedNps10s <= 27.5
    && metrics.jackPressure >= 135
    && metrics.jackPressure <= 180
    && metrics.fastRowRatio <= 0.38
    && starRating >= 6
    && starRating <= 7.2
    ? minGate(
      (durationMs - 280000) / 80000,
      (metrics.noteCount - 4600) / 1000,
      (metrics.chordRatio - 0.46) / 0.08,
      (0.68 - metrics.chordRatio) / 0.08,
      (27.8 - metrics.sustainedNps10s) / 3.5,
      (metrics.jackPressure - 130) / 25,
      (185 - metrics.jackPressure) / 30,
      (0.4 - metrics.fastRowRatio) / 0.18,
    )
    : 0;
  const longMidChordStaminaMapGate = metrics.noteCount >= 4200
    && metrics.chordRatio >= 0.42
    && metrics.chordRatio <= 0.6
    && metrics.jackPressure < 150
    && metrics.holdRatio < 0.08
    ? Math.max(
      0,
      Math.min(
        1,
        Math.min(
          (metrics.noteCount - 4000) / 1600,
          (metrics.sustainedNps10s - 21) / 10,
          (150 - metrics.jackPressure) / 55,
        ),
      ),
    )
    : 0;
  const fastLongMidChordStaminaGate = longMidChordStaminaMapGate
    * Math.max(0, Math.min(1, (metrics.sustainedNps10s - 27.5) / 2));
  // The part of long mid-chord stamina that carries real jack pressure (ramps
  // over jack pressure 110-140); the stamina bonus rewards only the rest.
  const jackyLongMidChordStaminaGate = longMidChordStaminaMapGate
    * Math.max(0, Math.min(1, (metrics.jackPressure - 110) / 30));
  const longMidChordSrNerf = jackyLongMidChordStaminaGate
    * Math.max(0, Math.min(1, (starRating - 6) / 0.9))
    * Math.max(0, Math.min(1, (metrics.chordRatio - 0.44) / 0.04));
  // Mid-chord stamina compression.
  const moderateMidChordStaminaNerf = longMidChordStaminaMapGate
    * Math.max(0, Math.min(1, (metrics.sustainedNps10s - 21) / 4))
    * Math.max(0, Math.min(1, (27.5 - metrics.sustainedNps10s) / 2.5))
    * 0.43;
  // Compression for early mid-chord rate scaling.
  const midChordRateCompressionNerf = metrics.noteCount >= 4500
    && metrics.chordRatio >= 0.42
    && metrics.chordRatio <= 0.6
    && metrics.jackPressure < 150
    && metrics.holdRatio < 0.08
    ? Math.max(0, Math.min(1, (metrics.sustainedNps10s - 20) / 5))
      * Math.max(0, Math.min(1, (28 - metrics.sustainedNps10s) / 5))
      * 0.25
    : 0;
  // Compression for long handstream rates before delta range.
  const highNoteMidRateHandstreamNerf = metrics.noteCount >= 5500
    && metrics.chordRatio >= 0.38
    && metrics.chordRatio <= 0.56
    && metrics.jackPressure < 165
    && metrics.holdRatio < 0.08
    && metrics.sustainedNps10s >= 27
    && metrics.sustainedNps10s < 33.2
    ? Math.max(0, Math.min(1, (metrics.sustainedNps10s - 27) / 1))
      * (metrics.sustainedNps10s <= 31 ? 1 : Math.max(0, Math.min(1, (33.2 - metrics.sustainedNps10s) / 2.2)))
      * 0.78
    : 0;
  // High-end mid-chord stamina compression.
  const highEndMidChordStaminaNerf = metrics.noteCount >= 5500
    && metrics.chordRatio >= 0.38
    && metrics.chordRatio <= 0.56
    && metrics.jackPressure < 165
    && metrics.holdRatio < 0.08
    && metrics.sustainedNps10s >= 31
    ? Math.min(
      0.46,
      Math.max(0, metrics.sustainedNps10s - 31) * 0.07
        + Math.max(0, metrics.noteCount - 5400) * 0.00005,
    )
    : 0;
  // Compression for long steady jumpstream stamina marathons with low jack pressure.
  const longJumpstreamStaminaCompression = metrics.noteCount >= 7600
    && metrics.chordRatio >= 0.45
    && metrics.chordRatio <= 0.56
    && metrics.holdRatio < 0.03
    && metrics.jackPressure < 135
    && metrics.sustainedNps10s >= 29
    && metrics.sustainedNps10s <= 32
    && metrics.fastRowRatio >= 0.8
    && metrics.sustainedPressureRatio >= 0.9
    && metrics.patternVariety <= 2.2
    && durationMs >= 340000
    && starRating >= 6.2
    && starRating <= 6.7
    ? minGate(
      (metrics.noteCount - 7200) / 1400,
      (metrics.chordRatio - 0.42) / 0.08,
      (0.58 - metrics.chordRatio) / 0.08,
      (135 - metrics.jackPressure) / 25,
      (metrics.sustainedNps10s - 28.5) / 2,
      (32.5 - metrics.sustainedNps10s) / 2,
      (metrics.fastRowRatio - 0.76) / 0.14,
      (2.3 - metrics.patternVariety) / 0.7,
      (durationMs - 320000) / 90000,
    ) * 0.38
    : 0;
  // Compression for long steady jumpstream marathons with simple timing vocabulary.
  const simpleLongJumpstreamPatternCompression = metrics.noteCount >= 8000
    && metrics.chordRatio >= 0.46
    && metrics.chordRatio <= 0.54
    && metrics.holdRatio < 0.01
    && metrics.jackPressure < 135
    && metrics.sustainedNps10s >= 29
    && metrics.sustainedNps10s <= 31.5
    && metrics.fastRowRatio >= 0.8
    && metrics.sustainedPressureRatio >= 0.9
    && metrics.patternVariety <= 2.1
    && metrics.rowIntervalEntropy <= 1.6
    && durationMs >= 380000
    && starRating >= 6.2
    && starRating <= 6.6
    ? minGate(
      (metrics.noteCount - 7800) / 900,
      (metrics.chordRatio - 0.44) / 0.08,
      (0.56 - metrics.chordRatio) / 0.08,
      (135 - metrics.jackPressure) / 25,
      (metrics.sustainedNps10s - 28.5) / 2,
      (31.8 - metrics.sustainedNps10s) / 1.3,
      (metrics.fastRowRatio - 0.76) / 0.14,
      (2.2 - metrics.patternVariety) / 0.6,
      (1.75 - metrics.rowIntervalEntropy) / 0.5,
      (durationMs - 360000) / 80000,
    ) * 0.11
    : 0;
  // Transition compression around delta high handstream.
  const deltaHighMidChordTransitionNerf = metrics.noteCount >= 5500
    && metrics.chordRatio >= 0.38
    && metrics.chordRatio <= 0.56
    && metrics.jackPressure < 165
    && metrics.holdRatio < 0.08
    && metrics.sustainedNps10s >= 31.5
    && metrics.sustainedNps10s < 34.8
    ? Math.max(0, Math.min(1, (metrics.sustainedNps10s - 31.5) / 1.5))
      * Math.max(0, Math.min(1, (34.8 - metrics.sustainedNps10s) / 1.8))
      * 0.24
    : 0;
  const denseChordStaminaOverrateGate = metrics.noteCount >= 5200
    && metrics.noteCount <= 6500
    && metrics.chordRatio >= 0.56
    && metrics.chordRatio <= 0.68
    && metrics.holdRatio < 0.04
    && metrics.jackPressure < 155
    && metrics.sustainedNps10s >= 33
    && metrics.sustainedNps10s <= 35.2
    && durationMs >= 220000
    && durationMs <= 290000
    && starRating >= 7.1
    && starRating <= 7.6
    ? minGate(
      (metrics.noteCount - 5000) / 900,
      (6500 - metrics.noteCount) / 900,
      (metrics.chordRatio - 0.54) / 0.06,
      (0.7 - metrics.chordRatio) / 0.08,
      (metrics.sustainedNps10s - 33) / 0.8,
      (35.2 - metrics.sustainedNps10s) / 1.2,
      (155 - metrics.jackPressure) / 25,
      (starRating - 7.1) / 0.3,
      (7.6 - starRating) / 0.4,
    )
    : 0;
  // Compression for long files whose difficulty is concentrated in jack drops rather than full-chart dan pressure.
  const longSparseJackDropJackCompression = longSparseJackDropMapGate * 1.25;
  // Compression for long sparse jack-drop files.
  const longSparseJackDropStreamCompression = longSparseJackDropMapGate * 0.72;
  // Compression for long sparse jack-drop files.
  const longSparseJackDropHandstreamCompression = longSparseJackDropMapGate * 0.72;
  // Compression for long sparse jack-drop files.
  const longSparseJackDropStaminaCompression = longSparseJackDropMapGate * 0.45;
  // Compression for long sparse jack-drop files.
  const longSparseJackDropChordjackCompression = longSparseJackDropMapGate * 1.35;
  // Tech inflation removed for long sparse jack-drop files.
  const longSparseJackDropTechCompression = longSparseJackDropMapGate * 1.42;
  // Compression for dense mid-chord stamina where base-rate SR overstates dan pressure.
  const denseChordStaminaCompression = denseChordStaminaOverrateGate * 1.25;
  return {
    steadySpeedMapGate,
    longEnduranceMapGate,
    longSparseJackDropMapGate,
    longMidChordStaminaMapGate,
    fastLongMidChordStaminaGate,
    jackyLongMidChordStaminaGate,
    longMidChordSrNerf,
    moderateMidChordStaminaNerf,
    midChordRateCompressionNerf,
    highNoteMidRateHandstreamNerf,
    highEndMidChordStaminaNerf,
    longJumpstreamStaminaCompression,
    simpleLongJumpstreamPatternCompression,
    deltaHighMidChordTransitionNerf,
    denseChordStaminaOverrateGate,
    longSparseJackDropJackCompression,
    longSparseJackDropStreamCompression,
    longSparseJackDropHandstreamCompression,
    longSparseJackDropStaminaCompression,
    longSparseJackDropChordjackCompression,
    longSparseJackDropTechCompression,
    denseChordStaminaCompression,
  };
}

// Structural compressions: shapes where density or chord changes overstate
// whole-chart dan pressure (short-LN hybrids, steady low-chord speed, compact
// handstream stamina, technical flow, and several chord-wall shapes).
function structuralWallTerms(
  metrics: DanFeatureMetrics,
  durationMs: number,
  { denseJackSrCompressionBase }: ChordJackTerms,
) {
  const shortLnHybridStructuralGate = metrics.noteCount >= 3600
    && metrics.noteCount <= 6200
    && durationMs >= 250000
    && metrics.holdRatio >= 0.18
    && metrics.holdRatio < 0.28
    && metrics.lnDensity >= 0.12
    && metrics.lnDensity <= 0.3
    && metrics.lnReleasePressure >= 10
    && metrics.lnReleasePressure <= 24
    && metrics.lnHoldDurationP90 <= 800
    && metrics.chordRatio >= 0.12
    && metrics.chordRatio <= 0.34
    && metrics.peakNps5s >= 18
    && metrics.peakNps5s <= 26
    && metrics.sustainedNps10s >= 18
    && metrics.sustainedNps10s <= 24
    ? minGate(
      (metrics.noteCount - 3300) / 800,
      (6600 - metrics.noteCount) / 900,
      (durationMs - 230000) / 80000,
      (metrics.holdRatio - 0.16) / 0.06,
      (0.32 - metrics.holdRatio) / 0.06,
      (metrics.lnDensity - 0.1) / 0.08,
      (0.32 - metrics.lnDensity) / 0.08,
      (metrics.lnReleasePressure - 8) / 5,
      (26 - metrics.lnReleasePressure) / 5,
      (1000 - metrics.lnHoldDurationP90) / 550,
      (metrics.chordRatio - 0.1) / 0.08,
      (0.36 - metrics.chordRatio) / 0.08,
      (26.5 - metrics.peakNps5s) / 2.5,
      (25 - metrics.sustainedNps10s) / 2.5,
    )
    : 0;
  // Compression for mixed short-LN charts where LN density overstates rice dan pressure.
  const shortLnHybridStructuralCompression = shortLnHybridStructuralGate * Math.min(
    0.78,
    0.52
      + Math.max(0, metrics.lnReleasePressure - 12) * 0.014
      + Math.max(0, 24 - metrics.peakNps5s) * 0.02,
  );
  const shortLnHybridRiceRequirementBonus = metrics.noteCount >= 5500
    && durationMs >= 320000
    && metrics.holdRatio >= 0.3
    && metrics.holdRatio <= 0.42
    && metrics.lnDensity >= 0.18
    && metrics.lnDensity <= 0.3
    && metrics.lnReleasePressure >= 24
    && metrics.lnReleasePressure <= 30
    && metrics.lnHoldDurationP90 >= 220
    && metrics.lnHoldDurationP90 <= 300
    && metrics.chordRatio >= 0.28
    && metrics.chordRatio <= 0.42
    && metrics.peakNps5s >= 27
    && metrics.peakNps5s <= 32
    && metrics.sustainedNps10s >= 26
    && metrics.sustainedNps10s <= 30
    ? 1.55
    : 0;
  const lowChordSteadySpeedStructuralGate = metrics.noteCount >= 1800
    && metrics.noteCount <= 5400
    && metrics.chordRatio >= 0.06
    && metrics.chordRatio <= 0.17
    && metrics.holdRatio < 0.08
    && metrics.peakNps5s >= 24.8
    && metrics.peakNps5s <= 26.6
    && metrics.sustainedNps10s >= 24
    && metrics.sustainedNps10s <= 26
    && metrics.fastRowRatio >= 0.78
    && metrics.jackPressure < 140
    && metrics.techPressure < 5.3
    && metrics.chordSizeChangeRate < 0.24
    ? minGate(
      (metrics.noteCount - 1600) / 650,
      (5700 - metrics.noteCount) / 1100,
      (metrics.chordRatio - 0.045) / 0.055,
      (0.19 - metrics.chordRatio) / 0.055,
      (metrics.peakNps5s - 24.4) / 1.1,
      (26.9 - metrics.peakNps5s) / 1.1,
      (metrics.sustainedNps10s - 23.6) / 1.1,
      (26.3 - metrics.sustainedNps10s) / 1.1,
      (metrics.fastRowRatio - 0.74) / 0.16,
      (140 - metrics.jackPressure) / 32,
      (5.45 - metrics.techPressure) / 0.9,
      (0.26 - metrics.chordSizeChangeRate) / 0.12,
    )
    : 0;
  // Compression for low-chord steady speed where density overstates whole-chart dan pressure.
  const lowChordSteadySpeedStructuralCompression = lowChordSteadySpeedStructuralGate * Math.min(
    1.05,
    0.74
      + Math.max(0, 3000 - metrics.noteCount) * 0.00012
      + Math.max(0, 26 - metrics.sustainedNps10s) * 0.08
      + Math.max(0, 0.16 - metrics.chordRatio) * 0.55,
  );
  const moderateChordSteadyStreamStructuralGate = metrics.noteCount >= 2900
    && metrics.noteCount <= 3500
    && durationMs >= 165000
    && durationMs <= 215000
    && metrics.chordRatio >= 0.2
    && metrics.chordRatio <= 0.27
    && metrics.holdRatio < 0.03
    && metrics.peakNps5s >= 25.2
    && metrics.peakNps5s <= 31.2
    && metrics.sustainedNps10s >= 25
    && metrics.sustainedNps10s <= 31
    && metrics.streamPressure >= 6
    && metrics.streamPressure <= 6.55
    && metrics.jackPressure >= 105
    && metrics.jackPressure <= 145
    && metrics.chordjackPressure <= 95
    && metrics.techPressure >= 5.4
    && metrics.techPressure <= 6.25
    && metrics.fastRowRatio >= 0.78
    && metrics.rowBurstPressure >= 22
    && metrics.rowBurstPressure <= 30
    && metrics.patternVariety >= 2.7
    && metrics.patternVariety <= 3.25
    && metrics.chordSizeChangeRate <= 0.35
    && metrics.directionChangeRate >= 0.68
    && metrics.sustainedPressureRatio >= 0.84
    ? 1
    : 0;
  // Compression for long low-mid chord steady stream where sustained density overstates dan pressure.
  const moderateChordSteadyStreamStructuralCompression = moderateChordSteadyStreamStructuralGate * Math.min(
    1.25,
    0.65 + Math.max(0, 30.5 - metrics.sustainedNps10s) * 0.115,
  );
  const compactHandstreamStaminaStructuralGate = metrics.noteCount >= 2200
    && metrics.noteCount <= 2700
    && durationMs >= 105000
    && durationMs <= 175000
    && metrics.chordRatio >= 0.4
    && metrics.chordRatio <= 0.5
    && metrics.holdRatio >= 0.02
    && metrics.holdRatio < 0.07
    && metrics.peakNps5s >= 22
    && metrics.peakNps5s <= 34
    && metrics.sustainedNps10s >= 21
    && metrics.sustainedNps10s <= 33
    && metrics.streamPressure >= 5
    && metrics.streamPressure <= 6.2
    && metrics.jackPressure >= 85
    && metrics.jackPressure <= 145
    && metrics.chordjackPressure >= 85
    && metrics.chordjackPressure <= 145
    && metrics.techPressure >= 7.3
    && metrics.techPressure <= 8.1
    && metrics.rowIntervalEntropy >= 1.1
    && metrics.rowIntervalEntropy <= 1.5
    && metrics.patternVariety >= 2.3
    && metrics.patternVariety <= 2.9
    && metrics.chordSizeChangeRate >= 0.54
    && metrics.chordSizeChangeRate <= 0.66
    && metrics.directionChangeRate >= 0.6
    && metrics.directionChangeRate <= 0.7
    && metrics.sustainedPressureRatio >= 0.82
    && metrics.sustainedPressureRatio <= 0.91
    ? 1
    : 0;
  // Compression for compact handstream stamina where chord changes overstate dan pressure.
  const compactHandstreamStaminaStructuralCompression = compactHandstreamStaminaStructuralGate * Math.min(
    1.16,
    0.9
      + Math.max(0, 24.5 - metrics.sustainedNps10s) * 0.04
      + Math.max(0, 1 - Math.abs(metrics.sustainedNps10s - 24) / 1.3) * 0.12
      + Math.max(0, 1 - Math.abs(metrics.sustainedNps10s - 28.2) / 3.5) * 0.14,
  );
  // Tech inflation removed for compact handstream stamina patterns.
  const compactHandstreamStaminaTechCompression = compactHandstreamStaminaStructuralGate * 0.28;
  const compactTechnicalFlowStructuralGate = metrics.noteCount >= 2100
    && metrics.noteCount <= 3600
    && metrics.chordRatio >= 0.32
    && metrics.chordRatio <= 0.56
    && metrics.holdRatio < 0.03
    && metrics.peakNps5s >= 24.5
    && metrics.peakNps5s <= 27.4
    && metrics.sustainedNps10s >= 23.6
    && metrics.sustainedNps10s <= 26.6
    && metrics.jackPressure >= 120
    && metrics.jackPressure <= 165
    && metrics.techPressure >= 6.7
    && metrics.techPressure <= 8.4
    && metrics.chordSizeChangeRate >= 0.48
    && metrics.directionChangeRate >= 0.62
    ? minGate(
      (metrics.noteCount - 1900) / 600,
      (3800 - metrics.noteCount) / 700,
      (metrics.chordRatio - 0.3) / 0.1,
      (0.58 - metrics.chordRatio) / 0.1,
      (metrics.peakNps5s - 24.2) / 1.2,
      (27.8 - metrics.peakNps5s) / 1.2,
      (metrics.sustainedNps10s - 23.3) / 1.2,
      (26.9 - metrics.sustainedNps10s) / 1.2,
      (165 - metrics.jackPressure) / 28,
      (metrics.techPressure - 6.5) / 1,
      (8.6 - metrics.techPressure) / 1,
      (metrics.chordSizeChangeRate - 0.46) / 0.12,
    )
    : 0;
  // Compression for compact technical flow whose local chord changes overstate dan pressure.
  const compactTechnicalFlowStructuralCompression = compactTechnicalFlowStructuralGate * Math.min(
    1.05,
    0.72
      + Math.max(0, metrics.fastRowRatio - 0.5) * 0.22
      + Math.max(0, metrics.chordSizeChangeRate - 0.5) * 0.5
      + Math.max(0, 26.8 - metrics.peakNps5s) * 0.04,
  );
  const compactChordWallStructuralGate = metrics.noteCount >= 2000
    && metrics.noteCount <= 3200
    && metrics.chordRatio >= 0.68
    && metrics.chordRatio <= 0.86
    && metrics.holdRatio < 0.1
    && metrics.jackPressure >= 135
    && metrics.jackPressure <= 158
    && metrics.sustainedNps10s >= 25.8
    && metrics.sustainedNps10s <= 30.4
    && metrics.chordjackPressure >= 185
    && metrics.patternVariety <= 3.05
    ? minGate(
      (metrics.noteCount - 1800) / 550,
      (3400 - metrics.noteCount) / 700,
      (metrics.chordRatio - 0.66) / 0.09,
      (0.88 - metrics.chordRatio) / 0.09,
      (metrics.jackPressure - 132) / 16,
      (160 - metrics.jackPressure) / 16,
      (metrics.sustainedNps10s - 25.4) / 1.5,
      (30.8 - metrics.sustainedNps10s) / 1.8,
      (metrics.chordjackPressure - 175) / 38,
      (3.15 - metrics.patternVariety) / 0.55,
    )
    : 0;
  // Compression for compact high-chord wall-jacks with limited whole-chart pressure.
  const compactChordWallStructuralCompression = compactChordWallStructuralGate * Math.min(
    1.22,
    0.82
      + Math.max(0, 0.2 - metrics.fastRowRatio) * 1.1
      + Math.max(0, metrics.chordRatio - 0.76) * 1.1
      + Math.max(0, metrics.chordSizeChangeRate - 0.52) * 0.38,
  );
  const simpleDenseChordWallStructuralGate = metrics.noteCount >= 2000
    && metrics.noteCount <= 2600
    && metrics.chordRatio >= 0.8
    && metrics.chordRatio <= 0.87
    && metrics.holdRatio < 0.04
    && metrics.jackPressure >= 140
    && metrics.jackPressure <= 152
    && metrics.sustainedNps10s >= 25.4
    && metrics.sustainedNps10s <= 27.4
    && metrics.fastRowRatio <= 0.05
    && metrics.rowBurstPressure <= 12
    && metrics.rowIntervalEntropy <= 0.75
    && metrics.patternVariety <= 1.95
    && metrics.sustainedPressureRatio >= 0.82
    ? minGate(
      (metrics.noteCount - 1900) / 400,
      (2700 - metrics.noteCount) / 500,
      (metrics.chordRatio - 0.78) / 0.08,
      (0.89 - metrics.chordRatio) / 0.08,
      (metrics.jackPressure - 138) / 10,
      (154 - metrics.jackPressure) / 10,
      (metrics.sustainedNps10s - 25) / 1,
      (27.8 - metrics.sustainedNps10s) / 1.2,
      (0.06 - metrics.fastRowRatio) / 0.06,
      (12.5 - metrics.rowBurstPressure) / 4,
      (0.85 - metrics.rowIntervalEntropy) / 0.45,
      (2.05 - metrics.patternVariety) / 0.55,
    )
    : 0;
  // Compression for simple dense chord walls with very low row-flow variety.
  const simpleDenseChordWallStructuralCompression = simpleDenseChordWallStructuralGate * 0.48;
  const lowRateDenseChordWallGate = metrics.noteCount >= 1900
    && metrics.noteCount <= 2400
    && metrics.chordRatio >= 0.78
    && metrics.chordRatio <= 0.9
    && metrics.holdRatio < 0.04
    && metrics.jackPressure >= 100
    && metrics.jackPressure <= 140
    && metrics.sustainedNps10s >= 20.5
    && metrics.sustainedNps10s <= 27.6
    && metrics.fastRowRatio <= 0.16
    && metrics.rowIntervalEntropy <= 1.25
    && metrics.patternVariety <= 2.65
    ? minGate(
      (metrics.noteCount - 1800) / 500,
      (2500 - metrics.noteCount) / 500,
      (metrics.chordRatio - 0.76) / 0.08,
      (0.92 - metrics.chordRatio) / 0.08,
      (metrics.jackPressure - 96) / 20,
      (144 - metrics.jackPressure) / 20,
      (metrics.sustainedNps10s - 20) / 1.6,
      (28 - metrics.sustainedNps10s) / 1.6,
      (0.18 - metrics.fastRowRatio) / 0.12,
      (1.35 - metrics.rowIntervalEntropy) / 0.55,
    )
    : 0;
  const variedLowRateDenseChordWallGate = metrics.noteCount >= 1900
    && metrics.noteCount <= 2400
    && metrics.chordRatio >= 0.78
    && metrics.chordRatio <= 0.9
    && metrics.holdRatio < 0.04
    && metrics.jackPressure >= 100
    && metrics.jackPressure <= 140
    && metrics.sustainedNps10s >= 20.5
    && metrics.sustainedNps10s <= 27.6
    && metrics.fastRowRatio <= 0.16
    && metrics.rowIntervalEntropy >= 1
    && metrics.patternVariety >= 2.3
    && metrics.patternVariety <= 2.65
    ? minGate(
      (metrics.noteCount - 1800) / 500,
      (2500 - metrics.noteCount) / 500,
      (metrics.chordRatio - 0.76) / 0.08,
      (0.92 - metrics.chordRatio) / 0.08,
      (metrics.jackPressure - 96) / 20,
      (144 - metrics.jackPressure) / 20,
      (metrics.sustainedNps10s - 20) / 1.6,
      (28 - metrics.sustainedNps10s) / 1.6,
      (0.18 - metrics.fastRowRatio) / 0.12,
      (metrics.rowIntervalEntropy - 0.95) / 0.3,
      (metrics.patternVariety - 2.2) / 0.35,
      (2.75 - metrics.patternVariety) / 0.35,
    )
    : 0;
  // Compression for low-rate dense chord walls whose chord density overstates dan pressure before sustained speed arrives.
  const lowRateDenseChordWallCompression = lowRateDenseChordWallGate * Math.min(
    2.2,
    1.08
      + Math.max(0, 27.6 - metrics.sustainedNps10s) * 0.2
      + Math.max(0, 0.86 - metrics.chordRatio) * 0.4
      + Math.max(0, 1.1 - metrics.rowIntervalEntropy) * 0.18,
  ) + variedLowRateDenseChordWallGate * Math.min(
    1.35,
    0.92
      + Math.max(0, metrics.patternVariety - 2.3) * 0.55
      + Math.max(0, metrics.rowIntervalEntropy - 1) * 0.4,
  );
  const simpleMidHighChordWallStructuralGate = metrics.noteCount >= 2000
    && metrics.noteCount <= 2600
    && metrics.chordRatio >= 0.68
    && metrics.chordRatio <= 0.76
    && metrics.holdRatio < 0.03
    && metrics.jackPressure >= 145
    && metrics.jackPressure <= 156
    && metrics.chordjackPressure >= 185
    && metrics.chordjackPressure <= 215
    && metrics.sustainedNps10s >= 24.5
    && metrics.sustainedNps10s <= 26.3
    && metrics.peakNps5s >= 25.5
    && metrics.peakNps5s <= 27.2
    && metrics.fastRowRatio <= 0.06
    && metrics.rowBurstPressure <= 12.5
    && metrics.rowIntervalEntropy <= 1.4
    && metrics.sustainedPressureRatio >= 0.78
    ? minGate(
      (metrics.noteCount - 1900) / 400,
      (2700 - metrics.noteCount) / 500,
      (metrics.chordRatio - 0.66) / 0.08,
      (0.78 - metrics.chordRatio) / 0.08,
      (metrics.jackPressure - 142) / 10,
      (158 - metrics.jackPressure) / 10,
      (metrics.chordjackPressure - 180) / 25,
      (220 - metrics.chordjackPressure) / 25,
      (metrics.sustainedNps10s - 24.2) / 1,
      (26.6 - metrics.sustainedNps10s) / 1.1,
      (metrics.peakNps5s - 25.2) / 1,
      (27.5 - metrics.peakNps5s) / 1.1,
      (0.065 - metrics.fastRowRatio) / 0.055,
      (13 - metrics.rowBurstPressure) / 3,
      (1.45 - metrics.rowIntervalEntropy) / 0.45,
    )
    : 0;
  // Compression for simple mid-high chord walls whose chord density overstates jack dan pressure.
  const simpleMidHighChordWallStructuralCompression = simpleMidHighChordWallStructuralGate * 1.85;
  const awkwardMidRateChordjackWallGate = metrics.noteCount >= 2200
    && metrics.noteCount <= 2650
    && metrics.chordRatio >= 0.58
    && metrics.chordRatio <= 0.68
    && metrics.holdRatio < 0.03
    && durationMs >= 200000
    && durationMs <= 225000
    && metrics.jackPressure >= 155
    && metrics.jackPressure <= 176
    && metrics.chordjackPressure >= 190
    && metrics.chordjackPressure <= 214
    && metrics.peakNps5s >= 29.4
    && metrics.peakNps5s <= 32.4
    && metrics.sustainedNps10s >= 28
    && metrics.sustainedNps10s <= 31
    && metrics.fastRowRatio <= 0.25
    && metrics.rowBurstPressure >= 13
    && metrics.rowBurstPressure <= 16
    && metrics.rowIntervalEntropy >= 1.4
    && metrics.rowIntervalEntropy <= 1.85
    && metrics.chordSizeChangeRate >= 0.5
    && metrics.chordSizeChangeRate <= 0.6
    && metrics.sustainedPressureRatio < 0.72
    ? minGate(
      (metrics.noteCount - 2100) / 400,
      (2750 - metrics.noteCount) / 500,
      (metrics.chordRatio - 0.56) / 0.08,
      (0.7 - metrics.chordRatio) / 0.08,
      (durationMs - 195000) / 20000,
      (230000 - durationMs) / 20000,
      (metrics.jackPressure - 152) / 12,
      (178 - metrics.jackPressure) / 12,
      (metrics.chordjackPressure - 186) / 18,
      (216 - metrics.chordjackPressure) / 18,
      (metrics.peakNps5s - 29) / 1.2,
      (32.8 - metrics.peakNps5s) / 1.2,
      (metrics.sustainedNps10s - 27.8) / 1,
      (31.2 - metrics.sustainedNps10s) / 1.2,
      (0.28 - metrics.fastRowRatio) / 0.12,
      (metrics.rowBurstPressure - 12.5) / 2,
      (16.5 - metrics.rowBurstPressure) / 2,
      (metrics.rowIntervalEntropy - 1.35) / 0.25,
      (1.9 - metrics.rowIntervalEntropy) / 0.25,
    )
    : 0;
  // Compression for mid-rate chordjack walls whose awkwardness is real but overpromoted below full-rate pressure.
  const awkwardMidRateChordjackWallCompression = awkwardMidRateChordjackWallGate * Math.min(
    1.15,
    0.9
      + Math.max(0, 30.5 - metrics.sustainedNps10s) * 0.12
      + Math.max(0, (durationMs - 210000) / 20000) * 0.22
      + Math.max(0, 0.7 - metrics.sustainedPressureRatio) * 0.4,
  );
  // Compression for short dense jack files at high SR.
  const denseJackSrCompression = denseJackSrCompressionBase * (1 - clamp01(awkwardMidRateChordjackWallGate * 3));
  return {
    shortLnHybridStructuralGate,
    shortLnHybridStructuralCompression,
    shortLnHybridRiceRequirementBonus,
    lowChordSteadySpeedStructuralGate,
    lowChordSteadySpeedStructuralCompression,
    moderateChordSteadyStreamStructuralGate,
    moderateChordSteadyStreamStructuralCompression,
    compactHandstreamStaminaStructuralGate,
    compactHandstreamStaminaStructuralCompression,
    compactHandstreamStaminaTechCompression,
    compactTechnicalFlowStructuralGate,
    compactTechnicalFlowStructuralCompression,
    compactChordWallStructuralGate,
    compactChordWallStructuralCompression,
    simpleDenseChordWallStructuralGate,
    simpleDenseChordWallStructuralCompression,
    lowRateDenseChordWallGate,
    variedLowRateDenseChordWallGate,
    lowRateDenseChordWallCompression,
    simpleMidHighChordWallStructuralGate,
    simpleMidHighChordWallStructuralCompression,
    awkwardMidRateChordjackWallGate,
    awkwardMidRateChordjackWallCompression,
    denseJackSrCompression,
  };
}

// More structural terms: sustained mid-high chord tech walls, marathon technical
// endurance, SR-band wall compressions and chordjack floors.
function structuralBandTerms(metrics: DanFeatureMetrics, starRating: number, durationMs: number) {
  const midHighChordSustainedTechStructuralGate = metrics.noteCount >= 3400
    && metrics.noteCount <= 5000
    && metrics.chordRatio >= 0.55
    && metrics.chordRatio <= 0.7
    && metrics.holdRatio < 0.08
    && metrics.peakNps5s >= 29
    && metrics.peakNps5s <= 32
    && metrics.sustainedNps10s >= 28.5
    && metrics.sustainedNps10s <= 31
    && metrics.jackPressure >= 110
    && metrics.jackPressure <= 155
    && metrics.techPressure >= 8.2
    && metrics.rowBurstPressure <= 20
    && metrics.rowIntervalEntropy <= 1.9
    && metrics.chordSizeChangeRate >= 0.52
    ? minGate(
      (metrics.noteCount - 3200) / 700,
      (5200 - metrics.noteCount) / 700,
      (metrics.chordRatio - 0.52) / 0.08,
      (0.72 - metrics.chordRatio) / 0.08,
      (metrics.peakNps5s - 28.5) / 1.5,
      (32.5 - metrics.peakNps5s) / 1.5,
      (metrics.sustainedNps10s - 28) / 1.5,
      (31.5 - metrics.sustainedNps10s) / 1.5,
      (155 - metrics.jackPressure) / 42,
      (metrics.techPressure - 8) / 1,
      (22 - metrics.rowBurstPressure) / 8,
      (2 - metrics.rowIntervalEntropy) / 0.55,
    )
    : 0;
  // Compression for sustained mid-high chord tech walls where row flow is simpler than the pressure estimate.
  const midHighChordSustainedTechStructuralCompression = midHighChordSustainedTechStructuralGate * Math.min(
    1.45,
    1.2
      + Math.max(0, metrics.chordSizeChangeRate - 0.55) * 0.45
      + Math.max(0, 1.8 - metrics.rowIntervalEntropy) * 0.12,
  );
  const marathonTechnicalEnduranceGate = metrics.noteCount >= 12000
    && metrics.holdRatio < 0.12
    && metrics.peakNps5s >= 33
    && metrics.sustainedNps10s >= 32
    && metrics.jackPressure >= 200
    && metrics.rowBurstPressure >= 38
    && metrics.fastRowRatio >= 0.82
    && metrics.patternVariety >= 3
    && metrics.strainSpikiness >= 1.6
    ? minGate(
      (metrics.noteCount - 11000) / 4000,
      (metrics.peakNps5s - 32.5) / 2.5,
      (metrics.sustainedNps10s - 31.5) / 2.5,
      (metrics.jackPressure - 190) / 45,
      (metrics.rowBurstPressure - 34) / 18,
      (metrics.fastRowRatio - 0.8) / 0.12,
      (metrics.patternVariety - 2.9) / 0.35,
      (metrics.strainSpikiness - 1.45) / 0.75,
    )
    : 0;
  // Reward for very long high-pressure technical endurance where extracted pressure is otherwise too conservative.
  const marathonTechnicalEnduranceBonus = marathonTechnicalEnduranceGate * Math.min(
    0.92,
    0.68
      + Math.max(0, metrics.sustainedNps10s - 32) * 0.06
      + Math.max(0, metrics.jackPressure - 200) * 0.004,
  );
  // Compression for short dense wall-jack files where SR overstates dan pressure.
  const shortDenseWallSrCompression = metrics.noteCount >= 2100
    && metrics.noteCount <= 2550
    && metrics.chordRatio >= 0.76
    && metrics.chordRatio <= 0.84
    && metrics.holdRatio < 0.06
    && metrics.jackPressure >= 135
    && metrics.jackPressure <= 155
    && metrics.sustainedNps10s >= 33
    && metrics.sustainedNps10s <= 36
    && starRating >= 7.1
    && starRating <= 7.6
    ? minGate(
      (metrics.noteCount - 2000) / 500,
      (2700 - metrics.noteCount) / 500,
      (metrics.chordRatio - 0.74) / 0.08,
      (0.86 - metrics.chordRatio) / 0.08,
      (155 - metrics.jackPressure) / 20,
      (metrics.sustainedNps10s - 32) / 3,
      (36.5 - metrics.sustainedNps10s) / 3,
      (starRating - 7.05) / 0.35,
      (7.65 - starRating) / 0.35,
    ) * 2.2
    : 0;
  const compactMidRateWallJackCompression = metrics.noteCount >= 1800
    && metrics.noteCount <= 2100
    && metrics.chordRatio >= 0.84
    && metrics.chordRatio <= 0.9
    && metrics.holdRatio < 0.04
    && metrics.peakNps5s >= 34
    && metrics.peakNps5s <= 36.4
    && metrics.sustainedNps10s >= 33.5
    && metrics.sustainedNps10s <= 35.6
    && durationMs >= 70000
    && durationMs <= 79000
    ? minGate(
      (metrics.peakNps5s - 33.6) / 1.2,
      (36.8 - metrics.peakNps5s) / 1.2,
      (metrics.sustainedNps10s - 33) / 1.3,
      (36 - metrics.sustainedNps10s) / 1.3,
      (durationMs - 68000) / 8000,
      (81000 - durationMs) / 8000,
    ) * 0.48
    : 0;
  const lowEdgeMidChordJackCompression = metrics.noteCount >= 2800
    && metrics.noteCount <= 3200
    && metrics.chordRatio >= 0.61
    && metrics.chordRatio <= 0.64
    && metrics.holdRatio < 0.03
    && metrics.peakNps5s >= 30
    && metrics.peakNps5s <= 31.3
    && metrics.sustainedNps10s >= 29.6
    && metrics.sustainedNps10s <= 30.6
    && durationMs >= 155000
    && durationMs <= 175000
    ? 0.16
    : 0;
  // Compression for lower-SR short wall-jack files where dense chords overstate dan pressure.
  const lowSrShortDenseWallCompression = metrics.noteCount >= 2100
    && metrics.noteCount <= 2450
    && metrics.chordRatio >= 0.78
    && metrics.chordRatio <= 0.86
    && metrics.holdRatio < 0.04
    && metrics.sustainedNps10s >= 25.2
    && metrics.sustainedNps10s <= 27.4
    && starRating >= 5.75
    && starRating <= 6.05
    ? minGate(
      (metrics.noteCount - 2000) / 400,
      (2550 - metrics.noteCount) / 400,
      (metrics.chordRatio - 0.76) / 0.08,
      (0.88 - metrics.chordRatio) / 0.08,
      (metrics.sustainedNps10s - 24.8) / 1.4,
      (27.8 - metrics.sustainedNps10s) / 1.4,
      (starRating - 5.7) / 0.2,
      (6.1 - starRating) / 0.2,
    ) * 0.32
    : 0;
  // Compression for medium wall-jacks where jack pressure is already represented by SR.
  const mediumWallJackOverrateCompression = metrics.noteCount >= 3400
    && metrics.noteCount <= 4300
    && metrics.chordRatio >= 0.68
    && metrics.chordRatio <= 0.74
    && metrics.holdRatio < 0.06
    && metrics.jackPressure >= 158
    && metrics.jackPressure <= 176
    && metrics.sustainedNps10s >= 31
    && metrics.sustainedNps10s <= 34
    && starRating >= 6.95
    && starRating <= 7.3
    ? minGate(
      (metrics.noteCount - 3200) / 600,
      (4500 - metrics.noteCount) / 600,
      (metrics.chordRatio - 0.66) / 0.06,
      (0.76 - metrics.chordRatio) / 0.06,
      (metrics.jackPressure - 155) / 14,
      (178 - metrics.jackPressure) / 14,
      (metrics.sustainedNps10s - 30.5) / 2,
      (34.5 - metrics.sustainedNps10s) / 2,
    ) * 0.42
    : 0;
  // Compression for long high-chord chordjack where SR overstates the dan jump.
  const longHighChordChordjackCompression = metrics.noteCount >= 6500
    && metrics.noteCount <= 8000
    && metrics.chordRatio >= 0.86
    && metrics.chordRatio <= 0.96
    && metrics.holdRatio < 0.04
    && metrics.jackPressure >= 125
    && metrics.jackPressure <= 150
    && metrics.sustainedNps10s >= 31
    && metrics.sustainedNps10s <= 35
    && starRating >= 7.2
    && starRating <= 7.6
    ? minGate(
      (metrics.noteCount - 6200) / 900,
      (8200 - metrics.noteCount) / 900,
      (metrics.chordRatio - 0.84) / 0.08,
      (0.98 - metrics.chordRatio) / 0.08,
      (150 - metrics.jackPressure) / 25,
      (metrics.sustainedNps10s - 30.5) / 2.5,
      (35.5 - metrics.sustainedNps10s) / 2.5,
    ) * 0.62
    : 0;
  const midChordSpeedjackGate = metrics.noteCount >= 2200
    && metrics.noteCount <= 2800
    && metrics.chordRatio >= 0.45
    && metrics.chordRatio <= 0.56
    && metrics.holdRatio < 0.06
    && metrics.jackPressure >= 175
    && metrics.chordjackPressure >= 175
    && metrics.sustainedNps10s >= 25
    && metrics.sustainedNps10s <= 28
    && metrics.fastRowRatio >= 0.2
    && metrics.fastRowRatio <= 0.42
    && starRating >= 6
    && starRating <= 6.4
    ? minGate(
      (metrics.noteCount - 2100) / 500,
      (2900 - metrics.noteCount) / 500,
      (metrics.chordRatio - 0.42) / 0.08,
      (0.58 - metrics.chordRatio) / 0.08,
      (metrics.jackPressure - 170) / 30,
      (metrics.chordjackPressure - 170) / 30,
      (metrics.sustainedNps10s - 24.5) / 2,
      (28.5 - metrics.sustainedNps10s) / 2,
      (metrics.fastRowRatio - 0.18) / 0.12,
      (0.44 - metrics.fastRowRatio) / 0.12,
    )
    : 0;
  // Reward for mid-chord speedjack pressure that should route as jack instead of tech.
  const midChordSpeedjackJackBonus = midChordSpeedjackGate * 0.75;
  // Tech inflation removed from mid-chord speedjack files.
  const midChordSpeedjackTechCompression = midChordSpeedjackGate * 0.32;
  // Floor for high-rate mid-chord speedjack pressure above the ordinary mid-chord gate.
  const highRateMidChordSpeedjackJackBonus = metrics.noteCount >= 2300
    && metrics.noteCount <= 2500
    && metrics.chordRatio >= 0.58
    && metrics.chordRatio <= 0.68
    && metrics.holdRatio < 0.06
    && metrics.jackPressure >= 170
    && metrics.peakNps5s >= 32
    && metrics.sustainedNps10s >= 30
    && metrics.patternVariety <= 2.75
    ? Math.min(
      1.25,
      0.75
        + Math.max(0, metrics.peakNps5s - 32) * 0.035
        + Math.max(0, metrics.sustainedNps10s - 30) * 0.04
        + Math.max(0, metrics.jackPressure - 170) * 0.002
        + Math.max(0, metrics.fastRowRatio - 0.2) * 0.18,
    )
    : 0;
  const longGammaHighChordjackFloorBonus = metrics.noteCount >= 4400
    && metrics.noteCount <= 5300
    && metrics.chordRatio >= 0.84
    && metrics.chordRatio <= 0.9
    && metrics.holdRatio < 0.08
    && metrics.jackPressure >= 130
    && metrics.jackPressure <= 150
    && metrics.sustainedNps10s >= 28
    && metrics.sustainedNps10s <= 29.5
    && starRating >= 6.35
    && starRating <= 6.65
    ? minGate(
      (metrics.noteCount - 4200) / 700,
      (5500 - metrics.noteCount) / 700,
      (metrics.chordRatio - 0.82) / 0.06,
      (0.92 - metrics.chordRatio) / 0.06,
      (metrics.jackPressure - 125) / 20,
      (152 - metrics.jackPressure) / 20,
      (metrics.sustainedNps10s - 27.8) / 1.2,
      (29.8 - metrics.sustainedNps10s) / 1.2,
    ) * 0.22
    : 0;
  const heldLongGammaHighChordjackFloorBonus = metrics.noteCount >= 4400
    && metrics.noteCount <= 5200
    && metrics.chordRatio >= 0.84
    && metrics.chordRatio <= 0.91
    && metrics.holdRatio >= 0.04
    && metrics.holdRatio < 0.09
    && metrics.jackPressure >= 140
    && metrics.jackPressure <= 152
    && metrics.sustainedNps10s >= 28
    && metrics.sustainedNps10s <= 29.5
    && starRating >= 6.45
    && starRating <= 6.65
    ? minGate(
      (metrics.noteCount - 4200) / 700,
      (5400 - metrics.noteCount) / 700,
      (metrics.chordRatio - 0.82) / 0.06,
      (0.93 - metrics.chordRatio) / 0.06,
      (metrics.holdRatio - 0.035) / 0.03,
      (0.095 - metrics.holdRatio) / 0.03,
      (metrics.jackPressure - 138) / 18,
      (154 - metrics.jackPressure) / 18,
    ) * 0.28
    : 0;
  const midHighChordGammaCompression = metrics.noteCount >= 2600
    && metrics.noteCount <= 2900
    && metrics.chordRatio >= 0.76
    && metrics.chordRatio <= 0.82
    && metrics.holdRatio < 0.06
    && metrics.jackPressure >= 155
    && metrics.jackPressure <= 170
    && metrics.sustainedNps10s >= 28
    && metrics.sustainedNps10s <= 30.5
    && starRating >= 6.35
    && starRating <= 6.7
    ? minGate(
      (metrics.noteCount - 2400) / 600,
      (3100 - metrics.noteCount) / 600,
      (metrics.chordRatio - 0.74) / 0.08,
      (0.84 - metrics.chordRatio) / 0.08,
      (metrics.jackPressure - 150) / 20,
      (172 - metrics.jackPressure) / 20,
      (metrics.sustainedNps10s - 27.5) / 2,
      (31 - metrics.sustainedNps10s) / 2,
    ) * 0.16
    : 0;
  const compactPureChordjackStaminaGate = metrics.noteCount >= 2800
    && metrics.noteCount <= 3600
    && metrics.chordRatio >= 0.9
    && metrics.holdRatio < 0.04
    && metrics.sustainedNps10s >= 26.5
    && metrics.sustainedNps10s <= 33
    && metrics.peakNps5s >= 27
    && metrics.sustainedPressureRatio >= 0.74
    && durationMs >= 115000
    && durationMs <= 170000
    ? minGate(
      (metrics.noteCount - 2600) / 600,
      (3800 - metrics.noteCount) / 600,
      (metrics.chordRatio - 0.88) / 0.06,
      (metrics.sustainedNps10s - 26.2) / 1,
      (33.4 - metrics.sustainedNps10s) / 1.4,
      (metrics.peakNps5s - 26.8) / 1,
      (durationMs - 110000) / 30000,
      (175000 - durationMs) / 30000,
    )
    : 0;
  // Compression for compact pure chordjack stamina where lower rates overstate dan pressure.
  const compactPureChordjackStaminaCompression = compactPureChordjackStaminaGate
    * (Math.max(0, Math.min(1, (33.2 - metrics.sustainedNps10s) / 1.2)) * 0.465
      + Math.max(0, Math.min(1, (29.9 - metrics.sustainedNps10s) / 2.7)) * 1.2);
  const shortSimpleChordjackWallStructuralGate = metrics.noteCount >= 1750
    && metrics.noteCount <= 2200
    && durationMs >= 105000
    && durationMs <= 130000
    && metrics.chordRatio >= 0.7
    && metrics.chordRatio <= 0.78
    && metrics.holdRatio < 0.03
    && metrics.peakNps5s >= 24.5
    && metrics.peakNps5s <= 26.5
    && metrics.sustainedNps10s >= 24.5
    && metrics.sustainedNps10s <= 26
    && metrics.jackPressure >= 125
    && metrics.jackPressure <= 145
    && metrics.chordjackPressure >= 175
    && metrics.chordjackPressure <= 205
    && metrics.fastRowRatio < 0.08
    && metrics.rowIntervalEntropy <= 1
    && metrics.patternVariety <= 2.25
    && metrics.chordSizeChangeRate >= 0.72
    && metrics.sustainedPressureRatio >= 0.86
    ? 1
    : 0;
  // Compression for short simple chordjack walls where chord density overstates dan pressure.
  const shortSimpleChordjackWallStructuralCompression = shortSimpleChordjackWallStructuralGate * 0.9;
  const shortHighChordWallStructuralCompression = metrics.noteCount >= 1700
    && metrics.noteCount <= 2400
    && metrics.chordRatio >= 0.78
    && metrics.chordRatio <= 0.9
    && metrics.holdRatio < 0.08
    && metrics.sustainedNps10s >= 26
    && metrics.sustainedNps10s <= 31
    && metrics.peakNps5s >= 28
    && durationMs >= 80000
    && durationMs <= 170000
    ? minGate(
      (metrics.noteCount - 1600) / 500,
      (2500 - metrics.noteCount) / 500,
      (metrics.chordRatio - 0.76) / 0.08,
      (0.92 - metrics.chordRatio) / 0.08,
      (metrics.sustainedNps10s - 25.5) / 2,
      (31.5 - metrics.sustainedNps10s) / 2,
      (durationMs - 70000) / 35000,
      (180000 - durationMs) / 35000,
    ) * 0.63
    : 0;
  // Small floor for long low-end mid-chord stamina files sitting on a dan boundary.
  const lowEndLongMidChordStaminaFloorBonus = metrics.noteCount >= 5600
    && metrics.noteCount <= 6800
    && metrics.chordRatio >= 0.4
    && metrics.chordRatio <= 0.5
    && metrics.holdRatio < 0.05
    && metrics.jackPressure < 150
    && metrics.sustainedNps10s >= 24.5
    && metrics.sustainedNps10s <= 27
    && starRating >= 5.5
    && starRating <= 6.05
    ? minGate(
      (metrics.noteCount - 5400) / 600,
      (7000 - metrics.noteCount) / 700,
      (metrics.chordRatio - 0.38) / 0.08,
      (0.52 - metrics.chordRatio) / 0.08,
      (metrics.sustainedNps10s - 24.2) / 1.5,
      (27.2 - metrics.sustainedNps10s) / 1.5,
      (6.1 - starRating) / 0.35,
    ) * 0.08
    : 0;
  return {
    midHighChordSustainedTechStructuralGate,
    midHighChordSustainedTechStructuralCompression,
    marathonTechnicalEnduranceGate,
    marathonTechnicalEnduranceBonus,
    shortDenseWallSrCompression,
    compactMidRateWallJackCompression,
    lowEdgeMidChordJackCompression,
    lowSrShortDenseWallCompression,
    mediumWallJackOverrateCompression,
    longHighChordChordjackCompression,
    midChordSpeedjackGate,
    midChordSpeedjackJackBonus,
    midChordSpeedjackTechCompression,
    highRateMidChordSpeedjackJackBonus,
    longGammaHighChordjackFloorBonus,
    heldLongGammaHighChordjackFloorBonus,
    midHighChordGammaCompression,
    compactPureChordjackStaminaGate,
    compactPureChordjackStaminaCompression,
    shortSimpleChordjackWallStructuralGate,
    shortSimpleChordjackWallStructuralCompression,
    shortHighChordWallStructuralCompression,
    lowEndLongMidChordStaminaFloorBonus,
  };
}

// Two gates that read star rating against the NPS bands.
function lateGates(metrics: DanFeatureMetrics, starRating: number) {
  // Modest low-mid charts can look inflated when local peaks and 10s stamina agree,
  // but neither the peak nor sustained NPS has crossed the next pressure band.
  const lowMidSustainedPressureGate = metrics.holdRatio < 0.12
    && starRating >= 5
    && starRating <= 5.8
    && metrics.peakNps5s <= 26
    && metrics.sustainedNps10s <= 26
    ? minGate(
      (starRating - 5) / 0.3,
      (5.8 - starRating) / 0.4,
      (26 - metrics.peakNps5s) / 2,
      (26 - metrics.sustainedNps10s) / 2,
    )
    : 0;
  const lowMidSustainedPressureCompression = lowMidSustainedPressureGate * 0.6;
  // Fast high-chord walls need a small floor once both sustained speed and
  // same-column pressure are present; otherwise delta walls collapse to gamma.
  const sustainedHighChordWallGate = metrics.chordRatio >= 0.82
    && metrics.holdRatio < 0.08
    && metrics.peakNps5s >= 29
    && metrics.sustainedNps10s >= 28
    && metrics.jackPressure >= 140
    && starRating >= 6.3
    && starRating <= 7.5
    ? minGate(
      (metrics.chordRatio - 0.82) / 0.08,
      (metrics.peakNps5s - 29) / 1.5,
      (metrics.sustainedNps10s - 28) / 1.5,
      (metrics.jackPressure - 140) / 30,
      (starRating - 6.3) / 0.4,
      (7.5 - starRating) / 0.7,
    )
    : 0;
  const sustainedHighChordWallBonus = sustainedHighChordWallGate * 0.5;
  return {
    lowMidSustainedPressureGate,
    lowMidSustainedPressureCompression,
    sustainedHighChordWallGate,
    sustainedHighChordWallBonus,
  };
}
