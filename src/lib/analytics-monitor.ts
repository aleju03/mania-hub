import type { AnalyticsRecentEventRow } from "./analytics-feed";

/* Shapes and vocabulary for the /admin/live-backend analytics tab. Kept free of
   server imports so the rendering components can depend on it without dragging
   the auth + fetching layer (analytics-monitor-data.ts) into their graph. */

export interface AnalyticsTopRouteRow {
  path: string;
  count: number;
}

export interface AnalyticsCountryRow {
  country: string;
  count: number;
}

export interface AnalyticsTopProfileRow {
  username: string;
  views: number;
  lastViewedLabel: string | null;
  lastVisitorCountry: string | null;
}

export interface AnalyticsTopReplayRow {
  scoreId: string;
  title: string | null;
  artist: string | null;
  difficulty: string | null;
  player: string | null;
  coverUrl: string | null;
  views: number;
  lastViewedLabel: string | null;
  lastVisitorCountry: string | null;
}

export interface AnalyticsReferrerRow {
  domain: string;
  count: number;
}

export interface AnalyticsSharePlatformRow {
  platform: string;
  count: number;
}

export interface AnalyticsSharedPageRow {
  path: string;
  subject: string | null;
  subjectType: string | null;
  count: number;
}

export interface AnalyticsServerErrorRow {
  caller: string;
  path: string;
  status: number | null;
  count: number;
}

export interface AnalyticsRecentServerErrorRow {
  timestamp: string;
  caller: string;
  path: string;
  status: number | null;
  bodyPreview: string | null;
  attempts: number | null;
  kind: string | null;
  context: string | null;
  ratePerMin: number | null;
  rateRemaining: number | null;
  rateLimit: number | null;
  retryAfter: string | null;
}

/* One osu! account that has browsed the site while signed in. Durable on the
   backend, so the roster outlives the 90-day event retention. */
export interface AnalyticsViewerRow {
  viewerId: number;
  username: string;
  firstSeen: number;
  lastSeen: number;
  events: number;
  country: string | null;
}

export interface AnalyticsViewersResult {
  total: number;
  viewers: AnalyticsViewerRow[];
}

export interface AnalyticsBounceStats {
  bounced: number;
  landers: number;
}

export interface AnalyticsTimelineBucket {
  ts: number;
  events: number;
  pageviews: number;
  visitors: number;
}

export type AnalyticsCacheState = "fresh" | "stale" | "warming";

export type AnalyticsRange = number;

export interface AnalyticsMonitorData {
  rangeHours: AnalyticsRange;
  cacheState: AnalyticsCacheState;
  bucketMs: number;
  timeline: AnalyticsTimelineBucket[];
  activeVisitors: number;
  pageviewsInRange: number;
  uniqueVisitorsInRange: number;
  eventsInRange: number;
  bounce: AnalyticsBounceStats;
  topRoutes: AnalyticsTopRouteRow[];
  recentEvents: AnalyticsRecentEventRow[];
  topPhysicalCountries: AnalyticsCountryRow[];
  topProfiles: AnalyticsTopProfileRow[];
  topReplays: AnalyticsTopReplayRow[];
  topReferrers: AnalyticsReferrerRow[];
  shareEvents: number;
  sharesByPlatform: AnalyticsSharePlatformRow[];
  topSharedPages: AnalyticsSharedPageRow[];
  serverErrors: AnalyticsServerErrorRow[];
  recentServerErrors: AnalyticsRecentServerErrorRow[];
  fetchedAt: number;
}

/* The store is a local read on the backend, so the dashboard can poll it at a
   seconds cadence without cost. */
export const ANALYTICS_REFRESH_MS = 5_000;
export const ANALYTICS_RANGE_STORAGE_KEY = "mh_monitor_range";
export const ANALYTICS_DEFAULT_RANGE_HOURS = 24;
const ANALYTICS_MIN_RANGE_HOURS = 1;
const ANALYTICS_MAX_RANGE_HOURS = 720;
export const ANALYTICS_RANGE_STEPS = [1, 2, 3, 4, 5, 6, 8, 12, 18, 24, 36, 48, 72, 168, 336, 720] as const;
export const ANALYTICS_RANGE_PRESETS = [1, 3, 6, 12, 24, 168, 720] as const;
// A safety cap, not a display cap: the feed shows everything in the range and
// only truncates if a range somehow exceeds it.
export const ANALYTICS_RECENT_EVENTS_LIMIT = 1000;
export const ANALYTICS_TIMELINE_BUCKETS = 48;
export const ANALYTICS_COLD_RESPONSE_BUDGET_MS = 1_500;

const LEGACY_ANALYTICS_RANGE_HOURS: Record<string, AnalyticsRange> = {
  "1h": 1,
  "24h": 24,
  "7d": 168,
  "30d": 720,
};

export function clampAnalyticsRangeHours(value: number): AnalyticsRange {
  if (!Number.isFinite(value)) return ANALYTICS_DEFAULT_RANGE_HOURS;
  return Math.min(ANALYTICS_MAX_RANGE_HOURS, Math.max(ANALYTICS_MIN_RANGE_HOURS, Math.round(value)));
}

export function parseAnalyticsRangeHours(value: unknown): AnalyticsRange | null {
  if (typeof value === "number") return clampAnalyticsRangeHours(value);
  if (typeof value !== "string") return null;

  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;
  const legacy = LEGACY_ANALYTICS_RANGE_HOURS[trimmed];
  if (legacy) return legacy;
  if (/^\d+$/.test(trimmed)) return clampAnalyticsRangeHours(Number(trimmed));

  const match = trimmed.match(/^(\d+)\s*(h|hr|hrs|hour|hours|d|day|days)$/);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2].startsWith("d") ? 24 : 1;
  return clampAnalyticsRangeHours(amount * unit);
}

export function formatAnalyticsRangeLabel(rangeHours: AnalyticsRange): string {
  const hours = clampAnalyticsRangeHours(rangeHours);
  if (hours === 1) return "Last hour";
  if (hours === 24) return "Last 24h";
  if (hours < 24) return `Last ${hours}h`;
  if (hours % 24 === 0) {
    const days = hours / 24;
    return `Last ${days} ${days === 1 ? "day" : "days"}`;
  }
  return `Last ${hours}h`;
}

export function formatAnalyticsRangeChipLabel(rangeHours: AnalyticsRange): string {
  const hours = clampAnalyticsRangeHours(rangeHours);
  if (hours < 24) return `${hours}h`;
  if (hours === 24) return "24h";
  if (hours % 24 === 0) return `${hours / 24}d`;
  return `${hours}h`;
}

export function getAnalyticsRangeStepIndex(rangeHours: AnalyticsRange): number {
  const clamped = clampAnalyticsRangeHours(rangeHours);
  let closestIndex = 0;
  let closestDistance = Number.POSITIVE_INFINITY;
  ANALYTICS_RANGE_STEPS.forEach((step, index) => {
    const distance = Math.abs(step - clamped);
    if (distance < closestDistance) {
      closestIndex = index;
      closestDistance = distance;
    }
  });
  return closestIndex;
}

/* Bucket width for the traffic chart: the range split into a fixed number of
   columns, floored at a minute so short ranges stay readable. */
export function getAnalyticsBucketMs(rangeHours: AnalyticsRange): number {
  return Math.max(60_000, Math.ceil((clampAnalyticsRangeHours(rangeHours) * 60 * 60_000) / ANALYTICS_TIMELINE_BUCKETS));
}
