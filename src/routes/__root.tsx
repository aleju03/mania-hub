import { HeadContent, Link, Outlet, Scripts, createRootRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getRequest, setCookie } from "@tanstack/react-start/server";
import { Nav } from "../components/layout/Nav";
import { RouteLoadingBar } from "../components/layout/RouteLoadingBar";
import { AuthContext } from "../lib/auth-context";
import { getCurrentAuth } from "../lib/auth";
import { InitialCountryContext } from "../lib/country-context";
import type { AuthState } from "../lib/auth-shared";
import {
  COUNTRY_AUTO_COOKIE_NAME,
  COUNTRY_COOKIE_MAX_AGE_SECONDS,
  COUNTRY_COOKIE_NAME,
  parseCountryCookieHeader,
  readCountryCookieClient,
  resolveDetectedCountry,
  resolveInitialCountry,
} from "../lib/country-cookie";
import { PostHogProvider } from "../lib/posthog-provider";
import { getCanonicalOrigin } from "../lib/origin";
import { DEFAULT_DESCRIPTION, SITE_NAME, websiteJsonLd } from "../lib/seo";
import { fetchLiveBackendBootstrap } from "../lib/live-backend";
import type { LiveBackendStatus, LiveCountryFeaturesSnapshot } from "../lib/live-backend";
import { BackendOfflineScreen } from "../components/BackendOfflineScreen";
import { seedCountryTierCache } from "../lib/use-country-warming";
import appCss from "../styles.css?url";

/* Origin is resolved through a configured canonical URL first, then through
   allowlisted request hosts. That keeps SEO URLs stable without trusting
   arbitrary Host / X-Forwarded-Host headers. */
const getRequestOrigin = createServerFn({ method: "GET" }).handler(() => {
  return getCanonicalOrigin(getRequest());
});

function getRequestCountry(): string | null {
  const headers = getRequest().headers;
  for (const headerName of [
    "x-vercel-ip-country",
    "cf-ipcountry",
    "cloudfront-viewer-country",
    "x-country-code",
    "x-geo-country",
  ]) {
    const country = resolveDetectedCountry(headers.get(headerName));
    if (country) return country;
  }
  return null;
}

const getInitialCountry = createServerFn({ method: "GET" }).handler(() => {
  const countryCookie = parseCountryCookieHeader(getRequest().headers.get("cookie"));
  if (countryCookie) return countryCookie;

  const detectedCountry = getRequestCountry();
  if (detectedCountry) {
    setCookie(COUNTRY_COOKIE_NAME, detectedCountry, {
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

  return resolveInitialCountry(countryCookie, detectedCountry);
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

function getClientRootContext(): RootRouteContext | Promise<RootRouteContext> {
  const initialCountry = resolveInitialCountry(readCountryCookieClient());
  const origin = window.location.origin;
  const slowContext = readClientRootSlowContext();

  if (isPromiseLike(slowContext)) {
    return slowContext.then((context) => ({ initialCountry, origin, ...context }));
  }

  return { initialCountry, origin, ...slowContext };
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
      { rel: "icon", type: "image/svg+xml", sizes: "any", href: "/favicon.svg" },
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
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-4 px-6 py-24 text-center">
      <div className="text-5xl font-bold text-white">Something broke</div>
      <div className="max-w-md text-sm text-osu-f1">
        The page hit an unexpected error and couldn't finish rendering. Reloading usually
        clears it. If it keeps happening, try disabling browser extensions.
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => window.location.reload()}
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

function RootLayout() {
  const { auth, initialCountry, backendStatus, countryFeatures } = Route.useRouteContext();
  seedClientRootSlowContext({ auth, backendStatus, countryFeatures });
  seedCountryTierCache(countryFeatures?.countries);
  return (
    <InitialCountryContext.Provider value={initialCountry}>
      <AuthContext.Provider value={auth}>
        <PostHogProvider>
          {backendStatus === "offline" ? (
            <main className="flex-1 flex">
              <BackendOfflineScreen />
            </main>
          ) : (
            <>
              <Nav />
              <RouteLoadingBar />
              <main className="flex-1 pt-[60px]">
                <Outlet />
              </main>
            </>
          )}
          <footer className="px-4 py-2 text-center text-[10px] text-osu-pink-light/30">
            <span title="Not affiliated with or endorsed by osu! or ppy Pty Ltd. All game data is fetched via the public osu! API.">
              not affiliated with ppy
            </span>
            {" · made by "}
            <a
              href="https://osu.ppy.sh/users/7095193"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-osu-pink-light/60 transition-colors"
            >
              aleju03
            </a>
          </footer>
        </PostHogProvider>
      </AuthContext.Provider>
    </InitialCountryContext.Provider>
  );
}

function RootDocument({ children }: { children: React.ReactNode }) {
  const { origin } = Route.useRouteContext();
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
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var h=null;var t=localStorage.getItem("mania-hub-theme-v1");if(t!=null){var tn=Number(t);if(isFinite(tn))h=tn;}if(h==null){var s=localStorage.getItem("mania-hub-cache-v5");if(s){var p=JSON.parse(s);var bh=p&&p.state&&p.state.themeHue;if(typeof bh==="number"&&isFinite(bh))h=bh;}}if(h!=null){var n=((Math.round(h)%360)+360)%360;document.documentElement.style.setProperty("--theme-hue",String(n));if(n!==333)document.documentElement.style.setProperty("--theme-hue-mix","1");}var sv=localStorage.getItem("mania-hub-theme-sat-v1");if(sv!=null){var sn=Number(sv);if(isFinite(sn))document.documentElement.style.setProperty("--theme-sat",String(Math.max(0,Math.min(100,Math.round(sn)))/100));}}catch(e){}})();`,
          }}
        />
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
