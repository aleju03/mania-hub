import { createFileRoute } from "@tanstack/react-router";

import { getCachedSignatureImage, putSignatureImage, signatureImageDigest } from "../../../../lib/r2-cache";
import { isSignatureTokenShape, resolveSignatureToken } from "../../../../lib/signature-resolve";
import { parseSignatureVariant, SIGNATURE_RENDER_VERSION } from "../../../../lib/signature-shared";
import { normalizeSignatureStyleMap } from "../../../../lib/signature-style";
import { ogRenderGate, pngResponse, scheduleDetached } from "../../../../lib/og-render";
import { createFixedWindowLimiter } from "../../../../lib/upload-guards";
import { placeholderPng, renderSignature } from "../-renderers";

/* Dynamic renders: a signature image behind a URL the player pasted into an
   osu! profile once and will never edit.
 *
 * That stable URL is the whole problem. /api/og can cache for a month because
 * every card URL carries v=OG_IMAGE_VERSION, so a layout change mints new
 * URLs. Here the URL is fixed forever, so freshness has to come from
 * somewhere else:
 *
 *  - The R2 cache key carries the player's data VERSION, derived backend-side
 *    from stamps the ingest pipeline already writes. A stored object is
 *    therefore immutable for its key, and a render happens exactly once per
 *    real data change instead of on a timer.
 *  - The CDN cannot key on that version, so the ETag does. An expired-but-
 *    unchanged edge copy revalidates into a 304 with no body and no render,
 *    which is what keeps "auto-updating" from meaning "re-render on every
 *    profile view".
 *
 * So the cost ladder per view is: browser cache, then edge cache, then a 304,
 * then an R2 read, and only then satori. */

// Short enough that an update lands quickly, long enough that the edge absorbs
// a popular profile: at most one origin request per edge per 5 minutes per URL,
// no matter how many people load the page.
const SIGNATURE_CACHE_HEADER = "public, max-age=60, s-maxage=300, stale-while-revalidate=86400, stale-if-error=604800";
// A refusal is cached too, so a dead or guessed token cannot be used to poke
// the origin in a loop.
const SIGNATURE_REFUSAL_HEADER = "public, max-age=300";
/* A failed render is NOT an answer, so it is never stored and never cached.
   `no-store` rather than a short TTL: under a stable URL, a cached failure is
   an invisible image that stays invisible until it expires, which is worse
   than the extra request a retry costs. */
const SIGNATURE_PLACEHOLDER_HEADER = "no-store";

/* Backstop against version thrash for a player mid-session. The edge TTL is
   the primary control (one origin miss per 5 min per URL); this only bounds
   the pathological case where many edges miss at once on a fast-moving key.
   A stranger cannot drive this at all - they cannot move the version, so every
   request of theirs lands on a stored object.

   Sized for the one caller who legitimately can: a player dragging the opacity
   or blur slider on /dynamic-renders mints a new version per change. The page
   debounces, so this is headroom above that rather than the thing shaping it. */
const coldRenderLimiter = createFixedWindowLimiter(60_000);
const COLD_RENDERS_PER_MINUTE = 12;

const inFlightSignatureRenders = new Map<string, Promise<Buffer | null>>();

/* Nothing else in the app does conditional requests, so this is hand-rolled.
   The W/ strip is deliberate: Cloudflare downgrades strong ETags to weak when
   it transforms a response, and accepting both forms makes that harmless. */
export function etagMatches(header: string | null, etag: string): boolean {
  if (!header) return false;
  if (header.trim() === "*") return true;
  return header.split(",").some((raw) => raw.trim().replace(/^W\//, "") === etag);
}

export function signatureCacheKey(
  userId: number,
  type: string,
  design: number,
  version: string,
): string {
  // Keyed on userId rather than the token, so rotating a token does not orphan
  // every render that player already has stored.
  return `sig:${type}:${design}:${userId}:${version}:r${SIGNATURE_RENDER_VERSION}`;
}

function refuse(): Response {
  // Every refusal is byte-identical: an unknown token, a disabled signature and
  // an unpublished type must not be distinguishable from one another.
  return new Response(null, {
    status: 404,
    headers: { "Cache-Control": SIGNATURE_REFUSAL_HEADER },
  });
}

function placeholderResponse(): Response {
  return pngResponse(placeholderPng(), SIGNATURE_PLACEHOLDER_HEADER);
}

async function renderAndStore(cacheKey: string, render: () => Promise<Buffer>): Promise<Buffer | null> {
  const inFlight = inFlightSignatureRenders.get(cacheKey);
  if (inFlight) return inFlight;

  const attempt = ogRenderGate.run(render)
    .then((buffer) => {
      // Only successes are stored. An error image written under a version key
      // that will never change again would be served until the data moves.
      scheduleDetached(putSignatureImage(cacheKey, buffer));
      return buffer;
    })
    .catch(() => null)
    .finally(() => {
      inFlightSignatureRenders.delete(cacheKey);
    });
  inFlightSignatureRenders.set(cacheKey, attempt);
  return attempt;
}

export const Route = createFileRoute("/api/signature/$token/$variant")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const token = params.token;
        if (!isSignatureTokenShape(token)) return refuse();

        const variant = parseSignatureVariant(params.variant);
        if (!variant) return refuse();

        const resolved = await resolveSignatureToken(token);
        if (!resolved) return refuse();
        if (!resolved.enabledTypes.includes(variant.type)) return refuse();

        const version = resolved.versions?.[variant.type];
        if (!version) return refuse();

        const cacheKey = signatureCacheKey(resolved.userId, variant.type, variant.design, version);
        const etag = `"${signatureImageDigest(cacheKey)}"`;
        const headers = { ETag: etag, "Cache-Control": SIGNATURE_CACHE_HEADER };

        // Before R2, before any render: an unchanged version is a bodyless 304.
        if (etagMatches(request.headers.get("if-none-match"), etag)) {
          return new Response(null, { status: 304, headers });
        }

        const cached = await getCachedSignatureImage(cacheKey);
        if (cached) return pngResponse(cached, SIGNATURE_CACHE_HEADER, { ETag: etag });

        /* Cold render. Unlike /api/og this WAITS on the gate instead of
           degrading to a fallback image when it is busy. An OG card is a
           1200x630 composition rasterized for a crawler nobody is watching; a
           signature is a small card (order 100-300ms) with either a person
           looking at the preview or a profile page waiting on it. Handing
           those an empty image to save a few hundred milliseconds of queueing
           is a bad trade - and a cached empty image is a blank embed. */
        const limiterKey = `${resolved.userId}:${variant.type}:${variant.design}`;
        if (coldRenderLimiter.isRateLimited(limiterKey, COLD_RENDERS_PER_MINUTE)) {
          return placeholderResponse();
        }

        /* The style is already baked into `version` backend-side, so this only
           has to turn the stored blob into something a layout can draw from.
           Normalizing here rather than in each renderer means an id that fell
           out of the allowlist degrades to the default look instead of
           reaching satori. */
        const style = normalizeSignatureStyleMap(resolved.styles)[variant.type];

        const buffer = await renderAndStore(cacheKey, () => renderSignature({
          request,
          resolved,
          type: variant.type,
          design: variant.design,
          style,
        }));
        if (!buffer) return placeholderResponse();

        return pngResponse(buffer, SIGNATURE_CACHE_HEADER, { ETag: etag });
      },
    },
  },
});
