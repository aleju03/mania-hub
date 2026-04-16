import { createFileRoute, stripSearchParams, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCountrySnipes, getSnipesScanStatus } from "../lib/osu";
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
import { useAppStore, useSelectedCountry } from "../store";

type KeyFilter = "all" | "4k" | "7k";
type RangeFilter = "24h" | "7d" | "30d" | "all";

type SnipesSearch = {
  keys: KeyFilter;
  range: RangeFilter;
  page: number;
};

const DEFAULT_SNIPES_SEARCH: SnipesSearch = {
  keys: "all",
  range: "7d",
  page: 0,
};

const RANGE_MS: Record<Exclude<RangeFilter, "all">, number> = {
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
  return value === "24h" || value === "30d" || value === "all" ? value : "7d";
}

export const Route = createFileRoute("/snipes")({
  search: {
    middlewares: [stripSearchParams(DEFAULT_SNIPES_SEARCH)],
  },
  validateSearch: (search: Record<string, unknown>): SnipesSearch => ({
    keys: readKeys(search.keys),
    range: readRange(search.range),
    page: typeof search.page === "number" && search.page > 0 ? Math.floor(search.page) : 0,
  }),
  component: SnipesPage,
});

function SnipesPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const selectedCountry = useSelectedCountry();
  const countryName = getCountryName(selectedCountry);

  const snipes = useAppStore((state) => state.snipesByCountry[selectedCountry]) ?? EMPTY_SNIPES;
  const snipesFetchedAt = useAppStore((state) => state.snipesFetchedAtByCountry[selectedCountry]) ?? null;
  const setSnipes = useAppStore((state) => state.setSnipes);

  const [loading, setLoading] = useState(snipes.length === 0);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [scanStartedAt, setScanStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [scanStatus, setScanStatus] = useState<SnipesScanStatus | null>(null);
  const fetchingRef = useRef(false);

  // Render-driving "elapsed" timer for the secondary header indicator.
  useEffect(() => {
    if (scanStartedAt == null) return;
    const tick = () => setElapsed(Date.now() - scanStartedAt);
    tick();
    const id = window.setInterval(tick, 250);
    return () => window.clearInterval(id);
  }, [scanStartedAt]);

  // Poll real scan progress while the request is in flight. The server writes
  // status snapshots to Turso at each phase (and throughout the seed loop);
  // we just read them back on a short interval.
  useEffect(() => {
    if (scanStartedAt == null) {
      setScanStatus(null);
      return;
    }
    let cancelled = false;
    const requestedCountry = selectedCountry;
    const poll = async () => {
      try {
        const status = await getSnipesScanStatus({ data: { country: requestedCountry } });
        if (cancelled) return;
        if (useAppStore.getState().selectedCountry !== requestedCountry) return;
        setScanStatus(status);
      } catch {
        // Status is best-effort; ignore failures so the main fetch isn't disturbed.
      }
    };
    poll();
    const id = window.setInterval(poll, 750);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [scanStartedAt, selectedCountry]);

  const searchRef = useRef(search);
  searchRef.current = search;
  const updateSearch = useCallback(
    (patch: Partial<SnipesSearch>) => {
      navigate({
        to: "/snipes",
        search: { ...searchRef.current, ...patch },
        replace: true,
      });
    },
    [navigate],
  );

  // Reset transient UI state on country switch.
  useEffect(() => {
    setError(null);
    setLoading(snipes.length === 0);
    setRefreshing(false);
    setExpandedKey(null);
    setScanStartedAt(null);
    setElapsed(0);
    fetchingRef.current = false;
    if (search.page !== 0) updateSearch({ page: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCountry]);

  // Fetch snipes when stale. State updates are gated on the country still
  // matching at resolve time so a country switch doesn't write the wrong
  // result. We don't cancel on cleanup — strict-mode double-mounting would
  // otherwise drop the only inflight fetch and leave us stuck loading.
  useEffect(() => {
    if (fetchingRef.current) return;
    const stale = isCacheStale(snipesFetchedAt, CLIENT_CACHE_TTL.snipes);
    if (!stale) {
      setLoading(false);
      return;
    }

    fetchingRef.current = true;
    setLoading(snipes.length === 0);
    if (snipes.length > 0) setRefreshing(true);
    setScanStartedAt(Date.now());
    setElapsed(0);
    const requestedCountry = selectedCountry;

    getCountrySnipes({ data: { country: requestedCountry } })
      .then((events) => {
        setSnipes(requestedCountry, events ?? []);
        if (useAppStore.getState().selectedCountry === requestedCountry) {
          setError(null);
        }
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : "Couldn't load snipes.";
        if (useAppStore.getState().selectedCountry === requestedCountry && snipes.length === 0) {
          setError(message);
        }
      })
      .finally(() => {
        if (useAppStore.getState().selectedCountry === requestedCountry) {
          setLoading(false);
          setRefreshing(false);
          setScanStartedAt(null);
        }
        fetchingRef.current = false;
      });
  }, [selectedCountry, snipesFetchedAt, snipes.length, setSnipes]);

  // ── Filter + sort ──────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    const cutoff = search.range === "all" ? 0 : Date.now() - RANGE_MS[search.range];
    return snipes.filter((event) => {
      const ts = new Date(event.timestamp).getTime();
      if (cutoff && ts < cutoff) return false;
      if (search.keys !== "all") {
        const keys = Math.round(event.beatmap.cs);
        if (search.keys === "4k" && keys !== 4) return false;
        if (search.keys === "7k" && keys !== 7) return false;
      }
      return true;
    });
  }, [snipes, search.range, search.keys]);

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
    updateSearch(DEFAULT_SNIPES_SEARCH);
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
                    : "Refreshing..."}
                </span>
              </div>
            )}
            {!loading && !refreshing && !error && snipes.length > 0 && (
              <span className="text-[10px] text-osu-f1">
                {sorted.length} {sorted.length === 1 ? "snipe" : "snipes"}
                {snipesFetchedAt ? ` · updated ${formatTimeAgo(new Date(snipesFetchedAt).toISOString())}` : ""}
              </span>
            )}
          </div>
        }
      />

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
                <ScanProgress
                  elapsed={elapsed}
                  countryName={countryName}
                  status={scanStatus}
                />
              )}

              {!loading && sorted.length === 0 && snipes.length === 0 && (
                <div className="text-center py-16 text-osu-f1 text-sm">
                  <p>No snipes tracked yet for {countryName}.</p>
                  <p className="mt-1 text-[11px]">Snipes appear as country players reclaim #1s on country leaderboards.</p>
                </div>
              )}

              {!loading && sorted.length === 0 && snipes.length > 0 && (
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
  const [rendered, setRendered] = useState(expanded);
  useEffect(() => {
    if (expanded) setRendered(true);
  }, [expanded]);

  const keys = Math.round(event.beatmap.cs);
  const sniperHref = `/player/${encodeURIComponent(event.sniper.username)}`;
  const previousHref = `/player/${encodeURIComponent(event.victim.username)}`;
  const beatmapHref = event.beatmap.url;
  const replayHref = event.hasReplay
    ? `/replay?scoreId=${event.score_id}&beatmapsetId=${event.beatmapset_id}`
    : null;

  const heldFor = useMemo(() => {
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
        {/* Cover thumb (desktop only) */}
        {event.beatmapset.cover_url && (
          <div
            className="hidden sm:block w-9 h-9 rounded flex-shrink-0 bg-cover bg-center"
            style={{ backgroundImage: `url(${event.beatmapset.cover_url})` }}
          />
        )}

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
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3 h-3 text-osu-f1 flex-shrink-0">
                <line x1="5" y1="12" x2="19" y2="12" />
                <polyline points="12 5 19 12 12 19" />
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
              {replayHref && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    window.location.href = replayHref;
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
          {replayHref && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                window.location.href = replayHref;
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
          <div className="relative grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-5 gap-3 text-center">
            <StatCell label="Score" value={formatNumber(event.totalScore)} />
            <StatCell label="Accuracy" value={formatAccuracy(event.accuracy)} color="text-osu-l2" />
            {event.pp != null && event.pp > 0 && (
              <StatCell label="PP" value={`${Math.round(event.pp)}pp`} color="text-osu-pink" />
            )}
            <StatCell label="Stars" value={event.beatmap.difficulty_rating.toFixed(2)} />
            {heldFor && (
              <StatCell label="Held for" value={heldFor} color="text-osu-yellow" />
            )}
          </div>
          <div className="relative mt-2 flex items-center justify-between gap-2 text-[10px] text-osu-f1">
            <span>
              {event.boardRank
                ? `${event.sniper.username} sniped #${event.boardRank} from ${event.victim.username}`
                : `${event.sniper.username} sniped ${event.victim.username}`}
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
    <div className="py-1.5">
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

const PHASE_ORDER: SnipesScanStatus["phase"][] = [
  "roster",
  "recent",
  "compare",
  "seed",
  "merge",
];

const PHASE_DESCRIPTIONS: Record<SnipesScanStatus["phase"], string> = {
  roster: "Loading the country's top 15 mania players.",
  recent: "Pulling each player's recent plays from the osu! API.",
  compare: "Cross-checking those plays against the saved country leaderboards.",
  seed: "Probing newly-encountered beatmaps - this is the slow part. 15 API calls per map.",
  merge: "Saving new snipes to the rolling log.",
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
  // Per-phase pct based on real current/total; if we don't yet have a
  // status (the very first poll hasn't returned), show an indeterminate
  // shimmer instead of pretending we've made progress.
  const phasePct =
    status && status.total > 0
      ? Math.min(100, Math.round((status.current / status.total) * 100))
      : 0;
  const description = status ? PHASE_DESCRIPTIONS[status.phase] : "Connecting to the scanner...";

  return (
    <div className="rounded-2xl bg-osu-b4 border border-osu-b3/30 px-5 py-6 sm:px-7 sm:py-8 max-w-2xl mx-auto">
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
                {phase === "seed" && "Seed new beatmaps"}
                {phase === "merge" && "Merge snipe log"}
              </span>
              {isCurrent && status && status.total > 0 && (
                <span className="ml-auto text-osu-f1 tabular-nums">
                  {status.current}/{status.total}
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
