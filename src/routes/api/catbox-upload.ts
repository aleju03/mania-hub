import { createFileRoute } from "@tanstack/react-router";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { getCanonicalOrigin } from "#/lib/origin";

// Server-side proxy for catbox.moe uploads. The BBCode editor pastes/drops
// images here; the browser can't POST to catbox.moe directly because catbox
// serves no CORS headers. The GET side re-fetches a remote image through our
// origin so the crop/resize canvas stays untainted (catbox images aren't
// CORS-enabled either, so a cross-origin <img> would taint toBlob()).
//
// Hardening: both handlers are same-origin only (so other sites can't use it
// as an open proxy), sizes are capped before buffering, and the GET proxy
// resolves + validates every redirect hop against a private-range denylist so
// it can't be steered at internal hosts (SSRF).

const CATBOX_API = "https://catbox.moe/user/api.php";
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // catbox allows 200MB; profile art stays small.
const MAX_PROXY_BYTES = 20 * 1024 * 1024;
const PROXY_FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;

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

/** Only ever called from the editor in a browser, so require a same-origin hit. */
function isSameOriginRequest(request: Request): boolean {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite) return fetchSite === "same-origin" || fetchSite === "same-site";
  // Older browsers omit Sec-Fetch-*; fall back to Origin/Referer host match.
  let canonicalHost: string;
  try {
    canonicalHost = new URL(getCanonicalOrigin(request)).host;
  } catch {
    return false;
  }
  for (const header of ["origin", "referer"]) {
    const value = request.headers.get(header);
    if (!value) continue;
    try {
      return new URL(value).host === canonicalHost;
    } catch {
      return false;
    }
  }
  return false;
}

/** True for loopback / private / link-local / reserved IP literals. */
function isBlockedIp(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) {
    const o = ip.split(".").map(Number);
    if (o[0] === 0 || o[0] === 10 || o[0] === 127) return true;
    if (o[0] === 169 && o[1] === 254) return true; // link-local / cloud metadata
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;
    if (o[0] === 192 && o[1] === 168) return true;
    if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return true; // CGNAT
    if (o[0] >= 224) return true; // multicast + reserved
    return false;
  }
  if (version === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower === "::") return true;
    if (lower.startsWith("fe80")) return true; // link-local
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique-local
    const mapped = /(?:::ffff:)(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isBlockedIp(mapped[1]);
    return false;
  }
  return true; // not a literal IP we understand -> err on the safe side
}

/** Resolves a hostname to its IPs (catching decimal/octal/hex forms too) and
    blocks it if any address is internal. */
async function isHostAllowed(hostname: string): Promise<boolean> {
  const host = hostname.replace(/^\[/, "").replace(/\]$/, "");
  if (isIP(host)) return !isBlockedIp(host);
  try {
    const addresses = await lookup(host, { all: true });
    return addresses.length > 0 && addresses.every((entry) => !isBlockedIp(entry.address));
  } catch {
    return false;
  }
}

class ProxyError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** fetch that validates protocol + resolved host on the URL and every hop. */
async function fetchValidatedImage(rawUrl: string, signal: AbortSignal): Promise<Response> {
  let current = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    let url: URL;
    try {
      url = new URL(current);
    } catch {
      throw new ProxyError("Invalid image url", 400);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new ProxyError("Invalid image url", 400);
    }
    if (!(await isHostAllowed(url.hostname))) {
      throw new ProxyError("Blocked host", 400);
    }
    const response = await fetch(current, {
      redirect: "manual",
      signal,
      headers: { Accept: "image/*" },
    });
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      current = new URL(location, current).toString();
      continue;
    }
    return response;
  }
  throw new ProxyError("Too many redirects", 502);
}

/** Reads a response body into a Buffer, aborting if it exceeds `cap`. */
async function readCappedBody(response: Response, cap: number): Promise<Buffer | null> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > cap) return null;
  const reader = response.body?.getReader();
  if (!reader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    return buffer.length > cap ? null : buffer;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.length;
      if (total > cap) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks);
}

export const Route = createFileRoute("/api/catbox-upload")({
  server: {
    handlers: {
      // Upload raw image bytes to catbox and return the hosted URL.
      POST: async ({ request }) => {
        if (!isSameOriginRequest(request)) {
          return Response.json({ error: "Forbidden." }, { status: 403 });
        }
        const mime = normalizeImageMime(request.headers.get("content-type"));
        if (!mime) {
          return Response.json({ error: "Unsupported image type." }, { status: 415 });
        }
        const declared = Number(request.headers.get("content-length"));
        if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
          return Response.json({ error: "Image is too large (max 10MB)." }, { status: 413 });
        }

        const buffer = Buffer.from(await request.arrayBuffer());
        if (buffer.length === 0) {
          return Response.json({ error: "Image is empty." }, { status: 400 });
        }
        if (buffer.length > MAX_UPLOAD_BYTES) {
          return Response.json({ error: "Image is too large (max 10MB)." }, { status: 413 });
        }

        const ext = MIME_EXTENSION[mime] ?? "png";
        const form = new FormData();
        form.append("reqtype", "fileupload");
        const userhash = process.env.CATBOX_USERHASH?.trim();
        if (userhash) form.append("userhash", userhash);
        form.append("fileToUpload", new Blob([buffer], { type: mime }), `image.${ext}`);

        let text: string;
        try {
          const res = await fetch(CATBOX_API, { method: "POST", body: form });
          text = (await res.text()).trim();
          if (!res.ok) {
            return Response.json({ error: text || "catbox upload failed." }, { status: 502 });
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : "catbox upload failed.";
          return Response.json({ error: message }, { status: 502 });
        }

        if (!/^https?:\/\/(files\.)?catbox\.moe\/\S+$/i.test(text)) {
          return Response.json({ error: text || "catbox returned no URL." }, { status: 502 });
        }
        return Response.json({ url: text });
      },

      // Re-serve a remote image from our origin so the editor canvas can read it.
      GET: async ({ request }) => {
        if (!isSameOriginRequest(request)) {
          return new Response("Forbidden", { status: 403 });
        }
        const target = new URL(request.url).searchParams.get("url");
        if (!target) {
          return new Response("Invalid image url", { status: 400 });
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), PROXY_FETCH_TIMEOUT_MS);
        try {
          const upstream = await fetchValidatedImage(target, controller.signal);
          if (!upstream.ok) {
            return new Response("Image fetch failed", { status: 502 });
          }
          const mime = normalizeImageMime(upstream.headers.get("content-type"));
          if (!mime) {
            return new Response("Not an image", { status: 415 });
          }
          const buffer = await readCappedBody(upstream, MAX_PROXY_BYTES);
          if (!buffer) {
            return new Response("Image too large", { status: 413 });
          }
          return new Response(buffer as unknown as BodyInit, {
            status: 200,
            headers: {
              "Content-Type": mime,
              "Content-Length": String(buffer.length),
              "Cache-Control": "private, max-age=300",
            },
          });
        } catch (error) {
          const status = error instanceof ProxyError ? error.status : 502;
          const message = error instanceof ProxyError ? error.message : "Image fetch failed";
          return new Response(message, { status });
        } finally {
          clearTimeout(timeout);
        }
      },
    },
  },
});
