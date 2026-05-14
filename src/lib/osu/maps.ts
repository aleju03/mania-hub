import { createServerFn } from "@tanstack/react-start";
import {
  deleteExpiredCacheEntriesByPrefix,
  deletePersistentCacheEntries,
  fetchWithCacheLock,
  fetchWithStaleAllowed,
  osuFetch,
  runCacheRebuild
} from "../api";
import {
  getModAcronyms,
  getScoreTimestamp,
  getScoreUrl
} from "../score";
import { detectManiaPatterns } from "../mania-patterns";
import type {
  BeatmapPlaycount,
  CountryMapsData,
  MapsAggregatedBeatmap,
  MapsAggregatedFavourite,
  MapsFarmedEntry,
  MapsFavouriteBeatmapset,
  MapsPlayerFavourites,
  OsuBeatmapset,
  OsuScore
} from "../types";
import {
  assertDevMutationAllowed,
  edgeCache
} from "./core";
import {
  FARMED_SINGLE_PLAYER_PP_MIN,
  MAPS_DATA_CACHE_VERSION,
  MAPS_FARMED_CACHE_TTL,
  MAPS_FAVOURITES_CACHE_TTL,
  MAPS_FETCH_CONCURRENCY,
  USER_FAVOURITES_CACHE_TTL,
  USER_FAVOURITES_MAX_PAGES,
  USER_FAVOURITES_PAGE_SIZE,
  USER_MOST_PLAYED_CACHE_TTL
} from "./constants";
import { mapWithConcurrency } from "./concurrency";
import { fetchUserBestScoresWindow } from "./users";

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
          const bestScores = await fetchUserBestScoresWindow(user.id, 200, {
            feature: "country-top-plays-refresh",
          }).catch(() => [] as OsuScore[]);
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
                  beatmapsetId: bm.beatmapset_id,
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
    await assertDevMutationAllowed("Country maps rebuild");
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
    await assertDevMutationAllowed("Country maps farmed rebuild");
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
    await assertDevMutationAllowed("Country maps favourites rebuild");
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
    await assertDevMutationAllowed("Country maps user rebuild");
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

