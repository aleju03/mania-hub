import { createFileRoute } from "@tanstack/react-router";
import { waitUntil } from "@vercel/functions";

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

// Mirrors getServerLiveBackendUrl without importing the client-side live
// backend module into this lean capture route.
function getLiveBackendBase(): string | null {
  const base = process.env.LIVE_BACKEND_URL ?? process.env.VITE_LIVE_BACKEND_URL;
  return base ? base.replace(/\/+$/, "") : null;
}

/* Second write target: the in-house analytics store on the live backend.
   Wrapped (not raw-forwarded) so the backend gets the Vercel-derived GeoIP
   country and a bot verdict without trusting client-supplied properties. */
function forwardToLiveAnalytics(request: Request, body: ArrayBuffer): void {
  const base = getLiveBackendBase();
  const token = process.env.LIVE_ADMIN_TOKEN;
  if (!base || !token) return;
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LIVE_ANALYTICS_FORWARD_TIMEOUT_MS);
  waitUntil(
    fetch(`${base}/api/analytics/capture`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        payload,
        geo_country: request.headers.get("x-vercel-ip-country"),
        is_bot: isLikelyBotUserAgent(request.headers.get("user-agent")),
      }),
      signal: controller.signal,
    }).catch(() => {}).finally(() => {
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
