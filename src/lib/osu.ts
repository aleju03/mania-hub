import { createServerFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import { sanitizeProfilePageHtml } from "./profile-page";

function edgeCache(sMaxage: number, swr?: number): void {
  const effectiveSwr = swr ?? sMaxage * 4;
  setResponseHeader(
    "Cache-Control",
    `public, s-maxage=${sMaxage}, stale-while-revalidate=${effectiveSwr}`,
  );
}

function noStore(): void {
  setResponseHeader("Cache-Control", "no-store");
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
import {
  osuFetch,
  osuFetchBinary,
  fetchBeatmapFile,
  fetchWithCacheLock,
  fetchWithStaleAllowed,
  runCacheRebuild,
  deleteExpiredCacheEntriesByPrefix,
  deletePersistentCacheEntries,
  getPersistentCacheEntry,
  getPersistentCacheEntryAllowStale,
  getPersistentCached,
  setPersistentCache,
} from "./api";
import { db, ensureCacheSchema, hasDb } from "./db";
import { calculateApproxPpGainMap, calculateReplacementPpGain, getBoardLaneKey, getModAcronyms, getModDisplayList, getScoreDisplayValues, getScoreRate, getScoreTimestamp, getScoreUrl } from "./score";
import { detectManiaPatterns } from "./mania-patterns";
import type {
  OsuUser,
  OsuScore,
  OsuBeatmapset,
  OsuGradeCounts,
  RankingsResponse,
  LeanRankingEntry,
  LeanHomeScore,
  LeanHomePopoff,
  BeatmapsetSearchResponse,
  BeatmapScoresResponse,
  UserSearchResponse,
  BeatmapPlaycount,
  CountryMapsData,
  MapsAggregatedBeatmap,
  MapsAggregatedFavourite,
  MapsFarmedEntry,
  MapsFavouriteBeatmapset,
  MapsPlayerFavourites,
  HomePageData,
  UserProfileInsights,
  InsightScoreSnapshot,
  SnipeEvent,
  CountryBoardSnapshot,
  CountryBoardSnapshotEntry,
  CountryBoardScore,
  SnipesResponse,
  SnipesScanStatus,
} from "./types";
import { normalizeCountryCode } from "./country";

// Raw shape returned by the osu! API's /rankings endpoint. We never expose
// this off of the server — `getRankings` trims each user down to
// `LeanRankingEntry` before responding or caching.
interface RawRankingsResponse {
  cursor: { page: number } | null;
  ranking: Array<{
    user: OsuUser;
    hit_accuracy: number;
    play_count: number;
    pp: number;
    global_rank: number;
    ranked_score: number;
    grade_counts: OsuGradeCounts;
  }>;
  total: number;
}

function toLeanRankingEntry(raw: RawRankingsResponse["ranking"][number]): LeanRankingEntry {
  return {
    user: {
      id: raw.user.id,
      username: raw.user.username,
      avatar_url: raw.user.avatar_url,
      country_code: raw.user.country_code,
      is_online: raw.user.is_online,
      is_active: raw.user.is_active,
    },
    hit_accuracy: raw.hit_accuracy,
    play_count: raw.play_count,
    pp: raw.pp,
    global_rank: raw.global_rank,
    ranked_score: raw.ranked_score,
    grade_counts: raw.grade_counts,
  };
}

function toLeanHomeScore(
  score: OsuScore,
  fallbackUser?: { id?: number; username?: string; avatar_url?: string },
): LeanHomeScore {
  const display = getScoreDisplayValues(score);
  const user = {
    id: score.user?.id ?? fallbackUser?.id ?? score.user_id,
    username: score.user?.username ?? fallbackUser?.username ?? "Unknown",
    avatar_url: score.user?.avatar_url ?? fallbackUser?.avatar_url ?? "",
  };
  return {
    id: score.id,
    pp: score.pp,
    displayAcc: display.accuracy,
    displayRank: display.rank,
    isLazer: display.isLazer,
    mods: getModDisplayList(score.mods),
    timestamp: getScoreTimestamp(score),
    title: score.beatmapset?.title ?? "",
    version: score.beatmap?.version ?? "",
    keyCount: Number(score.beatmap?.cs) || 0,
    beatmapsetId: score.beatmapset?.id,
    user,
  };
}

const MAPS_FARMED_CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 1 week
const MAPS_FAVOURITES_CACHE_TTL = 14 * 24 * 60 * 60 * 1000; // 2 weeks
const MAPS_DATA_CACHE_VERSION = 12;
const USER_FAVOURITES_PAGE_SIZE = 100;
const USER_FAVOURITES_MAX_PAGES = 10;
const FARMED_SINGLE_PLAYER_PP_MIN = 500;
const USER_MOST_PLAYED_CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours
const USER_FAVOURITES_CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours
const MAPS_FETCH_CONCURRENCY = 6;
const RANKINGS_CACHE_TTL = 5 * 60 * 1000;
const RANK_HISTORY_CACHE_TTL = 24 * 60 * 60 * 1000;
const BEST_SCORES_WINDOW_CACHE_TTL = 2 * 60 * 1000;
const COUNTRY_BEATMAP_SCORES_CACHE_TTL = 2 * 60 * 1000;
const COUNTRY_BEATMAP_USER_SCORE_CACHE_TTL = 10 * 60 * 1000;
const BEATMAP_USER_SCORES_ALL_CACHE_TTL = 10 * 60 * 1000;
const COUNTRY_BEATMAP_LOOKUP_CONCURRENCY = 10;
const COUNTRY_BEATMAP_PLAYER_PAGE_LIMIT = 2; // Match the rest of the app's top-100 country player scope.
const USER_PROFILE_INSIGHTS_CACHE_TTL = 6 * 60 * 60 * 1000;
const USER_PROFILE_INSIGHTS_CACHE_VERSION = 6;
const HOME_PAGE_CACHE_TTL = 60 * 1000;
const HOME_RECENT_SCORES_CACHE_TTL = 5 * 60 * 1000;
const HOME_POPOFFS_CACHE_TTL = 10 * 60 * 1000;
const COUNTRY_POPOFFS_CACHE_TTL = 10 * 60 * 1000;
const COUNTRY_POPOFFS_CACHE_VERSION = 4;
const COUNTRY_TOP_PLAYS_REFRESH_TTL = 15 * 60 * 1000;
const COUNTRY_TOP_PLAYS_REFRESH_LOCK_TTL = 90 * 1000;
const COUNTRY_TOP_PLAYS_RETENTION_MS = 31 * 24 * 60 * 60 * 1000;
const COUNTRY_TOP_PLAYS_QUERY_LIMIT = 500;
export type PopoffWindow = "24h" | "3d" | "7d" | "30d";
const POPOFF_WINDOW_MS: Record<PopoffWindow, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "3d": 3 * 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};
const HOME_RECENT_SCORES_PLAYER_COUNT = 10;
const HOME_POPOFFS_PLAYER_COUNT = 10;
const USER_CACHE_TTL = 2 * 60 * 1000;
const USER_SCORE_LIST_CACHE_TTL = 60 * 1000;
const RANK_HISTORY_CONCURRENCY = 20;
const APPROX_PP_GAINS_CONCURRENCY = 4;
const RECENT_SCORES_CONCURRENCY = 10;
const SNIPES_CACHE_TTL = 6 * 60 * 60 * 1000;
const SNIPES_LOCK_TTL = 60 * 1000;
const SNIPES_PLAYER_LIMIT = 15;
const SNIPES_RECENT_LIMIT = 100;
const SNIPES_RECENT_PLAYS_CACHE_TTL = 10 * 60 * 1000;
const SNIPES_SCAN_CONCURRENCY = 4;
const SNIPES_PROBE_CONCURRENCY = 5;
const SNIPES_LOG_CAP = 500;
const SNIPES_LOG_TTL = 30 * 24 * 60 * 60 * 1000;
const SNIPES_SNAPSHOT_TTL = 90 * 24 * 60 * 60 * 1000;
const SNIPES_SEED_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SNIPES_SEED_PROBE_BUDGET = 50;
const SNIPES_RANKED_STATUSES = new Set(["ranked", "loved", "approved"]);
const SNIPES_STATUS_TTL = 60 * 1000;
const SNIPES_STATUS_THROTTLE_MS = 350;
const snipesStatusLastWriteByCountry = new Map<string, number>();

function snipesStatusKey(country: string): string {
  return `snipes-scan-status:${country}`;
}

function writeSnipesScanStatus(
  country: string,
  status: Omit<SnipesScanStatus, "updatedAt">,
  options: { force?: boolean } = {},
): void {
  const now = Date.now();
  const last = snipesStatusLastWriteByCountry.get(country) ?? 0;
  if (!options.force && now - last < SNIPES_STATUS_THROTTLE_MS) return;
  snipesStatusLastWriteByCountry.set(country, now);
  // Fire-and-forget: status updates must not block the scan, and a failed
  // write just means the client briefly sees stale status.
  void setPersistentCache(snipesStatusKey(country), { ...status, updatedAt: now }, SNIPES_STATUS_TTL);
}

function clearSnipesScanStatus(country: string): void {
  snipesStatusLastWriteByCountry.delete(country);
  // Overwrite with a 1s-TTL marker so the client's next poll sees it gone.
  void setPersistentCache(snipesStatusKey(country), null, 1000);
}

function snipesPartialEventsKey(country: string): string {
  return `snipes-partial-events:${country}`;
}

function writePartialSnipeEvents(country: string, events: SnipeEvent[]): void {
  if (events.length === 0) return;
  const sorted = [...events].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );
  void setPersistentCache(snipesPartialEventsKey(country), sorted, SNIPES_STATUS_TTL);
}

function clearPartialSnipeEvents(country: string): void {
  void setPersistentCache(snipesPartialEventsKey(country), null, 1000);
}
const userRecentPlaysPromiseCache = new Map<number, Promise<OsuScore[]>>();
const userPromiseCache = new Map<string, Promise<OsuUser>>();
const userScoresListPromiseCache = new Map<string, Promise<OsuScore[]>>();
const rankHistoryPromiseCache = new Map<number, Promise<number[] | null>>();
const bestScoresWindowPromiseCache = new Map<string, Promise<OsuScore[]>>();
const MIXED_SCORE_USER_IDS = new Set<number>([
  23341349, // happy amke sure
  25914429, // jaimito
]);

interface BeatmapUserScoreResponse {
  error?: string | null;
  position?: number | null;
  score?: OsuScore | null;
}

interface BeatmapUserScoresResponse {
  scores?: OsuScore[] | null;
}

interface ScorePpGainLookup {
  beatmapId: number;
  scoreId: number;
  timestamp: string;
  userId: number;
}

interface CountryRecentScoresResponse {
  gains: Record<number, number>;
  scores: OsuScore[];
}

function getScoreRequestParams(
  userId: number,
  params: Record<string, string | number | undefined>,
): Record<string, string | number | undefined> {
  return {
    ...params,
    legacy_only: MIXED_SCORE_USER_IDS.has(userId) ? undefined : 1,
  };
}

const USER_CACHE_VERSION = 4;

function getUserCacheKey(key: string): string {
  return `user:v${USER_CACHE_VERSION}:${key.trim().toLowerCase()}`;
}

function getUserScoreListCacheKey(
  type: "best" | "recent" | "firsts" | "pinned",
  userId: number,
  params: { limit: number; offset: number; includeFails?: boolean },
): string {
  return [
    "user-score-list",
    type,
    userId,
    params.limit,
    params.offset,
    params.includeFails ? 1 : 0,
  ].join(":");
}

export async function getCachedUser(key: string): Promise<OsuUser> {
  const cacheKey = getUserCacheKey(key);
  const cached = await getPersistentCached<OsuUser>(cacheKey);
  if (cached) return cached;

  const pending = userPromiseCache.get(cacheKey);
  if (pending) return pending;

  const request = fetchWithCacheLock(cacheKey, USER_CACHE_TTL, async () => {
    const user = await osuFetch<OsuUser>(`/users/${encodeURIComponent(key)}/mania`, undefined, {
      caller: "getUser",
    });
    if (user.page) {
      user.page.html = sanitizeProfilePageHtml(user.page.html);
    }
    void Promise.allSettled([
      setPersistentCache(getUserCacheKey(user.username), user, USER_CACHE_TTL),
      setPersistentCache(`user-id:v${USER_CACHE_VERSION}:${user.id}`, user, USER_CACHE_TTL),
    ]);
    return user;
  }).finally(() => {
    userPromiseCache.delete(cacheKey);
  });

  userPromiseCache.set(cacheKey, request);
  return request;
}

export async function getCachedUserScores(
  type: "best" | "recent" | "firsts" | "pinned",
  userId: number,
  options: { limit: number; offset: number; includeFails?: boolean },
): Promise<OsuScore[]> {
  const cacheKey = getUserScoreListCacheKey(type, userId, options);
  const cached = await getPersistentCached<OsuScore[]>(cacheKey);
  if (cached) return cached;

  const pending = userScoresListPromiseCache.get(cacheKey);
  if (pending) return pending;

  const request = fetchWithCacheLock(cacheKey, USER_SCORE_LIST_CACHE_TTL, () =>
    osuFetch<OsuScore[]>(
      `/users/${userId}/scores/${type}`,
      getScoreRequestParams(userId, {
        mode: "mania",
        limit: options.limit,
        offset: options.offset,
        include_fails: type === "recent" && options.includeFails ? 1 : 0,
      }),
      { caller: `getUserScores:${type}` },
    ),
  ).finally(() => {
    userScoresListPromiseCache.delete(cacheKey);
  });

  userScoresListPromiseCache.set(cacheKey, request);
  return request;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (true) {
        const currentIndex = nextIndex++;
        if (currentIndex >= items.length) return;
        results[currentIndex] = await mapper(items[currentIndex], currentIndex);
      }
    }),
  );

  return results;
}

async function getUserRankHistory(userId: number): Promise<number[] | null> {
  const cacheKey = `rank-history:user:${userId}`;
  const cached = await getPersistentCacheEntry<number[] | null>(cacheKey);
  if (cached.hit) return cached.value;

  const pending = rankHistoryPromiseCache.get(userId);
  if (pending) return pending;

  const request = osuFetch<OsuUser>(`/users/${userId}/mania`, undefined, {
    caller: "getUserRankHistory",
  })
    .then((user) => {
      const history = user.rank_history?.data ?? null;
      void setPersistentCache(cacheKey, history, RANK_HISTORY_CACHE_TTL);
      return history;
    })
    .finally(() => {
      rankHistoryPromiseCache.delete(userId);
    });

  rankHistoryPromiseCache.set(userId, request);
  return request;
}

// ── User ────────────────────────────────────────────────────────────────────

export const getUser = createServerFn({ method: "GET" })
  .inputValidator((data: { key: string }) => data)
  .handler(async ({ data }: { data: { key: string } }) => {
    edgeCache(60, 300);
    return getCachedUser(data.key);
  });

export const getUserScoresBest = createServerFn({ method: "GET" })
  .inputValidator((data: { userId: number; limit?: number; offset?: number }) => data)
  .handler(async ({ data }: { data: { userId: number; limit?: number; offset?: number } }) => {
    edgeCache(120, 600);
    return getCachedUserScores("best", data.userId, {
      limit: data.limit ?? 20,
      offset: data.offset ?? 0,
    });
  });

export const getUserScoresRecent = createServerFn({ method: "GET" })
  .inputValidator((data: { userId: number; limit?: number; offset?: number; include_fails?: boolean }) => data)
  .handler(async ({ data }: { data: { userId: number; limit?: number; offset?: number; include_fails?: boolean } }) => {
    edgeCache(30, 120);
    return getCachedUserScores("recent", data.userId, {
      limit: data.limit ?? 10,
      offset: data.offset ?? 0,
      includeFails: data.include_fails,
    });
  });

export const getUserScoresFirsts = createServerFn({ method: "GET" })
  .inputValidator((data: { userId: number; limit?: number; offset?: number }) => data)
  .handler(async ({ data }: { data: { userId: number; limit?: number; offset?: number } }) => {
    edgeCache(300, 1800);
    return getCachedUserScores("firsts", data.userId, {
      limit: data.limit ?? 100,
      offset: data.offset ?? 0,
    });
  });

export const getUserScoresPinned = createServerFn({ method: "GET" })
  .inputValidator((data: { userId: number; limit?: number; offset?: number }) => data)
  .handler(async ({ data }: { data: { userId: number; limit?: number; offset?: number } }) => {
    edgeCache(600, 3600);
    return getCachedUserScores("pinned", data.userId, {
      limit: data.limit ?? 50,
      offset: data.offset ?? 0,
    });
  });

function getTopCountEntry(counts: Map<string, number>, total: number): { label: string; count: number; total: number } | null {
  const entries = [...counts.entries()];
  if (!entries.length) return null;

  entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const [label, count] = entries[0];
  return { label, count, total };
}

function getMedian(values: number[]): number | null {
  if (!values.length) return null;

  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 1) {
    return sorted[mid];
  }

  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function getTimestampMs(score: OsuScore): number {
  const timestamp = getScoreTimestamp(score);
  return timestamp ? new Date(timestamp).getTime() : 0;
}

function scoreToSnapshot(score: OsuScore): InsightScoreSnapshot {
  const display = getScoreDisplayValues(score);

  return {
    title: score.beatmapset?.title ?? "Unknown",
    artist: score.beatmapset?.artist ?? "",
    version: score.beatmap?.version ?? "",
    pp: score.pp,
    rank: display.rank,
    coverUrl: score.beatmapset?.covers?.cover ?? "",
    beatmapUrl: score.beatmap?.url ?? `https://osu.ppy.sh/b/${score.beatmap?.id ?? 0}`,
    date: getScoreTimestamp(score) ?? "",
    mods: getModAcronyms(score.mods),
  };
}

function calculateUserProfileInsights(bestScores: OsuScore[]): UserProfileInsights {
  const scores = bestScores.filter((score) => score.beatmap?.mode === "mania");
  const keyCounts = new Map<number, number>();
  const modCounts = new Map<string, number>();
  let moddedPlayCount = 0;
  const bpmEntries: Array<{ bpm: number; keyCount: number | null; score: OsuScore }> = [];
  const ppValues: number[] = [];
  const datedScores: Array<{ score: OsuScore; ms: number }> = [];

  for (const score of scores) {
    const rawKeyCount = Number(score.beatmap?.cs);
    const normalizedKeyCount = Number.isFinite(rawKeyCount) && rawKeyCount > 0 ? Math.round(rawKeyCount) : null;
    if (normalizedKeyCount !== null) {
      keyCounts.set(normalizedKeyCount, (keyCounts.get(normalizedKeyCount) ?? 0) + 1);
    }

    const mods = getModAcronyms(score.mods);
    if (mods.length > 0) {
      moddedPlayCount++;
      for (const mod of mods) {
        modCounts.set(mod, (modCounts.get(mod) ?? 0) + 1);
      }
    }

    const bpm = Number(score.beatmap?.bpm);
    if (Number.isFinite(bpm) && bpm > 0) {
      bpmEntries.push({ bpm: bpm * getScoreRate(score.mods), keyCount: normalizedKeyCount, score });
    }

    if (score.pp != null && score.pp > 0) {
      ppValues.push(score.pp);
    }

    const timestampMs = getTimestampMs(score);
    if (Number.isFinite(timestampMs) && timestampMs > 0) {
      datedScores.push({ score, ms: timestampMs });
    }
  }

  const sortedKeySplit = [...keyCounts.entries()]
    .map(([keyCount, count]) => ({ keyCount, count }))
    .sort((a, b) => b.count - a.count || a.keyCount - b.keyCount);
  datedScores.sort((a, b) => a.ms - b.ms);
  const sortedPpValues = ppValues.sort((a, b) => b - a);

  const bpms = bpmEntries.map((e) => e.bpm);

  let bpmRange: UserProfileInsights["bpmRange"] = null;
  if (bpmEntries.length > 0) {
    let minEntry = bpmEntries[0];
    let maxEntry = bpmEntries[0];
    for (const entry of bpmEntries) {
      if (entry.bpm < minEntry.bpm) minEntry = entry;
      if (entry.bpm > maxEntry.bpm) maxEntry = entry;
    }
    bpmRange = {
      min: minEntry.bpm,
      max: maxEntry.bpm,
      minScore: scoreToSnapshot(minEntry.score),
      maxScore: scoreToSnapshot(maxEntry.score),
    };
  }

  const bpmByKeyMap = new Map<number, number[]>();
  for (const entry of bpmEntries) {
    if (entry.keyCount === null) continue;
    const arr = bpmByKeyMap.get(entry.keyCount);
    if (arr) arr.push(entry.bpm);
    else bpmByKeyMap.set(entry.keyCount, [entry.bpm]);
  }
  const bpmByKeyMode = [...bpmByKeyMap.entries()]
    .map(([keyCount, values]) => ({ keyCount, median: getMedian(values) ?? 0, count: values.length }))
    .sort((a, b) => a.keyCount - b.keyCount);

  return {
    sampleSize: scores.length,
    keySplit: sortedKeySplit,
    mostUsedMod: getTopCountEntry(modCounts, moddedPlayCount),
    modBreakdown: [...modCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([label, count]) => ({ label, count, total: scores.length })),
    medianBpm: getMedian(bpms),
    bpmRange,
    bpmByKeyMode,
    newestTopPlay: datedScores.length ? scoreToSnapshot(datedScores[datedScores.length - 1].score) : null,
    oldestTopPlay: datedScores.length ? scoreToSnapshot(datedScores[0].score) : null,
    ppRange: sortedPpValues.length
      ? {
          top: sortedPpValues[0],
          bottom: sortedPpValues[sortedPpValues.length - 1],
        }
      : null,
  };
}

async function fetchUserBestScoresWindow(userId: number, totalLimit = 200): Promise<OsuScore[]> {
  const cacheKey = `user-best-scores-window:${userId}:${totalLimit}`;
  const cached = await getPersistentCached<OsuScore[]>(cacheKey);
  if (cached) return cached;

  const pending = bestScoresWindowPromiseCache.get(cacheKey);
  if (pending) return pending;

  const request = fetchWithCacheLock(cacheKey, BEST_SCORES_WINDOW_CACHE_TTL, async () => {
    const firstPage = await osuFetch<OsuScore[]>(
      `/users/${userId}/scores/best`,
      getScoreRequestParams(userId, {
        mode: "mania",
        limit: Math.min(totalLimit, 100),
        offset: 0,
      }),
      { caller: "fetchUserBestScoresWindow:p1" },
    );

    let scores = firstPage;

    if (totalLimit > 100 && firstPage.length >= 100) {
      const secondPage = await osuFetch<OsuScore[]>(
        `/users/${userId}/scores/best`,
        getScoreRequestParams(userId, {
          mode: "mania",
          limit: Math.min(totalLimit - 100, 100),
          offset: 100,
        }),
        { caller: "fetchUserBestScoresWindow:p2" },
      );
      scores = [...firstPage, ...secondPage];
    }

    return scores;
  }).finally(() => {
    bestScoresWindowPromiseCache.delete(cacheKey);
  });

  bestScoresWindowPromiseCache.set(cacheKey, request);
  return request;
}

async function getBeatmapUserScoresAll(beatmapId: number, userId: number): Promise<OsuScore[]> {
  const cacheKey = `beatmap-user-scores-all:${beatmapId}:${userId}`;
  return fetchWithCacheLock(cacheKey, BEATMAP_USER_SCORES_ALL_CACHE_TTL, async () => {
    const response = await osuFetch<BeatmapUserScoresResponse>(
      `/beatmaps/${beatmapId}/scores/users/${userId}/all`,
      getScoreRequestParams(userId, {
        ruleset: "mania",
      }),
      { caller: "getBeatmapUserScoresAll" },
    );
    return response.scores ?? [];
  });
}

function getPreviousBeatmapBestScore(scores: OsuScore[], target: ScorePpGainLookup): OsuScore | null {
  const targetTimestampMs = new Date(target.timestamp).getTime();
  if (!Number.isFinite(targetTimestampMs) || targetTimestampMs <= 0) return null;

  const olderScores = scores
    .filter((score) => score.id !== target.scoreId)
    .filter((score) => {
      const timestampMs = getTimestampMs(score);
      return Number.isFinite(timestampMs) && timestampMs > 0 && timestampMs < targetTimestampMs;
    })
    .filter((score) => score.pp != null && score.pp > 0);

  if (olderScores.length === 0) return null;

  olderScores.sort((a, b) => {
    const ppDiff = (b.pp ?? 0) - (a.pp ?? 0);
    if (ppDiff !== 0) return ppDiff;
    return getTimestampMs(b) - getTimestampMs(a);
  });

  return olderScores[0];
}

async function calculateReplacementPpGainMapForTargets(
  bestScores: OsuScore[],
  targets: ScorePpGainLookup[],
): Promise<Record<number, number>> {
  const bestScoreById = new Map(
    bestScores
      .filter((score) => score.id > 0 && score.pp != null && score.pp > 0)
      .map((score) => [score.id, score]),
  );
  const fallbackGainMap = calculateApproxPpGainMap(bestScores);
  const relevantTargets = targets.filter((target) => bestScoreById.has(target.scoreId));
  if (relevantTargets.length === 0) return {};

  const previousScores = await mapWithConcurrency(
    relevantTargets,
    APPROX_PP_GAINS_CONCURRENCY,
    async (target) => {
      try {
        const history = await getBeatmapUserScoresAll(target.beatmapId, target.userId);
        return getPreviousBeatmapBestScore(history, target);
      } catch (error) {
        console.warn("[osu] failed to fetch beatmap score history for pp gain fallback", {
          beatmapId: target.beatmapId,
          scoreId: target.scoreId,
          timestamp: target.timestamp,
          userId: target.userId,
          error: getErrorMessage(error),
        });
        return undefined;
      }
    },
  );

  const gains: Record<number, number> = {};
  relevantTargets.forEach((target, index) => {
    const currentScore = bestScoreById.get(target.scoreId);
    if (!currentScore) return;

    const previousScore = previousScores[index];
    if (previousScore === undefined) {
      const fallbackGain = fallbackGainMap[target.scoreId];
      if (fallbackGain > 0) gains[target.scoreId] = fallbackGain;
      return;
    }

    const gain = calculateReplacementPpGain(bestScores, target.scoreId, previousScore ?? null);
    if (gain > 0) gains[target.scoreId] = gain;
  });

  return gains;
}

export const getUserScoresBestWindow = createServerFn({ method: "GET" })
  .inputValidator((data: { userId: number; totalLimit?: number }) => data)
  .handler(async ({ data }: { data: { userId: number; totalLimit?: number } }) => {
    edgeCache(120, 600);
    return fetchUserBestScoresWindow(data.userId, data.totalLimit ?? 200);
  });

export const getUserProfileInsights = createServerFn({ method: "GET" })
  .inputValidator((data: { userId: number }) => data)
  .handler(async ({ data }: { data: { userId: number } }) => {
    edgeCache(1800, 21600);
    const cacheKey = `user-profile-insights:v${USER_PROFILE_INSIGHTS_CACHE_VERSION}:${data.userId}`;
    return fetchWithCacheLock(cacheKey, USER_PROFILE_INSIGHTS_CACHE_TTL, async () =>
      calculateUserProfileInsights(await fetchUserBestScoresWindow(data.userId, 200)),
    );
  });

// ── Rankings ────────────────────────────────────────────────────────────────

export const getRankings = createServerFn({ method: "GET" })
  .inputValidator((data: { type?: string; page?: number; country?: string }) => data)
  .handler(async ({ data }: { data: { type?: string; page?: number; country?: string } }): Promise<RankingsResponse> => {
    edgeCache(60, 300);
    const type = data.type ?? "performance";
    // v2: payload trimmed to LeanRankingEntry. Bumped so old full-OsuUser
    // blobs in Turso aren't returned with the new lean consumer types.
    const cacheKey = `rankings:v2:${type}:${data.page ?? 1}:${data.country ?? ""}`;
    return fetchWithCacheLock(cacheKey, RANKINGS_CACHE_TTL, async () => {
      const raw = await osuFetch<RawRankingsResponse>(
        `/rankings/mania/${type}`,
        {
          "cursor[page]": data.page ?? 1,
          country: data.country,
        },
        { caller: "getRankings" },
      );
      return {
        cursor: raw.cursor,
        ranking: raw.ranking.map(toLeanRankingEntry),
        total: raw.total,
      };
    });
  });

async function fetchCountryRecentScores(
  userIds: number[],
  options?: { batchSize?: number; batchIndex?: number; recentLimit?: number },
): Promise<OsuScore[]> {
  const size = options?.batchSize ?? 5;
  const start = ((options?.batchIndex ?? 0) * size) % userIds.length;
  const batch = userIds.slice(start, start + size);
  const recentLimit = options?.recentLimit ?? 20;

  const results = await mapWithConcurrency(
    batch,
    RECENT_SCORES_CONCURRENCY,
    async (uid: number) => {
      try {
        return await getCachedUserScores("recent", uid, {
          limit: recentLimit,
          offset: 0,
          includeFails: true,
        });
      } catch {
        return [];
      }
    },
  );

  return results.flatMap((scores) => scores);
}

async function fetchCountryRecentScoresWithGains(
  userIds: number[],
  options?: { batchSize?: number; batchIndex?: number; recentLimit?: number },
): Promise<CountryRecentScoresResponse> {
  const scores = await fetchCountryRecentScores(userIds, options);
  const rankedTargets = Array.from(
    new Map(
      scores
        .filter((score) => score.id > 0 && score.pp != null && score.pp > 0)
        .map((score) => [
          score.id,
          {
            beatmapId: score.beatmap_id ?? score.beatmap?.id ?? 0,
            scoreId: score.id,
            timestamp: getScoreTimestamp(score),
            userId: score.user_id,
          } satisfies ScorePpGainLookup,
        ]),
    ).values(),
  );

  if (rankedTargets.length === 0) {
    return { scores, gains: {} };
  }

  const targetsByUserId = new Map<number, ScorePpGainLookup[]>();
  rankedTargets.forEach((target) => {
    const list = targetsByUserId.get(target.userId);
    if (list) list.push(target);
    else targetsByUserId.set(target.userId, [target]);
  });

  const groupedTargets = [...targetsByUserId.entries()];
  const groupedGains = await mapWithConcurrency(
    groupedTargets,
    APPROX_PP_GAINS_CONCURRENCY,
    async ([userId, targets]) => {
      try {
        const bestScores = await fetchUserBestScoresWindow(userId, 200);
        return await calculateReplacementPpGainMapForTargets(bestScores, targets);
      } catch {
        return {} as Record<number, number>;
      }
    },
  );

  const gains: Record<number, number> = {};
  groupedGains.forEach((group) => Object.assign(gains, group));
  return { scores, gains };
}

function buildRecentScoresPreview(scores: OsuScore[], limit = 5): OsuScore[] {
  const seenUsers = new Set<number>();

  return scores
    .filter((score) => score.passed)
    .sort((a, b) => getTimestampMs(b) - getTimestampMs(a))
    .filter((score) => {
      if (seenUsers.has(score.user_id)) return false;
      seenUsers.add(score.user_id);
      return true;
    })
    .slice(0, limit);
}

async function buildHomeRecentScoresPreview(userIds: number[]): Promise<LeanHomeScore[]> {
  const previewUserIds = userIds.slice(0, HOME_RECENT_SCORES_PLAYER_COUNT);
  if (previewUserIds.length === 0) return [];
  // v2: response is now LeanHomeScore[] (pre-digested display values, no
  // fat beatmapset/beatmap fields).
  const cacheKey = `home-recent-scores:v2:${previewUserIds.join(",")}`;

  return fetchWithCacheLock(cacheKey, HOME_RECENT_SCORES_CACHE_TTL, async () => {
    const scores = await fetchCountryRecentScores(previewUserIds, {
      batchSize: previewUserIds.length,
      batchIndex: 0,
      recentLimit: 20,
    });
    return buildRecentScoresPreview(scores, 5).map((score) => toLeanHomeScore(score));
  });
}

type HomePreviewPlayer = {
  id: number;
  username: string;
  avatar_url: string;
};

type CountryPopoff = {
  user: { id: number; username: string; avatar_url: string };
  score: OsuScore;
  pp: number;
  weightedPP: number;
  ppGain: number;
  time: string;
};

async function buildHomePopoffs(players: HomePreviewPlayer[]): Promise<LeanHomePopoff[]> {
  const topPlayersForPopoffs = players.slice(0, HOME_POPOFFS_PLAYER_COUNT);
  if (topPlayersForPopoffs.length === 0) return [];
  // v2: response is now LeanHomePopoff[] (pre-digested display values).
  const cacheKey = `home-popoffs:v2:${topPlayersForPopoffs.map((player) => player.id).join(",")}`;

  return fetchWithCacheLock(cacheKey, HOME_POPOFFS_CACHE_TTL, async () => {
    type FatPopoff = { user: HomePreviewPlayer; score: OsuScore };
    const results = await mapWithConcurrency(
      topPlayersForPopoffs,
      APPROX_PP_GAINS_CONCURRENCY,
      async (player): Promise<FatPopoff[]> => {
        try {
          const scores = await fetchUserBestScoresWindow(player.id, 100);
          return scores
            .filter((score) => {
              const age = Date.now() - getTimestampMs(score);
              return age < 7 * 24 * 60 * 60 * 1000 && score.pp != null && score.pp > 0;
            })
            .map((score) => ({ user: player, score }));
        } catch {
          return [];
        }
      },
    );

    const sorted = results
      .flatMap((entries) => entries)
      .sort((a, b) => {
        const ppDiff = (b.score.pp ?? 0) - (a.score.pp ?? 0);
        if (ppDiff !== 0) return ppDiff;
        return getTimestampMs(b.score) - getTimestampMs(a.score);
      });

    const picked: FatPopoff[] = [];
    const seenUsers = new Set<string>();
    for (const entry of sorted) {
      if (picked.length >= 5) break;
      if (!seenUsers.has(entry.user.username)) {
        seenUsers.add(entry.user.username);
        picked.push(entry);
      }
    }
    if (picked.length < 5) {
      for (const entry of sorted) {
        if (picked.length >= 5) break;
        if (!picked.includes(entry)) picked.push(entry);
      }
    }

    return picked.map(({ user, score }) => ({
      user: { username: user.username, avatar_url: user.avatar_url },
      score: toLeanHomeScore(score, user),
    }));
  });
}

function filterPopoffsForWindow(popoffs: CountryPopoff[], window: PopoffWindow): CountryPopoff[] {
  const windowMs = POPOFF_WINDOW_MS[window];
  const cutoff = Date.now() - windowMs;
  return popoffs.filter((popoff) => {
    const scoreTime = new Date(popoff.time).getTime();
    return Number.isFinite(scoreTime) && scoreTime >= cutoff;
  });
}

function sortCountryPopoffs(popoffs: CountryPopoff[]): CountryPopoff[] {
  return [...popoffs].sort((a, b) => {
    if (b.pp !== a.pp) return b.pp - a.pp;
    return new Date(b.time).getTime() - new Date(a.time).getTime();
  });
}

async function buildLiveCountryPopoffs(
  players: HomePreviewPlayer[],
  window: PopoffWindow,
): Promise<CountryPopoff[]> {
  const topPlayers = players.slice(0, 30);
  if (topPlayers.length === 0) return [];

  const windowMs = POPOFF_WINDOW_MS[window];
  const cacheKey = `country-popoffs:v${COUNTRY_POPOFFS_CACHE_VERSION}:${window}:${topPlayers.map((player) => player.id).join(",")}`;

  return fetchWithCacheLock(cacheKey, COUNTRY_POPOFFS_CACHE_TTL, async () => {
    const results = await mapWithConcurrency(
      topPlayers,
      APPROX_PP_GAINS_CONCURRENCY,
      async (player) => {
        try {
          const scores = await fetchUserBestScoresWindow(player.id, 100);
          const relevantScores = scores.filter((score) => {
            const age = Date.now() - getTimestampMs(score);
            return age < windowMs && score.pp != null && score.pp > 0;
          });
          const gainMap = await calculateReplacementPpGainMapForTargets(
            scores,
            relevantScores.map((score) => ({
              beatmapId: score.beatmap_id ?? score.beatmap?.id ?? 0,
              scoreId: score.id,
              timestamp: getScoreTimestamp(score),
              userId: player.id,
            })),
          );

          return relevantScores
            .map((score) => ({
              user: player,
              score,
              pp: score.pp ?? 0,
              weightedPP: score.weight?.pp ?? 0,
              ppGain: gainMap[score.id] ?? 0,
              time: getScoreTimestamp(score),
            }));
        } catch (error) {
          console.warn("[osu] failed to build country popoff scores for player", {
            playerId: player.id,
            username: player.username,
            error: getErrorMessage(error),
          });
          return [] as CountryPopoff[];
        }
      },
    );

    return results.flatMap((scores) => scores);
  });
}

async function getStoredCountryTopPlays(country: string, window: PopoffWindow): Promise<CountryPopoff[]> {
  if (!hasDb() || !db) return [];

  try {
    await ensureCacheSchema();

    const result = await db.execute({
      sql: `
        SELECT user_id, username, avatar_url, score_json, pp, weighted_pp, pp_gain, score_time
        FROM country_top_plays
        WHERE country = ?
          AND score_time >= ?
        ORDER BY pp DESC, score_time DESC
        LIMIT ?
      `,
      args: [
        normalizeCountryCode(country),
        Date.now() - POPOFF_WINDOW_MS[window],
        COUNTRY_TOP_PLAYS_QUERY_LIMIT,
      ],
    });

    const popoffs: CountryPopoff[] = [];
    for (const row of result.rows) {
      try {
        popoffs.push({
          user: {
            id: Number(row.user_id),
            username: String(row.username),
            avatar_url: String(row.avatar_url),
          },
          score: JSON.parse(String(row.score_json)) as OsuScore,
          pp: Number(row.pp),
          weightedPP: Number(row.weighted_pp),
          ppGain: Number(row.pp_gain),
          time: new Date(Number(row.score_time)).toISOString(),
        });
      } catch (error) {
        console.warn("[osu] failed to parse stored country top play", {
          country,
          error: getErrorMessage(error),
        });
      }
    }

    return sortCountryPopoffs(popoffs);
  } catch (error) {
    console.warn("[osu] failed to read stored country top plays", {
      country,
      error: getErrorMessage(error),
    });
    return [];
  }
}

async function upsertStoredCountryTopPlays(country: string, popoffs: CountryPopoff[]): Promise<void> {
  if (!hasDb() || !db) return;

  const normalizedCountry = normalizeCountryCode(country);
  const now = Date.now();
  const cutoff = now - COUNTRY_TOP_PLAYS_RETENTION_MS;

  try {
    await ensureCacheSchema();

    const statements = popoffs
      .filter((popoff) => popoff.score.id > 0)
      .map((popoff) => {
        const scoreTime = new Date(popoff.time).getTime();
        return {
          sql: `
            INSERT INTO country_top_plays (
              country, score_id, user_id, username, avatar_url, score_json,
              pp, weighted_pp, pp_gain, score_time, discovered_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(country, score_id) DO UPDATE SET
              user_id = excluded.user_id,
              username = excluded.username,
              avatar_url = excluded.avatar_url,
              score_json = excluded.score_json,
              pp = excluded.pp,
              weighted_pp = excluded.weighted_pp,
              pp_gain = excluded.pp_gain,
              score_time = excluded.score_time,
              updated_at = excluded.updated_at
          `,
          args: [
            normalizedCountry,
            popoff.score.id,
            popoff.user.id,
            popoff.user.username,
            popoff.user.avatar_url,
            JSON.stringify(popoff.score),
            popoff.pp,
            popoff.weightedPP,
            popoff.ppGain,
            Number.isFinite(scoreTime) ? scoreTime : now,
            now,
            now,
          ],
        };
      });

    if (statements.length > 0) {
      await db.batch(statements);
    }

    await db.execute({
      sql: "DELETE FROM country_top_plays WHERE country = ? AND score_time < ?",
      args: [normalizedCountry, cutoff],
    });
  } catch (error) {
    console.warn("[osu] failed to write stored country top plays", {
      country,
      error: getErrorMessage(error),
    });
  }
}

async function refreshStoredCountryTopPlays(country: string, players: HomePreviewPlayer[]): Promise<number> {
  const refreshed = await buildLiveCountryPopoffs(players, "30d");
  await upsertStoredCountryTopPlays(country, refreshed);
  return Date.now();
}

async function refreshStoredCountryTopPlaysWithLock(country: string, players: HomePreviewPlayer[]): Promise<void> {
  const normalizedCountry = normalizeCountryCode(country);
  const cacheKey = `country-top-plays-refresh:v1:${normalizedCountry}`;
  await fetchWithCacheLock(
    cacheKey,
    COUNTRY_TOP_PLAYS_REFRESH_TTL,
    () => refreshStoredCountryTopPlays(normalizedCountry, players),
    COUNTRY_TOP_PLAYS_REFRESH_LOCK_TTL,
  );
}

async function buildCountryPopoffs(
  country: string | undefined,
  players: HomePreviewPlayer[],
  window: PopoffWindow,
): Promise<CountryPopoff[]> {
  if (!country || !hasDb()) {
    return buildLiveCountryPopoffs(players, window);
  }

  const normalizedCountry = normalizeCountryCode(country);
  const stored = await getStoredCountryTopPlays(normalizedCountry, window);
  if (stored.length > 0) {
    refreshStoredCountryTopPlaysWithLock(normalizedCountry, players).catch((error) => {
      console.warn("[osu] failed to refresh stored country top plays in background", {
        country: normalizedCountry,
        error: getErrorMessage(error),
      });
    });
    return stored;
  }

  const live = await buildLiveCountryPopoffs(players, window);
  await upsertStoredCountryTopPlays(normalizedCountry, live);

  if (window !== "30d") {
    refreshStoredCountryTopPlaysWithLock(normalizedCountry, players).catch((error) => {
      console.warn("[osu] failed to warm stored country top plays in background", {
        country: normalizedCountry,
        error: getErrorMessage(error),
      });
    });
  }

  const selectedWindow = sortCountryPopoffs(filterPopoffsForWindow(live, window));
  if (selectedWindow.length > 0 || window !== "30d") return selectedWindow;

  try {
    await refreshStoredCountryTopPlaysWithLock(normalizedCountry, players);
  } catch (error) {
    console.warn("[osu] failed to warm stored country top plays", {
      country: normalizedCountry,
      error: getErrorMessage(error),
    });
    return selectedWindow;
  }

  const refreshed = await getStoredCountryTopPlays(normalizedCountry, window);
  if (refreshed.length > 0) return refreshed;
  return selectedWindow;
}

export const getHomePageData = createServerFn({ method: "GET" })
  .inputValidator((data?: { country?: string }) => data)
  .handler(async ({ data }: { data?: { country?: string } }): Promise<HomePageData> => {
    edgeCache(30, 300);
    const country = data?.country ?? "CR";
    // v2: rankings and scores are now lean shapes.
    const cacheKey = `home-page-data:v2:${country}`;
    return fetchWithCacheLock(cacheKey, HOME_PAGE_CACHE_TTL, async () => {
      const rankings = await getRankings({ data: { type: "performance", page: 1, country } });
      const activeRankings = rankings.ranking.filter((entry) => entry.user.is_active !== false);
      const userIds = activeRankings.map((entry) => entry.user.id);
      const players = activeRankings.map((entry) => ({
        id: entry.user.id,
        username: entry.user.username,
        avatar_url: entry.user.avatar_url,
      }));

      const [recentScores, popoffs] = await Promise.all([
        buildHomeRecentScoresPreview(userIds),
        buildHomePopoffs(players),
      ]);

      return { rankings, recentScores, popoffs } satisfies HomePageData;
    }, 30_000);
  });

export const getHomeRecentScores = createServerFn({ method: "GET" })
  .inputValidator((data: { userIds: number[] }) => data)
  .handler(async ({ data }: { data: { userIds: number[] } }) => {
    edgeCache(60, 300);
    return buildHomeRecentScoresPreview(data.userIds);
  });

export const getHomePopoffs = createServerFn({ method: "GET" })
  .inputValidator((data: { players: HomePreviewPlayer[] }) => data)
  .handler(async ({ data }: { data: { players: HomePreviewPlayer[] } }) => {
    edgeCache(300, 1800);
    return buildHomePopoffs(data.players);
  });

export const getCountryPopoffs = createServerFn({ method: "GET" })
  .inputValidator((data: { country?: string; players: HomePreviewPlayer[]; window?: PopoffWindow }) => data)
  .handler(async ({ data }: { data: { country?: string; players: HomePreviewPlayer[]; window?: PopoffWindow } }) => {
    edgeCache(60, 600);
    return buildCountryPopoffs(data.country, data.players, data.window ?? "30d");
  });

// ── Batch user rank history ────────────────────────────────────────────────

export const getUsersRankHistory = createServerFn({ method: "GET" })
  .inputValidator((data: { userIds: number[] }) => data)
  .handler(async ({ data }: { data: { userIds: number[] } }) => {
    edgeCache(3600, 86400);
    const uniqueUserIds = [...new Set(data.userIds)];

    const results = await mapWithConcurrency(
      uniqueUserIds,
      RANK_HISTORY_CONCURRENCY,
      async (userId) => {
        try {
          const history = await getUserRankHistory(userId);
          return { userId, history };
        } catch {
          return { userId, history: null };
        }
      },
    );

    const out: Record<number, number[]> = {};

    results.forEach(({ userId, history }) => {
      if (history?.length) {
        out[userId] = history;
      }
    });

    return out;
  });

// ── Beatmaps ────────────────────────────────────────────────────────────────

export const searchBeatmaps = createServerFn({ method: "GET" })
  .inputValidator((data: { query?: string; sort?: string; cursor_string?: string; status?: string }) => data)
  .handler(async ({ data }: { data: { query?: string; sort?: string; cursor_string?: string; status?: string } }) => {
    edgeCache(300, 3600);
    return osuFetch<BeatmapsetSearchResponse>(
      "/beatmapsets/search",
      {
        m: 3, // mania
        q: data.query,
        sort: data.sort ?? "ranked_desc",
        cursor_string: data.cursor_string,
        s: data.status,
      },
      { caller: "searchBeatmaps" },
    );
  });

async function getBeatmapUserScore(beatmapId: number, userId: number): Promise<OsuScore | null> {
  const cacheKey = `beatmap-user-score:${beatmapId}:${userId}`;
  return fetchWithCacheLock(cacheKey, COUNTRY_BEATMAP_USER_SCORE_CACHE_TTL, async () => {
    const response = await osuFetch<BeatmapUserScoreResponse>(
      `/beatmaps/${beatmapId}/scores/users/${userId}`,
      { mode: "mania" },
      { caller: "getBeatmapUserScore" },
    );
    return response.score ?? null;
  });
}

async function getCountryBeatmapScores(beatmapId: number, country: string): Promise<OsuScore[]> {
  const normalizedCountry = country.trim().toUpperCase();
  const cacheKey = `country-beatmap-scores:${beatmapId}:${normalizedCountry}`;

  return fetchWithCacheLock(cacheKey, COUNTRY_BEATMAP_SCORES_CACHE_TTL, async () => {
    const firstPage = await getRankings({ data: { type: "performance", page: 1, country: normalizedCountry } });
    const totalPages = Math.max(1, Math.min(Math.ceil(firstPage.total / 50), COUNTRY_BEATMAP_PLAYER_PAGE_LIMIT));
    const remainingPages = await Promise.all(
      Array.from({ length: Math.max(0, totalPages - 1) }, (_, index) =>
        getRankings({ data: { type: "performance", page: index + 2, country: normalizedCountry } })),
    );

    const rankedUsers = [firstPage, ...remainingPages].flatMap((page) => page.ranking);
    const userIds = Array.from(new Set(rankedUsers.map((entry) => entry.user.id)));
    const scores = await mapWithConcurrency(
      userIds,
      COUNTRY_BEATMAP_LOOKUP_CONCURRENCY,
      async (userId) => getBeatmapUserScore(beatmapId, userId).catch(() => null),
    );

    return scores
      .filter((score): score is OsuScore => score !== null)
      .filter((score) => score.user?.country_code === normalizedCountry)
      .sort((left, right) => {
        const scoreDelta = (getScoreDisplayValues(right).totalScore ?? 0) - (getScoreDisplayValues(left).totalScore ?? 0);
        if (scoreDelta !== 0) return scoreDelta;

        const ppDelta = (right.pp ?? 0) - (left.pp ?? 0);
        if (ppDelta !== 0) return ppDelta;

        return right.accuracy - left.accuracy;
      });
  });
}

export const getBeatmapScores = createServerFn({ method: "GET" })
  .inputValidator((data: { beatmapId: number; country?: string }) => data)
  .handler(async ({ data }: { data: { beatmapId: number; country?: string } }) => {
    edgeCache(120, 600);
    if (data.country?.trim()) {
      return { scores: await getCountryBeatmapScores(data.beatmapId, data.country) };
    }

    return osuFetch<BeatmapScoresResponse>(
      `/beatmaps/${data.beatmapId}/scores`,
      {
        mode: "mania",
        type: "global",
      },
      { caller: "getBeatmapScores" },
    );
  });

// ── Search ──────────────────────────────────────────────────────────────────

export const searchUsers = createServerFn({ method: "GET" })
  .inputValidator((data: { query: string }) => data)
  .handler(async ({ data }: { data: { query: string } }) => {
    edgeCache(60, 600);
    return osuFetch<UserSearchResponse>(
      "/search",
      {
        mode: "user",
        query: data.query,
      },
      { caller: "searchUsers" },
    );
  });

// ── Score Feed (CR top players' recent scores) ─────────────────────────────

export const getCountryRecentScores = createServerFn({ method: "GET" })
  .inputValidator((data: { userIds: number[]; batchSize?: number; batchIndex?: number; recentLimit?: number }) => data)
  .handler(async ({ data }: { data: { userIds: number[]; batchSize?: number; batchIndex?: number; recentLimit?: number } }) => {
    edgeCache(30, 120);
    return fetchCountryRecentScoresWithGains(data.userIds, data);
  });

// ── Maps (aggregated most-played + favourites across CR players) ───────────

async function fetchUserMostPlayed(userId: number): Promise<BeatmapPlaycount[]> {
  const cacheKey = `user-most-played:${userId}`;
  return fetchWithCacheLock(cacheKey, USER_MOST_PLAYED_CACHE_TTL, () =>
    osuFetch<BeatmapPlaycount[]>(
      `/users/${userId}/beatmapsets/most_played`,
      { limit: 100, offset: 0 },
      { caller: "fetchUserMostPlayed" },
    ),
  );
}

async function fetchUserFavourites(userId: number): Promise<OsuBeatmapset[]> {
  const cacheKey = `user-favourites-all:${userId}`;
  return fetchWithCacheLock(cacheKey, USER_FAVOURITES_CACHE_TTL, async () => {
    const all: OsuBeatmapset[] = [];
    for (let page = 0; page < USER_FAVOURITES_MAX_PAGES; page++) {
      const batch = await osuFetch<OsuBeatmapset[]>(
        `/users/${userId}/beatmapsets/favourite`,
        { limit: USER_FAVOURITES_PAGE_SIZE, offset: page * USER_FAVOURITES_PAGE_SIZE },
        { caller: "fetchUserFavourites" },
      );
      all.push(...batch);
      if (batch.length < USER_FAVOURITES_PAGE_SIZE) break;
    }
    return all;
  });
}

type MapsUser = { id: number; username: string; avatar_url: string };

const MAPS_REBUILD_LOCK_TTL_MS = 60_000;
const MAPS_ORPHAN_CLEANUP_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAPS_MAX_USERS = 100;
const MAPS_MAX_USERNAME_LENGTH = 64;
const MAPS_MAX_AVATAR_URL_LENGTH = 512;

function normalizeMapsUserId(value: unknown): number | null {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0 || id > 1_000_000_000) return null;
  return id;
}

function normalizeMapsUsers(users: unknown): MapsUser[] {
  if (!Array.isArray(users)) {
    throw new Error("Invalid maps users payload.");
  }
  if (users.length > MAPS_MAX_USERS) {
    throw new Error(`Maps requests are limited to ${MAPS_MAX_USERS} users.`);
  }

  const out: MapsUser[] = [];
  const seen = new Set<number>();

  for (const raw of users) {
    if (!raw || typeof raw !== "object") continue;
    const input = raw as Partial<MapsUser>;
    const id = normalizeMapsUserId(input.id);
    if (!id || seen.has(id)) continue;

    seen.add(id);
    out.push({
      id,
      username: String(input.username ?? "Unknown").slice(0, MAPS_MAX_USERNAME_LENGTH),
      avatar_url: String(input.avatar_url ?? "").slice(0, MAPS_MAX_AVATAR_URL_LENGTH),
    });
  }

  return out;
}

function normalizeMapsUserPayload(data: { users?: unknown }): { users: MapsUser[] } {
  return { users: normalizeMapsUsers(data?.users) };
}

function normalizeMapsUserRebuildPayload(data: { users?: unknown; userId?: unknown }): {
  users: MapsUser[];
  userId: number;
} {
  const users = normalizeMapsUsers(data?.users);
  const userId = normalizeMapsUserId(data?.userId);
  if (!userId) {
    throw new Error("Invalid maps rebuild user.");
  }
  if (!users.some((user) => user.id === userId)) {
    throw new Error("Maps rebuild user must be present in the bounded users payload.");
  }
  return { users, userId };
}

function computeMapsUserKey(users: MapsUser[]): string {
  return users
    .map((user) => user.id)
    .sort((a, b) => a - b)
    .join(",");
}

function computeMapsFarmedCacheKey(users: MapsUser[]): string {
  return `country-maps-farmed:v${MAPS_DATA_CACHE_VERSION}:${computeMapsUserKey(users)}`;
}

function computeMapsFavouritesCacheKey(users: MapsUser[]): string {
  return `country-maps-favourites:v${MAPS_DATA_CACHE_VERSION}:${computeMapsUserKey(users)}`;
}

export interface CountryMapsFarmedSection {
  farmed: MapsFarmedEntry[];
  generatedAt: string;
}

export interface CountryMapsFavouritesSection {
  mostPlayed: MapsAggregatedBeatmap[];
  favourites: MapsAggregatedFavourite[];
  favouritesByPlayer: MapsPlayerFavourites[];
  beatmapsetsPool: Record<number, MapsFavouriteBeatmapset>;
  generatedAt: string;
}

async function buildCountryFarmed(users: MapsUser[]): Promise<CountryMapsFarmedSection> {
      const userResults = await mapWithConcurrency(
        users,
        MAPS_FETCH_CONCURRENCY,
        async (user) => {
          const bestScores = await fetchUserBestScoresWindow(user.id, 200).catch(() => [] as OsuScore[]);
          return { user, bestScores };
        },
      );

      // ── Farmed: maps in 2+ players' top 200 best scores ──────────
      const farmedMap = new Map<number, MapsFarmedEntry>();
      for (const { user, bestScores } of userResults) {
        for (const score of bestScores) {
          if (!score.beatmap || score.beatmap.mode !== "mania") continue;
          if (!score.pp || score.pp <= 0) continue;
          if (score.beatmapset?.status !== "ranked") continue;

          const bid = score.beatmap.id;
          const existing = farmedMap.get(bid);
          if (existing) {
            if (!existing.players.some((p) => p.id === user.id)) {
              existing.playerCount++;
              existing.players.push({
                id: user.id,
                username: user.username,
                avatarUrl: user.avatar_url,
                mods: getModAcronyms(score.mods),
                pp: score.pp,
                scoreUrl: getScoreUrl(score),
                playedAt: getScoreTimestamp(score),
              });
              existing.maxPp = Math.max(existing.maxPp, score.pp);
            }
          } else {
            farmedMap.set(bid, {
              beatmapId: bid,
              version: score.beatmap.version,
              difficultyRating: score.beatmap.difficulty_rating,
              totalLength: score.beatmap.total_length,
              cs: score.beatmap.cs,
              bpm: score.beatmap.bpm,
              beatmapsetId: score.beatmapset.id,
              title: score.beatmapset.title,
              artist: score.beatmapset.artist,
              creator: score.beatmapset.creator,
              covers: score.beatmapset.covers,
              status: score.beatmapset.status,
              playerCount: 1,
              players: [
                {
                  id: user.id,
                  username: user.username,
                  avatarUrl: user.avatar_url,
                  mods: getModAcronyms(score.mods),
                  pp: score.pp,
                  scoreUrl: getScoreUrl(score),
                  playedAt: getScoreTimestamp(score),
                },
              ],
              avgPp: 0,
              maxPp: score.pp,
            });
          }
        }
      }

      const farmed: MapsFarmedEntry[] = [];
      for (const entry of farmedMap.values()) {
        if (entry.playerCount < 2 && entry.maxPp < FARMED_SINGLE_PLAYER_PP_MIN) continue;
        entry.players.sort((a, b) => b.pp - a.pp);
        entry.avgPp =
          entry.players.reduce((sum, p) => sum + p.pp, 0) / entry.players.length;
        farmed.push(entry);
      }
      farmed.sort((a, b) => b.playerCount - a.playerCount || b.avgPp - a.avgPp);

      return { farmed, generatedAt: new Date().toISOString() };
}

async function buildCountryFavourites(users: MapsUser[]): Promise<CountryMapsFavouritesSection> {
      const userResults = await mapWithConcurrency(
        users,
        MAPS_FETCH_CONCURRENCY,
        async (user) => {
          const [mostPlayed, favourites] = await Promise.all([
            fetchUserMostPlayed(user.id).catch(() => [] as BeatmapPlaycount[]),
            fetchUserFavourites(user.id).catch(() => [] as OsuBeatmapset[]),
          ]);
          return { user, mostPlayed, favourites };
        },
      );

      // ── Most played: from most_played endpoint (mania only) ──────
      const mpMap = new Map<number, MapsAggregatedBeatmap>();
      for (const { user, mostPlayed } of userResults) {
        for (const mp of mostPlayed) {
          if (mp.beatmap.mode !== "mania") continue;
          const existing = mpMap.get(mp.beatmap_id);
          if (existing) {
            existing.totalPlays += mp.count;
            existing.playerCount++;
            existing.players.push({
              id: user.id,
              username: user.username,
              avatarUrl: user.avatar_url,
              count: mp.count,
            });
          } else {
            mpMap.set(mp.beatmap_id, {
              beatmapId: mp.beatmap_id,
              version: mp.beatmap.version,
              difficultyRating: mp.beatmap.difficulty_rating,
              totalLength: mp.beatmap.total_length,
              beatmapsetId: mp.beatmapset.id,
              title: mp.beatmapset.title,
              artist: mp.beatmapset.artist,
              creator: mp.beatmapset.creator,
              covers: mp.beatmapset.covers,
              status: mp.beatmapset.status,
              globalPlayCount: mp.beatmapset.play_count,
              totalPlays: mp.count,
              playerCount: 1,
              players: [
                {
                  id: user.id,
                  username: user.username,
                  avatarUrl: user.avatar_url,
                  count: mp.count,
                },
              ],
            });
          }
        }
      }

      for (const entry of mpMap.values()) {
        entry.players.sort((a, b) => b.count - a.count);
      }

      const mostPlayed = [...mpMap.values()]
        .filter((m) => m.playerCount >= 2)
        .sort((a, b) => b.playerCount - a.playerCount || b.totalPlays - a.totalPlays)
        .slice(0, 200);

      // ── Favourites (mania-only) ──────────────────────────────────
      const favMap = new Map<number, MapsAggregatedFavourite>();
      const beatmapsetsPool: Record<number, MapsFavouriteBeatmapset> = {};
      const favouritesByPlayer: MapsPlayerFavourites[] = [];
      for (const { user, favourites } of userResults) {
        const playerIds: number[] = [];
        for (const fav of favourites) {
          const maniaBeatmaps = (fav.beatmaps ?? []).filter((bm) => bm.mode === "mania");
          if (maniaBeatmaps.length === 0) continue;

          playerIds.push(fav.id);

          if (!beatmapsetsPool[fav.id]) {
            const maniaKeysSet = new Set<number>();
            for (const bm of maniaBeatmaps) {
              if (typeof bm.cs === "number") maniaKeysSet.add(bm.cs);
            }
            const stars = maniaBeatmaps
              .map((bm) => bm.difficulty_rating)
              .filter((s): s is number => typeof s === "number" && Number.isFinite(s));
            const starMin = stars.length ? Math.min(...stars) : 0;
            const starMax = stars.length ? Math.max(...stars) : 0;
            const versionNames = maniaBeatmaps.map((bm) => bm.version ?? "");
            const patterns = detectManiaPatterns(fav.tags ?? "", versionNames, fav.title ?? "");

            beatmapsetsPool[fav.id] = {
              id: fav.id,
              title: fav.title,
              artist: fav.artist,
              creator: fav.creator,
              covers: fav.covers,
              status: fav.status,
              globalPlayCount: fav.play_count,
              globalFavouriteCount: fav.favourite_count,
              previewUrl: fav.preview_url,
              maniaKeys: [...maniaKeysSet].sort((a, b) => a - b),
              maniaBeatmaps: maniaBeatmaps
                .map((bm) => ({
                  id: bm.id,
                  version: bm.version,
                  difficultyRating: bm.difficulty_rating,
                  totalLength: bm.total_length,
                  cs: bm.cs,
                }))
                .sort((a, b) => b.difficultyRating - a.difficultyRating),
              starMin,
              starMax,
              bpm: typeof fav.bpm === "number" ? fav.bpm : 0,
              patterns,
            };
          }

          const existing = favMap.get(fav.id);
          if (existing) {
            existing.playerCount++;
            existing.players.push({
              id: user.id,
              username: user.username,
              avatarUrl: user.avatar_url,
            });
          } else {
            favMap.set(fav.id, {
              beatmapsetId: fav.id,
              title: fav.title,
              artist: fav.artist,
              creator: fav.creator,
              covers: fav.covers,
              status: fav.status,
              globalPlayCount: fav.play_count,
              globalFavouriteCount: fav.favourite_count,
              playerCount: 1,
              players: [
                {
                  id: user.id,
                  username: user.username,
                  avatarUrl: user.avatar_url,
                },
              ],
            });
          }
        }

        if (playerIds.length > 0) {
          favouritesByPlayer.push({
            id: user.id,
            username: user.username,
            avatarUrl: user.avatar_url,
            beatmapsetIds: playerIds,
          });
        }
      }

      const favourites = [...favMap.values()]
        .filter((f) => f.playerCount >= 2)
        .sort(
          (a, b) =>
            b.playerCount - a.playerCount ||
            b.globalFavouriteCount - a.globalFavouriteCount,
        )
        .slice(0, 100);

      return {
        mostPlayed,
        favourites,
        favouritesByPlayer,
        beatmapsetsPool,
        generatedAt: new Date().toISOString(),
      };
}

export function composeCountryMapsData(
  farmedSection: CountryMapsFarmedSection,
  favSection: CountryMapsFavouritesSection,
): CountryMapsData {
  const farmedAt = farmedSection.generatedAt;
  const favAt = favSection.generatedAt;
  return {
    farmed: farmedSection.farmed,
    mostPlayed: favSection.mostPlayed,
    favourites: favSection.favourites,
    favouritesByPlayer: favSection.favouritesByPlayer,
    beatmapsetsPool: favSection.beatmapsetsPool,
    generatedAt: farmedAt < favAt ? farmedAt : favAt,
    farmedGeneratedAt: farmedAt,
    favouritesGeneratedAt: favAt,
  };
}

export const getCountryMapsData = createServerFn({ method: "GET" })
  .inputValidator(normalizeMapsUserPayload)
  .handler(async ({ data }: { data: { users: MapsUser[] } }) => {
    edgeCache(3600, 86400);
    const farmedKey = computeMapsFarmedCacheKey(data.users);
    const favKey = computeMapsFavouritesCacheKey(data.users);
    const [farmedRes, favRes] = await Promise.all([
      fetchWithStaleAllowed<CountryMapsFarmedSection>(
        farmedKey,
        MAPS_FARMED_CACHE_TTL,
        () => buildCountryFarmed(data.users),
        MAPS_REBUILD_LOCK_TTL_MS,
      ),
      fetchWithStaleAllowed<CountryMapsFavouritesSection>(
        favKey,
        MAPS_FAVOURITES_CACHE_TTL,
        () => buildCountryFavourites(data.users),
        MAPS_REBUILD_LOCK_TTL_MS,
      ),
    ]);
    return {
      value: composeCountryMapsData(farmedRes.value, favRes.value),
      isStale: farmedRes.isStale || favRes.isStale,
    };
  });

export const rebuildCountryMapsData = createServerFn({ method: "POST" })
  .inputValidator(normalizeMapsUserPayload)
  .handler(async ({ data }: { data: { users: MapsUser[] } }) => {
    const farmedKey = computeMapsFarmedCacheKey(data.users);
    const favKey = computeMapsFavouritesCacheKey(data.users);
    const [farmedRebuild, favRebuild] = await Promise.all([
      runCacheRebuild<CountryMapsFarmedSection>(
        farmedKey,
        MAPS_FARMED_CACHE_TTL,
        async () => {
          const result = await buildCountryFarmed(data.users);
          await deleteExpiredCacheEntriesByPrefix(
            "country-maps-farmed:",
            MAPS_ORPHAN_CLEANUP_AGE_MS,
          );
          return result;
        },
        MAPS_REBUILD_LOCK_TTL_MS,
      ),
      runCacheRebuild<CountryMapsFavouritesSection>(
        favKey,
        MAPS_FAVOURITES_CACHE_TTL,
        async () => {
          const result = await buildCountryFavourites(data.users);
          await deleteExpiredCacheEntriesByPrefix(
            "country-maps-favourites:",
            MAPS_ORPHAN_CLEANUP_AGE_MS,
          );
          // Clean out legacy single-blob entries from before the split.
          await deleteExpiredCacheEntriesByPrefix(
            "country-maps-data:",
            MAPS_ORPHAN_CLEANUP_AGE_MS,
          );
          return result;
        },
        MAPS_REBUILD_LOCK_TTL_MS,
      ),
    ]);
    const farmedValue = farmedRebuild.value;
    const favValue = favRebuild.value;
    return {
      rebuilt: farmedRebuild.rebuilt || favRebuild.rebuilt,
      value: farmedValue && favValue ? composeCountryMapsData(farmedValue, favValue) : null,
    };
  });

// Per-section exports so the client can fetch farmed and favourites in parallel
// and show incremental progress as each completes.
export const getCountryMapsFarmed = createServerFn({ method: "GET" })
  .inputValidator(normalizeMapsUserPayload)
  .handler(async ({ data }: { data: { users: MapsUser[] } }) => {
    edgeCache(3600, 86400);
    return fetchWithStaleAllowed<CountryMapsFarmedSection>(
      computeMapsFarmedCacheKey(data.users),
      MAPS_FARMED_CACHE_TTL,
      () => buildCountryFarmed(data.users),
      MAPS_REBUILD_LOCK_TTL_MS,
    );
  });

export const getCountryMapsFavourites = createServerFn({ method: "GET" })
  .inputValidator(normalizeMapsUserPayload)
  .handler(async ({ data }: { data: { users: MapsUser[] } }) => {
    edgeCache(3600, 86400);
    return fetchWithStaleAllowed<CountryMapsFavouritesSection>(
      computeMapsFavouritesCacheKey(data.users),
      MAPS_FAVOURITES_CACHE_TTL,
      () => buildCountryFavourites(data.users),
      MAPS_REBUILD_LOCK_TTL_MS,
    );
  });

export const rebuildCountryMapsFarmed = createServerFn({ method: "POST" })
  .inputValidator(normalizeMapsUserPayload)
  .handler(async ({ data }: { data: { users: MapsUser[] } }) => {
    return runCacheRebuild<CountryMapsFarmedSection>(
      computeMapsFarmedCacheKey(data.users),
      MAPS_FARMED_CACHE_TTL,
      async () => {
        const result = await buildCountryFarmed(data.users);
        await deleteExpiredCacheEntriesByPrefix(
          "country-maps-farmed:",
          MAPS_ORPHAN_CLEANUP_AGE_MS,
        );
        return result;
      },
      MAPS_REBUILD_LOCK_TTL_MS,
    );
  });

export const rebuildCountryMapsFavourites = createServerFn({ method: "POST" })
  .inputValidator(normalizeMapsUserPayload)
  .handler(async ({ data }: { data: { users: MapsUser[] } }) => {
    return runCacheRebuild<CountryMapsFavouritesSection>(
      computeMapsFavouritesCacheKey(data.users),
      MAPS_FAVOURITES_CACHE_TTL,
      async () => {
        const result = await buildCountryFavourites(data.users);
        await deleteExpiredCacheEntriesByPrefix(
          "country-maps-favourites:",
          MAPS_ORPHAN_CLEANUP_AGE_MS,
        );
        return result;
      },
      MAPS_REBUILD_LOCK_TTL_MS,
    );
  });

// Invalidate one player's per-user caches (favourites / most-played / best
// scores) and rebuild the country aggregate. Every other player's per-user
// data still hits the 6h cache, so only the target player is re-fetched from
// osu! — useful when a single player updates their favourites and you don't
// want to force-refresh the entire top 50.
export const rebuildCountryMapsForUser = createServerFn({ method: "POST" })
  .inputValidator(normalizeMapsUserRebuildPayload)
  .handler(async ({ data }: { data: { users: MapsUser[]; userId: number } }) => {
    await deletePersistentCacheEntries([
      `user-favourites-all:${data.userId}`,
      `user-most-played:${data.userId}`,
      `user-best-scores-window:${data.userId}:200`,
      `user-best-scores-window:${data.userId}:100`,
    ]);

    const farmedKey = computeMapsFarmedCacheKey(data.users);
    const favKey = computeMapsFavouritesCacheKey(data.users);
    const [farmedRebuild, favRebuild] = await Promise.all([
      runCacheRebuild<CountryMapsFarmedSection>(
        farmedKey,
        MAPS_FARMED_CACHE_TTL,
        () => buildCountryFarmed(data.users),
        MAPS_REBUILD_LOCK_TTL_MS,
      ),
      runCacheRebuild<CountryMapsFavouritesSection>(
        favKey,
        MAPS_FAVOURITES_CACHE_TTL,
        () => buildCountryFavourites(data.users),
        MAPS_REBUILD_LOCK_TTL_MS,
      ),
    ]);
    const farmedValue = farmedRebuild.value;
    const favValue = favRebuild.value;
    return {
      rebuilt: farmedRebuild.rebuilt || favRebuild.rebuilt,
      value: farmedValue && favValue ? composeCountryMapsData(farmedValue, favValue) : null,
    };
  });

// ── Replay (parsed server-side via osu-parsers) ────────────────────────────

export const getReplayParsed = createServerFn({ method: "GET" })
  .inputValidator((data: { scoreId: number; mode: string; keyCount?: number }) => data)
  .handler(async ({ data }: { data: { scoreId: number; mode: string; keyCount?: number } }) => {
    edgeCache(86400, 604800);
    const { ScoreDecoder } = await import("osu-parsers");
    let buffer: ArrayBuffer;
    try {
      // Try legacy (mode-prefixed) endpoint first — the scoreId from player pages
      // is a legacy ID, and the modern endpoint may resolve to a different score.
      buffer = await osuFetchBinary(`/scores/${data.mode}/${data.scoreId}/download`, {
        caller: "getReplayParsed:legacy",
      });
    } catch {
      buffer = await osuFetchBinary(`/scores/${data.scoreId}/download`, {
        caller: "getReplayParsed:modern",
      });
    }
    const decoder = new ScoreDecoder();
    const score = await decoder.decodeFromBuffer(Buffer.from(buffer));

    const info = score.info;
    const rawFrames = (score.replay?.frames ?? []) as any[];
    const replayScrollY = rawFrames
      .map((f: any) => Number(f.mouseY ?? f.position?.y))
      .find((value: number) => Number.isFinite(value) && value > 0);

    // Pack frames into typed arrays to shrink the wire payload ~20x vs JSON.
    // Little-endian host is assumed (every x86/ARM server and client is LE).
    // For mania, column bitmask is in mouseX (position.x), NOT buttonState.
    const frameCount = rawFrames.length;
    const times = new Int32Array(frameCount);
    const keys = new Uint16Array(frameCount);
    for (let i = 0; i < frameCount; i++) {
      const f = rawFrames[i];
      times[i] = f.startTime | 0;
      keys[i] = Math.round(f.mouseX ?? f.position?.x ?? f.buttonState ?? 0) & 0xffff;
    }

    // Detect key count: prefer beatmap CS from score API, fall back to OR of all frames
    let keyCount = data.keyCount ?? 0;
    if (!keyCount) {
      let allBits = 0;
      for (let i = 0; i < frameCount; i++) allBits |= keys[i];
      let maxBit = 0;
      let tmp = allBits;
      while (tmp > 0) { maxBit++; tmp >>= 1; }
      keyCount = Math.max(maxBit, 4);
    }

    const timesB64 = Buffer.from(times.buffer, times.byteOffset, times.byteLength).toString("base64");
    const keysB64 = Buffer.from(keys.buffer, keys.byteOffset, keys.byteLength).toString("base64");

    return {
      header: {
        playerName: info?.username ?? "Unknown",
        gameMode: info?.rulesetId ?? 3,
        totalScore: info?.totalScore ?? 0,
        maxCombo: info?.maxCombo ?? 0,
        count300: info?.count300 ?? 0,
        count100: info?.count100 ?? 0,
        count50: info?.count50 ?? 0,
        countGeki: info?.countGeki ?? 0,
        countKatu: info?.countKatu ?? 0,
        countMiss: info?.countMiss ?? 0,
        isPerfect: info?.perfect ?? false,
      },
      framesPacked: { count: frameCount, times: timesB64, keys: keysB64 },
      keyCount,
      replayScrollY,
    };
  });

export const getBeatmapFile = createServerFn({ method: "GET" })
  .inputValidator((data: { beatmapId: number }) => data)
  .handler(async ({ data }: { data: { beatmapId: number } }) => {
    noStore();
    const osuFile = await fetchBeatmapFile(data.beatmapId);
    return { content: osuFile };
  });

export const getScore = createServerFn({ method: "GET" })
  .inputValidator((data: { scoreId: number; mode?: string }) => data)
  .handler(async ({ data }: { data: { scoreId: number; mode?: string } }) => {
    edgeCache(300, 1800);
    const mode = data.mode ?? "mania";

    try {
      const legacyScore = await osuFetch<OsuScore>(
        `/scores/${mode}/${data.scoreId}`,
        undefined,
        { caller: "getScore:legacy" },
      );
      const resolvedMode = legacyScore.beatmap?.mode ?? mode;
      if (resolvedMode === mode) {
        return legacyScore;
      }
    } catch {
      // Fall back to modern score lookup below.
    }

    return osuFetch<OsuScore>(`/scores/${data.scoreId}`, undefined, {
      caller: "getScore:modern",
    });
  });

// ── Snipes (per-beatmap country leaderboard #1 changes) ─────────────────────

async function fetchUserRecentPlays(userId: number): Promise<OsuScore[]> {
  const cacheKey = `user-recent-plays:mania:${userId}`;
  const cached = await getPersistentCached<OsuScore[]>(cacheKey);
  if (cached) return cached;

  const pending = userRecentPlaysPromiseCache.get(userId);
  if (pending) return pending;

  const request = fetchWithCacheLock(cacheKey, SNIPES_RECENT_PLAYS_CACHE_TTL, () =>
    osuFetch<OsuScore[]>(
      `/users/${userId}/scores/recent`,
      getScoreRequestParams(userId, {
        mode: "mania",
        limit: SNIPES_RECENT_LIMIT,
        offset: 0,
        include_fails: 0,
      }),
      { caller: "fetchUserRecentPlays" },
    ),
  ).finally(() => {
    userRecentPlaysPromiseCache.delete(userId);
  });

  userRecentPlaysPromiseCache.set(userId, request);
  return request;
}

function boardScoreFromScore(score: OsuScore): CountryBoardScore | null {
  if (!score.user) return null;
  const display = getScoreDisplayValues(score);
  const totalScore = display.totalScore ?? score.total_score ?? score.score ?? 0;
  return {
    userId: score.user.id,
    username: score.user.username,
    avatarUrl: score.user.avatar_url,
    scoreId: score.id,
    totalScore,
    accuracy: display.accuracy,
    mods: getModAcronyms(score.mods),
    pp: score.pp,
    rank: display.rank,
    isLazer: display.isLazer,
    hasReplay: score.has_replay ?? score.replay ?? false,
    endedAt: getScoreTimestamp(score),
  };
}

type BoardMeta = Pick<CountryBoardSnapshotEntry, "beatmap" | "beatmapset">;

function boardMetadataFromScore(
  score: OsuScore,
  fallbackBeatmapset?: OsuScore["beatmapset"],
): BoardMeta | null {
  const beatmap = score.beatmap;
  const beatmapset = score.beatmapset ?? fallbackBeatmapset;
  if (!beatmap || !beatmapset) return null;
  return {
    beatmap: {
      version: beatmap.version,
      difficulty_rating: beatmap.difficulty_rating,
      cs: beatmap.cs,
      url: beatmap.url ?? `https://osu.ppy.sh/beatmaps/${beatmap.id}`,
    },
    beatmapset: {
      id: beatmapset.id,
      title: beatmapset.title,
      artist: beatmapset.artist,
      cover_url: beatmapset.covers?.["cover@2x"] ?? beatmapset.covers?.cover ?? "",
    },
  };
}

function buildSnipeEvent(
  beatmapId: number,
  meta: BoardMeta,
  sniper: CountryBoardScore,
  victim: CountryBoardScore,
  boardRank: number,
  isSeeded = false,
): SnipeEvent {
  return {
    beatmap_id: beatmapId,
    beatmapset_id: meta.beatmapset.id,
    score_id: sniper.scoreId,
    sniper: {
      id: sniper.userId,
      username: sniper.username,
      avatar_url: sniper.avatarUrl,
    },
    victim: {
      id: victim.userId,
      username: victim.username,
      avatar_url: victim.avatarUrl,
    },
    beatmap: meta.beatmap,
    beatmapset: meta.beatmapset,
    totalScore: sniper.totalScore,
    accuracy: sniper.accuracy,
    mods: sniper.mods,
    pp: sniper.pp,
    rank: sniper.rank,
    isLazer: sniper.isLazer,
    hasReplay: sniper.hasReplay,
    timestamp: sniper.endedAt,
    victimTimestamp: victim.endedAt,
    victimTotalScore: victim.totalScore,
    victimPp: victim.pp,
    detectedAt: Date.now(),
    boardRank,
    ...(isSeeded ? { isSeeded: true } : {}),
  };
}

interface SnipesRosterPlayer {
  id: number;
  username: string;
  avatar_url: string;
}

async function probeCountryBoardLanes(
  beatmapId: number,
  roster: SnipesRosterPlayer[],
  meta: BoardMeta,
): Promise<Record<string, CountryBoardSnapshotEntry> | null> {
  // getBeatmapUserScoresAll returns every score the user has on the map
  // (different mod sets, lazer/stable splits, etc). We need all of them so
  // we can segment by lane — getBeatmapUserScore only returns the user's
  // single "best" score and would collapse lanes.
  //
  // Note: this endpoint does NOT embed `user` on each returned score
  // (only `user_id`), nor does it include beatmap/beatmapset. That's why
  // we receive roster players and beatmap meta from the caller instead of
  // deriving them from the response.
  const perUserResults = await mapWithConcurrency(
    roster,
    SNIPES_PROBE_CONCURRENCY,
    async (player) => {
      try {
        const scores = await getBeatmapUserScoresAll(beatmapId, player.id);
        return { player, scores };
      } catch {
        return { player, scores: [] as OsuScore[] };
      }
    },
  );

  // For each (user, lane), compute the best play AND the best prior play
  // (highest totalScore with endedAt strictly before the best's endedAt). The
  // prior-best lets the seed heuristic detect self-improvement false positives
  // without needing cross-scan history.
  const perLane = new Map<string, Map<number, CountryBoardScore>>();
  for (const { player, scores } of perUserResults) {
    // Group this user's scores by lane first so prior-best stays lane-scoped.
    const byLane = new Map<string, { score: OsuScore; totalScore: number; endedAtMs: number }[]>();
    for (const score of scores) {
      if (!score) continue;
      const display = getScoreDisplayValues(score);
      const totalScore = display.totalScore ?? score.total_score ?? score.score ?? 0;
      if (totalScore <= 0) continue;
      const mods = getModAcronyms(score.mods);
      const lane = getBoardLaneKey(mods, display.isLazer);
      const endedAtMs = new Date(getScoreTimestamp(score)).getTime();
      if (!byLane.has(lane)) byLane.set(lane, []);
      byLane.get(lane)!.push({ score, totalScore, endedAtMs });
    }

    for (const [lane, entries] of byLane) {
      if (entries.length === 0) continue;
      entries.sort((a, b) => b.totalScore - a.totalScore);
      const best = entries[0];
      const display = getScoreDisplayValues(best.score);

      let priorBestTotalScore: number | undefined;
      if (Number.isFinite(best.endedAtMs)) {
        for (let i = 1; i < entries.length; i++) {
          const e = entries[i];
          if (!Number.isFinite(e.endedAtMs) || e.endedAtMs >= best.endedAtMs) continue;
          if (priorBestTotalScore == null || e.totalScore > priorBestTotalScore) {
            priorBestTotalScore = e.totalScore;
          }
        }
      }

      const board: CountryBoardScore = {
        userId: player.id,
        username: player.username,
        avatarUrl: player.avatar_url,
        scoreId: best.score.id,
        totalScore: best.totalScore,
        accuracy: display.accuracy,
        mods: getModAcronyms(best.score.mods),
        pp: best.score.pp,
        rank: display.rank,
        isLazer: display.isLazer,
        hasReplay: best.score.has_replay ?? best.score.replay ?? false,
        endedAt: getScoreTimestamp(best.score),
        ...(priorBestTotalScore != null ? { priorBestTotalScore } : {}),
      };

      let users = perLane.get(lane);
      if (!users) {
        users = new Map();
        perLane.set(lane, users);
      }
      users.set(board.userId, board);
    }
  }

  if (perLane.size === 0) return null;

  const entries: Record<string, CountryBoardSnapshotEntry> = {};
  const now = Date.now();
  for (const [lane, users] of perLane) {
    const scores = [...users.values()].sort((a, b) => b.totalScore - a.totalScore);
    entries[lane] = {
      ...meta,
      scores,
      lastTouchedAt: now,
    };
  }

  return entries;
}

const snipesBackgroundScanInProgress = new Set<string>();

function refreshCountrySnipesInBackground(
  country: string,
  cacheKey: string,
  snapshotKey: string,
  logKey: string,
): void {
  if (snipesBackgroundScanInProgress.has(country)) return;
  snipesBackgroundScanInProgress.add(country);
  let ranScan = false;
  void fetchWithCacheLock(
    cacheKey,
    SNIPES_CACHE_TTL,
    () => {
      ranScan = true;
      return runSnipesScan(country, snapshotKey, logKey);
    },
    SNIPES_LOCK_TTL,
  )
    .catch((err) => console.warn("[snipes] background scan failed:", getErrorMessage(err)))
    .finally(() => {
      if (ranScan) {
        clearSnipesScanStatus(country);
        clearPartialSnipeEvents(country);
      }
      snipesBackgroundScanInProgress.delete(country);
    });
}

async function runSnipesScan(
  country: string,
  snapshotKey: string,
  logKey: string,
): Promise<SnipesResponse> {
  try {
    clearPartialSnipeEvents(country);
    writeSnipesScanStatus(
      country,
      { phase: "roster", label: "Fetching country roster", current: 0, total: 1 },
      { force: true },
    );
    const rankings = await getRankings({ data: { type: "performance", page: 1, country } });
    const players = rankings.ranking
      .filter((entry) => entry.user.is_active !== false)
      .slice(0, SNIPES_PLAYER_LIMIT)
      .map((entry) => ({
        id: entry.user.id,
        username: entry.user.username,
        avatar_url: entry.user.avatar_url,
      }));

    if (players.length === 0) {
      clearSnipesScanStatus(country);
      clearPartialSnipeEvents(country);
      return { events: [], scannedAt: Date.now() };
    }

    writeSnipesScanStatus(
      country,
      {
        phase: "recent",
        label: `Loading recent plays from top ${players.length} players`,
        current: 0,
        total: players.length,
      },
      { force: true },
    );

    let recentDone = 0;
    const recentByPlayer = await mapWithConcurrency(
      players,
      SNIPES_SCAN_CONCURRENCY,
      async (player) => {
        try {
          const scores = await fetchUserRecentPlays(player.id);
          return { player, scores };
        } catch (error) {
          console.warn("[osu] failed to fetch recent plays for snipes scan", {
            playerId: player.id,
            error: getErrorMessage(error),
          });
          return { player, scores: [] as OsuScore[] };
        } finally {
          recentDone += 1;
          writeSnipesScanStatus(country, {
            phase: "recent",
            label: `Loading recent plays from top ${players.length} players`,
            current: recentDone,
            total: players.length,
          });
        }
      },
    );

    const candidates: OsuScore[] = [];
    for (const { scores } of recentByPlayer) {
      for (const score of scores) {
        if (!score.passed) continue;
        if (!score.beatmap || !score.beatmapset || !score.user) continue;
        if (score.beatmap.mode !== "mania") continue;
        if (!SNIPES_RANKED_STATUSES.has(score.beatmapset.status)) continue;
        candidates.push(score);
      }
    }

    const snapshot: CountryBoardSnapshot =
      (await getPersistentCached<CountryBoardSnapshot>(snapshotKey)) ?? {};

    const newEvents: SnipeEvent[] = [];
    const seedQueue: { beatmapId: number; bestCandidate: OsuScore }[] = [];

    const candidatesByBeatmap = new Map<number, OsuScore[]>();
    for (const score of candidates) {
      const bid = score.beatmap.id;
      let bucket = candidatesByBeatmap.get(bid);
      if (!bucket) {
        bucket = [];
        candidatesByBeatmap.set(bid, bucket);
      }
      bucket.push(score);
    }

    const compareTotal = candidatesByBeatmap.size;
    const compareLabel = `Comparing ${candidates.length} recent plays across ${compareTotal} beatmap${compareTotal === 1 ? "" : "s"}`;
    writeSnipesScanStatus(
      country,
      {
        phase: "compare",
        label: compareLabel,
        current: 0,
        total: compareTotal,
      },
      { force: true },
    );

    let compareDone = 0;
    for (const [bid, scoresForMap] of candidatesByBeatmap.entries()) {
      scoresForMap.sort((a, b) => {
        const aMs = new Date(getScoreTimestamp(a)).getTime();
        const bMs = new Date(getScoreTimestamp(b)).getTime();
        return aMs - bMs;
      });

      const existingLanes = snapshot[bid];
      if (!existingLanes || Object.keys(existingLanes).length === 0) {
        let bestCandidate = scoresForMap[0];
        let bestTotal = boardScoreFromScore(bestCandidate)?.totalScore ?? 0;
        for (const s of scoresForMap.slice(1)) {
          const t = boardScoreFromScore(s)?.totalScore ?? 0;
          if (t > bestTotal) {
            bestCandidate = s;
            bestTotal = t;
          }
        }
        seedQueue.push({ beatmapId: bid, bestCandidate });
        compareDone += 1;
        writeSnipesScanStatus(country, {
          phase: "compare",
          label: compareLabel,
          current: compareDone,
          total: compareTotal,
        });
        continue;
      }

      let lanesForBid: Record<string, CountryBoardSnapshotEntry> = { ...existingLanes };
      const anyLaneMeta: BoardMeta | null = (() => {
        const first = Object.values(existingLanes)[0];
        return first ? { beatmap: first.beatmap, beatmapset: first.beatmapset } : null;
      })();

      for (const score of scoresForMap) {
        const newScore = boardScoreFromScore(score);
        if (!newScore) continue;
        const lane = getBoardLaneKey(newScore.mods, newScore.isLazer);
        const entry = lanesForBid[lane];

        if (!entry) {
          const meta = boardMetadataFromScore(score) ?? anyLaneMeta;
          if (!meta) continue;
          lanesForBid = {
            ...lanesForBid,
            [lane]: { ...meta, scores: [newScore], lastTouchedAt: Date.now() },
          };
          continue;
        }

        const oldIdx = entry.scores.findIndex((s) => s.userId === newScore.userId);
        if (oldIdx >= 0 && entry.scores[oldIdx].totalScore >= newScore.totalScore) {
          continue;
        }

        const withoutPlayer =
          oldIdx >= 0 ? entry.scores.filter((_, i) => i !== oldIdx) : entry.scores;
        const newSorted = [...withoutPlayer, newScore].sort(
          (a, b) => b.totalScore - a.totalScore,
        );
        const newIdx = newSorted.findIndex((s) => s.userId === newScore.userId);

        const movedUp =
          oldIdx < 0 ? newIdx < entry.scores.length : newIdx < oldIdx;
        if (movedUp) {
          const victim = entry.scores[newIdx];
          if (victim && victim.userId !== newScore.userId) {
            newEvents.push(
              buildSnipeEvent(
                bid,
                { beatmap: entry.beatmap, beatmapset: entry.beatmapset },
                newScore,
                victim,
                newIdx + 1,
              ),
            );
          }
        }

        lanesForBid = {
          ...lanesForBid,
          [lane]: { ...entry, scores: newSorted, lastTouchedAt: Date.now() },
        };
      }

      snapshot[bid] = lanesForBid;
      compareDone += 1;
      writeSnipesScanStatus(country, {
        phase: "compare",
        label: compareLabel,
        current: compareDone,
        total: compareTotal,
      });
    }

    if (newEvents.length > 0) writePartialSnipeEvents(country, newEvents);

    if (seedQueue.length > 0) {
      seedQueue.sort((a, b) => {
        const aMs = new Date(getScoreTimestamp(a.bestCandidate)).getTime();
        const bMs = new Date(getScoreTimestamp(b.bestCandidate)).getTime();
        return bMs - aMs;
      });
      const probeBatch = seedQueue.slice(0, SNIPES_SEED_PROBE_BUDGET);
      const skipped = seedQueue.slice(SNIPES_SEED_PROBE_BUDGET);

      for (const { beatmapId, bestCandidate } of skipped) {
        const score = boardScoreFromScore(bestCandidate);
        const meta = boardMetadataFromScore(bestCandidate);
        if (score && meta) {
          const lane = getBoardLaneKey(score.mods, score.isLazer);
          snapshot[beatmapId] = {
            [lane]: {
              ...meta,
              scores: [score],
              lastTouchedAt: Date.now(),
            },
          };
        }
      }

      writeSnipesScanStatus(
        country,
        {
          phase: "seed",
          label: `Checking ${probeBatch.length} new beatmap${probeBatch.length === 1 ? "" : "s"}`,
          current: 0,
          total: probeBatch.length,
        },
        { force: true },
      );

      let seedDone = 0;
      const seedCutoff = Date.now() - SNIPES_SEED_MAX_AGE_MS;
      await mapWithConcurrency(
        probeBatch,
        SNIPES_SCAN_CONCURRENCY,
        async ({ beatmapId, bestCandidate }) => {
          try {
            const meta = boardMetadataFromScore(bestCandidate);
            if (!meta) return;
            const lanes = await probeCountryBoardLanes(beatmapId, players, meta);
            if (!lanes || Object.keys(lanes).length === 0) return;
            snapshot[beatmapId] = lanes;

            const userHasOlderScore = new Map<number, number>();
            for (const entry of Object.values(lanes)) {
              for (const s of entry.scores) {
                const ms = new Date(s.endedAt).getTime();
                if (!Number.isFinite(ms)) continue;
                const prev = userHasOlderScore.get(s.userId);
                if (prev == null || ms < prev) userHasOlderScore.set(s.userId, ms);
              }
            }

            for (const entry of Object.values(lanes)) {
              for (let i = 0; i < entry.scores.length - 1; i++) {
                const top = entry.scores[i];
                const next = entry.scores[i + 1];
                if (top.userId === next.userId) continue;
                const topMs = new Date(top.endedAt).getTime();
                const nextMs = new Date(next.endedAt).getTime();
                if (!Number.isFinite(topMs) || !Number.isFinite(nextMs)) continue;
                if (topMs <= nextMs) continue;
                if (topMs < seedCutoff) continue;
                if (
                  top.priorBestTotalScore != null &&
                  top.priorBestTotalScore > next.totalScore
                ) {
                  continue;
                }
                const oldestForSniper = userHasOlderScore.get(top.userId);
                if (oldestForSniper != null && oldestForSniper < topMs) continue;
                newEvents.push(
                  buildSnipeEvent(
                    beatmapId,
                    { beatmap: entry.beatmap, beatmapset: entry.beatmapset },
                    top,
                    next,
                    i + 1,
                    true,
                  ),
                );
              }
            }
            writePartialSnipeEvents(country, newEvents);
          } catch (error) {
            console.warn("[osu] snipes seed probe failed", {
              beatmapId,
              country,
              error: getErrorMessage(error),
            });
          } finally {
            seedDone += 1;
            writeSnipesScanStatus(country, {
              phase: "seed",
              label: `Checking ${probeBatch.length} new beatmap${probeBatch.length === 1 ? "" : "s"}`,
              current: seedDone,
              total: probeBatch.length,
            });
          }
        },
      );
    }

    const existingLog = (await getPersistentCached<SnipeEvent[]>(logKey)) ?? [];
    const merged = new Map<string, SnipeEvent>();
    for (const event of existingLog) {
      merged.set(`${event.beatmap_id}:${event.score_id}`, event);
    }
    for (const event of newEvents) {
      merged.set(`${event.beatmap_id}:${event.score_id}`, event);
    }
    const mergedLog = [...merged.values()]
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, SNIPES_LOG_CAP);

    void Promise.allSettled([
      setPersistentCache(logKey, mergedLog, SNIPES_LOG_TTL),
      setPersistentCache(snapshotKey, snapshot, SNIPES_SNAPSHOT_TTL),
    ]);

    return { events: mergedLog, scannedAt: Date.now() };
  } catch (err) {
    clearSnipesScanStatus(country);
    clearPartialSnipeEvents(country);
    throw err;
  }
}

export const getCountrySnipes = createServerFn({ method: "GET" })
  .inputValidator((data: { country?: string }) => data)
  .handler(async ({ data }: { data: { country?: string } }): Promise<SnipesResponse> => {
    edgeCache(60, 600);
    const country = normalizeCountryCode(data.country);
    const cacheKey = `country-snipes-response:v3:${country}`;
    const snapshotKey = `country-board-snapshot:v3:${country}`;
    const logKey = `country-snipes-log:v1:${country}`;

    // Stale-while-revalidate: return expired data immediately so the client
    // never blocks on the ~55s scan. A background scan refreshes the cache
    // for the next request.
    const cached = await getPersistentCacheEntryAllowStale<SnipesResponse>(cacheKey);
    if (cached.hit) {
      if (!cached.isStale) return cached.value;
      refreshCountrySnipesInBackground(country, cacheKey, snapshotKey, logKey);
      return { ...cached.value, refreshInProgress: true };
    }

    // The 6h response entry may have been purged while the durable 30d snipe
    // log is still present. Serve that log immediately and rebuild the shorter
    // response cache in the background instead of making the page wait for a
    // full scan.
    const loggedEvents = await getPersistentCacheEntryAllowStale<SnipeEvent[]>(logKey);
    if (loggedEvents.hit && loggedEvents.value.length > 0) {
      refreshCountrySnipesInBackground(country, cacheKey, snapshotKey, logKey);
      return {
        events: loggedEvents.value,
        scannedAt: loggedEvents.updatedAt ?? Date.now(),
        refreshInProgress: true,
      };
    }

    // No data at all (true cold start) - block on the full scan.
    let ranScan = false;
    return fetchWithCacheLock(
      cacheKey,
      SNIPES_CACHE_TTL,
      () => {
        ranScan = true;
        return runSnipesScan(country, snapshotKey, logKey);
      },
      SNIPES_LOCK_TTL,
    ).finally(() => {
      if (ranScan) {
        clearSnipesScanStatus(country);
        clearPartialSnipeEvents(country);
      }
    });
  });

export const getSnipesScanStatus = createServerFn({ method: "GET" })
  .inputValidator((data: { country?: string }) => data)
  .handler(async ({ data }: { data: { country?: string } }): Promise<SnipesScanStatus | null> => {
    edgeCache(0, 0);
    const country = normalizeCountryCode(data.country);
    return (await getPersistentCached<SnipesScanStatus>(snipesStatusKey(country))) ?? null;
  });

export const getPartialSnipeEvents = createServerFn({ method: "GET" })
  .inputValidator((data: { country?: string }) => data)
  .handler(async ({ data }: { data: { country?: string } }): Promise<SnipeEvent[]> => {
    edgeCache(0, 0);
    const country = normalizeCountryCode(data.country);
    return (await getPersistentCached<SnipeEvent[]>(snipesPartialEventsKey(country))) ?? [];
  });
