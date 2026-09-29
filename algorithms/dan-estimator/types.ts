// Shared types for the 4K rice dan estimator and the pattern analyzer: the
// input a chart is rated with, the feature metrics read off its notes, the
// estimate that comes back, and the pattern tags.

import type { ManiaNote } from "../chart/beatmap";

export type DanSkillFamily = "jack" | "stream" | "jumpstream" | "handstream" | "stamina" | "chordjack" | "tech" | "ln" | "dan";
export type DanPrimaryFamily = Exclude<DanSkillFamily, "ln" | "dan">;

// Every pattern family the estimator can score and choose between. Consumers
// iterate this list instead of naming families themselves.
export const DAN_PRIMARY_FAMILIES: DanPrimaryFamily[] = ["jack", "stream", "jumpstream", "handstream", "stamina", "chordjack", "tech"];

export interface DanEstimateInput {
  starRating?: number;
  /** Seconds, at 1.0x. */
  totalLength?: number;
  title?: string;
  version?: string;
  /** Playback rate (DT is 1.5, HT is 0.75). */
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
  durationMs: number;
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
  // Of adjacent chord rows (under 1s apart, both 2+ notes), the share that
  // re-hit at least one column. This is the chord-jack signal: dense
  // bracket/jumpstream charts sit near 0.1 at the same chord density where
  // real chordjack sits at 0.7+.
  chordColumnOverlapRatio: number;
  // Note-weighted column re-hits on the adjacent row and two rows back, both
  // within 500ms. Their difference is the alternating reload strain of 4K
  // quadstream/minijack charts: the same fingers return on A-B-A shapes even
  // when neither adjacent row is a conventional jack.
  adjacentColumnRehitShare: number;
  twoBackColumnRehitShare: number;
  twoBackColumnRehitExcess: number;
  techPressure: number;
  rowBurstPressure: number;
  fastRowRatio: number;
  rowIntervalEntropy: number;
  /** Share of note rows off the 16th grid (1/6, 1/8, 1/12 and finer, or off-snap). See offGridRowShare in features.ts. */
  offGridRowShare: number;
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

export type ManiaPatternId =
  | "jack"
  | "chordjack"
  | "speedjack"
  | "handjack"
  | "tech"
  | "stream"
  | "dumpstream"
  | "jumpstream"
  | "handstream"
  | "quadstream"
  | "delay"
  | "bracket"
  | "chordstream"
  | "ln"
  | "lngeneral"
  | "lnrelease"
  | "lninverse"
  | "lntech";

export interface ManiaPatternHit {
  id: ManiaPatternId;
  label: string;
  score: number;
  confidence: number;
  evidence: string;
}

export interface ManiaPatternAnalysis {
  keyCount: number;
  primary: ManiaPatternHit | null;
  patterns: ManiaPatternHit[];
  allPatterns: ManiaPatternHit[];
  metrics: DanFeatureMetrics;
  warnings: string[];
}
