import { createServerFn } from "@tanstack/react-start";
import {
  osuFetch,
  osuFetchBinary,
  fetchBeatmapFile,
  fetchWithCacheLock,
  getPersistentCacheEntry,
  getPersistentCached,
  setPersistentCache,
} from "./api";
import { calculateApproxPpGainMap, getModAcronyms, getScoreDisplayValues, getScoreTimestamp, getScoreUrl } from "./score";
import type {
  OsuUser,
  OsuScore,
  OsuBeatmapset,
  RankingsResponse,
  BeatmapsetSearchResponse,
  UserSearchResponse,
  BeatmapPlaycount,
  CountryMapsData,
  MapsAggregatedBeatmap,
  MapsAggregatedFavourite,
  MapsFarmedEntry,
  HomePageData,
  HomePagePopoff,
  UserProfileInsights,
  InsightScoreSnapshot,
} from "./types";

const MAPS_DATA_CACHE_TTL = 24 * 60 * 60 * 1000; // 1 day
const MAPS_DATA_CACHE_VERSION = 4;
const FARMED_SINGLE_PLAYER_PP_MIN = 500;
const USER_MOST_PLAYED_CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours
const USER_FAVOURITES_CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours
const MAPS_FETCH_CONCURRENCY = 6;
const RANKINGS_CACHE_TTL = 5 * 60 * 1000;
const RANK_HISTORY_CACHE_TTL = 24 * 60 * 60 * 1000;
const APPROX_PP_GAINS_CACHE_TTL = 10 * 60 * 1000;
const BEST_SCORES_WINDOW_CACHE_TTL = 2 * 60 * 1000;
const USER_PROFILE_INSIGHTS_CACHE_TTL = 6 * 60 * 60 * 1000;
const USER_PROFILE_INSIGHTS_CACHE_VERSION = 2;
const HOME_PAGE_CACHE_TTL = 60 * 1000;
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

  const request = fetchWithCacheLock(cacheKey, USER_CACHE_TTL, async () => {
    const user = await osuFetch<OsuUser>(`/users/${encodeURIComponent(key)}/mania`);
    void Promise.allSettled([
      setPersistentCache(getUserCacheKey(user.username), user, USER_CACHE_TTL),
      setPersistentCache(`user-id:${user.id}`, user, USER_CACHE_TTL),
    ]);
    return user;
  }).finally(() => {
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

  const request = fetchWithCacheLock(cacheKey, USER_SCORE_LIST_CACHE_TTL, () =>
    osuFetch<OsuScore[]>(
      `/users/${userId}/scores/${type}`,
      getScoreRequestParams(userId, {
        mode: "mania",
        limit: options.limit,
        offset: options.offset,
        include_fails: type === "recent" && options.includeFails ? 1 : 0,
      }),
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
  return fetchWithCacheLock(cacheKey, APPROX_PP_GAINS_CACHE_TTL, async () =>
    calculateApproxPpGainMap(await fetchUserBestScoresWindow(userId, 200)),
  );
}

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
  const bpms: number[] = [];
  const ppValues: number[] = [];
  const datedScores: Array<{ score: OsuScore; ms: number }> = [];

  for (const score of scores) {
    const keyCount = Number(score.beatmap?.cs);
    if (Number.isFinite(keyCount) && keyCount > 0) {
      const normalizedKeyCount = Math.round(keyCount);
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
      bpms.push(bpm);
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

  return {
    sampleSize: scores.length,
    keySplit: sortedKeySplit,
    mostUsedMod: getTopCountEntry(modCounts, moddedPlayCount),
    medianBpm: getMedian(bpms),
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

    return scores;
  }).finally(() => {
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

export const getUserProfileInsights = createServerFn({ method: "GET" })
  .inputValidator((data: { userId: number }) => data)
  .handler(async ({ data }: { data: { userId: number } }) => {
    const cacheKey = `user-profile-insights:v${USER_PROFILE_INSIGHTS_CACHE_VERSION}:${data.userId}`;
    return fetchWithCacheLock(cacheKey, USER_PROFILE_INSIGHTS_CACHE_TTL, async () =>
      calculateUserProfileInsights(await fetchUserBestScoresWindow(data.userId, 200)),
    );
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
    return fetchWithCacheLock(cacheKey, RANKINGS_CACHE_TTL, () =>
      osuFetch<RankingsResponse>(`/rankings/mania/${type}`, {
        "cursor[page]": data.page ?? 1,
        country: data.country,
      }),
    );
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

async function buildHomePopoffs(rankings: RankingsResponse): Promise<HomePagePopoff[]> {
  const topPlayersForPopoffs = rankings.ranking.slice(0, 30);

  const results = await mapWithConcurrency(
    topPlayersForPopoffs,
    APPROX_PP_GAINS_CONCURRENCY,
    async (entry) => {
      try {
        const scores = await fetchUserBestScoresWindow(entry.user.id, 100);
        return scores
          .filter((score) => {
            const age = Date.now() - getTimestampMs(score);
            return age < 7 * 24 * 60 * 60 * 1000 && score.pp != null && score.pp > 0;
          })
          .map((score) => ({
            user: {
              username: entry.user.username,
              avatar_url: entry.user.avatar_url,
            },
            score,
          }));
      } catch {
        return [] as HomePagePopoff[];
      }
    },
  );

  return results
    .flatMap((scores) => scores)
    .sort((a, b) => {
      const ppDiff = (b.score.pp ?? 0) - (a.score.pp ?? 0);
      if (ppDiff !== 0) return ppDiff;
      return getTimestampMs(b.score) - getTimestampMs(a.score);
    })
    .slice(0, 5);
}

export const getHomePageData = createServerFn({ method: "GET" })
  .inputValidator((data?: { country?: string }) => data)
  .handler(async ({ data }: { data?: { country?: string } }): Promise<HomePageData> => {
    const country = data?.country ?? "CR";
    const cacheKey = `home-page-data:v1:${country}`;
    return fetchWithCacheLock(cacheKey, HOME_PAGE_CACHE_TTL, async () => {
      const rankings = await getRankings({ data: { type: "performance", page: 1, country } });
      const userIds = rankings.ranking.map((entry) => entry.user.id);

      const [recentScores, popoffs] = await Promise.all([
        fetchCountryRecentScores(userIds, { batchSize: 10, batchIndex: 0, recentLimit: 20 })
          .then((scores) => buildRecentScoresPreview(scores, 5)),
        buildHomePopoffs(rankings),
      ]);

      return { rankings, recentScores, popoffs } satisfies HomePageData;
    }, 30_000);
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
    return fetchCountryRecentScores(data.userIds, data);
  });

// ── Maps (aggregated most-played + favourites across CR players) ───────────

async function fetchUserMostPlayed(userId: number): Promise<BeatmapPlaycount[]> {
  const cacheKey = `user-most-played:${userId}`;
  return fetchWithCacheLock(cacheKey, USER_MOST_PLAYED_CACHE_TTL, () =>
    osuFetch<BeatmapPlaycount[]>(`/users/${userId}/beatmapsets/most_played`, { limit: 100, offset: 0 }),
  );
}

async function fetchUserFavourites(userId: number): Promise<OsuBeatmapset[]> {
  const cacheKey = `user-favourites:${userId}`;
  return fetchWithCacheLock(cacheKey, USER_FAVOURITES_CACHE_TTL, () =>
    osuFetch<OsuBeatmapset[]>(`/users/${userId}/beatmapsets/favourite`, { limit: 100, offset: 0 }),
  );
}

export const getCountryMapsData = createServerFn({ method: "GET" })
  .inputValidator(
    (data: { users: Array<{ id: number; username: string; avatar_url: string }> }) => data,
  )
  .handler(
    async ({
      data,
    }: {
      data: { users: Array<{ id: number; username: string; avatar_url: string }> };
    }) => {
      const userKey = data.users
        .map((user) => user.id)
        .sort((a, b) => a - b)
        .join(",");
      const cacheKey = `country-maps-data:v${MAPS_DATA_CACHE_VERSION}:${userKey}`;
      const users = data.users;

      return fetchWithCacheLock(cacheKey, MAPS_DATA_CACHE_TTL, async () => {
      // Fetch best scores + most_played + favourites for all users
      const userResults = await mapWithConcurrency(
        users,
        MAPS_FETCH_CONCURRENCY,
        async (user) => {
          const [bestScores, mostPlayed, favourites] = await Promise.all([
            fetchUserBestScoresWindow(user.id, 200).catch(() => [] as OsuScore[]),
            fetchUserMostPlayed(user.id).catch(() => [] as BeatmapPlaycount[]),
            fetchUserFavourites(user.id).catch(() => [] as OsuBeatmapset[]),
          ]);
          return { user, bestScores, mostPlayed, favourites };
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

      // ── Favourites ───────────────────────────────────────────────
      const favMap = new Map<number, MapsAggregatedFavourite>();
      for (const { user, favourites } of userResults) {
        for (const fav of favourites) {
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
        farmed,
        mostPlayed,
        favourites,
        generatedAt: new Date().toISOString(),
      } satisfies CountryMapsData;
      }, 60_000);
    },
  );

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
