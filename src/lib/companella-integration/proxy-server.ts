/*
 * The public native API's proxy half.
 *
 * Its whole job is to be a narrow, boring hop: authenticate nothing, decide
 * nothing, and hand the backend an envelope it can trust the SHAPE of. The
 * rules that matter:
 *
 *  - Every internal header is BUILT here, never forwarded. An inbound
 *    x-companella-actor from the open internet must not be able to become an
 *    actor, so the outgoing header set is constructed from scratch.
 *  - The destination comes from a fixed route table, never from a path, host
 *    or header the caller supplied.
 *  - The client's DPoP credentials move into their own headers so the bridge
 *    token can occupy Authorization. Both must be valid at the backend; the
 *    bridge token alone authorizes nothing.
 *  - Redirects are never followed: a 30x with credentials attached is how a
 *    proxy leaks a token to somewhere else.
 */

import { liveBridgeToken } from "../live-backend-tokens";
import { COMPANELLA_NATIVE_ROUTES } from "./shared";

const REQUEST_TIMEOUT_MS = 30_000;
/** Hard ceiling so a proxy hop cannot be used to buffer something enormous. */
const MAX_PROXY_BODY_BYTES = 32 * 1024 * 1024;

export type NativeRouteId = keyof typeof COMPANELLA_NATIVE_ROUTES;

function backendBase(): string | null {
  return (process.env.LIVE_BACKEND_URL || process.env.VITE_LIVE_BACKEND_URL)?.trim().replace(/\/+$/, "") || null;
}

/** Country from the edge, and only when this deployment says it sits behind one. */
export function trustedEdgeCountry(request: Request, environment: NodeJS.ProcessEnv = process.env): string | null {
  if (!/^(1|true|yes|on)$/i.test(environment.TRUST_PROXY_HEADERS?.trim() ?? "")) return null;
  const raw = request.headers.get("cf-ipcountry")?.trim().toUpperCase() ?? "";
  // "XX" and "T1" are Cloudflare's own unknown/Tor markers, not countries.
  return /^[A-Z]{2}$/.test(raw) && raw !== "XX" && raw !== "T1" ? raw : null;
}

function resolveSubpath(route: NativeRouteId, params: Record<string, string>): string | null {
  const template = COMPANELLA_NATIVE_ROUTES[route];
  let resolved: string = template;
  for (const [key, value] of Object.entries(params)) {
    // Ids reach the path, so anything outside the id alphabet is refused
    // rather than escaped.
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(value)) return null;
    resolved = resolved.replace(`:${key}`, value);
  }
  return resolved.includes(":") ? null : resolved;
}

async function readBounded(request: Request): Promise<Buffer | null | "too_large"> {
  if (request.method === "GET" || request.method === "HEAD") return null;
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_PROXY_BODY_BYTES) return "too_large";
  const reader = request.body?.getReader();
  if (!reader) {
    const buffer = Buffer.from(await request.arrayBuffer());
    return buffer.length > MAX_PROXY_BODY_BYTES ? "too_large" : buffer;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.length;
    if (total > MAX_PROXY_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      return "too_large";
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function errorResponse(status: number, code: string, message: string, retryable = false): Response {
  return new Response(JSON.stringify({
    error: { code, message, retryable },
    request_id: "",
    submission_id: null,
  }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/** Response headers worth passing back to a native client. */
const PASS_THROUGH_HEADERS = ["www-authenticate", "dpop-nonce", "retry-after", "content-type"];

export async function forwardNativeRequest(
  request: Request,
  route: NativeRouteId,
  params: Record<string, string> = {},
): Promise<Response> {
  const base = backendBase();
  const token = liveBridgeToken();
  if (!base || !token) {
    return errorResponse(503, "integration_unavailable", "The integration backend is not configured.", true);
  }
  const subpath = resolveSubpath(route, params);
  if (!subpath) return errorResponse(400, "invalid_request", "Malformed request path.");

  const body = await readBounded(request);
  if (body === "too_large") {
    return errorResponse(413, "payload_too_large", "The uploaded file is too large.");
  }

  // Built from scratch. Nothing the caller sent becomes an internal header.
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    accept: "application/json",
  };
  const contentType = request.headers.get("content-type");
  if (contentType) headers["content-type"] = contentType;
  const clientAuthorization = request.headers.get("authorization");
  if (clientAuthorization) headers["x-companella-authorization"] = clientAuthorization;
  const proof = request.headers.get("dpop");
  if (proof) headers["x-companella-dpop"] = proof;
  const idempotency = request.headers.get("idempotency-key");
  if (idempotency) headers["idempotency-key"] = idempotency;
  const country = trustedEdgeCountry(request);
  if (country) headers["x-companella-country"] = country;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${base}/api/integrations/companella/native/${subpath}`, {
      method: request.method,
      headers,
      body: (body ?? undefined) as BodyInit | undefined,
      // A redirect would carry the bridge token somewhere we did not choose.
      redirect: "manual",
      signal: controller.signal,
    });
    if (response.status >= 300 && response.status < 400) {
      return errorResponse(502, "integration_unavailable", "The integration backend answered unexpectedly.", true);
    }
    const payload = await response.arrayBuffer();
    const out = new Headers();
    for (const name of PASS_THROUGH_HEADERS) {
      const value = response.headers.get(name);
      if (value) out.set(name, value);
    }
    // Private in every case: receipts, tokens and identity must not be cached
    // by a CDN, a shared proxy, or the browser.
    out.set("cache-control", "no-store");
    out.set("x-content-type-options", "nosniff");
    return new Response(payload, { status: response.status, headers: out });
  } catch {
    return errorResponse(504, "integration_unavailable", "The integration backend did not answer.", true);
  } finally {
    clearTimeout(timer);
  }
}
