import { createServerFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import sanitizeHtml from "sanitize-html";

function edgeCache(sMaxage: number, swr?: number): void {
  const effectiveSwr = swr ?? sMaxage * 4;
  setResponseHeader(
    "Cache-Control",
    `public, s-maxage=${sMaxage}, stale-while-revalidate=${effectiveSwr}`,
  );
}
import {
  osuFetch,
  osuFetchBinary,
  fetchBeatmapFile,
  fetchWithCacheLock,
  fetchWithStaleAllowed,
  runCacheRebuild,
  deleteExpiredCacheEntriesByPrefix,
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
  HomePagePopoff,
  UserProfileInsights,
  InsightScoreSnapshot,
} from "./types";

const MAPS_DATA_CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 1 week
const MAPS_DATA_CACHE_VERSION = 5;
const USER_FAVOURITES_PAGE_SIZE = 100;
const USER_FAVOURITES_MAX_PAGES = 10;
const FARMED_SINGLE_PLAYER_PP_MIN = 500;
const USER_MOST_PLAYED_CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours
const USER_FAVOURITES_CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours
const MAPS_FETCH_CONCURRENCY = 6;
const RANKINGS_CACHE_TTL = 5 * 60 * 1000;
const RANK_HISTORY_CACHE_TTL = 24 * 60 * 60 * 1000;
const APPROX_PP_GAINS_CACHE_TTL = 10 * 60 * 1000;
const BEST_SCORES_WINDOW_CACHE_TTL = 2 * 60 * 1000;
const COUNTRY_BEATMAP_SCORES_CACHE_TTL = 2 * 60 * 1000;
const COUNTRY_BEATMAP_USER_SCORE_CACHE_TTL = 10 * 60 * 1000;
const COUNTRY_BEATMAP_LOOKUP_CONCURRENCY = 10;
const COUNTRY_BEATMAP_PLAYER_PAGE_LIMIT = 2; // Match the rest of the app's top-100 country player scope.
const USER_PROFILE_INSIGHTS_CACHE_TTL = 6 * 60 * 60 * 1000;
const USER_PROFILE_INSIGHTS_CACHE_VERSION = 3;
const HOME_PAGE_CACHE_TTL = 60 * 1000;
const HOME_RECENT_SCORES_CACHE_TTL = 5 * 60 * 1000;
const HOME_POPOFFS_CACHE_TTL = 10 * 60 * 1000;
const COUNTRY_POPOFFS_CACHE_TTL = 2 * 60 * 1000;
const COUNTRY_POPOFFS_CACHE_VERSION = 3;
const HOME_RECENT_SCORES_PLAYER_COUNT = 10;
const HOME_POPOFFS_PLAYER_COUNT = 10;
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

interface BeatmapUserScoreResponse {
  error?: string | null;
  position?: number | null;
  score?: OsuScore | null;
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

const PROFILE_PAGE_SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    "a", "b", "br", "blockquote", "center", "code", "del", "div", "em", "h1",
    "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "li", "ol", "p", "pre",
    "s", "span", "strike", "strong", "u", "ul",
  ],
  allowedAttributes: {
    a: ["href", "title", "rel", "target", "class"],
    img: ["src", "alt", "title", "width", "height", "class", "loading", "style"],
    span: ["class", "style"],
    div: ["class", "style"],
    "*": ["class"],
  },
  allowedStyles: {
    "*": {
      color: [/^#(0x)?[0-9a-f]+$/i, /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/],
      "text-align": [/^left$/, /^right$/, /^center$/, /^justify$/],
      "font-size": [/^\d+(\.\d+)?(%|px|em|rem|pt)$/],
      width: [/^\d+(\.\d+)?(px|%|em|rem)$/],
      "max-width": [/^\d+(\.\d+)?(px|%|em|rem)$/],
      "aspect-ratio": [/^[\d.\s/]+$/],
    },
  },
  allowedSchemes: ["http", "https", "mailto"],
  transformTags: {
    a: (tagName, attribs) => {
      // Spoilerbox toggle links: strip href/target entirely. Without href, the
      // browser cannot navigate, even if our React click handler hasn't mounted
      // yet. Our JS handles the toggle via the preserved classes.
      const cls = typeof attribs.class === "string" ? attribs.class : "";
      if (cls.includes("js-spoilerbox__link")) {
        const { href: _href, target: _target, ...rest } = attribs;
        void _href; void _target;
        return { tagName, attribs: rest };
      }
      // Raw "#" links (rare, not spoilerbox): leave as-is so they don't open
      // "#" in a new tab.
      if (attribs.href === "#") return { tagName, attribs };
      // External links: open in new tab.
      return {
        tagName,
        attribs: {
          ...attribs,
          target: "_blank",
          rel: "noopener noreferrer nofollow",
        },
      };
    },
  },
};

function sanitizeProfilePageHtml(html: string | null | undefined): string | null {
  if (!html) return null;
  const cleaned = sanitizeHtml(html, PROFILE_PAGE_SANITIZE_OPTIONS);
  return cleaned.trim() || null;
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

async function getCachedUser(key: string): Promise<OsuUser> {
  const cacheKey = getUserCacheKey(key);
  const cached = await getPersistentCached<OsuUser>(cacheKey);
  if (cached) return cached;

  const pending = userPromiseCache.get(cacheKey);
  if (pending) return pending;

  const request = fetchWithCacheLock(cacheKey, USER_CACHE_TTL, async () => {
    const user = await osuFetch<OsuUser>(`/users/${encodeURIComponent(key)}/mania`);
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

async function getCachedUserScores(
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

export const getUserApproxPpGains = createServerFn({ method: "GET" })
  .inputValidator((data: { userId: number }) => data)
  .handler(async ({ data }: { data: { userId: number } }) => {
    edgeCache(300, 1800);
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
    bpmRange: bpms.length
      ? {
          min: Math.min(...bpms),
          max: Math.max(...bpms),
        }
      : null,
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

export const getUsersApproxPpGains = createServerFn({ method: "GET" })
  .inputValidator((data: { userIds: number[] }) => data)
  .handler(async ({ data }: { data: { userIds: number[] } }) => {
    edgeCache(300, 1800);
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
    edgeCache(60, 300);
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

async function buildHomeRecentScoresPreview(userIds: number[]): Promise<OsuScore[]> {
  const previewUserIds = userIds.slice(0, HOME_RECENT_SCORES_PLAYER_COUNT);
  if (previewUserIds.length === 0) return [];
  const cacheKey = `home-recent-scores:v1:${previewUserIds.join(",")}`;

  return fetchWithCacheLock(cacheKey, HOME_RECENT_SCORES_CACHE_TTL, async () =>
    fetchCountryRecentScores(previewUserIds, {
      batchSize: previewUserIds.length,
      batchIndex: 0,
      recentLimit: 20,
    }).then((scores) => buildRecentScoresPreview(scores, 5)),
  );
}

type HomePreviewPlayer = {
  id: number;
  username: string;
  avatar_url: string;
};

async function buildHomePopoffs(players: HomePreviewPlayer[]): Promise<HomePagePopoff[]> {
  const topPlayersForPopoffs = players.slice(0, HOME_POPOFFS_PLAYER_COUNT);
  if (topPlayersForPopoffs.length === 0) return [];
  const cacheKey = `home-popoffs:v1:${topPlayersForPopoffs.map((player) => player.id).join(",")}`;

  return fetchWithCacheLock(cacheKey, HOME_POPOFFS_CACHE_TTL, async () => {
    const results = await mapWithConcurrency(
      topPlayersForPopoffs,
      APPROX_PP_GAINS_CONCURRENCY,
      async (player) => {
        try {
          const scores = await fetchUserBestScoresWindow(player.id, 100);
          return scores
            .filter((score) => {
              const age = Date.now() - getTimestampMs(score);
              return age < 7 * 24 * 60 * 60 * 1000 && score.pp != null && score.pp > 0;
            })
            .map((score) => ({
              user: {
                username: player.username,
                avatar_url: player.avatar_url,
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
  });
}

async function buildCountryPopoffs(players: HomePreviewPlayer[]): Promise<Array<{
  user: { id: number; username: string; avatar_url: string };
  score: OsuScore;
  pp: number;
  weightedPP: number;
  ppGain: number;
  time: string;
}>> {
  const topPlayers = players.slice(0, 30);
  if (topPlayers.length === 0) return [];

  const cacheKey = `country-popoffs:v${COUNTRY_POPOFFS_CACHE_VERSION}:${topPlayers.map((player) => player.id).join(",")}`;

  return fetchWithCacheLock(cacheKey, COUNTRY_POPOFFS_CACHE_TTL, async () => {
    const results = await mapWithConcurrency(
      topPlayers,
      APPROX_PP_GAINS_CONCURRENCY,
      async (player) => {
        try {
          const scores = await fetchUserBestScoresWindow(player.id, 100);
          const gainMap = calculateApproxPpGainMap(scores);

          return scores
            .filter((score) => {
              const age = Date.now() - getTimestampMs(score);
              return age < 30 * 24 * 60 * 60 * 1000 && score.pp != null && score.pp > 0;
            })
            .map((score) => ({
              user: player,
              score,
              pp: score.pp ?? 0,
              weightedPP: score.weight?.pp ?? 0,
              ppGain: gainMap[score.id] ?? 0,
              time: getScoreTimestamp(score),
            }));
        } catch {
          return [] as Array<{
            user: { id: number; username: string; avatar_url: string };
            score: OsuScore;
            pp: number;
            weightedPP: number;
            ppGain: number;
            time: string;
          }>;
        }
      },
    );

    return results.flatMap((scores) => scores);
  });
}

export const getHomePageData = createServerFn({ method: "GET" })
  .inputValidator((data?: { country?: string }) => data)
  .handler(async ({ data }: { data?: { country?: string } }): Promise<HomePageData> => {
    edgeCache(30, 300);
    const country = data?.country ?? "CR";
    const cacheKey = `home-page-data:v1:${country}`;
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
  .inputValidator((data: { players: HomePreviewPlayer[] }) => data)
  .handler(async ({ data }: { data: { players: HomePreviewPlayer[] } }) => {
    edgeCache(60, 600);
    return buildCountryPopoffs(data.players);
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
    return osuFetch<BeatmapsetSearchResponse>("/beatmapsets/search", {
      m: 3, // mania
      q: data.query,
      sort: data.sort ?? "ranked_desc",
      cursor_string: data.cursor_string,
      s: data.status,
    });
  });

async function getBeatmapUserScore(beatmapId: number, userId: number): Promise<OsuScore | null> {
  const cacheKey = `beatmap-user-score:${beatmapId}:${userId}`;
  return fetchWithCacheLock(cacheKey, COUNTRY_BEATMAP_USER_SCORE_CACHE_TTL, async () => {
    const response = await osuFetch<BeatmapUserScoreResponse>(`/beatmaps/${beatmapId}/scores/users/${userId}`, {
      mode: "mania",
    });
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

    return osuFetch<BeatmapScoresResponse>(`/beatmaps/${data.beatmapId}/scores`, {
      mode: "mania",
      type: "global",
    });
  });

// ── Search ──────────────────────────────────────────────────────────────────

export const searchUsers = createServerFn({ method: "GET" })
  .inputValidator((data: { query: string }) => data)
  .handler(async ({ data }: { data: { query: string } }) => {
    edgeCache(60, 600);
    return osuFetch<UserSearchResponse>("/search", {
      mode: "user",
      query: data.query,
    });
  });

// ── Score Feed (CR top players' recent scores) ─────────────────────────────

export const getCountryRecentScores = createServerFn({ method: "GET" })
  .inputValidator((data: { userIds: number[]; batchSize?: number; batchIndex?: number; recentLimit?: number }) => data)
  .handler(async ({ data }: { data: { userIds: number[]; batchSize?: number; batchIndex?: number; recentLimit?: number } }) => {
    edgeCache(30, 120);
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
  const cacheKey = `user-favourites-all:${userId}`;
  return fetchWithCacheLock(cacheKey, USER_FAVOURITES_CACHE_TTL, async () => {
    const all: OsuBeatmapset[] = [];
    for (let page = 0; page < USER_FAVOURITES_MAX_PAGES; page++) {
      const batch = await osuFetch<OsuBeatmapset[]>(
        `/users/${userId}/beatmapsets/favourite`,
        { limit: USER_FAVOURITES_PAGE_SIZE, offset: page * USER_FAVOURITES_PAGE_SIZE },
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

function computeMapsCacheKey(users: MapsUser[]): string {
  const userKey = users
    .map((user) => user.id)
    .sort((a, b) => a - b)
    .join(",");
  return `country-maps-data:v${MAPS_DATA_CACHE_VERSION}:${userKey}`;
}

async function buildCountryMapsData(users: MapsUser[]): Promise<CountryMapsData> {
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
      const beatmapsetsPool: Record<number, MapsFavouriteBeatmapset> = {};
      const favouritesByPlayer: MapsPlayerFavourites[] = [];
      for (const { user, favourites } of userResults) {
        const playerIds: number[] = [];
        for (const fav of favourites) {
          playerIds.push(fav.id);

          if (!beatmapsetsPool[fav.id]) {
            beatmapsetsPool[fav.id] = {
              id: fav.id,
              title: fav.title,
              artist: fav.artist,
              creator: fav.creator,
              covers: fav.covers,
              status: fav.status,
              globalPlayCount: fav.play_count,
              globalFavouriteCount: fav.favourite_count,
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
        farmed,
        mostPlayed,
        favourites,
        favouritesByPlayer,
        beatmapsetsPool,
        generatedAt: new Date().toISOString(),
      } satisfies CountryMapsData;
}

export const getCountryMapsData = createServerFn({ method: "GET" })
  .inputValidator((data: { users: MapsUser[] }) => data)
  .handler(async ({ data }: { data: { users: MapsUser[] } }) => {
    edgeCache(3600, 86400);
    const cacheKey = computeMapsCacheKey(data.users);
    const { value, isStale } = await fetchWithStaleAllowed<CountryMapsData>(
      cacheKey,
      MAPS_DATA_CACHE_TTL,
      () => buildCountryMapsData(data.users),
      MAPS_REBUILD_LOCK_TTL_MS,
    );
    return { value, isStale };
  });

export const rebuildCountryMapsData = createServerFn({ method: "POST" })
  .inputValidator((data: { users: MapsUser[] }) => data)
  .handler(async ({ data }: { data: { users: MapsUser[] } }) => {
    const cacheKey = computeMapsCacheKey(data.users);
    const { rebuilt, value } = await runCacheRebuild<CountryMapsData>(
      cacheKey,
      MAPS_DATA_CACHE_TTL,
      async () => {
        const result = await buildCountryMapsData(data.users);
        await deleteExpiredCacheEntriesByPrefix(
          "country-maps-data:",
          MAPS_ORPHAN_CLEANUP_AGE_MS,
        );
        return result;
      },
      MAPS_REBUILD_LOCK_TTL_MS,
    );
    return { rebuilt, value };
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
      buffer = await osuFetchBinary(`/scores/${data.mode}/${data.scoreId}/download`);
    } catch {
      buffer = await osuFetchBinary(`/scores/${data.scoreId}/download`);
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
    edgeCache(86400, 604800);
    const osuFile = await fetchBeatmapFile(data.beatmapId);
    return { content: osuFile };
  });

export const getScore = createServerFn({ method: "GET" })
  .inputValidator((data: { scoreId: number; mode?: string }) => data)
  .handler(async ({ data }: { data: { scoreId: number; mode?: string } }) => {
    edgeCache(300, 1800);
    const mode = data.mode ?? "mania";

    try {
      const legacyScore = await osuFetch<OsuScore>(`/scores/${mode}/${data.scoreId}`);
      const resolvedMode = legacyScore.beatmap?.mode ?? mode;
      if (resolvedMode === mode) {
        return legacyScore;
      }
    } catch {
      // Fall back to modern score lookup below.
    }

    return osuFetch<OsuScore>(`/scores/${data.scoreId}`);
  });
