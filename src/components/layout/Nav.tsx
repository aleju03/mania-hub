import { useState, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { motion } from "framer-motion";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { LogIn, LogOut, Settings } from "lucide-react";
import { SearchInput } from "../ui/SearchInput";
import { CountrySelector } from "./CountrySelector";
import { ThemePicker } from "./ThemePicker";
import { useAuth } from "../../lib/auth-context";
import { clearDevServerCaches } from "../../lib/api";
import { searchUsers } from "../../lib/osu";
import { TOP_PLAYS_RANGE_STORAGE_KEY, useAppStore, useHasHydrated, useSelectedCountry } from "../../store";
import { readCountryFromSearchStr } from "../../lib/country-search";
import { getCountryFlagGradient, getCountryFlagUrl } from "../../lib/country";
import { useDynamicFavicon } from "../../lib/favicon";

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

/* Nav links to /maps and /snipes target routes whose validateSearch has
   many required fields. Passing only `{ country }` would be a partial and
   TanStack Router types the object form strictly. The reducer form is
   permissive at runtime (validateSearch fills in the rest from defaults),
   but its `prev` is typed loosely across all routes, so we cast the
   return to `never` to stop TS from demanding every field. */
function preserveSearchWithCountry(country: string) {
  return ((prev: Record<string, unknown>) => ({ ...prev, country })) as never;
}

function preserveSearchWithCountryOnFirstPage(country: string) {
  return ((prev: Record<string, unknown>) => ({ ...prev, country, page: 0 })) as never;
}

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
  const auth = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const [adminMenuOpen, setAdminMenuOpen] = useState(false);
  const fallbackCountry = useSelectedCountry();
  const setSelectedCountry = useAppStore((state) => state.setSelectedCountry);
  const routeCountry = readCountryFromSearchStr(location.searchStr);
  const selectedCountry = routeCountry ?? fallbackCountry;
  const devMode = auth.canUseDevFeatures;
  const adminMode = auth.canUseAdminFeatures;
  const devToolsLabel = adminMode ? "Admin" : (
    <img src="/images/icons/ninja.svg" alt="Ninja" draggable={false} className="h-4 w-4" />
  );
  const devToolsTitle = adminMode ? "Admin tools" : "Dev tools";
  const returnTo = `${location.pathname}${location.searchStr}`;
  const loginHref = `/api/auth/osu?next=${encodeURIComponent(returnTo)}`;
  const logoutHref = `/api/auth/logout?next=${encodeURIComponent(returnTo)}`;
  const visibleLinks = useMemo(
    () => links.filter((link) => devMode || link.id !== "replay"),
    [devMode],
  );
  const topPlaysRange = useAppStore((state) => state.topPlaysRangeByCountry[selectedCountry] ?? "7d");
  const hydrated = useHasHydrated();
  const topPlaysRangeForLink = hydrated && topPlaysRange !== "7d" ? topPlaysRange : "7d";
  const settingsActive = location.pathname.startsWith("/settings");
  const current = visibleLinks.find((l) => location.pathname.startsWith(l.to === "/" ? "/__home" : l.to)) ||
    (location.pathname === "/" ? links[0] : location.pathname.startsWith("/player") || settingsActive ? null : links[0]);

  // Active-link indicator: single always-mounted bar, measured from the
  // active link's rect. Replaces an earlier Framer Motion `layoutId` shared
  // layout animation that crashed the React tree on rapid nav clicks when a
  // remount happened mid-spring.
  const linksContainerRef = useRef<HTMLDivElement>(null);
  const adminMenuRef = useRef<HTMLDivElement>(null);
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

  useDynamicFavicon(selectedCountry);

  useEffect(() => {
    if (routeCountry && routeCountry !== fallbackCountry) {
      setSelectedCountry(routeCountry);
    }
  }, [fallbackCountry, routeCountry, setSelectedCountry]);

  // Close drawer on route change
  useEffect(() => {
    setMenuOpen(false);
    setAdminMenuOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!adminMenuOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && adminMenuRef.current?.contains(target)) return;
      setAdminMenuOpen(false);
    };

    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [adminMenuOpen]);

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

  const handleCountrySelect = (country: string) => {
    setSelectedCountry(country);
    setMenuOpen(false);

    if (location.pathname === "/") {
      navigate({ to: "/", search: { country }, replace: true });
      return;
    }
    if (location.pathname === "/rankings") {
      navigate({ to: "/rankings", search: { country, page: 1 }, replace: true });
      return;
    }
    if (location.pathname === "/top-plays") {
      navigate({ to: "/top-plays", search: { country, range: topPlaysRangeForLink }, replace: true });
      return;
    }
    if (location.pathname === "/tracker") {
      navigate({ to: "/tracker", search: { country }, replace: true });
      return;
    }
    // For /snipes and /maps reuse route search via the reducer form
    // (see preserveSearchWithCountry for why we cast). Maps resets page
    // because other routes also use `page` with different expectations.
    if (location.pathname === "/snipes") {
      navigate({ to: "/snipes", search: preserveSearchWithCountry(country), replace: true });
      return;
    }
    if (location.pathname === "/maps") {
      navigate({ to: "/maps", search: preserveSearchWithCountryOnFirstPage(country), replace: true });
    }
  };

  return (
    <header className="fixed top-0 left-0 right-0 z-50">
      <div className="absolute inset-0 bg-osu-b6">
        <img
          src="/images/layout/nav2-background-hue0.png"
          alt=""
          draggable={false}
          className="absolute inset-0 w-full h-full object-cover opacity-50"
          style={{ filter: `saturate(var(--theme-sat))` }}
        />
        <div
          className="absolute inset-0 pointer-events-none"
          style={{ backgroundColor: "hsl(calc(var(--theme-hue) * 1deg) calc(55% * var(--theme-sat)) 22% / 0.35)" }}
        />
      </div>
      <div className="absolute inset-0 bg-[#111]/60" />
      <div
        className="absolute inset-0 pointer-events-none mix-blend-hue"
        style={{
          backgroundColor: "hsl(calc(var(--theme-hue) * 1deg) calc(100% * var(--theme-sat)) 50%)",
          opacity: "var(--theme-hue-mix, 0)",
        }}
      />
      <div className="absolute bottom-0 left-0 right-0 h-px bg-osu-pink/20" />
      <nav
        className="relative flex items-center justify-between h-[60px] px-4 sm:px-5 max-w-[1200px] mx-auto select-none"
        onDragStart={(event) => event.preventDefault()}
      >
        <div className="flex items-center gap-1">
          <motion.div
            className="cursor-pointer mr-2"
            whileHover={{ scale: 1.11 }}
            transition={{ duration: 0.1 }}
          >
            <Link to="/" search={{ country: selectedCountry }} preload="intent" draggable={false} className="flex items-center gap-2">
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
            {visibleLinks.map((l) => (
              <Link
                key={l.id}
                ref={(el: HTMLAnchorElement | null) => {
                  if (el) linkRefs.current.set(l.id, el);
                  else linkRefs.current.delete(l.id);
                }}
                to={l.to}
                search={
                  l.id === "home" || l.id === "tracker"
                    ? { country: selectedCountry }
                    : l.id === "rankings"
                      ? { country: selectedCountry, page: 1 }
                      : l.id === "top-plays"
                        ? { country: selectedCountry, range: topPlaysRangeForLink }
                        : l.id === "maps"
                          ? preserveSearchWithCountryOnFirstPage(selectedCountry)
                          : l.id === "snipes"
                            ? preserveSearchWithCountry(selectedCountry)
                            : undefined
                }
                preload="intent"
                draggable={false}
                className={`relative px-2.5 py-[19px] text-[12px] font-semibold capitalize whitespace-nowrap transition-colors duration-[120ms] ${
                  current?.id === l.id
                    ? "text-white"
                    : "text-osu-pink-light hover:text-white"
                }`}
              >
                <span className="inline-flex items-center gap-1">
                  {l.label}
                  {l.id === "snipes" && <img src="/images/icons/sniper.webp" alt="" draggable={false} className="w-3.5 h-3.5 -mt-0.5" />}
                </span>
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
        <div className="hidden md:flex items-center gap-2 ml-3">
          {devMode && (
            <>
              <div ref={adminMenuRef} className="relative">
                <button
                  type="button"
                  onClick={() => setAdminMenuOpen((open) => !open)}
                  className="px-2 py-1 rounded-lg bg-osu-yellow/15 text-[10px] text-osu-yellow font-semibold whitespace-nowrap hover:bg-osu-yellow/25 transition-colors cursor-pointer border border-osu-yellow/30"
                  title={devToolsTitle}
                  aria-haspopup="menu"
                  aria-expanded={adminMenuOpen}
                >
                  {devToolsLabel}
                </button>
                {adminMenuOpen && (
                  <div
                    className="absolute right-0 top-full mt-2 w-36 rounded-lg bg-osu-b5 border border-osu-b3/50 shadow-xl overflow-hidden z-[80]"
                    role="menu"
                  >
                    {adminMode && (
                      <Link
                        to="/admin/monitor"
                        onClick={() => setAdminMenuOpen(false)}
                        className="block px-3 py-2 text-[11px] font-semibold text-osu-l2 hover:bg-osu-b4 hover:text-white transition-colors"
                        role="menuitem"
                      >
                        Monitor
                      </Link>
                    )}
                    <Link
                      to="/admin/maniacard"
                      search={{ player: "Anthony2308" }}
                      onClick={() => setAdminMenuOpen(false)}
                      className={`block px-3 py-2 text-[11px] font-semibold text-osu-l2 hover:bg-osu-b4 hover:text-white transition-colors ${adminMode ? "border-t border-osu-b3/30" : ""}`}
                      role="menuitem"
                    >
                      Maniacard
                    </Link>
                    <Link
                      to="/admin/dan-classifier"
                      onClick={() => setAdminMenuOpen(false)}
                      className="block px-3 py-2 text-[11px] font-semibold text-osu-l2 hover:bg-osu-b4 hover:text-white transition-colors border-t border-osu-b3/30"
                      role="menuitem"
                    >
                      Dan Classifier
                    </Link>
                    <Link
                      to="/admin/og-preview"
                      onClick={() => setAdminMenuOpen(false)}
                      className="block px-3 py-2 text-[11px] font-semibold text-osu-l2 hover:bg-osu-b4 hover:text-white transition-colors border-t border-osu-b3/30"
                      role="menuitem"
                    >
                      OG preview
                    </Link>
                  </div>
                )}
              </div>
              {adminMode && (
                <button
                  onClick={async () => {
                    await clearAllDevCaches();
                    window.location.reload();
                  }}
                  className="px-2 py-1 rounded-lg bg-osu-red/20 text-[10px] text-osu-red font-semibold whitespace-nowrap hover:bg-osu-red/30 transition-colors cursor-pointer border border-osu-red/30"
                  title="Clear dev caches, including Turso cache entries, and reload"
                >
                  Clear cache
                </button>
              )}
            </>
          )}
          {auth.viewer ? (
            <a
              href={logoutHref}
              className="flex h-8 items-center gap-1.5 rounded-lg border border-osu-b3/40 bg-osu-b4/50 px-2 text-[10px] font-semibold text-osu-l2 transition-colors hover:border-osu-pink/40 hover:bg-osu-b4 hover:text-white"
              title={`Signed in as ${auth.viewer.username}. Log out`}
            >
              <span className="max-w-20 truncate">{auth.viewer.username}</span>
              <LogOut className="h-3.5 w-3.5" />
            </a>
          ) : auth.loginSuggested ? (
            <a
              href={loginHref}
              className="flex h-8 items-center gap-1.5 rounded-lg border border-osu-pink/30 bg-osu-pink/10 px-2 text-[10px] font-semibold text-osu-pink-light transition-colors hover:border-osu-pink/50 hover:bg-osu-pink/20 hover:text-white"
              title="Sign in with osu!"
            >
              <LogIn className="h-3.5 w-3.5" />
              osu!
            </a>
          ) : null}
          <CountrySelector className="w-52" selectedCountry={selectedCountry} onSelect={handleCountrySelect} />
          <SearchInput
            className="w-52"
            placeholder="find player..."
            onSearch={handleSearch}
            onSelect={(u) => navigate({ to: "/player/$username", params: { username: u.username } })}
          />
          {devMode && (
            <Link
              to="/settings"
              preload="intent"
              draggable={false}
              className={`flex h-9 w-9 items-center justify-center rounded-lg transition-colors ${
                settingsActive
                  ? "bg-osu-pink/20 text-white"
                  : "text-osu-pink-light hover:bg-osu-b3/50 hover:text-white"
              }`}
              title="Settings"
              aria-label="Settings"
            >
              <Settings className="h-5 w-5" strokeWidth={2.1} />
            </Link>
          )}
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
                {visibleLinks.map((l) => (
                  <Link
                    key={l.id}
                    to={l.to}
                    search={
                      l.id === "home" || l.id === "tracker"
                        ? { country: selectedCountry }
                        : l.id === "rankings"
                          ? { country: selectedCountry, page: 1 }
                          : l.id === "top-plays"
                            ? { country: selectedCountry, range: topPlaysRangeForLink }
                            : l.id === "maps"
                              ? preserveSearchWithCountryOnFirstPage(selectedCountry)
                              : l.id === "snipes"
                                ? preserveSearchWithCountry(selectedCountry)
                                : undefined
                    }
                    preload="intent"
                    onClick={() => setMenuOpen(false)}
                    draggable={false}
                    className={`flex items-center gap-3 px-5 py-3 text-sm font-medium capitalize transition-colors duration-[120ms] ${
                      current?.id === l.id
                        ? "text-white bg-osu-pink/10 border-l-3 border-osu-yellow"
                        : "text-osu-pink-light hover:text-white hover:bg-osu-b4/50 border-l-3 border-transparent"
                    }`}
                  >
                    {l.label}
                    {l.id === "snipes" && <img src="/images/icons/sniper.webp" alt="" draggable={false} className="inline w-4 h-4" />}
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

              <div className="border-t border-osu-b3/30 px-4 py-3 space-y-2">
                <CountrySelector className="w-full" selectedCountry={selectedCountry} onSelect={handleCountrySelect} />
                <ThemePicker variant="mobile" />
                {auth.viewer ? (
                  <a
                    href={logoutHref}
                    className="flex w-full items-center justify-center gap-2 rounded-lg border border-osu-b3/40 bg-osu-b4/60 px-3 py-2 text-[12px] font-semibold text-osu-l2 transition-colors hover:bg-osu-b4 hover:text-white"
                  >
                    <span className="truncate">{auth.viewer.username}</span>
                    <LogOut className="h-4 w-4" />
                  </a>
                ) : auth.loginSuggested ? (
                  <a
                    href={loginHref}
                    className="flex w-full items-center justify-center gap-2 rounded-lg border border-osu-pink/30 bg-osu-pink/10 px-3 py-2 text-[12px] font-semibold text-osu-pink-light transition-colors hover:bg-osu-pink/20 hover:text-white"
                  >
                    <LogIn className="h-4 w-4" />
                    osu! login
                  </a>
                ) : null}
                {devMode && (
                  <Link
                    to="/settings"
                    preload="intent"
                    onClick={() => setMenuOpen(false)}
                    draggable={false}
                    className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-[12px] font-semibold capitalize transition-colors ${
                      settingsActive
                        ? "bg-osu-pink/15 text-white"
                        : "bg-osu-b4/60 text-osu-pink-light hover:bg-osu-b4 hover:text-white"
                    }`}
                  >
                    <Settings className="h-5 w-5" strokeWidth={2.1} />
                    settings
                  </Link>
                )}
              </div>

              {devMode && (
                <div className="border-t border-osu-b3/30 px-4 py-3 space-y-2">
                  <div className="text-[10px] uppercase tracking-wide text-osu-f1 font-semibold px-1">
                    {devToolsLabel}
                  </div>
                  {adminMode && (
                    <Link
                      to="/admin/monitor"
                      onClick={() => setMenuOpen(false)}
                      className="block w-full text-center px-3 py-2 rounded-lg bg-osu-yellow/15 text-[10px] text-osu-yellow font-semibold hover:bg-osu-yellow/25 transition-colors cursor-pointer border border-osu-yellow/30"
                    >
                      Monitor
                    </Link>
                  )}
                  <Link
                    to="/admin/maniacard"
                    search={{ player: "Anthony2308" }}
                    onClick={() => setMenuOpen(false)}
                    className="block w-full text-center px-3 py-2 rounded-lg bg-osu-yellow/15 text-[10px] text-osu-yellow font-semibold hover:bg-osu-yellow/25 transition-colors cursor-pointer border border-osu-yellow/30"
                  >
                    Maniacard
                  </Link>
                  <Link
                    to="/admin/dan-classifier"
                    onClick={() => setMenuOpen(false)}
                    className="block w-full text-center px-3 py-2 rounded-lg bg-osu-yellow/15 text-[10px] text-osu-yellow font-semibold hover:bg-osu-yellow/25 transition-colors cursor-pointer border border-osu-yellow/30"
                  >
                    Dan Classifier
                  </Link>
                  <Link
                    to="/admin/og-preview"
                    onClick={() => setMenuOpen(false)}
                    className="block w-full text-center px-3 py-2 rounded-lg bg-osu-yellow/15 text-[10px] text-osu-yellow font-semibold hover:bg-osu-yellow/25 transition-colors cursor-pointer border border-osu-yellow/30"
                  >
                    OG preview
                  </Link>
                  {adminMode && (
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
                  )}
                </div>
              )}
      </div>
    </header>
  );
}
