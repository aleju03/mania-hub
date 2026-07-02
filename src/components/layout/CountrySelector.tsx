import { useState, useEffect, useRef, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronDown } from "lucide-react";
import {
  COUNTRY_OPTIONS,
  GLOBAL_SCOPE_CODE,
  GLOBAL_SCOPE_NAME,
  getCountryName,
} from "../../lib/country";
import type { LiveCountryFeatureTier } from "../../lib/live-backend";
import { getCachedCountryTier } from "../../lib/use-country-warming";
import { CountryFlag } from "../ui/CountryFlag";

interface CountrySelectorProps {
  selectedCountry: string;
  onSelect: (country: string) => void;
  className?: string;
  // The Global aggregate is only meaningful when the server is wired up,
  // so the nav opts in based on that.
  showGlobal?: boolean;
  // Optional controlled open state so a parent can coordinate with sibling dropdowns.
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

type CountryOption = (typeof COUNTRY_OPTIONS)[number];
type PickerOption = CountryOption | { code: typeof GLOBAL_SCOPE_CODE; name: typeof GLOBAL_SCOPE_NAME };
type PickerItem =
  | { type: "option"; option: PickerOption; selectable: boolean; muted: boolean }
  | { type: "separator"; id: string; count: number; expanded: boolean };

const GLOBAL_OPTION = { code: GLOBAL_SCOPE_CODE, name: GLOBAL_SCOPE_NAME } as const;

function isTrackedCountryTier(tier: LiveCountryFeatureTier | null): boolean {
  return tier === "live" || tier === "snipes";
}

export function CountrySelector({
  selectedCountry,
  onSelect,
  className = "",
  showGlobal = false,
  open: openProp,
  onOpenChange,
}: CountrySelectorProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = openProp ?? uncontrolledOpen;
  const setOpen = (value: boolean) => {
    if (openProp === undefined) setUncontrolledOpen(value);
    onOpenChange?.(value);
  };
  const [search, setSearch] = useState("");
  const [notTrackedOpen, setNotTrackedOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const pickerItems = useMemo<PickerItem[]>(() => {
    const q = search.trim().toLowerCase();
    const searching = q.length > 0;
    const countryTiers = new Map(COUNTRY_OPTIONS.map((country) => [country.code, getCachedCountryTier(country.code)]));
    const hasTrackedCountries = showGlobal && COUNTRY_OPTIONS.some((country) => isTrackedCountryTier(countryTiers.get(country.code) ?? null));
    const matchesCountry = (country: CountryOption) => (
      !q || country.name.toLowerCase().includes(q) || country.code.toLowerCase().includes(q)
    );
    const matchesGlobal = !q || GLOBAL_SCOPE_NAME.toLowerCase().includes(q) || GLOBAL_SCOPE_CODE.toLowerCase().includes(q);
    const countries = COUNTRY_OPTIONS.filter(matchesCountry);
    const trackedCountries = showGlobal
      ? countries.filter((country) => isTrackedCountryTier(countryTiers.get(country.code) ?? null))
      : [];
    const trackedCountryCodes = new Set(trackedCountries.map((country) => country.code));
    const offeredCountries = countries.filter((country) => !trackedCountryCodes.has(country.code));
    const items: PickerItem[] = [];

    if (showGlobal && matchesGlobal) {
      items.push({ type: "option", option: GLOBAL_OPTION, selectable: true, muted: false });
    }
    for (const country of trackedCountries) {
      items.push({ type: "option", option: country, selectable: true, muted: false });
    }
    if (trackedCountries.length > 0 && offeredCountries.length > 0) {
      items.push({ type: "separator", id: "offered-countries", count: offeredCountries.length, expanded: notTrackedOpen || searching });
    }
    if (!hasTrackedCountries || notTrackedOpen || searching) {
      for (const country of offeredCountries) {
        items.push({ type: "option", option: country, selectable: !hasTrackedCountries, muted: hasTrackedCountries });
      }
    }

    return items;
  }, [notTrackedOpen, search, showGlobal]);

  // Reset transient state whenever the dropdown closes (including a controlled close)
  useEffect(() => {
    if (!open) {
      setSearch("");
      setNotTrackedOpen(false);
    }
  }, [open]);

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setSearch("");
        setNotTrackedOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        setSearch("");
        setNotTrackedOpen(false);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open]);

  // Focus search when opening (skip on touch devices to avoid popping up the keyboard)
  useEffect(() => {
    if (open && !window.matchMedia("(pointer: coarse)").matches) {
      requestAnimationFrame(() => searchRef.current?.focus());
    }
  }, [open]);

  const handleSelect = (code: string) => {
    onSelect(code);
    setOpen(false);
    setSearch("");
    setNotTrackedOpen(false);
  };

  return (
    <div ref={ref} className={`relative ${className}`}>
      {/* Trigger button */}
      <button
        onClick={() => {
          setOpen(!open);
          if (open) {
            setSearch("");
            setNotTrackedOpen(false);
          }
        }}
        className="w-full flex items-center gap-2.5 rounded-lg border border-osu-b3/30 bg-osu-b4/60 px-2.5 py-1.5 text-osu-l2 hover:border-osu-b3/60 hover:bg-osu-b4/80 transition-colors duration-[120ms] cursor-pointer"
        aria-label="Select country"
        aria-expanded={open}
      >
        <CountryFlag code={selectedCountry} size="md" decorative />
        <span className="text-[11px] font-semibold truncate flex-1 text-left">
          {getCountryName(selectedCountry)}
        </span>
        <svg
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          className={`h-3.5 w-3.5 text-osu-f1 flex-shrink-0 transition-transform duration-150 ${open ? "rotate-180" : ""}`}
          aria-hidden="true"
        >
          <path d="m5 7 5 5 5-5" />
        </svg>
      </button>

      {/* Dropdown */}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.12 }}
            className="absolute top-full left-0 right-0 mt-1 bg-osu-b5 border border-osu-b3/50 rounded-lg overflow-hidden z-[65] shadow-[0_10px_25px_rgba(0,0,0,0.5)]"
          >
            {/* Search */}
            <div className="p-2 border-b border-osu-b3/30">
              <input
                ref={searchRef}
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search..."
                className="w-full px-3 py-1.5 rounded-md bg-osu-b4 text-osu-c1 text-[11px] placeholder:text-osu-f1 border border-osu-b3/40 focus:border-osu-h1/40 focus:outline-none transition-colors duration-[120ms]"
              />
            </div>

            {/* Country list */}
            <div ref={listRef} className="max-h-[240px] overflow-y-auto overscroll-contain">
              {pickerItems.length > 0 ? (
                pickerItems.map((item) => {
                  if (item.type === "separator") {
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onMouseDown={(e) => {
                          e.preventDefault();
                        }}
                        onClick={() => {
                          if (!search.trim()) setNotTrackedOpen((value) => !value);
                        }}
                        className={`w-full flex items-center gap-2 px-3 py-1.5 text-[9px] font-semibold uppercase text-osu-f1/70 transition-colors duration-[80ms] ${
                          search.trim() ? "cursor-default" : "hover:text-osu-l2 cursor-pointer"
                        }`}
                        aria-expanded={item.expanded}
                      >
                        <span className="h-px flex-1 bg-osu-b3/35" />
                        <span className="whitespace-nowrap">Not tracked yet</span>
                        <span className="flex-shrink-0 text-osu-f1/45">{item.count}</span>
                        <ChevronDown
                          className={`h-3 w-3 flex-shrink-0 transition-transform duration-150 ${item.expanded ? "rotate-180" : ""}`}
                          strokeWidth={2.4}
                          aria-hidden="true"
                        />
                        <span className="h-px flex-1 bg-osu-b3/35" />
                      </button>
                    );
                  }

                  const c = item.option;
                  const selected = c.code === selectedCountry;
                  const muted = item.muted && !selected;
                  const selectable = item.selectable;
                  const rowClassName = `w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors duration-[80ms] ${
                    selected
                      ? "bg-osu-pink/15 text-white"
                      : muted
                        ? "text-osu-f1/55 cursor-default"
                        : "text-osu-l2 hover:bg-osu-b3/50 hover:text-white cursor-pointer"
                  }`;
                  const content = (
                    <>
                      <CountryFlag code={c.code} size="md" muted={muted} decorative />
                      <span className={`text-[11px] font-medium truncate ${muted ? "opacity-80" : ""}`}>{c.name}</span>
                      {selected && (
                        <svg viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5 text-osu-pink ml-auto flex-shrink-0">
                          <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                        </svg>
                      )}
                    </>
                  );

                  if (!selectable) {
                    return (
                      <div
                        key={c.code}
                        className={rowClassName}
                        role="option"
                        aria-disabled="true"
                        aria-selected={selected}
                      >
                        {content}
                      </div>
                    );
                  }

                  return (
                    <button
                      key={c.code}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        handleSelect(c.code);
                      }}
                      className={rowClassName}
                    >
                      {content}
                    </button>
                  );
                })
              ) : (
                <div className="px-3 py-4 text-center text-[11px] text-osu-f1">No countries found</div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
