// Server handlers for /api/catbox-upload, kept out of the route file so they
// can be tested with plain Request objects (no TanStack server context).
//
// The BBCode editor pastes/drops images here; the browser can't POST to
// catbox.moe directly because catbox serves no CORS headers. The GET side
// re-fetches a remote image through our origin so the crop/resize canvas
// stays untainted (catbox images aren't CORS-enabled either, so a
// cross-origin <img> would taint toBlob()).
//
// Hardening: both handlers require the signed osu! session (or the explicit
// loopback-only local-dev grant) and a same-origin hit, are rate limited per
// viewer, cap sizes before buffering, and verify image magic bytes instead of
// trusting Content-Type. The GET proxy pins every hop's connection to its
// validated DNS answer via safe-image-fetch, so it can't be steered at
// internal hosts (SSRF), even through redirects or DNS rebinding.

import { isLocalDevAccessGranted } from "./auth-local-dev";
import { readViewerFromRequest } from "./auth-server";
import { sniffImageMime } from "./image-sniff";
import { isSameOriginRequest } from "./origin";
import { createFixedWindowLimiter, readCappedBody } from "./upload-guards";
import {
  fetchValidatedImage,
  ProxyError,
  readCappedStream,
  type LookupFn,
  type PinnedTransport,
} from "./safe-image-fetch";

const CATBOX_API = "https://catbox.moe/user/api.php";
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // catbox allows 200MB; profile art stays small.
const MAX_PROXY_BYTES = 20 * 1024 * 1024;
const PROXY_FETCH_TIMEOUT_MS = 15_000;

// Cloudflare swaps 502 and 504 origin responses for its own "Bad gateway" page
// and discards our body along with them; every other status, 503 included,
// reaches the browser untouched (probed against the live edge 2026-08-03).
// Upstream failures therefore answer 503, so catbox's own explanation - it
// replies "Invalid uploader" or "Uploads paused until I can resolve storage
// issues" in plain text - still shows up in the editor rather than an
// unexplained gateway error the site looks responsible for.
const UPSTREAM_FAILURE_STATUS = 503;

/** Maps the two statuses the edge would swallow onto one it forwards. */
function edgeVisibleStatus(status: number): number {
  return status === 502 || status === 504 ? UPSTREAM_FAILURE_STATUS : status;
}

// catbox answers in plain text, but an error page or proxy in front of it can
// answer in anything, so quote one readable line at most: enough to carry the
// real reason, not enough to spill a whole HTML document into the UI.
function describeUpstream(text: string): string {
  const line = text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return line.length > 160 ? `${line.slice(0, 160)}…` : line;
}

function upstreamRefused(text: string, fallback: string): Response {
  const detail = describeUpstream(text);
  return Response.json(
    { error: detail ? `catbox.moe refused the upload: ${detail}` : fallback },
    { status: UPSTREAM_FAILURE_STATUS },
  );
}

// Per-instance fixed windows keyed by viewer id: enough to stop one account
// from hammering catbox or the proxy. Per-instance only — the edge/WAF rule
// for /api/catbox-upload (tracked in findings/README.md Phase 2) is what
// bounds the multi-instance total.
const RATE_WINDOW_MS = 60_000;
const UPLOAD_RATE_LIMIT_PER_WINDOW = 12;
const PROXY_RATE_LIMIT_PER_WINDOW = 30;

const ALLOWED_IMAGE_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/avif",
]);

const MIME_EXTENSION: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/avif": "avif",
};

function normalizeImageMime(value: string | null): string | null {
  const mime = value?.split(";")[0]?.trim().toLowerCase();
  return mime && ALLOWED_IMAGE_MIME.has(mime) ? mime : null;
}

/** Rate-limit key for an authorized request, or null when unauthenticated. */
async function authorizeViewer(request: Request): Promise<string | null> {
  const viewer = await readViewerFromRequest(request);
  if (viewer) return `user:${viewer.id}`;
  let hostname = "";
  try {
    hostname = new URL(request.url).hostname.toLowerCase();
  } catch {
    return null;
  }
  const localDev = isLocalDevAccessGranted({
    nodeEnv: process.env.NODE_ENV,
    localDevSwitch: process.env.ENABLE_LOCAL_DEV_ADMIN,
    hostname,
  });
  return localDev ? "local-dev" : null;
}

const rateLimiter = createFixedWindowLimiter(RATE_WINDOW_MS);

function isRateLimited(key: string, limit: number): boolean {
  return rateLimiter.isRateLimited(key, limit);
}

// Upload raw image bytes to catbox and return the hosted URL.
export async function handleCatboxUploadPost(request: Request): Promise<Response> {
  if (!isSameOriginRequest(request)) {
    return Response.json({ error: "Forbidden." }, { status: 403 });
  }
  const rateKey = await authorizeViewer(request);
  if (!rateKey) {
    return Response.json({ error: "Sign in to upload images." }, { status: 401 });
  }
  if (isRateLimited(`post:${rateKey}`, UPLOAD_RATE_LIMIT_PER_WINDOW)) {
    return Response.json({ error: "Too many uploads; try again in a minute." }, { status: 429 });
  }
  if (!normalizeImageMime(request.headers.get("content-type"))) {
    return Response.json({ error: "Unsupported image type." }, { status: 415 });
  }

  const buffer = await readCappedBody(request, MAX_UPLOAD_BYTES);
  if (!buffer) {
    return Response.json({ error: "Image is too large (max 10MB)." }, { status: 413 });
  }
  if (buffer.length === 0) {
    return Response.json({ error: "Image is empty." }, { status: 400 });
  }
  // The claimed Content-Type only gates the request; what actually goes to
  // catbox is named and typed from the sniffed bytes.
  const mime = sniffImageMime(buffer);
  if (!mime) {
    return Response.json({ error: "File does not look like a supported image." }, { status: 415 });
  }

  const ext = MIME_EXTENSION[mime] ?? "png";
  const form = new FormData();
  form.append("reqtype", "fileupload");
  const userhash = process.env.CATBOX_USERHASH?.trim();
  if (userhash) form.append("userhash", userhash);
  form.append("fileToUpload", new Blob([buffer as unknown as BlobPart], { type: mime }), `image.${ext}`);

  let text: string;
  try {
    const res = await fetch(CATBOX_API, { method: "POST", body: form });
    text = (await res.text()).trim();
    if (!res.ok) {
      return upstreamRefused(text, "catbox.moe refused the upload.");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "catbox upload failed.";
    return Response.json({ error: `Could not reach catbox.moe: ${message}` }, { status: UPSTREAM_FAILURE_STATUS });
  }

  // A 200 is no guarantee of a URL: catbox reports several refusals as plain
  // text with an OK status.
  if (!/^https?:\/\/(files\.)?catbox\.moe\/\S+$/i.test(text)) {
    return upstreamRefused(text, "catbox.moe returned no URL.");
  }
  return Response.json({ url: text });
}

export interface CatboxProxyTestSeams {
  lookupFn?: LookupFn;
  transport?: PinnedTransport;
}

// Re-serve a remote image from our origin so the editor canvas can read it.
export async function handleCatboxProxyGet(request: Request, seams: CatboxProxyTestSeams = {}): Promise<Response> {
  if (!isSameOriginRequest(request)) {
    return new Response("Forbidden", { status: 403 });
  }
  const rateKey = await authorizeViewer(request);
  if (!rateKey) {
    return new Response("Sign in to load remote images.", { status: 401 });
  }
  if (isRateLimited(`get:${rateKey}`, PROXY_RATE_LIMIT_PER_WINDOW)) {
    return new Response("Too many image loads; try again in a minute.", { status: 429 });
  }
  const target = new URL(request.url).searchParams.get("url");
  if (!target) {
    return new Response("Invalid image url", { status: 400 });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROXY_FETCH_TIMEOUT_MS);
  try {
    const upstream = await fetchValidatedImage(target, { signal: controller.signal, ...seams });
    if (upstream.status < 200 || upstream.status >= 300) {
      upstream.stream.destroy();
      return new Response("Image fetch failed", { status: UPSTREAM_FAILURE_STATUS });
    }
    if (!normalizeImageMime(upstream.contentType)) {
      upstream.stream.destroy();
      return new Response("Not an image", { status: 415 });
    }
    const buffer = await readCappedStream(upstream.stream, MAX_PROXY_BYTES, upstream.contentLength);
    if (!buffer) {
      return new Response("Image too large", { status: 413 });
    }
    // The bytes win over the upstream header: serve the sniffed type or nothing.
    const mime = sniffImageMime(buffer);
    if (!mime) {
      return new Response("Not an image", { status: 415 });
    }
    return new Response(buffer as unknown as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": mime,
        "Content-Length": String(buffer.length),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, max-age=300",
      },
    });
  } catch (error) {
    const status = error instanceof ProxyError ? edgeVisibleStatus(error.status) : UPSTREAM_FAILURE_STATUS;
    const message = error instanceof ProxyError ? error.message : "Image fetch failed";
    return new Response(message, { status });
  } finally {
    clearTimeout(timeout);
  }
}
