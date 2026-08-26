import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Trans, useLingui } from "@lingui/react/macro";
import { msg } from "@lingui/core/macro";
import type { I18n } from "@lingui/core";
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
import { MapPreviewPlayerBar, useMapPreviewAudio } from "./MapPreviewAudio";
import { PatternPicker, validPatternIds } from "./PatternPicker";
import { playPatternHit } from "./patternSfx";
import { RangeSlider } from "./RangeSlider";
import { danScaleImage, danScaleLabel, type DanScaleContext } from "../../lib/dan-images";
import { SearchCard, toPreviewTrack } from "./SearchCard";
import { DEFAULT_SEARCH_SORT, savedSearchSortToRestore } from "./searchSortPreference";
import { StarRangePill } from "./StarRangePill";
import {
  ACCENT_CHIP_TEXT,
  accentChipRing,
  ChipGroup,
  DirButton,
  SortSelect,
  STATUS_COLOR,
  TriStatePill,
} from "./FilterChips";
import type { TriStateMode } from "../../lib/maps-random-filter";
import { useBodyScrollLock } from "../../lib/use-body-scroll-lock";

const SEARCH_PAGE_SIZE = 24;
const SEARCH_INITIAL_SKELETON_COUNT = 12;
const SEARCH_DEBOUNCE_MS = 300;
// Safety valve on the held first fetch: if the saved-sort restore somehow
// never lands, fetch with the default rather than strand the page on skeletons.
const SAVED_SORT_RESTORE_TIMEOUT_MS = 1500;

// "4K"/"7K" are keymode names and render as written; "Other" is copy, so
// KeysChips swaps in the translated label for that one.
const KEY_OPTIONS = [
  { id: "4k", label: "4K" },
  { id: "7k", label: "7K" },
  { id: "other", label: "Other" },
];

const STATUS_OPTIONS = [
  { id: "ranked", label: msg`Ranked` },
  { id: "qualified", label: msg`Qualified` },
  { id: "loved", label: msg`Loved` },
  { id: "graveyard", label: msg`Graveyard` },
  { id: "other", label: msg`Pending` },
];

const SORT_OPTIONS = [
  { id: "playcount", label: msg`Most played` },
  { id: "stars", label: msg`Difficulty` },
  { id: "bpm", label: msg`BPM` },
  { id: "length", label: msg`Length` },
  { id: "date", label: msg`Newest` },
];

export interface MapSearchUiState {
  q: string;
  keys: string[];
  keysExclude: string[];
  statuses: string[];
  statusesExclude: string[];
  patterns: string[];
  patternsExclude: string[];
  starMin: number;
  starMax: number;
  bpmMin: number;
  bpmMax: number;
  lenMin: number;
  lenMax: number;
  danMin: number | null;
  danMax: number | null;
  sort: string;
  dir: string;
  page: number;
}

interface Props {
  state: MapSearchUiState;
  onChange: (patch: Partial<MapSearchUiState>) => void;
  liveBackendEnabled: boolean;
}

function facetMode(includes: string[], excludes: string[], value: string): TriStateMode | undefined {
  if (includes.includes(value)) return "include";
  if (excludes.includes(value)) return "exclude";
  return undefined;
}

function cycleFacet(
  includes: string[],
  excludes: string[],
  value: string,
  reverse = false,
): { includes: string[]; excludes: string[] } {
  const mode = facetMode(includes, excludes, value);
  const withoutValue = (list: string[]) => list.filter((item) => item !== value);
  if (reverse) {
    if (mode === "include") return { includes: withoutValue(includes), excludes };
    if (mode === "exclude") return { includes: [...withoutValue(includes), value], excludes: withoutValue(excludes) };
    return { includes, excludes: [...excludes, value] };
  }
  if (mode === "include") return { includes: withoutValue(includes), excludes: [...withoutValue(excludes), value] };
  if (mode === "exclude") return { includes, excludes: withoutValue(excludes) };
  return { includes: [...includes, value], excludes };
}

// Order-independent identity of a filter set, so we can tell our own URL echo
// (ignore) from a real back/forward navigation (adopt).
function stateKey(s: MapSearchUiState): string {
  return JSON.stringify([
    s.q,
    [...s.keys].sort(),
    [...s.keysExclude].sort(),
    [...s.statuses].sort(),
    [...s.statusesExclude].sort(),
    [...s.patterns].sort(),
    [...s.patternsExclude].sort(),
    s.starMin, s.starMax, s.bpmMin, s.bpmMax, s.lenMin, s.lenMax, s.danMin, s.danMax,
    s.sort, s.dir, s.page,
  ]);
}

// The Keys/Status chip groups and range sliders, shared between the desktop
// inline row and the mobile filter sheet.
type ApplyFn = (patch: Partial<MapSearchUiState>) => void;

function KeysChips({ ui, apply }: { ui: MapSearchUiState; apply: ApplyFn }) {
  const { t } = useLingui();
  // A keymode switch changes the pattern vocabulary; drop pattern picks the
  // new keymode can't express so no filter survives without a visible chip.
  const cycleKey = (id: string, reverse = false) => {
    const next = cycleFacet(ui.keys, ui.keysExclude, id, reverse);
    const valid = validPatternIds(next.includes);
    apply({
      keys: next.includes,
      keysExclude: next.excludes,
      patterns: ui.patterns.filter((pattern) => valid.has(pattern)),
      patternsExclude: ui.patternsExclude.filter((pattern) => valid.has(pattern)),
      page: 0,
    });
  };
  return (
    <ChipGroup label={t`Keys`}>
      {KEY_OPTIONS.map((option) => (
        <TriStatePill
          key={option.id}
          mode={facetMode(ui.keys, ui.keysExclude, option.id)}
          hasAnyActive={ui.keys.length + ui.keysExclude.length > 0}
          onClick={() => cycleKey(option.id)}
          onContextMenu={() => cycleKey(option.id, true)}
        >
          {option.id === "other" ? t`Other` : option.label}
        </TriStatePill>
      ))}
    </ChipGroup>
  );
}

function StatusChips({ ui, apply }: { ui: MapSearchUiState; apply: ApplyFn }) {
  const { t, i18n } = useLingui();
  return (
    <ChipGroup label={t`Status`}>
      {STATUS_OPTIONS.map((option) => (
        <TriStatePill
          key={option.id}
          color={STATUS_COLOR[option.id]}
          pill
          mode={facetMode(ui.statuses, ui.statusesExclude, option.id)}
          hasAnyActive={ui.statuses.length + ui.statusesExclude.length > 0}
          onClick={() => {
            const next = cycleFacet(ui.statuses, ui.statusesExclude, option.id);
            apply({ statuses: next.includes, statusesExclude: next.excludes, page: 0 });
          }}
          onContextMenu={() => {
            const next = cycleFacet(ui.statuses, ui.statusesExclude, option.id, true);
            apply({ statuses: next.includes, statusesExclude: next.excludes, page: 0 });
          }}
        >
          {i18n._(option.label)}
        </TriStatePill>
      ))}
    </ChipGroup>
  );
}

function StarSlider({ ui, apply }: { ui: MapSearchUiState; apply: ApplyFn }) {
  const { t } = useLingui();
  return (
    <StarRangePill lo={0} hi={15} min={ui.starMin} max={ui.starMax} step={0.1} ariaLabel={t`Star rating`} onChange={(min, max) => apply({ starMin: min, starMax: max, page: 0 })} />
  );
}

function BpmSlider({ ui, apply }: { ui: MapSearchUiState; apply: ApplyFn }) {
  const { t } = useLingui();
  return (
    <RangeSlider lo={0} hi={400} min={ui.bpmMin} max={ui.bpmMax} step={5} ariaLabel={t`BPM`} onChange={(min, max) => apply({ bpmMin: min, bpmMax: max, page: 0 })} />
  );
}

function LengthSlider({ ui, apply }: { ui: MapSearchUiState; apply: ApplyFn }) {
  const { t } = useLingui();
  return (
    <RangeSlider lo={0} hi={600} min={ui.lenMin} max={ui.lenMax} step={5} ariaLabel={t`Length`} format={(v) => formatDuration(v)} onChange={(min, max) => apply({ lenMin: min, lenMax: max, page: 0 })} />
  );
}

// One ladder the picker can offer: a keymode plus the scale context that names
// its badges. rawDan is a per-keymode axis (4K reform/LN vs 7K courses), so a
// pick from a ladder only means what its badge says when the search is scoped
// to that ladder's keymode.
interface DanLadderGroup {
  keysId: "4k" | "7k";
  label: string;
  context: DanScaleContext;
}

// Which ladders the picker offers: the keymode's own ladder when the key facet
// resolves to exactly 4K or 7K, otherwise both (empty, mixed, or "other" key
// facets are ambiguous, and the 4K and 7K courses share numbers but not
// difficulty). An LN-flavoured pattern facet swaps in the LN ladders.
function danLadderGroups(ui: MapSearchUiState): DanLadderGroup[] {
  const lnFlavoured = ui.patterns.some((pattern) => pattern === "ln" || pattern.startsWith("ln"));
  const fourKey: DanLadderGroup = { keysId: "4k", label: "4K", context: lnFlavoured ? "ln" : "reform" };
  const sevenKey: DanLadderGroup = { keysId: "7k", label: "7K", context: lnFlavoured ? "7k-ln" : "7k" };
  const only = ui.keys.length === 1 ? ui.keys[0] : null;
  if (only === "4k") return [fourKey];
  if (only === "7k") return [sevenKey];
  return [fourKey, sevenKey];
}

// The context that annotates the collapsed trigger chip; with both ladders on
// offer the selection is a bare rawDan range, shown with the 4K badges.
function danSliderContext(ui: MapSearchUiState): DanScaleContext {
  return danLadderGroups(ui)[0].context;
}

// The ladder's badge rows: numeric courses on top, boss/greek courses below.
// Values are integer dan levels on the classifier's rawDan axis.
function danLadderRows(context: DanScaleContext): number[][] {
  const seq = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
  if (context === "7k" || context === "7k-ln") return [seq(0, 10), seq(11, 14)];
  // LN runs 1-17 (16 Yokaze, 17 Yeehee are the extra-level courses), split into
  // a row of nine and a row of eight.
  if (context === "ln") return [seq(1, 9), seq(10, 17)];
  return [seq(1, 10), seq(11, 20)];
}

// The ordinal ("5th") is built here and handed to the message as a placeholder,
// the same shape SkillBreakdown uses for its dan chips.
function danReadout(value: number, context: DanScaleContext, i18n: I18n): string {
  const label = danScaleLabel(value, context);
  if (!/^\d+$/.test(label)) return label;
  const n = Number(label);
  const suffix = n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th";
  const ordinal = `${n}${suffix}`;
  return i18n._(msg`${ordinal} dan`);
}

function danRangeReadout(lo: number, hi: number, context: DanScaleContext, i18n: I18n): string {
  const from = danReadout(lo, context, i18n);
  const to = danReadout(hi, context, i18n);
  return i18n._(msg`${from} to ${to}`);
}

// The badge wall: tap a badge to filter to exactly that dan, tap it again to
// clear, or drag across badges to paint a range (shift-click extends from the
// current selection). Unselected badges sit dimmed and desaturated; the
// selection pops to full color. A fixed-height readout under the wall names
// whatever is hovered or selected, so the layout never moves. Only charts with
// a stored chart analysis match while set.
//
// With an ambiguous key facet the wall stacks the 4K and 7K ladders, and a
// pick also applies its ladder's keymode to the Keys facet (pruning pattern
// picks the keymode can't express, same as the Keys chips): without the scope
// a "4K 5th dan" pick would match 7K 5th-dan charts at the same rawDan.
// Clearing the dan never touches the keys facet.
function DanBadgeWall({ ui, apply }: { ui: MapSearchUiState; apply: ApplyFn }) {
  const { t, i18n } = useLingui();
  const groups = danLadderGroups(ui);
  const ambiguous = groups.length > 1;
  const selection = ui.danMin != null && ui.danMax != null ? { lo: ui.danMin, hi: ui.danMax } : null;
  const [drag, setDrag] = useState<{ group: DanLadderGroup; anchor: number; current: number } | null>(null);
  const [hovered, setHovered] = useState<{ group: DanLadderGroup; level: number } | null>(null);
  const dragRef = useRef(drag);
  dragRef.current = drag;

  const commit = (lo: number | null, hi: number | null, group: DanLadderGroup) => {
    playPatternHit(lo != null);
    if (ambiguous && lo != null) {
      const keys = [group.keysId];
      const valid = validPatternIds(keys);
      apply({
        danMin: lo,
        danMax: hi,
        keys,
        keysExclude: [],
        patterns: ui.patterns.filter((pattern) => valid.has(pattern)),
        patternsExclude: ui.patternsExclude.filter((pattern) => valid.has(pattern)),
        page: 0,
      });
      return;
    }
    apply({ danMin: lo, danMax: hi, page: 0 });
  };
  const toggleSingle = (level: number, group: DanLadderGroup) => {
    // Re-click toggles off only on a single ladder; with both ladders shown the
    // same number sits on each, so a tap always means "select on this ladder".
    if (!ambiguous && selection && selection.lo === level && selection.hi === level) commit(null, null, group);
    else commit(level, level, group);
  };

  const dragging = drag != null;
  useEffect(() => {
    if (!dragging) return;
    const onMove = (event: PointerEvent) => {
      const target = document.elementFromPoint(event.clientX, event.clientY);
      const badge = target instanceof Element ? target.closest("[data-dan-level]") : null;
      if (!badge) return;
      const level = Number(badge.getAttribute("data-dan-level"));
      const groupId = badge.getAttribute("data-dan-group");
      setDrag((state) =>
        state && state.group.keysId === groupId && state.current !== level ? { ...state, current: level } : state,
      );
    };
    const onUp = () => {
      const state = dragRef.current;
      setDrag(null);
      if (!state) return;
      if (state.anchor === state.current) toggleSingle(state.anchor, state.group);
      else commit(Math.min(state.anchor, state.current), Math.max(state.anchor, state.current), state.group);
    };
    // A vertical touch pan cancels the pointer: abort without applying.
    const onCancel = () => setDrag(null);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging]);

  // Live paint while dragging (only on the ladder the drag started in); the
  // committed selection otherwise. A committed range with both ladders shown is
  // a bare rawDan filter, so it highlights on each.
  const paintFor = (group: DanLadderGroup) => {
    if (drag) {
      if (drag.group.keysId !== group.keysId) return null;
      return { lo: Math.min(drag.anchor, drag.current), hi: Math.max(drag.anchor, drag.current) };
    }
    return selection;
  };
  const describe = (group: DanLadderGroup, lo: number, hi?: number) => {
    const name = hi == null || hi === lo
      ? danReadout(lo, group.context, i18n)
      : danRangeReadout(lo, hi, group.context, i18n);
    // The prefix is the keymode itself ("4K", "7K"), so it stays as written.
    return ambiguous ? `${group.label} ${name}` : name;
  };
  return (
    <div className="flex flex-col gap-2 select-none" style={{ touchAction: "pan-y" }} onPointerLeave={() => setHovered(null)}>
      {groups.map((group) => (
        <div key={group.keysId} className="flex flex-col gap-1.5">
          {ambiguous && (
            <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-osu-f1/55">{group.label}</span>
          )}
          {danLadderRows(group.context).map((row, rowIndex) => {
            const groupPaint = paintFor(group);
            return (
              <div key={rowIndex} className="flex items-center gap-1 sm:gap-1.5">
                {row.map((level) => {
                  const active = groupPaint != null && level >= groupPaint.lo && level <= groupPaint.hi;
                  const isHovered = hovered != null && hovered.group.keysId === group.keysId && hovered.level === level;
                  const src = danScaleImage(level, group.context);
                  const label = danScaleLabel(level, group.context);
                  return (
                    <motion.button
                      key={`${group.context}:${level}`}
                      type="button"
                      data-dan-level={level}
                      data-dan-group={group.keysId}
                      title={describe(group, level)}
                      aria-pressed={active}
                      onPointerDown={(event) => {
                        if (event.button !== 0 && event.pointerType === "mouse") return;
                        if (event.shiftKey && selection) {
                          // Extend: anchor at the selection edge farthest from the tap.
                          const anchor = Math.abs(level - selection.lo) >= Math.abs(level - selection.hi) ? selection.lo : selection.hi;
                          setDrag({ group, anchor, current: level });
                          return;
                        }
                        setDrag({ group, anchor: level, current: level });
                      }}
                      onClick={(event) => {
                        // Pointer commits handle mouse/touch; this is the keyboard path.
                        if (event.detail === 0) toggleSingle(level, group);
                      }}
                      onPointerEnter={(event) => {
                        if (event.pointerType === "mouse") setHovered({ group, level });
                      }}
                      onPointerLeave={() => setHovered((value) => (
                        value && value.group.keysId === group.keysId && value.level === level ? null : value
                      ))}
                      animate={{ scale: active ? 1.12 : 1 }}
                      transition={{ type: "spring", stiffness: 560, damping: 24 }}
                      className={`grid h-7 w-7 sm:h-8 sm:w-8 shrink-0 cursor-pointer place-items-center transition-[opacity,filter] duration-150 ${
                        active ? "opacity-100" : isHovered ? "opacity-90 grayscale-[20%]" : "opacity-40 grayscale-[45%]"
                      }`}
                    >
                      {src ? (
                        <img
                          src={src}
                          alt={label}
                          draggable={false}
                          decoding="async"
                          className={`h-full w-full object-contain ${
                            active ? "drop-shadow-[0_0_6px_rgba(255,102,171,0.4)]" : "drop-shadow-[0_2px_4px_rgba(0,0,0,0.5)]"
                          }`}
                        />
                      ) : (
                        <span className="grid h-6 w-6 place-items-center rounded-full bg-osu-b3 ring-1 ring-white/20 text-[11px] font-black text-osu-l1">
                          {label}
                        </span>
                      )}
                    </motion.button>
                  );
                })}
              </div>
            );
          })}
        </div>
      ))}
      <div className="flex h-4 items-center gap-2 text-[10px] font-bold uppercase tracking-wide text-osu-f1/70">
        <span>
          {hovered != null
            ? describe(hovered.group, hovered.level)
            : drag
              ? describe(drag.group, Math.min(drag.anchor, drag.current), Math.max(drag.anchor, drag.current))
              : selection
                ? selection.lo === selection.hi
                  ? danReadout(selection.lo, groups[0].context, i18n)
                  : danRangeReadout(selection.lo, selection.hi, groups[0].context, i18n)
                : t`any`}
        </span>
        {selection != null && drag == null && (
          <button
            type="button"
            onClick={() => commit(null, null, groups[0])}
            className="lowercase text-osu-f1/50 hover:text-osu-pink-light transition-colors cursor-pointer"
          >
            <Trans>clear</Trans>
          </button>
        )}
        <span className="ml-auto font-normal lowercase text-osu-f1/40"><Trans>rough estimate, may be off</Trans></span>
      </div>
    </div>
  );
}

// The greek badge webps run up to ~130KB each; fetching and decoding them the
// moment the sheet first slides in is a visible stutter on phones. Warm the
// whole ladder off the critical path instead (idle time, once per src).
const warmedDanArt = new Set<string>();
function warmDanBadgeArt(context: DanScaleContext) {
  for (const row of danLadderRows(context)) {
    for (const level of row) {
      const src = danScaleImage(level, context);
      if (!src || warmedDanArt.has(src)) continue;
      warmedDanArt.add(src);
      const img = new Image();
      img.src = src;
      img.decode?.().catch(() => {});
    }
  }
}

// A selected dan at chip scale for the collapsed trigger.
function DanMini({ level, context }: { level: number; context: DanScaleContext }) {
  const src = danScaleImage(level, context);
  const label = danScaleLabel(level, context);
  return src ? (
    <img src={src} alt={label} className="h-5 w-5 shrink-0 object-contain" loading="lazy" />
  ) : (
    <span className="text-[11px] font-black leading-none text-osu-l1">{label}</span>
  );
}

// Estimated-dan filter. Collapsed it is a plain chip showing the selection
// (badge art, or "Any"); clicking opens the badge wall as a floating panel
// anchored under it, overlay-style so the filter row never grows. The mobile
// sheet renders the wall inline instead (inline prop): it is a vertical
// surface where the wall fits naturally and a flyout would clip its scroll.
function DanPicker({ ui, apply, inline = false }: { ui: MapSearchUiState; apply: ApplyFn; inline?: boolean }) {
  const context = danSliderContext(ui);
  const selection = ui.danMin != null && ui.danMax != null ? { lo: ui.danMin, hi: ui.danMax } : null;
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent | TouchEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("touchstart", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("touchstart", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (inline) return <DanBadgeWall ui={ui} apply={apply} />;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="inline-flex min-w-[84px] items-center justify-between gap-2 rounded-md px-3 py-1.5 text-[12.5px] font-bold cursor-pointer transition-colors duration-150"
        style={{
          background: open ? "color-mix(in srgb, var(--color-osu-pink) 12%, transparent)" : "transparent",
          color: ACCENT_CHIP_TEXT,
          boxShadow: accentChipRing(open ? 90 : selection ? 65 : 35),
        }}
      >
        {selection ? (
          <span className="inline-flex items-center gap-1.5">
            <DanMini level={selection.lo} context={context} />
            {selection.hi !== selection.lo && (
              <>
                <span className="text-[10px] opacity-70"><Trans>to</Trans></span>
                <DanMini level={selection.hi} context={context} />
              </>
            )}
          </span>
        ) : (
          <span><Trans>Any</Trans></span>
        )}
        <svg
          viewBox="0 0 20 20"
          fill="currentColor"
          className={`h-3.5 w-3.5 shrink-0 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
          aria-hidden="true"
        >
          <path d="M5.25 7.5 10 12.25 14.75 7.5H5.25Z" />
        </svg>
      </button>
      {open && (
        <div className="absolute left-0 top-[calc(100%+6px)] z-30 w-max max-w-[min(440px,92vw)] rounded-lg bg-osu-b4 p-3 ring-1 ring-white/10 shadow-xl">
          <DanBadgeWall ui={ui} apply={apply} />
        </div>
      )}
    </div>
  );
}

// The mobile toolbar's Filters trigger plus its bottom sheet. The open state
// lives here, not in MapSearchSection, so toggling the sheet re-renders only
// this control and not the card grid behind it (the other half of the phone
// open/close jank).
function MobileFilters({
  ui,
  apply,
  onClear,
  hasActiveFilters,
  collapsedFilterCount,
  resultsLabel,
}: {
  ui: MapSearchUiState;
  apply: ApplyFn;
  onClear: () => void;
  hasActiveFilters: boolean;
  collapsedFilterCount: number;
  resultsLabel: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-[12.5px] font-semibold cursor-pointer transition-colors bg-osu-b4 text-osu-l2 hover:bg-osu-b3 hover:text-osu-l1"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5" aria-hidden="true">
          <path d="M3 6h18M7 12h10M10 18h4" />
        </svg>
        <Trans>Filters</Trans>
        {collapsedFilterCount > 0 && (
          <span className="rounded-full bg-osu-pink px-1.5 text-[10px] font-bold leading-4 text-white tabular-nums">
            {collapsedFilterCount}
          </span>
        )}
      </button>
      <MobileFilterSheet
        open={open}
        onClose={() => setOpen(false)}
        ui={ui}
        apply={apply}
        onClear={onClear}
        hasActiveFilters={hasActiveFilters}
        resultsLabel={resultsLabel}
      />
    </>
  );
}

// Bottom sheet holding the secondary filters on phones. Filters apply live (the
// dimmed grid updates behind the scrim); the pink button just closes the sheet.
// The sheet stays mounted across open/close (translated offscreen, inert) so a
// toggle only moves an existing compositor layer instead of mounting the badge
// wall and sliders mid-animation, which dropped frames on phones.
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
  const { t } = useLingui();
  // The sheet is always mounted (see above) and portals into document.body,
  // which the app hydrates as part of the whole document (hydrateRoot(document)
  // in client.tsx). A `typeof document` guard alone would render nothing on the
  // server but a real <div> on the very first client render, so React would find
  // an element the server HTML never had and throw out the SSR tree (#418, the
  // top error on /maps). Gating on mount keeps the first client render matching
  // the server; the portal then appears a tick later, still long before any open.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Swipe-to-dismiss, mirroring the random-tab filter sheet in maps.tsx: the
  // open/close slide is a CSS transition (compositor thread, buttery on phones),
  // and the transition only switches off while a finger is actively dragging.
  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState(0);
  const dragStartYRef = useRef(0);
  const handleDragStart = (e: React.TouchEvent) => {
    dragStartYRef.current = e.touches[0].clientY;
    setIsDragging(true);
    setDragOffset(0);
  };
  const handleDragMove = (e: React.TouchEvent) => {
    setDragOffset(Math.max(0, e.touches[0].clientY - dragStartYRef.current));
  };
  const handleDragEnd = () => {
    setIsDragging(false);
    if (dragOffset > 100) onClose();
    setDragOffset(0);
  };
  useEffect(() => {
    if (open) setDragOffset(0);
  }, [open]);

  // Pre-fetch/decode the badge art for the ladders the sheet would show, so
  // the first open animates over already-decoded images. The contexts join to
  // a string so the effect keys on the value, not the array identity.
  const danContexts = danLadderGroups(ui).map((group) => group.context).join(" ");
  useEffect(() => {
    const warm = () => {
      for (const context of danContexts.split(" ")) warmDanBadgeArt(context as DanScaleContext);
    };
    if (typeof window.requestIdleCallback === "function") {
      const handle = window.requestIdleCallback(warm, { timeout: 2000 });
      return () => window.cancelIdleCallback(handle);
    }
    const timer = window.setTimeout(warm, 300);
    return () => window.clearTimeout(timer);
  }, [danContexts]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useBodyScrollLock(open);

  if (!mounted) return null;

  return createPortal(
    <div
      className={`fixed inset-0 z-[120] sm:hidden ${open ? "" : "pointer-events-none"}`}
      aria-hidden={!open}
      inert={!open}
    >
      <div
        className="absolute inset-0 bg-black/70 transition-opacity duration-200"
        style={{ opacity: open ? Math.max(0, 1 - dragOffset / 260) : 0 }}
        onClick={onClose}
      />
      <div
        className="absolute inset-x-0 bottom-0 flex max-h-[85dvh] flex-col rounded-t-2xl bg-osu-b5 ring-1 ring-white/10"
        style={{
          transform: open ? `translateY(${dragOffset}px)` : "translateY(100%)",
          // Hidden outright once closed so the mobile URL-bar collapse can't
          // reveal its top edge mid-scroll (translateY(100%) alone leaves the
          // edge flush with the viewport bottom); the hide waits out the
          // slide-down so the close still animates.
          visibility: open ? "visible" : "hidden",
          transition: isDragging
            ? "none"
            : open
              ? "transform 0.3s cubic-bezier(0.32, 0.72, 0, 1)"
              : "transform 0.3s cubic-bezier(0.32, 0.72, 0, 1), visibility 0s linear 0.3s",
          willChange: "transform",
        }}
      >
        <div
          className="shrink-0 cursor-grab touch-none pt-2 active:cursor-grabbing"
          onTouchStart={handleDragStart}
          onTouchMove={handleDragMove}
          onTouchEnd={handleDragEnd}
          onTouchCancel={handleDragEnd}
        >
          <div className="mx-auto h-1 w-9 rounded-full bg-osu-b3" aria-hidden="true" />
          <span className="block px-4 pt-2 text-[13px] font-bold text-osu-l1"><Trans>Filters</Trans></span>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-3.5">
          <KeysChips ui={ui} apply={apply} />
          <StatusChips ui={ui} apply={apply} />
          <ChipGroup label={t`Difficulty`}>
            <StarSlider ui={ui} apply={apply} />
          </ChipGroup>
          <ChipGroup label={t`Dan (est.)`}>
            <DanPicker ui={ui} apply={apply} inline />
          </ChipGroup>
          <ChipGroup label={t`BPM`}>
            <BpmSlider ui={ui} apply={apply} />
          </ChipGroup>
          <ChipGroup label={t`Length`}>
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
            <Trans>Clear all</Trans>
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md bg-osu-pink px-4 py-2 text-[12.5px] font-bold text-white hover:bg-osu-pink-light transition-colors cursor-pointer"
          >
            {resultsLabel}
          </button>
        </div>
      </div>
    </div>,
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
  const { t, i18n } = useLingui();
  // Local source of truth so a tap updates the grid on the same frame; the URL
  // still syncs underneath (shareable links, back/forward) without gating the fetch.
  const [ui, setUi] = useState<MapSearchUiState>(state);
  const [searchInput, setSearchInput] = useState(state.q);
  const [showMore, setShowMore] = useState(state.bpmMin > 0 || state.bpmMax > 0 || state.lenMin > 0 || state.lenMax > 0);
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

  // Adopt genuine external navigations (back/forward, clear, the post-hydration
  // sort restore); skip our own echoes. This runs during render (the adjust-
  // state-on-prop-change pattern) rather than in an effect: an effect adopts a
  // commit late, and anything keyed on `ui` in that gap (the fetch below)
  // fires with filters that are about to be superseded.
  const [adoptedState, setAdoptedState] = useState(state);
  if (state !== adoptedState) {
    setAdoptedState(state);
    const key = stateKey(state);
    if (!pendingKeys.current.has(key) && key !== stateKey(ui)) {
      setUi(state);
      setSearchInput(state.q);
    }
  }
  // Echo bookkeeping waits for the render that observed the prop change (a
  // render-phase mutation would misbehave under StrictMode's double render):
  // our own pushes retire as they echo back, and a genuine external navigation
  // moots whatever else was still pending.
  useEffect(() => {
    if (!pendingKeys.current.delete(stateKey(state))) pendingKeys.current.clear();
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

  // On a cold load the first client render must keep the SSR default sort; a
  // saved preference only lands afterwards (the post-hydration restore in
  // maps.tsx). If one is about to, a fetch now would be superseded the moment
  // the restore lands, so the first fetch waits for the restored sort to reach
  // `ui`. Reading localStorage in the initializer is hydration-safe: the flag
  // only gates the fetch effect and never changes rendered output.
  const [awaitingSavedSort, setAwaitingSavedSort] = useState(() => savedSearchSortToRestore(state));
  useEffect(() => {
    if (!awaitingSavedSort) return;
    if (ui.sort !== DEFAULT_SEARCH_SORT.sort || ui.dir !== DEFAULT_SEARCH_SORT.dir) {
      setAwaitingSavedSort(false);
      return;
    }
    const timer = window.setTimeout(() => setAwaitingSavedSort(false), SAVED_SORT_RESTORE_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [awaitingSavedSort, requestKey]);

  // A filter/page change swaps the grid out from under the playing card.
  useEffect(() => {
    stopPreview();
  }, [requestKey, stopPreview]);

  useEffect(() => {
    if (!liveBackendEnabled) {
      setLoading(false);
      setError(t`Search is unavailable right now. Try again in a bit.`);
      return;
    }
    if (awaitingSavedSort) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchLiveMapSearch({
      q: ui.q,
      keys: ui.keys,
      keysExclude: ui.keysExclude,
      statuses: ui.statuses,
      statusesExclude: ui.statusesExclude,
      patterns: ui.patterns,
      patternsExclude: ui.patternsExclude,
      starMin: ui.starMin > 0 ? ui.starMin : null,
      starMax: ui.starMax > 0 ? ui.starMax : null,
      bpmMin: ui.bpmMin > 0 ? ui.bpmMin : null,
      bpmMax: ui.bpmMax > 0 ? ui.bpmMax : null,
      lenMin: ui.lenMin > 0 ? ui.lenMin : null,
      lenMax: ui.lenMax > 0 ? ui.lenMax : null,
      danMin: ui.danMin,
      danMax: ui.danMax,
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
        setError(t`Couldn't load search results. Try again.`);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey, liveBackendEnabled, awaitingSavedSort]);

  const items = result?.items ?? lastResultRef.current?.items ?? [];
  // Skip order for the preview player: the grid as shown.
  const previewTracks = useMemo(() => items.map(toPreviewTrack), [items]);
  const total = result?.total ?? lastResultRef.current?.total ?? 0;
  // The backend stops counting at its cap; render the honest "5,000+".
  const totalCapped = (result ?? lastResultRef.current)?.totalCapped === true;
  const totalLabel = `${formatNumber(total)}${totalCapped ? "+" : ""}`;
  const totalPages = Math.max(1, Math.ceil(total / SEARCH_PAGE_SIZE));
  const effectiveError = liveBackendEnabled ? error : t`Search is unavailable right now. Try again in a bit.`;
  const hasLoadedResult = result !== null || lastResultRef.current !== null;
  const showLoadingSkeleton = !effectiveError && liveBackendEnabled && (loading || !hasLoadedResult) && items.length === 0;
  // No "updating" suffix while refreshing: the label sits next to a flex-1
  // input, so any width change resizes the search bar. It dims instead.
  const countLabel = showLoadingSkeleton ? t`Loading maps...` : t`${totalLabel} maps`;
  const countRefreshing = loading && hasLoadedResult;

  // A stale ?page= past the last page (a shrunken result set, an old link)
  // renders an empty board: snap back to the last real page once results are
  // in. Mirrors the browse tabs' overflow correction in maps.tsx.
  useEffect(() => {
    if (loading || !hasLoadedResult || items.length > 0) return;
    if (ui.page >= totalPages && ui.page > 0) apply({ page: totalPages - 1 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, hasLoadedResult, items.length, ui.page, totalPages]);

  const hasActiveFilters =
    ui.q.trim() !== "" ||
    ui.keys.length > 0 ||
    ui.keysExclude.length > 0 ||
    ui.statuses.length > 0 ||
    ui.statusesExclude.length > 0 ||
    ui.patterns.length > 0 ||
    ui.patternsExclude.length > 0 ||
    ui.starMin > 0 || ui.starMax > 0 ||
    ui.bpmMin > 0 || ui.bpmMax > 0 ||
    ui.lenMin > 0 || ui.lenMax > 0 ||
    ui.danMin != null || ui.danMax != null;

  // How many collapsed filters are active, for the mobile toggle's badge.
  // Patterns stay visible above the toggle, so they don't count.
  const collapsedFilterCount =
    ui.keys.length + ui.keysExclude.length +
    ui.statuses.length + ui.statusesExclude.length +
    (ui.starMin > 0 || ui.starMax > 0 ? 1 : 0) +
    (ui.bpmMin > 0 || ui.bpmMax > 0 ? 1 : 0) +
    (ui.lenMin > 0 || ui.lenMax > 0 ? 1 : 0) +
    (ui.danMin != null || ui.danMax != null ? 1 : 0);

  // The sort table is module-scope descriptors; resolve it once per locale.
  const sortOptions = useMemo(
    () => SORT_OPTIONS.map((option) => ({ id: option.id, label: i18n._(option.label) })),
    [i18n],
  );

  const clearFilters = () => {
    setSearchInput("");
    apply({
      q: "", keys: [], keysExclude: [], statuses: [], statusesExclude: [], patterns: [], patternsExclude: [],
      starMin: 0, starMax: 0, bpmMin: 0, bpmMax: 0, lenMin: 0, lenMax: 0,
      danMin: null, danMax: null,
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
              placeholder={t`Search title, artist, mapper, or filter: keys=7 stars>5 status=ranked`}
              aria-label={t`Search maps`}
              className={`w-full bg-osu-b4 border border-osu-b3/30 rounded-lg pl-10 py-2.5 text-[14px] text-osu-l1 placeholder:text-osu-f1/55 focus:outline-none focus:border-osu-pink/50 transition-colors ${searchInput ? "pr-10" : "pr-3"}`}
            />
            {searchInput && (
              <button
                type="button"
                onClick={() => setSearchInput("")}
                aria-label={t`Clear search`}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 flex h-6 w-6 items-center justify-center rounded-md text-osu-f1/55 hover:text-osu-l1 hover:bg-osu-b3 transition-colors cursor-pointer"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true">
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            )}
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
          <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-osu-f1/55"><Trans>Pattern</Trans></span>
          <PatternPicker
            selected={ui.patterns}
            excluded={ui.patternsExclude}
            keys={ui.keys}
            onToggle={(pattern, reverse) => {
              const next = cycleFacet(ui.patterns, ui.patternsExclude, pattern, reverse);
              apply({ patterns: next.includes, patternsExclude: next.excludes, page: 0 });
            }}
          />
        </div>

        {/* Mobile toolbar: secondary filters collapse behind a toggle, sort is a dropdown */}
        <div className="flex items-center gap-2 sm:hidden">
          <MobileFilters
            ui={ui}
            apply={apply}
            onClear={clearFilters}
            hasActiveFilters={hasActiveFilters}
            collapsedFilterCount={collapsedFilterCount}
            resultsLabel={t`Show ${totalLabel} maps`}
          />
          <div className="ml-auto">
            <SortSelect options={sortOptions} value={ui.sort} onChange={(id) => apply({ sort: id, page: 0 })} />
          </div>
          <DirButton dir={ui.dir} onToggle={() => apply({ sort: ui.sort, dir: ui.dir === "asc" ? "desc" : "asc", page: 0 })} />
        </div>

        {/* Secondary filters: inline on sm+, in the bottom sheet on phones */}
        <div className="hidden sm:flex flex-col gap-4">
          <div className="flex flex-wrap gap-x-10 gap-y-4">
            <KeysChips ui={ui} apply={apply} />
            <StatusChips ui={ui} apply={apply} />
            <ChipGroup label={t`Difficulty`}>
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
                <StarSlider ui={ui} apply={apply} />
                <button type="button" onClick={() => setShowMore((value) => !value)} className="text-[11.5px] text-osu-f1 hover:text-osu-pink-light transition-colors cursor-pointer">
                  {showMore ? <Trans>− bpm & length</Trans> : <Trans>+ bpm & length</Trans>}
                </button>
              </div>
            </ChipGroup>
            <ChipGroup label={t`Dan (est.)`}>
              <DanPicker ui={ui} apply={apply} />
            </ChipGroup>
          </div>

          {showMore && (
            <div className="flex flex-wrap gap-x-10 gap-y-4">
              <ChipGroup label={t`BPM`}>
                <BpmSlider ui={ui} apply={apply} />
              </ChipGroup>
              <ChipGroup label={t`Length`}>
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
            <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-osu-f1/55"><Trans>Sort by</Trans></span>
            {sortOptions.map((option) => {
              const isActive = ui.sort === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  onClick={() =>
                    isActive
                      ? apply({ sort: option.id, dir: ui.dir === "asc" ? "desc" : "asc", page: 0 })
                      : apply({ sort: option.id, page: 0 })
                  }
                  aria-pressed={isActive}
                  title={isActive ? t`Flip direction` : undefined}
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
              <Trans>Clear all</Trans>
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
          <div className="py-16 text-center text-[13px] text-osu-f1"><Trans>No maps match these filters.</Trans></div>
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
      <MapDetailModal entry={detail} onClose={() => setDetail(null)} />
      <MapPreviewPlayerBar preview={preview} tracks={previewTracks} clearsStickyBar={totalPages > 1} />
    </div>
  );
}
