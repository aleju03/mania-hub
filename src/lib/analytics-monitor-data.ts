import { createServerFn } from "@tanstack/react-start";
import { requireAdminAccess } from "./auth";
import { getServerLiveBackendUrl } from "./live-backend";
import {
  ANALYTICS_COLD_RESPONSE_BUDGET_MS,
  ANALYTICS_DEFAULT_RANGE_HOURS,
  ANALYTICS_RECENT_EVENTS_LIMIT,
  ANALYTICS_TIMELINE_BUCKETS,
  clampAnalyticsRangeHours,
  getAnalyticsBucketMs,
  normalizeAnalyticsViewerSort,
  parseAnalyticsRangeHours,
  type AnalyticsCacheState,
  type AnalyticsMonitorData,
  type AnalyticsRange,
  type AnalyticsTimelineBucket,
  type AnalyticsViewerSort,
  type AnalyticsViewersResult,
} from "./analytics-monitor";

/* Reads the live backend's in-house analytics store for the admin monitor.
   Server-side only - the admin panel reaches this through the two server
   functions at the bottom. */

// The store answers in milliseconds from a local file, so this window only
// exists to coalesce refresh bursts across concurrent admin tabs.
const ANALYTICS_CACHE_FRESH_MS = 4_000;
const ANALYTICS_ERROR_RETRY_MS = 30_000;

const analyticsMonitorCache = new Map<string, {
  data: AnalyticsMonitorData | null;
  promise: Promise<AnalyticsMonitorData> | null;
  error?: unknown;
  failedAt?: number;
}>();

function getAnalyticsCacheKey(rangeHours: AnalyticsRange, recentCountry: string | null): string {
  return `${clampAnalyticsRangeHours(rangeHours)}:${recentCountry ?? "all"}`;
}

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

function createEmptyAnalyticsMonitorData(rangeHours: AnalyticsRange, cacheState: AnalyticsCacheState): AnalyticsMonitorData {
  const now = Date.now();
  return {
    rangeHours,
    cacheState,
    ...emptyAnalyticsTimeline(rangeHours, now),
    activeVisitors: 0,
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

    const cacheKey = getAnalyticsCacheKey(data.rangeHours, data.recentCountry);
    const cached = analyticsMonitorCache.get(cacheKey);
    const now = Date.now();
    if (cached?.data && now - cached.data.fetchedAt <= ANALYTICS_CACHE_FRESH_MS) {
      return { ...cached.data, cacheState: "fresh" };
    }

    let refreshPromise = cached?.promise ?? null;
    const failedRecently = cached?.error != null && cached.failedAt != null && now - cached.failedAt <= ANALYTICS_ERROR_RETRY_MS;
    if (!refreshPromise && failedRecently) {
      if (cached?.data) return { ...cached.data, cacheState: "stale" };
      throw cached.error;
    }

    if (!refreshPromise) {
      let nextPromise: Promise<AnalyticsMonitorData>;
      nextPromise = fetchAnalyticsMonitorData({
        rangeHours: data.rangeHours,
        recentCountry: data.recentCountry,
      }).then(
        (freshData) => {
          analyticsMonitorCache.set(cacheKey, { data: freshData, promise: null });
          return freshData;
        },
        (err) => {
          const latest = analyticsMonitorCache.get(cacheKey);
          if (latest?.promise === nextPromise) {
            analyticsMonitorCache.set(cacheKey, { data: latest.data, promise: null, error: err, failedAt: Date.now() });
          }
          throw err;
        },
      );
      refreshPromise = nextPromise;
      analyticsMonitorCache.set(cacheKey, { data: cached?.data ?? null, promise: refreshPromise });
    }

    if (cached?.data) {
      void refreshPromise.catch(() => undefined);
      return { ...cached.data, cacheState: "stale" };
    }

    const settled = await settleWithin(refreshPromise, ANALYTICS_COLD_RESPONSE_BUDGET_MS);
    if (settled.status === "resolved") return settled.value;
    if (settled.status === "rejected") {
      throw settled.reason;
    }

    void refreshPromise.catch(() => undefined);
    return createEmptyAnalyticsMonitorData(data.rangeHours, "warming");
  });

/* The signed-in roster. Not range-scoped and it changes slowly, so the card
   fetches it on its own rather than riding the 5s monitor poll. */
export const getAnalyticsViewers = createServerFn({ method: "POST" })
  .validator((data: { sort?: unknown } | undefined) => ({
    sort: normalizeAnalyticsViewerSort(data?.sort),
  }))
  .handler(async ({ data }: { data: { sort: AnalyticsViewerSort } }): Promise<AnalyticsViewersResult> => {
    await requireAdminAccess("Analytics viewers");
    const base = getServerLiveBackendUrl();
    const token = process.env.LIVE_ADMIN_TOKEN;
    if (!base || !token) throw new Error("Configure LIVE_BACKEND_URL + LIVE_ADMIN_TOKEN in .env to use analytics monitoring.");
    const response = await fetch(`${base}/api/admin/analytics/viewers?limit=2000&sort=${data.sort}`, {
      headers: { authorization: `Bearer ${token}`, connection: "close" },
    });
    if (!response.ok) throw new Error(`Analytics viewers failed (${response.status}).`);
    return await response.json() as AnalyticsViewersResult;
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
