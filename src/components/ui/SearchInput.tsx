import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { avatarImageSrc } from "./Avatar";
import { CountryFlag } from "./CountryFlag";

interface SearchResult {
  id: number;
  username: string;
  avatar_url: string;
  country_code: string;
}

export function SearchInput({
  onSearch,
  onSelect,
  onSubmit,
  onQueryChange,
  placeholder = "Search player...",
  className = "",
  disabledIds,
  disabledNote,
}: {
  onSearch: (q: string) => Promise<SearchResult[]>;
  onSelect: (user: SearchResult) => void;
  onSubmit?: (q: string) => void;
  onQueryChange?: (q: string) => void;
  placeholder?: string;
  className?: string;
  /* Players the box may show but not pick. Greyed in place rather than filtered
     out, because searching a name and getting silence reads as a broken search;
     `disabledNote` is the reason, printed where the flag goes. */
  disabledIds?: ReadonlySet<number>;
  disabledNote?: string;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const onSearchRef = useRef(onSearch);

  useEffect(() => {
    onSearchRef.current = onSearch;
  }, [onSearch]);

  useEffect(() => {
    if (query.length < 2) {
      setResults([]);
      setOpen(false);
      setLoading(false);
      return;
    }
    setLoading(true);
    clearTimeout(timerRef.current);
    let cancelled = false;
    timerRef.current = setTimeout(async () => {
      try {
        const r = await onSearchRef.current(query);
        if (cancelled) return;
        setResults(r);
        setOpen(r.length > 0);
      } catch {
        if (cancelled) return;
        setResults([]);
        setOpen(false);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timerRef.current);
    };
  }, [query]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  return (
    <div ref={ref} className={`relative ${className}`}>
      <input
        type="text"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          onQueryChange?.(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key !== "Enter" || !onSubmit) return;
          e.preventDefault();
          onSubmit(query);
        }}
        onFocus={() => results.length > 0 && setOpen(true)}
        placeholder={placeholder}
        className="w-full px-4 py-2.5 rounded-lg bg-osu-b4 text-osu-c1 text-sm placeholder:text-osu-f1 border border-osu-b3/50 focus:border-osu-h1/40 focus:outline-none transition-colors duration-[120ms] shadow-[inset_0_1px_3px_rgba(0,0,0,0.3)]"
      />
      {loading && (
        <div className="absolute right-3 top-1/2 -translate-y-1/2">
          <div className="w-4 h-4 border-2 border-osu-pink/40 border-t-osu-pink rounded-full animate-spin" />
        </div>
      )}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.12 }}
            className="absolute top-full left-0 right-0 mt-1 bg-osu-b4 border border-osu-b3/50 rounded-lg overflow-hidden z-50 shadow-[0_10px_20px_rgba(0,0,0,0.4)]"
          >
            {results.map((u) => {
              const disabled = disabledIds?.has(u.id) ?? false;
              return (
                <button
                  key={u.id}
                  disabled={disabled}
                  onClick={() => {
                    onSelect(u);
                    setQuery("");
                    onQueryChange?.("");
                    setOpen(false);
                  }}
                  className={`w-full flex items-center gap-3 px-4 py-2.5 transition-colors duration-[120ms] text-left ${
                    disabled ? "cursor-default opacity-45" : "hover:bg-osu-b3 cursor-pointer"
                  }`}
                >
                  <img
                    src={avatarImageSrc(u.avatar_url, u.id)}
                    alt=""
                    className={`w-7 h-7 rounded-full ${disabled ? "grayscale" : ""}`}
                    loading="lazy"
                  />
                  <span className="text-sm font-medium text-white">{u.username}</span>
                  {disabled && disabledNote ? (
                    <span className="ml-auto text-[10px] font-semibold uppercase tracking-[0.1em] text-osu-f1">
                      {disabledNote}
                    </span>
                  ) : (
                    <CountryFlag code={u.country_code} size="sm" className="ml-auto" />
                  )}
                </button>
              );
            })}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
