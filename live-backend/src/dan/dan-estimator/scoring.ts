import { clamp01, gateWhen, minGate } from "./math.js";
import type { DanFeatureMetrics, DanScoringDebug, DanSkillFamily } from "./types.js";

const BASE_PRESSURE_CALIBRATION = {
  densityBase: 2.45,
  peak5sWeight: 0.095,
  peak1sWeight: 0.018,
  staminaBase: 2.65,
  sustained10sWeight: 0.16,
};

export interface DanFamilyScoreResult {
  skillScores: Record<DanSkillFamily, number>;
  debug: DanScoringDebug;
}

export function estimateFamilyScores(metrics: DanFeatureMetrics, starRating: number, durationMs: number): DanFamilyScoreResult {
  const densitySr = BASE_PRESSURE_CALIBRATION.densityBase
    + metrics.peakNps5s * BASE_PRESSURE_CALIBRATION.peak5sWeight
    + metrics.peakNps1s * BASE_PRESSURE_CALIBRATION.peak1sWeight;
  const staminaSr = BASE_PRESSURE_CALIBRATION.staminaBase + metrics.sustainedNps10s * BASE_PRESSURE_CALIBRATION.sustained10sWeight;
  const structuralSr = Math.max(densitySr, staminaSr);
  const base = structuralSr;
  const lnNerf = metrics.holdRatio > 0.45 ? 0.72 : metrics.holdRatio > 0.34 ? 0.76 : metrics.holdRatio > 0.28 ? 0.84 : 1;
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
  const compactDeltaSpeedBridgeBonus = compactDeltaSpeedBridgeGate * 0.06;
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
  const sustainedLightJumpstreamBonus = sustainedLightJumpstreamGate * 0.12;
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
  const lowRateMidChordJackCompression = lowRateMidChordJackGate * 0.8;
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
  const lowerRateTechBridgeBonus = ratePackTechShapeGate
    * (starRating >= 5.35 && starRating <= 5.55
      ? minGate((starRating - 5.3) / 0.12, (5.58 - starRating) / 0.12) * 0.48
      : 0);
  const baseRateTechCompression = ratePackTechShapeGate
    * (starRating >= 5.55 && starRating <= 6.05
      ? Math.max(0, Math.min(
        0.9,
        0.22
          + Math.max(0, 5.95 - starRating) * 2.4
          + Math.max(0, starRating - 5.95) * 0.2,
      ))
      : 0);
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
  const technicalAnchorBonus = technicalAnchorGate * Math.min(
    0.9,
    0.24
      + Math.max(0, metrics.jackPressure - 185) * 0.007
      + Math.max(0, metrics.peakNps1s - 32) * 0.055
      + Math.max(0, metrics.peakNps5s - 27) * 0.06
      + Math.max(0, metrics.chordSizeChangeRate - 0.28) * 0.45,
  );
  const highRatePackTechnicalAnchorCompression = technicalAnchorBonus * highRatePackTechnicalRhythmInflationGate;
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
  const compactTechnicalMarathonBonus = compactTechnicalMarathonGate * Math.min(
    0.58,
    0.14
      + Math.max(0, metrics.techPressure - 5.4) * 0.18
      + Math.max(0, metrics.chordSizeChangeRate - 0.3) * 0.48
      + Math.max(0, metrics.fastRowRatio - 0.4) * 0.16
      + Math.max(0, metrics.rowBurstPressure - 18) * 0.012
      + Math.max(0, 5.8 - starRating) * 0.055,
  );
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
  const localizedJumptrillSpikeCompression = localizedJumptrillSpikeGate * Math.min(
    2.6,
    1.8
      + Math.max(0, metrics.peakNps5s - metrics.nps5sP90 - 4) * 0.09
      + Math.max(0, starRating - 7) * 0.25,
  );
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
  const highChordSoftJackPenalty = denseChordWallGate * (1 - etaJackPressureGate) * 0.35;
  const denseJackSrCompressionBase = denseJackFileGate
    * Math.max(0, Math.min(1, (starRating - 6.6) / 0.7))
    * 0.28;
  const denseJackTechNerf = denseJackFileGate
    * Math.min(0.82, 0.68 + Math.max(0, metrics.techPressure - 8) * 0.08);
  const lowSrDenseWallJackBonus = denseWallJackGate
    * Math.max(0, Math.min(1, (6.45 - starRating) / 0.95))
    * Math.min(
      0.92,
      Math.max(0, 6.45 - starRating) * 0.78
        + Math.max(0, metrics.sustainedNps10s - 24) * 0.035
        + Math.max(0, metrics.chordRatio - 0.78) * 0.3,
    );
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
  const slowRepetitiveJackstreamBonus = slowRepetitiveJackstreamGate * 0.55;
  const ratedRepetitiveSpeedjackBonus = ratedRepetitiveSpeedjackGate * 1.05;
  const repetitiveSpeedjackTechCompression = slowRepetitiveJackstreamGate * 0.34
    + ratedRepetitiveSpeedjackGate * 0.75;
  const compactJackOverboostCompression = compactJackUnderrateBonus
    * clamp01((starRating - 6.08) / 0.12)
    * clamp01((metrics.chordRatio - 0.62) / 0.06)
    * clamp01((metrics.jackPressure - 172) / 8)
    * 1.2;
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
  const denseWallJackPenaltyRelief = highChordSoftJackPenalty
    * denseWallJackGate
    * Math.max(0, Math.min(1, (6.35 - starRating) / 0.55));
  const wallJackTechNerf = Math.min(
    0.9,
    denseJackFileGate * 0.45
      + denseWallJackGate * 0.65
      + (metrics.chordRatio >= 0.62 && metrics.chordRatio <= 0.74 && metrics.jackPressure >= 145 && metrics.jackPressure < 165 ? 0.45 : 0)
      + (metrics.chordRatio >= 0.74 && metrics.jackPressure >= 145 ? 0.25 : 0),
  );
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
  const farmJumptrillJackCompression = farmJumptrillGate * 0.45 + ratedVibroJumptrillGate * 0.95;
  const farmJumptrillStreamCompression = farmJumptrillGate * 0.5 + ratedVibroJumptrillGate * 0.75;
  const farmJumptrillHandstreamCompression = farmJumptrillGate * 0.75 + ratedVibroJumptrillGate * 1.3;
  const farmJumptrillStaminaCompression = farmJumptrillGate * 0.35 + ratedVibroJumptrillGate * 0.9;
  const farmJumptrillChordjackCompression = farmJumptrillGate * 0.75 + ratedVibroJumptrillGate * 1.35;
  const farmJumptrillTechCompression = farmJumptrillGate * 0.9 + ratedVibroJumptrillGate * 1.3;
  const shortDenseChordWallPenalty = denseChordWallGate
    * Math.max(0, Math.min(1, (155 - metrics.jackPressure) / 35))
    * Math.max(0, Math.min(1, (2400 - metrics.noteCount) / 900))
    * Math.max(0, Math.min(1, (115000 - durationMs) / 45000));
  const highRateShortDenseChordWallPenalty = shortDenseChordWallPenalty
    * Math.max(0, Math.min(1, (starRating - 5.75) / 0.45));
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
  const cyberLikeStaminaGate = longMidChordStaminaMapGate
    * Math.max(0, Math.min(1, (metrics.jackPressure - 110) / 30));
  const longMidChordSrNerf = cyberLikeStaminaGate
    * Math.max(0, Math.min(1, (starRating - 6) / 0.9))
    * Math.max(0, Math.min(1, (metrics.chordRatio - 0.44) / 0.04));
  const moderateMidChordStaminaNerf = longMidChordStaminaMapGate
    * Math.max(0, Math.min(1, (metrics.sustainedNps10s - 21) / 4))
    * Math.max(0, Math.min(1, (27.5 - metrics.sustainedNps10s) / 2.5))
    * 0.43;
  const midChordRateCompressionNerf = metrics.noteCount >= 4500
    && metrics.chordRatio >= 0.42
    && metrics.chordRatio <= 0.6
    && metrics.jackPressure < 150
    && metrics.holdRatio < 0.08
    ? Math.max(0, Math.min(1, (metrics.sustainedNps10s - 20) / 5))
      * Math.max(0, Math.min(1, (28 - metrics.sustainedNps10s) / 5))
      * 0.25
    : 0;
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
  const longSparseJackDropJackCompression = longSparseJackDropMapGate * 1.25;
  const longSparseJackDropStreamCompression = longSparseJackDropMapGate * 0.72;
  const longSparseJackDropHandstreamCompression = longSparseJackDropMapGate * 0.72;
  const longSparseJackDropStaminaCompression = longSparseJackDropMapGate * 0.45;
  const longSparseJackDropChordjackCompression = longSparseJackDropMapGate * 1.35;
  const longSparseJackDropTechCompression = longSparseJackDropMapGate * 1.42;
  const denseChordStaminaCompression = denseChordStaminaOverrateGate * 1.25;
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
  const compactHandstreamStaminaStructuralCompression = compactHandstreamStaminaStructuralGate * Math.min(
    1.16,
    0.9
      + Math.max(0, 24.5 - metrics.sustainedNps10s) * 0.04
      + Math.max(0, 1 - Math.abs(metrics.sustainedNps10s - 24) / 1.3) * 0.12
      + Math.max(0, 1 - Math.abs(metrics.sustainedNps10s - 28.2) / 3.5) * 0.14,
  );
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
  const awkwardMidRateChordjackWallCompression = awkwardMidRateChordjackWallGate * Math.min(
    1.15,
    0.9
      + Math.max(0, 30.5 - metrics.sustainedNps10s) * 0.12
      + Math.max(0, (durationMs - 210000) / 20000) * 0.22
      + Math.max(0, 0.7 - metrics.sustainedPressureRatio) * 0.4,
  );
  const denseJackSrCompression = denseJackSrCompressionBase * (1 - clamp01(awkwardMidRateChordjackWallGate * 3));
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
  const marathonTechnicalEnduranceBonus = marathonTechnicalEnduranceGate * Math.min(
    0.92,
    0.68
      + Math.max(0, metrics.sustainedNps10s - 32) * 0.06
      + Math.max(0, metrics.jackPressure - 200) * 0.004,
  );
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
  const midChordSpeedjackJackBonus = midChordSpeedjackGate * 0.75;
  const midChordSpeedjackTechCompression = midChordSpeedjackGate * 0.32;
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
  const jackBonus = Math.min(0.82, Math.max(0, (metrics.jackPressure - 92) / 240) + chordGate * 0.12 + highChordJackBonus);
  const streamBonus = Math.min(1.65, Math.max(0, metrics.streamPressure / 16) + Math.max(0, metrics.peakNps5s - 25) * 0.008 + speedBonus + pureSpeedBonus + lowChordSustainedSpeedBonus + longLowChordSpeedBonus + lightChordGammaSpeedFloorBonus + lowSrSpeedUnderrateBonus + compactDeltaSpeedBridgeBonus + simpleHighDeltaSpeedBridgeBonus + sustainedLightJumpstreamBonus + baseRateSubGammaStreamBonus + compactModerateChordSpeedBonus + speedEnduranceBonus + longSteadyStreamBonus);
  const staminaBonus = Math.min(1.45, Math.max(0, metrics.sustainedNps10s - 23) * 0.018 + Math.min(0.16, metrics.noteCount / 16000) + speedBonus * 0.8 + staminaEnduranceBonus + longSteadyStreamBonus * 0.45 + fastLongMidChordStaminaGate * 0.02 - longMidChordSrNerf * 0.6 + Math.max(0, longMidChordStaminaMapGate - cyberLikeStaminaGate) * 0.28);
  const jumpstreamBonus = Math.max(0, jumpstreamChordGate * Math.min(
    1.45,
    Math.max(0, metrics.jumpstreamPressure - 12) * 0.045
      + Math.max(0, metrics.sustainedNps10s - 18) * 0.038
      + Math.max(0, metrics.peakNps5s - 21) * 0.024
      + Math.min(0.2, metrics.noteCount / 18000)
      + Math.max(0, 155 - metrics.jackPressure) * 0.001,
  ) - highChordGate * 0.18 - denseChordWallGate * 0.42);
  const handstreamBonus = handstreamChordGate * Math.min(
    1.35,
    Math.max(0, metrics.sustainedNps10s - 20) * 0.055
      + Math.max(0, metrics.peakNps5s - 23) * 0.022
      + Math.min(0.24, metrics.noteCount / 22000)
      + Math.max(0, 160 - metrics.jackPressure) * 0.0012,
  );
  const chordjackBonus = Math.max(
    0,
    Math.min(1, chordGate * 0.35 + Math.max(0, (metrics.chordjackPressure - 70) / 260) + denseChordedSpeedBonus * 0.55) * chordjackEnduranceMultiplier
      - highChordGate * strongJackGate * 0.45
      - longEnduranceMapGate * 0.32
      - longMidChordStaminaMapGate * 0.55
      - shortDenseChordWallPenalty * 1.2
      - highRateShortDenseChordWallPenalty * 1.18,
  );
  const techBonus = Math.max(
    0,
    Math.min(
      1.95,
      metrics.techPressure * 0.065
        + chordGate * 0.14
        + denseChordedSpeedBonus
        + burstTechBonus
        + lowSrTechnicalRhythmBonus
        + lowerRateTechBridgeBonus
        + syncopatedChordTechBonus
        + compactChordSwitchTechBonus
        + technicalAnchorBonus
        + compactTechnicalMarathonBonus
        + earlyVariedPatternTechBonus
        + compactChordFlowTechBonus
        + fastTechnicalSpeedFloorBonus
        + highRateTechnicalAnchorFloorBonus
        + variedTechnicalAnchorBridgeBonus
        + lowChordTechnicalSpeedBridgeBonus,
    )
      - highChordGate * 0.7
      - denseChordWallGate * 0.55
      - shortDenseChordWallPenalty * 1.55
      - highRateShortDenseChordWallPenalty * 1.65
      - steadySpeedMapGate * 0.58
      - longEnduranceMapGate * 0.75
      - longMidChordStaminaMapGate * 0.8
      - moderateBurstTechCompression
      - lowDensityChordFlowTechCompression
      - introHighChordFlowTechCompression
      - earlyLowEntropyTechCompression
      - sparseLowSrTechVocabularyCompression
      - compactHighChordTechCompression,
  );
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

  const rawSkillScores: Record<DanSkillFamily, number> = {
    jack: (base + jackBonus + shortLnHybridRiceRequirementBonus * 0.6 + extremeChordwallSpeedBonus + fastSimpleChordWallJackFloorBonus + denseSimpleChordWallRateBonus + highEndFastWallJackBonus + sustainedHighChordWallBonus + midHighChordjackDeltaBridgeBonus + highRateVariedWallJackBridgeBonus + marathonTechnicalEnduranceBonus + lowSrDenseWallJackBonus + compactJackUnderrateBonus + lowRateHighChordJackBonus + slowRepetitiveJackstreamBonus + ratedRepetitiveSpeedjackBonus + compactHighChordDeltaJackBonus + denseWallJackPenaltyRelief + midChordSpeedjackJackBonus + highRateMidChordSpeedjackJackBonus + longGammaHighChordjackFloorBonus + heldLongGammaHighChordjackFloorBonus - midRatePlainWallJackCompression - plainHighChordWallRateCompression - variedMidHighChordWallCompression - lowRateMidChordJackCompression - introMidChordJackCompression - midVarietyHighSpeedCompression - lowMidRateOverpromotionCompression - lowMidSustainedPressureCompression - sparseLowSrTechVocabularyCompression * 0.7 - introHighChordFlowTechCompression * 0.7 - highChordSoftJackPenalty - denseJackSrCompression - mediumWallJackSrCompression - compactJackOverboostCompression - farmJumptrillJackCompression - longSparseJackDropJackCompression - shortLnHybridStructuralCompression - lowChordSteadySpeedStructuralCompression - moderateChordSteadyStreamStructuralCompression - compactHandstreamStaminaStructuralCompression - compactTechnicalFlowStructuralCompression * 0.65 - compactChordWallStructuralCompression - simpleDenseChordWallStructuralCompression - lowRateDenseChordWallCompression - simpleMidHighChordWallStructuralCompression - awkwardMidRateChordjackWallCompression - midHighChordSustainedTechStructuralCompression - shortDenseWallSrCompression - compactMidRateWallJackCompression - lowEdgeMidChordJackCompression - lowSrShortDenseWallCompression - mediumWallJackOverrateCompression - midHighChordGammaCompression - compactPureChordjackStaminaCompression - shortSimpleChordjackWallStructuralCompression - shortHighChordWallStructuralCompression - shortSpikeCompression - localizedJumptrillSpikeCompression) * lnNerf,
    stream: (base + streamBonus + shortLnHybridRiceRequirementBonus * 0.85 + highSpeedEndgameBonus + lowChordSpeedjackAnchorBonus + highEntropyLowChordEnduranceBridgeBonus + variedLowChordSpeedjackBridgeBonus + marathonTechnicalEnduranceBonus * 0.85 + lightRowBurstStreamBonus - introHighChordFlowTechCompression * 0.6 - lowDensityChordFlowTechCompression * 0.5 - lowRateMidChordJackCompression - introMidChordJackCompression - midVarietyHighSpeedCompression - lowMidRateOverpromotionCompression - lowMidSustainedPressureCompression - sparseLowSrTechVocabularyCompression - lowChordBurstStreamNerf - variedLowChordSpeedCompression - thinLowChordSpeedCompression - highVarietyThinStreamEdgeCompression - longSparseStreamCompression - farmJumptrillStreamCompression - longSparseJackDropStreamCompression - shortLnHybridStructuralCompression - lowChordSteadySpeedStructuralCompression - moderateChordSteadyStreamStructuralCompression - compactHandstreamStaminaStructuralCompression - compactTechnicalFlowStructuralCompression * 0.6 - compactChordWallStructuralCompression - simpleDenseChordWallStructuralCompression - lowRateDenseChordWallCompression - simpleMidHighChordWallStructuralCompression - awkwardMidRateChordjackWallCompression - midHighChordSustainedTechStructuralCompression * 0.85 - shortDenseWallSrCompression - lowSrShortDenseWallCompression - mediumWallJackOverrateCompression - midHighChordGammaCompression - compactPureChordjackStaminaCompression - shortSimpleChordjackWallStructuralCompression - shortHighChordWallStructuralCompression - shortSpikeCompression - localizedJumptrillSpikeCompression) * lnNerf,
    jumpstream: (base + jumpstreamBonus + sustainedLightJumpstreamBonus + compactModerateChordSpeedBonus * 0.75 + speedEnduranceBonus * 0.35 + longSteadyStreamBonus * 0.35 + shortLnHybridRiceRequirementBonus * 0.75 - lowRateMidChordJackCompression * 0.5 - introMidChordJackCompression * 0.5 - midVarietyHighSpeedCompression - lowMidRateOverpromotionCompression - lowMidSustainedPressureCompression * 0.7 - sparseLowSrTechVocabularyCompression * 0.7 - farmJumptrillStreamCompression - longSparseStreamCompression * 0.7 - shortLnHybridStructuralCompression - lowChordSteadySpeedStructuralCompression * 0.7 - compactHandstreamStaminaStructuralCompression * 0.65 - compactTechnicalFlowStructuralCompression * 0.7 - compactChordWallStructuralCompression - simpleDenseChordWallStructuralCompression - lowRateDenseChordWallCompression - simpleMidHighChordWallStructuralCompression - awkwardMidRateChordjackWallCompression - midHighChordSustainedTechStructuralCompression * 0.75 - shortDenseWallSrCompression - lowSrShortDenseWallCompression - mediumWallJackOverrateCompression - midHighChordGammaCompression - compactPureChordjackStaminaCompression - shortSimpleChordjackWallStructuralCompression - shortHighChordWallStructuralCompression - shortSpikeCompression - localizedJumptrillSpikeCompression) * lnNerf,
    handstream: (base + handstreamBonus + fastMidChordHandstreamBridgeBonus + marathonTechnicalEnduranceBonus * 0.7 - compactMidChordHandstreamCompression - lowRateMidChordJackCompression - introMidChordJackCompression - midVarietyHighSpeedCompression - lowMidRateOverpromotionCompression - sparseLowSrTechVocabularyCompression * 0.7 - introHighChordFlowTechCompression * 0.7 - moderateMidChordStaminaNerf * 0.25 - highEndMidChordStaminaNerf * 0.35 - longJumpstreamStaminaCompression * 0.45 - simpleLongJumpstreamPatternCompression * 0.35 - farmJumptrillHandstreamCompression - longSparseJackDropHandstreamCompression - shortLnHybridStructuralCompression - lowChordSteadySpeedStructuralCompression * 0.85 - moderateChordSteadyStreamStructuralCompression - compactHandstreamStaminaStructuralCompression - compactTechnicalFlowStructuralCompression * 0.7 - compactChordWallStructuralCompression - simpleDenseChordWallStructuralCompression - lowRateDenseChordWallCompression - simpleMidHighChordWallStructuralCompression - awkwardMidRateChordjackWallCompression - midHighChordSustainedTechStructuralCompression - shortDenseWallSrCompression - lowSrShortDenseWallCompression - mediumWallJackOverrateCompression - midHighChordGammaCompression - compactPureChordjackStaminaCompression - shortSimpleChordjackWallStructuralCompression - shortHighChordWallStructuralCompression - shortSpikeCompression - localizedJumptrillSpikeCompression) * lnNerf,
    stamina: (base + staminaBonus + highSpeedEndgameBonus * 0.65 + marathonTechnicalEnduranceBonus * 0.9 + lowEndLongMidChordStaminaFloorBonus - lowRateMidChordJackCompression - introMidChordJackCompression - midVarietyHighSpeedCompression - lowMidRateOverpromotionCompression - sparseLowSrTechVocabularyCompression * 0.7 - moderateMidChordStaminaNerf - midChordRateCompressionNerf - highNoteMidRateHandstreamNerf - highEndMidChordStaminaNerf - longJumpstreamStaminaCompression - simpleLongJumpstreamPatternCompression - deltaHighMidChordTransitionNerf - farmJumptrillStaminaCompression - longSparseJackDropStaminaCompression - denseChordStaminaCompression - shortLnHybridStructuralCompression - lowChordSteadySpeedStructuralCompression * 0.9 - moderateChordSteadyStreamStructuralCompression - compactHandstreamStaminaStructuralCompression - compactTechnicalFlowStructuralCompression * 0.6 - compactChordWallStructuralCompression - simpleDenseChordWallStructuralCompression - lowRateDenseChordWallCompression - simpleMidHighChordWallStructuralCompression - awkwardMidRateChordjackWallCompression - midHighChordSustainedTechStructuralCompression - shortDenseWallSrCompression - lowSrShortDenseWallCompression - mediumWallJackOverrateCompression - midHighChordGammaCompression - compactPureChordjackStaminaCompression - shortSimpleChordjackWallStructuralCompression - shortHighChordWallStructuralCompression - shortSpikeCompression - localizedJumptrillSpikeCompression) * lnNerf,
    chordjack: (base + chordjackBonus + shortLnHybridRiceRequirementBonus * 0.75 + lowRateChordjackWallFloorBonus + compactHighChordAlphaWallFloorBonus + compactHighChordGammaWallFloorBonus + compactHighChordGammaPlusWallBridgeBonus + compactHighChordDeltaWallBridgeBonus + sustainedHighChordWallBonus + extremeChordwallSpeedBonus * 0.6 + marathonTechnicalEnduranceBonus * 0.75 + slowRepetitiveJackstreamBonus * 0.55 + ratedRepetitiveSpeedjackBonus * 0.55 + midChordSpeedjackJackBonus + longGammaHighChordjackFloorBonus + heldLongGammaHighChordjackFloorBonus - lowRateMidChordJackCompression - introMidChordJackCompression - midVarietyHighSpeedCompression - lowMidRateOverpromotionCompression - sparseLowSrTechVocabularyCompression * 0.7 - introHighChordFlowTechCompression * 0.75 - farmJumptrillChordjackCompression - longSparseJackDropChordjackCompression - shortLnHybridStructuralCompression - lowChordSteadySpeedStructuralCompression * 0.8 - moderateChordSteadyStreamStructuralCompression - compactHandstreamStaminaStructuralCompression - compactTechnicalFlowStructuralCompression * 0.75 - compactChordWallStructuralCompression - simpleDenseChordWallStructuralCompression - lowRateDenseChordWallCompression - simpleMidHighChordWallStructuralCompression - awkwardMidRateChordjackWallCompression - midHighChordSustainedTechStructuralCompression - shortDenseWallSrCompression - lowSrShortDenseWallCompression - mediumWallJackOverrateCompression - longHighChordChordjackCompression - midHighChordGammaCompression - compactPureChordjackStaminaCompression - shortSimpleChordjackWallStructuralCompression - shortHighChordWallStructuralCompression - shortSpikeCompression - localizedJumptrillSpikeCompression) * lnNerf,
    tech: (base + techBonus + shortLnHybridRiceRequirementBonus + highSpeedEndgameBonus * 0.85 + lowChordSpeedjackAnchorBonus * 0.6 + variedLowChordSpeedjackBridgeBonus * 0.85 + highRateTechnicalAnchorFloorBonus * 0.23 + highAnchorTechDeltaBridgeBonus + compactGammaTechCalibrationBridgeBonus + lowEntropyTechDeltaBridgeBonus + marathonTechnicalEnduranceBonus * 0.8 - shortLnHybridTechCompression - midChordTechOvercallCompression - lowRateMidChordJackCompression - introMidChordJackCompression - midVarietyHighSpeedCompression - lowMidRateOverpromotionCompression - lowMidSustainedPressureCompression - sparseLowSrTechVocabularyCompression * 0.7 - lowRateTechnicalVocabularyCompression - baseRateTechCompression - ratePackTechStructuralCompression - highRatePackTechnicalAnchorCompression - repetitiveSpeedjackTechCompression - denseJackTechNerf - wallJackTechNerf - lowChordBurstTechNerf - variedLowChordSpeedCompression - farmJumptrillTechCompression - longSparseJackDropTechCompression - shortLnHybridStructuralCompression - lowChordSteadySpeedStructuralCompression * 0.85 - moderateChordSteadyStreamStructuralCompression - compactHandstreamStaminaStructuralCompression - compactHandstreamStaminaTechCompression - compactTechnicalFlowStructuralCompression - compactChordWallStructuralCompression - simpleDenseChordWallStructuralCompression - lowRateDenseChordWallCompression - simpleMidHighChordWallStructuralCompression - awkwardMidRateChordjackWallCompression - midHighChordSustainedTechStructuralCompression - shortDenseWallSrCompression - lowSrShortDenseWallCompression - mediumWallJackOverrateCompression - midChordSpeedjackTechCompression - midHighChordGammaCompression - compactPureChordjackStaminaCompression - shortSimpleChordjackWallStructuralCompression - shortHighChordWallStructuralCompression - shortSpikeCompression - localizedJumptrillSpikeCompression * 1.45) * lnNerf,
    ln: 0,
    dan: 0,
  };
  // Jumpstream is a pattern subtype here; keep SR on the existing handstream scale.
  rawSkillScores.jumpstream = rawSkillScores.handstream;

  // Moderate practice walls can stack local jack/chordjack/tech pressure well
  // above their osu! SR without crossing into the next real dan band.
  const practicePatternInflationGate = (score: number): number => metrics.holdRatio < 0.12
    && starRating >= 4.5
    && starRating <= 7
    && metrics.peakNps5s >= 24
    && metrics.peakNps5s <= 31
    && metrics.sustainedNps10s >= 24
    && metrics.sustainedNps10s <= 30
    && metrics.chordRatio >= 0.6
    && metrics.jackPressure <= 170
    ? minGate(
      (score - starRating - 0.8) / 0.8,
      (starRating - 4.5) / 0.5,
      (7 - starRating) / 0.7,
      (metrics.peakNps5s - 24) / 1.5,
      (metrics.sustainedNps10s - 24) / 1.5,
      (31 - metrics.peakNps5s) / 3,
      (30 - metrics.sustainedNps10s) / 3,
      (metrics.chordRatio - 0.6) / 0.15,
      (170 - metrics.jackPressure) / 50,
    )
    : 0;
  const jackPracticePatternInflationGate = practicePatternInflationGate(rawSkillScores.jack);
  const streamPracticePatternInflationGate = practicePatternInflationGate(rawSkillScores.stream);
  const jumpstreamPracticePatternInflationGate = practicePatternInflationGate(rawSkillScores.jumpstream);
  const handstreamPracticePatternInflationGate = practicePatternInflationGate(rawSkillScores.handstream);
  const staminaPracticePatternInflationGate = practicePatternInflationGate(rawSkillScores.stamina);
  const chordjackPracticePatternInflationGate = practicePatternInflationGate(rawSkillScores.chordjack);
  const techPracticePatternInflationGate = practicePatternInflationGate(rawSkillScores.tech);
  const jackPracticePatternInflationCompression = jackPracticePatternInflationGate * 1.5;
  const streamPracticePatternInflationCompression = streamPracticePatternInflationGate * 1.5;
  const jumpstreamPracticePatternInflationCompression = jumpstreamPracticePatternInflationGate * 1.5;
  const handstreamPracticePatternInflationCompression = handstreamPracticePatternInflationGate * 1.5;
  const staminaPracticePatternInflationCompression = staminaPracticePatternInflationGate * 1.5;
  const chordjackPracticePatternInflationCompression = chordjackPracticePatternInflationGate * 1.5;
  const techPracticePatternInflationCompression = techPracticePatternInflationGate * 1.7;

  const skillScores: Record<DanSkillFamily, number> = {
    ...rawSkillScores,
    jack: rawSkillScores.jack - jackPracticePatternInflationCompression,
    stream: rawSkillScores.stream - streamPracticePatternInflationCompression,
    jumpstream: rawSkillScores.jumpstream - jumpstreamPracticePatternInflationCompression,
    handstream: rawSkillScores.handstream - handstreamPracticePatternInflationCompression,
    stamina: rawSkillScores.stamina - staminaPracticePatternInflationCompression,
    chordjack: rawSkillScores.chordjack - chordjackPracticePatternInflationCompression,
    tech: rawSkillScores.tech - techPracticePatternInflationCompression,
  };
  const gates = {
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
    sustainedLightJumpstreamGate,
    chordjackEnduranceGate,
    strongJackGate,
    etaJackPressureGate,
    steadySpeedMapGate,
    longEnduranceMapGate,
    longSparseJackDropMapGate,
    longMidChordStaminaMapGate,
    fastLongMidChordStaminaGate,
    cyberLikeStaminaGate,
    denseChordStaminaOverrateGate,
    moderateChordSteadyStreamStructuralGate,
    compactHandstreamStaminaStructuralGate,
    shortSimpleChordjackWallStructuralGate,
    longJumpstreamStaminaCompressionGate: longJumpstreamStaminaCompression > 0 ? longJumpstreamStaminaCompression / 0.38 : 0,
    simpleLongJumpstreamPatternCompressionGate: simpleLongJumpstreamPatternCompression > 0 ? simpleLongJumpstreamPatternCompression / 0.11 : 0,
    shortLnHybridStructuralGate,
    lowChordSteadySpeedStructuralGate,
    compactTechnicalFlowStructuralGate,
    compactChordWallStructuralGate,
    simpleDenseChordWallStructuralGate,
    lowRateDenseChordWallGate,
    variedLowRateDenseChordWallGate,
    simpleMidHighChordWallStructuralGate,
    awkwardMidRateChordjackWallGate,
    midHighChordSustainedTechStructuralGate,
    marathonTechnicalEnduranceGate,
    lowSrShortDenseWallCompressionGate: lowSrShortDenseWallCompression > 0 ? lowSrShortDenseWallCompression / 0.32 : 0,
    midChordSpeedjackGate,
    compactPureChordjackStaminaGate,
    shortHighChordWallStructuralGate: shortHighChordWallStructuralCompression > 0 ? shortHighChordWallStructuralCompression / 0.63 : 0,
    farmJumptrillGate,
    ratedVibroJumptrillGate,
    lowSrTechnicalRhythmGate,
    highRatePackTechnicalRhythmInflationGate,
    compactDeltaSpeedBridgeGate,
    ratePackTechShapeGate,
    syncopatedChordTechGate,
    compactChordSwitchTechGate,
    technicalAnchorGate,
    compactTechnicalMarathonGate,
    shortSpikeGate,
    localizedJumptrillSpikeGate,
    lowMidSustainedPressureGate,
    sustainedHighChordWallGate,
    jackPracticePatternInflationGate,
    streamPracticePatternInflationGate,
    jumpstreamPracticePatternInflationGate,
    handstreamPracticePatternInflationGate,
    staminaPracticePatternInflationGate,
    chordjackPracticePatternInflationGate,
    techPracticePatternInflationGate,
  };
  const terms = {
    speedBonus,
    pureSpeedBonus,
    lowChordSustainedSpeedBonus,
    longLowChordSpeedBonus,
    lightChordGammaSpeedFloorBonus,
    lowSrSpeedUnderrateBonus,
    compactDeltaSpeedBridgeBonus,
    simpleHighDeltaSpeedBridgeBonus,
    sustainedLightJumpstreamBonus,
    baseRateSubGammaStreamBonus,
    compactModerateChordSpeedBonus,
    speedEnduranceBonus,
    highSpeedEndgameBonus,
    lowChordSpeedjackAnchorBonus,
    variedLowChordSpeedjackBridgeBonus,
    variedLowChordSpeedCompression,
    midVarietyHighSpeedCompression,
    lowMidRateOverpromotionCompression,
    lowMidSustainedPressureCompression,
    jackPracticePatternInflationCompression,
    streamPracticePatternInflationCompression,
    jumpstreamPracticePatternInflationCompression,
    handstreamPracticePatternInflationCompression,
    staminaPracticePatternInflationCompression,
    chordjackPracticePatternInflationCompression,
    techPracticePatternInflationCompression,
    extremeChordwallSpeedBonus,
    fastSimpleChordWallJackFloorBonus,
    sustainedHighChordWallBonus,
    staminaEnduranceBonus,
    longSteadyStreamBonus,
    burstTechBonus,
    lowSrTechnicalRhythmBonus,
    lowerRateTechBridgeBonus,
    baseRateTechCompression,
    ratePackTechStructuralCompression,
    syncopatedChordTechBonus,
    compactChordSwitchTechBonus,
    technicalAnchorBonus,
    highRatePackTechnicalAnchorCompression,
    highRateTechnicalAnchorFloorBonus,
    compactTechnicalMarathonBonus,
    earlyVariedPatternTechBonus,
    lightRowBurstStreamBonus,
    compactChordFlowTechBonus,
    fastTechnicalSpeedFloorBonus,
    variedTechnicalAnchorBridgeBonus,
    moderateBurstTechCompression,
    lowDensityChordFlowTechCompression,
    introHighChordFlowTechCompression,
    earlyLowEntropyTechCompression,
    sparseLowSrTechVocabularyCompression,
    compactHighChordTechCompression,
    shortSpikeCompression,
    localizedJumptrillSpikeCompression,
    chordedSpeedBonus,
    denseChordedSpeedBonus,
    chordjackEnduranceMultiplier,
    highChordJackBonus,
    highChordSoftJackPenalty,
    denseJackSrCompression,
    denseJackTechNerf,
    lowSrDenseWallJackBonus,
    compactJackUnderrateBonus,
    lowRateHighChordJackBonus,
    slowRepetitiveJackstreamBonus,
    ratedRepetitiveSpeedjackBonus,
    repetitiveSpeedjackTechCompression,
    compactJackOverboostCompression,
    compactHighChordDeltaJackBonus,
    mediumWallJackSrCompression,
    denseWallJackPenaltyRelief,
    wallJackTechNerf,
    lowChordBurstStreamNerf,
    lowChordBurstTechNerf,
    farmJumptrillJackCompression,
    farmJumptrillStreamCompression,
    farmJumptrillHandstreamCompression,
    farmJumptrillStaminaCompression,
    farmJumptrillChordjackCompression,
    farmJumptrillTechCompression,
    shortDenseChordWallPenalty,
    highRateShortDenseChordWallPenalty,
    longMidChordSrNerf,
    moderateMidChordStaminaNerf,
    midChordRateCompressionNerf,
    highNoteMidRateHandstreamNerf,
    highEndMidChordStaminaNerf,
    longJumpstreamStaminaCompression,
    simpleLongJumpstreamPatternCompression,
    deltaHighMidChordTransitionNerf,
    longSparseStreamCompression,
    longSparseJackDropJackCompression,
    longSparseJackDropStreamCompression,
    longSparseJackDropHandstreamCompression,
    longSparseJackDropStaminaCompression,
    longSparseJackDropChordjackCompression,
    longSparseJackDropTechCompression,
    denseChordStaminaCompression,
    shortLnHybridStructuralCompression,
    lowChordSteadySpeedStructuralCompression,
    moderateChordSteadyStreamStructuralCompression,
    compactHandstreamStaminaStructuralCompression,
    compactHandstreamStaminaTechCompression,
    compactTechnicalFlowStructuralCompression,
    compactChordWallStructuralCompression,
    simpleDenseChordWallStructuralCompression,
    lowRateDenseChordWallCompression,
    simpleMidHighChordWallStructuralCompression,
    awkwardMidRateChordjackWallCompression,
    midHighChordSustainedTechStructuralCompression,
    marathonTechnicalEnduranceBonus,
    shortDenseWallSrCompression,
    lowSrShortDenseWallCompression,
    mediumWallJackOverrateCompression,
    longHighChordChordjackCompression,
    midChordSpeedjackJackBonus,
    midChordSpeedjackTechCompression,
    highRateMidChordSpeedjackJackBonus,
    longGammaHighChordjackFloorBonus,
    heldLongGammaHighChordjackFloorBonus,
    midHighChordGammaCompression,
    compactPureChordjackStaminaCompression,
    shortSimpleChordjackWallStructuralCompression,
    shortHighChordWallStructuralCompression,
    lowEndLongMidChordStaminaFloorBonus,
    jackBonus,
    streamBonus,
    jumpstreamBonus,
    staminaBonus,
    handstreamBonus,
    chordjackBonus,
    techBonus,
  };

  return {
    skillScores,
    debug: {
      densitySr,
      staminaSr,
      structuralSr,
      base,
      lnNerf,
      gates,
      terms,
      contributions: {
        jack: [
          { id: "base", value: base, description: "Base pressure estimate from extracted density and stamina." },
          { id: "jackBonus", value: jackBonus, description: "Jack pressure and high-chord jack reward." },
          { id: "extremeChordwallSpeedBonus", value: extremeChordwallSpeedBonus, description: "Floor for extreme dense chordwall speed where peak and sustained wall pressure exceed ordinary jack calibration." },
          { id: "denseSimpleChordWallRateBonus", value: denseSimpleChordWallRateBonus, description: "Floor for dense simple chord walls once jack pressure crosses the next rate step." },
          { id: "highEndFastWallJackBonus", value: highEndFastWallJackBonus, description: "Top-end floor for long fast wall-jack files with sustained same-column pressure." },
          { id: "midHighChordjackDeltaBridgeBonus", value: midHighChordjackDeltaBridgeBonus, description: "Bridge for mid-high chordjack files where fast-row and same-column pressure reach low-delta shape." },
          { id: "highRateVariedWallJackBridgeBonus", value: highRateVariedWallJackBridgeBonus, description: "Bridge for higher-rate varied wall-jacks once entropy and jack pressure exceed the plain-wall band." },
          { id: "marathonTechnicalEnduranceBonus", value: marathonTechnicalEnduranceBonus, description: "Reward for very long high-pressure technical endurance where extracted pressure is otherwise too conservative." },
          { id: "midChordSpeedjackJackBonus", value: midChordSpeedjackJackBonus, description: "Reward for mid-chord speedjack pressure that should route as jack instead of tech." },
          { id: "highRateMidChordSpeedjackJackBonus", value: highRateMidChordSpeedjackJackBonus, description: "Floor for high-rate mid-chord speedjack pressure above the ordinary mid-chord gate." },
          { id: "lowSrDenseWallJackBonus", value: lowSrDenseWallJackBonus, description: "Dense wall-jack reward where SR underrates slow high-chord repetition." },
          { id: "compactJackUnderrateBonus", value: compactJackUnderrateBonus, description: "Compact dense jack files around gamma that SR tends to underrate." },
          { id: "lowRateHighChordJackBonus", value: lowRateHighChordJackBonus, description: "High-chord lower-rate jack reward for gamma-range files." },
          { id: "slowRepetitiveJackstreamBonus", value: slowRepetitiveJackstreamBonus, description: "Reward for slow repetitive jackstream where row timing is simple but same-column pressure is high." },
          { id: "ratedRepetitiveSpeedjackBonus", value: ratedRepetitiveSpeedjackBonus, description: "Reward for rate-scaled repetitive speedjack pressure that should stay in the jack family." },
          { id: "compactHighChordDeltaJackBonus", value: compactHighChordDeltaJackBonus, description: "Compact high-chord wall-jack reward around low delta." },
          { id: "denseWallJackPenaltyRelief", value: denseWallJackPenaltyRelief, description: "Restores high-chord wall penalty when same-column jack pressure is present at lower SR." },
          { id: "midRatePlainWallJackCompression", value: -midRatePlainWallJackCompression, description: "Compression for plain mid-rate wall-jacks before timing variety catches up." },
          { id: "plainHighChordWallRateCompression", value: -plainHighChordWallRateCompression, description: "Compression for plain high-chord walls where rate lifts peak pressure before timing variety appears." },
          { id: "variedMidHighChordWallCompression", value: -variedMidHighChordWallCompression, description: "Compression for varied mid-high chord walls that inflate SR before fast-row pressure arrives." },
          { id: "lowRateMidChordJackCompression", value: -lowRateMidChordJackCompression, description: "Compression for low-rate mid-chord jack files where jack pressure overstates dan level." },
          { id: "introMidChordJackCompression", value: -introMidChordJackCompression, description: "Compression for introductory mid-chord jack files with low row speed." },
          { id: "highChordSoftJackPenalty", value: -highChordSoftJackPenalty, description: "Penalty for chord walls without enough jack pressure." },
          { id: "denseJackSrCompression", value: -denseJackSrCompression, description: "Compression for short dense jack files at high SR." },
          { id: "mediumWallJackSrCompression", value: -mediumWallJackSrCompression, description: "Compression for medium wall-jacks where SR overstates dan pressure." },
          { id: "compactJackOverboostCompression", value: -compactJackOverboostCompression, description: "Trims compact jack boost when higher-rate pressure is already represented." },
          { id: "farmJumptrillJackCompression", value: -farmJumptrillJackCompression, description: "Compression for long farm jumptrills that only become vibro-like under rate." },
          { id: "longSparseJackDropJackCompression", value: -longSparseJackDropJackCompression, description: "Compression for long files whose difficulty is concentrated in jack drops rather than full-chart dan pressure." },
          { id: "shortLnHybridStructuralCompression", value: -shortLnHybridStructuralCompression, description: "Compression for mixed short-LN charts where LN density overstates rice dan pressure." },
          { id: "lowChordSteadySpeedStructuralCompression", value: -lowChordSteadySpeedStructuralCompression, description: "Compression for low-chord steady speed where density overstates whole-chart dan pressure." },
          { id: "moderateChordSteadyStreamStructuralCompression", value: -moderateChordSteadyStreamStructuralCompression, description: "Compression for long low-mid chord steady stream where sustained density overstates dan pressure." },
          { id: "compactHandstreamStaminaStructuralCompression", value: -compactHandstreamStaminaStructuralCompression, description: "Compression for compact handstream stamina where chord changes overstate dan pressure." },
          { id: "compactTechnicalFlowStructuralCompression", value: -compactTechnicalFlowStructuralCompression * 0.65, description: "Shared compression for compact technical flow whose local chord changes overstate dan pressure." },
          { id: "compactChordWallStructuralCompression", value: -compactChordWallStructuralCompression, description: "Compression for compact high-chord wall-jacks with limited whole-chart pressure." },
          { id: "simpleDenseChordWallStructuralCompression", value: -simpleDenseChordWallStructuralCompression, description: "Compression for simple dense chord walls with very low row-flow variety." },
          { id: "lowRateDenseChordWallCompression", value: -lowRateDenseChordWallCompression, description: "Compression for low-rate dense chord walls whose chord density overstates dan pressure before sustained speed arrives." },
          { id: "simpleMidHighChordWallStructuralCompression", value: -simpleMidHighChordWallStructuralCompression, description: "Compression for simple mid-high chord walls whose chord density overstates jack dan pressure." },
          { id: "awkwardMidRateChordjackWallCompression", value: -awkwardMidRateChordjackWallCompression, description: "Compression for mid-rate chordjack walls whose awkwardness is real but overpromoted below full-rate pressure." },
          { id: "midHighChordSustainedTechStructuralCompression", value: -midHighChordSustainedTechStructuralCompression, description: "Compression for sustained mid-high chord tech walls where row flow is simpler than the pressure estimate." },
          { id: "shortDenseWallSrCompression", value: -shortDenseWallSrCompression, description: "Compression for short dense wall-jack files where SR overstates dan pressure." },
          { id: "lowSrShortDenseWallCompression", value: -lowSrShortDenseWallCompression, description: "Compression for lower-SR short wall-jack files where dense chords overstate dan pressure." },
          { id: "mediumWallJackOverrateCompression", value: -mediumWallJackOverrateCompression, description: "Compression for medium wall-jacks where jack pressure is already represented by SR." },
          { id: "compactPureChordjackStaminaCompression", value: -compactPureChordjackStaminaCompression, description: "Compression for compact pure chordjack stamina where lower rates overstate dan pressure." },
          { id: "shortSimpleChordjackWallStructuralCompression", value: -shortSimpleChordjackWallStructuralCompression, description: "Compression for short simple chordjack walls where chord density overstates dan pressure." },
          { id: "shortSpikeCompression", value: -shortSpikeCompression, description: "Compression for files whose difficulty is mostly a short isolated spike." },
          { id: "localizedJumptrillSpikeCompression", value: -localizedJumptrillSpikeCompression, description: "Compression for maps whose hardest 5s jumptrill or vibro section is much denser than the surrounding file." },
        ],
        stream: [
          { id: "base", value: base, description: "Base pressure estimate from extracted density and stamina." },
          { id: "streamBonus", value: streamBonus, description: "Speed and sustained stream pressure." },
          { id: "highSpeedEndgameBonus", value: highSpeedEndgameBonus, description: "Floor for continuous low-chord speed/endurance charts at high sustained NPS." },
          { id: "lowChordSpeedjackAnchorBonus", value: lowChordSpeedjackAnchorBonus, description: "Floor for low-chord speedjack anchor patterns where same-column pressure suppresses ordinary stream scoring." },
          { id: "highEntropyLowChordEnduranceBridgeBonus", value: highEntropyLowChordEnduranceBridgeBonus, description: "Bridge for low-chord endurance streams whose row-speed coverage and timing entropy exceed the ordinary speed floor." },
          { id: "marathonTechnicalEnduranceBonus", value: marathonTechnicalEnduranceBonus * 0.85, description: "Shared reward for very long high-pressure technical endurance." },
          { id: "lightChordGammaSpeedFloorBonus", value: lightChordGammaSpeedFloorBonus, description: "Gamma floor for lower-rate light-chord steady speed." },
          { id: "compactDeltaSpeedBridgeBonus", value: compactDeltaSpeedBridgeBonus, description: "Small bridge for compact low-chord speed files sitting just below the middle-delta boundary." },
          { id: "simpleHighDeltaSpeedBridgeBonus", value: simpleHighDeltaSpeedBridgeBonus, description: "Bridge for simple low-chord sustained speed just above the compact delta-speed window." },
          { id: "sustainedLightJumpstreamBonus", value: sustainedLightJumpstreamBonus, description: "Rate-scaled reward for continuous light jumpstream with high sustain and low jack pressure." },
          { id: "baseRateSubGammaStreamBonus", value: baseRateSubGammaStreamBonus, description: "Beta floor for base-rate low-chord stream sitting just below gamma speed thresholds." },
          { id: "compactModerateChordSpeedBonus", value: compactModerateChordSpeedBonus, description: "Compact moderate-chord speed reward around beta." },
          { id: "lightRowBurstStreamBonus", value: lightRowBurstStreamBonus, description: "Reward for light stream charts with frequent row bursts and varied timing." },
          { id: "longSparseStreamCompression", value: -longSparseStreamCompression, description: "Compression for long sparse dumpstreams with steady density but low chord and tech variety." },
          { id: "sparseLowSrTechVocabularyCompression", value: -sparseLowSrTechVocabularyCompression, description: "Compression for very sparse low-SR charts where timing vocabulary exceeds actual pressure." },
          { id: "lowChordBurstStreamNerf", value: -lowChordBurstStreamNerf, description: "Compression for low-chord burst streams with jack pressure." },
          { id: "variedLowChordSpeedCompression", value: -variedLowChordSpeedCompression, description: "Compression for varied low-chord speed charts where timing variety makes the endgame floor too aggressive." },
          { id: "thinLowChordSpeedCompression", value: -thinLowChordSpeedCompression, description: "Compression for thin low-chord speed files whose timing variety is present but not backed by chord density." },
          { id: "highVarietyThinStreamEdgeCompression", value: -highVarietyThinStreamEdgeCompression, description: "Compression for high-variety thin streams near the gamma/delta edge." },
          { id: "farmJumptrillStreamCompression", value: -farmJumptrillStreamCompression, description: "Compression for long farm jumptrills with non-stream difficulty profile." },
          { id: "longSparseJackDropStreamCompression", value: -longSparseJackDropStreamCompression, description: "Compression for long sparse jack-drop files." },
          { id: "shortLnHybridStructuralCompression", value: -shortLnHybridStructuralCompression, description: "Shared compression for mixed short-LN charts where LN density overstates rice dan pressure." },
          { id: "lowChordSteadySpeedStructuralCompression", value: -lowChordSteadySpeedStructuralCompression, description: "Compression for low-chord steady speed where density overstates whole-chart dan pressure." },
          { id: "moderateChordSteadyStreamStructuralCompression", value: -moderateChordSteadyStreamStructuralCompression, description: "Compression for long low-mid chord steady stream where sustained density overstates dan pressure." },
          { id: "compactHandstreamStaminaStructuralCompression", value: -compactHandstreamStaminaStructuralCompression, description: "Compression for compact handstream stamina where chord changes overstate dan pressure." },
          { id: "compactTechnicalFlowStructuralCompression", value: -compactTechnicalFlowStructuralCompression * 0.6, description: "Shared compression for compact technical flow whose local chord changes overstate dan pressure." },
          { id: "compactChordWallStructuralCompression", value: -compactChordWallStructuralCompression, description: "Compression for compact high-chord wall-jacks with limited whole-chart pressure." },
          { id: "simpleDenseChordWallStructuralCompression", value: -simpleDenseChordWallStructuralCompression, description: "Compression for simple dense chord walls with very low row-flow variety." },
          { id: "lowRateDenseChordWallCompression", value: -lowRateDenseChordWallCompression, description: "Compression for low-rate dense chord walls whose chord density overstates dan pressure before sustained speed arrives." },
          { id: "simpleMidHighChordWallStructuralCompression", value: -simpleMidHighChordWallStructuralCompression, description: "Compression for simple mid-high chord walls whose chord density overstates jack dan pressure." },
          { id: "awkwardMidRateChordjackWallCompression", value: -awkwardMidRateChordjackWallCompression, description: "Compression for mid-rate chordjack walls whose awkwardness is real but overpromoted below full-rate pressure." },
          { id: "midHighChordSustainedTechStructuralCompression", value: -midHighChordSustainedTechStructuralCompression * 0.85, description: "Compression for sustained mid-high chord tech walls where row flow is simpler than the pressure estimate." },
          { id: "shortDenseWallSrCompression", value: -shortDenseWallSrCompression, description: "Shared compression for short dense wall-jack files." },
          { id: "lowSrShortDenseWallCompression", value: -lowSrShortDenseWallCompression, description: "Shared compression for lower-SR short wall-jack files." },
          { id: "mediumWallJackOverrateCompression", value: -mediumWallJackOverrateCompression, description: "Shared compression for medium wall-jack files." },
          { id: "compactPureChordjackStaminaCompression", value: -compactPureChordjackStaminaCompression, description: "Shared compression for compact pure chordjack stamina files." },
          { id: "shortSimpleChordjackWallStructuralCompression", value: -shortSimpleChordjackWallStructuralCompression, description: "Compression for short simple chordjack walls where chord density overstates dan pressure." },
          { id: "shortSpikeCompression", value: -shortSpikeCompression, description: "Compression for files whose pressure is concentrated in one short spike." },
          { id: "localizedJumptrillSpikeCompression", value: -localizedJumptrillSpikeCompression, description: "Compression for maps whose hardest 5s jumptrill or vibro section is much denser than the surrounding file." },
        ],
        jumpstream: [
          { id: "base", value: base, description: "Base pressure estimate from extracted density and stamina." },
          { id: "jumpstreamBonus", value: jumpstreamBonus, description: "Sustained two-note chord stream pressure." },
          { id: "sustainedLightJumpstreamBonus", value: sustainedLightJumpstreamBonus, description: "Rate-scaled reward for continuous light jumpstream with high sustain and low jack pressure." },
          { id: "compactModerateChordSpeedBonus", value: compactModerateChordSpeedBonus * 0.75, description: "Compact moderate-chord speed reward around beta." },
          { id: "speedEnduranceBonus", value: speedEnduranceBonus * 0.35, description: "Shared endurance reward for fast sustained chorded streams." },
          { id: "longSteadyStreamBonus", value: longSteadyStreamBonus * 0.35, description: "Shared reward for long steady chorded stream coverage." },
          { id: "lowRateMidChordJackCompression", value: -lowRateMidChordJackCompression * 0.5, description: "Compression for low-rate mid-chord jack files where jack pressure overstates dan level." },
          { id: "compactHandstreamStaminaStructuralCompression", value: -compactHandstreamStaminaStructuralCompression * 0.65, description: "Compression when the chart reads more like compact handstream stamina than jumpstream." },
          { id: "compactTechnicalFlowStructuralCompression", value: -compactTechnicalFlowStructuralCompression * 0.7, description: "Shared compression for compact technical flow whose local chord changes overstate dan pressure." },
          { id: "compactChordWallStructuralCompression", value: -compactChordWallStructuralCompression, description: "Compression for compact high-chord wall-jacks with limited whole-chart pressure." },
          { id: "simpleDenseChordWallStructuralCompression", value: -simpleDenseChordWallStructuralCompression, description: "Compression for simple dense chord walls with very low row-flow variety." },
          { id: "shortSpikeCompression", value: -shortSpikeCompression, description: "Compression for files whose pressure is concentrated in one short spike." },
        ],
        handstream: [
          { id: "base", value: base, description: "Base pressure estimate from extracted density and stamina." },
          { id: "handstreamBonus", value: handstreamBonus, description: "Mid-chord sustained stream pressure." },
          { id: "fastMidChordHandstreamBridgeBonus", value: fastMidChordHandstreamBridgeBonus, description: "Bridge for fast mid-chord handstream with sustained row coverage." },
          { id: "marathonTechnicalEnduranceBonus", value: marathonTechnicalEnduranceBonus * 0.7, description: "Shared reward for very long high-pressure technical endurance." },
          { id: "moderateMidChordStaminaNerf", value: -moderateMidChordStaminaNerf * 0.25, description: "Shared mid-chord stamina compression." },
          { id: "highEndMidChordStaminaNerf", value: -highEndMidChordStaminaNerf * 0.35, description: "Shared high-end mid-chord stamina compression." },
          { id: "longJumpstreamStaminaCompression", value: -longJumpstreamStaminaCompression * 0.45, description: "Compression for long steady jumpstream stamina marathons with low jack pressure." },
          { id: "simpleLongJumpstreamPatternCompression", value: -simpleLongJumpstreamPatternCompression * 0.35, description: "Compression for long steady jumpstream marathons with simple timing vocabulary." },
          { id: "farmJumptrillHandstreamCompression", value: -farmJumptrillHandstreamCompression, description: "Compression for jumptrill farm patterns mistaken for handstream." },
          { id: "longSparseJackDropHandstreamCompression", value: -longSparseJackDropHandstreamCompression, description: "Compression for long sparse jack-drop files." },
          { id: "shortLnHybridStructuralCompression", value: -shortLnHybridStructuralCompression, description: "Shared compression for mixed short-LN charts where LN density overstates rice dan pressure." },
          { id: "lowChordSteadySpeedStructuralCompression", value: -lowChordSteadySpeedStructuralCompression * 0.85, description: "Compression for low-chord steady speed where density overstates whole-chart dan pressure." },
          { id: "moderateChordSteadyStreamStructuralCompression", value: -moderateChordSteadyStreamStructuralCompression, description: "Compression for long low-mid chord steady stream where sustained density overstates dan pressure." },
          { id: "compactHandstreamStaminaStructuralCompression", value: -compactHandstreamStaminaStructuralCompression, description: "Compression for compact handstream stamina where chord changes overstate dan pressure." },
          { id: "compactTechnicalFlowStructuralCompression", value: -compactTechnicalFlowStructuralCompression * 0.7, description: "Shared compression for compact technical flow whose local chord changes overstate dan pressure." },
          { id: "compactChordWallStructuralCompression", value: -compactChordWallStructuralCompression, description: "Compression for compact high-chord wall-jacks with limited whole-chart pressure." },
          { id: "simpleDenseChordWallStructuralCompression", value: -simpleDenseChordWallStructuralCompression, description: "Compression for simple dense chord walls with very low row-flow variety." },
          { id: "lowRateDenseChordWallCompression", value: -lowRateDenseChordWallCompression, description: "Compression for low-rate dense chord walls whose chord density overstates dan pressure before sustained speed arrives." },
          { id: "simpleMidHighChordWallStructuralCompression", value: -simpleMidHighChordWallStructuralCompression, description: "Compression for simple mid-high chord walls whose chord density overstates jack dan pressure." },
          { id: "awkwardMidRateChordjackWallCompression", value: -awkwardMidRateChordjackWallCompression, description: "Compression for mid-rate chordjack walls whose awkwardness is real but overpromoted below full-rate pressure." },
          { id: "midHighChordSustainedTechStructuralCompression", value: -midHighChordSustainedTechStructuralCompression, description: "Compression for sustained mid-high chord tech walls where row flow is simpler than the pressure estimate." },
          { id: "shortDenseWallSrCompression", value: -shortDenseWallSrCompression, description: "Shared compression for short dense wall-jack files." },
          { id: "lowSrShortDenseWallCompression", value: -lowSrShortDenseWallCompression, description: "Shared compression for lower-SR short wall-jack files." },
          { id: "mediumWallJackOverrateCompression", value: -mediumWallJackOverrateCompression, description: "Shared compression for medium wall-jack files." },
          { id: "compactPureChordjackStaminaCompression", value: -compactPureChordjackStaminaCompression, description: "Shared compression for compact pure chordjack stamina files." },
          { id: "shortSimpleChordjackWallStructuralCompression", value: -shortSimpleChordjackWallStructuralCompression, description: "Compression for short simple chordjack walls where chord density overstates dan pressure." },
          { id: "shortSpikeCompression", value: -shortSpikeCompression, description: "Compression for short spike-dominant files." },
          { id: "localizedJumptrillSpikeCompression", value: -localizedJumptrillSpikeCompression, description: "Compression for maps whose hardest 5s jumptrill or vibro section is much denser than the surrounding file." },
        ],
        stamina: [
          { id: "base", value: base, description: "Base pressure estimate from extracted density and stamina." },
          { id: "staminaBonus", value: staminaBonus, description: "Sustained NPS and endurance reward." },
          { id: "highSpeedEndgameBonus", value: highSpeedEndgameBonus * 0.65, description: "Shared high-speed floor for continuous low-chord endurance pressure." },
          { id: "marathonTechnicalEnduranceBonus", value: marathonTechnicalEnduranceBonus * 0.9, description: "Shared reward for very long high-pressure technical endurance." },
          { id: "moderateMidChordStaminaNerf", value: -moderateMidChordStaminaNerf, description: "Compression for slower long mid-chord stamina." },
          { id: "midChordRateCompressionNerf", value: -midChordRateCompressionNerf, description: "Compression for early mid-chord rate scaling." },
          { id: "highNoteMidRateHandstreamNerf", value: -highNoteMidRateHandstreamNerf, description: "Compression for long handstream rates before delta range." },
          { id: "highEndMidChordStaminaNerf", value: -highEndMidChordStaminaNerf, description: "Compression for high-end mid-chord stamina." },
          { id: "longJumpstreamStaminaCompression", value: -longJumpstreamStaminaCompression, description: "Compression for long steady jumpstream stamina where endurance matters but pattern density is not beta-level." },
          { id: "simpleLongJumpstreamPatternCompression", value: -simpleLongJumpstreamPatternCompression, description: "Compression for long steady jumpstream stamina with simple pattern vocabulary." },
          { id: "deltaHighMidChordTransitionNerf", value: -deltaHighMidChordTransitionNerf, description: "Transition compression around delta high handstream." },
          { id: "farmJumptrillStaminaCompression", value: -farmJumptrillStaminaCompression, description: "Compression for long jumptrill farm patterns with easy base stamina." },
          { id: "longSparseJackDropStaminaCompression", value: -longSparseJackDropStaminaCompression, description: "Compression for long sparse jack-drop files." },
          { id: "denseChordStaminaCompression", value: -denseChordStaminaCompression, description: "Compression for dense mid-chord stamina where base-rate SR overstates dan pressure." },
          { id: "lowEndLongMidChordStaminaFloorBonus", value: lowEndLongMidChordStaminaFloorBonus, description: "Small floor for long low-end mid-chord stamina files sitting on a dan boundary." },
          { id: "shortLnHybridStructuralCompression", value: -shortLnHybridStructuralCompression, description: "Shared compression for mixed short-LN charts where LN density overstates rice dan pressure." },
          { id: "lowChordSteadySpeedStructuralCompression", value: -lowChordSteadySpeedStructuralCompression * 0.9, description: "Compression for low-chord steady speed where density overstates whole-chart dan pressure." },
          { id: "moderateChordSteadyStreamStructuralCompression", value: -moderateChordSteadyStreamStructuralCompression, description: "Compression for long low-mid chord steady stream where sustained density overstates dan pressure." },
          { id: "compactHandstreamStaminaStructuralCompression", value: -compactHandstreamStaminaStructuralCompression, description: "Compression for compact handstream stamina where chord changes overstate dan pressure." },
          { id: "compactTechnicalFlowStructuralCompression", value: -compactTechnicalFlowStructuralCompression * 0.6, description: "Shared compression for compact technical flow whose local chord changes overstate dan pressure." },
          { id: "compactChordWallStructuralCompression", value: -compactChordWallStructuralCompression, description: "Compression for compact high-chord wall-jacks with limited whole-chart pressure." },
          { id: "simpleDenseChordWallStructuralCompression", value: -simpleDenseChordWallStructuralCompression, description: "Compression for simple dense chord walls with very low row-flow variety." },
          { id: "lowRateDenseChordWallCompression", value: -lowRateDenseChordWallCompression, description: "Compression for low-rate dense chord walls whose chord density overstates dan pressure before sustained speed arrives." },
          { id: "simpleMidHighChordWallStructuralCompression", value: -simpleMidHighChordWallStructuralCompression, description: "Compression for simple mid-high chord walls whose chord density overstates jack dan pressure." },
          { id: "awkwardMidRateChordjackWallCompression", value: -awkwardMidRateChordjackWallCompression, description: "Compression for mid-rate chordjack walls whose awkwardness is real but overpromoted below full-rate pressure." },
          { id: "midHighChordSustainedTechStructuralCompression", value: -midHighChordSustainedTechStructuralCompression, description: "Compression for sustained mid-high chord tech walls where row flow is simpler than the pressure estimate." },
          { id: "shortDenseWallSrCompression", value: -shortDenseWallSrCompression, description: "Shared compression for short dense wall-jack files." },
          { id: "lowSrShortDenseWallCompression", value: -lowSrShortDenseWallCompression, description: "Shared compression for lower-SR short wall-jack files." },
          { id: "mediumWallJackOverrateCompression", value: -mediumWallJackOverrateCompression, description: "Shared compression for medium wall-jack files." },
          { id: "compactPureChordjackStaminaCompression", value: -compactPureChordjackStaminaCompression, description: "Shared compression for compact pure chordjack stamina files." },
          { id: "shortSimpleChordjackWallStructuralCompression", value: -shortSimpleChordjackWallStructuralCompression, description: "Compression for short simple chordjack walls where chord density overstates dan pressure." },
          { id: "shortSpikeCompression", value: -shortSpikeCompression, description: "Compression for files with low sustained pressure relative to peak burst pressure." },
          { id: "localizedJumptrillSpikeCompression", value: -localizedJumptrillSpikeCompression, description: "Compression for maps whose hardest 5s jumptrill or vibro section is much denser than the surrounding file." },
        ],
        chordjack: [
          { id: "base", value: base, description: "Base pressure estimate from extracted density and stamina." },
          { id: "chordjackBonus", value: chordjackBonus, description: "Chordjack pressure after wall/endurance penalties." },
          { id: "extremeChordwallSpeedBonus", value: extremeChordwallSpeedBonus * 0.6, description: "Shared floor for extreme dense chordwall speed in chordjack routing." },
          { id: "lowRateChordjackWallFloorBonus", value: lowRateChordjackWallFloorBonus, description: "Floor for low-rate high-chord walls where chordjack pressure is understated." },
          { id: "marathonTechnicalEnduranceBonus", value: marathonTechnicalEnduranceBonus * 0.75, description: "Shared reward for very long high-pressure technical endurance." },
          { id: "slowRepetitiveJackstreamBonus", value: slowRepetitiveJackstreamBonus * 0.55, description: "Partial chordjack credit for slow repetitive jackstream pressure." },
          { id: "ratedRepetitiveSpeedjackBonus", value: ratedRepetitiveSpeedjackBonus * 0.55, description: "Partial chordjack credit for rate-scaled repetitive speedjack pressure." },
          { id: "midChordSpeedjackJackBonus", value: midChordSpeedjackJackBonus, description: "Reward for mid-chord speedjack pressure in chordjack-like files." },
          { id: "farmJumptrillChordjackCompression", value: -farmJumptrillChordjackCompression, description: "Compression for jumptrills that inflate chordjack pressure." },
          { id: "longSparseJackDropChordjackCompression", value: -longSparseJackDropChordjackCompression, description: "Compression for long sparse jack-drop files." },
          { id: "shortLnHybridStructuralCompression", value: -shortLnHybridStructuralCompression, description: "Shared compression for mixed short-LN charts where LN density overstates rice dan pressure." },
          { id: "lowChordSteadySpeedStructuralCompression", value: -lowChordSteadySpeedStructuralCompression * 0.8, description: "Compression for low-chord steady speed where density overstates whole-chart dan pressure." },
          { id: "moderateChordSteadyStreamStructuralCompression", value: -moderateChordSteadyStreamStructuralCompression, description: "Compression for long low-mid chord steady stream where sustained density overstates dan pressure." },
          { id: "compactHandstreamStaminaStructuralCompression", value: -compactHandstreamStaminaStructuralCompression, description: "Compression for compact handstream stamina where chord changes overstate dan pressure." },
          { id: "compactTechnicalFlowStructuralCompression", value: -compactTechnicalFlowStructuralCompression * 0.75, description: "Shared compression for compact technical flow whose local chord changes overstate dan pressure." },
          { id: "compactChordWallStructuralCompression", value: -compactChordWallStructuralCompression, description: "Compression for compact high-chord wall-jacks with limited whole-chart pressure." },
          { id: "simpleDenseChordWallStructuralCompression", value: -simpleDenseChordWallStructuralCompression, description: "Compression for simple dense chord walls with very low row-flow variety." },
          { id: "lowRateDenseChordWallCompression", value: -lowRateDenseChordWallCompression, description: "Compression for low-rate dense chord walls whose chord density overstates dan pressure before sustained speed arrives." },
          { id: "simpleMidHighChordWallStructuralCompression", value: -simpleMidHighChordWallStructuralCompression, description: "Compression for simple mid-high chord walls whose chord density overstates jack dan pressure." },
          { id: "awkwardMidRateChordjackWallCompression", value: -awkwardMidRateChordjackWallCompression, description: "Compression for mid-rate chordjack walls whose awkwardness is real but overpromoted below full-rate pressure." },
          { id: "midHighChordSustainedTechStructuralCompression", value: -midHighChordSustainedTechStructuralCompression, description: "Compression for sustained mid-high chord tech walls where row flow is simpler than the pressure estimate." },
          { id: "shortDenseWallSrCompression", value: -shortDenseWallSrCompression, description: "Shared compression for short dense wall-jack files." },
          { id: "lowSrShortDenseWallCompression", value: -lowSrShortDenseWallCompression, description: "Shared compression for lower-SR short wall-jack files." },
          { id: "mediumWallJackOverrateCompression", value: -mediumWallJackOverrateCompression, description: "Shared compression for medium wall-jack files." },
          { id: "longHighChordChordjackCompression", value: -longHighChordChordjackCompression, description: "Compression for long high-chord chordjack where SR overstates the dan jump." },
          { id: "compactPureChordjackStaminaCompression", value: -compactPureChordjackStaminaCompression, description: "Shared compression for compact pure chordjack stamina files." },
          { id: "shortSimpleChordjackWallStructuralCompression", value: -shortSimpleChordjackWallStructuralCompression, description: "Compression for short simple chordjack walls where chord density overstates dan pressure." },
          { id: "shortSpikeCompression", value: -shortSpikeCompression, description: "Compression for short spike-dominant files." },
          { id: "localizedJumptrillSpikeCompression", value: -localizedJumptrillSpikeCompression, description: "Compression for maps whose hardest 5s jumptrill or vibro section is much denser than the surrounding file." },
        ],
        tech: [
          { id: "base", value: base, description: "Base pressure estimate from extracted density and stamina." },
          { id: "techBonus", value: techBonus, description: "Direction, chord-size, burst, and density tech pressure." },
          { id: "highSpeedEndgameBonus", value: highSpeedEndgameBonus * 0.85, description: "Shared high-speed floor for technical charts whose primary pressure is still continuous speed." },
          { id: "lowChordSpeedjackAnchorBonus", value: lowChordSpeedjackAnchorBonus * 0.6, description: "Partial speedjack anchor credit when low-chord repetition presents as technical speed." },
          { id: "marathonTechnicalEnduranceBonus", value: marathonTechnicalEnduranceBonus * 0.8, description: "Shared reward for very long high-pressure technical endurance." },
          { id: "denseJackTechNerf", value: -denseJackTechNerf, description: "Tech inflation removed for short dense jack files." },
          { id: "wallJackTechNerf", value: -wallJackTechNerf, description: "Tech inflation removed for dense jack-wall repetition." },
          { id: "lowChordBurstTechNerf", value: -lowChordBurstTechNerf, description: "Tech inflation removed for low-chord burst streams." },
          { id: "variedLowChordSpeedCompression", value: -variedLowChordSpeedCompression, description: "Compression for varied low-chord speed charts where timing variety makes the endgame floor too aggressive." },
          { id: "farmJumptrillTechCompression", value: -farmJumptrillTechCompression, description: "Tech inflation removed for long jumptrill farm patterns." },
          { id: "lowSrTechnicalRhythmBonus", value: lowSrTechnicalRhythmBonus, description: "Reward for low-SR tech cuts with fast row bursts, rhythm variation, and chord-size changes." },
          { id: "lowerRateTechBridgeBonus", value: lowerRateTechBridgeBonus, description: "Bridge for low-rate tech packs whose rhythm shape is present before full burst speed arrives." },
          { id: "syncopatedChordTechBonus", value: syncopatedChordTechBonus, description: "Reward for syncopated moderate-chord tech cuts with slower note NPS but awkward row flow." },
          { id: "compactChordSwitchTechBonus", value: compactChordSwitchTechBonus, description: "Reward for compact chord-switch tech with high fast-row ratio and anchor pressure." },
          { id: "technicalAnchorBonus", value: technicalAnchorBonus, description: "Reward for moderate-chord technical anchors with strong same-column pressure." },
          { id: "highRatePackTechnicalAnchorCompression", value: -highRatePackTechnicalAnchorCompression, description: "Removes technical-anchor inflation on high-rate Crescent-like rate-pack patterns." },
          { id: "highRateTechnicalAnchorFloorBonus", value: highRateTechnicalAnchorFloorBonus, description: "Floor for high-rate technical anchors whose same-column pressure exceeds lower-rate pack calibration." },
          { id: "compactTechnicalMarathonBonus", value: compactTechnicalMarathonBonus, description: "Reward for compact technical marathons with sustained direction and chord-size pressure." },
          { id: "earlyVariedPatternTechBonus", value: earlyVariedPatternTechBonus, description: "Reward for early-dan charts with varied timing and same-column pressure." },
          { id: "compactChordFlowTechBonus", value: compactChordFlowTechBonus, description: "Reward for compact chord-flow tech with sustained direction changes." },
          { id: "fastTechnicalSpeedFloorBonus", value: fastTechnicalSpeedFloorBonus, description: "Floor for fast low-chord technical speed charts." },
          { id: "variedTechnicalAnchorBridgeBonus", value: variedTechnicalAnchorBridgeBonus, description: "Bridge for varied moderate-chord technical anchors sitting just below delta pressure." },
          { id: "lowChordTechnicalSpeedBridgeBonus", value: lowChordTechnicalSpeedBridgeBonus, description: "Bridge for low-chord technical speed charts with compact timing entropy." },
          { id: "moderateBurstTechCompression", value: -moderateBurstTechCompression, description: "Compression for mid-chord burst tech that was overpromoted by peak density alone." },
          { id: "lowDensityChordFlowTechCompression", value: -lowDensityChordFlowTechCompression, description: "Compression for low-density chord-flow charts where chord changes overstate dan pressure." },
          { id: "introHighChordFlowTechCompression", value: -introHighChordFlowTechCompression, description: "Compression for introductory high-chord flow with low row speed." },
          { id: "earlyLowEntropyTechCompression", value: -earlyLowEntropyTechCompression, description: "Compression for early low-density tech with simple row timing." },
          { id: "sparseLowSrTechVocabularyCompression", value: -sparseLowSrTechVocabularyCompression, description: "Compression for very sparse low-SR charts where timing vocabulary exceeds actual pressure." },
          { id: "lowRateTechnicalVocabularyCompression", value: -lowRateTechnicalVocabularyCompression, description: "Compression for low-rate technical rhythm where vocabulary exceeds the pressure ceiling." },
          { id: "compactHighChordTechCompression", value: -compactHighChordTechCompression, description: "Compression for compact high-chord technical marathons at the beta/gamma boundary." },
          { id: "baseRateTechCompression", value: -baseRateTechCompression, description: "Compression for Crescent-like rate packs where base-rate SR overstates the dan jump." },
          { id: "ratePackTechStructuralCompression", value: -ratePackTechStructuralCompression, description: "Compression for Crescent-like rate packs whose fast-row shape overstates whole-file tech pressure." },
          { id: "repetitiveSpeedjackTechCompression", value: -repetitiveSpeedjackTechCompression, description: "Tech inflation removed when the chart is repetitive jackstream or speedjack rather than pattern tech." },
          { id: "longSparseJackDropTechCompression", value: -longSparseJackDropTechCompression, description: "Tech inflation removed for long sparse jack-drop files." },
          { id: "shortLnHybridStructuralCompression", value: -shortLnHybridStructuralCompression, description: "Shared compression for mixed short-LN charts where LN density overstates rice dan pressure." },
          { id: "lowChordSteadySpeedStructuralCompression", value: -lowChordSteadySpeedStructuralCompression * 0.85, description: "Compression for low-chord steady speed where density overstates whole-chart dan pressure." },
          { id: "moderateChordSteadyStreamStructuralCompression", value: -moderateChordSteadyStreamStructuralCompression, description: "Compression for long low-mid chord steady stream where sustained density overstates dan pressure." },
          { id: "compactHandstreamStaminaStructuralCompression", value: -compactHandstreamStaminaStructuralCompression, description: "Compression for compact handstream stamina where chord changes overstate dan pressure." },
          { id: "compactHandstreamStaminaTechCompression", value: -compactHandstreamStaminaTechCompression, description: "Tech inflation removed for compact handstream stamina patterns." },
          { id: "compactTechnicalFlowStructuralCompression", value: -compactTechnicalFlowStructuralCompression, description: "Compression for compact technical flow whose local chord changes overstate dan pressure." },
          { id: "compactChordWallStructuralCompression", value: -compactChordWallStructuralCompression, description: "Compression for compact high-chord wall-jacks with limited whole-chart pressure." },
          { id: "simpleDenseChordWallStructuralCompression", value: -simpleDenseChordWallStructuralCompression, description: "Compression for simple dense chord walls with very low row-flow variety." },
          { id: "lowRateDenseChordWallCompression", value: -lowRateDenseChordWallCompression, description: "Compression for low-rate dense chord walls whose chord density overstates dan pressure before sustained speed arrives." },
          { id: "simpleMidHighChordWallStructuralCompression", value: -simpleMidHighChordWallStructuralCompression, description: "Compression for simple mid-high chord walls whose chord density overstates jack dan pressure." },
          { id: "awkwardMidRateChordjackWallCompression", value: -awkwardMidRateChordjackWallCompression, description: "Compression for mid-rate chordjack walls whose awkwardness is real but overpromoted below full-rate pressure." },
          { id: "midHighChordSustainedTechStructuralCompression", value: -midHighChordSustainedTechStructuralCompression, description: "Compression for sustained mid-high chord tech walls where row flow is simpler than the pressure estimate." },
          { id: "shortDenseWallSrCompression", value: -shortDenseWallSrCompression, description: "Shared compression for short dense wall-jack files." },
          { id: "lowSrShortDenseWallCompression", value: -lowSrShortDenseWallCompression, description: "Shared compression for lower-SR short wall-jack files." },
          { id: "mediumWallJackOverrateCompression", value: -mediumWallJackOverrateCompression, description: "Shared compression for medium wall-jack files." },
          { id: "midChordSpeedjackTechCompression", value: -midChordSpeedjackTechCompression, description: "Tech inflation removed from mid-chord speedjack files." },
          { id: "compactPureChordjackStaminaCompression", value: -compactPureChordjackStaminaCompression, description: "Shared compression for compact pure chordjack stamina files." },
          { id: "shortSimpleChordjackWallStructuralCompression", value: -shortSimpleChordjackWallStructuralCompression, description: "Compression for short simple chordjack walls where chord density overstates dan pressure." },
          { id: "shortSpikeCompression", value: -shortSpikeCompression, description: "Compression for tech estimates driven by a short isolated burst." },
          { id: "localizedJumptrillSpikeCompression", value: -localizedJumptrillSpikeCompression * 1.45, description: "Tech inflation removed when a localized jumptrill or vibro spike is not representative of whole-file tech pressure." },
        ],
        ln: [],
        dan: [],
      },
    },
  };
}
