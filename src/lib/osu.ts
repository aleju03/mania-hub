import { createServerFn } from "@tanstack/react-start";
import {
  osuFetch,
  osuFetchBinary,
  fetchBeatmapFile,
  getPersistentCacheEntry,
  getPersistentCached,
  setPersistentCache,
} from "./api";
import { calculateApproxPpGainMap } from "./score";
import type {
  OsuUser,
  OsuScore,
  RankingsResponse,
  BeatmapsetSearchResponse,
  UserSearchResponse,
} from "./types";

const RANKINGS_CACHE_TTL = 5 * 60 * 1000;
const RANK_HISTORY_CACHE_TTL = 24 * 60 * 60 * 1000;
const APPROX_PP_GAINS_CACHE_TTL = 10 * 60 * 1000;
const BEST_SCORES_WINDOW_CACHE_TTL = 2 * 60 * 1000;
const USER_CACHE_TTL = 2 * 60 * 1000;
const USER_SCORE_LIST_CACHE_TTL = 60 * 1000;
const RANK_HISTORY_CONCURRENCY = 20;
const APPROX_PP_GAINS_CONCURRENCY = 8;
const RECENT_SCORES_CONCURRENCY = 10;
const userPromiseCache = new Map<string, Promise<OsuUser>>();
const userScoresListPromiseCache = new Map<string, Promise<OsuScore[]>>();
const rankHistoryPromiseCache = new Map<number, Promise<number[] | null>>();
const bestScoresWindowPromiseCache = new Map<string, Promise<OsuScore[]>>();
const MIXED_SCORE_USER_IDS = new Set<number>([
  23341349, // happy amke sure
  25914429, // jaimito
]);

function getScoreRequestParams(
  userId: number,
  params: Record<string, string | number | undefined>,
): Record<string, string | number | undefined> {
  return {
    ...params,
    legacy_only: MIXED_SCORE_USER_IDS.has(userId) ? undefined : 1,
  };
}

function getUserCacheKey(key: string): string {
  return `user:${key.trim().toLowerCase()}`;
}

function getUserScoreListCacheKey(
  type: "best" | "recent",
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

async function getCachedUser(key: string): Promise<OsuUser> {
  const cacheKey = getUserCacheKey(key);
  const cached = await getPersistentCached<OsuUser>(cacheKey);
  if (cached) return cached;

  const pending = userPromiseCache.get(cacheKey);
  if (pending) return pending;

  const request = osuFetch<OsuUser>(`/users/${encodeURIComponent(key)}/mania`)
    .then((user) => {
      void Promise.allSettled([
        setPersistentCache(cacheKey, user, USER_CACHE_TTL),
        setPersistentCache(getUserCacheKey(user.username), user, USER_CACHE_TTL),
        setPersistentCache(`user-id:${user.id}`, user, USER_CACHE_TTL),
      ]);
      return user;
    })
    .finally(() => {
      userPromiseCache.delete(cacheKey);
    });

  userPromiseCache.set(cacheKey, request);
  return request;
}

async function getCachedUserScores(
  type: "best" | "recent",
  userId: number,
  options: { limit: number; offset: number; includeFails?: boolean },
): Promise<OsuScore[]> {
  const cacheKey = getUserScoreListCacheKey(type, userId, options);
  const cached = await getPersistentCached<OsuScore[]>(cacheKey);
  if (cached) return cached;

  const pending = userScoresListPromiseCache.get(cacheKey);
  if (pending) return pending;

  const request = osuFetch<OsuScore[]>(
    `/users/${userId}/scores/${type}`,
    getScoreRequestParams(userId, {
      mode: "mania",
      limit: options.limit,
      offset: options.offset,
      include_fails: type === "recent" && options.includeFails ? 1 : 0,
    }),
  )
    .then((scores) => {
      void setPersistentCache(cacheKey, scores, USER_SCORE_LIST_CACHE_TTL);
      return scores;
    })
    .finally(() => {
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

  const request = osuFetch<OsuUser>(`/users/${userId}/mania`)
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
    return getCachedUser(data.key);
  });

export const getUserScoresBest = createServerFn({ method: "GET" })
  .inputValidator((data: { userId: number; limit?: number; offset?: number }) => data)
  .handler(async ({ data }: { data: { userId: number; limit?: number; offset?: number } }) => {
    return getCachedUserScores("best", data.userId, {
      limit: data.limit ?? 20,
      offset: data.offset ?? 0,
    });
  });

export const getUserScoresRecent = createServerFn({ method: "GET" })
  .inputValidator((data: { userId: number; limit?: number; offset?: number; include_fails?: boolean }) => data)
  .handler(async ({ data }: { data: { userId: number; limit?: number; offset?: number; include_fails?: boolean } }) => {
    return getCachedUserScores("recent", data.userId, {
      limit: data.limit ?? 10,
      offset: data.offset ?? 0,
      includeFails: data.include_fails,
    });
  });

export const getUserApproxPpGains = createServerFn({ method: "GET" })
  .inputValidator((data: { userId: number }) => data)
  .handler(async ({ data }: { data: { userId: number } }) => {
    return getApproxPpGainsForUser(data.userId);
  });

async function getApproxPpGainsForUser(userId: number): Promise<Record<number, number>> {
  const cacheKey = `pp-gains:${userId}`;
  const cached = await getPersistentCached<Record<number, number>>(cacheKey);
  if (cached) return cached;

  const gains = calculateApproxPpGainMap(await fetchUserBestScoresWindow(userId, 200));
  await setPersistentCache(cacheKey, gains, APPROX_PP_GAINS_CACHE_TTL);
  return gains;
}

async function fetchUserBestScoresWindow(userId: number, totalLimit = 200): Promise<OsuScore[]> {
  const cacheKey = `user-best-scores-window:${userId}:${totalLimit}`;
  const cached = await getPersistentCacheEntry<OsuScore[]>(cacheKey);
  if (cached.hit) return cached.value;

  const pending = bestScoresWindowPromiseCache.get(cacheKey);
  if (pending) return pending;

  const request = (async () => {
    const firstPage = await osuFetch<OsuScore[]>(`/users/${userId}/scores/best`, getScoreRequestParams(userId, {
      mode: "mania",
      limit: Math.min(totalLimit, 100),
      offset: 0,
    }));

    let scores = firstPage;

    if (totalLimit > 100 && firstPage.length >= 100) {
      const secondPage = await osuFetch<OsuScore[]>(`/users/${userId}/scores/best`, getScoreRequestParams(userId, {
        mode: "mania",
        limit: Math.min(totalLimit - 100, 100),
        offset: 100,
      }));
      scores = [...firstPage, ...secondPage];
    }

    await setPersistentCache(cacheKey, scores, BEST_SCORES_WINDOW_CACHE_TTL);
    return scores;
  })().finally(() => {
    bestScoresWindowPromiseCache.delete(cacheKey);
  });

  bestScoresWindowPromiseCache.set(cacheKey, request);
  return request;
}

export const getUserScoresBestWindow = createServerFn({ method: "GET" })
  .inputValidator((data: { userId: number; totalLimit?: number }) => data)
  .handler(async ({ data }: { data: { userId: number; totalLimit?: number } }) => {
    return fetchUserBestScoresWindow(data.userId, data.totalLimit ?? 200);
  });

export const getUsersApproxPpGains = createServerFn({ method: "GET" })
  .inputValidator((data: { userIds: number[] }) => data)
  .handler(async ({ data }: { data: { userIds: number[] } }) => {
    const uniqueUserIds = [...new Set(data.userIds)];

    const results = await mapWithConcurrency(
      uniqueUserIds,
      APPROX_PP_GAINS_CONCURRENCY,
      async (userId) => {
        try {
          const gains = await getApproxPpGainsForUser(userId);
          return { userId, gains };
        } catch {
          return { userId, gains: {} as Record<number, number> };
        }
      },
    );

    const merged: Record<number, number> = {};
    results.forEach(({ gains }) => {
      Object.assign(merged, gains);
    });

    return merged;
  });

// ── Rankings ────────────────────────────────────────────────────────────────

export const getRankings = createServerFn({ method: "GET" })
  .inputValidator((data: { type?: string; page?: number; country?: string }) => data)
  .handler(async ({ data }: { data: { type?: string; page?: number; country?: string } }) => {
    const type = data.type ?? "performance";
    const cacheKey = `rankings:${type}:${data.page ?? 1}:${data.country ?? ""}`;
    const cached = await getPersistentCached<RankingsResponse>(cacheKey);
    if (cached) return cached;
    const result = await osuFetch<RankingsResponse>(`/rankings/mania/${type}`, {
      "cursor[page]": data.page ?? 1,
      country: data.country,
    });
    await setPersistentCache(cacheKey, result, RANKINGS_CACHE_TTL);
    return result;
  });

// ── Batch user rank history ────────────────────────────────────────────────

export const getUsersRankHistory = createServerFn({ method: "GET" })
  .inputValidator((data: { userIds: number[] }) => data)
  .handler(async ({ data }: { data: { userIds: number[] } }) => {
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
    return osuFetch<BeatmapsetSearchResponse>("/beatmapsets/search", {
      m: 3, // mania
      q: data.query,
      sort: data.sort ?? "ranked_desc",
      cursor_string: data.cursor_string,
      s: data.status,
    });
  });

// ── Search ──────────────────────────────────────────────────────────────────

export const searchUsers = createServerFn({ method: "GET" })
  .inputValidator((data: { query: string }) => data)
  .handler(async ({ data }: { data: { query: string } }) => {
    return osuFetch<UserSearchResponse>("/search", {
      mode: "user",
      query: data.query,
    });
  });

// ── Score Feed (CR top players' recent scores) ─────────────────────────────

export const getCountryRecentScores = createServerFn({ method: "GET" })
  .inputValidator((data: { userIds: number[]; batchSize?: number; batchIndex?: number; recentLimit?: number }) => data)
  .handler(async ({ data }: { data: { userIds: number[]; batchSize?: number; batchIndex?: number; recentLimit?: number } }) => {
    const size = data.batchSize ?? 5;
    const start = ((data.batchIndex ?? 0) * size) % data.userIds.length;
    const batch = data.userIds.slice(start, start + size);
    const recentLimit = data.recentLimit ?? 20;

    const results = await mapWithConcurrency(
      batch,
      RECENT_SCORES_CONCURRENCY,
      async (uid: number) => {
        try {
          return await osuFetch<OsuScore[]>(`/users/${uid}/scores/recent`, getScoreRequestParams(uid, {
            mode: "mania",
            limit: recentLimit,
            include_fails: 1,
          }));
        } catch {
          return [];
        }
      },
    );

    return results.flatMap((scores) => scores);
  });

// ── Replay (parsed server-side via osu-parsers) ────────────────────────────

export const getReplayParsed = createServerFn({ method: "GET" })
  .inputValidator((data: { scoreId: number; mode: string; keyCount?: number }) => data)
  .handler(async ({ data }: { data: { scoreId: number; mode: string; keyCount?: number } }) => {
    const { ScoreDecoder } = await import("osu-parsers");
    let buffer: ArrayBuffer;
    try {
      // Try legacy (mode-prefixed) endpoint first — the scoreId from player pages
      // is a legacy ID, and the modern endpoint may resolve to a different score.
      buffer = await osuFetchBinary(`/scores/${data.mode}/${data.scoreId}/download`);
    } catch {
      buffer = await osuFetchBinary(`/scores/${data.scoreId}/download`);
    }
    const decoder = new ScoreDecoder();
    const score = await decoder.decodeFromBuffer(Buffer.from(buffer));

    const info = score.info;
    // For mania, column bitmask is in mouseX (position.x), NOT buttonState
    const frames = (score.replay?.frames ?? []).map((f: any) => ({
      time: f.startTime,
      keyState: Math.round(f.mouseX ?? f.position?.x ?? f.buttonState ?? 0),
    }));

    // Detect key count: prefer beatmap CS from score API, fall back to OR of all frames
    let keyCount = data.keyCount ?? 0;
    if (!keyCount) {
      let allBits = 0;
      for (const f of frames) allBits |= f.keyState;
      let maxBit = 0;
      let tmp = allBits;
      while (tmp > 0) { maxBit++; tmp >>= 1; }
      keyCount = Math.max(maxBit, 4);
    }

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
      frames,
      keyCount,
    };
  });

export const getBeatmapFile = createServerFn({ method: "GET" })
  .inputValidator((data: { beatmapId: number }) => data)
  .handler(async ({ data }: { data: { beatmapId: number } }) => {
    const osuFile = await fetchBeatmapFile(data.beatmapId);
    return { content: osuFile };
  });

export const getScore = createServerFn({ method: "GET" })
  .inputValidator((data: { scoreId: number; mode?: string }) => data)
  .handler(async ({ data }: { data: { scoreId: number; mode?: string } }) => {
    const mode = data.mode ?? "mania";

    try {
      const legacyScore = await osuFetch<OsuScore>(`/scores/${mode}/${data.scoreId}`);
      const resolvedMode = legacyScore.beatmap?.mode ?? legacyScore.user?.playmode ?? mode;
      if (resolvedMode === mode) {
        return legacyScore;
      }
    } catch {
      // Fall back to modern score lookup below.
    }

    return osuFetch<OsuScore>(`/scores/${data.scoreId}`);
  });
