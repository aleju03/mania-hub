import type { IncomingMessage, ServerResponse } from "node:http";
import { performance } from "node:perf_hooks";
import { brotliCompress, constants as zlibConstants, gzip } from "node:zlib";
import { enrichPayloadAvatarAccents } from "../features/avatar-accents.js";
import { logWarn } from "../logger.js";
import type { AbuseBucket, RateLimitResult } from "./abuse-guard.js";
import { COMPRESSIBLE_MIN_BYTES, type PreparedJsonResponse } from "./prepared-json.js";
import { REQUEST_FARM_HELPER_TIMINGS, REQUEST_STARTED_AT, type HttpContext, type TimedRequest } from "./context.js";
import { isAdmin, isBridge } from "./request.js";

// sendJson for the surfaces that render player names: attaches avatar accents next to every
// avatar URL in the payload (and queues extraction for unseen avatars). Additive only; an
// enrichment failure still sends the plain payload.
export async function sendAccentEnrichedJson(req: IncomingMessage, res: ServerResponse, ctx: HttpContext, status: number, body: unknown): Promise<void> {
  await enrichPayloadAvatarAccents(ctx.db, ctx.queue ?? null, body);
  sendJson(req, res, ctx, status, body);
}

// `suffix` splits a bucket's limit into an independent per-IP window without
// inventing a new bucket (and a new env var) for it. Used where two groups of
// endpoints deserve the same ceiling but must not spend each other's budget.
export function checkRate(req: IncomingMessage, res: ServerResponse, ctx: HttpContext, bucket: AbuseBucket, suffix = ""): boolean {
  if (!ctx.abuse || isAdmin(req, ctx)) return true;
  /* Bridge requests are not exempt, they are re-bucketed. Exempting them was
     how an unauthenticated public route on the frontend (which forwards with
     the token) became an unmetered firehose at the DB. But they cannot be
     charged the public per-IP buckets either: they all arrive from the frontend
     server, so one address carries every signed-in visitor's traffic and a
     120/min ceiling would throttle the whole site at once. Its own generous
     bucket keeps a leaked bridge token bounded without capping real users. */
  if (isBridge(req, ctx)) {
    bucket = "bridge";
    suffix = "";
  }
  const result = ctx.abuse.check(req, ctx.config, bucket, suffix);
  if (result.allowed) return true;
  sendRateLimited(req, res, ctx, result);
  return false;
}

// Rejections used to be silent, which is why the 2026-08-03 pack-probe fan-out
// had to be reconstructed from queue rows: nothing recorded whether those hand
// probes were 429ed, timed out, or died at the edge. One line per bucket+route
// per interval, carrying the count suppressed since the last one, so a cascade
// is visible without the log becoming the flood.
const RATE_LIMIT_LOG_INTERVAL_MS = 10_000;
const RATE_LIMIT_LOG_STATE_MAX = 256;
const rateLimitLogState = new Map<string, { lastLoggedAtMs: number; suppressed: number }>();

// Collapses the dynamic segment of the per-player routes so the state map holds
// one entry per route shape, not one per player.
function rateLimitRouteKey(rawUrl: string | undefined): string {
  const pathname = (rawUrl ?? "").split("?")[0];
  return pathname.replace(/^\/api\/profiles\/[^/]+\//, "/api/profiles/*/").slice(0, 120);
}

function logRateLimited(req: IncomingMessage, result: Exclude<RateLimitResult, { allowed: true }>): void {
  const route = rateLimitRouteKey(req.url);
  const key = `${result.bucket}:${route}`;
  const nowMs = Date.now();
  const state = rateLimitLogState.get(key);
  if (state != null && nowMs - state.lastLoggedAtMs < RATE_LIMIT_LOG_INTERVAL_MS) {
    state.suppressed += 1;
    return;
  }
  if (rateLimitLogState.size >= RATE_LIMIT_LOG_STATE_MAX) rateLimitLogState.clear();
  rateLimitLogState.set(key, { lastLoggedAtMs: nowMs, suppressed: 0 });
  logWarn("rate_limited", {
    bucket: result.bucket,
    route,
    limit: result.limit,
    retry_after_ms: result.retryAfterMs,
    suppressed_since_last: state?.suppressed ?? 0,
  });
}

/**
 * The write-pressure shed: a 429 for discretionary write endpoints when the
 * serve-write gate is backed up (checkWriteGateOverloaded). Same shape the
 * rate limiter sends, with a separate bucket so the signed-in pack flow can
 * retry brief pre-payment refusals without retrying account rate limits.
 */
export function sendWritePressureShed(req: IncomingMessage, res: ServerResponse, ctx: Pick<HttpContext, "config">, route: string, retryAfterMs: number, details: Record<string, unknown> = {}): void {
  res.setHeader("retry-after", String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
  logWarn("write_pressure_shed", { ...details, route, retry_after_ms: retryAfterMs });
  sendJson(req, res, ctx, 429, { error: "rate_limited", bucket: "write_pressure", retryAfterMs });
}

export function sendRateLimited(req: IncomingMessage, res: ServerResponse, ctx: Pick<HttpContext, "config">, result: Exclude<RateLimitResult, { allowed: true }>): void {
  res.setHeader("retry-after", String(Math.max(1, Math.ceil(result.retryAfterMs / 1000))));
  logRateLimited(req, result);
  sendJson(req, res, ctx, 429, {
    error: "rate_limited",
    bucket: result.bucket,
    limit: result.limit,
    retryAfterMs: result.retryAfterMs,
  });
}

export function isDisallowedOrigin(req: IncomingMessage, ctx: Pick<HttpContext, "config">): boolean {
  const origin = req.headers.origin;
  return !!origin && !ctx.config.allowedOrigins.includes("*") && !ctx.config.allowedOrigins.includes(origin);
}

export function sendJson(req: IncomingMessage, res: ServerResponse, ctx: Pick<HttpContext, "config">, status: number, body: unknown): void {
  sendCors(req, res, ctx);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  setServerTiming(req, res);
  const json = Buffer.from(JSON.stringify(body), "utf8");
  if (json.length < COMPRESSIBLE_MIN_BYTES) {
    res.end(json);
    return;
  }

  appendVary(res, "accept-encoding");
  const encoding = negotiateEncoding(req);
  if (!encoding) {
    res.end(json);
    return;
  }

  const finish = (error: Error | null, compressed: Buffer): void => {
    if (res.writableEnded || res.destroyed) return;
    try {
      if (error) {
        res.end(json);
      } else {
        res.setHeader("content-encoding", encoding);
        res.end(compressed);
      }
    } catch {
      // Connection torn down mid-flight; nothing left to send.
    }
  };
  if (encoding === "br") {
    brotliCompress(json, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 } }, finish);
  } else {
    gzip(json, { level: 6 }, finish);
  }
}

export function writePreparedJson(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: Pick<HttpContext, "config">,
  prepared: PreparedJsonResponse,
): void {
  sendCors(req, res, ctx);
  res.statusCode = prepared.status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  setServerTiming(req, res);
  if (prepared.vary) appendVary(res, "accept-encoding");
  if (prepared.encoding) res.setHeader("content-encoding", prepared.encoding);
  res.end(prepared.body);
}

function setServerTiming(req: IncomingMessage, res: ServerResponse): void {
  if (res.headersSent) return;
  const startedAt = (req as TimedRequest)[REQUEST_STARTED_AT];
  if (startedAt == null) return;
  const durationMs = Math.max(0, performance.now() - startedAt);
  // Farm Helper stages append to the app total rather than replacing it, so
  // the header still reads as one request with a breakdown underneath.
  const stages = (req as TimedRequest)[REQUEST_FARM_HELPER_TIMINGS];
  res.setHeader("server-timing", stages
    ? `app;dur=${durationMs.toFixed(1)}, ${stages.toServerTiming()}`
    : `app;dur=${durationMs.toFixed(1)}`);
}

export function negotiateEncoding(req: IncomingMessage): "br" | "gzip" | null {
  const raw = req.headers["accept-encoding"];
  const accepted = Array.isArray(raw) ? raw.join(",") : raw ?? "";
  let brQ = 0;
  let gzipQ = 0;
  for (const item of accepted.split(",")) {
    const [namePart, ...params] = item.trim().split(";");
    const name = namePart.trim().toLowerCase();
    if (name !== "br" && name !== "gzip") continue;
    let q = 1;
    for (const param of params) {
      const [key, value] = param.trim().split("=");
      if (key?.trim().toLowerCase() !== "q") continue;
      const parsed = Number(value);
      if (Number.isFinite(parsed)) q = parsed;
    }
    if (name === "br") brQ = Math.max(brQ, q);
    if (name === "gzip") gzipQ = Math.max(gzipQ, q);
  }
  if (brQ <= 0 && gzipQ <= 0) return null;
  if (brQ >= gzipQ) return "br";
  if (gzipQ > 0) return "gzip";
  return null;
}

export function appendVary(res: ServerResponse, field: string): void {
  const existing = res.getHeader("vary");
  if (existing == null) {
    res.setHeader("vary", field);
    return;
  }
  const current = String(existing);
  if (current.toLowerCase().split(/\s*,\s*/).includes(field.toLowerCase())) return;
  res.setHeader("vary", `${current}, ${field}`);
}

export function sendCors(req: IncomingMessage, res: ServerResponse, ctx: Pick<HttpContext, "config">): void {
  const origin = req.headers.origin;
  // Varying on origin is declared even when the request carried none, which is
  // the case that actually bites: a skin's .osk is reachable both by an <a
  // href> download (no Origin, so no allow-origin on the way back) and by the
  // preview editor's fetch, and it is served `immutable, max-age=86400`. Skip
  // the header on the origin-less answer and the browser keeps one cache entry
  // for the URL with no allow-origin on it, which every later cross-origin
  // fetch reuses and then fails the CORS check against.
  appendVary(res, "origin");
  if (origin && (ctx.config.allowedOrigins.includes("*") || ctx.config.allowedOrigins.includes(origin))) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("access-control-allow-methods", "GET,HEAD,POST,OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type,authorization,range");
    // retry-after must be exposed or cross-origin clients cannot see how long
    // a 429 asked them to wait: the pack draw's and card probes' "retry when
    // the window is about to clear" logic reads it via response.headers.
    res.setHeader(
      "access-control-expose-headers",
      "accept-ranges,content-length,content-range,content-type,retry-after,x-audio-mp3-in-mp4,x-audio-size-bytes",
    );
    res.setHeader("access-control-max-age", "600");
  }
}

export function sendNotFound(res: ServerResponse): void {
  res.statusCode = 404;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ error: "not_found" }));
}
