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
  /* Optional because a backend deployed behind this build does not send them
     yet, and because only players the backend has ingested have them at all. */
  pp?: number | null;
  globalRank?: number | null;
}

/* How the signed-in roster is ordered. pp and rank are the backend's job: it
   sorts the whole roster before cutting it to a page, so the top of the list
   is the real top and not just the best of whoever visited recently. */
export type AnalyticsViewerSort = "recent" | "pp" | "rank";

const ANALYTICS_VIEWER_SORTS: readonly AnalyticsViewerSort[] = ["recent", "pp", "rank"];

export function normalizeAnalyticsViewerSort(value: unknown): AnalyticsViewerSort {
  const candidate = typeof value === "string" ? value.toLowerCase() : "";
  return ANALYTICS_VIEWER_SORTS.includes(candidate as AnalyticsViewerSort)
    ? candidate as AnalyticsViewerSort
    : "recent";
}

export interface AnalyticsViewersResult {
  total: number;
  viewers: AnalyticsViewerRow[];
  sort?: AnalyticsViewerSort;
  /* The country filter the backend applied, how many of the roster it matches,
     and every country the roster has players in. Optional because a backend
     deployed behind this build answers without them. */
  country?: string | null;
  matched?: number;
  countries?: AnalyticsCountryRow[];
}

/* One player's own trail, read on demand from the roster. Empty is a real
   answer: the roster is durable and the events behind it are pruned. */
export interface AnalyticsViewerEventsResult {
  viewerId: number;
  events: AnalyticsRecentEventRow[];
}

// How much of one player's trail a single request pulls back. Matches the
// backend ceiling.
export const ANALYTICS_VIEWER_EVENTS_LIMIT = 300;

/* One event name the store has recorded, with how often it ever has and when
   it last did. The picker for the lookup below. */
export interface AnalyticsEventCatalogEntry {
  event: string;
  count: number;
  lastTs: number;
}

/* One person behind an event: a signed-in account, or the device a signed-out
   visitor browsed on. The counts are over the lookup's window, not all time. */
export interface AnalyticsEventActorRow {
  actorKey: string;
  viewerId: number | null;
  username: string | null;
  distinctId: string;
  country: string | null;
  path: string | null;
  lastTs: number;
  count: number;
}

/* Who fired one event, read two ways: folded to one row per person, and
   unrolled to every firing. Empty is a real answer - events are pruned at the
   store's retention while the event name itself stays in the catalog. */
export interface AnalyticsEventLookupResult {
  event: string;
  sinceTs: number;
  people: AnalyticsEventActorRow[];
  occurrences: AnalyticsRecentEventRow[];
}

/* What the store's event names mean, for reading a list of them at a glance.
   The names themselves are code identifiers and stay available on hover; only
   the ones whose own name reads badly need an entry here, since anything
   missing is humanized from itself (streak_run -> "Streak run"). */
const ANALYTICS_EVENT_LABELS: Record<string, string> = {
  $pageview: "Page views",
  changelog_open: "Changelog opened",
  community_join: "Server invite opened",
  community_post_connect: "Discord connect clicked",
  community_post_consent: "Post-a-server opened",
  community_post_details: "Server details started",
  community_post_no_servers: "No postable servers",
  community_post_pick: "Server picker reached",
  community_post_start: "Post-a-server opened",
  community_post_submitted: "Server submitted",
  dom_translate_conflict: "Page translator conflict",
  map_opened: "Map opened",
  osu_api_error: "osu! API error",
  pack_cut: "Pack cut open",
  pack_open: "Pack opened",
  page_shared: "Page shared",
  react_recoverable_error: "React error",
  replay_load_slow: "Slow replay load",
  replay_renderer_error: "Replay render error",
  replay_upload_beatmap_missing: "Upload with no map",
  replay_upload_community_beatmap: "Upload of a community map",
  replay_upload_local_beatmap: "Upload of a local map",
  replay_upload_shared_view: "Shared upload watched",
  replay_upload_view: "Own upload watched",
  replay_view: "Replay watched",
  replay_watch_crash: "Replay viewer crash",
  route_error: "Page error",
  skin_download: "Skin downloaded",
  skin_file_updated: "Skin build shipped",
  skin_previews_edited: "Skin previews edited",
  skin_upload_failed: "Skin upload failed",
  skin_upload_published: "Skin published",
  streak_run: "Streak run",
};

export function formatAnalyticsEventLabel(event: string): string {
  const known = ANALYTICS_EVENT_LABELS[event];
  if (known) return known;
  const cleaned = event.replace(/^\$/, "").replace(/[_-]+/g, " ").trim();
  if (!cleaned) return event;
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

// Matches the backend ceiling on one event lookup.
export const ANALYTICS_EVENT_LOOKUP_LIMIT = 300;
export const ANALYTICS_EVENT_LOOKUP_STORAGE_KEY = "mh_monitor_lookup_event";

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

/* "warming" is the empty placeholder a cold range answers with while the
   backend is still computing it; every other reply is a real measurement. */
export type AnalyticsCacheState = "fresh" | "warming";

export type AnalyticsRange = number;

export interface AnalyticsMonitorData {
  rangeHours: AnalyticsRange;
  cacheState: AnalyticsCacheState;
  bucketMs: number;
  timeline: AnalyticsTimelineBucket[];
  activeVisitors: number;
  /* Distinct visitors in the last 15 minutes; the 5-minute activeVisitors
     count sits beside it. Optional because a backend deployed behind this
     build answers without it. */
  recentVisitors?: number;
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

/* Identifies what the panel is currently showing, so a reply can be matched
   against it before it renders. */
export function getAnalyticsViewKey(rangeHours: AnalyticsRange, recentCountry: string | null): string {
  return `${clampAnalyticsRangeHours(rangeHours)}:${recentCountry ?? "all"}`;
}

/* Whether a reply should replace what is on screen. The frontend serves from
   two node instances behind a round-robin proxy, so replies can land out of
   order, and a still-warming range answers with an empty placeholder; neither
   may overwrite numbers already shown for the same view. A different range or
   country always renders, since the numbers it replaces are not about it. */
export function analyticsSnapshotSupersedes(
  shown: { key: string; fetchedAt: number } | null,
  next: { key: string; fetchedAt: number; cacheState: AnalyticsCacheState },
): boolean {
  if (!shown || shown.key !== next.key) return true;
  if (next.cacheState === "warming") return false;
  return next.fetchedAt > shown.fetchedAt;
}

/* The store is a local read on the backend, so the dashboard can poll it at a
   seconds cadence without cost. */
export const ANALYTICS_REFRESH_MS = 5_000;
export const ANALYTICS_RANGE_STORAGE_KEY = "mh_monitor_range";
export const ANALYTICS_STREAM_MODE_STORAGE_KEY = "mh_monitor_stream_mode";
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

/* Round wall-clock steps for the traffic axis. A tick every "11:30 PM" reads at
   a glance; ticks every "11:27 PM" (evenly spaced buckets) do not. */
const ANALYTICS_TICK_INTERVALS_MS = [
  60_000,
  2 * 60_000,
  5 * 60_000,
  10 * 60_000,
  15 * 60_000,
  30 * 60_000,
  60 * 60_000,
  2 * 60 * 60_000,
  3 * 60 * 60_000,
  6 * 60 * 60_000,
  12 * 60 * 60_000,
  24 * 60 * 60_000,
  2 * 24 * 60 * 60_000,
  7 * 24 * 60 * 60_000,
] as const;

export interface AnalyticsTimelineTick {
  ts: number;
  /** 0..1 across the plotted span, for absolute positioning. */
  position: number;
}

// Snap up to the next round local-clock step: hours land on the hour and days on
// local midnight, whatever the viewer's offset is.
function ceilToLocalStep(ts: number, stepMs: number): number {
  const offsetMs = new Date(ts).getTimezoneOffset() * 60_000;
  return Math.ceil((ts - offsetMs) / stepMs) * stepMs + offsetMs;
}

export function buildAnalyticsTimelineTicks(
  startTs: number,
  endTs: number,
  maxTicks = 5,
): AnalyticsTimelineTick[] {
  const span = endTs - startTs;
  if (!Number.isFinite(span) || span <= 0 || maxTicks < 1) return [];
  const step =
    ANALYTICS_TICK_INTERVALS_MS.find((interval) => span / interval <= maxTicks) ??
    ANALYTICS_TICK_INTERVALS_MS[ANALYTICS_TICK_INTERVALS_MS.length - 1];
  const ticks: AnalyticsTimelineTick[] = [];
  for (let ts = ceilToLocalStep(startTs, step); ts < endTs; ts += step) {
    const position = (ts - startTs) / span;
    // The edges belong to the range's own start/"now" labels; a tick there would
    // just print the same clock twice.
    if (position < 0.04 || position > 0.9) continue;
    ticks.push({ ts, position });
  }
  return ticks;
}

/* The activity feed's two readings. Persisted so the dashboard comes back the
   way it was left instead of snapping to "stream" on every visit. */
export type AnalyticsStreamMode = "stream" | "sessions";

export function parseAnalyticsStreamMode(value: unknown): AnalyticsStreamMode | null {
  return value === "stream" || value === "sessions" ? value : null;
}

export function readStoredAnalyticsStreamMode(): AnalyticsStreamMode | null {
  if (typeof window === "undefined") return null;
  try {
    return parseAnalyticsStreamMode(window.localStorage.getItem(ANALYTICS_STREAM_MODE_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function storeAnalyticsStreamMode(mode: AnalyticsStreamMode): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(ANALYTICS_STREAM_MODE_STORAGE_KEY, mode);
  } catch {
    // ignore
  }
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
