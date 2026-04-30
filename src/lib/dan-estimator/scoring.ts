import { clamp01, gateWhen, minGate } from "./math";
import type { DanFeatureMetrics, DanScoringDebug, DanSkillFamily } from "./types";

const BASE_SR_CALIBRATION = {
  densityBase: 2.45,
  peak5sWeight: 0.095,
  peak1sWeight: 0.018,
  staminaBase: 2.65,
  sustained10sWeight: 0.16,
  starRatingWeight: 0.82,
  structuralWeight: 0.18,
};

export interface DanFamilyScoreResult {
  skillScores: Record<DanSkillFamily, number>;
  debug: DanScoringDebug;
}

export function estimateFamilyScores(metrics: DanFeatureMetrics, starRating: number, durationMs: number): DanFamilyScoreResult {
  const densitySr = BASE_SR_CALIBRATION.densityBase
    + metrics.peakNps5s * BASE_SR_CALIBRATION.peak5sWeight
    + metrics.peakNps1s * BASE_SR_CALIBRATION.peak1sWeight;
  const staminaSr = BASE_SR_CALIBRATION.staminaBase + metrics.sustainedNps10s * BASE_SR_CALIBRATION.sustained10sWeight;
  const structuralSr = Math.max(densitySr, staminaSr);
  const base = starRating > 0
    ? starRating * BASE_SR_CALIBRATION.starRatingWeight + structuralSr * BASE_SR_CALIBRATION.structuralWeight
    : structuralSr;
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
  const lowSrSpeedUnderrateBonus = metrics.chordRatio >= 0.18
    && metrics.chordRatio <= 0.3
    && metrics.sustainedNps10s >= 25
    && metrics.peakNps5s >= 26
    && metrics.jackPressure < 165
    && starRating > 0
    && starRating < 6.5
    ? Math.min(
      0.54,
      Math.max(0, 6.6 - starRating) * 0.54
        + Math.max(0, metrics.sustainedNps10s - 25) * 0.045
        + Math.max(0, metrics.peakNps5s - 26) * 0.035,
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
  const lowSrTechnicalRhythmGate = lowSrTechnicalRhythmShapeGate
    * (starRating > 6 ? 0.72 : 1);
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
  const denseJackSrCompression = denseJackFileGate
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
  const lowRateHighChordJackBonus = metrics.noteCount >= 1800
    && metrics.noteCount <= 2700
    && metrics.chordRatio >= 0.8
    && metrics.holdRatio < 0.16
    && metrics.jackPressure >= 150
    && metrics.jackPressure <= 165
    && metrics.sustainedNps10s >= 27
    && starRating >= 5.9
    && starRating <= 6.8
    && (starRating <= 6.55 || metrics.holdRatio >= 0.08)
    ? Math.min(
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
      0.5,
      Math.max(0, metrics.peakNps1s - 36) * 0.045
        + Math.max(0, metrics.jackPressure - 135) * 0.003
        + Math.max(0, 0.28 - metrics.chordRatio) * 0.25,
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
  const streamBonus = Math.min(1.65, Math.max(0, metrics.streamPressure / 16) + Math.max(0, metrics.peakNps5s - 25) * 0.008 + speedBonus + pureSpeedBonus + lowChordSustainedSpeedBonus + longLowChordSpeedBonus + lightChordGammaSpeedFloorBonus + lowSrSpeedUnderrateBonus + sustainedLightJumpstreamBonus + baseRateSubGammaStreamBonus + compactModerateChordSpeedBonus + speedEnduranceBonus + longSteadyStreamBonus);
  const staminaBonus = Math.min(1.45, Math.max(0, metrics.sustainedNps10s - 23) * 0.018 + Math.min(0.16, metrics.noteCount / 16000) + speedBonus * 0.8 + staminaEnduranceBonus + longSteadyStreamBonus * 0.45 + fastLongMidChordStaminaGate * 0.02 - longMidChordSrNerf * 0.6 + Math.max(0, longMidChordStaminaMapGate - cyberLikeStaminaGate) * 0.28);
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
        + technicalAnchorBonus,
    )
      - highChordGate * 0.7
      - denseChordWallGate * 0.55
      - shortDenseChordWallPenalty * 1.55
      - highRateShortDenseChordWallPenalty * 1.65
      - steadySpeedMapGate * 0.58
      - longEnduranceMapGate * 0.75
      - longMidChordStaminaMapGate * 0.8
      - moderateBurstTechCompression,
  );

  const skillScores: Record<DanSkillFamily, number> = {
    jack: (base + jackBonus + lowSrDenseWallJackBonus + compactJackUnderrateBonus + lowRateHighChordJackBonus + slowRepetitiveJackstreamBonus + ratedRepetitiveSpeedjackBonus + compactHighChordDeltaJackBonus + denseWallJackPenaltyRelief + midChordSpeedjackJackBonus + longGammaHighChordjackFloorBonus + heldLongGammaHighChordjackFloorBonus - highChordSoftJackPenalty - denseJackSrCompression - mediumWallJackSrCompression - compactJackOverboostCompression - farmJumptrillJackCompression - longSparseJackDropJackCompression - shortDenseWallSrCompression - mediumWallJackOverrateCompression - midHighChordGammaCompression - shortSpikeCompression) * lnNerf,
    stream: (base + streamBonus - lowChordBurstStreamNerf - farmJumptrillStreamCompression - longSparseJackDropStreamCompression - shortDenseWallSrCompression - mediumWallJackOverrateCompression - midHighChordGammaCompression - shortSpikeCompression) * lnNerf,
    handstream: (base + handstreamBonus - moderateMidChordStaminaNerf * 0.25 - highEndMidChordStaminaNerf * 0.35 - longJumpstreamStaminaCompression * 0.45 - farmJumptrillHandstreamCompression - longSparseJackDropHandstreamCompression - shortDenseWallSrCompression - mediumWallJackOverrateCompression - midHighChordGammaCompression - shortSpikeCompression) * lnNerf,
    stamina: (base + staminaBonus + lowEndLongMidChordStaminaFloorBonus - moderateMidChordStaminaNerf - midChordRateCompressionNerf - highNoteMidRateHandstreamNerf - highEndMidChordStaminaNerf - longJumpstreamStaminaCompression - deltaHighMidChordTransitionNerf - farmJumptrillStaminaCompression - longSparseJackDropStaminaCompression - denseChordStaminaCompression - shortDenseWallSrCompression - mediumWallJackOverrateCompression - midHighChordGammaCompression - shortSpikeCompression) * lnNerf,
    chordjack: (base + chordjackBonus + slowRepetitiveJackstreamBonus * 0.55 + ratedRepetitiveSpeedjackBonus * 0.55 + midChordSpeedjackJackBonus + longGammaHighChordjackFloorBonus + heldLongGammaHighChordjackFloorBonus - farmJumptrillChordjackCompression - longSparseJackDropChordjackCompression - shortDenseWallSrCompression - mediumWallJackOverrateCompression - longHighChordChordjackCompression - midHighChordGammaCompression - shortSpikeCompression) * lnNerf,
    tech: (base + techBonus - baseRateTechCompression - repetitiveSpeedjackTechCompression - denseJackTechNerf - wallJackTechNerf - lowChordBurstTechNerf - farmJumptrillTechCompression - longSparseJackDropTechCompression - shortDenseWallSrCompression - mediumWallJackOverrateCompression - midChordSpeedjackTechCompression - midHighChordGammaCompression - shortSpikeCompression) * lnNerf,
    ln: 0,
    dan: 0,
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
    longJumpstreamStaminaCompressionGate: longJumpstreamStaminaCompression > 0 ? longJumpstreamStaminaCompression / 0.38 : 0,
    midChordSpeedjackGate,
    farmJumptrillGate,
    ratedVibroJumptrillGate,
    lowSrTechnicalRhythmGate,
    ratePackTechShapeGate,
    syncopatedChordTechGate,
    compactChordSwitchTechGate,
    technicalAnchorGate,
    shortSpikeGate,
  };
  const terms = {
    speedBonus,
    pureSpeedBonus,
    lowChordSustainedSpeedBonus,
    longLowChordSpeedBonus,
    lightChordGammaSpeedFloorBonus,
    lowSrSpeedUnderrateBonus,
    sustainedLightJumpstreamBonus,
    baseRateSubGammaStreamBonus,
    compactModerateChordSpeedBonus,
    speedEnduranceBonus,
    staminaEnduranceBonus,
    longSteadyStreamBonus,
    burstTechBonus,
    lowSrTechnicalRhythmBonus,
    lowerRateTechBridgeBonus,
    baseRateTechCompression,
    syncopatedChordTechBonus,
    compactChordSwitchTechBonus,
    technicalAnchorBonus,
    moderateBurstTechCompression,
    shortSpikeCompression,
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
    deltaHighMidChordTransitionNerf,
    longSparseJackDropJackCompression,
    longSparseJackDropStreamCompression,
    longSparseJackDropHandstreamCompression,
    longSparseJackDropStaminaCompression,
    longSparseJackDropChordjackCompression,
    longSparseJackDropTechCompression,
    denseChordStaminaCompression,
    shortDenseWallSrCompression,
    mediumWallJackOverrateCompression,
    longHighChordChordjackCompression,
    midChordSpeedjackJackBonus,
    midChordSpeedjackTechCompression,
    longGammaHighChordjackFloorBonus,
    heldLongGammaHighChordjackFloorBonus,
    midHighChordGammaCompression,
    lowEndLongMidChordStaminaFloorBonus,
    jackBonus,
    streamBonus,
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
          { id: "base", value: base, description: "Base SR blend from star rating and structural density." },
          { id: "jackBonus", value: jackBonus, description: "Jack pressure and high-chord jack reward." },
          { id: "midChordSpeedjackJackBonus", value: midChordSpeedjackJackBonus, description: "Reward for mid-chord speedjack pressure that should route as jack instead of tech." },
          { id: "lowSrDenseWallJackBonus", value: lowSrDenseWallJackBonus, description: "Dense wall-jack reward where SR underrates slow high-chord repetition." },
          { id: "compactJackUnderrateBonus", value: compactJackUnderrateBonus, description: "Compact dense jack files around gamma that SR tends to underrate." },
          { id: "lowRateHighChordJackBonus", value: lowRateHighChordJackBonus, description: "High-chord lower-rate jack reward for gamma-range files." },
          { id: "slowRepetitiveJackstreamBonus", value: slowRepetitiveJackstreamBonus, description: "Reward for slow repetitive jackstream where row timing is simple but same-column pressure is high." },
          { id: "ratedRepetitiveSpeedjackBonus", value: ratedRepetitiveSpeedjackBonus, description: "Reward for rate-scaled repetitive speedjack pressure that should stay in the jack family." },
          { id: "compactHighChordDeltaJackBonus", value: compactHighChordDeltaJackBonus, description: "Compact high-chord wall-jack reward around low delta." },
          { id: "denseWallJackPenaltyRelief", value: denseWallJackPenaltyRelief, description: "Restores high-chord wall penalty when same-column jack pressure is present at lower SR." },
          { id: "highChordSoftJackPenalty", value: -highChordSoftJackPenalty, description: "Penalty for chord walls without enough jack pressure." },
          { id: "denseJackSrCompression", value: -denseJackSrCompression, description: "Compression for short dense jack files at high SR." },
          { id: "mediumWallJackSrCompression", value: -mediumWallJackSrCompression, description: "Compression for medium wall-jacks where SR overstates dan pressure." },
          { id: "compactJackOverboostCompression", value: -compactJackOverboostCompression, description: "Trims compact jack boost when higher-rate pressure is already represented." },
          { id: "farmJumptrillJackCompression", value: -farmJumptrillJackCompression, description: "Compression for long farm jumptrills that only become vibro-like under rate." },
          { id: "longSparseJackDropJackCompression", value: -longSparseJackDropJackCompression, description: "Compression for long files whose difficulty is concentrated in jack drops rather than full-chart dan pressure." },
          { id: "shortDenseWallSrCompression", value: -shortDenseWallSrCompression, description: "Compression for short dense wall-jack files where SR overstates dan pressure." },
          { id: "mediumWallJackOverrateCompression", value: -mediumWallJackOverrateCompression, description: "Compression for medium wall-jacks where jack pressure is already represented by SR." },
          { id: "shortSpikeCompression", value: -shortSpikeCompression, description: "Compression for files whose difficulty is mostly a short isolated spike." },
        ],
        stream: [
          { id: "base", value: base, description: "Base SR blend from star rating and structural density." },
          { id: "streamBonus", value: streamBonus, description: "Speed and sustained stream pressure." },
          { id: "lightChordGammaSpeedFloorBonus", value: lightChordGammaSpeedFloorBonus, description: "Gamma floor for lower-rate light-chord steady speed." },
          { id: "sustainedLightJumpstreamBonus", value: sustainedLightJumpstreamBonus, description: "Rate-scaled reward for continuous light jumpstream with high sustain and low jack pressure." },
          { id: "baseRateSubGammaStreamBonus", value: baseRateSubGammaStreamBonus, description: "Beta floor for base-rate low-chord stream sitting just below gamma speed thresholds." },
          { id: "compactModerateChordSpeedBonus", value: compactModerateChordSpeedBonus, description: "Compact moderate-chord speed reward around beta." },
          { id: "lowChordBurstStreamNerf", value: -lowChordBurstStreamNerf, description: "Compression for low-chord burst streams with jack pressure." },
          { id: "farmJumptrillStreamCompression", value: -farmJumptrillStreamCompression, description: "Compression for long farm jumptrills with non-stream difficulty profile." },
          { id: "longSparseJackDropStreamCompression", value: -longSparseJackDropStreamCompression, description: "Compression for long sparse jack-drop files." },
          { id: "shortDenseWallSrCompression", value: -shortDenseWallSrCompression, description: "Shared compression for short dense wall-jack files." },
          { id: "mediumWallJackOverrateCompression", value: -mediumWallJackOverrateCompression, description: "Shared compression for medium wall-jack files." },
          { id: "shortSpikeCompression", value: -shortSpikeCompression, description: "Compression for files whose pressure is concentrated in one short spike." },
        ],
        handstream: [
          { id: "base", value: base, description: "Base SR blend from star rating and structural density." },
          { id: "handstreamBonus", value: handstreamBonus, description: "Mid-chord sustained stream pressure." },
          { id: "moderateMidChordStaminaNerf", value: -moderateMidChordStaminaNerf * 0.25, description: "Shared mid-chord stamina compression." },
          { id: "highEndMidChordStaminaNerf", value: -highEndMidChordStaminaNerf * 0.35, description: "Shared high-end mid-chord stamina compression." },
          { id: "longJumpstreamStaminaCompression", value: -longJumpstreamStaminaCompression * 0.45, description: "Compression for long steady jumpstream stamina marathons with low jack pressure." },
          { id: "farmJumptrillHandstreamCompression", value: -farmJumptrillHandstreamCompression, description: "Compression for jumptrill farm patterns mistaken for handstream." },
          { id: "longSparseJackDropHandstreamCompression", value: -longSparseJackDropHandstreamCompression, description: "Compression for long sparse jack-drop files." },
          { id: "shortDenseWallSrCompression", value: -shortDenseWallSrCompression, description: "Shared compression for short dense wall-jack files." },
          { id: "mediumWallJackOverrateCompression", value: -mediumWallJackOverrateCompression, description: "Shared compression for medium wall-jack files." },
          { id: "shortSpikeCompression", value: -shortSpikeCompression, description: "Compression for short spike-dominant files." },
        ],
        stamina: [
          { id: "base", value: base, description: "Base SR blend from star rating and structural density." },
          { id: "staminaBonus", value: staminaBonus, description: "Sustained NPS and endurance reward." },
          { id: "moderateMidChordStaminaNerf", value: -moderateMidChordStaminaNerf, description: "Compression for slower long mid-chord stamina." },
          { id: "midChordRateCompressionNerf", value: -midChordRateCompressionNerf, description: "Compression for early mid-chord rate scaling." },
          { id: "highNoteMidRateHandstreamNerf", value: -highNoteMidRateHandstreamNerf, description: "Compression for long handstream rates before delta range." },
          { id: "highEndMidChordStaminaNerf", value: -highEndMidChordStaminaNerf, description: "Compression for high-end mid-chord stamina." },
          { id: "longJumpstreamStaminaCompression", value: -longJumpstreamStaminaCompression, description: "Compression for long steady jumpstream stamina where endurance matters but pattern density is not beta-level." },
          { id: "deltaHighMidChordTransitionNerf", value: -deltaHighMidChordTransitionNerf, description: "Transition compression around delta high handstream." },
          { id: "farmJumptrillStaminaCompression", value: -farmJumptrillStaminaCompression, description: "Compression for long jumptrill farm patterns with easy base stamina." },
          { id: "longSparseJackDropStaminaCompression", value: -longSparseJackDropStaminaCompression, description: "Compression for long sparse jack-drop files." },
          { id: "denseChordStaminaCompression", value: -denseChordStaminaCompression, description: "Compression for dense mid-chord stamina where base-rate SR overstates dan pressure." },
          { id: "lowEndLongMidChordStaminaFloorBonus", value: lowEndLongMidChordStaminaFloorBonus, description: "Small floor for long low-end mid-chord stamina files sitting on a dan boundary." },
          { id: "shortDenseWallSrCompression", value: -shortDenseWallSrCompression, description: "Shared compression for short dense wall-jack files." },
          { id: "mediumWallJackOverrateCompression", value: -mediumWallJackOverrateCompression, description: "Shared compression for medium wall-jack files." },
          { id: "shortSpikeCompression", value: -shortSpikeCompression, description: "Compression for files with low sustained pressure relative to peak burst pressure." },
        ],
        chordjack: [
          { id: "base", value: base, description: "Base SR blend from star rating and structural density." },
          { id: "chordjackBonus", value: chordjackBonus, description: "Chordjack pressure after wall/endurance penalties." },
          { id: "slowRepetitiveJackstreamBonus", value: slowRepetitiveJackstreamBonus * 0.55, description: "Partial chordjack credit for slow repetitive jackstream pressure." },
          { id: "ratedRepetitiveSpeedjackBonus", value: ratedRepetitiveSpeedjackBonus * 0.55, description: "Partial chordjack credit for rate-scaled repetitive speedjack pressure." },
          { id: "midChordSpeedjackJackBonus", value: midChordSpeedjackJackBonus, description: "Reward for mid-chord speedjack pressure in chordjack-like files." },
          { id: "farmJumptrillChordjackCompression", value: -farmJumptrillChordjackCompression, description: "Compression for jumptrills that inflate chordjack pressure." },
          { id: "longSparseJackDropChordjackCompression", value: -longSparseJackDropChordjackCompression, description: "Compression for long sparse jack-drop files." },
          { id: "shortDenseWallSrCompression", value: -shortDenseWallSrCompression, description: "Shared compression for short dense wall-jack files." },
          { id: "mediumWallJackOverrateCompression", value: -mediumWallJackOverrateCompression, description: "Shared compression for medium wall-jack files." },
          { id: "longHighChordChordjackCompression", value: -longHighChordChordjackCompression, description: "Compression for long high-chord chordjack where SR overstates the dan jump." },
          { id: "shortSpikeCompression", value: -shortSpikeCompression, description: "Compression for short spike-dominant files." },
        ],
        tech: [
          { id: "base", value: base, description: "Base SR blend from star rating and structural density." },
          { id: "techBonus", value: techBonus, description: "Direction, chord-size, burst, and density tech pressure." },
          { id: "denseJackTechNerf", value: -denseJackTechNerf, description: "Tech inflation removed for short dense jack files." },
          { id: "wallJackTechNerf", value: -wallJackTechNerf, description: "Tech inflation removed for dense jack-wall repetition." },
          { id: "lowChordBurstTechNerf", value: -lowChordBurstTechNerf, description: "Tech inflation removed for low-chord burst streams." },
          { id: "farmJumptrillTechCompression", value: -farmJumptrillTechCompression, description: "Tech inflation removed for long jumptrill farm patterns." },
          { id: "lowSrTechnicalRhythmBonus", value: lowSrTechnicalRhythmBonus, description: "Reward for low-SR tech cuts with fast row bursts, rhythm variation, and chord-size changes." },
          { id: "lowerRateTechBridgeBonus", value: lowerRateTechBridgeBonus, description: "Bridge for low-rate tech packs whose rhythm shape is present before full burst speed arrives." },
          { id: "syncopatedChordTechBonus", value: syncopatedChordTechBonus, description: "Reward for syncopated moderate-chord tech cuts with slower note NPS but awkward row flow." },
          { id: "compactChordSwitchTechBonus", value: compactChordSwitchTechBonus, description: "Reward for compact chord-switch tech with high fast-row ratio and anchor pressure." },
          { id: "technicalAnchorBonus", value: technicalAnchorBonus, description: "Reward for moderate-chord technical anchors with strong same-column pressure." },
          { id: "moderateBurstTechCompression", value: -moderateBurstTechCompression, description: "Compression for mid-chord burst tech that was overpromoted by peak density alone." },
          { id: "baseRateTechCompression", value: -baseRateTechCompression, description: "Compression for Crescent-like rate packs where base-rate SR overstates the dan jump." },
          { id: "repetitiveSpeedjackTechCompression", value: -repetitiveSpeedjackTechCompression, description: "Tech inflation removed when the chart is repetitive jackstream or speedjack rather than pattern tech." },
          { id: "longSparseJackDropTechCompression", value: -longSparseJackDropTechCompression, description: "Tech inflation removed for long sparse jack-drop files." },
          { id: "shortDenseWallSrCompression", value: -shortDenseWallSrCompression, description: "Shared compression for short dense wall-jack files." },
          { id: "mediumWallJackOverrateCompression", value: -mediumWallJackOverrateCompression, description: "Shared compression for medium wall-jack files." },
          { id: "midChordSpeedjackTechCompression", value: -midChordSpeedjackTechCompression, description: "Tech inflation removed from mid-chord speedjack files." },
          { id: "shortSpikeCompression", value: -shortSpikeCompression, description: "Compression for tech estimates driven by a short isolated burst." },
        ],
        ln: [],
        dan: [],
      },
    },
  };
}
