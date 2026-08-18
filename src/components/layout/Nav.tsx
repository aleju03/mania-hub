import { useState, useEffect, useLayoutEffect, useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { BarChart3, ChevronDown, Globe, Image as ImageIcon, LogIn, LogOut, Settings, Target, UserRound } from "lucide-react";
import { SearchInput } from "../ui/SearchInput";
import { Avatar } from "../ui/Avatar";
import { CountryFlag } from "../ui/CountryFlag";
import { RegionIcon } from "../ui/RegionIcon";
import { CountrySelector } from "./CountrySelector";
import { SettingsDrawer } from "./SettingsDrawer";
import { ThemePicker } from "./ThemePicker";
import { useAuth } from "../../lib/auth-context";
import { searchPlayers } from "../../lib/player-search";
import { DEFAULT_SNIPES_FILTERS, useAppStore, useHasHydrated, useSelectedCountry } from "../../store";
import { readCountryFromSearchStr } from "../../lib/country-search";
import { getCountryFlagGradient, getCountryFlagLargeUrl, getCountryName, isGlobalScope, isSupportedCountryCode } from "../../lib/country";
import { isRegionScope } from "../../lib/regions";
import { isLiveBackendConfigured } from "../../lib/live-backend";
import { showPlayerCountryFlagState } from "../../lib/player-profile-navigation";
import { getCachedCountryTier, useCountryWarming } from "../../lib/use-country-warming";
import { useDynamicFavicon } from "../../lib/favicon";

// Leaf destinations. Kept `as const` (not typed) so each `to` stays a literal
// route path; TanStack Router's Link types reject a widened `string`.
const NAV_LEAVES = {
  home: { id: "home", to: "/", label: "home" },
  rankings: { id: "rankings", to: "/rankings", label: "rankings" },
  "top-plays": { id: "top-plays", to: "/top-plays", label: "top plays" },
  tracker: { id: "tracker", to: "/tracker", label: "tracker" },
  maps: { id: "maps", to: "/maps", label: "maps" },
  /* Listed before "packs" on purpose: the active-leaf lookup below is a
     startsWith scan in this object's order, and /packs/collections also starts
     with /packs, so the longer path has to be tested first. */
  "pack-collections": { id: "pack-collections", to: "/packs/collections", label: "collections" },
  packs: { id: "packs", to: "/packs", label: "open packs" },
  skins: { id: "skins", to: "/skins", label: "skins" },
  snipes: { id: "snipes", to: "/snipes", label: "snipes" },
  "farm-helper": { id: "farm-helper", to: "/farm-helper", label: "farm helper" },
  replay: { id: "replay", to: "/replay", label: "watch replays" },
  bbcode: { id: "bbcode", to: "/bbcode", label: "BBCode editor" },
  discord: { id: "discord", to: "/discord", label: "Discord bot" },
  communities: { id: "communities", to: "/communities", label: "Discord servers" },
} as const;

type NavLeafId = keyof typeof NAV_LEAVES;
type NavLeaf = (typeof NAV_LEAVES)[NavLeafId];

// Top-level nav: a few standalone links plus grouped dropdowns, osu!-style.
type NavTop =
  | { kind: "link"; id: NavLeafId }
  | { kind: "group"; id: string; label: string; items: NavLeafId[] };

const NAV_TOP: NavTop[] = [
  { kind: "link", id: "home" },
  { kind: "group", id: "players", label: "players", items: ["tracker", "rankings", "top-plays"] },
  { kind: "link", id: "maps" },
  { kind: "group", id: "packs", label: "packs", items: ["packs", "pack-collections"] },
  { kind: "link", id: "skins" },
  { kind: "link", id: "snipes" },
  /* Everything that is not one of the data surfaces above. Called "more" rather
     than "tools" because it stopped being one: the replay viewer and the BBCode
     editor are tools, but the Discord bot page is a pitch and the server
     directory is a place. A deliberately broad label so the next thing added
     here does not restart the argument. */
  { kind: "group", id: "more", label: "more", items: ["farm-helper", "replay", "bbcode", "discord", "communities"] },
];

// Each leaf maps to its top-level item id so the active-link bar can sit under
// the group that owns the current page.
const LEAF_TO_TOP: Record<string, string> = {};
for (const top of NAV_TOP) {
  if (top.kind === "link") LEAF_TO_TOP[top.id] = top.id;
  else for (const id of top.items) LEAF_TO_TOP[id] = top.id;
}

const ALL_LEAVES = Object.values(NAV_LEAVES);

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

/* The dev-tools menu, listed once and rendered by both the desktop dropdown
   and the phone drawer (it used to be the same eight links written out twice).
   Ordered by how often each gets opened rather than by when it was built, and
   read two at a time, so the pairs above are the ones that matter. `adminOnly`
   items need real admin; the last two also show in plain dev mode. Kept
   `as const` for the same reason NAV_LEAVES is. */
const ADMIN_TOOLS = [
  { to: "/admin/live-backend", label: "Monitoring", adminOnly: true },
  { to: "/valley", label: "Valley", adminOnly: true },
  { to: "/admin/todos", label: "Todos", adminOnly: true },
  { to: "/admin/ghost", label: "Ghost", adminOnly: true },
  { to: "/admin/r2", label: "R2", adminOnly: true, search: { prefix: "replay-cache/" } },
  { to: "/admin/collections", label: "Collections", adminOnly: true },
  { to: "/admin/bbcode-images", label: "BBCode images", adminOnly: true },
  { to: "/admin/discord", label: "Discord", adminOnly: true },
  { to: "/admin/dan-classifier", label: "Chart Patterns", adminOnly: false },
  { to: "/admin/og-preview", label: "OG preview", adminOnly: false },
  { to: "/admin/dynamic-renders", label: "Dynamic renders", adminOnly: true },
] as const;

type AdminTool = (typeof ADMIN_TOOLS)[number];

function adminToolsFor(adminMode: boolean): AdminTool[] {
  return ADMIN_TOOLS.filter((tool) => adminMode || !tool.adminOnly);
}

/* The r2 entry is the only one that carries search params, and TanStack types
   `search` per route, so it is passed through untyped rather than making every
   other entry declare an empty one. */
function adminToolSearch(tool: AdminTool): never | undefined {
  return "search" in tool ? (tool.search as never) : undefined;
}

export function Nav() {
  const location = useLocation();
  const navigate = useNavigate();
  const auth = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const [adminMenuOpen, setAdminMenuOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [mobileAccountOpen, setMobileAccountOpen] = useState(false);
  const [mobileCountryOpen, setMobileCountryOpen] = useState(false);
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const [mobileOpenGroups, setMobileOpenGroups] = useState<Set<string>>(() => new Set());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const fallbackCountry = useSelectedCountry();
  const setSelectedCountry = useAppStore((state) => state.setSelectedCountry);
  const routeCountry = readCountryFromSearchStr(location.searchStr);
  const selectedCountry = routeCountry ?? fallbackCountry;
  const liveBackendConfigured = isLiveBackendConfigured();
  const viewerCountryCode = auth.viewer?.countryCode?.trim().toUpperCase() || null;
  // Only offer the one-click country switch when the viewer's country is one the
  // backend actually tracks, so the destination view has data. When the live
  // backend isn't configured there's no track list, so any supported country goes.
  const viewerCountryTracked = Boolean(
    viewerCountryCode
      && !isGlobalScope(viewerCountryCode)
      && isSupportedCountryCode(viewerCountryCode)
      && (!liveBackendConfigured || getCachedCountryTier(viewerCountryCode) != null),
  );
  // Resolves the country's feature tier (cached per country, so a switch
  // between two already-seen countries never flickers the Snipes tab).
  const { featureTier: selectedCountryFeatureTier } = useCountryWarming(selectedCountry);
  const devMode = auth.canUseDevFeatures;
  const adminMode = auth.canUseAdminFeatures;
  const devToolsLabel = adminMode ? "Admin" : (
    <img src="/images/icons/ninja.svg" alt="Ninja" draggable={false} className="h-4 w-4" />
  );
  const devToolsTitle = adminMode ? "Admin tools" : "Dev tools";
  const returnTo = `${location.pathname}${location.searchStr}`;
  const loginHref = `/api/auth/osu?next=${encodeURIComponent(returnTo)}`;
  const logoutHref = `/api/auth/logout?next=${encodeURIComponent(returnTo)}`;
  // When the server is off, Snipes is always shown. Otherwise show it
  // only once the tier is known to be "snipes" — while the tier is still
  // unknown (first-ever visit) the tab stays hidden rather than flashing in.
  const showSnipesLink = !liveBackendConfigured || selectedCountryFeatureTier === "snipes";
  const isLeafVisible = (leaf: NavLeaf) => {
    // Discord bot is dev-gated for now: visible in local dev and on the dev
    // preview host, hidden in production.
    if (leaf.id === "discord") return devMode;
    /* Admin-gated while the collections page is still being built out. Same
       flag the route's beforeLoad checks (canUseAdminFeatures), so the tab and
       the page cannot disagree about who gets in; everyone else 404s. */
    if (leaf.id === "pack-collections") return adminMode;
    if (leaf.id === "snipes") return showSnipesLink;
    return true;
  };
  const visibleLeaves = ALL_LEAVES.filter(isLeafVisible);
  const topPlaysRange = useAppStore((state) => state.topPlaysRangeByCountry[selectedCountry] ?? "7d");
  const snipesFilters = useAppStore((state) => state.snipesFiltersByCountry[selectedCountry] ?? DEFAULT_SNIPES_FILTERS);
  const hydrated = useHasHydrated();
  const topPlaysRangeForLink = hydrated && topPlaysRange !== "7d" ? topPlaysRange : "7d";
  const snipesFiltersForLink = hydrated ? snipesFilters : DEFAULT_SNIPES_FILTERS;
  const settingsActive = location.pathname.startsWith("/settings");
  const current = visibleLeaves.find((l) => location.pathname.startsWith(l.to === "/" ? "/__home" : l.to)) ||
    (location.pathname === "/" ? NAV_LEAVES.home : location.pathname.startsWith("/player") || settingsActive || (location.pathname === "/snipes" && !showSnipesLink) ? null : visibleLeaves[0]);
  // The active page's top-level item; the indicator bar sits under this.
  const activeTopId = current ? (LEAF_TO_TOP[current.id] ?? null) : null;

  // Active-link indicator: single always-mounted bar, measured from the
  // active link's rect. Replaces an earlier Framer Motion `layoutId` shared
  // layout animation that crashed the React tree on rapid nav clicks when a
  // remount happened mid-spring.
  const linksContainerRef = useRef<HTMLDivElement>(null);
  const adminMenuRef = useRef<HTMLDivElement>(null);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const restoreMenuAfterSettingsCloseRef = useRef(false);
  // Keyed by top-level item id (home link + group triggers); used to measure
  // the active-link indicator bar.
  const linkRefs = useRef<Map<string, HTMLElement>>(new Map());
  const closeGroupTimer = useRef<number | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [dimHeight, setDimHeight] = useState(0);
  const [barRect, setBarRect] = useState<{ left: number; width: number } | null>(null);

  useLayoutEffect(() => {
    const measure = () => {
      const id = activeTopId;
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
  }, [activeTopId]);

  // Size the dim band to the open dropdown so only the menu area darkens, not
  // the whole page. Stored as the band height BELOW the 60px navbar, with a bit
  // of extra room so the gradient fades out past the last item before its
  // accent line. Left at its last value while closing so it fades out cleanly.
  useLayoutEffect(() => {
    if (!openGroup) return;
    const el = dropdownRef.current;
    if (!el) return;
    setDimHeight(Math.max(0, Math.ceil(el.getBoundingClientRect().bottom) - 60 + 22));
  }, [openGroup]);

  const selectedIsGlobal = isGlobalScope(selectedCountry);
  const selectedIsRegion = isRegionScope(selectedCountry);
  // A CSS background can't onError-fall-back like <img>, so source the flag from
  // flagcdn (universal coverage, incl. countries osu! lacks e.g. Curaçao) rather
  // than osu!'s set, whose missing PNGs would leave the nav crest blank.
  const flagBackground = getCountryFlagGradient(selectedCountry)
    ?? `url(${getCountryFlagLargeUrl(selectedCountry)}) center/cover no-repeat`;

  useDynamicFavicon(selectedCountry);

  useEffect(() => {
    if (routeCountry && routeCountry !== fallbackCountry) {
      setSelectedCountry(routeCountry);
    }
  }, [fallbackCountry, routeCountry, setSelectedCountry]);

  // Close drawer on route change
  useEffect(() => {
    restoreMenuAfterSettingsCloseRef.current = false;
    setMenuOpen(false);
    setAdminMenuOpen(false);
    setUserMenuOpen(false);
    setMobileAccountOpen(false);
    setOpenGroup(null);
    setSettingsOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!menuOpen) {
      setMobileAccountOpen(false);
      setMobileCountryOpen(false);
    }
  }, [menuOpen]);

  // When the drawer opens, expand whichever group owns the current page so the
  // active item is visible without a tap.
  useEffect(() => {
    if (menuOpen && activeTopId) {
      setMobileOpenGroups((prev) => (prev.has(activeTopId) ? prev : new Set(prev).add(activeTopId)));
    }
  }, [menuOpen, activeTopId]);

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

  useEffect(() => {
    if (!userMenuOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && userMenuRef.current?.contains(target)) return;
      setUserMenuOpen(false);
    };

    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [userMenuOpen]);

  // Nav group dropdowns: close on outside click or Escape.
  useEffect(() => {
    if (!openGroup) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && linksContainerRef.current?.contains(target)) return;
      setOpenGroup(null);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenGroup(null);
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [openGroup]);

  useEffect(() => () => {
    if (closeGroupTimer.current) clearTimeout(closeGroupTimer.current);
  }, []);

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

  // Per-leaf search params. Routes like /maps and /snipes have many required
  // search fields; validateSearch fills the rest from defaults at runtime.
  const linkSearch = (id: NavLeafId) => {
    switch (id) {
      case "home":
      case "tracker":
        return { country: selectedCountry };
      case "rankings":
        return { country: selectedCountry, page: 1 };
      case "top-plays":
        return { country: selectedCountry, range: topPlaysRangeForLink };
      case "maps":
        return preserveSearchWithCountryOnFirstPage(selectedCountry);
      case "snipes":
        return { country: selectedCountry, ...snipesFiltersForLink, page: 0 };
      default:
        return undefined;
    }
  };

  const openGroupNow = (id: string) => {
    if (closeGroupTimer.current) {
      clearTimeout(closeGroupTimer.current);
      closeGroupTimer.current = null;
    }
    setOpenGroup(id);
  };

  const scheduleCloseGroup = () => {
    if (closeGroupTimer.current) clearTimeout(closeGroupTimer.current);
    closeGroupTimer.current = window.setTimeout(() => setOpenGroup(null), 120);
  };

  /* A group whose own name is also a destination navigates on click and only
     opens on hover, so making Packs a dropdown does not cost it its tab. */
  const handleGroupTriggerClick = (top: Extract<NavTop, { kind: "group" }>) => {
    if (top.id === "players") {
      setOpenGroup(null);
      navigate({ to: "/rankings", search: { country: selectedCountry, page: 1 } });
      return;
    }
    if (top.id === "packs") {
      setOpenGroup(null);
      navigate({ to: "/packs" });
      return;
    }

    openGroupNow(top.id);
  };

  const toggleMobileGroup = (id: string) =>
    setMobileOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const renderMobileLink = (leaf: NavLeaf, opts?: { nested?: boolean }) => (
    <Link
      key={leaf.id}
      to={leaf.to}
      search={linkSearch(leaf.id)}
      preload={leaf.id === "tracker" ? false : "intent"}
      onClick={() => setMenuOpen(false)}
      draggable={false}
      className={`flex items-center gap-3 border-l-3 py-3 text-sm font-medium capitalize transition-colors duration-[120ms] ${
        opts?.nested ? "pl-9 pr-5 text-[13px]" : "px-5"
      } ${
        current?.id === leaf.id
          ? "border-osu-yellow bg-osu-pink/10 text-white"
          : "border-transparent text-osu-pink-light hover:bg-osu-b4/50 hover:text-white"
      }`}
    >
      {leaf.label}
    </Link>
  );

  // Stored players answer this without an osu! call; the API is only asked when
  // the name belongs to nobody we track (see lib/player-search).
  const handleSearch = (q: string) => searchPlayers(q);

  const handleCountrySelect = (country: string) => {
    setSelectedCountry(country);
    setMenuOpen(false);

    // Snipes is not a Global surface (Global is not a country). Switching to
    // Global from /snipes moves the reader to Maps, the headline Global view.
    if (isGlobalScope(country) && location.pathname === "/snipes") {
      navigate({ to: "/maps", search: preserveSearchWithCountryOnFirstPage(country), replace: true });
      return;
    }

    if (location.pathname === "/") {
      navigate({ to: "/", search: { country }, replace: true });
      return;
    }
    if (location.pathname === "/rankings") {
      navigate({ to: "/rankings", search: { country, page: 1 }, replace: true });
      return;
    }
    if (location.pathname === "/top-plays") {
      navigate({
        to: "/top-plays",
        search: { country, range: topPlaysRangeForLink, sort: "recent", dir: "desc", keys: "all" },
        replace: true,
      });
      return;
    }
    if (location.pathname === "/tracker") {
      navigate({ to: "/tracker", search: { country, page: undefined }, replace: true });
      return;
    }
    // For /snipes and /maps reuse route search via the reducer form
    // (see preserveSearchWithCountry for why we cast). Maps resets page
    // because other routes also use `page` with different expectations.
    if (location.pathname === "/snipes") {
      navigate({ to: "/snipes", search: preserveSearchWithCountry(country), replace: true });
      return;
    }
    if (location.pathname === "/farm-helper") {
      // Farm Helper is global; changing country only updates the app shell.
      return;
    }
    if (location.pathname === "/maps") {
      navigate({ to: "/maps", search: preserveSearchWithCountryOnFirstPage(country), replace: true });
    }
  };

  const handleSettingsClose = () => {
    setSettingsOpen(false);
    if (restoreMenuAfterSettingsCloseRef.current) {
      restoreMenuAfterSettingsCloseRef.current = false;
      setMenuOpen(true);
    }
  };

  const handleSettingsBackdropClose = () => {
    restoreMenuAfterSettingsCloseRef.current = false;
    setSettingsOpen(false);
    setMenuOpen(false);
  };

  return (
    <>
      {/* osu!-style dim behind an open nav dropdown: a band only as tall as the
          menu, dark under the navbar and fading to transparent, capped by a
          themed accent line marking its end. Sits below the header (z-50) so the
          bar and dropdown stay bright. */}
      <div
        className={`fixed inset-x-0 top-[60px] z-40 bg-gradient-to-b from-black/25 via-black/40 to-black/55 backdrop-blur-md transition-opacity duration-150 ${
          openGroup ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
        style={{ height: dimHeight }}
        onClick={() => setOpenGroup(null)}
        aria-hidden
      >
        <div className="absolute inset-x-0 bottom-0 h-px bg-osu-pink/40" />
      </div>
      {/* translate="no" for the same reason the packs panels carry it, except
          this one rides every route: the group triggers hold bare text next to
          an icon, so browser auto-translate rewraps that text in <font> nodes
          and the next commit touching the trigger throws NotFoundError
          (removeChild/insertBefore). The labels are osu! jargon anyway. */}
      <header translate="no" className="fixed top-0 left-0 right-0 z-50">
      <div className="absolute inset-0 bg-osu-b6">
        <img
          src="/images/layout/nav2-background-hue0.webp"
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
                {selectedIsGlobal ? (
                  <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-osu-pink/35 to-osu-b6">
                    <Globe className="h-5 w-5 text-osu-pink-light" strokeWidth={2.2} />
                  </div>
                ) : selectedIsRegion ? (
                  <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-osu-pink/35 to-osu-b6">
                    <RegionIcon code={selectedCountry} className="h-[22px] w-[22px] text-osu-pink-light" />
                  </div>
                ) : (
                  <>
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
                  </>
                )}
              </div>
              <span className="mode-icon text-osu-pink text-lg" title="mania">{"\ue802"}</span>
            </Link>
          </motion.div>

          {/* Desktop nav links */}
          <div ref={linksContainerRef} className="relative hidden md:flex items-center gap-1">
            {NAV_TOP.map((top) => {
              if (top.kind === "link") {
                const leaf = NAV_LEAVES[top.id];
                if (!isLeafVisible(leaf)) return null;
                return (
                  <Link
                    key={top.id}
                    ref={(el: HTMLAnchorElement | null) => {
                      if (el) linkRefs.current.set(top.id, el);
                      else linkRefs.current.delete(top.id);
                    }}
                    to={leaf.to}
                    search={linkSearch(leaf.id)}
                    preload={leaf.id === "tracker" ? false : "intent"}
                    draggable={false}
                    className={`relative px-2.5 py-[19px] text-[12px] font-semibold capitalize whitespace-nowrap transition-colors duration-[120ms] ${
                      activeTopId === top.id ? "text-white" : "text-osu-pink-light hover:text-white"
                    }`}
                  >
                    {leaf.label}
                  </Link>
                );
              }

              const groupItems = top.items.map((id) => NAV_LEAVES[id]).filter(isLeafVisible);
              if (groupItems.length === 0) return null;
              const open = openGroup === top.id;
              return (
                <div
                  key={top.id}
                  className="relative"
                  onMouseEnter={() => openGroupNow(top.id)}
                  onMouseLeave={scheduleCloseGroup}
                >
                  <button
                    type="button"
                    ref={(el: HTMLButtonElement | null) => {
                      if (el) linkRefs.current.set(top.id, el);
                      else linkRefs.current.delete(top.id);
                    }}
                    onClick={() => handleGroupTriggerClick(top)}
                    className={`relative flex cursor-pointer items-center gap-1 px-2.5 py-[19px] text-[12px] font-semibold capitalize whitespace-nowrap transition-colors duration-[120ms] ${
                      activeTopId === top.id || open ? "text-white" : "text-osu-pink-light hover:text-white"
                    }`}
                    aria-haspopup="menu"
                    aria-expanded={open}
                  >
                    {top.label}
                    <ChevronDown
                      className={`h-3 w-3 opacity-70 transition-transform duration-150 ${open ? "rotate-180" : ""}`}
                      strokeWidth={2.5}
                    />
                  </button>
                  {open && (
                    <div
                      ref={dropdownRef}
                      className="absolute left-0 top-full z-[70] flex min-w-[150px] flex-col whitespace-nowrap pt-1 pb-2"
                      role="menu"
                    >
                      {groupItems.map((leaf) => {
                        const itemActive = current?.id === leaf.id;
                        return (
                          <Link
                            key={leaf.id}
                            to={leaf.to}
                            search={linkSearch(leaf.id)}
                            preload={leaf.id === "tracker" ? false : "intent"}
                            onClick={() => setOpenGroup(null)}
                            draggable={false}
                            role="menuitem"
                            className={`relative py-2 pl-4 pr-3 text-[13px] font-semibold capitalize [text-shadow:0_1px_5px_rgba(0,0,0,0.95)] transition-colors before:absolute before:left-1 before:top-1/2 before:h-[15px] before:w-[3px] before:-translate-y-1/2 before:rounded-full before:bg-osu-yellow before:transition-opacity ${
                              itemActive
                                ? "text-white before:opacity-100"
                                : "text-osu-pink-light before:opacity-0 hover:text-white hover:before:opacity-100"
                            }`}
                          >
                            {leaf.label}
                          </Link>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
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
                  /* Two columns: eight tools in one column ran most of the way
                     down the page. The dividers are borders on the cells rather
                     than a grid gap, because a gap is a hole - the menu's own
                     background does not paint there and the page reads through
                     the seams. */
                  <div
                    className="absolute right-0 top-full mt-2 w-56 grid grid-cols-2 rounded-lg bg-osu-b5 border border-osu-b3/50 shadow-xl overflow-hidden z-[80]"
                    role="menu"
                  >
                    {adminToolsFor(adminMode).map((tool, index) => (
                      <Link
                        key={tool.to}
                        to={tool.to}
                        search={adminToolSearch(tool)}
                        onClick={() => setAdminMenuOpen(false)}
                        className={`px-3 py-2 text-[11px] font-semibold text-osu-l2 hover:bg-osu-b4 hover:text-white transition-colors ${
                          index > 1 ? "border-t border-osu-b3/30" : ""
                        } ${index % 2 === 1 ? "border-l border-osu-b3/30" : ""}`}
                        role="menuitem"
                      >
                        {tool.label}
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
          {auth.viewer || auth.loginAvailable ? (
            <div ref={userMenuRef} className="relative">
              <button
                type="button"
                onClick={() => setUserMenuOpen((open) => !open)}
                className="flex h-8 w-8 items-center justify-center overflow-hidden rounded-full ring-1 ring-osu-b3/60 text-osu-pink-light transition hover:ring-osu-pink/60 cursor-pointer"
                title={auth.viewer ? `Signed in as ${auth.viewer.username}` : "Account"}
                aria-haspopup="menu"
                aria-expanded={userMenuOpen}
              >
                {auth.viewer ? (
                  <Avatar url={auth.viewer.avatarUrl} userId={auth.viewer.id} size={32} />
                ) : (
                  <UserRound className="h-4 w-4" strokeWidth={2.1} />
                )}
              </button>
              {userMenuOpen && (
                <div
                  className="absolute right-0 top-full mt-2 w-44 rounded-lg bg-osu-b5 border border-osu-b3/50 shadow-xl overflow-hidden z-[80]"
                  role="menu"
                >
                  {auth.viewer ? (
                    <>
                      <div className="px-3 py-2 border-b border-osu-b3/30">
                        <div className="text-[10px] font-medium text-osu-l3 leading-tight">Signed in as</div>
                        <div className="flex items-center gap-1.5">
                          <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-white">{auth.viewer.username}</span>
                          {viewerCountryTracked && viewerCountryCode ? (
                            <button
                              type="button"
                              onClick={() => {
                                handleCountrySelect(viewerCountryCode);
                                setUserMenuOpen(false);
                              }}
                              title={`Switch to ${getCountryName(viewerCountryCode)}`}
                              aria-label={`Switch country to ${getCountryName(viewerCountryCode)}`}
                              className="-my-1 flex shrink-0 items-center justify-center rounded-md p-1 transition-colors hover:bg-osu-b3/70 cursor-pointer"
                            >
                              <CountryFlag code={viewerCountryCode} size="md" decorative />
                            </button>
                          ) : null}
                        </div>
                      </div>
                      <Link
                        to="/player/$username"
                        params={{ username: auth.viewer.username }}
                        onClick={() => setUserMenuOpen(false)}
                        className="flex items-center gap-2 px-3 py-2 text-[11px] font-semibold text-osu-l2 hover:bg-osu-b4 hover:text-white transition-colors"
                        role="menuitem"
                      >
                        <UserRound className="h-3.5 w-3.5" />
                        Profile
                      </Link>
                      <Link
                        to="/my-stats"
                        onClick={() => setUserMenuOpen(false)}
                        className="flex items-center gap-2 px-3 py-2 text-[11px] font-semibold text-osu-l2 hover:bg-osu-b4 hover:text-white transition-colors"
                        role="menuitem"
                      >
                        <BarChart3 className="h-3.5 w-3.5" />
                        My Stats
                      </Link>
                      <Link
                        to="/goals"
                        onClick={() => setUserMenuOpen(false)}
                        className="flex items-center gap-2 px-3 py-2 text-[11px] font-semibold text-osu-l2 hover:bg-osu-b4 hover:text-white transition-colors"
                        role="menuitem"
                      >
                        <Target className="h-3.5 w-3.5" />
                        Goals
                      </Link>
                      {adminMode ? (
                        <Link
                          to="/dynamic-renders"
                          onClick={() => setUserMenuOpen(false)}
                          className="flex items-center gap-2 px-3 py-2 text-[11px] font-semibold text-osu-l2 hover:bg-osu-b4 hover:text-white transition-colors"
                          role="menuitem"
                        >
                          <ImageIcon className="h-3.5 w-3.5" />
                          Dynamic Renders
                        </Link>
                      ) : null}
                      {/* Logout is a POST (the route rejects GET), so it needs a
                          form; `contents` keeps the button laid out as if it
                          were still a direct child of the menu. */}
                      <form method="post" action={logoutHref} className="contents">
                        <button
                          type="submit"
                          className="flex w-full items-center gap-2 border-t border-osu-b3/30 px-3 py-2 text-[11px] font-semibold text-osu-l2 hover:bg-osu-b4 hover:text-white transition-colors"
                          role="menuitem"
                        >
                          <LogOut className="h-3.5 w-3.5" />
                          Logout
                        </button>
                      </form>
                    </>
                  ) : (
                    <>
                      <div className="px-3 py-2 border-b border-osu-b3/30 text-[12px] font-semibold text-white">
                        Not signed in
                      </div>
                      <a
                        href={loginHref}
                        className="flex items-center gap-2 px-3 py-2 text-[11px] font-semibold text-osu-l2 hover:bg-osu-b4 hover:text-white transition-colors"
                        role="menuitem"
                      >
                        <LogIn className="h-3.5 w-3.5" />
                        Log in with osu!
                      </a>
                    </>
                  )}
                </div>
              )}
            </div>
          ) : null}
          <CountrySelector className="w-52" selectedCountry={selectedCountry} onSelect={handleCountrySelect} showGlobal={liveBackendConfigured} />
          <SearchInput
            className="w-52"
            placeholder="find player..."
            onSearch={handleSearch}
            onSelect={(u) => navigate({
              to: "/player/$username",
              params: { username: u.username },
              state: showPlayerCountryFlagState,
            })}
          />
          <button
            type="button"
            onClick={() => {
              restoreMenuAfterSettingsCloseRef.current = false;
              setSettingsOpen((open) => !open);
            }}
            className={`flex h-9 w-9 cursor-pointer items-center justify-center rounded-lg transition-colors ${
              settingsOpen || settingsActive
                ? "bg-osu-pink/20 text-white"
                : "text-osu-pink-light hover:bg-osu-b3/50 hover:text-white"
            }`}
            title="Settings"
            aria-label="Settings"
            aria-expanded={settingsOpen}
          >
            <Settings className="h-5 w-5" strokeWidth={2.1} />
          </button>
          <ThemePicker />
        </div>

        {/* Mobile hamburger button */}
        <button
          className="md:hidden flex items-center justify-center w-9 h-9 rounded-lg hover:bg-osu-b3/50 transition-colors cursor-pointer"
          onClick={() => {
            restoreMenuAfterSettingsCloseRef.current = false;
            setMenuOpen(!menuOpen);
          }}
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
                {NAV_TOP.map((top) => {
                  if (top.kind === "link") {
                    if (!isLeafVisible(NAV_LEAVES[top.id])) return null;
                    return renderMobileLink(NAV_LEAVES[top.id]);
                  }
                  const groupItems = top.items.map((id) => NAV_LEAVES[id]).filter(isLeafVisible);
                  if (groupItems.length === 0) return null;
                  const expanded = mobileOpenGroups.has(top.id);
                  return (
                    <div key={top.id}>
                      <button
                        type="button"
                        onClick={() => toggleMobileGroup(top.id)}
                        aria-expanded={expanded}
                        className={`flex w-full cursor-pointer items-center justify-between gap-3 border-l-3 px-5 py-3 text-sm font-medium capitalize transition-colors duration-[120ms] ${
                          activeTopId === top.id
                            ? "border-osu-yellow text-white"
                            : "border-transparent text-osu-pink-light hover:bg-osu-b4/50 hover:text-white"
                        }`}
                      >
                        <span>{top.label}</span>
                        <ChevronDown
                          className={`h-4 w-4 shrink-0 opacity-70 transition-transform duration-150 ${expanded ? "rotate-180" : ""}`}
                          strokeWidth={2.5}
                        />
                      </button>
                      <AnimatePresence initial={false}>
                        {expanded ? (
                          <motion.div
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: "auto", opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            transition={{ duration: 0.2, ease: "easeOut" }}
                            className="overflow-hidden bg-osu-b6/40"
                          >
                            {groupItems.map((leaf) => renderMobileLink(leaf, { nested: true }))}
                          </motion.div>
                        ) : null}
                      </AnimatePresence>
                    </div>
                  );
                })}
              </div>

              <div className="border-t border-osu-b3/30 px-4 py-4">
                <SearchInput
                  className="w-full"
                  placeholder="find player..."
                  onSearch={handleSearch}
                  onSelect={(u) => {
                    setMenuOpen(false);
                    navigate({
                      to: "/player/$username",
                      params: { username: u.username },
                      state: showPlayerCountryFlagState,
                    });
                  }}
                />
              </div>

              <div className="border-t border-osu-b3/30 px-4 py-3 space-y-2">
                <CountrySelector
                  className="w-full"
                  selectedCountry={selectedCountry}
                  onSelect={handleCountrySelect}
                  showGlobal={liveBackendConfigured}
                  open={mobileCountryOpen}
                  onOpenChange={(next) => {
                    setMobileCountryOpen(next);
                    if (next) setMobileAccountOpen(false);
                  }}
                />
                <ThemePicker variant="mobile" />
                {auth.viewer ? (
                  <div className="relative">
                    <div className="flex items-stretch gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setMobileAccountOpen((open) => !open);
                          setMobileCountryOpen(false);
                        }}
                        className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg border border-osu-b3/30 bg-osu-b4/60 px-2.5 py-1.5 text-osu-l2 transition-colors duration-[120ms] hover:border-osu-b3/60 hover:bg-osu-b4/80"
                        aria-label="Account menu"
                        aria-expanded={mobileAccountOpen}
                      >
                        <span className="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-full ring-1 ring-osu-b3/60">
                          <Avatar url={auth.viewer.avatarUrl} userId={auth.viewer.id} size={24} />
                        </span>
                        <span className="min-w-0 flex-1 truncate text-left text-[11px] font-semibold">
                          {auth.viewer.username}
                        </span>
                        <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-osu-f1 transition-transform duration-150 ${mobileAccountOpen ? "rotate-180" : ""}`} strokeWidth={2.2} />
                      </button>
                      {viewerCountryTracked && viewerCountryCode ? (
                        <button
                          type="button"
                          onClick={() => {
                            handleCountrySelect(viewerCountryCode);
                            setMobileAccountOpen(false);
                            setMenuOpen(false);
                          }}
                          title={`Switch to ${getCountryName(viewerCountryCode)}`}
                          aria-label={`Switch country to ${getCountryName(viewerCountryCode)}`}
                          className="flex shrink-0 items-center justify-center rounded-lg border border-osu-b3/30 bg-osu-b4/60 px-2.5 transition-colors duration-[120ms] hover:border-osu-b3/60 hover:bg-osu-b4/80 cursor-pointer"
                        >
                          <CountryFlag code={viewerCountryCode} size="md" decorative />
                        </button>
                      ) : null}
                    </div>

                    {mobileAccountOpen ? (
                      <div className="absolute left-0 right-0 top-full z-[65] mt-1 overflow-hidden rounded-lg border border-osu-b3/50 bg-osu-b5 shadow-[0_10px_25px_rgba(0,0,0,0.5)]">
                        <Link
                          to="/player/$username"
                          params={{ username: auth.viewer.username }}
                          onClick={() => {
                            setMobileAccountOpen(false);
                            setMenuOpen(false);
                          }}
                          className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[11px] font-medium text-osu-l2 transition-colors duration-[80ms] hover:bg-osu-b3/50 hover:text-white"
                        >
                          <UserRound className="h-3.5 w-3.5 shrink-0 opacity-75" />
                          Profile
                        </Link>
                        <Link
                          to="/my-stats"
                          onClick={() => {
                            setMobileAccountOpen(false);
                            setMenuOpen(false);
                          }}
                          className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[11px] font-medium text-osu-l2 transition-colors duration-[80ms] hover:bg-osu-b3/50 hover:text-white"
                        >
                          <BarChart3 className="h-3.5 w-3.5 shrink-0 opacity-75" />
                          My Stats
                        </Link>
                        <Link
                          to="/goals"
                          onClick={() => {
                            setMobileAccountOpen(false);
                            setMenuOpen(false);
                          }}
                          className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[11px] font-medium text-osu-l2 transition-colors duration-[80ms] hover:bg-osu-b3/50 hover:text-white"
                        >
                          <Target className="h-3.5 w-3.5 shrink-0 opacity-75" />
                          Goals
                        </Link>
                        {adminMode ? (
                          <Link
                            to="/dynamic-renders"
                            onClick={() => {
                              setMobileAccountOpen(false);
                              setMenuOpen(false);
                            }}
                            className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[11px] font-medium text-osu-l2 transition-colors duration-[80ms] hover:bg-osu-b3/50 hover:text-white"
                          >
                            <ImageIcon className="h-3.5 w-3.5 shrink-0 opacity-75" />
                            Dynamic Renders
                          </Link>
                        ) : null}
                        <form method="post" action={logoutHref} className="contents">
                          <button
                            type="submit"
                            className="flex w-full items-center gap-2.5 border-t border-osu-b3/30 px-3 py-2 text-left text-[11px] font-medium text-osu-l2 transition-colors duration-[80ms] hover:bg-osu-b3/50 hover:text-white"
                          >
                            <LogOut className="h-3.5 w-3.5 shrink-0 opacity-75" />
                            Logout
                          </button>
                        </form>
                      </div>
                    ) : null}
                  </div>
                ) : auth.loginAvailable ? (
                  <a
                    href={loginHref}
                    className="flex w-full items-center justify-center gap-2 rounded-lg border border-osu-pink/30 bg-osu-pink/10 px-3 py-2 text-[12px] font-semibold text-osu-pink-light transition-colors hover:bg-osu-pink/20 hover:text-white"
                  >
                    <LogIn className="h-4 w-4" />
                    Login
                  </a>
                ) : null}
                <button
                  type="button"
                  onClick={() => {
                    restoreMenuAfterSettingsCloseRef.current = true;
                    setMenuOpen(false);
                    setSettingsOpen(true);
                  }}
                  className={`flex w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-[12px] font-semibold capitalize transition-colors ${
                    settingsOpen || settingsActive
                      ? "bg-osu-pink/15 text-white"
                      : "bg-osu-b4/60 text-osu-pink-light hover:bg-osu-b4 hover:text-white"
                  }`}
                >
                  <Settings className="h-5 w-5" strokeWidth={2.1} />
                  settings
                </button>
              </div>

              {devMode && (
                <div className="border-t border-osu-b3/30 px-4 py-3 space-y-2">
                  <div className="text-[10px] uppercase tracking-wide text-osu-f1 font-semibold px-1">
                    {devToolsLabel}
                  </div>
                  {/* Same list, same order, two across: the drawer is already
                      long by the time it reaches this. */}
                  <div className="grid grid-cols-2 gap-2">
                    {adminToolsFor(adminMode).map((tool) => (
                      <Link
                        key={tool.to}
                        to={tool.to}
                        search={adminToolSearch(tool)}
                        onClick={() => setMenuOpen(false)}
                        className="text-center px-3 py-2 rounded-lg bg-osu-yellow/15 text-[10px] text-osu-yellow font-semibold hover:bg-osu-yellow/25 transition-colors cursor-pointer border border-osu-yellow/30"
                      >
                        {tool.label}
                      </Link>
                    ))}
                  </div>
                </div>
              )}
      </div>

      <SettingsDrawer
        open={settingsOpen}
        onClose={handleSettingsClose}
        onBackdropClose={handleSettingsBackdropClose}
      />
    </header>
    </>
  );
}
