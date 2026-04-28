import { HeadContent, Link, Outlet, Scripts, createRootRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getCookie, getRequest, setCookie } from "@tanstack/react-start/server";
import { Nav } from "../components/layout/Nav";
import { DevRateLimitBadge } from "../components/layout/DevRateLimitBadge";
import { RouteLoadingBar } from "../components/layout/RouteLoadingBar";
import { InitialCountryContext } from "../lib/country-context";
import {
  COUNTRY_AUTO_COOKIE_NAME,
  COUNTRY_COOKIE_MAX_AGE_SECONDS,
  COUNTRY_COOKIE_NAME,
  parseCountryCookieValue,
  readCountryCookieClient,
  resolveDetectedCountry,
  resolveInitialCountry,
} from "../lib/country-cookie";
import { PostHogProvider } from "../lib/posthog-provider";
import { getCanonicalOrigin } from "../lib/origin";
import { DEFAULT_DESCRIPTION, SITE_NAME, websiteJsonLd } from "../lib/seo";
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
  const countryCookie = parseCountryCookieValue(getCookie(COUNTRY_COOKIE_NAME));
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

export const Route = createRootRoute({
  beforeLoad: async () => {
    const onClient = typeof document !== "undefined";
    const [initialCountry, origin] = await Promise.all([
      onClient
        ? Promise.resolve(resolveInitialCountry(readCountryCookieClient()))
        : getInitialCountry(),
      onClient
        ? Promise.resolve(window.location.origin)
        : getRequestOrigin(),
    ]);
    return { initialCountry, origin };
  },
  head: ({ match }) => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: SITE_NAME },
      { name: "description", content: DEFAULT_DESCRIPTION },
      { name: "robots", content: "index, follow" },
      { name: "theme-color", content: "#1a1517" },
    ],
    links: [
      { rel: "icon", type: "image/png", href: `/api/favicon?code=${match.context.initialCountry}&v=2` },
      { rel: "manifest", href: "/manifest.json" },
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
});

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
  const { initialCountry } = Route.useRouteContext();
  return (
    <InitialCountryContext.Provider value={initialCountry}>
      <PostHogProvider>
        <Nav />
        <RouteLoadingBar />
        <main className="flex-1 pt-[60px]">
          <Outlet />
        </main>
        <footer className="px-4 py-2 text-center text-[10px] text-osu-pink-light/30">
          <span title="Unofficial fanmade website for the osu! community. Not affiliated with or endorsed by osu! or ppy Pty Ltd. All game data is fetched via the public osu! API.">
            fanmade · unofficial · not affiliated with ppy
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
        {import.meta.env.VITE_DEV_MODE === "1" ? <DevRateLimitBadge /> : null}
      </PostHogProvider>
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
