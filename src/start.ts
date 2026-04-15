import { createStart, createMiddleware } from "@tanstack/react-start";
import { COUNTRY_COOKIE_NAME } from "./lib/country-cookie";

const CACHEABLE_DOCUMENT_PATHS = new Set<string>([
  "/",
  "/rankings",
  "/top-plays",
  "/maps",
]);

const DOCUMENT_CACHE_CONTROL =
  "public, s-maxage=60, stale-while-revalidate=300";

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
        return {
          response: new Response("Unknown server function", { status: 404 }),
        };
      }
      throw err;
    }

    const response = (result as { response?: Response } | undefined)?.response;
    if (!response || typeof response.headers?.set !== "function") {
      return result;
    }

    const url = new URL(request.url);
    if (!CACHEABLE_DOCUMENT_PATHS.has(url.pathname)) return result;

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("text/html")) return result;

    // The HTML body now embeds the country resolved from the request's
    // `mania-hub-country` cookie. If that cookie is present, the response
    // is per-user and must NOT enter the shared CDN cache. New visitors
    // (no cookie) still get the cached default-country HTML.
    const cookieHeader = request.headers.get("cookie") ?? "";
    const escaped = COUNTRY_COOKIE_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(?:^|;\\s*)${escaped}=`).test(cookieHeader)) {
      return result;
    }

    const existing = response.headers.get("cache-control") ?? "";
    if (existing && !/max-age=0|no-store|no-cache/i.test(existing)) {
      return result;
    }

    try {
      response.headers.set("Cache-Control", DOCUMENT_CACHE_CONTROL);
    } catch {
      // Some response objects have immutable headers — silently skip.
    }

    return result;
  },
);

export const startInstance = createStart(() => ({
  requestMiddleware: [documentCacheMiddleware],
}));
