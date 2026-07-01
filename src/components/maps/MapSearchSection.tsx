import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  fetchLiveMapSearch,
  type LiveMapSearchEntry,
  type LiveMapSearchResult,
} from "../../lib/live-backend";
import { formatDuration, formatNumber } from "../../lib/format";
import { Pagination } from "../ui/Pagination";
import { Skeleton } from "../ui/LoadingSkeleton";
import { MapDetailModal } from "./MapDetailModal";
import { PatternPicker } from "./PatternPicker";
import { RangeSlider } from "./RangeSlider";
import { SearchCard } from "./SearchCard";

const SEARCH_PAGE_SIZE = 24;
const SEARCH_INITIAL_SKELETON_COUNT = 12;
const SEARCH_DEBOUNCE_MS = 300;

const KEY_OPTIONS = [
  { id: "4k", label: "4K" },
  { id: "7k", label: "7K" },
  { id: "other", label: "Other" },
];

const STATUS_OPTIONS = [
  { id: "ranked", label: "Ranked" },
  { id: "loved", label: "Loved" },
  { id: "graveyard", label: "Graveyard" },
  { id: "other", label: "Pending" },
];

// Match beatmapStatusBadgeClass() in maps.tsx so the filters read like the badges
// on the cards: green ranked, pink loved, grey graveyard, yellow pending.
const STATUS_COLOR: Record<string, string> = {
  ranked: "#6cf27f",
  loved: "#f26fa6",
  graveyard: "#b3b3b3",
  other: "#ffd36b",
};

const SORT_OPTIONS = [
  { id: "playcount", label: "Most played" },
  { id: "stars", label: "Difficulty" },
  { id: "bpm", label: "BPM" },
  { id: "length", label: "Length" },
  { id: "date", label: "Newest" },
];

export interface MapSearchUiState {
  q: string;
  keys: string[];
  statuses: string[];
  patterns: string[];
  starMin: number;
  starMax: number;
  bpmMin: number;
  bpmMax: number;
  lenMin: number;
  lenMax: number;
  sort: string;
  dir: string;
  page: number;
}

interface Props {
  state: MapSearchUiState;
  onChange: (patch: Partial<MapSearchUiState>) => void;
  liveBackendEnabled: boolean;
}

function toggle(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

// Order-independent identity of a filter set, so we can tell our own URL echo
// (ignore) from a real back/forward navigation (adopt).
function stateKey(s: MapSearchUiState): string {
  return JSON.stringify([
    s.q,
    [...s.keys].sort(),
    [...s.statuses].sort(),
    [...s.patterns].sort(),
    s.starMin, s.starMax, s.bpmMin, s.bpmMax, s.lenMin, s.lenMax,
    s.sort, s.dir, s.page,
  ]);
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      whileTap={{ scale: 0.94 }}
      transition={{ type: "spring", stiffness: 600, damping: 32 }}
      className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12.5px] font-semibold cursor-pointer transition-colors duration-100 ${
        active ? "bg-osu-pink text-white" : "bg-osu-b4 text-osu-l2 hover:bg-osu-b3 hover:text-osu-l1"
      }`}
    >
      {children}
    </motion.button>
  );
}

// Status chips styled as the card status badges: solid coloured pill when on,
// outlined in the same colour when off.
function StatusChip({ id, label, active, onClick }: { id: string; label: string; active: boolean; onClick: () => void }) {
  const color = STATUS_COLOR[id] ?? "#ffd36b";
  return (
    <motion.button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      whileTap={{ scale: 0.94 }}
      transition={{ type: "spring", stiffness: 600, damping: 32 }}
      className="inline-flex items-center rounded-full px-3 py-1.5 text-[11px] font-extrabold uppercase tracking-wide leading-none cursor-pointer transition-colors duration-100"
      style={
        active
          ? { background: color, color: "#11111a" }
          : { background: "transparent", color, boxShadow: `inset 0 0 0 1.5px ${color}59` }
      }
    >
      {label}
    </motion.button>
  );
}

function ChipGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-osu-f1/55">{label}</span>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  );
}

function SearchCardSkeleton() {
  return (
    <div className="overflow-hidden rounded-xl border border-osu-b3/20 bg-osu-b4">
      <div className="relative h-[90px]">
        <Skeleton className="h-full w-full rounded-none" />
        <Skeleton className="absolute left-1.5 top-1.5 h-4 w-8 rounded" />
        <Skeleton className="absolute right-1.5 top-1.5 h-4 w-12 rounded" />
        <Skeleton className="absolute bottom-1.5 right-1.5 h-4 w-14 rounded-full" />
        <div className="absolute bottom-1.5 left-2.5 right-20 flex flex-col gap-1">
          <Skeleton className="h-3 w-4/5" />
          <Skeleton className="h-2.5 w-1/2" />
        </div>
      </div>

      <div className="flex flex-col gap-1.5 px-2.5 py-2">
        <div className="flex items-center justify-between gap-2">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-2.5 w-8" />
        </div>
        <div className="flex items-center gap-1">
          <Skeleton className="h-4 w-12 rounded" />
          <Skeleton className="h-4 w-14 rounded" />
          <Skeleton className="h-4 w-12 rounded" />
        </div>
        <div className="flex items-center justify-between gap-2 pt-1">
          <Skeleton className="h-2.5 w-16" />
          <div className="flex items-center gap-1.5">
            <Skeleton className="h-4 w-10 rounded" />
            <Skeleton className="h-4 w-10 rounded" />
          </div>
        </div>
      </div>
    </div>
  );
}

function SearchCardGridSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4" aria-hidden="true">
      {Array.from({ length: SEARCH_INITIAL_SKELETON_COUNT }).map((_, index) => (
        <SearchCardSkeleton key={index} />
      ))}
    </div>
  );
}

export function MapSearchSection({ state, onChange, liveBackendEnabled }: Props) {
  // Local source of truth so a tap updates the grid on the same frame; the URL
  // still syncs underneath (shareable links, back/forward) without gating the fetch.
  const [ui, setUi] = useState<MapSearchUiState>(state);
  const [searchInput, setSearchInput] = useState(state.q);
  const [showMore, setShowMore] = useState(state.bpmMin > 0 || state.bpmMax > 0 || state.lenMin > 0 || state.lenMax > 0);
  const [result, setResult] = useState<LiveMapSearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<LiveMapSearchEntry | null>(null);
  const lastResultRef = useRef<LiveMapSearchResult | null>(null);
  const uiRef = useRef(ui);
  uiRef.current = ui;
  // Keys we've pushed to the URL but not yet seen echo back, so a stale echo from
  // a rapid tap sequence can't revert a newer local state.
  const pendingKeys = useRef<Set<string>>(new Set());

  // Adopt genuine external navigations (back/forward, clear); skip our own echoes.
  useEffect(() => {
    const key = stateKey(state);
    if (pendingKeys.current.has(key)) {
      pendingKeys.current.delete(key);
      return;
    }
    if (key !== stateKey(uiRef.current)) {
      setUi(state);
      uiRef.current = state;
      setSearchInput(state.q);
      pendingKeys.current.clear();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  // Filter changes apply instantly to local state, then sync to the URL.
  const apply = (patch: Partial<MapSearchUiState>) => {
    const next = { ...uiRef.current, ...patch };
    uiRef.current = next;
    pendingKeys.current.add(stateKey(next));
    setUi(next);
    onChange(patch);
  };

  // Free text is debounced so we don't refetch per keystroke.
  useEffect(() => {
    if (searchInput === ui.q) return;
    const timer = window.setTimeout(() => apply({ q: searchInput, page: 0 }), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput, ui.q]);

  const requestKey = useMemo(
    () => JSON.stringify(ui),
    [ui],
  );

  useEffect(() => {
    if (!liveBackendEnabled) {
      setLoading(false);
      setError("Search needs the live backend running.");
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchLiveMapSearch({
      q: ui.q,
      keys: ui.keys,
      statuses: ui.statuses,
      patterns: ui.patterns,
      starMin: ui.starMin > 0 ? ui.starMin : null,
      starMax: ui.starMax > 0 ? ui.starMax : null,
      bpmMin: ui.bpmMin > 0 ? ui.bpmMin : null,
      bpmMax: ui.bpmMax > 0 ? ui.bpmMax : null,
      lenMin: ui.lenMin > 0 ? ui.lenMin : null,
      lenMax: ui.lenMax > 0 ? ui.lenMax : null,
      country: null,
      sort: ui.sort,
      dir: ui.dir,
      page: ui.page,
      pageSize: SEARCH_PAGE_SIZE,
    })
      .then((data) => {
        if (cancelled) return;
        setResult(data);
        lastResultRef.current = data;
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setError("Couldn't load search results. Try again.");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey, liveBackendEnabled]);

  const items = result?.items ?? lastResultRef.current?.items ?? [];
  const total = result?.total ?? lastResultRef.current?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / SEARCH_PAGE_SIZE));
  const effectiveError = liveBackendEnabled ? error : "Search needs the live backend running.";
  const hasLoadedResult = result !== null || lastResultRef.current !== null;
  const showLoadingSkeleton = !effectiveError && liveBackendEnabled && (loading || !hasLoadedResult) && items.length === 0;
  const countLabel = showLoadingSkeleton
    ? "Loading maps..."
    : loading && hasLoadedResult
      ? `${formatNumber(total)} maps · updating`
      : `${formatNumber(total)} maps`;

  const hasActiveFilters =
    ui.q.trim() !== "" ||
    ui.keys.length > 0 ||
    ui.statuses.length > 0 ||
    ui.patterns.length > 0 ||
    ui.starMin > 0 || ui.starMax > 0 ||
    ui.bpmMin > 0 || ui.bpmMax > 0 ||
    ui.lenMin > 0 || ui.lenMax > 0;

  const clearFilters = () => {
    setSearchInput("");
    apply({
      q: "", keys: [], statuses: [], patterns: [],
      starMin: 0, starMax: 0, bpmMin: 0, bpmMax: 0, lenMin: 0, lenMax: 0,
      page: 0,
    });
  };

  return (
    <div className="bg-osu-d5 min-h-[60vh]">
      <div className="max-w-[1200px] mx-auto px-4 sm:px-5 py-4 flex flex-col gap-4">
        {/* Search bar */}
        <div className="flex items-center gap-3">
          <div className="relative flex-1">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-osu-f1/50">
              <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
            </svg>
            <input
              type="text"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search title, artist, mapper, or difficulty"
              aria-label="Search maps"
              className="w-full bg-osu-b4 border border-osu-b3/30 rounded-lg pl-10 pr-3 py-2.5 text-[14px] text-osu-l1 placeholder:text-osu-f1/55 focus:outline-none focus:border-osu-pink/50 transition-colors"
            />
          </div>
          <span className="shrink-0 text-[12px] text-osu-f1 tabular-nums" role="status" aria-live="polite">
            {countLabel}
          </span>
        </div>

        {/* Pattern — the headline filter, each shown as a mini note-chart */}
        <div className="flex flex-col gap-2">
          <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-osu-f1/55">Pattern</span>
          <PatternPicker selected={ui.patterns} onToggle={(pattern) => apply({ patterns: toggle(ui.patterns, pattern), page: 0 })} />
        </div>

        <div className="flex flex-wrap gap-x-10 gap-y-4">
          <ChipGroup label="Keys">
            {KEY_OPTIONS.map((option) => (
              <Chip key={option.id} active={ui.keys.includes(option.id)} onClick={() => apply({ keys: toggle(ui.keys, option.id), page: 0 })}>
                {option.label}
              </Chip>
            ))}
          </ChipGroup>
          <ChipGroup label="Status">
            {STATUS_OPTIONS.map((option) => (
              <StatusChip
                key={option.id}
                id={option.id}
                label={option.label}
                active={ui.statuses.includes(option.id)}
                onClick={() => apply({ statuses: toggle(ui.statuses, option.id), page: 0 })}
              />
            ))}
          </ChipGroup>
        </div>

        <ChipGroup label="Difficulty">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <RangeSlider lo={0} hi={15} min={ui.starMin} max={ui.starMax} step={0.1} ariaLabel="Star rating" format={(v) => `${v.toFixed(1)}★`} onChange={(min, max) => apply({ starMin: min, starMax: max, page: 0 })} />
            <button type="button" onClick={() => setShowMore((value) => !value)} className="text-[11.5px] text-osu-f1 hover:text-osu-pink-light transition-colors cursor-pointer">
              {showMore ? "− bpm & length" : "+ bpm & length"}
            </button>
          </div>
        </ChipGroup>

        {showMore && (
          <div className="flex flex-wrap gap-x-10 gap-y-4">
            <ChipGroup label="BPM">
              <RangeSlider lo={0} hi={400} min={ui.bpmMin} max={ui.bpmMax} step={5} ariaLabel="BPM" onChange={(min, max) => apply({ bpmMin: min, bpmMax: max, page: 0 })} />
            </ChipGroup>
            <ChipGroup label="Length">
              <RangeSlider lo={0} hi={600} min={ui.lenMin} max={ui.lenMax} step={5} ariaLabel="Length" format={(v) => formatDuration(v)} onChange={(min, max) => apply({ lenMin: min, lenMax: max, page: 0 })} />
            </ChipGroup>
          </div>
        )}

        {/* Sort + actions */}
        <div className="flex flex-wrap items-end justify-between gap-3 border-t border-osu-b3/15 pt-3.5">
          <ChipGroup label="Sort by">
            {SORT_OPTIONS.map((option) => (
              <Chip key={option.id} active={ui.sort === option.id} onClick={() => apply({ sort: option.id, page: 0 })}>
                {option.label}
              </Chip>
            ))}
            <motion.button
              type="button"
              whileTap={{ scale: 0.94 }}
              onClick={() => apply({ dir: ui.dir === "asc" ? "desc" : "asc", page: 0 })}
              className="inline-flex items-center justify-center rounded-md px-2.5 py-1.5 bg-osu-b4 text-osu-l2 hover:bg-osu-b3 hover:text-osu-l1 transition-colors cursor-pointer"
              title={ui.dir === "asc" ? "Ascending" : "Descending"}
              aria-label={ui.dir === "asc" ? "Ascending" : "Descending"}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true">
                {ui.dir === "asc" ? <path d="M12 19V5m-6 6 6-6 6 6" /> : <path d="M12 5v14m-6-6 6 6 6-6" />}
              </svg>
            </motion.button>
          </ChipGroup>
          <div className="flex items-center gap-3 pb-1">
            {hasActiveFilters && (
              <button type="button" onClick={clearFilters} className="text-[12px] text-osu-f1 hover:text-osu-pink-light transition-colors cursor-pointer">
                Clear all
              </button>
            )}
          </div>
        </div>

        {/* Results */}
        {effectiveError ? (
          <div className="py-16 text-center text-[13px] text-osu-f1">{effectiveError}</div>
        ) : showLoadingSkeleton ? (
          <div className="transition-opacity" aria-busy="true">
            <SearchCardGridSkeleton />
          </div>
        ) : items.length === 0 && !loading ? (
          <div className="py-16 text-center text-[13px] text-osu-f1">No maps match these filters.</div>
        ) : (
          <div className={loading ? "opacity-60 transition-opacity" : "transition-opacity"} aria-busy={loading}>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2.5">
              {items.map((entry: LiveMapSearchEntry) => (
                <SearchCard key={entry.beatmapId} entry={entry} onOpen={setDetail} />
              ))}
            </div>
            <Pagination page={ui.page} totalPages={totalPages} onPageChange={(p) => apply({ page: p })} />
          </div>
        )}
      </div>
      <MapDetailModal entry={detail} onClose={() => setDetail(null)} />
    </div>
  );
}
