import type { IncomingMessage, ServerResponse } from "node:http";
import { resolveCountryScope, touchCountryRequest } from "../countries.js";
import { exec, type Db } from "../db.js";
import { normalizeCountryParam } from "../http/abuse-guard.js";
import { activatePublicCountry, sendRateLimited, type HttpContext } from "../http/snapshots.js";
import type { LiveEvent } from "../shared/types.js";

const DEFAULT_COUNTRY_TOUCH_INTERVAL_MS = 60 * 60_000;
const INGEST_FRESHNESS_CACHE_MS = 15_000;

// Heartbeats carry when the pipeline last ingested a score, so clients can
// tell "connected but the backend stopped writing" (the 2026-07-18 wedge)
// apart from a healthy quiet feed. Ingest happens in the worker process, so
// the serving process reads it from the DB — one indexed newest-row read,
// cached across all SSE connections.
let ingestFreshness: { checkedAt: number; ingestAtMs: number | null } = { checkedAt: 0, ingestAtMs: null };

// Exported for tests; production reads it only through the heartbeat.
export async function getLastIngestAtMs(db: Db): Promise<number | null> {
  const now = Date.now();
  if (now - ingestFreshness.checkedAt < INGEST_FRESHNESS_CACHE_MS) return ingestFreshness.ingestAtMs;
  ingestFreshness.checkedAt = now;
  try {
    // Manual submissions and leaderboard imports are excluded: their rows are
    // written with a current received_at, and this readout exists to expose a
    // stalled pipeline - a hand-pasted historical score must not make a wedged
    // feed look healthy.
    const row = (await exec(db, "select received_at from score_events where source not in ('manual_submit', 'leaderboard_import') order by id desc limit 1")).rows[0];
    const parsed = row?.received_at == null ? NaN : Date.parse(String(row.received_at));
    ingestFreshness.ingestAtMs = Number.isFinite(parsed) ? parsed : null;
  } catch {
    // Keep the previous value; a failed read must never break heartbeats.
  }
  return ingestFreshness.ingestAtMs;
}

export async function handleSse(req: IncomingMessage, res: ServerResponse, ctx: HttpContext): Promise<boolean> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (url.pathname !== "/api/live") return false;
  const origin = req.headers.origin;
  if (origin && !ctx.config.allowedOrigins.includes(origin)) {
    res.statusCode = 403;
    res.end("forbidden");
    return true;
  }
  if (origin) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("vary", "origin");
  }
  const country = normalizeCountryParam(url.searchParams.get("country"))
    ?? normalizeCountryParam(ctx.config.trackedCountries?.[0])
    ?? "CR";
  if (url.searchParams.has("country") && !normalizeCountryParam(url.searchParams.get("country"))) {
    res.statusCode = 400;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "invalid_country" }));
    return true;
  }
  const observeOnly = url.searchParams.get("observe") === "1";
  // Global fans in every country's events; a region fans in its member
  // countries'. Both are synthetic aggregates: never touch a roster/registry
  // or per-country client counter for them.
  const scope = resolveCountryScope(country);
  const scopeSet = scope.codes ? new Set(scope.codes) : null;
  const opened = ctx.abuse?.openSse(req, ctx.config);
  if (opened && !opened.allowed) {
    sendRateLimited(req, res, ctx, opened);
    return true;
  }
  const releaseSse = opened?.allowed ? opened.release : null;
  let releaseCountryClient: (() => void) | null = null;
  try {
    if (!observeOnly && scope.kind === "country") {
      const activated = await activatePublicCountry(req, res, ctx, country);
      if (!activated) {
        releaseSse?.();
        return true;
      }
      releaseCountryClient = ctx.countryClients?.open(country) ?? null;
    }
  } catch (error) {
    releaseCountryClient?.();
    releaseSse?.();
    throw error;
  }
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  const cursor = req.headers["last-event-id"] ?? url.searchParams.get("lastEventId");
  const lastEventId = Number(cursor ?? 0);
  writeEvent(res, { type: "hello", sequence: Number.isFinite(lastEventId) && lastEventId > 0 ? lastEventId : await ctx.events.latestSequence(), payload: { country, status: "connected" } });
  if (cursor != null && Number.isFinite(lastEventId)) {
    const replay = await ctx.events.replay(scope.codes, lastEventId, 100);
    for (const event of replay) writeEvent(res, event);
  }
  const unsubscribe = ctx.events.subscribe((event) => {
    if (scopeSet && event.country != null && !scopeSet.has(event.country)) return;
    writeEvent(res, event);
  });
  let lastCountryTouchAt = Date.now();
  const countryTouchIntervalMs = Math.max(
    60_000,
    Math.min(DEFAULT_COUNTRY_TOUCH_INTERVAL_MS, Math.floor((ctx.config.countryWarmTtlMs ?? 72 * 60 * 60_000) / 4)),
  );
  const heartbeat = setInterval(() => {
    const now = Date.now();
    void getLastIngestAtMs(ctx.db).then((ingestAtMs) => {
      // No id line: an id here would overwrite the browser's Last-Event-ID
      // cursor with a timestamp, breaking replay on the next reconnect.
      res.write(`event: heartbeat\ndata: ${JSON.stringify({ t: now, ingest_at: ingestAtMs })}\n\n`);
    }).catch(() => undefined);
    if (!observeOnly && scope.kind === "country" && now - lastCountryTouchAt >= countryTouchIntervalMs) {
      lastCountryTouchAt = now;
      // Off the serving connection (see HttpContext.serveWriteDb): a long-lived
      // SSE stream must never issue a write on the connection that serves reads.
      void touchCountryRequest(ctx.serveWriteDb ?? ctx.db, country).catch(() => undefined);
    }
  }, 15_000);
  heartbeat.unref();
  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
    releaseCountryClient?.();
    releaseSse?.();
  });
  return true;
}

// Live events are dispatched as one shared object to every subscriber, so the
// serialized SSE frame is cached per event: one stringify per event instead of
// one per connected client. Hello/replay events are per-connection objects and
// just pass through the miss path.
const frameCache = new WeakMap<object, string>();

function writeEvent(res: ServerResponse, event: Pick<LiveEvent, "type" | "sequence" | "payload">): void {
  let frame = frameCache.get(event);
  if (frame == null) {
    frame = `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`;
    frameCache.set(event, frame);
  }
  res.write(frame);
}
