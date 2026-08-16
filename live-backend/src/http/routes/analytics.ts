import type { IncomingMessage, ServerResponse } from "node:http";
import { parseJson } from "../../db.js";
import { MAX_EVENT_LOOKUP_ROWS, MAX_VIEWER_EVENT_ROWS, MAX_VIEWER_ROWS } from "../../features/analytics.js";
import { attachViewerRanks, normalizeAnalyticsViewerSort, sortRankedViewers } from "../../features/analytics-viewer-ranks.js";
import { normalizeCountryParam } from "../abuse-guard.js";
import type { HttpContext } from "../context.js";
import { isAdmin, isBridge, readBody } from "../request.js";
import { sendCors, sendJson } from "../respond.js";

// Admin-only viewer roster responses; see the /api/admin/analytics/viewers
// handler. Process-wide is fine: one serving process owns the analytics store.
const ANALYTICS_VIEWERS_CACHE_TTL_MS = 15_000;
const analyticsViewersCache = new Map<string, { at: number; payload: unknown }>();

export async function handleAnalyticsRoutes(req: IncomingMessage, res: ServerResponse, ctx: HttpContext, url: URL): Promise<boolean> {
  if (url.pathname === "/api/analytics/capture") {
    if (!ctx.analytics) {
      sendJson(req, res, ctx, 404, { error: "analytics_disabled" });
      return true;
    }
    // The ingress, not an admin action: the frontend's /api/sync proxy forwards
    // browser events here. The admin queries below keep the admin token.
    if (!isBridge(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (req.method !== "POST") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    const body = parseJson<{ payload?: unknown; geo_country?: unknown; is_bot?: unknown; client_key?: unknown }>((await readBody(req)) || "{}", {});
    const accepted = ctx.analytics.capture(body.payload, {
      geoCountry: typeof body.geo_country === "string" ? body.geo_country : null,
      isBot: body.is_bot === true,
      clientKey: typeof body.client_key === "string" ? body.client_key.slice(0, 64) : null,
    });
    sendJson(req, res, ctx, 202, { accepted });
    return true;
  }
  if (url.pathname === "/api/admin/analytics/monitor") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (!ctx.analytics) {
      sendJson(req, res, ctx, 404, { error: "analytics_disabled" });
      return true;
    }
    sendJson(req, res, ctx, 200, await ctx.analytics.getMonitorData({
      rangeHours: Number(url.searchParams.get("rangeHours")) || 24,
      recentCountry: url.searchParams.get("recentCountry"),
      recentLimit: Number(url.searchParams.get("recentLimit")) || undefined,
    }));
    return true;
  }
  if (url.pathname === "/api/admin/analytics/valley") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (!ctx.analytics) {
      sendJson(req, res, ctx, 404, { error: "analytics_disabled" });
      return true;
    }
    sendJson(req, res, ctx, 200, await ctx.analytics.getValleyVisitors());
    return true;
  }
  // The signed-in roster: not range-scoped, so it gets its own endpoint rather
  // than riding along on every 5s monitor poll.
  if (url.pathname === "/api/admin/analytics/viewers") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (!ctx.analytics) {
      sendJson(req, res, ctx, 404, { error: "analytics_disabled" });
      return true;
    }
    const requested = Number(url.searchParams.get("limit") ?? 500);
    const limit = Number.isFinite(requested) ? Math.min(2000, Math.max(1, Math.round(requested))) : 500;
    const sort = normalizeAnalyticsViewerSort(url.searchParams.get("sort"));
    // Where these players browsed from, which is the country their row already
    // shows. GLOBAL is a scope name here, not a place anyone signs in from.
    const requestedCountry = normalizeCountryParam(url.searchParams.get("country"));
    const viewerCountry = requestedCountry && requestedCountry !== "GLOBAL" ? requestedCountry : null;
    // The roster changes on the minutes scale but the rank attachment reads
    // the main DB on the serving loop, so a short cache keeps tab switches and
    // the two frontend instances from re-paying it back to back.
    const viewersCacheKey = `${sort}:${limit}:${viewerCountry ?? "all"}`;
    const cachedViewers = analyticsViewersCache.get(viewersCacheKey);
    if (cachedViewers && Date.now() - cachedViewers.at < ANALYTICS_VIEWERS_CACHE_TTL_MS) {
      sendJson(req, res, ctx, 200, cachedViewers.payload);
      return true;
    }
    // "Best players on the site" has to mean best of everyone who signed in, so
    // pp and rank read the whole roster and cut it down after sorting. Recent
    // needs no such scan: the roster comes back in that order already.
    const scanned = await ctx.analytics.getViewers(sort === "recent" ? limit : MAX_VIEWER_ROWS, viewerCountry);
    const ranked = sortRankedViewers(await attachViewerRanks(ctx.db, scanned), sort);
    const viewersTotal = await ctx.analytics.countViewers();
    const viewersPayload = {
      total: viewersTotal,
      // How many the filter matches at all, which is what the page in hand is
      // cut from. Equal to the total when no country is asked for.
      matched: viewerCountry ? await ctx.analytics.countViewers(viewerCountry) : viewersTotal,
      country: viewerCountry,
      countries: await ctx.analytics.getViewerCountries(),
      sort,
      viewers: ranked.slice(0, limit),
    };
    if (analyticsViewersCache.size > 16) analyticsViewersCache.clear();
    analyticsViewersCache.set(viewersCacheKey, { at: Date.now(), payload: viewersPayload });
    sendJson(req, res, ctx, 200, viewersPayload);
    return true;
  }
  // One signed-in player's recent trail, asked for from the roster card. Read
  // on demand rather than folded into the roster: nobody needs 756 trails.
  if (url.pathname === "/api/admin/analytics/viewer-events") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (!ctx.analytics) {
      sendJson(req, res, ctx, 404, { error: "analytics_disabled" });
      return true;
    }
    const viewerId = Number(url.searchParams.get("viewerId"));
    if (!Number.isFinite(viewerId) || viewerId <= 0) {
      sendJson(req, res, ctx, 400, { error: "invalid_viewer_id" });
      return true;
    }
    const requestedEvents = Number(url.searchParams.get("limit") ?? MAX_VIEWER_EVENT_ROWS);
    const eventLimit = Number.isFinite(requestedEvents)
      ? Math.min(MAX_VIEWER_EVENT_ROWS, Math.max(1, Math.round(requestedEvents)))
      : MAX_VIEWER_EVENT_ROWS;
    sendJson(req, res, ctx, 200, { viewerId, events: await ctx.analytics.getViewerEvents(viewerId, eventLimit) });
    return true;
  }
  // The picker behind the event lookup: every event name the store has, so an
  // admin can pick one without knowing how it is spelled in the code.
  if (url.pathname === "/api/admin/analytics/event-catalog") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (!ctx.analytics) {
      sendJson(req, res, ctx, 404, { error: "analytics_disabled" });
      return true;
    }
    sendJson(req, res, ctx, 200, { events: await ctx.analytics.getEventCatalog() });
    return true;
  }
  // Who fired one event, most recent first. The mirror image of viewer-events:
  // that one asks what a player did, this one asks who did a thing.
  if (url.pathname === "/api/admin/analytics/event-lookup") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (!ctx.analytics) {
      sendJson(req, res, ctx, 404, { error: "analytics_disabled" });
      return true;
    }
    const event = (url.searchParams.get("event") ?? "").trim().slice(0, 120);
    if (!event) {
      sendJson(req, res, ctx, 400, { error: "invalid_event" });
      return true;
    }
    const requestedLookup = Number(url.searchParams.get("limit") ?? MAX_EVENT_LOOKUP_ROWS);
    const lookupLimit = Number.isFinite(requestedLookup)
      ? Math.min(MAX_EVENT_LOOKUP_ROWS, Math.max(1, Math.round(requestedLookup)))
      : MAX_EVENT_LOOKUP_ROWS;
    const requestedSince = Number(url.searchParams.get("sinceTs"));
    const sinceTs = Number.isFinite(requestedSince) && requestedSince > 0 ? Math.round(requestedSince) : 0;
    // Both readings of the same window, in one call: the card offers people and
    // raw firings as two tabs and switching between them is not worth a round trip.
    const [people, occurrences] = await Promise.all([
      ctx.analytics.getEventActors(event, { sinceTs, limit: lookupLimit }),
      ctx.analytics.getEventOccurrences(event, { sinceTs, limit: lookupLimit }),
    ]);
    sendJson(req, res, ctx, 200, { event, sinceTs, people, occurrences });
    return true;
  }
  // Short-lived ticket for the admin browser's live SSE stream: EventSource
  // can't send Authorization headers, and baking the real admin token into a
  // URL would leak it into history/proxy logs.
  if (url.pathname === "/api/admin/analytics/live-ticket") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (!ctx.analytics) {
      sendJson(req, res, ctx, 404, { error: "analytics_disabled" });
      return true;
    }
    if (req.method !== "POST") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    sendJson(req, res, ctx, 200, ctx.analytics.issueLiveTicket());
    return true;
  }
  // Realtime admin feed: pushes every accepted capture (post feed-visibility
  // filters) the moment it arrives, ~1s ahead of it being queryable.
  if (url.pathname === "/api/admin/analytics/live") {
    if (!ctx.analytics) {
      sendJson(req, res, ctx, 404, { error: "analytics_disabled" });
      return true;
    }
    const store = ctx.analytics;
    if (!isAdmin(req, ctx) && !store.consumeLiveTicket(url.searchParams.get("ticket"))) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    sendCors(req, res, ctx);
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    res.write(`event: hello\ndata: ${JSON.stringify({ status: "connected" })}\n\n`);
    const unsubscribe = store.subscribe((record) => {
      if (!store.feedFilterAccepts(record)) return;
      res.write(`event: analytics_event\ndata: ${JSON.stringify(store.buildFeedEvent(record))}\n\n`);
    });
    const heartbeat = setInterval(() => {
      res.write(`event: heartbeat\ndata: ${JSON.stringify({ t: Date.now() })}\n\n`);
    }, 15_000);
    heartbeat.unref();
    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
    return true;
  }
  return false;
}
