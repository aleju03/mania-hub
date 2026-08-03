import { createFileRoute } from "@tanstack/react-router";
import { waitUntil } from "@vercel/functions";

import { readEdgeCountry } from "../../lib/country-cookie";

const MAX_SYNC_BODY_BYTES = 64 * 1024;
const LIVE_ANALYTICS_FORWARD_TIMEOUT_MS = 5_000;

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

   The secret is the admin token this route already needs to forward anything
   at all, so there is no new env var to set and nothing silently degrades. */
const CLIENT_KEY_LENGTH = 16;

function getClientAddress(request: Request): string | null {
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

/* Second write target: the in-house analytics store on the live backend.
   Wrapped (not raw-forwarded) so the backend gets the edge-derived GeoIP
   country and a bot verdict without trusting client-supplied properties. */
function forwardToLiveAnalytics(request: Request, body: ArrayBuffer): void {
  const base = getLiveBackendBase();
  const token = process.env.LIVE_ADMIN_TOKEN;
  if (!base || !token) return;
  const events = readCapturedEvents(body);
  if (events.length === 0) return;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LIVE_ANALYTICS_FORWARD_TIMEOUT_MS);
  waitUntil(
    (async () => {
      const clientKey = await buildClientKey(request, token);
      await fetch(`${base}/api/analytics/capture`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        // The store unwraps a `batch` payload into individual events itself, so
        // a browser batch stays one forward rather than one per event.
        body: JSON.stringify({
          payload: { batch: events },
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
