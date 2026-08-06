import { createServerFn } from "@tanstack/react-start";
import {
  fetchWithCacheLock,
  osuFetch
} from "../api";
import type { RankingsResponse } from "../types";
import { edgeCache } from "./server";
import { toLeanRankingEntry } from "./mappers";
import type { RawRankingsResponse } from "./mappers";
import {
  OSU_PROXY_STALE_MS,
  RANKINGS_CACHE_TTL
} from "./constants";
import { normalizeRankingsPayload } from "./validators";

export const getRankings = createServerFn({ method: "GET" })
  .validator(normalizeRankingsPayload)
  .handler(async ({ data }: { data: { type?: string; page?: number; country?: string } }): Promise<RankingsResponse> => {
    edgeCache(60, 300);
    const type = data.type ?? "performance";
    return fetchRankingsPage(type, data.page ?? 1, data.country);
  });

// v4: lean ranking users read cover_url from user.cover.url for replay
// suggestion banners. Bumped so broken v3 entries with undefined banners
// are refetched.
function rankingsCacheKey(type: string, page: number, country?: string): string {
  return `rankings:v4:${type}:${page}:${country ?? ""}`;
}

export async function fetchRankingsPage(type: string, page: number, country?: string): Promise<RankingsResponse> {
  const cacheKey = rankingsCacheKey(type, page, country);
  return fetchWithCacheLock(cacheKey, RANKINGS_CACHE_TTL, async () => {
    const raw = await osuFetch<RawRankingsResponse>(
      `/rankings/mania/${type}`,
      {
        "cursor[page]": page,
        country,
      },
      // Stale window keeps replay scoreboards and OG cards working through osu! hiccups.
      { caller: "getRankings", cacheTtlMs: RANKINGS_CACHE_TTL, staleMs: OSU_PROXY_STALE_MS },
    );
    return {
      cursor: raw.cursor,
      ranking: raw.ranking.map(toLeanRankingEntry),
      total: raw.total,
    };
  });
}

