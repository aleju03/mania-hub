import { createServerFn } from "@tanstack/react-start";
import {
  fetchWithCacheLock,
  osuFetch
} from "../api";
import { normalizeCountryCode } from "../country";
import { getScoreTimestamp } from "../score";
import type {
  LeanTrackerScore,
  OsuBeatmap,
  OsuBeatmapset,
  OsuScore,
  RankingsResponse
} from "../types";
import {
  getErrorMessage
} from "./core";
import { edgeCache } from "./server";
import {
  APPROX_PP_GAINS_CONCURRENCY,
  OSC_BEATMAP_METADATA_CACHE_TTL,
  OSC_BEATMAP_METADATA_CONCURRENCY,
  OSC_FETCH_TIMEOUT_MS,
  OSC_RECENT_SCORES_CACHE_TTL,
  OSC_RECENT_SCORES_LIMIT,
  OSC_RECENT_SCORES_PAGES,
  RECENT_SCORES_CONCURRENCY,
  TRACKER_LIVE_SNAPSHOT_CACHE_TTL,
  TRACKER_LIVE_SNAPSHOT_CACHE_VERSION,
  TRACKER_RECENT_SCORES_CACHE_TTL,
  TRACKER_RECENT_SCORES_CACHE_VERSION
} from "./constants";
import { oscRecentScoresPromiseCache } from "./state";
import type {
  CountryRecentScoresResponse,
  OscScore,
  OscScoresResponse,
  ScorePpGainLookup,
  TrackerLiveSnapshotResponse,
  TrackerSnapshotResponse,
  TrackerUserSummary
} from "./internal-types";
import {
  normalizeCountryPayload,
  normalizeCountryRecentScoresPayload
} from "./validators";
import {
  mapWithConcurrency,
  withTrackerSnapshotBatchBudget
} from "./concurrency";
import {
  calculateReplacementPpGainMapForTargets,
  fetchUserBestScoresWindow,
  getCachedUser,
  getCachedUserScores
} from "./users";
import { fetchRankingsPage } from "./rankings";

function getOscBaseUrl(): string | null {
  if (process.env.OSC_TRACKER_ENABLED === "0" || process.env.OSC_TRACKER_DISABLED === "1") {
    return null;
  }
  const baseUrl = (process.env.OSC_BASE_URL ?? "https://osc.kaysting.dev").trim().replace(/\/+$/, "");
  return baseUrl || null;
}

async function fetchPublicJsonWithTimeout<T>(url: string, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.json() as T;
  } finally {
    clearTimeout(timeout);
  }
}

function getOscScoreTimeMs(score: OscScore): number {
  const timestamp = score.ended_at ?? score.created_at ?? "";
  return timestamp ? new Date(timestamp).getTime() : 0;
}

async function fetchOscRecentScoresPage(before?: number | null): Promise<OscScoresResponse> {
  const baseUrl = getOscBaseUrl();
  if (!baseUrl) throw new Error("oSC tracker feed is disabled.");

  const params = new URLSearchParams({
    limit: String(OSC_RECENT_SCORES_LIMIT),
    mode: "mania",
  });
  if (before != null) params.set("before", String(before));
  return fetchPublicJsonWithTimeout<OscScoresResponse>(
    `${baseUrl}/api/scores?${params.toString()}`,
    OSC_FETCH_TIMEOUT_MS,
  );
}

async function fetchOscRecentScores(): Promise<OscScore[]> {
  const cacheKey = `osc-recent-scores:mania:v1:${OSC_RECENT_SCORES_LIMIT}:${OSC_RECENT_SCORES_PAGES}`;
  const pending = oscRecentScoresPromiseCache.get(cacheKey);
  if (pending) return pending;

  const request = fetchWithCacheLock(cacheKey, OSC_RECENT_SCORES_CACHE_TTL, async () => {
    const scores: OscScore[] = [];
    const seen = new Set<number>();
    let before: number | null | undefined;

    for (let page = 0; page < OSC_RECENT_SCORES_PAGES; page++) {
      const response = await fetchOscRecentScoresPage(before);
      if (response.success === false) {
        throw new Error("oSC returned an unsuccessful response.");
      }
      const pageScores = response.scores ?? [];
      for (const score of pageScores) {
        if (!score || (score.ruleset_id != null && score.ruleset_id !== 3)) continue;
        if (!Number.isFinite(score.id) || seen.has(score.id)) continue;
        seen.add(score.id);
        scores.push(score);
      }

      const older = response.meta?.oldest;
      if (!older || pageScores.length === 0) break;
      before = older;
    }

    return scores.sort((a, b) => {
      const timeDelta = getOscScoreTimeMs(b) - getOscScoreTimeMs(a);
      return timeDelta !== 0 ? timeDelta : b.id - a.id;
    });
  }).finally(() => {
    oscRecentScoresPromiseCache.delete(cacheKey);
  });

  oscRecentScoresPromiseCache.set(cacheKey, request);
  return request;
}

async function getCachedBeatmapMetadataForTracker(
  beatmapId: number,
): Promise<{ beatmap: OsuBeatmap; beatmapset: OsuBeatmapset } | null> {
  const cacheKey = `tracker-beatmap-metadata:v1:${beatmapId}`;
  return fetchWithCacheLock(cacheKey, OSC_BEATMAP_METADATA_CACHE_TTL, async () => {
    const beatmap = await osuFetch<OsuBeatmap>(
      `/beatmaps/${beatmapId}`,
      undefined,
      { caller: "trackerBeatmapMetadata:beatmap" },
    );
    const beatmapset = await osuFetch<OsuBeatmapset>(
      `/beatmapsets/${beatmap.beatmapset_id}`,
      undefined,
      { caller: "trackerBeatmapMetadata:beatmapset" },
    );
    return { beatmap, beatmapset };
  }).catch((error) => {
    console.warn("[osu] failed to hydrate oSC beatmap metadata", {
      beatmapId,
      error: getErrorMessage(error),
    });
    return null;
  });
}

async function getTrackerUserSummary(
  userId: number,
  usersById: ReadonlyMap<number, TrackerUserSummary>,
): Promise<TrackerUserSummary | null> {
  const known = usersById.get(userId);
  if (known) return known;

  try {
    const user = await getCachedUser(String(userId));
    return {
      id: user.id,
      username: user.username,
      avatar_url: user.avatar_url,
      country_code: user.country_code,
    };
  } catch {
    return null;
  }
}

function scoreNumberFromOsc(score: OscScore): number {
  return score.score
    ?? score.legacy_total_score
    ?? score.classic_total_score
    ?? score.total_score
    ?? 0;
}

function hydrateOscScore(
  score: OscScore,
  user: TrackerUserSummary,
  metadata: { beatmap: OsuBeatmap; beatmapset: OsuBeatmapset },
): OsuScore {
  return {
    id: score.id,
    legacy_score_id: score.legacy_score_id,
    user_id: score.user_id,
    accuracy: score.accuracy,
    beatmap_id: score.beatmap_id,
    build_id: score.build_id,
    mods: score.mods ?? [],
    score: scoreNumberFromOsc(score),
    total_score: score.total_score,
    classic_total_score: score.classic_total_score,
    legacy_total_score: score.legacy_total_score,
    max_combo: score.max_combo,
    passed: score.passed,
    ranked: score.ranked,
    rank: score.rank,
    statistics: score.statistics ?? {},
    pp: score.pp ?? null,
    beatmap: metadata.beatmap,
    beatmapset: metadata.beatmapset,
    user,
    created_at: score.created_at,
    started_at: score.started_at,
    ended_at: score.ended_at,
    replay: score.replay,
    has_replay: score.has_replay,
    is_perfect_combo: score.is_perfect_combo,
    legacy_perfect: score.legacy_perfect,
    processed: score.processed,
    type: score.type,
  };
}

export async function fetchOscCountryRecentScores(
  userIds: number[],
  options?: { batchSize?: number; batchIndex?: number; recentLimit?: number; users?: TrackerUserSummary[] },
): Promise<OsuScore[] | null> {
  if (!getOscBaseUrl()) return null;

  const batch = getCountryRecentScoresBatchUserIds(userIds, options);
  if (batch.length === 0) return [];

  const batchUserIds = new Set(batch);
  const usersById = new Map((options?.users ?? []).map((user) => [user.id, user]));
  const maxScores = Math.max(1, batch.length * (options?.recentLimit ?? 20));
  const rawScores = await fetchOscRecentScores();
  const matched = rawScores
    .filter((score) => batchUserIds.has(score.user_id))
    .filter((score) => Number.isFinite(score.beatmap_id) && score.beatmap_id > 0)
    .slice(0, maxScores);

  if (matched.length === 0) return [];

  const uniqueBeatmapIds = [...new Set(matched.map((score) => score.beatmap_id))];
  const metadataEntries = await mapWithConcurrency(
    uniqueBeatmapIds,
    OSC_BEATMAP_METADATA_CONCURRENCY,
    async (beatmapId) => [beatmapId, await getCachedBeatmapMetadataForTracker(beatmapId)] as const,
  );
  const metadataByBeatmapId = new Map(metadataEntries.filter((entry): entry is readonly [number, {
    beatmap: OsuBeatmap;
    beatmapset: OsuBeatmapset;
  }] => entry[1] !== null));

  const userEntries = await mapWithConcurrency(
    [...new Set(matched.map((score) => score.user_id))],
    OSC_BEATMAP_METADATA_CONCURRENCY,
    async (userId) => [userId, await getTrackerUserSummary(userId, usersById)] as const,
  );
  const hydratedUsersById = new Map(userEntries.filter((entry): entry is readonly [number, TrackerUserSummary] => entry[1] !== null));

  const scores: OsuScore[] = [];
  for (const score of matched) {
    const user = hydratedUsersById.get(score.user_id);
    const metadata = metadataByBeatmapId.get(score.beatmap_id);
    if (!user || !metadata) continue;
    scores.push(hydrateOscScore(score, user, metadata));
  }

  if (scores.length === 0) return null;
  return scores;
}

export async function fetchCountryRecentScores(
  userIds: number[],
  options?: { batchSize?: number; batchIndex?: number; recentLimit?: number },
): Promise<OsuScore[]> {
  const batch = getCountryRecentScoresBatchUserIds(userIds, options);
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

function getCountryRecentScoresBatchUserIds(
  userIds: number[],
  options?: { batchSize?: number; batchIndex?: number },
): number[] {
  if (userIds.length === 0) return [];
  const size = options?.batchSize ?? 5;
  const start = ((options?.batchIndex ?? 0) * size) % userIds.length;
  return userIds.slice(start, start + size);
}

function getTrackerRecentScoresCacheKey(
  userIds: number[],
  options?: { batchSize?: number; batchIndex?: number; recentLimit?: number; source?: "backfill" | "live" },
): string {
  const batchUserIds = getCountryRecentScoresBatchUserIds(userIds, options);
  return [
    `tracker-recent-scores:v${TRACKER_RECENT_SCORES_CACHE_VERSION}`,
    options?.source ?? "live",
    options?.recentLimit ?? 20,
    batchUserIds.join(","),
  ].join(":");
}

function toTrackerUserSummaries(rankings: RankingsResponse): TrackerUserSummary[] {
  return rankings.ranking
    .filter((entry) => entry.user.is_active !== false)
    .map((entry) => ({
      id: entry.user.id,
      username: entry.user.username,
      avatar_url: entry.user.avatar_url,
      country_code: entry.user.country_code,
    }));
}

function getTrackerScoreKey(score: LeanTrackerScore): string {
  return score.id > 0
    ? String(score.id)
    : `${score.user_id}:${score.beatmap_id ?? ""}:${score.created_at ?? ""}:${score.ended_at ?? ""}`;
}

function getLeanTrackerScoreTimeMs(score: LeanTrackerScore): number {
  return new Date(score.ended_at ?? score.created_at ?? score.started_at ?? "").getTime() || 0;
}

export async function fetchTrackerRecentScoresCached(
  userIds: number[],
  options: {
    batchIndex?: number;
    batchSize?: number;
    recentLimit?: number;
    source?: "backfill" | "live";
    users?: TrackerUserSummary[];
  },
): Promise<CountryRecentScoresResponse> {
  const cacheKey = getTrackerRecentScoresCacheKey(userIds, options);
  return fetchWithCacheLock(cacheKey, TRACKER_RECENT_SCORES_CACHE_TTL, () =>
    fetchCountryRecentScoresWithGains(userIds, options),
  );
}

function toLeanTrackerScore(score: OsuScore): LeanTrackerScore {
  return {
    id: score.id,
    legacy_score_id: score.legacy_score_id,
    user_id: score.user_id,
    accuracy: score.accuracy,
    beatmap_id: score.beatmap_id ?? score.beatmap?.id,
    mods: score.mods,
    score: score.score,
    total_score: score.total_score,
    classic_total_score: score.classic_total_score,
    legacy_total_score: score.legacy_total_score,
    max_combo: score.max_combo,
    passed: score.passed,
    rank: score.rank,
    statistics: score.statistics,
    pp: score.pp,
    beatmap: {
      id: score.beatmap.id,
      beatmapset_id: score.beatmap.beatmapset_id,
      difficulty_rating: score.beatmap.difficulty_rating,
      mode: score.beatmap.mode,
      cs: score.beatmap.cs,
      bpm: score.beatmap.bpm,
      max_combo: score.beatmap.max_combo,
      version: score.beatmap.version,
      url: score.beatmap.url,
    },
    beatmapset: {
      id: score.beatmapset.id,
      title: score.beatmapset.title,
      artist: score.beatmapset.artist,
      covers: score.beatmapset.covers,
    },
    user: {
      id: score.user.id,
      username: score.user.username,
      avatar_url: score.user.avatar_url,
      country_code: score.user.country_code,
    },
    created_at: score.created_at,
    started_at: score.started_at,
    ended_at: score.ended_at,
    replay: score.replay,
    has_replay: score.has_replay,
    type: score.type,
  };
}

async function fetchCountryRecentScoresWithGains(
  userIds: number[],
  options?: { batchSize?: number; batchIndex?: number; recentLimit?: number; users?: TrackerUserSummary[]; source?: "backfill" | "live" },
): Promise<CountryRecentScoresResponse> {
  let scores: OsuScore[];
  if (options?.source === "backfill") {
    scores = await fetchCountryRecentScores(userIds, options);
  } else {
    try {
      scores = await fetchOscCountryRecentScores(userIds, options) ?? await fetchCountryRecentScores(userIds, options);
    } catch (error) {
      console.warn("[osu] oSC tracker feed failed; falling back to osu! recent scores", {
        error: getErrorMessage(error),
      });
      scores = await fetchCountryRecentScores(userIds, options);
    }
  }
  const rankedTargets = Array.from(
    new Map(
      scores
        .filter((score) => score.id > 0 && score.pp != null && score.pp > 0)
        .map((score) => [
          score.id,
          {
            beatmapId: score.beatmap_id ?? score.beatmap?.id ?? 0,
            scoreId: score.id,
            timestamp: getScoreTimestamp(score),
            userId: score.user_id,
          } satisfies ScorePpGainLookup,
        ]),
    ).values(),
  );

  if (rankedTargets.length === 0) {
    return { scores: scores.map(toLeanTrackerScore), gains: {} };
  }

  const targetsByUserId = new Map<number, ScorePpGainLookup[]>();
  rankedTargets.forEach((target) => {
    const list = targetsByUserId.get(target.userId);
    if (list) list.push(target);
    else targetsByUserId.set(target.userId, [target]);
  });

  const groupedTargets = [...targetsByUserId.entries()];
  const groupedGains = await mapWithConcurrency(
    groupedTargets,
    APPROX_PP_GAINS_CONCURRENCY,
    async ([userId, targets]) => {
      try {
        const bestScores = await fetchUserBestScoresWindow(userId, 200, {
          feature: "tracker-pp-gains",
          groupedUsers: groupedTargets.length,
          targetCount: targets.length,
          concurrency: APPROX_PP_GAINS_CONCURRENCY,
        });
        return await calculateReplacementPpGainMapForTargets(bestScores, targets);
      } catch {
        return {} as Record<number, number>;
      }
    },
  );

  const gains: Record<number, number> = {};
  groupedGains.forEach((group) => Object.assign(gains, group));
  return { scores: scores.map(toLeanTrackerScore), gains };
}


// ── Score Feed (CR top players' recent scores) ─────────────────────────────

export const getCountryRecentScores = createServerFn({ method: "GET" })
  .inputValidator(normalizeCountryRecentScoresPayload)
  .handler(async ({ data }: { data: { userIds: number[]; users?: TrackerUserSummary[]; batchSize?: number; batchIndex?: number; recentLimit?: number; source?: "backfill" | "live" } }) => {
    edgeCache(30, 120);
    return fetchTrackerRecentScoresCached(data.userIds, data);
  });

export const getTrackerSnapshot = createServerFn({ method: "GET" })
  .inputValidator(normalizeCountryPayload)
  .handler(async ({ data }: { data: { country?: string } }): Promise<TrackerSnapshotResponse> => {
    edgeCache(30, 120);
    const country = normalizeCountryCode(data.country);
    const rankings = await fetchRankingsPage("performance", 1, country);
    const users = toTrackerUserSummaries(rankings);
    const userIds = users.map((user) => user.id);
    const seedBatchCount = Math.min(3, Math.ceil(userIds.length / 10));
    const feedResults = await Promise.allSettled(
      Array.from({ length: seedBatchCount }, async (_, batchIndex) => {
        const batchUsers = users.slice(batchIndex * 10, batchIndex * 10 + 10);
        const batchUserIds = batchUsers.map((user) => user.id);
        const feedOptions = {
          userIds: batchUserIds,
          users: batchUsers,
          batchSize: 10,
          batchIndex: 0,
          recentLimit: 10,
          source: "live" as const,
        };
        return withTrackerSnapshotBatchBudget(
          fetchTrackerRecentScoresCached(batchUserIds, feedOptions),
        );
      }),
    );
    const mergedScores = new Map<string, LeanTrackerScore>();
    const gains: Record<number, number> = {};
    for (const result of feedResults) {
      if (result.status !== "fulfilled" || !result.value) continue;
      Object.assign(gains, result.value.gains);
      for (const score of result.value.scores) {
        const key = getTrackerScoreKey(score);
        if (!mergedScores.has(key)) mergedScores.set(key, score);
      }
    }
    const scores = [...mergedScores.values()]
      .sort((a, b) => getLeanTrackerScoreTimeMs(b) - getLeanTrackerScoreTimeMs(a))
      .slice(0, 100);

    return {
      country,
      rankings,
      seedBatchCount,
      userIds,
      users,
      scores,
      gains,
      fetchedAt: Date.now(),
    };
  });

export const getTrackerLiveSnapshot = createServerFn({ method: "GET" })
  .inputValidator(normalizeCountryPayload)
  .handler(async ({ data }: { data: { country?: string } }): Promise<TrackerLiveSnapshotResponse> => {
    edgeCache(30, 120);
    const country = normalizeCountryCode(data.country);
    const minuteBucket = Math.floor(Date.now() / 60_000);
    const cacheKey = `tracker-live-snapshot:v${TRACKER_LIVE_SNAPSHOT_CACHE_VERSION}:${country}:${minuteBucket}`;

    return fetchWithCacheLock(cacheKey, TRACKER_LIVE_SNAPSHOT_CACHE_TTL, async () => {
      const rankings = await fetchRankingsPage("performance", 1, country);
      const users = toTrackerUserSummaries(rankings);
      const userIds = users.map((user) => user.id);
      const batchSize = 10;
      const totalBatches = Math.max(1, Math.ceil(userIds.length / batchSize));
      const batchIndex = minuteBucket % totalBatches;
      const batchUsers = users.slice(batchIndex * batchSize, batchIndex * batchSize + batchSize);
      const batchUserIds = batchUsers.map((user) => user.id);
      const feed = await fetchTrackerRecentScoresCached(batchUserIds, {
        users: batchUsers,
        batchSize,
        batchIndex: 0,
        recentLimit: 20,
        source: "live",
      });

      return {
        batchIndex,
        country,
        fetchedAt: Date.now(),
        gains: feed.gains,
        scores: feed.scores,
        totalBatches,
        userIds,
        users,
      };
    });
  });
