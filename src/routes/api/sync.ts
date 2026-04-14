import { createFileRoute } from "@tanstack/react-router";

const POSTHOG_CAPTURE_URL = "https://us.i.posthog.com/capture/";

async function forwardCapture(request: Request): Promise<Response> {
  const body = await request.arrayBuffer();

  const headers = new Headers();
  headers.set("content-type", "application/json");

  const clientIp =
    request.headers.get("x-forwarded-for")
    ?? request.headers.get("x-real-ip")
    ?? request.headers.get("cf-connecting-ip");
  if (clientIp) headers.set("x-forwarded-for", clientIp);

  const userAgent = request.headers.get("user-agent");
  if (userAgent) headers.set("user-agent", userAgent);

  // Fire-and-forget: forward to PostHog without blocking the response.
  // The client (browser sendBeacon) doesn't need the upstream body and
  // holding the connection open starves the browser's per-origin
  // concurrent connection budget, queueing other server function calls.
  fetch(POSTHOG_CAPTURE_URL, {
    method: "POST",
    headers,
    body,
  }).catch(() => {});

  return new Response(null, { status: 202 });
}

export const Route = createFileRoute("/api/sync")({
  server: {
    handlers: {
      POST: async ({ request }) => forwardCapture(request),
    },
  },
});
