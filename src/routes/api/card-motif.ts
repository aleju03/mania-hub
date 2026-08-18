import { createFileRoute } from "@tanstack/react-router";
import { CARD_MOTIF_URL_MAX_CHARS } from "#/lib/card-motif";
import { sniffImageMime } from "#/lib/image-sniff";
import { bridgeAuthHeaders } from "#/lib/live-backend-tokens";

/* The image a hand-granted maniacard floats in its background, served by us
   instead of by whoever hosts it.
 *
 * It exists for the same reason /api/avatar does: the card front is painted
 * into a 2D canvas and read back out (collection thumbnails, the reveal tray),
 * and a cross-origin image without CORS headers taints that canvas, turning
 * every toDataURL into a security error. A redirect would defeat the point, so
 * the bytes pass through here.
 *
 * What it is NOT is an open image proxy. `src` is checked against the set of
 * motif URLs the live backend actually has on a card, so the only images this
 * route will fetch are ones an admin already pinned to a holding from
 * /admin/collections. Without that check, anybody could stream arbitrary
 * remote bytes through our own domain and our own bandwidth.
 */

const ALLOWLIST_TTL_MS = 5 * 60 * 1000;
// A motif granted a second ago is not in the cached list yet, so a miss is
// allowed to refresh it - bounded, or an unknown src becomes a way to make the
// frontend hammer the backend.
const ALLOWLIST_MIN_REFRESH_MS = 15 * 1000;
const IMAGE_TTL_MS = 60 * 60 * 1000;
const IMAGE_CACHE_MAX_ENTRIES = 32;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 8_000;

/* Long, because the URL names one image and a card redraws on every visit.
   Not immutable: the bytes behind somebody's link can change, and a day is a
   fair ceiling on how long a card keeps drawing the old ones. */
const IMAGE_CACHE_HEADER = "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800";

type ImageEntry = { buffer: Buffer; contentType: string; expiresAt: number; lastAccessedAt: number };

const imageCache = new Map<string, ImageEntry>();

let allowedUrls: Set<string> | null = null;
let allowlistExpiresAt = 0;
let allowlistFetchedAt = 0;
let allowlistInFlight: Promise<Set<string> | null> | null = null;

function backendBase(): string | null {
  const raw = (process.env.LIVE_BACKEND_URL || process.env.VITE_LIVE_BACKEND_URL)?.trim();
  return raw ? raw.replace(/\/+$/, "") : null;
}

async function fetchAllowlist(): Promise<Set<string> | null> {
  const base = backendBase();
  if (!base) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(`${base}/api/packs/card-motifs`, {
      headers: bridgeAuthHeaders(),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { urls?: unknown };
    const urls = Array.isArray(body.urls) ? body.urls.filter((url): url is string => typeof url === "string") : [];
    return new Set(urls);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/* True when this URL is on a card. A stale-cache miss refreshes once and
   re-checks, so a motif granted moments ago starts drawing without waiting out
   the TTL; a URL that was never granted costs at most one refresh per
   ALLOWLIST_MIN_REFRESH_MS however often it is asked for. */
async function isAllowedMotifUrl(src: string): Promise<boolean> {
  const now = Date.now();
  if (allowedUrls && allowlistExpiresAt > now && allowedUrls.has(src)) return true;

  const stale = !allowedUrls || allowlistExpiresAt <= now;
  const mayRefresh = stale || now - allowlistFetchedAt >= ALLOWLIST_MIN_REFRESH_MS;
  if (!mayRefresh) return allowedUrls?.has(src) === true;

  if (!allowlistInFlight) {
    allowlistFetchedAt = now;
    allowlistInFlight = fetchAllowlist().finally(() => {
      allowlistInFlight = null;
    });
  }
  const fresh = await allowlistInFlight;
  // A backend that did not answer leaves the last known list in place rather
  // than blocking every card: the list only ever grows by an admin's hand.
  if (fresh) {
    allowedUrls = fresh;
    allowlistExpiresAt = Date.now() + ALLOWLIST_TTL_MS;
  }
  return allowedUrls?.has(src) === true;
}

function pruneImageCache(now = Date.now()) {
  for (const [key, entry] of imageCache.entries()) {
    if (entry.expiresAt <= now) imageCache.delete(key);
  }
  if (imageCache.size <= IMAGE_CACHE_MAX_ENTRIES) return;
  const excess = [...imageCache.entries()]
    .sort(([, a], [, b]) => a.lastAccessedAt - b.lastAccessedAt)
    .slice(0, imageCache.size - IMAGE_CACHE_MAX_ENTRIES);
  for (const [key] of excess) imageCache.delete(key);
}

async function fetchMotif(src: string): Promise<ImageEntry | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(src, {
      redirect: "follow",
      headers: { "User-Agent": "mania-hub-card-motif", accept: "image/*" },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) return null;
    /* Labelled from its own bytes, never from the upstream header. That also
       settles SVG: it has no magic number to sniff, so it cannot pass here,
       which is the point - an SVG served back from our own origin can carry
       script. */
    const contentType = sniffImageMime(buffer);
    if (!contentType) return null;
    const now = Date.now();
    return { buffer, contentType, expiresAt: now + IMAGE_TTL_MS, lastAccessedAt: now };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function getMotif(src: string): Promise<ImageEntry | null> {
  pruneImageCache();
  const cached = imageCache.get(src);
  if (cached && cached.expiresAt > Date.now()) {
    cached.lastAccessedAt = Date.now();
    return cached;
  }
  const fresh = await fetchMotif(src);
  if (fresh) imageCache.set(src, fresh);
  return fresh;
}

/* One answer for every refusal, cached briefly so a card whose motif was
   removed does not re-ask on every render. */
function notFound(): Response {
  return new Response("Not found", {
    status: 404,
    headers: { "Cache-Control": "public, max-age=60" },
  });
}

export const Route = createFileRoute("/api/card-motif")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const src = new URL(request.url).searchParams.get("src") ?? "";
        if (!src || src.length > CARD_MOTIF_URL_MAX_CHARS) return notFound();
        let parsed: URL;
        try {
          parsed = new URL(src);
        } catch {
          return notFound();
        }
        if (parsed.protocol !== "https:") return notFound();
        if (!(await isAllowedMotifUrl(src))) return notFound();

        const entry = await getMotif(src);
        if (!entry) return notFound();
        return new Response(entry.buffer as unknown as BodyInit, {
          status: 200,
          headers: {
            "Content-Type": entry.contentType,
            "Content-Length": String(entry.buffer.length),
            "Cache-Control": IMAGE_CACHE_HEADER,
            "Access-Control-Allow-Origin": "*",
            // Belt and braces for a format sniffing ever gets wrong: the bytes
            // are only ever an image, so never let a browser decide otherwise.
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; sandbox",
          },
        });
      },
    },
  },
});
