import type { ManiaBeatmap, ManiaNote } from "./beatmap-parser";

export type DanSkillFamily = "jack" | "stream" | "handstream" | "stamina" | "chordjack" | "tech" | "dan";
export type DanPrimaryFamily = Exclude<DanSkillFamily, "dan" | "handstream">;

export interface DanEstimateInput {
  starRating?: number;
  totalLength?: number;
  title?: string;
  version?: string;
  rate?: number;
}

export interface DanEstimate {
  label: string;
  variant: string | null;
  displayName: string;
  rawDan: number;
  estimatedSr: number;
  family: DanSkillFamily;
  confidence: number;
  metrics: {
    keyCount: number;
    noteCount: number;
    holdRatio: number;
    chordRatio: number;
    peakNps1s: number;
    peakNps5s: number;
    sustainedNps10s: number;
    jackPressure: number;
    streamPressure: number;
    chordjackPressure: number;
    techPressure: number;
    rowBurstPressure: number;
    fastRowRatio: number;
    rowIntervalEntropy: number;
    chordSizeChangeRate: number;
    directionChangeRate: number;
    staminaPressure: number;
  };
  skillScores: Record<DanSkillFamily, number>;
  warnings: string[];
  debug?: DanEstimateDebug;
}

export interface DanEstimateDebug {
  scoring: DanScoringDebug;
  familyChoice: DanFamilyChoiceDebug;
}

export interface DanScoringDebug {
  densitySr: number;
  staminaSr: number;
  structuralSr: number;
  base: number;
  lnNerf: number;
  gates: Record<string, number>;
  terms: Record<string, number>;
  contributions: Record<DanSkillFamily, DanScoreContribution[]>;
}

export interface DanScoreContribution {
  id: string;
  value: number;
  description: string;
}

export interface DanFamilyChoiceDebug {
  topFamily: DanPrimaryFamily;
  topScore: number;
  selectedFamily: DanPrimaryFamily;
  reason: string;
}

const DAN_LABELS = [
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
  "alpha",
  "beta",
  "gamma",
  "delta",
  "epsilon",
  "zeta",
  "eta",
  "theta",
  "iota",
  "kappa",
];

const MAX_SUPPORTED_DAN_INDEX = DAN_LABELS.indexOf("eta");

const DAN_MEANS: Record<DanPrimaryFamily, number[]> = {
  jack: [3.15, 3.55, 3.95, 4.35, 4.75, 5.15, 5.45, 5.7, 5.92, 6.1, 6.35, 6.75, 7.15, 7.65, 8.25, 8.85, 9.55, 10.25, 11.0, 11.8],
  stream: [3.1, 3.5, 3.9, 4.3, 4.7, 5.05, 5.35, 5.6, 5.78, 5.92, 6.12, 6.5, 6.92, 7.42, 8.08, 8.8, 9.65, 10.42, 11.2, 12.0],
  stamina: [3.2, 3.6, 4.0, 4.4, 4.8, 5.15, 5.45, 5.72, 5.92, 6.08, 6.3, 6.7, 7.12, 7.62, 8.28, 8.98, 9.78, 10.52, 11.26, 12.0],
  chordjack: [3.2, 3.6, 4.0, 4.42, 4.82, 5.18, 5.48, 5.75, 5.95, 6.12, 6.35, 6.75, 7.15, 7.65, 8.25, 8.85, 9.55, 10.25, 11.0, 11.8],
  tech: [3.25, 3.65, 4.05, 4.48, 4.88, 5.25, 5.55, 5.82, 6.02, 6.18, 6.42, 6.82, 7.22, 7.72, 8.35, 9.02, 9.8, 10.52, 11.26, 12.0],
};

const PRIMARY_FAMILIES: DanPrimaryFamily[] = ["jack", "stream", "stamina", "chordjack", "tech"];

const BASE_SR_CALIBRATION = {
  densityBase: 2.45,
  peak5sWeight: 0.095,
  peak1sWeight: 0.018,
  staminaBase: 2.65,
  sustained10sWeight: 0.16,
  starRatingWeight: 0.82,
  structuralWeight: 0.18,
};

function getInputRate(input: DanEstimateInput): number {
  const rate = Number(input.rate);
  return Number.isFinite(rate) && rate > 0.4 && rate < 2.5 ? rate : 1;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function gateWhen(condition: boolean, value: number): number {
  return condition ? value : 0;
}

function minGate(...values: number[]): number {
  return clamp01(Math.min(...values));
}

function quantile(values: number[], q: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * q)));
  return sorted[index];
}

function countInWindow(times: number[], windowMs: number): number {
  let best = 0;
  let start = 0;
  for (let end = 0; end < times.length; end++) {
    while (times[end] - times[start] > windowMs) start++;
    best = Math.max(best, end - start + 1);
  }
  return best;
}

function average(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function bucketEntropy(values: number[], bucketSize: number): number {
  if (!values.length || bucketSize <= 0) return 0;
  const buckets = new Map<number, number>();
  for (const value of values) {
    const bucket = Math.round(value / bucketSize) * bucketSize;
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
  }

  let entropy = 0;
  for (const count of buckets.values()) {
    const probability = count / values.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function srToRawDan(sr: number, family: DanPrimaryFamily): number {
  const means = DAN_MEANS[family];
  const maxIndex = MAX_SUPPORTED_DAN_INDEX >= 0 ? MAX_SUPPORTED_DAN_INDEX : DAN_LABELS.length - 1;
  const cappedMeans = means.slice(0, maxIndex + 1);
  const boundaries = cappedMeans.map((mean, index) => {
    const lower = index === 0 ? mean - (cappedMeans[index + 1] - mean) / 2 : (cappedMeans[index - 1] + mean) / 2;
    const upper = index === cappedMeans.length - 1 ? mean + (mean - cappedMeans[index - 1]) / 2 : (mean + cappedMeans[index + 1]) / 2;
    return { lower, upper, level: index + 1 };
  });

  if (sr < boundaries[0].lower) return 1;
  const last = boundaries[boundaries.length - 1];
  if (sr >= last.upper) return maxIndex + 1;

  for (const boundary of boundaries) {
    if (sr >= boundary.lower && sr < boundary.upper) {
      const t = (sr - boundary.lower) / Math.max(0.001, boundary.upper - boundary.lower);
      return boundary.level + t - 0.5;
    }
  }

  return 1;
}

function parseDan(rawDan: number) {
  const maxLevel = (MAX_SUPPORTED_DAN_INDEX >= 0 ? MAX_SUPPORTED_DAN_INDEX : DAN_LABELS.length - 1) + 1;
  const level = Math.min(maxLevel, Math.max(1, Math.round(rawDan)));
  const offset = rawDan - level;
  const variant = offset <= -0.3 ? "--" : offset <= -0.1 ? "-" : offset < 0.1 ? null : offset < 0.3 ? "+" : "++";
  const label = DAN_LABELS[level - 1];
  return {
    label,
    variant,
    displayName: `${label}${variant ?? ""}`,
  };
}

interface DanFamilyScoreResult {
  skillScores: Record<DanSkillFamily, number>;
  debug: DanScoringDebug;
}

function estimateFamilyScores(metrics: DanEstimate["metrics"], starRating: number, durationMs: number): DanFamilyScoreResult {
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
    && starRating <= 6.15;
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
    && metrics.holdRatio < 0.08
    && metrics.jackPressure >= 150
    && metrics.jackPressure <= 165
    && metrics.sustainedNps10s >= 27
    && starRating >= 5.9
    && starRating <= 6.55
    ? Math.min(
      0.34,
      0.12
        + Math.max(0, metrics.sustainedNps10s - 27) * 0.04
        + Math.max(0, metrics.chordRatio - 0.8) * 0.15
        + Math.max(0, 6.55 - starRating) * 0.25,
    )
    : 0;
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
  const jackBonus = Math.min(0.82, Math.max(0, (metrics.jackPressure - 92) / 240) + chordGate * 0.12 + highChordJackBonus);
  const streamBonus = Math.min(1.65, Math.max(0, metrics.streamPressure / 16) + Math.max(0, metrics.peakNps5s - 25) * 0.008 + speedBonus + pureSpeedBonus + lowChordSustainedSpeedBonus + longLowChordSpeedBonus + lightChordGammaSpeedFloorBonus + lowSrSpeedUnderrateBonus + baseRateSubGammaStreamBonus + compactModerateChordSpeedBonus + speedEnduranceBonus + longSteadyStreamBonus);
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
    jack: (base + jackBonus + lowSrDenseWallJackBonus + compactJackUnderrateBonus + lowRateHighChordJackBonus + compactHighChordDeltaJackBonus + denseWallJackPenaltyRelief - highChordSoftJackPenalty - denseJackSrCompression - mediumWallJackSrCompression - compactJackOverboostCompression - farmJumptrillJackCompression) * lnNerf,
    stream: (base + streamBonus - lowChordBurstStreamNerf - farmJumptrillStreamCompression) * lnNerf,
    handstream: (base + handstreamBonus - moderateMidChordStaminaNerf * 0.25 - highEndMidChordStaminaNerf * 0.35 - farmJumptrillHandstreamCompression) * lnNerf,
    stamina: (base + staminaBonus - moderateMidChordStaminaNerf - midChordRateCompressionNerf - highNoteMidRateHandstreamNerf - highEndMidChordStaminaNerf - deltaHighMidChordTransitionNerf - farmJumptrillStaminaCompression) * lnNerf,
    chordjack: (base + chordjackBonus - farmJumptrillChordjackCompression) * lnNerf,
    tech: (base + techBonus - denseJackTechNerf - wallJackTechNerf - lowChordBurstTechNerf - farmJumptrillTechCompression) * lnNerf,
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
    handstreamChordGate,
    pureSpeedGate,
    speedGate,
    chordjackEnduranceGate,
    strongJackGate,
    etaJackPressureGate,
    steadySpeedMapGate,
    longEnduranceMapGate,
    longMidChordStaminaMapGate,
    fastLongMidChordStaminaGate,
    cyberLikeStaminaGate,
    farmJumptrillGate,
    ratedVibroJumptrillGate,
    lowSrTechnicalRhythmGate,
    syncopatedChordTechGate,
    compactChordSwitchTechGate,
    technicalAnchorGate,
  };
  const terms = {
    speedBonus,
    pureSpeedBonus,
    lowChordSustainedSpeedBonus,
    longLowChordSpeedBonus,
    lightChordGammaSpeedFloorBonus,
    lowSrSpeedUnderrateBonus,
    baseRateSubGammaStreamBonus,
    compactModerateChordSpeedBonus,
    speedEnduranceBonus,
    staminaEnduranceBonus,
    longSteadyStreamBonus,
    burstTechBonus,
    lowSrTechnicalRhythmBonus,
    syncopatedChordTechBonus,
    compactChordSwitchTechBonus,
    technicalAnchorBonus,
    moderateBurstTechCompression,
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
    deltaHighMidChordTransitionNerf,
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
          { id: "lowSrDenseWallJackBonus", value: lowSrDenseWallJackBonus, description: "Dense wall-jack reward where SR underrates slow high-chord repetition." },
          { id: "compactJackUnderrateBonus", value: compactJackUnderrateBonus, description: "Compact dense jack files around gamma that SR tends to underrate." },
          { id: "lowRateHighChordJackBonus", value: lowRateHighChordJackBonus, description: "High-chord lower-rate jack reward for gamma-range files." },
          { id: "compactHighChordDeltaJackBonus", value: compactHighChordDeltaJackBonus, description: "Compact high-chord wall-jack reward around low delta." },
          { id: "denseWallJackPenaltyRelief", value: denseWallJackPenaltyRelief, description: "Restores high-chord wall penalty when same-column jack pressure is present at lower SR." },
          { id: "highChordSoftJackPenalty", value: -highChordSoftJackPenalty, description: "Penalty for chord walls without enough jack pressure." },
          { id: "denseJackSrCompression", value: -denseJackSrCompression, description: "Compression for short dense jack files at high SR." },
          { id: "mediumWallJackSrCompression", value: -mediumWallJackSrCompression, description: "Compression for medium wall-jacks where SR overstates dan pressure." },
          { id: "compactJackOverboostCompression", value: -compactJackOverboostCompression, description: "Trims compact jack boost when higher-rate pressure is already represented." },
          { id: "farmJumptrillJackCompression", value: -farmJumptrillJackCompression, description: "Compression for long farm jumptrills that only become vibro-like under rate." },
        ],
        stream: [
          { id: "base", value: base, description: "Base SR blend from star rating and structural density." },
          { id: "streamBonus", value: streamBonus, description: "Speed and sustained stream pressure." },
          { id: "lightChordGammaSpeedFloorBonus", value: lightChordGammaSpeedFloorBonus, description: "Gamma floor for lower-rate light-chord steady speed." },
          { id: "baseRateSubGammaStreamBonus", value: baseRateSubGammaStreamBonus, description: "Beta floor for base-rate low-chord stream sitting just below gamma speed thresholds." },
          { id: "compactModerateChordSpeedBonus", value: compactModerateChordSpeedBonus, description: "Compact moderate-chord speed reward around beta." },
          { id: "lowChordBurstStreamNerf", value: -lowChordBurstStreamNerf, description: "Compression for low-chord burst streams with jack pressure." },
          { id: "farmJumptrillStreamCompression", value: -farmJumptrillStreamCompression, description: "Compression for long farm jumptrills with non-stream difficulty profile." },
        ],
        handstream: [
          { id: "base", value: base, description: "Base SR blend from star rating and structural density." },
          { id: "handstreamBonus", value: handstreamBonus, description: "Mid-chord sustained stream pressure." },
          { id: "moderateMidChordStaminaNerf", value: -moderateMidChordStaminaNerf * 0.25, description: "Shared mid-chord stamina compression." },
          { id: "highEndMidChordStaminaNerf", value: -highEndMidChordStaminaNerf * 0.35, description: "Shared high-end mid-chord stamina compression." },
          { id: "farmJumptrillHandstreamCompression", value: -farmJumptrillHandstreamCompression, description: "Compression for jumptrill farm patterns mistaken for handstream." },
        ],
        stamina: [
          { id: "base", value: base, description: "Base SR blend from star rating and structural density." },
          { id: "staminaBonus", value: staminaBonus, description: "Sustained NPS and endurance reward." },
          { id: "moderateMidChordStaminaNerf", value: -moderateMidChordStaminaNerf, description: "Compression for slower long mid-chord stamina." },
          { id: "midChordRateCompressionNerf", value: -midChordRateCompressionNerf, description: "Compression for early mid-chord rate scaling." },
          { id: "highNoteMidRateHandstreamNerf", value: -highNoteMidRateHandstreamNerf, description: "Compression for long handstream rates before delta range." },
          { id: "highEndMidChordStaminaNerf", value: -highEndMidChordStaminaNerf, description: "Compression for high-end mid-chord stamina." },
          { id: "deltaHighMidChordTransitionNerf", value: -deltaHighMidChordTransitionNerf, description: "Transition compression around delta high handstream." },
          { id: "farmJumptrillStaminaCompression", value: -farmJumptrillStaminaCompression, description: "Compression for long jumptrill farm patterns with easy base stamina." },
        ],
        chordjack: [
          { id: "base", value: base, description: "Base SR blend from star rating and structural density." },
          { id: "chordjackBonus", value: chordjackBonus, description: "Chordjack pressure after wall/endurance penalties." },
          { id: "farmJumptrillChordjackCompression", value: -farmJumptrillChordjackCompression, description: "Compression for jumptrills that inflate chordjack pressure." },
        ],
        tech: [
          { id: "base", value: base, description: "Base SR blend from star rating and structural density." },
          { id: "techBonus", value: techBonus, description: "Direction, chord-size, burst, and density tech pressure." },
          { id: "denseJackTechNerf", value: -denseJackTechNerf, description: "Tech inflation removed for short dense jack files." },
          { id: "wallJackTechNerf", value: -wallJackTechNerf, description: "Tech inflation removed for dense jack-wall repetition." },
          { id: "lowChordBurstTechNerf", value: -lowChordBurstTechNerf, description: "Tech inflation removed for low-chord burst streams." },
          { id: "farmJumptrillTechCompression", value: -farmJumptrillTechCompression, description: "Tech inflation removed for long jumptrill farm patterns." },
          { id: "lowSrTechnicalRhythmBonus", value: lowSrTechnicalRhythmBonus, description: "Reward for low-SR tech cuts with fast row bursts, rhythm variation, and chord-size changes." },
          { id: "syncopatedChordTechBonus", value: syncopatedChordTechBonus, description: "Reward for syncopated moderate-chord tech cuts with slower note NPS but awkward row flow." },
          { id: "compactChordSwitchTechBonus", value: compactChordSwitchTechBonus, description: "Reward for compact chord-switch tech with high fast-row ratio and anchor pressure." },
          { id: "technicalAnchorBonus", value: technicalAnchorBonus, description: "Reward for moderate-chord technical anchors with strong same-column pressure." },
          { id: "moderateBurstTechCompression", value: -moderateBurstTechCompression, description: "Compression for mid-chord burst tech that was overpromoted by peak density alone." },
        ],
        dan: [],
      },
    },
  };
}

interface DanFamilyChoiceResult {
  family: DanPrimaryFamily;
  debug: DanFamilyChoiceDebug;
}

interface DanFamilyChoiceRule {
  id: string;
  family: DanPrimaryFamily;
  applies: (context: {
    metrics: DanEstimate["metrics"];
    skillScores: Record<DanSkillFamily, number>;
    topScore: number;
  }) => boolean;
}

const FAMILY_CHOICE_RULES: DanFamilyChoiceRule[] = [
  {
    id: "short-dense-jack-file",
    family: "jack",
    applies: ({ metrics, skillScores, topScore }) => metrics.noteCount >= 1800
      && metrics.noteCount <= 3200
      && metrics.chordRatio >= 0.54
      && metrics.chordRatio <= 0.72
      && metrics.holdRatio < 0.06
      && metrics.jackPressure >= 130
      && skillScores.jack >= topScore - 0.25,
  },
  {
    id: "dense-wall-jack",
    family: "jack",
    applies: ({ metrics, skillScores, topScore }) => metrics.noteCount >= 1800
      && metrics.chordRatio >= 0.74
      && metrics.holdRatio < 0.08
      && metrics.jackPressure >= 140
      && metrics.sustainedNps10s >= 23
      && skillScores.jack >= topScore - 0.45,
  },
  {
    id: "medium-wall-jack",
    family: "jack",
    applies: ({ metrics, skillScores, topScore }) => metrics.noteCount >= 3000
      && metrics.chordRatio >= 0.62
      && metrics.chordRatio <= 0.74
      && metrics.holdRatio < 0.08
      && metrics.jackPressure >= 145
      && metrics.sustainedNps10s >= 27
      && skillScores.jack >= topScore - 0.5,
  },
  {
    id: "low-sr-technical-rhythm",
    family: "tech",
    applies: ({ metrics, skillScores, topScore }) => metrics.noteCount >= 2200
      && metrics.noteCount <= 4200
      && metrics.chordRatio >= 0.16
      && metrics.chordRatio <= 0.38
      && metrics.holdRatio < 0.16
      && metrics.rowBurstPressure >= 20
      && metrics.fastRowRatio >= 0.5
      && metrics.chordSizeChangeRate >= 0.24
      && metrics.directionChangeRate >= 0.62
      && skillScores.tech >= topScore - 0.45,
  },
  {
    id: "syncopated-chord-tech",
    family: "tech",
    applies: ({ metrics, skillScores, topScore }) => metrics.noteCount >= 1600
      && metrics.noteCount <= 2600
      && metrics.chordRatio >= 0.28
      && metrics.chordRatio <= 0.38
      && metrics.holdRatio < 0.08
      && metrics.fastRowRatio >= 0.42
      && metrics.fastRowRatio <= 0.72
      && metrics.rowIntervalEntropy >= 2
      && metrics.chordSizeChangeRate >= 0.34
      && skillScores.tech >= topScore - 0.45,
  },
  {
    id: "compact-chord-switch-tech",
    family: "tech",
    applies: ({ metrics, skillScores, topScore }) => metrics.noteCount >= 1600
      && metrics.noteCount <= 2500
      && metrics.chordRatio >= 0.3
      && metrics.chordRatio <= 0.48
      && metrics.holdRatio >= 0.025
      && metrics.holdRatio <= 0.12
      && metrics.fastRowRatio >= 0.72
      && metrics.chordSizeChangeRate >= 0.48
      && metrics.jackPressure >= 165
      && metrics.techPressure >= 6.8
      && skillScores.tech >= topScore - 0.45,
  },
  {
    id: "technical-anchor",
    family: "tech",
    applies: ({ metrics, skillScores, topScore }) => metrics.noteCount >= 1700
      && metrics.noteCount <= 3300
      && metrics.chordRatio >= 0.26
      && metrics.chordRatio <= 0.38
      && metrics.holdRatio < 0.08
      && metrics.jackPressure >= 185
      && metrics.peakNps1s >= 32
      && metrics.peakNps5s >= 27
      && skillScores.tech >= topScore - 0.55,
  },
  {
    id: "rated-vibro-jumptrill",
    family: "jack",
    applies: ({ metrics, skillScores, topScore }) => metrics.noteCount >= 4000
      && metrics.chordRatio >= 0.42
      && metrics.chordRatio <= 0.58
      && metrics.holdRatio >= 0.1
      && metrics.holdRatio <= 0.24
      && metrics.jackPressure >= 165
      && metrics.peakNps1s >= 44
      && metrics.sustainedNps10s >= 30
      && skillScores.jack >= topScore - 0.4,
  },
  {
    id: "high-sustained-mid-chord-stamina",
    family: "stamina",
    applies: ({ metrics, skillScores, topScore }) => metrics.sustainedNps10s >= 34
      && metrics.chordRatio >= 0.32
      && metrics.chordRatio <= 0.7
      && metrics.jackPressure < 195
      && skillScores.stamina >= topScore - 0.85,
  },
  {
    id: "long-mid-chord-stamina",
    family: "stamina",
    applies: ({ metrics, skillScores, topScore }) => metrics.sustainedNps10s >= 28
      && metrics.chordRatio >= 0.38
      && metrics.chordRatio <= 0.75
      && metrics.jackPressure < 165
      && metrics.noteCount >= 4500
      && skillScores.stamina >= topScore - 1.05,
  },
  {
    id: "cyber-like-mid-chord-stamina",
    family: "stamina",
    applies: ({ metrics, skillScores, topScore }) => metrics.noteCount >= 4200
      && metrics.chordRatio >= 0.42
      && metrics.chordRatio <= 0.6
      && metrics.jackPressure < 150
      && metrics.holdRatio < 0.08
      && metrics.sustainedNps10s >= 23
      && skillScores.stamina >= topScore - 0.65,
  },
  {
    id: "long-mid-chord-stamina-family-bias",
    family: "stamina",
    applies: ({ metrics, skillScores, topScore }) => metrics.noteCount >= 4500
      && metrics.chordRatio >= 0.42
      && metrics.chordRatio <= 0.6
      && metrics.jackPressure < 150
      && metrics.holdRatio < 0.08
      && metrics.sustainedNps10s >= 20
      && skillScores.stamina >= topScore - 0.75,
  },
  {
    id: "low-chord-sustained-speed",
    family: "stream",
    applies: ({ metrics, skillScores, topScore }) => metrics.chordRatio <= 0.28
      && metrics.sustainedNps10s >= 25
      && metrics.peakNps5s >= 26
      && metrics.jackPressure < 165
      && metrics.techPressure < 6.4
      && skillScores.stream >= topScore - 0.7,
  },
  {
    id: "burst-tech",
    family: "tech",
    applies: ({ metrics, skillScores, topScore }) => metrics.peakNps1s >= 34
      && metrics.chordRatio >= 0.18
      && metrics.chordRatio <= 0.36
      && metrics.techPressure >= 5.6
      && metrics.jackPressure >= 130
      && metrics.jackPressure <= 190
      && skillScores.tech >= topScore - 0.45,
  },
  {
    id: "steady-stream",
    family: "stream",
    applies: ({ metrics, skillScores, topScore }) => metrics.chordRatio <= 0.38
      && metrics.sustainedNps10s >= 25
      && metrics.peakNps5s >= 26
      && metrics.jackPressure < 155
      && skillScores.stream >= topScore - 0.35,
  },
  {
    id: "dense-chordjack",
    family: "chordjack",
    applies: ({ metrics, skillScores, topScore }) => metrics.chordRatio >= 0.72
      && metrics.holdRatio < 0.18
      && metrics.jackPressure < 150
      && skillScores.chordjack >= topScore - 0.35,
  },
];

function chooseSkillFamily(skillScores: Record<DanSkillFamily, number>, metrics: DanEstimate["metrics"]): DanFamilyChoiceResult {
  const ranked = PRIMARY_FAMILIES
    .map((family) => [family, skillScores[family]] as [DanPrimaryFamily, number])
    .sort((a, b) => b[1] - a[1]);
  const [topFamily, topScore] = ranked[0];
  const choose = (selectedFamily: DanPrimaryFamily, reason: string): DanFamilyChoiceResult => ({
    family: selectedFamily,
    debug: {
      topFamily,
      topScore,
      selectedFamily,
      reason,
    },
  });

  for (const rule of FAMILY_CHOICE_RULES) {
    if (rule.applies({ metrics, skillScores, topScore })) {
      return choose(rule.family, rule.id);
    }
  }

  return choose(topFamily, "top-score");
}

function countDanSegments(orderedRows: Array<[number, ManiaNote[]]>): number {
  if (orderedRows.length === 0) return 0;

  let segments = 0;
  let segmentStart = orderedRows[0][0];
  let segmentNotes = 0;

  for (let index = 0; index < orderedRows.length; index++) {
    const [time, rowNotes] = orderedRows[index];
    segmentNotes += rowNotes.length;
    const next = orderedRows[index + 1];
    if (!next || next[0] - time > 2500) {
      if (time - segmentStart >= 30000 && segmentNotes >= 400) segments++;
      if (next) {
        segmentStart = next[0];
        segmentNotes = 0;
      }
    }
  }

  return segments;
}

function isDanCourse(input: DanEstimateInput, orderedRows: Array<[number, ManiaNote[]]>, durationMs: number, noteCount: number): boolean {
  const title = input.title?.toLowerCase() ?? "";
  const version = input.version?.toLowerCase() ?? "";
  const combined = `${title} ${version}`;
  if (!/\bdan\b/.test(combined)) return false;

  const segmentCount = countDanSegments(orderedRows);
  return (durationMs >= 180000 && segmentCount >= 3)
    || (durationMs >= 240000 && noteCount >= 6000 && segmentCount >= 3);
}

function estimateDanCourseSr(metrics: DanEstimate["metrics"], starRating: number, fallbackSr: number): number {
  if (starRating <= 0) return Math.max(1, fallbackSr - 0.8);

  const densityPressure = Math.max(0, metrics.sustainedNps10s - 24) * 0.035
    + Math.max(0, metrics.peakNps5s - 28) * 0.025;
  const endurancePressure = Math.min(0.12, metrics.noteCount / 100000);
  return starRating + Math.min(0.55, densityPressure + endurancePressure);
}

interface DanFeatureExtractionResult {
  notes: ManiaNote[];
  noteTimes: number[];
  durationMs: number;
  orderedRows: Array<[number, ManiaNote[]]>;
  metrics: DanEstimate["metrics"];
  warnings: string[];
}

function getRatedNotes(map: ManiaBeatmap, rate: number): ManiaNote[] {
  return map.notes
    .filter((note) => note.column >= 0 && note.column < map.keyCount)
    .map((note) => rate === 1 ? note : {
      ...note,
      time: note.time / rate,
      endTime: note.endTime / rate,
    });
}

function groupNotesByTime(notes: ManiaNote[]): Array<[number, ManiaNote[]]> {
  const rows = new Map<number, ManiaNote[]>();
  for (const note of notes) {
    const row = rows.get(note.time);
    if (row) row.push(note);
    else rows.set(note.time, [note]);
  }
  return [...rows.entries()].sort((a, b) => a[0] - b[0]);
}

function extractDanFeatures(map: ManiaBeatmap, input: DanEstimateInput, rate: number): DanFeatureExtractionResult {
  const notes = getRatedNotes(map, rate);
  const warnings: string[] = [];
  const noteTimes = notes.map((note) => note.time).sort((a, b) => a - b);
  const durationMs = Math.max(input.totalLength ? (input.totalLength * 1000) / rate : 0, map.totalLength / rate, noteTimes.at(-1) ?? 0);

  if (notes.length < 50 || durationMs <= 0) {
    warnings.push("This map has very little note data, so the estimate is low confidence.");
  }

  const orderedRows = groupNotesByTime(notes);
  const chordRows = orderedRows.filter(([, rowNotes]) => rowNotes.length >= 2).length;
  const holdRatio = notes.length ? notes.filter((note) => note.isHold).length / notes.length : 0;
  const chordRatio = orderedRows.length ? chordRows / orderedRows.length : 0;

  const lastByColumn = Array.from({ length: Math.max(1, map.keyCount) }, () => -Infinity);
  const jackValues: number[] = [];
  const streamValues: number[] = [];
  const rowDensities: number[] = [];
  const rowIntervals: number[] = [];
  const rowRates: number[] = [];
  let directionChanges = 0;
  let previousColumn: number | null = null;
  let previousDirection = 0;
  let previousChordSize = 0;
  let chordSizeChanges = 0;
  let previousRowTime: number | null = null;

  for (const [time, rowNotes] of orderedRows) {
    const columns = rowNotes.map((note) => note.column).sort((a, b) => a - b);
    if (previousChordSize && previousChordSize !== columns.length) chordSizeChanges++;
    if (previousRowTime != null) {
      const rowDelta = time - previousRowTime;
      if (rowDelta > 0 && rowDelta < 1200) {
        rowIntervals.push(rowDelta);
        rowRates.push(1000 / rowDelta);
        rowDensities.push((columns.length * 1000) / rowDelta);
      }
    }
    previousChordSize = columns.length;
    previousRowTime = time;

    for (const column of columns) {
      const sameDelta = time - lastByColumn[column];
      if (sameDelta > 0 && sameDelta < 1000) {
        jackValues.push(Math.min(230, 15000 / sameDelta));
      }

      for (const neighbor of [column - 1, column + 1]) {
        if (neighbor < 0 || neighbor >= map.keyCount) continue;
        const delta = time - lastByColumn[neighbor];
        if (delta > 0 && delta < 260) {
          streamValues.push((260 - delta) / 35);
        }
      }

      if (previousColumn != null) {
        const direction = Math.sign(column - previousColumn);
        if (direction && previousDirection && direction !== previousDirection) directionChanges++;
        if (direction) previousDirection = direction;
      }
      previousColumn = column;
      lastByColumn[column] = time;
    }
  }

  const peakNps1s = countInWindow(noteTimes, 1000);
  const peakNps5s = countInWindow(noteTimes, 5000) / 5;
  const sustainedNps10s = countInWindow(noteTimes, 10000) / 10;
  const jackPressure = quantile(jackValues, 0.92);
  const streamPressure = quantile(streamValues, 0.9);
  const burstDensity = quantile(rowDensities, 0.9);
  const rowBurstPressure = quantile(rowRates, 0.9);
  const fastRowRatio = rowIntervals.length
    ? rowIntervals.filter((interval) => interval <= 80).length / rowIntervals.length
    : 0;
  const rowIntervalEntropy = bucketEntropy(rowIntervals, 5);
  const chordSizeChangeRate = orderedRows.length ? chordSizeChanges / orderedRows.length : 0;
  const directionChangeRate = notes.length ? directionChanges / notes.length : 0;
  const chordjackPressure = jackPressure * (0.28 + chordRatio * 1.35) + burstDensity * chordRatio * 0.6;
  const techPressure = orderedRows.length
    ? (directionChanges / orderedRows.length) * 4.4 + (chordSizeChanges / orderedRows.length) * 3.5 + chordRatio * 1.6 + average(rowDensities) * 0.018
    : 0;

  return {
    notes,
    noteTimes,
    durationMs,
    orderedRows,
    warnings,
    metrics: {
      keyCount: map.keyCount,
      noteCount: notes.length,
      holdRatio,
      chordRatio,
      peakNps1s,
      peakNps5s,
      sustainedNps10s,
      jackPressure,
      streamPressure,
      chordjackPressure,
      techPressure,
      rowBurstPressure,
      fastRowRatio,
      rowIntervalEntropy,
      chordSizeChangeRate,
      directionChangeRate,
      staminaPressure: sustainedNps10s,
    },
  };
}

export function estimateDan(map: ManiaBeatmap, input: DanEstimateInput = {}): DanEstimate {
  if (map.keyCount !== 4) {
    throw new Error("Dan estimates are currently only supported for 4K beatmaps.");
  }

  const rate = getInputRate(input);
  const features = extractDanFeatures(map, input, rate);
  const { notes, durationMs, orderedRows, metrics } = features;
  const warnings = [...features.warnings];

  const baseStarRating = Number.isFinite(input.starRating) ? Math.max(0, input.starRating ?? 0) : 0;
  const starRating = baseStarRating > 0 ? baseStarRating * Math.pow(rate, 0.7) : 0;
  const scoring = estimateFamilyScores(metrics, starRating, durationMs);
  const skillScores = scoring.skillScores;
  const familyChoice = chooseSkillFamily(skillScores, metrics);
  const skillFamily = familyChoice.family;
  const isCourse = isDanCourse(input, orderedRows, durationMs, notes.length);
  const family = isCourse ? "dan" : skillFamily;
  const estimatedSr = isCourse
    ? estimateDanCourseSr(metrics, starRating, skillScores[skillFamily])
    : skillScores[skillFamily];
  const rawDan = srToRawDan(estimatedSr, skillFamily);
  const parsed = parseDan(rawDan);
  const confidence = Math.max(
    0.15,
    Math.min(
      0.92,
      0.55
        + Math.min(0.18, notes.length / 6000)
        + (map.keyCount === 4 ? 0.12 : -0.1)
        + (starRating > 0 ? 0.07 : -0.05)
        - (metrics.holdRatio > 0.45 ? 0.18 : 0),
    ),
  );

  if (metrics.holdRatio > 0.28) {
    warnings.push("This looks LN-heavy; LN dan handling is intentionally conservative for now.");
  }

  return {
    ...parsed,
    rawDan,
    estimatedSr,
    family,
    confidence,
    metrics,
    skillScores,
    warnings,
    debug: {
      scoring: scoring.debug,
      familyChoice: familyChoice.debug,
    },
  };
}
