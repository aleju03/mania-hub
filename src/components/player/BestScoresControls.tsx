/* The Best Performance list's controls (keymode strip, mod chips, sort) and
   the filters behind them, shared by the player and team pages. */

import { useMemo, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { getBeatmapKeyCount, getDisplayedRank, getModAcronyms, getScoreTimeMs } from "../../lib/score";
import {
  NO_MOD_KEY,
  cycleModFilterMode,
  getModFilterGroup,
  relevantModFilterKeys,
  reverseCycleModFilterMode,
  type ModFilterMode,
  type ModFilterState,
} from "../../lib/mod-filter";
import type { OsuScore } from "../../lib/types";
import { GradeImg } from "../ui/GradeImg";
import { ModFilterChip } from "../ui/ModFilterChip";
import { SortArrow } from "../ui/SortArrow";

export type KeyFilter = "all" | string;
export type BestPpSort = "pp-desc" | "pp-asc";
export type BestAgeSort = "newest" | "oldest";
export type BestSort = BestPpSort | BestAgeSort;
/** Grades a list is narrowed to or hides, set like the mod chips. */
export type GradeFilter = Record<string, ModFilterMode>;

export function matchesKeyFilter(score: OsuScore, keyFilter: KeyFilter): boolean {
  if (keyFilter === "all") return true;
  return getBeatmapKeyCount(score.beatmap) === Number(keyFilter.replace("k", ""));
}

/* A keymode list is the plays behind that keymode's pp, and osu! grows its
   keymode statistics from natively-mania maps only, which is what the Key
   Split modal already tells the reader it leaves out. So a convert is a play
   under "All", where osu! does rank it, and not a row in one keymode's list:
   listing it there would put a play on screen that the total beside it never
   counted. Recent keeps the plain filter; nothing there is a total. */
export function matchesBestKeyFilter(score: OsuScore, keyFilter: KeyFilter): boolean {
  if (keyFilter === "all") return true;
  return !score.beatmap?.convert && matchesKeyFilter(score, keyFilter);
}

export function getAvailableKeyModes(scores: OsuScore[]): string[] {
  const keys = new Set<number>();
  for (const score of scores) {
    const keyCount = getBeatmapKeyCount(score.beatmap);
    if (keyCount != null) keys.add(keyCount);
  }
  return Array.from(keys).sort((a, b) => a - b).map((k) => `${k}k`);
}

export function matchesModFilter(score: OsuScore, modFilter: ModFilterState): boolean {
  const entries = Object.entries(modFilter);
  if (entries.length === 0) return true;

  const scoreMods = new Set(getModAcronyms(score.mods));
  const hasNoMods = scoreMods.size === 0;

  for (const [key, mode] of entries) {
    let present: boolean;
    if (key === NO_MOD_KEY) {
      present = hasNoMods;
    } else {
      const group = getModFilterGroup(key);
      present = group ? group.some((m) => scoreMods.has(m)) : scoreMods.has(key);
    }
    if (mode === "include" && !present) return false;
    if (mode === "exclude" && present) return false;
  }
  return true;
}

/* Silver grades share a chip with their gold one: the silver only says HD or
   FL was on, which the mod chips already filter. */
const GRADE_FILTER_ORDER = ["SS", "S", "A", "B", "C", "D"];

export function getGradeFilterKey(rank: string): string {
  if (rank === "X" || rank === "XH" || rank === "SSH") return "SS";
  if (rank === "SH") return "S";
  return rank;
}

/* A play has one grade, so required grades are alternatives: requiring S and
   A shows both. A hidden grade is hidden either way. */
export function matchesGradeKeyFilter(grade: string | null, gradeFilter: GradeFilter): boolean {
  const modes = Object.entries(gradeFilter);
  if (modes.length === 0) return true;
  if (grade == null) return !modes.some(([, mode]) => mode === "include");
  if (gradeFilter[grade] === "exclude") return false;
  return !modes.some(([, mode]) => mode === "include") || gradeFilter[grade] === "include";
}

export function matchesGradeFilter(rank: string, gradeFilter: GradeFilter): boolean {
  return matchesGradeKeyFilter(getGradeFilterKey(rank), gradeFilter);
}

export function matchesScoreGradeFilter(score: OsuScore, gradeFilter: GradeFilter): boolean {
  return matchesGradeFilter(getDisplayedRank(score), gradeFilter);
}

/** The grades on a list, plus any already picked, so a picked grade the list
    no longer holds keeps a chip to turn it off with. */
export function getAvailableGrades(ranks: string[], gradeFilter: GradeFilter): string[] {
  const keys = new Set(Object.keys(gradeFilter));
  for (const rank of ranks) keys.add(getGradeFilterKey(rank));
  return GRADE_FILTER_ORDER.filter((key) => keys.has(key));
}

export function cycleGradeFilter(gradeFilter: GradeFilter, grade: string, reverse = false): GradeFilter {
  const next = reverse ? reverseCycleModFilterMode(gradeFilter[grade]) : cycleModFilterMode(gradeFilter[grade]);
  const { [grade]: _dropped, ...rest } = gradeFilter;
  return next ? { ...rest, [grade]: next } : rest;
}

export function getSortablePp(score: OsuScore): number | null {
  return typeof score.pp === "number" && Number.isFinite(score.pp) ? score.pp : null;
}

export function sortBestScores(scores: OsuScore[], sort: BestSort): OsuScore[] {
  const copy = [...scores];
  if (sort === "pp-desc" || sort === "pp-asc") {
    copy.sort((a, b) => {
      const aPp = getSortablePp(a);
      const bPp = getSortablePp(b);
      if (aPp == null && bPp == null) return 0;
      if (aPp == null) return 1;
      if (bPp == null) return -1;
      return sort === "pp-desc" ? bPp - aPp : aPp - bPp;
    });
    return copy;
  }

  copy.sort((a, b) => {
    const diff = getScoreTimeMs(b) - getScoreTimeMs(a);
    return sort === "newest" ? diff : -diff;
  });
  return copy;
}


export function getRelevantMods(scores: OsuScore[]): string[] {
  return relevantModFilterKeys(scores.map((score) => getModAcronyms(score.mods)));
}


export function BestScoresControlBar({
  availableKeyModes,
  keyFilter,
  onChangeKeyFilter,
  maxInlineKeyModes,
  keyModePlayCounts,
  onKeyModeOverflow,
  mods,
  modFilter,
  onCycleMod,
  onReverseCycleMod,
  onClearMods,
  grades,
  gradeFilter,
  onCycleGrade,
  sort,
  ppSort,
  ageSort,
  onChangeSort,
}: {
  availableKeyModes: string[];
  keyFilter: KeyFilter;
  onChangeKeyFilter: (keyFilter: KeyFilter) => void;
  maxInlineKeyModes: number;
  keyModePlayCounts: Record<string, number>;
  onKeyModeOverflow?: () => void;
  mods: string[];
  modFilter: ModFilterState;
  onCycleMod: (mod: string) => void;
  onReverseCycleMod: (mod: string) => void;
  onClearMods: () => void;
  grades: string[];
  gradeFilter: GradeFilter;
  onCycleGrade: (grade: string, reverse: boolean) => void;
  sort: BestSort;
  ppSort: BestPpSort;
  ageSort: BestAgeSort;
  onChangeSort: (sort: BestSort) => void;
}) {
  const { t } = useLingui();
  const hasActiveFilter = Object.keys(modFilter).length > 0;

  return (
    <div className="mt-3 flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
      {/* Below lg the label/chip pairs share a two-column grid so Grade lines up under Mods. */}
      <div className="order-2 grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2 gap-y-2 min-w-0 lg:order-1 lg:flex lg:flex-wrap lg:gap-x-4">
        <div className="contents lg:flex lg:items-center lg:gap-2 lg:flex-wrap lg:min-w-0">
          <span className="text-[9px] uppercase tracking-wider text-osu-f1 font-semibold shrink-0">{t`Mods`}</span>
          {mods.length === 0 ? (
            <span className="text-[11px] text-osu-f1">{t`No mods in top plays`}</span>
          ) : (
            <div className="flex items-center gap-2 flex-wrap min-w-0">
              <div className="flex items-center gap-1 flex-wrap">
                {mods.map((mod) => (
                  <ModFilterChip
                    key={mod}
                    mod={mod}
                    mode={modFilter[mod]}
                    onClick={() => onCycleMod(mod)}
                    onContextMenu={() => onReverseCycleMod(mod)}
                  />
                ))}
              </div>
              {hasActiveFilter && (
                <button
                  type="button"
                  onClick={onClearMods}
                  className="text-[10px] font-semibold text-osu-f1 hover:text-osu-l2 underline underline-offset-2 cursor-pointer"
                >
                  {t`Clear`}
                </button>
              )}
            </div>
          )}
        </div>
        {(grades.length > 1 || Object.keys(gradeFilter).length > 0) && (
          <div className="contents lg:flex lg:items-center lg:gap-2 lg:border-l lg:border-white/[0.07] lg:pl-4 lg:min-w-0">
            <span className="text-[9px] uppercase tracking-wider text-osu-f1 font-semibold shrink-0">{t`Grade`}</span>
            <div className="flex items-center gap-1 flex-wrap">
              {grades.map((grade) => (
                <GradeFilterChip
                  key={grade}
                  grade={grade}
                  mode={gradeFilter[grade]}
                  onCycle={(reverse) => onCycleGrade(grade, reverse)}
                />
              ))}
            </div>
          </div>
        )}
      </div>
      <div className="order-1 flex w-full min-w-0 flex-nowrap items-center justify-between gap-2 lg:order-2 lg:w-auto lg:flex-col lg:items-end lg:justify-start">
        {availableKeyModes.length > 1 && (
          // Shrinks so the keymode strip scrolls inside itself instead of pushing
          // the sort buttons off the right edge (a 4K-to-18K player overflows).
          <div className="min-w-0 flex-1 lg:hidden">
            <KeyModeControl
              availableKeyModes={availableKeyModes}
              keyFilter={keyFilter}
              onChangeKeyFilter={onChangeKeyFilter}
              maxVisible={maxInlineKeyModes}
              playCounts={keyModePlayCounts}
              onOverflow={onKeyModeOverflow}
            />
          </div>
        )}
        <BestSortControl sort={sort} ppSort={ppSort} ageSort={ageSort} onChangeSort={onChangeSort} />
      </div>
    </div>
  );
}

/** A grade's chip, cycled like a mod chip: left click forward, right click back. */
export function GradeFilterChip({
  grade,
  mode,
  onCycle,
}: {
  grade: string;
  mode: ModFilterMode | undefined;
  onCycle: (reverse: boolean) => void;
}) {
  const { t } = useLingui();
  const title = mode === "include"
    ? t`Showing only ${grade}`
    : mode === "exclude"
      ? t`Hiding ${grade}`
      : t`Click to require ${grade}`;
  return (
    <button
      type="button"
      onClick={() => onCycle(false)}
      onContextMenu={(event) => {
        event.preventDefault();
        onCycle(true);
      }}
      title={title}
      aria-label={title}
      className={`relative flex items-center rounded-md border px-1.5 py-1 transition-colors cursor-pointer ${mode === "include"
          ? "border-osu-green-light bg-osu-green/15"
          : mode === "exclude"
            ? "border-osu-red-light bg-osu-red/15"
            : "border-osu-b3/30 bg-osu-b4/50 hover:bg-osu-b3/40"
        }`}
    >
      <GradeImg
        grade={grade === "SS" ? "X" : grade}
        size={22}
        className={mode === "exclude" ? "opacity-40 saturate-50" : undefined}
      />
      {mode === "exclude" && (
        <span
          className="pointer-events-none absolute left-1 right-1 top-1/2 h-[2px] -translate-y-1/2 rotate-[-10deg] rounded-full bg-osu-red-light shadow-[0_0_0_1px_rgba(0,0,0,0.5)]"
          aria-hidden="true"
        />
      )}
    </button>
  );
}

export function BestSortControl({
  sort,
  ppSort,
  ageSort,
  onChangeSort,
}: {
  sort: BestSort;
  ppSort: BestPpSort;
  ageSort: BestAgeSort;
  onChangeSort: (sort: BestSort) => void;
}) {
  const { t } = useLingui();
  const ppActive = sort === "pp-desc" || sort === "pp-asc";
  const ppDirection = ppSort === "pp-asc" ? "asc" : "desc";
  const nextPpSort: BestPpSort = ppActive
    ? (ppSort === "pp-desc" ? "pp-asc" : "pp-desc")
    : ppSort;
  const ageActive = sort === "newest" || sort === "oldest";
  const ageDirection = ageSort === "oldest" ? "asc" : "desc";
  const nextAgeSort: BestAgeSort = ageActive
    ? (ageSort === "newest" ? "oldest" : "newest")
    : ageSort;

  return (
    <div className="flex items-center gap-1 shrink-0">
      <span className="hidden text-[9px] uppercase tracking-wider text-osu-f1 font-semibold sm:inline">{t`Sort`}</span>
      <div className="flex items-center gap-0.5 rounded-lg bg-osu-b4/60 border border-osu-b3/20 p-0.5 sm:gap-1 sm:p-1">
        <button
          type="button"
          onClick={() => onChangeSort(nextPpSort)}
          title={ppSort === "pp-asc" ? t`Lowest PP first` : t`Highest PP first`}
          className={`inline-flex items-center gap-1 px-2 py-1.5 rounded-md text-[10px] font-semibold transition-colors cursor-pointer sm:px-3 sm:text-[11px] ${ppActive
              ? "bg-osu-pink/15 text-osu-pink-light"
              : "text-osu-f1 hover:text-osu-l2 hover:bg-osu-b3/50"
            }`}
        >
          <span>PP</span>
          <SortArrow direction={ppDirection} />
        </button>
        <button
          type="button"
          onClick={() => onChangeSort(nextAgeSort)}
          title={ageSort === "oldest" ? t`Oldest first` : t`Newest first`}
          className={`inline-flex items-center gap-1 px-2 py-1.5 rounded-md text-[10px] font-semibold transition-colors cursor-pointer sm:px-3 sm:text-[11px] ${ageActive
              ? "bg-osu-pink/15 text-osu-pink-light"
              : "text-osu-f1 hover:text-osu-l2 hover:bg-osu-b3/50"
            }`}
        >
          <Trans>Date</Trans>
          <SortArrow direction={ageDirection} />
        </button>
      </div>
    </div>
  );
}

/**
 * Which keymodes a crowded strip keeps inline, and which fall to the overflow.
 *
 * A profile with 4K through 18K on it has more chips than a phone row holds,
 * and they are not worth the same: two 18K plays are a novelty beside a 200
 * play 7K list. So the strip keeps the keymodes with the most plays, and the
 * rest go behind one chip. What is kept is still drawn in numeric order, since
 * ranking the chips themselves would move 4K around per profile.
 *
 * The active filter is always kept, or picking a keymode from the overflow
 * would hide the chip that says which one is on.
 */
export function selectVisibleKeyModes(
  availableKeyModes: string[],
  keyFilter: KeyFilter,
  playCounts: Record<string, number>,
  maxVisible: number,
): string[] {
  if (availableKeyModes.length <= maxVisible) return availableKeyModes;
  const ranked = [...availableKeyModes].sort((a, b) =>
    (playCounts[b] ?? 0) - (playCounts[a] ?? 0)
    || Number(a.replace("k", "")) - Number(b.replace("k", "")));
  const kept = new Set(ranked.slice(0, Math.max(1, maxVisible)));
  if (keyFilter !== "all") kept.add(keyFilter);
  return availableKeyModes.filter((keyMode) => kept.has(keyMode));
}

export function KeyModeControl({
  availableKeyModes,
  keyFilter,
  onChangeKeyFilter,
  maxVisible,
  playCounts,
  onOverflow,
}: {
  availableKeyModes: string[];
  keyFilter: KeyFilter;
  onChangeKeyFilter: (keyFilter: KeyFilter) => void;
  /** Chips to keep inline before the rest collapse. Unset keeps all of them. */
  maxVisible?: number;
  playCounts?: Record<string, number>;
  /** Opens a fuller picker instead of unfolding the rest of the strip in place. */
  onOverflow?: () => void;
}) {
  const { t } = useLingui();
  const [expanded, setExpanded] = useState(false);
  const visibleKeyModes = useMemo(() => (
    maxVisible == null || expanded
      ? availableKeyModes
      : selectVisibleKeyModes(availableKeyModes, keyFilter, playCounts ?? {}, maxVisible)
  ), [availableKeyModes, expanded, keyFilter, maxVisible, playCounts]);
  const hiddenCount = availableKeyModes.length - visibleKeyModes.length;

  return (
    // Someone who plays every keymode makes this strip wider than a phone. It
    // scrolls inside its own box rather than running off the screen, and the
    // box never grows past its parent, so the sort buttons beside it stay put.
    // Unfolded it holds more chips than the row it sits in is wide, so it wraps
    // onto as many lines as it needs instead of scrolling: a scrolling strip
    // clips its last chip against the edge, and the point of unfolding is to
    // see every keymode. It also gives up its desktop shrink-0 there, so it
    // takes the width it can rather than squeezing the tabs beside it.
    <div className={`inline-flex max-w-full min-w-0 items-center gap-0.5 rounded-lg bg-osu-b4/60 border border-osu-b3/20 p-0.5 sm:gap-1 sm:p-1 ${
      expanded ? "flex-wrap" : "overflow-x-auto scrollbar-hide lg:shrink-0"
    }`}>
      {[["all", t`All`] as const, ...visibleKeyModes.map((k) => [k, k.toUpperCase()] as const)].map(([value, label]) => (
        <button
          key={value}
          onClick={() => onChangeKeyFilter(value)}
          className={`shrink-0 px-2 py-1.5 rounded-md text-[10px] font-semibold transition-colors cursor-pointer sm:px-3 sm:text-[11px] ${keyFilter === value
              ? "bg-osu-pink/15 text-osu-pink-light"
              : "text-osu-f1 hover:text-osu-l2 hover:bg-osu-b3/50"
            }`}
        >
          {label}
        </button>
      ))}
      {hiddenCount > 0 && (
        /* On Best the rest live in the PP by Keymode modal, which lists every
           keymode with what it is worth and how many plays it holds - more to
           go on than a menu of the same chips would give. Everywhere else the
           strip just unfolds, since a keymode with no pp still has plays. */
        <button
          type="button"
          onClick={onOverflow ?? (() => setExpanded(true))}
          title={t`All keymodes`}
          className="shrink-0 px-2 py-1.5 rounded-md text-[10px] font-semibold text-osu-f1 transition-colors cursor-pointer hover:text-osu-l2 hover:bg-osu-b3/50 sm:px-3 sm:text-[11px]"
        >
          +{hiddenCount}
        </button>
      )}
    </div>
  );
}

