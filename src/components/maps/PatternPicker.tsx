import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Trans, useLingui } from "@lingui/react/macro";
import { PATTERN_COLOR, usePatternLabel } from "./SearchCard";
import { ACCENT_CHIP_TEXT, accentChipRing } from "./FilterChips";
import { DAN_SKILLSET_META } from "../../lib/skill-axes";
import { playPatternHit } from "./patternSfx";
import { LnSharePill } from "./LnSharePill";
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
  jack: ["speedjack", "handjack", "quadstream"],
  stream: ["dumpstream", "chordstream", "delay", "bracket"],
  ln: ["lnhybrid", "lntechnical", "lnwalls", "lnspeed", "lngeneral", "lnrelease", "lninverse", "lntech"],
};

// Each keymode speaks its own pattern vocabulary, mirroring the per-keymode
// branches in the backend analyzer: 4K charts are tagged with jump/hand/quad/
// dumpstream and jack subfamilies, 7K charts with chordstream/delay/bracket,
// everything else with the wide-key stream set. Jack and stream stay in every
// list: the analyzer detects both for all keymodes. The LN subfamilies are 4K
// and 7K only: 4K uses the four course stages, while 7K retains General,
// Release, Inverse and Tech.
// The full generic list only shows when the Keys facet is empty or mixed.
const KEYMODE_PATTERN_OPTIONS: Record<string, string[]> = {
  "4k": ["jack", "stream", "jumpstream", "handstream", "stamina", "chordjack", "tech", "ln"],
  "7k": ["jack", "stream", "chordstream", "delay", "bracket", "stamina", "chordjack", "tech", "ln"],
  other: ["jack", "stream", "chordstream", "delay", "bracket", "stamina", "chordjack", "tech", "ln"],
};

const KEYMODE_SUBFAMILIES: Record<string, Record<string, string[]>> = {
  "4k": {
    jack: ["speedjack", "handjack", "quadstream"],
    stream: ["dumpstream"],
    ln: ["lnhybrid", "lntechnical", "lnwalls", "lnspeed"],
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

// The rice dan tiles each keymode's dan breakdown publishes (the backend's
// danSkillsetBuckets): 4K has Stamina, 6K/7K have Stream instead. "other"
// covers 6K; the remaining keymodes have no rice ladder and match nothing.
const SKILL_OPTIONS = ["speed", "stamina", "tech", "jack", "stream"];
const KEYMODE_SKILL_OPTIONS: Record<string, string[]> = {
  "4k": ["speed", "stamina", "tech", "jack"],
  "7k": ["speed", "tech", "jack", "stream"],
  other: ["speed", "tech", "jack", "stream"],
};

function skillVocabulary(keys: string[]): string[] {
  const context = keys.length === 1 ? keys[0] : null;
  return (context && KEYMODE_SKILL_OPTIONS[context]) || SKILL_OPTIONS;
}

export function validSkillIds(keys: string[]): Set<string> {
  return new Set(skillVocabulary(keys));
}

function PatternChip({
  pattern,
  mode,
  hasAnyActive,
  onToggle,
  small = false,
  attachRight = false,
  className = "",
  color: colorOverride,
  label,
}: {
  pattern: string;
  mode: TriStateMode | undefined;
  hasAnyActive: boolean;
  onToggle: (pattern: string, reverse: boolean) => void;
  small?: boolean;
  attachRight?: boolean;
  className?: string;
  color?: string;
  label?: string;
}) {
  const { t } = useLingui();
  const patternName = usePatternLabel();
  const color = colorOverride ?? PATTERN_COLOR[pattern] ?? "#cfcfe6";
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
          : "px-3.5 py-2 text-[13.5px] sm:py-1.5 sm:text-[12.5px]"
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
      <span className={`relative z-10 ${mode === "exclude" ? "opacity-70" : ""}`}>{label ?? patternName(pattern)}</span>
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
      className="grid w-8 shrink-0 place-items-center rounded-md rounded-l-none cursor-pointer transition-colors sm:w-5"
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
  lnShare,
  onLnShareChange,
}: {
  selected: string[];
  excluded?: string[];
  keys?: string[];
  onToggle: (pattern: string, reverse: boolean) => void;
  /** Hold share of the map in percent, 0/0 for any; shown as a slider in the LN flyout. */
  lnShare?: { min: number; max: number };
  onLnShareChange?: (min: number, max: number) => void;
}) {
  const lnShareActive = lnShare != null && (lnShare.min > 0 || lnShare.max > 0);
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
    <div ref={rootRef} className="relative grid grid-cols-3 gap-1.5 sm:flex sm:flex-wrap sm:gap-2">
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
        const selectedSubs = subs.filter((sub) => selected.includes(sub) || excluded.includes(sub)).length
          + (pattern === "ln" && lnShareActive ? 1 : 0);
        const showLnShare = pattern === "ln" && lnShare != null && onLnShareChange != null;
        return (
          <span key={pattern} className="inline-flex w-full items-stretch gap-px sm:relative sm:w-auto">
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
                className={`absolute left-0 ${pattern === "ln" ? "sm:left-auto sm:right-0" : ""} top-[calc(100%+6px)] z-30 flex max-h-72 w-max max-w-[min(340px,80vw)] flex-wrap gap-1.5 overflow-y-auto rounded-lg bg-osu-b4 p-2 ring-1 ring-white/10 shadow-xl`}
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
                {showLnShare && (
                  <div className="basis-full pt-1">
                    <LnSharePill
                      min={lnShare.min}
                      max={lnShare.max}
                      ariaLabel={t`LN share`}
                      onChange={onLnShareChange}
                      heading={<span className="text-[10px] font-bold uppercase tracking-[0.08em] text-osu-f1/55">{t`LN share`}</span>}
                    />
                  </div>
                )}
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

// The Patterns flyout, grouped by what the pattern is rather than by analyzer
// family: jacks, then streams. Each group keeps only the ids the keymode's
// vocabulary reaches. Stamina and tech are left out because the Skill row and
// the MSD filter already cover them.
const PATTERN_FLYOUT_GROUPS = [
  ["jack", "chordjack", "speedjack", "handjack", "quadstream"],
  ["stream", "jumpstream", "handstream", "chordstream", "dumpstream", "delay", "bracket"],
];

// The Search tab's headline row: the rice dan tiles a chart files under (the
// same filing a clear on it gets for the per-skill dans), then LN with its
// subtypes, then every finer analyzer pattern behind one Patterns flyout.
// Skills and patterns are separate facets that AND together.
export function SkillPicker({
  skills,
  skillsExcluded,
  onToggleSkill,
  patterns,
  patternsExcluded,
  onTogglePattern,
  keys = [],
  lnShare,
  onLnShareChange,
}: {
  skills: string[];
  skillsExcluded: string[];
  onToggleSkill: (skill: string, reverse: boolean) => void;
  patterns: string[];
  patternsExcluded: string[];
  onTogglePattern: (pattern: string, reverse: boolean) => void;
  keys?: string[];
  lnShare: { min: number; max: number };
  onLnShareChange: (min: number, max: number) => void;
}) {
  const { t, i18n } = useLingui();
  const patternName = usePatternLabel();
  const [open, setOpen] = useState<"ln" | "patterns" | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // Outside means outside the open chip and its flyout: the row itself spans
  // the full width, so its empty space must close the flyout too.
  const lnRef = useRef<HTMLSpanElement>(null);
  const patternsRef = useRef<HTMLSpanElement>(null);
  const skillOptions = skillVocabulary(keys);
  const { options, subfamilies } = pickerVocabulary(keys);
  const lnSubs = subfamilies.ln ?? [];
  const reachablePatterns = new Set([...options, ...Object.values(subfamilies).flat()]);
  const patternGroups = PATTERN_FLYOUT_GROUPS
    .map((group) => group.filter((pattern) => reachablePatterns.has(pattern)))
    .filter((group) => group.length > 0);
  const activeSkills = [...new Set([...skills, ...skillsExcluded])];
  const orphanSkills = activeSkills.filter((skill) => !skillOptions.includes(skill));
  const activePatterns = [...new Set([...patterns, ...patternsExcluded])];
  const lnIds = new Set(["ln", ...lnSubs]);
  // Picks the flyout does not offer (a shared URL, usually) stay listed in it
  // so an active filter is never invisible.
  const flyoutPatterns = new Set(patternGroups.flat());
  const orphanPatterns = activePatterns.filter(
    (pattern) => !flyoutPatterns.has(pattern) && !(lnIds.has(pattern) && reachablePatterns.has(pattern)),
  );
  const lnShareActive = lnShare.min > 0 || lnShare.max > 0;
  const lnCount = lnSubs.filter((sub) => activePatterns.includes(sub)).length + (lnShareActive ? 1 : 0);
  const patternCount = activePatterns.filter((pattern) => !lnIds.has(pattern) || !reachablePatterns.has(pattern)).length;
  const hasAnyActive = activeSkills.length + activePatterns.length > 0;
  const skillMode = (skill: string): TriStateMode | undefined =>
    skills.includes(skill) ? "include" : skillsExcluded.includes(skill) ? "exclude" : undefined;
  const patternMode = (pattern: string): TriStateMode | undefined =>
    patterns.includes(pattern) ? "include" : patternsExcluded.includes(pattern) ? "exclude" : undefined;
  const skillChip = (skill: string, className: string) => {
    const meta = DAN_SKILLSET_META[skill];
    return (
      <PatternChip
        key={`skill:${skill}`}
        pattern={skill}
        color={meta?.color}
        label={meta ? i18n._(meta.labelMsg) : skill}
        mode={skillMode(skill)}
        hasAnyActive={hasAnyActive}
        onToggle={onToggleSkill}
        className={className}
      />
    );
  };

  const vocabularyKey = `${skillOptions.join(",")}|${options.join(",")}`;
  useEffect(() => {
    setOpen(null);
  }, [vocabularyKey]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent | TouchEvent) => {
      const anchor = open === "ln" ? lnRef.current : patternsRef.current;
      if (anchor && !anchor.contains(event.target as Node)) setOpen(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(null);
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

  const flyout = "absolute top-[calc(100%+6px)] z-30 rounded-lg bg-osu-b4 p-2 ring-1 ring-white/10 shadow-xl";

  return (
    <div ref={rootRef} className="relative flex flex-wrap gap-2">
      {skillOptions.map((skill) => skillChip(skill, ""))}
      {orphanSkills.map((skill) => skillChip(skill, ""))}

      <span ref={lnRef} className="inline-flex items-stretch gap-px sm:relative">
        <PatternChip
          pattern="ln"
          mode={patternMode("ln")}
          hasAnyActive={hasAnyActive}
          onToggle={onTogglePattern}
          attachRight
          className=""
        />
        <SubfamilyCaret pattern="ln" open={open === "ln"} count={lnCount} onClick={() => setOpen(open === "ln" ? null : "ln")} />
        {open === "ln" && (
          <div
            role="group"
            aria-label={t`${patternName("ln")} subfamilies`}
            className={`${flyout} left-0 flex max-h-72 w-max max-w-[min(340px,80vw)] flex-wrap gap-1.5 overflow-y-auto`}
          >
            {lnSubs.map((sub) => (
              <PatternChip key={sub} pattern={sub} mode={patternMode(sub)} hasAnyActive={hasAnyActive} onToggle={onTogglePattern} small />
            ))}
            <div className="basis-full pt-1">
              <LnSharePill
                min={lnShare.min}
                max={lnShare.max}
                ariaLabel={t`LN share`}
                onChange={onLnShareChange}
                heading={<span className="text-[10px] font-bold uppercase tracking-[0.08em] text-osu-f1/55">{t`LN share`}</span>}
              />
            </div>
          </div>
        )}
      </span>

      <span ref={patternsRef} className="inline-flex sm:relative">
        <button
          type="button"
          onClick={() => setOpen(open === "patterns" ? null : "patterns")}
          aria-expanded={open === "patterns"}
          aria-haspopup="dialog"
          className="inline-flex items-center justify-center gap-1.5 rounded-md px-3.5 py-2 text-[13.5px] font-bold cursor-pointer transition-colors sm:py-1.5 sm:text-[12.5px]"
          style={{
            color: ACCENT_CHIP_TEXT,
            background: open === "patterns" ? "color-mix(in srgb, var(--color-osu-pink) 12%, transparent)" : "transparent",
            boxShadow: accentChipRing(open === "patterns" ? 90 : patternCount > 0 ? 65 : 35),
          }}
        >
          <Trans>Patterns</Trans>
          {patternCount > 0 ? (
            <span className="rounded-full bg-osu-pink px-1.5 text-[10px] font-bold leading-4 text-white tabular-nums">{patternCount}</span>
          ) : (
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={`h-3 w-3 transition-transform duration-150 ${open === "patterns" ? "rotate-180" : ""}`}
              aria-hidden="true"
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
          )}
        </button>
        {open === "patterns" && (
          <div
            role="group"
            aria-label={t`Patterns`}
            className={`${flyout} left-0 right-0 flex max-h-[min(420px,70vh)] flex-col gap-2 overflow-y-auto sm:left-auto sm:w-[min(400px,92vw)]`}
          >
            {patternGroups.map((group, index) => (
              <div key={group[0]} className={`flex flex-wrap items-center gap-1.5 ${index > 0 ? "border-t border-white/[0.07] pt-2" : ""}`}>
                {group.map((pattern) => (
                  <PatternChip key={pattern} pattern={pattern} mode={patternMode(pattern)} hasAnyActive={hasAnyActive} onToggle={onTogglePattern} small />
                ))}
              </div>
            ))}
            {orphanPatterns.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 border-t border-white/[0.07] pt-2">
                {orphanPatterns.map((pattern) => (
                  <PatternChip key={pattern} pattern={pattern} mode={patternMode(pattern)} hasAnyActive={hasAnyActive} onToggle={onTogglePattern} small />
                ))}
              </div>
            )}
          </div>
        )}
      </span>
    </div>
  );
}
