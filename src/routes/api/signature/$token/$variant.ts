import { createFileRoute } from "@tanstack/react-router";

import {
  getCachedSignatureImage,
  putSignatureImage,
  signatureImageDigest,
  SIGNATURE_IMAGE_CONTENT_TYPE,
} from "../../../../lib/r2-cache";
import { isSignatureTokenShape, resolveSignatureToken } from "../../../../lib/signature-resolve";
import {
  readSignatureRender,
  signatureRenderKey,
  signatureRenderRevision,
  storeSignatureRender,
} from "../../../../lib/signature-render-cache";
import { parseSignatureVariant, SIGNATURE_RENDER_VERSION } from "../../../../lib/signature-shared";
import { normalizeSignatureStyleMap } from "../../../../lib/signature-style";
import { encodeSignatureWebp, imageResponse, ogRenderGate, scheduleDetached } from "../../../../lib/og-render";
import { createFixedWindowLimiter } from "../../../../lib/upload-guards";
import { SignatureTiming } from "../../../../lib/signature-timing";
import { renderSignature } from "../-renderers";

/* Dynamic renders: a signature image behind a URL the player pasted into an
   osu! profile once and will never edit.
 *
 * That stable URL is the whole problem. /api/og can cache for a month because
 * every card URL carries v=OG_IMAGE_VERSION, so a layout change mints new
 * URLs. Here the URL is fixed forever, so freshness has to come from
 * somewhere else:
 *
 *  - The R2 cache key carries the player's data VERSION, derived backend-side
 *    from the projected inputs (or stamps for skills/goals). A stored object is
 *    therefore immutable for its key, and a render happens exactly once per
 *    real data change instead of on a timer.
 *  - The CDN cannot key on that version, so the ETag does. An expired-but-
 *    unchanged edge copy revalidates into a 304 with no body and no render,
 *    which is what keeps "auto-updating" from meaning "re-render on every
 *    profile view".
 *
 * So the cost ladder per view is: browser cache, then edge cache, then a 304,
 * then this process's own copy of the finished bytes, then an R2 read, and only
 * then satori. */

/* Five-minute freshness, then a day of background revalidation. A profile
   opened after a quiet gap can show the previous image immediately while the
   edge refreshes it. No s-maxage: its proxy-revalidate semantics disable SWR.
   Revokes/moderation still purge these stable URLs through signature.ts. */
export const SIGNATURE_CACHE_HEADER = "public, max-age=300, stale-while-revalidate=86400, stale-if-error=604800";
// A refusal is cached too, so a dead or guessed token cannot be used to poke
// the origin in a loop.
const SIGNATURE_REFUSAL_HEADER = "public, max-age=300";
/* A failed render is NOT an answer, so it is never stored and never cached.
   `no-store` rather than a short TTL: under a stable URL, a cached failure is
   an invisible image that stays invisible until it expires, which is worse
   than the extra request a retry costs. */
const SIGNATURE_ERROR_HEADER = "no-store";

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

function unavailable(timing: SignatureTiming): Response {
  // A real 5xx lets the CDN use stale-if-error; a transparent 200 cannot.
  return new Response(null, { status: 503, headers: {
    "Cache-Control": SIGNATURE_ERROR_HEADER,
    "Server-Timing": timing.header("error"),
  } });
}

function signatureResponse(buffer: Buffer, etag: string, timing: SignatureTiming, cache: string): Response {
  return imageResponse(buffer, SIGNATURE_IMAGE_CONTENT_TYPE, SIGNATURE_CACHE_HEADER, {
    ETag: etag, "Server-Timing": timing.header(cache),
  });
}

async function renderAndStore(cacheKey: string, render: () => Promise<Buffer>): Promise<Buffer | null> {
  const inFlight = inFlightSignatureRenders.get(cacheKey);
  if (inFlight) return inFlight;

  const attempt = render()
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
        const timing = new SignatureTiming();
        const revision = signatureRenderRevision();
        const token = params.token;
        if (!isSignatureTokenShape(token)) return refuse();

        const variant = parseSignatureVariant(params.variant);
        if (!variant) return refuse();

        /* Above the resolve, because the resolve is half of what an edge miss
           costs. A hit here answers with no backend call and no R2 read; what
           it gives up is that a mutation on another frontend instance takes up
           to the cache's TTL to be noticed, which is why that TTL is short. */
        const renderKey = signatureRenderKey(token, variant.type, variant.design);
        const memoized = readSignatureRender(renderKey);
        if (memoized) {
          if (etagMatches(request.headers.get("if-none-match"), memoized.etag)) {
            return new Response(null, {
              status: 304,
              headers: { ETag: memoized.etag, "Cache-Control": SIGNATURE_CACHE_HEADER, "Server-Timing": timing.header("memory-304") },
            });
          }
          return signatureResponse(memoized.buffer, memoized.etag, timing, "memory");
        }

        let resolved;
        try {
          resolved = await timing.measure("resolve", () => resolveSignatureToken(token));
        } catch {
          return unavailable(timing);
        }
        if (revision !== signatureRenderRevision()) return unavailable(timing);
        if (!resolved) return refuse();
        if (!resolved.enabledTypes.includes(variant.type)) return refuse();

        const version = resolved.versions?.[variant.type];
        if (!version) return refuse();

        const cacheKey = signatureCacheKey(resolved.userId, variant.type, variant.design, version);
        const etag = `"${signatureImageDigest(cacheKey)}"`;
        const headers = { ETag: etag, "Cache-Control": SIGNATURE_CACHE_HEADER };

        // Before R2, before any render: an unchanged version is a bodyless 304.
        if (etagMatches(request.headers.get("if-none-match"), etag)) {
          return new Response(null, { status: 304, headers: { ...headers, "Server-Timing": timing.header("version-304") } });
        }

        const retained = readSignatureRender(renderKey, etag);
        if (retained && retained.etag === etag) {
          storeSignatureRender(renderKey, retained.buffer, etag);
          return signatureResponse(retained.buffer, etag, timing, "validated-memory");
        }
        let cache = inFlightSignatureRenders.has(cacheKey) ? "coalesced" : "render";
        const buffer = await timing.measure("load", () => renderAndStore(cacheKey, async () => {
          const cached = await timing.measure("storage", () => getCachedSignatureImage(cacheKey));
          if (cached) {
            cache = "storage";
            return cached;
          }
          const limiterKey = `${resolved.userId}:${variant.type}:${variant.design}`;
          if (coldRenderLimiter.isRateLimited(limiterKey, COLD_RENDERS_PER_MINUTE)) {
            throw new Error("signature render rate limited");
          }
          const style = normalizeSignatureStyleMap(resolved.styles)[variant.type];
          const png = await timing.measure("render", () => renderSignature({
            request, resolved, type: variant.type, design: variant.design, style, timing,
          }));
          const queuedAt = performance.now();
          const encoded = await ogRenderGate.run(() => {
            timing.add("queue", performance.now() - queuedAt);
            return timing.measure("encode", () => encodeSignatureWebp(png));
          });
          scheduleDetached(putSignatureImage(cacheKey, encoded));
          return encoded;
        }));
        if (!buffer || revision !== signatureRenderRevision()) return unavailable(timing);

        storeSignatureRender(renderKey, buffer, etag);
        return signatureResponse(buffer, etag, timing, cache);
      },
    },
  },
});
