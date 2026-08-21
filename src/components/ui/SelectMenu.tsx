import { useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Trans, useLingui } from "@lingui/react/macro";
import { Check, ChevronDown, type LucideIcon } from "lucide-react";

// A small custom dropdown to replace the native <select>, so category-style pickers match the site
// instead of rendering the OS chrome. Options can carry an icon + accent color; the popover mirrors
// the CountrySelector motion/close-on-outside pattern.

export interface SelectMenuOption<T extends string> {
  value: T;
  label: string;
  icon?: LucideIcon;
  colorClass?: string;
  // Anything the option should carry that is not a lucide glyph, a country flag
  // being the case this exists for. Drawn in the same place as `icon`.
  leading?: ReactNode;
}

interface SelectMenuProps<T extends string> {
  value: T;
  options: SelectMenuOption<T>[];
  onChange: (value: T) => void;
  ariaLabel?: string;
  className?: string;
  align?: "left" | "right";
  // Adds a filter box above the list, for pickers long enough that scrolling
  // for an option is worse than typing it (the country list, say).
  searchable?: boolean;
  /** Defaults to a translated "Search"; pass one only to name what is searched. */
  searchPlaceholder?: string;
  // Fills its container and pushes the chevron to the right, for a select
  // sitting in a form beside full-width inputs rather than in a toolbar.
  block?: boolean;
}

// The popover scrolls past this rather than growing, and flips above the button
// when there is not this much room below it. A twenty-entry list used to open
// downward at full height and run off the bottom of the screen.
const MENU_MAX_HEIGHT_PX = 240;

export function SelectMenu<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  className = "",
  align = "left",
  searchable = false,
  searchPlaceholder,
  block = false,
}: SelectMenuProps<T>) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [dropUp, setDropUp] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const selected = options.find((option) => option.value === value) ?? options[0];
  const query = search.trim().toLowerCase();
  const visibleOptions = query
    ? options.filter((option) => option.label.toLowerCase().includes(query))
    : options;

  useEffect(() => {
    if (!open || !ref.current) return;
    // Measured on open rather than tracked: the popover closes on scroll-adjacent
    // interactions anyway, so one reading at the moment it appears is enough.
    const rect = ref.current.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom;
    setDropUp(below < MENU_MAX_HEIGHT_PX && rect.top > below);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const SelectedIcon = selected?.icon;

  return (
    <div ref={ref} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={`inline-flex items-center gap-1.5 rounded-md border border-osu-b3/50 bg-osu-b4 px-2.5 py-1.5 text-xs font-semibold text-osu-l2 transition-colors hover:border-osu-b3 hover:bg-osu-b4/80 cursor-pointer ${
          block ? "w-full justify-between" : ""
        }`}
      >
        {SelectedIcon && <SelectedIcon className={`h-3.5 w-3.5 ${selected?.colorClass ?? "text-osu-f1"}`} />}
        {selected?.leading}
        {/* flex-1 rather than letting justify-between space it: with a leading
            flag the label would otherwise float in the middle of the button. */}
        <span className={`${selected?.colorClass ?? ""} ${block ? "flex-1 truncate text-left" : ""}`}>
          {selected?.label}
        </span>
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-osu-f1 transition-transform duration-150 ${open ? "rotate-180" : ""}`} />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: dropUp ? 4 : -4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: dropUp ? 4 : -4, scale: 0.98 }}
            transition={{ duration: 0.12 }}
            role="listbox"
            style={{ maxHeight: MENU_MAX_HEIGHT_PX }}
            className={`absolute z-[70] min-w-[9.5rem] overflow-y-auto rounded-lg border border-osu-b3/50 bg-osu-b5 p-1 shadow-[0_12px_28px_rgba(0,0,0,0.55)] ${
              align === "right" ? "right-0" : "left-0"
            } ${dropUp ? "bottom-full mb-1" : "top-full mt-1"} ${block ? "w-full" : ""}`}
          >
            {searchable && (
              <input
                type="text"
                value={search}
                autoFocus
                onChange={(event) => setSearch(event.target.value)}
                placeholder={searchPlaceholder ?? t`Search`}
                className="mb-1 w-full rounded-md border border-osu-b3/40 bg-osu-b4 px-2 py-1.5 text-xs text-osu-l1 placeholder:text-osu-f1/55 focus:border-osu-pink/50 focus:outline-none"
              />
            )}
            {visibleOptions.length === 0 && (
              <div className="px-2.5 py-1.5 text-xs text-osu-f1">
                <Trans>No matches</Trans>
              </div>
            )}
            {visibleOptions.map((option) => {
              const OptionIcon = option.icon;
              const active = option.value === value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={active}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    onChange(option.value);
                    setOpen(false);
                    setSearch("");
                  }}
                  className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs font-medium transition-colors cursor-pointer ${
                    active ? "bg-osu-b3/50 text-white" : "text-osu-l2 hover:bg-osu-b3/40 hover:text-white"
                  }`}
                >
                  {OptionIcon && <OptionIcon className={`h-3.5 w-3.5 ${option.colorClass ?? "text-osu-f1"}`} />}
                  {option.leading}
                  <span className="flex-1">{option.label}</span>
                  {active && <Check className="h-3.5 w-3.5 text-osu-pink" />}
                </button>
              );
            })}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
