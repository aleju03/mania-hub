import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { SearchInput } from "../ui/SearchInput";
import { CountrySelector } from "./CountrySelector";
import { clearDevServerCaches } from "../../lib/api";
import { searchUsers } from "../../lib/osu";
import { useAppStore } from "../../store";
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
  const selectedCountry = useAppStore((state) => state.selectedCountry);
  const current = links.find((l) => location.pathname.startsWith(l.to === "/" ? "/__home" : l.to)) ||
    (location.pathname === "/" ? links[0] : location.pathname.startsWith("/player") ? null : links[0]);

  const flagGradient = getCountryFlagGradient(selectedCountry);
  const flagImageUrl = getCountryFlagUrl(selectedCountry);

  // Close drawer on route change
  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  // Prevent body scroll when drawer is open
  useEffect(() => {
    if (menuOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
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
          className="absolute inset-0 w-full h-full object-cover opacity-60"
          style={{ filter: "hue-rotate(333deg) saturate(0.8)" }}
        />
      </div>
      <div className="absolute inset-0 bg-[#111]/70" />
      <div
        className="absolute bottom-0 left-0 right-0 h-px"
        style={{ background: "hsl(333,100%,70%,0.2)" }}
      />
      <nav className="relative flex items-center justify-between h-[60px] px-4 sm:px-5 max-w-[1200px] mx-auto">
        <div className="flex items-center gap-1">
          <motion.div
            className="cursor-pointer mr-2"
            whileHover={{ scale: 1.11 }}
            transition={{ duration: 0.1 }}
          >
            <Link to="/" preload="intent" className="flex items-center gap-2">
              <div className="relative w-10 h-10">
                <div
                  className="absolute inset-0 transition-all duration-300"
                  style={{
                    background: flagGradient ?? `url(${flagImageUrl}) center/cover no-repeat`,
                    maskImage: "url(/images/layout/osu-logo-circle.svg)",
                    WebkitMaskImage: "url(/images/layout/osu-logo-circle.svg)",
                    maskSize: "contain",
                    WebkitMaskSize: "contain",
                    maskRepeat: "no-repeat",
                    WebkitMaskRepeat: "no-repeat",
                    maskPosition: "center",
                    WebkitMaskPosition: "center",
                  }}
                />
                {/* Dark halo behind text for readability on light/busy flags */}
                <div
                  className="absolute inset-0"
                  style={{
                    background: "rgba(0,0,0,0.35)",
                    maskImage: "url(/images/layout/osu-logo-text.svg)",
                    WebkitMaskImage: "url(/images/layout/osu-logo-text.svg)",
                    maskSize: "115%",
                    WebkitMaskSize: "115%",
                    maskRepeat: "no-repeat",
                    WebkitMaskRepeat: "no-repeat",
                    maskPosition: "center",
                    WebkitMaskPosition: "center",
                    filter: "blur(2px)",
                  }}
                />
                <div
                  className="absolute inset-0"
                  style={{
                    background: "white",
                    maskImage: "url(/images/layout/osu-logo-text.svg)",
                    WebkitMaskImage: "url(/images/layout/osu-logo-text.svg)",
                    maskSize: "contain",
                    WebkitMaskSize: "contain",
                    maskRepeat: "no-repeat",
                    WebkitMaskRepeat: "no-repeat",
                    maskPosition: "center",
                    WebkitMaskPosition: "center",
                  }}
                />
              </div>
              <span className="mode-icon text-osu-pink text-lg" title="mania">{"\ue802"}</span>
            </Link>
          </motion.div>

          {/* Desktop nav links */}
          <div className="hidden md:flex items-center gap-1">
            {links.map((l) => (
              <Link
                key={l.id}
                to={l.to}
                preload="intent"
                className={`relative px-2.5 py-[19px] text-[12px] font-semibold capitalize transition-colors duration-[120ms] ${
                  current?.id === l.id
                    ? "text-white"
                    : "text-osu-pink-light hover:text-white"
                }`}
              >
                {l.label}
                {l.id === "snipes" && <img src="/images/icons/sniper.webp" alt="" className="inline w-4 h-4 ml-1 -mt-0.5" />}
                {current?.id === l.id && (
                  <motion.div
                    layoutId="nav-bar"
                    className="absolute bottom-0 left-2 right-2 h-[3px] rounded-full bg-osu-yellow"
                    transition={{ type: "spring", stiffness: 500, damping: 35 }}
                  />
                )}
              </Link>
            ))}
          </div>
        </div>

        {/* Desktop search + dev tools */}
        <div className="hidden md:flex items-center gap-2">
          {import.meta.env.VITE_DEV_MODE === "1" && (
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
          )}
          <CountrySelector className="w-52" />
          <SearchInput
            className="w-52"
            placeholder="find player..."
            onSearch={handleSearch}
            onSelect={(u) => navigate({ to: "/player/$username", params: { username: u.username } })}
          />
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
                <div className="px-4 pb-3">
                  <CountrySelector className="w-full" />
                </div>
                {links.map((l) => (
                  <Link
                    key={l.id}
                    to={l.to}
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

              {import.meta.env.VITE_DEV_MODE === "1" && (
                <div className="border-t border-osu-b3/30 px-4 py-3">
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
