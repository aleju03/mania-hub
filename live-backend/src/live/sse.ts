import type { IncomingMessage, ServerResponse } from "node:http";
import { isGlobalCountry, touchCountryRequest } from "../countries.js";
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

async function getLastIngestAtMs(db: Db): Promise<number | null> {
  const now = Date.now();
  if (now - ingestFreshness.checkedAt < INGEST_FRESHNESS_CACHE_MS) return ingestFreshness.ingestAtMs;
  ingestFreshness.checkedAt = now;
  try {
    const row = (await exec(db, "select received_at from score_events order by id desc limit 1")).rows[0];
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
  // Global is a synthetic aggregate: fan in every country's events, and never
  // touch a roster/registry or per-country client counter for it.
  const global = isGlobalCountry(country);
  const opened = ctx.abuse?.openSse(req, ctx.config);
  if (opened && !opened.allowed) {
    sendRateLimited(req, res, ctx, opened);
    return true;
  }
  const releaseSse = opened?.allowed ? opened.release : null;
  let releaseCountryClient: (() => void) | null = null;
  try {
    if (!observeOnly && !global) {
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
    const replay = await ctx.events.replay(global ? null : country, lastEventId, 100);
    for (const event of replay) writeEvent(res, event);
  }
  const unsubscribe = ctx.events.subscribe((event) => {
    if (!global && event.country != null && event.country !== country) return;
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
    if (!observeOnly && !global && now - lastCountryTouchAt >= countryTouchIntervalMs) {
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

function writeEvent(res: ServerResponse, event: Pick<LiveEvent, "type" | "sequence" | "payload">): void {
  res.write(`id: ${event.sequence}\n`);
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event.payload)}\n\n`);
}
