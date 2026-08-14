import type { Db } from "../db.js";
import { exec, execBatch, parseJson, type DbStatement } from "../db.js";
import { logWarn } from "../logger.js";
import { loadActiveFarmHelperFeedback, type ActiveFarmHelperFeedbackMark, type FarmHelperFeedbackVerdict } from "./farm-helper-feedback.js";
import { getPlayerProfileSnapshot, PROFILE_BEST_SCORES_LIMIT } from "./player-profiles.js";
import { calculateManiaCustomAccuracy, calculateWeightedPpTotal, extractManiaVariantPps, getModAcronyms, getScoreSpeedBucket, normalizeStoredMods, nowIso, type ScoreSpeedBucket } from "../shared/score.js";
import type { OscScore } from "../shared/types.js";
import { OsuApiError, type OsuApiClient } from "../osu/client.js";
import { calibrateProxy, getKeyModePeerPool, type FarmHelperKeyCount } from "./farm-helper-key-stats.js";
import { buildWeightedUserShape, computeShapeWeights, MSD_SKILLSETS, primaryPatternFamily, readChartShapeData, readChartShapes, readPeerShapes, shapeSimilarity, SHAPE_MIN_CHARTS, type ChartShape, type UserShape } from "./farm-helper-shape.js";
import { enqueueMissingChartAnalyses, readDtRateMsd } from "./chart-analysis.js";
import { getPlayerSkillBreakdown, type PlayerSkillBreakdown, type PlayerSkillModeBreakdown } from "./player-skills.js";
import { ACC_MODEL_PRIOR_TYPICAL_ACC, predictPlayerAccuracy, predictPlayerChoke, readPlayerAccModel, type PlayerAccModel, type PlayerAccPrediction, type PlayerChokePrediction } from "./player-acc-model.js";
import { getBaselineUserVectors, type BaselineUserVector } from "./skill-baseline.js";
import { timeStage, timeStageSync, type FarmHelperTimings } from "./farm-helper-timing.js";
import type { JobQueue } from "../jobs/queue.js";

// Farm Helper recommends maps a player should farm, ranked by estimated pp gain.
// The peer pool is GLOBAL: we compare the subject against same-pp players across
// every tracked country. The candidate pool is `country_maps_farmed_scores` (the
// proven farm-map set: rows only exist when a score entered someone's top plays),
// aggregated across all countries. The subject's own top plays come from
// `getPlayerProfileSnapshot` (osu! API, cached 24h). Internal/offline callers
// can still build for any player; public HTTP routes first apply the known-
// subject gate below so arbitrary names cannot spend the shared osu! budget.

export type FarmHelperKeyMode = "4k" | "7k" | "any";
type ConcreteFarmHelperKeyMode = Exclude<FarmHelperKeyMode, "any">;
export type FarmHelperReason = "missing" | "improve" | "stale" | "owned" | "push";
// "gain" is the personalized, pp-gain-ranked recommendation view (the default).
// "popular" reuses the same peer cohort but skips the value/already-cleared gates
// and ranks by how many same-pp peers farm a map, so a player can browse every
// popular farm map around their fit (including ones they have already cleared).
// Popular differs ONLY in which rows appear (nothing drops: caps clamp, the
// feasibility gate never removes, min-gain/margin re-checks are bypassed); the
// benchmark/gain numbers themselves are computed under the same acc scaling
// and caps as the gain view so both views quote the same figure for a map.
export type FarmHelperView = "gain" | "popular";

export interface FarmHelperPeer {
  userId: number;
  username: string;
  avatarUrl: string;
  pp: number;
}

export interface FarmHelperRec {
  beatmapId: number;
  speedBucket: ScoreSpeedBucket;
  recommendedMods: string[];
  beatmapsetId: number;
  title: string;
  artist: string;
  creator: string;
  version: string;
  cover: string;
  listCover: string;
  status: string;
  stars: number;
  keys: number;
  // bpm and lengthSec are rate-adjusted for the lane's speed bucket (DT 1.5x,
  // HT 0.75x), matching what the map detail page shows for the same rate.
  // Stars stay unscaled: both surfaces quote NM stars.
  bpm: number;
  lengthSec: number;
  reason: FarmHelperReason;
  estimatedPpGain: number;
  benchmarkPp: number;
  subjectPp: number | null;
  subjectPlayedAt: string | null;
  peerCount: number;
  peerSampleSize: number;
  peerFraction: number;
  // Shape similarity between the subject and this chart in [0,1], or null when
  // either side has no comparable shape. Distinct from peerFraction: this is
  // "is this my kind of chart", not "how many peers farm it".
  patternFit: number | null;
  peerPpMedian: number;
  peerPpP75: number;
  latestPeerPlayedAt: string | null;
  peerRecencyPlayedAt: string | null;
  topPeers: FarmHelperPeer[];
  scoreUrl: string | null;
  mapUrl: string;
  rankScore: number;
  // P(finish) estimate for this lane in [0,1] (see the SURVIVAL_* block).
  // 1 = no finish risk detected or lane already cleared by the subject; null
  // on the popular browse and when the backtest A/B flag disables the term.
  // The displayed gain/target stay if-you-finish values; the ranking already
  // discounted by this.
  survival: number | null;
  // True when survival fell below SURVIVAL_CLEAR_RISK_MAX AND the subject's
  // personal choke model contributed to it (predictPlayerChoke returned a
  // prediction): an honest "clear attempt, not a farm, for YOU" label for the
  // UI. A population-only discount still lowers the ranking (a sane prior)
  // but never produces the personal label.
  clearRisk: boolean;
  // The subject's active feedback mark on this lane ("too hard" only surfaces
  // on the popular browse; the gain view hides those lanes instead). Absent
  // when no active mark applies. Additive.
  feedback?: FarmHelperFeedbackVerdict;
}

export interface PeerBandSummary {
  mode: string;
  count: number;
  farmDataCount: number;
  minPp: number;
  maxPp: number;
  effectiveCount: number;
}

export interface FarmHelperSnapshot {
  status: "ready";
  userId: number;
  username: string;
  avatarUrl: string;
  coverUrl: string;
  pp: number;
  keyMode: FarmHelperKeyMode;
  view: FarmHelperView;
  // The merged cohort summary (union across both keymode runs on the "any" view,
  // a single cohort otherwise). Kept for compat.
  peerBand: PeerBandSummary;
  // Per-keymode cohort summaries, present only on the merged "any" view (not the
  // fallback), so the UI can show "4K: 12.9k-15.6k · 7K: 13.9k-16.9k". Additive.
  peerBands?: Partial<Record<ConcreteFarmHelperKeyMode, PeerBandSummary>>;
  totalPotentialPp: number;
  // What the gain numbers measure. "overall" = the player's profile pp (the
  // "any" view). "keymode" = the requested keymode's variant pp: a concrete
  // "4k"/"7k" request estimates gain within that keymode's own weighted list,
  // so a 7K main still gets real 4K suggestions even though no 4K play can
  // move their overall pp. Additive; absent on older cached snapshots.
  gainBasis?: "overall" | "keymode";
  // How many recommendations qualified before truncating to `limit`, so the UI
  // can say "showing 100 of 214" instead of implying the list is complete.
  totalQualifying: number;
  // Gain view only: how many lanes that passed every other gate (feasibility,
  // caps, benchmark, minimum gain) were hidden by active "too hard" marks, so
  // the UI can say "N hidden by your feedback". Lanes that would never have
  // qualified anyway are not counted. Additive; absent on the popular browse
  // and on older cached snapshots.
  feedbackHiddenCount?: number;
  // Gain view only: how many lanes cleared every gate except the minimum
  // visible gain (their scaled benchmark would move the baseline by under
  // MIN_VISIBLE_GAIN_PP). Lets an empty board say "peers are farming, it just
  // would not move your total" instead of implying there is no data. Additive;
  // absent on the popular browse and on older cached snapshots.
  belowGainFloorCount?: number;
  // False when the subject's skill breakdown is not "ready" yet (the same
  // condition that disables the feasibility gate and makes the acc model
  // abstain), so the UI can note that estimates are rough until the player's
  // plays are analyzed. Emitted on both views. Additive; absent on older
  // cached snapshots.
  modelsReady?: boolean;
  // Transparency: the per-keymode feasibility-margin adjustment the subject's
  // accumulated feedback marks applied to this build, as a signed fraction of
  // the base margin (e.g. { "4k": -0.10 } = the 4K margins ran 10% tighter).
  // Gain view only; omitted whenever no adjustment applied. Additive; the
  // frontend may ignore it.
  feedbackMarginAdjust?: Partial<Record<ConcreteFarmHelperKeyMode, number>>;
  recs: FarmHelperRec[];
  generatedAt: string;
}

export interface FarmHelperParams {
  keyMode?: FarmHelperKeyMode;
  view?: FarmHelperView;
  limit?: number;
  // Who is asking, when the request proved it. A player's feedback marks are
  // private (every other route that touches them is bridge-gated and forwards
  // an osu!-verified viewer id), but the marks also ride the snapshot as
  // per-rec tags and two envelope counters, and this endpoint names its subject
  // in the query string. So the marks are built into the wire payload only when
  // this equals the resolved subject; every public read gets a board with the
  // same recommendations and no trace of what its subject marked. Part of the
  // snapshot cache key, so an owner-scoped build is never handed to a stranger.
  viewerUserId?: number | null;
}

export class FarmHelperUserNotFoundError extends Error {
  constructor(key: string) {
    super(`farm helper could not resolve user "${key}"`);
    this.name = "FarmHelperUserNotFoundError";
  }
}

export type FarmHelperProfileLookupMode = "auto" | "userId";

export interface KnownFarmHelperSubject {
  lookupMode: FarmHelperProfileLookupMode;
}

/* Resolve only against local identity data. Public Farm Helper routes call this
   before getPlayerProfileSnapshot is allowed to mint anything, so a caller can
   search stored/roster players but cannot turn arbitrary usernames into osu!
   API work. Username precedence mirrors the profile resolver, including the
   unusual but valid case of an all-numeric username. */
export async function resolveKnownFarmHelperSubject(
  db: Db,
  rawKey: string,
): Promise<KnownFarmHelperSubject | null> {
  const key = normalizeIdentityKey(rawKey);
  if (!key || key.length > 120) return null;

  const storedByUsername = (await exec(
    db,
    "select 1 from profile_snapshots where username_key = ? limit 1",
    [key],
  )).rows[0];
  if (storedByUsername) return { lookupMode: "auto" };

  const usernameRow = (await exec(
    db,
    `select u.user_id,
            exists(select 1 from profile_snapshots ps where ps.user_id = u.user_id) as has_profile,
            exists(select 1 from country_rosters cr where cr.user_id = u.user_id) as has_roster
     from users u
     where lower(u.username) = ?
     limit 1`,
    [key],
  )).rows[0];
  if (usernameRow) {
    return Number(usernameRow.has_profile ?? 0) > 0 || Number(usernameRow.has_roster ?? 0) > 0
      ? { lookupMode: "auto" }
      : null;
  }

  const numericKey = Number(key);
  if (!Number.isSafeInteger(numericKey) || numericKey <= 0) return null;
  const storedById = (await exec(
    db,
    "select 1 from profile_snapshots where user_id = ? limit 1",
    [numericKey],
  )).rows[0];
  if (storedById) return { lookupMode: "auto" };
  const rosterById = (await exec(
    db,
    "select 1 from country_rosters where user_id = ? limit 1",
    [numericKey],
  )).rows[0];
  // Force an id lookup for a roster-only numeric key. Auto mode tries numeric
  // usernames first and could otherwise hydrate a different, unknown account.
  return rosterById ? { lookupMode: "userId" } : null;
}

export const FARM_HELPER_DEFAULT_LIMIT = 100;
export const FARM_HELPER_MAX_LIMIT = 200;
// Kernel-kNN peer model (Stage 2). Distance d = (peerModePp - subjectModePp) /
// subjectModePp. Two triangular kernels over the same fetched cohort: an
// up-skewed "discovery" kernel decides which maps enter the candidate pool (peers
// slightly above you hold your next farm set), and a symmetric "benchmark" kernel
// weights the pp quantiles so an up-skewed cohort cannot inflate the target pp.
const DISCOVERY_KERNEL_DOWN = 0.08;
const DISCOVERY_KERNEL_UP = 0.15;
const BENCHMARK_KERNEL_HALF_WIDTH = 0.10;
// Calibrated-proxy peers (no real variant pp) are down-weighted: their distance
// is an estimate, not a measurement.
const PROXY_CONFIDENCE = 0.85;
// Cohort affinity (Stage 5): pp proximity alone kept long-inactive players
// (frozen pp, years-old farm sets) and off-style specialists at full cohort
// weight. Each keymode peer's kernel confidence is additionally scaled by
//  - recency: full weight while their newest top play in the keymode is under
//    RECENCY_FULL_MS old, then a half-life decay down to a floor (never zero:
//    an inactive peer's farm data is stale evidence, not no evidence), and
//  - skill-shape similarity: Pearson correlation between the subject's and
//    peer's Overall-normalized baseline rating shapes (what they are good at
//    relative to their level; the level itself is already the pp distance),
//    mapped onto [SKILL_SIM_FLOOR, 1].
// Both factors read the weekly player_skill_baseline vectors and stay neutral
// (1.0) whenever a vector is missing - the model must never reject on missing
// data, and before the first baseline run it behaves exactly like pure pp kNN.
const RECENCY_FULL_MS = 180 * 86_400_000;
const RECENCY_HALF_LIFE_MS = 365 * 86_400_000;
const RECENCY_FLOOR = 0.25;
const SKILL_SIM_FLOOR = 0.35;
const SKILL_SIM_MIN_PLAYS = 10;
const SKILL_SIM_MIN_SHARED_AXES = 3;
// Effective sample = sum of discovery weights. Below this, widen both kernels.
const MIN_EFFECTIVE_PEERS = 12;
const KNN_MAX_PEERS = 400;
const KNN_WIDEN_MODES = ["knn", "knn_wide", "knn_wider", "knn_widest"] as const;
// When even the widest kernel finds (nearly) nobody, fall back to the nearest
// peers by mode-pp distance at a flat floor weight, so pp-isolated subjects (top
// ranks, sparse keymodes) still get a cohort instead of an empty page. Mirrors
// the old band ladder's unconditional "nearest" terminal mode.
const SPARSE_FALLBACK_PEERS = 100;
const SPARSE_FALLBACK_WEIGHT = 0.25;
// Feasibility gate (Stage 4): drop a chart from the gain view when the axes
// that define it - the dominant MSD skillset, near-dominant secondary
// skillsets, or its pattern family - exceed the subject's demonstrated
// ratings by the margin. The "normal" lane uses stored 1.0x MSD; the "dt"
// lane uses the rate-adjusted 1.5x MSD from the DT-rate analysis sweep
// (chart-analysis.ts), with a wider margin since 1.5x charts sit higher on
// the same skill axis; the "ht" lane has no stored 0.75x MSD, so it screens
// against the 1.0x MSD scaled by the rate (a fair mid estimate of MinaCalc's
// rate response, and the margin absorbs the error).
// Per-keymode feasibility margins (normal / DT lanes). The gate covers every
// keymode the skill pipeline rates; 7K runs wider margins because MinaCalc's
// skillset taxonomy is 4K-born and per-axis values are noisier there, so only
// clearly-out-of-reach charts should drop. This is what keeps a high-pp LN
// main from being fed rice-speed charts their pp alone says they can farm:
// the pp is LN-earned, but the gate compares the chart's dominant skillset
// against what their plays actually demonstrated on that axis.
// Since the A8 predicted-accuracy scaling landed, this hard gate is the
// extreme backstop rather than the primary filter: inside the margins the
// continuous multiplier discounts targets toward what the subject would
// actually score, and for subjects with a fitted (steep) accuracy curve the
// multiplier collapses out-of-reach charts well before the margin. The
// margins stay unchanged because prior-dominated subjects (thin evidence)
// have shallow curves that discount a 3+ MSD overshoot only mildly - for
// them the cliff is still what stands between an LN main and rice-jack recs.
const FEASIBILITY_MARGINS: Record<number, { normal: number; dt: number }> = {
  4: { normal: 3.0, dt: 3.5 },
  7: { normal: 3.5, dt: 4.0 },
};
const FEASIBILITY_MIN_ANALYZED_PLAYS = 30;
// A keymode below the analyzed-plays floor still gates - on cross-keymode
// transferred ratings - but conservatively: margins tighten by this ratio and
// targets cap at the keymode's demonstrated top play. (Omitting sparse
// keymodes, the old behavior, inverted the gate: the players with the least
// evidence in a keymode got zero filtering there.)
const FEASIBILITY_SPARSE_MARGIN_RATIO = 0.5;
// Secondary MSD axes within this window of the dominant one are checked too:
// a chart defined almost equally by two skillsets is not farmable on the
// strength of just one of them. Axes well below the dominant stay unchecked
// (they are texture, not the chart's identity).
const FEASIBILITY_SECONDARY_AXIS_WINDOW = 1.0;
// The HT lane's 0.75x MSD approximation: linear rate scaling of the stored
// 1.0x vector. No chart-identity data involved; replace with a stored 0.75x
// sweep if one ever lands.
const FEASIBILITY_HT_RATE_MSD_RATIO = 0.75;
// Feedback generalization: the subject's active too_hard/too_easy marks vote
// on the feasibility gate's per-keymode margins, so a handful of marks
// auto-adjusts recommendations beyond the marked lanes themselves. Each usable
// mark is classified against the gate's CURRENT (base-margin) verdict for the
// marked chart on the same MSD ruler the gate uses:
//  - too_hard on a chart the gate would PASS -> a tighten vote (the ceiling
//    let through something the player says is out of reach);
//  - too_easy on a chart the gate would DROP, or that passes only inside the
//    margin band (some checked axis above the subject's rating) -> a loosen
//    vote (the ceiling is too strict);
//  - marks that agree with the gate (too_hard on an already-dropped chart,
//    too_easy on a comfortably-passing one) carry no signal.
// Per keymode, net = tighten - loosen votes; nothing moves below
// FEEDBACK_MIN_NET_VOTES. The margin then scales by 1 + adjust, where
// abs(adjust) = FEEDBACK_MARGIN_STEP per net vote beyond the first, clamped
// to FEEDBACK_MARGIN_MAX_ADJUST (tighten shrinks the margin, loosen widens
// it). Gain view only, never when the skill breakdown is not ready (the gate
// is off entirely there), and never on the backtest path (no marks load).
// Per-lane effects keep precedence on their own lane: a too_easy-marked lane
// still bypasses the gate outright even under a tightened ceiling. Resolved
// marks drop out of the active set, retiring their votes automatically.
const FEEDBACK_MIN_NET_VOTES = 2;
const FEEDBACK_MARGIN_STEP = 0.05;
const FEEDBACK_MARGIN_MAX_ADJUST = 0.15;
const PEER_MIN_COUNT = 3;
const PEER_MIN_FRACTION = 0.12;
// A peer only counts toward the peerFraction denominator once it has farmed at
// least this many maps, so the fraction is not deflated by peers who barely
// appear in the farm data (the old denominator counted anyone with >= 1 row).
const MIN_FARMED_FOR_SAMPLE = 5;
// Popular mode is a browse view, so the popularity floor is lower than the
// personalized view's and the difficulty/value gates are skipped entirely.
const POPULAR_PEER_MIN_FRACTION = 0.05;
const IMPROVE_MARGIN_PP = 8;
const STALE_AGE_MS = 120 * 86_400_000;
const STALE_ACTIVE_MS = 180 * 86_400_000;
const FIT_SAMPLE_SIZE = 50;
const STAR_BUFFER = 0.5;
const TOP_PEERS_PER_REC = 4;
const MODE_TOP_PP_HEADROOM = 1.04;
// Growth allowance over a demonstrated top play for benchmark caps: targets
// modestly above the best play a player has shown are the growth path;
// targets far above it are peer projection, not evidence.
const MODE_TOP_PP_GROWTH_HEADROOM = 1.15;
const MODE_WEIGHTED_PP_BENCHMARK_CAP_RATIO = 0.2;
const MISSING_MAP_BENCHMARK_QUANTILE = 0.4;
const PLAYED_MAP_BENCHMARK_STEP = 0.06;
const PLAYED_MAP_MIN_STEP_PP = 30;
const MIN_VISIBLE_GAIN_PP = 1;
// Self-improvement ("push") targets for owned lanes where no peer benchmark
// sits above the subject (so neither "improve" nor "stale" fired). For a fixed
// map+mods, mania pp is linear in (5 * acc - 4) with acc the 320-weighted
// custom accuracy (NF/EZ multipliers cancel out on the same score), so the
// target rescales the subject's own pp to a modestly higher accuracy:
//   pp_target = pp_now * (5 * acc_target - 4) / (5 * acc_now - 4).
// Guardrails:
//  - the step is fixed and small (PUSH_ACC_STEP on the custom-accuracy scale);
//  - the target accuracy never exceeds the keymode's demonstrated best custom
//    accuracy plus a small headroom, nor the absolute ceiling (a near-SS score
//    is not a push target);
//  - the remaining accuracy delta must be meaningful (PUSH_MIN_ACC_DELTA,
//    deliberately above PUSH_ACC_BEST_HEADROOM so a score already at the
//    player's demonstrated best accuracy never pushes);
//  - at most PUSH_MAX_PER_RUN push entries per mode run (strongest estimated
//    gain first), and push rank scores are scaled down so peer-driven reasons
//    outrank them at comparable gain.
// The existing IMPROVE_MARGIN_PP and MIN_VISIBLE_GAIN_PP gates apply on top.
const PUSH_ACC_STEP = 0.0075;
const PUSH_ACC_BEST_HEADROOM = 0.0025;
const PUSH_ACC_CEILING = 0.998;
const PUSH_MIN_ACC_DELTA = 0.003;
const PUSH_MAX_PER_RUN = 8;
const PUSH_RANK_SCORE_FACTOR = 0.85;
// Continuous feasibility via the personal accuracy model (A8). Peer-derived
// benchmarks (missing/improve/stale) are scaled by
//   (5 * accYou - 4) / (5 * accTypical - 4)
// - the exact pp-linearity factor of the mania pp formula - so the displayed
// target becomes what THIS player would plausibly score, and charts the model
// says they cannot hit accuracy on collapse in the gain ranking instead of
// (only) being cliff-dropped by the hard feasibility gate. accYou is the
// prediction's confidence-shaded accConservative: thin evidence discounts,
// never inflates. accTypical is the candidate lane's stored peer accuracy
// (weighted median over the same wB kernel as the pp quantiles) once at least
// ACC_TYPICAL_MIN_PEER_ACCS rows carry one; until the A9 columns fill it
// falls back to the model's global prior at gap 0, which keeps the multiplier
// near 1 on an on-level chart. The multiplier is clamped to [0, 1] (a
// discount, never a boost: peer evidence stays the ceiling) and every
// existing cap (mode cap, family cap, nextPlayedMapBenchmark) still binds on
// the scaled value. Push targets are never scaled - they are already derived
// from the subject's own accuracy. The hard gate above keeps its margins as
// the extreme backstop: for prior-dominated subjects the model's slopes are
// too shallow to collapse a 3+ MSD overshoot on their own.
const ACC_TYPICAL_MIN_PEER_ACCS = 5;
// Numeric safety rails on the typical-accuracy denominator: (5 * acc - 4)
// crosses 0 at 80%, and farmed top plays below ~85% custom accuracy are
// noise, not a benchmark's accuracy.
const ACC_TYPICAL_MIN = 0.85;
const ACC_TYPICAL_MAX = 0.999;
// Survival term (A10): a P(finish) estimate per un-cleared candidate lane,
// combining three independent signals into one multiplier in [SURVIVAL_FLOOR, 1]:
//   pFinish = popFactor * chokeFactor ^ lengthExp
//  - popFactor: the osu! population pass rate (map_search_index
//    pass_count / play_count, healed hourly by D1). play_count includes
//    retries and fails, so the ratio is ordinal evidence of "people fail
//    this a lot", never a literal probability: the shrunk rate (pseudo-count
//    prior, so thin play counts stay near neutral) only discounts once it
//    falls below the LOW anchor (set near the index's 10th-15th percentile,
//    measured 2026-07: median 0.35, p10 0.18), down to a floor. Anchoring on
//    the low tail instead of the median matters: most farm maps sit below
//    the mean-ish rates, and discounting the whole midfield would act as a
//    coverage penalty (charts missing from the index would float above
//    covered ones). Missing or zero play_count is no signal (factor 1).
//  - chokeFactor: the subject's own missShare-vs-gap choke curve
//    (predictPlayerChoke at the lane's chart Overall, the same laneChartOverall
//    the A8 scaling uses). A high predicted choke rate discounts up to
//    SURVIVAL_CHOKE_MAX_PENALTY, scaled by the curve's confidence so thin
//    evidence stays near neutral. No model / no chart Overall: factor 1.
//  - lengthExp: map length compounds the subject's choke risk (more chances
//    to drop the HP bar), so the choke factor is raised to lane length /
//    SURVIVAL_LENGTH_REF_SEC, clamped. Length alone never discounts: with a
//    neutral choke factor (1) the exponent is a no-op, and the population
//    factor already reflects length implicitly.
// Each factor is monotone in its signal and every missing signal degrades to
// exactly 1 (never punish missing data). Uses: the merged gain ranking runs
// on the EXPECTED gain (estimatedPpGain * pFinish) so risky clears sink,
// while the displayed target pp and gain stay the honest if-you-finish
// values; below SURVIVAL_CLEAR_RISK_MAX the rec carries clearRisk = true and
// the UI labels it a clear attempt rather than a farm. Lanes the subject
// already cleared (improve/stale/push) are proven finishable and stay at 1.
// Shrinkage target: the typical ranked-mania pass ratio (prod index median).
const SURVIVAL_PASS_PRIOR_RATE = 0.35;
const SURVIVAL_PASS_PRIOR_PLAYS = 200;
// Discount anchor: rates at or above this stay neutral; the factor falls
// linearly below it, hitting SURVIVAL_PASS_FLOOR at half the anchor.
const SURVIVAL_PASS_LOW_RATE = 0.2;
const SURVIVAL_PASS_FLOOR = 0.5;
const SURVIVAL_CHOKE_MAX_PENALTY = 0.6;
const SURVIVAL_LENGTH_REF_SEC = 120;
const SURVIVAL_LENGTH_EXP_MIN = 0.5;
const SURVIVAL_LENGTH_EXP_MAX = 2.5;
const SURVIVAL_FLOOR = 0.2;
export const SURVIVAL_CLEAR_RISK_MAX = 0.6;
const FARM_HELPER_CONCRETE_KEY_MODES = ["4k", "7k"] as const satisfies readonly ConcreteFarmHelperKeyMode[];

const CACHE_TTL_MS = 5 * 60_000;
// Entries are finished snapshots (tens of KB), not row sets, and one subject
// can occupy up to six slots (3 keymodes x 2 views), so 64 thrashed under a
// dozen concurrent players and every eviction was a full rebuild. 256 holds
// ~40 concurrent subjects for a few MB.
const CACHE_MAX_ENTRIES = 256;

interface CachedFarmHelper {
  snapshot: FarmHelperSnapshot;
  expiresAt: number;
}

// Per-Db cache (one Db per process in prod; tests get a fresh Db each). The
// per-subject peer-band cache is gone: the expensive fetch is the per-keyCount
// pool, cached subject-independently inside farm-helper-key-stats.
const farmHelperCache = new WeakMap<Db, Map<string, CachedFarmHelper>>();

// Raw request key -> canonical osu! user id.
//
// The snapshot cache is keyed by canonical user id, but the id used to be
// known only AFTER full profile resolution, so every cache hit still paid for
// a stored-profile read and its top-play projection (~110ms on prod-sized
// data) before it could find out it had nothing to do. This alias map answers
// "which user is `xX_player_Xx`?" first, so a hit skips hydration entirely.
//
// Aliases outlive snapshot invalidation on purpose: a feedback mark changes
// what the snapshot says, never who the player is, and an osu! user id is
// stable for the life of the account.
//
// The TTL matches the snapshot TTL rather than exceeding it, because an alias
// pays off in exactly one place - letting a request find a still-cached
// snapshot without hydrating the profile first. An alias that outlives every
// snapshot it could match saves nothing, and only widens the window in which a
// username freed by a rename still points at the account that gave it up.
const IDENTITY_ALIAS_TTL_MS = CACHE_TTL_MS;
const IDENTITY_ALIAS_MAX_ENTRIES = 1024;
const identityAliasCache = new WeakMap<Db, Map<string, { userId: number; expiresAt: number }>>();

// In-flight snapshot builds, so N simultaneous requests for the same subject
// run one build instead of N. Entries are always removed in `finally`, so a
// failed build is never retained and the next request retries it.
const inFlightBuilds = new WeakMap<Db, Map<string, Promise<FarmHelperSnapshot>>>();

// Bumped by every invalidation. A build that started before the bump must not
// write its result into the cache afterwards, or a feedback mark set mid-build
// would be undone by the older build landing a moment later. One counter for
// the whole Db rather than one per user: invalidations are rare (a feedback
// mutation, an ingest auto-resolve), so over-invalidating a concurrent build
// costs one rebuild, while a per-user map would grow with every subject.
const cacheGenerations = new WeakMap<Db, { value: number }>();

const TOTAL_PP_POOL_TTL_MS = 5 * 60_000;
interface CachedTotalPpPool {
  rows: Array<{ userId: number; pp: number }>;
  expiresAt: number;
}
const totalPpPoolCache = new WeakMap<Db, CachedTotalPpPool>();

// A cohort peer with both kernel weights. modePp is the effective mode pp used
// for distance (real variant pp, calibrated proxy, or total pp for "any"); pp is
// the display-only total pp.
interface WeightedPeer {
  userId: number;
  pp: number;
  modePp: number;
  wD: number;
  wB: number;
  // True for calibrated-proxy peers that were never variant-enriched: an
  // enrich_user fetch can still replace their proxy with real variant pp, so
  // the cohort self-heal targets them.
  needsVariantEnrich?: boolean;
}

type ProfileOsuClient = Pick<OsuApiClient, "getUser" | "getUserByKey" | "getUserBestScoresWindow">;

interface SubjectMapScore {
  pp: number;
  endedAt: string | null;
  scoreId: number;
  speedBucket: ScoreSpeedBucket;
  // 320-weighted custom accuracy of this score, or null when the score carries
  // no judgement counts. Feeds the "push" target's pp-linearity rescale.
  customAccuracy: number | null;
  // The newest ended_at across ALL of the subject's windowed plays on this
  // lane, not just the best-pp one. The "stale" reason requires BOTH the PB
  // and the latest play to be old: replaying a map yesterday (scoring lower)
  // is fresh engagement, not an old PB gathering dust. Display keeps the PB's
  // endedAt (the copy talks about the PB's age).
  latestEndedAt: string | null;
}

// One farmed entry per cohort peer on a map: their farmed pp plus the kernel
// weights carried over from peer selection (wD for discovery/fraction, wB for
// the benchmark quantiles).
interface CandidatePeerEntry {
  userId: number;
  pp: number;
  wD: number;
  wB: number;
  // 320-weighted custom accuracy of the farmed score (the A9 column), or null
  // on rows written before the column existed. Feeds the A8 benchmark
  // scaling's "typical peer accuracy" once enough rows carry one.
  acc: number | null;
}

interface CandidateAgg {
  beatmapId: number;
  speedBucket: ScoreSpeedBucket;
  entries: CandidatePeerEntry[];
  modCombos: Map<string, { mods: string[]; count: number; ppTotal: number }>;
  latestUpdatedMs: number;
  playedAtMs: number[];
}

interface PeerFarmedAggregation {
  byBeatmap: Map<string, CandidateAgg>;
  // Cohort peers with any farm data (>= 1 row).
  farmDataPeerCount: number;
  // Cohort peers with a meaningful farm sample (>= MIN_FARMED_FOR_SAMPLE rows):
  // the peerFraction denominator, as a count, a discovery-weight sum, and the
  // id set (so the fraction NUMERATOR can be restricted to the same peers -
  // summing every lane entry's wD against an eligible-only denominator
  // overflowed past 1 and hid behind the Math.min clamp).
  eligiblePeerCount: number;
  eligibleWdSum: number;
  eligibleIds: Set<number>;
}

interface CanonicalFarmedScore {
  userId: number;
  beatmapId: number;
  pp: number;
  mods: string[];
  speedBucket: ScoreSpeedBucket;
  playedAtMs: number;
  updatedAtMs: number;
  // Stored 320-weighted custom accuracy (A9), null on pre-column rows or on
  // reads that do not select the column.
  accuracy: number | null;
}

interface BeatmapMeta {
  beatmapId: number;
  beatmapsetId: number;
  stars: number;
  keys: number;
  bpm: number;
  lengthSec: number;
  version: string;
  url: string;
  status: string;
}

interface BeatmapsetMeta {
  beatmapsetId: number;
  title: string;
  artist: string;
  creator: string;
  status: string;
  cover: string;
  listCover: string;
}

export interface FarmHelperSnapshotOptions {
  // Dedicated write connection for the read-time feedback reconcile. On the
  // HTTP path this must be ctx.serveWriteDb ?? ctx.db (the serving-path write
  // invariant: no write may queue on the connection that serves page-load
  // reads; see server.ts). Callers that omit it (Discord, tests) write on the
  // read connection, which is fine off the serving path.
  writeDb?: Db;
  // Optional stage-level timing collector. The HTTP path always passes one so
  // a slow request names the stage that cost the time; every other caller
  // omits it and the instrumentation compiles away to one branch per stage.
  timings?: FarmHelperTimings;
  // Trusted callers may force a numeric subject to resolve as an id. The HTTP
  // route uses this only for a roster-only numeric key or for the bridge-proven
  // viewer's own id, avoiding osu!'s valid all-numeric username ambiguity.
  profileLookupMode?: FarmHelperProfileLookupMode;
}

export async function getFarmHelperSnapshot(
  db: Db,
  osu: ProfileOsuClient,
  rawKey: string,
  params: FarmHelperParams = {},
  queue?: JobQueue,
  options: FarmHelperSnapshotOptions = {},
): Promise<FarmHelperSnapshot> {
  const requestedKeyMode = params.keyMode ?? "any";
  const view = params.view ?? "gain";
  const limit = clampLimit(params.limit);
  const timings = options.timings;
  const profileLookupMode = options.profileLookupMode ?? "auto";
  const viewerUserId = Number.isInteger(params.viewerUserId) && Number(params.viewerUserId) > 0
    ? Number(params.viewerUserId)
    : 0;
  // The viewer is part of the variant: an owner-scoped build carries the
  // subject's private marks, so it must never be served from (or into) the
  // entry a public read uses. Only the subject's own requests carry a viewer,
  // so this adds at most one extra entry per subject.
  const variantKey = `${requestedKeyMode}:${view}:${limit}:${viewerUserId}`;
  const aliasKey = normalizeIdentityKey(rawKey);

  // Identity first: with the canonical id already known, a fresh snapshot is
  // served without touching the profile snapshot or its projection.
  const forcedUserId = profileLookupMode === "userId" && aliasKey != null
    && Number.isSafeInteger(Number(aliasKey)) && Number(aliasKey) > 0
    ? Number(aliasKey)
    : null;
  const aliasUserId = forcedUserId ?? (aliasKey ? readIdentityAlias(db, aliasKey) : null);
  if (aliasUserId != null) {
    timings?.setSubject({ userId: aliasUserId, keyMode: requestedKeyMode, view, limit });
    const hit = takeFreshSnapshot(db, `${aliasUserId}:${variantKey}`);
    if (hit) {
      timings?.setCacheState("hit");
      return hit;
    }
  }

  // Single-flight. Keyed by canonical id when the alias resolved it, else by
  // the raw key so simultaneous first-time requests for one username share a
  // single cold mint instead of racing two osu! fetches.
  const flightKey = aliasUserId != null ? `${aliasUserId}:${variantKey}` : `raw:${aliasKey ?? rawKey}:${variantKey}`;
  const flights = getInFlightBuilds(db);
  const running = flights.get(flightKey);
  if (running) {
    timings?.setCacheState("coalesced");
    // Awaiting a build started elsewhere: this request cannot cancel it, and
    // a rejection fans out to every waiter without being cached.
    return running;
  }

  // A cold subject starts out registered under its raw key, because that is all
  // this request knows. The moment the build resolves identity it registers the
  // same promise under the canonical key too, so later requests naming the same
  // player any other way coalesce onto it, and so invalidation - which can only
  // look for the `<userId>:` prefix - can actually reach it.
  const registeredKeys = [flightKey];
  let build!: Promise<FarmHelperSnapshot>;
  const onIdentityResolved = (userId: number) => {
    const canonicalKey = `${userId}:${variantKey}`;
    if (canonicalKey === flightKey || flights.has(canonicalKey)) return;
    flights.set(canonicalKey, build);
    registeredKeys.push(canonicalKey);
  };

  build = resolveAndBuildSnapshot(db, osu, rawKey, aliasKey, {
    requestedKeyMode,
    view,
    limit,
    variantKey,
    viewerUserId,
    profileLookupMode,
    queue,
    options,
    // Read before any I/O: an invalidation that lands while this request is
    // still resolving identity must also stop it caching its result.
    generation: readCacheGeneration(db),
    onIdentityResolved,
  }).finally(() => {
    // Only ever unregister THIS build. An invalidation can drop the key
    // mid-flight and a newer build can claim it, and a blind delete would
    // then unregister the newer build and stop coalescing for its whole run.
    for (const key of registeredKeys) {
      if (flights.get(key) === build) flights.delete(key);
    }
  });
  flights.set(flightKey, build);
  return build;
}

// Everything a miss has to do: resolve the subject, re-check the canonical
// cache (another raw key for the same player may have finished a build while
// this one waited on identity), then build and store.
async function resolveAndBuildSnapshot(
  db: Db,
  osu: ProfileOsuClient,
  rawKey: string,
  aliasKey: string | null,
  request: {
    requestedKeyMode: FarmHelperKeyMode;
    view: FarmHelperView;
    limit: number;
    variantKey: string;
    // 0 for a public read; a positive id only when the caller proved it.
    viewerUserId: number;
    profileLookupMode: FarmHelperProfileLookupMode;
    queue?: JobQueue;
    options: FarmHelperSnapshotOptions;
    generation: number;
    // Called once the canonical user id is known, so the caller can register
    // this build under its canonical single-flight key as well.
    onIdentityResolved?: (userId: number) => void;
  },
): Promise<FarmHelperSnapshot> {
  const { requestedKeyMode, view, limit, variantKey, viewerUserId, profileLookupMode, queue, options, generation } = request;
  const timings = options.timings;

  const profile = await timeStage(timings, "fh_profile", () => resolveProfile(db, osu, rawKey, queue, profileLookupMode));
  const user = profile.user;
  const userId = Number(user.id ?? 0);
  if (!Number.isInteger(userId) || userId <= 0) throw new FarmHelperUserNotFoundError(rawKey);
  request.onIdentityResolved?.(userId);

  const statistics = asRecord(user.statistics);
  const subjectPp = numberOr(statistics.pp, 0);
  const subjectVariantPps = getVariantPps(statistics);
  const username = String(user.username ?? rawKey);
  const avatarUrl = String(user.avatar_url ?? "");
  const coverUrl = String(user.cover_url ?? asRecord(user.cover).url ?? "");

  // Identity is now known: record it so the next request naming this player the
  // same way skips profile hydration.
  //
  // Only keys that PROVABLY resolve to this account are aliased, and
  // `String(userId)` is deliberately not one of them. osu! usernames may be
  // entirely numeric, and the resolver looks a raw key up as a username before
  // it tries it as an id (getStoredProfileSnapshot, then getUserByKey). So if
  // account 5092 is "indridcold" while some other account is *named* "5092",
  // then "5092" as a request key means that other account - and aliasing
  // "5092" -> 5092 here would answer their request with indridcold's board.
  // `aliasKey` is safe because it is the key that just resolved to this user,
  // and the username is safe because a username lookup is what the resolver
  // tries first.
  if (profileLookupMode === "auto") writeIdentityAlias(db, aliasKey, userId);
  writeIdentityAlias(db, normalizeIdentityKey(username), userId);

  const cache = getCache(db);
  // Queue-less callers (Discord) share this per-Db cache with the HTTP path.
  // Snapshot content no longer depends on the queue - the feasibility gate
  // reads stored skill ratings either way - so one entry serves both; only
  // the fire-and-forget self-heal enqueues differ.
  const cacheKey = `${userId}:${variantKey}`;
  timings?.setSubject({ userId, keyMode: requestedKeyMode, view, limit });
  const cached = takeFreshSnapshot(db, cacheKey);
  if (cached) {
    timings?.setCacheState("hit");
    return cached;
  }
  timings?.setCacheState(cache.has(cacheKey) ? "expired" : "miss");

  const snapshot = await buildSnapshot(db, profile.bestScores, {
    userId,
    username,
    avatarUrl,
    coverUrl,
    subjectPp,
    subjectVariantPps,
    requestedKeyMode,
    view,
    limit,
    // Owner-scoped build: only then do the subject's own marks reach the wire.
    isOwnerView: viewerUserId > 0 && viewerUserId === userId,
    queue,
    writeDb: options.writeDb,
    timings,
  });

  // Only cache a build nothing invalidated while it ran. The caller still gets
  // this snapshot (it is the best answer available for a request that started
  // before the change); the next request rebuilds instead of reading it back.
  if (readCacheGeneration(db) === generation) {
    const store = getCache(db);
    store.set(cacheKey, { snapshot, expiresAt: Date.now() + CACHE_TTL_MS });
    while (store.size > CACHE_MAX_ENTRIES) {
      const oldest = store.keys().next().value;
      if (oldest === undefined) break;
      store.delete(oldest);
    }
  }
  return snapshot;
}

export interface FarmHelperBacktestOptions {
  asOf: number;
  keyMode?: FarmHelperKeyMode;
  view?: FarmHelperView;
  limit?: number;
  // Disables the A8 predicted-accuracy benchmark scaling for A/B comparison.
  noAccScaling?: boolean;
  // Disables the A10 survival term (ranking discount + clear-risk label) for
  // A/B comparison.
  noSurvival?: boolean;
  // Injects the subject's acc model (see BuildCtx.accModelOverride).
  accModel?: PlayerAccModel | null;
}

// Offline backtest entry point. Reconstructs a farm-helper snapshot "as of" a
// past cutoff from stored data only (no osu! API, no top-level cache), so the
// maintenance harness can score recommendation quality before and after each
// redesign stage. The subject's best scores are filtered by ended_at here; peer
// farmed rows are filtered by played_at inside buildSnapshot. Never call this on
// the HTTP path: it takes an already-resolved profile and skips all caching.
export async function buildFarmHelperSnapshotForBacktest(
  db: Db,
  user: Record<string, unknown>,
  bestScores: OscScore[],
  options: FarmHelperBacktestOptions,
): Promise<FarmHelperSnapshot> {
  const requestedKeyMode = options.keyMode ?? "any";
  const view = options.view ?? "gain";
  const limit = clampLimit(options.limit);
  const asOf = options.asOf;

  const statistics = asRecord(user.statistics);
  const subjectPp = numberOr(statistics.pp, 0);
  const subjectVariantPps = getVariantPps(statistics);
  const username = String(user.username ?? "");
  const avatarUrl = String(user.avatar_url ?? "");
  const coverUrl = String(user.cover_url ?? asRecord(user.cover).url ?? "");

  const asOfScores = bestScores.filter((score) => {
    const endedAt = score.ended_at;
    if (!endedAt) return true;
    const ms = Date.parse(endedAt);
    return !Number.isFinite(ms) || ms <= asOf;
  });

  return buildSnapshot(db, asOfScores, {
    userId: Number(user.id ?? 0),
    username,
    avatarUrl,
    coverUrl,
    subjectPp,
    subjectVariantPps,
    requestedKeyMode,
    view,
    limit,
    asOf,
    disableAccScaling: options.noAccScaling === true,
    disableSurvival: options.noSurvival === true,
    ...("accModel" in options ? { accModelOverride: options.accModel } : {}),
  });
}

async function resolveProfile(
  db: Db,
  osu: ProfileOsuClient,
  rawKey: string,
  queue?: JobQueue,
  lookupMode: FarmHelperProfileLookupMode = "auto",
) {
  try {
    // The queue is how a stored profile gets refreshed at all now, so passing
    // it is what keeps farm-helper subjects from serving a frozen snapshot.
    // Note BPM is profile-page decoration read off a separate indexed lookup
    // over ~200 beatmaps; nothing in the recommendation build consumes it, so
    // skipping it takes that lookup off every Farm Helper request.
    return await getPlayerProfileSnapshot(db, osu, rawKey, { queue, includeNoteBpms: false, lookupMode });
  } catch (error) {
    if (error instanceof OsuApiError && error.status === 404) throw new FarmHelperUserNotFoundError(rawKey);
    throw error;
  }
}

// Shared request context threaded through the per-mode runs and the shared
// scoring helper. Each run reads `subjectVariantPps[mode]` directly.
interface BuildCtx {
  userId: number;
  username: string;
  avatarUrl: string;
  coverUrl: string;
  subjectPp: number;
  subjectVariantPps: Partial<Record<ConcreteFarmHelperKeyMode, number>>;
  requestedKeyMode: FarmHelperKeyMode;
  view: FarmHelperView;
  limit: number;
  // True when the request proved it is the subject (see
  // FarmHelperParams.viewerUserId). The marks always shape the board; this only
  // decides whether they are also described on the wire.
  isOwnerView?: boolean;
  // Internal-only "as of" cutoff (epoch ms) used exclusively by the offline
  // backtest harness to reconstruct a historical snapshot: subject best scores
  // are pre-filtered by the caller, peer farmed rows are filtered by played_at,
  // and all in-memory caches are bypassed. Never set on the HTTP path.
  asOf?: number;
  // Optional queue for the fire-and-forget self-heal that enqueues chart
  // analysis for the subject's uncovered top plays. Absent on the backtest path.
  queue?: JobQueue;
  // Dedicated write connection for the read-time feedback reconcile (the
  // serving-path invariant; see FarmHelperSnapshotOptions). Falls back to the
  // read connection when absent. Unused on the backtest path (asOf skips
  // feedback loading entirely).
  writeDb?: Db;
  // The subject's skill breakdown, read once per request in buildSnapshot and
  // shared by every mode run (feasibility gate, modelsReady flag).
  skillBreakdown?: PlayerSkillBreakdown;
  // Backtest A/B switch (--no-acc-scaling): skips the personal-accuracy
  // benchmark scaling so its effect stays measurable in isolation. Never set
  // on the HTTP path.
  disableAccScaling?: boolean;
  // Backtest A/B switch (--no-survival): skips the A10 survival term
  // (survival stays null, no ranking discount, no clear-risk labels). Never
  // set on the HTTP path.
  disableSurvival?: boolean;
  // Backtest-only model injection: when set (including an explicit null), the
  // snapshot uses this model instead of reading player_skill_ratings, so the
  // harness can serve a freshly fitted model on DBs whose skills job has not
  // stored acc_model_json yet. Never set on the HTTP path.
  accModelOverride?: PlayerAccModel | null;
  // The subject's active feedback marks keyed by farmHelperLaneKey, loaded
  // once in buildSnapshot after the read-time reconcile. Absent when there are
  // none and on the backtest path (marks are live player state, and the
  // reconcile writes; a historical reconstruction must do neither).
  activeFeedback?: Map<string, FarmHelperFeedbackVerdict>;
  // Per-keymode feasibility-margin adjustment generalized from the active
  // marks (see the FEEDBACK_MARGIN_* block), computed once in buildSnapshot
  // and read by every mode run's gate. Absent when no adjustment applies
  // (popular view, backtest, breakdown not ready, or below the vote floor).
  feedbackMarginAdjust?: Partial<Record<ConcreteFarmHelperKeyMode, number>>;
  // Optional stage-level timing collector (see FarmHelperSnapshotOptions).
  timings?: FarmHelperTimings;
}

// Subject state prepared once per request and shared by every mode run.
interface PreparedSubject {
  rankedScores: OscScore[];
  subjectByBeatmap: Map<string, SubjectMapScore>;
  baselineEntries: Array<{ pp: number; beatmapId: number }>;
  baselineTotal: number;
  // Keymode-local weighted lists (the subject's virtual variant-pp profiles).
  // A concrete-keymode request estimates gain against these instead of the
  // overall list: a 7K main's feasible 4K plays land far past the overall
  // top-plays cutoff (gain ~0, every rec dropped), but they still move the
  // player's 4K variant pp, which is what a "4k"-scoped run is about.
  // Calibrated against the official variant pp (see padModeBaseline): the
  // best-scores window only shows a minority keymode's top plays, and gains
  // measured against that truncated list ignore the hidden tail a new play
  // would displace, overstating them severalfold.
  modeBaselines: Record<ConcreteFarmHelperKeyMode, { entries: Array<{ pp: number; beatmapId: number }>; total: number }>;
  subjectTopPp: number;
  subjectModeStatsByKey: Record<ConcreteFarmHelperKeyMode, ReturnType<typeof calculateSubjectKeyModeStats>>;
}

type ScoredRec = FarmHelperRec & { difficultyFit: number; recencyFit: number };

// One concrete-keymode (or total-pp fallback) run's output before the merged
// re-rank: its scored recs (rankScore still 0, unsliced), its cohort summary,
// how many candidate lanes this run's gain view hid on "too hard" marks, and
// how many fell only at the minimum-visible-gain gate.
interface ModeRunResult {
  scored: ScoredRec[];
  band: PeerBandSummary;
  feedbackHidden: number;
  belowGainFloor: number;
}

// Star-fit band for one keymode filter (all scores on the fallback path).
interface FitBand {
  hasFit: boolean;
  starLo: number;
  starHi: number;
  starMid: number;
  starSpread: number;
}

async function buildSnapshot(db: Db, bestScores: OscScore[], ctx: BuildCtx): Promise<FarmHelperSnapshot> {
  const isPopular = ctx.view === "popular";
  const generatedAt = nowIso();
  const subject = timeStageSync(ctx.timings, "fh_subject", () => prepareSubject(bestScores, ctx.subjectVariantPps));
  const keyMode = ctx.requestedKeyMode;

  // Player feedback marks ("too hard" / "too easy"), loaded once per request
  // and reconciled against the subject's own scores before they apply: a real
  // play after the mark retires it. Never on the backtest path (live state,
  // and the reconcile writes). Best-effort: a feedback failure never fails
  // the snapshot. The reconcile's writes go through ctx.writeDb when the
  // caller provided one (the HTTP serving-path invariant).
  let activeMarks: ActiveFarmHelperFeedbackMark[] | undefined;
  if (ctx.asOf == null) {
    const feedback = await timeStage(ctx.timings, "fh_feedback", () =>
      loadActiveFeedbackForBuild(db, ctx.writeDb ?? db, ctx.userId, subject));
    ctx.activeFeedback = feedback?.byLane;
    activeMarks = feedback?.marks;
  }

  // Subject skill breakdown, read once per request and shared by every mode
  // run: the feasibility gate and the modelsReady flag key off it. Queue-less
  // callers (backtest, Discord) read the stored row without enqueueing a
  // recompute.
  const skillQueue = ctx.queue;
  const skillBreakdown = await timeStage(ctx.timings, "fh_skills", () => (skillQueue
    // Detached: the recompute is background work for the NEXT build. This one
    // serves the stored breakdown either way, so a contended queue write must
    // not sit in front of the response.
    ? getPlayerSkillBreakdown(db, skillQueue, ctx.userId, { enqueueMode: "detached" })
    : getPlayerSkillBreakdown(db, NOOP_QUEUE, ctx.userId, { allowEnqueue: false })));
  ctx.skillBreakdown = skillBreakdown;

  // Feedback generalization (see the FEEDBACK_MARGIN_* block): the active
  // marks vote on the per-keymode feasibility margins. Gain view only, and
  // never when the breakdown is not ready (the gate is off entirely there).
  // Best-effort like the mark load: a failure never fails the snapshot.
  if (!isPopular && activeMarks && activeMarks.length > 0 && skillBreakdown.status === "ready") {
    try {
      ctx.feedbackMarginAdjust = await computeFeedbackMarginAdjust(db, activeMarks, skillBreakdown);
    } catch (error) {
      logWarn("farm_helper_feedback_margin_adjust_failed", {
        user_id: ctx.userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Personal accuracy model (A8): one small select per request, shared by
  // every mode run; never read per candidate. Null (benchmarks stay
  // unscaled) for subjects without a fitted model and when the backtest A/B
  // flag disables scaling. The popular browse scales too: both views must
  // quote the same numbers for the same map (popular only differs in which
  // rows appear).
  const accModel = ctx.disableAccScaling
    ? null
    : ctx.accModelOverride !== undefined
      ? ctx.accModelOverride
      : await timeStage(ctx.timings, "fh_acc_model", () => readPlayerAccModel(db, ctx.userId).catch(() => null));

  // "any" runs the concrete 4k and 7k pipelines separately (each with its own
  // strict keymode cohort) and merges the rec lists. A concrete request runs one
  // pipeline. A subject with no keymode evidence in either mode falls back to the
  // total-pp cohort.
  const runs: ModeRunResult[] = [];
  let peerBands: Partial<Record<ConcreteFarmHelperKeyMode, PeerBandSummary>> | undefined;
  if (keyMode !== "any") {
    runs.push(await buildModeRun(db, subject, keyMode, ctx, accModel));
  } else {
    const eligibleModes = FARM_HELPER_CONCRETE_KEY_MODES.filter((mode) => {
      const pp = ctx.subjectVariantPps[mode] ?? subject.subjectModeStatsByKey[mode].weightedPp;
      return Number.isFinite(pp) && pp > 0;
    });
    if (eligibleModes.length > 0) {
      // Sequential, not Promise.all: local libsql is synchronous, so parallelism
      // buys nothing and would interleave the per-keyCount pool cache seeding.
      const bands: Partial<Record<ConcreteFarmHelperKeyMode, PeerBandSummary>> = {};
      for (const mode of eligibleModes) {
        const run = await buildModeRun(db, subject, mode, ctx, accModel);
        runs.push(run);
        bands[mode] = run.band;
      }
      peerBands = bands;
    } else {
      runs.push(await buildTotalPpRun(db, subject, ctx, accModel));
    }
  }

  const peerBand = mergeBands(runs.map((run) => run.band));
  const base: FarmHelperSnapshot = {
    status: "ready",
    userId: ctx.userId,
    username: ctx.username,
    avatarUrl: ctx.avatarUrl,
    coverUrl: ctx.coverUrl,
    pp: ctx.subjectPp,
    keyMode,
    view: ctx.view,
    peerBand,
    gainBasis: keyMode === "any" ? "overall" : "keymode",
    totalPotentialPp: 0,
    totalQualifying: 0,
    modelsReady: skillBreakdown.status === "ready",
    recs: [],
    generatedAt,
    ...(peerBands ? { peerBands } : {}),
    // Gain view only (the popular browse never hides on marks); 0 included so
    // the UI can rely on the field's presence. The hidden count describes the
    // subject's own marks, so it is owner-only; the gain-floor count describes
    // the board and is public.
    ...(isPopular ? {} : {
      ...(ctx.isOwnerView
        ? { feedbackHiddenCount: runs.reduce((sum, run) => sum + run.feedbackHidden, 0) }
        : {}),
      belowGainFloorCount: runs.reduce((sum, run) => sum + run.belowGainFloor, 0),
    }),
    // Transparency: the margin adjustment the subject's marks applied (absent
    // when none, and owner-only for the same reason as the tags above).
    ...(ctx.feedbackMarginAdjust && ctx.isOwnerView ? { feedbackMarginAdjust: ctx.feedbackMarginAdjust } : {}),
  };

  const merged = runs.flatMap((run) => run.scored);
  if (merged.length === 0) return base;
  const rankTimings = ctx.timings;
  const rankStartedAt = rankTimings ? performance.now() : 0;

  // Popular mode can surface the same chart under two speed lanes (e.g. NoMod and
  // DT); collapse to the most-farmed lane per beatmap so the browse grid shows one
  // card per map, matching the maps page. Key counts differ across modes, so the
  // merge never collides two modes on the same beatmap.
  let ranked = isPopular ? collapsePopularLanes(merged) : merged;

  if (isPopular) {
    for (const rec of ranked) rec.rankScore = round2(rec.peerFraction);
    ranked.sort((a, b) =>
      b.peerFraction - a.peerFraction
      || b.peerCount - a.peerCount
      || b.estimatedPpGain - a.estimatedPpGain
      || b.stars - a.stars,
    );
  } else {
    // Normalize gain by the MERGED list's max so cross-mode ranking is fair;
    // peerFraction/fit/recency are already mode-local [0,1] values. The gain
    // term ranks the EXPECTED gain (gain * survival), so a lane the subject
    // may not even finish sinks below a safer equal-gain lane while the
    // displayed gain stays the honest if-you-finish value.
    const maxGain = Math.max(...ranked.map((r) => r.estimatedPpGain * (r.survival ?? 1)), 1);
    for (const rec of ranked) {
      // patternFit (shape match) replaces the star-proximity difficultyFit as the
      // fit term when available; difficultyFit is the fallback for shapeless charts.
      const fit = rec.patternFit ?? rec.difficultyFit;
      const expectedGain = rec.estimatedPpGain * (rec.survival ?? 1);
      const rankScore = 0.5 * (expectedGain / maxGain)
        + 0.2 * rec.peerFraction
        + 0.2 * fit
        + 0.1 * rec.recencyFit;
      // Push targets are self-derived (no peer evidence above the subject), so
      // they rank below peer-driven reasons at comparable gain.
      rec.rankScore = round2(rec.reason === "push" ? rankScore * PUSH_RANK_SCORE_FACTOR : rankScore);
    }
    ranked.sort((a, b) => b.rankScore - a.rankScore || b.estimatedPpGain - a.estimatedPpGain);
    // One lane per beatmap on the gain board too: an NM and a DT lane of the
    // same chart each claim (nearly) the full gain against the shared
    // baseline, so letting both through spends two slots on one map. Keep the
    // stronger lane. Runs after scoring and before truncation so
    // totalQualifying counts collapsed lanes, and after the too_hard hide (a
    // hidden lane already never reached this list, so it cannot shadow the
    // surviving one).
    ranked = collapseGainLanes(ranked);
  }

  const top: FarmHelperRec[] = ranked.slice(0, ctx.limit).map(({ difficultyFit, recencyFit, ...rec }) => {
    void difficultyFit;
    void recencyFit;
    return rec;
  });
  if (rankTimings) {
    rankTimings.add("fh_rank", performance.now() - rankStartedAt);
    rankTimings.count("recs", top.length);
    rankTimings.count("qualifying", ranked.length);
  }

  await timeStage(ctx.timings, "fh_top_peers", () => hydrateTopPeers(db, top));

  // The headline total simulates farming everything shown at once against the
  // same baseline the per-rec gains used, so it can never exceed what the list
  // is collectively worth (a naive sum of per-rec gains explodes on short
  // variant baselines: every rec claims the same top slots).
  const totalBaseline = base.gainBasis === "keymode" && keyMode !== "any"
    ? subject.modeBaselines[keyMode]
    : { entries: subject.baselineEntries, total: subject.baselineTotal };

  return {
    ...base,
    totalPotentialPp: round2(estimateCombinedGain(totalBaseline.entries, totalBaseline.total, top)),
    totalQualifying: ranked.length,
    recs: top,
  };
}

// Loads the subject's active feedback marks as a lane-keyed map, after the
// read-time reconcile: a mark whose lane has a subject score played strictly
// after the mark's creation resolves right here (the real play drives recs
// again) via one batched best-effort update, and counts as inactive for this
// build. This covers "they said too easy and then actually set the score"
// even when the score arrived outside the live ingest pipeline. Reads run on
// `db` (the caller's read connection); the reconcile updates run on `writeDb`
// so the HTTP path can keep serving-path writes off the read connection.
async function loadActiveFeedbackForBuild(
  db: Db,
  writeDb: Db,
  userId: number,
  subject: PreparedSubject,
): Promise<{ byLane: Map<string, FarmHelperFeedbackVerdict>; marks: ActiveFarmHelperFeedbackMark[] } | undefined> {
  let marks;
  try {
    marks = await loadActiveFarmHelperFeedback(db, userId);
  } catch (error) {
    logWarn("farm_helper_feedback_load_failed", { user_id: userId, error: error instanceof Error ? error.message : String(error) });
    return undefined;
  }
  if (marks.length === 0) return undefined;

  // The subject's plays per lane, keyed exactly like the scoring loop keys
  // subject scores (farmHelperLaneKey over beatmap + mod speed bucket).
  const playsByLane = new Map<string, Array<{ endedAtMs: number; pp: number }>>();
  for (const score of subject.rankedScores) {
    const beatmapId = Number(score.beatmap_id ?? score.beatmap?.id ?? 0);
    if (!(beatmapId > 0) || !score.ended_at) continue;
    const endedAtMs = Date.parse(score.ended_at);
    if (!Number.isFinite(endedAtMs)) continue;
    const lane = farmHelperLaneKey(beatmapId, getScoreSpeedBucket(getModAcronyms(score.mods)));
    const plays = playsByLane.get(lane) ?? [];
    plays.push({ endedAtMs, pp: typeof score.pp === "number" && score.pp > 0 ? score.pp : 0 });
    playsByLane.set(lane, plays);
  }

  const active = new Map<string, FarmHelperFeedbackVerdict>();
  const activeMarks: ActiveFarmHelperFeedbackMark[] = [];
  const statements: DbStatement[] = [];
  const now = Date.now();
  for (const mark of marks) {
    const lane = farmHelperLaneKey(mark.beatmapId, mark.speedBucket);
    const later = (playsByLane.get(lane) ?? []).filter((play) => play.endedAtMs > mark.createdAt);
    if (later.length === 0) {
      active.set(lane, mark.verdict);
      activeMarks.push(mark);
      continue;
    }
    const bestPp = later.reduce((max, play) => Math.max(max, play.pp), 0);
    statements.push({
      sql: `update farm_helper_feedback
            set resolved_at = ?, resolved_pp = ?, updated_at = ?
            where user_id = ? and beatmap_id = ? and speed_bucket = ? and resolved_at is null`,
      args: [now, bestPp > 0 ? bestPp : null, now, userId, mark.beatmapId, mark.speedBucket],
    });
  }
  if (statements.length > 0) {
    // Best-effort: a failed write leaves the marks for the next build (or the
    // ingest hook) to retire; this build already treats them as inactive.
    try {
      await execBatch(writeDb, statements);
    } catch (error) {
      logWarn("farm_helper_feedback_reconcile_failed", {
        user_id: userId,
        marks: statements.length,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return active.size > 0 ? { byLane: active, marks: activeMarks } : undefined;
}

// Everything before cohort selection: subject top plays, baseline, per-keymode
// stats. Shared by every run in a request.
function prepareSubject(
  bestScores: OscScore[],
  variantPps: Partial<Record<ConcreteFarmHelperKeyMode, number>>,
): PreparedSubject {
  const subjectByBeatmap = new Map<string, SubjectMapScore>();
  const baselineEntries: Array<{ pp: number; beatmapId: number }> = [];
  const modeEntries: Record<ConcreteFarmHelperKeyMode, Array<{ pp: number; beatmapId: number }>> = { "4k": [], "7k": [] };
  let subjectTopPp = 0;

  const rankedScores = [...bestScores]
    .filter((score) => typeof score.pp === "number" && score.pp > 0)
    .sort((a, b) => (b.pp ?? 0) - (a.pp ?? 0));

  rankedScores.forEach((score) => {
    const pp = score.pp as number;
    const beatmapId = score.beatmap_id ?? score.beatmap?.id ?? 0;
    if (pp > subjectTopPp) subjectTopPp = pp;
    if (beatmapId > 0) {
      const entry = { pp, beatmapId };
      baselineEntries.push(entry);
      const keyMode = beatmapKeyMode(getScoreKeys(score));
      if (keyMode) modeEntries[keyMode].push(entry);
      const speedBucket = getScoreSpeedBucket(getModAcronyms(score.mods));
      const subjectKey = farmHelperLaneKey(beatmapId, speedBucket);
      const endedAt = score.ended_at ?? null;
      const existing = subjectByBeatmap.get(subjectKey);
      if (!existing) {
        subjectByBeatmap.set(subjectKey, {
          pp,
          endedAt,
          scoreId: score.id,
          speedBucket,
          customAccuracy: calculateManiaCustomAccuracy(score.statistics),
          latestEndedAt: endedAt,
        });
      } else {
        // Track the newest play on the lane regardless of pp: the stale
        // check needs "when did they last touch this", not "when was the PB".
        if (endedAt != null && (existing.latestEndedAt == null || Date.parse(endedAt) > Date.parse(existing.latestEndedAt))) {
          existing.latestEndedAt = endedAt;
        }
        if (pp > existing.pp) {
          existing.pp = pp;
          existing.endedAt = endedAt;
          existing.scoreId = score.id;
          existing.customAccuracy = calculateManiaCustomAccuracy(score.statistics);
        }
      }
    }
  });

  const baselineTotal = calculateWeightedPpTotal(baselineEntries);
  // A keymode's visible plays can only be truncated from below when the overall
  // window itself is full: every keymode play above the window cutoff is in the
  // window, so the visible entries are always the exact top of that keymode's
  // list. An unfilled window means the list is already complete.
  const windowFull = bestScores.length >= PROFILE_BEST_SCORES_LIMIT;
  const hiddenCapPp = windowFull && rankedScores.length > 0
    ? (rankedScores[rankedScores.length - 1].pp as number)
    : null;
  const modeBaselines = {
    "4k": padModeBaseline(modeEntries["4k"], variantPps["4k"], hiddenCapPp),
    "7k": padModeBaseline(modeEntries["7k"], variantPps["7k"], hiddenCapPp),
  } satisfies PreparedSubject["modeBaselines"];
  const subjectModeStatsByKey = {
    "4k": calculateSubjectKeyModeStats(rankedScores, "4k"),
    "7k": calculateSubjectKeyModeStats(rankedScores, "7k"),
  } satisfies Record<ConcreteFarmHelperKeyMode, ReturnType<typeof calculateSubjectKeyModeStats>>;

  return { rankedScores, subjectByBeatmap, baselineEntries, baselineTotal, modeBaselines, subjectTopPp, subjectModeStatsByKey };
}

// One concrete-keymode pipeline: strict cohort, shape folding, farmed-map
// aggregation, the value/popularity gate, and the shared scoring loop. No
// rankScore assignment and no limit slice (the merged tail owns both).
async function buildModeRun(
  db: Db,
  subject: PreparedSubject,
  mode: ConcreteFarmHelperKeyMode,
  ctx: BuildCtx,
  accModel: PlayerAccModel | null,
): Promise<ModeRunResult> {
  const isPopular = ctx.view === "popular";
  const asOf = ctx.asOf;
  const subjectModeStats = subject.subjectModeStatsByKey[mode];
  const subjectVariantPp = ctx.subjectVariantPps[mode] ?? null;
  const subjectPeerPp = subjectVariantPp ?? subjectModeStats.weightedPp;
  const subjectBenchmarkCap = getModeBenchmarkCap(subjectModeStats, subjectVariantPp, subject.subjectTopPp);
  const fit = computeFitBand(subject.rankedScores, mode);

  const { peers, mode: peerMode } = await timeStage(ctx.timings, "fh_peer_pool", () =>
    selectPeerBand(db, ctx.userId, ctx.subjectPp, mode, subjectPeerPp, { strictKeyMode: true, writeDb: ctx.writeDb }));
  ctx.timings?.count("peers", peers.length);

  // Cohort self-heal: proxy-only peers that were never variant-enriched can be
  // badly mis-placed. Enqueue their enrichment strongest-weight first so the
  // players who pollute real cohorts get real variant pp ahead of the global
  // pp-ordered drip. Fire-and-forget; never on the backtest path.
  if (ctx.queue && asOf == null) enqueueVariantSelfHeal(ctx.queue, peers);

  // Chart-shape weighting: down-weight peers whose farm charts look unlike the
  // subject's, folded into wD/wB up front. Also carries the subject's shape for
  // this mode (for per-candidate patternFit; null when too few plays are
  // analyzed) and their per-family demonstrated top-play pp (the family cap).
  const shapeContext = peers.length > 0
    ? await timeStage(ctx.timings, "fh_shapes", () => computeShapeContext(db, peers, subject.rankedScores, mode, ctx.queue))
    : null;
  const subjectShape = shapeContext?.shape ?? null;

  const band = buildPeerBand(peerMode, peers);
  if (peers.length === 0) return { scored: [], band, feedbackHidden: 0, belowGainFloor: 0 };

  const peerFarmed = await timeStage(ctx.timings, "fh_farm_rows", () =>
    aggregatePeerFarmedMaps(db, peers, keyModeToKeys(mode), asOf, ctx.timings));
  band.farmDataCount = peerFarmed.farmDataPeerCount;
  if (peerFarmed.farmDataPeerCount === 0) return { scored: [], band, feedbackHidden: 0, belowGainFloor: 0 };

  const candidates = gateCandidates(peerFarmed, isPopular);
  ctx.timings?.count("candidates", candidates.length);
  if (candidates.length === 0) return { scored: [], band, feedbackHidden: 0, belowGainFloor: 0 };

  const { scored, feedbackHidden, belowGainFloor } = await timeStage(ctx.timings, "fh_score", () => scoreCandidates(db, subject, ctx, {
    candidates,
    peerSampleSize: peerFarmed.eligiblePeerCount,
    mode,
    fit,
    subjectBenchmarkCap,
    subjectBestAccuracy: subjectModeStats.bestCustomAccuracy,
    subjectShape,
    familyTopPp: shapeContext?.familyTopPp ?? null,
    accModel,
  }));
  return { scored, band, feedbackHidden, belowGainFloor };
}

// Fallback for subjects with no keymode evidence in either mode: the total-pp
// cohort with per-candidate caps and no shape context. Mirrors the old "any"
// view minus the deleted primary-ratio / off-key / deferred-shape gates.
async function buildTotalPpRun(db: Db, subject: PreparedSubject, ctx: BuildCtx, accModel: PlayerAccModel | null): Promise<ModeRunResult> {
  const isPopular = ctx.view === "popular";
  const asOf = ctx.asOf;
  const anyStats = calculateSubjectKeyModeStats(subject.rankedScores, "any");
  const subjectBenchmarkCap = getModeBenchmarkCap(anyStats, null, subject.subjectTopPp);
  const fit = computeFitBand(subject.rankedScores, "any");

  const { peers } = await timeStage(ctx.timings, "fh_peer_pool", () =>
    selectPeerBand(db, ctx.userId, ctx.subjectPp, "any", 0, { strictKeyMode: false, writeDb: ctx.writeDb }));
  ctx.timings?.count("peers", peers.length);
  if (ctx.queue && asOf == null) enqueueVariantSelfHeal(ctx.queue, peers);

  const band = buildPeerBand("total_pp_fallback", peers);
  if (peers.length === 0) return { scored: [], band, feedbackHidden: 0, belowGainFloor: 0 };

  const peerFarmed = await timeStage(ctx.timings, "fh_farm_rows", () =>
    aggregatePeerFarmedMaps(db, peers, null, asOf, ctx.timings));
  band.farmDataCount = peerFarmed.farmDataPeerCount;
  if (peerFarmed.farmDataPeerCount === 0) return { scored: [], band, feedbackHidden: 0, belowGainFloor: 0 };

  const candidates = gateCandidates(peerFarmed, isPopular);
  ctx.timings?.count("candidates", candidates.length);
  if (candidates.length === 0) return { scored: [], band, feedbackHidden: 0, belowGainFloor: 0 };

  const { scored, feedbackHidden, belowGainFloor } = await timeStage(ctx.timings, "fh_score", () => scoreCandidates(db, subject, ctx, {
    candidates,
    peerSampleSize: peerFarmed.eligiblePeerCount,
    mode: null,
    fit,
    subjectBenchmarkCap,
    subjectBestAccuracy: anyStats.bestCustomAccuracy,
    subjectShape: null,
    familyTopPp: null,
    accModel,
  }));
  return { scored, band, feedbackHidden, belowGainFloor };
}

interface ScoreCandidatesParams {
  candidates: Array<{ agg: CandidateAgg; kernelFraction: number }>;
  peerSampleSize: number;
  // The concrete keymode this run covers, or null for the total-pp fallback
  // (any key count allowed, cap resolved per candidate).
  mode: ConcreteFarmHelperKeyMode | null;
  fit: FitBand;
  subjectBenchmarkCap: number;
  // Best demonstrated 320-weighted custom accuracy in this run's keymode (all
  // scores on the total-pp fallback); caps "push" target accuracies. Null when
  // no top play carries judgement counts (push never fires then).
  subjectBestAccuracy: number | null;
  subjectShape: UserShape | null;
  // Demonstrated top-play pp per chart pattern family for this run's keymode
  // (null on the total-pp fallback): the evidence behind the per-candidate
  // family benchmark cap.
  familyTopPp: Map<string, number> | null;
  // The subject's personal accuracy model (read once per request), or null
  // when there is none / scaling is disabled. Drives the A8 benchmark scale.
  accModel: PlayerAccModel | null;
}

// The shared scoring loop: meta/shape/feasibility reads plus reason/benchmark/gain
// for one run's gated candidates. Emits ScoredRec with rankScore 0 (the merged
// tail assigns it) and no limit slice.
async function scoreCandidates(
  db: Db,
  subject: PreparedSubject,
  ctx: BuildCtx,
  params: ScoreCandidatesParams,
): Promise<{ scored: ScoredRec[]; feedbackHidden: number; belowGainFloor: number }> {
  const isPopular = ctx.view === "popular";
  const { candidates, peerSampleSize, mode, fit, subjectBenchmarkCap, subjectBestAccuracy, subjectShape, familyTopPp, accModel } = params;

  const beatmapIds = candidates.map((c) => c.agg.beatmapId);
  const beatmapMeta = await readBeatmapMeta(db, beatmapIds);
  const beatmapsetIds = [...new Set([...beatmapMeta.values()].map((m) => m.beatmapsetId))];
  const beatmapsetMeta = await readBeatmapsetMeta(db, beatmapsetIds);
  const hasSubjectShape = subjectShape != null;
  // One map_search_index pass serves per-candidate patternFit (shapes), the
  // feasibility gate (raw MSD), and the A8/A10 difficulty axes. Read on both
  // views: popular quotes the same acc-scaled, capped numbers as gain.
  const chartData = await readChartShapeData(db, beatmapIds);
  const candidateShapes = hasSubjectShape ? chartData.shapes : new Map<number, ChartShape>();
  // Feasibility context: the subject's per-keymode skill ratings vs each
  // chart's dominant MSD skillset, from the breakdown read once per request.
  // Built on both views (the sparse-keymode cap and the DT Overall need it);
  // only the gain view uses it to DROP charts - popular never drops.
  const feasibility = ctx.skillBreakdown
    ? await buildFeasibilityContext(db, ctx.skillBreakdown, chartData.rawMsd)
    : null;

  // Per-keymode pp gain: a concrete-keymode request measures gain against the
  // subject's keymode-local weighted list (their variant pp), so a 7K main
  // browsing the 4K tab sees what a play would add to their 4K pp instead of a
  // universal ~0 against an overall list their 7K plays dominate. The "any"
  // view (and its total-pp fallback) keeps overall-pp gain: minority-keymode
  // plays genuinely do not move that player's profile pp.
  const gainBaseline = ctx.requestedKeyMode !== "any" && mode != null ? subject.modeBaselines[mode] : null;

  const scored: ScoredRec[] = [];
  let feedbackHidden = 0;
  let belowGainFloor = 0;
  for (const { agg, kernelFraction } of candidates) {
    const meta = beatmapMeta.get(agg.beatmapId);
    if (!meta) continue;
    if (mode != null && meta.keys !== keyModeToKeys(mode)) continue;
    if (!isPopular && fit.hasFit && (meta.stars < fit.starLo - STAR_BUFFER || meta.stars > fit.starHi + STAR_BUFFER)) continue;
    // Player feedback on this exact lane. "too hard" hides the lane from the
    // gain view, but only as the LAST check before emission (see below): the
    // hidden counter must only count lanes that would actually have shown.
    // The popular browse keeps the row labelled. "too easy" trusts the player
    // over the model (no feasibility drop, optimistic accuracy, no clear
    // risk, over-cap clamps instead of dropping).
    const laneKey = farmHelperLaneKey(agg.beatmapId, agg.speedBucket);
    const laneFeedback = ctx.activeFeedback?.get(laneKey) ?? null;
    const chartPat = chartData.shapes.get(agg.beatmapId)?.pat ?? null;
    // The chart's primary pattern family: the accuracy model's family axis,
    // the feasibility gate's family check, and the family cap all key on it.
    const family = primaryPatternFamily(chartPat);
    // Feasibility: a chart whose defining axes (dominant MSD skillset,
    // near-dominant secondaries, pattern family) outstrip the subject's
    // demonstrated ratings is not realistically farmable now, so drop it in
    // the gain view (popular still browses it). The normal lane uses stored
    // 1.0x MSD, the DT lane the rate-adjusted 1.5x MSD with a wider margin,
    // and the HT lane the 1.0x MSD scaled down to the 0.75x rate. Sparse
    // keymodes gate on cross-keymode transferred ratings with tighter margins.
    // Missing MSD (or a subject with no rated plays anywhere) never gates.
    const feasibilityEntry = feasibility?.byKeys.get(meta.keys) ?? null;
    // A "too easy" mark bypasses the hard feasibility gate for this lane: the
    // player has explicitly claimed the chart, which outranks the model's
    // demonstrated-rating margins. Popular never drops on feasibility (it is
    // a browse), though its caps below still read feasibilityEntry.
    if (!isPopular && feasibility && feasibilityEntry && laneFeedback !== "too_easy") {
      const margins = FEASIBILITY_MARGINS[meta.keys];
      if (margins) {
        // Feedback generalization: the subject's accumulated marks shrink
        // (net too_hard) or widen (net too_easy) this keymode's margins by a
        // bounded fraction, uniformly across axes and lanes (see the
        // FEEDBACK_MARGIN_* block). Gain view only - this branch already is.
        const chartKeyMode = beatmapKeyMode(meta.keys);
        const feedbackScale = 1 + (chartKeyMode ? ctx.feedbackMarginAdjust?.[chartKeyMode] ?? 0 : 0);
        const marginScale = (feasibilityEntry.sparse ? FEASIBILITY_SPARSE_MARGIN_RATIO : 1) * feedbackScale;
        if (agg.speedBucket === "normal"
          && isChartInfeasible(feasibility.chartMsd.get(agg.beatmapId), chartPat, feasibilityEntry, margins.normal * marginScale)) continue;
        if (agg.speedBucket === "dt"
          && isChartInfeasible(feasibility.chartMsdDt.get(agg.beatmapId), chartPat, feasibilityEntry, margins.dt * marginScale)) continue;
        if (agg.speedBucket === "ht"
          && isChartInfeasible(scaleMsdVector(feasibility.chartMsd.get(agg.beatmapId), FEASIBILITY_HT_RATE_MSD_RATIO), chartPat, feasibilityEntry, margins.normal * marginScale)) continue;
      }
    }

    const candidateKeyMode = beatmapKeyMode(meta.keys);
    const peerFraction = kernelFraction;

    // The chart's MSD Overall at this lane's rate: the A8 accuracy scaling's
    // and the A10 choke prediction's shared difficulty axis.
    const laneOverall = laneChartOverall(
      chartData.overall.get(agg.beatmapId) ?? null,
      feasibility?.chartDtOverall.get(agg.beatmapId) ?? null,
      agg.speedBucket,
    );

    // A8 continuous feasibility: the peer benchmarks below are scaled by the
    // subject's predicted accuracy on this chart (see the ACC_TYPICAL_*
    // comment block for the full rationale). No model or no chart Overall for
    // the lane leaves the benchmark unscaled. Applies on BOTH views so the
    // popular browse quotes the same numbers as the gain view.
    let accScale = 1;
    if (accModel && laneOverall != null) {
      const prediction = predictPlayerAccuracy(accModel, { keyCount: meta.keys, chartOverall: laneOverall, family });
      if (prediction) {
        // "Too easy" trusts the player over the model on this lane: scale on
        // the optimistic accP85 instead of the confidence-shaded conservative
        // percentile, so the target and gain rise toward the player's claim.
        const accBasis = laneFeedback === "too_easy" ? { accConservative: prediction.accP85 } : prediction;
        accScale = computeAccBenchmarkScale(accBasis, typicalPeerAccuracy(agg.entries));
      }
    }

    // Benchmark quantiles are weighted by the symmetric benchmark kernel (wB), so
    // an up-skewed discovery cohort cannot inflate the "if you get X" target.
    // Reliability guard: weightedQuantile silently drops w <= 0 pairs, so a
    // lane can clear PEER_MIN_COUNT on raw entries while its quantiles rest
    // on one peer, or on nobody (all-zero kernel -> quantile 0). The gain
    // view demands at least two kernel-weighted peers behind a target; the
    // popular browse keeps the row but, when the whole kernel is empty,
    // falls back to unweighted quantiles over the lane's entries so it never
    // displays a 0pp median sourced from nothing.
    const wbEntryCount = agg.entries.reduce((count, e) => count + (e.wB > 0 ? 1 : 0), 0);
    if (!isPopular && wbEntryCount < 2) continue;
    // Sorted once per lane, then queried for the median, the p75 and (for a
    // missing map) the discovery quantile, instead of re-sorting per quantile.
    const benchDistribution = prepareWeightedDistribution(wbEntryCount > 0
      ? agg.entries.map((e) => ({ v: e.pp, w: e.wB }))
      : agg.entries.map((e) => ({ v: e.pp, w: 1 })));
    const median = quantileOfDistribution(benchDistribution, 0.5);
    const p75 = quantileOfDistribution(benchDistribution, 0.75);
    // Reason selection and the caps run on the accuracy-scaled quantiles; the
    // raw median/p75 stay on the rec (they describe the peers, not the target).
    const scaledMedian = median * accScale;
    const scaledP75 = p75 * accScale;

    // Concrete run: the single mode cap. Fallback: cap by the candidate's own
    // keymode evidence when it exists, else the overall cap - the same one
    // non-4K/7K candidates get. (A null per-mode cap used to DROP every
    // 4K/7K candidate here, blanking the board for pure 5K/6K players even
    // though the farmed tables are mostly 4K/7K.)
    const rawCap = mode != null
      ? subjectBenchmarkCap
      : candidateKeyMode
        ? getModeBenchmarkCapFromEvidence(subject.subjectModeStatsByKey[candidateKeyMode], ctx.subjectVariantPps[candidateKeyMode] ?? null) ?? subjectBenchmarkCap
        : subjectBenchmarkCap;
    // The caps apply on BOTH views (popular clamps, never drops, so both
    // views quote the same target for the same map).
    let cap = rawCap;
    // A sparse keymode's targets never exceed the top play the subject has
    // actually demonstrated there: with almost no rated evidence in the
    // keymode, a peer benchmark above it is projection, not a target.
    if (feasibilityEntry?.sparse && candidateKeyMode) {
      const demonstratedTop = subject.subjectModeStatsByKey[candidateKeyMode].topPp;
      if (demonstratedTop > 0) cap = Math.min(cap, demonstratedTop * MODE_TOP_PP_HEADROOM);
    }
    // Family cap: targets are bounded by what the subject has demonstrated
    // on the candidate chart's pattern family (an LN main's 1100pp proves
    // nothing about rice-jack charts). Missing family evidence - an
    // uncovered chart, or a family the subject never played - never caps;
    // the feasibility gate is the backstop there.
    const familyTop = family != null ? familyTopPp?.get(family) : null;
    if (familyTop != null && familyTop > 0) cap = Math.min(cap, familyTop * MODE_TOP_PP_GROWTH_HEADROOM);
    const subjectScore = subject.subjectByBeatmap.get(laneKey) ?? null;

    // Peer play recency: when peers actually SET their scores (played_at).
    // updated_at is useless here - the periodic refresh rewrites it for every
    // row, so it is always fresh and would gate nothing. Rows written before
    // played_at existed leave the aggregate empty; fall back to updated_at
    // there rather than treating unknown as never-played.
    // Sorted once and reused: the ranking's recency term wants the
    // updated_at fallback, the response field wants the raw value.
    const rawPeerRecencyMs = peerRecencyPlayedAtMs(agg.playedAtMs);
    const peerRecencyMs = rawPeerRecencyMs || agg.latestUpdatedMs;

    let reason: FarmHelperReason;
    let benchmark: number;
    if (!subjectScore) {
      reason = "missing";
      const rawBenchmark = quantileOfDistribution(benchDistribution, MISSING_MAP_BENCHMARK_QUANTILE) * accScale;
      // Over-cap drops in the gain view - unless the player claimed the lane
      // with a "too easy" mark: trusting the player (which raises accScale)
      // must never vanish the rec, so a marked lane clamps to the cap
      // instead. Popular clamps too (no-drop policy).
      if (rawBenchmark > cap && !isPopular && laneFeedback !== "too_easy") continue;
      benchmark = Math.min(rawBenchmark, cap);
    } else if (scaledMedian - subjectScore.pp > IMPROVE_MARGIN_PP) {
      reason = "improve";
      benchmark = Math.min(scaledMedian, cap, nextPlayedMapBenchmark(subjectScore.pp));
    } else if (
      // "Old pb" requires the PB AND the latest play on the lane to be old
      // (replaying yesterday at a lower score is fresh engagement), and peers
      // to have actually PLAYED it recently (real play recency, not the
      // refresh-rewritten updated_at).
      isStale(subjectScore.endedAt)
      && isStale(subjectScore.latestEndedAt)
      && peerRecencyMs > Date.now() - STALE_ACTIVE_MS
      && Math.min(scaledP75, cap) - subjectScore.pp > IMPROVE_MARGIN_PP
    ) {
      reason = "stale";
      benchmark = Math.min(scaledP75, cap, nextPlayedMapBenchmark(subjectScore.pp));
    } else if (isPopular) {
      // Already cleared at a competitive score: keep it in the popular browse,
      // labelled "owned", with a near-zero gain (same scaled median as gain).
      reason = "owned";
      benchmark = Math.max(subjectScore.pp, Math.min(scaledMedian, cap));
    } else {
      // No peer benchmark above the subject: a strong owned score used to be
      // silently dropped here. Offer a self-improvement ("push") target
      // instead, rescaling the subject's own pp to a modestly higher custom
      // accuracy (see the PUSH_* constants for the guardrails). Deliberately
      // NOT multiplied by accScale: the push target is already derived from
      // the subject's own achieved accuracy on this exact chart, so scaling
      // it again would double-apply the accuracy discount.
      const pushBenchmark = computePushBenchmark(subjectScore, subjectBestAccuracy);
      if (pushBenchmark == null) continue;
      reason = "push";
      benchmark = Math.min(pushBenchmark, cap, nextPlayedMapBenchmark(subjectScore.pp));
    }

    if (!Number.isFinite(benchmark) || benchmark <= 0) {
      // Gain view: a collapsed benchmark (e.g. the acc multiplier hit 0) is
      // not worth showing. Popular never drops a row: show it with an honest
      // 0 target / 0 gain, matching what the gain view's numbers would say.
      if (!isPopular) continue;
      benchmark = 0;
    }
    if (!isPopular && subjectScore && benchmark - subjectScore.pp <= IMPROVE_MARGIN_PP) continue;
    const estimatedPpGain = gainBaseline
      ? estimateGain(gainBaseline.entries, gainBaseline.total, agg.beatmapId, benchmark)
      : estimateGain(subject.baselineEntries, subject.baselineTotal, agg.beatmapId, benchmark);
    if (!isPopular && estimatedPpGain < MIN_VISIBLE_GAIN_PP) {
      // Cleared every other gate; only the gain floor hides it. Counted so an
      // otherwise-empty board can explain itself (belowGainFloorCount).
      belowGainFloor += 1;
      continue;
    }

    // The too_hard hide, applied as the LAST drop before emission: every gate
    // above has passed, so this lane would genuinely have shown - which is
    // exactly what feedbackHiddenCount promises to count. The popular browse
    // keeps the row (tagged via `feedback` below).
    if (laneFeedback === "too_hard" && !isPopular) {
      feedbackHidden += 1;
      continue;
    }

    // A10 survival: only a lane the subject has NOT already cleared carries
    // finish risk (a subject score in this exact lane is proof of a pass).
    // The popular browse and the backtest A/B flag leave it null: no
    // discount, no label.
    let survival: number | null = null;
    let clearRisk = false;
    if (!isPopular && !ctx.disableSurvival) {
      if (subjectScore || laneFeedback === "too_easy") {
        // A subject score in this exact lane is proof of a pass; a "too easy"
        // mark is the player asserting the same, so no survival discount and
        // no clear-risk label.
        survival = 1;
      } else {
        const choke = accModel && laneOverall != null
          ? predictPlayerChoke(accModel, { keyCount: meta.keys, chartOverall: laneOverall })
          : null;
        const passStats = chartData.passStats.get(agg.beatmapId) ?? null;
        survival = computeSurvival({
          playCount: passStats?.playCount ?? null,
          passCount: passStats?.passCount ?? null,
          lengthSec: laneLengthSec(meta.lengthSec, agg.speedBucket),
          choke,
        });
        // The "risky for you" label needs a personal signal: without a choke
        // prediction the discount is population-only (retry-heavy play
        // counts), a sane ranking prior but not evidence about THIS player.
        clearRisk = choke != null && survival < SURVIVAL_CLEAR_RISK_MAX;
      }
    }

    const setMeta = beatmapsetMeta.get(meta.beatmapsetId);
    const difficultyFit = fit.hasFit ? clamp01(1 - Math.abs(meta.stars - fit.starMid) / fit.starSpread) : 0.5;
    // Real peer play recency (see peerRecencyMs above), not the
    // refresh-rewritten updated_at that made this term a constant.
    const recencyFit = clamp01(1 - (Date.now() - peerRecencyMs) / STALE_ACTIVE_MS);
    const chartShape = candidateShapes.get(agg.beatmapId);
    const patternFit = subjectShape && chartShape ? computePatternFit(subjectShape, chartShape) : null;

    scored.push({
      beatmapId: agg.beatmapId,
      speedBucket: agg.speedBucket,
      recommendedMods: getRecommendedMods(agg),
      beatmapsetId: meta.beatmapsetId,
      title: setMeta?.title ?? "",
      artist: setMeta?.artist ?? "",
      creator: setMeta?.creator ?? "",
      version: meta.version,
      cover: setMeta?.cover ?? "",
      listCover: setMeta?.listCover ?? setMeta?.cover ?? "",
      status: setMeta?.status || meta.status,
      stars: meta.stars,
      keys: meta.keys,
      // Rate-adjusted for the lane so the board and the map detail page quote
      // the same effective bpm/length for a DT/HT rec. Stars stay NM-scaled
      // on both surfaces.
      bpm: round2(laneBpm(meta.bpm, agg.speedBucket)),
      lengthSec: Math.round(laneLengthSec(meta.lengthSec, agg.speedBucket)),
      reason,
      estimatedPpGain: round2(estimatedPpGain),
      benchmarkPp: round2(benchmark),
      subjectPp: subjectScore ? round2(subjectScore.pp) : null,
      subjectPlayedAt: subjectScore?.endedAt ?? null,
      peerCount: agg.entries.length,
      peerSampleSize,
      peerFraction: round2(peerFraction),
      patternFit: patternFit == null ? null : round2(patternFit),
      peerPpMedian: round2(median),
      peerPpP75: round2(p75),
      // Plain loop, not Math.max(0, ...arr): a lane farmed by a large cohort
      // would spread thousands of arguments onto the stack.
      latestPeerPlayedAt: dateMsToIso(maxOf(agg.playedAtMs)),
      peerRecencyPlayedAt: dateMsToIso(rawPeerRecencyMs),
      topPeers: selectTopPeers(agg.entries)
        .map((p) => ({ userId: p.userId, username: "", avatarUrl: "", pp: round2(p.pp) })),
      scoreUrl: subjectScore ? `https://osu.ppy.sh/scores/${subjectScore.scoreId}` : null,
      mapUrl: meta.url,
      rankScore: 0,
      survival: survival == null ? null : round2(survival),
      clearRisk,
      // Owner-only: what this player marked this lane is theirs to know.
      ...(laneFeedback && ctx.isOwnerView ? { feedback: laneFeedback } : {}),
      difficultyFit,
      recencyFit,
    });
  }

  return { scored: capPushRecs(scored), feedbackHidden, belowGainFloor };
}

// Volume gate for "push": self-derived targets exist for potentially every
// owned lane, so without a cap they would drown the peer-driven reasons. Keep
// only the strongest PUSH_MAX_PER_RUN by estimated gain per mode run.
function capPushRecs(scored: ScoredRec[]): ScoredRec[] {
  const pushRecs = scored.filter((rec) => rec.reason === "push");
  if (pushRecs.length <= PUSH_MAX_PER_RUN) return scored;
  const keep = new Set(pushRecs.sort((a, b) => b.estimatedPpGain - a.estimatedPpGain).slice(0, PUSH_MAX_PER_RUN));
  return scored.filter((rec) => rec.reason !== "push" || keep.has(rec));
}

// The "push" benchmark: the subject's own pp rescaled from their score's
// custom accuracy to a fixed step above it, capped by their demonstrated best
// accuracy plus a small headroom and the absolute ceiling. Null when the score
// has no judgement counts, sits outside the linear regime, or the remaining
// accuracy delta is too small to be a meaningful target.
function computePushBenchmark(score: SubjectMapScore, bestAccuracy: number | null): number | null {
  const accuracy = score.customAccuracy;
  if (accuracy == null || accuracy <= 0.8 || accuracy >= 1) return null;
  const accuracyCap = Math.min(
    PUSH_ACC_CEILING,
    bestAccuracy != null && bestAccuracy > 0 ? bestAccuracy + PUSH_ACC_BEST_HEADROOM : PUSH_ACC_CEILING,
  );
  const targetAccuracy = Math.min(accuracy + PUSH_ACC_STEP, accuracyCap);
  if (targetAccuracy - accuracy < PUSH_MIN_ACC_DELTA) return null;
  return score.pp * (5 * targetAccuracy - 4) / (5 * accuracy - 4);
}

// The A8 benchmark multiplier: (5 * accYou - 4) / (5 * accTypical - 4), the
// mania pp formula's accuracy factor ratio. accYou is the prediction's
// confidence-shaded accConservative rather than accMedian: at low confidence
// the median reverts toward the prior's on-level accuracy (multiplier ~1, no
// discount at all), while the conservative percentile is the one choice
// where thinner evidence always means a lower target. The 2026-07 backtest
// A/B priced that safety at roughly one point of recall@100 (0.398 median
// vs 0.388 conservative, baseline 0.406) with precision@25/50 flat within
// noise. The result is clamped to [0, 1] so scaling only ever discounts,
// and it floors at 0 once the predicted accuracy reaches 80% (where the pp
// accuracy factor itself hits 0) - the candidate then drops on the
// benchmark <= 0 check. A degenerate typical accuracy (<= 80%, impossible
// after the ACC_TYPICAL_MIN clamp) leaves the benchmark unscaled.
// Exported for tests.
// Floor on the A8 benchmark scale. The pp-linear (5*acc - 4) axis amplifies
// accuracy gaps hard: a 93% player vs a 97% typical peer already lands near
// 0.6, and the confidence-shaded conservative percentile on unplayed harder
// charts can push the raw ratio toward 0.2, at which point every benchmark
// scales below the subject's own tail and the whole gain board empties. Below
// half the peer benchmark the model is extrapolating outside its evidence, so
// the discount stops there; the belowGainFloorCount empty-state explains the
// boards that stay empty anyway.
const ACC_BENCHMARK_SCALE_FLOOR = 0.5;

export function computeAccBenchmarkScale(
  prediction: Pick<PlayerAccPrediction, "accConservative">,
  typicalAccuracy: number,
): number {
  const you = 5 * prediction.accConservative - 4;
  const typical = 5 * typicalAccuracy - 4;
  if (!Number.isFinite(you) || !(typical > 0)) return 1;
  return Math.max(ACC_BENCHMARK_SCALE_FLOOR, Math.min(1, you / typical));
}

// The typical peer's custom accuracy on one candidate lane: the weighted
// median of the stored (A9) accuracies over the same wB kernel the pp
// benchmark quantiles use. The columns start null and only fill as
// maps-refresh re-fetches top plays, so below ACC_TYPICAL_MIN_PEER_ACCS
// usable rows this falls back to the accuracy model's global prior at gap 0
// (an on-level chart then scales by ~1).
function typicalPeerAccuracy(entries: CandidatePeerEntry[]): number {
  const pairs: Array<{ v: number; w: number }> = [];
  for (const entry of entries) {
    if (entry.acc != null && entry.acc > 0 && entry.acc <= 1) pairs.push({ v: entry.acc, w: entry.wB });
  }
  if (pairs.length < ACC_TYPICAL_MIN_PEER_ACCS) return ACC_MODEL_PRIOR_TYPICAL_ACC;
  const median = weightedQuantile(pairs, 0.5);
  return Math.min(ACC_TYPICAL_MAX, Math.max(ACC_TYPICAL_MIN, median));
}

// The A10 P(finish) inputs for one candidate lane. Every member may be
// missing (null / non-positive / no choke prediction); a missing signal is
// neutral, never a penalty.
export interface SurvivalSignals {
  playCount: number | null;
  passCount: number | null;
  // Lane-adjusted map length in seconds (see laneLengthSec); <= 0 = unknown.
  lengthSec: number;
  choke: Pick<PlayerChokePrediction, "chokeRate" | "confidence"> | null;
}

// pFinish = popFactor * chokeFactor ^ lengthExp (see the SURVIVAL_* constant
// block for the full rationale). Monotone in each signal: a lower population
// pass rate, a higher predicted choke rate, and a longer map (given any choke
// risk) each only ever lower the result. All-neutral inputs return exactly 1.
// Exported for tests.
export function computeSurvival(signals: SurvivalSignals): number {
  // Population pass rate, shrunk toward the typical rate by pseudo-plays so a
  // thin play count barely moves it, then mapped against the LOW anchor: at
  // or above it stays 1 (the midfield of real pass rates is not a risk
  // signal), below it discounts linearly to the floor.
  let popFactor = 1;
  const { playCount, passCount } = signals;
  if (playCount != null && playCount > 0 && passCount != null && passCount >= 0) {
    const shrunkRate = (passCount + SURVIVAL_PASS_PRIOR_RATE * SURVIVAL_PASS_PRIOR_PLAYS)
      / (playCount + SURVIVAL_PASS_PRIOR_PLAYS);
    popFactor = Math.max(SURVIVAL_PASS_FLOOR, Math.min(1, shrunkRate / SURVIVAL_PASS_LOW_RATE));
  }
  // The subject's own choke curve, confidence-shaded: a certain choke at full
  // confidence discounts by SURVIVAL_CHOKE_MAX_PENALTY, thin evidence fades
  // toward neutral.
  let chokeFactor = 1;
  if (signals.choke) {
    chokeFactor = 1 - SURVIVAL_CHOKE_MAX_PENALTY * clamp01(signals.choke.chokeRate) * clamp01(signals.choke.confidence);
  }
  // Length compounds the per-segment choke risk; with no choke signal
  // (chokeFactor 1) the exponent is a no-op, so length alone never punishes.
  const lengthExp = signals.lengthSec > 0
    ? Math.min(SURVIVAL_LENGTH_EXP_MAX, Math.max(SURVIVAL_LENGTH_EXP_MIN, signals.lengthSec / SURVIVAL_LENGTH_REF_SEC))
    : 1;
  return Math.max(SURVIVAL_FLOOR, popFactor * Math.pow(chokeFactor, lengthExp));
}

// Real-time seconds a lane takes: the stored length is at 1.0x, DT compresses
// it, HT stretches it. 0 (unknown length) stays 0 = neutral.
function laneLengthSec(lengthSec: number, speedBucket: ScoreSpeedBucket): number {
  if (!(lengthSec > 0)) return 0;
  if (speedBucket === "dt") return lengthSec / 1.5;
  if (speedBucket === "ht") return lengthSec / 0.75;
  return lengthSec;
}

// Effective bpm at a lane's rate (the laneLengthSec counterpart): DT plays
// 1.5x faster, HT 0.75x. 0 (unknown bpm) stays 0.
function laneBpm(bpm: number, speedBucket: ScoreSpeedBucket): number {
  if (!(bpm > 0)) return 0;
  if (speedBucket === "dt") return bpm * 1.5;
  if (speedBucket === "ht") return bpm * 0.75;
  return bpm;
}

// The chart's MSD Overall at a speed lane's rate, for the accuracy model:
// the stored 1.0x Overall for the normal lane, the DT sweep's Overall (else
// a linear 1.5x scaling) for DT, and the same linear approximation the
// feasibility gate's HT lane uses for HT. Null (no scaling) when the chart
// has no stored Overall.
function laneChartOverall(
  overall: number | null,
  dtOverall: number | null,
  speedBucket: ScoreSpeedBucket,
): number | null {
  if (speedBucket === "dt") {
    if (dtOverall != null && dtOverall > 0) return dtOverall;
    return overall != null && overall > 0 ? overall * 1.5 : null;
  }
  if (speedBucket === "ht") {
    return overall != null && overall > 0 ? overall * FEASIBILITY_HT_RATE_MSD_RATIO : null;
  }
  return overall != null && overall > 0 ? overall : null;
}

// Star-fit band from the subject's top plays in one keymode ("any" = all scores).
function computeFitBand(rankedScores: OscScore[], keyMode: FarmHelperKeyMode): FitBand {
  const fitStars = rankedScores
    .filter((score) => scoreMatchesKeyMode(score, keyMode))
    .slice(0, FIT_SAMPLE_SIZE)
    .map((score) => numberOr(score.beatmap?.difficulty_rating, 0))
    .filter((stars) => stars > 0);
  fitStars.sort((a, b) => a - b);
  const hasFit = fitStars.length >= 5;
  const starLo = hasFit ? quantile(fitStars, 0.1) : 0;
  const starHi = hasFit ? quantile(fitStars, 0.95) : Infinity;
  return {
    hasFit,
    starLo,
    starHi,
    starMid: hasFit ? quantile(fitStars, 0.5) : 0,
    starSpread: hasFit ? Math.max(1.5, starHi - starLo) : 1.5,
  };
}

// The peerFraction / popularity gate: a discovery-weight ratio floor over the
// meaningful-sample denominator. Shared by every run.
function gateCandidates(
  peerFarmed: PeerFarmedAggregation,
  isPopular: boolean,
): Array<{ agg: CandidateAgg; kernelFraction: number }> {
  const minPeerFraction = isPopular ? POPULAR_PEER_MIN_FRACTION : PEER_MIN_FRACTION;
  const candidates: Array<{ agg: CandidateAgg; kernelFraction: number }> = [];
  for (const agg of peerFarmed.byBeatmap.values()) {
    if (agg.entries.length < PEER_MIN_COUNT) continue;
    // Numerator and denominator cover the SAME peer set (the eligible
    // meaningful-sample peers): drive-by farmers below the sample floor sit
    // in neither, so the advertised percentage stays honest instead of
    // overflowing into the Math.min clamp.
    const numeratorWd = agg.entries.reduce((sum, e) => sum + (peerFarmed.eligibleIds.has(e.userId) ? e.wD : 0), 0);
    const kernelFraction = peerFarmed.eligibleWdSum > 0 ? Math.min(1, numeratorWd / peerFarmed.eligibleWdSum) : 0;
    if (kernelFraction < minPeerFraction) continue;
    candidates.push({ agg, kernelFraction });
  }
  return candidates;
}

// The cohort summary for one run. `farmDataCount` is filled in after the farmed
// aggregation; the effective count reflects post-shape-fold discovery weights.
// The pp range is on the run's own selection scale (modePp: variant/proxy pp
// for keymode runs, total pp for the fallback), not the peers' total pp - a 7K
// main with 26k total but 13k 4K pp is a 13k peer in a 4K cohort, and showing
// their total would misread as "compared to 26k players".
function buildPeerBand(mode: string, peers: WeightedPeer[]): PeerBandSummary {
  return {
    mode,
    count: peers.length,
    farmDataCount: 0,
    minPp: peers.length ? Math.min(...peers.map((p) => p.modePp)) : 0,
    maxPp: peers.length ? Math.max(...peers.map((p) => p.modePp)) : 0,
    effectiveCount: Math.round(peers.reduce((sum, p) => sum + p.wD, 0)),
  };
}

// Unions the per-run bands into the compat `peerBand`: summed counts, min/max pp
// across non-empty runs, per-run modes joined with "+" (e.g. "knn+knn_wide").
function mergeBands(bands: PeerBandSummary[]): PeerBandSummary {
  const nonEmpty = bands.filter((band) => band.count > 0);
  return {
    mode: bands.map((band) => band.mode).join("+"),
    count: bands.reduce((sum, band) => sum + band.count, 0),
    farmDataCount: bands.reduce((sum, band) => sum + band.farmDataCount, 0),
    minPp: nonEmpty.length ? Math.min(...nonEmpty.map((band) => band.minPp)) : 0,
    maxPp: nonEmpty.length ? Math.max(...nonEmpty.map((band) => band.maxPp)) : 0,
    effectiveCount: bands.reduce((sum, band) => sum + band.effectiveCount, 0),
  };
}

interface CohortCandidate {
  userId: number;
  pp: number;
  modePp: number;
  confidence: number;
  needsVariantEnrich?: boolean;
}

// Enqueues enrich_user for the cohort's never-variant-enriched proxy peers,
// strongest discovery weight first. The dedupe key matches organic enrichment,
// so repeats within a queue cycle collapse; once the fetch stores a variants
// block the peer stops qualifying (hasVariantsProfile flips true even when the
// fetched profile carries no positive variant pp).
const VARIANT_SELF_HEAL_MAX = 12;
const VARIANT_SELF_HEAL_PRIORITY = 10;

function enqueueVariantSelfHeal(queue: JobQueue, peers: WeightedPeer[]): void {
  const targets = peers
    .filter((peer) => peer.needsVariantEnrich)
    .sort((a, b) => b.wD - a.wD)
    .slice(0, VARIANT_SELF_HEAL_MAX);
  for (const peer of targets) {
    void queue
      .enqueue("enrich_user", `user:${peer.userId}`, { userId: peer.userId }, { priority: VARIANT_SELF_HEAL_PRIORITY })
      .catch(() => {});
  }
}

// The same-pp comparison cohort as a kernel-weighted kNN: a candidate set (the
// key-mode pool for 4k/7k, a total-pp window for "any") weighted per peer by two
// triangular kernels over their distance from the subject. The full cohort stays
// server-side; HTTP responses only include counts and tiny top-peer previews.
async function selectPeerBand(
  db: Db,
  userId: number,
  subjectPp: number,
  keyMode: FarmHelperKeyMode,
  subjectModePp: number,
  // writeDb: the dedicated write connection the pool's one-off calibration
  // observability write may use; absent means that write is skipped.
  options: { strictKeyMode?: boolean; writeDb?: Db } = {},
): Promise<{ peers: WeightedPeer[]; mode: string }> {
  if (keyMode !== "any") {
    if (subjectModePp > 0) {
      const keyModeResult = await selectKeyModeKnn(db, userId, keyMode, subjectModePp, options.writeDb);
      // A strict request keeps the key-mode cohort even when thin; a non-strict
      // caller (e.g. the who-farms modal derived from a map's key count) only
      // falls back to the broader total-pp cohort when the key-mode pool is too
      // sparse to compare against. Gate on the raw cohort size (not the weighted
      // effective sample) so a full cohort of same-keymode peers whose distances
      // merely down-weight them is still preferred over ignoring keymode.
      if (options.strictKeyMode || keyModeResult.peers.length >= MIN_EFFECTIVE_PEERS) return keyModeResult;
    } else if (options.strictKeyMode) {
      return { peers: [], mode: `${keyMode}_no_pp_proxy` };
    }
  }
  if (subjectPp <= 0) return { peers: [], mode: "no_pp" };
  return selectTotalPpKnn(db, userId, subjectPp);
}

async function selectKeyModeKnn(
  db: Db,
  userId: number,
  keyMode: ConcreteFarmHelperKeyMode,
  subjectModePp: number,
  writeDb?: Db,
): Promise<{ peers: WeightedPeer[]; mode: string }> {
  const keyCount = keyModeToKeys(keyMode) as FarmHelperKeyCount;
  const { peers: pool, calibration } = await getKeyModePeerPool(db, keyCount, writeDb);
  const vectors = await getBaselineUserVectors(db, keyCount).catch(() => new Map<number, BaselineUserVector>());
  const subjectVector = vectors.get(userId) ?? null;
  const nowMs = Date.now();
  const candidates: CohortCandidate[] = [];
  for (const peer of pool) {
    if (peer.userId === userId) continue;
    const hasVariant = peer.variantPp != null && peer.variantPp > 0;
    // Real variant pp when present, else the proxy calibrated onto the variant
    // scale so proxy peers sit at the right distance from a variant subject.
    const modePp = hasVariant ? (peer.variantPp as number) : calibrateProxy(calibration, peer.weightedPp);
    if (!Number.isFinite(modePp) || modePp <= 0) continue;
    const peerVector = vectors.get(peer.userId) ?? null;
    const affinity = peerRecencyFactor(peerVector, nowMs) * skillSimilarityFactor(subjectVector, peerVector);
    candidates.push({
      userId: peer.userId,
      pp: peer.pp,
      modePp,
      confidence: (hasVariant ? 1 : PROXY_CONFIDENCE) * affinity,
      needsVariantEnrich: !hasVariant && !peer.hasVariantsProfile,
    });
  }
  return kernelSelect(candidates, subjectModePp);
}

// Peers with no baseline vector (or no timestamped plays) stay neutral.
function peerRecencyFactor(vector: BaselineUserVector | null, nowMs: number): number {
  if (!vector || vector.latestPlayedAtMs == null) return 1;
  const age = nowMs - vector.latestPlayedAtMs;
  if (age <= RECENCY_FULL_MS) return 1;
  return Math.max(RECENCY_FLOOR, 0.5 ** ((age - RECENCY_FULL_MS) / RECENCY_HALF_LIFE_MS));
}

// Correlation of Overall-normalized rating shapes over the axes both sides
// have; neutral when either side lacks a trustworthy vector or the shared
// axis set is too thin to mean anything.
function skillSimilarityFactor(subject: BaselineUserVector | null, peer: BaselineUserVector | null): number {
  if (!subject || !peer) return 1;
  if (subject.analyzedPlays < SKILL_SIM_MIN_PLAYS || peer.analyzedPlays < SKILL_SIM_MIN_PLAYS) return 1;
  const subjectOverall = Number(subject.ratings.Overall ?? 0);
  const peerOverall = Number(peer.ratings.Overall ?? 0);
  if (!(subjectOverall > 0) || !(peerOverall > 0)) return 1;
  const a: number[] = [];
  const b: number[] = [];
  for (const [axis, value] of Object.entries(subject.ratings)) {
    if (axis === "Overall") continue;
    const peerValue = Number(peer.ratings[axis] ?? 0);
    if (!(Number(value) > 0) || !(peerValue > 0)) continue;
    a.push(Number(value) / subjectOverall);
    b.push(peerValue / peerOverall);
  }
  if (a.length < SKILL_SIM_MIN_SHARED_AXES) return 1;
  const correlation = pearson(a, b);
  if (correlation == null) return 1;
  return SKILL_SIM_FLOOR + (1 - SKILL_SIM_FLOOR) * Math.max(0, Math.min(1, (correlation + 1) / 2));
}

function pearson(a: number[], b: number[]): number | null {
  const n = a.length;
  const meanA = a.reduce((sum, v) => sum + v, 0) / n;
  const meanB = b.reduce((sum, v) => sum + v, 0) / n;
  let cov = 0;
  let varA = 0;
  let varB = 0;
  for (let i = 0; i < n; i += 1) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }
  // A flat shape has no direction to correlate against.
  if (varA <= 1e-9 || varB <= 1e-9) return null;
  return cov / Math.sqrt(varA * varB);
}

async function selectTotalPpKnn(
  db: Db,
  userId: number,
  subjectPp: number,
): Promise<{ peers: WeightedPeer[]; mode: string }> {
  // Window generously (covers the widest kernel widening, with a floor for
  // low-pp subjects) and let the kernel do the relative weighting in JS. Total
  // pp is a real measurement: no calibration, full confidence.
  const pool = await getTotalPpPool(db);
  const downFetch = Math.max(subjectPp * 0.35, 800);
  const upFetch = Math.max(subjectPp * 0.6, 800);
  const lo = Math.max(0, subjectPp - downFetch);
  const hi = subjectPp + upFetch;
  const candidates: CohortCandidate[] = [];
  for (const row of pool) {
    if (row.userId === userId || row.pp < lo || row.pp > hi) continue;
    candidates.push({ userId: row.userId, pp: row.pp, modePp: row.pp, confidence: 1 });
  }
  return kernelSelect(candidates, subjectPp);
}

// The total-pp pool (every tracked user with pp), cached briefly per Db: the
// who-farms modal and repeated "any" snapshots re-enter peer selection often,
// so one bounded read per TTL beats a users window scan per request (mirrors
// getKeyModePeerPool on the keymode path).
async function getTotalPpPool(db: Db): Promise<Array<{ userId: number; pp: number }>> {
  const now = Date.now();
  const cached = totalPpPoolCache.get(db);
  if (cached && cached.expiresAt > now) return cached.rows;
  // is_active = 1 keeps banned/deactivated players out of the cohort; the users
  // row always exists here (we are selecting from users), so this never rejects
  // anyone for merely missing data.
  const rows = (await exec(db, "select user_id, pp from users where pp is not null and pp > 0 and is_active = 1")).rows;
  const pool: Array<{ userId: number; pp: number }> = [];
  for (const row of rows) {
    const id = Number(row.user_id);
    const pp = Number(row.pp);
    if (!Number.isSafeInteger(id) || id <= 0 || !Number.isFinite(pp) || pp <= 0) continue;
    pool.push({ userId: id, pp });
  }
  totalPpPoolCache.set(db, { rows: pool, expiresAt: now + TOTAL_PP_POOL_TTL_MS });
  return pool;
}

// Weights each candidate by the discovery and benchmark kernels, widening both
// (1.5x per step) until the effective sample (sum of discovery weights) clears
// MIN_EFFECTIVE_PEERS, then caps to the strongest KNN_MAX_PEERS by discovery
// weight to bound the farmed-row scan.
function kernelSelect(candidates: CohortCandidate[], subjectModePp: number): { peers: WeightedPeer[]; mode: string } {
  if (subjectModePp <= 0 || candidates.length === 0) return { peers: [], mode: "knn" };

  let weighted: WeightedPeer[] = [];
  let mode = "knn_sparse";
  for (let i = 0; i < KNN_WIDEN_MODES.length; i++) {
    const m = 1.5 ** i;
    weighted = [];
    let effN = 0;
    for (const c of candidates) {
      const d = (c.modePp - subjectModePp) / subjectModePp;
      const wD = c.confidence * triangular(d, DISCOVERY_KERNEL_DOWN * m, DISCOVERY_KERNEL_UP * m);
      const wB = c.confidence * triangular(d, BENCHMARK_KERNEL_HALF_WIDTH * m, BENCHMARK_KERNEL_HALF_WIDTH * m);
      // A peer belongs to the cohort if EITHER kernel reaches them. The
      // benchmark kernel extends further down (0.10) than the discovery
      // kernel (0.08), so peers at d in (-0.10, -0.08] carry benchmark
      // weight with zero discovery weight; skipping on wD alone (the old
      // behavior) clipped every peer median/p75 20% harder on the
      // below-you side, biasing targets upward against the symmetric-kernel
      // design. Discovery-derived quantities (effN, peerFraction, the
      // self-heal ordering) keep using wD only; benchmark quantiles use wB.
      if (wD <= 0 && wB <= 0) continue;
      weighted.push({ userId: c.userId, pp: c.pp, modePp: c.modePp, wD, wB, needsVariantEnrich: c.needsVariantEnrich });
      effN += wD;
    }
    if (effN >= MIN_EFFECTIVE_PEERS) {
      mode = KNN_WIDEN_MODES[i];
      break;
    }
  }

  // Sparse fallback: the old band ladder ended in an unconditional "nearest"
  // mode; keep that guarantee for a subject whose neighbors mostly sit outside
  // even the widest kernel (pp-isolated top ranks, sparse keymodes). Gate on
  // the COUNT of peers carrying DISCOVERY weight, not the weighted effective
  // sample: a full cohort of down-weighted peers is a valid cohort, an
  // (almost) empty one is not - and benchmark-only peers (wB > 0, wD = 0)
  // cannot discover candidates, so they must not mask an empty discovery
  // cohort. Nearest peers by mode-pp distance get a flat floor weight, and
  // any peer either widest kernel did reach keeps its kernel weight where
  // that is stronger.
  const discoveryPeerCount = weighted.reduce((count, peer) => count + (peer.wD > 0 ? 1 : 0), 0);
  if (mode === "knn_sparse" && discoveryPeerCount < MIN_EFFECTIVE_PEERS && candidates.length > 0) {
    const merged = new Map(weighted.map((p) => [p.userId, p]));
    const nearest = [...candidates]
      .sort((a, b) => Math.abs(a.modePp - subjectModePp) - Math.abs(b.modePp - subjectModePp))
      .slice(0, SPARSE_FALLBACK_PEERS);
    for (const c of nearest) {
      const existing = merged.get(c.userId);
      const floor = c.confidence * SPARSE_FALLBACK_WEIGHT;
      merged.set(c.userId, {
        userId: c.userId,
        pp: c.pp,
        modePp: c.modePp,
        wD: Math.max(existing?.wD ?? 0, floor),
        wB: Math.max(existing?.wB ?? 0, floor),
        needsVariantEnrich: c.needsVariantEnrich,
      });
    }
    weighted = [...merged.values()];
  }

  weighted.sort((a, b) => b.wD - a.wD);
  if (weighted.length > KNN_MAX_PEERS) weighted = weighted.slice(0, KNN_MAX_PEERS);
  return { peers: weighted, mode };
}

// Triangular kernel: 1 at d=0, falling linearly to 0 at -down and +up, 0 outside.
export function triangular(d: number, down: number, up: number): number {
  if (d === 0) return 1;
  if (d < 0) return d <= -down ? 0 : 1 + d / down;
  return d >= up ? 0 : 1 - d / up;
}

export interface FarmHelperFarmer {
  userId: number;
  username: string;
  avatarUrl: string;
  pp: number;
  mods: string[];
}

export interface FarmHelperFarmersResult {
  beatmapId: number;
  total: number;
  farmers: FarmHelperFarmer[];
}

const FARMERS_MAX = 300;

// Full list of the subject's peers who have this beatmap in their top plays,
// ranked by pp. Powers the "who farmed this" modal; computed on demand so the
// main snapshot stays small. The osu! profile resolve is cached, so this is a
// DB-only lookup in the common case.
export async function getFarmHelperFarmers(
  db: Db,
  osu: ProfileOsuClient,
  rawKey: string,
  beatmapId: number,
  speedBucket?: ScoreSpeedBucket,
  requestedKeyMode?: FarmHelperKeyMode,
  queue?: JobQueue,
  profileLookupMode: FarmHelperProfileLookupMode = "auto",
): Promise<FarmHelperFarmersResult> {
  const profile = await resolveProfile(db, osu, rawKey, queue, profileLookupMode);
  const user = profile.user;
  const userId = Number(user.id ?? 0);
  if (!Number.isInteger(userId) || userId <= 0) throw new FarmHelperUserNotFoundError(rawKey);
  if (!Number.isInteger(beatmapId) || beatmapId <= 0) return { beatmapId, total: 0, farmers: [] };

  const statistics = asRecord(user.statistics);
  const subjectPp = numberOr(statistics.pp, 0);
  const beatmap = (await readBeatmapMeta(db, [beatmapId])).get(beatmapId);
  // Mirror the snapshot's peer pool: use the keyMode the card was generated with,
  // not the map's own key count. Otherwise the card (e.g. "any" -> total-pp band)
  // and this list (map-derived "4k"/"7k" band) sample different cohorts and the
  // farmer counts disagree. Fall back to the map's key count for direct callers
  // that don't pass a keyMode.
  const keyMode: FarmHelperKeyMode = requestedKeyMode
    ?? (beatmap?.keys === 7 ? "7k" : beatmap?.keys === 4 ? "4k" : "any");
  const lane = speedBucket ?? inferSubjectSpeedBucket(profile.bestScores, beatmapId);
  const rankedScores = [...profile.bestScores]
    .filter((score) => typeof score.pp === "number" && score.pp > 0)
    .sort((a, b) => (b.pp ?? 0) - (a.pp ?? 0));
  const subjectModeStats = calculateSubjectKeyModeStats(rankedScores, keyMode);
  const subjectPeerPp = getVariantPp(getVariantPps(statistics), keyMode) ?? subjectModeStats.weightedPp;
  const { peers } = await selectPeerBand(db, userId, subjectPp, keyMode, subjectPeerPp, {
    strictKeyMode: requestedKeyMode != null && keyMode !== "any",
  });
  if (peers.length === 0) return { beatmapId, total: 0, farmers: [] };

  const peerIds = peers.map((p) => p.userId);
  const farmersByLane = new Map<string, CanonicalFarmedScore>();
  for (let i = 0; i < peerIds.length; i += 900) {
    const chunk = peerIds.slice(i, i + 900);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "?").join(",");
    const rows = (await exec(
      db,
      `select s.beatmap_id, s.user_id, s.pp, s.mods_json, s.played_at, s.updated_at from country_maps_farmed_scores s
       where s.beatmap_id = ? and s.user_id in (${placeholders})
         and not exists (select 1 from users u where u.user_id = s.user_id and u.is_active = 0)`,
      [beatmapId, ...chunk],
    )).rows;
    for (const row of rows) {
      const farmed = parseFarmedScoreRow(row);
      if (!farmed) continue;
      if (lane && farmed.speedBucket !== lane) continue;
      keepBestFarmedScore(farmersByLane, farmed);
    }
  }

  const farmersRaw = [...farmersByLane.values()];
  farmersRaw.sort((a, b) => b.pp - a.pp);
  const total = farmersRaw.length;
  const top = farmersRaw.slice(0, FARMERS_MAX);
  const rows = await selectByIds(db, "select user_id, username, avatar_url from users where user_id in", top.map((f) => f.userId));
  const byId = new Map(rows.map((row) => [Number(row.user_id), row]));
  const farmers: FarmHelperFarmer[] = top.map((f) => {
    const row = byId.get(f.userId);
    return {
      userId: f.userId,
      username: row ? String(row.username ?? "") : "",
      avatarUrl: row ? String(row.avatar_url ?? "") : "",
      pp: round2(f.pp),
      mods: f.mods,
    };
  });
  return { beatmapId, total, farmers };
}

export interface FarmHelperNeighbor {
  userId: number;
  username: string;
  avatarUrl: string;
  modePp: number;
}

export interface FarmHelperNeighborsResult {
  userId: number;
  username: string;
  avatarUrl: string;
  // Cohort axis actually used: a concrete keymode, or "any" when the subject
  // had no keymode data (or the keymode pool was too sparse) and the band fell
  // back to total pp.
  keyMode: FarmHelperKeyMode;
  bandMode: string;
  subjectModePp: number;
  neighborCount: number;
  neighbors: FarmHelperNeighbor[];
}

const NEIGHBORS_MAX = 96;

// The sampled peer cohort around a player, for the farm-helper landing
// neighborhood graph. Reuses the snapshot's kernel-kNN cohort selection; the
// sample is stratified by mode-pp distance so the graph sees the whole band,
// not just the nearest rim. The osu! profile resolve is cached, so this is a
// DB-only lookup in the common case.
export async function getFarmHelperNeighbors(
  db: Db,
  osu: ProfileOsuClient,
  rawKey: string,
  requestedKeyMode: FarmHelperKeyMode = "any",
  queue?: JobQueue,
  profileLookupMode: FarmHelperProfileLookupMode = "auto",
): Promise<FarmHelperNeighborsResult> {
  const profile = await resolveProfile(db, osu, rawKey, queue, profileLookupMode);
  const user = profile.user;
  const userId = Number(user.id ?? 0);
  if (!Number.isInteger(userId) || userId <= 0) throw new FarmHelperUserNotFoundError(rawKey);

  const statistics = asRecord(user.statistics);
  const subjectPp = numberOr(statistics.pp, 0);
  const variantPps = getVariantPps(statistics);
  const rankedScores = [...profile.bestScores]
    .filter((score) => typeof score.pp === "number" && score.pp > 0)
    .sort((a, b) => (b.pp ?? 0) - (a.pp ?? 0));
  const subjectModePpFor = (mode: ConcreteFarmHelperKeyMode) =>
    getVariantPp(variantPps, mode) ?? calculateSubjectKeyModeStats(rankedScores, mode).weightedPp;

  // "any" resolves to the subject's dominant concrete keymode so the graph
  // compares like with like (a 7k monster is not a 4k neighbor).
  let keyMode: FarmHelperKeyMode = requestedKeyMode;
  if (keyMode === "any") {
    const pp4 = subjectModePpFor("4k");
    const pp7 = subjectModePpFor("7k");
    if (pp4 > 0 || pp7 > 0) keyMode = pp7 > pp4 ? "7k" : "4k";
  }

  let band: { peers: WeightedPeer[]; mode: string } = { peers: [], mode: "no_pp" };
  let referencePp = subjectPp;
  let usedKeyMode: FarmHelperKeyMode = "any";
  if (keyMode !== "any") {
    const subjectModePp = subjectModePpFor(keyMode);
    if (subjectModePp > 0) {
      const result = await selectKeyModeKnn(db, userId, keyMode, subjectModePp);
      if (result.peers.length >= MIN_EFFECTIVE_PEERS) {
        band = result;
        referencePp = subjectModePp;
        usedKeyMode = keyMode;
      }
    }
  }
  if (usedKeyMode === "any" && subjectPp > 0) {
    band = await selectTotalPpKnn(db, userId, subjectPp);
  }

  // Stratified sample across the distance range: nearest first, then evenly
  // spaced through the tail so far cohort members stay represented.
  const sorted = [...band.peers].sort(
    (a, b) => Math.abs(a.modePp - referencePp) - Math.abs(b.modePp - referencePp),
  );
  let sample: WeightedPeer[];
  if (sorted.length <= NEIGHBORS_MAX) {
    sample = sorted;
  } else {
    const picked = new Map<number, WeightedPeer>();
    for (let i = 0; i < NEIGHBORS_MAX; i++) {
      const peer = sorted[Math.round((i * (sorted.length - 1)) / (NEIGHBORS_MAX - 1))];
      picked.set(peer.userId, peer);
    }
    sample = [...picked.values()];
  }

  const rows = await selectByIds(db, "select user_id, username, avatar_url from users where user_id in", sample.map((p) => p.userId));
  const byId = new Map(rows.map((row) => [Number(row.user_id), row]));
  const neighbors: FarmHelperNeighbor[] = sample.map((peer) => {
    const row = byId.get(peer.userId);
    return {
      userId: peer.userId,
      username: row ? String(row.username ?? "") : "",
      avatarUrl: row ? String(row.avatar_url ?? "") : "",
      modePp: round2(peer.modePp),
    };
  });

  return {
    userId,
    username: String(user.username ?? rawKey),
    avatarUrl: String(user.avatar_url ?? ""),
    keyMode: usedKeyMode,
    bandMode: band.mode,
    subjectModePp: round2(referencePp),
    neighborCount: band.peers.length,
    neighbors,
  };
}

async function aggregatePeerFarmedMaps(
  db: Db,
  peers: WeightedPeer[],
  keys: number | null,
  asOf?: number,
  timings?: FarmHelperTimings,
): Promise<PeerFarmedAggregation> {
  const weightById = new Map(peers.map((p) => [p.userId, { wD: p.wD, wB: p.wB }]));
  // Inactive peers are dropped up front from the id list (one small lookup)
  // instead of a correlated NOT EXISTS probing users once per farmed row.
  const peerIds = await filterActivePeerIds(db, peers.map((p) => p.userId));
  const byPeerLane = new Map<string, CanonicalFarmedScore>();
  for (let i = 0; i < peerIds.length; i += 900) {
    const chunk = peerIds.slice(i, i + 900);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "?").join(",");
    // This read stays inside idx_country_maps_farmed_scores_user_lane: every
    // selected column is in the index (the epoch conversions run over indexed
    // text), so a cohort read never touches the main table. The keymode
    // filter admits -1 rows (key count unknown at write time); the JS meta
    // filter in scoreCandidates stays authoritative for those.
    const rows = (await exec(
      db,
      `select s.beatmap_id, s.user_id, s.pp, s.mods_key, s.speed_bucket, s.accuracy,
              cast(strftime('%s', s.played_at) as integer) * 1000 as played_at_ms,
              cast(strftime('%s', s.updated_at) as integer) * 1000 as updated_at_ms
       from country_maps_farmed_scores s
       where s.user_id in (${placeholders})${keys != null ? " and s.key_count in (?, -1)" : ""}`,
      keys != null ? [...chunk, keys] : chunk,
    )).rows;
    timings?.count("farm_rows", rows.length);
    for (const row of rows) {
      const farmed = parseFarmedLaneRow(row);
      if (!farmed) continue;
      // Backtest as-of reconstruction: a farmed row only counts if it was set on
      // or before the cutoff. Rows with an unknown played_at (playedAtMs === 0)
      // are kept (better slight leakage than dropping most of the pool).
      if (asOf != null && farmed.playedAtMs > 0 && farmed.playedAtMs > asOf) continue;
      keepBestFarmedScore(byPeerLane, farmed);
    }
  }

  const byBeatmap = new Map<string, CandidateAgg>();
  const farmedRowsPerPeer = new Map<number, number>();
  for (const farmed of byPeerLane.values()) {
    const weights = weightById.get(farmed.userId);
    if (!weights) continue;
    farmedRowsPerPeer.set(farmed.userId, (farmedRowsPerPeer.get(farmed.userId) ?? 0) + 1);
    const key = farmHelperLaneKey(farmed.beatmapId, farmed.speedBucket);
    let agg = byBeatmap.get(key);
    if (!agg) {
      agg = {
        beatmapId: farmed.beatmapId,
        speedBucket: farmed.speedBucket,
        entries: [],
        modCombos: new Map(),
        latestUpdatedMs: 0,
        playedAtMs: [],
      };
      byBeatmap.set(key, agg);
    }
    agg.entries.push({ userId: farmed.userId, pp: farmed.pp, wD: weights.wD, wB: weights.wB, acc: farmed.accuracy });
    const modKey = farmed.mods.join(",");
    const modCombo = agg.modCombos.get(modKey) ?? { mods: farmed.mods, count: 0, ppTotal: 0 };
    modCombo.count += 1;
    modCombo.ppTotal += farmed.pp;
    agg.modCombos.set(modKey, modCombo);
    if (farmed.updatedAtMs > agg.latestUpdatedMs) agg.latestUpdatedMs = farmed.updatedAtMs;
    if (farmed.playedAtMs > 0) agg.playedAtMs.push(farmed.playedAtMs);
  }

  // Denominator = peers with a meaningful farm sample. If none clear the bar (a
  // tiny cohort where nobody has farmed much), fall back to every farm-data peer
  // rather than stranding the whole cohort with a zero denominator.
  const eligibleIds = [...farmedRowsPerPeer].filter(([, count]) => count >= MIN_FARMED_FOR_SAMPLE).map(([userId]) => userId);
  const denominatorIds = eligibleIds.length > 0 ? eligibleIds : [...farmedRowsPerPeer.keys()];
  let eligibleWdSum = 0;
  for (const userId of denominatorIds) eligibleWdSum += weightById.get(userId)?.wD ?? 0;
  return {
    byBeatmap,
    farmDataPeerCount: farmedRowsPerPeer.size,
    eligiblePeerCount: denominatorIds.length,
    eligibleWdSum,
    eligibleIds: new Set(denominatorIds),
  };
}

function dateMsToIso(ms: number): string | null {
  return ms > 0 && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function maxOf(values: number[]): number {
  let max = 0;
  for (const value of values) if (value > max) max = value;
  return max;
}

// The lane's top peers by pp. Selected incrementally rather than by sorting a
// copy of every entry: only TOP_PEERS_PER_REC survive, and a lane can carry
// hundreds of entries. Insertion is strictly-greater, which reproduces the
// stable descending sort this replaced - equal-pp peers keep aggregation order.
export function selectTopPeers(entries: CandidatePeerEntry[]): CandidatePeerEntry[] {
  const top: CandidatePeerEntry[] = [];
  for (const entry of entries) {
    if (top.length === TOP_PEERS_PER_REC && entry.pp <= top[top.length - 1].pp) continue;
    let index = 0;
    while (index < top.length && top[index].pp >= entry.pp) index += 1;
    top.splice(index, 0, entry);
    if (top.length > TOP_PEERS_PER_REC) top.pop();
  }
  return top;
}

function peerRecencyPlayedAtMs(values: number[]): number {
  const sorted = values.filter((value) => value > 0 && Number.isFinite(value)).sort((a, b) => b - a);
  if (sorted.length === 0) return 0;
  return sorted.length >= 5 ? sorted[2] : sorted[0];
}

async function filterActivePeerIds(db: Db, peerIds: number[]): Promise<number[]> {
  const inactive = new Set<number>();
  for (let i = 0; i < peerIds.length; i += 900) {
    const chunk = peerIds.slice(i, i + 900);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "?").join(",");
    const rows = (await exec(
      db,
      `select user_id from users where user_id in (${placeholders}) and is_active = 0`,
      chunk,
    )).rows;
    for (const row of rows) inactive.add(Number(row.user_id));
  }
  return inactive.size === 0 ? peerIds : peerIds.filter((id) => !inactive.has(id));
}

// Row parse for the cohort aggregation's lean lane read: the stored lane
// columns replace the per-row JSON.parse + mods normalization, and the epoch
// timestamps arrive precomputed from SQL. Rows written without lane columns
// (an old-version writer during a deploy overlap) degrade to the no-mod
// normal lane until the player's next overlay refresh rewrites them.
function parseFarmedLaneRow(row: Record<string, unknown>): CanonicalFarmedScore | null {
  const userId = Number(row.user_id);
  const beatmapId = Number(row.beatmap_id);
  const pp = Number(row.pp);
  if (!Number.isSafeInteger(userId) || userId <= 0) return null;
  if (!Number.isSafeInteger(beatmapId) || beatmapId <= 0) return null;
  if (!Number.isFinite(pp) || pp <= 0) return null;
  const modsKey = row.mods_key == null ? "" : String(row.mods_key);
  const mods = modsKey === "" ? [] : modsKey.split(",");
  const stored = row.speed_bucket;
  const speedBucket: ScoreSpeedBucket = stored === "dt" || stored === "ht" || stored === "normal"
    ? stored
    : getScoreSpeedBucket(mods);
  const playedAtMs = Number(row.played_at_ms);
  const updatedAtMs = Number(row.updated_at_ms);
  const accuracyRaw = Number(row.accuracy);
  return {
    userId,
    beatmapId,
    pp,
    mods,
    speedBucket,
    playedAtMs: Number.isFinite(playedAtMs) && playedAtMs > 0 ? playedAtMs : 0,
    updatedAtMs: Number.isFinite(updatedAtMs) && updatedAtMs > 0 ? updatedAtMs : 0,
    accuracy: Number.isFinite(accuracyRaw) && accuracyRaw > 0 && accuracyRaw <= 1 ? accuracyRaw : null,
  };
}

function parseFarmedScoreRow(row: Record<string, unknown>): CanonicalFarmedScore | null {
  const userId = Number(row.user_id);
  const beatmapId = Number(row.beatmap_id);
  const pp = Number(row.pp);
  if (!Number.isSafeInteger(userId) || userId <= 0) return null;
  if (!Number.isSafeInteger(beatmapId) || beatmapId <= 0) return null;
  if (!Number.isFinite(pp) || pp <= 0) return null;
  const mods = normalizeStoredMods(parseJson<string[]>(row.mods_json, []));
  const playedAtMs = row.played_at == null ? 0 : Date.parse(String(row.played_at));
  const updatedAtMs = row.updated_at == null ? 0 : Date.parse(String(row.updated_at));
  const accuracyRaw = Number(row.accuracy);
  return {
    userId,
    beatmapId,
    pp,
    mods,
    speedBucket: getScoreSpeedBucket(mods),
    playedAtMs: Number.isFinite(playedAtMs) ? playedAtMs : 0,
    updatedAtMs: Number.isFinite(updatedAtMs) ? updatedAtMs : 0,
    accuracy: Number.isFinite(accuracyRaw) && accuracyRaw > 0 && accuracyRaw <= 1 ? accuracyRaw : null,
  };
}

function keepBestFarmedScore(target: Map<string, CanonicalFarmedScore>, farmed: CanonicalFarmedScore): void {
  const key = `${farmed.userId}:${farmed.beatmapId}:${farmed.speedBucket}`;
  const existing = target.get(key);
  if (!existing || farmed.pp > existing.pp || (farmed.pp === existing.pp && farmed.updatedAtMs > existing.updatedAtMs)) {
    target.set(key, farmed);
  }
}

// The subject's shape plus per-family demonstrated-pp evidence for one
// concrete keymode. `shape` is null when too few top plays are analyzed;
// `familyTopPp` (best top-play pp per chart pattern family) only needs a
// single covered play per family, so it can carry evidence even when the
// shape cannot.
interface SubjectShapeContext {
  shape: UserShape | null;
  familyTopPp: Map<string, number>;
}

// Chart-shape weighting for one concrete-keymode run: down-weights peers whose
// farm charts look unlike the subject's, folding that mode's per-peer weights
// into wD/wB up front. Returns the subject's shape for this mode (used for
// per-candidate patternFit; null when too few top plays are analyzed) plus
// their per-family top-play pp. Also self-heals: enqueues chart analysis for
// the subject's un-analyzed top plays so their shape improves on later
// requests. Fire-and-forget.
async function computeShapeContext(
  db: Db,
  peers: WeightedPeer[],
  rankedScores: OscScore[],
  mode: ConcreteFarmHelperKeyMode,
  queue?: JobQueue,
): Promise<SubjectShapeContext> {
  const { shape, uncovered, familyTopPp } = await computeSubjectShape(db, rankedScores, mode);
  if (queue && uncovered.length > 0) {
    void enqueueMissingChartAnalyses(db, queue, uncovered).catch(() => {});
  }
  if (!shape) return { shape: null, familyTopPp };

  const userIds = peers.map((p) => p.userId);
  const peerShapes = await readPeerShapes(db, userIds, keyModeToKeys(mode));
  const weights = computeShapeWeights(shape, peerShapes, userIds);
  for (const peer of peers) {
    const wS = weights.get(peer.userId) ?? 1;
    peer.wD *= wS;
    peer.wB *= wS;
  }
  return { shape, familyTopPp };
}

async function computeSubjectShape(
  db: Db,
  rankedScores: OscScore[],
  shapeKeyMode: ConcreteFarmHelperKeyMode,
): Promise<{ shape: UserShape | null; uncovered: number[]; familyTopPp: Map<string, number> }> {
  const entries = rankedScores
    .filter((score) => scoreMatchesKeyMode(score, shapeKeyMode))
    .slice(0, 100)
    .map((score) => ({ beatmapId: Number(score.beatmap_id ?? score.beatmap?.id ?? 0), pp: score.pp as number }))
    .filter((entry) => Number.isSafeInteger(entry.beatmapId) && entry.beatmapId > 0);
  const familyTopPp = new Map<string, number>();
  if (entries.length === 0) return { shape: null, uncovered: [], familyTopPp };
  const chartShapes = await readChartShapes(db, entries.map((e) => e.beatmapId));
  for (const entry of entries) {
    const family = primaryPatternFamily(chartShapes.get(entry.beatmapId)?.pat);
    if (family == null) continue;
    familyTopPp.set(family, Math.max(familyTopPp.get(family) ?? 0, entry.pp));
  }
  if (entries.length < SHAPE_MIN_CHARTS) {
    return { shape: null, uncovered: entries.map((e) => e.beatmapId), familyTopPp };
  }
  const { shape, uncovered } = buildWeightedUserShape(entries, chartShapes);
  return { shape, uncovered, familyTopPp };
}

// patternFit: shape cosine clamped to [0,1] (pat/msd vectors are non-negative),
// or null when the shapes are not comparable.
function computePatternFit(subjectShape: UserShape, chartShape: ChartShape): number | null {
  const sim = shapeSimilarity(subjectShape, chartShape);
  return sim == null ? null : clamp01(sim);
}

interface FeasibilityModeEntry {
  // Effective per-skillset ratings the gate compares chart MSD against: the
  // keymode's own ratings when it has enough analyzed plays, a cross-keymode
  // transfer otherwise (see buildFeasibilityContext).
  ratings: Record<string, number>;
  // Per-pattern-family Overall ratings from the same keymode's plays, in the
  // chart-analysis id vocabulary ("jack", "ln", ...). Play-count floors are
  // enforced upstream (player-skills PATTERN_RATING_MIN_PLAYS).
  familyRatings: Map<string, number>;
  // Below FEASIBILITY_MIN_ANALYZED_PLAYS: margins tighten and targets cap at
  // the keymode's demonstrated top play.
  sparse: boolean;
}

interface FeasibilityContext {
  // Subject skill evidence per key count. A keymode with no evidence anywhere
  // (no rated plays in any keymode) never gates its charts.
  byKeys: Map<number, FeasibilityModeEntry>;
  chartMsd: Map<number, number[]>;
  chartMsdDt: Map<number, number[]>;
  // The DT sweep's own Overall per chart (the accuracy model's 1.5x
  // difficulty axis); charts without a stored sweep fall back to a linear
  // 1.5x scaling of the 1.0x Overall in laneChartOverall.
  chartDtOverall: Map<number, number>;
}

// getPlayerSkillBreakdown demands a queue for its stale-recompute enqueue;
// queue-less callers (backtest, Discord) read-only via allowEnqueue: false,
// where the queue is never touched.
const NOOP_QUEUE = { enqueue: async () => {} } as unknown as JobQueue;

// Builds the feasibility context (subject per-keymode skill evidence +
// candidate raw MSD at 1.0x, the latter passed in from the shared
// map_search_index read, plus the 1.5x MSD for the DT lane). Returns null
// (gate disabled) when the subject has no ready skill ratings at all or no
// candidate has MSD. The breakdown is read once per request in buildSnapshot
// (queue-less callers read without enqueueing a recompute) and passed in.
async function buildFeasibilityContext(
  db: Db,
  breakdown: PlayerSkillBreakdown,
  chartMsd: Map<number, number[]>,
): Promise<FeasibilityContext | null> {
  if (chartMsd.size === 0) return null;
  if (breakdown.status !== "ready") return null;
  const modesByKeys = new Map(breakdown.modes.map((mode) => [mode.keyCount, mode]));
  // The best-evidenced keymode donates its ratings to sparse ones.
  const donor = breakdown.modes
    .filter((mode) => mode.analyzedPlays >= FEASIBILITY_MIN_ANALYZED_PLAYS)
    .sort((a, b) => b.analyzedPlays - a.analyzedPlays)[0] ?? null;
  const byKeys = new Map<number, FeasibilityModeEntry>();
  for (const keyCountRaw of Object.keys(FEASIBILITY_MARGINS)) {
    const keyCount = Number(keyCountRaw);
    const mode = modesByKeys.get(keyCount) ?? null;
    const familyRatings = new Map((mode?.patterns ?? []).map((pattern) => [pattern.id, pattern.rating]));
    if (mode && mode.analyzedPlays >= FEASIBILITY_MIN_ANALYZED_PLAYS) {
      byKeys.set(keyCount, { ratings: mode.ratings, familyRatings, sparse: false });
      continue;
    }
    // Sparse keymode (below the analyzed-plays floor, possibly zero rated
    // plays): the old behavior omitted it entirely, which inverted the gate -
    // the players with the least evidence in a keymode got zero filtering
    // there. Instead, transfer the donor keymode's ratings (scaled down by
    // the sparse mode's own Overall when it has one) and take the per-axis
    // minimum with the sparse mode's own thin ratings. Cross-keymode MSD
    // rulers differ, so the transfer is an estimate; the tighter sparse
    // margin and the demonstrated-top-play cap absorb that.
    const ratings = buildTransferredRatings(mode, donor);
    if (!ratings) continue;
    byKeys.set(keyCount, { ratings, familyRatings, sparse: true });
  }
  if (byKeys.size === 0) return null;
  const dtEntries = await readDtRateMsd(db, [...chartMsd.keys()]);
  const chartMsdDt = new Map<number, number[]>();
  const chartDtOverall = new Map<number, number>();
  for (const [beatmapId, entry] of dtEntries) {
    chartMsdDt.set(beatmapId, entry.msd);
    if (entry.overall != null) chartDtOverall.set(beatmapId, entry.overall);
  }
  return { byKeys, chartMsd, chartMsdDt, chartDtOverall };
}

// Effective ratings for a sparse keymode: per axis, the minimum of its own
// thin rating and the donor keymode's transferred one. Null (no gate) only
// when there is no evidence on either side - never reject on missing data.
function buildTransferredRatings(
  own: PlayerSkillModeBreakdown | null,
  donor: PlayerSkillModeBreakdown | null,
): Record<string, number> | null {
  if (!donor) return own && Object.keys(own.ratings).length > 0 ? own.ratings : null;
  const ownOverall = Number(own?.ratings.Overall ?? 0);
  const donorOverall = Number(donor.ratings.Overall ?? 0);
  // Scale the donor's shape down to the sparse mode's own demonstrated level
  // when both Overalls exist; never scale up (that would launder the donor's
  // strength into a keymode that has not demonstrated it).
  const factor = ownOverall > 0 && donorOverall > 0 ? Math.min(1, ownOverall / donorOverall) : 1;
  const ratings: Record<string, number> = {};
  for (const skill of MSD_SKILLSETS) {
    const transferred = Number(donor.ratings[skill] ?? 0) * factor;
    const ownValue = Number(own?.ratings[skill] ?? 0);
    const value = ownValue > 0 && transferred > 0
      ? Math.min(ownValue, transferred)
      : ownValue > 0 ? ownValue : transferred;
    if (value > 0) ratings[skill] = value;
  }
  return Object.keys(ratings).length > 0 ? ratings : null;
}

// A chart is infeasible when any axis that defines it outstrips the subject's
// same-keymode evidence by more than the margin: the dominant MSD skillset,
// secondary skillsets within FEASIBILITY_SECONDARY_AXIS_WINDOW of it, or the
// chart's primary pattern family (compared against the subject's rating on
// charts of that family - what keeps an LN main's LN-earned axis ratings from
// vouching for rice charts). Missing/short MSD, a missing axis rating, or a
// family the subject has no trusted rating for never gate (never reject on
// missing data).
function isChartInfeasible(
  msd: number[] | undefined,
  pat: number[] | null,
  entry: FeasibilityModeEntry,
  margin: number,
): boolean {
  if (!msd || msd.length !== MSD_SKILLSETS.length) return false;
  let dominantIdx = 0;
  for (let i = 1; i < msd.length; i++) if (msd[i] > msd[dominantIdx]) dominantIdx = i;
  const dominant = msd[dominantIdx];
  for (let i = 0; i < msd.length; i++) {
    if (msd[i] < dominant - FEASIBILITY_SECONDARY_AXIS_WINDOW) continue;
    const rating = entry.ratings[MSD_SKILLSETS[i]];
    if (Number.isFinite(rating) && msd[i] > rating + margin) return true;
  }
  const family = primaryPatternFamily(pat);
  if (family != null) {
    const familyRating = entry.familyRatings.get(family);
    if (familyRating != null && familyRating > 0 && dominant > familyRating + margin) return true;
  }
  return false;
}

// The HT lane's rate-scaled MSD approximation (no stored 0.75x sweep).
function scaleMsdVector(msd: number[] | undefined, ratio: number): number[] | undefined {
  return msd ? msd.map((value) => value * ratio) : undefined;
}

// Generalizes the subject's active feedback marks into a bounded per-keymode
// feasibility-margin adjustment (see the FEEDBACK_MARGIN_* block for the vote
// rules). Each mark's chart is resolved on the same MSD ruler the gate uses
// for that lane (1.0x for normal, the stored 1.5x sweep for DT, the
// rate-scaled 1.0x vector for HT) and classified against the gate's current
// base-margin verdict; unresolvable charts (no MSD, no meta, no gated
// keymode) are skipped, never guessed. Returns undefined when no keymode
// reaches the vote floor.
async function computeFeedbackMarginAdjust(
  db: Db,
  marks: ActiveFarmHelperFeedbackMark[],
  breakdown: PlayerSkillBreakdown,
): Promise<Partial<Record<ConcreteFarmHelperKeyMode, number>> | undefined> {
  const beatmapIds = [...new Set(marks.map((mark) => mark.beatmapId))];
  const beatmapMeta = await readBeatmapMeta(db, beatmapIds);
  const chartData = await readChartShapeData(db, beatmapIds);
  // Same context builder as the gate itself: subject per-keymode evidence plus
  // the marked charts' 1.0x and DT MSD vectors. Null = no usable ruler at all.
  const feasibility = await buildFeasibilityContext(db, breakdown, chartData.rawMsd);
  if (!feasibility) return undefined;

  const votes = new Map<ConcreteFarmHelperKeyMode, number>();
  for (const mark of marks) {
    const meta = beatmapMeta.get(mark.beatmapId);
    if (!meta) continue;
    const keyMode = beatmapKeyMode(meta.keys);
    const margins = FEASIBILITY_MARGINS[meta.keys];
    const entry = feasibility.byKeys.get(meta.keys);
    if (!keyMode || !margins || !entry) continue;
    const marginScale = entry.sparse ? FEASIBILITY_SPARSE_MARGIN_RATIO : 1;
    const chartPat = chartData.shapes.get(mark.beatmapId)?.pat ?? null;
    let msd: number[] | undefined;
    let margin: number;
    // DT lanes without a stored 1.5x sweep (7K, unswept charts) fall back to
    // the 1.0x vector, which is only a LOWER bound on the DT difficulty: it
    // can certify "at or over the ceiling region" (so a too_easy loosen vote
    // still counts) but never "the gate would pass" (so a too_hard tighten
    // vote is skipped rather than guessed).
    let lowerBoundOnly = false;
    if (mark.speedBucket === "dt") {
      msd = feasibility.chartMsdDt.get(mark.beatmapId);
      if (!msd) {
        msd = feasibility.chartMsd.get(mark.beatmapId);
        lowerBoundOnly = true;
      }
      margin = margins.dt * marginScale;
    } else if (mark.speedBucket === "ht") {
      msd = scaleMsdVector(feasibility.chartMsd.get(mark.beatmapId), FEASIBILITY_HT_RATE_MSD_RATIO);
      margin = margins.normal * marginScale;
    } else {
      msd = feasibility.chartMsd.get(mark.beatmapId);
      margin = margins.normal * marginScale;
    }
    if (!msd || msd.length !== MSD_SKILLSETS.length) continue;
    const drops = isChartInfeasible(msd, chartPat, entry, margin);
    // "Near the ceiling": passes the gate, but only because of the margin
    // (some checked axis sits above the subject's rating itself).
    const aboveRating = drops || isChartInfeasible(msd, chartPat, entry, 0);
    let vote = 0;
    if (mark.verdict === "too_hard") {
      if (!drops && !lowerBoundOnly) vote = 1;
    } else if (drops || aboveRating) {
      vote = -1;
    }
    if (vote !== 0) votes.set(keyMode, (votes.get(keyMode) ?? 0) + vote);
  }

  const adjust: Partial<Record<ConcreteFarmHelperKeyMode, number>> = {};
  for (const [keyMode, net] of votes) {
    if (Math.abs(net) < FEEDBACK_MIN_NET_VOTES) continue;
    const magnitude = Math.min(FEEDBACK_MARGIN_MAX_ADJUST, (Math.abs(net) - 1) * FEEDBACK_MARGIN_STEP);
    // Positive net = tighten = a smaller margin, so the sign flips here.
    adjust[keyMode] = net > 0 ? -magnitude : magnitude;
  }
  return Object.keys(adjust).length > 0 ? adjust : undefined;
}

async function readBeatmapMeta(db: Db, ids: number[]): Promise<Map<number, BeatmapMeta>> {
  const result = new Map<number, BeatmapMeta>();
  // Prefer the enriched maps_beatmaps table; fall back to raw beatmaps.
  const enriched = await selectByIds(
    db,
    `select beatmap_id, beatmapset_id, cs, difficulty_rating, bpm, total_length, version, url, status
     from maps_beatmaps where beatmap_id in`,
    ids,
  );
  for (const row of enriched) {
    const meta = toBeatmapMeta(row, numberOr(row.total_length, 0));
    result.set(meta.beatmapId, meta);
  }
  const missing = ids.filter((id) => !result.has(id));
  if (missing.length > 0) {
    const raw = await selectByIds(
      db,
      `select beatmap_id, beatmapset_id, cs, difficulty_rating, bpm, version, url, status
       from beatmaps where beatmap_id in`,
      missing,
    );
    for (const row of raw) {
      const meta = toBeatmapMeta(row, 0);
      result.set(meta.beatmapId, meta);
    }
  }
  return result;
}

function toBeatmapMeta(row: Record<string, unknown>, lengthSec: number): BeatmapMeta {
  const beatmapId = Number(row.beatmap_id);
  return {
    beatmapId,
    beatmapsetId: Number(row.beatmapset_id),
    stars: numberOr(row.difficulty_rating, 0),
    keys: Math.round(numberOr(row.cs, 0)),
    bpm: numberOr(row.bpm, 0),
    lengthSec,
    version: String(row.version ?? ""),
    url: String(row.url ?? `https://osu.ppy.sh/beatmaps/${beatmapId}`),
    status: String(row.status ?? ""),
  };
}

async function readBeatmapsetMeta(db: Db, ids: number[]): Promise<Map<number, BeatmapsetMeta>> {
  const result = new Map<number, BeatmapsetMeta>();
  const enriched = await selectByIds(
    db,
    `select beatmapset_id, title, artist, creator, status, covers_json
     from maps_beatmapsets where beatmapset_id in`,
    ids,
  );
  for (const row of enriched) result.set(Number(row.beatmapset_id), toBeatmapsetMeta(row));
  const missing = ids.filter((id) => !result.has(id));
  if (missing.length > 0) {
    const raw = await selectByIds(
      db,
      `select beatmapset_id, title, artist, creator, status, covers_json
       from beatmapsets where beatmapset_id in`,
      missing,
    );
    for (const row of raw) result.set(Number(row.beatmapset_id), toBeatmapsetMeta(row));
  }
  return result;
}

function toBeatmapsetMeta(row: Record<string, unknown>): BeatmapsetMeta {
  const covers = parseJson<Record<string, string | undefined>>(row.covers_json, {});
  return {
    beatmapsetId: Number(row.beatmapset_id),
    title: String(row.title ?? ""),
    artist: String(row.artist ?? ""),
    creator: String(row.creator ?? ""),
    status: String(row.status ?? ""),
    cover: covers["cover@2x"] ?? covers.cover ?? covers["card@2x"] ?? covers.card ?? covers["slimcover@2x"] ?? covers.slimcover ?? covers["list@2x"] ?? covers.list ?? "",
    listCover: covers["list@2x"] ?? covers.list ?? covers["card@2x"] ?? covers.card ?? covers["cover@2x"] ?? covers.cover ?? "",
  };
}

async function hydrateTopPeers(db: Db, recs: FarmHelperRec[]): Promise<void> {
  const ids = [...new Set(recs.flatMap((rec) => rec.topPeers.map((p) => p.userId)))];
  if (ids.length === 0) return;
  const rows = await selectByIds(db, "select user_id, username, avatar_url from users where user_id in", ids);
  const byId = new Map(rows.map((row) => [Number(row.user_id), row]));
  for (const rec of recs) {
    rec.topPeers = rec.topPeers.map((peer) => {
      const row = byId.get(peer.userId);
      return {
        ...peer,
        username: row ? String(row.username ?? "") : "",
        avatarUrl: row ? String(row.avatar_url ?? "") : "",
      };
    });
  }
}

async function selectByIds(db: Db, sqlPrefix: string, values: number[]): Promise<Record<string, unknown>[]> {
  const ids = [...new Set(values.filter((value) => Number.isSafeInteger(value) && value > 0))];
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < ids.length; i += 900) {
    const chunk = ids.slice(i, i + 900);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "?").join(",");
    rows.push(...(await exec(db, `${sqlPrefix} (${placeholders})`, chunk)).rows);
  }
  return rows;
}

// Synthetic hidden-tail entries carry this beatmapId so no candidate map's
// estimateGain filter (positive ids) can ever remove them.
const HIDDEN_TAIL_BEATMAP_ID = -1;

// Calibrate a keymode baseline against the official variant pp. The visible
// entries are the exact top of the keymode's true list (the overall window
// truncates from below), so the hidden tail's weighted mass is simply
// variantPp minus the visible mass. The weighted-gain formula only depends on
// hidden plays through that mass, so synthetic entries reproducing it make the
// gain of any benchmark landing at or above the visible floor exact. Entries
// are packed at hiddenCapPp (the overall window cutoff, an upper bound on
// every hidden play), which places the mass as high as possible: benchmarks
// landing inside the tail sort below it, keeping their estimates conservative.
// Also conservative: the variant's bonus pp (up to ~417, not displaceable and
// not separable without the variant play count) stays folded into the tail,
// and mass that cannot fit in the 100 weighted slots is dropped since entries
// past #100 never displace anything.
function padModeBaseline(
  entries: Array<{ pp: number; beatmapId: number }>,
  variantPp: number | null | undefined,
  hiddenCapPp: number | null,
): { entries: Array<{ pp: number; beatmapId: number }>; total: number } {
  const visibleTotal = calculateWeightedPpTotal(entries);
  if (variantPp == null || !(variantPp > 0) || hiddenCapPp == null || !(hiddenCapPp > 0)) {
    return { entries, total: visibleTotal };
  }
  let remaining = variantPp - visibleTotal;
  if (remaining <= 0) return { entries, total: visibleTotal };
  const padded = [...entries];
  for (let position = padded.length; position < 100 && remaining > 1; position += 1) {
    const weight = 0.95 ** position;
    const value = Math.min(hiddenCapPp, remaining / weight);
    padded.push({ pp: value, beatmapId: HIDDEN_TAIL_BEATMAP_ID });
    remaining -= value * weight;
  }
  return { entries: padded, total: calculateWeightedPpTotal(padded) };
}

function estimateGain(
  baselineEntries: Array<{ pp: number; beatmapId: number }>,
  baselineTotal: number,
  beatmapId: number,
  benchmark: number,
): number {
  const hypothetical: Array<{ pp: number }> = baselineEntries.filter((entry) => entry.beatmapId !== beatmapId);
  hypothetical.push({ pp: benchmark });
  return Math.max(0, calculateWeightedPpTotal(hypothetical) - baselineTotal);
}

// "If you got ALL of these at their benchmarks": one simulation inserting every
// rec's benchmark at once, instead of summing per-rec gains that each pretend
// to be the only new play (those double-count massively on short baselines).
// One score per map counts, so a map recommended in two speed lanes contributes
// its best benchmark once.
function estimateCombinedGain(
  baselineEntries: Array<{ pp: number; beatmapId: number }>,
  baselineTotal: number,
  recs: Array<{ beatmapId: number; benchmarkPp: number }>,
): number {
  if (recs.length === 0) return 0;
  const benchByMap = new Map<number, number>();
  for (const rec of recs) {
    benchByMap.set(rec.beatmapId, Math.max(rec.benchmarkPp, benchByMap.get(rec.beatmapId) ?? 0));
  }
  const hypothetical: Array<{ pp: number }> = baselineEntries.filter((entry) => !benchByMap.has(entry.beatmapId));
  for (const benchmark of benchByMap.values()) hypothetical.push({ pp: benchmark });
  return Math.max(0, calculateWeightedPpTotal(hypothetical) - baselineTotal);
}

// Keep one entry per beatmap (the most-farmed speed lane) for the popular browse.
function collapsePopularLanes<T extends { beatmapId: number; peerCount: number }>(recs: T[]): T[] {
  const byBeatmap = new Map<number, T>();
  for (const rec of recs) {
    const existing = byBeatmap.get(rec.beatmapId);
    if (!existing || rec.peerCount > existing.peerCount) byBeatmap.set(rec.beatmapId, rec);
  }
  return [...byBeatmap.values()];
}

// The gain board's counterpart: one lane per beatmap, keeping the STRONGER
// lane (higher rankScore, then higher estimated gain). Expects the input
// sorted by that same order and preserves it, so the first lane seen per
// beatmap wins and later duplicates drop.
function collapseGainLanes(recs: ScoredRec[]): ScoredRec[] {
  const seen = new Set<number>();
  const collapsed: ScoredRec[] = [];
  for (const rec of recs) {
    if (seen.has(rec.beatmapId)) continue;
    seen.add(rec.beatmapId);
    collapsed.push(rec);
  }
  return collapsed;
}

function getRecommendedMods(agg: CandidateAgg): string[] {
  const best = [...agg.modCombos.values()]
    .sort((a, b) => b.count - a.count || (b.ppTotal / b.count) - (a.ppTotal / a.count))[0];
  return best?.mods ?? [];
}

function calculateSubjectKeyModeStats(
  scores: OscScore[],
  keyMode: FarmHelperKeyMode,
): { weightedPp: number; topPp: number; scoreCount: number; bestCustomAccuracy: number | null } {
  const filtered = scores.filter((score) => scoreMatchesKeyMode(score, keyMode));
  // The best 320-weighted custom accuracy demonstrated in this keymode's top
  // plays: the evidence cap for "push" target accuracies. Null when no play
  // carries judgement counts.
  let bestCustomAccuracy: number | null = null;
  for (const score of filtered) {
    const accuracy = calculateManiaCustomAccuracy(score.statistics);
    if (accuracy != null && (bestCustomAccuracy == null || accuracy > bestCustomAccuracy)) bestCustomAccuracy = accuracy;
  }
  return {
    weightedPp: calculateWeightedPpTotal(filtered),
    topPp: filtered.reduce((max, score) => Math.max(max, score.pp ?? 0), 0),
    scoreCount: filtered.length,
    bestCustomAccuracy,
  };
}

function getVariantPps(statistics: Record<string, unknown>): Partial<Record<"4k" | "7k", number>> {
  const variantPps = extractManiaVariantPps(statistics);
  const result: Partial<Record<"4k" | "7k", number>> = {};
  if (!variantPps) return result;
  if (variantPps.pp4k != null) result["4k"] = variantPps.pp4k;
  if (variantPps.pp7k != null) result["7k"] = variantPps.pp7k;
  return result;
}

function getVariantPp(variantPps: Partial<Record<"4k" | "7k", number>>, keyMode: FarmHelperKeyMode): number | null {
  if (keyMode === "any") return null;
  return variantPps[keyMode] ?? null;
}

// The benchmark ceiling for a keymode, from demonstrated evidence. A visible
// keymode top play IS the true keymode top (any play above the overall
// window's cutoff is visible), so targets cap at a growth step above it. The
// variant-pp term only stands in when the window shows no keymode play at
// all: the true top hides below the cutoff and a fraction of the official
// variant pp is the only bound available. (It used to be max()-ed in
// unconditionally, where 20% of a specialist's variant pp sat far above
// anything they ever scored and the cap never bound.)
function getModeBenchmarkCapFromEvidence(
  stats: { topPp: number },
  variantPp: number | null | undefined,
): number | null {
  if (stats.topPp > 0) return stats.topPp * MODE_TOP_PP_GROWTH_HEADROOM;
  if (variantPp && variantPp > 0) return variantPp * MODE_WEIGHTED_PP_BENCHMARK_CAP_RATIO * MODE_TOP_PP_HEADROOM;
  return null;
}

function getModeBenchmarkCap(
  stats: { topPp: number },
  variantPp: number | null | undefined,
  fallbackTopPp: number,
): number {
  const modeCap = getModeBenchmarkCapFromEvidence(stats, variantPp);
  if (modeCap != null) return modeCap;
  return fallbackTopPp > 0 ? fallbackTopPp * MODE_TOP_PP_HEADROOM : Infinity;
}

function beatmapKeyMode(keys: number): "4k" | "7k" | null {
  if (keys === 4) return "4k";
  if (keys === 7) return "7k";
  return null;
}

function scoreMatchesKeyMode(score: OscScore, keyMode: FarmHelperKeyMode): boolean {
  if (keyMode === "any") return true;
  return getScoreKeys(score) === keyModeToKeys(keyMode);
}

function getScoreKeys(score: OscScore): number {
  return Math.round(numberOr(score.beatmap?.cs, 0));
}

function keyModeToKeys(keyMode: Exclude<FarmHelperKeyMode, "any">): number {
  return keyMode === "7k" ? 7 : 4;
}

function nextPlayedMapBenchmark(subjectPp: number): number {
  return subjectPp + Math.max(PLAYED_MAP_MIN_STEP_PP, subjectPp * PLAYED_MAP_BENCHMARK_STEP);
}

function inferSubjectSpeedBucket(scores: OscScore[], beatmapId: number): ScoreSpeedBucket | undefined {
  const best = scores
    .filter((score) => Number(score.beatmap_id ?? score.beatmap?.id) === beatmapId && typeof score.pp === "number" && score.pp > 0)
    .sort((a, b) => (b.pp ?? 0) - (a.pp ?? 0))[0];
  return best ? getScoreSpeedBucket(getModAcronyms(best.mods)) : undefined;
}

export function farmHelperLaneKey(beatmapId: number, speedBucket: ScoreSpeedBucket): string {
  return `${beatmapId}:${speedBucket}`;
}

function isStale(endedAt: string | null): boolean {
  if (!endedAt) return false;
  const ms = Date.parse(endedAt);
  return Number.isFinite(ms) && Date.now() - ms > STALE_AGE_MS;
}

function quantile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = values.length > 1 ? [...values].sort((a, b) => a - b) : values;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const next = sorted[base + 1];
  return next === undefined ? sorted[base] : sorted[base] + rest * (next - sorted[base]);
}

// A validated, value-sorted weighted distribution: the reusable half of
// `weightedQuantile`. Every candidate lane asks for two or three quantiles off
// the same peer pp list, and each ask used to re-filter and re-sort it.
export interface WeightedDistribution {
  values: number[];
  // Each value's plotting position: the center of its weight segment on the
  // cumulative-weight axis.
  positions: number[];
}

export function prepareWeightedDistribution(pairs: Array<{ v: number; w: number }>): WeightedDistribution {
  const valid = pairs.filter((p) => Number.isFinite(p.v) && Number.isFinite(p.w) && p.w > 0);
  // Stable sort, same comparator, same input order as before: identical
  // ordering (and therefore identical interpolation) for tied values.
  valid.sort((a, b) => a.v - b.v);
  const values = new Array<number>(valid.length);
  const positions = new Array<number>(valid.length);
  let cum = 0;
  for (let i = 0; i < valid.length; i++) {
    const p = valid[i];
    cum += p.w;
    values[i] = p.v;
    positions[i] = cum - p.w / 2;
  }
  return { values, positions };
}

// Weighted quantile over a prepared distribution. Interpolating at the weight
// segment centers reduces exactly to the unweighted type-7 `quantile` when all
// weights are equal.
export function quantileOfDistribution(distribution: WeightedDistribution, q: number): number {
  const { values, positions } = distribution;
  if (values.length === 0) return 0;
  if (values.length === 1) return values[0];
  const first = positions[0];
  const last = positions[positions.length - 1];
  const span = last - first;
  if (span <= 0) return values[0];
  const target = first + clamp01(q) * span;
  if (target <= first) return values[0];
  if (target >= last) return values[values.length - 1];
  for (let i = 1; i < values.length; i++) {
    if (target <= positions[i]) {
      const lo = positions[i - 1];
      const t = (target - lo) / (positions[i] - lo);
      return values[i - 1] + t * (values[i] - values[i - 1]);
    }
  }
  return values[values.length - 1];
}

// Weighted quantile over (value, weight) pairs.
export function weightedQuantile(pairs: Array<{ v: number; w: number }>, q: number): number {
  return quantileOfDistribution(prepareWeightedDistribution(pairs), q);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function clampLimit(raw: number | undefined): number {
  if (raw == null || !Number.isFinite(raw)) return FARM_HELPER_DEFAULT_LIMIT;
  return Math.max(1, Math.min(FARM_HELPER_MAX_LIMIT, Math.floor(raw)));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function getCache(db: Db): Map<string, CachedFarmHelper> {
  let cache = farmHelperCache.get(db);
  if (!cache) farmHelperCache.set(db, (cache = new Map()));
  return cache;
}

function getInFlightBuilds(db: Db): Map<string, Promise<FarmHelperSnapshot>> {
  let flights = inFlightBuilds.get(db);
  if (!flights) inFlightBuilds.set(db, (flights = new Map()));
  return flights;
}

function readCacheGeneration(db: Db): number {
  let generation = cacheGenerations.get(db);
  if (!generation) cacheGenerations.set(db, (generation = { value: 0 }));
  return generation.value;
}

function bumpCacheGeneration(db: Db): void {
  const generation = cacheGenerations.get(db);
  if (generation) generation.value += 1;
  else cacheGenerations.set(db, { value: 1 });
}

// A fresh snapshot for this exact variant, refreshing its LRU position. An
// expired entry is left in place so the caller can still distinguish
// "expired" from "never built" for the timing header.
function takeFreshSnapshot(db: Db, cacheKey: string): FarmHelperSnapshot | null {
  const cache = getCache(db);
  const cached = cache.get(cacheKey);
  if (!cached || cached.expiresAt <= Date.now()) return null;
  cache.delete(cacheKey);
  cache.set(cacheKey, cached);
  return cached.snapshot;
}

// Null for anything that cannot name a player (empty, or longer than osu!
// allows): those simply skip the alias cache rather than filling it with junk.
function normalizeIdentityKey(rawKey: string): string | null {
  const normalized = rawKey.trim().toLowerCase();
  if (!normalized || normalized.length > 120) return null;
  return normalized;
}

function readIdentityAlias(db: Db, aliasKey: string): number | null {
  const aliases = identityAliasCache.get(db);
  const entry = aliases?.get(aliasKey);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    aliases?.delete(aliasKey);
    return null;
  }
  return entry.userId;
}

// Bounded by entry count AND time, so a run of failed searches can neither
// grow this map without limit nor pin a rename forever.
function writeIdentityAlias(db: Db, aliasKey: string | null, userId: number): void {
  if (!aliasKey) return;
  let aliases = identityAliasCache.get(db);
  if (!aliases) identityAliasCache.set(db, (aliases = new Map()));
  aliases.delete(aliasKey);
  aliases.set(aliasKey, { userId, expiresAt: Date.now() + IDENTITY_ALIAS_TTL_MS });
  while (aliases.size > IDENTITY_ALIAS_MAX_ENTRIES) {
    const oldest = aliases.keys().next().value;
    if (oldest === undefined) break;
    aliases.delete(oldest);
  }
}

// Evicts every cached snapshot for one subject (all keyMode/view/limit
// variants) on this Db's cache. Called by the feedback set/clear endpoints and
// the ingest auto-resolution so a mark reshapes the next snapshot immediately
// instead of after the 5-minute TTL.
export function invalidateFarmHelperCacheForUser(db: Db, userId: number): void {
  // Bumped unconditionally, even with nothing cached yet: a build already
  // running must not store a pre-mark snapshot after this returns.
  bumpCacheGeneration(db);
  const prefix = `${userId}:`;
  const cache = farmHelperCache.get(db);
  if (cache) {
    for (const key of [...cache.keys()]) {
      if (key.startsWith(prefix)) cache.delete(key);
    }
  }
  // Unregister this subject's in-flight builds so the next request starts a
  // fresh one instead of joining a build that predates the mark. The running
  // promise still settles normally for whoever already awaits it.
  const flights = inFlightBuilds.get(db);
  if (flights) {
    for (const key of [...flights.keys()]) {
      if (key.startsWith(prefix)) flights.delete(key);
    }
  }
  // Identity aliases deliberately survive: a mark changes what the snapshot
  // says, never which osu! account the key names.
}

// Wholesale clear of this Db's farm-helper caches (every cached subject
// snapshot plus the total-pp cohort pool). Used by the admin wipe-user-data
// purge, where the wiped user may sit inside OTHER subjects' cached snapshots;
// wipes are rare, so dropping everything beats tracking cross-references.
export function clearFarmHelperCache(db: Db): void {
  bumpCacheGeneration(db);
  farmHelperCache.delete(db);
  totalPpPoolCache.delete(db);
  // The wipe can remove the user rows an alias points at, so identities go
  // too. In-flight builds are unregistered rather than cancelled: they settle
  // for their existing waiters, and the generation bump stops them writing a
  // pre-wipe snapshot back into the cache.
  identityAliasCache.delete(db);
  inFlightBuilds.delete(db);
}
