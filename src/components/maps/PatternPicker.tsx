import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { useLingui } from "@lingui/react/macro";
import { PATTERN_COLOR, usePatternLabel } from "./SearchCard";
import { playPatternHit } from "./patternSfx";
import type { TriStateMode } from "../../lib/maps-random-filter";

// Hit-to-select: tapping a pattern lands like hitting a note. An osu-style ring
// bursts outward and a soft hitsound plays, then the chip stays lit in its color.
// Squared chips, color-coded so the row reads as a palette.
//
// Families with subfamilies carry a fused caret segment; it opens a floating
// panel anchored under the pill (overlay, never pushes layout). Family chips
// filter by dominant pattern, sub-chips by detected patterns; both mix freely.

const PATTERN_OPTIONS = ["jack", "stream", "jumpstream", "handstream", "stamina", "chordjack", "tech", "ln"];

const SUBFAMILIES: Record<string, string[]> = {
  jack: ["speedjack", "handjack"],
  stream: ["dumpstream", "quadstream", "chordstream", "delay", "bracket"],
  ln: ["lngeneral", "lnrelease", "lninverse", "lntech"],
};

// Each keymode speaks its own pattern vocabulary, mirroring the per-keymode
// branches in the backend analyzer: 4K charts are tagged with jump/hand/quad/
// dumpstream and jack subfamilies, 7K charts with chordstream/delay/bracket,
// everything else with the wide-key stream set. Jack and stream stay in every
// list: the analyzer detects both for all keymodes. The LN subfamilies are 4K
// and 7K only, and 4K omits LN Release: the release ramps are measured on 7K
// charts, so the analyzer doesn't emit the tag on 4 columns at all.
// The full generic list only shows when the Keys facet is empty or mixed.
const KEYMODE_PATTERN_OPTIONS: Record<string, string[]> = {
  "4k": ["jack", "stream", "jumpstream", "handstream", "stamina", "chordjack", "tech", "ln"],
  "7k": ["jack", "stream", "chordstream", "delay", "bracket", "stamina", "chordjack", "tech", "ln"],
  other: ["jack", "stream", "chordstream", "delay", "bracket", "stamina", "chordjack", "tech", "ln"],
};

const KEYMODE_SUBFAMILIES: Record<string, Record<string, string[]>> = {
  "4k": {
    jack: ["speedjack", "handjack"],
    stream: ["dumpstream", "quadstream"],
    ln: ["lngeneral", "lninverse", "lntech"],
  },
  "7k": { ln: ["lngeneral", "lnrelease", "lninverse", "lntech"] },
  other: {},
};

function pickerVocabulary(keys: string[]): { options: string[]; subfamilies: Record<string, string[]> } {
  const context = keys.length === 1 ? keys[0] : null;
  if (context && KEYMODE_PATTERN_OPTIONS[context]) {
    return { options: KEYMODE_PATTERN_OPTIONS[context], subfamilies: KEYMODE_SUBFAMILIES[context] ?? {} };
  }
  return { options: PATTERN_OPTIONS, subfamilies: SUBFAMILIES };
}

// All pattern ids selectable under a Keys facet selection, so key toggles can
// prune pattern picks that no longer exist in the new keymode.
export function validPatternIds(keys: string[]): Set<string> {
  const { options, subfamilies } = pickerVocabulary(keys);
  return new Set([...options, ...Object.values(subfamilies).flat()]);
}

function PatternChip({
  pattern,
  mode,
  hasAnyActive,
  onToggle,
  small = false,
  attachRight = false,
  className = "",
}: {
  pattern: string;
  mode: TriStateMode | undefined;
  hasAnyActive: boolean;
  onToggle: (pattern: string, reverse: boolean) => void;
  small?: boolean;
  attachRight?: boolean;
  className?: string;
}) {
  const { t } = useLingui();
  const patternName = usePatternLabel();
  const color = PATTERN_COLOR[pattern] ?? "#cfcfe6";
  // Bumped on each select so the burst ring remounts and replays.
  const [burst, setBurst] = useState(0);

  const handleClick = () => {
    const willInclude = mode == null;
    onToggle(pattern, false);
    playPatternHit(willInclude);
    if (willInclude) setBurst((value) => value + 1);
  };
  const handleContextMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    const willInclude = mode === "exclude";
    onToggle(pattern, true);
    playPatternHit(willInclude);
    if (willInclude) setBurst((value) => value + 1);
  };

  const radius = attachRight ? "rounded-md rounded-r-none" : "rounded-md";
  const title = mode === "include"
    ? t`Including (click to exclude)`
    : mode === "exclude"
      ? t`Excluding (click to clear)`
      : t`Click to include, right-click to exclude`;
  return (
    <motion.button
      type="button"
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      aria-pressed={mode === "exclude" ? "mixed" : mode === "include"}
      title={title}
      whileHover={{ scale: small ? 1.04 : 1.03 }}
      whileTap={{ scale: 0.95 }}
      transition={{ type: "spring", stiffness: 600, damping: 30 }}
      className={`relative font-bold cursor-pointer transition-colors duration-150 ${radius} ${
        small
          ? "px-2.5 py-1 text-[11.5px]"
          : "px-2 py-1 text-[11px] sm:px-3.5 sm:py-1.5 sm:text-[12.5px]"
      } ${className}`}
      style={
        mode === "include"
          ? { background: color, color: "#11111a" }
          : {
              background: "transparent",
              color,
              boxShadow: `inset 0 0 0 1.5px ${color}59`,
              opacity: mode === "exclude" ? 0.8 : hasAnyActive ? 0.55 : 1,
            }
      }
    >
      {/* osu-style hit burst: a ring that expands out and fades on each select */}
      {burst > 0 && (
        <motion.span
          key={burst}
          aria-hidden="true"
          className={`absolute inset-0 pointer-events-none ${radius}`}
          style={{ border: `2px solid ${color}` }}
          initial={{ scale: 1, opacity: 0.7 }}
          animate={{ scale: 1.22, opacity: 0 }}
          transition={{ duration: 0.4, ease: "easeOut" }}
        />
      )}
      <span className={`relative z-10 ${mode === "exclude" ? "opacity-70" : ""}`}>{patternName(pattern)}</span>
      {mode === "exclude" && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute left-2 right-2 top-1/2 z-20 h-[1.5px] -translate-y-1/2 rotate-[-8deg] rounded-full bg-osu-red/80"
        />
      )}
    </motion.button>
  );
}

// The caret half of a split family pill: opens the subfamily flyout. When subs
// are selected it shows their count instead of the chevron, so collapsed state
// still reveals that filters live inside.
function SubfamilyCaret({
  pattern,
  open,
  count,
  onClick,
}: {
  pattern: string;
  open: boolean;
  count: number;
  onClick: () => void;
}) {
  const { t } = useLingui();
  const patternName = usePatternLabel();
  const color = PATTERN_COLOR[pattern] ?? "#cfcfe6";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={open}
      aria-label={t`${patternName(pattern)} subfamilies`}
      className="grid w-5 shrink-0 place-items-center rounded-md rounded-l-none cursor-pointer transition-colors"
      style={
        count > 0
          ? { background: `${color}2e`, color, boxShadow: `inset 0 0 0 1.5px ${color}59` }
          : { color, boxShadow: `inset 0 0 0 1.5px ${color}40` }
      }
    >
      {count > 0 && !open ? (
        <span className="text-[10px] font-black">{count}</span>
      ) : (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`h-3 w-3 transition-transform duration-150 ${open ? "rotate-180" : ""}`}
          aria-hidden="true"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      )}
    </button>
  );
}

export function PatternPicker({
  selected,
  excluded = [],
  keys = [],
  onToggle,
}: {
  selected: string[];
  excluded?: string[];
  keys?: string[];
  onToggle: (pattern: string, reverse: boolean) => void;
}) {
  const { t } = useLingui();
  const patternName = usePatternLabel();
  const [openFamily, setOpenFamily] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const { options, subfamilies } = pickerVocabulary(keys);
  // Selections outside this keymode's vocabulary (a shared URL, usually) still
  // render as plain chips so an active filter is never invisible.
  const reachable = new Set([...options, ...Object.values(subfamilies).flat()]);
  const activePatterns = [...new Set([...selected, ...excluded])];
  const orphans = activePatterns.filter((pattern) => !reachable.has(pattern));
  const hasAnyActive = activePatterns.length > 0;
  const modeFor = (pattern: string): TriStateMode | undefined =>
    selected.includes(pattern) ? "include" : excluded.includes(pattern) ? "exclude" : undefined;

  // A keymode switch can drop the family whose flyout is open.
  const vocabularyKey = options.join(",");
  useEffect(() => {
    setOpenFamily(null);
  }, [vocabularyKey]);

  useEffect(() => {
    if (!openFamily) return;
    const onPointerDown = (event: MouseEvent | TouchEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpenFamily(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenFamily(null);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("touchstart", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("touchstart", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [openFamily]);

  return (
    // Mobile: a compact 3-column grid so the chips read as a tidy matrix instead
    // of ragged wrapped rows, without eating vertical space. From sm up it
    // relaxes back to the natural inline palette row.
    <div ref={rootRef} className="grid grid-cols-3 gap-1.5 sm:flex sm:flex-wrap sm:gap-2">
      {options.map((pattern) => {
        const subs = subfamilies[pattern];
        if (!subs) {
          return (
            <PatternChip
              key={pattern}
              pattern={pattern}
              mode={modeFor(pattern)}
              hasAnyActive={hasAnyActive}
              onToggle={onToggle}
              className="w-full text-center sm:w-auto sm:text-left"
            />
          );
        }
        const open = openFamily === pattern;
        const selectedSubs = subs.filter((sub) => selected.includes(sub) || excluded.includes(sub)).length;
        return (
          <span key={pattern} className="relative inline-flex w-full items-stretch gap-px sm:w-auto">
            <PatternChip
              pattern={pattern}
              mode={modeFor(pattern)}
              hasAnyActive={hasAnyActive}
              onToggle={onToggle}
              attachRight
              className="min-w-0 flex-1 text-center sm:flex-none sm:text-left"
            />
            <SubfamilyCaret
              pattern={pattern}
              open={open}
              count={selectedSubs}
              onClick={() => setOpenFamily(open ? null : pattern)}
            />
            {open && (
              <div
                role="group"
                aria-label={t`${patternName(pattern)} subfamilies`}
                className="absolute left-0 top-[calc(100%+6px)] z-30 flex w-max max-w-[min(280px,80vw)] flex-wrap gap-1.5 rounded-lg bg-osu-b4 p-2 ring-1 ring-white/10 shadow-xl"
              >
                {subs.map((sub) => (
                  <PatternChip
                    key={sub}
                    pattern={sub}
                    mode={modeFor(sub)}
                    hasAnyActive={hasAnyActive}
                    onToggle={onToggle}
                    small
                  />
                ))}
              </div>
            )}
          </span>
        );
      })}
      {orphans.map((pattern) => (
        <PatternChip
          key={pattern}
          pattern={pattern}
          mode={modeFor(pattern)}
          hasAnyActive={hasAnyActive}
          onToggle={onToggle}
          className="w-full text-center sm:w-auto sm:text-left"
        />
      ))}
    </div>
  );
}
