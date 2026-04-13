import { createStart, createMiddleware } from "@tanstack/react-start";

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
    const result = await next();

    const response = (result as { response?: Response } | undefined)?.response;
    if (!response || typeof response.headers?.set !== "function") {
      return result;
    }

    const url = new URL(request.url);
    if (!CACHEABLE_DOCUMENT_PATHS.has(url.pathname)) return result;

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("text/html")) return result;

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
