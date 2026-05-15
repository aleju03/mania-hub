import { createServerFn } from "@tanstack/react-start";
import {
  fetchWithCacheLock,
  getPersistentCacheEntries,
  osuFetch
} from "../api";
import type { RankingsResponse } from "../types";
import { edgeCache } from "./server";
import { toLeanRankingEntry } from "./mappers";
import type { RawRankingsResponse } from "./mappers";
import {
  RANKINGS_CACHE_TTL,
  RANK_HISTORY_CONCURRENCY
} from "./constants";
import {
  normalizeRankHistoryPayload,
  normalizeRankingsPayload
} from "./validators";
import { mapWithConcurrency } from "./concurrency";
import {
  fetchAndCacheUserRankHistory,
  getRankHistoryCacheKey
} from "./users";

export const getRankings = createServerFn({ method: "GET" })
  .inputValidator(normalizeRankingsPayload)
  .handler(async ({ data }: { data: { type?: string; page?: number; country?: string } }): Promise<RankingsResponse> => {
    edgeCache(60, 300);
    const type = data.type ?? "performance";
    return fetchRankingsPage(type, data.page ?? 1, data.country);
  });

export async function fetchRankingsPage(type: string, page: number, country?: string): Promise<RankingsResponse> {
  // v4: lean ranking users read cover_url from user.cover.url for replay
  // suggestion banners. Bumped so broken v3 entries with undefined banners
  // are refetched.
  const cacheKey = `rankings:v4:${type}:${page}:${country ?? ""}`;
  return fetchWithCacheLock(cacheKey, RANKINGS_CACHE_TTL, async () => {
    const raw = await osuFetch<RawRankingsResponse>(
      `/rankings/mania/${type}`,
      {
        "cursor[page]": page,
        country,
      },
      { caller: "getRankings" },
    );
    return {
      cursor: raw.cursor,
      ranking: raw.ranking.map(toLeanRankingEntry),
      total: raw.total,
    };
  });
}

// ── Batch user rank history ────────────────────────────────────────────────

export const getUsersRankHistory = createServerFn({ method: "GET" })
  .inputValidator(normalizeRankHistoryPayload)
  .handler(async ({ data }: { data: { userIds: number[] } }) => {
    edgeCache(3600, 86400);
    const uniqueUserIds = [...new Set(data.userIds)];
    const cacheKeysByUserId = new Map(uniqueUserIds.map((userId) => [userId, getRankHistoryCacheKey(userId)]));
    const cachedHistories = await getPersistentCacheEntries<number[] | null>([...cacheKeysByUserId.values()]);
    const out: Record<number, number[]> = {};
    const missingUserIds: number[] = [];

    for (const userId of uniqueUserIds) {
      const cacheKey = cacheKeysByUserId.get(userId)!;
      if (!cachedHistories.has(cacheKey)) {
        missingUserIds.push(userId);
        continue;
      }
      const history = cachedHistories.get(cacheKey);
      if (history?.length) out[userId] = history;
    }

    const fetchedResults = await mapWithConcurrency(
      missingUserIds,
      RANK_HISTORY_CONCURRENCY,
      async (userId) => {
        try {
          const history = await fetchAndCacheUserRankHistory(userId);
          return { userId, history };
        } catch {
          return { userId, history: null };
        }
      },
    );

    fetchedResults.forEach(({ userId, history }) => {
      if (history?.length) {
        out[userId] = history;
      }
    });

    return out;
  });
