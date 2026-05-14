import { createServerFn } from "@tanstack/react-start";
import {
  fetchWithCacheLock,
  getPersistentCacheEntries,
  getPersistentCacheEntry,
  getPersistentCached,
  osuFetch,
  setPersistentCache
} from "../api";
import type { OsuFetchContextValue } from "../api";
import { calculateUserProfileInsights } from "../profile-insights";
import {
  calculateApproxPpGainMap,
  calculateReplacementPpGain,
  getScoreTimestamp
} from "../score";
import type {
  OsuScore,
  OsuUser
} from "../types";
import {
  edgeCache,
  getErrorMessage,
  sanitizeServerProfilePageHtml
} from "./core";
import {
  APPROX_PP_GAINS_CONCURRENCY,
  BEATMAP_USER_SCORES_ALL_CACHE_TTL,
  BEST_SCORES_WINDOW_CACHE_TTL,
  RANK_HISTORY_CACHE_TTL,
  SCORE_PP_GAIN_CACHE_TTL,
  USER_CACHE_TTL,
  USER_CACHE_VERSION,
  USER_PROFILE_INSIGHTS_CACHE_TTL,
  USER_PROFILE_INSIGHTS_CACHE_VERSION,
  USER_SCORE_LIST_CACHE_TTL
} from "./constants";
import {
  MIXED_SCORE_USER_IDS,
  bestScoresWindowPromiseCache,
  rankHistoryPromiseCache,
  userPromiseCache,
  userScoresListPromiseCache
} from "./state";
import { scorePpGainCacheKey } from "./internal-types";
import type {
  BeatmapUserScoresResponse,
  CachedScorePpGain,
  ScorePpGainLookup
} from "./internal-types";
import {
  asInputRecord,
  normalizeBestWindowPayload,
  normalizeScoreListPayload,
  normalizeUserIdPayload,
  normalizeUserKeyPayload
} from "./validators";
import { mapWithConcurrency } from "./concurrency";

export function getScoreRequestParams(
  userId: number,
  params: Record<string, string | number | undefined>,
): Record<string, string | number | undefined> {
  return {
    ...params,
    legacy_only: MIXED_SCORE_USER_IDS.has(userId) ? undefined : 1,
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
      user.page.html = await sanitizeServerProfilePageHtml(user.page.html);
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
      {
        caller: `getUserScores:${type}`,
        context: {
          source: "user-score-list",
          userId,
          limit: options.limit,
          offset: options.offset,
          includeFails: type === "recent" && !!options.includeFails,
        },
      },
    ),
  ).finally(() => {
    userScoresListPromiseCache.delete(cacheKey);
  });

  userScoresListPromiseCache.set(cacheKey, request);
  return request;
}

export async function getUserRankHistory(userId: number): Promise<number[] | null> {
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
  .inputValidator(normalizeUserKeyPayload)
  .handler(async ({ data }: { data: { key: string } }) => {
    edgeCache(60, 300);
    return getCachedUser(data.key);
  });

export const getUserScoresBest = createServerFn({ method: "GET" })
  .inputValidator(normalizeScoreListPayload)
  .handler(async ({ data }: { data: { userId: number; limit?: number; offset?: number } }) => {
    edgeCache(120, 600);
    return getCachedUserScores("best", data.userId, {
      limit: data.limit ?? 20,
      offset: data.offset ?? 0,
    });
  });

export const getUserScoresRecent = createServerFn({ method: "GET" })
  .inputValidator(normalizeScoreListPayload)
  .handler(async ({ data }: { data: { userId: number; limit?: number; offset?: number; include_fails?: boolean } }) => {
    edgeCache(30, 120);
    return getCachedUserScores("recent", data.userId, {
      limit: data.limit ?? 10,
      offset: data.offset ?? 0,
      includeFails: data.include_fails,
    });
  });

export const getUserScoresFirsts = createServerFn({ method: "GET" })
  .inputValidator(normalizeScoreListPayload)
  .handler(async ({ data }: { data: { userId: number; limit?: number; offset?: number } }) => {
    edgeCache(300, 1800);
    return getCachedUserScores("firsts", data.userId, {
      limit: data.limit ?? 100,
      offset: data.offset ?? 0,
    });
  });

export const getUserScoresPinned = createServerFn({ method: "GET" })
  .inputValidator(normalizeScoreListPayload)
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
): Promise<OsuScore[]> {
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
      {
        caller: "fetchUserBestScoresWindow:p1",
        context: {
          source: "best-scores-window",
          userId,
          totalLimit,
          page: 1,
          ...context,
        },
      },
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
        {
          caller: "fetchUserBestScoresWindow:p2",
          context: {
            source: "best-scores-window",
            userId,
            totalLimit,
            page: 2,
            ...context,
          },
        },
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
  .inputValidator((data: unknown) => {
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

export function getPreviousBeatmapBestScore(scores: OsuScore[], target: ScorePpGainLookup): OsuScore | null {
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

export async function calculateReplacementPpGainMapForTargets(
  bestScores: OsuScore[],
  targets: ScorePpGainLookup[],
): Promise<Record<number, number>> {
  if (targets.length === 0) return {};

  const bestScoreById = new Map(
    bestScores
      .filter((score) => score.id > 0 && score.pp != null && score.pp > 0)
      .map((score) => [score.id, score]),
  );
  const fallbackGainMap = calculateApproxPpGainMap(bestScores);
  const relevantTargets = targets.filter((target) => bestScoreById.has(target.scoreId));
  if (relevantTargets.length === 0) return {};

  const cacheKeyByScoreId = new Map<number, string>();
  for (const target of relevantTargets) {
    const currentScore = bestScoreById.get(target.scoreId);
    if (!currentScore?.pp) continue;
    cacheKeyByScoreId.set(target.scoreId, scorePpGainCacheKey(target.scoreId, currentScore.pp));
  }

  const cachedGains = await getPersistentCacheEntries<CachedScorePpGain>(
    [...new Set(cacheKeyByScoreId.values())],
  );
  const gains: Record<number, number> = {};
  const uncachedTargets: ScorePpGainLookup[] = [];

  for (const target of relevantTargets) {
    const currentScore = bestScoreById.get(target.scoreId);
    const cacheKey = cacheKeyByScoreId.get(target.scoreId);
    const cached = cacheKey ? cachedGains.get(cacheKey) : undefined;
    if (
      currentScore?.pp &&
      cached &&
      Number.isFinite(cached.pp) &&
      Number.isFinite(cached.ppGain) &&
      Math.abs(cached.pp - currentScore.pp) < 0.01
    ) {
      if (cached.ppGain > 0) gains[target.scoreId] = cached.ppGain;
      continue;
    }

    uncachedTargets.push(target);
  }

  if (uncachedTargets.length === 0) return gains;

  const previousScores = await mapWithConcurrency(
    uncachedTargets,
    APPROX_PP_GAINS_CONCURRENCY,
    async (target) => {
      try {
        const history = await getBeatmapUserScoresAll(target.beatmapId, target.userId, {
          feature: "pp-gain-fallback",
          batchSize: uncachedTargets.length,
          concurrency: APPROX_PP_GAINS_CONCURRENCY,
          scoreId: target.scoreId,
        });
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

  uncachedTargets.forEach((target, index) => {
    const currentScore = bestScoreById.get(target.scoreId);
    if (!currentScore) return;

    const previousScore = previousScores[index];
    if (previousScore === undefined) {
      const fallbackGain = fallbackGainMap[target.scoreId];
      if (fallbackGain > 0) gains[target.scoreId] = fallbackGain;
      return;
    }

    const gain = calculateReplacementPpGain(bestScores, target.scoreId, previousScore ?? null);
    const cacheKey = cacheKeyByScoreId.get(target.scoreId);
    if (cacheKey && currentScore.pp != null) {
      void setPersistentCache(
        cacheKey,
        { pp: currentScore.pp, ppGain: gain } satisfies CachedScorePpGain,
        SCORE_PP_GAIN_CACHE_TTL,
      );
    }
    if (gain > 0) gains[target.scoreId] = gain;
  });

  return gains;
}

export const getUserScoresBestWindow = createServerFn({ method: "GET" })
  .inputValidator(normalizeBestWindowPayload)
  .handler(async ({ data }: { data: { userId: number; totalLimit?: number } }) => {
    edgeCache(120, 600);
    return fetchUserBestScoresWindow(data.userId, data.totalLimit ?? 200, {
      feature: "user-best-window",
      source: "getUserScoresBestWindow",
    });
  });

export const getUserProfileInsights = createServerFn({ method: "GET" })
  .inputValidator(normalizeUserIdPayload)
  .handler(async ({ data }: { data: { userId: number } }) => {
    edgeCache(1800, 21600);
    const cacheKey = `user-profile-insights:v${USER_PROFILE_INSIGHTS_CACHE_VERSION}:${data.userId}`;
    return fetchWithCacheLock(cacheKey, USER_PROFILE_INSIGHTS_CACHE_TTL, async () =>
      calculateUserProfileInsights(await fetchUserBestScoresWindow(data.userId, 200, {
        feature: "profile-insights",
      })),
    );
  });
