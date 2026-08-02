import { createServerFn } from "@tanstack/react-start";
import { searchHonoraryPlayers } from "../honorary-players";
import {
  beatmapScoreLookupPartialKey,
  beatmapScoreLookupStatusKey,
  sortBeatmapScores
} from "../beatmap-score-progress";
import {
  fetchWithCacheLock,
  getPersistentCached,
  osuFetch
} from "../api";
import type {
  BeatmapScoreLookupStatus,
  BeatmapScoresResponse,
  BeatmapsetSearchResponse,
  OsuBeatmap,
  OsuBeatmapset,
  OsuScore,
  OsuUser,
  UserSearchResponse
} from "../types";
import {
  edgeCache,
  noStore
} from "./server";
import {
  COUNTRY_BEATMAP_LOOKUP_CONCURRENCY,
  COUNTRY_BEATMAP_SCORES_CACHE_TTL,
  COUNTRY_BEATMAP_USER_SCORE_CACHE_TTL
} from "./constants";
import {
  clearBeatmapScoreLookupStatus,
  writeBeatmapScoreLookupStatus,
  writePartialBeatmapScores
} from "./status";
import type { BeatmapUserScoreResponse } from "./internal-types";
import {
  normalizeBeatmapPayload,
  normalizeBeatmapScoresPayload,
  normalizeBeatmapSearchPayload,
  normalizeBeatmapsetPayload,
  normalizeMapperSearchPayload,
  normalizeSearchUsersPayload
} from "./validators";
import { mapWithConcurrency } from "./concurrency";
import { getRankings } from "./rankings";

// ── Beatmaps ────────────────────────────────────────────────────────────────

export const searchBeatmaps = createServerFn({ method: "GET" })
  .validator(normalizeBeatmapSearchPayload)
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

export const searchBeatmapsByMappers = createServerFn({ method: "GET" })
  .validator(normalizeMapperSearchPayload)
  .handler(async ({ data }: { data: { usernames?: string[] } }) => {
    edgeCache(300, 3600);

    const usernames = [...new Set((data.usernames ?? [])
      .map((username) => username.trim())
      .filter((username) => /^[\w[\]-]{3,24}$/.test(username)))]
      .slice(0, 3);
    const beatmapsetTypes = ["loved", "ranked", "pending", "graveyard"] as const;
    const beatmapsetsById = new Map<number, OsuBeatmapset>();

    for (const username of usernames) {
      try {
        const user = await osuFetch<OsuUser>(
          `/users/${encodeURIComponent(username)}/mania`,
          undefined,
          { caller: "searchBeatmapsByMappers:user" },
        );

        for (const type of beatmapsetTypes) {
          try {
            const beatmapsets = await osuFetch<OsuBeatmapset[]>(
              `/users/${user.id}/beatmapsets/${type}`,
              { limit: 50, offset: 0 },
              { caller: "searchBeatmapsByMappers:beatmapsets" },
            );
            for (const beatmapset of beatmapsets) {
              if ((beatmapset.beatmaps ?? []).some((beatmap) => beatmap.mode === "mania")) {
                beatmapsetsById.set(beatmapset.id, beatmapset);
              }
            }
          } catch {
            // Some users simply have no sets in a category.
          }
        }
      } catch {
        // Treat non-user tokens from broad searches as misses.
      }
    }

    return { beatmapsets: [...beatmapsetsById.values()] };
  });

export const getBeatmapset = createServerFn({ method: "GET" })
  .validator(normalizeBeatmapsetPayload)
  .handler(async ({ data }: { data: { beatmapsetId: number } }) => {
    edgeCache(300, 3600);
    return osuFetch<OsuBeatmapset>(
      `/beatmapsets/${data.beatmapsetId}`,
      undefined,
      { caller: "getBeatmapset" },
    );
  });

export const getBeatmapsetForBeatmap = createServerFn({ method: "GET" })
  .validator(normalizeBeatmapPayload)
  .handler(async ({ data }: { data: { beatmapId: number } }) => {
    edgeCache(300, 3600);
    const beatmap = await osuFetch<OsuBeatmap>(
      `/beatmaps/${data.beatmapId}`,
      undefined,
      { caller: "getBeatmapsetForBeatmap" },
    );
    return osuFetch<OsuBeatmapset>(
      `/beatmapsets/${beatmap.beatmapset_id}`,
      undefined,
      { caller: "getBeatmapsetForBeatmap:beatmapset" },
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

async function getCountryBeatmapScores(beatmapId: number, country: string, page: number): Promise<OsuScore[]> {
  const normalizedCountry = country.trim().toUpperCase();
  const safePage = Math.max(1, Math.min(2, Math.round(page)));
  const cacheKey = `country-beatmap-scores:${beatmapId}:${normalizedCountry}:page:${safePage}`;

  return fetchWithCacheLock(cacheKey, COUNTRY_BEATMAP_SCORES_CACHE_TTL, async () => {
    writeBeatmapScoreLookupStatus(beatmapId, normalizedCountry, {
      phase: "scores",
      label: "Loading country players",
      current: 0,
      total: 0,
      found: 0,
    }, { force: true });
    writePartialBeatmapScores(beatmapId, normalizedCountry, []);

    try {
      const rankingPage = await getRankings({ data: { type: "performance", page: safePage, country: normalizedCountry } });
      const rankedUsers = rankingPage.ranking;
      const userIds = Array.from(new Set(rankedUsers.map((entry) => entry.user.id)));
      const partialScores: OsuScore[] = [];
      let checked = 0;

      writeBeatmapScoreLookupStatus(beatmapId, normalizedCountry, {
        phase: "scores",
        label: "Checking player scores",
        current: checked,
        total: userIds.length,
        found: partialScores.length,
      }, { force: true });

      await mapWithConcurrency(
        userIds,
        COUNTRY_BEATMAP_LOOKUP_CONCURRENCY,
        async (userId) => {
          const score = await getBeatmapUserScore(beatmapId, userId).catch(() => null);
          checked += 1;

          if (score?.user?.country_code === normalizedCountry) {
            partialScores.push(score);
            writePartialBeatmapScores(beatmapId, normalizedCountry, partialScores);
          }

          writeBeatmapScoreLookupStatus(beatmapId, normalizedCountry, {
            phase: "scores",
            label: "Checking player scores",
            current: checked,
            total: userIds.length,
            found: partialScores.length,
          });
        },
      );

      const sortedScores = sortBeatmapScores(partialScores);
      writePartialBeatmapScores(beatmapId, normalizedCountry, sortedScores);
      return sortedScores;
    } finally {
      clearBeatmapScoreLookupStatus(beatmapId, normalizedCountry);
    }
  });
}

export const getBeatmapScores = createServerFn({ method: "GET" })
  .validator(normalizeBeatmapScoresPayload)
  .handler(async ({ data }: { data: { beatmapId: number; country?: string; page: number } }) => {
    edgeCache(120, 600);
    if (data.country?.trim()) {
      return { scores: await getCountryBeatmapScores(data.beatmapId, data.country, data.page) };
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

export const getBeatmapScoreLookupStatus = createServerFn({ method: "GET" })
  .validator(normalizeBeatmapScoresPayload)
  .handler(async ({ data }: { data: { beatmapId: number; country?: string; page: number } }): Promise<BeatmapScoreLookupStatus | null> => {
    noStore();
    if (!data.country?.trim()) return null;
    return (await getPersistentCached<BeatmapScoreLookupStatus>(
      beatmapScoreLookupStatusKey(data.beatmapId, data.country),
    )) ?? null;
  });

export const getPartialBeatmapScores = createServerFn({ method: "GET" })
  .validator(normalizeBeatmapScoresPayload)
  .handler(async ({ data }: { data: { beatmapId: number; country?: string; page: number } }): Promise<OsuScore[]> => {
    noStore();
    if (!data.country?.trim()) return [];
    return (await getPersistentCached<OsuScore[]>(
      beatmapScoreLookupPartialKey(data.beatmapId, data.country),
    )) ?? [];
  });

// ── Search ──────────────────────────────────────────────────────────────────

export const searchUsers = createServerFn({ method: "GET" })
  .validator(normalizeSearchUsersPayload)
  .handler(async ({ data }: { data: { query: string } }) => {
    edgeCache(60, 600);
    const response = await osuFetch<UserSearchResponse>(
      "/search",
      {
        mode: "user",
        query: data.query,
      },
      { caller: "searchUsers" },
    );
    return mergeHonoraryMatches(response, data.query);
  });

/* osu!'s user search can't return a deleted account, so the honorary roster is
   merged in locally. Matches go first (someone typing "jakads" wants Jakads,
   not the live accounts that merely contain the string) and existing rows for
   the same id are dropped so a still-live honorary player isn't listed twice. */
function mergeHonoraryMatches(response: UserSearchResponse, query: string): UserSearchResponse {
  const matches = searchHonoraryPlayers(query);
  if (matches.length === 0) return response;

  const matchIds = new Set(matches.map((player) => player.id));
  const existing = (response.user?.data ?? []).filter((entry) => !matchIds.has(entry.id));
  const merged = matches.map((player) => ({
    id: player.id,
    username: player.username,
    avatar_url: player.avatarUrl,
    country_code: player.countryCode,
    is_online: false,
  }));

  return {
    user: {
      data: [...merged, ...existing],
      total: (response.user?.total ?? existing.length) + merged.length,
    },
  };
}
