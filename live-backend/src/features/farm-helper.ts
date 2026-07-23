import type { Db } from "../db.js";
import { exec, parseJson } from "../db.js";
import { getPlayerProfileSnapshot } from "./player-profiles.js";
import { calculateWeightedPpTotal, extractManiaVariantPps, getModAcronyms, getScoreSpeedBucket, nowIso, type ScoreSpeedBucket } from "../shared/score.js";
import type { OscScore } from "../shared/types.js";
import { OsuApiError, type OsuApiClient } from "../osu/client.js";
import { calibrateProxy, getKeyModePeerPool, type FarmHelperKeyCount } from "./farm-helper-key-stats.js";
import { buildWeightedUserShape, computeShapeWeights, MSD_SKILLSETS, readChartShapeData, readChartShapes, readPeerShapes, shapeSimilarity, SHAPE_MIN_CHARTS, type ChartShape, type UserShape } from "./farm-helper-shape.js";
import { enqueueMissingChartAnalyses, readDtRateMsd } from "./chart-analysis.js";
import { getPlayerSkillBreakdown } from "./player-skills.js";
import { getBaselineUserVectors, type BaselineUserVector } from "./skill-baseline.js";
import type { JobQueue } from "../jobs/queue.js";

// Farm Helper recommends maps a player should farm, ranked by estimated pp gain.
// The peer pool is GLOBAL: we compare the subject against same-pp players across
// every tracked country. The candidate pool is `country_maps_farmed_scores` (the
// proven farm-map set: rows only exist when a score entered someone's top plays),
// aggregated across all countries. The subject's own top plays come from
// `getPlayerProfileSnapshot` (osu! API, cached 24h), so this works for any
// player, tracked or not.

export type FarmHelperKeyMode = "4k" | "7k" | "any";
type ConcreteFarmHelperKeyMode = Exclude<FarmHelperKeyMode, "any">;
export type FarmHelperReason = "missing" | "improve" | "stale" | "owned";
// "gain" is the personalized, pp-gain-ranked recommendation view (the default).
// "popular" reuses the same peer cohort but skips the value/already-cleared gates
// and ranks by how many same-pp peers farm a map, so a player can browse every
// popular farm map around their fit (including ones they have already cleared).
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
  // How many recommendations qualified before truncating to `limit`, so the UI
  // can say "showing 100 of 214" instead of implying the list is complete.
  totalQualifying: number;
  recs: FarmHelperRec[];
  generatedAt: string;
}

export interface FarmHelperParams {
  keyMode?: FarmHelperKeyMode;
  view?: FarmHelperView;
  limit?: number;
}

export class FarmHelperUserNotFoundError extends Error {
  constructor(key: string) {
    super(`farm helper could not resolve user "${key}"`);
    this.name = "FarmHelperUserNotFoundError";
  }
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
// Feasibility gate (Stage 4): drop a 4K chart from the gain view when its
// dominant MSD skillset exceeds the subject's rating for it by this margin. The
// "normal" lane uses stored 1.0x MSD; the "dt" lane uses the rate-adjusted 1.5x
// MSD from the DT-rate analysis sweep (chart-analysis.ts), with a wider margin
// since 1.5x charts sit higher on the same skill axis. HT stays ungated (no
// stored 0.75x MSD yet).
// Per-keymode feasibility margins (normal / DT lanes). The gate covers every
// keymode the skill pipeline rates; 7K runs wider margins because MinaCalc's
// skillset taxonomy is 4K-born and per-axis values are noisier there, so only
// clearly-out-of-reach charts should drop. This is what keeps a high-pp LN
// main from being fed rice-speed charts their pp alone says they can farm:
// the pp is LN-earned, but the gate compares the chart's dominant skillset
// against what their plays actually demonstrated on that axis.
const FEASIBILITY_MARGINS: Record<number, { normal: number; dt: number }> = {
  4: { normal: 3.0, dt: 3.5 },
  7: { normal: 3.5, dt: 4.0 },
};
const FEASIBILITY_MIN_ANALYZED_PLAYS = 30;
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
const MODE_WEIGHTED_PP_BENCHMARK_CAP_RATIO = 0.2;
const MISSING_MAP_BENCHMARK_QUANTILE = 0.4;
const PLAYED_MAP_BENCHMARK_STEP = 0.06;
const PLAYED_MAP_MIN_STEP_PP = 30;
const MIN_VISIBLE_GAIN_PP = 1;
const FARM_HELPER_CONCRETE_KEY_MODES = ["4k", "7k"] as const satisfies readonly ConcreteFarmHelperKeyMode[];

const CACHE_TTL_MS = 5 * 60_000;
const CACHE_MAX_ENTRIES = 64;

interface CachedFarmHelper {
  snapshot: FarmHelperSnapshot;
  expiresAt: number;
}

// Per-Db cache (one Db per process in prod; tests get a fresh Db each). The
// per-subject peer-band cache is gone: the expensive fetch is the per-keyCount
// pool, cached subject-independently inside farm-helper-key-stats.
const farmHelperCache = new WeakMap<Db, Map<string, CachedFarmHelper>>();

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
}

// One farmed entry per cohort peer on a map: their farmed pp plus the kernel
// weights carried over from peer selection (wD for discovery/fraction, wB for
// the benchmark quantiles).
interface CandidatePeerEntry {
  userId: number;
  pp: number;
  wD: number;
  wB: number;
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
  // the peerFraction denominator, as a count and a discovery-weight sum.
  eligiblePeerCount: number;
  eligibleWdSum: number;
}

interface CanonicalFarmedScore {
  userId: number;
  beatmapId: number;
  pp: number;
  mods: string[];
  speedBucket: ScoreSpeedBucket;
  playedAtMs: number;
  updatedAtMs: number;
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

export async function getFarmHelperSnapshot(
  db: Db,
  osu: ProfileOsuClient,
  rawKey: string,
  params: FarmHelperParams = {},
  queue?: JobQueue,
): Promise<FarmHelperSnapshot> {
  const requestedKeyMode = params.keyMode ?? "any";
  const view = params.view ?? "gain";
  const limit = clampLimit(params.limit);

  const profile = await resolveProfile(db, osu, rawKey);
  const user = profile.user;
  const userId = Number(user.id ?? 0);
  if (!Number.isInteger(userId) || userId <= 0) throw new FarmHelperUserNotFoundError(rawKey);

  const statistics = asRecord(user.statistics);
  const subjectPp = numberOr(statistics.pp, 0);
  const subjectVariantPps = getVariantPps(statistics);
  const username = String(user.username ?? rawKey);
  const avatarUrl = String(user.avatar_url ?? "");
  const coverUrl = String(user.cover_url ?? asRecord(user.cover).url ?? "");

  const cache = getCache(db);
  // The queue flag is part of the key: snapshot content depends on it (the
  // feasibility gate only runs with a queue), and queue-less callers (Discord)
  // share this per-Db cache with the HTTP path.
  const cacheKey = `${userId}:${requestedKeyMode}:${view}:${limit}:${queue ? "q" : "nq"}`;
  const now = Date.now();
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    cache.delete(cacheKey);
    cache.set(cacheKey, cached);
    return cached.snapshot;
  }

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
    queue,
  });

  cache.set(cacheKey, { snapshot, expiresAt: now + CACHE_TTL_MS });
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return snapshot;
}

export interface FarmHelperBacktestOptions {
  asOf: number;
  keyMode?: FarmHelperKeyMode;
  view?: FarmHelperView;
  limit?: number;
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
  });
}

async function resolveProfile(db: Db, osu: ProfileOsuClient, rawKey: string) {
  try {
    return await getPlayerProfileSnapshot(db, osu, rawKey);
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
  // Internal-only "as of" cutoff (epoch ms) used exclusively by the offline
  // backtest harness to reconstruct a historical snapshot: subject best scores
  // are pre-filtered by the caller, peer farmed rows are filtered by played_at,
  // and all in-memory caches are bypassed. Never set on the HTTP path.
  asOf?: number;
  // Optional queue for the fire-and-forget self-heal that enqueues chart
  // analysis for the subject's uncovered top plays. Absent on the backtest path.
  queue?: JobQueue;
}

// Subject state prepared once per request and shared by every mode run.
interface PreparedSubject {
  rankedScores: OscScore[];
  subjectByBeatmap: Map<string, SubjectMapScore>;
  baselineEntries: Array<{ pp: number; beatmapId: number }>;
  baselineTotal: number;
  subjectTopPp: number;
  subjectModeStatsByKey: Record<ConcreteFarmHelperKeyMode, ReturnType<typeof calculateSubjectKeyModeStats>>;
}

type ScoredRec = FarmHelperRec & { difficultyFit: number; recencyFit: number };

// One concrete-keymode (or total-pp fallback) run's output before the merged
// re-rank: its scored recs (rankScore still 0, unsliced) and its cohort summary.
interface ModeRunResult {
  scored: ScoredRec[];
  band: PeerBandSummary;
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
  const subject = prepareSubject(bestScores);
  const keyMode = ctx.requestedKeyMode;

  // "any" runs the concrete 4k and 7k pipelines separately (each with its own
  // strict keymode cohort) and merges the rec lists. A concrete request runs one
  // pipeline. A subject with no keymode evidence in either mode falls back to the
  // total-pp cohort.
  const runs: ModeRunResult[] = [];
  let peerBands: Partial<Record<ConcreteFarmHelperKeyMode, PeerBandSummary>> | undefined;
  if (keyMode !== "any") {
    runs.push(await buildModeRun(db, subject, keyMode, ctx));
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
        const run = await buildModeRun(db, subject, mode, ctx);
        runs.push(run);
        bands[mode] = run.band;
      }
      peerBands = bands;
    } else {
      runs.push(await buildTotalPpRun(db, subject, ctx));
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
    totalPotentialPp: 0,
    totalQualifying: 0,
    recs: [],
    generatedAt,
    ...(peerBands ? { peerBands } : {}),
  };

  const merged = runs.flatMap((run) => run.scored);
  if (merged.length === 0) return base;

  // Popular mode can surface the same chart under two speed lanes (e.g. NoMod and
  // DT); collapse to the most-farmed lane per beatmap so the browse grid shows one
  // card per map, matching the maps page. Key counts differ across modes, so the
  // merge never collides two modes on the same beatmap.
  const ranked = isPopular ? collapsePopularLanes(merged) : merged;

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
    // peerFraction/fit/recency are already mode-local [0,1] values.
    const maxGain = Math.max(...ranked.map((r) => r.estimatedPpGain), 1);
    for (const rec of ranked) {
      // patternFit (shape match) replaces the star-proximity difficultyFit as the
      // fit term when available; difficultyFit is the fallback for shapeless charts.
      const fit = rec.patternFit ?? rec.difficultyFit;
      rec.rankScore = round2(
        0.5 * (rec.estimatedPpGain / maxGain)
        + 0.2 * rec.peerFraction
        + 0.2 * fit
        + 0.1 * rec.recencyFit,
      );
    }
    ranked.sort((a, b) => b.rankScore - a.rankScore || b.estimatedPpGain - a.estimatedPpGain);
  }

  const top: FarmHelperRec[] = ranked.slice(0, ctx.limit).map(({ difficultyFit, recencyFit, ...rec }) => {
    void difficultyFit;
    void recencyFit;
    return rec;
  });

  await hydrateTopPeers(db, top);

  return {
    ...base,
    totalPotentialPp: round2(top.reduce((sum, rec) => sum + rec.estimatedPpGain, 0)),
    totalQualifying: ranked.length,
    recs: top,
  };
}

// Everything before cohort selection: subject top plays, baseline, per-keymode
// stats. Shared by every run in a request.
function prepareSubject(bestScores: OscScore[]): PreparedSubject {
  const subjectByBeatmap = new Map<string, SubjectMapScore>();
  const baselineEntries: Array<{ pp: number; beatmapId: number }> = [];
  let subjectTopPp = 0;

  const rankedScores = [...bestScores]
    .filter((score) => typeof score.pp === "number" && score.pp > 0)
    .sort((a, b) => (b.pp ?? 0) - (a.pp ?? 0));

  rankedScores.forEach((score) => {
    const pp = score.pp as number;
    const beatmapId = score.beatmap_id ?? score.beatmap?.id ?? 0;
    if (pp > subjectTopPp) subjectTopPp = pp;
    if (beatmapId > 0) {
      baselineEntries.push({ pp, beatmapId });
      const speedBucket = getScoreSpeedBucket(getModAcronyms(score.mods));
      const subjectKey = farmHelperLaneKey(beatmapId, speedBucket);
      const existing = subjectByBeatmap.get(subjectKey);
      if (!existing || pp > existing.pp) {
        subjectByBeatmap.set(subjectKey, { pp, endedAt: score.ended_at ?? null, scoreId: score.id, speedBucket });
      }
    }
  });

  const baselineTotal = calculateWeightedPpTotal(baselineEntries);
  const subjectModeStatsByKey = {
    "4k": calculateSubjectKeyModeStats(rankedScores, "4k"),
    "7k": calculateSubjectKeyModeStats(rankedScores, "7k"),
  } satisfies Record<ConcreteFarmHelperKeyMode, ReturnType<typeof calculateSubjectKeyModeStats>>;

  return { rankedScores, subjectByBeatmap, baselineEntries, baselineTotal, subjectTopPp, subjectModeStatsByKey };
}

// One concrete-keymode pipeline: strict cohort, shape folding, farmed-map
// aggregation, the value/popularity gate, and the shared scoring loop. No
// rankScore assignment and no limit slice (the merged tail owns both).
async function buildModeRun(
  db: Db,
  subject: PreparedSubject,
  mode: ConcreteFarmHelperKeyMode,
  ctx: BuildCtx,
): Promise<ModeRunResult> {
  const isPopular = ctx.view === "popular";
  const asOf = ctx.asOf;
  const subjectModeStats = subject.subjectModeStatsByKey[mode];
  const subjectVariantPp = ctx.subjectVariantPps[mode] ?? null;
  const subjectPeerPp = subjectVariantPp ?? subjectModeStats.weightedPp;
  const subjectBenchmarkCap = getModeBenchmarkCap(subjectModeStats, subjectVariantPp, subject.subjectTopPp);
  const fit = computeFitBand(subject.rankedScores, mode);

  const { peers, mode: peerMode } = await selectPeerBand(db, ctx.userId, ctx.subjectPp, mode, subjectPeerPp, {
    strictKeyMode: true,
  });

  // Cohort self-heal: proxy-only peers that were never variant-enriched can be
  // badly mis-placed. Enqueue their enrichment strongest-weight first so the
  // players who pollute real cohorts get real variant pp ahead of the global
  // pp-ordered drip. Fire-and-forget; never on the backtest path.
  if (ctx.queue && asOf == null) enqueueVariantSelfHeal(ctx.queue, peers);

  // Chart-shape weighting: down-weight peers whose farm charts look unlike the
  // subject's, folded into wD/wB up front. Returns the subject's shape for this
  // mode (for per-candidate patternFit) or null when too few plays are analyzed.
  const subjectShape = peers.length > 0
    ? await computeShapeContext(db, peers, subject.rankedScores, mode, ctx.queue)
    : null;

  const band = buildPeerBand(peerMode, peers);
  if (peers.length === 0) return { scored: [], band };

  const peerFarmed = await aggregatePeerFarmedMaps(db, peers, asOf);
  band.farmDataCount = peerFarmed.farmDataPeerCount;
  if (peerFarmed.farmDataPeerCount === 0) return { scored: [], band };

  const candidates = gateCandidates(peerFarmed, isPopular);
  if (candidates.length === 0) return { scored: [], band };

  const scored = await scoreCandidates(db, subject, ctx, {
    candidates,
    peerSampleSize: peerFarmed.eligiblePeerCount,
    mode,
    fit,
    subjectBenchmarkCap,
    subjectShape,
  });
  return { scored, band };
}

// Fallback for subjects with no keymode evidence in either mode: the total-pp
// cohort with per-candidate caps and no shape context. Mirrors the old "any"
// view minus the deleted primary-ratio / off-key / deferred-shape gates.
async function buildTotalPpRun(db: Db, subject: PreparedSubject, ctx: BuildCtx): Promise<ModeRunResult> {
  const isPopular = ctx.view === "popular";
  const asOf = ctx.asOf;
  const anyStats = calculateSubjectKeyModeStats(subject.rankedScores, "any");
  const subjectBenchmarkCap = getModeBenchmarkCap(anyStats, null, subject.subjectTopPp);
  const fit = computeFitBand(subject.rankedScores, "any");

  const { peers } = await selectPeerBand(db, ctx.userId, ctx.subjectPp, "any", 0, { strictKeyMode: false });
  if (ctx.queue && asOf == null) enqueueVariantSelfHeal(ctx.queue, peers);

  const band = buildPeerBand("total_pp_fallback", peers);
  if (peers.length === 0) return { scored: [], band };

  const peerFarmed = await aggregatePeerFarmedMaps(db, peers, asOf);
  band.farmDataCount = peerFarmed.farmDataPeerCount;
  if (peerFarmed.farmDataPeerCount === 0) return { scored: [], band };

  const candidates = gateCandidates(peerFarmed, isPopular);
  if (candidates.length === 0) return { scored: [], band };

  const scored = await scoreCandidates(db, subject, ctx, {
    candidates,
    peerSampleSize: peerFarmed.eligiblePeerCount,
    mode: null,
    fit,
    subjectBenchmarkCap,
    subjectShape: null,
  });
  return { scored, band };
}

interface ScoreCandidatesParams {
  candidates: Array<{ agg: CandidateAgg; kernelFraction: number }>;
  peerSampleSize: number;
  // The concrete keymode this run covers, or null for the total-pp fallback
  // (any key count allowed, cap resolved per candidate).
  mode: ConcreteFarmHelperKeyMode | null;
  fit: FitBand;
  subjectBenchmarkCap: number;
  subjectShape: UserShape | null;
}

// The shared scoring loop: meta/shape/feasibility reads plus reason/benchmark/gain
// for one run's gated candidates. Emits ScoredRec with rankScore 0 (the merged
// tail assigns it) and no limit slice.
async function scoreCandidates(
  db: Db,
  subject: PreparedSubject,
  ctx: BuildCtx,
  params: ScoreCandidatesParams,
): Promise<ScoredRec[]> {
  const isPopular = ctx.view === "popular";
  const { candidates, peerSampleSize, mode, fit, subjectBenchmarkCap, subjectShape } = params;

  const beatmapIds = candidates.map((c) => c.agg.beatmapId);
  const beatmapMeta = await readBeatmapMeta(db, beatmapIds);
  const beatmapsetIds = [...new Set([...beatmapMeta.values()].map((m) => m.beatmapsetId))];
  const beatmapsetMeta = await readBeatmapsetMeta(db, beatmapsetIds);
  const hasSubjectShape = subjectShape != null;
  // One map_search_index pass serves both per-candidate patternFit (shapes) and
  // the feasibility gate (raw MSD).
  const chartData = hasSubjectShape || !isPopular ? await readChartShapeData(db, beatmapIds) : null;
  const candidateShapes = hasSubjectShape && chartData ? chartData.shapes : new Map<number, ChartShape>();
  // Feasibility gate (gain view only): the subject's per-keymode skill ratings
  // vs each chart's dominant MSD skillset. Never blocks or computes inline.
  const feasibility = isPopular || !chartData
    ? null
    : await buildFeasibilityContext(db, ctx.userId, chartData.rawMsd, ctx.queue);

  const scored: ScoredRec[] = [];
  for (const { agg, kernelFraction } of candidates) {
    const meta = beatmapMeta.get(agg.beatmapId);
    if (!meta) continue;
    if (mode != null && meta.keys !== keyModeToKeys(mode)) continue;
    if (!isPopular && fit.hasFit && (meta.stars < fit.starLo - STAR_BUFFER || meta.stars > fit.starHi + STAR_BUFFER)) continue;
    // Feasibility: a chart whose dominant MSD skillset outstrips the subject's
    // rating for it is not realistically farmable now, so drop it in the gain
    // view (popular still browses it). The normal lane uses stored 1.0x MSD; the
    // DT lane uses the rate-adjusted 1.5x MSD with a wider margin. HT and other
    // lanes fall through to the existing pp caps. Missing MSD (or a keymode the
    // subject has no trusted rating in) never gates.
    if (feasibility) {
      const ratings = feasibility.ratingsByKeys.get(meta.keys);
      const margins = FEASIBILITY_MARGINS[meta.keys];
      if (ratings && margins) {
        if (agg.speedBucket === "normal" && isChartInfeasible(feasibility.chartMsd.get(agg.beatmapId), ratings, margins.normal)) continue;
        if (agg.speedBucket === "dt" && isChartInfeasible(feasibility.chartMsdDt.get(agg.beatmapId), ratings, margins.dt)) continue;
      }
    }

    const candidateKeyMode = beatmapKeyMode(meta.keys);
    const peerFraction = kernelFraction;
    // Benchmark quantiles are weighted by the symmetric benchmark kernel (wB), so
    // an up-skewed discovery cohort cannot inflate the "if you get X" target.
    const benchPairs = agg.entries.map((e) => ({ v: e.pp, w: e.wB }));
    const median = weightedQuantile(benchPairs, 0.5);
    const p75 = weightedQuantile(benchPairs, 0.75);

    // Concrete run: the single mode cap. Fallback: cap by the candidate's own
    // keymode evidence (null -> drop in the gain view), else the overall cap.
    const rawCap = mode != null
      ? subjectBenchmarkCap
      : candidateKeyMode
        ? getModeBenchmarkCapFromEvidence(subject.subjectModeStatsByKey[candidateKeyMode], ctx.subjectVariantPps[candidateKeyMode] ?? null)
        : subjectBenchmarkCap;
    if (rawCap == null && !isPopular) continue;
    // Popular mode is a browse, not a pp ceiling check, so an unknown cap means
    // "don't cap" rather than "drop".
    const cap = rawCap ?? Number.POSITIVE_INFINITY;
    const subjectScore = subject.subjectByBeatmap.get(farmHelperLaneKey(agg.beatmapId, agg.speedBucket)) ?? null;

    let reason: FarmHelperReason;
    let benchmark: number;
    if (!subjectScore) {
      reason = "missing";
      const rawBenchmark = weightedQuantile(benchPairs, MISSING_MAP_BENCHMARK_QUANTILE);
      if (rawBenchmark > cap && !isPopular) continue;
      benchmark = Math.min(rawBenchmark, cap);
    } else if (median - subjectScore.pp > IMPROVE_MARGIN_PP) {
      reason = "improve";
      benchmark = Math.min(median, cap, nextPlayedMapBenchmark(subjectScore.pp));
    } else if (
      isStale(subjectScore.endedAt)
      && agg.latestUpdatedMs > Date.now() - STALE_ACTIVE_MS
      && Math.min(p75, cap) - subjectScore.pp > IMPROVE_MARGIN_PP
    ) {
      reason = "stale";
      benchmark = Math.min(p75, cap, nextPlayedMapBenchmark(subjectScore.pp));
    } else if (isPopular) {
      // Already cleared at a competitive score: keep it in the popular browse,
      // labelled "owned", with a near-zero gain.
      reason = "owned";
      benchmark = Math.max(subjectScore.pp, Math.min(median, cap));
    } else {
      continue;
    }

    if (!Number.isFinite(benchmark) || benchmark <= 0) continue;
    if (!isPopular && subjectScore && benchmark - subjectScore.pp <= IMPROVE_MARGIN_PP) continue;
    const estimatedPpGain = estimateGain(subject.baselineEntries, subject.baselineTotal, agg.beatmapId, benchmark);
    if (!isPopular && estimatedPpGain < MIN_VISIBLE_GAIN_PP) continue;

    const setMeta = beatmapsetMeta.get(meta.beatmapsetId);
    const difficultyFit = fit.hasFit ? clamp01(1 - Math.abs(meta.stars - fit.starMid) / fit.starSpread) : 0.5;
    const recencyFit = clamp01(1 - (Date.now() - agg.latestUpdatedMs) / STALE_ACTIVE_MS);
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
      bpm: meta.bpm,
      lengthSec: meta.lengthSec,
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
      latestPeerPlayedAt: dateMsToIso(Math.max(0, ...agg.playedAtMs)),
      peerRecencyPlayedAt: dateMsToIso(peerRecencyPlayedAtMs(agg.playedAtMs)),
      topPeers: agg.entries
        .slice()
        .sort((a, b) => b.pp - a.pp)
        .slice(0, TOP_PEERS_PER_REC)
        .map((p) => ({ userId: p.userId, username: "", avatarUrl: "", pp: round2(p.pp) })),
      scoreUrl: subjectScore ? `https://osu.ppy.sh/scores/${subjectScore.scoreId}` : null,
      mapUrl: meta.url,
      rankScore: 0,
      difficultyFit,
      recencyFit,
    });
  }

  return scored;
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
    const numeratorWd = agg.entries.reduce((sum, e) => sum + e.wD, 0);
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
  options: { strictKeyMode?: boolean } = {},
): Promise<{ peers: WeightedPeer[]; mode: string }> {
  if (keyMode !== "any") {
    if (subjectModePp > 0) {
      const keyModeResult = await selectKeyModeKnn(db, userId, keyMode, subjectModePp);
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
): Promise<{ peers: WeightedPeer[]; mode: string }> {
  const keyCount = keyModeToKeys(keyMode) as FarmHelperKeyCount;
  const { peers: pool, calibration } = await getKeyModePeerPool(db, keyCount);
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
  const rows = (await exec(db, "select user_id, pp from users where pp is not null and pp > 0")).rows;
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
      if (wD <= 0) continue;
      const wB = c.confidence * triangular(d, BENCHMARK_KERNEL_HALF_WIDTH * m, BENCHMARK_KERNEL_HALF_WIDTH * m);
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
  // included-peer COUNT, not the weighted effective sample: a full cohort of
  // down-weighted peers is a valid cohort, an (almost) empty one is not.
  // Nearest peers by mode-pp distance get a flat floor weight, and any peer the
  // widest kernel did reach keeps its kernel weight where that is stronger.
  if (mode === "knn_sparse" && weighted.length < MIN_EFFECTIVE_PEERS && candidates.length > 0) {
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
): Promise<FarmHelperFarmersResult> {
  const profile = await resolveProfile(db, osu, rawKey);
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
      `select beatmap_id, user_id, pp, mods_json, played_at, updated_at from country_maps_farmed_scores
       where beatmap_id = ? and user_id in (${placeholders})`,
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
): Promise<FarmHelperNeighborsResult> {
  const profile = await resolveProfile(db, osu, rawKey);
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

async function aggregatePeerFarmedMaps(db: Db, peers: WeightedPeer[], asOf?: number): Promise<PeerFarmedAggregation> {
  const weightById = new Map(peers.map((p) => [p.userId, { wD: p.wD, wB: p.wB }]));
  const peerIds = peers.map((p) => p.userId);
  const byPeerLane = new Map<string, CanonicalFarmedScore>();
  for (let i = 0; i < peerIds.length; i += 900) {
    const chunk = peerIds.slice(i, i + 900);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "?").join(",");
    const rows = (await exec(
      db,
      `select beatmap_id, user_id, pp, mods_json, played_at, updated_at
       from country_maps_farmed_scores
       where user_id in (${placeholders})`,
      chunk,
    )).rows;
    for (const row of rows) {
      const farmed = parseFarmedScoreRow(row);
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
    agg.entries.push({ userId: farmed.userId, pp: farmed.pp, wD: weights.wD, wB: weights.wB });
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
  return { byBeatmap, farmDataPeerCount: farmedRowsPerPeer.size, eligiblePeerCount: denominatorIds.length, eligibleWdSum };
}

function dateMsToIso(ms: number): string | null {
  return ms > 0 && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function peerRecencyPlayedAtMs(values: number[]): number {
  const sorted = values.filter((value) => value > 0 && Number.isFinite(value)).sort((a, b) => b - a);
  if (sorted.length === 0) return 0;
  return sorted.length >= 5 ? sorted[2] : sorted[0];
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
  return {
    userId,
    beatmapId,
    pp,
    mods,
    speedBucket: getScoreSpeedBucket(mods),
    playedAtMs: Number.isFinite(playedAtMs) ? playedAtMs : 0,
    updatedAtMs: Number.isFinite(updatedAtMs) ? updatedAtMs : 0,
  };
}

function keepBestFarmedScore(target: Map<string, CanonicalFarmedScore>, farmed: CanonicalFarmedScore): void {
  const key = `${farmed.userId}:${farmed.beatmapId}:${farmed.speedBucket}`;
  const existing = target.get(key);
  if (!existing || farmed.pp > existing.pp || (farmed.pp === existing.pp && farmed.updatedAtMs > existing.updatedAtMs)) {
    target.set(key, farmed);
  }
}

// Chart-shape weighting for one concrete-keymode run: down-weights peers whose
// farm charts look unlike the subject's, folding that mode's per-peer weights
// into wD/wB up front. Returns the subject's shape for this mode (used for
// per-candidate patternFit) or null when too few top plays are analyzed. Also
// self-heals: enqueues chart analysis for the subject's un-analyzed top plays so
// their shape improves on later requests. Fire-and-forget.
async function computeShapeContext(
  db: Db,
  peers: WeightedPeer[],
  rankedScores: OscScore[],
  mode: ConcreteFarmHelperKeyMode,
  queue?: JobQueue,
): Promise<UserShape | null> {
  const { shape, uncovered } = await computeSubjectShape(db, rankedScores, mode);
  if (queue && uncovered.length > 0) {
    void enqueueMissingChartAnalyses(db, queue, uncovered).catch(() => {});
  }
  if (!shape) return null;

  const userIds = peers.map((p) => p.userId);
  const peerShapes = await readPeerShapes(db, userIds, keyModeToKeys(mode));
  const weights = computeShapeWeights(shape, peerShapes, userIds);
  for (const peer of peers) {
    const wS = weights.get(peer.userId) ?? 1;
    peer.wD *= wS;
    peer.wB *= wS;
  }
  return shape;
}

async function computeSubjectShape(
  db: Db,
  rankedScores: OscScore[],
  shapeKeyMode: ConcreteFarmHelperKeyMode,
): Promise<{ shape: UserShape | null; uncovered: number[] }> {
  const entries = rankedScores
    .filter((score) => scoreMatchesKeyMode(score, shapeKeyMode))
    .slice(0, 100)
    .map((score) => ({ beatmapId: Number(score.beatmap_id ?? score.beatmap?.id ?? 0), pp: score.pp as number }))
    .filter((entry) => Number.isSafeInteger(entry.beatmapId) && entry.beatmapId > 0);
  if (entries.length < SHAPE_MIN_CHARTS) return { shape: null, uncovered: entries.map((e) => e.beatmapId) };
  const chartShapes = await readChartShapes(db, entries.map((e) => e.beatmapId));
  return buildWeightedUserShape(entries, chartShapes);
}

// patternFit: shape cosine clamped to [0,1] (pat/msd vectors are non-negative),
// or null when the shapes are not comparable.
function computePatternFit(subjectShape: UserShape, chartShape: ChartShape): number | null {
  const sim = shapeSimilarity(subjectShape, chartShape);
  return sim == null ? null : clamp01(sim);
}

interface FeasibilityContext {
  // Subject skill ratings per key count, for the keymodes with enough
  // analyzed plays to trust. A missing keymode never gates its charts.
  ratingsByKeys: Map<number, Record<string, number>>;
  chartMsd: Map<number, number[]>;
  chartMsdDt: Map<number, number[]>;
}

// Builds the feasibility context (subject per-keymode skill ratings +
// candidate raw MSD at 1.0x, the latter passed in from the shared
// map_search_index read, plus the 1.5x MSD for the DT lane). Returns null
// (gate disabled) without a queue (backtest), when no keymode has a ready
// skill rating with enough analyzed plays, or when no candidate has MSD.
// Reading the ratings enqueues a recompute if stale; it never blocks.
async function buildFeasibilityContext(
  db: Db,
  userId: number,
  chartMsd: Map<number, number[]>,
  queue?: JobQueue,
): Promise<FeasibilityContext | null> {
  if (!queue) return null;
  if (chartMsd.size === 0) return null;
  const breakdown = await getPlayerSkillBreakdown(db, queue, userId);
  if (breakdown.status !== "ready") return null;
  const ratingsByKeys = new Map<number, Record<string, number>>();
  for (const mode of breakdown.modes) {
    if (FEASIBILITY_MARGINS[mode.keyCount] && mode.analyzedPlays >= FEASIBILITY_MIN_ANALYZED_PLAYS) {
      ratingsByKeys.set(mode.keyCount, mode.ratings);
    }
  }
  if (ratingsByKeys.size === 0) return null;
  const chartMsdDt = await readDtRateMsd(db, [...chartMsd.keys()]);
  return { ratingsByKeys, chartMsd, chartMsdDt };
}

// A chart is infeasible when its dominant MSD skillset outstrips the subject's
// same-keymode rating for that skillset by more than the margin. Missing/short
// MSD never gates (never reject on missing data).
function isChartInfeasible(msd: number[] | undefined, ratings: Record<string, number>, margin: number): boolean {
  if (!msd || msd.length !== MSD_SKILLSETS.length) return false;
  let dominantIdx = 0;
  for (let i = 1; i < msd.length; i++) if (msd[i] > msd[dominantIdx]) dominantIdx = i;
  const rating = ratings[MSD_SKILLSETS[dominantIdx]];
  if (!Number.isFinite(rating)) return false;
  return msd[dominantIdx] > rating + margin;
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

// Keep one entry per beatmap (the most-farmed speed lane) for the popular browse.
function collapsePopularLanes<T extends { beatmapId: number; peerCount: number }>(recs: T[]): T[] {
  const byBeatmap = new Map<number, T>();
  for (const rec of recs) {
    const existing = byBeatmap.get(rec.beatmapId);
    if (!existing || rec.peerCount > existing.peerCount) byBeatmap.set(rec.beatmapId, rec);
  }
  return [...byBeatmap.values()];
}

function getRecommendedMods(agg: CandidateAgg): string[] {
  const best = [...agg.modCombos.values()]
    .sort((a, b) => b.count - a.count || (b.ppTotal / b.count) - (a.ppTotal / a.count))[0];
  return best?.mods ?? [];
}

function calculateSubjectKeyModeStats(scores: OscScore[], keyMode: FarmHelperKeyMode): { weightedPp: number; topPp: number; scoreCount: number } {
  const filtered = scores.filter((score) => scoreMatchesKeyMode(score, keyMode));
  return {
    weightedPp: calculateWeightedPpTotal(filtered),
    topPp: filtered.reduce((max, score) => Math.max(max, score.pp ?? 0), 0),
    scoreCount: filtered.length,
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

function getModeBenchmarkCapFromEvidence(
  stats: { topPp: number },
  variantPp: number | null | undefined,
): number | null {
  const topCap = stats.topPp > 0 ? stats.topPp * MODE_TOP_PP_HEADROOM : 0;
  const variantCap = variantPp && variantPp > 0
    ? variantPp * MODE_WEIGHTED_PP_BENCHMARK_CAP_RATIO * MODE_TOP_PP_HEADROOM
    : 0;
  const modeCap = Math.max(topCap, variantCap);
  return modeCap > 0 ? modeCap : null;
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

function farmHelperLaneKey(beatmapId: number, speedBucket: ScoreSpeedBucket): string {
  return `${beatmapId}:${speedBucket}`;
}

const MOD_DISPLAY_ORDER = [
  "NF", "EZ", "HD", "HR", "SD", "PF", "DT", "NC", "HT", "DC", "FI", "FL", "MR", "RD", "CO", "SV2",
];

function normalizeStoredMods(mods: string[]): string[] {
  return mods
    .filter((mod): mod is string => typeof mod === "string" && mod.length > 0 && mod !== "CL")
    .sort((a, b) => {
      const aIndex = MOD_DISPLAY_ORDER.indexOf(a);
      const bIndex = MOD_DISPLAY_ORDER.indexOf(b);
      if (aIndex === -1 && bIndex === -1) return a.localeCompare(b);
      if (aIndex === -1) return 1;
      if (bIndex === -1) return -1;
      return aIndex - bIndex;
    });
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

// Weighted quantile over (value, weight) pairs. Each value's plotting position is
// the center of its weight segment, normalized to [0,1]; interpolating there
// reduces exactly to the unweighted type-7 `quantile` when all weights are equal.
export function weightedQuantile(pairs: Array<{ v: number; w: number }>, q: number): number {
  const valid = pairs.filter((p) => Number.isFinite(p.v) && Number.isFinite(p.w) && p.w > 0);
  if (valid.length === 0) return 0;
  if (valid.length === 1) return valid[0].v;
  valid.sort((a, b) => a.v - b.v);

  const positions: number[] = [];
  let cum = 0;
  for (const p of valid) {
    cum += p.w;
    positions.push(cum - p.w / 2);
  }
  const first = positions[0];
  const last = positions[positions.length - 1];
  const span = last - first;
  if (span <= 0) return valid[0].v;
  const target = first + clamp01(q) * span;
  if (target <= first) return valid[0].v;
  if (target >= last) return valid[valid.length - 1].v;
  for (let i = 1; i < valid.length; i++) {
    if (target <= positions[i]) {
      const lo = positions[i - 1];
      const t = (target - lo) / (positions[i] - lo);
      return valid[i - 1].v + t * (valid[i].v - valid[i - 1].v);
    }
  }
  return valid[valid.length - 1].v;
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
