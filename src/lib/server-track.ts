// Server-only PostHog event capture. Used for operational signals
// (osu! API failures, upstream outages) that the client tracker can't see.
// Fire-and-forget — tracking must never throw into production paths.
import { waitUntil } from "@vercel/functions";

const POSTHOG_CAPTURE_URL = "https://us.i.posthog.com/capture/";
const POSTHOG_CAPTURE_TIMEOUT_MS = 5_000;

export function trackServerEvent(
  event: string,
  properties?: Record<string, unknown>,
): void {
  if (typeof window !== "undefined") return;
  const apiKey = process.env.VITE_POSTHOG_KEY;
  if (!apiKey) return;

  const payload = {
    api_key: apiKey,
    event,
    distinct_id: "server",
    timestamp: new Date().toISOString(),
    properties: {
      $lib: "mania-hub-server",
      ...properties,
    },
  };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), POSTHOG_CAPTURE_TIMEOUT_MS);
    waitUntil(
      fetch(POSTHOG_CAPTURE_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      }).catch(() => {}).finally(() => {
        clearTimeout(timeout);
      }),
    );
  } catch {
    // waitUntil may throw outside a request context; swallow.
  }
}
