import { createServerFn } from "@tanstack/react-start";
import {
  fetchWithCacheLock,
  getPersistentCached
} from "../api";
import {
  db,
  ensureCacheSchema,
  hasDb
} from "../db";
import { normalizeCountryCode } from "../country";
import { getScoreTimestamp } from "../score";
import type {
  CountryTopPlay,
  HomePageData,
  LeanHomePopoff,
  LeanHomeScore,
  OsuScore,
  TopPlaysRefreshStatus,
  TopPlaysResponse
} from "../types";
import {
  edgeCache,
  getErrorMessage,
  noStore
} from "./core";
import { toLeanHomeScore } from "./mappers";
import {
  APPROX_PP_GAINS_CONCURRENCY,
  COUNTRY_POPOFFS_CACHE_TTL,
  COUNTRY_POPOFFS_CACHE_VERSION,
  COUNTRY_TOP_PLAYS_QUERY_LIMIT,
  COUNTRY_TOP_PLAYS_REFRESH_LOCK_TTL,
  COUNTRY_TOP_PLAYS_REFRESH_TTL,
  COUNTRY_TOP_PLAYS_RETENTION_MS,
  HOME_PAGE_CACHE_TTL,
  HOME_POPOFFS_CACHE_TTL,
  HOME_POPOFFS_PLAYER_COUNT,
  HOME_RECENT_SCORES_CACHE_TTL,
  HOME_RECENT_SCORES_LIVE_PLAYER_COUNT,
  HOME_RECENT_SCORES_OSU_FALLBACK_PLAYER_COUNT,
  POPOFF_WINDOW_MS,
  SCORE_PP_GAIN_REUSE_MS
} from "./constants";
import type { PopoffWindow } from "./constants";
import {
  clearPartialTopPlays,
  clearTopPlaysRefreshStatus,
  topPlaysPartialKey,
  topPlaysStatusKey,
  writePartialTopPlays,
  writeTopPlaysRefreshStatus
} from "./status";
import type {
  CachedScorePpGain,
  ScorePpGainLookup
} from "./internal-types";
import {
  normalizeCountryPayload,
  normalizeCountryPopoffsPayload,
  normalizeHomePopoffsPayload,
  normalizeHomeRecentScoresPayload
} from "./validators";
import { mapWithConcurrency } from "./concurrency";
import {
  calculateReplacementPpGainMapForTargets,
  fetchUserBestScoresWindow,
  getTimestampMs
} from "./users";
import { getRankings } from "./rankings";
import {
  fetchCountryRecentScores,
  fetchOscCountryRecentScores
} from "./tracker";

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
  const liveUserIds = userIds.slice(0, HOME_RECENT_SCORES_LIVE_PLAYER_COUNT);
  if (liveUserIds.length === 0) return [];
  const fallbackUserIds = liveUserIds.slice(0, HOME_RECENT_SCORES_OSU_FALLBACK_PLAYER_COUNT);
  // Keep the response lean while merging the public live tracker feed for the
  // first rankings page with a small osu! recent-score fallback.
  const cacheKey = `home-recent-scores:v6:${liveUserIds.join(",")}`;

  return fetchWithCacheLock(cacheKey, HOME_RECENT_SCORES_CACHE_TTL, async () => {
    const [liveResult, fallbackResult] = await Promise.allSettled([
      fetchOscCountryRecentScores(liveUserIds, {
        batchSize: liveUserIds.length,
        batchIndex: 0,
        recentLimit: 20,
      }),
      fetchCountryRecentScores(fallbackUserIds, {
        batchSize: fallbackUserIds.length,
        batchIndex: 0,
        recentLimit: 20,
      }),
    ]);
    const liveScores = liveResult.status === "fulfilled" ? liveResult.value ?? [] : [];
    const fallbackScores = fallbackResult.status === "fulfilled" ? fallbackResult.value : [];
    const scores = [...liveScores, ...fallbackScores];
    return buildRecentScoresPreview(scores, 5).map((score) => toLeanHomeScore(score));
  });
}

type HomePreviewPlayer = {
  id: number;
  username: string;
  avatar_url: string;
};

type CountryPopoff = CountryTopPlay;

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
          const scores = await fetchUserBestScoresWindow(player.id, 100, {
            feature: "home-popoffs",
            playerCount: topPlayersForPopoffs.length,
            concurrency: APPROX_PP_GAINS_CONCURRENCY,
          });
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

async function buildCountryPopoffsForPlayer(
  player: HomePreviewPlayer,
  windowMs: number,
  options: { knownPpGainsByScoreId?: ReadonlyMap<number, CachedScorePpGain> } = {},
): Promise<CountryPopoff[]> {
  const scores = await fetchUserBestScoresWindow(player.id, 100, {
    feature: "home-profile-preview",
  });
  const relevantScores = scores.filter((score) => {
    const age = Date.now() - getTimestampMs(score);
    return age < windowMs && score.pp != null && score.pp > 0;
  });
  const cachedGainMap: Record<number, number> = {};
  const uncachedTargets: ScorePpGainLookup[] = [];

  relevantScores.forEach((score) => {
    const scoreId = score.id;
    const known = options.knownPpGainsByScoreId?.get(scoreId);
    const currentPp = score.pp ?? 0;
    if (
      scoreId > 0 &&
      known &&
      Number.isFinite(known.pp) &&
      Number.isFinite(known.ppGain) &&
      Math.abs(known.pp - currentPp) < 0.01
    ) {
      cachedGainMap[scoreId] = Math.max(0, known.ppGain);
      return;
    }

    uncachedTargets.push({
      beatmapId: score.beatmap_id ?? score.beatmap?.id ?? 0,
      scoreId,
      timestamp: getScoreTimestamp(score),
      userId: player.id,
    });
  });

  const gainMap = await calculateReplacementPpGainMapForTargets(
    scores,
    uncachedTargets,
  );
  const mergedGainMap = { ...cachedGainMap, ...gainMap };

  return relevantScores
    .map((score) => ({
      user: player,
      score,
      pp: score.pp ?? 0,
      weightedPP: score.weight?.pp ?? 0,
      ppGain: mergedGainMap[score.id] ?? 0,
      time: getScoreTimestamp(score),
    }));
}

async function buildLiveCountryPopoffs(
  players: HomePreviewPlayer[],
  window: PopoffWindow,
  options: {
    progressCountry?: string;
    knownPpGainsByScoreId?: ReadonlyMap<number, CachedScorePpGain>;
  } = {},
): Promise<CountryPopoff[]> {
  const topPlayers = players.slice(0, 30);
  if (topPlayers.length === 0) return [];

  const windowMs = POPOFF_WINDOW_MS[window];
  const cacheKey = `country-popoffs:v${COUNTRY_POPOFFS_CACHE_VERSION}:${window}:${topPlayers.map((player) => player.id).join(",")}`;

  return fetchWithCacheLock(cacheKey, COUNTRY_POPOFFS_CACHE_TTL, async () => {
    let completed = 0;
    const partialPopoffs: CountryPopoff[] = [];
    const progressCountry = options.progressCountry;
    if (progressCountry) {
      clearPartialTopPlays(progressCountry);
      writeTopPlaysRefreshStatus(
        progressCountry,
        {
          phase: "scores",
          label: "Checking players' best scores",
          current: 0,
          total: topPlayers.length,
          found: 0,
        },
        { force: true },
      );
    }

    const results = await mapWithConcurrency(
      topPlayers,
      APPROX_PP_GAINS_CONCURRENCY,
      async (player) => {
        let playerPopoffs: CountryPopoff[] = [];
        try {
          playerPopoffs = await buildCountryPopoffsForPlayer(player, windowMs, {
            knownPpGainsByScoreId: options.knownPpGainsByScoreId,
          });
          return playerPopoffs;
        } catch (error) {
          console.warn("[osu] failed to build country popoff scores for player", {
            playerId: player.id,
            username: player.username,
            error: getErrorMessage(error),
          });
          return [] as CountryPopoff[];
        } finally {
          completed += 1;
          partialPopoffs.push(...playerPopoffs);
          const latest = sortCountryPopoffs(partialPopoffs);
          if (progressCountry) {
            writeTopPlaysRefreshStatus(progressCountry, {
              phase: "scores",
              label: "Checking players' best scores",
              current: completed,
              total: topPlayers.length,
              found: latest.length,
            });
            writePartialTopPlays(progressCountry, latest);
          }
        }
      },
    );

    return sortCountryPopoffs(results.flatMap((scores) => scores));
  });
}

async function getStoredCountryTopPlays(country: string, window: PopoffWindow): Promise<CountryPopoff[]> {
  if (!hasDb() || !db) return [];

  try {
    await ensureCacheSchema();

    const result = await db.execute({
      sql: `
        SELECT user_id, username, avatar_url, score_json, pp, weighted_pp, pp_gain, score_time
        FROM country_top_plays INDEXED BY idx_country_top_plays_country_pp_time
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
  const knownPpGainsByScoreId = new Map<number, CachedScorePpGain>();
  const reuseCutoff = Date.now() - SCORE_PP_GAIN_REUSE_MS;
  const stored = await getStoredCountryTopPlays(country, "30d");
  for (const popoff of stored) {
    const scoreId = popoff.score.id;
    const scoreTime = new Date(popoff.time).getTime();
    if (scoreId <= 0) continue;
    if (!Number.isFinite(scoreTime) || scoreTime < reuseCutoff) continue;
    if (!Number.isFinite(popoff.pp) || !Number.isFinite(popoff.ppGain)) continue;
    knownPpGainsByScoreId.set(scoreId, {
      pp: popoff.pp,
      ppGain: popoff.ppGain,
    });
  }

  const refreshed = await buildLiveCountryPopoffs(players, "30d", {
    progressCountry: country,
    knownPpGainsByScoreId,
  });
  await upsertStoredCountryTopPlays(country, refreshed);
  return Date.now();
}

async function refreshStoredCountryTopPlaysWithLock(country: string, players: HomePreviewPlayer[]): Promise<boolean> {
  const normalizedCountry = normalizeCountryCode(country);
  const cacheKey = `country-top-plays-refresh:v1:${normalizedCountry}`;
  let ranRefresh = false;
  await fetchWithCacheLock(
    cacheKey,
    COUNTRY_TOP_PLAYS_REFRESH_TTL,
    () => {
      ranRefresh = true;
      return refreshStoredCountryTopPlays(normalizedCountry, players);
    },
    COUNTRY_TOP_PLAYS_REFRESH_LOCK_TTL,
  );
  return ranRefresh;
}

const topPlaysBackgroundRefreshInProgress = new Set<string>();

function refreshStoredCountryTopPlaysInBackground(country: string, players: HomePreviewPlayer[]): boolean {
  const normalizedCountry = normalizeCountryCode(country);
  if (topPlaysBackgroundRefreshInProgress.has(normalizedCountry)) return true;
  topPlaysBackgroundRefreshInProgress.add(normalizedCountry);
  void refreshStoredCountryTopPlaysWithLock(normalizedCountry, players)
    .then((ranRefresh) => {
      if (!ranRefresh) return;
      clearTopPlaysRefreshStatus(normalizedCountry);
      clearPartialTopPlays(normalizedCountry);
    })
    .catch((error) => {
      console.warn("[osu] failed to refresh stored country top plays in background", {
        country: normalizedCountry,
        error: getErrorMessage(error),
      });
    })
    .finally(() => {
      topPlaysBackgroundRefreshInProgress.delete(normalizedCountry);
    });
  return true;
}

async function buildCountryPopoffs(
  country: string | undefined,
  players: HomePreviewPlayer[],
  window: PopoffWindow,
  refresh: boolean,
): Promise<TopPlaysResponse> {
  if (!country || !hasDb()) {
    const popoffs = await buildLiveCountryPopoffs(
      players,
      window,
      country ? { progressCountry: normalizeCountryCode(country) } : {},
    );
    return { popoffs, scannedAt: Date.now(), window };
  }

  const normalizedCountry = normalizeCountryCode(country);
  const stored = await getStoredCountryTopPlays(normalizedCountry, window);
  if (stored.length > 0) {
    const refreshInProgress = refresh && refreshStoredCountryTopPlaysInBackground(normalizedCountry, players);
    return {
      popoffs: stored,
      scannedAt: Date.now(),
      window,
      refreshInProgress,
    };
  }

  let live: CountryPopoff[] = [];
  try {
    live = await buildLiveCountryPopoffs(players, window, { progressCountry: normalizedCountry });
  } finally {
    clearTopPlaysRefreshStatus(normalizedCountry);
    clearPartialTopPlays(normalizedCountry);
  }
  await upsertStoredCountryTopPlays(normalizedCountry, live);

  if (window !== "30d") {
    refreshStoredCountryTopPlaysInBackground(normalizedCountry, players);
  }

  const selectedWindow = sortCountryPopoffs(filterPopoffsForWindow(live, window));
  if (selectedWindow.length > 0 || window !== "30d") {
    return {
      popoffs: selectedWindow,
      scannedAt: Date.now(),
      window,
      refreshInProgress: window !== "30d",
    };
  }

  try {
    await refreshStoredCountryTopPlaysWithLock(normalizedCountry, players);
    clearTopPlaysRefreshStatus(normalizedCountry);
    clearPartialTopPlays(normalizedCountry);
  } catch (error) {
    console.warn("[osu] failed to warm stored country top plays", {
      country: normalizedCountry,
      error: getErrorMessage(error),
    });
    return { popoffs: selectedWindow, scannedAt: Date.now(), window };
  }

  const refreshed = await getStoredCountryTopPlays(normalizedCountry, window);
  if (refreshed.length > 0) {
    return { popoffs: refreshed, scannedAt: Date.now(), window };
  }
  return { popoffs: selectedWindow, scannedAt: Date.now(), window };
}

export const getHomePageData = createServerFn({ method: "GET" })
  .inputValidator(normalizeCountryPayload)
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
  .inputValidator(normalizeHomeRecentScoresPayload)
  .handler(async ({ data }: { data: { userIds: number[] } }) => {
    edgeCache(60, 300);
    return buildHomeRecentScoresPreview(data.userIds);
  });

export const getHomePopoffs = createServerFn({ method: "GET" })
  .inputValidator(normalizeHomePopoffsPayload)
  .handler(async ({ data }: { data: { players: HomePreviewPlayer[] } }) => {
    edgeCache(300, 1800);
    return buildHomePopoffs(data.players);
  });

export const getCountryPopoffs = createServerFn({ method: "GET" })
  .inputValidator(normalizeCountryPopoffsPayload)
  .handler(async ({ data }: { data: { country?: string; players: HomePreviewPlayer[]; window?: PopoffWindow; refresh?: boolean } }) => {
    noStore();
    return buildCountryPopoffs(data.country, data.players, data.window ?? "30d", data.refresh !== false);
  });

export const getTopPlaysRefreshStatus = createServerFn({ method: "GET" })
  .inputValidator(normalizeCountryPayload)
  .handler(async ({ data }: { data?: { country?: string } }): Promise<TopPlaysRefreshStatus | null> => {
    noStore();
    const country = normalizeCountryCode(data?.country ?? "CR");
    return (await getPersistentCached<TopPlaysRefreshStatus>(topPlaysStatusKey(country))) ?? null;
  });

export const getPartialTopPlays = createServerFn({ method: "GET" })
  .inputValidator(normalizeCountryPayload)
  .handler(async ({ data }: { data?: { country?: string } }): Promise<CountryTopPlay[]> => {
    noStore();
    const country = normalizeCountryCode(data?.country ?? "CR");
    return (await getPersistentCached<CountryTopPlay[]>(topPlaysPartialKey(country))) ?? [];
  });
