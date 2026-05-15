import { createFileRoute, stripSearchParams, useNavigate } from "@tanstack/react-router";
import { useState, useEffect, useCallback, useMemo, memo, useRef } from "react";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import { getRankings, getCountryRecentScores, getTrackerLiveSnapshot, getTrackerSnapshot } from "../lib/osu";
import { CLIENT_CACHE_TTL, isCacheStale } from "../lib/cache";
import { getCountryName } from "../lib/country";
import { formatAccuracy, formatTimeAgo, formatPP, formatNumber } from "../lib/format";
import {
  getBeatmapUrl,
  getDisplayedAccuracy,
  getDisplayedRank,
  getDisplayedTotalScore,
  getModDisplayList,
  getScoreIdentity,
  getScoreTimeMs,
  getScoreTimestamp,
  getScoreUrl,
  isDisplayedPassed,
  isLazerScore,
  scoreHasReplay,
} from "../lib/score";
import { PageHeader } from "../components/layout/PageHeader";

import { Avatar } from "../components/ui/Avatar";
import { GradeImg } from "../components/ui/GradeImg";
import { ModBadge } from "../components/ui/ModBadge";
import { DanBadge } from "../components/ui/DanBadge";
import { TrackerRowSkeleton } from "../components/ui/LoadingSkeleton";
import { Pagination } from "../components/ui/Pagination";
import { getManiaJudgementStats } from "../components/ui/ManiaJudgementStats";
import { UsernameText } from "../components/ui/UsernameText";
import { TRACKER_PP_GAIN_CLIENT_TTL, useAppStore, useSelectedCountry } from "../store";
import type { LeanTrackerScore } from "../lib/types";
import { parseCountrySearchParam } from "../lib/country-search";
import { getReplaySearch } from "../lib/replay-navigation";
import { fetchLiveTrackerSnapshot, isLiveBackendConfigured, openLiveEventSource } from "../lib/live-backend";

const TRACKER_SNAPSHOT_LOADER_TIMEOUT_MS = 2500;
const TRACKER_PAGE_SIZE = 100;
const TRACKER_LIVE_SNAPSHOT_LIMIT = 500;

async function withSnapshotLoaderBudget<T>(snapshotPromise: Promise<T>): Promise<T | null> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<null>((resolve) => {
    timeoutId = setTimeout(() => resolve(null), TRACKER_SNAPSHOT_LOADER_TIMEOUT_MS);
  });
  return Promise.race([
    snapshotPromise.finally(() => {
      if (timeoutId) clearTimeout(timeoutId);
    }),
    timeoutPromise,
  ]);
}

export const Route = createFileRoute("/tracker")({
  validateSearch: (search: Record<string, unknown>) => ({
    country: parseCountrySearchParam(search.country),
    page: (() => {
      const n = Number(search.page);
      if (!Number.isFinite(n) || n < 0) return undefined;
      return Math.floor(n);
    })(),
  }),
  search: {
    middlewares: [stripSearchParams({ page: undefined })],
  },
  loaderDeps: ({ search }) => ({
    country: search.country,
  }),
  loader: async ({ deps }) => {
    if (isLiveBackendConfigured()) return null;
    try {
      return await withSnapshotLoaderBudget(getTrackerSnapshot({ data: { country: deps.country } }));
    } catch {
      return null;
    }
  },
  head: ({ match }) => {
    const country = match.search.country;
    const countryName = country ? getCountryName(country) : null;
    return {
      meta: [
        { title: countryName ? `Live score tracker - ${countryName}` : "Live score tracker" },
        { name: "robots", content: "noindex, nofollow" },
      ],
    };
  },
  component: ScoresPage,
});

type ScoreFilter = "all" | "ranked";
type GradeFilter = "all" | "SS" | "S" | "A" | "B";
const EMPTY_IDS: number[] = [];
const EMPTY_SCORES: LeanTrackerScore[] = [];
const EMPTY_SCORE_GAINS: Record<number, { fetchedAt: number; value: number }> = {};

function getTrackerUserBatch(
  userIds: number[],
  users: Array<{ id: number; username: string; avatar_url: string; country_code: string }>,
  batchSize: number,
  batchIndex: number,
) {
  const start = (batchIndex * batchSize) % Math.max(1, userIds.length);
  const batchUserIds = userIds.slice(start, start + batchSize);
  const batchUserIdSet = new Set(batchUserIds);
  return {
    userIds: batchUserIds,
    users: users.filter((user) => batchUserIdSet.has(user.id)),
  };
}

function ScoresPage() {
  const navigate = useNavigate();
  const { country, page: searchPage } = Route.useSearch();
  const page = searchPage ?? 0;
  const fallbackCountry = useSelectedCountry();
  const selectedCountry = country ?? fallbackCountry;
  const loaderData = Route.useLoaderData();
  const snapshot = loaderData?.country === selectedCountry ? loaderData : null;
  const cachedRankings = useAppStore((state) => state.rankingsByCountry[selectedCountry] ?? null);
  const rankings = cachedRankings ?? snapshot?.rankings ?? null;
  const rankingsFetchedAt = useAppStore((state) => state.rankingsFetchedAtByCountry[selectedCountry] ?? null);
  const cachedFeedScores = useAppStore((state) => state.feedScoresByCountry[selectedCountry]) ?? EMPTY_SCORES;
  const feedScores = cachedFeedScores.length > 0 ? cachedFeedScores : snapshot?.scores ?? EMPTY_SCORES;
  const feedScoresFetchedAt = useAppStore((state) => state.feedScoresFetchedAtByCountry[selectedCountry]) ?? null;
  const cachedTrackedUserIds = useAppStore((state) => state.trackedUserIdsByCountry[selectedCountry]) ?? EMPTY_IDS;
  const trackedUserIds = cachedTrackedUserIds.length > 0 ? cachedTrackedUserIds : snapshot?.userIds ?? EMPTY_IDS;
  const addFeedScores = useAppStore((state) => state.addFeedScores);
  const markFeedScoresFetched = useAppStore((state) => state.markFeedScoresFetched);
  const setRankings = useAppStore((state) => state.setRankings);
  const setTrackedUserIds = useAppStore((state) => state.setTrackedUserIds);
  const resetPollIndex = useAppStore((state) => state.resetPollIndex);
  const [userIds, setUserIds] = useState<number[]>(trackedUserIds);
  const [loadingPlayers, setLoadingPlayers] = useState<boolean>(trackedUserIds.length === 0 && !rankings);
  const [playersError, setPlayersError] = useState<string | null>(null);
  const [filter, setFilter] = useState<ScoreFilter>("all");
  const [gradeFilter, setGradeFilter] = useState<GradeFilter>("all");
  const [selectedPlayerIds, setSelectedPlayerIds] = useState<number[]>([]);
  const [initialLoaded, setInitialLoaded] = useState(feedScores.length > 0 || !!feedScoresFetchedAt || !!snapshot);
  const [initialRefreshDone, setInitialRefreshDone] = useState(false);
  const [initialFetching, setInitialFetching] = useState(false);
  const [polling, setPolling] = useState(false);
  const [timeTick, setTimeTick] = useState(0);
  const refreshing = initialFetching || polling;
  const initialFetchInFlightRef = useRef(false);
  const pollInFlightRef = useRef(false);
  const pollRequestIdRef = useRef(0);
  const appliedSnapshotKeyRef = useRef<string | null>(null);
  const liveBackendEnabled = isLiveBackendConfigured();
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const handleToggleExpand = useCallback((key: string) => {
    setExpandedKey((prev) => (prev === key ? null : key));
  }, []);
  const trackerPpGainEntries = useAppStore((state) => state.trackerPpGainsByCountry[selectedCountry] ?? EMPTY_SCORE_GAINS);
  const setTrackerPpGains = useAppStore((state) => state.setTrackerPpGains);
  const countryName = getCountryName(selectedCountry);
  const trackerUsers = useMemo(
    () => rankings?.ranking
      .filter((entry: { user: { is_active?: boolean } }) => entry.user.is_active !== false)
      .map((entry) => ({
        id: entry.user.id,
        username: entry.user.username,
        avatar_url: entry.user.avatar_url,
        country_code: entry.user.country_code,
      })) ?? [],
    [rankings],
  );

  useEffect(() => {
    if (!snapshot) return;
    const snapshotKey = `${snapshot.country}:${snapshot.fetchedAt}`;
    if (appliedSnapshotKeyRef.current === snapshotKey) return;
    appliedSnapshotKeyRef.current = snapshotKey;

    setRankings(selectedCountry, snapshot.rankings);
    setTrackedUserIds(selectedCountry, snapshot.userIds);
    setUserIds(snapshot.userIds);
    setLoadingPlayers(false);
    setPlayersError(null);
    setInitialLoaded(true);
    if (snapshot.scores.length > 0) addFeedScores(selectedCountry, snapshot.scores);
    if (Object.keys(snapshot.gains).length > 0) {
      setTrackerPpGains(selectedCountry, snapshot.gains, snapshot.fetchedAt);
    }
  }, [snapshot, selectedCountry, setRankings, setTrackedUserIds, addFeedScores, setTrackerPpGains]);

  useEffect(() => {
    const id = window.setInterval(() => setTimeTick((value) => value + 1), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const reconcileLiveSnapshot = useCallback(async (requestedCountry: string) => {
    const liveSnapshot = await fetchLiveTrackerSnapshot(requestedCountry, TRACKER_LIVE_SNAPSHOT_LIMIT);
    if (requestedCountry !== selectedCountry) return;
    const passedScores = liveSnapshot.scores.filter(isDisplayedPassed);
    if (passedScores.length > 0) addFeedScores(requestedCountry, passedScores);
    if (Object.keys(liveSnapshot.gains).length > 0) {
      setTrackerPpGains(requestedCountry, liveSnapshot.gains, liveSnapshot.fetchedAt);
    }
    markFeedScoresFetched(requestedCountry);
    setInitialLoaded(true);
    setInitialRefreshDone(true);
    setInitialFetching(false);
    setLoadingPlayers(false);
  }, [addFeedScores, markFeedScoresFetched, selectedCountry, setTrackerPpGains]);

  useEffect(() => {
    if (!liveBackendEnabled) return;
    let cancelled = false;
    const requestedCountry = selectedCountry;
    const run = () => {
      reconcileLiveSnapshot(requestedCountry).catch(() => {
        // The existing server-function path below remains the fallback.
      });
    };
    run();
    const intervalId = window.setInterval(() => {
      if (!cancelled && document.visibilityState === "visible") run();
    }, 30_000);
    const onVisibility = () => {
      if (!cancelled && document.visibilityState === "visible") run();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [liveBackendEnabled, reconcileLiveSnapshot, selectedCountry]);

  useEffect(() => {
    if (!liveBackendEnabled) return;
    const source = openLiveEventSource(selectedCountry);
    if (!source) return;
    source.addEventListener("hello", () => {
      void reconcileLiveSnapshot(selectedCountry);
    });
    source.addEventListener("tracker_score", (event) => {
      const score = JSON.parse(event.data) as LeanTrackerScore;
      if (isDisplayedPassed(score)) addFeedScores(selectedCountry, [score]);
    });
    source.addEventListener("score_gain", (event) => {
      const data = JSON.parse(event.data) as { scoreId?: number; ppGain?: number };
      if (data.scoreId != null && data.ppGain != null) {
        setTrackerPpGains(selectedCountry, { [data.scoreId]: data.ppGain });
      }
    });
    return () => source.close();
  }, [addFeedScores, liveBackendEnabled, reconcileLiveSnapshot, selectedCountry, setTrackerPpGains]);

  useEffect(() => {
    setUserIds(trackedUserIds);
    setLoadingPlayers(trackedUserIds.length === 0 && !rankings);
    setPlayersError(null);
    setInitialLoaded(feedScores.length > 0 || !!feedScoresFetchedAt);
    setInitialRefreshDone(false);
    setInitialFetching(false);
    setPolling(false);
    initialFetchInFlightRef.current = false;
    pollInFlightRef.current = false;
    pollRequestIdRef.current += 1;
    setExpandedKey(null);
    setSelectedPlayerIds([]);
    resetPollIndex(selectedCountry);
  }, [selectedCountry]);

  useEffect(() => {
    let cancelled = false;
    const cachedIds = rankings?.ranking
      .filter((entry: { user: { is_active?: boolean } }) => entry.user.is_active !== false)
      .map((entry: { user: { id: number } }) => entry.user.id) ?? trackedUserIds;

    if (cachedIds.length > 0) {
      setUserIds(cachedIds);
      setLoadingPlayers(false);
      setPlayersError(null);
    }

    if (liveBackendEnabled) {
      setLoadingPlayers(false);
      setPlayersError(null);
      return () => {
        cancelled = true;
      };
    }

    const shouldRefresh = !rankings || isCacheStale(rankingsFetchedAt, CLIENT_CACHE_TTL.rankings);

    if (!shouldRefresh) {
      return () => {
        cancelled = true;
      };
    }

    setLoadingPlayers(cachedIds.length === 0);

    getRankings({ data: { type: "performance", page: 1, country: selectedCountry } })
      .then((rankings) => {
        if (cancelled) return;

        const ids = rankings.ranking
          .filter((entry: { user: { is_active?: boolean } }) => entry.user.is_active !== false)
          .map((entry: { user: { id: number } }) => entry.user.id);
        setRankings(selectedCountry, rankings);
        setUserIds(ids);
        setTrackedUserIds(selectedCountry, ids);
        setPlayersError(null);
      })
      .catch(() => {
        if (cancelled || cachedIds.length > 0) return;
        setPlayersError("Couldn't load the tracked player pool.");
      })
      .finally(() => {
        if (cancelled) return;
        setLoadingPlayers(false);
      });

    return () => {
      cancelled = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rankings, rankingsFetchedAt, selectedCountry, liveBackendEnabled]);

  useEffect(() => {
    if (initialLoaded || feedScores.length > 0) {
      setInitialLoaded(true);
    }
  }, [feedScores.length, initialLoaded]);

  useEffect(() => {
    if (liveBackendEnabled) {
      setInitialRefreshDone(true);
      setInitialFetching(false);
      return;
    }
    if (userIds.length === 0 || initialRefreshDone || initialFetchInFlightRef.current) return;

    const feedIsStale =
      feedScores.length === 0 ||
      !feedScoresFetchedAt || isCacheStale(feedScoresFetchedAt, CLIENT_CACHE_TTL.scoresFeed);
    const shouldBackfillSeededSnapshot = snapshot?.country === selectedCountry && snapshot.seedBatchCount > 0;
    const shouldRefresh = feedIsStale || shouldBackfillSeededSnapshot;

    if (!shouldRefresh) {
      setInitialLoaded(true);
      setInitialRefreshDone(true);
      return;
    }

    if (feedScores.length > 0) {
      setInitialLoaded(true);
    }

    let cancelled = false;
    const BATCH = 10;
    const requestedCountry = selectedCountry;
    const requestedUserIds = userIds;
    const requestedUsers = trackerUsers;

    initialFetchInFlightRef.current = true;
    setInitialFetching(true);

    (async () => {
      const totalBatches = Math.ceil(requestedUserIds.length / BATCH);
      const backfillBatchCount = feedIsStale
        ? totalBatches
        : Math.min(snapshot?.seedBatchCount ?? totalBatches, totalBatches);
      // The loader snapshot is intentionally fast and may be sourced from the
      // public live feed, which can miss osu! recent-score entries with odd
      // shapes. Still backfill from osu! after first paint so the seeded top
      // players do not get stuck with a partial live snapshot.
      const firstBatchIndex = 0;
      const parallelBatchEnd = Math.min(backfillBatchCount, 3);
      const fetchBatch = async (batchIndex: number) => {
        if (cancelled) return;
        try {
          const batch = getTrackerUserBatch(requestedUserIds, requestedUsers, BATCH, batchIndex);
          const result = await getCountryRecentScores({
            data: { userIds: batch.userIds, users: batch.users, batchSize: BATCH, batchIndex: 0, recentLimit: 20, source: "backfill" },
          });
          if (cancelled) return;
          if (result.scores.length > 0) addFeedScores(requestedCountry, result.scores);
          if (Object.keys(result.gains).length > 0) setTrackerPpGains(requestedCountry, result.gains);
          setInitialLoaded(true);
        } catch { /* continue */ }
      };

      await Promise.allSettled(
        Array.from(
          { length: Math.max(0, parallelBatchEnd - firstBatchIndex) },
          (_, offset) => fetchBatch(firstBatchIndex + offset),
        ),
      );

      for (let b = Math.max(firstBatchIndex, parallelBatchEnd); b < backfillBatchCount; b++) {
        await fetchBatch(b);
      }
      if (!cancelled) {
        markFeedScoresFetched(requestedCountry);
        setInitialRefreshDone(true);
        initialFetchInFlightRef.current = false;
        setInitialFetching(false);
      }
    })();

    return () => {
      cancelled = true;
      initialFetchInFlightRef.current = false;
      setInitialFetching(false);
    };
  // feedScores.length and feedScoresFetchedAt intentionally omitted:
  // addFeedScores writes both inside the loop, and those writes must not cancel
  // the remaining batches of this initial refresh.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userIds, trackerUsers, initialRefreshDone, addFeedScores, markFeedScoresFetched, selectedCountry, setTrackerPpGains, snapshot]);

  const poll = useCallback(async () => {
    if (liveBackendEnabled) return;
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    if (pollInFlightRef.current) return;
    pollInFlightRef.current = true;
    const requestId = ++pollRequestIdRef.current;
    setPolling(true);
    try {
      const result = await getTrackerLiveSnapshot({ data: { country: selectedCountry } });
      if (result.userIds.length > 0) setTrackedUserIds(selectedCountry, result.userIds);
      if (result.scores.length > 0) addFeedScores(selectedCountry, result.scores);
      if (Object.keys(result.gains).length > 0) setTrackerPpGains(selectedCountry, result.gains);
      else markFeedScoresFetched(selectedCountry);
    } catch { /* silently continue */ } finally {
      if (pollRequestIdRef.current === requestId) {
        pollInFlightRef.current = false;
        setPolling(false);
      }
    }
  }, [liveBackendEnabled, addFeedScores, markFeedScoresFetched, selectedCountry, setTrackerPpGains, setTrackedUserIds]);

  useEffect(() => {
    if (liveBackendEnabled) return;
    const id = setInterval(poll, 60_000);
    const onVisibility = () => {
      if (document.visibilityState === "visible") void poll();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [poll, liveBackendEnabled]);

  useEffect(() => {
    setExpandedKey(null);
  }, [filter, gradeFilter]);

  const ppGainByScoreId = useMemo(
    () => Object.fromEntries(
      Object.entries(trackerPpGainEntries)
        .filter(([, entry]) => Date.now() - entry.fetchedAt < TRACKER_PP_GAIN_CLIENT_TTL)
        .map(([scoreId, entry]) => [Number(scoreId), entry.value]),
    ) as Record<number, number>,
    [trackerPpGainEntries],
  );

  const selectedPlayerIdSet = useMemo(() => new Set(selectedPlayerIds), [selectedPlayerIds]);

  const updateTrackerSearch = useCallback((patch: Partial<{ country: string | undefined; page: number | undefined }>) => {
    const nextPage = patch.page ?? page;
    navigate({
      to: "/tracker",
      search: {
        country: patch.country ?? country,
        page: nextPage > 0 ? nextPage : undefined,
      },
      replace: true,
    });
  }, [country, navigate, page]);

  const togglePlayerFilter = useCallback((playerId: number) => {
    setSelectedPlayerIds((current) =>
      current.includes(playerId)
        ? current.filter((id) => id !== playerId)
        : [...current, playerId]
    );
    updateTrackerSearch({ page: 0 });
  }, [updateTrackerSearch]);

  const clearPlayerFilter = useCallback(() => {
    setSelectedPlayerIds([]);
    updateTrackerSearch({ page: 0 });
  }, [updateTrackerSearch]);

  const filtered = useMemo(() => {
    const playerFiltered = selectedPlayerIds.length > 0
      ? feedScores.filter((score: LeanTrackerScore) => selectedPlayerIdSet.has(score.user_id))
      : feedScores;

    return playerFiltered.filter((score: LeanTrackerScore) => {
      if (!isDisplayedPassed(score)) return false;
      switch (filter) {
        case "ranked":
          return score.pp != null && score.pp > 0;
        default:
          break;
      }
      if (gradeFilter !== "all") {
        const rank = getDisplayedRank(score);
        // SS includes XH/X/SS/SSH, S includes SH/S
        if (gradeFilter === "SS") return ["SS", "SSH", "X", "XH"].includes(rank);
        if (gradeFilter === "S") return ["S", "SH"].includes(rank);
        return rank === gradeFilter;
      }
      return true;
    });
  }, [feedScores, filter, gradeFilter, selectedPlayerIdSet, selectedPlayerIds.length]);

  const activePlayers = useMemo(() => {
    const activeCutoff = Date.now() - 40 * 60 * 1000;
    const seen = new Map<number, { username: string; avatar_url: string; latestTime: number }>();
    for (const score of feedScores) {
      const timeMs = getScoreTimeMs(score);
      if (timeMs < activeCutoff || !score.user) continue;
      const existing = seen.get(score.user_id);
      if (!existing || timeMs > existing.latestTime) {
        seen.set(score.user_id, {
          username: score.user.username,
          avatar_url: score.user.avatar_url,
          latestTime: timeMs,
        });
      }
    }
    return [...seen.entries()]
      .sort((a, b) => b[1].latestTime - a[1].latestTime)
      .map(([id, info]) => ({ id, ...info }));
  }, [feedScores]);

  const filters: { id: ScoreFilter; label: string }[] = [
    { id: "all", label: "All" },
    { id: "ranked", label: "Ranked (PP)" },
  ];
  const grades: { id: GradeFilter; label: string }[] = [
    { id: "all", label: "Any" },
    { id: "SS", label: "SS" },
    { id: "S", label: "S" },
    { id: "A", label: "A" },
    { id: "B", label: "B" },
  ];
  const listKey = `${filter}:${gradeFilter}`;
  const liveStatusLabel = liveBackendEnabled ? "Live updates on" : "Live polling";
  const totalPages = Math.max(1, Math.ceil(filtered.length / TRACKER_PAGE_SIZE));
  const currentPage = Math.min(page, totalPages - 1);
  const paginatedScores = useMemo(
    () => filtered.slice(currentPage * TRACKER_PAGE_SIZE, (currentPage + 1) * TRACKER_PAGE_SIZE),
    [currentPage, filtered],
  );

  useEffect(() => {
    if (page !== currentPage) updateTrackerSearch({ page: currentPage });
  }, [currentPage, page, updateTrackerSearch]);

  return (
    <div className="flex-1">
      <PageHeader
        iconSrc="/images/icons/news.svg"
        title={`${countryName} mania tracker`}
        right={
          <div className="flex items-center gap-2">
            {loadingPlayers || refreshing ? (
              <>
                <div className="w-3 h-3 border-2 border-osu-pink/40 border-t-osu-pink rounded-full animate-spin" />
                <span className="text-[10px] text-osu-f1 tabular-nums">
                  {loadingPlayers
                    ? "Loading tracked players..."
                    : "Refreshing..."}
                </span>
              </>
            ) : (
              <>
                <div className="w-2 h-2 rounded-full bg-osu-green animate-pulse" />
                <span className="text-[10px] text-osu-f1">
                  {liveStatusLabel} {"\u00b7"} {feedScores.length} scores
                </span>
              </>
            )}
          </div>
        }
      />

      <div className="bg-osu-d5 border-b border-osu-b3/30">
        <div className="max-w-[1200px] mx-auto px-4 sm:px-5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-0">
          {/* Desktop: single row with all filters */}
          <div className="hidden sm:flex items-center gap-0 w-auto">
            {selectedPlayerIds.length > 0 && (
              <>
                <button
                  onClick={clearPlayerFilter}
                  className="mr-2 px-2.5 py-1 rounded-lg bg-osu-pink/15 text-[11px] font-medium text-osu-pink-light hover:bg-osu-pink/25 transition-colors cursor-pointer"
                >
                  Clear player filter
                </button>
                <div className="w-px h-5 bg-osu-b3/40 mr-2" />
              </>
            )}
            {filters.map((item) => (
              <button
                key={item.id}
                onClick={() => { setFilter(item.id); if (item.id !== "all") setGradeFilter("all"); updateTrackerSearch({ page: 0 }); }}
                className={`px-4 py-2.5 text-[12px] font-medium cursor-pointer transition-colors duration-[120ms] border-b-2 ${
                  filter === item.id
                    ? "text-osu-c1 border-osu-h1"
                    : "text-osu-f1 border-transparent hover:text-osu-l2"
                }`}
              >
                {item.label}
              </button>
            ))}
            <div className="w-px h-5 bg-osu-b3/40 mx-2" />
            {grades.map((item) => (
              <button
                key={item.id}
                onClick={() => { setGradeFilter(item.id); if (item.id !== "all") setFilter("all"); updateTrackerSearch({ page: 0 }); }}
                className={`px-2.5 py-2 cursor-pointer transition-all duration-[120ms] border-b-2 flex items-center ${
                  gradeFilter === item.id
                    ? "border-osu-h1 opacity-100"
                    : "border-transparent opacity-50 hover:opacity-80"
                }`}
              >
                {item.id === "all" ? (
                  <span className="text-[11px] font-semibold text-osu-f1">Any</span>
                ) : (
                  <GradeImg grade={item.id} size={20} />
                )}
              </button>
            ))}
          </div>
          {/* Mobile: compact single row */}
          <div className="sm:hidden w-full py-2">
            {selectedPlayerIds.length > 0 && (
              <button
                onClick={clearPlayerFilter}
                className="mb-2 px-2.5 py-1 rounded-lg bg-osu-pink/15 text-[11px] font-medium text-osu-pink-light hover:bg-osu-pink/25 transition-colors cursor-pointer"
              >
                Clear player filter
              </button>
            )}
            <div className="flex items-center justify-between gap-2">
              <div className="flex rounded-lg overflow-hidden border border-osu-b3/30 flex-shrink-0">
                {filters.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => { setFilter(item.id); if (item.id !== "all") setGradeFilter("all"); updateTrackerSearch({ page: 0 }); }}
                    className={`px-2.5 py-1.5 text-[11px] font-medium cursor-pointer transition-colors duration-[120ms] ${
                      filter === item.id && gradeFilter === "all"
                        ? "bg-osu-b3 text-osu-l2"
                        : "bg-osu-b4/50 text-osu-f1 hover:text-osu-l2"
                    }`}
                  >
                    {item.id === "all" ? "All" : item.id === "ranked" ? "PP" : "Pass"}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-2">
                {grades.filter((g) => g.id !== "all").map((item) => (
                  <button
                    key={item.id}
                    onClick={() => {
                      if (gradeFilter === item.id) { setGradeFilter("all"); }
                      else { setGradeFilter(item.id); setFilter("all"); }
                      updateTrackerSearch({ page: 0 });
                    }}
                    className={`cursor-pointer transition-all duration-[120ms] ${
                      gradeFilter === item.id
                        ? "opacity-100 scale-110"
                        : gradeFilter === "all"
                          ? "opacity-60"
                          : "opacity-30"
                    }`}
                  >
                    <GradeImg grade={item.id} size={32} />
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="bg-osu-b5">
        <div className="max-w-[1200px] mx-auto px-5 py-5 flex flex-col lg:flex-row gap-4 lg:gap-5">
          {activePlayers.length > 0 && (
            <>
              {/* Mobile: horizontal row */}
              <div className="lg:hidden flex items-center gap-3 overflow-x-auto scrollbar-hide py-1">
                <span className="text-[9px] uppercase tracking-wider text-osu-f1 font-semibold flex-shrink-0">Playing</span>
                {activePlayers.map((player) => (
                  <button
                    key={player.id}
                    onClick={() => togglePlayerFilter(player.id)}
                    onContextMenu={(event) => {
                      event.preventDefault();
                    }}
                    aria-pressed={selectedPlayerIdSet.has(player.id)}
                    className="cursor-pointer group relative flex-shrink-0"
                    title={`${player.username} - click to filter`}
                  >
                    <div className={`ring-2 ring-inset rounded-full transition-all ${
                      selectedPlayerIdSet.has(player.id)
                        ? "ring-osu-pink shadow-[0_0_0_3px_rgba(255,102,171,0.18)]"
                        : "ring-osu-pink/40 group-hover:ring-osu-pink"
                    }`}>
                      <Avatar url={player.avatar_url} size={32} />
                    </div>
                  </button>
                ))}
              </div>
              {/* Desktop: vertical sidebar */}
              <div className="hidden lg:flex flex-col items-center gap-2 flex-shrink-0 pt-1">
                <span className="text-[9px] uppercase tracking-wider text-osu-f1 font-semibold mb-1">Playing</span>
                {activePlayers.map((player) => (
                  <button
                    key={player.id}
                    onClick={() => togglePlayerFilter(player.id)}
                    onContextMenu={(event) => {
                      event.preventDefault();
                    }}
                    aria-pressed={selectedPlayerIdSet.has(player.id)}
                    className="cursor-pointer group relative"
                    title={`${player.username} - click to filter`}
                  >
                    <div className={`ring-2 rounded-full transition-all ${
                      selectedPlayerIdSet.has(player.id)
                        ? "ring-osu-pink shadow-[0_0_0_3px_rgba(255,102,171,0.18)]"
                        : "ring-osu-pink/40 group-hover:ring-osu-pink"
                    }`}>
                      <Avatar url={player.avatar_url} size={32} />
                    </div>
                  </button>
                ))}
              </div>
            </>
          )}
          <div className="flex-1 min-w-0">
            {playersError ? (
              <div className="text-center py-16 text-osu-f1 text-sm">
                {playersError}
              </div>
            ) : loadingPlayers || (!initialLoaded && feedScores.length === 0) ? (
              <div className="space-y-2">
                {Array.from({ length: 6 }).map((_, i) => (
                  <TrackerRowSkeleton key={i} />
                ))}
              </div>
            ) : (
              <>
                <VirtualScoreList
                  listKey={`${listKey}:${currentPage}`}
                  scores={paginatedScores}
                  timeTick={timeTick}
                  expandedKey={expandedKey}
                  onToggle={handleToggleExpand}
                  ppGainByScoreId={ppGainByScoreId}
                />
                <Pagination
                  page={currentPage}
                  totalPages={totalPages}
                  onPageChange={(nextPage) => updateTrackerSearch({ page: nextPage })}
                />
                {filtered.length === 0 && (
                  <div className="text-center py-16 text-osu-f1 text-sm">
                    {feedScores.length === 0
                      ? "No recent scores yet."
                      : "No scores match this filter"}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// Window-virtualized score list. Only mounts the items currently in the
// viewport (plus a small overscan), so mount cost stays roughly constant
// regardless of how many scores are in the feed.
//
// scrollMargin is set to the list container's offsetTop so the virtualizer
// knows where the list starts relative to the window scroll. measureElement
// handles variable item heights (collapsed vs expanded). The outer div gets
// position: relative and a fixed total height so the page scrollbar reflects
// the full list even though only a few items are rendered.
const ESTIMATED_ROW_HEIGHT = 80;

function VirtualScoreList({
  listKey,
  scores,
  timeTick,
  expandedKey,
  onToggle,
  ppGainByScoreId,
}: {
  listKey: string;
  scores: LeanTrackerScore[];
  timeTick: number;
  expandedKey: string | null;
  onToggle: (key: string) => void;
  ppGainByScoreId: Record<number, number>;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const scrollMargin = parentRef.current?.offsetTop ?? 0;

  const virtualizer = useWindowVirtualizer({
    count: scores.length,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    overscan: 4,
    scrollMargin,
    // Include the 8px gap (space-y-2) in the item's measured size via a
    // wrapper padding, so the virtualizer's offsets stay correct.
    getItemKey: (index) => getScoreIdentity(scores[index]),
  });

  const items = virtualizer.getVirtualItems();

  return (
    <div
      key={listKey}
      ref={parentRef}
      style={{
        height: `${virtualizer.getTotalSize()}px`,
        position: "relative",
        width: "100%",
      }}
    >
      {items.map((vi) => {
        const score = scores[vi.index];
        const scoreKey = getScoreIdentity(score);
        return (
          <div
            key={scoreKey}
            data-index={vi.index}
            ref={virtualizer.measureElement}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              transform: `translateY(${vi.start - virtualizer.options.scrollMargin}px)`,
              paddingBottom: 8,
            }}
          >
            <ScoreFeedItem
              score={score}
              scoreKey={scoreKey}
              timeTick={timeTick}
              approxPpGain={ppGainByScoreId[score.id] ?? null}
              expanded={expandedKey === scoreKey}
              onToggle={onToggle}
            />
          </div>
        );
      })}
    </div>
  );
}

const ScoreFeedItem = memo(function ScoreFeedItem({
  score,
  scoreKey,
  timeTick: _timeTick,
  approxPpGain,
  expanded,
  onToggle,
}: {
  score: LeanTrackerScore;
  scoreKey: string;
  timeTick: number;
  approxPpGain: number | null;
  expanded: boolean;
  onToggle: (key: string) => void;
}) {
  const navigate = useNavigate();
  const [rendered, setRendered] = useState(expanded);
  useEffect(() => { if (expanded) setRendered(true); }, [expanded]);

  const keys = score.beatmap?.cs;
  const totalScore = getDisplayedTotalScore(score);
  const beatmapUrl = getBeatmapUrl(score);
  const scoreUrl = getScoreUrl(score);
  const judgementStats = getManiaJudgementStats(score);
  const lazer = isLazerScore(score);
  const accColorClass = lazer ? "text-osu-pink-light" : "text-osu-l2";
  const canReplay = scoreHasReplay(score);

  return (
    <div className="rounded-xl bg-osu-b4 border border-osu-b3/20 overflow-hidden">
      <div
        className="flex items-center gap-2 sm:gap-3 py-3 px-3 sm:px-4 hover:bg-osu-b3/50 transition-colors duration-[120ms] cursor-pointer"
        onClick={() => onToggle(scoreKey)}
      >
        <GradeImg grade={getDisplayedRank(score)} size={32} />
        <button
          onClick={(e) => {
            e.stopPropagation();
            if (!score.user?.username) return;
            window.location.href = `/player/${encodeURIComponent(score.user.username)}`;
          }}
          className="cursor-pointer"
          title={score.user?.username ? `Open ${score.user.username}'s profile` : undefined}
        >
          <Avatar url={score.user?.avatar_url} size={36} />
        </button>
        <div className="flex-1 min-w-0">
          {/* Row 1: Username + time (mobile) */}
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              {score.user?.username ? (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    window.location.href = `/player/${encodeURIComponent(score.user.username)}`;
                  }}
                  className="cursor-pointer"
                >
                  <UsernameText
                    username={score.user.username}
                    avatarUrl={score.user?.avatar_url}
                    className="text-sm font-semibold"
                  />
                </button>
              ) : (
                <UsernameText
                  username="Unknown"
                  avatarUrl={score.user?.avatar_url}
                  className="text-sm font-semibold"
                />
              )}
            </div>
            <span className="text-[10px] text-osu-f1 flex-shrink-0 sm:hidden">{formatTimeAgo(getScoreTimestamp(score))}</span>
          </div>
          {/* Row 2: Beatmap title + keys */}
          <div className="flex items-center justify-between sm:justify-start gap-2 mt-0.5">
            <div className="flex items-center gap-2 min-w-0">
              {beatmapUrl ? (
                <a
                  href={beatmapUrl}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="text-xs text-white truncate hover:text-osu-pink-light underline-offset-2 hover:underline"
                  title="Open beatmap on osu!"
                >
                  {score.beatmapset?.title}
                </a>
              ) : (
                <span className="text-xs text-white truncate">{score.beatmapset?.title}</span>
              )}
              <span className="text-[10px] text-osu-f1 truncate">[{score.beatmap?.version}]</span>
            </div>
            {keys && (
              <span className="px-1 py-0.5 rounded text-[8px] font-bold bg-osu-b3/50 text-osu-yellow flex-shrink-0">
                {keys}K
              </span>
            )}
            <span className="hidden sm:inline flex-shrink-0"><DanBadge score={score} /></span>
          </div>
          {/* Row 3 (mobile): Mods left, stats right */}
          <div className="flex items-center justify-between gap-2 mt-1 sm:hidden">
            <div className="flex items-center gap-1">
              {getModDisplayList(score.mods).map((m) => (
                <ModBadge key={m.acronym} mod={m.acronym} rate={m.rate} />
              ))}
              <DanBadge score={score} />
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <span className={`text-xs ${accColorClass}`}>{formatAccuracy(getDisplayedAccuracy(score))}</span>
              <span className="text-sm font-bold">{formatPP(score.pp)}</span>
              {approxPpGain != null && (
                <span className="text-[10px] font-semibold text-osu-green">+{formatNumber(Math.round(approxPpGain))}</span>
              )}
              {canReplay && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    navigate({ to: "/replay", search: getReplaySearch(score.id, score.beatmapset?.id) });
                  }}
                  className="px-1.5 py-0.5 rounded bg-osu-pink/20 text-[10px] text-osu-pink-light font-semibold hover:bg-osu-pink/30 transition-colors cursor-pointer"
                  title="Watch replay"
                  aria-label="Watch replay"
                >
                  &#9654;
                </button>
              )}
            </div>
          </div>
        </div>
        {/* Desktop metadata */}
        <div className="hidden sm:flex items-center gap-3 flex-shrink-0">
          <div className="flex gap-0.5">
            {getModDisplayList(score.mods).map((m) => (
              <ModBadge key={m.acronym} mod={m.acronym} rate={m.rate} />
            ))}
          </div>
          <span className={`text-xs ${accColorClass}`}>{formatAccuracy(getDisplayedAccuracy(score))}</span>
          <span className="text-sm font-bold">
            {formatPP(score.pp)}
            {approxPpGain != null && (
              <span
                className="ml-1 text-[11px] font-semibold text-osu-green"
                title="Estimated pp gain from replacing your previous best score on this map"
              >
                (+{formatNumber(Math.round(approxPpGain))})
              </span>
            )}
          </span>
          {canReplay && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                navigate({ to: "/replay", search: getReplaySearch(score.id, score.beatmapset?.id) });
              }}
              className="px-2 py-1 rounded bg-osu-pink/20 text-[10px] text-osu-pink-light font-semibold hover:bg-osu-pink/30 transition-colors cursor-pointer"
              title="Watch replay"
            >
              &#9654; Watch
            </button>
          )}
          <span className="text-[10px] text-osu-f1 w-12 text-right">
            {formatTimeAgo(getScoreTimestamp(score))}
          </span>
        </div>
      </div>

      {/* Expanded score details */}
      {rendered && (
        <div
          className={`relative overflow-hidden px-4 pb-3 pt-1 border-t border-osu-b3/20 ${expanded ? "detail-enter" : "detail-exit"}`}
          onAnimationEnd={() => { if (!expanded) setRendered(false); }}
        >
              {(score.beatmapset?.covers?.["cover@2x"] || score.beatmapset?.covers?.cover) && (
                <div
                  className="absolute inset-0 opacity-[0.07] bg-cover bg-center pointer-events-none"
                  style={{ backgroundImage: `url(${score.beatmapset.covers["cover@2x"] || score.beatmapset.covers.cover})` }}
                />
              )}
              <div className="relative grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3 text-center">
                <StatCell label="Score" value={totalScore != null ? formatNumber(totalScore) : "-"} />
                <StatCell label="Combo" value={`${formatNumber(score.max_combo)}x`} />
                {judgementStats.map((judgement) => (
                  <StatCell key={judgement.label} label={judgement.label} value={formatNumber(judgement.value)} color={judgement.className} />
                ))}
                {score.pp != null && score.pp > 0 && (
                  <StatCell label="PP" value={`${Math.round(score.pp)}pp`} color="text-osu-pink" />
                )}
                {score.beatmap?.difficulty_rating != null && (
                  <StatCell label="Stars" value={score.beatmap.difficulty_rating.toFixed(2)} />
                )}
                {score.beatmap?.bpm != null && (
                  <StatCell label="BPM" value={String(Math.round(score.beatmap.bpm))} />
                )}
              </div>
              <div className="relative mt-2 flex items-center justify-between gap-2">
                <span className="text-[10px] text-osu-f1">
                  Played on: <span className={lazer ? "text-osu-pink-light" : "text-osu-l2"}>{lazer ? "Lazer" : "Stable"}</span>
                </span>
                {scoreUrl ? (
                  <a
                    href={scoreUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[10px] text-osu-f1 hover:text-osu-pink-light underline-offset-2 hover:underline transition-colors"
                  >
                    View on osu! →
                  </a>
                ) : <span />}
              </div>
        </div>
      )}
    </div>
  );
});

function StatCell({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="py-1.5">
      <div className="text-[9px] uppercase tracking-wider text-osu-f1 font-semibold">{label}</div>
      <div className={`text-sm font-bold ${color ?? "text-white"}`}>{value}</div>
    </div>
  );
}
