import { createServerFn } from "@tanstack/react-start";
import { requireAdminAccess } from "./auth";
import { getServerLiveBackendUrl } from "./live-backend";
import {
  ANALYTICS_COLD_RESPONSE_BUDGET_MS,
  ANALYTICS_DEFAULT_RANGE_HOURS,
  ANALYTICS_RECENT_EVENTS_LIMIT,
  ANALYTICS_TIMELINE_BUCKETS,
  ANALYTICS_VIEWER_EVENTS_LIMIT,
  clampAnalyticsRangeHours,
  getAnalyticsBucketMs,
  normalizeAnalyticsViewerSort,
  parseAnalyticsRangeHours,
  type AnalyticsMonitorData,
  type AnalyticsRange,
  type AnalyticsTimelineBucket,
  type AnalyticsViewerEventsResult,
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

/* What one signed-in player has been doing. Its own call rather than part of
   the roster: a trail per row would be hundreds of scans for the handful anyone
   actually opens. */
export const getAnalyticsViewerEvents = createServerFn({ method: "POST" })
  .validator((data: { viewerId?: unknown }) => {
    const viewerId = Number(data?.viewerId);
    if (!Number.isFinite(viewerId) || viewerId <= 0) throw new Error("A viewer id is required.");
    return { viewerId: Math.round(viewerId) };
  })
  .handler(async ({ data }: { data: { viewerId: number } }): Promise<AnalyticsViewerEventsResult> => {
    await requireAdminAccess("Analytics viewer events");
    const base = getServerLiveBackendUrl();
    const token = process.env.LIVE_ADMIN_TOKEN;
    if (!base || !token) throw new Error("Configure LIVE_BACKEND_URL + LIVE_ADMIN_TOKEN in .env to use analytics monitoring.");
    const params = new URLSearchParams({ viewerId: String(data.viewerId), limit: String(ANALYTICS_VIEWER_EVENTS_LIMIT) });
    const response = await fetch(`${base}/api/admin/analytics/viewer-events?${params}`, {
      headers: { authorization: `Bearer ${token}`, connection: "close" },
    });
    if (!response.ok) throw new Error(`Analytics viewer events failed (${response.status}).`);
    return await response.json() as AnalyticsViewerEventsResult;
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
