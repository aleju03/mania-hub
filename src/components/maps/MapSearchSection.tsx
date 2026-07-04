import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import {
  fetchLiveMapSearch,
  type LiveMapSearchEntry,
  type LiveMapSearchResult,
} from "../../lib/live-backend";
import { formatDuration, formatNumber } from "../../lib/format";
import { Pagination } from "../ui/Pagination";
import { Skeleton } from "../ui/LoadingSkeleton";
import { MapDetailModal } from "./MapDetailModal";
import { useMapPreviewAudio } from "./MapPreviewAudio";
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

// Custom sort dropdown for the mobile toolbar, styled like the random tab's
// difficulty picker so it doesn't fall back to the OS-native select look.
function SortSelect({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const selected = SORT_OPTIONS.find((option) => option.id === value) ?? SORT_OPTIONS[0];

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Sort by"
        className={`inline-flex items-center gap-1.5 rounded-md pl-3 pr-2 py-2 text-[12.5px] font-semibold cursor-pointer transition-colors ${
          open ? "bg-osu-b3 text-osu-l1" : "bg-osu-b4 text-osu-l2"
        }`}
      >
        {selected.label}
        <svg
          viewBox="0 0 20 20"
          fill="currentColor"
          className={`h-3.5 w-3.5 shrink-0 transition-transform duration-200 ${open ? "rotate-180 text-osu-pink-light" : "text-osu-f1"}`}
          aria-hidden="true"
        >
          <path d="M5.25 7.5 10 12.25 14.75 7.5H5.25Z" />
        </svg>
      </button>

      <div
        role="listbox"
        className={`absolute right-0 top-full z-50 mt-1.5 min-w-[160px] overflow-hidden rounded-lg border border-osu-pink/20 bg-osu-b4/95 shadow-xl shadow-black/40 backdrop-blur-md transition-all duration-200 origin-top ${
          open ? "opacity-100 scale-y-100 translate-y-0 pointer-events-auto" : "opacity-0 scale-y-95 -translate-y-1 pointer-events-none"
        }`}
      >
        <div className="p-1">
          {SORT_OPTIONS.map((option) => {
            const isSelected = option.id === value;
            return (
              <button
                key={option.id}
                type="button"
                role="option"
                aria-selected={isSelected}
                onClick={() => {
                  onChange(option.id);
                  setOpen(false);
                }}
                className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[12px] font-semibold transition-colors cursor-pointer ${
                  isSelected ? "bg-osu-pink/15 text-osu-pink-light" : "text-osu-l2 hover:bg-osu-b3 hover:text-white"
                }`}
              >
                <span className={`flex h-3 w-3 shrink-0 items-center justify-center transition-all ${isSelected ? "opacity-100" : "opacity-0 scale-75"}`}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3 text-osu-pink">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </span>
                {option.label}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function DirButton({ dir, onToggle }: { dir: string; onToggle: () => void }) {
  return (
    <motion.button
      type="button"
      whileTap={{ scale: 0.94 }}
      onClick={onToggle}
      className="inline-flex items-center justify-center rounded-md px-2.5 py-2 bg-osu-b4 text-osu-l2 hover:bg-osu-b3 hover:text-osu-l1 transition-colors cursor-pointer"
      title={dir === "asc" ? "Ascending" : "Descending"}
      aria-label={dir === "asc" ? "Ascending" : "Descending"}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true">
        {dir === "asc" ? <path d="M12 19V5m-6 6 6-6 6 6" /> : <path d="M12 5v14m-6-6 6 6 6-6" />}
      </svg>
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

// The Keys/Status chip groups and range sliders, shared between the desktop
// inline row and the mobile filter sheet.
type ApplyFn = (patch: Partial<MapSearchUiState>) => void;

function KeysChips({ ui, apply }: { ui: MapSearchUiState; apply: ApplyFn }) {
  return (
    <ChipGroup label="Keys">
      {KEY_OPTIONS.map((option) => (
        <Chip key={option.id} active={ui.keys.includes(option.id)} onClick={() => apply({ keys: toggle(ui.keys, option.id), page: 0 })}>
          {option.label}
        </Chip>
      ))}
    </ChipGroup>
  );
}

function StatusChips({ ui, apply }: { ui: MapSearchUiState; apply: ApplyFn }) {
  return (
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
  );
}

function StarSlider({ ui, apply }: { ui: MapSearchUiState; apply: ApplyFn }) {
  return (
    <RangeSlider lo={0} hi={15} min={ui.starMin} max={ui.starMax} step={0.1} ariaLabel="Star rating" format={(v) => `${v.toFixed(1)}★`} onChange={(min, max) => apply({ starMin: min, starMax: max, page: 0 })} />
  );
}

function BpmSlider({ ui, apply }: { ui: MapSearchUiState; apply: ApplyFn }) {
  return (
    <RangeSlider lo={0} hi={400} min={ui.bpmMin} max={ui.bpmMax} step={5} ariaLabel="BPM" onChange={(min, max) => apply({ bpmMin: min, bpmMax: max, page: 0 })} />
  );
}

function LengthSlider({ ui, apply }: { ui: MapSearchUiState; apply: ApplyFn }) {
  return (
    <RangeSlider lo={0} hi={600} min={ui.lenMin} max={ui.lenMax} step={5} ariaLabel="Length" format={(v) => formatDuration(v)} onChange={(min, max) => apply({ lenMin: min, lenMax: max, page: 0 })} />
  );
}

// Bottom sheet holding the secondary filters on phones. Filters apply live (the
// dimmed grid updates behind the scrim); the pink button just closes the sheet.
function MobileFilterSheet({
  open,
  onClose,
  ui,
  apply,
  onClear,
  hasActiveFilters,
  resultsLabel,
}: {
  open: boolean;
  onClose: () => void;
  ui: MapSearchUiState;
  apply: ApplyFn;
  onClear: () => void;
  hasActiveFilters: boolean;
  resultsLabel: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          key="map-filter-sheet"
          className="fixed inset-0 z-[120] sm:hidden"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
        >
          <div className="absolute inset-0 bg-black/70" onClick={onClose} />
          <motion.div
            className="absolute inset-x-0 bottom-0 flex max-h-[85dvh] flex-col rounded-t-2xl bg-osu-b5 ring-1 ring-white/10"
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ duration: 0.2, ease: "easeOut" }}
          >
            <div className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-osu-b3" aria-hidden="true" />
            <span className="px-4 pt-2 text-[13px] font-bold text-osu-l1">Filters</span>
            <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-3.5">
              <KeysChips ui={ui} apply={apply} />
              <StatusChips ui={ui} apply={apply} />
              <ChipGroup label="Difficulty">
                <StarSlider ui={ui} apply={apply} />
              </ChipGroup>
              <ChipGroup label="BPM">
                <BpmSlider ui={ui} apply={apply} />
              </ChipGroup>
              <ChipGroup label="Length">
                <LengthSlider ui={ui} apply={apply} />
              </ChipGroup>
            </div>
            <div className="flex items-center justify-between gap-3 border-t border-osu-b3/20 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
              <button
                type="button"
                onClick={onClear}
                disabled={!hasActiveFilters}
                className={`text-[12px] transition-colors ${
                  hasActiveFilters ? "text-osu-f1 hover:text-osu-pink-light cursor-pointer" : "text-osu-f1/40 cursor-default"
                }`}
              >
                Clear all
              </button>
              <button
                type="button"
                onClick={onClose}
                className="rounded-md bg-osu-pink px-4 py-2 text-[12.5px] font-bold text-white hover:bg-osu-pink-light transition-colors cursor-pointer"
              >
                {resultsLabel}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

function SearchCardSkeleton() {
  return (
    <div className="overflow-hidden rounded-xl border border-osu-b3/20 bg-osu-b4">
      <div className="relative h-[100px]">
        <Skeleton className="h-full w-full rounded-none" />
        <Skeleton className="absolute left-2 top-2 h-[18px] w-9 rounded" />
        <Skeleton className="absolute right-2 top-2 h-[18px] w-14 rounded" />
        <Skeleton className="absolute bottom-2 right-2 h-[18px] w-16 rounded-full" />
        <div className="absolute bottom-2 left-3 right-20 flex flex-col gap-1.5">
          <Skeleton className="h-3.5 w-4/5" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      </div>

      <div className="flex flex-col gap-2 px-3 py-2.5">
        <div className="flex items-center justify-between gap-2">
          <Skeleton className="h-3.5 w-24" />
          <Skeleton className="h-3 w-9" />
        </div>
        <div className="flex items-center gap-1">
          <Skeleton className="h-5 w-14 rounded" />
          <Skeleton className="h-5 w-16 rounded" />
          <Skeleton className="h-5 w-14 rounded" />
        </div>
        <div className="flex items-center justify-between gap-2 pt-1">
          <div className="flex items-center gap-1.5">
            <Skeleton className="h-7 w-7 rounded-full" />
            <Skeleton className="h-3 w-14" />
          </div>
          <div className="flex items-center gap-1.5">
            <Skeleton className="h-5 w-12 rounded" />
            <Skeleton className="h-5 w-12 rounded" />
          </div>
        </div>
      </div>
    </div>
  );
}

function SearchCardGridSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4" aria-hidden="true">
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
  // On phones the secondary filters live in a bottom sheet behind the toolbar's
  // Filters button; its badge carries the active count.
  const [showFilters, setShowFilters] = useState(false);
  const [result, setResult] = useState<LiveMapSearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<LiveMapSearchEntry | null>(null);
  // Shared audio for the per-card preview buttons; one card playing at a time.
  const preview = useMapPreviewAudio();
  const { stop: stopPreview } = preview;
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

  // A filter/page change swaps the grid out from under the playing card.
  useEffect(() => {
    stopPreview();
  }, [requestKey, stopPreview]);

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
  // No "updating" suffix while refreshing: the label sits next to a flex-1
  // input, so any width change resizes the search bar. It dims instead.
  const countLabel = showLoadingSkeleton ? "Loading maps..." : `${formatNumber(total)} maps`;
  const countRefreshing = loading && hasLoadedResult;

  const hasActiveFilters =
    ui.q.trim() !== "" ||
    ui.keys.length > 0 ||
    ui.statuses.length > 0 ||
    ui.patterns.length > 0 ||
    ui.starMin > 0 || ui.starMax > 0 ||
    ui.bpmMin > 0 || ui.bpmMax > 0 ||
    ui.lenMin > 0 || ui.lenMax > 0;

  // How many collapsed filters are active, for the mobile toggle's badge.
  // Patterns stay visible above the toggle, so they don't count.
  const collapsedFilterCount =
    ui.keys.length +
    ui.statuses.length +
    (ui.starMin > 0 || ui.starMax > 0 ? 1 : 0) +
    (ui.bpmMin > 0 || ui.bpmMax > 0 ? 1 : 0) +
    (ui.lenMin > 0 || ui.lenMax > 0 ? 1 : 0);

  const clearFilters = () => {
    setSearchInput("");
    apply({
      q: "", keys: [], statuses: [], patterns: [],
      starMin: 0, starMax: 0, bpmMin: 0, bpmMax: 0, lenMin: 0, lenMax: 0,
      page: 0,
    });
  };

  return (
    <div className="bg-osu-b5 min-h-[60vh]">
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
          <span
            className={`shrink-0 text-[12px] text-osu-f1 tabular-nums transition-opacity duration-150 ${countRefreshing ? "opacity-45" : ""}`}
            role="status"
            aria-live="polite"
          >
            {countLabel}
          </span>
        </div>

        {/* Pattern — the headline filter, each shown as a mini note-chart */}
        <div className="flex flex-col gap-2">
          <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-osu-f1/55">Pattern</span>
          <PatternPicker selected={ui.patterns} onToggle={(pattern) => apply({ patterns: toggle(ui.patterns, pattern), page: 0 })} />
        </div>

        {/* Mobile toolbar: secondary filters collapse behind a toggle, sort is a dropdown */}
        <div className="flex items-center gap-2 sm:hidden">
          <button
            type="button"
            onClick={() => setShowFilters(true)}
            aria-haspopup="dialog"
            aria-expanded={showFilters}
            className="inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-[12.5px] font-semibold cursor-pointer transition-colors bg-osu-b4 text-osu-l2 hover:bg-osu-b3 hover:text-osu-l1"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5" aria-hidden="true">
              <path d="M3 6h18M7 12h10M10 18h4" />
            </svg>
            Filters
            {collapsedFilterCount > 0 && (
              <span className="rounded-full bg-osu-pink px-1.5 text-[10px] font-bold leading-4 text-white tabular-nums">
                {collapsedFilterCount}
              </span>
            )}
          </button>
          <div className="ml-auto">
            <SortSelect value={ui.sort} onChange={(id) => apply({ sort: id, page: 0 })} />
          </div>
          <DirButton dir={ui.dir} onToggle={() => apply({ dir: ui.dir === "asc" ? "desc" : "asc", page: 0 })} />
        </div>

        {/* Secondary filters: inline on sm+, in the bottom sheet on phones */}
        <div className="hidden sm:flex flex-col gap-4">
          <div className="flex flex-wrap gap-x-10 gap-y-4">
            <KeysChips ui={ui} apply={apply} />
            <StatusChips ui={ui} apply={apply} />
            <ChipGroup label="Difficulty">
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
                <StarSlider ui={ui} apply={apply} />
                <button type="button" onClick={() => setShowMore((value) => !value)} className="text-[11.5px] text-osu-f1 hover:text-osu-pink-light transition-colors cursor-pointer">
                  {showMore ? "− bpm & length" : "+ bpm & length"}
                </button>
              </div>
            </ChipGroup>
          </div>

          {showMore && (
            <div className="flex flex-wrap gap-x-10 gap-y-4">
              <ChipGroup label="BPM">
                <BpmSlider ui={ui} apply={apply} />
              </ChipGroup>
              <ChipGroup label="Length">
                <LengthSlider ui={ui} apply={apply} />
              </ChipGroup>
            </div>
          )}
        </div>

        {/* Sort + actions (desktop; phones sort from the toolbar above). Plain
            text links like osu-web's listing: the active sort is white with a
            direction caret, and clicking it again flips the direction. */}
        <div className="hidden sm:flex flex-wrap items-center justify-between gap-3 border-t border-osu-b3/15 pt-3.5">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-osu-f1/55">Sort by</span>
            {SORT_OPTIONS.map((option) => {
              const isActive = ui.sort === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  onClick={() =>
                    isActive
                      ? apply({ dir: ui.dir === "asc" ? "desc" : "asc", page: 0 })
                      : apply({ sort: option.id, page: 0 })
                  }
                  aria-pressed={isActive}
                  title={isActive ? "Flip direction" : undefined}
                  className={`inline-flex items-center gap-1 text-[12.5px] font-semibold transition-colors cursor-pointer ${
                    isActive ? "text-white" : "text-osu-f1 hover:text-osu-pink-light"
                  }`}
                >
                  {option.label}
                  {isActive && (
                    <svg
                      viewBox="0 0 20 20"
                      fill="currentColor"
                      className={`h-3 w-3 text-osu-pink-light transition-transform duration-150 ${ui.dir === "asc" ? "rotate-180" : ""}`}
                      aria-hidden="true"
                    >
                      <path d="M5.25 7.5 10 12.25 14.75 7.5H5.25Z" />
                    </svg>
                  )}
                </button>
              );
            })}
          </div>
          {hasActiveFilters && (
            <button type="button" onClick={clearFilters} className="text-[12px] text-osu-f1 hover:text-osu-pink-light transition-colors cursor-pointer">
              Clear all
            </button>
          )}
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
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
              {items.map((entry: LiveMapSearchEntry) => (
                <SearchCard
                  key={entry.beatmapId}
                  entry={entry}
                  preview={preview}
                  onOpen={(opened) => {
                    // The detail modal has its own audio; don't play over it.
                    stopPreview();
                    setDetail(opened);
                  }}
                />
              ))}
            </div>
            {totalPages > 1 && (
              <div
                className="sticky bottom-0 z-10 -mx-4 sm:-mx-5 mt-6 px-4 sm:px-5 py-2 bg-osu-b5/90 backdrop-blur-sm border-t border-osu-b3/30 [&>div]:!mt-0 relative after:absolute after:left-0 after:right-0 after:top-full after:h-4 after:bg-osu-b5/90 after:backdrop-blur-sm after:content-['']"
                style={{ paddingBottom: "calc(0.5rem + env(safe-area-inset-bottom, 0px))" }}
              >
                <Pagination page={ui.page} totalPages={totalPages} onPageChange={(p) => apply({ page: p })} />
              </div>
            )}
          </div>
        )}
      </div>
      <MobileFilterSheet
        open={showFilters}
        onClose={() => setShowFilters(false)}
        ui={ui}
        apply={apply}
        onClear={clearFilters}
        hasActiveFilters={hasActiveFilters}
        resultsLabel={`Show ${formatNumber(total)} maps`}
      />
      <MapDetailModal entry={detail} onClose={() => setDetail(null)} />
    </div>
  );
}
