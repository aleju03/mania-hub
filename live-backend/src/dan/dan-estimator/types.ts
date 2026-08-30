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
  // Of adjacent chord rows (<1s apart, both >= 2 notes), the share that
  // re-hit at least one column: the actual chord-JACK signal. Dense
  // bracket/jumpstream files sit ~0.1 here at the same chord density where
  // true chordjack sits 0.7+.
  chordColumnOverlapRatio: number;
  // Note-weighted column re-hits on adjacent rows and two rows apart, capped
  // to a 500ms neighbourhood. Their difference is the alternating reload
  // strain behind 4K quadstream/minijack charts: the same fingers return on
  // A-B-A shapes even when neither adjacent row is a conventional jack.
  adjacentColumnRehitShare: number;
  twoBackColumnRehitShare: number;
  twoBackColumnRehitExcess: number;
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
