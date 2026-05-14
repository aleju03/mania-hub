import { createServerFn } from "@tanstack/react-start";
import {
  fetchWithCacheLock,
  getPersistentCacheEntryAllowStale,
  getPersistentCached,
  osuFetch,
  setPersistentCache
} from "../api";
import { normalizeCountryCode } from "../country";
import {
  getBoardLaneKey,
  getModAcronyms,
  getScoreDisplayValues,
  getScoreTimestamp,
  hasCustomRateMod
} from "../score";
import type {
  CountryBoardScore,
  CountryBoardSnapshot,
  CountryBoardSnapshotEntry,
  OsuScore,
  SnipeEvent,
  SnipesResponse,
  SnipesScanStatus
} from "../types";
import {
  getErrorMessage
} from "./core";
import { edgeCache } from "./server";
import {
  SNIPES_CACHE_TTL,
  SNIPES_LOCK_TTL,
  SNIPES_LOCK_WAIT_MS,
  SNIPES_LOCK_WAIT_RETRIES,
  SNIPES_LOG_CAP,
  SNIPES_LOG_TTL,
  SNIPES_PLAYER_LIMIT,
  SNIPES_PROBE_CONCURRENCY,
  SNIPES_RANKED_STATUSES,
  SNIPES_RECENT_LIMIT,
  SNIPES_RECENT_PLAYS_CACHE_TTL,
  SNIPES_SCAN_CONCURRENCY,
  SNIPES_SEED_MAX_AGE_MS,
  SNIPES_SEED_PROBE_BUDGET,
  SNIPES_SNAPSHOT_TTL
} from "./constants";
import {
  clearPartialSnipeEvents,
  clearSnipesScanStatus,
  snipesPartialEventsKey,
  snipesStatusKey,
  writePartialSnipeEvents,
  writeSnipesScanStatus
} from "./status";
import { userRecentPlaysPromiseCache } from "./state";
import { normalizeCountryPayload } from "./validators";
import { mapWithConcurrency } from "./concurrency";
import {
  getBeatmapUserScoresAll,
  getScoreRequestParams
} from "./users";
import { getRankings } from "./rankings";

// ── Snipes (per-beatmap country leaderboard #1 changes) ─────────────────────

async function fetchUserRecentPlays(userId: number): Promise<OsuScore[]> {
  const cacheKey = `user-recent-plays:mania:${userId}`;
  const cached = await getPersistentCached<OsuScore[]>(cacheKey);
  if (cached) return cached;

  const pending = userRecentPlaysPromiseCache.get(userId);
  if (pending) return pending;

  const request = fetchWithCacheLock(cacheKey, SNIPES_RECENT_PLAYS_CACHE_TTL, () =>
    osuFetch<OsuScore[]>(
      `/users/${userId}/scores/recent`,
      getScoreRequestParams({
        mode: "mania",
        limit: SNIPES_RECENT_LIMIT,
        offset: 0,
        include_fails: 0,
      }),
      { caller: "fetchUserRecentPlays" },
    ),
  ).finally(() => {
    userRecentPlaysPromiseCache.delete(userId);
  });

  userRecentPlaysPromiseCache.set(userId, request);
  return request;
}

function isSnipesRankedScore(score: OsuScore): boolean {
  if (score.ranked === false) return false;
  return !hasCustomRateMod(score.mods);
}

function boardScoreFromScore(score: OsuScore): CountryBoardScore | null {
  if (!score.user) return null;
  const display = getScoreDisplayValues(score);
  const totalScore = display.totalScore ?? score.total_score ?? score.score ?? 0;
  return {
    userId: score.user.id,
    username: score.user.username,
    avatarUrl: score.user.avatar_url,
    scoreId: score.id,
    totalScore,
    accuracy: display.accuracy,
    mods: getModAcronyms(score.mods),
    pp: score.pp,
    rank: display.rank,
    isLazer: display.isLazer,
    hasReplay: score.has_replay ?? score.replay ?? false,
    endedAt: getScoreTimestamp(score),
  };
}

type BoardMeta = Pick<CountryBoardSnapshotEntry, "beatmap" | "beatmapset">;

function boardMetadataFromScore(
  score: OsuScore,
  fallbackBeatmapset?: OsuScore["beatmapset"],
): BoardMeta | null {
  const beatmap = score.beatmap;
  const beatmapset = score.beatmapset ?? fallbackBeatmapset;
  if (!beatmap || !beatmapset) return null;
  return {
    beatmap: {
      version: beatmap.version,
      difficulty_rating: beatmap.difficulty_rating,
      cs: beatmap.cs,
      url: beatmap.url ?? `https://osu.ppy.sh/beatmaps/${beatmap.id}`,
    },
    beatmapset: {
      id: beatmapset.id,
      title: beatmapset.title,
      artist: beatmapset.artist,
      cover_url: beatmapset.covers?.["cover@2x"] ?? beatmapset.covers?.cover ?? "",
    },
  };
}

function buildSnipeEvent(
  beatmapId: number,
  meta: BoardMeta,
  sniper: CountryBoardScore,
  victim: CountryBoardScore,
  boardRank: number,
  isSeeded = false,
): SnipeEvent {
  return {
    beatmap_id: beatmapId,
    beatmapset_id: meta.beatmapset.id,
    score_id: sniper.scoreId,
    sniper: {
      id: sniper.userId,
      username: sniper.username,
      avatar_url: sniper.avatarUrl,
    },
    victim: {
      id: victim.userId,
      username: victim.username,
      avatar_url: victim.avatarUrl,
    },
    beatmap: meta.beatmap,
    beatmapset: meta.beatmapset,
    totalScore: sniper.totalScore,
    accuracy: sniper.accuracy,
    mods: sniper.mods,
    pp: sniper.pp,
    rank: sniper.rank,
    isLazer: sniper.isLazer,
    hasReplay: sniper.hasReplay,
    timestamp: sniper.endedAt,
    victimTimestamp: victim.endedAt,
    victimTotalScore: victim.totalScore,
    victimPp: victim.pp,
    detectedAt: Date.now(),
    boardRank,
    ...(isSeeded ? { isSeeded: true } : {}),
  };
}

interface SnipesRosterPlayer {
  id: number;
  username: string;
  avatar_url: string;
}

async function probeCountryBoardLanes(
  beatmapId: number,
  roster: SnipesRosterPlayer[],
  meta: BoardMeta,
): Promise<Record<string, CountryBoardSnapshotEntry> | null> {
  // getBeatmapUserScoresAll returns every score the user has on the map
  // (different mod sets, lazer/stable splits, etc). We need all of them so
  // we can segment by lane — getBeatmapUserScore only returns the user's
  // single "best" score and would collapse lanes.
  //
  // Note: this endpoint does NOT embed `user` on each returned score
  // (only `user_id`), nor does it include beatmap/beatmapset. That's why
  // we receive roster players and beatmap meta from the caller instead of
  // deriving them from the response.
  const perUserResults = await mapWithConcurrency(
    roster,
    SNIPES_PROBE_CONCURRENCY,
    async (player) => {
      try {
        const scores = await getBeatmapUserScoresAll(beatmapId, player.id, {
          feature: "snipes-probe-country-board",
          rosterSize: roster.length,
          concurrency: SNIPES_PROBE_CONCURRENCY,
          beatmapsetId: meta.beatmapset.id,
        });
        return { player, scores };
      } catch {
        return { player, scores: [] as OsuScore[] };
      }
    },
  );

  // For each (user, lane), compute the best play AND the best prior play
  // (highest totalScore with endedAt strictly before the best's endedAt). The
  // prior-best lets the seed heuristic detect self-improvement false positives
  // without needing cross-scan history.
  const perLane = new Map<string, Map<number, CountryBoardScore>>();
  for (const { player, scores } of perUserResults) {
    // Group this user's scores by lane first so prior-best stays lane-scoped.
    const byLane = new Map<string, { score: OsuScore; totalScore: number; endedAtMs: number }[]>();
    for (const score of scores) {
      if (!score) continue;
      if (!isSnipesRankedScore(score)) continue;
      const display = getScoreDisplayValues(score);
      const totalScore = display.totalScore ?? score.total_score ?? score.score ?? 0;
      if (totalScore <= 0) continue;
      const mods = getModAcronyms(score.mods);
      const lane = getBoardLaneKey(mods, display.isLazer);
      const endedAtMs = new Date(getScoreTimestamp(score)).getTime();
      if (!byLane.has(lane)) byLane.set(lane, []);
      byLane.get(lane)!.push({ score, totalScore, endedAtMs });
    }

    for (const [lane, entries] of byLane) {
      if (entries.length === 0) continue;
      entries.sort((a, b) => b.totalScore - a.totalScore);
      const best = entries[0];
      const display = getScoreDisplayValues(best.score);

      let priorBestTotalScore: number | undefined;
      if (Number.isFinite(best.endedAtMs)) {
        for (let i = 1; i < entries.length; i++) {
          const e = entries[i];
          if (!Number.isFinite(e.endedAtMs) || e.endedAtMs >= best.endedAtMs) continue;
          if (priorBestTotalScore == null || e.totalScore > priorBestTotalScore) {
            priorBestTotalScore = e.totalScore;
          }
        }
      }

      const board: CountryBoardScore = {
        userId: player.id,
        username: player.username,
        avatarUrl: player.avatar_url,
        scoreId: best.score.id,
        totalScore: best.totalScore,
        accuracy: display.accuracy,
        mods: getModAcronyms(best.score.mods),
        pp: best.score.pp,
        rank: display.rank,
        isLazer: display.isLazer,
        hasReplay: best.score.has_replay ?? best.score.replay ?? false,
        endedAt: getScoreTimestamp(best.score),
        ...(priorBestTotalScore != null ? { priorBestTotalScore } : {}),
      };

      let users = perLane.get(lane);
      if (!users) {
        users = new Map();
        perLane.set(lane, users);
      }
      users.set(board.userId, board);
    }
  }

  if (perLane.size === 0) return null;

  const entries: Record<string, CountryBoardSnapshotEntry> = {};
  const now = Date.now();
  for (const [lane, users] of perLane) {
    const scores = [...users.values()].sort((a, b) => b.totalScore - a.totalScore);
    entries[lane] = {
      ...meta,
      scores,
      lastTouchedAt: now,
    };
  }

  return entries;
}

const snipesBackgroundScanInProgress = new Set<string>();

function refreshCountrySnipesInBackground(
  country: string,
  cacheKey: string,
  snapshotKey: string,
  logKey: string,
): void {
  if (snipesBackgroundScanInProgress.has(country)) return;
  snipesBackgroundScanInProgress.add(country);
  let ranScan = false;
  void fetchWithCacheLock(
    cacheKey,
    SNIPES_CACHE_TTL,
    () => {
      ranScan = true;
      return runSnipesScan(country, snapshotKey, logKey);
    },
    SNIPES_LOCK_TTL,
    {
      waitMs: SNIPES_LOCK_WAIT_MS,
      waitRetries: SNIPES_LOCK_WAIT_RETRIES,
      runWithoutLockOnTimeout: false,
    },
  )
    .catch((err) => console.warn("[snipes] background scan failed:", getErrorMessage(err)))
    .finally(() => {
      if (ranScan) {
        clearSnipesScanStatus(country);
        clearPartialSnipeEvents(country);
      }
      snipesBackgroundScanInProgress.delete(country);
    });
}

async function runSnipesScan(
  country: string,
  snapshotKey: string,
  logKey: string,
): Promise<SnipesResponse> {
  try {
    clearPartialSnipeEvents(country);
    writeSnipesScanStatus(
      country,
      { phase: "roster", label: "Fetching country roster", current: 0, total: 1 },
      { force: true },
    );
    const rankings = await getRankings({ data: { type: "performance", page: 1, country } });
    const players = rankings.ranking
      .filter((entry) => entry.user.is_active !== false)
      .slice(0, SNIPES_PLAYER_LIMIT)
      .map((entry) => ({
        id: entry.user.id,
        username: entry.user.username,
        avatar_url: entry.user.avatar_url,
      }));

    if (players.length === 0) {
      clearSnipesScanStatus(country);
      clearPartialSnipeEvents(country);
      return { events: [], scannedAt: Date.now() };
    }

    writeSnipesScanStatus(
      country,
      {
        phase: "recent",
        label: `Loading recent plays from top ${players.length} players`,
        current: 0,
        total: players.length,
      },
      { force: true },
    );

    let recentDone = 0;
    const recentByPlayer = await mapWithConcurrency(
      players,
      SNIPES_SCAN_CONCURRENCY,
      async (player) => {
        try {
          const scores = await fetchUserRecentPlays(player.id);
          return { player, scores };
        } catch (error) {
          console.warn("[osu] failed to fetch recent plays for snipes scan", {
            playerId: player.id,
            error: getErrorMessage(error),
          });
          return { player, scores: [] as OsuScore[] };
        } finally {
          recentDone += 1;
          writeSnipesScanStatus(country, {
            phase: "recent",
            label: `Loading recent plays from top ${players.length} players`,
            current: recentDone,
            total: players.length,
          });
        }
      },
    );

    const candidates: OsuScore[] = [];
    for (const { scores } of recentByPlayer) {
      for (const score of scores) {
        if (!score.passed) continue;
        if (!score.beatmap || !score.beatmapset || !score.user) continue;
        if (score.beatmap.mode !== "mania") continue;
        if (!SNIPES_RANKED_STATUSES.has(score.beatmapset.status)) continue;
        if (!isSnipesRankedScore(score)) continue;
        candidates.push(score);
      }
    }

    const snapshot: CountryBoardSnapshot =
      (await getPersistentCached<CountryBoardSnapshot>(snapshotKey)) ?? {};

    const newEvents: SnipeEvent[] = [];
    const seedQueue: { beatmapId: number; bestCandidate: OsuScore }[] = [];

    const candidatesByBeatmap = new Map<number, OsuScore[]>();
    for (const score of candidates) {
      const bid = score.beatmap.id;
      let bucket = candidatesByBeatmap.get(bid);
      if (!bucket) {
        bucket = [];
        candidatesByBeatmap.set(bid, bucket);
      }
      bucket.push(score);
    }

    const compareTotal = candidatesByBeatmap.size;
    const compareLabel = `Comparing ${candidates.length} recent plays across ${compareTotal} beatmap${compareTotal === 1 ? "" : "s"}`;
    writeSnipesScanStatus(
      country,
      {
        phase: "compare",
        label: compareLabel,
        current: 0,
        total: compareTotal,
      },
      { force: true },
    );

    let compareDone = 0;
    for (const [bid, scoresForMap] of candidatesByBeatmap.entries()) {
      scoresForMap.sort((a, b) => {
        const aMs = new Date(getScoreTimestamp(a)).getTime();
        const bMs = new Date(getScoreTimestamp(b)).getTime();
        return aMs - bMs;
      });

      const existingLanes = snapshot[bid];
      if (!existingLanes || Object.keys(existingLanes).length === 0) {
        let bestCandidate = scoresForMap[0];
        let bestTotal = boardScoreFromScore(bestCandidate)?.totalScore ?? 0;
        for (const s of scoresForMap.slice(1)) {
          const t = boardScoreFromScore(s)?.totalScore ?? 0;
          if (t > bestTotal) {
            bestCandidate = s;
            bestTotal = t;
          }
        }
        seedQueue.push({ beatmapId: bid, bestCandidate });
        compareDone += 1;
        writeSnipesScanStatus(country, {
          phase: "compare",
          label: compareLabel,
          current: compareDone,
          total: compareTotal,
        });
        continue;
      }

      let lanesForBid: Record<string, CountryBoardSnapshotEntry> = { ...existingLanes };
      const anyLaneMeta: BoardMeta | null = (() => {
        const first = Object.values(existingLanes)[0];
        return first ? { beatmap: first.beatmap, beatmapset: first.beatmapset } : null;
      })();

      for (const score of scoresForMap) {
        const newScore = boardScoreFromScore(score);
        if (!newScore) continue;
        const lane = getBoardLaneKey(newScore.mods, newScore.isLazer);
        const entry = lanesForBid[lane];

        if (!entry) {
          const meta = boardMetadataFromScore(score) ?? anyLaneMeta;
          if (!meta) continue;
          lanesForBid = {
            ...lanesForBid,
            [lane]: { ...meta, scores: [newScore], lastTouchedAt: Date.now() },
          };
          continue;
        }

        const oldIdx = entry.scores.findIndex((s) => s.userId === newScore.userId);
        if (oldIdx >= 0 && entry.scores[oldIdx].totalScore >= newScore.totalScore) {
          continue;
        }

        const withoutPlayer =
          oldIdx >= 0 ? entry.scores.filter((_, i) => i !== oldIdx) : entry.scores;
        const newSorted = [...withoutPlayer, newScore].sort(
          (a, b) => b.totalScore - a.totalScore,
        );
        const newIdx = newSorted.findIndex((s) => s.userId === newScore.userId);

        const movedUp =
          oldIdx < 0 ? newIdx < entry.scores.length : newIdx < oldIdx;
        if (movedUp) {
          const victim = entry.scores[newIdx];
          if (victim && victim.userId !== newScore.userId) {
            newEvents.push(
              buildSnipeEvent(
                bid,
                { beatmap: entry.beatmap, beatmapset: entry.beatmapset },
                newScore,
                victim,
                newIdx + 1,
              ),
            );
          }
        }

        lanesForBid = {
          ...lanesForBid,
          [lane]: { ...entry, scores: newSorted, lastTouchedAt: Date.now() },
        };
      }

      snapshot[bid] = lanesForBid;
      compareDone += 1;
      writeSnipesScanStatus(country, {
        phase: "compare",
        label: compareLabel,
        current: compareDone,
        total: compareTotal,
      });
    }

    if (newEvents.length > 0) writePartialSnipeEvents(country, newEvents);

    if (seedQueue.length > 0) {
      seedQueue.sort((a, b) => {
        const aMs = new Date(getScoreTimestamp(a.bestCandidate)).getTime();
        const bMs = new Date(getScoreTimestamp(b.bestCandidate)).getTime();
        return bMs - aMs;
      });
      const probeBatch = seedQueue.slice(0, SNIPES_SEED_PROBE_BUDGET);

      writeSnipesScanStatus(
        country,
        {
          phase: "seed",
          label: `Checking ${probeBatch.length} new beatmap${probeBatch.length === 1 ? "" : "s"}`,
          current: 0,
          total: probeBatch.length,
        },
        { force: true },
      );

      let seedDone = 0;
      const seedCutoff = Date.now() - SNIPES_SEED_MAX_AGE_MS;
      await mapWithConcurrency(
        probeBatch,
        SNIPES_SCAN_CONCURRENCY,
        async ({ beatmapId, bestCandidate }) => {
          try {
            const meta = boardMetadataFromScore(bestCandidate);
            if (!meta) return;
            const lanes = await probeCountryBoardLanes(beatmapId, players, meta);
            if (!lanes || Object.keys(lanes).length === 0) return;
            snapshot[beatmapId] = lanes;

            const userHasOlderScore = new Map<number, number>();
            for (const entry of Object.values(lanes)) {
              for (const s of entry.scores) {
                const ms = new Date(s.endedAt).getTime();
                if (!Number.isFinite(ms)) continue;
                const prev = userHasOlderScore.get(s.userId);
                if (prev == null || ms < prev) userHasOlderScore.set(s.userId, ms);
              }
            }

            for (const entry of Object.values(lanes)) {
              for (let i = 0; i < entry.scores.length - 1; i++) {
                const top = entry.scores[i];
                const next = entry.scores[i + 1];
                if (top.userId === next.userId) continue;
                const topMs = new Date(top.endedAt).getTime();
                const nextMs = new Date(next.endedAt).getTime();
                if (!Number.isFinite(topMs) || !Number.isFinite(nextMs)) continue;
                if (topMs <= nextMs) continue;
                if (topMs < seedCutoff) continue;
                if (
                  top.priorBestTotalScore != null &&
                  top.priorBestTotalScore > next.totalScore
                ) {
                  continue;
                }
                const oldestForSniper = userHasOlderScore.get(top.userId);
                if (oldestForSniper != null && oldestForSniper < topMs) continue;
                newEvents.push(
                  buildSnipeEvent(
                    beatmapId,
                    { beatmap: entry.beatmap, beatmapset: entry.beatmapset },
                    top,
                    next,
                    i + 1,
                    true,
                  ),
                );
              }
            }
            writePartialSnipeEvents(country, newEvents);
          } catch (error) {
            console.warn("[osu] snipes seed probe failed", {
              beatmapId,
              country,
              error: getErrorMessage(error),
            });
          } finally {
            seedDone += 1;
            writeSnipesScanStatus(country, {
              phase: "seed",
              label: `Checking ${probeBatch.length} new beatmap${probeBatch.length === 1 ? "" : "s"}`,
              current: seedDone,
              total: probeBatch.length,
            });
          }
        },
      );
    }

    const existingLog = (await getPersistentCached<SnipeEvent[]>(logKey)) ?? [];
    const merged = new Map<string, SnipeEvent>();
    for (const event of existingLog) {
      merged.set(`${event.beatmap_id}:${event.score_id}`, event);
    }
    for (const event of newEvents) {
      merged.set(`${event.beatmap_id}:${event.score_id}`, event);
    }
    const mergedLog = [...merged.values()]
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, SNIPES_LOG_CAP);

    void Promise.allSettled([
      setPersistentCache(logKey, mergedLog, SNIPES_LOG_TTL),
      setPersistentCache(snapshotKey, snapshot, SNIPES_SNAPSHOT_TTL),
    ]);

    return { events: mergedLog, scannedAt: Date.now() };
  } catch (err) {
    clearSnipesScanStatus(country);
    clearPartialSnipeEvents(country);
    throw err;
  }
}

export const getCountrySnipes = createServerFn({ method: "GET" })
  .inputValidator(normalizeCountryPayload)
  .handler(async ({ data }: { data: { country?: string } }): Promise<SnipesResponse> => {
    edgeCache(60, 600);
    const country = normalizeCountryCode(data.country);
    const cacheKey = `country-snipes-response:v5:${country}`;
    const snapshotKey = `country-board-snapshot:v5:${country}`;
    const logKey = `country-snipes-log:v3:${country}`;

    // Stale-while-revalidate: return expired data immediately so the client
    // never blocks on the ~55s scan. A background scan refreshes the cache
    // for the next request.
    const cached = await getPersistentCacheEntryAllowStale<SnipesResponse>(cacheKey);
    if (cached.hit) {
      if (!cached.isStale) return cached.value;
      refreshCountrySnipesInBackground(country, cacheKey, snapshotKey, logKey);
      return { ...cached.value, refreshInProgress: true };
    }

    // The 6h response entry may have been purged while the durable 30d snipe
    // log is still present. Serve that log immediately and rebuild the shorter
    // response cache in the background instead of making the page wait for a
    // full scan.
    const loggedEvents = await getPersistentCacheEntryAllowStale<SnipeEvent[]>(logKey);
    if (loggedEvents.hit && loggedEvents.value.length > 0) {
      refreshCountrySnipesInBackground(country, cacheKey, snapshotKey, logKey);
      return {
        events: loggedEvents.value,
        scannedAt: loggedEvents.updatedAt ?? Date.now(),
        refreshInProgress: true,
      };
    }

    // No data at all (true cold start) - block on the full scan.
    let ranScan = false;
    return fetchWithCacheLock(
      cacheKey,
      SNIPES_CACHE_TTL,
      () => {
        ranScan = true;
        return runSnipesScan(country, snapshotKey, logKey);
      },
      SNIPES_LOCK_TTL,
      {
        waitMs: SNIPES_LOCK_WAIT_MS,
        waitRetries: SNIPES_LOCK_WAIT_RETRIES,
        runWithoutLockOnTimeout: false,
      },
    ).finally(() => {
      if (ranScan) {
        clearSnipesScanStatus(country);
        clearPartialSnipeEvents(country);
      }
    });
  });

export const getSnipesScanStatus = createServerFn({ method: "GET" })
  .inputValidator(normalizeCountryPayload)
  .handler(async ({ data }: { data: { country?: string } }): Promise<SnipesScanStatus | null> => {
    edgeCache(0, 0);
    const country = normalizeCountryCode(data.country);
    return (await getPersistentCached<SnipesScanStatus>(snipesStatusKey(country))) ?? null;
  });

export const getPartialSnipeEvents = createServerFn({ method: "GET" })
  .inputValidator(normalizeCountryPayload)
  .handler(async ({ data }: { data: { country?: string } }): Promise<SnipeEvent[]> => {
    edgeCache(0, 0);
    const country = normalizeCountryCode(data.country);
    return (await getPersistentCached<SnipeEvent[]>(snipesPartialEventsKey(country))) ?? [];
  });
