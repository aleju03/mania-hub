import { createFileRoute, stripSearchParams, useNavigate } from "@tanstack/react-router";
import { useState, useEffect, useCallback, useMemo, memo, useRef } from "react";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import { getRankings, getCountryRecentScores, getTrackerLiveSnapshot, getTrackerSnapshot } from "../lib/osu";
import { CLIENT_CACHE_TTL, isCacheStale } from "../lib/cache";
import { getCountryName, isGlobalScope } from "../lib/country";
import { formatAccuracy, formatTimeAgo, formatPP, formatNumber, formatPpGain } from "../lib/format";
import {
  getBeatmapUrl,
  getBeatmapKeyCount,
  getBeatmapKeymodeLabel,
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
import { OsuTriangleBackdrop } from "../components/layout/OsuTriangleBackdrop";
import { CountryFlag } from "../components/ui/CountryFlag";

import { Avatar } from "../components/ui/Avatar";
import { GradeImg } from "../components/ui/GradeImg";
import { ModBadge } from "../components/ui/ModBadge";
import { DanBadge } from "../components/ui/DanBadge";
import { TrackerRowSkeleton } from "../components/ui/LoadingSkeleton";
import { Pagination } from "../components/ui/Pagination";
import { getManiaJudgementStats } from "../components/ui/ManiaJudgementStats";
import { UsernameText } from "../components/ui/UsernameText";
import { TRACKER_FEED_SCORE_LIMIT, TRACKER_PP_GAIN_CLIENT_TTL, useAppStore, useHiddenUserIds, useSelectedCountry } from "../store";
import type { LeanTrackerScore } from "../lib/types";
import { parseCountrySearchParam } from "../lib/country-search";
import { getReplaySearch } from "../lib/replay-navigation";
import { fetchLiveTrackerSnapshot, isLiveBackendConfigured, openLiveEventSource } from "../lib/live-backend";
import { CountryWarming } from "../components/CountryWarming";
import { LiveDataEmptyState } from "../components/LiveDataEmptyState";
import { useCountryWarming } from "../lib/use-country-warming";
import { useWindowActive } from "../lib/window-activity";

const TRACKER_SNAPSHOT_LOADER_TIMEOUT_MS = 2500;
const TRACKER_PAGE_SIZE = 45;
const TRACKER_LIVE_MIN_SNAPSHOT_LIMIT = TRACKER_PAGE_SIZE * 2;
const TRACKER_LIVE_RECONCILE_LIMIT = 60;
const TRACKER_LIVE_RECONCILE_MIN_INTERVAL_MS = 2 * 60_000;
const TRACKER_GLOBAL_WINDOW_HOURS = 24;
const DEV_ACTIVE_PLAYER_SIMULATION_COUNT = 200;

type ActivePlayerRailInfo = {
  username: string;
  avatar_url: string;
  latestTime: number;
  simulated?: boolean;
};

type ActivePlayerRailItem = ActivePlayerRailInfo & {
  id: number;
};

function makeDevAvatarUrl(index: number): string {
  const hue = (index * 47) % 360;
  const accentHue = (hue + 44) % 360;
  const label = String((index % 99) + 1);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="32" fill="hsl(${hue} 58% 28%)"/><circle cx="45" cy="18" r="20" fill="hsl(${accentHue} 90% 66%)" opacity=".75"/><circle cx="20" cy="46" r="22" fill="hsl(${hue} 78% 72%)" opacity=".62"/><text x="32" y="38" text-anchor="middle" font-family="Arial,sans-serif" font-size="20" font-weight="700" fill="white">${label}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function makeDevActivePlayers(count: number): ActivePlayerRailItem[] {
  const now = Date.now();
  return Array.from({ length: count }, (_, index) => ({
    id: -9_000_000 - index,
    username: `sim player ${index + 1}`,
    avatar_url: makeDevAvatarUrl(index),
    latestTime: now - index * 1000,
    simulated: true,
  }));
}

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

function parseTrackerSort(value: unknown): TrackerSort {
  return value === "stars" ? "stars" : "recent";
}

function parseTrackerSortDirection(value: unknown): TrackerSortDirection {
  return value === "asc" ? "asc" : "desc";
}

export const Route = createFileRoute("/tracker")({
  validateSearch: (search: Record<string, unknown>) => {
    const sort = parseTrackerSort(search.sort);
    const sortDirection = parseTrackerSortDirection(search.sortDirection ?? search.dir);
    return {
      country: parseCountrySearchParam(search.country),
      page: (() => {
        const n = Number(search.page);
        if (!Number.isFinite(n) || n < 0) return undefined;
        return Math.floor(n);
      })(),
      ...(sort === "stars"
        ? {
            sort,
            ...(sortDirection === "asc" ? { sortDirection } : {}),
          }
        : {}),
    };
  },
  search: {
    middlewares: [stripSearchParams({ page: undefined, sort: undefined, sortDirection: undefined })],
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
        { name: "description", content: "" },
        { name: "robots", content: "noindex, nofollow" },
      ],
    };
  },
  component: ScoresPage,
});

type ScoreFilter = "all" | "ranked";
type GradeFilter = "all" | "SS" | "S" | "A" | "B";
type KeyFilter = "all" | "4k" | "other";
type MissFilter = "all" | "fc" | "fc_choke";
type TrackerSort = "recent" | "stars";
type TrackerSortDirection = "asc" | "desc";
type TrackerBackendFilterOptions = {
  scoreFilter?: "ranked";
  grade?: Exclude<GradeFilter, "all">;
  key?: Exclude<KeyFilter, "all">;
  miss?: Exclude<MissFilter, "all">;
};

function scoreMatchesKeyFilter(score: LeanTrackerScore, keyFilter: KeyFilter): boolean {
  if (keyFilter === "all") return true;
  const keys = getBeatmapKeyCount(score.beatmap);
  if (keys == null) return false;
  return keyFilter === "4k" ? keys === 4 : keys !== 4;
}

function getScoreMissCount(score: LeanTrackerScore): number {
  const stats = score.statistics ?? {};
  return stats.count_miss ?? stats.miss ?? 0;
}

function scoreMatchesMissFilter(score: LeanTrackerScore, missFilter: MissFilter): boolean {
  if (missFilter === "all") return true;
  const misses = getScoreMissCount(score);
  return missFilter === "fc" ? misses === 0 : misses === 1;
}

function scoreMatchesTrackerFilters(
  score: LeanTrackerScore,
  filters: { filter: ScoreFilter; gradeFilter: GradeFilter; keyFilter: KeyFilter; missFilter: MissFilter },
): boolean {
  if (!isDisplayedPassed(score)) return false;
  if (!scoreMatchesKeyFilter(score, filters.keyFilter)) return false;
  if (!scoreMatchesMissFilter(score, filters.missFilter)) return false;
  if (filters.filter === "ranked") return score.pp != null && score.pp > 0;
  if (filters.gradeFilter !== "all") {
    const rank = getDisplayedRank(score);
    if (filters.gradeFilter === "SS") return ["SS", "SSH", "X", "XH"].includes(rank);
    if (filters.gradeFilter === "S") return ["S", "SH"].includes(rank);
    return rank === filters.gradeFilter;
  }
  return true;
}

function getBackendTrackerFilters(filters: { filter: ScoreFilter; gradeFilter: GradeFilter; keyFilter: KeyFilter; missFilter: MissFilter }): TrackerBackendFilterOptions {
  return {
    scoreFilter: filters.filter === "ranked" ? "ranked" : undefined,
    grade: filters.gradeFilter === "all" ? undefined : filters.gradeFilter,
    key: filters.keyFilter === "all" ? undefined : filters.keyFilter,
    miss: filters.missFilter === "all" ? undefined : filters.missFilter,
  };
}

function getStarRating(score: LeanTrackerScore): number {
  return score.beatmap?.difficulty_rating ?? -1;
}

function compareTrackerScores(a: LeanTrackerScore, b: LeanTrackerScore, sort: TrackerSort, direction: TrackerSortDirection): number {
  if (sort === "stars") {
    const starDelta = direction === "asc"
      ? (a.beatmap?.difficulty_rating ?? Number.MAX_SAFE_INTEGER) - (b.beatmap?.difficulty_rating ?? Number.MAX_SAFE_INTEGER)
      : getStarRating(b) - getStarRating(a);
    if (starDelta !== 0) return starDelta;
  }
  return getScoreTimeMs(b) - getScoreTimeMs(a);
}

function sortTrackerScores(scores: LeanTrackerScore[], sort: TrackerSort, direction: TrackerSortDirection): LeanTrackerScore[] {
  if (sort === "recent") return scores;
  return [...scores].sort((a, b) => compareTrackerScores(a, b, sort, direction));
}

function getLiveTrackerSnapshotOptions(country: string, options: { offset?: number; filters?: TrackerBackendFilterOptions; sort?: TrackerSort; sortDirection?: TrackerSortDirection } = {}): { offset?: number; hours?: number; filters?: TrackerBackendFilterOptions; sort?: TrackerSort; sortDirection?: TrackerSortDirection } {
  return isGlobalScope(country) ? { ...options, hours: TRACKER_GLOBAL_WINDOW_HOURS } : options;
}

function getLiveTrackerTotal(country: string, total: number | null | undefined): number {
  const normalizedTotal = Math.max(0, Math.floor(total ?? 0));
  return isGlobalScope(country) ? normalizedTotal : Math.min(TRACKER_FEED_SCORE_LIMIT, normalizedTotal);
}

const EMPTY_IDS: number[] = [];
const EMPTY_SCORES: LeanTrackerScore[] = [];
const EMPTY_KEY_SET: ReadonlySet<string> = new Set<string>();
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
  const { country, page: searchPage, sort: searchSort, sortDirection: searchSortDirection } = Route.useSearch();
  const trackerSort: TrackerSort = searchSort ?? "recent";
  const trackerSortDirection: TrackerSortDirection = trackerSort === "stars" ? (searchSortDirection ?? "desc") : "desc";
  const page = searchPage ?? 0;
  const fallbackCountry = useSelectedCountry();
  const selectedCountry = country ?? fallbackCountry;
  const selectedCountryRef = useRef(selectedCountry);
  selectedCountryRef.current = selectedCountry;
  const selectedIsGlobal = isGlobalScope(selectedCountry);
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
  const hiddenUserIds = useHiddenUserIds();
  const [userIds, setUserIds] = useState<number[]>(trackedUserIds);
  const [loadingPlayers, setLoadingPlayers] = useState<boolean>(trackedUserIds.length === 0 && !rankings);
  const [playersError, setPlayersError] = useState<string | null>(null);
  const [filter, setFilter] = useState<ScoreFilter>("all");
  const [gradeFilter, setGradeFilter] = useState<GradeFilter>("all");
  const [keyFilter, setKeyFilter] = useState<KeyFilter>("all");
  const [missFilter, setMissFilter] = useState<MissFilter>("all");
  const [selectedPlayerIds, setSelectedPlayerIds] = useState<number[]>([]);
  const [initialLoaded, setInitialLoaded] = useState(feedScores.length > 0 || !!feedScoresFetchedAt || !!snapshot);
  const initialLoadedCountryRef = useRef(selectedCountry);
  const initialLoadedForSelectedCountry = initialLoadedCountryRef.current === selectedCountry
    ? initialLoaded
    : feedScores.length > 0 || !!feedScoresFetchedAt || !!snapshot;
  const [initialRefreshDone, setInitialRefreshDone] = useState(false);
  const [initialFetching, setInitialFetching] = useState(false);
  const [polling, setPolling] = useState(false);
  const [simulateHighTraffic, setSimulateHighTraffic] = useState(false);
  const [timeTick, setTimeTick] = useState(0);
  const [liveSnapshotLoading, setLiveSnapshotLoading] = useState(false);
  const [liveTrackerTotal, setLiveTrackerTotal] = useState<number | null>(null);
  const [livePageScores, setLivePageScores] = useState<LeanTrackerScore[]>([]);
  const [livePageSnapshotKey, setLivePageSnapshotKey] = useState<string | null>(null);
  const [livePageLoading, setLivePageLoading] = useState(false);
  const [liveFilteredTotal, setLiveFilteredTotal] = useState<number | null>(null);
  const [liveFilteredScores, setLiveFilteredScores] = useState<LeanTrackerScore[]>([]);
  const [liveFilteredSnapshotKey, setLiveFilteredSnapshotKey] = useState<string | null>(null);
  const [liveFilteredLoading, setLiveFilteredLoading] = useState(false);
  const refreshing = initialFetching || polling || liveSnapshotLoading || livePageLoading || liveFilteredLoading;
  const initialFetchInFlightRef = useRef(false);
  const pollInFlightRef = useRef(false);
  const liveSnapshotInFlightRef = useRef(false);
  const liveSnapshotInFlightLimitRef = useRef(0);
  const queuedLiveSnapshotLimitRef = useRef<number | null>(null);
  const livePageRequestIdRef = useRef(0);
  const liveFilteredRequestIdRef = useRef(0);
  const lastLiveSnapshotAtRef = useRef(0);
  const knownLiveScoreIdentitiesRef = useRef<Set<string>>(new Set());
  const pollRequestIdRef = useRef(0);
  const appliedSnapshotKeyRef = useRef<string | null>(null);
  const liveBackendEnabled = isLiveBackendConfigured();
  const windowActive = useWindowActive();
  const { warming } = useCountryWarming(selectedCountry);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const handleToggleExpand = useCallback((key: string) => {
    setExpandedKey((prev) => (prev === key ? null : key));
  }, []);
  const trackerPpGainEntries = useAppStore((state) => state.trackerPpGainsByCountry[selectedCountry] ?? EMPTY_SCORE_GAINS);
  const setTrackerPpGains = useAppStore((state) => state.setTrackerPpGains);
  const countryName = getCountryName(selectedCountry);
  const hasActiveScoreFilters = selectedPlayerIds.length > 0
    || filter !== "all"
    || gradeFilter !== "all"
    || keyFilter !== "all"
    || missFilter !== "all"
    || hiddenUserIds.size > 0;
  const hasBackendScoreFilters = filter !== "all"
    || gradeFilter !== "all"
    || keyFilter !== "all"
    || missFilter !== "all";
  const useLiveBackendFilteredScores = liveBackendEnabled
    && ((selectedIsGlobal && hasBackendScoreFilters) || trackerSort !== "recent")
    && selectedPlayerIds.length === 0
    && hiddenUserIds.size === 0;
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
    initialLoadedCountryRef.current = selectedCountry;
    setInitialLoaded(true);
    if (snapshot.scores.length > 0) addFeedScores(selectedCountry, snapshot.scores);
    if (Object.keys(snapshot.gains).length > 0) {
      setTrackerPpGains(selectedCountry, snapshot.gains, snapshot.fetchedAt);
    }
  }, [snapshot, selectedCountry, setRankings, setTrackedUserIds, addFeedScores, setTrackerPpGains]);

  useEffect(() => {
    if (!windowActive) return;
    const id = window.setInterval(() => setTimeTick((value) => value + 1), 30_000);
    return () => window.clearInterval(id);
  }, [windowActive]);

  useEffect(() => {
    for (const score of feedScores) {
      knownLiveScoreIdentitiesRef.current.add(getScoreIdentity(score));
    }
  }, [feedScores]);

  const reconcileLiveSnapshot = useCallback(async (
    requestedCountry: string,
    options: { force?: boolean; limit?: number } = {},
  ) => {
    const now = Date.now();
    const requestedLimit = options.limit ?? TRACKER_LIVE_RECONCILE_LIMIT;
    if (!options.force && now - lastLiveSnapshotAtRef.current < TRACKER_LIVE_RECONCILE_MIN_INTERVAL_MS) return;
    if (liveSnapshotInFlightRef.current) {
      if (options.force || requestedLimit > liveSnapshotInFlightLimitRef.current) {
        queuedLiveSnapshotLimitRef.current = Math.max(queuedLiveSnapshotLimitRef.current ?? 0, requestedLimit);
      }
      return;
    }

    liveSnapshotInFlightRef.current = true;
    liveSnapshotInFlightLimitRef.current = requestedLimit;
    setLiveSnapshotLoading(true);
    try {
      const liveSnapshot = await fetchLiveTrackerSnapshot(requestedCountry, requestedLimit, getLiveTrackerSnapshotOptions(requestedCountry));
      if (requestedCountry !== selectedCountryRef.current) return;
      lastLiveSnapshotAtRef.current = Date.now();
      if (Number.isFinite(liveSnapshot.total)) {
        setLiveTrackerTotal(getLiveTrackerTotal(requestedCountry, liveSnapshot.total));
      }
      const passedScores = liveSnapshot.scores.filter(isDisplayedPassed);
      if (passedScores.length > 0) addFeedScores(requestedCountry, passedScores);
      if (Object.keys(liveSnapshot.gains).length > 0) {
        setTrackerPpGains(requestedCountry, liveSnapshot.gains, liveSnapshot.fetchedAt);
      }
      markFeedScoresFetched(requestedCountry);
      initialLoadedCountryRef.current = requestedCountry;
      setInitialLoaded(true);
      setInitialRefreshDone(true);
      setInitialFetching(false);
      setLoadingPlayers(false);
    } finally {
      liveSnapshotInFlightRef.current = false;
      liveSnapshotInFlightLimitRef.current = 0;
      const queuedLimit = queuedLiveSnapshotLimitRef.current;
      queuedLiveSnapshotLimitRef.current = null;
      if (queuedLimit != null && requestedCountry === selectedCountryRef.current) {
        void reconcileLiveSnapshot(requestedCountry, { force: true, limit: queuedLimit });
      } else {
        setLiveSnapshotLoading(false);
      }
    }
  }, [addFeedScores, markFeedScoresFetched, setTrackerPpGains]);

  useEffect(() => {
    if (!liveBackendEnabled || !windowActive) return;
    const requestedCountry = selectedCountry;
    const run = (options: { force?: boolean; limit?: number } = {}) => {
      reconcileLiveSnapshot(requestedCountry, options).catch(() => {
        // The existing server-function path below remains the fallback.
      });
    };
    run({ force: true, limit: TRACKER_LIVE_MIN_SNAPSHOT_LIMIT });
  }, [liveBackendEnabled, reconcileLiveSnapshot, selectedCountry, windowActive]);

  useEffect(() => {
    if (!liveBackendEnabled || !windowActive) return;
    const source = openLiveEventSource(selectedCountry);
    if (!source) return;
    source.addEventListener("tracker_score", (event) => {
      const score = JSON.parse(event.data) as LeanTrackerScore;
      if (!isDisplayedPassed(score)) return;
      const identity = getScoreIdentity(score);
      const alreadyKnown = knownLiveScoreIdentitiesRef.current.has(identity);
      knownLiveScoreIdentitiesRef.current.add(identity);
      addFeedScores(selectedCountry, [score]);
      if (!alreadyKnown) {
        setLiveTrackerTotal((current) => {
          if (current == null) return current;
          return getLiveTrackerTotal(selectedCountry, current + 1);
        });
        if (useLiveBackendFilteredScores && scoreMatchesTrackerFilters(score, { filter, gradeFilter, keyFilter, missFilter })) {
          setLiveFilteredTotal((current) => current == null ? current : current + 1);
          setLiveFilteredScores((current) => page === 0 ? sortTrackerScores([score, ...current], trackerSort, trackerSortDirection).slice(0, TRACKER_PAGE_SIZE) : current);
        }
      }
    });
    source.addEventListener("score_gain", (event) => {
      const data = JSON.parse(event.data) as { scoreId?: number; ppGain?: number };
      if (data.scoreId != null && data.ppGain != null) {
        setTrackerPpGains(selectedCountry, { [data.scoreId]: data.ppGain });
      }
    });
    return () => source.close();
  }, [addFeedScores, filter, gradeFilter, keyFilter, liveBackendEnabled, missFilter, page, reconcileLiveSnapshot, selectedCountry, setTrackerPpGains, trackerSort, trackerSortDirection, useLiveBackendFilteredScores, windowActive]);

  useEffect(() => {
    initialLoadedCountryRef.current = selectedCountry;
    setUserIds(trackedUserIds);
    setLoadingPlayers(trackedUserIds.length === 0 && !rankings);
    setPlayersError(null);
    setInitialLoaded(feedScores.length > 0 || !!feedScoresFetchedAt);
    setInitialRefreshDone(false);
    setInitialFetching(false);
    setPolling(false);
    initialFetchInFlightRef.current = false;
    pollInFlightRef.current = false;
    liveSnapshotInFlightRef.current = false;
    liveSnapshotInFlightLimitRef.current = 0;
    queuedLiveSnapshotLimitRef.current = null;
    lastLiveSnapshotAtRef.current = 0;
    setLiveSnapshotLoading(false);
    setLiveTrackerTotal(null);
    setLivePageScores([]);
    setLivePageSnapshotKey(null);
    setLivePageLoading(false);
    livePageRequestIdRef.current += 1;
    setLiveFilteredTotal(null);
    setLiveFilteredScores([]);
    setLiveFilteredSnapshotKey(null);
    setLiveFilteredLoading(false);
    liveFilteredRequestIdRef.current += 1;
    pollRequestIdRef.current += 1;
    knownLiveScoreIdentitiesRef.current = new Set();
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
    if (feedScores.length > 0 || !!feedScoresFetchedAt || !!snapshot) {
      initialLoadedCountryRef.current = selectedCountry;
      setInitialLoaded(true);
    }
  }, [feedScores.length, feedScoresFetchedAt, selectedCountry, snapshot]);

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
      initialLoadedCountryRef.current = selectedCountry;
      setInitialLoaded(true);
      setInitialRefreshDone(true);
      return;
    }

    if (feedScores.length > 0) {
      initialLoadedCountryRef.current = selectedCountry;
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
          initialLoadedCountryRef.current = requestedCountry;
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
    if (!windowActive) return;
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
  }, [liveBackendEnabled, addFeedScores, markFeedScoresFetched, selectedCountry, setTrackerPpGains, setTrackedUserIds, windowActive]);

  useEffect(() => {
    if (liveBackendEnabled || !windowActive) return;
    void poll();
    const id = setInterval(poll, 60_000);
    return () => {
      clearInterval(id);
    };
  }, [poll, liveBackendEnabled, windowActive]);

  useEffect(() => {
    setExpandedKey(null);
  }, [filter, gradeFilter, keyFilter, missFilter, trackerSort, trackerSortDirection]);

  const ppGainByScoreId = useMemo(
    () => Object.fromEntries(
      Object.entries(trackerPpGainEntries)
        .filter(([, entry]) => Date.now() - entry.fetchedAt < TRACKER_PP_GAIN_CLIENT_TTL)
        .map(([scoreId, entry]) => [Number(scoreId), entry.value]),
    ) as Record<number, number>,
    [trackerPpGainEntries],
  );

  const selectedPlayerIdSet = useMemo(() => new Set(selectedPlayerIds), [selectedPlayerIds]);

  const updateTrackerSearch = useCallback((patch: Partial<{ country: string | undefined; page: number | undefined; sort: TrackerSort; sortDirection: TrackerSortDirection }>) => {
    const nextPage = patch.page ?? page;
    const nextCountry = patch.country ?? country;
    const nextSort = patch.sort ?? trackerSort;
    const nextSortDirection = nextSort === "stars"
      ? (patch.sortDirection ?? trackerSortDirection)
      : "desc";
    const currentSortDirection = trackerSort === "stars" ? trackerSortDirection : "desc";
    const nextPageParam = nextPage > 0 ? nextPage : undefined;
    const currentPageParam = page > 0 ? page : undefined;
    if (
      nextCountry === country
      && nextPageParam === currentPageParam
      && nextSort === trackerSort
      && nextSortDirection === currentSortDirection
    ) return;

    navigate({
      to: "/tracker",
      search: {
        country: nextCountry,
        page: nextPageParam,
        sort: nextSort === "stars" ? nextSort : undefined,
        sortDirection: nextSort === "stars" && nextSortDirection === "asc" ? nextSortDirection : undefined,
      },
      replace: true,
      resetScroll: false,
    });
  }, [country, navigate, page, trackerSort, trackerSortDirection]);

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

    const nextFiltered = playerFiltered.filter((score: LeanTrackerScore) => {
      if (hiddenUserIds.has(score.user_id)) return false;
      return scoreMatchesTrackerFilters(score, { filter, gradeFilter, keyFilter, missFilter });
    });
    return sortTrackerScores(nextFiltered, trackerSort, trackerSortDirection);
  }, [feedScores, filter, gradeFilter, keyFilter, missFilter, selectedPlayerIdSet, selectedPlayerIds.length, hiddenUserIds, trackerSort, trackerSortDirection]);

  const activePlayers = useMemo(() => {
    const activeCutoff = Date.now() - 40 * 60 * 1000;
    const seen = new Map<number, ActivePlayerRailInfo>();
    for (const score of feedScores) {
      const timeMs = getScoreTimeMs(score);
      if (timeMs < activeCutoff || !score.user) continue;
      if (hiddenUserIds.has(score.user_id)) continue;
      const existing = seen.get(score.user_id);
      if (!existing || timeMs > existing.latestTime) {
        seen.set(score.user_id, {
          username: score.user.username,
          avatar_url: score.user.avatar_url,
          latestTime: timeMs,
        });
      }
    }
    const realPlayers = [...seen.entries()]
      .sort((a, b) => b[1].latestTime - a[1].latestTime)
      .map(([id, info]) => ({ id, ...info }));
    if (!import.meta.env.DEV || !simulateHighTraffic || realPlayers.length >= DEV_ACTIVE_PLAYER_SIMULATION_COUNT) {
      return realPlayers;
    }
    return [
      ...realPlayers,
      ...makeDevActivePlayers(DEV_ACTIVE_PLAYER_SIMULATION_COUNT - realPlayers.length),
    ];
  }, [feedScores, hiddenUserIds, simulateHighTraffic]);

  // Desktop active-player rail scrolls internally; fade the edge(s) that have
  // hidden avatars so the list never cuts off abruptly (and hide the scrollbar).
  const activeRailRef = useRef<HTMLDivElement | null>(null);
  const [railFade, setRailFade] = useState<{ top: boolean; bottom: boolean }>({ top: false, bottom: false });
  const updateRailFade = useCallback(() => {
    const el = activeRailRef.current;
    if (!el) return;
    const top = el.scrollTop > 4;
    const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 4;
    setRailFade((prev) => (prev.top === top && prev.bottom === bottom ? prev : { top, bottom }));
  }, []);
  useEffect(() => {
    updateRailFade();
    window.addEventListener("resize", updateRailFade);
    return () => window.removeEventListener("resize", updateRailFade);
  }, [activePlayers.length, updateRailFade]);
  const railMaskClass = railFade.top && railFade.bottom
    ? "tracker-rail--tb"
    : railFade.top
      ? "tracker-rail--t"
      : railFade.bottom
        ? "tracker-rail--b"
        : "";

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
  const keymodes: { id: KeyFilter; label: string }[] = [
    { id: "all", label: "Any" },
    { id: "4k", label: "4K" },
    { id: "other", label: "≠4K" },
  ];
  const cycleStarSort = (direction: 1 | -1 = 1) => {
    const states: Array<{ sort: TrackerSort; direction: TrackerSortDirection }> = [
      { sort: "recent", direction: "desc" },
      { sort: "stars", direction: "desc" },
      { sort: "stars", direction: "asc" },
    ];
    const currentIndex = states.findIndex((state) => state.sort === trackerSort && state.direction === trackerSortDirection);
    const next = states[(currentIndex + direction + states.length) % states.length] ?? states[0];
    updateTrackerSearch({ page: 0, sort: next.sort, sortDirection: next.direction });
  };
  const cycleMissFilter = (direction: 1 | -1 = 1) => {
    const states: MissFilter[] = ["all", "fc", "fc_choke"];
    setMissFilter((current) => {
      const currentIndex = states.indexOf(current);
      return states[(currentIndex + direction + states.length) % states.length] ?? "all";
    });
    updateTrackerSearch({ page: 0 });
  };
  useEffect(() => {
    if (!liveBackendEnabled || !windowActive || !hasActiveScoreFilters || useLiveBackendFilteredScores || feedScores.length >= TRACKER_FEED_SCORE_LIMIT) return;
    void reconcileLiveSnapshot(selectedCountry, { force: true, limit: TRACKER_FEED_SCORE_LIMIT });
  }, [feedScores.length, hasActiveScoreFilters, liveBackendEnabled, reconcileLiveSnapshot, selectedCountry, useLiveBackendFilteredScores, windowActive]);
  const missButtonLabel = missFilter === "fc_choke" ? "Choke" : "FC";
  const mobileMissButtonLabel = missFilter === "fc_choke" ? "Ch" : "FC";
  const missButtonTitle = missFilter === "fc"
    ? "Showing full combos (0 misses) - left click for FC chokes, right click to clear"
    : missFilter === "fc_choke"
      ? "Showing FC chokes (1 miss) - left click to clear, right click for FCs"
      : "Left click for FCs, right click for FC chokes";
  const starSortTitle = trackerSort === "stars"
    ? trackerSortDirection === "desc"
      ? "Sorting highest star rating first - left click for ascending, right click to clear"
      : "Sorting lowest star rating first - left click to clear, right click for descending"
    : "Left click for highest star rating first, right click for lowest first";
  const listKey = `${filter}:${gradeFilter}:${keyFilter}:${missFilter}:${trackerSort}:${trackerSortDirection}`;
  const liveTrackerAvailableCount = liveTrackerTotal == null
    ? (selectedIsGlobal ? filtered.length : TRACKER_FEED_SCORE_LIMIT)
    : getLiveTrackerTotal(selectedCountry, liveTrackerTotal);
  const trackerWindowCount = useLiveBackendFilteredScores
    ? (liveFilteredTotal ?? 0)
    : liveBackendEnabled && !hasActiveScoreFilters
    ? Math.max(filtered.length, liveTrackerAvailableCount)
    : filtered.length;
  const totalPages = Math.max(1, Math.ceil(
    trackerWindowCount / TRACKER_PAGE_SIZE,
  ));
  const currentPage = Math.min(page, totalPages - 1);
  const requiredScoreCountForPage = liveBackendEnabled && !hasActiveScoreFilters
    ? Math.min((currentPage + 1) * TRACKER_PAGE_SIZE, trackerWindowCount)
    : 0;
  const livePageOffset = currentPage * TRACKER_PAGE_SIZE;
  const expectedLivePageSize = useLiveBackendFilteredScores && liveFilteredTotal == null
    ? TRACKER_PAGE_SIZE
    : Math.max(0, Math.min(TRACKER_PAGE_SIZE, trackerWindowCount - livePageOffset));
  const expectedLivePageEnd = livePageOffset + expectedLivePageSize;
  const needsLivePageSnapshot = liveBackendEnabled
    && !hasActiveScoreFilters
    && currentPage > 0
    && filtered.length < requiredScoreCountForPage;
  const currentLivePageSnapshotKey = `${selectedCountry}:${livePageOffset}:${expectedLivePageSize}`;
  const backendTrackerFilters = getBackendTrackerFilters({ filter, gradeFilter, keyFilter, missFilter });
  const currentLiveFilteredSnapshotKey = `${selectedCountry}:${livePageOffset}:${expectedLivePageSize}:${filter}:${gradeFilter}:${keyFilter}:${missFilter}:${trackerSort}:${trackerSortDirection}`;
  const hasLivePageSnapshot = needsLivePageSnapshot
    && livePageSnapshotKey === currentLivePageSnapshotKey;
  const hasLiveFilteredSnapshot = useLiveBackendFilteredScores
    && liveFilteredSnapshotKey === currentLiveFilteredSnapshotKey;
  const showingLivePageSkeletons = needsLivePageSnapshot
    ? !hasLivePageSnapshot
    : useLiveBackendFilteredScores
      ? !hasLiveFilteredSnapshot
      : liveBackendEnabled && !hasActiveScoreFilters && filtered.length < requiredScoreCountForPage;
  const paginatedScores = useMemo(
    () => hasLiveFilteredSnapshot
      ? liveFilteredScores.slice(0, expectedLivePageSize)
      : hasLivePageSnapshot
      ? livePageScores.slice(0, expectedLivePageSize)
      : filtered.slice(livePageOffset, expectedLivePageEnd),
    [expectedLivePageEnd, expectedLivePageSize, filtered, hasLiveFilteredSnapshot, hasLivePageSnapshot, liveFilteredScores, livePageOffset, livePageScores],
  );
  const liveStatusLabel = liveBackendEnabled ? "Live updates on" : "Live polling";
  const scoreWindowLabel = liveBackendEnabled && selectedIsGlobal
    ? liveTrackerTotal == null && !useLiveBackendFilteredScores
      ? "Last 24h"
      : `Last 24h \u00b7 ${formatNumber(trackerWindowCount)} scores`
    : liveBackendEnabled
      ? `${formatNumber(trackerWindowCount)} scores`
      : `${formatNumber(feedScores.length)} scores`;

  useEffect(() => {
    if (!useLiveBackendFilteredScores) {
      setLiveFilteredTotal(null);
      setLiveFilteredScores([]);
      setLiveFilteredSnapshotKey(null);
      setLiveFilteredLoading(false);
      liveFilteredRequestIdRef.current += 1;
      return;
    }
    if (expectedLivePageSize === 0 && liveFilteredTotal != null) {
      setLiveFilteredScores([]);
      setLiveFilteredSnapshotKey(currentLiveFilteredSnapshotKey);
      setLiveFilteredLoading(false);
      return;
    }
    if (hasLiveFilteredSnapshot) {
      setLiveFilteredLoading(false);
      return;
    }

    const requestId = ++liveFilteredRequestIdRef.current;
    const requestedCountry = selectedCountry;
    const requestedKey = currentLiveFilteredSnapshotKey;
    setLiveFilteredLoading(true);
    fetchLiveTrackerSnapshot(
      requestedCountry,
      Math.max(1, expectedLivePageSize || TRACKER_PAGE_SIZE),
      getLiveTrackerSnapshotOptions(requestedCountry, {
        offset: livePageOffset,
        filters: backendTrackerFilters,
        sort: trackerSort,
        sortDirection: trackerSortDirection,
      }),
    )
      .then((snapshot) => {
        if (liveFilteredRequestIdRef.current !== requestId || requestedCountry !== selectedCountryRef.current) return;
        setLiveFilteredTotal(getLiveTrackerTotal(requestedCountry, snapshot.total ?? snapshot.scores.length));
        const passedScores = sortTrackerScores(snapshot.scores.filter(isDisplayedPassed), trackerSort, trackerSortDirection);
        setLiveFilteredScores(passedScores);
        setLiveFilteredSnapshotKey(requestedKey);
        if (Object.keys(snapshot.gains).length > 0) {
          setTrackerPpGains(requestedCountry, snapshot.gains, snapshot.fetchedAt);
        }
      })
      .catch(() => {
        if (liveFilteredRequestIdRef.current === requestId) {
          setLiveFilteredScores([]);
          setLiveFilteredSnapshotKey(requestedKey);
        }
      })
      .finally(() => {
        if (liveFilteredRequestIdRef.current === requestId) setLiveFilteredLoading(false);
      });
  }, [
    currentLiveFilteredSnapshotKey,
    expectedLivePageSize,
    filter,
    gradeFilter,
    hasLiveFilteredSnapshot,
    keyFilter,
    liveFilteredTotal,
    livePageOffset,
    missFilter,
    selectedCountry,
    setTrackerPpGains,
    trackerSort,
    trackerSortDirection,
    useLiveBackendFilteredScores,
  ]);

  useEffect(() => {
    if (!needsLivePageSnapshot) {
      setLivePageLoading(false);
      if (currentPage === 0 || hasActiveScoreFilters || !liveBackendEnabled) {
        setLivePageScores([]);
        setLivePageSnapshotKey(null);
      }
      return;
    }
    if (hasLivePageSnapshot || expectedLivePageSize === 0) {
      setLivePageLoading(false);
      return;
    }

    const requestId = ++livePageRequestIdRef.current;
    const requestedCountry = selectedCountry;
    const requestedKey = currentLivePageSnapshotKey;
    setLivePageLoading(true);
    fetchLiveTrackerSnapshot(requestedCountry, expectedLivePageSize, getLiveTrackerSnapshotOptions(requestedCountry, { offset: livePageOffset }))
      .then((snapshot) => {
        if (livePageRequestIdRef.current !== requestId || requestedCountry !== selectedCountryRef.current) return;
        if (Number.isFinite(snapshot.total)) {
          setLiveTrackerTotal(getLiveTrackerTotal(requestedCountry, snapshot.total));
        }
        const passedScores = snapshot.scores.filter(isDisplayedPassed);
        setLivePageScores(passedScores);
        setLivePageSnapshotKey(requestedKey);
        if (Object.keys(snapshot.gains).length > 0) {
          setTrackerPpGains(requestedCountry, snapshot.gains, snapshot.fetchedAt);
        }
      })
      .catch(() => {
        if (livePageRequestIdRef.current === requestId) {
          setLivePageScores([]);
          setLivePageSnapshotKey(requestedKey);
        }
      })
      .finally(() => {
        if (livePageRequestIdRef.current === requestId) setLivePageLoading(false);
      });
  }, [
    currentLivePageSnapshotKey,
    currentPage,
    expectedLivePageSize,
    hasActiveScoreFilters,
    hasLivePageSnapshot,
    liveBackendEnabled,
    livePageOffset,
    needsLivePageSnapshot,
    selectedCountry,
    setTrackerPpGains,
  ]);

  useEffect(() => {
    if (page !== currentPage) updateTrackerSearch({ page: currentPage });
  }, [currentPage, page, updateTrackerSearch]);

  const mobileHeaderKeymodeControls = (
    <div className="flex rounded-lg overflow-hidden border border-osu-b3/30 shrink-0 sm:hidden">
      {keymodes.map((item) => (
        <button
          key={item.id}
          onClick={() => { setKeyFilter(item.id); updateTrackerSearch({ page: 0 }); }}
          title={item.id === "other" ? "Show non-4K scores" : "Filter by keymode"}
          className={`px-2 py-1 text-[10px] font-semibold cursor-pointer transition-colors duration-[120ms] tabular-nums ${
            keyFilter === item.id
              ? "bg-osu-b3 text-osu-l2"
              : "bg-osu-b4/50 text-osu-f1 hover:text-osu-l2"
          }`}
        >
          {item.label}
        </button>
      ))}
    </div>
  );

  return (
    <div className="flex-1">
      <PageHeader
        iconSrc="/images/icons/news.svg"
        title={`${countryName} mania tracker`}
        right={
          <div className="flex flex-wrap items-center justify-end gap-2">
            {import.meta.env.DEV && (
              <button
                type="button"
                onClick={() => setSimulateHighTraffic((enabled) => !enabled)}
                className={`rounded-lg border px-2 py-1 text-[10px] font-semibold transition-colors ${
                  simulateHighTraffic
                    ? "border-osu-yellow/40 bg-osu-yellow/15 text-osu-yellow"
                    : "border-osu-pink/25 bg-osu-pink/10 text-osu-pink-light hover:bg-osu-pink/20"
                }`}
                title="Toggle simulated high-traffic active players"
              >
                {simulateHighTraffic ? "Sim 200 on" : "Sim 200"}
              </button>
            )}
            {loadingPlayers || refreshing || showingLivePageSkeletons ? (
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
                  {liveStatusLabel} {"\u00b7"} {scoreWindowLabel}
                </span>
              </>
            )}
            {mobileHeaderKeymodeControls}
          </div>
        }
      />

      {warming && <CountryWarming country={selectedCountry} />}

      {/* overflow-clip (not hidden) clips the triangle backdrop without creating
          a scroll container, so the sticky active-player rail inside resolves
          against the viewport. With overflow-hidden the rail stuck relative to
          this box and the "Playing" header snapped from too-high to its resting
          spot as the section height settled during the async load. */}
      {!warming && (
      <div className="relative overflow-clip bg-osu-b5">
      <OsuTriangleBackdrop />
      <div className="relative z-10 bg-osu-d5/90 border-b border-osu-b3/30 backdrop-blur-[1px]">
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
            <div className="w-px h-5 bg-osu-b3/40 mx-2" />
            {keymodes.map((item) => (
              <button
                key={item.id}
                onClick={() => { setKeyFilter(item.id); updateTrackerSearch({ page: 0 }); }}
                title={item.id === "other" ? "Show non-4K scores" : "Filter by keymode"}
                className={`px-2.5 py-2.5 text-[12px] font-medium cursor-pointer transition-colors duration-[120ms] border-b-2 tabular-nums ${
                  keyFilter === item.id
                    ? "text-osu-c1 border-osu-h1"
                    : "text-osu-f1 border-transparent hover:text-osu-l2"
                }`}
              >
                {item.label}
              </button>
            ))}
            <div className="w-px h-5 bg-osu-b3/40 mx-2" />
            <button
              onClick={() => cycleMissFilter(1)}
              onContextMenu={(event) => {
                event.preventDefault();
                cycleMissFilter(-1);
              }}
              title={missButtonTitle}
              className={`px-3 py-2.5 text-[12px] font-medium cursor-pointer transition-colors duration-[120ms] border-b-2 ${
                missFilter === "fc"
                  ? "text-osu-c1 border-osu-h1"
                  : missFilter === "fc_choke"
                    ? "text-osu-yellow border-osu-yellow"
                    : "text-osu-f1 border-transparent hover:text-osu-l2"
              }`}
            >
              {missButtonLabel}
            </button>
            <div className="w-px h-5 bg-osu-b3/40 mx-2" />
            <button
              onClick={() => cycleStarSort(1)}
              onContextMenu={(event) => {
                event.preventDefault();
                cycleStarSort(-1);
              }}
              title={starSortTitle}
              className={`px-3 py-2.5 text-[12px] font-medium cursor-pointer transition-colors duration-[120ms] border-b-2 ${
                trackerSort === "stars"
                  ? "text-osu-c1 border-osu-h1"
                  : "text-osu-f1 border-transparent hover:text-osu-l2"
              }`}
            >
              Stars{trackerSort === "stars" ? (trackerSortDirection === "desc" ? " ↓" : " ↑") : ""}
            </button>
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
            <div className="flex items-center justify-between gap-1">
              <div className="flex rounded-lg overflow-hidden border border-osu-b3/30 flex-shrink-0">
                {filters.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => { setFilter(item.id); if (item.id !== "all") setGradeFilter("all"); updateTrackerSearch({ page: 0 }); }}
                    className={`px-2 py-1.5 text-[11px] font-medium cursor-pointer transition-colors duration-[120ms] ${
                      filter === item.id && gradeFilter === "all"
                        ? "bg-osu-b3 text-osu-l2"
                        : "bg-osu-b4/50 text-osu-f1 hover:text-osu-l2"
                    }`}
                  >
                    {item.id === "all" ? "All" : item.id === "ranked" ? "PP" : "Pass"}
                  </button>
                ))}
                <button
                  onClick={() => cycleMissFilter(1)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    cycleMissFilter(-1);
                  }}
                  title={missButtonTitle}
                  className={`w-8 py-1.5 text-[11px] font-medium cursor-pointer transition-colors duration-[120ms] ${
                    missFilter === "fc"
                      ? "bg-osu-pink/20 text-osu-pink-light"
                      : missFilter === "fc_choke"
                        ? "bg-osu-yellow/15 text-osu-yellow"
                        : "bg-osu-b4/50 text-osu-f1 hover:text-osu-l2"
                  }`}
                >
                  {mobileMissButtonLabel}
                </button>
              </div>
              <div className="flex flex-1 min-w-0 items-center justify-center gap-1">
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
              <button
                onClick={() => cycleStarSort(1)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  cycleStarSort(-1);
                }}
                title={starSortTitle}
                className={`flex-shrink-0 rounded-lg border border-osu-b3/30 px-2 py-1.5 text-[11px] font-medium cursor-pointer transition-colors duration-[120ms] ${
                  trackerSort === "stars"
                    ? "bg-osu-b3 text-osu-l2"
                    : "bg-osu-b4/50 text-osu-f1 hover:text-osu-l2"
                }`}
              >
                Stars{trackerSort === "stars" ? (trackerSortDirection === "desc" ? " ↓" : " ↑") : ""}
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="relative z-10">
        <div className="max-w-[1200px] mx-auto px-5 py-5 flex flex-col lg:flex-row gap-4 lg:gap-5">
          {activePlayers.length > 0 && (
            <>
              {/* Mobile: horizontal row */}
              <div className="lg:hidden flex items-center gap-3 overflow-x-auto scrollbar-hide py-1">
                <span className="text-[9px] uppercase tracking-wider text-osu-f1 font-semibold flex-shrink-0">Playing</span>
                {activePlayers.map((player) => (
                  <button
                    key={player.id}
                    onClick={() => {
                      if (player.simulated) return;
                      togglePlayerFilter(player.id);
                    }}
                    onContextMenu={(event) => {
                      event.preventDefault();
                    }}
                    aria-pressed={!player.simulated && selectedPlayerIdSet.has(player.id)}
                    className="cursor-pointer group relative flex-shrink-0"
                    title={player.simulated ? `${player.username} - simulated dev traffic` : `${player.username} - click to filter`}
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
              {/* Desktop: vertical sidebar, two columns, edge-faded internal scroll */}
              <div className="hidden lg:flex sticky top-[76px] max-h-[calc(100svh_-_196px)] self-start flex-col flex-shrink-0">
                <div className="flex items-baseline justify-between gap-2 mb-2 px-0.5">
                  <span className="text-[9px] uppercase tracking-wider text-osu-f1 font-semibold">Playing</span>
                  <span className="text-[9px] tabular-nums text-osu-f1/70 font-semibold">{activePlayers.length}</span>
                </div>
                <div
                  ref={activeRailRef}
                  onScroll={updateRailFade}
                  className={`min-h-0 overflow-y-auto overscroll-contain scrollbar-hide ${railMaskClass}`}
                >
                  <div className="grid grid-cols-2 gap-2 place-items-center px-0.5 py-1">
                    {activePlayers.map((player) => (
                      <button
                        key={player.id}
                        onClick={() => {
                          if (player.simulated) return;
                          togglePlayerFilter(player.id);
                        }}
                        onContextMenu={(event) => {
                          event.preventDefault();
                        }}
                        aria-pressed={!player.simulated && selectedPlayerIdSet.has(player.id)}
                        className="cursor-pointer group relative shrink-0"
                        title={player.simulated ? `${player.username} - simulated dev traffic` : `${player.username} - click to filter`}
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
                </div>
              </div>
            </>
          )}
          <div className="flex-1 min-w-0">
            {playersError ? (
              <div className="text-center py-16 text-osu-f1 text-sm">
                {playersError}
              </div>
            ) : loadingPlayers || (!initialLoadedForSelectedCountry && feedScores.length === 0) || showingLivePageSkeletons ? (
              <>
                <div className="space-y-2">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <TrackerRowSkeleton key={i} />
                  ))}
                </div>
                {showingLivePageSkeletons && (
                  <Pagination
                    page={currentPage}
                    totalPages={totalPages}
                    onPageChange={(nextPage) => updateTrackerSearch({ page: nextPage })}
                  />
                )}
              </>
            ) : (
              <>
                <VirtualScoreList
                  listKey={`${listKey}:${currentPage}`}
                  scores={paginatedScores}
                  timeTick={timeTick}
                  expandedKey={expandedKey}
                  onToggle={handleToggleExpand}
                  ppGainByScoreId={ppGainByScoreId}
                  showCountryFlag={selectedIsGlobal}
                />
                <Pagination
                  page={currentPage}
                  totalPages={totalPages}
                  onPageChange={(nextPage) => updateTrackerSearch({ page: nextPage })}
                />
                {filtered.length === 0 && (
                  feedScores.length === 0 && liveBackendEnabled ? (
                    <LiveDataEmptyState country={selectedCountry} kind="scores" />
                  ) : (
                    <div className="text-center py-16 text-osu-f1 text-sm">
                      {feedScores.length === 0
                        ? "No recent scores yet."
                        : "No scores match this filter"}
                    </div>
                  )
                )}
              </>
            )}
          </div>
        </div>
      </div>
      </div>
      )}
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
const ignoreVirtualizerScrollCorrection = () => false;

function VirtualScoreList({
  listKey,
  scores,
  timeTick,
  expandedKey,
  onToggle,
  ppGainByScoreId,
  showCountryFlag,
}: {
  listKey: string;
  scores: LeanTrackerScore[];
  timeTick: number;
  expandedKey: string | null;
  onToggle: (key: string) => void;
  ppGainByScoreId: Record<number, number>;
  showCountryFlag: boolean;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const scrollMargin = parentRef.current?.offsetTop ?? 0;

  const virtualizer = useWindowVirtualizer({
    count: scores.length,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    overscan: 4,
    scrollMargin,
    useAnimationFrameWithResizeObserver: true,
    // Include the 8px gap (space-y-2) in the item's measured size via a
    // wrapper padding, so the virtualizer's offsets stay correct.
    getItemKey: (index) => getScoreIdentity(scores[index]),
  });
  // Score detail expansion is a click-driven resize in visible rows; scroll
  // correction here causes one-frame jumps while the accordion swaps rows.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = ignoreVirtualizerScrollCorrection;

  // Track which score keys we've already shown so only scores that are genuinely
  // new to the feed get the entrance cue. Rows that mount because the user
  // scrolled them into view are already "seen" and stay still. A null seen-set
  // means first paint; a listKey change (filter/page swap) resets it so the
  // whole new slice arrives without animating.
  const seenKeysRef = useRef<Set<string> | null>(null);
  const prevListKeyRef = useRef(listKey);
  const isResetRender = prevListKeyRef.current !== listKey;
  const animatedKeys = useMemo(() => {
    const seen = seenKeysRef.current;
    if (isResetRender || seen === null) return EMPTY_KEY_SET;
    const fresh = new Set<string>();
    for (const score of scores) {
      const key = getScoreIdentity(score);
      if (!seen.has(key)) fresh.add(key);
    }
    return fresh;
  }, [scores, isResetRender]);

  useEffect(() => {
    const seen = isResetRender || seenKeysRef.current === null ? new Set<string>() : seenKeysRef.current;
    for (const score of scores) seen.add(getScoreIdentity(score));
    seenKeysRef.current = seen;
    prevListKeyRef.current = listKey;
  }, [scores, listKey, isResetRender]);

  const items = virtualizer.getVirtualItems();

  return (
    <div
      key={listKey}
      ref={parentRef}
      style={{
        height: `${virtualizer.getTotalSize()}px`,
        position: "relative",
        width: "100%",
        overflowAnchor: "none",
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
              showCountryFlag={showCountryFlag}
              isNew={animatedKeys.has(scoreKey)}
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
  showCountryFlag,
  isNew,
}: {
  score: LeanTrackerScore;
  scoreKey: string;
  timeTick: number;
  approxPpGain: number | null;
  expanded: boolean;
  onToggle: (key: string) => void;
  showCountryFlag: boolean;
  isNew: boolean;
}) {
  const navigate = useNavigate();

  const keymodeLabel = getBeatmapKeymodeLabel(score.beatmap);
  const totalScore = getDisplayedTotalScore(score);
  const beatmapUrl = getBeatmapUrl(score);
  const scoreUrl = getScoreUrl(score);
  const judgementStats = getManiaJudgementStats(score);
  const lazer = isLazerScore(score);
  const accColorClass = lazer ? "text-osu-pink-light" : "text-osu-l2";
  const canReplay = scoreHasReplay(score);
  const showPpGain = approxPpGain != null && approxPpGain >= 0.05;

  return (
    <div className={`rounded-xl bg-osu-b4 border border-osu-b3/20 overflow-hidden${isNew ? " score-enter" : ""}`}>
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
                            <div className="flex items-center gap-2 min-w-0">
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  window.location.href = `/player/${encodeURIComponent(score.user.username)}`;
                                }}
                                className="cursor-pointer min-w-0"
                              >
                                <UsernameText
                                  username={score.user.username}
                                  avatarUrl={score.user?.avatar_url}
                                  className="text-sm font-semibold truncate"
                                />
                              </button>
                              {showCountryFlag && score.user.country_code ? (
                                <CountryFlag code={score.user.country_code} size="sm" />
                              ) : null}
                            </div>
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
            {keymodeLabel && (
              <span className="px-1 py-0.5 rounded text-[8px] font-bold bg-osu-b3/50 text-osu-yellow flex-shrink-0">
                {keymodeLabel}
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
              {showPpGain && (
                <span className="text-[10px] font-semibold text-osu-green">+{formatPpGain(approxPpGain)}</span>
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
            {showPpGain && (
              <span
                className="ml-1 text-[11px] font-semibold text-osu-green"
                title="Estimated pp gain from replacing your previous best score on this map"
              >
                (+{formatPpGain(approxPpGain)})
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
      {expanded && (
        <div
          className="relative overflow-hidden px-4 pb-3 pt-1 border-t border-osu-b3/20 detail-enter"
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
                {judgementStats.map((judgement, i) => (
                  <StatCell key={judgement.label} label={judgement.label} value={formatNumber(judgement.value)} color={judgement.className} className={JUDGEMENT_MOBILE_ORDER_CLASS[i]} />
                ))}
                {score.beatmap?.difficulty_rating != null && (
                  <StatCell label="Stars" value={score.beatmap.difficulty_rating.toFixed(2)} className="max-sm:order-8" />
                )}
                {score.beatmap?.bpm != null && (
                  <StatCell label="BPM" value={String(Math.round(score.beatmap.bpm))} className="max-sm:order-9" />
                )}
                {/* On mobile (2-col) PP gets its own centered full-width row as the headline stat; on sm+ it's a normal trailing cell. */}
                {score.pp != null && score.pp > 0 && (
                  <StatCell label="PP" value={`${Math.round(score.pp)}pp`} color="text-osu-pink" className="col-span-2 max-sm:order-10 sm:col-span-1" />
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

// Judgement cells render in canonical [MAX, 300, 200, 100, 50, Miss] DOM order (kept for
// the desktop 4/6-col rows). On the mobile 2-col grid these max-sm orders swap MAX/300 so
// each row pairs like the osu!mania score screen: 300|MAX, 200|100, 50|Miss.
const JUDGEMENT_MOBILE_ORDER_CLASS = [
  "max-sm:order-3",
  "max-sm:order-2",
  "max-sm:order-4",
  "max-sm:order-5",
  "max-sm:order-6",
  "max-sm:order-7",
];

function StatCell({ label, value, color, className }: { label: string; value: string; color?: string; className?: string }) {
  return (
    <div className={`py-1.5${className ? ` ${className}` : ""}`}>
      <div className="text-[9px] uppercase tracking-wider text-osu-f1 font-semibold">{label}</div>
      <div className={`text-sm font-bold ${color ?? "text-white"}`}>{value}</div>
    </div>
  );
}
