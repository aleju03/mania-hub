import { createStart, createMiddleware } from "@tanstack/react-start";
import { hasAuthCookieHeader } from "./lib/auth-shared";
import { hasCountryCookieHeader } from "./lib/country-cookie";
import { trackServerEvent } from "./lib/server-track";

interface DocumentCacheConfig {
  sMaxage: number;
  swr: number;
}

const DEFAULT_DOCUMENT_CACHE: DocumentCacheConfig = {
  sMaxage: 60,
  swr: 300,
};

type AppRateBucket = "api" | "serverFn" | "costly";

const appRateWindows = new Map<string, { count: number; resetAt: number }>();
let appRateChecksSincePrune = 0;

function readPositiveInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function isRateLimitEnabled(): boolean {
  return process.env.APP_RATE_LIMIT_ENABLED !== "false";
}

function appRateLimitForBucket(bucket: AppRateBucket): number {
  switch (bucket) {
    case "api":
      return readPositiveInt("APP_PUBLIC_RATE_PER_MINUTE", 240);
    case "serverFn":
      return readPositiveInt("APP_SERVER_FN_RATE_PER_MINUTE", 120);
    case "costly":
      return readPositiveInt("APP_COSTLY_RATE_PER_MINUTE", 30);
  }
}

function appRateBucketForPath(pathname: string): AppRateBucket | null {
  if (pathname.includes("/_serverFn/")) return "serverFn";
  if (pathname === "/api/og") return "costly";
  if (pathname.startsWith("/api/")) return "api";
  return null;
}

function getClientIp(request: Request): string {
  const trustProxy = /^(1|true|yes|on)$/i.test(process.env.TRUST_PROXY_HEADERS ?? "");
  if (trustProxy) {
    const forwarded = request.headers.get("cf-connecting-ip")
      ?? request.headers.get("x-real-ip")
      ?? request.headers.get("x-forwarded-for")?.split(",")[0];
    if (forwarded?.trim()) return normalizeIp(forwarded);
  }
  return normalizeIp(request.headers.get("x-real-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0] ?? "unknown");
}

function normalizeIp(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("::ffff:") ? trimmed.slice(7) : trimmed || "unknown";
}

function checkAppRateLimit(request: Request, bucket: AppRateBucket): { allowed: true } | { allowed: false; retryAfterMs: number; limit: number } {
  const now = Date.now();
  const limit = appRateLimitForBucket(bucket);
  const key = `${bucket}:${getClientIp(request)}`;
  appRateChecksSincePrune += 1;
  if (appRateChecksSincePrune >= 128 || appRateWindows.size > 10_000) {
    appRateChecksSincePrune = 0;
    for (const [entryKey, entry] of appRateWindows) {
      if (entry.resetAt <= now) appRateWindows.delete(entryKey);
    }
  }
  const existing = appRateWindows.get(key);
  if (!existing || existing.resetAt <= now) {
    appRateWindows.set(key, { count: 1, resetAt: now + 60_000 });
    return { allowed: true };
  }
  if (existing.count >= limit) {
    return { allowed: false, retryAfterMs: Math.max(1, existing.resetAt - now), limit };
  }
  existing.count += 1;
  return { allowed: true };
}

const requestRateLimitMiddleware = createMiddleware().server(
  async ({ next, request }) => {
    if (!isRateLimitEnabled()) return next();
    const url = new URL(request.url);
    const bucket = appRateBucketForPath(url.pathname);
    if (!bucket) return next();
    const result = checkAppRateLimit(request, bucket);
    if (result.allowed) return next();
    return new Response(JSON.stringify({
      error: "rate_limited",
      bucket,
      limit: result.limit,
      retryAfterMs: result.retryAfterMs,
    }), {
      status: 429,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "retry-after": String(Math.max(1, Math.ceil(result.retryAfterMs / 1000))),
      },
    });
  },
);

// Per-path SSR HTML cache config. The CDN caches the rendered document so
// repeat navigations don't re-invoke the function. Server-function RPC
// responses inside each page have their own edgeCache() and are cached
// independently, so these TTLs only affect the HTML shell.
const DOCUMENT_CACHE_BY_PATH: Record<string, DocumentCacheConfig> = {
  "/": DEFAULT_DOCUMENT_CACHE,
  "/rankings": DEFAULT_DOCUMENT_CACHE,
  "/tracker": DEFAULT_DOCUMENT_CACHE,
  "/top-plays": DEFAULT_DOCUMENT_CACHE,
  "/snipes": DEFAULT_DOCUMENT_CACHE,
  "/maps": DEFAULT_DOCUMENT_CACHE,
  "/farm-helper": DEFAULT_DOCUMENT_CACHE,
  // Replay pages are an app shell; the real replay/beatmap data is loaded
  // via server functions. Long TTL since the shell rarely changes.
  "/replay": { sMaxage: 300, swr: 1800 },
  // App-shell pages whose data loads client-side; without an entry here they
  // shipped with no Cache-Control at all and every visit hit the function.
  "/skins": DEFAULT_DOCUMENT_CACHE,
  "/packs": DEFAULT_DOCUMENT_CACHE,
  "/bbcode": { sMaxage: 300, swr: 1800 },
  "/goals": { sMaxage: 300, swr: 1800 },
  "/valley": { sMaxage: 300, swr: 1800 },
  // Fixed copy that only changes on deploy.
  "/legal": { sMaxage: 3600, swr: 86400 },
  "/privacy": { sMaxage: 3600, swr: 86400 },
  "/terms": { sMaxage: 3600, swr: 86400 },
};

function getDocumentCacheForPathname(pathname: string): DocumentCacheConfig | null {
  const exact = DOCUMENT_CACHE_BY_PATH[pathname];
  if (exact) return exact;
  // The embedded player snapshot goes stale as new scores land, but the page
  // refreshes it from the live backend shortly after mount, so a longer
  // document TTL only affects the first paint.
  if (pathname.startsWith("/player/")) return { sMaxage: 300, swr: 1800 };
  if (pathname.startsWith("/skins/")) return DEFAULT_DOCUMENT_CACHE;
  if (pathname.startsWith("/farm-helper/map/")) return DEFAULT_DOCUMENT_CACHE;
  // A pull share page describes one card pull that already happened, so it
  // never changes. These are made to be pasted into chat, which means repeat
  // visitors arriving from the same link.
  if (pathname.startsWith("/pull/")) return { sMaxage: 3600, swr: 86400 };
  return null;
}

function formatCacheControl(cfg: DocumentCacheConfig): string {
  return `public, s-maxage=${cfg.sMaxage}, stale-while-revalidate=${cfg.swr}`;
}

const documentCacheMiddleware = createMiddleware().server(
  async ({ next, request }) => {
    let result;
    try {
      result = await next();
    } catch (err) {
      // @tanstack/start-server-core's handleServerAction reads
      // `action.method` without guarding against an unknown server-fn id.
      // Stale browser tabs from a previous dev build trigger this after
      // HMR. Surface it as a 404 instead of a 500 TypeError.
      if (
        err instanceof TypeError &&
        /reading 'method'/.test(err.message) &&
        new URL(request.url).pathname.includes("/_serverFn/")
      ) {
        return new Response("Unknown server function", { status: 404 });
      }
      throw err;
    }

    const response = (result as { response?: Response } | undefined)?.response;
    if (!response || typeof response.headers?.set !== "function") {
      return result;
    }

    const url = new URL(request.url);
    const cacheConfig = getDocumentCacheForPathname(url.pathname);
    if (!cacheConfig) return result;

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("text/html")) return result;

    const cookieHeader = request.headers.get("cookie");
    if (hasAuthCookieHeader(cookieHeader)) {
      try {
        response.headers.set("Cache-Control", "private, no-store");
        response.headers.set("Vary", "Cookie");
      } catch {
        // Some response objects have immutable headers — silently skip.
      }
      return result;
    }

    if (!hasCountryCookieHeader(cookieHeader)) {
      try {
        response.headers.set("Cache-Control", "private, no-store");
        response.headers.set("Vary", "Cookie");
      } catch {
        // Some response objects have immutable headers — silently skip.
      }
      return result;
    }

    const existing = response.headers.get("cache-control") ?? "";
    if (existing && !/max-age=0|no-store|no-cache/i.test(existing)) {
      return result;
    }

    try {
      response.headers.set("Cache-Control", formatCacheControl(cacheConfig));
      // Key the CDN cache per country. The HTML embeds country-specific
      // state (nav, initial context) resolved from the `mania-hub-country`
      // cookie, so responses differ per country. `Vary: Cookie` makes the
      // edge key by cookie value, producing one cached variant per country
      // (plus an anonymous "no cookie" bucket). Authenticated requests are
      // handled above as private/no-store so per-user dev access never gets
      // cached into a shared document.
      response.headers.set("Vary", "Cookie");
    } catch {
      // Some response objects have immutable headers — silently skip.
    }

    return result;
  },
);

// ---------------------------------------------------------------------------
// Link-preview share tracking. When someone pastes a mania-tracker link into
// Discord/Twitter/iMessage/etc., that platform's unfurl crawler fetches the
// page HTML to read the og: meta tags. Those requests carry distinctive
// User-Agents and, because crawlers send no cookies, are never CDN-cached
// (documentCacheMiddleware stamps cookieless HTML `private, no-store`), so
// they reach this function on every unfurl. Each crawl logs one `page_shared`
// event via trackServerEvent; the /admin/live-backend analytics tab renders
// the rollups.
//
// This is a share-intent signal, not reach: one unfurl in a 500-person server
// looks identical to one DM. Search-index bots (Googlebot, bingbot, Applebot)
// are intentionally excluded here since they crawl to index, not because a
// human shared a link. Ordered so the specific token wins; iMessage sends a
// combined `facebookexternalhit ... Twitterbot` UA and lands on facebook.
const LINK_PREVIEW_CRAWLERS: Array<[RegExp, string]> = [
  [/discordbot/i, "discord"],
  // Telegram ("TelegramBot (like TwitterBot)") and iMessage
  // ("facebookexternalhit/1.1 Facebot Twitterbot/1.0") both embed the
  // "Twitterbot" token, so they MUST be matched before /twitterbot/i or the
  // substring test below would misattribute their unfurls to twitter.
  [/telegrambot/i, "telegram"],
  [/facebookexternalhit|facebot/i, "facebook"],
  [/twitterbot/i, "twitter"],
  [/slackbot|slack-imgproxy/i, "slack"],
  [/redditbot/i, "reddit"],
  [/whatsapp/i, "whatsapp"],
  [/linkedinbot/i, "linkedin"],
  [/pinterest/i, "pinterest"],
  [/skypeuripreview/i, "skype"],
  [/vkshare/i, "vk"],
  [/mastodon/i, "mastodon"],
  [/bluesky|bsky|cardyb/i, "bluesky"],
  [/embedly/i, "embedly"],
  [/iframely/i, "iframely"],
];

function classifyLinkPreviewCrawler(userAgent: string | null | undefined): string | null {
  if (!userAgent) return null;
  for (const [pattern, name] of LINK_PREVIEW_CRAWLERS) {
    if (pattern.test(userAgent)) return name;
  }
  return null;
}

// Coarse surface bucket derived from the path alone, for the "by type"
// breakdown. Mirrors the real routes in src/routes/.
function shareSubjectType(pathname: string): string {
  if (pathname === "/") return "home";
  if (pathname.startsWith("/player/")) return "player";
  if (pathname === "/replay") return "replay";
  if (pathname === "/rankings") return "rankings";
  if (pathname === "/maps") return "maps";
  if (pathname === "/tracker") return "tracker";
  if (pathname === "/top-plays") return "top-plays";
  if (pathname === "/snipes") return "snipes";
  if (pathname === "/farm-helper") return "farm-helper";
  if (pathname === "/goals") return "goals";
  if (pathname === "/packs") return "packs";
  if (pathname.startsWith("/skins")) return "skins";
  if (pathname === "/bbcode") return "bbcode";
  return "other";
}

// The specific entity a shared card is about, when the identity is in the URL:
// the username for /player/<name>, the score id for /replay?scoreId=. Lets the
// monitor break out top shared players/replays instead of one collapsed row.
function shareSubject(pathname: string, url: URL): string | null {
  if (pathname.startsWith("/player/")) {
    const raw = pathname.slice("/player/".length).split("/")[0];
    if (!raw) return null;
    try {
      return decodeURIComponent(raw).slice(0, 60);
    } catch {
      return raw.slice(0, 60);
    }
  }
  if (pathname === "/replay") {
    const scoreId = url.searchParams.get("scoreId");
    return scoreId && /^\d{1,20}$/.test(scoreId) ? scoreId : null;
  }
  return null;
}

function isHtmlDocumentResponse(response: Response): boolean {
  if (response.status !== 200) return false;
  return (response.headers.get("content-type") ?? "").toLowerCase().includes("text/html");
}

const shareTrackingMiddleware = createMiddleware().server(
  async ({ next, request }) => {
    const result = await next();
    try {
      // Only GET: a crawler's pre-flight HEAD would otherwise double-count.
      const crawler =
        request.method === "GET" ? classifyLinkPreviewCrawler(request.headers.get("user-agent")) : null;
      if (crawler) {
        const response = (result as { response?: Response } | undefined)?.response;
        // Only the HTML page fetch counts: the og:image at /api/og is
        // image/png (filtered out here) and is CDN-cached anyway, so counting
        // it would double-count and undercount at the same time.
        if (response && typeof response.headers?.get === "function" && isHtmlDocumentResponse(response)) {
          const url = new URL(request.url);
          const pathname = url.pathname;
          if (!pathname.startsWith("/admin/")) {
            const properties: Record<string, unknown> = {
              crawler,
              pathname,
              subject_type: shareSubjectType(pathname),
            };
            const subject = shareSubject(pathname, url);
            if (subject) properties.subject = subject;
            trackServerEvent("page_shared", properties);
          }
        }
      }
    } catch {
      // Share tracking must never affect the response.
    }
    return result;
  },
);

export const startInstance = createStart(() => ({
  requestMiddleware: [requestRateLimitMiddleware, documentCacheMiddleware, shareTrackingMiddleware],
}));
