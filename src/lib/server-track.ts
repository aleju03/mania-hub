// Server-only analytics event capture. Used for operational signals
// (osu! API failures, upstream outages, link-unfurl shares) that the client
// tracker can't see. Fire-and-forget — tracking must never throw into
// production paths. Events go to the in-house analytics store on the live
// backend.
import { waitUntil } from "@vercel/functions";

import { liveBridgeToken } from "./live-backend-tokens";

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
    event,
    distinct_id: "server",
    timestamp: new Date().toISOString(),
    properties: {
      $lib: "mania-hub-server",
      ...properties,
      $insert_id: eventId,
    },
  };

  const base = (process.env.LIVE_BACKEND_URL ?? process.env.VITE_LIVE_BACKEND_URL)?.replace(/\/+$/, "");
  // Analytics capture is a bridge route, not an admin one: this is the site's
  // own server reporting an operational signal, never an admin action.
  const token = liveBridgeToken();
  if (base && token) {
    fireAndForget(
      `${base}/api/analytics/capture`,
      JSON.stringify({ payload, geo_country: null, is_bot: false }),
      { authorization: `Bearer ${token}` },
    );
  }
}
