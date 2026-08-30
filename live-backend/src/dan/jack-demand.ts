import type { DanFeatureMetrics, ManiaPatternHit } from "./dan-estimator/types.js";

// Player-dan tiles answer which specialist a clear demonstrates, not merely
// which MinaCalc label won. MinaCalc deliberately suppresses anchored rows and
// consequently files several community-Jack 4K shapes under Technical or
// Jumpstream. This verdict supplies the missing structural override.
//
// It is intentionally separate from the chart's dan family/rating: none of
// these rules changes what a chart is rated, only which player skill bucket a
// clear supplies evidence for.
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
  // Use allPatterns, not the stored top-five surface. A secondary jack signal
  // must not disappear merely because five other hybrid labels scored higher.
  patterns: Array<Pick<ManiaPatternHit, "id" | "score">>;
  clusters: FourKeyJackDemandCluster[];
}

const DENSE_CHORD_RATIO_MIN = 0.70;
const DENSE_CHORD_OVERLAP_MIN = 0.58;
const TWO_BACK_REHIT_EXCESS_MIN = 0.30;

// A repeated column is jack demand only while a finger can be asked to re-tap
// it. One row of 1/4 at this BPM is ~65ms, so a two-row reload lands ~130ms
// apart; faster than that the same shape has to be spread across two fingers,
// which is the speed/tech demand rather than the jack one. Measured: the jack
// marathons carry importance-weighted cluster BPM 159-198, against 277 for a
// speed-pack file whose every other jack signal reads stronger than all of
// them (jack 1.00, jack pressure at the cap).
const JACKABLE_MAX_CLUSTER_BPM = 230;
const JACK_CLUSTER_SHARE_MIN = 0.60;
// Below that share the clusters alone are not enough: half the corpus carries
// some jack cluster. A quarter of the chart's importance counts when the
// in-house chordjack detector independently reaches half-confidence and the
// notes carry real jack pressure, which is two detectors agreeing rather than
// one threshold lowered. Measured: it moves 4 more charts in 897, none in the
// tech, speed, stream or handstream packs.
const JACK_CLUSTER_CORROBORATED_SHARE_MIN = 0.25;
const JACK_CLUSTER_CORROBORATED_CHORDJACK_MIN = 0.5;
const JACK_CLUSTER_CORROBORATED_PRESSURE_MIN = 150;
/** LeoBlack's family name for minijack, chordjack and longjack clusters. */
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

/**
 * Identity-blind 4K Jack demand missed by MinaCalc's JackSpeed/Chordjack
 * argmax. Three arms cover distinct community-Jack shapes:
 *
 * - dense alternating chords: jump/hand rows that repeatedly reload the same
 *   fingers two rows later while adjacent chords still overlap;
 * - jack cluster dominance: LeoBlack reads most of the chart's importance as
 *   minijack, chordjack or longjack clusters at a jackable speed, which is the
 *   quadstream and minijack shape MinaCalc files as Technical, or reads a
 *   quarter of it that way while the in-house chordjack detector and the raw
 *   jack pressure both corroborate;
 * - jack marathon: long, high-pressure jack hybrids whose generic Jack signal
 *   is strong but whose speedjack/chordjack tag narrowly misses its override,
 *   again only at a speed the repeats can be jacked at.
 *
 * Thresholds were checked against mapper-named 4K Jack, Tech, Jumpstream,
 * Stamina, Stream, Speed and Handstream pack corpora, counting charts that
 * actually CHANGE tile rather than charts the verdict merely agrees with (the
 * cluster arm fires on 28% of 4K charts, but most of those already win a
 * JackSpeed or Chordjack argmax). Moved: 2.9% of a random 4K sample, 4.5% of
 * the jack packs, 1 of 212 tech-pack charts (a file LeoBlack itself
 * categorises Chordjacks), and none of the 399 speed, stream and handstream
 * pack charts.
 *
 * A third arm was measured and rejected. It read the share of cluster
 * importance carried by jackable-speed minitrills, to catch a 180BPM
 * jumpstream file whose community reading is jack but whose minijack content
 * MinaCalc buries. Every feature available here (minitrill share and BPM, jack
 * pressure, two-back reload excess, adjacent-row column re-hits, peak windowed
 * jack load, four-note row share, LeoBlack cluster category, and the relative
 * MSD shape) puts that chart inside noise of a handstream-pack file the same
 * community reads as tech, and on the two most direct jack measures the tech
 * file scores higher. Do not re-add the arm on threshold tuning; it needs a
 * signal that separates those two, measured on more than one labelled pair.
 */
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

  // A chart with no clusters at all keeps the older behaviour rather than
  // losing the arm: the gate is there to reject fast files, not unread ones.
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
