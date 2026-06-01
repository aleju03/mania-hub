import { useState, useEffect, useRef, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Globe } from "lucide-react";
import {
  COUNTRY_OPTIONS,
  GLOBAL_SCOPE_CODE,
  GLOBAL_SCOPE_NAME,
  getCountryName,
  getCountryFlagUrl,
  isGlobalScope,
} from "../../lib/country";
import type { LiveCountryFeatureTier } from "../../lib/live-backend";
import { getCachedCountryTier } from "../../lib/use-country-warming";

interface CountrySelectorProps {
  selectedCountry: string;
  onSelect: (country: string) => void;
  className?: string;
  // The Global aggregate is only meaningful when the live backend is wired up,
  // so the nav opts in based on that.
  showGlobal?: boolean;
}

// Renders the scope's flag, or the globe motif for the Global scope.
function ScopeIcon({ code, muted = false }: { code: string; muted?: boolean }) {
  if (isGlobalScope(code)) {
    return (
      <span className={`flex w-[22px] h-[15px] flex-shrink-0 items-center justify-center rounded-[2px] bg-osu-pink/25 text-osu-pink-light ${muted ? "opacity-60 saturate-75" : ""}`}>
        <Globe className="h-[12px] w-[12px]" strokeWidth={2.4} />
      </span>
    );
  }
  return (
    <img
      src={getCountryFlagUrl(code)}
      alt=""
      className={`w-[22px] h-[15px] object-cover rounded-[2px] flex-shrink-0 ${muted ? "opacity-50 saturate-75" : ""}`}
      loading="lazy"
    />
  );
}

type CountryOption = (typeof COUNTRY_OPTIONS)[number];
type PickerOption = CountryOption | { code: typeof GLOBAL_SCOPE_CODE; name: typeof GLOBAL_SCOPE_NAME };
type PickerItem =
  | { type: "option"; option: PickerOption; muted: boolean }
  | { type: "separator"; id: string };

const GLOBAL_OPTION = { code: GLOBAL_SCOPE_CODE, name: GLOBAL_SCOPE_NAME } as const;

function isTrackedCountryTier(tier: LiveCountryFeatureTier | null): boolean {
  return tier === "live" || tier === "snipes";
}

export function CountrySelector({
  selectedCountry,
  onSelect,
  className = "",
  showGlobal = false,
}: CountrySelectorProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const pickerItems = useMemo<PickerItem[]>(() => {
    const q = search.trim().toLowerCase();
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
      items.push({ type: "option", option: GLOBAL_OPTION, muted: false });
    }
    for (const country of trackedCountries) {
      items.push({ type: "option", option: country, muted: false });
    }
    if (trackedCountries.length > 0 && offeredCountries.length > 0) {
      items.push({ type: "separator", id: "offered-countries" });
    }
    for (const country of offeredCountries) {
      items.push({ type: "option", option: country, muted: hasTrackedCountries });
    }

    return items;
  }, [search, showGlobal]);

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setSearch("");
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
  };

  return (
    <div ref={ref} className={`relative ${className}`}>
      {/* Trigger button */}
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2.5 rounded-lg border border-osu-b3/30 bg-osu-b4/60 px-2.5 py-1.5 text-osu-l2 hover:border-osu-b3/60 hover:bg-osu-b4/80 transition-colors duration-[120ms] cursor-pointer"
        aria-label="Select country"
        aria-expanded={open}
      >
        <ScopeIcon code={selectedCountry} />
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
            className="absolute top-full left-0 right-0 mt-1 bg-osu-b5 border border-osu-b3/50 rounded-lg overflow-hidden z-50 shadow-[0_10px_25px_rgba(0,0,0,0.5)]"
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
                      <div key={item.id} className="mx-3 my-1.5 flex items-center gap-2" aria-hidden="true">
                        <span className="h-px flex-1 bg-osu-b3/35" />
                        <span className="text-[9px] font-semibold uppercase text-osu-f1/70">Untracked countries</span>
                        <span className="h-px flex-1 bg-osu-b3/35" />
                      </div>
                    );
                  }

                  const c = item.option;
                  const selected = c.code === selectedCountry;
                  const muted = item.muted && !selected;

                  return (
                    <button
                      key={c.code}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        handleSelect(c.code);
                      }}
                      className={`w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors duration-[80ms] cursor-pointer ${
                        selected
                          ? "bg-osu-pink/15 text-white"
                          : muted
                            ? "text-osu-f1/70 hover:bg-osu-b3/35 hover:text-osu-l2"
                            : "text-osu-l2 hover:bg-osu-b3/50 hover:text-white"
                      }`}
                    >
                      <ScopeIcon code={c.code} muted={muted} />
                      <span className={`text-[11px] font-medium truncate ${muted ? "opacity-80" : ""}`}>{c.name}</span>
                      {selected && (
                        <svg viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5 text-osu-pink ml-auto flex-shrink-0">
                          <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                        </svg>
                      )}
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
