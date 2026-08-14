import { HeadContent, Link, Outlet, Scripts, createRootRoute, useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Coffee, X } from "lucide-react";
import { createServerFn } from "@tanstack/react-start";
import { getRequest, setCookie } from "@tanstack/react-start/server";
import { ChangelogModal } from "../components/layout/ChangelogModal";
import { GhostLayer } from "../components/ghost/GhostLayer";
import { CustomCursor } from "../components/layout/CustomCursor";
import { ManiaRain } from "../components/home/ManiaRain";
import { Nav } from "../components/layout/Nav";
import { OsuTriangleBackdrop } from "../components/layout/OsuTriangleBackdrop";
import { RouteLoadingBar } from "../components/layout/RouteLoadingBar";
import { GoalToasts } from "../components/me/GoalToasts";
import { TrackingToasts } from "../components/me/TrackingToasts";
import { AuthContext } from "../lib/auth-context";
import { getCurrentAuth } from "../lib/auth";
import { InitialCountryContext } from "../lib/country-context";
import type { AuthState } from "../lib/auth-shared";
import {
  COUNTRY_AUTO_COOKIE_NAME,
  COUNTRY_COOKIE_MAX_AGE_SECONDS,
  COUNTRY_COOKIE_NAME,
  hasAutoCountryCookieHeader,
  parseCountryCookieHeader,
  readAutoCountryCookieClient,
  readCountryCookieClient,
  readEdgeCountry,
  resolveDetectedCountry,
  resolveInitialCountry,
} from "../lib/country-cookie";
import { AnalyticsProvider } from "../lib/analytics-provider";
import { track } from "../lib/analytics";
import { getCanonicalOrigin } from "../lib/origin";
import { isStaleRouteModuleMessage } from "../lib/stale-route-error";
import { DEFAULT_DESCRIPTION, SITE_FAVICON_HREF, SITE_NAME, websiteJsonLd } from "../lib/seo";
import { activateLiveCountryOnServer, fetchLiveBackendBootstrap } from "../lib/live-backend";
import type { LiveBackendStatus, LiveCountryFeaturesSnapshot } from "../lib/live-backend";
import { BackendOfflineScreen } from "../components/BackendOfflineScreen";
import { seedCountryTierCache } from "../lib/use-country-warming";
import { isWindowActive, subscribeWindowActivity } from "../lib/window-activity";
import { reapplyThemeToDom } from "../store";
import appCss from "../styles.css?url";

/* Origin is resolved through a configured canonical URL first, then through
   allowlisted request hosts. That keeps SEO URLs stable without trusting
   arbitrary Host / X-Forwarded-Host headers. */
const getRequestOrigin = createServerFn({ method: "GET" }).handler(() => {
  return getCanonicalOrigin(getRequest());
});

// Narrowed to a country the site tracks, unlike the analytics path which keeps
// the raw code: this one picks which country view a visitor lands on, and an
// untracked code is no more routable here than no code at all.
function getRequestCountry(): string | null {
  return resolveDetectedCountry(readEdgeCountry(getRequest().headers));
}

// The set of country codes the server actually tracks. We only auto-route
// a visitor to a single-country view when its country is in this set; everything
// else (untracked countries, no geo signal, backend offline) lands on Global.
// Returns null when the backend is unreachable so availability stays "unknown".
async function getAvailableCountrySet(): Promise<ReadonlySet<string> | null> {
  const bootstrap = await fetchLiveBackendBootstrap();
  if (!bootstrap.countryFeatures) return null;
  return new Set(bootstrap.countryFeatures.countries.map((entry) => entry.country.toUpperCase()));
}

const getInitialCountry = createServerFn({ method: "GET" }).handler(async () => {
  const cookieHeader = getRequest().headers.get("cookie");
  const countryCookie = parseCountryCookieHeader(cookieHeader);
  const cookieIsAuto = hasAutoCountryCookieHeader(cookieHeader);

  // A country the visitor explicitly picked is always honoured without needing
  // to consult the backend, which keeps the common returning-visitor path fast.
  if (countryCookie && !cookieIsAuto) return countryCookie;

  let available = await getAvailableCountrySet();
  const detectedCountry = getRequestCountry();

  // First visit from a country the backend has never registered: start
  // tracking it immediately (active status, live tier) and route the visitor
  // there; the country-warming flow covers the empty-roster window. Countries
  // already in the registry, even cold ones, are in `available`, so this only
  // fires for brand-new ones.
  if (available && detectedCountry && !available.has(detectedCountry)) {
    const activated = await activateLiveCountryOnServer(
      detectedCountry,
      getRequest().headers.get("x-forwarded-for"),
    );
    if (activated) available = new Set([...available, detectedCountry]);
  }

  const resolved = resolveInitialCountry(countryCookie, detectedCountry, {
    available,
    cookieIsAuto,
  });

  // Persist the resolved scope so subsequent requests (and the client store) see
  // it. Global is written too, so a stale auto cookie that pointed at a now
  // untracked country gets corrected. The `-auto` marker stays set: the visitor
  // can still override with a manual pick later.
  if (resolved !== countryCookie) {
    setCookie(COUNTRY_COOKIE_NAME, resolved, {
      path: "/",
      maxAge: COUNTRY_COOKIE_MAX_AGE_SECONDS,
      sameSite: "lax",
    });
    setCookie(COUNTRY_AUTO_COOKIE_NAME, "1", {
      path: "/",
      maxAge: COUNTRY_COOKIE_MAX_AGE_SECONDS,
      sameSite: "lax",
    });
  }

  return resolved;
});

type RootSlowContext = {
  auth: AuthState;
  backendStatus: LiveBackendStatus;
  countryFeatures: LiveCountryFeaturesSnapshot | null;
};

type RootRouteContext = RootSlowContext & {
  initialCountry: string;
  origin: string;
};

const CLIENT_ROOT_CONTEXT_TTL_MS = 60_000;

let clientRootSlowContextCache: { value: RootSlowContext; expiresAt: number } | null = null;
let clientRootSlowContextPromise: Promise<RootSlowContext> | null = null;

function refreshClientRootSlowContext(): Promise<RootSlowContext> {
  if (!clientRootSlowContextPromise) {
    clientRootSlowContextPromise = Promise.all([
      getCurrentAuth(),
      fetchLiveBackendBootstrap(),
    ])
      .then(([auth, bootstrap]) => {
        const value = {
          auth,
          backendStatus: bootstrap.status,
          countryFeatures: bootstrap.countryFeatures,
        };
        clientRootSlowContextCache = {
          value,
          expiresAt: Date.now() + CLIENT_ROOT_CONTEXT_TTL_MS,
        };
        return value;
      })
      .finally(() => {
        clientRootSlowContextPromise = null;
      });
  }

  return clientRootSlowContextPromise;
}

function readClientRootSlowContext(): RootSlowContext | Promise<RootSlowContext> {
  if (clientRootSlowContextCache) {
    if (clientRootSlowContextCache.expiresAt <= Date.now()) {
      void refreshClientRootSlowContext().catch(() => {});
    }
    return clientRootSlowContextCache.value;
  }

  return refreshClientRootSlowContext();
}

// The SSR response dehydrates its slow context (auth + backend bootstrap) into
// an inline script, and the first client beforeLoad consumes it here instead of
// fetching. This is a hydration-correctness requirement, not just a saved round
// trip: route context is not serialized by the router, so without the handoff
// the client re-fetches during hydration, and any drift from what the server
// rendered with (a backend restart between the two fetches, a country tier
// flap, transient bootstrap failure) makes React hydrate against different
// data -- seen in the wild as recoverable #418s at the first divergent node
// (the nav's tier-gated Snipes link). Consumed once; later refreshes go
// through the normal TTL'd fetch path.
function consumeDehydratedRootSlowContext(): RootSlowContext | null {
  const value = window.__maniaHubRootSlowContext;
  if (!value || typeof value !== "object" || typeof value.backendStatus !== "string") return null;
  delete window.__maniaHubRootSlowContext;
  const context: RootSlowContext = {
    auth: value.auth,
    backendStatus: value.backendStatus,
    countryFeatures: value.countryFeatures ?? null,
  };
  clientRootSlowContextCache = {
    value: context,
    expiresAt: Date.now() + CLIENT_ROOT_CONTEXT_TTL_MS,
  };
  return context;
}

// Keys are written in RootSlowContext declaration order so the client's
// re-render of the dehydration script serializes to the identical string.
function serializeRootSlowContext(value: RootSlowContext): string {
  return JSON.stringify({
    auth: value.auth,
    backendStatus: value.backendStatus,
    countryFeatures: value.countryFeatures,
  })
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function seedClientRootSlowContext(value: RootSlowContext): void {
  if (typeof document === "undefined") return;
  if (
    clientRootSlowContextCache &&
    clientRootSlowContextCache.expiresAt > Date.now() &&
    clientRootSlowContextCache.value.auth === value.auth &&
    clientRootSlowContextCache.value.backendStatus === value.backendStatus &&
    clientRootSlowContextCache.value.countryFeatures === value.countryFeatures
  ) {
    return;
  }
  clientRootSlowContextCache = {
    value,
    expiresAt: Date.now() + CLIENT_ROOT_CONTEXT_TTL_MS,
  };
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof (value as Promise<T>).then === "function";
}

declare global {
  interface Window {
    __maniaHubRecoverChunkLoad?: (error: unknown, force?: boolean) => boolean;
    __maniaHubRootSlowContext?: RootSlowContext;
  }
}

const CHUNK_LOAD_ERROR_PATTERNS = [
  "failed to fetch dynamically imported module",
  "error loading dynamically imported module",
  "importing a module script failed",
  "failed to load module script",
  "loading chunk",
  "chunkloaderror",
  "vite:preloaderror",
];

/* One reload per URL per five minutes, counted separately for the two callers.
   The ambient listeners recover silently, so a page that reloaded once already
   used to leave the error boundary's forced call guard-blocked -- the user sat
   on "Something broke" having never seen a refresh of their own. Separate slots
   keep each path's loop protection intact while letting the boundary try once. */
const CHUNK_LOAD_RECOVERY_SCRIPT = `(()=>{var key="mania-hub-chunk-reload-v1";var forcedKey="mania-hub-route-reload-v1";var ttl=300000;function text(value){try{if(!value)return"";if(typeof value==="string")return value;if(value instanceof Error)return value.name+" "+value.message;var parts=[];if(typeof value.name==="string")parts.push(value.name);if(typeof value.message==="string")parts.push(value.message);if(typeof value.type==="string")parts.push(value.type);if(value.reason)parts.push(text(value.reason));if(value.payload)parts.push(text(value.payload));return parts.join(" ");}catch(e){return"";}}function isChunkError(value){var message=text(value).toLowerCase();return message.indexOf("failed to fetch dynamically imported module")!==-1||message.indexOf("error loading dynamically imported module")!==-1||message.indexOf("importing a module script failed")!==-1||message.indexOf("failed to load module script")!==-1||message.indexOf("loading chunk")!==-1||message.indexOf("chunkloaderror")!==-1||message.indexOf("vite:preloaderror")!==-1;}function freshen(){var tasks=[];try{if(navigator.serviceWorker&&navigator.serviceWorker.getRegistrations){tasks.push(navigator.serviceWorker.getRegistrations().then(function(registrations){return Promise.all(registrations.map(function(registration){return registration.unregister().catch(function(){});}));}));}}catch(e){}try{if(window.caches&&caches.keys){tasks.push(caches.keys().then(function(keys){return Promise.all(keys.filter(function(name){return /^static-v/.test(name)||/^mania-hub/.test(name);}).map(function(name){return caches.delete(name);}));}));}}catch(e){}Promise.allSettled(tasks).finally(function(){location.reload();});}function recover(value,force){if(!force&&!isChunkError(value))return false;var slot=force?forcedKey:key;try{var now=Date.now();var href=location.href;var previous=JSON.parse(sessionStorage.getItem(slot)||"null");if(previous&&previous.href===href&&now-previous.at<ttl)return false;sessionStorage.setItem(slot,JSON.stringify({href:href,at:now}));}catch(e){}freshen();return true;}window.__maniaHubRecoverChunkLoad=recover;window.addEventListener("vite:preloadError",function(event){if(recover(event&&event.payload)){event.preventDefault();}},true);window.addEventListener("unhandledrejection",function(event){recover(event&&event.reason);},true);window.addEventListener("error",function(event){recover(event&&(event.error||event.message));},true);})();`;

function errorText(error: unknown): string {
  if (!error) return "";
  if (typeof error === "string") return error;
  if (error instanceof Error) return `${error.name} ${error.message}`;
  if (typeof error === "object") {
    const value = error as {
      message?: unknown;
      name?: unknown;
      payload?: unknown;
      reason?: unknown;
      type?: unknown;
    };
    return [
      typeof value.name === "string" ? value.name : "",
      typeof value.message === "string" ? value.message : "",
      typeof value.type === "string" ? value.type : "",
      errorText(value.reason),
      errorText(value.payload),
    ].filter(Boolean).join(" ");
  }
  return "";
}

function isChunkLoadError(error: unknown): boolean {
  const message = errorText(error).toLowerCase();
  return CHUNK_LOAD_ERROR_PATTERNS.some((pattern) => message.includes(pattern));
}

// Matched only here in the route error boundary -- the global
// error/unhandledrejection hooks keep the narrow chunk patterns, so a genuine
// app bug that happens to read `.component` can at worst cost one guarded
// reload via this path, not ambient listeners.
function isStaleRouteModuleError(error: unknown): boolean {
  return isStaleRouteModuleMessage(errorText(error));
}

function recoverFromChunkLoadError(error: unknown, force = false): boolean {
  if (typeof window === "undefined") return false;
  return window.__maniaHubRecoverChunkLoad?.(error, force) ?? false;
}

function availableCountrySetFromContext(context: RootSlowContext): ReadonlySet<string> | null {
  if (!context.countryFeatures) return null;
  return new Set(context.countryFeatures.countries.map((entry) => entry.country.toUpperCase()));
}

function resolveClientInitialCountry(context: RootSlowContext): string {
  return resolveInitialCountry(readCountryCookieClient(), null, {
    available: availableCountrySetFromContext(context),
    cookieIsAuto: readAutoCountryCookieClient(),
  });
}

function getClientRootContext(): RootRouteContext | Promise<RootRouteContext> {
  const origin = window.location.origin;
  const slowContext = consumeDehydratedRootSlowContext() ?? readClientRootSlowContext();

  if (isPromiseLike(slowContext)) {
    return slowContext.then((context) => ({
      initialCountry: resolveClientInitialCountry(context),
      origin,
      ...context,
    }));
  }

  return { initialCountry: resolveClientInitialCountry(slowContext), origin, ...slowContext };
}

async function getServerRootContext(): Promise<RootRouteContext> {
  const [initialCountry, origin, auth, bootstrap] = await Promise.all([
    getInitialCountry(),
    getRequestOrigin(),
    getCurrentAuth(),
    fetchLiveBackendBootstrap(),
  ]);
  return {
    initialCountry,
    origin,
    auth,
    backendStatus: bootstrap.status,
    countryFeatures: bootstrap.countryFeatures,
  };
}

export const Route = createRootRoute({
  beforeLoad: () => typeof document !== "undefined" ? getClientRootContext() : getServerRootContext(),
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: SITE_NAME },
      { name: "description", content: DEFAULT_DESCRIPTION },
      { name: "robots", content: "index, follow" },
      { name: "theme-color", content: "#1a1517" },
    ],
    links: [
      { rel: "icon", type: "image/png", sizes: "256x256", href: SITE_FAVICON_HREF },
      { rel: "manifest", href: "/manifest.json" },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Baloo+2:wght@800&family=Comic+Neue:ital,wght@1,700&family=Fredoka:wght@700&family=Knewave&family=Lato:wght@600;700&family=Noto+Sans:ital,wght@0,600;1,800&family=Nunito:wght@800&family=Open+Sans:ital,wght@1,800&family=PT+Sans:wght@400&family=Roboto+Condensed:wght@300&family=Roboto:wght@300;700&family=Source+Sans+3:wght@400&display=swap",
      },
      { rel: "stylesheet", href: appCss },
      {
        rel: "preload",
        href: "/fonts/Torus-Regular.otf",
        as: "font",
        type: "font/otf",
        crossOrigin: "anonymous",
      },
      {
        rel: "preload",
        href: "/fonts/Torus-Heavy.otf",
        as: "font",
        type: "font/otf",
        crossOrigin: "anonymous",
      },
    ],
  }),
  component: RootLayout,
  shellComponent: RootDocument,
  notFoundComponent: NotFoundPage,
  errorComponent: RootErrorComponent,
});

function RootErrorComponent({ error }: { error: Error }) {
  const chunkLoadError = isChunkLoadError(error);
  const staleRouteError = !chunkLoadError && isStaleRouteModuleError(error);
  const staleBuildError = chunkLoadError || staleRouteError;

  useEffect(() => {
    const autoReloading = import.meta.env.PROD && staleBuildError && recoverFromChunkLoadError(error, true);
    // stale build + auto_reloading:false means the reload loop guard tripped,
    // i.e. a refresh did not clear it and the user is stuck on this screen.
    track("route_error", {
      message: (errorText(error) || "unknown").slice(0, 500),
      stack: error instanceof Error && error.stack ? error.stack.slice(0, 1500) : null,
      chunk_load: chunkLoadError,
      stale_route: staleRouteError,
      auto_reloading: autoReloading,
    });
  }, [chunkLoadError, staleBuildError, staleRouteError, error]);

  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-4 px-6 py-24 text-center">
      <div className="text-5xl font-bold text-white">Something broke</div>
      <div className="max-w-md text-sm text-osu-f1">
        {staleBuildError
          ? "A freshly deployed asset could not be loaded. The app will try one clean refresh; if it comes back here, the preview deploy is missing a built asset."
          : "The page hit an unexpected error and couldn't finish rendering. Reloading usually clears it. If it keeps happening, try disabling browser extensions."}
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => {
            if (!staleBuildError || !recoverFromChunkLoadError(error, true)) {
              window.location.reload();
            }
          }}
          className="rounded-md bg-osu-pink/20 px-4 py-2 text-xs font-semibold text-white hover:bg-osu-pink/30 transition-colors"
        >
          Reload page
        </button>
        <Link
          to="/"
          search={{ country: undefined }}
          className="rounded-md px-4 py-2 text-xs font-semibold text-osu-f1 hover:text-white transition-colors"
        >
          Go home
        </Link>
      </div>
      {import.meta.env.DEV && error?.message ? (
        <pre className="mt-2 max-w-full overflow-x-auto rounded-md bg-black/30 px-3 py-2 text-left text-[10px] text-osu-pink-light/60">
          {error.message}
        </pre>
      ) : null}
    </div>
  );
}

function NotFoundPage() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-4 px-6 py-24 text-center">
      <div className="text-5xl font-bold text-white">404</div>
      <div className="text-sm text-osu-f1">This page doesn't exist.</div>
      <Link
        to="/"
        search={{ country: undefined }}
        className="rounded-md bg-osu-pink/20 px-4 py-2 text-xs font-semibold text-white hover:bg-osu-pink/30 transition-colors"
      >
        Go home
      </Link>
    </div>
  );
}

const KOFI_PAGE_URL = "https://ko-fi.com/aleju03";

function KofiSupportButton() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const previousBodyOverflow = document.body.style.overflow;
    const previousHtmlOverscroll = document.documentElement.style.overscrollBehavior;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overscrollBehavior = "none";
    return () => {
      document.body.style.overflow = previousBodyOverflow;
      document.documentElement.style.overscrollBehavior = previousHtmlOverscroll;
    };
  }, [open]);
  const modal = open && typeof document !== "undefined"
    ? createPortal(
        <div
          className="fixed inset-0 z-[140] flex items-center justify-center p-4 pointer-events-none"
          onTouchMoveCapture={(event) => {
            if (event.target instanceof HTMLIFrameElement) return;
            event.preventDefault();
          }}
        >
          <div
            className="absolute inset-0 bg-black/65 pointer-events-auto touch-none"
            onClick={() => setOpen(false)}
          />
          <div
            role="dialog"
            aria-modal="true"
            className="relative z-10 w-[min(400px,calc(100vw-2rem))] max-h-[calc(100vh-2rem)] overflow-hidden rounded-xl border border-osu-b2/70 bg-osu-b4 shadow-2xl pointer-events-auto"
          >
            <div className="flex items-center justify-between gap-3 border-b border-osu-b3/50 px-4 py-3">
              <div className="text-left">
                <div className="text-sm font-bold text-white">Support mania-tracker</div>
                <div className="text-[11px] text-osu-f1">
                  This site is a hobby project running on a single server. If it&apos;s been useful to you, you can help keep it up here.
                </div>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="cursor-pointer rounded-md p-1 text-osu-f1 transition-colors hover:bg-osu-b3/60 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <iframe
              src={`${KOFI_PAGE_URL}/?hidefeed=true&widget=true&embed=true`}
              title="Support aleju03 on Ko-fi"
              loading="eager"
              scrolling="yes"
              allow="payment *"
              className="block h-[540px] max-h-[calc(100vh-9rem)] w-full overscroll-contain border-0 bg-[#f9f9f9] [touch-action:auto]"
            />
          </div>
        </div>,
        document.body,
      )
    : null;
  return (
    <>
      <a
        href={KOFI_PAGE_URL}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          setOpen(true);
        }}
        className="inline-flex items-center gap-1 rounded-full border border-osu-pink/25 bg-osu-pink/10 px-2 py-0.5 text-[10px] font-semibold text-osu-pink-light/80 hover:bg-osu-pink/20 hover:text-osu-pink-light transition-colors"
      >
        <Coffee className="h-3 w-3" />
        support
      </a>
      {modal}
    </>
  );
}

function ChangelogFooterLink() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => {
          track("changelog_open");
          setOpen(true);
        }}
        className="inline-flex cursor-pointer items-center gap-1 transition-colors hover:text-osu-pink-light/60"
      >
        changelog
      </button>
      <ChangelogModal open={open} onClose={() => setOpen(false)} />
    </>
  );
}

function RootLayout() {
  const { auth, initialCountry, backendStatus, countryFeatures } = Route.useRouteContext();
  seedClientRootSlowContext({ auth, backendStatus, countryFeatures });
  seedCountryTierCache(countryFeatures?.countries);
  return (
    <InitialCountryContext.Provider value={initialCountry}>
      <AuthContext.Provider value={auth}>
        <AnalyticsProvider>
          <ThemeRecovery />
          <WindowActivityAttribute />
          <CustomCursor />
          {backendStatus === "offline" ? (
            <main className="flex-1 flex">
              <BackendOfflineScreen />
            </main>
          ) : (
            <>
              <Nav />
              <RouteLoadingBar />
              <main className="relative flex-1 pt-[60px]">
                <SkinsBackdrop />
                <Outlet />
              </main>
              <GoalToasts />
              <TrackingToasts />
              <GhostLayer />
            </>
          )}
          <footer className="flex flex-wrap items-center justify-center gap-x-1.5 gap-y-1 px-4 py-2 text-center text-[10px] text-osu-pink-light/30">
            <KofiSupportButton />
            <span>·</span>
            <Link to="/privacy" className="hover:text-osu-pink-light/60 transition-colors">
              privacy
            </Link>
            <span>·</span>
            <Link to="/terms" className="hover:text-osu-pink-light/60 transition-colors">
              terms
            </Link>
            <span>·</span>
            <ChangelogFooterLink />
            <span>·</span>
            <span>
              made by{" "}
              <a
                href="https://osu.ppy.sh/users/7095193"
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-osu-pink-light/60 transition-colors"
              >
                aleju03
              </a>
            </span>
          </footer>
        </AnalyticsProvider>
      </AuthContext.Provider>
    </InitialCountryContext.Provider>
  );
}

// /skins and /skins/:id are sibling file routes, so a rain canvas owned by
// either page is torn down when navigating between them. Keep one canvas in
// the root shell for the whole skins route family instead. Its parent follows
// the outlet's height, letting ManiaRain preserve and rescale the same notes
// when the browse and detail pages have different lengths.
function SkinsBackdrop() {
  const active = useRouterState({
    select: (state) => /^\/skins(?:\/|$)/.test(state.location.pathname),
  });

  if (!active) return null;

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden bg-osu-b5" aria-hidden="true">
      <OsuTriangleBackdrop />
      <ManiaRain />
    </div>
  );
}

// Mount effects run after hydration commits, including the client-render
// fallback React takes on a hydration mismatch, which resets <html>'s
// attributes and strips the theme vars the pre-hydration script set
// (see reapplyThemeToDom).
function ThemeRecovery() {
  useEffect(() => {
    reapplyThemeToDom();
  }, []);
  return null;
}

function WindowActivityAttribute() {
  useEffect(() => {
    const update = () => {
      document.documentElement.dataset.windowActive = isWindowActive() ? "true" : "false";
    };
    update();
    const unsubscribe = subscribeWindowActivity(update);
    return () => {
      unsubscribe();
      delete document.documentElement.dataset.windowActive;
    };
  }, []);

  return null;
}

function RootDocument({ children }: { children: React.ReactNode }) {
  const { origin, auth, backendStatus, countryFeatures } = Route.useRouteContext();
  const jsonLd = websiteJsonLd(origin);
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
        {jsonLd && (
          <script
            type="application/ld+json"
            dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
          />
        )}
        {/* Dehydrated slow context: the client's first beforeLoad consumes this
            instead of re-fetching, so hydration renders against exactly the
            data the server rendered with (see consumeDehydratedRootSlowContext). */}
        <script
          suppressHydrationWarning
          dangerouslySetInnerHTML={{
            __html: `window.__maniaHubRootSlowContext=${serializeRootSlowContext({ auth, backendStatus, countryFeatures })};`,
          }}
        />
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var h=null;var t=localStorage.getItem("mania-hub-theme-v1");if(t!=null){var tn=Number(t);if(isFinite(tn))h=tn;}if(h==null){var s=localStorage.getItem("mania-hub-cache-v5");if(s){var p=JSON.parse(s);var bh=p&&p.state&&p.state.themeHue;if(typeof bh==="number"&&isFinite(bh))h=bh;}}if(h!=null){var n=((Math.round(h)%360)+360)%360;document.documentElement.style.setProperty("--theme-hue",String(n));if(n!==333)document.documentElement.style.setProperty("--theme-hue-mix","1");}var sv=localStorage.getItem("mania-hub-theme-sat-v1");if(sv!=null){var sn=Number(sv);if(isFinite(sn))document.documentElement.style.setProperty("--theme-sat",String(Math.max(0,Math.min(100,Math.round(sn)))/100));}}catch(e){}})();`,
          }}
        />
        <script dangerouslySetInnerHTML={{ __html: CHUNK_LOAD_RECOVERY_SCRIPT }} />
      </head>
      <body className="min-h-screen flex flex-col font-sans antialiased">
        {children}
        <Scripts />
        {import.meta.env.PROD ? (
          <script
            dangerouslySetInnerHTML={{
              __html: `if('serviceWorker' in navigator){window.addEventListener('load',()=>navigator.serviceWorker.register('/sw.js'))}`,
            }}
          />
        ) : null}
      </body>
    </html>
  );
}
