import { useState, useEffect, useLayoutEffect, useRef } from "react";
import { motion } from "framer-motion";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { SearchInput } from "../ui/SearchInput";
import { CountrySelector } from "./CountrySelector";
import { ThemePicker } from "./ThemePicker";
import { clearDevServerCaches } from "../../lib/api";
import { searchUsers } from "../../lib/osu";
import { TOP_PLAYS_RANGE_STORAGE_KEY, useAppStore, useSelectedCountry } from "../../store";
import { getCountryFlagGradient, getCountryFlagUrl } from "../../lib/country";

const links = [
  { id: "home", to: "/", label: "home" },
  { id: "rankings", to: "/rankings", label: "rankings" },
  { id: "tracker", to: "/tracker", label: "tracker" },
  { id: "top-plays", to: "/top-plays", label: "top plays" },
  { id: "maps", to: "/maps", label: "maps" },
  { id: "replay", to: "/replay", label: "replay" },
  { id: "snipes", to: "/snipes", label: "snipes" },
] as const;

const CLIENT_CACHE_KEYS = ["mania-hub-cache-v1", "mania-hub-cache-v2", "mania-hub-cache-v3", "mania-hub-cache-v4"];
const SKIN_DB_NAME = "mania-hub-skins";

function deleteIndexedDb(name: string): Promise<void> {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve();
      return;
    }

    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}

async function clearClientCaches(): Promise<void> {
  useAppStore.persist.clearStorage();

  if (typeof window !== "undefined") {
    CLIENT_CACHE_KEYS.forEach((key) => {
      window.localStorage.removeItem(key);
    });
    window.localStorage.removeItem(TOP_PLAYS_RANGE_STORAGE_KEY);
    window.sessionStorage.clear();
  }

  if (typeof caches !== "undefined") {
    const cacheNames = await caches.keys();
    await Promise.allSettled(cacheNames.map((name) => caches.delete(name)));
  }

  if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.allSettled(registrations.map((registration) => registration.unregister()));
  }

  await deleteIndexedDb(SKIN_DB_NAME);
}

async function clearAllDevCaches(): Promise<void> {
  await Promise.allSettled([
    clearClientCaches(),
    clearDevServerCaches(),
  ]);
}

export function Nav() {
  const location = useLocation();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const selectedCountry = useSelectedCountry();
  const devMode = import.meta.env.VITE_DEV_MODE === "1";
  const topPlaysRange = useAppStore((state) => state.topPlaysRangeByCountry[selectedCountry] ?? "7d");
  const current = links.find((l) => location.pathname.startsWith(l.to === "/" ? "/__home" : l.to)) ||
    (location.pathname === "/" ? links[0] : location.pathname.startsWith("/player") ? null : links[0]);

  // Active-link indicator: single always-mounted bar, measured from the
  // active link's rect. Replaces an earlier Framer Motion `layoutId` shared
  // layout animation that crashed the React tree on rapid nav clicks when a
  // remount happened mid-spring.
  const linksContainerRef = useRef<HTMLDivElement>(null);
  const linkRefs = useRef<Map<string, HTMLAnchorElement>>(new Map());
  const [barRect, setBarRect] = useState<{ left: number; width: number } | null>(null);

  useLayoutEffect(() => {
    const measure = () => {
      const id = current?.id;
      const container = linksContainerRef.current;
      if (!id || !container) {
        setBarRect(null);
        return;
      }
      const link = linkRefs.current.get(id);
      if (!link) {
        setBarRect(null);
        return;
      }
      const c = container.getBoundingClientRect();
      const l = link.getBoundingClientRect();
      setBarRect({ left: l.left - c.left + 8, width: Math.max(0, l.width - 16) });
    };
    measure();
    const container = linksContainerRef.current;
    if (!container) return;
    const ro = new ResizeObserver(measure);
    ro.observe(container);
    linkRefs.current.forEach((el) => ro.observe(el));
    let cancelled = false;
    if (typeof document !== "undefined" && document.fonts?.ready) {
      document.fonts.ready.then(() => {
        if (!cancelled) measure();
      });
    }
    return () => {
      cancelled = true;
      ro.disconnect();
    };
  }, [current?.id]);

  const flagBackground = getCountryFlagGradient(selectedCountry)
    ?? `url(${getCountryFlagUrl(selectedCountry)}) center/cover no-repeat`;

  // Close drawer on route change
  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  // Prevent body scroll when drawer is open. Defer the layout-invalidating
  // style write by two rAFs so the drawer's transform transition gets a clean
  // first frame on the compositor before we trigger a full-document restyle
  // (otherwise the first frame stutters on mid-tier Android browsers).
  useEffect(() => {
    if (menuOpen) {
      let raf2 = 0;
      const raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => {
          document.body.style.overflow = "hidden";
        });
      });
      return () => {
        cancelAnimationFrame(raf1);
        if (raf2) cancelAnimationFrame(raf2);
        document.body.style.overflow = "";
      };
    }
    document.body.style.overflow = "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [menuOpen]);

  const handleSearch = async (q: string) => {
    const res = await searchUsers({ data: { query: q } });
    return (res.user?.data ?? []).slice(0, 6).map((u: { id: number; username: string; avatar_url: string; country_code: string }) => ({
      id: u.id,
      username: u.username,
      avatar_url: u.avatar_url,
      country_code: u.country_code,
    }));
  };

  return (
    <header className="fixed top-0 left-0 right-0 z-50">
      <div className="absolute inset-0 bg-osu-b6">
        <img
          src="/images/layout/nav2-background-hue0.png"
          alt=""
          className="absolute inset-0 w-full h-full object-cover opacity-50"
        />
        <div
          className="absolute inset-0 pointer-events-none"
          style={{ backgroundColor: "hsl(calc(var(--theme-hue) * 1deg) 55% 22% / 0.35)" }}
        />
      </div>
      <div className="absolute inset-0 bg-[#111]/60" />
      <div className="absolute bottom-0 left-0 right-0 h-px bg-osu-pink/20" />
      <nav className="relative flex items-center justify-between h-[60px] px-4 sm:px-5 max-w-[1200px] mx-auto">
        <div className="flex items-center gap-1">
          <motion.div
            className="cursor-pointer mr-2"
            whileHover={{ scale: 1.11 }}
            transition={{ duration: 0.1 }}
          >
            <Link to="/" preload="intent" className="flex items-center gap-2">
              <div className="relative w-9 h-9 rounded-full shadow-md ring-1 ring-white/15 overflow-hidden transition-all duration-300">
                {/* Dimmed flag base */}
                <div
                  className="absolute inset-0"
                  style={{
                    background: flagBackground,
                    filter: "brightness(0.45) saturate(0.75)",
                  }}
                />
                {/* Bright flag clipped to arrow shape (clipping mask + outer glow) */}
                <div
                  className="absolute inset-0"
                  style={{
                    background: flagBackground,
                    maskImage: "url(/images/notes/arrow-left-pink.png)",
                    WebkitMaskImage: "url(/images/notes/arrow-left-pink.png)",
                    maskSize: "62%",
                    WebkitMaskSize: "62%",
                    maskRepeat: "no-repeat",
                    WebkitMaskRepeat: "no-repeat",
                    maskPosition: "center",
                    WebkitMaskPosition: "center",
                    transform: "scaleX(-1)",
                    filter: [
                      "brightness(1.4)",
                      "saturate(1.45)",
                      "drop-shadow(1.5px 0 0 rgba(0,0,0,0.95))",
                      "drop-shadow(-1.5px 0 0 rgba(0,0,0,0.95))",
                      "drop-shadow(0 1.5px 0 rgba(0,0,0,0.95))",
                      "drop-shadow(0 -1.5px 0 rgba(0,0,0,0.95))",
                      "drop-shadow(0 0 4px rgba(255,255,255,0.45))",
                    ].join(" "),
                  }}
                />
              </div>
              <span className="mode-icon text-osu-pink text-lg" title="mania">{"\ue802"}</span>
            </Link>
          </motion.div>

          {/* Desktop nav links */}
          <div ref={linksContainerRef} className="relative hidden md:flex items-center gap-1">
            {links.map((l) => (
              <Link
                key={l.id}
                ref={(el: HTMLAnchorElement | null) => {
                  if (el) linkRefs.current.set(l.id, el);
                  else linkRefs.current.delete(l.id);
                }}
                to={l.to}
                search={l.id === "top-plays" && topPlaysRange !== "7d" ? { range: topPlaysRange } : undefined}
                preload="intent"
                className={`relative px-2.5 py-[19px] text-[12px] font-semibold capitalize transition-colors duration-[120ms] ${
                  current?.id === l.id
                    ? "text-white"
                    : "text-osu-pink-light hover:text-white"
                }`}
              >
                {l.label}
                {l.id === "snipes" && <img src="/images/icons/sniper.webp" alt="" className="inline w-4 h-4 ml-1 -mt-0.5" />}
              </Link>
            ))}
            {barRect && (
              <motion.div
                className="absolute bottom-0 h-[3px] rounded-full bg-osu-yellow pointer-events-none"
                initial={false}
                animate={{ left: barRect.left, width: barRect.width }}
                transition={{ type: "spring", stiffness: 500, damping: 35 }}
              />
            )}
          </div>
        </div>

        {/* Desktop search + dev tools */}
        <div className="hidden md:flex items-center gap-2">
          {devMode && (
            <>
              <Link
                to="/admin/monitor"
                className="px-2 py-1 rounded-lg bg-osu-yellow/15 text-[10px] text-osu-yellow font-semibold hover:bg-osu-yellow/25 transition-colors cursor-pointer border border-osu-yellow/30"
                title="Situation monitor (dev only)"
              >
                Monitor
              </Link>
              <button
                onClick={async () => {
                  await clearAllDevCaches();
                  window.location.reload();
                }}
                className="px-2 py-1 rounded-lg bg-osu-red/20 text-[10px] text-osu-red font-semibold hover:bg-osu-red/30 transition-colors cursor-pointer border border-osu-red/30"
                title="Clear dev caches, including Turso cache entries, and reload"
              >
                Clear cache
              </button>
            </>
          )}
          <CountrySelector className="w-52" />
          <SearchInput
            className="w-52"
            placeholder="find player..."
            onSearch={handleSearch}
            onSelect={(u) => navigate({ to: "/player/$username", params: { username: u.username } })}
          />
          <ThemePicker />
        </div>

        {/* Mobile hamburger button */}
        <button
          className="md:hidden flex items-center justify-center w-9 h-9 rounded-lg hover:bg-osu-b3/50 transition-colors cursor-pointer"
          onClick={() => setMenuOpen(!menuOpen)}
          aria-label="Toggle menu"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-5 h-5 text-osu-pink-light">
            {menuOpen ? (
              <>
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </>
            ) : (
              <>
                <line x1="4" y1="7" x2="20" y2="7" />
                <line x1="4" y1="12" x2="20" y2="12" />
                <line x1="4" y1="17" x2="20" y2="17" />
              </>
            )}
          </svg>
        </button>
      </nav>

      {/* Mobile drawer — pure CSS transitions for compositor-thread animation */}
      {/* Backdrop */}
      <div
        className={`fixed inset-0 z-[55] bg-black/60 md:hidden transition-opacity duration-200 ease-out ${
          menuOpen ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
        onClick={() => setMenuOpen(false)}
        style={{ top: 60 }}
        aria-hidden={!menuOpen}
      />
      {/* Drawer panel */}
      <div
        className={`fixed top-[60px] right-0 w-64 bottom-0 bg-osu-b5 z-[60] md:hidden border-l border-osu-b3/30 overflow-y-auto transform-gpu will-change-transform transition-transform duration-250 ease-out ${
          menuOpen ? "translate-x-0" : "translate-x-full pointer-events-none"
        }`}
        aria-hidden={!menuOpen}
      >
              <div className="py-2">
                <div className="px-4 pb-3 space-y-2">
                  <CountrySelector className="w-full" />
                  <ThemePicker variant="mobile" />
                </div>
                {links.map((l) => (
                  <Link
                    key={l.id}
                    to={l.to}
                    search={l.id === "top-plays" && topPlaysRange !== "7d" ? { range: topPlaysRange } : undefined}
                    preload="intent"
                    onClick={() => setMenuOpen(false)}
                    className={`flex items-center gap-3 px-5 py-3 text-sm font-medium capitalize transition-colors duration-[120ms] ${
                      current?.id === l.id
                        ? "text-white bg-osu-pink/10 border-l-3 border-osu-yellow"
                        : "text-osu-pink-light hover:text-white hover:bg-osu-b4/50 border-l-3 border-transparent"
                    }`}
                  >
                    {l.label}
                    {l.id === "snipes" && <img src="/images/icons/sniper.webp" alt="" className="inline w-4 h-4" />}
                  </Link>
                ))}
              </div>

              <div className="border-t border-osu-b3/30 px-4 py-4">
                <SearchInput
                  className="w-full"
                  placeholder="find player..."
                  onSearch={handleSearch}
                  onSelect={(u) => {
                    setMenuOpen(false);
                    navigate({ to: "/player/$username", params: { username: u.username } });
                  }}
                />
              </div>

              {devMode && (
                <div className="border-t border-osu-b3/30 px-4 py-3 space-y-2">
                  <Link
                    to="/admin/monitor"
                    onClick={() => setMenuOpen(false)}
                    className="block w-full text-center px-3 py-2 rounded-lg bg-osu-yellow/15 text-[10px] text-osu-yellow font-semibold hover:bg-osu-yellow/25 transition-colors cursor-pointer border border-osu-yellow/30"
                  >
                    Monitor
                  </Link>
                  <button
                    onClick={async () => {
                      await clearAllDevCaches();
                      window.location.reload();
                    }}
                    className="w-full px-3 py-2 rounded-lg bg-osu-red/20 text-[10px] text-osu-red font-semibold hover:bg-osu-red/30 transition-colors cursor-pointer border border-osu-red/30"
                    title="Clear dev caches"
                  >
                    Clear cache
                  </button>
                </div>
              )}
      </div>
    </header>
  );
}
