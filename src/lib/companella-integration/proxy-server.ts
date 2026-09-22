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
 *  - The body is streamed, never buffered. The backend checks the proof the
 *    moment the request arrives, before it reads the body, so an upload that
 *    takes longer than a proof's lifetime still authenticates. A body is
 *    carried only on the routes that take one, up to that route's ceiling, and
 *    a request missing the credentials its route needs is refused here before
 *    a byte of it is read.
 *  - A backend failure that is not one of our error envelopes (an unhandled
 *    exception's message, say) never reaches the client: it is replaced with
 *    a generic one.
 */

import { liveBridgeToken } from "../live-backend-tokens";
import { COMPANELLA_NATIVE_ROUTES } from "./shared";

const MIB = 1024 * 1024;
/** Manifests and token requests are a few hundred bytes. */
const JSON_BODY_BYTES = 64 * 1024;
/**
 * Upload ceilings for the hop itself. The backend enforces its own configured
 * limits (25 MiB replays and 8 MiB charts by default) on the same stream; these
 * only stop something absurd from being carried at all.
 */
const REPLAY_BODY_BYTES = 32 * MIB;
const BEATMAP_BODY_BYTES = 32 * MIB;

const REQUEST_TIMEOUT_MS = 30_000;
/** The backend answers an upload only once it has the whole file, so a slow
    connection needs longer than a JSON call does. It must stay under Node's
    request timeout (5 minutes, counted from the first byte), which both this
    server and the backend apply to the inbound upload: Nitro's node-server
    entry offers no way to raise it here, and past it the socket is cut with
    a 408 instead of this hop's own 504. */
const UPLOAD_TIMEOUT_MS = 4 * 60_000;

export type NativeRouteId = keyof typeof COMPANELLA_NATIVE_ROUTES;

interface RouteRule {
  /** Largest body carried to the backend; 0 means none is forwarded. */
  maxBodyBytes: number;
  /** What a request carrying a body must present before any of it is read. */
  requires: "nothing" | "proof" | "token_and_proof";
  /** OAuth endpoints answer in the OAuth error shape, not the envelope. */
  oauth: boolean;
  timeoutMs: number;
}

const ROUTE_RULES: Record<NativeRouteId, RouteRule> = {
  capabilities: { maxBodyBytes: 0, requires: "nothing", oauth: false, timeoutMs: REQUEST_TIMEOUT_MS },
  token: { maxBodyBytes: JSON_BODY_BYTES, requires: "proof", oauth: true, timeoutMs: REQUEST_TIMEOUT_MS },
  revoke: { maxBodyBytes: JSON_BODY_BYTES, requires: "proof", oauth: true, timeoutMs: REQUEST_TIMEOUT_MS },
  me: { maxBodyBytes: 0, requires: "token_and_proof", oauth: false, timeoutMs: REQUEST_TIMEOUT_MS },
  submissions: { maxBodyBytes: JSON_BODY_BYTES, requires: "token_and_proof", oauth: false, timeoutMs: REQUEST_TIMEOUT_MS },
  submissionRead: { maxBodyBytes: 0, requires: "token_and_proof", oauth: false, timeoutMs: REQUEST_TIMEOUT_MS },
  submissionReplay: { maxBodyBytes: REPLAY_BODY_BYTES, requires: "token_and_proof", oauth: false, timeoutMs: UPLOAD_TIMEOUT_MS },
  submissionBeatmap: { maxBodyBytes: BEATMAP_BODY_BYTES, requires: "token_and_proof", oauth: false, timeoutMs: UPLOAD_TIMEOUT_MS },
  submissionComplete: { maxBodyBytes: 0, requires: "token_and_proof", oauth: false, timeoutMs: REQUEST_TIMEOUT_MS },
};

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

function errorResponse(
  status: number,
  code: string,
  message: string,
  options: { retryable?: boolean; oauth?: boolean; headers?: Record<string, string> } = {},
): Response {
  const body = options.oauth
    ? { error: code }
    : { error: { code, message, retryable: options.retryable ?? false }, request_id: "", submission_id: null };
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...(options.headers ?? {}),
    },
  });
}

/**
 * The credentials a route cannot work without, checked before its body is
 * touched. Only presence and shape: whether they are valid is the backend's
 * call, made on the same request before it reads the body.
 */
function missingCredentials(request: Request, rule: RouteRule): Response | null {
  if (rule.requires === "nothing") return null;
  const challenge = { "www-authenticate": "DPoP" };
  if (rule.requires === "token_and_proof" && !/^DPoP\s+\S+$/i.test(request.headers.get("authorization")?.trim() ?? "")) {
    return errorResponse(401, "invalid_token", "A DPoP access token is required.", { headers: challenge });
  }
  if (!request.headers.get("dpop")?.trim()) {
    return rule.oauth
      ? errorResponse(400, "invalid_dpop_proof", "", { oauth: true, headers: challenge })
      : errorResponse(401, "invalid_dpop_proof", "A DPoP proof is required.", { headers: challenge });
  }
  return null;
}

function tooLargeResponse(rule: RouteRule): Response {
  return rule.oauth
    ? errorResponse(413, "invalid_request", "", { oauth: true })
    : errorResponse(413, "payload_too_large", "The request body is too large.");
}

/** The request body as a stream that errors once it passes `limit` bytes. */
function boundedBody(request: Request, limit: number, onTooLarge: () => void): ReadableStream<Uint8Array> | null {
  if (limit <= 0 || !request.body || request.method === "GET" || request.method === "HEAD") return null;
  let total = 0;
  return request.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > limit) {
        onTooLarge();
        controller.error(new Error("payload_too_large"));
        return;
      }
      controller.enqueue(chunk);
    },
  }));
}

/** Whether a failure body is one of the backend's deliberate error envelopes. */
function isErrorEnvelope(payload: ArrayBuffer): boolean {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(payload)) as { error?: { code?: unknown } } | null;
    return Boolean(parsed && typeof parsed.error === "object" && parsed.error
      && typeof parsed.error.code === "string" && /^[a-z_]{1,64}$/.test(parsed.error.code));
  } catch {
    return false;
  }
}

/** Response headers worth passing back to a native client. */
const PASS_THROUGH_HEADERS = ["www-authenticate", "dpop-nonce", "retry-after", "content-type"];

export async function forwardNativeRequest(
  request: Request,
  route: NativeRouteId,
  params: Record<string, string> = {},
): Promise<Response> {
  const rule = ROUTE_RULES[route];
  const base = backendBase();
  const token = liveBridgeToken();
  if (!base || !token) {
    return errorResponse(503, "integration_unavailable", "The integration backend is not configured.", { retryable: true, oauth: rule.oauth });
  }
  const subpath = resolveSubpath(route, params);
  if (!subpath) return errorResponse(400, "invalid_request", "Malformed request path.");

  // Both refusals below read headers only; not a byte of the body has moved.
  const declared = Number(request.headers.get("content-length"));
  if (rule.maxBodyBytes > 0 && Number.isFinite(declared) && declared > rule.maxBodyBytes) {
    return tooLargeResponse(rule);
  }
  // Only where a body would be carried: a bodiless request costs nothing to
  // pass on, and the backend's own refusal carries a fresh DPoP nonce.
  if (rule.maxBodyBytes > 0) {
    const refused = missingCredentials(request, rule);
    if (refused) return refused;
  }
  let tooLarge = false;
  const body = boundedBody(request, rule.maxBodyBytes, () => {
    tooLarge = true;
  });

  // Built from scratch. Nothing the caller sent becomes an internal header.
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    accept: "application/json",
  };
  const contentType = request.headers.get("content-type");
  if (contentType && body) headers["content-type"] = contentType;
  const clientAuthorization = request.headers.get("authorization");
  if (clientAuthorization) headers["x-companella-authorization"] = clientAuthorization;
  const proof = request.headers.get("dpop");
  if (proof) headers["x-companella-dpop"] = proof;
  const idempotency = request.headers.get("idempotency-key");
  if (idempotency) headers["idempotency-key"] = idempotency;
  const country = trustedEdgeCountry(request);
  if (country) headers["x-companella-country"] = country;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), rule.timeoutMs);
  try {
    const init: RequestInit & { duplex?: "half" } = {
      method: request.method,
      headers,
      // A redirect would carry the bridge token somewhere we did not choose.
      redirect: "manual",
      signal: controller.signal,
    };
    if (body) {
      init.body = body;
      // Required by fetch for a streamed request body.
      init.duplex = "half";
    }
    const response = await fetch(`${base}/api/integrations/companella/native/${subpath}`, init);
    if (response.status >= 300 && response.status < 400) {
      return errorResponse(502, "integration_unavailable", "The integration backend answered unexpectedly.", { retryable: true, oauth: rule.oauth });
    }
    const payload = await response.arrayBuffer();
    const out = new Headers();
    for (const name of PASS_THROUGH_HEADERS) {
      const value = response.headers.get(name);
      if (value) out.set(name, value);
    }
    if (response.status >= 500 && (rule.oauth || !isErrorEnvelope(payload))) {
      const retryAfter = response.headers.get("retry-after");
      return errorResponse(response.status, rule.oauth ? "server_error" : "internal_error", "The server could not handle this request.", {
        retryable: true, oauth: rule.oauth, headers: retryAfter ? { "retry-after": retryAfter } : {},
      });
    }
    // Private in every case: receipts, tokens and identity must not be cached
    // by a CDN, a shared proxy, or the browser.
    out.set("cache-control", "no-store");
    out.set("x-content-type-options", "nosniff");
    return new Response(payload, { status: response.status, headers: out });
  } catch {
    if (tooLarge) return tooLargeResponse(rule);
    return errorResponse(504, "integration_unavailable", "The integration backend did not answer.", { retryable: true, oauth: rule.oauth });
  } finally {
    clearTimeout(timer);
  }
}
