import { createFileRoute, stripSearchParams, useLocation, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCountrySnipes, getPartialSnipeEvents, getSnipesScanStatus } from "../lib/osu";
import { CLIENT_CACHE_TTL, isCacheStale } from "../lib/cache";
import { getCountryName } from "../lib/country";
import { formatAccuracy, formatNumber, formatPP, formatTimeAgo } from "../lib/format";
import { PageHeader } from "../components/layout/PageHeader";
import { Avatar } from "../components/ui/Avatar";
import { GradeImg } from "../components/ui/GradeImg";
import { LazerBadge } from "../components/ui/LazerBadge";
import { ModBadge } from "../components/ui/ModBadge";
import { Pagination } from "../components/ui/Pagination";
import { UsernameText } from "../components/ui/UsernameText";
import type { SnipeEvent, SnipesScanStatus } from "../lib/types";
import { DEFAULT_SNIPES_FILTERS, useAppStore, useSelectedCountry, type SnipesFilters, type SnipesKeyFilter, type SnipesRange } from "../store";
import { parseCountrySearchParam } from "../lib/country-search";
import { getReplaySearch } from "../lib/replay-navigation";
import { startProgressPoll } from "../lib/progress-poll";
import { fetchLiveSnipesSnapshot, isLiveBackendConfigured, openLiveEventSource } from "../lib/live-backend";
import { CountryWarming } from "../components/CountryWarming";
import { SnipesNotTracked } from "../components/SnipesNotTracked";
import { useCountryWarming } from "../lib/use-country-warming";

type KeyFilter = SnipesKeyFilter;
type RangeFilter = SnipesRange;

type SnipesSearch = {
  keys: KeyFilter;
  range: RangeFilter;
  page: number;
  country: string | undefined;
};

const DEFAULT_SNIPES_SEARCH: SnipesSearch = {
  keys: "all",
  range: "7d",
  page: 0,
  country: undefined,
};

const RANGE_MS: Record<Exclude<RangeFilter, "all">, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

const PAGE_SIZE = 25;
const EMPTY_SNIPES: SnipeEvent[] = [];

const INLINE_PHASE_LABEL: Record<SnipesScanStatus["phase"], string> = {
  roster: "Loading country roster…",
  recent: "Loading players' recent plays…",
  compare: "Comparing plays against snapshot…",
  seed: "Checking new beatmaps…",
};

function readKeys(value: unknown): KeyFilter {
  return value === "4k" || value === "7k" ? value : "all";
}
function readRange(value: unknown): RangeFilter {
  return value === "24h" || value === "30d" || value === "all" ? value : "7d";
}

export const Route = createFileRoute("/snipes")({
  head: ({ match }) => {
    const country = match.search.country;
    const countryName = country ? getCountryName(country) : null;
    return {
      meta: [
        { title: countryName ? `Snipes - ${countryName}` : "Snipes" },
        { name: "description", content: "" },
        { name: "robots", content: "noindex, nofollow" },
      ],
    };
  },
  search: {
    middlewares: [stripSearchParams(DEFAULT_SNIPES_SEARCH)],
  },
  validateSearch: (search: Record<string, unknown>): SnipesSearch => ({
    keys: readKeys(search.keys),
    range: readRange(search.range),
    page: typeof search.page === "number" && search.page > 0 ? Math.floor(search.page) : 0,
    country: parseCountrySearchParam(search.country),
  }),
  component: SnipesPage,
});

function SnipesPage() {
  const search = Route.useSearch();
  const location = useLocation();
  const navigate = useNavigate();
  const fallbackCountry = useSelectedCountry();
  const selectedCountry = search.country ?? fallbackCountry;
  const countryName = getCountryName(selectedCountry);

  // Stale-response guard: compares against the component's view of the
  // current resolved country (route search > store fallback). The store
  // alone isn't enough on a fresh `/snipes?country=XX` because Nav's
  // URL -> store sync runs after our fetch has already started, which
  // made a valid XX response look stale and silently drop.
  const currentCountryRef = useRef(selectedCountry);
  currentCountryRef.current = selectedCountry;

  const snipes = useAppStore((state) => state.snipesByCountry[selectedCountry]) ?? EMPTY_SNIPES;
  const snipesFetchedAt = useAppStore((state) => state.snipesFetchedAtByCountry[selectedCountry]) ?? null;
  const rememberedFilters = useAppStore(
    (state) => state.snipesFiltersByCountry[selectedCountry] ?? DEFAULT_SNIPES_FILTERS,
  );
  const setSnipes = useAppStore((state) => state.setSnipes);
  const setSnipesFilters = useAppStore((state) => state.setSnipesFilters);

  const [loading, setLoading] = useState(snipes.length === 0);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [scanStartedAt, setScanStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [scanStatus, setScanStatus] = useState<SnipesScanStatus | null>(null);
  const [partialEvents, setPartialEvents] = useState<SnipeEvent[]>([]);
  const fetchingRef = useRef(false);
  const sawScanActivityRef = useRef(false);
  const finalizingRefreshRef = useRef(false);
  const refreshInProgressRef = useRef(false);
  const hasRestoredRememberedFiltersRef = useRef(false);
  const liveBackendEnabled = isLiveBackendConfigured();
  const { warming, featureTier } = useCountryWarming(selectedCountry);
  // Country is below the snipes tier: the backend won't seed/update snipe
  // boards for it, so there is nothing live to wait for here.
  const snipesTierDisabled = liveBackendEnabled && featureTier != null && featureTier !== "snipes";

  // Render-driving "elapsed" timer for the secondary header indicator.
  useEffect(() => {
    if (scanStartedAt == null) return;
    const tick = () => setElapsed(Date.now() - scanStartedAt);
    tick();
    const id = window.setInterval(tick, 250);
    return () => window.clearInterval(id);
  }, [scanStartedAt]);

  // Poll scan progress and partial events while the request is in flight.
  useEffect(() => {
    if (liveBackendEnabled) {
      setScanStatus(null);
      setPartialEvents([]);
      return;
    }
    if (scanStartedAt == null) {
      setScanStatus(null);
      setPartialEvents([]);
      return;
    }
    let cancelled = false;
    const requestedCountry = selectedCountry;
    const startedAt = scanStartedAt;
    const poll = async () => {
      try {
        const [status, partial] = await Promise.all([
          getSnipesScanStatus({ data: { country: requestedCountry } }),
          getPartialSnipeEvents({ data: { country: requestedCountry } }),
        ]);
        if (cancelled) return;
        if (currentCountryRef.current !== requestedCountry) return;
        setScanStatus((prev) => getMonotonicScanStatus(prev, status));
        if (status || partial.length > 0) sawScanActivityRef.current = true;
        if (partial.length > 0) {
          setPartialEvents(partial);
        }

        if (
          !status &&
          sawScanActivityRef.current &&
          Date.now() - startedAt > 1500 &&
          !finalizingRefreshRef.current
        ) {
          finalizingRefreshRef.current = true;
          const response = await getCountrySnipes({ data: { country: requestedCountry } });
          if (cancelled) return;
          if (currentCountryRef.current !== requestedCountry) return;
          setSnipes(
            requestedCountry,
            response?.events ?? [],
            response?.scannedAt ?? Date.now(),
          );
          const refreshStillInProgress = response?.refreshInProgress === true;
          refreshInProgressRef.current = refreshStillInProgress;
          setRefreshing(refreshStillInProgress);
          setScanStartedAt(refreshStillInProgress ? Date.now() : null);
          if (!refreshStillInProgress) {
            setPartialEvents([]);
            setScanStatus(null);
            sawScanActivityRef.current = false;
          }
          finalizingRefreshRef.current = false;
        }
      } catch {
        // Best-effort; ignore failures so the main fetch isn't disturbed.
        finalizingRefreshRef.current = false;
      }
    };
    const stopPolling = startProgressPoll(poll);
    return () => {
      cancelled = true;
      stopPolling();
    };
  }, [liveBackendEnabled, scanStartedAt, selectedCountry, setSnipes]);

  useEffect(() => {
    if (!liveBackendEnabled) return;
    let cancelled = false;
    const requestedCountry = selectedCountry;
    fetchLiveSnipesSnapshot(requestedCountry)
      .then((snapshot) => {
        if (cancelled || currentCountryRef.current !== requestedCountry) return;
        setSnipes(requestedCountry, snapshot.events, snapshot.scannedAt);
        setLoading(false);
        setRefreshing(false);
        setScanStartedAt(null);
      })
      .catch((err) => {
        if (currentCountryRef.current === requestedCountry && snipes.length === 0) {
          setError(err instanceof Error ? err.message : "Couldn't load live snipes.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [liveBackendEnabled, selectedCountry, setSnipes, snipes.length]);

  useEffect(() => {
    if (!liveBackendEnabled) return;
    const source = openLiveEventSource(selectedCountry);
    if (!source) return;
    source.addEventListener("snipe", (event) => {
      const snipe = JSON.parse(event.data) as SnipeEvent;
      const merged = new Map<string, SnipeEvent>();
      merged.set(`${snipe.beatmap_id}:${snipe.score_id}`, snipe);
      for (const existing of snipes) {
        const key = `${existing.beatmap_id}:${existing.score_id}`;
        if (!merged.has(key)) merged.set(key, existing);
      }
      setSnipes(selectedCountry, [...merged.values()], Date.now());
    });
    source.addEventListener("job_status", () => {
      setRefreshing(false);
      setScanStartedAt(null);
    });
    return () => source.close();
  }, [liveBackendEnabled, selectedCountry, setSnipes, snipes]);

  const searchRef = useRef(search);
  searchRef.current = search;
  const updateSearch = useCallback(
    (patch: Partial<SnipesSearch>) => {
      const nextSearch = { ...searchRef.current, ...patch };
      const changed = (Object.keys(patch) as Array<keyof SnipesSearch>).some((key) => searchRef.current[key] !== nextSearch[key]);
      if (!changed) return;

      if (patch.range || patch.keys) {
        setSnipesFilters(selectedCountry, {
          range: patch.range ?? searchRef.current.range,
          keys: patch.keys ?? searchRef.current.keys,
        });
      }
      navigate({
        to: "/snipes",
        search: nextSearch,
        replace: true,
        resetScroll: false,
      });
    },
    [navigate, selectedCountry, setSnipesFilters],
  );

  // Reset transient UI state on country switch.
  useEffect(() => {
    setError(null);
    setLoading(snipes.length === 0);
    setRefreshing(false);
    setExpandedKey(null);
    setScanStartedAt(null);
    setPartialEvents([]);
    setElapsed(0);
    fetchingRef.current = false;
    sawScanActivityRef.current = false;
    finalizingRefreshRef.current = false;
    refreshInProgressRef.current = false;
    hasRestoredRememberedFiltersRef.current = false;
    if (search.page !== 0) updateSearch({ page: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCountry]);

  useEffect(() => {
    if (hasRestoredRememberedFiltersRef.current) return;

    hasRestoredRememberedFiltersRef.current = true;
    const params = new URLSearchParams(location.searchStr);
    const hasExplicitRange = params.has("range");
    const hasExplicitKeys = params.has("keys");
    if (hasExplicitRange && hasExplicitKeys) return;

    const nextSearch = {
      ...search,
      range: hasExplicitRange ? search.range : rememberedFilters.range,
      keys: hasExplicitKeys ? search.keys : rememberedFilters.keys,
      page: 0,
    };
    if (
      nextSearch.range === search.range &&
      nextSearch.keys === search.keys &&
      nextSearch.page === search.page
    ) {
      return;
    }

    navigate({
      to: "/snipes",
      search: nextSearch,
      replace: true,
      resetScroll: false,
    });
  }, [location.searchStr, navigate, rememberedFilters.keys, rememberedFilters.range, search]);

  useEffect(() => {
    const params = new URLSearchParams(location.searchStr);
    const restoringMissingFilters =
      (!params.has("range") && rememberedFilters.range !== search.range) ||
      (!params.has("keys") && rememberedFilters.keys !== search.keys);
    if (restoringMissingFilters) return;

    const currentFilters: SnipesFilters = {
      keys: search.keys,
      range: search.range,
    };
    if (
      rememberedFilters.keys === currentFilters.keys &&
      rememberedFilters.range === currentFilters.range
    ) {
      return;
    }
    setSnipesFilters(selectedCountry, currentFilters);
  }, [location.searchStr, rememberedFilters.keys, rememberedFilters.range, search.keys, search.range, selectedCountry, setSnipesFilters]);

  // Fetch snipes when stale. State updates are gated on the country still
  // matching at resolve time so a country switch doesn't write the wrong
  // result. We don't cancel on cleanup — strict-mode double-mounting would
  // otherwise drop the only inflight fetch and leave us stuck loading.
  useEffect(() => {
    if (liveBackendEnabled) return;
    if (fetchingRef.current) return;
    const stale = isCacheStale(snipesFetchedAt, CLIENT_CACHE_TTL.snipes);
    if (!stale) {
      refreshInProgressRef.current = false;
      setLoading(false);
      return;
    }
    if (refreshInProgressRef.current) {
      setLoading(false);
      if (snipes.length > 0) setRefreshing(true);
      if (scanStartedAt == null) setScanStartedAt(Date.now());
      return;
    }

    fetchingRef.current = true;
    setLoading(snipes.length === 0);
    if (snipes.length > 0) setRefreshing(true);
    setScanStartedAt(Date.now());
    setElapsed(0);
    const requestedCountry = selectedCountry;
    let keepPollingRefresh = false;

    getCountrySnipes({ data: { country: requestedCountry } })
      .then((response) => {
        keepPollingRefresh = response?.refreshInProgress === true;
        refreshInProgressRef.current = keepPollingRefresh;
        setSnipes(
          requestedCountry,
          response?.events ?? [],
          response?.scannedAt ?? Date.now(),
        );
        if (currentCountryRef.current === requestedCountry) {
          setError(null);
          if (keepPollingRefresh) {
            setRefreshing(true);
            setScanStartedAt(Date.now());
          }
        }
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : "Couldn't load snipes.";
        if (currentCountryRef.current === requestedCountry && snipes.length === 0) {
          setError(message);
        }
      })
      .finally(() => {
        if (currentCountryRef.current === requestedCountry) {
          setLoading(false);
          if (!keepPollingRefresh) {
            refreshInProgressRef.current = false;
            setRefreshing(false);
            setScanStartedAt(null);
          }
        }
        fetchingRef.current = false;
      });
  }, [liveBackendEnabled, selectedCountry, snipesFetchedAt, snipes.length, scanStartedAt, setSnipes]);

  // ── Filter + sort ──────────────────────────────────────────────────────
  const visibleSnipes = useMemo(() => {
    if (partialEvents.length === 0) return snipes;
    const merged = new Map<string, SnipeEvent>();
    for (const event of partialEvents) {
      merged.set(`${event.beatmap_id}:${event.score_id}`, event);
    }
    for (const event of snipes) {
      const key = `${event.beatmap_id}:${event.score_id}`;
      if (!merged.has(key)) merged.set(key, event);
    }
    return [...merged.values()];
  }, [snipes, partialEvents]);

  const filtered = useMemo(() => {
    const cutoff = search.range === "all" ? 0 : Date.now() - RANGE_MS[search.range];
    return visibleSnipes.filter((event) => {
      const ts = new Date(event.timestamp).getTime();
      if (cutoff && ts < cutoff) return false;
      if (search.keys !== "all") {
        const keys = Math.round(event.beatmap.cs);
        if (search.keys === "4k" && keys !== 4) return false;
        if (search.keys === "7k" && keys !== 7) return false;
      }
      return true;
    });
  }, [visibleSnipes, search.range, search.keys]);

  const sorted = useMemo(() => {
    const out = [...filtered];
    out.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    return out;
  }, [filtered]);

  // ── Pagination ─────────────────────────────────────────────────────────
  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const safePage = Math.min(search.page, totalPages - 1);
  const paginated = sorted.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  useEffect(() => {
    if (safePage !== search.page) updateSearch({ page: safePage });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [safePage, search.page]);

  // ── Mobile filter sheet ────────────────────────────────────────────────
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState(0);
  const dragStartYRef = useRef(0);
  const handleDragStart = (e: React.TouchEvent) => {
    dragStartYRef.current = e.touches[0].clientY;
    setIsDragging(true);
    setDragOffset(0);
  };
  const handleDragMove = (e: React.TouchEvent) => {
    const delta = e.touches[0].clientY - dragStartYRef.current;
    setDragOffset(Math.max(0, delta));
  };
  const handleDragEnd = () => {
    setIsDragging(false);
    if (dragOffset > 80) setFiltersOpen(false);
    setDragOffset(0);
  };
  useEffect(() => {
    if (!filtersOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFiltersOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [filtersOpen]);
  useEffect(() => {
    if (filtersOpen) setDragOffset(0);
  }, [filtersOpen]);

  const activeFilterCount =
    (search.keys !== "all" ? 1 : 0) +
    (search.range !== "7d" ? 1 : 0);
  const hasActiveFilters = activeFilterCount > 0;
  const scanProgressPercent = getScanProgressPercent(scanStatus);

  const resetFilters = () => {
    updateSearch({ ...DEFAULT_SNIPES_SEARCH, country: search.country });
  };

  return (
    <div className="flex-1">
      <PageHeader
        iconSrc="/images/icons/sniper.webp"
        title={`${countryName} mania snipes`}
        right={
          <div className="flex items-center gap-2">
            {(loading || refreshing) && !error && (
              <div className="flex items-center gap-1.5">
                <div className="w-3 h-3 border-2 border-osu-pink/40 border-t-osu-pink rounded-full animate-spin" />
                <span className="text-[10px] text-osu-f1">
                  {loading
                    ? `Scanning... ${formatElapsedSeconds(elapsed)}`
                    : `Refreshing...${scanProgressPercent == null ? "" : ` (${scanProgressPercent}%)`}`}
                </span>
              </div>
            )}
            {!loading && !refreshing && !error && visibleSnipes.length > 0 && (
              <span className="text-[10px] text-osu-f1">
                {sorted.length} {sorted.length === 1 ? "snipe" : "snipes"}
                {snipesFetchedAt ? ` · updated ${formatTimeAgo(new Date(snipesFetchedAt).toISOString())}` : ""}
              </span>
            )}
          </div>
        }
      />

      {warming && <CountryWarming country={selectedCountry} />}

      {!warming && snipesTierDisabled && (
        <SnipesNotTracked country={selectedCountry} hasOldData={snipes.length > 0} />
      )}

      {!warming && !(snipesTierDisabled && snipes.length === 0) && (
      <>
      {/* ── Filter bar ─────────────────────────────────────────────────── */}
      <div className="bg-osu-d5 border-b border-osu-b3/20">
        <div className="max-w-[1200px] mx-auto px-4 sm:px-5 py-2.5 flex flex-wrap items-start sm:items-center gap-x-4 gap-y-2">
          {/* Mobile filter toggle */}
          <div className="flex w-full items-center justify-between gap-2 sm:hidden">
            <button
              onClick={() => setFiltersOpen((o) => !o)}
              aria-expanded={filtersOpen}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-osu-b4 border border-osu-b3/30 text-[11px] text-osu-l2 hover:bg-osu-b3 transition-colors cursor-pointer"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3 h-3">
                <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
              </svg>
              <span>Filters</span>
              {activeFilterCount > 0 && (
                <span className="inline-flex min-w-[18px] h-[18px] shrink-0 items-center justify-center self-center rounded-full bg-osu-pink/30 px-1 text-[10px] font-bold leading-none text-osu-pink-light tabular-nums">
                  <span className="relative -top-px">{activeFilterCount}</span>
                </span>
              )}
            </button>
          </div>

          {/* Backdrop */}
          <div
            onClick={() => setFiltersOpen(false)}
            aria-hidden="true"
            className="fixed inset-0 z-40 bg-black/35 sm:hidden transition-opacity duration-300 ease-out"
            style={{
              opacity: filtersOpen ? Math.max(0, 1 - dragOffset / 250) : 0,
              pointerEvents: filtersOpen ? "auto" : "none",
            }}
          />

          {/* Sheet (inline desktop / bottom sheet mobile). The pointer-events
              toggle is mobile-only — on desktop the wrapper becomes
              `display: contents` and inheriting `pointer-events: none` would
              kill clicks on the filter buttons. */}
          <div
            className={`sm:contents fixed bottom-0 left-0 right-0 z-50 max-h-[75vh] overflow-y-auto bg-osu-d5 border-t border-osu-b3/30 rounded-t-2xl shadow-2xl px-4 pt-2 pb-6 flex flex-col gap-3 will-change-transform ${
              filtersOpen ? "pointer-events-auto" : "pointer-events-none"
            } sm:pointer-events-auto`}
            style={{
              transform: filtersOpen ? `translateY(${dragOffset}px)` : "translateY(105%)",
              transition: isDragging ? "none" : "transform 280ms cubic-bezier(0.32, 0.72, 0, 1)",
            }}
            role={filtersOpen ? "dialog" : undefined}
            aria-modal={filtersOpen ? true : undefined}
          >
            <div
              onTouchStart={handleDragStart}
              onTouchMove={handleDragMove}
              onTouchEnd={handleDragEnd}
              onTouchCancel={handleDragEnd}
              className="sm:hidden flex justify-center pt-2 pb-3 -mx-4 cursor-grab touch-none"
            >
              <div className="h-1 w-10 rounded-full bg-osu-b3" />
            </div>
            <div className="sm:hidden flex items-center justify-between">
              <div className="flex items-center gap-2">
                <h3 className="text-[12px] font-bold text-osu-l2 uppercase tracking-wider">Filters</h3>
                {activeFilterCount > 0 && (
                  <span className="inline-flex min-w-[18px] h-[18px] shrink-0 items-center justify-center self-center rounded-full bg-osu-pink/30 px-1 text-[10px] font-bold leading-none text-osu-pink-light tabular-nums">
                    <span className="relative -top-px">{activeFilterCount}</span>
                  </span>
                )}
              </div>
              <button
                onClick={() => setFiltersOpen(false)}
                aria-label="Close filters"
                className="p-1 text-osu-f1 hover:text-white transition-colors cursor-pointer"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>

            <FilterGroup label="Range">
              {(["24h", "7d", "30d", "all"] as RangeFilter[]).map((r) => (
                <FilterPill key={r} active={search.range === r} onClick={() => updateSearch({ range: r, page: 0 })}>
                  {r === "all" ? "All time" : r === "24h" ? "24h" : r === "7d" ? "7 days" : "30 days"}
                </FilterPill>
              ))}
            </FilterGroup>

            <FilterGroup label="Keys">
              {(["all", "4k", "7k"] as KeyFilter[]).map((k) => (
                <FilterPill key={k} active={search.keys === k} onClick={() => updateSearch({ keys: k, page: 0 })}>
                  {k === "all" ? "All" : k.toUpperCase()}
                </FilterPill>
              ))}
            </FilterGroup>

          </div>

          {hasActiveFilters && (
            <button
              onClick={resetFilters}
              className="text-[10px] text-osu-pink-light hover:text-white transition-colors cursor-pointer"
            >
              Clear filters
            </button>
          )}
        </div>
      </div>

      {/* ── Content ────────────────────────────────────────────────────── */}
      <div className="bg-osu-b5">
        <div className="max-w-[1200px] mx-auto px-4 sm:px-5 py-6">
          {error && (
            <div className="text-center py-16 text-osu-f1 text-sm">{error}</div>
          )}

          {!error && (
            <>
              {loading && snipes.length === 0 && (
                <>
                  {scanStatus?.phase === "seed" ? (
                    <ScanProgress
                      elapsed={elapsed}
                      countryName={countryName}
                      status={scanStatus}
                    />
                  ) : (
                    <div className="flex flex-col items-center justify-center gap-1.5 py-20 text-osu-f1 text-xs">
                      <div className="flex items-center gap-2">
                        <div className="w-3 h-3 border-2 border-osu-pink/40 border-t-osu-pink rounded-full animate-spin" />
                        <span>
                          {scanStatus
                            ? INLINE_PHASE_LABEL[scanStatus.phase]
                            : `Loading ${countryName} snipes…`}
                        </span>
                      </div>
                      {scanStatus && scanStatus.total > 0 && (
                        <span className="text-[10px] tabular-nums text-osu-f1/70">
                          {scanStatus.current}/{scanStatus.total}
                        </span>
                      )}
                    </div>
                  )}
                  {partialEvents.length > 0 && (
                    <div className="space-y-2 mt-4">
                      <div className="text-[11px] text-osu-f1 mb-2">
                        Found {partialEvents.length} snipe{partialEvents.length === 1 ? "" : "s"} so far...
                      </div>
                      {partialEvents.map((event) => {
                        const key = `${event.beatmap_id}:${event.score_id}`;
                        return (
                          <SnipeRow
                            key={key}
                            event={event}
                            eventKey={key}
                            expanded={expandedKey === key}
                            onToggle={(k) => setExpandedKey((prev) => (prev === k ? null : k))}
                          />
                        );
                      })}
                    </div>
                  )}
                </>
              )}

              {!loading && sorted.length === 0 && visibleSnipes.length === 0 && (
                <div className="text-center py-16 text-osu-f1 text-sm">
                  <p>No snipes tracked yet for {countryName}.</p>
                  <p className="mt-1 text-[11px]">
                    Snipes appear when tracked country players push each other down a beatmap's country leaderboard.
                  </p>
                  {snipesFetchedAt && !liveBackendEnabled && (
                    <p className="mt-2 text-[10px] text-osu-f1/60">
                      Last scanned {formatTimeAgo(new Date(snipesFetchedAt).toISOString())}.
                    </p>
                  )}
                </div>
              )}

              {!loading && sorted.length === 0 && visibleSnipes.length > 0 && (
                <div className="text-center py-16 text-osu-f1 text-sm">
                  <p>No snipes match the current filters.</p>
                  {hasActiveFilters && (
                    <button onClick={resetFilters} className="mt-2 text-[11px] text-osu-pink-light hover:text-white cursor-pointer">
                      Clear filters
                    </button>
                  )}
                </div>
              )}

              {!loading && paginated.length > 0 && (
                <div className="space-y-2">
                  {paginated.map((event) => {
                    const key = `${event.beatmap_id}:${event.score_id}`;
                    return (
                      <SnipeRow
                        key={key}
                        event={event}
                        eventKey={key}
                        expanded={expandedKey === key}
                        onToggle={(k) => setExpandedKey((prev) => (prev === k ? null : k))}
                      />
                    );
                  })}
                </div>
              )}

              {totalPages > 1 && (
                <div className="mt-5 flex justify-center">
                  <Pagination
                    page={safePage}
                    totalPages={totalPages}
                    onPageChange={(p) => updateSearch({ page: p })}
                  />
                </div>
              )}
            </>
          )}
        </div>
      </div>
      </>
      )}
    </div>
  );
}

// ── Snipe row ─────────────────────────────────────────────────────────────

function SnipeRow({
  event,
  eventKey,
  expanded,
  onToggle,
}: {
  event: SnipeEvent;
  eventKey: string;
  expanded: boolean;
  onToggle: (key: string) => void;
}) {
  const navigate = useNavigate();
  const [rendered, setRendered] = useState(expanded);
  useEffect(() => {
    if (expanded) setRendered(true);
  }, [expanded]);

  const keys = Math.round(event.beatmap.cs);
  const sniperHref = `/player/${encodeURIComponent(event.sniper.username)}`;
  const previousHref = `/player/${encodeURIComponent(event.victim.username)}`;
  const beatmapHref = event.beatmap.url;
  const replaySearch = event.hasReplay
    ? getReplaySearch(event.score_id, event.beatmapset_id)
    : null;

  const previousScoreAge = useMemo(() => {
    const sniperMs = new Date(event.timestamp).getTime();
    const previousMs = new Date(event.victimTimestamp).getTime();
    if (!Number.isFinite(sniperMs) || !Number.isFinite(previousMs)) return null;
    const diff = sniperMs - previousMs;
    if (diff <= 0) return null;
    const days = Math.floor(diff / (24 * 60 * 60 * 1000));
    if (days >= 1) return `${days} ${days === 1 ? "day" : "days"}`;
    const hours = Math.max(1, Math.floor(diff / (60 * 60 * 1000)));
    return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  }, [event.timestamp, event.victimTimestamp]);

  const relationLabel = "sniped";

  return (
    <div className="rounded-xl bg-osu-b4 border border-osu-b3/20 overflow-hidden">
      <div
        className="flex items-center gap-2 sm:gap-3 py-3 px-3 sm:px-4 hover:bg-osu-b3/50 transition-colors duration-[120ms] cursor-pointer"
        onClick={() => onToggle(eventKey)}
      >
        {/* Sniper */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            window.location.href = sniperHref;
          }}
          className="cursor-pointer flex-shrink-0"
          title={`Open ${event.sniper.username}'s profile`}
        >
          <Avatar url={event.sniper.avatar_url} size={36} />
        </button>

        <div className="flex-1 min-w-0">
          {/* Row 1: sniper → victim + time (mobile) */}
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 min-w-0">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  window.location.href = sniperHref;
                }}
                className="cursor-pointer min-w-0"
              >
                <UsernameText
                  username={event.sniper.username}
                  avatarUrl={event.sniper.avatar_url}
                  className="text-sm font-semibold truncate"
                />
              </button>
              <span className="text-[9px] text-osu-f1 uppercase tracking-wider hidden sm:inline">
                {relationLabel}
              </span>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5 text-osu-pink-light flex-shrink-0" aria-label="sniped">
                <circle cx="12" cy="12" r="9" />
                <line x1="12" y1="2" x2="12" y2="6" />
                <line x1="12" y1="18" x2="12" y2="22" />
                <line x1="2" y1="12" x2="6" y2="12" />
                <line x1="18" y1="12" x2="22" y2="12" />
                <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
              </svg>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  window.location.href = previousHref;
                }}
                className="cursor-pointer min-w-0 flex items-center gap-1.5"
                title={`Open ${event.victim.username}'s profile`}
              >
                <Avatar url={event.victim.avatar_url} size={20} />
                <UsernameText
                  username={event.victim.username}
                  avatarUrl={event.victim.avatar_url}
                  className="text-xs text-osu-l2 truncate"
                />
              </button>
            </div>
            <span className="text-[10px] text-osu-f1 flex-shrink-0 sm:hidden">
              {formatTimeAgo(event.timestamp)}
            </span>
          </div>

          {/* Row 2: beatmap title + diff + keys */}
          <div className="flex items-center justify-between sm:justify-start gap-2 mt-0.5">
            <div className="flex items-center gap-2 min-w-0">
              <GradeImg grade={event.rank} size={20} />
              {beatmapHref ? (
                <a
                  href={beatmapHref}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="text-xs text-white truncate hover:text-osu-pink-light underline-offset-2 hover:underline"
                  title="Open beatmap on osu!"
                >
                  {event.beatmapset.title}
                </a>
              ) : (
                <span className="text-xs text-white truncate">{event.beatmapset.title}</span>
              )}
              <span className="text-[10px] text-osu-f1 truncate">[{event.beatmap.version}]</span>
            </div>
            {keys > 0 && (
              <span className="px-1 py-0.5 rounded text-[8px] font-bold bg-osu-b3/50 text-osu-yellow flex-shrink-0">
                {keys}K
              </span>
            )}
          </div>

          {/* Row 3 (mobile): mods + acc + pp */}
          <div className="flex items-center justify-between gap-2 mt-1 sm:hidden">
            <div className="flex items-center gap-1">
              {event.mods.map((m) => (
                <ModBadge key={m} mod={m} />
              ))}
              {event.isLazer && <LazerBadge />}
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <span className="text-xs text-osu-l2">{formatAccuracy(event.accuracy)}</span>
              <span className="text-sm font-bold">{formatPP(event.pp)}</span>
              {replaySearch && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    navigate({ to: "/replay", search: replaySearch });
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
            {event.mods.map((m) => (
              <ModBadge key={m} mod={m} />
            ))}
          </div>
          {event.isLazer && <LazerBadge />}
          <span className="text-xs text-osu-l2 tabular-nums">{formatAccuracy(event.accuracy)}</span>
          <span className="text-sm font-bold tabular-nums">{formatPP(event.pp)}</span>
          {replaySearch && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                navigate({ to: "/replay", search: replaySearch });
              }}
              className="px-2 py-1 rounded bg-osu-pink/20 text-[10px] text-osu-pink-light font-semibold hover:bg-osu-pink/30 transition-colors cursor-pointer"
              title="Watch replay"
            >
              &#9654; Watch
            </button>
          )}
          <span className="text-[10px] text-osu-f1 w-12 text-right">
            {formatTimeAgo(event.timestamp)}
          </span>
        </div>
      </div>

      {rendered && (
        <div
          className={`relative px-4 pb-3 pt-2 border-t border-osu-b3/20 overflow-hidden ${expanded ? "detail-enter" : "detail-exit"}`}
          onAnimationEnd={() => {
            if (!expanded) setRendered(false);
          }}
        >
          {event.beatmapset.cover_url && (
            <div
              className="absolute inset-0 opacity-[0.07] bg-cover bg-center pointer-events-none"
              style={{ backgroundImage: `url(${event.beatmapset.cover_url})` }}
            />
          )}
          {/* flex-wrap + justify-center so an orphan last row (e.g. 5 stats in
              a 2/4/5-col layout) centers itself instead of hugging the left
              edge. Each cell's basis matches the old grid's column width minus
              its share of the gap. */}
          <div className="relative flex flex-wrap justify-center gap-3 text-center">
            <StatCell label="Score" value={formatNumber(event.totalScore)} />
            <StatCell label="Accuracy" value={formatAccuracy(event.accuracy)} color="text-osu-l2" />
            {event.pp != null && event.pp > 0 && (
              <div className="basis-[calc(50%-6px)] sm:basis-[calc(25%-9px)] lg:basis-[calc(20%-9.6px)] py-1.5">
                <div className="text-[9px] uppercase tracking-wider text-osu-f1 font-semibold">PP</div>
                <div className="text-sm font-bold">
                  <span
                    className={
                      event.victimPp != null && event.victimPp > event.pp
                        ? "text-osu-yellow"
                        : "text-osu-pink"
                    }
                  >
                    {Math.round(event.pp)}pp
                  </span>
                  {event.victimPp != null && event.victimPp > 0 && (
                    <span className="ml-1 text-[11px] font-normal text-osu-f1">
                      vs {Math.round(event.victimPp)}pp
                    </span>
                  )}
                </div>
              </div>
            )}
            <StatCell label="Stars" value={event.beatmap.difficulty_rating.toFixed(2)} />
            {event.victimTotalScore != null && event.victimTotalScore > 0 && (
              <StatCell
                label="Margin"
                value={`+${formatNumber(Math.max(0, event.totalScore - event.victimTotalScore))}`}
                color="text-osu-pink-light"
              />
            )}
            {previousScoreAge && (
              <StatCell label="Previous score age" value={previousScoreAge} color="text-osu-yellow" />
            )}
          </div>
          <div className="relative mt-2 flex items-center justify-between gap-2 text-[10px] text-osu-f1">
            <span>
              {`${event.sniper.username} sniped ${event.victim.username}`}
            </span>
            <a
              href={beatmapHref}
              target="_blank"
              rel="noreferrer"
              className="hover:text-osu-pink-light underline-offset-2 hover:underline transition-colors flex-shrink-0"
            >
              View beatmap →
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

function StatCell({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="basis-[calc(50%-6px)] sm:basis-[calc(25%-9px)] lg:basis-[calc(20%-9.6px)] py-1.5">
      <div className="text-[9px] uppercase tracking-wider text-osu-f1 font-semibold">{label}</div>
      <div className={`text-sm font-bold ${color ?? "text-white"}`}>{value}</div>
    </div>
  );
}

// ── Filter UI helpers (copied from /maps for consistency) ────────────────

function FilterGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex w-full min-w-0 flex-col gap-1 sm:w-auto sm:flex-row sm:items-center sm:gap-1.5">
      <span className="text-[9px] uppercase tracking-wider text-osu-f1 font-semibold shrink-0">{label}</span>
      <div className="flex min-w-0 flex-wrap gap-0.5">{children}</div>
    </div>
  );
}

function FilterPill({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-2 py-1 rounded text-[10px] font-medium transition-colors cursor-pointer ${
        active
          ? "bg-osu-pink/20 text-osu-pink-light"
          : "bg-osu-b4 text-osu-f1 hover:text-osu-l2 hover:bg-osu-b3"
      }`}
    >
      {children}
    </button>
  );
}

function formatElapsedSeconds(ms: number): string {
  return `${Math.floor(ms / 1000)}s`;
}

function getScanProgressPercent(status: SnipesScanStatus | null): number | null {
  if (!status || status.total <= 0) return null;
  const phaseIdx = PHASE_ORDER.indexOf(status.phase);
  if (phaseIdx < 0) return null;
  const phaseProgress = Math.max(0, Math.min(1, status.current / status.total));
  return Math.max(
    0,
    Math.min(100, Math.round(((phaseIdx + phaseProgress) / PHASE_ORDER.length) * 100)),
  );
}

function getMonotonicScanStatus(
  previous: SnipesScanStatus | null,
  next: SnipesScanStatus | null,
): SnipesScanStatus | null {
  if (!previous || !next) return next;
  const previousPercent = getScanProgressPercent(previous);
  const nextPercent = getScanProgressPercent(next);
  if (previousPercent == null || nextPercent == null) return next;
  return nextPercent >= previousPercent ? next : previous;
}

const PHASE_ORDER: SnipesScanStatus["phase"][] = [
  "roster",
  "recent",
  "compare",
  "seed",
];

const PHASE_DESCRIPTIONS: Record<SnipesScanStatus["phase"], string> = {
  roster: "Loading the country roster.",
  recent: "Pulling each player's recent plays from the osu! API.",
  compare: "Cross-checking those plays against the saved country leaderboards.",
  seed: "Looking up country rankings on beatmaps we haven't seen yet.",
};

function ScanProgress({
  elapsed,
  countryName,
  status,
}: {
  elapsed: number;
  countryName: string;
  status: SnipesScanStatus | null;
}) {
  const phaseIdx = status ? PHASE_ORDER.indexOf(status.phase) : -1;
  const maxRef = useRef({ phase: "", pct: 0, current: 0 });
  const rawPct =
    status && status.total > 0
      ? Math.min(100, Math.round((status.current / status.total) * 100))
      : 0;
  if (status && status.phase !== maxRef.current.phase) {
    maxRef.current = { phase: status.phase, pct: rawPct, current: status?.current ?? 0 };
  } else {
    if (rawPct > maxRef.current.pct) maxRef.current.pct = rawPct;
    if (status && status.current > maxRef.current.current) maxRef.current.current = status.current;
  }
  const phasePct = maxRef.current.pct;
  const flooredCurrent = maxRef.current.current;
  const description = status ? PHASE_DESCRIPTIONS[status.phase] : "Connecting to the scanner...";

  return (
    <div className="max-w-xl mx-auto py-8 px-1">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <div className="w-3.5 h-3.5 border-2 border-osu-pink/40 border-t-osu-pink rounded-full animate-spin flex-shrink-0" />
            <h2 className="text-sm font-bold text-white">
              Scanning {countryName}
            </h2>
          </div>
          <p className="text-[11px] text-osu-f1 mt-1">
            First scan for a country pulls a lot of data. Subsequent scans are near-instant.
          </p>
        </div>
        <span className="text-[11px] text-osu-f1 tabular-nums flex-shrink-0">
          {formatElapsedSeconds(elapsed)}
        </span>
      </div>

      {/* Phase checklist */}
      <ol className="mt-5 space-y-1.5">
        {PHASE_ORDER.map((phase, idx) => {
          const isCurrent = idx === phaseIdx;
          const isDone = phaseIdx >= 0 && idx < phaseIdx;
          const isPending = phaseIdx < 0 || idx > phaseIdx;
          return (
            <li
              key={phase}
              className={`flex items-center gap-2 text-[11px] ${
                isCurrent
                  ? "text-white"
                  : isDone
                    ? "text-osu-l2"
                    : "text-osu-f1/60"
              }`}
            >
              <span
                className={`inline-flex items-center justify-center w-4 h-4 rounded-full text-[9px] font-bold flex-shrink-0 ${
                  isCurrent
                    ? "bg-osu-pink text-white"
                    : isDone
                      ? "bg-osu-pink/30 text-osu-pink-light"
                      : "bg-osu-b3/60 text-osu-f1"
                }`}
              >
                {isDone ? "✓" : idx + 1}
              </span>
              <span className={isPending ? "" : "font-medium"}>
                {phase === "roster" && "Country roster"}
                {phase === "recent" && "Recent plays"}
                {phase === "compare" && "Compare against snapshot"}
                {phase === "seed" && "Check new beatmaps"}
              </span>
              {isCurrent && status && status.total > 0 && (
                <span className="ml-auto text-osu-f1 tabular-nums">
                  {flooredCurrent}/{status.total}
                </span>
              )}
            </li>
          );
        })}
      </ol>

      {/* Active phase detail + progress bar */}
      <div className="mt-5">
        <div className="flex items-center justify-between text-[10px] text-osu-f1 mb-1.5">
          <span className="truncate pr-2">{status?.label ?? "Waiting for first status update..."}</span>
          {status && status.total > 0 && (
            <span className="tabular-nums flex-shrink-0">{phasePct}%</span>
          )}
        </div>
        <div className="h-2 rounded-full bg-osu-b3/60 overflow-hidden">
          {status && status.total > 0 ? (
            <div
              className="h-full bg-osu-pink transition-[width] duration-[400ms] ease-out"
              style={{ width: `${phasePct}%` }}
            />
          ) : (
            <div className="h-full w-1/3 bg-osu-pink/60 animate-pulse rounded-full" />
          )}
        </div>
        <p className="text-[10px] text-osu-f1 mt-2">{description}</p>
      </div>
    </div>
  );
}
