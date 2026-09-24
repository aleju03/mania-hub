import { createServerFn } from "@tanstack/react-start";
import { requireAdminAccess } from "./auth";
import { getServerLiveBackendUrl } from "./live-backend";
import type { AnalyticsProductResponse } from "../../live-backend/src/shared/analytics-insights";
import {
  ANALYTICS_COLD_RESPONSE_BUDGET_MS,
  ANALYTICS_DEFAULT_RANGE_HOURS,
  ANALYTICS_EVENT_LOOKUP_LIMIT,
  ANALYTICS_RECENT_EVENTS_LIMIT,
  ANALYTICS_TIMELINE_BUCKETS,
  clampAnalyticsRangeHours,
  getAnalyticsBucketMs,
  normalizeAnalyticsViewerSort,
  parseAnalyticsRangeHours,
  type AnalyticsEventCatalogEntry,
  type AnalyticsEventLookupResult,
  type AnalyticsPageLookupResult,
  type AnalyticsMonitorData,
  type AnalyticsRange,
  type AnalyticsTimelineBucket,
  type AnalyticsViewerSort,
  type AnalyticsViewersResult,
} from "./analytics-monitor";

/* Reads the live backend's in-house analytics store for the admin monitor.
   Server-side only - the admin panel reaches this through the two server
   functions at the bottom.

   Deliberately uncached here. The frontend serves from two node instances
   behind a round-robin proxy, so a cache at this layer is two caches: polls
   alternate between them and the panel flips between two snapshots of
   different ages. The backend already coalesces concurrent computes and holds
   the result for a few seconds (`analytics.ts`, MONITOR_CACHE_TTL_MS), and it
   is one process, so letting both instances read straight through means they
   cannot disagree. */

function normalizeAnalyticsRangeHours(value: unknown): AnalyticsRange {
  return parseAnalyticsRangeHours(value) ?? ANALYTICS_DEFAULT_RANGE_HOURS;
}

function normalizeAnalyticsCountryFilter(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const country = value.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(country) ? country : null;
}

function emptyAnalyticsTimeline(rangeHours: AnalyticsRange, now: number): { bucketMs: number; timeline: AnalyticsTimelineBucket[] } {
  const bucketMs = getAnalyticsBucketMs(rangeHours);
  const since = now - clampAnalyticsRangeHours(rangeHours) * 60 * 60_000;
  return {
    bucketMs,
    timeline: Array.from({ length: ANALYTICS_TIMELINE_BUCKETS }, (_, index) => ({
      ts: since + index * bucketMs,
      events: 0,
      pageviews: 0,
      visitors: 0,
    })),
  };
}

function createWarmingAnalyticsMonitorData(rangeHours: AnalyticsRange): AnalyticsMonitorData {
  const now = Date.now();
  return {
    rangeHours,
    cacheState: "warming",
    ...emptyAnalyticsTimeline(rangeHours, now),
    activeVisitors: 0,
    recentVisitors: 0,
    pageviewsInRange: 0,
    uniqueVisitorsInRange: 0,
    eventsInRange: 0,
    bounce: {
      bounced: 0,
      landers: 0,
    },
    topRoutes: [],
    recentEvents: [],
    topPhysicalCountries: [],
    topProfiles: [],
    topReplays: [],
    topReferrers: [],
    shareEvents: 0,
    sharesByPlatform: [],
    topSharedPages: [],
    serverErrors: [],
    recentServerErrors: [],
    fetchedAt: now,
  };
}

function settleWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<{ status: "resolved"; value: T } | { status: "rejected"; reason: unknown } | { status: "timeout" }> {
  return Promise.race([
    promise.then(
      (value) => ({ status: "resolved" as const, value }),
      (reason) => ({ status: "rejected" as const, reason }),
    ),
    new Promise<{ status: "timeout" }>((resolve) => {
      setTimeout(() => resolve({ status: "timeout" }), timeoutMs);
    }),
  ]);
}

/* One call to the live backend's local store; it returns display-ready rows in
   the exact AnalyticsMonitorData row shapes. */
async function fetchAnalyticsMonitorData({
  rangeHours,
  recentCountry,
}: {
  rangeHours: AnalyticsRange;
  recentCountry: string | null;
}): Promise<AnalyticsMonitorData> {
  const base = getServerLiveBackendUrl();
  if (!base) throw new Error("LIVE_BACKEND_URL is not configured.");
  const params = new URLSearchParams({ rangeHours: String(rangeHours), recentLimit: String(ANALYTICS_RECENT_EVENTS_LIMIT) });
  if (recentCountry) params.set("recentCountry", recentCountry);
  const headers: HeadersInit = { connection: "close" };
  if (process.env.LIVE_ADMIN_TOKEN) headers.authorization = `Bearer ${process.env.LIVE_ADMIN_TOKEN}`;
  const response = await fetch(`${base}/api/admin/analytics/monitor?${params}`, { headers });
  if (!response.ok) throw new Error(`Live analytics monitor failed (${response.status}).`);
  const payload = await response.json() as Omit<AnalyticsMonitorData, "cacheState" | "fetchedAt">;
  return { ...payload, rangeHours, cacheState: "fresh", fetchedAt: Date.now() };
}

export const getAnalyticsMonitorData = createServerFn({ method: "POST" })
  .validator((data: { range?: unknown; rangeHours?: unknown; recentCountry?: unknown }) => ({
    rangeHours: normalizeAnalyticsRangeHours(data?.rangeHours ?? data?.range),
    recentCountry: normalizeAnalyticsCountryFilter(data?.recentCountry),
  }))
  .handler(async ({ data }: { data: { rangeHours: AnalyticsRange; recentCountry: string | null } }): Promise<AnalyticsMonitorData> => {
    await requireAdminAccess("Monitoring analytics");

    if (!getServerLiveBackendUrl() || !process.env.LIVE_ADMIN_TOKEN) {
      throw new Error("Configure LIVE_BACKEND_URL + LIVE_ADMIN_TOKEN in .env to use analytics monitoring.");
    }

    const pending = fetchAnalyticsMonitorData({
      rangeHours: data.rangeHours,
      recentCountry: data.recentCountry,
    });

    const settled = await settleWithin(pending, ANALYTICS_COLD_RESPONSE_BUDGET_MS);
    if (settled.status === "resolved") return settled.value;
    if (settled.status === "rejected") throw settled.reason;

    // Only the waiting is abandoned, not the work: the backend keeps computing
    // this key and holds the result, so the retry the panel schedules next
    // picks it up whichever instance that one lands on.
    void pending.catch(() => undefined);
    return createWarmingAnalyticsMonitorData(data.rangeHours);
  });

/* The signed-in roster. Not range-scoped and it changes slowly, so the card
   fetches it on its own rather than riding the 5s monitor poll. */
export const getAnalyticsViewers = createServerFn({ method: "POST" })
  .validator((data: { sort?: unknown; country?: unknown } | undefined) => ({
    sort: normalizeAnalyticsViewerSort(data?.sort),
    country: normalizeAnalyticsCountryFilter(data?.country),
  }))
  .handler(async ({ data }: { data: { sort: AnalyticsViewerSort; country: string | null } }): Promise<AnalyticsViewersResult> => {
    await requireAdminAccess("Analytics viewers");
    const base = getServerLiveBackendUrl();
    const token = process.env.LIVE_ADMIN_TOKEN;
    if (!base || !token) throw new Error("Configure LIVE_BACKEND_URL + LIVE_ADMIN_TOKEN in .env to use analytics monitoring.");
    // The country narrows the roster on the backend, so a filtered list reaches
    // players older than the cut an unfiltered page ends at.
    const params = new URLSearchParams({ limit: "2000", sort: data.sort });
    if (data.country) params.set("country", data.country);
    const response = await fetch(`${base}/api/admin/analytics/viewers?${params}`, {
      headers: { authorization: `Bearer ${token}`, connection: "close" },
    });
    if (!response.ok) throw new Error(`Analytics viewers failed (${response.status}).`);
    return await response.json() as AnalyticsViewersResult;
  });

/* Every event name the store has recorded. Its own call because it is the
   picker rather than the answer: it is read once when the lookup opens and
   again only when the admin asks for a refresh. */
export const getAnalyticsEventCatalog = createServerFn({ method: "POST" })
  .handler(async (): Promise<AnalyticsEventCatalogEntry[]> => {
    await requireAdminAccess("Analytics event catalog");
    const base = getServerLiveBackendUrl();
    const token = process.env.LIVE_ADMIN_TOKEN;
    if (!base || !token) throw new Error("Configure LIVE_BACKEND_URL + LIVE_ADMIN_TOKEN in .env to use analytics monitoring.");
    const response = await fetch(`${base}/api/admin/analytics/event-catalog`, {
      headers: { authorization: `Bearer ${token}`, connection: "close" },
    });
    if (!response.ok) throw new Error(`Analytics event catalog failed (${response.status}).`);
    const payload = await response.json() as { events?: AnalyticsEventCatalogEntry[] };
    return payload.events ?? [];
  });

export const getAnalyticsProductInsights = createServerFn({ method: "POST" })
  .handler(async (): Promise<AnalyticsProductResponse> => {
    await requireAdminAccess("Analytics audience and reliability");
    const base = getServerLiveBackendUrl();
    const token = process.env.LIVE_ADMIN_TOKEN;
    if (!base || !token) throw new Error("Configure LIVE_BACKEND_URL + LIVE_ADMIN_TOKEN to use analytics.");
    const response = await fetch(`${base}/api/admin/analytics/product`, {
      headers: { authorization: `Bearer ${token}`, connection: "close" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Analytics insights failed (${response.status}).`);
    return await response.json() as AnalyticsProductResponse;
  });

/* Which anonymous visitors fired one event. */
export const getAnalyticsEventLookup = createServerFn({ method: "POST" })
  .validator((data: { event?: unknown; sinceTs?: unknown }) => {
    const event = typeof data?.event === "string" ? data.event.trim().slice(0, 120) : "";
    if (!event) throw new Error("An event name is required.");
    const sinceTs = Number(data?.sinceTs);
    return { event, sinceTs: Number.isFinite(sinceTs) && sinceTs > 0 ? Math.round(sinceTs) : 0 };
  })
  .handler(async ({ data }: { data: { event: string; sinceTs: number } }): Promise<AnalyticsEventLookupResult> => {
    await requireAdminAccess("Analytics event lookup");
    const base = getServerLiveBackendUrl();
    const token = process.env.LIVE_ADMIN_TOKEN;
    if (!base || !token) throw new Error("Configure LIVE_BACKEND_URL + LIVE_ADMIN_TOKEN in .env to use analytics monitoring.");
    const params = new URLSearchParams({ event: data.event, limit: String(ANALYTICS_EVENT_LOOKUP_LIMIT) });
    if (data.sinceTs > 0) params.set("sinceTs", String(data.sinceTs));
    const response = await fetch(`${base}/api/admin/analytics/event-lookup?${params}`, {
      headers: { authorization: `Bearer ${token}`, connection: "close" },
    });
    if (!response.ok) throw new Error(`Analytics event lookup failed (${response.status}).`);
    return await response.json() as AnalyticsEventLookupResult;
  });

/* Every view of one page, newest first. */
export const getAnalyticsPageLookup = createServerFn({ method: "POST" })
  .validator((data: { path?: unknown; sinceTs?: unknown }) => {
    const path = typeof data?.path === "string" ? data.path.trim().slice(0, 300) : "";
    if (!path.startsWith("/")) throw new Error("A page path is required.");
    const sinceTs = Number(data?.sinceTs);
    return { path, sinceTs: Number.isFinite(sinceTs) && sinceTs > 0 ? Math.round(sinceTs) : 0 };
  })
  .handler(async ({ data }: { data: { path: string; sinceTs: number } }): Promise<AnalyticsPageLookupResult> => {
    await requireAdminAccess("Analytics page lookup");
    const base = getServerLiveBackendUrl();
    const token = process.env.LIVE_ADMIN_TOKEN;
    if (!base || !token) throw new Error("Configure LIVE_BACKEND_URL + LIVE_ADMIN_TOKEN in .env to use analytics monitoring.");
    const params = new URLSearchParams({ path: data.path, limit: String(ANALYTICS_EVENT_LOOKUP_LIMIT) });
    if (data.sinceTs > 0) params.set("sinceTs", String(data.sinceTs));
    const response = await fetch(`${base}/api/admin/analytics/page-lookup?${params}`, {
      headers: { authorization: `Bearer ${token}`, connection: "close" },
    });
    if (!response.ok) throw new Error(`Analytics page lookup failed (${response.status}).`);
    return await response.json() as AnalyticsPageLookupResult;
  });

/* Trades the admin session for a short-lived SSE ticket: EventSource can't
   send auth headers, and the browser must never hold the real admin token.
   Returns null when the in-house store isn't configured. */
export const getAnalyticsLiveTicket = createServerFn({ method: "POST" })
  .handler(async (): Promise<{ ticket: string; expiresAt: number } | null> => {
    await requireAdminAccess("Analytics live feed");
    const base = getServerLiveBackendUrl();
    const token = process.env.LIVE_ADMIN_TOKEN;
    if (!base || !token) return null;
    const response = await fetch(`${base}/api/admin/analytics/live-ticket`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, connection: "close" },
    });
    if (!response.ok) return null;
    return await response.json() as { ticket: string; expiresAt: number };
  });
