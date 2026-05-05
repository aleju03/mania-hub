import { createStart, createMiddleware } from "@tanstack/react-start";
import { hasAuthCookieHeader } from "./lib/auth-shared";
import { hasCountryCookieHeader } from "./lib/country-cookie";

interface DocumentCacheConfig {
  sMaxage: number;
  swr: number;
}

const DEFAULT_DOCUMENT_CACHE: DocumentCacheConfig = {
  sMaxage: 60,
  swr: 300,
};

// Per-path SSR HTML cache config. The CDN caches the rendered document so
// repeat navigations don't re-invoke the function. Server-function RPC
// responses inside each page have their own edgeCache() and are cached
// independently, so these TTLs only affect the HTML shell.
const DOCUMENT_CACHE_BY_PATH: Record<string, DocumentCacheConfig> = {
  "/": DEFAULT_DOCUMENT_CACHE,
  "/rankings": DEFAULT_DOCUMENT_CACHE,
  "/top-plays": DEFAULT_DOCUMENT_CACHE,
  "/maps": DEFAULT_DOCUMENT_CACHE,
  // Replay pages are an app shell; the real replay/beatmap data is loaded
  // via server functions. Long TTL since the shell rarely changes.
  "/replay": { sMaxage: 300, swr: 1800 },
};

function getDocumentCacheForPathname(pathname: string): DocumentCacheConfig | null {
  const exact = DOCUMENT_CACHE_BY_PATH[pathname];
  if (exact) return exact;
  if (pathname.startsWith("/player/")) return { sMaxage: 60, swr: 300 };
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

export const startInstance = createStart(() => ({
  requestMiddleware: [documentCacheMiddleware],
}));
