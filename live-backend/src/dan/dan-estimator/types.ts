import type { ManiaNote } from "../beatmap-parser.js";

export type DanSkillFamily = "jack" | "stream" | "jumpstream" | "handstream" | "stamina" | "chordjack" | "tech" | "ln" | "dan";
export type DanPrimaryFamily = Exclude<DanSkillFamily, "ln" | "dan">;

// Canonical list of pattern families the estimator can score and choose
// between. Downstream consumers (activity pattern mixes) iterate this instead
// of hardcoding family names, so new families flow through automatically.
export const DAN_PRIMARY_FAMILIES: DanPrimaryFamily[] = ["jack", "stream", "jumpstream", "handstream", "stamina", "chordjack", "tech"];

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
  metrics: DanFeatureMetrics;
  skillScores: Record<DanSkillFamily, number>;
  warnings: string[];
  debug?: DanEstimateDebug;
}

export interface DanFeatureMetrics {
  keyCount: number;
  noteCount: number;
  holdRatio: number;
  chordRatio: number;
  twoNoteChordRatio: number;
  peakNps1s: number;
  peakNps5s: number;
  nps5sP50: number;
  nps5sP90: number;
  nps5sP95: number;
  sustainedNps10s: number;
  sustainedNps30s: number;
  sustainedNps60s: number;
  activeNps: number;
  longGapRatio: number;
  longGapCount: number;
  jackPressure: number;
  streamPressure: number;
  jumpstreamPressure: number;
  chordjackPressure: number;
  techPressure: number;
  rowBurstPressure: number;
  fastRowRatio: number;
  rowIntervalEntropy: number;
  patternVariety: number;
  rowPatternEntropy: number;
  rowPatternVariety: number;
  repeatedRowPatternRatio: number;
  alternatingRowPatternRatio: number;
  rowPatternChangeRate: number;
  rowMotifRepeatRatio: number;
  rhythmMotifRepeatRatio: number;
  adjacentMotifRepeatRatio: number;
  strainSpikiness: number;
  sustainedPressureRatio: number;
  anchorPressure: number;
  lnReleasePressure: number;
  lnDensity: number;
  lnOverlapPressure: number;
  lnChordPressure: number;
  lnHoldDurationAvg: number;
  lnHoldDurationP90: number;
  chordSizeChangeRate: number;
  directionChangeRate: number;
  staminaPressure: number;
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
  topFamily: DanSkillFamily;
  topScore: number;
  selectedFamily: DanSkillFamily;
  reason: string;
}

export interface DanFeatureExtractionResult {
  notes: ManiaNote[];
  noteTimes: number[];
  durationMs: number;
  orderedRows: Array<[number, ManiaNote[]]>;
  metrics: DanFeatureMetrics;
  warnings: string[];
}
