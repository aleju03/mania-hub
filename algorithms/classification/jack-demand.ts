import type { DanFeatureMetrics, ManiaPatternHit } from "../dan-estimator/types";

export const FOUR_KEY_JACK_DEMAND_VERSION = 1;

export type FourKeyJackDemandReason =
  | "dense_alternating_chords"
  | "jack_cluster_dominant"
  | "jack_cluster_corroborated"
  | "jack_marathon";

export interface FourKeyJackDemandVerdict {
  version: number;
  detected: boolean;
  reasons: FourKeyJackDemandReason[];
}

export interface FourKeyJackDemandCluster {
  label: string;
  pattern: string;
  bpm: number;
  importance: number;
}

export interface FourKeyJackDemandInput {
  keyCount: number;
  metrics: Pick<
    DanFeatureMetrics,
    | "durationMs"
    | "chordRatio"
    | "chordColumnOverlapRatio"
    | "twoBackColumnRehitExcess"
    | "jackPressure"
  >;
  patterns: Array<Pick<ManiaPatternHit, "id" | "score">>;
  clusters: FourKeyJackDemandCluster[];
}

const DENSE_CHORD_RATIO_MIN = 0.70;
const DENSE_CHORD_OVERLAP_MIN = 0.58;
const TWO_BACK_REHIT_EXCESS_MIN = 0.30;

const JACKABLE_MAX_CLUSTER_BPM = 230;
const JACK_CLUSTER_SHARE_MIN = 0.60;

const JACK_CLUSTER_CORROBORATED_SHARE_MIN = 0.25;
const JACK_CLUSTER_CORROBORATED_CHORDJACK_MIN = 0.5;
const JACK_CLUSTER_CORROBORATED_PRESSURE_MIN = 150;

const JACK_CLUSTER_PATTERN = "Jacks";
const MARATHON_DURATION_MIN_MS = 240_000;
const MARATHON_JACK_SCORE_MIN = 0.75;
const MARATHON_JACK_PRESSURE_MIN = 175;
const MARATHON_CHORD_RATIO_MIN = 0.45;
const MARATHON_CHORD_OVERLAP_MIN = 0.55;

function patternScore(patterns: FourKeyJackDemandInput["patterns"], id: string): number {
  let score = 0;
  for (const pattern of patterns) {
    if (pattern.id !== id) continue;
    const value = Number(pattern.score);
    if (Number.isFinite(value)) score = Math.max(score, value);
  }
  return score;
}

function jackClusterImportanceShare(clusters: FourKeyJackDemandCluster[]): number {
  let total = 0;
  let jack = 0;
  for (const cluster of clusters) {
    const importance = Number(cluster.importance);
    if (!Number.isFinite(importance) || importance <= 0) continue;
    total += importance;
    const bpm = Number(cluster.bpm);
    if (!Number.isFinite(bpm) || bpm <= 0 || bpm > JACKABLE_MAX_CLUSTER_BPM) continue;
    if (cluster.pattern === JACK_CLUSTER_PATTERN) jack += importance;
  }
  return total > 0 ? jack / total : 0;
}

function weightedMeanClusterBpm(clusters: FourKeyJackDemandCluster[]): number | null {
  let weight = 0;
  let weighted = 0;
  for (const cluster of clusters) {
    const importance = Number(cluster.importance);
    const bpm = Number(cluster.bpm);
    if (!Number.isFinite(importance) || importance <= 0) continue;
    if (!Number.isFinite(bpm) || bpm <= 0) continue;
    weight += importance;
    weighted += importance * bpm;
  }
  return weight > 0 ? weighted / weight : null;
}

export function classifyFourKeyJackDemand(input: FourKeyJackDemandInput): FourKeyJackDemandVerdict {
  if (input.keyCount !== 4) {
    return { version: FOUR_KEY_JACK_DEMAND_VERSION, detected: false, reasons: [] };
  }

  const { metrics } = input;
  const reasons: FourKeyJackDemandReason[] = [];
  const denseAlternatingChords = metrics.chordRatio >= DENSE_CHORD_RATIO_MIN
    && metrics.chordColumnOverlapRatio >= DENSE_CHORD_OVERLAP_MIN
    && metrics.twoBackColumnRehitExcess >= TWO_BACK_REHIT_EXCESS_MIN;
  if (denseAlternatingChords) reasons.push("dense_alternating_chords");

  const meanClusterBpm = weightedMeanClusterBpm(input.clusters);
  const jackableSpeed = meanClusterBpm == null || meanClusterBpm <= JACKABLE_MAX_CLUSTER_BPM;

  const jackClusterShare = jackClusterImportanceShare(input.clusters);
  const jackClusterDominant = jackableSpeed
    && meanClusterBpm != null
    && jackClusterShare >= JACK_CLUSTER_SHARE_MIN;
  if (jackClusterDominant) reasons.push("jack_cluster_dominant");

  const jackClusterCorroborated = !jackClusterDominant
    && jackableSpeed
    && meanClusterBpm != null
    && jackClusterShare >= JACK_CLUSTER_CORROBORATED_SHARE_MIN
    && patternScore(input.patterns, "chordjack") >= JACK_CLUSTER_CORROBORATED_CHORDJACK_MIN
    && metrics.jackPressure >= JACK_CLUSTER_CORROBORATED_PRESSURE_MIN;
  if (jackClusterCorroborated) reasons.push("jack_cluster_corroborated");
  const jackMarathon = jackableSpeed
    && metrics.durationMs >= MARATHON_DURATION_MIN_MS
    && patternScore(input.patterns, "jack") >= MARATHON_JACK_SCORE_MIN
    && metrics.jackPressure >= MARATHON_JACK_PRESSURE_MIN
    && metrics.chordRatio >= MARATHON_CHORD_RATIO_MIN
    && metrics.chordColumnOverlapRatio >= MARATHON_CHORD_OVERLAP_MIN;
  if (jackMarathon) reasons.push("jack_marathon");

  return {
    version: FOUR_KEY_JACK_DEMAND_VERSION,
    detected: reasons.length > 0,
    reasons,
  };
}
