import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
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
  const [place, setPlace] = useState<CSSProperties | null>(null);
  // Touch screens open without focusing the search box, so the keyboard stays down until asked for.
  const [focusSearch, setFocusSearch] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // Matched by attribute, not menuRef: the search box focuses itself before the
  // menu's ref is attached, and that blur must not read as leaving the menu.
  const menuId = useId();
  const inside = (node: Node | null) => Boolean(node && (
    ref.current?.contains(node) || (node instanceof Element && node.closest("[data-select-menu]")?.getAttribute("data-select-menu") === menuId)
  ));
  const selected = options.find((option) => option.value === value) ?? options[0];
  const query = search.trim().toLowerCase();
  const visibleOptions = query
    ? options.filter((option) => option.label.toLowerCase().includes(query))
    : options;

  // The popover is portalled and fixed to the viewport, so a scrolling or
  // clipped parent (a modal body) can never cut it off. Placed on open and
  // kept on the trigger while anything scrolls or resizes.
  useLayoutEffect(() => {
    if (!open) return;
    setFocusSearch(typeof window.matchMedia !== "function" || window.matchMedia("(hover: hover) and (pointer: fine)").matches);
    const measure = () => {
      if (!ref.current) return;
      const rect = ref.current.getBoundingClientRect();
      const below = window.innerHeight - rect.bottom - 8;
      const above = rect.top - 8;
      const up = below < MENU_MAX_HEIGHT_PX && above > below;
      setDropUp(up);
      setPlace({
        position: "fixed",
        ...(up ? { bottom: window.innerHeight - rect.top + 4 } : { top: rect.bottom + 4 }),
        ...(align === "right" ? { right: window.innerWidth - rect.right } : { left: rect.left }),
        ...(block ? { width: rect.width } : {}),
        maxHeight: Math.max(120, Math.min(MENU_MAX_HEIGHT_PX, (up ? above : below) - 4)),
      });
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open, align, block]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!inside(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
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
    <div
      ref={ref}
      className={`relative ${className}`}
      onBlur={(event) => {
        if (!inside(event.relatedTarget as Node | null)) setOpen(false);
      }}
      onKeyDown={(event) => {
        const arrow = event.key === "ArrowDown" || event.key === "ArrowUp";
        const edge = open && (event.key === "Home" || event.key === "End") && !(event.target instanceof HTMLInputElement);
        if (!arrow && !edge) return;
        event.preventDefault();
        const key = event.key;
        const focusOption = () => {
          const buttons = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? []);
          if (!buttons.length) return;
          const focused = buttons.indexOf(document.activeElement as HTMLButtonElement);
          const selectedIndex = Math.max(0, buttons.findIndex((button) => button.getAttribute("aria-selected") === "true"));
          const index = key === "Home" ? 0 : key === "End" ? buttons.length - 1 : focused < 0 ? selectedIndex
            : (focused + (key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
          buttons[index].focus();
        };
        if (!open) {
          setOpen(true);
          requestAnimationFrame(focusOption);
        } else focusOption();
      }}
    >
      <button
        ref={triggerRef}
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

      {typeof document !== "undefined" && createPortal(
      <AnimatePresence>
        {open && place && (
          <motion.div
            ref={menuRef}
            data-select-menu={menuId}
            initial={{ opacity: 0, y: dropUp ? 4 : -4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: dropUp ? 4 : -4, scale: 0.98 }}
            transition={{ duration: 0.12 }}
            role="listbox"
            aria-label={ariaLabel}
            style={place}
            className="z-[300] min-w-[9.5rem] overflow-y-auto rounded-lg border border-osu-b3/50 bg-osu-b5 p-1 shadow-[0_12px_28px_rgba(0,0,0,0.55)]"
          >
            {searchable && (
              <input
                type="text"
                value={search}
                autoFocus={focusSearch}
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
                  onClick={() => {
                    onChange(option.value);
                    setOpen(false);
                    setSearch("");
                    triggerRef.current?.focus();
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
      </AnimatePresence>,
      document.body,
      )}
    </div>
  );
}
