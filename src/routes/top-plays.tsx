import { createFileRoute, stripSearchParams, useLocation, useNavigate } from "@tanstack/react-router";
import { useState, useEffect, useCallback, useMemo, useRef, type ReactNode } from "react";
import { motion } from "framer-motion";
import { Trans, useLingui } from "@lingui/react/macro";
import { msg } from "@lingui/core/macro";
import { getI18n } from "../lib/i18n";
import { CLIENT_CACHE_TTL } from "../lib/cache";
import { displayCountryName, isGlobalScope } from "../lib/country";
import { useLocale } from "../lib/locale-context";
import { isRegionScope } from "../lib/regions";
import { formatNumber, formatAccuracy, formatTimeAgo, formatTimeAgoTooltip, formatPpGain } from "../lib/format";
import { getBeatmapUrl, getBeatmapKeymodeLabel, getDisplayedAccuracy, getDisplayedRank, getDisplayedTotalScore, getModDisplayList, getScoreUrl, isLazerScore, scoreHasReplay } from "../lib/score";
import { PageHeader } from "../components/layout/PageHeader";
import { OsuTriangleBackdrop } from "../components/layout/OsuTriangleBackdrop";
import { PageTabs } from "../components/layout/PageTabs";
import { Avatar } from "../components/ui/Avatar";
import { CountryFlag } from "../components/ui/CountryFlag";
import { GradeImg } from "../components/ui/GradeImg";
import { ModBadge } from "../components/ui/ModBadge";
import { DanBadge } from "../components/ui/DanBadge";
import { StarRatingBadge } from "../components/ui/StarRating";
import { CoverBackdrop } from "../components/ui/CoverBackdrop";
import { Skeleton } from "../components/ui/LoadingSkeleton";
import { getManiaJudgementStats } from "../components/ui/ManiaJudgementStats";
import { UsernameText } from "../components/ui/UsernameText";
import { Pagination } from "../components/ui/Pagination";
import { PpGainsRail } from "../components/top-plays/PpGainsRail";
import type { CountryTopPlay } from "../lib/types";
import { useAppStore, useHiddenUserIds, useSelectedCountry, type CachedPopoff, type TopPlaysRange } from "../store";
import { parseCountrySearchParam, withSearchParams } from "../lib/country-search";
import { countryTopPlaysTitle, pageSeo } from "../lib/seo";
import { hasTopPlaysCache, shouldRefreshTopPlays } from "../lib/top-plays-cache";
import { showPlayerCountryFlagState } from "../lib/player-profile-navigation";
import { getReplaySearch } from "../lib/replay-navigation";
import { fetchLiveTopPlaysSnapshot, isLiveBackendConfigured, openLiveEventSource, type LiveTopPlaysPpGain } from "../lib/live-backend";
import { CountryWarming } from "../components/CountryWarming";
import { LiveBackendRequired, LiveDataEmptyState } from "../components/LiveDataEmptyState";
import { useCountryWarming } from "../lib/use-country-warming";
import { useWindowActive } from "../lib/window-activity";

type PopOff = CountryTopPlay;

type TimeRange = TopPlaysRange;
type SortMode = "recent" | "pp" | "gain";
type SortDirection = "desc" | "asc";
type KeyFilter = "all" | "4k" | "other";

const RANGE_WIDTH: Record<TimeRange, number> = {
  "24h": 0,
  "3d": 1,
  "7d": 2,
  "30d": 3,
};

function widerWindow(a: TimeRange | null, b: TimeRange): TimeRange {
  if (!a) return b;
  return RANGE_WIDTH[a] >= RANGE_WIDTH[b] ? a : b;
}

type TopPlaysSearch = {
  range: TimeRange;
  country: string | undefined;
  sort: SortMode;
  dir: SortDirection;
  keys: KeyFilter;
};

const RANGE_MS: Record<TimeRange, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "3d": 3 * 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

const PAGE_SIZE = 15;
const DEFAULT_TOP_PLAYS_SEARCH: TopPlaysSearch = {
  range: "7d",
  country: undefined,
  sort: "recent",
  dir: "desc",
  keys: "all",
};

function hasPopoffsInRange(popoffs: PopOff[], range: TimeRange): boolean {
  const now = Date.now();
  return popoffs.some((popoff) => now - new Date(popoff.time).getTime() < RANGE_MS[range]);
}

export const Route = createFileRoute("/top-plays")({
  head: ({ match }) => {
    const country = match.search.country;
    const countryName = country ? displayCountryName(country, match.context.locale) : null;
    const i18n = getI18n(match.context.locale);
    return pageSeo({
      title: countryName ? i18n._(msg`Top mania plays in ${countryName}`) : i18n._(msg`Top osu!mania plays`),
      description: countryName
        ? i18n._(msg`Recent top osu!mania plays and pp records in ${countryName}.`)
        : i18n._(msg`Recent top osu!mania plays and pp records by country.`),
      path: withSearchParams("/top-plays", { country }),
      origin: match.context.origin,
      imageCountry: country,
      imageTitle: countryName ? countryTopPlaysTitle(countryName) : "Top osu!mania plays",
    });
  },
  search: {
    middlewares: [stripSearchParams(DEFAULT_TOP_PLAYS_SEARCH)],
  },
  validateSearch: (search: Record<string, unknown>): TopPlaysSearch => ({
    range:
      search.range === "24h" ||
      search.range === "3d" ||
      search.range === "7d" ||
      search.range === "30d"
        ? search.range
        : DEFAULT_TOP_PLAYS_SEARCH.range,
    country: parseCountrySearchParam(search.country),
    sort:
      search.sort === "recent" || search.sort === "pp" || search.sort === "gain"
        ? search.sort
        : DEFAULT_TOP_PLAYS_SEARCH.sort,
    dir: search.dir === "asc" || search.dir === "desc" ? search.dir : DEFAULT_TOP_PLAYS_SEARCH.dir,
    keys:
      search.keys === "all" || search.keys === "4k" || search.keys === "other"
        ? search.keys
        : DEFAULT_TOP_PLAYS_SEARCH.keys,
  }),
  component: PopOffsPage,
});

const EMPTY_POPOFFS: CachedPopoff[] = [];
const EMPTY_POPOFF_KEY_SET: ReadonlySet<string> = new Set<string>();

function getPopoffKey(popoff: PopOff): string {
  return `${popoff.user.id}-${popoff.score.id}`;
}

// The expanded panel's cover backdrop is the only place a row loads its cover,
// so the image download used to start on click and the backdrop faded in late.
// Warming it on hover has it cached by the time the row expands.
const preloadedCoverUrls = new Set<string>();
function preloadPopoffCover(popoff: PopOff): void {
  const url = popoff.score.beatmapset?.covers?.["cover@2x"] || popoff.score.beatmapset?.covers?.cover;
  if (!url || preloadedCoverUrls.has(url)) return;
  preloadedCoverUrls.add(url);
  new Image().src = url;
}

function PopOffsPage() {
  const { t } = useLingui();
  const { range, country, sort, dir, keys } = Route.useSearch();
  const location = useLocation();
  const navigate = useNavigate();
  const fallbackCountry = useSelectedCountry();
  const selectedCountry = country ?? fallbackCountry;
  const currentCountryRef = useRef(selectedCountry);
  currentCountryRef.current = selectedCountry;
  const popoffs = useAppStore((state) => state.popoffsByCountry[selectedCountry]) ?? EMPTY_POPOFFS;
  const popoffsFetchedAt = useAppStore((state) => state.popoffsFetchedAtByCountry[selectedCountry]) ?? null;
  const popoffsWindow = useAppStore((state) => state.popoffsWindowByCountry[selectedCountry] ?? null);
  const rememberedRange = useAppStore((state) => state.topPlaysRangeByCountry[selectedCountry] ?? DEFAULT_TOP_PLAYS_SEARCH.range);
  const setCachedPopoffs = useAppStore((state) => state.setPopoffs);
  const setTopPlaysRange = useAppStore((state) => state.setTopPlaysRange);
  const hiddenUserIds = useHiddenUserIds();
  const hasCachedPopoffs = hasTopPlaysCache(popoffsFetchedAt, popoffsWindow);
  const [loading, setLoading] = useState(!hasCachedPopoffs);
  const [refreshing, setRefreshing] = useState(false);
  const [page, setPage] = useState(0);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [selectedPlayerIds, setSelectedPlayerIds] = useState<number[]>([]);
  const [livePagePopoffs, setLivePagePopoffs] = useState<PopOff[]>([]);
  const [liveTotal, setLiveTotal] = useState(0);
  const [livePpGains, setLivePpGains] = useState<LiveTopPlaysPpGain[]>([]);
  const [settledLiveSnapshotKey, setSettledLiveSnapshotKey] = useState<string | null>(null);
  const hasRestoredRememberedRangeRef = useRef(false);
  const currentLiveSnapshotKeyRef = useRef<string | null>(null);
  const seenPopoffKeysRef = useRef<Set<string> | null>(null);
  const prevPopoffListKeyRef = useRef<string | null>(null);
  const locale = useLocale();
  const countryName = displayCountryName(selectedCountry, locale);
  const selectedIsGlobal = isGlobalScope(selectedCountry);
  // Multi-country scopes (Global, regions) show each row's country flag.
  const selectedIsMultiCountry = selectedIsGlobal || isRegionScope(selectedCountry);
  const liveBackendEnabled = isLiveBackendConfigured();
  const windowActive = useWindowActive();
  const { warming } = useCountryWarming(selectedCountry);
  const wasWindowActiveRef = useRef(windowActive);

  const refocusRefreshRef = useRef(false);

  // Refocus catch-up: force the next snapshot fetch without clearing
  // currentLiveSnapshotKeyRef - nulling it made the UI read the refetch as a
  // page change and wipe the visible list to skeletons ("Loading page...")
  // every time the window regained focus. With the key intact the refetch runs
  // as a background "Refreshing..." over the list that's already on screen.
  useEffect(() => {
    if (!wasWindowActiveRef.current && windowActive) {
      refocusRefreshRef.current = true;
    }
    wasWindowActiveRef.current = windowActive;
  }, [windowActive]);

  useEffect(() => {
    setLoading(!hasCachedPopoffs);
    setRefreshing(false);
    setPage(0);
    setExpandedId(null);
    setSelectedPlayerIds([]);
    setLivePagePopoffs([]);
    setLiveTotal(0);
    setLivePpGains([]);
    setSettledLiveSnapshotKey(null);
    currentLiveSnapshotKeyRef.current = null;
    seenPopoffKeysRef.current = null;
    prevPopoffListKeyRef.current = null;
    hasRestoredRememberedRangeRef.current = false;
  }, [selectedCountry]);

  useEffect(() => {
    if (hasRestoredRememberedRangeRef.current) return;

    hasRestoredRememberedRangeRef.current = true;
    const hasExplicitRange = new URLSearchParams(location.searchStr).has("range");
    if (hasExplicitRange || rememberedRange === range) return;

    navigate({
      to: "/top-plays",
      search: { range: rememberedRange, country, sort, dir, keys },
      replace: true,
      resetScroll: false,
    });
  }, [country, location.searchStr, navigate, range, rememberedRange, sort, dir, keys]);

  useEffect(() => {
    if (rememberedRange === range) return;
    setTopPlaysRange(selectedCountry, range);
  }, [range, rememberedRange, selectedCountry, setTopPlaysRange]);

  const mergePopoffs = useCallback((entries: PopOff[]): PopOff[] => {
    const byKey = new Map<string, PopOff>();

    entries.forEach((entry) => {
      byKey.set(`${entry.user.id}-${entry.score.id}`, entry);
    });

    return [...byKey.values()].sort((a, b) => {
      if (b.pp !== a.pp) return b.pp - a.pp;
      return new Date(b.time).getTime() - new Date(a.time).getTime();
    });
  }, []);

  useEffect(() => {
    if (!liveBackendEnabled || !windowActive) return;
    const selectedPlayersKey = selectedPlayerIds.join(",");
    const snapshotKey = `${selectedCountry}:${range}:${sort}:${dir}:${keys}:${page}:${selectedPlayersKey}`;
    const cacheNeedsRefresh = shouldRefreshTopPlays({
      fetchedAt: popoffsFetchedAt,
      cachedWindow: popoffsWindow,
      selectedRange: range,
      cacheTtlMs: CLIENT_CACHE_TTL.popoffs,
    });
    if (!cacheNeedsRefresh && !refocusRefreshRef.current && currentLiveSnapshotKeyRef.current === snapshotKey) {
      setLoading(false);
      setRefreshing(false);
      return;
    }
    refocusRefreshRef.current = false;

    let cancelled = false;
    const requestedCountry = selectedCountry;
    const currentPopoffs = useAppStore.getState().popoffsByCountry[requestedCountry] ?? [];
    const hasVisibleCache = livePagePopoffs.length > 0 || hasPopoffsInRange(currentPopoffs, range);
    setSettledLiveSnapshotKey(null);
    setLoading(!hasVisibleCache);
    setRefreshing(hasVisibleCache);

    fetchLiveTopPlaysSnapshot(requestedCountry, range, {
      sort,
      dir,
      keys,
      page: page + 1,
      pageSize: PAGE_SIZE,
      includePpGains: true,
      userIds: selectedPlayerIds,
    })
      .then((snapshot) => {
        if (cancelled || currentCountryRef.current !== requestedCountry) return;
        currentLiveSnapshotKeyRef.current = snapshotKey;
        setLivePagePopoffs(snapshot.popoffs);
        setLiveTotal(snapshot.total ?? snapshot.popoffs.length);
        setLivePpGains(snapshot.ppGains ?? []);
        const cachedPopoffs = useAppStore.getState().popoffsByCountry[requestedCountry] ?? [];
        const cachedWindow = useAppStore.getState().popoffsWindowByCountry[requestedCountry] ?? null;
        setCachedPopoffs(
          requestedCountry,
          mergePopoffs([...cachedPopoffs, ...snapshot.popoffs]),
          widerWindow(cachedWindow, snapshot.window),
        );
        setLoading(false);
        setRefreshing(false);
      })
      .catch(() => {
        if (cancelled || currentCountryRef.current !== requestedCountry) return;
        setSettledLiveSnapshotKey(snapshotKey);
        setLoading(false);
        setRefreshing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [dir, keys, liveBackendEnabled, livePagePopoffs.length, mergePopoffs, page, popoffsFetchedAt, popoffsWindow, range, selectedCountry, selectedPlayerIds, setCachedPopoffs, sort, windowActive]);

  // Stays connected while unfocused so new top plays still appear on a second
  // monitor during play (same rationale as the tracker feed). top_play is
  // low-frequency, so this is cheap; snapshot fetches and timers stay gated.
  useEffect(() => {
    if (!liveBackendEnabled) return;
    const source = openLiveEventSource(selectedCountry);
    if (!source) return;
    source.addEventListener("top_play", (event) => {
      const popoff = JSON.parse(event.data) as PopOff;
      setCachedPopoffs(selectedCountry, mergePopoffs([popoff, ...popoffs]), popoffsWindow ?? range);
    });
    source.addEventListener("job_status", () => {
      setRefreshing(false);
    });
    return () => source.close();
  }, [liveBackendEnabled, mergePopoffs, popoffs, popoffsWindow, range, selectedCountry, setCachedPopoffs]);

  const togglePlayerFilter = useCallback((playerId: number) => {
    setSelectedPlayerIds((current) =>
      current.includes(playerId)
        ? current.filter((id) => id !== playerId)
        : [...current, playerId]
    );
    setPage(0);
  }, []);

  const clearPlayerFilter = useCallback(() => {
    setSelectedPlayerIds([]);
    setPage(0);
  }, []);

  // The backend snapshot already applies range/sort/key/player filters; only
  // hidden users are stripped client-side.
  const rangedPopoffs = useMemo(
    () => livePagePopoffs.filter((popoff) => !hiddenUserIds.has(popoff.user.id)),
    [hiddenUserIds, livePagePopoffs],
  );
  const filtered = rangedPopoffs;

  const selectedPlayersKey = selectedPlayerIds.join(",");
  const liveSnapshotKey = `${selectedCountry}:${range}:${sort}:${dir}:${keys}:${page}:${selectedPlayersKey}`;
  const liveSnapshotNeeded =
    shouldRefreshTopPlays({
      fetchedAt: popoffsFetchedAt,
      cachedWindow: popoffsWindow,
      selectedRange: range,
      cacheTtlMs: CLIENT_CACHE_TTL.popoffs,
    }) || currentLiveSnapshotKeyRef.current !== liveSnapshotKey;
  const waitingForLiveSnapshot =
    liveBackendEnabled &&
    settledLiveSnapshotKey !== liveSnapshotKey &&
    liveSnapshotNeeded;
  const waitingForLivePageSnapshot =
    liveBackendEnabled &&
    settledLiveSnapshotKey !== liveSnapshotKey &&
    currentLiveSnapshotKeyRef.current !== liveSnapshotKey;
  const showingInitialLiveSnapshot = waitingForLiveSnapshot && filtered.length === 0;
  const showingLivePageTransition = waitingForLivePageSnapshot && filtered.length > 0;

  const playerPpGains = useMemo(() => {
    if (livePpGains.length > 0) {
      return livePpGains
        .filter((player) => !hiddenUserIds.has(player.id) && player.totalGain >= 0.05)
        .sort((a, b) => b.totalGain - a.totalGain);
    }

    const byUser = new Map<number, { username: string; avatar_url: string; totalGain: number }>();
    for (const p of rangedPopoffs) {
      if (!p.ppGain) continue;
      const existing = byUser.get(p.user.id);
      if (existing) {
        existing.totalGain += p.ppGain;
      } else {
        byUser.set(p.user.id, {
          username: p.user.username,
          avatar_url: p.user.avatar_url,
          totalGain: p.ppGain,
        });
      }
    }
    const ranked = [...byUser.entries()]
      .filter(([, info]) => info.totalGain >= 0.05)
      .sort((a, b) => b[1].totalGain - a[1].totalGain)
      .map(([id, info]) => ({ id, ...info }));
    return ranked;
  }, [hiddenUserIds, livePpGains, rangedPopoffs]);

  const showPpGainsRail = playerPpGains.length > 0;

  // The backend snapshot is already the requested page.
  const totalCount = liveTotal;
  const totalPages = Math.ceil(totalCount / PAGE_SIZE);
  const paginated = filtered;
  const popoffListKey = liveSnapshotKey;
  const isPopoffListResetRender = prevPopoffListKeyRef.current !== popoffListKey;
  const animatedPopoffKeys = useMemo(() => {
    const seen = seenPopoffKeysRef.current;
    if (showingInitialLiveSnapshot || showingLivePageTransition || isPopoffListResetRender || seen === null) {
      return EMPTY_POPOFF_KEY_SET;
    }
    const fresh = new Set<string>();
    for (const popoff of paginated) {
      const key = getPopoffKey(popoff);
      if (!seen.has(key)) fresh.add(key);
    }
    return fresh;
  }, [isPopoffListResetRender, paginated, showingInitialLiveSnapshot, showingLivePageTransition]);
  useEffect(() => {
    if (showingInitialLiveSnapshot || showingLivePageTransition) return;
    const seen = isPopoffListResetRender || seenPopoffKeysRef.current === null ? new Set<string>() : seenPopoffKeysRef.current;
    for (const popoff of paginated) seen.add(getPopoffKey(popoff));
    seenPopoffKeysRef.current = seen;
    prevPopoffListKeyRef.current = popoffListKey;
  }, [isPopoffListResetRender, paginated, popoffListKey, showingInitialLiveSnapshot, showingLivePageTransition]);
  const loadingLabel = hasCachedPopoffs ? t`Refreshing...` : t`Loading top plays...`;
  const scanProgressLabel = showingLivePageTransition ? t`Loading page...` : loadingLabel;
  const showTopPlaysSkeletons =
    showingInitialLiveSnapshot || showingLivePageTransition || (loading && paginated.length === 0);

  const ranges: { id: TimeRange; label: string }[] = [
    { id: "24h", label: t`24 hours` },
    { id: "3d", label: t`3 days` },
    { id: "7d", label: t`7 days` },
    { id: "30d", label: t`30 days` },
  ];
  const keymodes: { id: KeyFilter; label: string }[] = [
    { id: "all", label: t`Any` },
    { id: "4k", label: "4K" },
    { id: "other", label: "≠4K" },
  ];

  if (!liveBackendEnabled) {
    return (
      <div className="flex-1">
        <PageHeader iconSrc="/images/icons/rankings.svg" title={t`${countryName} mania top plays`} />
        <LiveBackendRequired />
      </div>
    );
  }

  return (
    <div className="flex-1">
      <PageHeader
        iconSrc="/images/icons/rankings.svg"
        title={t`${countryName} mania top plays`}
        right={
          <div className="flex items-center gap-2">
            {(refreshing || showingInitialLiveSnapshot || showingLivePageTransition) && (
              <div className="flex items-center gap-1.5">
                <div className="w-3 h-3 border-2 border-osu-pink/40 border-t-osu-pink rounded-full animate-spin" />
                <span className="text-[10px] text-osu-f1 tabular-nums">
                  {scanProgressLabel}
                </span>
              </div>
            )}
            {!refreshing && !loading && !showingInitialLiveSnapshot && !showingLivePageTransition && (
              <span className="text-[10px] text-osu-f1">
                <Trans>{totalCount} top plays found</Trans>
              </span>
            )}
          </div>
        }
      />

      {warming && <CountryWarming country={selectedCountry} />}

      {!warming && (
      <div className="relative overflow-hidden bg-osu-b5">
      <OsuTriangleBackdrop />
      <div className="relative z-10">
        <PageTabs
          items={ranges}
          value={range}
          onChange={(nextRange) => {
            setTopPlaysRange(selectedCountry, nextRange);
            navigate({
              to: "/top-plays",
              search: { range: nextRange, country, sort, dir, keys },
              replace: true,
              resetScroll: false,
            });
            setPage(0);
          }}
        />
      </div>

      <div className="relative z-10 bg-osu-d5/90 border-b border-osu-b3/20 backdrop-blur-[1px]">
        <div className="max-w-[1200px] mx-auto px-5 py-2 flex items-center justify-between gap-2">
          <div className="min-h-7 flex items-center">
            {selectedPlayerIds.length > 0 && (
              <button
                onClick={clearPlayerFilter}
                className="px-2.5 py-1 rounded-lg bg-osu-pink/15 text-[11px] font-medium text-osu-pink-light hover:bg-osu-pink/25 transition-colors cursor-pointer"
              >
                <Trans>Clear player filter</Trans>
              </button>
            )}
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <div className="flex rounded-lg overflow-hidden border border-osu-b3/30">
              {keymodes.map((item) => (
                <button
                  key={item.id}
                  onClick={() => {
                    navigate({
                      to: "/top-plays",
                      search: { range, country, sort, dir, keys: item.id },
                      replace: true,
                      resetScroll: false,
                    });
                    setPage(0);
                  }}
                  title={item.id === "other" ? t`Show non-4K plays` : t`Filter by keymode`}
                  className={`px-2.5 py-1.5 text-[11px] font-medium cursor-pointer transition-colors duration-[120ms] tabular-nums ${
                    keys === item.id
                      ? "bg-osu-b3 text-osu-l2"
                      : "bg-osu-b4/50 text-osu-f1 hover:text-osu-l2"
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>
            {([
              ["recent", t`Recent`],
              ["pp", "PP"],
              ["gain", t`PP Gain`],
            ] as [SortMode, string][]).map(([id, label]) => (
              <SortPill
                key={id}
                active={sort === id}
                dir={dir}
                onClick={() => {
                  const nextDir: SortDirection = sort === id ? (dir === "desc" ? "asc" : "desc") : "desc";
                  navigate({
                    to: "/top-plays",
                    search: { range, country, sort: id, dir: nextDir, keys },
                    replace: true,
                    resetScroll: false,
                  });
                  setPage(0);
                }}
              >
                {label}
              </SortPill>
            ))}
          </div>
        </div>
      </div>

      <div className="relative z-10">
        <div className="max-w-[1200px] mx-auto px-5 py-6 flex flex-col lg:flex-row gap-4 lg:gap-5">
          {showPpGainsRail && (
            <PpGainsRail
              players={playerPpGains}
              selectedPlayerIds={selectedPlayerIds}
              onTogglePlayer={togglePlayerFilter}
            />
          )}
          <div className="flex-1 min-w-0">
          {/* Loading skeletons on initial load */}
          {showTopPlaysSkeletons && (
            <div className="space-y-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="rounded-xl bg-osu-b4 border border-osu-b3/20 overflow-hidden">
                  <div className="flex items-center gap-2 sm:gap-3 py-3 px-3 sm:px-4">
                    <div className="flex-shrink-0 w-12 sm:w-16 flex flex-col items-center gap-1">
                      <Skeleton className="h-5 w-9" />
                      <Skeleton className="h-2 w-5" />
                      <Skeleton className="h-2.5 w-7" />
                    </div>
                    <Skeleton className="w-[30px] h-[30px] rounded" />
                    <Skeleton className="w-9 h-9 rounded-full" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <Skeleton className="h-4 w-24" />
                        <Skeleton className="h-3 w-10 sm:hidden" />
                      </div>
                      <div className="flex items-center gap-2 mt-1">
                        <Skeleton className="h-3 w-36 sm:w-56 max-w-full" />
                        <Skeleton className="h-3 w-12 hidden sm:block" />
                      </div>
                      <div className="flex items-center justify-between gap-2 mt-1.5 sm:hidden">
                        <div className="flex items-center gap-1">
                          <Skeleton className="h-4 w-6 rounded" />
                          <Skeleton className="h-4 w-6 rounded" />
                        </div>
                        <div className="flex items-center gap-2">
                          <Skeleton className="h-3 w-12" />
                          <Skeleton className="h-5 w-6 rounded" />
                        </div>
                      </div>
                    </div>
                    <div className="hidden sm:flex items-center gap-3 flex-shrink-0">
                      <div className="flex gap-0.5">
                        <Skeleton className="h-4 w-6 rounded" />
                        <Skeleton className="h-4 w-6 rounded" />
                      </div>
                      <Skeleton className="h-3 w-12" />
                      <Skeleton className="h-3 w-10" />
                      <Skeleton className="h-5 w-16 rounded" />
                      <Skeleton className="h-3 w-10" />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Results */}
          {paginated.length > 0 && !showingInitialLiveSnapshot && !showingLivePageTransition && (
            <div className="space-y-2">
              {paginated.map((p: PopOff) => {
                  const lazer = isLazerScore(p.score);
                  const accColorClass = lazer ? "text-osu-pink-light" : "text-osu-l2";
                  const judgementStats = getManiaJudgementStats(p.score);
                  const keymodeLabel = getBeatmapKeymodeLabel(p.score.beatmap);
                  const popoffKey = getPopoffKey(p);
                  const shouldAnimate = animatedPopoffKeys.has(popoffKey);
                  return (
                  <motion.div
                    key={popoffKey}
                    initial={shouldAnimate ? { opacity: 0, y: -10 } : false}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.15 }}
                    className="rounded-xl bg-osu-b4 border border-osu-b3/20 overflow-hidden"
                  >
                    <div
                      className="flex items-center gap-2 sm:gap-3 py-3 px-3 sm:px-4 hover:bg-osu-b3 transition-colors duration-[120ms] cursor-pointer"
                      onClick={() => setExpandedId(expandedId === p.score.id ? null : p.score.id)}
                      onPointerEnter={() => preloadPopoffCover(p)}
                    >
                      <div className="flex-shrink-0 w-12 sm:w-16 text-center">
                        <div className="text-base sm:text-lg font-bold text-osu-pink" style={{ fontFamily: "Torus" }}>
                          {Math.round(p.pp)}
                        </div>
                        <div className="text-[8px] uppercase tracking-wider text-osu-f1 font-semibold">pp</div>
                        {p.ppGain >= 0.05 && (
                          <div
                            className="text-[10px] font-semibold text-osu-green"
                            title={t`Estimated pp gain from replacing your previous best score on this map`}
                          >
                            +{formatPpGain(p.ppGain)}
                          </div>
                        )}
                      </div>

                      <GradeImg grade={getDisplayedRank(p.score)} size={30} />
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          navigate({
                            to: "/player/$username",
                            params: { username: p.user.username },
                            ...(selectedIsMultiCountry ? { state: showPlayerCountryFlagState } : {}),
                          });
                        }}
                        className="cursor-pointer"
                        title={t`Open ${p.user.username}'s profile`}
                      >
                        <Avatar url={p.user.avatar_url} size={36} />
                      </button>

                      <div className="flex-1 min-w-0">
                        {/* Row 1: Username + time (mobile) */}
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2 min-w-0">
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                navigate({
                                  to: "/player/$username",
                                  params: { username: p.user.username },
                                  ...(selectedIsMultiCountry ? { state: showPlayerCountryFlagState } : {}),
                                });
                              }}
                              className="cursor-pointer min-w-0"
                            >
                              <UsernameText
                                username={p.user.username}
                                avatarUrl={p.user.avatar_url}
                                className="text-sm font-semibold truncate"
                              />
                            </button>
                            {selectedIsMultiCountry && p.user.country_code ? (
                              <CountryFlag code={p.user.country_code} size="sm" />
                            ) : null}
                          </div>
                          <span className="text-[11px] text-osu-f1 flex-shrink-0 sm:hidden" title={formatTimeAgoTooltip(p.time, locale)}>{formatTimeAgo(p.time, locale)}</span>
                        </div>
                        {/* Row 2: Beatmap title */}
                        <div className="flex items-center gap-2 mt-0.5">
                          {getBeatmapUrl(p.score) ? (
                            <a
                              href={getBeatmapUrl(p.score)!}
                              target="_blank"
                              rel="noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              className="text-xs text-osu-l2 truncate hover:text-osu-pink-light underline-offset-2 hover:underline"
                              title={t`Open beatmap on osu!`}
                            >
                              {p.score.beatmapset?.title}
                            </a>
                          ) : (
                            <span className="text-xs text-osu-l2 truncate">
                              {p.score.beatmapset?.title}
                            </span>
                          )}
                          <span className="text-[11px] text-osu-f1 truncate">
                            [{p.score.beatmap?.version}]
                          </span>
                          {keymodeLabel && (
                            <span className="px-1 py-0.5 rounded text-[8px] font-bold bg-osu-b3/50 text-osu-yellow flex-shrink-0">
                              {keymodeLabel}
                            </span>
                          )}
                          <span className="hidden sm:inline flex-shrink-0"><DanBadge score={p.score} /></span>
                        </div>
                        {/* Row 3 (mobile): Mods left, accuracy right */}
                        <div className="flex items-center justify-between gap-2 mt-1 sm:hidden">
                          <div className="flex items-center gap-1">
                            {getModDisplayList(p.score.mods).map((m) => (
                              <ModBadge key={m.acronym} mod={m.acronym} rate={m.rate} />
                            ))}
                            <DanBadge score={p.score} />
                          </div>
                          <div className="flex items-center gap-2 flex-shrink-0">
                            <span className={`text-xs ${accColorClass}`}>{formatAccuracy(getDisplayedAccuracy(p.score))}</span>
                            {scoreHasReplay(p.score) && (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  navigate({ to: "/replay", search: getReplaySearch(p.score.id, p.score.beatmapset?.id) });
                                }}
                                className="px-1.5 py-0.5 rounded bg-osu-pink/20 text-[10px] text-osu-pink-light font-semibold hover:bg-osu-pink/30 transition-colors cursor-pointer"
                                title={t`Watch replay`}
                                aria-label={t`Watch replay`}
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
                          {getModDisplayList(p.score.mods).map((m) => (
                            <ModBadge key={m.acronym} mod={m.acronym} rate={m.rate} />
                          ))}
                        </div>
                        <span className={`text-xs ${accColorClass}`}>
                          {formatAccuracy(getDisplayedAccuracy(p.score))}
                        </span>
                        <span className="text-xs text-osu-f1">
                          {formatNumber(p.score.max_combo)}x
                        </span>
                        {scoreHasReplay(p.score) && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              navigate({ to: "/replay", search: getReplaySearch(p.score.id, p.score.beatmapset?.id) });
                            }}
                            className="px-2 py-1 rounded bg-osu-pink/20 text-[10px] text-osu-pink-light font-semibold hover:bg-osu-pink/30 transition-colors cursor-pointer"
                          >
                            <Trans>▶ Watch</Trans>
                          </button>
                        )}
                        <span className="text-[11px] text-osu-f1 w-16 text-right" title={formatTimeAgoTooltip(p.time, locale)}>
                          {formatTimeAgo(p.time, locale)}
                        </span>
                      </div>
                    </div>

                    <ExpandableDetail expanded={expandedId === p.score.id}>
                      <div className="relative px-4 pb-3 pt-1 border-t border-osu-b3/20 overflow-hidden">
                            {(p.score.beatmapset?.covers?.["cover@2x"] || p.score.beatmapset?.covers?.cover) && (
                              <CoverBackdrop url={p.score.beatmapset.covers["cover@2x"] || p.score.beatmapset.covers.cover} />
                            )}
                            <div className="relative grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3 text-center">
                              <StatCell label={t`Score`} value={getDisplayedTotalScore(p.score) != null ? formatNumber(getDisplayedTotalScore(p.score)!) : "-"} />
                              <StatCell label={t`Combo`} value={`${formatNumber(p.score.max_combo)}x`} />
                              {judgementStats.map((judgement, i) => (
                                <StatCell key={judgement.label} label={judgement.label} value={formatNumber(judgement.value)} color={judgement.className} className={JUDGEMENT_MOBILE_ORDER_CLASS[i]} />
                              ))}
                              {p.score.beatmap?.difficulty_rating != null && (
                                <StatCell
                                  label={t`Stars`}
                                  value={<StarRatingBadge stars={p.score.beatmap.difficulty_rating} size={1.2} />}
                                  className="max-sm:order-8"
                                />
                              )}
                              {p.score.beatmap?.bpm != null && (
                                <StatCell label="BPM" value={String(Math.round(p.score.beatmap.bpm))} className="max-sm:order-9" />
                              )}
                              {/* On mobile (2-col) PP gets its own centered full-width row as the headline stat; on sm+ it's a normal trailing cell. */}
                              <StatCell label="PP" value={`${Math.round(p.pp)}pp`} color="text-osu-pink" className="col-span-2 max-sm:order-10 sm:col-span-1" />
                            </div>
                            <div className="relative mt-2 flex items-center justify-between gap-2">
                              <span className="text-[10px] text-osu-f1">
                                <Trans>Played on: <span className={lazer ? "text-osu-pink-light" : "text-osu-l2"}>{lazer ? "Lazer" : "Stable"}</span></Trans>
                              </span>
                              {getScoreUrl(p.score) ? (
                                <a
                                  href={getScoreUrl(p.score)!}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="text-[10px] text-osu-f1 hover:text-osu-pink-light underline-offset-2 hover:underline transition-colors"
                                >
                                  <Trans>View on osu! →</Trans>
                                </a>
                              ) : <span />}
                            </div>
                      </div>
                    </ExpandableDetail>
                  </motion.div>
                  );
                })}
            </div>
          )}

          {!loading && !showingInitialLiveSnapshot && !showingLivePageTransition && filtered.length === 0 && (
            <LiveDataEmptyState country={selectedCountry} kind="top-plays" />
          )}

          {/* Pagination */}
          <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />

          </div>
        </div>
      </div>
      </div>
      )}
    </div>
  );
}

function SortPill({
  active,
  dir,
  onClick,
  children,
}: {
  active: boolean;
  dir: SortDirection;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const { t } = useLingui();
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 rounded-lg text-[11px] font-medium transition-colors cursor-pointer inline-flex items-center gap-1 ${
        active
          ? "bg-osu-pink/15 text-osu-pink-light"
          : "bg-osu-b4 text-osu-f1 hover:text-osu-l2 hover:bg-osu-b3"
      }`}
      aria-pressed={active}
      title={active ? (dir === "desc" ? t`Click to sort ascending` : t`Click to sort descending`) : undefined}
    >
      <span>{children}</span>
      {active && (
        <span aria-hidden className="text-[10px] leading-none opacity-90">
          {dir === "desc" ? "↓" : "↑"}
        </span>
      )}
    </button>
  );
}

function ExpandableDetail({ expanded, children }: { expanded: boolean; children: React.ReactNode }) {
  if (!expanded) return null;
  return (
    <div className="detail-enter">
      {children}
    </div>
  );
}

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

function StatCell({ label, value, color, className }: { label: string; value: ReactNode; color?: string; className?: string }) {
  return (
    <div className={`py-1.5${className ? ` ${className}` : ""}`}>
      <div className="text-[9px] uppercase tracking-wider text-osu-f1 font-semibold">{label}</div>
      <div className={`text-sm font-bold ${color ?? "text-white"}`}>{value}</div>
    </div>
  );
}
