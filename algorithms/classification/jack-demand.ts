// 4K Jack demand that MinaCalc's JackSpeed/Chordjack argmax misses, because
// MinaCalc suppresses anchored rows. Only decides which player skill a clear
// counts toward. It never changes a chart's rating.
import type { DanFeatureMetrics, ManiaPatternHit } from "../dan-estimator/types";

export type FourKeyJackDemandReason =
  | "dense_alternating_chords"
  | "jack_cluster_dominant"
  | "jack_cluster_corroborated"
  | "jack_marathon";

export interface FourKeyJackDemandVerdict {
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
  // Every pattern hit, so a secondary jack signal is not crowded out of the
  // top five.
  patterns: Array<Pick<ManiaPatternHit, "id" | "score">>;
  clusters: FourKeyJackDemandCluster[];
}

const DENSE_CHORDS = {
  chordRatioMin: 0.70,
  chordOverlapMin: 0.58,
  twoBackRehitExcessMin: 0.30,
};

// Fastest column reload one finger can jack, about 130ms for two rows of 1/4.
// Faster shapes are speed or tech.
const JACKABLE_MAX_CLUSTER_BPM = 230;

// Share of cluster importance on jack clusters that makes them dominant.
const JACK_CLUSTER_SHARE_MIN = 0.60;
// Half of all charts have some jack cluster, so a quarter share only counts
// when the chordjack pattern and raw jack pressure agree.
const CORROBORATED = {
  shareMin: 0.25,
  chordjackScoreMin: 0.5,
  jackPressureMin: 150,
};

/** LeoBlack's family name for minijack, chordjack and longjack clusters. */
const JACK_CLUSTER_PATTERN = "Jacks";

const MARATHON = {
  durationMinMs: 240_000,
  jackScoreMin: 0.75,
  jackPressureMin: 175,
  chordRatioMin: 0.45,
  chordOverlapMin: 0.55,
};

/**
 * Three arms. Dense alternating chords reload the same fingers two rows later
 * while chords overlap. Jack cluster dominance means LeoBlack reads most
 * cluster importance as jacks at a jackable speed. Jack marathons are long,
 * high-pressure jack hybrids that just miss the speedjack/chordjack override.
 *
 * Moves 2.9% of a random 4K sample and no speed, stream or handstream pack
 * charts. A minitrill-share arm was tried and dropped because no feature
 * separated a jumpstream chart read as jack from a handstream chart read as
 * tech.
 */
export function classifyFourKeyJackDemand(input: FourKeyJackDemandInput): FourKeyJackDemandVerdict {
  if (input.keyCount !== 4) {
    return { detected: false, reasons: [] };
  }

  const { metrics } = input;
  const reasons: FourKeyJackDemandReason[] = [];
  const denseAlternatingChords = metrics.chordRatio >= DENSE_CHORDS.chordRatioMin
    && metrics.chordColumnOverlapRatio >= DENSE_CHORDS.chordOverlapMin
    && metrics.twoBackColumnRehitExcess >= DENSE_CHORDS.twoBackRehitExcessMin;
  if (denseAlternatingChords) reasons.push("dense_alternating_chords");

  // A chart with no clusters passes. The gate only rejects charts read as
  // fast.
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
    && jackClusterShare >= CORROBORATED.shareMin
    && patternScore(input.patterns, "chordjack") >= CORROBORATED.chordjackScoreMin
    && metrics.jackPressure >= CORROBORATED.jackPressureMin;
  if (jackClusterCorroborated) reasons.push("jack_cluster_corroborated");

  const jackMarathon = jackableSpeed
    && metrics.durationMs >= MARATHON.durationMinMs
    && patternScore(input.patterns, "jack") >= MARATHON.jackScoreMin
    && metrics.jackPressure >= MARATHON.jackPressureMin
    && metrics.chordRatio >= MARATHON.chordRatioMin
    && metrics.chordColumnOverlapRatio >= MARATHON.chordOverlapMin;
  if (jackMarathon) reasons.push("jack_marathon");

  return { detected: reasons.length > 0, reasons };
}

/** Highest score among hits with this pattern id, 0 when none. */
function patternScore(patterns: FourKeyJackDemandInput["patterns"], id: string): number {
  let score = 0;
  for (const pattern of patterns) {
    if (pattern.id !== id) continue;
    const value = Number(pattern.score);
    if (Number.isFinite(value)) score = Math.max(score, value);
  }
  return score;
}

/** Share of cluster importance carried by jack clusters slow enough to jack. */
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

/** Importance-weighted mean cluster BPM, or null when no cluster carries one. */
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
