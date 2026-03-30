import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";

interface SearchResult {
  id: number;
  username: string;
  avatar_url: string;
  country_code: string;
}

export function SearchInput({
  onSearch,
  onSelect,
  placeholder = "Search player...",
  className = "",
}: {
  onSearch: (q: string) => Promise<SearchResult[]>;
  onSelect: (user: SearchResult) => void;
  placeholder?: string;
  className?: string;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (query.length < 2) {
      setResults([]);
      setOpen(false);
      return;
    }
    setLoading(true);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(async () => {
      const r = await onSearch(query);
      setResults(r);
      setOpen(r.length > 0);
      setLoading(false);
    }, 350);
    return () => clearTimeout(timerRef.current);
  }, [query, onSearch]);

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
        onChange={(e) => setQuery(e.target.value)}
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
            {results.map((u) => (
              <button
                key={u.id}
                onClick={() => {
                  onSelect(u);
                  setQuery("");
                  setOpen(false);
                }}
                className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-osu-b3 transition-colors duration-[120ms] cursor-pointer text-left"
              >
                <img
                  src={u.avatar_url}
                  alt=""
                  className="w-7 h-7 rounded-full"
                  loading="lazy"
                />
                <span className="text-sm font-medium text-white">{u.username}</span>
                <span className="text-[10px] text-osu-f1 ml-auto">{u.country_code}</span>
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
