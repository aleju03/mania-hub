import type { Db } from "../db.js";
import { exec, parseJson } from "../db.js";
import { getPlayerProfileSnapshot } from "./player-profiles.js";
import { calculateWeightedPpTotal, getModAcronyms, getScoreSpeedBucket, nowIso, type ScoreSpeedBucket } from "../shared/score.js";
import type { OscScore } from "../shared/types.js";
import { OsuApiError, type OsuApiClient } from "../osu/client.js";
import { queryFarmHelperKeyPeersByDistance, queryFarmHelperKeyPeersWithinBand, type FarmHelperKeyCount } from "./farm-helper-key-stats.js";

// Farm Helper recommends maps a player should farm, ranked by estimated pp gain.
// The peer pool is GLOBAL: we compare the subject against same-pp players across
// every tracked country. The candidate pool is `country_maps_farmed_scores` (the
// proven farm-map set: rows only exist when a score entered someone's top plays),
// aggregated across all countries. The subject's own top plays come from
// `getPlayerProfileSnapshot` (osu! API, cached 24h), so this works for any
// player, tracked or not.

export type FarmHelperKeyMode = "4k" | "7k" | "any";
export type FarmHelperReason = "missing" | "improve" | "stale";

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
  peerBand: { mode: string; count: number; farmDataCount: number; minPp: number; maxPp: number };
  totalPotentialPp: number;
  recs: FarmHelperRec[];
  generatedAt: string;
}

export interface FarmHelperParams {
  keyMode?: FarmHelperKeyMode;
  limit?: number;
}

export class FarmHelperUserNotFoundError extends Error {
  constructor(key: string) {
    super(`farm helper could not resolve user "${key}"`);
    this.name = "FarmHelperUserNotFoundError";
  }
}

const DEFAULT_LIMIT = 60;
const MAX_LIMIT = 100;
const MIN_PEERS = 12;
const MIN_KEYMODE_PROXY_SCORES = 8;
const PEER_MIN_COUNT = 3;
const PEER_MIN_FRACTION = 0.12;
const IMPROVE_MARGIN_PP = 8;
const STALE_AGE_MS = 120 * 86_400_000;
const STALE_ACTIVE_MS = 180 * 86_400_000;
const FIT_SAMPLE_SIZE = 50;
const STAR_BUFFER = 0.5;
const TOP_PEERS_PER_REC = 4;
const MODE_TOP_PP_HEADROOM = 1.04;
const MISSING_MAP_BENCHMARK_QUANTILE = 0.4;
const PLAYED_MAP_BENCHMARK_STEP = 0.06;
const PLAYED_MAP_MIN_STEP_PP = 30;
const MIN_VISIBLE_GAIN_PP = 1;

const CACHE_TTL_MS = 5 * 60_000;
const CACHE_MAX_ENTRIES = 64;
const PEER_BAND_CACHE_TTL_MS = 5 * 60_000;
const PEER_BAND_CACHE_MAX_ENTRIES = 256;

interface CachedFarmHelper {
  snapshot: FarmHelperSnapshot;
  expiresAt: number;
}

interface CachedPeerBand {
  peers: Array<{ userId: number; pp: number }>;
  mode: string;
  expiresAt: number;
}

// Per-Db cache (one Db per process in prod; tests get a fresh Db each).
const farmHelperCache = new WeakMap<Db, Map<string, CachedFarmHelper>>();
const peerBandCache = new WeakMap<Db, Map<string, CachedPeerBand>>();

type ProfileOsuClient = Pick<OsuApiClient, "getUser" | "getUserByKey" | "getUserBestScoresWindow">;

interface SubjectMapScore {
  pp: number;
  endedAt: string | null;
  scoreId: number;
  speedBucket: ScoreSpeedBucket;
}

interface CandidateAgg {
  beatmapId: number;
  speedBucket: ScoreSpeedBucket;
  pps: number[];
  peers: Array<{ userId: number; pp: number }>;
  modCombos: Map<string, { mods: string[]; count: number; ppTotal: number }>;
  latestUpdatedMs: number;
}

interface PeerFarmedAggregation {
  byBeatmap: Map<string, CandidateAgg>;
  farmDataPeerCount: number;
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
}

export async function getFarmHelperSnapshot(
  db: Db,
  osu: ProfileOsuClient,
  rawKey: string,
  params: FarmHelperParams = {},
): Promise<FarmHelperSnapshot> {
  const requestedKeyMode = params.keyMode ?? "any";
  const limit = clampLimit(params.limit);

  const profile = await resolveProfile(db, osu, rawKey);
  const user = profile.user;
  const userId = Number(user.id ?? 0);
  if (!Number.isInteger(userId) || userId <= 0) throw new FarmHelperUserNotFoundError(rawKey);

  const statistics = asRecord(user.statistics);
  const subjectPp = numberOr(statistics.pp, 0);
  const username = String(user.username ?? rawKey);
  const avatarUrl = String(user.avatar_url ?? "");
  const coverUrl = String(user.cover_url ?? asRecord(user.cover).url ?? "");

  const cache = getCache(db);
  const cacheKey = `${userId}:${requestedKeyMode}:${limit}`;
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
    requestedKeyMode,
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
    requestedKeyMode: FarmHelperKeyMode;
    limit: number;
  },
): Promise<FarmHelperSnapshot> {
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
  const subjectBenchmarkCap = subjectModeStats.topPp > 0
    ? subjectModeStats.topPp * MODE_TOP_PP_HEADROOM
    : subjectTopPp > 0
      ? subjectTopPp * MODE_TOP_PP_HEADROOM
      : Infinity;

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

  // --- Peers: nearest-by-pp players across all countries, then band-filter ---
  const { peers, mode: peerMode } = await selectPeerBand(db, ctx.userId, ctx.subjectPp, keyMode, subjectModeStats.weightedPp);

  const emptyBand = {
    mode: peerMode,
    count: peers.length,
    farmDataCount: 0,
    minPp: peers.length ? Math.min(...peers.map((p) => p.pp)) : 0,
    maxPp: peers.length ? Math.max(...peers.map((p) => p.pp)) : 0,
  };
  const baseSnapshot: FarmHelperSnapshot = {
    status: "ready",
    userId: ctx.userId,
    username: ctx.username,
    avatarUrl: ctx.avatarUrl,
    coverUrl: ctx.coverUrl,
    pp: ctx.subjectPp,
    keyMode,
    peerBand: emptyBand,
    totalPotentialPp: 0,
    recs: [],
    generatedAt,
  };
  if (peers.length === 0) return baseSnapshot;

  // --- Candidate aggregation from peers' farmed maps ---
  const peerIds = peers.map((p) => p.userId);
  const peerFarmed = await aggregatePeerFarmedMaps(db, peerIds);
  const peerSampleSize = peerFarmed.farmDataPeerCount;
  const coveredSnapshot: FarmHelperSnapshot = {
    ...baseSnapshot,
    peerBand: { ...baseSnapshot.peerBand, farmDataCount: peerSampleSize },
  };
  if (peerSampleSize === 0) return coveredSnapshot;

  const candidates: CandidateAgg[] = [];
  for (const agg of peerFarmed.byBeatmap.values()) {
    if (agg.peers.length < PEER_MIN_COUNT) continue;
    if (agg.peers.length / peerSampleSize < PEER_MIN_FRACTION) continue;
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
    if (hasFit && (meta.stars < starLo - STAR_BUFFER || meta.stars > starHi + STAR_BUFFER)) continue;

    const median = quantile(agg.pps, 0.5);
    const p75 = quantile(agg.pps, 0.75);
    const cap = subjectBenchmarkCap;
    const subject = subjectByBeatmap.get(farmHelperLaneKey(agg.beatmapId, agg.speedBucket)) ?? null;

    let reason: FarmHelperReason;
    let benchmark: number;
    if (!subject) {
      reason = "missing";
      benchmark = Math.min(quantile(agg.pps, MISSING_MAP_BENCHMARK_QUANTILE), cap);
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
    } else {
      continue;
    }

    if (!Number.isFinite(benchmark) || benchmark <= 0) continue;
    if (subject && benchmark - subject.pp <= IMPROVE_MARGIN_PP) continue;
    const estimatedPpGain = estimateGain(baselineEntries, baselineTotal, agg.beatmapId, benchmark);
    if (estimatedPpGain < MIN_VISIBLE_GAIN_PP) continue;

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
      peerCount: agg.peers.length,
      peerSampleSize,
      peerFraction: round2(agg.peers.length / peerSampleSize),
      peerPpMedian: round2(median),
      peerPpP75: round2(p75),
      topPeers: agg.peers
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

  const maxGain = Math.max(...scored.map((r) => r.estimatedPpGain), 1);
  for (const rec of scored) {
    rec.rankScore = round2(
      0.5 * (rec.estimatedPpGain / maxGain)
      + 0.25 * rec.peerFraction
      + 0.15 * rec.difficultyFit
      + 0.1 * rec.recencyFit,
    );
  }

  scored.sort((a, b) => b.rankScore - a.rankScore || b.estimatedPpGain - a.estimatedPpGain);
  const top: FarmHelperRec[] = scored.slice(0, ctx.limit).map(({ difficultyFit, recencyFit, ...rec }) => {
    void difficultyFit;
    void recencyFit;
    return rec;
  });

  await hydrateTopPeers(db, top);

  return {
    ...coveredSnapshot,
    totalPotentialPp: round2(top.reduce((sum, rec) => sum + rec.estimatedPpGain, 0)),
    recs: top,
  };
}

async function queryPeersWithinPpBand(
  db: Db,
  userId: number,
  subjectPp: number,
  band: number,
): Promise<Array<{ userId: number; pp: number }>> {
  const minPp = Math.max(0, subjectPp - band);
  const maxPp = subjectPp + band;
  const rows = (await exec(
    db,
    `select user_id, pp from users
     where pp is not null and pp > 0 and user_id != ?
       and pp between ? and ?
     order by abs(pp - ?) asc`,
    [userId, minPp, maxPp, subjectPp],
  )).rows;
  return rows.map((row) => ({ userId: Number(row.user_id), pp: Number(row.pp) }));
}

async function queryPeersByPpDistance(
  db: Db,
  userId: number,
  subjectPp: number,
): Promise<Array<{ userId: number; pp: number }>> {
  const rows = (await exec(
    db,
    `select user_id, pp from users
     where pp is not null and pp > 0 and user_id != ?
     order by abs(pp - ?) asc`,
    [userId, subjectPp],
  )).rows;
  return rows.map((row) => ({ userId: Number(row.user_id), pp: Number(row.pp) }));
}

// The same-pp comparison cohort: all players in the relevant pp band across all
// countries, progressively widening the band only when the cohort is too thin.
// The full peer cohort stays server-side; HTTP responses only include counts,
// recommendation summaries, and tiny top-peer previews.
async function selectPeerBand(
  db: Db,
  userId: number,
  subjectPp: number,
  keyMode: FarmHelperKeyMode,
  subjectModePp: number,
): Promise<{ peers: Array<{ userId: number; pp: number }>; mode: string }> {
  const cache = getPeerBandCache(db);
  const cacheKey = `${userId}:${roundCacheNumber(subjectPp)}:${keyMode}:${roundCacheNumber(subjectModePp)}`;
  const now = Date.now();
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    cache.delete(cacheKey);
    cache.set(cacheKey, cached);
    return { peers: cached.peers.slice(), mode: cached.mode };
  }

  const selected = await computePeerBand(db, userId, subjectPp, keyMode, subjectModePp);
  cache.set(cacheKey, { peers: selected.peers.slice(), mode: selected.mode, expiresAt: now + PEER_BAND_CACHE_TTL_MS });
  while (cache.size > PEER_BAND_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return selected;
}

async function computePeerBand(
  db: Db,
  userId: number,
  subjectPp: number,
  keyMode: FarmHelperKeyMode,
  subjectModePp: number,
): Promise<{ peers: Array<{ userId: number; pp: number }>; mode: string }> {
  if (keyMode !== "any" && subjectModePp > 0) {
    const keyModePeers = await selectKeyModePeerBand(db, userId, subjectPp, keyMode, subjectModePp);
    if (keyModePeers) return keyModePeers;
  }

  const band = Math.max(400, subjectPp * 0.08);
  let peers = await queryPeersWithinPpBand(db, userId, subjectPp, band);
  let mode = "pp_band";
  if (peers.length < MIN_PEERS) {
    peers = await queryPeersWithinPpBand(db, userId, subjectPp, band * 2);
    mode = "pp_band_wide";
  }
  if (peers.length < MIN_PEERS) {
    peers = await queryPeersByPpDistance(db, userId, subjectPp);
    mode = "nearest";
  }
  return { peers, mode };
}

async function selectKeyModePeerBand(
  db: Db,
  userId: number,
  _subjectPp: number,
  keyMode: Exclude<FarmHelperKeyMode, "any">,
  subjectModePp: number,
): Promise<{ peers: Array<{ userId: number; pp: number }>; mode: string } | null> {
  const keyCount = keyModeToKeys(keyMode) as FarmHelperKeyCount;
  const band = Math.max(300, subjectModePp * 0.08);
  let peers = await queryFarmHelperKeyPeersWithinBand(db, keyCount, userId, subjectModePp, band, MIN_KEYMODE_PROXY_SCORES);
  let mode = `${keyMode}_pp_proxy`;
  if (peers.length < MIN_PEERS) {
    peers = await queryFarmHelperKeyPeersWithinBand(db, keyCount, userId, subjectModePp, band * 2, MIN_KEYMODE_PROXY_SCORES);
    mode = `${keyMode}_pp_proxy_wide`;
  }
  if (peers.length < MIN_PEERS) {
    peers = await queryFarmHelperKeyPeersByDistance(db, keyCount, userId, subjectModePp, MIN_KEYMODE_PROXY_SCORES);
    mode = `${keyMode}_nearest`;
  }
  if (peers.length < MIN_PEERS) return null;
  return { peers: peers.map(({ userId, pp }) => ({ userId, pp })), mode };
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
): Promise<FarmHelperFarmersResult> {
  const profile = await resolveProfile(db, osu, rawKey);
  const user = profile.user;
  const userId = Number(user.id ?? 0);
  if (!Number.isInteger(userId) || userId <= 0) throw new FarmHelperUserNotFoundError(rawKey);
  if (!Number.isInteger(beatmapId) || beatmapId <= 0) return { beatmapId, total: 0, farmers: [] };

  const subjectPp = numberOr(asRecord(user.statistics).pp, 0);
  const beatmap = (await readBeatmapMeta(db, [beatmapId])).get(beatmapId);
  const keyMode: FarmHelperKeyMode = beatmap?.keys === 7 ? "7k" : beatmap?.keys === 4 ? "4k" : "any";
  const lane = speedBucket ?? inferSubjectSpeedBucket(profile.bestScores, beatmapId);
  const rankedScores = [...profile.bestScores]
    .filter((score) => typeof score.pp === "number" && score.pp > 0)
    .sort((a, b) => (b.pp ?? 0) - (a.pp ?? 0));
  const subjectModeStats = calculateSubjectKeyModeStats(rankedScores, keyMode);
  const { peers } = await selectPeerBand(db, userId, subjectPp, keyMode, subjectModeStats.weightedPp);
  if (peers.length === 0) return { beatmapId, total: 0, farmers: [] };

  const peerIds = peers.map((p) => p.userId);
  const farmersRaw: Array<{ userId: number; pp: number; mods: string[] }> = [];
  for (let i = 0; i < peerIds.length; i += 900) {
    const chunk = peerIds.slice(i, i + 900);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "?").join(",");
    const rows = (await exec(
      db,
      `select user_id, pp, mods_json from country_maps_farmed_scores
       where beatmap_id = ? and user_id in (${placeholders})`,
      [beatmapId, ...chunk],
    )).rows;
    for (const row of rows) {
      const mods = parseJson<string[]>(row.mods_json, []);
      if (lane && getScoreSpeedBucket(mods) !== lane) continue;
      const pp = Number(row.pp);
      if (!Number.isFinite(pp) || pp <= 0) continue;
      farmersRaw.push({ userId: Number(row.user_id), pp, mods });
    }
  }

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

async function aggregatePeerFarmedMaps(db: Db, peerIds: number[]): Promise<PeerFarmedAggregation> {
  const byBeatmap = new Map<string, CandidateAgg>();
  const farmDataPeerIds = new Set<number>();
  for (let i = 0; i < peerIds.length; i += 900) {
    const chunk = peerIds.slice(i, i + 900);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "?").join(",");
    const rows = (await exec(
      db,
      `select beatmap_id, user_id, pp, mods_json, updated_at
       from country_maps_farmed_scores
       where user_id in (${placeholders})`,
      chunk,
    )).rows;
    for (const row of rows) {
      const userId = Number(row.user_id);
      const beatmapId = Number(row.beatmap_id);
      const pp = Number(row.pp);
      if (!Number.isSafeInteger(userId) || userId <= 0) continue;
      if (!Number.isFinite(pp) || pp <= 0) continue;
      farmDataPeerIds.add(userId);
      const mods = normalizeStoredMods(parseJson<string[]>(row.mods_json, []));
      const speedBucket = getScoreSpeedBucket(mods);
      const key = farmHelperLaneKey(beatmapId, speedBucket);
      let agg = byBeatmap.get(key);
      if (!agg) {
        agg = { beatmapId, speedBucket, pps: [], peers: [], modCombos: new Map(), latestUpdatedMs: 0 };
        byBeatmap.set(key, agg);
      }
      agg.pps.push(pp);
      agg.peers.push({ userId, pp });
      const modKey = mods.join(",");
      const modCombo = agg.modCombos.get(modKey) ?? { mods, count: 0, ppTotal: 0 };
      modCombo.count += 1;
      modCombo.ppTotal += pp;
      agg.modCombos.set(modKey, modCombo);
      const updatedMs = row.updated_at == null ? 0 : Date.parse(String(row.updated_at));
      if (Number.isFinite(updatedMs) && updatedMs > agg.latestUpdatedMs) agg.latestUpdatedMs = updatedMs;
    }
  }
  return { byBeatmap, farmDataPeerCount: farmDataPeerIds.size };
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
    cover: covers["list@2x"] ?? covers.list ?? covers["cover@2x"] ?? covers.cover ?? covers.card ?? "",
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

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function clampLimit(raw: number | undefined): number {
  if (raw == null || !Number.isFinite(raw)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(raw)));
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

function getPeerBandCache(db: Db): Map<string, CachedPeerBand> {
  let cache = peerBandCache.get(db);
  if (!cache) peerBandCache.set(db, (cache = new Map()));
  return cache;
}

function roundCacheNumber(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;
}
