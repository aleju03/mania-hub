import { createFileRoute } from "@tanstack/react-router";
import { waitUntil } from "@vercel/functions";

import type { AuthViewer } from "../../lib/auth-shared";
import { readViewerFromRequest } from "../../lib/auth-server";
import { readEdgeCountry } from "../../lib/country-cookie";
import { liveBridgeToken } from "../../lib/live-backend-tokens";
import { isSameOriginRequest } from "../../lib/origin";
import { createFixedWindowLimiter } from "../../lib/upload-guards";

const MAX_SYNC_BODY_BYTES = 64 * 1024;
const LIVE_ANALYTICS_FORWARD_TIMEOUT_MS = 5_000;

/* This route forwards to a token-gated backend endpoint, so anything it
   accepts is written with the site's own authority. Two ceilings sit in front
   of it: the dedicated `sync` bucket in src/start.ts, and this one, which is
   local to the route so the limit survives the generic middleware being
   switched off or its path list drifting.

   Deliberately high, because this counts requests and the thing worth counting
   is events. A browser flushes at most one batch per 500 ms per tab, several
   tabs each run their own timer, and the key is a public address, so one
   university or one mobile carrier NAT is a single bucket for everyone behind
   it. A ceiling tuned to a single session would silently drop those visitors'
   events (a 429 to sendBeacon is not retried). Ten requests a second from one
   address is not a browser population, it is a script, and what bounds the
   damage below that line is the 20-event / 64 KiB cap on each accepted request
   plus the server-derived viewer identity. */
const SYNC_RATE_WINDOW_MS = 60_000;
const SYNC_RATE_PER_WINDOW = 600;
const syncLimiter = createFixedWindowLimiter(SYNC_RATE_WINDOW_MS);

// Link-unfurl crawlers and monitoring agents that execute JS still send
// obviously non-browser user agents; flag them so the in-house store can keep
// them out of visitor counts.
const BOT_USER_AGENT_PATTERN =
  /bot|crawler|spider|crawling|facebookexternalhit|whatsapp|telegram|discord|slurp|bingpreview|headless|lighthouse|gtmetrix|pingdom|uptime|statuscake|python-requests|python-urllib|curl\/|wget\/|go-http-client|okhttp|axios\//i;

function isLikelyBotUserAgent(userAgent: string | null): boolean {
  if (!userAgent) return true;
  return BOT_USER_AGENT_PATTERN.test(userAgent);
}

/* A client that keeps no storage between page loads mints a fresh visitor id
   every time, so one crawl of eight pages reads as eight visitors (seen on
   2026-08-01: identical 800x600-screen fingerprint, one pageview each). The
   browser can't fix that about itself, so the proxy - the only place that sees
   the address and the user agent - hands the store a key it can use to
   recognise the same client across those loads.

   Deliberately narrow: the address is hashed with the day and a secret, never
   forwarded or stored raw, and the salt rotates at UTC midnight so the key
   cannot follow anyone from one day to the next. The store keeps it in memory
   for a stitching window and writes it nowhere. That makes it strictly less
   durable than the permanent localStorage id it is backing up.

   The secret is the bridge token this route already needs to forward anything
   at all, so there is no new env var to set and nothing silently degrades. */
const CLIENT_KEY_LENGTH = 16;

// Cloudflare overwrites `cf-connecting-ip` on every proxied request; the
// x-forwarded-for chain is appended to, so its first element is whatever the
// caller typed. Only the former can key a rate window or stitch a visitor
// together, so the others are a fallback for a local run with no edge in front
// (where they are equally untrusted but nothing is at stake).
function getClientAddress(request: Request): string | null {
  const edgeIp = request.headers.get("cf-connecting-ip")?.trim();
  if (edgeIp) return edgeIp;
  const forwarded = request.headers.get("x-forwarded-for") ?? request.headers.get("x-vercel-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  return first || request.headers.get("x-real-ip") || null;
}

export async function buildClientKey(request: Request, secret: string): Promise<string | null> {
  const address = getClientAddress(request);
  const userAgent = request.headers.get("user-agent");
  if (!address || !userAgent) return null;
  try {
    const utcDay = new Date().toISOString().slice(0, 10);
    const data = new TextEncoder().encode(`${secret}|${utcDay}|${address}|${userAgent}`);
    const digest = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, CLIENT_KEY_LENGTH);
  } catch {
    // No Web Crypto in this runtime: the store falls back to the client's own
    // id, which is exactly today's behaviour.
    return null;
  }
}

// Mirrors getServerLiveBackendUrl without importing the client-side live
// backend module into this lean capture route.
function getLiveBackendBase(): string | null {
  const base = process.env.LIVE_BACKEND_URL ?? process.env.VITE_LIVE_BACKEND_URL;
  return base ? base.replace(/\/+$/, "") : null;
}

/* The client batches events over a short window and posts them as
   `{ events: [...] }`. A bare event object is the pre-batching shape and is
   still accepted, so tabs running an older bundle keep reporting across a
   deploy. */
const MAX_FORWARDED_EVENTS = 20;

function readCapturedEvents(body: ArrayBuffer): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return [];
  }
  if (parsed && typeof parsed === "object" && Array.isArray((parsed as { events?: unknown }).events)) {
    return (parsed as { events: unknown[] }).events.slice(0, MAX_FORWARDED_EVENTS);
  }
  return parsed ? [parsed] : [];
}

/* The acting identity is server business, not a browser super-property. The
   store copies `viewer_id` / `viewer_username` straight out of the bag and
   upserts them into `analytics_viewers`, a roster that deliberately outlives
   event pruning, so a client-supplied pair would let anyone invent a trail for
   any osu! account. Drop whatever arrived and re-derive from the signed session
   cookie, the same way geo_country and is_bot are derived here. */
export function applyServerViewer(events: unknown[], viewer: AuthViewer | null): unknown[] {
  return events.map((event) => {
    if (!event || typeof event !== "object" || Array.isArray(event)) return event;
    const record = { ...(event as Record<string, unknown>) };
    const rawProperties = record.properties;
    const properties: Record<string, unknown> =
      rawProperties && typeof rawProperties === "object" && !Array.isArray(rawProperties)
        ? { ...(rawProperties as Record<string, unknown>) }
        : {};
    delete properties.viewer_id;
    delete properties.viewer_username;
    if (viewer) {
      properties.viewer_id = viewer.id;
      properties.viewer_username = viewer.username;
    }
    record.properties = properties;
    return record;
  });
}

/* Second write target: the in-house analytics store on the live backend.
   Wrapped (not raw-forwarded) so the backend gets the edge-derived GeoIP
   country, a bot verdict and the signed-in viewer without trusting
   client-supplied properties. */
function forwardToLiveAnalytics(request: Request, body: ArrayBuffer): void {
  const base = getLiveBackendBase();
  const token = liveBridgeToken();
  if (!base || !token) return;
  const events = readCapturedEvents(body);
  if (events.length === 0) return;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LIVE_ANALYTICS_FORWARD_TIMEOUT_MS);
  waitUntil(
    (async () => {
      const [clientKey, viewer] = await Promise.all([
        buildClientKey(request, token),
        readViewerFromRequest(request),
      ]);
      await fetch(`${base}/api/analytics/capture`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        // The store unwraps a `batch` payload into individual events itself, so
        // a browser batch stays one forward rather than one per event.
        body: JSON.stringify({
          payload: { batch: applyServerViewer(events, viewer) },
          geo_country: readEdgeCountry(request.headers),
          is_bot: isLikelyBotUserAgent(request.headers.get("user-agent")),
          client_key: clientKey,
        }),
        signal: controller.signal,
      });
    })().catch(() => {}).finally(() => {
      clearTimeout(timeout);
    }),
  );
}

async function readRequestBodyWithLimit(request: Request, limitBytes: number): Promise<ArrayBuffer | null> {
  const contentLength = request.headers.get("content-length");
  if (contentLength) {
    const length = Number(contentLength);
    if (!Number.isFinite(length) || length < 0 || length > limitBytes) {
      return null;
    }
  }

  if (!request.body) return new ArrayBuffer(0);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;

    total += value.byteLength;
    if (total > limitBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
}

async function forwardCapture(request: Request): Promise<Response> {
  // The page's own beacon is same-origin; nothing else has business writing to
  // the analytics store. Same gate /api/auth/logout uses.
  if (!isSameOriginRequest(request)) {
    return new Response(null, { status: 403 });
  }

  const address = getClientAddress(request);
  if (address && syncLimiter.isRateLimited(address, SYNC_RATE_PER_WINDOW)) {
    return new Response(null, { status: 429, headers: { "retry-after": "60" } });
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return new Response("Unsupported Media Type", { status: 415 });
  }

  const body = await readRequestBodyWithLimit(request, MAX_SYNC_BODY_BYTES);
  if (!body) {
    return new Response("Payload Too Large", { status: 413 });
  }

  forwardToLiveAnalytics(request, body);

  return new Response(null, { status: 202 });
}

export const Route = createFileRoute("/api/sync")({
  server: {
    handlers: {
      POST: async ({ request }) => forwardCapture(request),
    },
  },
});
