// Server-only analytics event capture. Used for operational signals
// (osu! API failures, upstream outages, link-unfurl shares) that the client
// tracker can't see. Fire-and-forget — tracking must never throw into
// production paths. Events dual-write to PostHog (cold archive) and the
// in-house analytics store on the live backend.
import { waitUntil } from "@vercel/functions";

const POSTHOG_CAPTURE_URL = "https://us.i.posthog.com/capture/";
const CAPTURE_TIMEOUT_MS = 5_000;

function fireAndForget(url: string, body: string, headers: Record<string, string>): void {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CAPTURE_TIMEOUT_MS);
    waitUntil(
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body,
        signal: controller.signal,
      }).catch(() => {}).finally(() => {
        clearTimeout(timeout);
      }),
    );
  } catch {
    // waitUntil may throw outside a request context; swallow.
  }
}

export function trackServerEvent(
  event: string,
  properties?: Record<string, unknown>,
): void {
  if (typeof window !== "undefined") return;

  const eventId = crypto.randomUUID();
  const payload = {
    api_key: process.env.VITE_POSTHOG_KEY,
    event,
    distinct_id: "server",
    timestamp: new Date().toISOString(),
    properties: {
      $lib: "mania-hub-server",
      ...properties,
      $insert_id: eventId,
    },
  };

  if (process.env.VITE_POSTHOG_KEY) {
    fireAndForget(POSTHOG_CAPTURE_URL, JSON.stringify(payload), {});
  }

  const base = (process.env.LIVE_BACKEND_URL ?? process.env.VITE_LIVE_BACKEND_URL)?.replace(/\/+$/, "");
  const token = process.env.LIVE_ADMIN_TOKEN;
  if (base && token) {
    fireAndForget(
      `${base}/api/analytics/capture`,
      JSON.stringify({ payload, geo_country: null, is_bot: false }),
      { authorization: `Bearer ${token}` },
    );
  }
}
