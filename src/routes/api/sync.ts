import { createFileRoute } from "@tanstack/react-router";
import { waitUntil } from "@vercel/functions";

const POSTHOG_CAPTURE_URL = "https://us.i.posthog.com/capture/";
const MAX_SYNC_BODY_BYTES = 64 * 1024;

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
  // waitUntil keeps the Vercel function alive until the upstream fetch
  // resolves so events aren't dropped when the runtime recycles the
  // instance; it's a no-op outside Vercel.
  waitUntil(
    fetch(POSTHOG_CAPTURE_URL, {
      method: "POST",
      headers,
      body,
    }).catch(() => {}),
  );

  return new Response(null, { status: 202 });
}

export const Route = createFileRoute("/api/sync")({
  server: {
    handlers: {
      POST: async ({ request }) => forwardCapture(request),
    },
  },
});
