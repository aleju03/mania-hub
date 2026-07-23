import { createServerFn } from "@tanstack/react-start";
import {
  fetchWithCacheLock,
  getPersistentCacheEntryAllowStale,
  getPersistentCacheEntry,
  osuFetch,
  refreshCacheInBackground,
  setPersistentCache
} from "../api";
import type { OsuFetchContextValue } from "../api";
import { calculateUserProfileInsights } from "../profile-insights";
import { getScoreTimestamp } from "../score";
import type {
  OsuScore,
  OsuUser
} from "../types";
import { getErrorMessage } from "./core";
import {
  edgeCache,
  sanitizeServerProfilePageHtml
} from "./server";
import {
  BEATMAP_USER_SCORES_ALL_CACHE_TTL,
  BEST_SCORES_WINDOW_CACHE_TTL,
  OSU_PROXY_STALE_MS,
  RANK_HISTORY_CACHE_TTL,
  USER_CACHE_TTL,
  USER_CACHE_VERSION,
  USER_PROFILE_INSIGHTS_CACHE_TTL,
  USER_PROFILE_INSIGHTS_CACHE_VERSION,
  USER_SCORE_LIST_CACHE_TTL
} from "./constants";
import {
  bestScoresWindowPromiseCache,
  rankHistoryPromiseCache,
  userPromiseCache,
  userScoresListPromiseCache
} from "./state";
import type { BeatmapUserScoresResponse } from "./internal-types";
import {
  asInputRecord,
  normalizeBestWindowPayload,
  normalizeScoreListPayload,
  normalizeUserIdPayload,
  normalizeUserKeyPayload
} from "./validators";

export function getScoreRequestParams(
  params: Record<string, string | number | undefined>,
): Record<string, string | number | undefined> {
  return {
    ...params,
    legacy_only: 1,
  };
}


export function getUserCacheKey(key: string): string {
  return `user:v${USER_CACHE_VERSION}:${key.trim().toLowerCase()}`;
}

export function getUserScoreListCacheKey(
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

async function fetchUserFromOsu(key: string): Promise<OsuUser> {
  const user = await fetchUserByKeyFromOsu(key);
  if (user.page) {
    user.page.html = await sanitizeServerProfilePageHtml(user.page.html);
  }
  void Promise.allSettled([
    setPersistentCache(getUserCacheKey(user.username), user, USER_CACHE_TTL),
    setPersistentCache(`user-id:v${USER_CACHE_VERSION}:${user.id}`, user, USER_CACHE_TTL),
  ]);
  return user;
}

async function fetchUserByKeyFromOsu(key: string): Promise<OsuUser> {
  const trimmed = key.trim();
  const lookupKeys = isNumericUserKey(trimmed) ? [`@${trimmed}`, trimmed] : [`@${trimmed}`];
  let fallbackError: unknown = null;

  for (const lookupKey of lookupKeys) {
    try {
      return await osuFetch<OsuUser>(`/users/${encodeURIComponent(lookupKey)}/mania`, undefined, {
        caller: "getUser",
        expectedStatuses: [404],
        cacheTtlMs: USER_CACHE_TTL,
        staleMs: OSU_PROXY_STALE_MS,
      });
    } catch (error) {
      fallbackError = error;
      if (!isNumericUserKey(trimmed) || !isOsuNotFoundError(error)) throw error;
    }
  }

  throw fallbackError instanceof Error ? fallbackError : new Error(String(fallbackError ?? "Failed to fetch user"));
}

function isNumericUserKey(key: string): boolean {
  const numericKey = Number(key);
  return Number.isInteger(numericKey) && numericKey > 0;
}

function isOsuNotFoundError(error: unknown): boolean {
  return /\]\s+404\s/.test(getErrorMessage(error));
}

export async function getCachedUser(key: string): Promise<OsuUser> {
  const cacheKey = getUserCacheKey(key);
  const cached = await getPersistentCacheEntryAllowStale<OsuUser>(cacheKey);
  if (cached.hit) {
    if (cached.isStale) {
      void refreshCacheInBackground(cacheKey, USER_CACHE_TTL, () => fetchUserFromOsu(key));
    }
    return cached.value;
  }

  const pending = userPromiseCache.get(cacheKey);
  if (pending) return pending;

  const request = fetchWithCacheLock(cacheKey, USER_CACHE_TTL, () => fetchUserFromOsu(key)).finally(() => {
    userPromiseCache.delete(cacheKey);
  });

  userPromiseCache.set(cacheKey, request);
  return request;
}

function fetchUserScoresFromOsu(
  type: "best" | "recent" | "firsts" | "pinned",
  userId: number,
  options: { limit: number; offset: number; includeFails?: boolean },
): Promise<OsuScore[]> {
  return osuFetch<OsuScore[]>(
    `/users/${userId}/scores/${type}`,
    getScoreRequestParams({
      mode: "mania",
      limit: options.limit,
      offset: options.offset,
      include_fails: type === "recent" && options.includeFails ? 1 : 0,
    }),
    {
      caller: `getUserScores:${type}`,
      // Recent scores must stay live; the stable lists can share across instances.
      cacheTtlMs: type === "recent" ? undefined : USER_SCORE_LIST_CACHE_TTL,
      staleMs: type === "recent" ? undefined : OSU_PROXY_STALE_MS,
      context: {
        source: "user-score-list",
        userId,
        limit: options.limit,
        offset: options.offset,
        includeFails: type === "recent" && !!options.includeFails,
      },
    },
  );
}

export async function getCachedUserScores(
  type: "best" | "recent" | "firsts" | "pinned",
  userId: number,
  options: { limit: number; offset: number; includeFails?: boolean },
): Promise<OsuScore[]> {
  const cacheKey = getUserScoreListCacheKey(type, userId, options);
  const cached = await getPersistentCacheEntryAllowStale<OsuScore[]>(cacheKey);
  if (cached.hit) {
    if (cached.isStale) {
      void refreshCacheInBackground(cacheKey, USER_SCORE_LIST_CACHE_TTL, () => fetchUserScoresFromOsu(type, userId, options));
    }
    return cached.value;
  }

  const pending = userScoresListPromiseCache.get(cacheKey);
  if (pending) return pending;

  const request = fetchWithCacheLock(cacheKey, USER_SCORE_LIST_CACHE_TTL, () =>
    fetchUserScoresFromOsu(type, userId, options),
  ).finally(() => {
    userScoresListPromiseCache.delete(cacheKey);
  });

  userScoresListPromiseCache.set(cacheKey, request);
  return request;
}

export async function getUserRankHistory(userId: number): Promise<number[] | null> {
  const cacheKey = getRankHistoryCacheKey(userId);
  const cached = await getPersistentCacheEntry<number[] | null>(cacheKey);
  if (cached.hit) return cached.value;

  return fetchAndCacheUserRankHistory(userId);
}

export function getRankHistoryCacheKey(userId: number): string {
  return `rank-history:user:${userId}`;
}

export async function fetchAndCacheUserRankHistory(userId: number): Promise<number[] | null> {
  const pending = rankHistoryPromiseCache.get(userId);
  if (pending) return pending;

  // Same proxy path as the profile fetch, so one cached response serves both.
  const request = osuFetch<OsuUser>(`/users/${userId}/mania`, undefined, {
    caller: "getUserRankHistory",
    cacheTtlMs: USER_CACHE_TTL,
    staleMs: OSU_PROXY_STALE_MS,
  })
    .then((user) => {
      const history = user.rank_history?.data ?? null;
      void setPersistentCache(getRankHistoryCacheKey(userId), history, RANK_HISTORY_CACHE_TTL);
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
  .validator(normalizeUserKeyPayload)
  .handler(async ({ data }: { data: { key: string } }) => {
    edgeCache(60, 300);
    return getCachedUser(data.key);
  });

export const getUserScoresBest = createServerFn({ method: "GET" })
  .validator(normalizeScoreListPayload)
  .handler(async ({ data }: { data: { userId: number; limit?: number; offset?: number } }) => {
    edgeCache(120, 600);
    return getCachedUserScores("best", data.userId, {
      limit: data.limit ?? 20,
      offset: data.offset ?? 0,
    });
  });

export const getUserScoresRecent = createServerFn({ method: "GET" })
  .validator(normalizeScoreListPayload)
  .handler(async ({ data }: { data: { userId: number; limit?: number; offset?: number; include_fails?: boolean } }) => {
    edgeCache(30, 120);
    return getCachedUserScores("recent", data.userId, {
      limit: data.limit ?? 10,
      offset: data.offset ?? 0,
      includeFails: data.include_fails,
    });
  });

export const getUserScoresFirsts = createServerFn({ method: "GET" })
  .validator(normalizeScoreListPayload)
  .handler(async ({ data }: { data: { userId: number; limit?: number; offset?: number } }) => {
    edgeCache(300, 1800);
    return getCachedUserScores("firsts", data.userId, {
      limit: data.limit ?? 100,
      offset: data.offset ?? 0,
    });
  });

export const getUserScoresPinned = createServerFn({ method: "GET" })
  .validator(normalizeScoreListPayload)
  .handler(async ({ data }: { data: { userId: number; limit?: number; offset?: number } }) => {
    edgeCache(600, 3600);
    return getCachedUserScores("pinned", data.userId, {
      limit: data.limit ?? 50,
      offset: data.offset ?? 0,
    });
  });

export function getTimestampMs(score: OsuScore): number {
  const timestamp = getScoreTimestamp(score);
  return timestamp ? new Date(timestamp).getTime() : 0;
}

export async function fetchUserBestScoresWindow(
  userId: number,
  totalLimit = 200,
  context?: Record<string, OsuFetchContextValue>,
  options: { parallelPages?: boolean } = {},
): Promise<OsuScore[]> {
  const cacheKey = `user-best-scores-window:${userId}:${totalLimit}`;
  const cached = await getPersistentCacheEntryAllowStale<OsuScore[]>(cacheKey);
  if (cached.hit) {
    if (cached.isStale) {
      void refreshCacheInBackground(cacheKey, BEST_SCORES_WINDOW_CACHE_TTL, () =>
        fetchUserBestScoresWindowFromOsu(userId, totalLimit, context, options),
      );
    }
    return cached.value;
  }

  const pending = bestScoresWindowPromiseCache.get(cacheKey);
  if (pending) return pending;

  const request = fetchWithCacheLock(cacheKey, BEST_SCORES_WINDOW_CACHE_TTL, () =>
    fetchUserBestScoresWindowFromOsu(userId, totalLimit, context, options),
  ).finally(() => {
    bestScoresWindowPromiseCache.delete(cacheKey);
  });

  bestScoresWindowPromiseCache.set(cacheKey, request);
  return request;
}

async function fetchUserBestScoresWindowFromOsu(
  userId: number,
  totalLimit: number,
  context?: Record<string, OsuFetchContextValue>,
  options: { parallelPages?: boolean } = {},
): Promise<OsuScore[]> {
  const fetchPage = (offset: number, limit: number, page: number) => osuFetch<OsuScore[]>(
    `/users/${userId}/scores/best`,
    getScoreRequestParams({
      mode: "mania",
      limit,
      offset,
    }),
    {
      caller: `fetchUserBestScoresWindow:p${page}`,
      expectedStatuses: [404],
      cacheTtlMs: BEST_SCORES_WINDOW_CACHE_TTL,
      staleMs: OSU_PROXY_STALE_MS,
      context: {
        source: "best-scores-window",
        userId,
        totalLimit,
        page,
        ...context,
      },
    },
  );

  const firstPagePromise = fetchPage(0, Math.min(totalLimit, 100), 1);

  if (options.parallelPages && totalLimit > 100) {
    const secondPageResult = fetchPage(100, Math.min(totalLimit - 100, 100), 2)
      .then((value) => ({ ok: true, value }) as const)
      .catch((error) => ({ ok: false, error }) as const);
    const firstPage = await firstPagePromise;
    if (firstPage.length < 100) return firstPage;
    const secondPage = await secondPageResult;
    if (!secondPage.ok) throw secondPage.error;
    return [...firstPage, ...secondPage.value];
  }

  const firstPage = await firstPagePromise;

  if (totalLimit <= 100 || firstPage.length < 100) return firstPage;

  const secondPage = await fetchPage(100, Math.min(totalLimit - 100, 100), 2);
  return [...firstPage, ...secondPage];
}

export async function getBeatmapUserScoresAll(
  beatmapId: number,
  userId: number,
  context?: Record<string, OsuFetchContextValue>,
): Promise<OsuScore[]> {
  const cacheKey = `beatmap-user-scores-all:v2:${beatmapId}:${userId}`;
  return fetchWithCacheLock(cacheKey, BEATMAP_USER_SCORES_ALL_CACHE_TTL, async () => {
    const response = await osuFetch<BeatmapUserScoresResponse>(
      `/beatmaps/${beatmapId}/scores/users/${userId}/all`,
      { ruleset: "mania" },
      {
        caller: "getBeatmapUserScoresAll",
        cacheTtlMs: BEATMAP_USER_SCORES_ALL_CACHE_TTL,
        context: {
          source: "beatmap-user-scores-all",
          beatmapId,
          userId,
          ...context,
        },
      },
    );
    return response.scores ?? [];
  });
}

export const getUserBeatmapScores = createServerFn({ method: "GET" })
  .validator((data: unknown) => {
    const input = asInputRecord(data);
    const beatmapId = Number(input.beatmapId);
    const userId = Number(input.userId);
    if (!Number.isFinite(beatmapId) || beatmapId <= 0) throw new Error("Invalid beatmap ID.");
    if (!Number.isFinite(userId) || userId <= 0) throw new Error("Invalid user ID.");
    return { beatmapId, userId };
  })
  .handler(async ({ data }: { data: { beatmapId: number; userId: number } }) => {
    edgeCache(60, 300);
    return getBeatmapUserScoresAll(data.beatmapId, data.userId, {
      feature: "user-beatmap-scores",
      source: "getUserBeatmapScores",
    });
  });

export const getUserScoresBestWindow = createServerFn({ method: "GET" })
  .validator(normalizeBestWindowPayload)
  .handler(async ({ data }: { data: { userId: number; totalLimit?: number; parallel?: boolean } }) => {
    edgeCache(120, 600);
    return fetchUserBestScoresWindow(data.userId, data.totalLimit ?? 200, {
      feature: "user-best-window",
      source: "getUserScoresBestWindow",
    }, {
      parallelPages: data.parallel === true,
    });
  });

export const getUserProfileInsights = createServerFn({ method: "GET" })
  .validator(normalizeUserIdPayload)
  .handler(async ({ data }: { data: { userId: number } }) => {
    edgeCache(1800, 21600);
    const cacheKey = `user-profile-insights:v${USER_PROFILE_INSIGHTS_CACHE_VERSION}:${data.userId}`;
    return fetchWithCacheLock(cacheKey, USER_PROFILE_INSIGHTS_CACHE_TTL, async () =>
      calculateUserProfileInsights(await fetchUserBestScoresWindow(data.userId, 200, {
        feature: "profile-insights",
      })),
    );
  });
