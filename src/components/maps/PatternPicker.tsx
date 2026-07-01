import { useState } from "react";
import { motion } from "framer-motion";
import { PATTERN_COLOR, patternLabel } from "./SearchCard";
import { playPatternHit } from "./patternSfx";

// Hit-to-select: tapping a pattern lands like hitting a note. An osu-style ring
// bursts outward and a soft hitsound plays, then the chip stays lit in its color.
// Squared chips, color-coded so the row reads as a palette.

const PATTERN_OPTIONS = ["jack", "stream", "jumpstream", "handstream", "stamina", "chordjack", "tech", "ln"];

function PatternChip({ pattern, active, onToggle }: { pattern: string; active: boolean; onToggle: (pattern: string) => void }) {
  const color = PATTERN_COLOR[pattern] ?? "#cfcfe6";
  // Bumped on each select so the burst ring remounts and replays.
  const [burst, setBurst] = useState(0);

  const handleClick = () => {
    const willActivate = !active;
    onToggle(pattern);
    playPatternHit(willActivate);
    if (willActivate) setBurst((value) => value + 1);
  };

  return (
    <motion.button
      type="button"
      onClick={handleClick}
      aria-pressed={active}
      whileHover={{ scale: 1.03 }}
      whileTap={{ scale: 0.95 }}
      transition={{ type: "spring", stiffness: 600, damping: 30 }}
      className="relative rounded-md px-3.5 py-1.5 text-[12.5px] font-bold cursor-pointer transition-colors duration-150"
      style={
        active
          ? { background: color, color: "#11111a" }
          : { background: "transparent", color, boxShadow: `inset 0 0 0 1.5px ${color}59` }
      }
    >
      {/* osu-style hit burst: a ring that expands out and fades on each select */}
      {burst > 0 && (
        <motion.span
          key={burst}
          aria-hidden="true"
          className="absolute inset-0 rounded-md pointer-events-none"
          style={{ border: `2px solid ${color}` }}
          initial={{ scale: 1, opacity: 0.7 }}
          animate={{ scale: 1.22, opacity: 0 }}
          transition={{ duration: 0.4, ease: "easeOut" }}
        />
      )}
      <span className="relative z-10">{patternLabel(pattern)}</span>
    </motion.button>
  );
}

export function PatternPicker({ selected, onToggle }: { selected: string[]; onToggle: (pattern: string) => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      {PATTERN_OPTIONS.map((pattern) => (
        <PatternChip key={pattern} pattern={pattern} active={selected.includes(pattern)} onToggle={onToggle} />
      ))}
    </div>
  );
}
