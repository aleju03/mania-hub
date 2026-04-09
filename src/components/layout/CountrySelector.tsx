import { useState, useEffect, useRef, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { COUNTRY_OPTIONS, getCountryName, getCountryFlagUrl } from "../../lib/country";
import { useAppStore } from "../../store";

interface CountrySelectorProps {
  className?: string;
}

export function CountrySelector({ className = "" }: CountrySelectorProps) {
  const selectedCountry = useAppStore((state) => state.selectedCountry);
  const setSelectedCountry = useAppStore((state) => state.setSelectedCountry);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    if (!search) return COUNTRY_OPTIONS;
    const q = search.toLowerCase();
    return COUNTRY_OPTIONS.filter(
      (c) => c.name.toLowerCase().includes(q) || c.code.toLowerCase().includes(q),
    );
  }, [search]);

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

  // Focus search when opening
  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => searchRef.current?.focus());
    }
  }, [open]);

  const handleSelect = (code: string) => {
    setSelectedCountry(code);
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
        <img
          src={getCountryFlagUrl(selectedCountry)}
          alt=""
          className="w-[22px] h-[15px] object-cover rounded-[2px] flex-shrink-0"
        />
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
              {filtered.length > 0 ? (
                filtered.map((c) => (
                  <button
                    key={c.code}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      handleSelect(c.code);
                    }}
                    className={`w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors duration-[80ms] cursor-pointer ${
                      c.code === selectedCountry
                        ? "bg-osu-pink/15 text-white"
                        : "text-osu-l2 hover:bg-osu-b3/50 hover:text-white"
                    }`}
                  >
                    <img
                      src={getCountryFlagUrl(c.code)}
                      alt={c.code}
                      className="w-[22px] h-[15px] object-cover rounded-[2px] flex-shrink-0"
                      loading="lazy"
                    />
                    <span className="text-[11px] font-medium truncate">{c.name}</span>
                    {c.code === selectedCountry && (
                      <svg viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5 text-osu-pink ml-auto flex-shrink-0">
                        <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                      </svg>
                    )}
                  </button>
                ))
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
