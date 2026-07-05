import type { Db } from "../db.js";
import { exec, parseJson } from "../db.js";
import { getPlayerProfileSnapshot } from "./player-profiles.js";
import { calculateWeightedPpTotal, extractManiaVariantPps, getModAcronyms, getScoreSpeedBucket, nowIso, type ScoreSpeedBucket } from "../shared/score.js";
import type { OscScore } from "../shared/types.js";
import { OsuApiError, type OsuApiClient } from "../osu/client.js";
import { calibrateProxy, getKeyModePeerPool, type FarmHelperKeyCount } from "./farm-helper-key-stats.js";

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
  peerPpMedian: number;
  peerPpP75: number;
  latestPeerPlayedAt: string | null;
  peerRecencyPlayedAt: string | null;
  topPeers: FarmHelperPeer[];
  scoreUrl: string | null;
  mapUrl: string;
  rankScore: number;
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
  peerBand: { mode: string; count: number; farmDataCount: number; minPp: number; maxPp: number; effectiveCount: number };
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
// Effective sample = sum of discovery weights. Below this, widen both kernels.
const MIN_EFFECTIVE_PEERS = 12;
const KNN_MAX_PEERS = 400;
const KNN_WIDEN_MODES = ["knn", "knn_wide", "knn_wider", "knn_widest"] as const;
const PEER_MIN_COUNT = 3;
const PEER_MIN_FRACTION = 0.12;
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
const ANY_PRIMARY_MODE_RATIO = 0.85;
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

// A cohort peer with both kernel weights. modePp is the effective mode pp used
// for distance (real variant pp, calibrated proxy, or total pp for "any"); pp is
// the display-only total pp.
interface WeightedPeer {
  userId: number;
  pp: number;
  modePp: number;
  wD: number;
  wB: number;
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
  farmDataPeerCount: number;
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
  const subjectVariantPp = getVariantPp(subjectVariantPps, requestedKeyMode);
  const username = String(user.username ?? rawKey);
  const avatarUrl = String(user.avatar_url ?? "");
  const coverUrl = String(user.cover_url ?? asRecord(user.cover).url ?? "");

  const cache = getCache(db);
  const cacheKey = `${userId}:${requestedKeyMode}:${view}:${limit}`;
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
    subjectVariantPp,
    subjectVariantPps,
    requestedKeyMode,
    view,
    limit,
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
  const subjectVariantPp = getVariantPp(subjectVariantPps, requestedKeyMode);
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
    subjectVariantPp,
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

async function buildSnapshot(
  db: Db,
  bestScores: OscScore[],
  ctx: {
    userId: number;
    username: string;
    avatarUrl: string;
    coverUrl: string;
    subjectPp: number;
    subjectVariantPp: number | null;
    subjectVariantPps: Partial<Record<"4k" | "7k", number>>;
    requestedKeyMode: FarmHelperKeyMode;
    view: FarmHelperView;
    limit: number;
    // Internal-only "as of" cutoff (epoch ms) used exclusively by the offline
    // backtest harness to reconstruct a historical snapshot: subject best scores
    // are pre-filtered by the caller, peer farmed rows are filtered by played_at,
    // and all in-memory caches are bypassed. Never set on the HTTP path.
    asOf?: number;
  },
): Promise<FarmHelperSnapshot> {
  const isPopular = ctx.view === "popular";
  const asOf = ctx.asOf;
  const generatedAt = nowIso();
  // Per-beatmap best pp the subject already has in their top plays, and the flat
  // pp list used as the baseline for net-weighted-pp gain estimation.
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
  const keyMode = ctx.requestedKeyMode;
  const subjectModeStats = calculateSubjectKeyModeStats(rankedScores, keyMode);
  const subjectPeerPp = ctx.subjectVariantPp ?? subjectModeStats.weightedPp;
  const subjectBenchmarkCap = getModeBenchmarkCap(subjectModeStats, ctx.subjectVariantPp, subjectTopPp);
  const subjectModeStatsByKey = {
    "4k": keyMode === "4k" ? subjectModeStats : calculateSubjectKeyModeStats(rankedScores, "4k"),
    "7k": keyMode === "7k" ? subjectModeStats : calculateSubjectKeyModeStats(rankedScores, "7k"),
  } satisfies Record<ConcreteFarmHelperKeyMode, ReturnType<typeof calculateSubjectKeyModeStats>>;
  const anyPrimaryKeyModes = keyMode === "any"
    ? getAnyPrimaryKeyModes(subjectModeStatsByKey, ctx.subjectVariantPps)
    : new Set<ConcreteFarmHelperKeyMode>();
  const anyOffKeySupport = keyMode === "any"
    ? await collectAnyOffKeyCandidateSupport(db, ctx, subjectModeStatsByKey, anyPrimaryKeyModes, asOf)
    : null;

  const fitStars = rankedScores
    .filter((score) => scoreMatchesKeyMode(score, keyMode))
    .slice(0, FIT_SAMPLE_SIZE)
    .map((score) => numberOr(score.beatmap?.difficulty_rating, 0))
    .filter((stars) => stars > 0);
  fitStars.sort((a, b) => a - b);
  const hasFit = fitStars.length >= 5;
  const starLo = hasFit ? quantile(fitStars, 0.1) : 0;
  const starHi = hasFit ? quantile(fitStars, 0.95) : Infinity;
  const starMid = hasFit ? quantile(fitStars, 0.5) : 0;
  const starSpread = hasFit ? Math.max(1.5, starHi - starLo) : 1.5;

  // --- Peers: kernel-weighted kNN cohort across all countries ---
  const { peers, mode: peerMode } = await selectPeerBand(db, ctx.userId, ctx.subjectPp, keyMode, subjectPeerPp, {
    strictKeyMode: keyMode !== "any",
  });

  const emptyBand = {
    mode: peerMode,
    count: peers.length,
    farmDataCount: 0,
    minPp: peers.length ? Math.min(...peers.map((p) => p.pp)) : 0,
    maxPp: peers.length ? Math.max(...peers.map((p) => p.pp)) : 0,
    effectiveCount: Math.round(peers.reduce((sum, p) => sum + p.wD, 0)),
  };
  const baseSnapshot: FarmHelperSnapshot = {
    status: "ready",
    userId: ctx.userId,
    username: ctx.username,
    avatarUrl: ctx.avatarUrl,
    coverUrl: ctx.coverUrl,
    pp: ctx.subjectPp,
    keyMode,
    view: ctx.view,
    peerBand: emptyBand,
    totalPotentialPp: 0,
    totalQualifying: 0,
    recs: [],
    generatedAt,
  };
  if (peers.length === 0) return baseSnapshot;

  // --- Candidate aggregation from peers' farmed maps ---
  const peerFarmed = await aggregatePeerFarmedMaps(db, peers, asOf);
  const peerSampleSize = peerFarmed.farmDataPeerCount;
  const coveredSnapshot: FarmHelperSnapshot = {
    ...baseSnapshot,
    peerBand: { ...baseSnapshot.peerBand, farmDataCount: peerSampleSize },
  };
  if (peerSampleSize === 0) return coveredSnapshot;

  const minPeerFraction = isPopular ? POPULAR_PEER_MIN_FRACTION : PEER_MIN_FRACTION;
  const candidates: CandidateAgg[] = [];
  for (const agg of peerFarmed.byBeatmap.values()) {
    if (agg.entries.length < PEER_MIN_COUNT) continue;
    if (agg.entries.length / peerSampleSize < minPeerFraction) continue;
    candidates.push(agg);
  }
  if (candidates.length === 0) return coveredSnapshot;

  const beatmapIds = candidates.map((c) => c.beatmapId);
  const beatmapMeta = await readBeatmapMeta(db, beatmapIds);
  const beatmapsetIds = [...new Set([...beatmapMeta.values()].map((m) => m.beatmapsetId))];
  const beatmapsetMeta = await readBeatmapsetMeta(db, beatmapsetIds);

  type ScoredRec = FarmHelperRec & { difficultyFit: number; recencyFit: number };
  const scored: ScoredRec[] = [];
  for (const agg of candidates) {
    const meta = beatmapMeta.get(agg.beatmapId);
    if (!meta) continue;
    if (keyMode !== "any" && meta.keys !== (keyMode === "7k" ? 7 : 4)) continue;
    if (!isPopular && hasFit && (meta.stars < starLo - STAR_BUFFER || meta.stars > starHi + STAR_BUFFER)) continue;

    // Benchmark quantiles are weighted by the symmetric benchmark kernel (wB) so
    // an up-skewed discovery cohort cannot inflate the "if you get X" target.
    const benchPairs = agg.entries.map((e) => ({ v: e.pp, w: e.wB }));
    const median = weightedQuantile(benchPairs, 0.5);
    const p75 = weightedQuantile(benchPairs, 0.75);
    const candidateKeyMode = beatmapKeyMode(meta.keys);
    const candidateLaneKey = farmHelperLaneKey(agg.beatmapId, agg.speedBucket);
    if (
      keyMode === "any"
      && candidateKeyMode
      && !anyPrimaryKeyModes.has(candidateKeyMode)
      && !anyOffKeySupport?.get(candidateKeyMode)?.has(candidateLaneKey)
    ) {
      continue;
    }
    const rawCap = keyMode === "any" && candidateKeyMode
      ? getModeBenchmarkCapFromEvidence(
          subjectModeStatsByKey[candidateKeyMode],
          ctx.subjectVariantPps[candidateKeyMode] ?? null,
        )
      : subjectBenchmarkCap;
    if (rawCap == null && !isPopular) continue;
    // Popular mode is a browse, not a pp ceiling check, so an unknown cap means
    // "don't cap" rather than "drop".
    const cap = rawCap ?? Number.POSITIVE_INFINITY;
    const subject = subjectByBeatmap.get(farmHelperLaneKey(agg.beatmapId, agg.speedBucket)) ?? null;

    let reason: FarmHelperReason;
    let benchmark: number;
    if (!subject) {
      reason = "missing";
      const rawBenchmark = weightedQuantile(benchPairs, MISSING_MAP_BENCHMARK_QUANTILE);
      if (rawBenchmark > cap && !isPopular) continue;
      benchmark = Math.min(rawBenchmark, cap);
    } else if (median - subject.pp > IMPROVE_MARGIN_PP) {
      reason = "improve";
      benchmark = Math.min(median, cap, nextPlayedMapBenchmark(subject.pp));
    } else if (
      isStale(subject.endedAt)
      && agg.latestUpdatedMs > Date.now() - STALE_ACTIVE_MS
      && Math.min(p75, cap) - subject.pp > IMPROVE_MARGIN_PP
    ) {
      reason = "stale";
      benchmark = Math.min(p75, cap, nextPlayedMapBenchmark(subject.pp));
    } else if (isPopular) {
      // Already cleared at a competitive score: keep it in the popular browse,
      // labelled "owned", with a near-zero gain.
      reason = "owned";
      benchmark = Math.max(subject.pp, Math.min(median, cap));
    } else {
      continue;
    }

    if (!Number.isFinite(benchmark) || benchmark <= 0) continue;
    if (!isPopular && subject && benchmark - subject.pp <= IMPROVE_MARGIN_PP) continue;
    const estimatedPpGain = estimateGain(baselineEntries, baselineTotal, agg.beatmapId, benchmark);
    if (!isPopular && estimatedPpGain < MIN_VISIBLE_GAIN_PP) continue;

    const setMeta = beatmapsetMeta.get(meta.beatmapsetId);
    const difficultyFit = hasFit ? clamp01(1 - Math.abs(meta.stars - starMid) / starSpread) : 0.5;
    const recencyFit = clamp01(1 - (Date.now() - agg.latestUpdatedMs) / STALE_ACTIVE_MS);

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
      subjectPp: subject ? round2(subject.pp) : null,
      subjectPlayedAt: subject?.endedAt ?? null,
      peerCount: agg.entries.length,
      peerSampleSize,
      peerFraction: round2(agg.entries.length / peerSampleSize),
      peerPpMedian: round2(median),
      peerPpP75: round2(p75),
      latestPeerPlayedAt: dateMsToIso(Math.max(0, ...agg.playedAtMs)),
      peerRecencyPlayedAt: dateMsToIso(peerRecencyPlayedAtMs(agg.playedAtMs)),
      topPeers: agg.entries
        .slice()
        .sort((a, b) => b.pp - a.pp)
        .slice(0, TOP_PEERS_PER_REC)
        .map((p) => ({ userId: p.userId, username: "", avatarUrl: "", pp: round2(p.pp) })),
      scoreUrl: subject ? `https://osu.ppy.sh/scores/${subject.scoreId}` : null,
      mapUrl: meta.url,
      rankScore: 0,
      difficultyFit,
      recencyFit,
    });
  }

  if (scored.length === 0) return coveredSnapshot;

  // Popular mode can surface the same chart under two speed lanes (e.g. NoMod and
  // DT); collapse to the most-farmed lane per beatmap so the browse grid shows one
  // card per map, matching the maps page.
  const ranked = isPopular ? collapsePopularLanes(scored) : scored;

  if (isPopular) {
    for (const rec of ranked) rec.rankScore = round2(rec.peerFraction);
    ranked.sort((a, b) =>
      b.peerFraction - a.peerFraction
      || b.peerCount - a.peerCount
      || b.estimatedPpGain - a.estimatedPpGain
      || b.stars - a.stars,
    );
  } else {
    const maxGain = Math.max(...ranked.map((r) => r.estimatedPpGain), 1);
    for (const rec of ranked) {
      rec.rankScore = round2(
        0.5 * (rec.estimatedPpGain / maxGain)
        + 0.25 * rec.peerFraction
        + 0.15 * rec.difficultyFit
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
    ...coveredSnapshot,
    totalPotentialPp: round2(top.reduce((sum, rec) => sum + rec.estimatedPpGain, 0)),
    totalQualifying: ranked.length,
    recs: top,
  };
}

interface CohortCandidate {
  userId: number;
  pp: number;
  modePp: number;
  confidence: number;
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
  const candidates: CohortCandidate[] = [];
  for (const peer of pool) {
    if (peer.userId === userId) continue;
    const hasVariant = peer.variantPp != null && peer.variantPp > 0;
    // Real variant pp when present, else the proxy calibrated onto the variant
    // scale so proxy peers sit at the right distance from a variant subject.
    const modePp = hasVariant ? (peer.variantPp as number) : calibrateProxy(calibration, peer.weightedPp);
    if (!Number.isFinite(modePp) || modePp <= 0) continue;
    candidates.push({ userId: peer.userId, pp: peer.pp, modePp, confidence: hasVariant ? 1 : PROXY_CONFIDENCE });
  }
  return kernelSelect(candidates, subjectModePp);
}

async function selectTotalPpKnn(
  db: Db,
  userId: number,
  subjectPp: number,
): Promise<{ peers: WeightedPeer[]; mode: string }> {
  // Fetch a generous absolute window (covers the widest kernel widening, with a
  // floor for low-pp subjects) and let the kernel do the relative weighting in
  // JS. Total pp is a real measurement: no calibration, full confidence.
  const downFetch = Math.max(subjectPp * 0.35, 800);
  const upFetch = Math.max(subjectPp * 0.6, 800);
  const rows = (await exec(
    db,
    `select user_id, pp from users
     where pp is not null and pp > 0 and user_id != ?
       and pp between ? and ?`,
    [userId, Math.max(0, subjectPp - downFetch), subjectPp + upFetch],
  )).rows;
  const candidates: CohortCandidate[] = [];
  for (const row of rows) {
    const id = Number(row.user_id);
    const pp = Number(row.pp);
    if (!Number.isSafeInteger(id) || id <= 0 || !Number.isFinite(pp) || pp <= 0) continue;
    candidates.push({ userId: id, pp, modePp: pp, confidence: 1 });
  }
  return kernelSelect(candidates, subjectPp);
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
      weighted.push({ userId: c.userId, pp: c.pp, modePp: c.modePp, wD, wB });
      effN += wD;
    }
    if (effN >= MIN_EFFECTIVE_PEERS) {
      mode = KNN_WIDEN_MODES[i];
      break;
    }
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
  const farmDataPeerIds = new Set<number>();
  for (const farmed of byPeerLane.values()) {
    const weights = weightById.get(farmed.userId);
    if (!weights) continue;
    farmDataPeerIds.add(farmed.userId);
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
  return { byBeatmap, farmDataPeerCount: farmDataPeerIds.size };
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

async function collectAnyOffKeyCandidateSupport(
  db: Db,
  ctx: {
    userId: number;
    subjectPp: number;
    subjectVariantPps: Partial<Record<ConcreteFarmHelperKeyMode, number>>;
  },
  subjectModeStatsByKey: Record<ConcreteFarmHelperKeyMode, { weightedPp: number; topPp: number; scoreCount: number }>,
  primaryModes: Set<ConcreteFarmHelperKeyMode>,
  asOf?: number,
): Promise<Map<ConcreteFarmHelperKeyMode, Set<string>>> {
  const support = new Map<ConcreteFarmHelperKeyMode, Set<string>>();
  for (const mode of FARM_HELPER_CONCRETE_KEY_MODES) {
    if (primaryModes.has(mode)) continue;
    const subjectModePp = ctx.subjectVariantPps[mode] ?? subjectModeStatsByKey[mode].weightedPp;
    if (!Number.isFinite(subjectModePp) || subjectModePp <= 0) continue;

    const { peers } = await selectPeerBand(db, ctx.userId, ctx.subjectPp, mode, subjectModePp, { strictKeyMode: true });
    if (peers.length === 0) continue;

    const peerFarmed = await aggregatePeerFarmedMaps(db, peers, asOf);
    const peerSampleSize = peerFarmed.farmDataPeerCount;
    if (peerSampleSize === 0) continue;

    const candidates = [...peerFarmed.byBeatmap.values()].filter((agg) => (
      agg.entries.length >= PEER_MIN_COUNT
      && agg.entries.length / peerSampleSize >= PEER_MIN_FRACTION
    ));
    if (candidates.length === 0) continue;

    const beatmapMeta = await readBeatmapMeta(db, candidates.map((agg) => agg.beatmapId));
    const modeKeys = keyModeToKeys(mode);
    const supported = new Set<string>();
    for (const agg of candidates) {
      const meta = beatmapMeta.get(agg.beatmapId);
      if (!meta || meta.keys !== modeKeys) continue;
      supported.add(farmHelperLaneKey(agg.beatmapId, agg.speedBucket));
    }
    if (supported.size > 0) support.set(mode, supported);
  }
  return support;
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

function getAnyPrimaryKeyModes(
  statsByKey: Record<ConcreteFarmHelperKeyMode, { weightedPp: number }>,
  variantPps: Partial<Record<ConcreteFarmHelperKeyMode, number>>,
): Set<ConcreteFarmHelperKeyMode> {
  const modePps = FARM_HELPER_CONCRETE_KEY_MODES.map((mode) => ({
    mode,
    pp: variantPps[mode] ?? statsByKey[mode].weightedPp,
  })).filter(({ pp }) => Number.isFinite(pp) && pp > 0);
  const maxPp = modePps.reduce((max, entry) => Math.max(max, entry.pp), 0);
  if (maxPp <= 0) return new Set();
  return new Set(modePps.filter((entry) => entry.pp >= maxPp * ANY_PRIMARY_MODE_RATIO).map((entry) => entry.mode));
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
