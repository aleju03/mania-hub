import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { motion } from "framer-motion";
import type { TriStateMode } from "../../lib/maps-random-filter";

// The filter-chip language shared by the maps search tab and the browse tabs
// (farmed / most played / favourites / random): outlined accent chips that fill
// when active, colored status chips matching the card badges, and the mobile
// toolbar's sort dropdown + direction toggle.

// Keys and other accent-family facets speak the pattern/status chip language
// (outlined when off, filled when on) in the theme accent, so they read as
// their own facet family without going flat white.
export const ACCENT_CHIP_TEXT = "var(--color-osu-pink-light)";
export const ACCENT_CHIP_FILL = "var(--color-osu-pink)";
export const accentChipRing = (alpha: number) =>
  `inset 0 0 0 1.5px color-mix(in srgb, var(--color-osu-pink) ${alpha}%, transparent)`;

// Match the card status pills (statusPill() in SearchCard) so the filters read
// like the badges on the cards: green ranked, blue qualified, pink loved, grey
// graveyard, yellow pending.
export const STATUS_COLOR: Record<string, string> = {
  ranked: "#6cf27f",
  qualified: "#66ccff",
  loved: "#f26fa6",
  graveyard: "#b3b3b3",
  other: "#ffd36b",
};

export function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      whileHover={{ scale: 1.03 }}
      whileTap={{ scale: 0.95 }}
      transition={{ type: "spring", stiffness: 600, damping: 30 }}
      className="rounded-md px-3.5 py-1.5 text-[12.5px] font-bold cursor-pointer transition-colors duration-150"
      style={
        active
          ? { background: ACCENT_CHIP_FILL, color: "#11111a" }
          : { background: "transparent", color: ACCENT_CHIP_TEXT, boxShadow: accentChipRing(35) }
      }
    >
      {children}
    </motion.button>
  );
}

// Status chips styled as the card status badges: solid coloured pill when on,
// outlined in the same colour when off.
export function StatusChip({ id, label, active, onClick }: { id: string; label: string; active: boolean; onClick: () => void }) {
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

// Shared tri-state chip: click cycles none -> include -> exclude -> none;
// right-click runs that cycle in reverse so a neutral option can be excluded
// immediately. Search and Random use the same interaction and visual language.
export function TriStatePill({
  mode,
  hasAnyActive,
  onClick,
  onContextMenu,
  color,
  pill = false,
  children,
}: {
  mode: TriStateMode | undefined;
  hasAnyActive: boolean;
  onClick: () => void;
  onContextMenu: () => void;
  color?: string;
  pill?: boolean;
  children: React.ReactNode;
}) {
  const style: CSSProperties = color
    ? mode === "include"
      ? { background: color, color: "#11111a" }
      : {
          background: "transparent",
          color,
          boxShadow: `inset 0 0 0 1.5px ${color}59`,
          opacity: mode === "exclude" ? 0.8 : hasAnyActive ? 0.55 : 1,
        }
    : mode === "include"
      ? { background: ACCENT_CHIP_FILL, color: "#11111a" }
      : mode === "exclude"
        ? {
            background: "transparent",
            color: "var(--color-osu-red-light)",
            boxShadow: "inset 0 0 0 1.5px color-mix(in srgb, var(--color-osu-red) 55%, transparent)",
          }
        : {
            background: "transparent",
            color: ACCENT_CHIP_TEXT,
            boxShadow: accentChipRing(35),
            opacity: hasAnyActive ? 0.55 : 1,
          };
  const title = mode === "include"
    ? "Including (click to exclude)"
    : mode === "exclude"
      ? "Excluding (click to clear)"
      : "Click to include, right-click to exclude";
  return (
    <motion.button
      type="button"
      onClick={onClick}
      onContextMenu={(event) => {
        event.preventDefault();
        onContextMenu();
      }}
      aria-pressed={mode === "exclude" ? "mixed" : mode === "include"}
      whileTap={{ scale: 0.94 }}
      transition={{ type: "spring", stiffness: 600, damping: 30 }}
      title={title}
      className={`relative cursor-pointer transition-[background-color,color,opacity] duration-150 ${
        pill
          ? "inline-flex items-center rounded-full px-3 py-1.5 text-[11px] font-extrabold uppercase tracking-wide leading-none"
          : "rounded-md px-3.5 py-1.5 text-[12.5px] font-bold"
      }`}
      style={style}
    >
      <span className={mode === "exclude" ? "opacity-70" : ""}>{children}</span>
      {mode === "exclude" && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute left-2.5 right-2.5 top-1/2 h-[1.5px] -translate-y-1/2 rotate-[-8deg] rounded-full bg-osu-red/80"
        />
      )}
    </motion.button>
  );
}

export function ChipGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-osu-f1/55">{label}</span>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  );
}

export interface SortOption {
  id: string;
  label: string;
}

// Custom sort dropdown for the mobile toolbar, styled like the random tab's
// difficulty picker so it doesn't fall back to the OS-native select look.
export function SortSelect({ options, value, onChange }: { options: SortOption[]; value: string; onChange: (id: string) => void }) {
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

  const selected = options.find((option) => option.id === value) ?? options[0];

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
          {options.map((option) => {
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

export function DirButton({ dir, onToggle }: { dir: string; onToggle: () => void }) {
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
