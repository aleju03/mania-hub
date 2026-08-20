import { createFileRoute, Link, stripSearchParams, useLocation, useNavigate } from "@tanstack/react-router";
import { Globe } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { msg } from "@lingui/core/macro";
import { getI18n } from "../lib/i18n";
import { getCountryName, isGlobalScope } from "../lib/country";
import { formatAccuracy, formatNumber, formatPP, formatTimeAgo } from "../lib/format";
import { PageHeader } from "../components/layout/PageHeader";
import { OsuTriangleBackdrop } from "../components/layout/OsuTriangleBackdrop";
import { Avatar } from "../components/ui/Avatar";
import { GradeImg } from "../components/ui/GradeImg";
import { FilterField, SegmentedControl, type SegmentedOption } from "../components/ui/SegmentedControl";
import { LazerBadge } from "../components/ui/LazerBadge";
import { ModBadge } from "../components/ui/ModBadge";
import { Pagination } from "../components/ui/Pagination";
import { UsernameText } from "../components/ui/UsernameText";
import { CoverBackdrop } from "../components/ui/CoverBackdrop";
import type { SnipeEvent } from "../lib/types";
import { DEFAULT_SNIPES_FILTERS, useAppStore, useHiddenUserIds, useSelectedCountry, type SnipesFilters, type SnipesKeyFilter, type SnipesRange } from "../store";
import { parseCountrySearchParam } from "../lib/country-search";
import { getReplaySearch } from "../lib/replay-navigation";
import { fetchLiveSnipeBoard, fetchLiveSnipesSnapshot, isLiveBackendConfigured, openLiveEventSource, type LiveSnipeBoardEntry, type LiveSnipeBoardSnapshot } from "../lib/live-backend";
import { CountryWarming } from "../components/CountryWarming";
import { LiveBackendRequired } from "../components/LiveDataEmptyState";
import { SnipesNotTracked } from "../components/SnipesNotTracked";
import { useCountryWarming } from "../lib/use-country-warming";
import { useWindowActive } from "../lib/window-activity";

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

const RANGE_MS: Record<RangeFilter, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

const PAGE_SIZE = 25;
const EMPTY_SNIPES: SnipeEvent[] = [];

function readKeys(value: unknown): KeyFilter {
  return value === "4k" || value === "7k" ? value : "all";
}
function readRange(value: unknown): RangeFilter {
  return value === "24h" || value === "30d" ? value : "7d";
}

export const Route = createFileRoute("/snipes")({
  head: ({ match }) => {
    const country = match.search.country;
    const countryName = country ? getCountryName(country) : null;
    const i18n = getI18n(match.context.locale);
    return {
      meta: [
        { title: countryName ? i18n._(msg`Snipes - ${countryName}`) : i18n._(msg`Snipes`) },
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
  const { t } = useLingui();
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
  const hiddenUserIds = useHiddenUserIds();

  const [loading, setLoading] = useState(snipes.length === 0);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const hasRestoredRememberedFiltersRef = useRef(false);
  const liveBackendEnabled = isLiveBackendConfigured();
  const windowActive = useWindowActive();
  const selectedIsGlobal = isGlobalScope(selectedCountry);
  const { warming, featureTier } = useCountryWarming(selectedCountry);
  // Country is below the snipes tier: the backend won't seed/update snipe
  // boards for it, so there is nothing live to wait for here.
  const snipesTierDisabled = liveBackendEnabled && featureTier != null && featureTier !== "snipes";

  useEffect(() => {
    if (!liveBackendEnabled || selectedIsGlobal || !windowActive) return;
    let cancelled = false;
    const requestedCountry = selectedCountry;
    fetchLiveSnipesSnapshot(requestedCountry)
      .then((snapshot) => {
        if (cancelled || currentCountryRef.current !== requestedCountry) return;
        setSnipes(requestedCountry, snapshot.events, snapshot.scannedAt);
        setLoading(false);
        setRefreshing(false);
      })
      .catch((err) => {
        if (currentCountryRef.current === requestedCountry && snipes.length === 0) {
          setError(err instanceof Error ? err.message : t`Couldn't load live snipes.`);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [liveBackendEnabled, selectedCountry, selectedIsGlobal, setSnipes, snipes.length, windowActive]);

  useEffect(() => {
    if (!liveBackendEnabled || selectedIsGlobal || !windowActive) return;
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
    });
    return () => source.close();
  }, [liveBackendEnabled, selectedCountry, selectedIsGlobal, setSnipes, snipes, windowActive]);

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

  // ── Filter + sort ──────────────────────────────────────────────────────
  const visibleSnipes = snipes;

  const filtered = useMemo(() => {
    const cutoff = Date.now() - RANGE_MS[search.range];
    return visibleSnipes.filter((event) => {
      // Drop the whole event if either side is hidden — a snipe row only makes
      // sense with both the sniper and the victim shown.
      if (hiddenUserIds.has(event.sniper.id) || hiddenUserIds.has(event.victim.id)) return false;
      const ts = new Date(event.timestamp).getTime();
      if (ts < cutoff) return false;
      if (search.keys !== "all") {
        const keys = Math.round(event.beatmap.cs);
        if (search.keys === "4k" && keys !== 4) return false;
        if (search.keys === "7k" && keys !== 7) return false;
      }
      return true;
    });
  }, [visibleSnipes, search.range, search.keys, hiddenUserIds]);

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

  const resetFilters = () => {
    updateSearch({ ...DEFAULT_SNIPES_SEARCH, country: search.country });
  };

  if (!liveBackendEnabled) {
    return (
      <div className="flex-1">
        <PageHeader iconSrc="/images/icons/snipes.svg" title={t`${countryName} mania snipes`} />
        <LiveBackendRequired />
      </div>
    );
  }

  // Snipes are inherently per-country (a snipe is one country's player passing
  // another). The Global aggregate has no such notion, so point readers to Maps.
  if (selectedIsGlobal) {
    return (
      <div className="flex-1">
        <PageHeader iconSrc="/images/icons/snipes.svg" title={t`Global mania snipes`} />
        <div className="relative max-w-[1200px] mx-auto px-4 sm:px-5 py-12 sm:py-20">
          <div className="mx-auto max-w-md rounded-xl border border-osu-b3/30 bg-osu-b4/80 px-6 py-10 text-center backdrop-blur-sm">
            <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-osu-pink/15 text-osu-pink-light">
              <Globe className="h-6 w-6" strokeWidth={2.2} />
            </span>
            <p className="mt-5 text-sm font-medium text-osu-c2"><Trans>Snipes don't apply to Global</Trans></p>
            <p className="mt-2 text-[12px] leading-relaxed text-osu-f1">
              <Trans>
                A snipe is one country's player overtaking another on a board, so it
                only makes sense within a single country. Pick a country to see its
                snipes, or explore the combined Maps view.
              </Trans>
            </p>
            <Link
              to="/maps"
              search={{ tab: "farmed", country: selectedCountry, page: 0 } as never}
              className="mt-5 inline-flex items-center gap-1.5 rounded-lg bg-osu-pink/20 px-3.5 py-2 text-[12px] font-semibold text-osu-pink-light transition-colors hover:bg-osu-pink/30 hover:text-white"
            >
              <Globe className="h-3.5 w-3.5" strokeWidth={2.4} />
              <Trans>Explore Global maps</Trans>
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1">
      <PageHeader
        iconSrc="/images/icons/snipes.svg"
        title={t`${countryName} mania snipes`}
        right={
          <div className="flex items-center gap-2">
            {(loading || refreshing) && !error && (
              <div className="flex items-center gap-1.5">
                <div className="w-3 h-3 border-2 border-osu-pink/40 border-t-osu-pink rounded-full animate-spin" />
                <span className="text-[10px] text-osu-f1">
                  {loading ? <Trans>Loading...</Trans> : <Trans>Refreshing...</Trans>}
                </span>
              </div>
            )}
            {!loading && !refreshing && !error && visibleSnipes.length > 0 && (
              <span className="text-[10px] text-osu-f1">
                <Plural value={sorted.length} one="# snipe" other="# snipes" />
                {snipesFetchedAt ? t` · updated ${formatTimeAgo(new Date(snipesFetchedAt).toISOString())}` : ""}
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
      <div className="relative overflow-hidden bg-osu-b5">
      <OsuTriangleBackdrop />
      {/* ── Filter bar ─────────────────────────────────────────────────── */}
      <div className="relative z-20 bg-osu-d5/90 border-b border-osu-b3/20">
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
              <span><Trans>Filters</Trans></span>
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
                <h3 className="text-[12px] font-bold text-osu-l2 uppercase tracking-wider"><Trans>Filters</Trans></h3>
                {activeFilterCount > 0 && (
                  <span className="inline-flex min-w-[18px] h-[18px] shrink-0 items-center justify-center self-center rounded-full bg-osu-pink/30 px-1 text-[10px] font-bold leading-none text-osu-pink-light tabular-nums">
                    <span className="relative -top-px">{activeFilterCount}</span>
                  </span>
                )}
              </div>
              <button
                onClick={() => setFiltersOpen(false)}
                aria-label={t`Close filters`}
                className="p-1 text-osu-f1 hover:text-white transition-colors cursor-pointer"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>

            <FilterField label={t`Range`}>
              <SegmentedControl
                id="snipes-range"
                value={search.range}
                className="max-sm:flex max-sm:w-full max-sm:*:flex-1"
                options={[
                  { value: "24h", label: t`24h` },
                  { value: "7d", label: t`7 days` },
                  { value: "30d", label: t`30 days` },
                ] satisfies SegmentedOption<RangeFilter>[]}
                onChange={(range) => updateSearch({ range, page: 0 })}
              />
            </FilterField>

            <FilterField label={t`Keys`}>
              <SegmentedControl
                id="snipes-keys"
                value={search.keys}
                className="max-sm:flex max-sm:w-full max-sm:*:flex-1"
                options={[
                  { value: "all", label: t`All` },
                  { value: "4k", label: "4K" },
                  { value: "7k", label: "7K" },
                ] satisfies SegmentedOption<KeyFilter>[]}
                onChange={(keys) => updateSearch({ keys, page: 0 })}
              />
            </FilterField>

          </div>

          {hasActiveFilters && (
            <button
              onClick={resetFilters}
              className="text-[10px] text-osu-pink-light hover:text-white transition-colors cursor-pointer"
            >
              <Trans>Clear filters</Trans>
            </button>
          )}
        </div>
      </div>

      {/* ── Content ────────────────────────────────────────────────────── */}
      <div className="relative z-10">
        <div className="max-w-[1200px] mx-auto px-4 sm:px-5 py-6">
          {error && (
            <div className="text-center py-16 text-osu-f1 text-sm">{error}</div>
          )}

          {!error && (
            <>
              {loading && snipes.length === 0 && (
                <div className="flex items-center justify-center gap-2 py-20 text-osu-f1 text-xs">
                  <div className="w-3 h-3 border-2 border-osu-pink/40 border-t-osu-pink rounded-full animate-spin" />
                  <span>{t`Loading ${countryName} snipes…`}</span>
                </div>
              )}

              {!loading && sorted.length === 0 && visibleSnipes.length === 0 && (
                <div className="text-center py-16 text-osu-f1 text-sm">
                  <p><Trans>No snipes tracked yet for {countryName}.</Trans></p>
                  <p className="mt-1 text-[11px]">
                    <Trans>
                      Snipes appear when tracked country players push each other down a beatmap's country leaderboard.
                    </Trans>
                  </p>
                </div>
              )}

              {!loading && sorted.length === 0 && visibleSnipes.length > 0 && (
                <div className="text-center py-16 text-osu-f1 text-sm">
                  <p><Trans>No snipes match the current filters.</Trans></p>
                  {hasActiveFilters && (
                    <button onClick={resetFilters} className="mt-2 text-[11px] text-osu-pink-light hover:text-white cursor-pointer">
                      <Trans>Clear filters</Trans>
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
                        country={selectedCountry}
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
      </div>
      )}
    </div>
  );
}

// ── Snipe row ─────────────────────────────────────────────────────────────

function SnipeRow({
  event,
  eventKey,
  country,
  expanded,
  onToggle,
}: {
  event: SnipeEvent;
  eventKey: string;
  country: string;
  expanded: boolean;
  onToggle: (key: string) => void;
}) {
  const { t } = useLingui();
  const navigate = useNavigate();

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
    // Seeded boards routinely displace scores from years back, and "1631 days"
    // is not a figure anyone reads.
    if (days >= 365) {
      const years = Math.floor(days / 365);
      return <Plural value={years} one="# year" other="# years" />;
    }
    if (days >= 60) return <Trans>{Math.floor(days / 30)} months</Trans>;
    if (days >= 1) return <Plural value={days} one="# day" other="# days" />;
    const hours = Math.max(1, Math.floor(diff / (60 * 60 * 1000)));
    return <Plural value={hours} one="# hour" other="# hours" />;
  }, [event.timestamp, event.victimTimestamp]);

  const relationLabel = t`sniped`;
  const hasVictimScore = event.victimTotalScore != null && event.victimTotalScore > 0;
  const hasSniperPp = event.pp != null && event.pp > 0;
  const hasVictimPp = event.victimPp != null && event.victimPp > 0;
  const victimPpLeads = hasSniperPp && hasVictimPp && event.victimPp! > event.pp!;

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
          title={t`Open ${event.sniper.username}'s profile`}
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
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5 text-osu-pink-light flex-shrink-0" aria-label={t`sniped`}>
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
                title={t`Open ${event.victim.username}'s profile`}
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

          {/* Row 2: cover + beatmap title + diff + keys + board rank */}
          <div className="flex items-center justify-between sm:justify-start gap-2 mt-1">
            <div className="flex items-center gap-2 min-w-0">
              <GradeImg grade={event.rank} size={20} />
              {event.beatmapset.cover_url && (
                <img
                  src={event.beatmapset.cover_url}
                  alt=""
                  loading="lazy"
                  className="h-6 w-9 flex-shrink-0 rounded object-cover"
                />
              )}
              <div className="min-w-0">
                <div className="flex items-baseline gap-2 min-w-0">
                  {beatmapHref ? (
                    <a
                      href={beatmapHref}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="text-xs text-white truncate hover:text-osu-pink-light underline-offset-2 hover:underline"
                      title={t`Open beatmap on osu!`}
                    >
                      {event.beatmapset.title}
                    </a>
                  ) : (
                    <span className="text-xs text-white truncate">{event.beatmapset.title}</span>
                  )}
                  <span className="text-[10px] text-osu-f1 truncate">[{event.beatmap.version}]</span>
                </div>
                <div className="text-[10px] text-osu-f1 truncate">{event.beatmapset.artist}</div>
              </div>
            </div>
            <div className="flex flex-shrink-0 items-center gap-1.5">
              {/* The board position taken is what separates a headline snipe
                  from a routine one, and it was only ever shown in Discord. */}
              {event.boardRank != null && event.boardRank > 0 && (
                <span
                  className="rounded bg-osu-pink/15 px-1.5 py-0.5 text-[9px] font-bold tabular-nums text-osu-pink-light"
                  title={t`Took the country board's #${event.boardRank} spot`}
                >
                  #{event.boardRank}
                </span>
              )}
              {keys > 0 && (
                <span className="rounded bg-osu-b3/50 px-1 py-0.5 text-[8px] font-bold text-osu-yellow">
                  {keys}K
                </span>
              )}
            </div>
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
              title={t`Watch replay`}
            >
              <Trans>&#9654; Watch</Trans>
            </button>
          )}
          <span className="text-[10px] text-osu-f1 w-12 text-right">
            {formatTimeAgo(event.timestamp)}
          </span>
        </div>
      </div>

      {expanded && (
        <div
          className="relative px-4 pb-3 pt-2 border-t border-osu-b3/20 overflow-hidden detail-enter"
        >
          {event.beatmapset.cover_url && <CoverBackdrop url={event.beatmapset.cover_url} />}
          {/* A snipe is one score displacing another, so the detail reads as a
              head to head rather than a flat strip of the sniper's numbers.
              The previous holder's score and pp are in the payload and used to
              only show up folded into a "margin" figure. */}
          <div className="relative mx-auto grid w-full max-w-[540px] grid-cols-[1fr_auto_1fr] items-center gap-x-3 gap-y-2 sm:gap-x-6">
            <div className="min-w-0 text-right">
              <UsernameText
                username={event.sniper.username}
                avatarUrl={event.sniper.avatar_url}
                className="block truncate text-xs font-semibold"
              />
              <div className="text-[9px] uppercase tracking-wider text-osu-f1"><Trans>Sniper</Trans></div>
            </div>
            <div className="text-[9px] uppercase tracking-wider text-osu-f1"><Trans>vs</Trans></div>
            <div className="min-w-0 text-left">
              <UsernameText
                username={event.victim.username}
                avatarUrl={event.victim.avatar_url}
                className="block truncate text-xs font-semibold"
              />
              <div className="text-[9px] uppercase tracking-wider text-osu-f1"><Trans>Previously</Trans></div>
            </div>

            <VersusRow
              label={t`Score`}
              sniper={formatNumber(event.totalScore)}
              victim={hasVictimScore ? formatNumber(event.victimTotalScore!) : null}
              sniperLeads
            />
            {(hasSniperPp || hasVictimPp) && (
              <VersusRow
                label="PP"
                sniper={hasSniperPp ? `${Math.round(event.pp!)}pp` : "-"}
                victim={hasVictimPp ? `${Math.round(event.victimPp!)}pp` : "-"}
                // Mania totalScore rides on combo, so the sniper can take the
                // board with the weaker play. Worth calling out rather than
                // colouring them as the winner across the board.
                sniperLeads={!victimPpLeads}
              />
            )}
            <VersusRow
              label={t`Set`}
              sniper={formatTimeAgo(event.timestamp)}
              victim={previousScoreAge ? <Trans>{previousScoreAge} earlier</Trans> : formatTimeAgo(event.victimTimestamp)}
              sniperLeads={false}
              muted
            />
          </div>

          <div className="relative mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-osu-b3/20 pt-2.5 text-[10px] text-osu-f1">
            {hasVictimScore && (
              <span>
                <Trans>Margin <strong className="font-bold tabular-nums text-osu-pink-light">+{formatNumber(Math.max(0, event.totalScore - event.victimTotalScore!))}</strong></Trans>
              </span>
            )}
            <span>
              <Trans>Accuracy <strong className="font-bold tabular-nums text-osu-l2">{formatAccuracy(event.accuracy)}</strong></Trans>
            </span>
            <span>
              <Trans>Stars <strong className="font-bold tabular-nums text-white">{event.beatmap.difficulty_rating.toFixed(2)}</strong></Trans>
            </span>
            {event.boardRank != null && event.boardRank > 0 && (
              <span>
                <Trans>Board spot <strong className="font-bold tabular-nums text-osu-pink-light">#{event.boardRank}</strong></Trans>
              </span>
            )}
            {victimPpLeads && (
              <span className="text-osu-yellow"><Trans>Won on score, not pp</Trans></span>
            )}
            <a
              href={beatmapHref}
              target="_blank"
              rel="noreferrer"
              className="ml-auto flex-shrink-0 underline-offset-2 transition-colors hover:text-osu-pink-light hover:underline"
            >
              <Trans>View beatmap →</Trans>
            </a>
          </div>

          <SnipeBoard event={event} country={country} />
        </div>
      )}
    </div>
  );
}

// ── Country board behind the snipe ────────────────────────────────────────

const BOARD_LIMIT = 50;
const BOARD_COLLAPSED_ROWS = 10;
// Boards only move when someone scores on that exact lane, so one fetch per
// beatmap survives collapsing and re-expanding rows (and the many rows that
// share a map on a busy feed).
const boardCache = new Map<string, LiveSnipeBoardSnapshot>();

function boardCacheKey(country: string, event: SnipeEvent): string {
  return `${country}:${event.beatmap_id}:${event.mods.join("+")}:${event.isLazer ? "lazer" : "stable"}`;
}

/**
 * The full country board the snipe happened on, in the same order the backend
 * ranks it. Loaded on expand, so a feed of 25 rows costs nothing until someone
 * opens one.
 */
function SnipeBoard({ event, country }: { event: SnipeEvent; country: string }) {
  const cacheKey = boardCacheKey(country, event);
  const [board, setBoard] = useState<LiveSnipeBoardSnapshot | null>(() => boardCache.get(cacheKey) ?? null);
  const [error, setError] = useState(false);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    const cached = boardCache.get(cacheKey);
    if (cached) {
      setBoard(cached);
      return;
    }
    const controller = new AbortController();
    setBoard(null);
    setError(false);
    fetchLiveSnipeBoard(country, event.beatmap_id, { mods: event.mods, isLazer: event.isLazer, limit: BOARD_LIMIT }, { signal: controller.signal })
      .then((snapshot) => {
        boardCache.set(cacheKey, snapshot);
        setBoard(snapshot);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      });
    return () => controller.abort();
  }, [cacheKey, country, event.beatmap_id, event.isLazer, event.mods]);

  if (error) {
    return (
      <div className="relative mt-3 border-t border-osu-b3/20 pt-2.5 text-[10px] text-osu-f1">
        <Trans>Couldn't load the board.</Trans>
      </div>
    );
  }

  return (
    <div className="relative mt-3 border-t border-osu-b3/20 pt-2.5">
      <div className="flex items-baseline justify-between gap-3 text-[10px] uppercase tracking-wider text-osu-f1">
        <span><Trans>Leaderboard</Trans></span>
        {board != null && (
          <span className="tabular-nums normal-case tracking-normal">
            {board.total > board.entries.length
              ? <Trans>Top {board.entries.length} of {formatNumber(board.total)}</Trans>
              : <Plural value={board.total} one="# score" other="# scores" />}
          </span>
        )}
      </div>

      {board == null ? (
        <div className="flex items-center gap-2 py-3 text-[10px] text-osu-f1">
          <div className="w-2.5 h-2.5 border-2 border-osu-pink/40 border-t-osu-pink rounded-full animate-spin" />
          <span><Trans>Loading board…</Trans></span>
        </div>
      ) : board.entries.length === 0 ? (
        <div className="py-3 text-[10px] text-osu-f1"><Trans>No board stored for this lane yet.</Trans></div>
      ) : (
        <BoardRows board={board} event={event} showAll={showAll} onShowAll={() => setShowAll(true)} />
      )}
    </div>
  );
}

/**
 * A long board doesn't get to swallow the page: it shows the head plus the two
 * players this snipe is about, and opens fully on request.
 */
function BoardRows({
  board,
  event,
  showAll,
  onShowAll,
}: {
  board: LiveSnipeBoardSnapshot;
  event: SnipeEvent;
  showAll: boolean;
  onShowAll: () => void;
}) {
  // Seeded boards can carry no pp at all; a column of dashes says less than no column.
  const showPp = board.entries.some((row) => row.pp != null && row.pp > 0);
  const highlightOf = (userId: number): "sniper" | "victim" | null =>
    userId === event.sniper.id ? "sniper" : userId === event.victim.id ? "victim" : null;

  const head = showAll ? board.entries : board.entries.slice(0, BOARD_COLLAPSED_ROWS);
  const tail = showAll ? [] : board.entries.slice(BOARD_COLLAPSED_ROWS).filter((entry) => highlightOf(entry.user.id));
  const hidden = board.entries.length - head.length - tail.length;

  return (
    <div className="mt-1">
      {head.map((entry) => (
        <SnipeBoardRow key={entry.scoreId} entry={entry} showPp={showPp} highlight={highlightOf(entry.user.id)} />
      ))}
      {tail.length > 0 && <div className="py-0.5 pl-2 text-[10px] leading-none text-osu-f1">···</div>}
      {tail.map((entry) => (
        <SnipeBoardRow key={entry.scoreId} entry={entry} showPp={showPp} highlight={highlightOf(entry.user.id)} />
      ))}
      {hidden > 0 && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onShowAll();
          }}
          className="mt-1 cursor-pointer text-[10px] text-osu-pink-light transition-colors hover:text-white"
        >
          <Trans>Show all {formatNumber(board.entries.length)}</Trans>
        </button>
      )}
    </div>
  );
}

function SnipeBoardRow({
  entry,
  showPp,
  highlight,
}: {
  entry: LiveSnipeBoardEntry;
  showPp: boolean;
  highlight: "sniper" | "victim" | null;
}) {
  const { t } = useLingui();
  // Names carry their own accent color, so the two rows this snipe is about are
  // marked by the row itself rather than by text color.
  const rowTint = highlight === "sniper" ? "bg-osu-pink/10" : highlight === "victim" ? "bg-osu-b3/40" : "";
  return (
    <div className={`grid grid-cols-[1.75rem_1fr_auto] items-center gap-2 rounded py-1 pr-1.5 ${rowTint}`}>
      <span className={`text-right text-[11px] font-bold tabular-nums ${highlight === "sniper" ? "text-osu-pink-light" : "text-osu-f1"}`}>
        #{entry.position}
      </span>
      <button
        onClick={(e) => {
          e.stopPropagation();
          window.location.href = `/player/${encodeURIComponent(entry.user.username)}`;
        }}
        className="flex min-w-0 cursor-pointer items-center gap-1.5 text-left"
        title={t`Open ${entry.user.username}'s profile`}
      >
        <Avatar url={entry.user.avatar_url} size={18} />
        <UsernameText
          username={entry.user.username}
          avatarUrl={entry.user.avatar_url}
          className="truncate text-xs font-medium text-white"
        />
        {entry.mods.map((mod) => (
          <ModBadge key={mod} mod={mod} size={0.55} />
        ))}
        {entry.isLazer && <LazerBadge />}
      </button>
      <div className="flex flex-shrink-0 items-center gap-2.5 tabular-nums">
        <span className="text-[10px] text-osu-f1 hidden sm:inline">{formatAccuracy(entry.accuracy)}</span>
        <span className="text-xs font-bold text-white">{formatNumber(entry.totalScore)}</span>
        {showPp && (
          <span className="w-12 text-right text-[11px] text-osu-l2">
            {entry.pp != null && entry.pp > 0 ? `${Math.round(entry.pp)}pp` : "-"}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * One metric across the snipe: the sniper's figure, the label, then whoever
 * held the spot before. The leading side keeps full contrast so the comparison
 * is readable at a glance without an extra marker.
 */
function VersusRow({
  label,
  sniper,
  victim,
  sniperLeads,
  muted = false,
}: {
  label: string;
  sniper: string;
  victim: ReactNode | null;
  sniperLeads: boolean;
  muted?: boolean;
}) {
  const winner = muted ? "text-osu-l2" : "text-white";
  const loser = "text-osu-f1";
  return (
    <>
      <div className={`text-right text-sm font-bold tabular-nums ${sniperLeads ? winner : loser}`}>{sniper}</div>
      <div className="text-[9px] font-semibold uppercase tracking-[0.14em] text-osu-f1">{label}</div>
      <div className={`text-left text-sm font-bold tabular-nums ${!sniperLeads && !muted ? winner : loser}`}>
        {victim ?? "-"}
      </div>
    </>
  );
}
