import { createFileRoute, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Activity, Check, ChevronDown, ChevronRight, Crosshair, Database, HelpCircle, History, Monitor, Pause, Play, Radio, RefreshCw, Server, Signal, Smartphone, Trash2, UserRound, Wifi, WifiOff, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { canUseAdminFeatures } from "../../lib/auth-shared";
import { requireAdminAccess } from "../../lib/auth";
import {
  fetchLiveBackendAdminStatus,
  getLiveBackendUrl,
  openLiveEventSource,
  runLiveBackendAdminAction,
  type LiveEventName,
} from "../../lib/live-backend";
import { formatNumber, formatTimeAgo } from "../../lib/format";
import { getCountryName } from "../../lib/country";
import { CountryFlag } from "../../components/ui/CountryFlag";

type ConnectionState = "idle" | "connecting" | "open" | "error";
type StatusTone = "good" | "warn" | "bad" | "neutral";

const OSC_FEED_STALE_MS = 30 * 1000;

interface LiveBackendStatus {
  ok: boolean;
  db: boolean;
  storage?: {
    filePath: string | null;
    bytes: number | null;
    walBytes: number | null;
    maxBytes: number;
    targetBytes: number;
    overLimit: boolean;
  };
  osc: {
    connected: boolean;
    lastBatchAt: string | null;
    lastError: string | null;
    stale?: boolean;
  };
  lastEventAt: string | null;
  queueDepth: number;
  queuePressure?: {
    depth: number;
    deferred?: number;
    targetDepth: number;
    softDepth: number;
    recoveryDepth?: number;
    shedding: boolean;
    sheddableTypes: string[];
    typeCaps: Record<string, number>;
  };
  queueSummary?: Array<{
    status: string;
    type: string;
    count: number;
    oldestRunAfter: string | null;
    newestError: string | null;
  }>;
  roster?: Array<{ country: string; users: number; refreshedAt: string | null }>;
  countries?: Array<{
    country: string;
    status: "active" | "warm" | "paused";
    featureTier?: "indexed" | "maps_warm" | "live" | "snipes";
    pinned: boolean;
    firstRequestedAt: string;
    lastRequestedAt: string;
    lastRosterRefreshAt: string | null;
    lastScoreAt: string | null;
    activeUsers: number;
    lastActiveAt: string | null;
    isWarm: boolean;
  }>;
  catchup?: Record<string, {
    pending: number;
    running: number;
    failed: number;
    lastError: string | null;
    lastRunAt: string | null;
    cursorMs: number | null;
    lastResult: {
      fetched: number;
      inserted: number;
      skipped: number;
      after: number;
      nextAfter: number | null;
      hasMore: boolean;
    } | null;
  }>;
  rate: {
    hardPerMinute: number;
    targetPerMinute?: number;
    usedLastMinute: number;
    pending?: number;
    byCaller?: Array<{ caller: string; count: number }>;
    byPath?: Array<{ path: string; count: number }>;
  };
  scoresFallback?: {
    enabled: boolean;
    intervalMs: number;
    updatedAt: string | null;
    cursorUpdatedAt: string | null;
    hasCursor: boolean;
    rate?: {
      usedLastMinute: number;
      targetPerMinute: number;
      hardPerMinute: number;
      pending: number;
    } | null;
    result: {
      ran: boolean;
      reason: string | null;
      fetched: number;
      candidates: number;
      inserted: number;
      skipped: number;
      cursorString: string | null;
      nextCursorString: string | null;
      latestEndedAt: string | null;
    } | null;
  };
  abuse?: {
    windows: number;
    sseTotal: number;
    sseIps: number;
  } | null;
  apiCallHistory?: {
    windowMinutes: number;
    byCaller: Array<{ caller: string; count: number }>;
    byPath: Array<{ path: string; count: number }>;
  };
  worker?: {
    paused: boolean;
    stopped: boolean;
    workerId: string;
    lanes?: Array<{
      name: string;
      claimLimit: number;
      intervalMs: number;
      jobTypes: string[] | null;
      activeJobs?: Array<{
        id: number;
        type: string;
        dedupeKey: string;
        attempts: number;
        startedAt: string;
        payload: unknown;
      }>;
    }>;
  } | null;
  snapshotStats?: SnapshotStats;
}

interface SnapshotStats {
  trackerScores: number | null;
  trackerFetchedAt: number | null;
  topPlays: number | null;
  topPlaysFetchedAt: number | null;
  snipes: number | null;
  snipesFetchedAt: number | null;
}

interface LiveEventRow {
  id: string;
  type: LiveEventName | string;
  receivedAt: number;
  preview: string;
}

interface AnalyticsTopRouteRow {
  path: string;
  count: number;
}

type AnalyticsDeviceKind = "mobile" | "desktop" | "unknown";

interface AnalyticsRecentEventRow {
  timestamp: string;
  event: string;
  path: string;
  country: string | null;
  selectedCountry: string | null;
  deviceKind: AnalyticsDeviceKind;
  distinctId: string;
  mapsTab: string | null;
  rankingsPage: string | null;
  profileUsername: string | null;
  replayPlayer: string | null;
  replayScoreId: string | null;
}

interface AnalyticsCountryRow {
  country: string;
  count: number;
}

interface AnalyticsTopProfileRow {
  username: string;
  views: number;
  lastViewedLabel: string | null;
  lastVisitorCountry: string | null;
}

interface AnalyticsTopReplayRow {
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

interface AnalyticsReferrerRow {
  domain: string;
  count: number;
}

interface AnalyticsServerErrorRow {
  caller: string;
  path: string;
  status: number | null;
  count: number;
}

interface AnalyticsRecentServerErrorRow {
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

interface AnalyticsBounceStats {
  bounced: number;
  landers: number;
}

type AnalyticsCacheState = "fresh" | "stale" | "warming";

interface AnalyticsMonitorData {
  rangeHours: AnalyticsRange;
  cacheState: AnalyticsCacheState;
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
  serverErrors: AnalyticsServerErrorRow[];
  recentServerErrors: AnalyticsRecentServerErrorRow[];
  fetchedAt: number;
}

const BACKEND_REFRESH_MS = 5_000;
const ANALYTICS_REFRESH_MS = 30_000;
const DEFAULT_COUNTRY = "CR";
const MONITORING_TABS = ["backend", "analytics"] as const;
type MonitoringTab = (typeof MONITORING_TABS)[number];
type AnalyticsRange = number;
const ANALYTICS_RANGE_STORAGE_KEY = "mh_monitor_range";
const ANALYTICS_DEFAULT_RANGE_HOURS = 24;
const ANALYTICS_MIN_RANGE_HOURS = 1;
const ANALYTICS_MAX_RANGE_HOURS = 720;
const ANALYTICS_RANGE_STEPS = [1, 2, 3, 4, 5, 6, 8, 12, 18, 24, 36, 48, 72, 168, 336, 720] as const;
const ANALYTICS_RANGE_PRESETS = [1, 3, 6, 12, 24, 168, 720] as const;
const ANALYTICS_CACHE_FRESH_MS = 30_000;
const ANALYTICS_COLD_RESPONSE_BUDGET_MS = 1_500;
const ANALYTICS_ERROR_RETRY_MS = 30_000;
const POSTHOG_QUERY_TIMEOUT_MS = 30_000;
const HIDDEN_WORKER_LANE_NAMES = new Set([
  "dan-estimates",
  "replay-video-render",
  "replay-video-finalize",
]);

const LEGACY_ANALYTICS_RANGE_HOURS: Record<string, AnalyticsRange> = {
  "1h": 1,
  "24h": 24,
  "7d": 168,
  "30d": 720,
};

const analyticsMonitorCache = new Map<string, {
  data: AnalyticsMonitorData | null;
  promise: Promise<AnalyticsMonitorData> | null;
  error?: unknown;
  failedAt?: number;
}>();

function clampAnalyticsRangeHours(value: number): AnalyticsRange {
  if (!Number.isFinite(value)) return ANALYTICS_DEFAULT_RANGE_HOURS;
  return Math.min(ANALYTICS_MAX_RANGE_HOURS, Math.max(ANALYTICS_MIN_RANGE_HOURS, Math.round(value)));
}

function parseAnalyticsRangeHours(value: unknown): AnalyticsRange | null {
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

function normalizeAnalyticsRangeHours(value: unknown): AnalyticsRange {
  return parseAnalyticsRangeHours(value) ?? ANALYTICS_DEFAULT_RANGE_HOURS;
}

function getAnalyticsRangeSql(rangeHours: AnalyticsRange): string {
  const hours = clampAnalyticsRangeHours(rangeHours);
  if (hours >= 24 && hours % 24 === 0) return `now() - interval ${hours / 24} day`;
  return `now() - interval ${hours} hour`;
}

function formatAnalyticsRangeLabel(rangeHours: AnalyticsRange): string {
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

function formatAnalyticsRangeChipLabel(rangeHours: AnalyticsRange): string {
  const hours = clampAnalyticsRangeHours(rangeHours);
  if (hours < 24) return `${hours}h`;
  if (hours === 24) return "24h";
  if (hours % 24 === 0) return `${hours / 24}d`;
  return `${hours}h`;
}

function getAnalyticsRangeStepIndex(rangeHours: AnalyticsRange): number {
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

function getAnalyticsCacheKey(rangeHours: AnalyticsRange, recentCountry: string | null): string {
  return `${clampAnalyticsRangeHours(rangeHours)}:${recentCountry ?? "all"}`;
}

class AnalyticsPostHogQueryError extends Error {
  status: number | null;

  constructor(status: number | null, message: string) {
    super(status == null ? message : `PostHog query failed (${status}): ${message}`);
    this.name = "AnalyticsPostHogQueryError";
    this.status = status;
  }
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.message.toLowerCase().includes("aborted"));
}

function normalizeAnalyticsCountryFilter(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const country = value.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(country) ? country : null;
}

function formatServerErrorContext(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (typeof value !== "object") return String(value);

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined && entryValue !== null && entryValue !== "")
    .slice(0, 10)
    .map(([key, entryValue]) => `${key}=${String(entryValue)}`);

  return entries.length ? entries.join(" ") : null;
}

function parseAnalyticsDeviceWidth(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value !== "string") return null;
  const width = Number(value);
  return Number.isFinite(width) && width > 0 ? width : null;
}

function getAnalyticsDeviceKind(screenWidth: unknown, viewportWidth: unknown): AnalyticsDeviceKind {
  const width = parseAnalyticsDeviceWidth(screenWidth) ?? parseAnalyticsDeviceWidth(viewportWidth);
  if (width == null) return "unknown";
  return width < 768 ? "mobile" : "desktop";
}

function createEmptyAnalyticsMonitorData(rangeHours: AnalyticsRange, cacheState: AnalyticsCacheState): AnalyticsMonitorData {
  return {
    rangeHours,
    cacheState,
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
    serverErrors: [],
    recentServerErrors: [],
    fetchedAt: Date.now(),
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

async function fetchAnalyticsMonitorDataFromPostHog({
  endpoint,
  apiKey,
  rangeHours,
  recentCountry,
}: {
  endpoint: string;
  apiKey: string;
  rangeHours: AnalyticsRange;
  recentCountry: string | null;
}): Promise<AnalyticsMonitorData> {
  const since = getAnalyticsRangeSql(rangeHours);
  const recentCountryClause = recentCountry ? ` AND properties.$geoip_country_code = '${recentCountry}'` : "";

  async function runQuery(label: string, query: string): Promise<unknown[][]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), POSTHOG_QUERY_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ query: { kind: "HogQLQuery", query } }),
        signal: controller.signal,
      });
    } catch (err) {
      if (isAbortError(err)) {
        throw new AnalyticsPostHogQueryError(null, `PostHog "${label}" query timed out after ${Math.round(POSTHOG_QUERY_TIMEOUT_MS / 1000)}s.`);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
    if (!res.ok) {
      const text = await res.text();
      throw new AnalyticsPostHogQueryError(res.status, `${label}: ${text.slice(0, 400)}`);
    }
    const body = (await res.json()) as { results?: unknown[][] };
    return body.results ?? [];
  }

  const [
    active,
    pvRange,
    uvRange,
    eventsRange,
    topRoutes,
    recent,
    topPhysCountries,
    topProfiles,
    topReplays,
    topReferrers,
    serverErrors,
    recentServerErrors,
    bounce,
  ] = await Promise.all([
    runQuery("active visitors", `SELECT count(DISTINCT distinct_id) FROM events WHERE timestamp > now() - interval 5 minute`),
    runQuery("pageviews", `SELECT count() FROM events WHERE event = '$pageview' AND timestamp > ${since} AND properties.$pathname NOT LIKE '/admin/%'`),
    runQuery("unique visitors", `SELECT count(DISTINCT distinct_id) FROM events WHERE timestamp > ${since}`),
    runQuery("events", `SELECT count() FROM events WHERE timestamp > ${since}`),
    runQuery(
      "top routes",
      `SELECT properties.$pathname AS p, count() AS c FROM events WHERE event = '$pageview' AND timestamp > ${since} AND properties.$pathname IS NOT NULL AND properties.$pathname != '/' AND properties.$pathname NOT LIKE '/admin/%' GROUP BY p ORDER BY c DESC LIMIT 10`,
    ),
    runQuery(
      "recent activity",
      `SELECT formatDateTime(toTimeZone(timestamp, 'America/Costa_Rica'), '%h:%i:%S %p'), event, properties.$pathname, properties.$geoip_country_code, properties.selected_country, distinct_id, properties.maps_tab, properties.rankings_page, properties.profile_username, properties.replay_player, properties.replay_score_id, properties.$screen_width, properties.$viewport_width FROM events WHERE timestamp > ${since} AND distinct_id != 'server'${recentCountryClause} AND (properties.$pathname IS NULL OR properties.$pathname NOT LIKE '/admin/%') AND NOT (event = '$pageview' AND properties.$pathname = '/') ORDER BY timestamp DESC LIMIT 30`,
    ),
    runQuery(
      "physical countries",
      `SELECT properties.$geoip_country_code AS c, count(DISTINCT distinct_id) AS n FROM events WHERE timestamp > ${since} AND properties.$geoip_country_code IS NOT NULL GROUP BY c ORDER BY n DESC LIMIT 20`,
    ),
    runQuery(
      "top profiles",
      `SELECT properties.profile_username AS u, count() AS n, max(timestamp) AS last_viewed_at, formatDateTime(toTimeZone(max(timestamp), 'America/Costa_Rica'), '%Y-%m-%d %h:%i %p') AS last_viewed_label, argMax(properties.$geoip_country_code, timestamp) AS last_country FROM events WHERE event = '$pageview' AND properties.profile_username IS NOT NULL AND timestamp > ${since} GROUP BY u ORDER BY n DESC, last_viewed_at DESC LIMIT 10`,
    ),
    runQuery(
      "top replays",
      `SELECT properties.replay_score_id AS score_id, any(properties.replay_title) AS title, any(properties.replay_artist) AS artist, any(properties.replay_difficulty) AS difficulty, any(properties.replay_player) AS player, any(properties.replay_cover_url) AS cover_url, count() AS n, max(timestamp) AS last_viewed_at, formatDateTime(toTimeZone(max(timestamp), 'America/Costa_Rica'), '%Y-%m-%d %h:%i %p') AS last_viewed_label, argMax(properties.$geoip_country_code, timestamp) AS last_country FROM events WHERE event = 'replay_view' AND properties.replay_score_id IS NOT NULL AND timestamp > ${since} GROUP BY score_id ORDER BY n DESC, last_viewed_at DESC LIMIT 10`,
    ),
    runQuery(
      "top referrers",
      `SELECT properties.$referring_domain AS d, count(DISTINCT distinct_id) AS n FROM events WHERE event = '$pageview' AND timestamp > ${since} AND properties.$referring_domain IS NOT NULL AND properties.$referring_domain NOT IN ('localhost', '127.0.0.1', '::1') AND properties.$referring_domain NOT LIKE '%-aleju03s-projects.vercel.app' GROUP BY d ORDER BY n DESC LIMIT 10`,
    ),
    runQuery(
      "server errors",
      `SELECT properties.caller AS c, properties.path AS p, properties.status AS s, count() AS n FROM events WHERE event = 'osu_api_error' AND timestamp > ${since} AND properties.caller IS NOT NULL GROUP BY c, p, s ORDER BY n DESC LIMIT 10`,
    ),
    runQuery(
      "recent server errors",
      `SELECT formatDateTime(toTimeZone(timestamp, 'America/Costa_Rica'), '%h:%i:%S %p'), properties.caller, properties.path, properties.status, properties.body_preview, properties.attempts, properties.kind, properties.context, properties.rate_per_min, properties.rate_remaining, properties.rate_limit, properties.retry_after FROM events WHERE event = 'osu_api_error' AND timestamp > ${since} AND properties.caller IS NOT NULL ORDER BY timestamp DESC LIMIT 15`,
    ),
    runQuery(
      "bounce",
      `SELECT countIf(pv_count = 1) AS bounced, count() AS landers FROM (SELECT distinct_id, count() AS pv_count FROM events WHERE event = '$pageview' AND timestamp > ${since} GROUP BY distinct_id HAVING countIf(properties.$pathname = '/') > 0)`,
    ),
  ]);

  return {
    rangeHours,
    cacheState: "fresh",
    activeVisitors: Number(active[0]?.[0] ?? 0),
    pageviewsInRange: Number(pvRange[0]?.[0] ?? 0),
    uniqueVisitorsInRange: Number(uvRange[0]?.[0] ?? 0),
    eventsInRange: Number(eventsRange[0]?.[0] ?? 0),
    bounce: {
      bounced: Number(bounce[0]?.[0] ?? 0),
      landers: Number(bounce[0]?.[1] ?? 0),
    },
    topRoutes: topRoutes.map((row) => ({
      path: String(row[0] ?? ""),
      count: Number(row[1] ?? 0),
    })),
    recentEvents: recent.map((row) => ({
      timestamp: String(row[0] ?? ""),
      event: String(row[1] ?? ""),
      path: String(row[2] ?? ""),
      country: row[3] ? String(row[3]) : null,
      selectedCountry: row[4] ? String(row[4]) : null,
      deviceKind: getAnalyticsDeviceKind(row[11], row[12]),
      distinctId: String(row[5] ?? ""),
      mapsTab: row[6] ? String(row[6]) : null,
      rankingsPage: row[7] ? String(row[7]) : null,
      profileUsername: row[8] ? String(row[8]) : null,
      replayPlayer: row[9] ? String(row[9]) : null,
      replayScoreId: row[10] ? String(row[10]) : null,
    })),
    topPhysicalCountries: topPhysCountries.map((row) => ({
      country: String(row[0] ?? ""),
      count: Number(row[1] ?? 0),
    })),
    topProfiles: topProfiles.map((row) => ({
      username: String(row[0] ?? ""),
      views: Number(row[1] ?? 0),
      lastViewedLabel: row[3] ? String(row[3]) : null,
      lastVisitorCountry: row[4] ? String(row[4]) : null,
    })),
    topReplays: topReplays.map((row) => ({
      scoreId: String(row[0] ?? ""),
      title: row[1] ? String(row[1]) : null,
      artist: row[2] ? String(row[2]) : null,
      difficulty: row[3] ? String(row[3]) : null,
      player: row[4] ? String(row[4]) : null,
      coverUrl: row[5] ? String(row[5]) : null,
      views: Number(row[6] ?? 0),
      lastViewedLabel: row[8] ? String(row[8]) : null,
      lastVisitorCountry: row[9] ? String(row[9]) : null,
    })),
    topReferrers: topReferrers.map((row) => ({
      domain: String(row[0] ?? ""),
      count: Number(row[1] ?? 0),
    })),
    serverErrors: serverErrors.map((row) => ({
      caller: row[0] ? String(row[0]) : "unknown",
      path: String(row[1] ?? ""),
      status: row[2] == null ? null : Number(row[2]),
      count: Number(row[3] ?? 0),
    })),
    recentServerErrors: recentServerErrors.map((row) => ({
      timestamp: String(row[0] ?? ""),
      caller: row[1] ? String(row[1]) : "unknown",
      path: String(row[2] ?? ""),
      status: row[3] == null ? null : Number(row[3]),
      bodyPreview: row[4] ? String(row[4]) : null,
      attempts: row[5] == null ? null : Number(row[5]),
      kind: row[6] ? String(row[6]) : null,
      context: row[7] ? formatServerErrorContext(row[7]) : null,
      ratePerMin: row[8] == null ? null : Number(row[8]),
      rateRemaining: row[9] == null ? null : Number(row[9]),
      rateLimit: row[10] == null ? null : Number(row[10]),
      retryAfter: row[11] ? String(row[11]) : null,
    })),
    fetchedAt: Date.now(),
  };
}

const getAnalyticsMonitorData = createServerFn({ method: "POST" })
  .inputValidator((data: { range?: unknown; rangeHours?: unknown; recentCountry?: unknown }) => ({
    rangeHours: normalizeAnalyticsRangeHours(data?.rangeHours ?? data?.range),
    recentCountry: normalizeAnalyticsCountryFilter(data?.recentCountry),
  }))
  .handler(async ({ data }: { data: { rangeHours: AnalyticsRange; recentCountry: string | null } }): Promise<AnalyticsMonitorData> => {
    await requireAdminAccess("Monitoring analytics");

    const apiKey = process.env.POSTHOG_PERSONAL_API_KEY;
    const projectId = process.env.POSTHOG_PROJECT_ID;
    if (!apiKey || !projectId) {
      throw new Error("Set POSTHOG_PERSONAL_API_KEY and POSTHOG_PROJECT_ID in .env to use analytics monitoring.");
    }

    const endpoint = `https://us.posthog.com/api/projects/${projectId}/query/`;
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
      nextPromise = fetchAnalyticsMonitorDataFromPostHog({
        endpoint,
        apiKey,
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

export const Route = createFileRoute("/admin/live-backend")({
  head: () => ({
    meta: [
      { title: "Monitoring - admin" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  beforeLoad: ({ context }) => {
    if (!canUseAdminFeatures(context.auth)) {
      throw notFound();
    }
    return undefined as never;
  },
  component: LiveBackendPage,
});

function LiveBackendPage() {
  const backendUrl = getLiveBackendUrl();
  const [activeTab, setActiveTab] = useState<MonitoringTab>("backend");
  const [country, setCountry] = useState(DEFAULT_COUNTRY);
  const [status, setStatus] = useState<LiveBackendStatus | null>(null);
  const [snapshots, setSnapshots] = useState<SnapshotStats>({
    trackerScores: null,
    trackerFetchedAt: null,
    topPlays: null,
    topPlaysFetchedAt: null,
    snipes: null,
    snipesFetchedAt: null,
  });
  const [events, setEvents] = useState<LiveEventRow[]>([]);
  const [connectionState, setConnectionState] = useState<ConnectionState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const loadInFlightCountryRef = useRef<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);

  const countryCode = useMemo(() => country.trim().toUpperCase().slice(0, 2) || DEFAULT_COUNTRY, [country]);

  const load = useCallback(async (quiet = false): Promise<void> => {
    if (quiet && loadInFlightCountryRef.current === countryCode) return;
    loadInFlightCountryRef.current = countryCode;
    const requestId = ++requestIdRef.current;
    if (!quiet) setRefreshing(true);
    try {
      const nextStatus = await fetchLiveBackendAdminStatus({ data: { country: countryCode } }) as LiveBackendStatus;
      if (requestId !== requestIdRef.current) return;
      setStatus(nextStatus);
      if (nextStatus.snapshotStats) setSnapshots(nextStatus.snapshotStats);
      setError(null);
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      setError(err instanceof Error ? err.message : "Could not reach live backend.");
    } finally {
      if (requestId === requestIdRef.current) {
        loadInFlightCountryRef.current = null;
        setRefreshing(false);
      }
    }
  }, [countryCode]);

  // Status-only refresh: skips the tracker/top-plays/snipes snapshot fetches in
  // `load`, which can take tens of seconds. Used after admin actions so the
  // country pills reconcile to backend truth within ~1s instead of blocking on
  // those snapshots.
  const refreshStatus = useCallback(async (): Promise<string | null> => {
    const requestId = ++requestIdRef.current;
    try {
      const nextStatus = await fetchLiveBackendAdminStatus({ data: { country: countryCode } }) as LiveBackendStatus;
      if (requestId !== requestIdRef.current) return null;
      setStatus(nextStatus);
      if (nextStatus.snapshotStats) setSnapshots(nextStatus.snapshotStats);
      return null;
    } catch (err) {
      if (requestId !== requestIdRef.current) return null;
      return err instanceof Error ? err.message : "Could not reach live backend.";
    }
  }, [countryCode]);

  // `optimistic` patches local state before the request returns so the UI
  // updates instantly; `refreshStatus` then reconciles (and reverts a bad
  // optimistic patch) without the slow snapshot fetches `load` performs.
  const runAdminAction = useCallback(async (action: string, path: string, optimistic?: () => void) => {
    setActionBusy(action);
    optimistic?.();
    let message: string | null = null;
    try {
      await runLiveBackendAdminAction({ data: { path } });
    } catch (err) {
      message = err instanceof Error ? err.message : "Admin action failed.";
    }
    const refreshError = await refreshStatus();
    setError(message ?? refreshError);
    setActionBusy(null);
  }, [refreshStatus]);

  const patchCountryStatus = useCallback((country: string, lifecycle: CountryLifecycleStatus) => {
    setStatus((current) => {
      if (!current?.countries) return current;
      return {
        ...current,
        countries: current.countries.map((entry) =>
          entry.country === country
            ? { ...entry, status: lifecycle, isWarm: lifecycle === "paused" ? entry.isWarm : true }
            : entry,
        ),
      };
    });
  }, []);

  useEffect(() => {
    if (activeTab !== "backend") return;
    const quiet = refreshNonce > 0;
    void load(quiet);
  }, [activeTab, load, refreshNonce]);

  useEffect(() => {
    if (activeTab !== "backend") return;
    if (!autoRefresh) return;
    const id = window.setInterval(() => {
      setRefreshNonce((value) => value + 1);
    }, BACKEND_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [activeTab, autoRefresh]);

  useEffect(() => {
    if (activeTab !== "backend") {
      setConnectionState("idle");
      return;
    }
    setConnectionState("connecting");
    const source = openLiveEventSource(countryCode, { observe: true });
    if (!source) {
      setConnectionState("error");
      return;
    }
    const addEvent = (type: LiveEventName | string) => (event: MessageEvent) => {
      setConnectionState("open");
      setEvents((current) => [
        {
          id: `${type}:${event.lastEventId || Date.now()}:${Math.random().toString(36).slice(2)}`,
          type,
          receivedAt: Date.now(),
          preview: event.data,
        },
        ...current,
      ].slice(0, 50));
    };
    const listeners: Array<[LiveEventName, (event: MessageEvent) => void]> = [
      ["hello", addEvent("hello")],
      ["heartbeat", addEvent("heartbeat")],
      ["status", addEvent("status")],
      ["tracker_score", addEvent("tracker_score")],
      ["score_gain", addEvent("score_gain")],
      ["top_play", addEvent("top_play")],
      ["snipe", addEvent("snipe")],
      ["job_status", addEvent("job_status")],
    ];
    source.onopen = () => setConnectionState("open");
    source.onerror = () => setConnectionState("error");
    for (const [type, listener] of listeners) {
      source.addEventListener(type, listener);
    }
    return () => {
      for (const [type, listener] of listeners) {
        source.removeEventListener(type, listener);
      }
      source.close();
      setConnectionState("idle");
    };
  }, [activeTab, countryCode]);

  const oscFeed = getOscFeedStatus(status);
  const fallbackFeed = getScoresFallbackStatus(status);
  const osuRateTarget = status?.rate.targetPerMinute ?? status?.rate.hardPerMinute ?? 0;
  const statusLoaded = status !== null;

  return (
    <div className="flex-1">
      <LiveBackendHeader
        activeTab={activeTab}
        backendUrl={backendUrl}
        refreshing={refreshing}
        autoRefresh={autoRefresh}
        connectionState={connectionState}
        onRefresh={() => setRefreshNonce((value) => value + 1)}
        onToggleAutoRefresh={() => setAutoRefresh((value) => !value)}
      />
      <div className="bg-osu-b5 min-h-[calc(100vh-60px)]">
        <div className="max-w-[1200px] mx-auto px-4 sm:px-5 py-5 space-y-6">
          <MonitoringTabs activeTab={activeTab} onChange={setActiveTab} />
          {activeTab === "backend" ? (
            <>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-[9px] uppercase tracking-wider text-osu-f1 font-semibold">Live backend</div>
              <div className="text-[13px] text-osu-c2 mt-1">
                Always-on ingestion is server-side. Pages still fetch a snapshot on entry, then subscribe to SSE for changes.
              </div>
            </div>
            <label className="flex items-center gap-2 text-[11px] text-osu-f1">
              Country
              <input
                value={country}
                onChange={(event) => setCountry(event.target.value)}
                className="w-16 rounded-md bg-osu-b4/60 border border-osu-b3/30 px-2 py-1 text-[12px] font-mono text-white outline-none focus:border-osu-pink/40 uppercase"
                maxLength={2}
              />
            </label>
          </div>

          {error ? <ErrorBanner message={error} /> : null}

          <Section title="Health" subtitle="Is the backend up and ingesting?">
            <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
              <KpiCard
                label="Backend"
                value={statusLoaded ? status.ok ? "online" : "offline" : "loading"}
                hint={backendUrl ?? "not configured"}
                tone={statusLoaded ? status.ok ? "good" : "bad" : "neutral"}
                icon={<Server className="h-4 w-4" />}
              />
              <KpiCard
                label="Database"
                value={statusLoaded ? status.db ? "ready" : "down" : "loading"}
                hint={formatStorageHint(status)}
                tone={statusLoaded ? status.storage?.overLimit ? "bad" : status.db ? "good" : "bad" : "neutral"}
                icon={<Database className="h-4 w-4" />}
              />
              <KpiCard
                label="oSC feed"
                value={oscFeed.value}
                hint={oscFeed.hint}
                tone={oscFeed.tone}
                icon={<Radio className="h-4 w-4" />}
              />
              <KpiCard
                label="Fallback"
                value={fallbackFeed.value}
                hint={fallbackFeed.hint}
                tone={fallbackFeed.tone}
                icon={<RefreshCw className="h-4 w-4" />}
              />
              <KpiCard
                label="Queue"
                value={status?.queueDepth == null ? "—" : formatNumber(status.queueDepth)}
                hint={status?.queuePressure ? `target ${formatNumber(status.queuePressure.targetDepth)}, parked ${formatNumber(status.queuePressure.deferred ?? 0)}` : "queued / running jobs"}
                tone={status?.queuePressure?.shedding ? "warn" : "neutral"}
                icon={<Activity className="h-4 w-4" />}
              />
              <KpiCard
                label="osu! rate"
                value={status ? `${status.rate.usedLastMinute}/${osuRateTarget}` : "—"}
                hint={status ? `${status.rate.hardPerMinute} hard ceiling${status.rate.pending ? `, ${status.rate.pending} pending` : ""}` : "calls in last minute"}
                tone={status && osuRateTarget > 0 && status.rate.usedLastMinute >= osuRateTarget ? "warn" : "neutral"}
                icon={<Signal className="h-4 w-4" />}
              />
            </div>
          </Section>

          <Section title="Status" subtitle="Process, ingest, roster, and country snapshots">
            <StatusCard status={status} connectionState={connectionState} country={countryCode} snapshots={snapshots} />
          </Section>

          <Section title="Countries" subtitle="Which countries the backend is currently tracking">
            <CountriesCard
              status={status}
              busy={actionBusy}
              onSetCountryStatus={(entry, lifecycle) => {
                void runAdminAction(
                  `set-status-${entry.country}`,
                  `/api/admin/set-country-status?country=${encodeURIComponent(entry.country)}&status=${encodeURIComponent(lifecycle)}`,
                  () => patchCountryStatus(entry.country, lifecycle),
                );
              }}
              onDeleteCountry={(entry) => {
                void runAdminAction(`delete-country-${entry.country}`, `/api/admin/delete-country?country=${encodeURIComponent(entry.country)}`);
              }}
              onSetCountryTier={(entry, tier) => {
                void runAdminAction(`set-tier-${entry.country}`, `/api/admin/set-country-tier?country=${encodeURIComponent(entry.country)}&tier=${encodeURIComponent(tier)}`);
              }}
              onCatchUpCountry={(entry) => {
                void runAdminAction(
                  `catch-up-country-${entry.country}`,
                  `/api/admin/catch-up-country?country=${encodeURIComponent(entry.country)}`,
                  () => patchCountryStatus(entry.country, "active"),
                );
              }}
              onCancelCatchUpCountry={(entry) => {
                void runAdminAction(
                  `catch-up-country-${entry.country}`,
                  `/api/admin/cancel-catch-up-country?country=${encodeURIComponent(entry.country)}`,
                );
              }}
              onAddCountry={(country) => {
                void runAdminAction(`add-country-${country}`, `/api/admin/add-country?country=${encodeURIComponent(country)}`);
              }}
            />
          </Section>

          {getVisibleWorkerLanes(status).length > 0 ? (
            <Section title="Workers" subtitle="What each lane is processing right now">
              <WorkerLanesCard status={status} />
            </Section>
          ) : null}

          <Section title="Activity" subtitle="Live SSE stream and job queue pressure">
            <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
              <div className="lg:col-span-3 flex">
                <EventStreamCard events={events} connectionState={connectionState} />
              </div>
              <div className="lg:col-span-2 flex">
                <QueueSummaryCard status={status} />
              </div>
            </div>
          </Section>

          <Section title="Traffic guard" subtitle="In-memory abuse guard pressure for public traffic and SSE connections">
            <AbuseGuardCard status={status} />
          </Section>

          <Section title="osu! API pressure" subtitle="Who and what is burning rate-limit budget">
            <RateBreakdownCard status={status} />
          </Section>

          <Section title="Controls" subtitle="Admin actions for routine backend maintenance.">
            <ControlsCard
              status={status}
              busy={actionBusy}
              onClearFailed={() => void runAdminAction("clear-failed", "/api/admin/clear-failed-jobs")}
              onRefreshRoster={() => void runAdminAction("refresh-roster", `/api/admin/refresh-roster?country=${encodeURIComponent(countryCode)}`)}
              onRunRetention={() => void runAdminAction("retention", "/api/admin/run-retention")}
              onOscSmoke={() => void runAdminAction("osc-smoke", "/api/admin/osc-smoke")}
              onRunOscBackfill={() => void runAdminAction("osc-backfill", "/api/admin/run-osc-backfill")}
              onToggleWorkers={() => void runAdminAction(
                status?.worker?.paused ? "resume-workers" : "pause-workers",
                status?.worker?.paused ? "/api/admin/resume-workers" : "/api/admin/pause-workers",
              )}
            />
          </Section>
            </>
          ) : (
            <AnalyticsMonitorPanel />
          )}
        </div>
      </div>
    </div>
  );
}

function LiveBackendHeader({
  activeTab,
  backendUrl,
  refreshing,
  autoRefresh,
  connectionState,
  onRefresh,
  onToggleAutoRefresh,
}: {
  activeTab: MonitoringTab;
  backendUrl: string | null;
  refreshing: boolean;
  autoRefresh: boolean;
  connectionState: ConnectionState;
  onRefresh: () => void;
  onToggleAutoRefresh: () => void;
}) {
  const connected = activeTab === "backend" && connectionState === "open";
  const statusLabel = activeTab === "backend" ? (refreshing ? "refreshing..." : connectionState) : "analytics";
  const contextLabel = activeTab === "backend" ? backendUrl ?? "not configured" : "PostHog analytics";
  return (
    <div className="bg-osu-d5 border-b border-osu-b3/40">
      <div className="max-w-[1200px] mx-auto px-4 sm:px-5 py-3 flex items-center gap-3">
        <div className="relative flex-shrink-0">
          <span className={`block w-2.5 h-2.5 rounded-full ${connected ? "bg-osu-green-light" : "bg-osu-yellow"}`} />
          {connected ? <span className="absolute inset-0 rounded-full bg-osu-green-light animate-ping opacity-75" /> : null}
        </div>
        <h2 className="text-[13px] sm:text-[15px] font-medium text-osu-c2">Monitoring</h2>
        <span className="text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-osu-yellow/15 text-osu-yellow">
          admin
        </span>
        <span className="hidden sm:inline text-[11px] text-osu-f1 font-mono truncate">{contextLabel}</span>
        <div className="ml-auto flex items-center gap-2 text-[11px] text-osu-f1">
          <span className={refreshing && activeTab === "backend" ? "text-osu-pink-light" : ""}>{statusLabel}</span>
          {activeTab === "backend" ? (
            <>
              <button
                onClick={onRefresh}
                disabled={refreshing}
                className="inline-flex items-center justify-center h-7 w-7 rounded-md bg-osu-b4/60 border border-osu-b3/30 text-osu-l2 hover:bg-osu-b3/60 hover:text-white transition-colors duration-[120ms] disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                title="Refresh"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
              </button>
              <button
                onClick={onToggleAutoRefresh}
                className={`px-2.5 py-1 rounded-md border transition-colors duration-[120ms] cursor-pointer ${
                  autoRefresh
                    ? "bg-osu-pink/15 border-osu-pink/30 text-white"
                    : "bg-osu-b4/60 border-osu-b3/30 text-osu-l2 hover:bg-osu-b3/60 hover:text-white"
                }`}
              >
                Auto {autoRefresh ? "on" : "off"}
              </button>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function MonitoringTabs({ activeTab, onChange }: { activeTab: MonitoringTab; onChange: (tab: MonitoringTab) => void }) {
  const tabs: Array<{ value: MonitoringTab; label: string; hint: string }> = [
    { value: "backend", label: "Backend", hint: "oSC, SSE, jobs, countries" },
    { value: "analytics", label: "Analytics", hint: "replays, visitors, referrers, errors" },
  ];
  return (
    <div className="rounded-lg border border-osu-b3/30 bg-osu-b4/30 p-1.5">
      <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
        {tabs.map((tab) => {
          const active = activeTab === tab.value;
          return (
            <button
              key={tab.value}
              type="button"
              onClick={() => onChange(tab.value)}
              aria-pressed={active}
              className={`rounded-md px-3 py-2 text-left transition-colors duration-[120ms] cursor-pointer ${
                active
                  ? "bg-osu-pink/15 text-white border border-osu-pink/25"
                  : "border border-transparent text-osu-l2 hover:bg-osu-b3/40 hover:text-white"
              }`}
            >
              <span className="block text-[11px] font-semibold uppercase tracking-wider">{tab.label}</span>
              <span className="mt-0.5 block text-[10px] text-osu-f1">{tab.hint}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function AnalyticsMonitorPanel() {
  const [range, setRangeState] = useState<AnalyticsRange>(ANALYTICS_DEFAULT_RANGE_HOURS);
  const [recentCountry, setRecentCountry] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [data, setData] = useState<AnalyticsMonitorData | null>(null);
  const [dataRange, setDataRange] = useState<AnalyticsRange | null>(null);
  const [dataRecentCountry, setDataRecentCountry] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const mountedRef = useRef(true);
  const requestIdRef = useRef(0);
  const hasLoadedRef = useRef(false);

  const setRange = useCallback((next: AnalyticsRange) => {
    const normalized = clampAnalyticsRangeHours(next);
    setRangeState(normalized);
    setRecentCountry(null);
    try {
      window.localStorage.setItem(ANALYTICS_RANGE_STORAGE_KEY, String(normalized));
    } catch {
      // ignore
    }
  }, []);

  const load = useCallback(
    async (targetRange: AnalyticsRange, targetRecentCountry: string | null, isInitial: boolean) => {
      const requestId = ++requestIdRef.current;
      if (!isInitial) setRefreshing(true);
      try {
        const result = await getAnalyticsMonitorData({ data: { rangeHours: targetRange, recentCountry: targetRecentCountry } });
        if (!mountedRef.current) return;
        if (requestId !== requestIdRef.current) return;
        setData(result);
        setDataRange(targetRange);
        setDataRecentCountry(targetRecentCountry);
        setError(null);
        hasLoadedRef.current = true;
        if (result.cacheState !== "fresh") {
          window.setTimeout(() => {
            if (!mountedRef.current) return;
            if (requestId !== requestIdRef.current) return;
            void load(targetRange, targetRecentCountry, false);
          }, ANALYTICS_COLD_RESPONSE_BUDGET_MS);
        }
      } catch (err) {
        if (!mountedRef.current) return;
        if (requestId !== requestIdRef.current) return;
        setError(err instanceof Error ? err.message : "Could not load analytics monitoring.");
      } finally {
        if (!mountedRef.current) return;
        if (requestId !== requestIdRef.current) return;
        setRefreshing(false);
      }
    },
    [],
  );

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(ANALYTICS_RANGE_STORAGE_KEY);
      const storedRange = parseAnalyticsRangeHours(stored);
      if (storedRange) {
        setRangeState(storedRange);
      }
    } catch {
      // ignore
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    const delay = hasLoadedRef.current ? 250 : 0;
    const id = window.setTimeout(() => {
      void load(range, recentCountry, true);
    }, delay);
    return () => window.clearTimeout(id);
  }, [hydrated, range, recentCountry, load]);

  useEffect(() => {
    if (!hydrated) return;
    if (!autoRefresh) return;
    const id = window.setInterval(() => {
      void load(range, recentCountry, false);
    }, ANALYTICS_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [hydrated, autoRefresh, range, recentCountry, load]);

  const currentData = data && dataRange === range ? data : null;
  const isRecentCountryPending = Boolean(currentData && dataRecentCountry !== recentCountry);
  const statusData = currentData ?? data;
  const statusText = statusData?.fetchedAt
    ? statusData.cacheState === "warming"
      ? "warming..."
      : refreshing
        ? "refreshing..."
        : statusData.cacheState === "stale"
          ? `cached ${formatTimeAgo(new Date(statusData.fetchedAt).toISOString())}`
          : `updated ${formatTimeAgo(new Date(statusData.fetchedAt).toISOString())}`
    : null;
  const statusColorClass = statusData?.cacheState === "warming" || refreshing
    ? "text-osu-pink-light"
    : statusData?.cacheState === "stale"
      ? "text-osu-yellow"
      : "text-osu-f1";

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="text-[9px] uppercase tracking-wider text-osu-f1 font-semibold">Analytics</div>
          <div className="text-[13px] text-osu-c2 mt-1">
            Replay views, visitor geography, referrers, recent events, and PostHog-captured server errors.
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {statusText ? (
            <span className={`text-[11px] ${statusColorClass}`}>
              {statusText}
            </span>
          ) : null}
          <button
            type="button"
            onClick={() => void load(range, recentCountry, false)}
            disabled={refreshing}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-osu-b3/30 bg-osu-b4/60 text-osu-l2 transition-colors duration-[120ms] hover:bg-osu-b3/60 hover:text-white disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
            title="Refresh analytics"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
          </button>
          <button
            type="button"
            onClick={() => setAutoRefresh((value) => !value)}
            className={`px-2.5 py-1 rounded-md border text-[11px] transition-colors duration-[120ms] cursor-pointer ${
              autoRefresh
                ? "bg-osu-pink/15 border-osu-pink/30 text-white"
                : "bg-osu-b4/60 border-osu-b3/30 text-osu-l2 hover:bg-osu-b3/60 hover:text-white"
            }`}
          >
            Auto {autoRefresh ? "on" : "off"}
          </button>
        </div>
      </div>

      <AnalyticsRangeSelector range={range} onChange={setRange} />
      {error ? <AnalyticsErrorBanner message={error} /> : null}
      {currentData?.cacheState === "warming" ? (
        <AnalyticsInfoBanner message="PostHog is still preparing this range; the view will fill in automatically." />
      ) : null}

      {currentData ? (
        <>
          <AnalyticsKpiRow data={currentData} range={range} />
          <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
            <div className="lg:col-span-3 flex">
              <AnalyticsTopReplaysCard rows={currentData.topReplays} range={range} />
            </div>
            <div className="lg:col-span-2 flex">
              <AnalyticsRecentEventsCard
                rows={currentData.recentEvents}
                countries={currentData.topPhysicalCountries}
                country={recentCountry}
                loading={isRecentCountryPending}
                onCountryChange={setRecentCountry}
              />
            </div>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <AnalyticsCountriesCard
              title="Physical country"
              subtitle={`unique visitors, ${formatAnalyticsRangeLabel(range).toLowerCase()}`}
              rows={currentData.topPhysicalCountries}
            />
            <AnalyticsReferrersCard rows={currentData.topReferrers} range={range} />
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <AnalyticsServerErrorsCard
              rows={currentData.serverErrors}
              recent={currentData.recentServerErrors}
              range={range}
            />
            <AnalyticsTopRoutesCard rows={currentData.topRoutes} range={range} />
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <AnalyticsTopProfilesCard rows={currentData.topProfiles} range={range} />
          </div>
        </>
      ) : (
        <AnalyticsLoadingGrid />
      )}
    </div>
  );
}

const ANALYTICS_RANGE_THUMB_PX = 14;

function AnalyticsRangeSelector({ range, onChange }: { range: AnalyticsRange; onChange: (range: AnalyticsRange) => void }) {
  const stepIndex = getAnalyticsRangeStepIndex(range);
  const lastStep = ANALYTICS_RANGE_STEPS.length - 1;
  const fraction = lastStep > 0 ? stepIndex / lastStep : 0;
  const rangeLabel = formatAnalyticsRangeLabel(range);
  const presetSteps = new Set(ANALYTICS_RANGE_PRESETS.map((entry) => getAnalyticsRangeStepIndex(entry)));
  // The native thumb travels between its own half-widths, so a raw percentage
  // fill drifts from the thumb at the ends. Offset by the thumb radius to track it.
  const offsetFor = (f: number) => `calc(${f * 100}% + ${(0.5 - f) * ANALYTICS_RANGE_THUMB_PX}px)`;

  return (
    <div className="rounded-lg bg-osu-b4/40 border border-osu-b3/30 p-3">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-baseline gap-2">
          <div className="text-[9px] uppercase tracking-wider text-osu-f1 font-semibold">Range</div>
          <div className="text-[13px] font-semibold text-white">{rangeLabel}</div>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {ANALYTICS_RANGE_PRESETS.map((entry) => {
            const active = clampAnalyticsRangeHours(entry) === clampAnalyticsRangeHours(range);
            return (
              <button
                key={entry}
                type="button"
                onClick={() => onChange(entry)}
                className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors duration-[120ms] cursor-pointer ${
                  active
                    ? "bg-osu-pink/20 text-white"
                    : "text-osu-l2 hover:text-white hover:bg-osu-b3/40"
                }`}
              >
                {formatAnalyticsRangeChipLabel(entry)}
              </button>
            );
          })}
        </div>
      </div>

      <div className="mt-4 flex items-center gap-3">
        <span className="w-7 shrink-0 text-right text-[10px] font-mono text-osu-f1">1h</span>
        <div className="relative h-5 min-w-0 flex-1">
          {/* base track */}
          <div className="pointer-events-none absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-osu-b3/70" />
          {/* filled portion up to the thumb */}
          <div
            className="pointer-events-none absolute left-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-osu-pink"
            style={{ width: offsetFor(fraction) }}
          />
          {/* tick marks: taller + brighter on preset stops */}
          {ANALYTICS_RANGE_STEPS.map((_, index) => {
            const f = lastStep > 0 ? index / lastStep : 0;
            const isPreset = presetSteps.has(index);
            const passed = index <= stepIndex;
            return (
              <span
                key={index}
                className={`pointer-events-none absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full ${
                  isPreset ? "h-2.5 w-0.5" : "h-1.5 w-px"
                } ${passed ? "bg-osu-pink-light/70" : isPreset ? "bg-osu-f1/80" : "bg-osu-f1/40"}`}
                style={{ left: offsetFor(f) }}
              />
            );
          })}
          <input
            type="range"
            min={0}
            max={lastStep}
            step={1}
            value={stepIndex}
            onChange={(event) => {
              const nextStep = ANALYTICS_RANGE_STEPS[Number(event.currentTarget.value)];
              if (nextStep) onChange(nextStep);
            }}
            aria-label="Analytics range"
            aria-valuetext={rangeLabel}
            className="absolute inset-0 h-full w-full cursor-pointer appearance-none bg-transparent
              [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-white [&::-webkit-slider-thumb]:bg-osu-pink [&::-webkit-slider-thumb]:transition-transform [&::-webkit-slider-thumb]:cursor-grab hover:[&::-webkit-slider-thumb]:scale-110 active:[&::-webkit-slider-thumb]:cursor-grabbing
              [&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:w-3.5 [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-white [&::-moz-range-thumb]:bg-osu-pink [&::-moz-range-thumb]:cursor-grab"
          />
        </div>
        <span className="w-8 shrink-0 text-[10px] font-mono text-osu-f1">30d</span>
      </div>
    </div>
  );
}

function AnalyticsKpiRow({ data, range }: { data: AnalyticsMonitorData; range: AnalyticsRange }) {
  const hint = formatAnalyticsRangeLabel(range).toLowerCase();
  const bouncePct = data.bounce.landers > 0
    ? Math.round((data.bounce.bounced / data.bounce.landers) * 100)
    : null;
  const bounceLabel = bouncePct == null ? "—" : `${bouncePct}%`;
  const bounceHint = data.bounce.landers > 0
    ? `${formatNumber(data.bounce.bounced)} / ${formatNumber(data.bounce.landers)} landers`
    : `no landers ${hint}`;
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
      <AnalyticsKpiCard label="Active now" hint="last 5 min" value={data.activeVisitors} accent="pink" />
      <AnalyticsKpiCard label="Pageviews" hint={hint} value={data.pageviewsInRange} />
      <AnalyticsKpiCard label="Visitors" hint={hint} value={data.uniqueVisitorsInRange} />
      <AnalyticsKpiCard label="Events" hint={hint} value={data.eventsInRange} />
      <AnalyticsKpiCard label="Bounce" hint={bounceHint} display={bounceLabel} />
    </div>
  );
}

function AnalyticsKpiCard({
  label,
  hint,
  value,
  display,
  accent,
}: {
  label: string;
  hint: string;
  value?: number;
  display?: string;
  accent?: "pink";
}) {
  const rendered = display ?? (value != null ? formatNumber(value) : "—");
  return (
    <div className={`rounded-lg border px-4 py-3 ${accent === "pink" ? "bg-osu-pink/10 border-osu-pink/25" : "bg-osu-b4/40 border-osu-b3/30"}`}>
      <div className="text-[9px] uppercase tracking-wider text-osu-f1 font-semibold">{label}</div>
      <div className={`text-3xl font-bold leading-none mt-1 ${accent === "pink" ? "text-osu-pink-light" : "text-white"}`}>
        {rendered}
      </div>
      <div className="text-[10px] text-osu-f1 mt-1.5 truncate">{hint}</div>
    </div>
  );
}

function AnalyticsTopRoutesCard({ rows, range }: { rows: AnalyticsTopRouteRow[]; range: AnalyticsRange }) {
  const max = Math.max(1, ...rows.map((row) => row.count));
  return (
    <SectionCard title="Top routes" subtitle={`pageviews, ${formatAnalyticsRangeLabel(range).toLowerCase()}`}>
      {rows.length === 0 ? (
        <AnalyticsEmptyMessage text="No pageviews captured yet." />
      ) : (
        <div className="flex flex-col gap-1.5 h-full">
          {rows.map((row) => {
            const pct = Math.max(3, Math.round((row.count / max) * 100));
            return (
              <div key={row.path} className="relative rounded-md bg-osu-b5/60 border border-osu-b3/20 overflow-hidden flex-1 min-h-[32px]">
                <div className="absolute inset-y-0 left-0 bg-gradient-to-r from-osu-pink/25 to-osu-pink/10" style={{ width: `${pct}%` }} />
                <div className="relative px-3 h-full flex items-center justify-between gap-3">
                  <span className="text-[11px] font-mono text-osu-c2 truncate">{row.path || "(unknown)"}</span>
                  <span className="text-[11px] font-bold text-white flex-shrink-0">{formatNumber(row.count)}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </SectionCard>
  );
}

const ANALYTICS_MAPS_TAB_LABELS: Record<string, string> = {
  farmed: "Most farmed",
  popular: "Widely played",
  favourites: "Community favorites",
  random: "Random picks",
};

function formatAnalyticsMapsTab(tab: string | null): string {
  if (!tab) return ANALYTICS_MAPS_TAB_LABELS.farmed;
  return ANALYTICS_MAPS_TAB_LABELS[tab] ?? tab;
}

function formatAnalyticsRecentEventLabel(row: AnalyticsRecentEventRow): string {
  const path = row.path || "";
  if (!path || path === "/") return "Home";
  if (path === "/maps") return `Maps / ${formatAnalyticsMapsTab(row.mapsTab)}`;
  if (path === "/rankings") return row.rankingsPage ? `Rankings · p${row.rankingsPage}` : "Rankings";
  if (path.startsWith("/player/")) return row.profileUsername ? `Player · ${row.profileUsername}` : "Player";
  if (path === "/top-plays") return "Top plays";
  if (path === "/tracker") return "Tracker";
  if (path === "/replay") {
    if (row.replayPlayer) return `Replay / ${row.replayPlayer}`;
    if (row.replayScoreId) return `Replay / #${row.replayScoreId.slice(-6)}`;
    return "Replay";
  }
  if (path === "/snipes") return "Snipes";
  return path;
}

const VISITOR_COLORS = [
  { bg: "bg-osu-pink/15", text: "text-osu-pink-light", dot: "bg-osu-pink" },
  { bg: "bg-osu-blue/15", text: "text-osu-blue", dot: "bg-osu-blue" },
  { bg: "bg-osu-green-light/15", text: "text-osu-green-light", dot: "bg-osu-green-light" },
  { bg: "bg-osu-yellow/15", text: "text-osu-yellow", dot: "bg-osu-yellow" },
  { bg: "bg-osu-c2/15", text: "text-osu-c2", dot: "bg-osu-c2" },
  { bg: "bg-osu-red-light/15", text: "text-osu-red-light", dot: "bg-osu-red-light" },
] as const;

function buildVisitorPalette(rows: AnalyticsRecentEventRow[]): Map<string, { slot: number; label: string }> {
  const palette = new Map<string, { slot: number; label: string }>();
  let nextSlot = 0;
  for (const row of rows) {
    const id = row.distinctId;
    if (!id || palette.has(id)) continue;
    palette.set(id, { slot: nextSlot, label: `V${nextSlot + 1}` });
    nextSlot += 1;
  }
  return palette;
}

function AnalyticsVisitorDeviceIcon({ deviceKind }: { deviceKind: AnalyticsDeviceKind }) {
  if (deviceKind === "mobile") {
    return (
      <span title="Mobile visitor" aria-label="Mobile visitor" className="inline-flex h-3 w-3 flex-shrink-0 items-center justify-center text-osu-f1/75">
        <Smartphone className="h-3 w-3" aria-hidden="true" />
      </span>
    );
  }
  if (deviceKind === "desktop") {
    return (
      <span title="Desktop visitor" aria-label="Desktop visitor" className="inline-flex h-3 w-3 flex-shrink-0 items-center justify-center text-osu-f1/75">
        <Monitor className="h-3 w-3" aria-hidden="true" />
      </span>
    );
  }
  return <span className="h-3 w-3 flex-shrink-0" aria-hidden="true" />;
}

function AnalyticsRecentEventsCard({
  rows,
  countries,
  country,
  loading,
  onCountryChange,
}: {
  rows: AnalyticsRecentEventRow[];
  countries: AnalyticsCountryRow[];
  country: string | null;
  loading?: boolean;
  onCountryChange: (country: string | null) => void;
}) {
  const visitorPalette = useMemo(() => buildVisitorPalette(rows), [rows]);
  const countryOptions = useMemo(() => {
    const byCountry = new Map<string, AnalyticsCountryRow>();
    countries.forEach((entry) => {
      const code = entry.country.trim().toUpperCase();
      if (code) byCountry.set(code, { ...entry, country: code });
    });
    if (country && !byCountry.has(country)) {
      byCountry.set(country, { country, count: 0 });
    }
    return Array.from(byCountry.values());
  }, [countries, country]);
  const visitorCount = visitorPalette.size;
  const countryLabel = country ? ` in ${getCountryName(country) || country}` : "";
  const subtitle = loading
    ? `loading${countryLabel || " all countries"}...`
    : `last ${rows.length}${countryLabel} from ${visitorCount} visitor${visitorCount === 1 ? "" : "s"}`;
  return (
    <SectionCard
      title="Recent activity"
      subtitle={subtitle}
      actions={
        <AnalyticsCountryFilter
          country={country}
          options={countryOptions}
          onChange={onCountryChange}
        />
      }
    >
      {loading ? (
        <div className="space-y-1 h-full max-h-[420px] overflow-hidden pr-1">
          {Array.from({ length: 10 }).map((_, index) => (
            <div key={index} className="skeleton-pulse h-[30px] rounded-md" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <AnalyticsEmptyMessage text={country ? "No events captured for this country in the selected range." : "No events captured yet."} />
      ) : (
        <div className="space-y-1 h-full max-h-[420px] overflow-y-auto pr-1">
          {rows.map((row, index) => {
            const entry = row.distinctId ? visitorPalette.get(row.distinctId) : undefined;
            const color = entry ? VISITOR_COLORS[entry.slot % VISITOR_COLORS.length] : null;
            const visitorLabel = entry?.label ?? "—";
            return (
              <div
                key={`${row.timestamp}-${index}`}
                className="flex items-center gap-2 text-[10px] py-1.5 px-2 rounded-md hover:bg-osu-b3/30 transition-colors duration-[100ms]"
                title={row.distinctId ? `visitor id: ${row.distinctId}${row.path ? ` · ${row.path}` : ""}` : row.path || ""}
              >
                <span className={`w-1 self-stretch rounded-full flex-shrink-0 ${color?.dot ?? "bg-osu-b3/40"}`} />
                <span className="text-osu-f1 font-mono w-20 flex-shrink-0">{row.timestamp || "—"}</span>
                {row.country ? (
                  <CountryFlag code={row.country} size="xs" />
                ) : (
                  <span className="h-[10px] w-[15px] rounded-[1px] bg-osu-b3/40 flex-shrink-0" />
                )}
                <AnalyticsVisitorDeviceIcon deviceKind={row.deviceKind} />
                <span className="text-osu-c2 truncate flex-1">{formatAnalyticsRecentEventLabel(row)}</span>
                <span className={`font-mono font-semibold px-1.5 py-0.5 rounded flex-shrink-0 ${color ? `${color.bg} ${color.text}` : "text-osu-f1"}`}>
                  {visitorLabel}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </SectionCard>
  );
}

function AnalyticsCountryFilter({
  country,
  options,
  onChange,
}: {
  country: string | null;
  options: AnalyticsCountryRow[];
  onChange: (country: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const select = (next: string | null) => {
    onChange(next);
    setOpen(false);
  };

  const activeName = country ? getCountryName(country) || country : null;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Filter recent activity by physical country"
        className={`flex h-7 max-w-[180px] items-center gap-1.5 rounded-md border px-2 text-[10px] font-semibold transition-colors duration-[120ms] cursor-pointer ${
          country
            ? "border-osu-pink/40 bg-osu-pink/15 text-white"
            : "border-osu-b3/30 bg-osu-b5/70 text-osu-c2 hover:border-osu-b3/60 hover:text-white"
        }`}
      >
        {country ? (
          <CountryFlag code={country} size="xs" decorative />
        ) : null}
        <span className="truncate">{activeName ?? "All countries"}</span>
        <ChevronDown className={`h-3 w-3 flex-shrink-0 text-osu-f1 transition-transform duration-150 ${open ? "rotate-180" : ""}`} />
      </button>

      {open ? (
        <div
          role="listbox"
          className="absolute right-0 top-full z-50 mt-1 max-h-[280px] w-52 overflow-y-auto overscroll-contain rounded-lg border border-osu-b3/50 bg-osu-b5 py-1 shadow-[0_10px_25px_rgba(0,0,0,0.5)]"
        >
          <AnalyticsCountryOption
            label="All countries"
            selected={country == null}
            onSelect={() => select(null)}
          />
          {options.length > 0 ? <div className="my-1 h-px bg-osu-b3/30" /> : null}
          {options.map((entry) => (
            <AnalyticsCountryOption
              key={entry.country}
              code={entry.country}
              label={getCountryName(entry.country) || entry.country}
              count={entry.count}
              selected={country === entry.country}
              onSelect={() => select(entry.country)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function AnalyticsCountryOption({
  code,
  label,
  count,
  selected,
  onSelect,
}: {
  code?: string;
  label: string;
  count?: number;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onMouseDown={(event) => {
        event.preventDefault();
        onSelect();
      }}
      className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors duration-[80ms] cursor-pointer ${
        selected ? "bg-osu-pink/15 text-white" : "text-osu-l2 hover:bg-osu-b3/50 hover:text-white"
      }`}
    >
      {code ? (
        <CountryFlag code={code} size="xs" decorative />
      ) : (
        <span className="h-[10px] w-[15px] flex-shrink-0" />
      )}
      <span className="flex-1 truncate text-[11px] font-medium">{label}</span>
      {count != null ? (
        <span className="font-mono text-[10px] text-osu-f1">{formatNumber(count)}</span>
      ) : null}
      {selected ? <Check className="h-3 w-3 flex-shrink-0 text-osu-pink" /> : null}
    </button>
  );
}

function AnalyticsCountriesCard({ title, subtitle, rows }: { title: string; subtitle: string; rows: AnalyticsCountryRow[] }) {
  const max = Math.max(1, ...rows.map((row) => row.count));
  return (
    <SectionCard title={title} subtitle={subtitle}>
      {rows.length === 0 ? (
        <AnalyticsEmptyMessage text="No country data yet." />
      ) : (
        <div className="space-y-1.5">
          {rows.map((row) => {
            const pct = Math.max(3, Math.round((row.count / max) * 100));
            const code = row.country.toUpperCase();
            return (
              <div key={code} className="relative rounded-md bg-osu-b5/60 border border-osu-b3/20 overflow-hidden">
                <div className="absolute inset-y-0 left-0 bg-gradient-to-r from-osu-blue/20 to-osu-blue/5" style={{ width: `${pct}%` }} />
                <div className="relative px-3 py-2 flex items-center gap-2.5">
                  <CountryFlag code={code} size="sm" />
                  <span className="text-[11px] text-osu-c2 flex-1 truncate">{getCountryName(code) || code}</span>
                  <span className="text-[11px] font-bold text-white flex-shrink-0">{formatNumber(row.count)}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </SectionCard>
  );
}

function AnalyticsInlineCountryFlag({ country }: { country: string | null }) {
  const code = country?.trim().toUpperCase().slice(0, 2);
  if (!code) return null;
  return (
    <CountryFlag code={code} size="xs" />
  );
}

function AnalyticsTopProfilesCard({ rows, range }: { rows: AnalyticsTopProfileRow[]; range: AnalyticsRange }) {
  const max = Math.max(1, ...rows.map((row) => row.views));
  return (
    <SectionCard title="Top profile visits" subtitle={formatAnalyticsRangeLabel(range).toLowerCase()}>
      {rows.length === 0 ? (
        <AnalyticsEmptyMessage text="No profile visits yet." />
      ) : (
        <div className="space-y-1.5">
          {rows.map((row) => {
            const pct = Math.max(3, Math.round((row.views / max) * 100));
            return (
              <div key={row.username} className="relative rounded-md bg-osu-b5/60 border border-osu-b3/20 overflow-hidden">
                <div className="absolute inset-y-0 left-0 bg-gradient-to-r from-osu-purple/20 to-osu-purple/5" style={{ width: `${pct}%` }} />
                <div className="relative px-3 py-2 flex items-center justify-between gap-3">
                  <span className="min-w-0 flex-1 truncate text-[11px] text-osu-c2">
                    {row.username}
                    {row.lastViewedLabel ? (
                      <span className="text-osu-f1">
                        {" "}· last visited {row.lastViewedLabel} <AnalyticsInlineCountryFlag country={row.lastVisitorCountry} />
                      </span>
                    ) : null}
                  </span>
                  <span className="text-[11px] font-bold text-white flex-shrink-0">{formatNumber(row.views)}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </SectionCard>
  );
}

function AnalyticsTopReplaysCard({ rows, range }: { rows: AnalyticsTopReplayRow[]; range: AnalyticsRange }) {
  const max = Math.max(1, ...rows.map((row) => row.views));
  return (
    <SectionCard title="Top replay views" subtitle={`each replay open, ${formatAnalyticsRangeLabel(range).toLowerCase()}`}>
      {rows.length === 0 ? (
        <AnalyticsEmptyMessage text="No replays opened yet." />
      ) : (
        <div className="space-y-1.5">
          {rows.map((row) => {
            const pct = Math.max(3, Math.round((row.views / max) * 100));
            const primary = row.title && row.artist
              ? `${row.artist} - ${row.title}`
              : row.title ?? `#${row.scoreId.slice(-6)}`;
            return (
              <div key={row.scoreId} className="relative rounded-md bg-osu-b5/60 border border-osu-b3/20 overflow-hidden">
                <div className="absolute inset-y-0 left-0 bg-gradient-to-r from-osu-yellow/20 to-osu-yellow/5" style={{ width: `${pct}%` }} />
                <div className="relative px-2 py-1.5 flex items-center gap-2.5 min-w-0">
                  {row.coverUrl ? (
                    <img src={row.coverUrl} alt="" className="w-[56px] h-[34px] object-cover rounded-[2px] flex-shrink-0 border border-osu-b3/30" loading="lazy" />
                  ) : (
                    <div className="w-[56px] h-[34px] rounded-[2px] bg-osu-b3/30 flex-shrink-0" />
                  )}
                  <div className="flex-1 min-w-0 leading-tight">
                    <div className="text-[11px] text-white truncate font-medium">{primary}</div>
                    <div className="mt-0.5 flex min-w-0 items-center gap-1 truncate text-[9px] text-osu-f1">
                      {row.difficulty ? <span className="text-osu-c2">[{row.difficulty}]</span> : null}
                      {row.difficulty && (row.player || row.lastViewedLabel) ? <span>·</span> : null}
                      {row.player ? <span className="truncate">{row.player}</span> : null}
                      {row.player && row.lastViewedLabel ? <span>·</span> : null}
                      {row.lastViewedLabel ? (
                        <>
                          <span className="flex-shrink-0">last viewed {row.lastViewedLabel}</span>
                          <AnalyticsInlineCountryFlag country={row.lastVisitorCountry} />
                        </>
                      ) : null}
                    </div>
                  </div>
                  <span className="text-[12px] font-bold text-white flex-shrink-0">{formatNumber(row.views)}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </SectionCard>
  );
}

const FRIENDLY_REFERRER_LABELS: Record<string, string> = {
  $direct: "Direct visit",
  "google.com": "Google Search",
  "www.google.com": "Google Search",
  "google.co.uk": "Google Search",
  "google.com.br": "Google Search",
  "duckduckgo.com": "DuckDuckGo",
  "bing.com": "Bing",
  "osu.ppy.sh": "osu! site",
  "old.reddit.com": "Reddit",
  "www.reddit.com": "Reddit",
  "reddit.com": "Reddit",
  "out.reddit.com": "Reddit link out",
  "t.co": "Twitter / X",
  "x.com": "Twitter / X",
  "twitter.com": "Twitter / X",
  "discord.com": "Discord",
  "discordapp.com": "Discord",
  "www.youtube.com": "YouTube",
  "youtube.com": "YouTube",
  "m.youtube.com": "YouTube mobile",
  "github.com": "GitHub",
};

function formatReferrerLabel(domain: string): string {
  const friendly = FRIENDLY_REFERRER_LABELS[domain];
  if (friendly) return friendly;
  if (/-aleju03s-projects\.vercel\.app$/.test(domain)) {
    return `${domain.replace(/^maniacr-tracker-/, "")} preview`;
  }
  if (domain.endsWith(".vercel.app")) return `${domain} vercel`;
  return domain.replace(/^www\./, "");
}

function AnalyticsReferrersCard({ rows, range }: { rows: AnalyticsReferrerRow[]; range: AnalyticsRange }) {
  const max = Math.max(1, ...rows.map((row) => row.count));
  return (
    <SectionCard title="Top referrers" subtitle={`unique visitors by referring domain, ${formatAnalyticsRangeLabel(range).toLowerCase()}`}>
      {rows.length === 0 ? (
        <AnalyticsEmptyMessage text="No external referrers captured yet." />
      ) : (
        <div className="space-y-1.5">
          {rows.map((row) => {
            const pct = Math.max(3, Math.round((row.count / max) * 100));
            const label = formatReferrerLabel(row.domain);
            const isDirect = row.domain === "$direct";
            return (
              <div key={row.domain} className="relative rounded-md bg-osu-b5/60 border border-osu-b3/20 overflow-hidden" title={isDirect ? "" : row.domain}>
                <div className="absolute inset-y-0 left-0 bg-gradient-to-r from-osu-green-light/20 to-osu-green-light/5" style={{ width: `${pct}%` }} />
                <div className="relative px-3 py-2 flex items-center justify-between gap-3">
                  <span className={`text-[11px] truncate ${isDirect ? "italic text-osu-f1" : "text-osu-c2"}`}>{label}</span>
                  <span className="text-[11px] font-bold text-white flex-shrink-0">{formatNumber(row.count)}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </SectionCard>
  );
}

function analyticsStatusColorClass(status: number | null): string {
  if (status == null || status >= 500) return "text-osu-red-light";
  if (status === 429) return "text-osu-yellow";
  if (status === 401 || status === 403) return "text-osu-pink-light";
  if (status === 404) return "text-osu-l2";
  return "text-osu-c2";
}

function formatRateLimitContext(row: AnalyticsRecentServerErrorRow): string | null {
  const parts: string[] = [];
  if (row.ratePerMin != null && Number.isFinite(row.ratePerMin)) {
    parts.push(`${formatNumber(row.ratePerMin)}/min`);
  }
  if (row.rateRemaining != null && Number.isFinite(row.rateRemaining) && row.rateLimit != null && Number.isFinite(row.rateLimit)) {
    parts.push(`${formatNumber(row.rateRemaining)}/${formatNumber(row.rateLimit)} left`);
  }
  if (row.retryAfter) parts.push(`retry-after ${row.retryAfter}s`);
  return parts.length ? parts.join(" · ") : null;
}

function AnalyticsServerErrorsCard({
  rows,
  recent,
  range,
}: {
  rows: AnalyticsServerErrorRow[];
  recent: AnalyticsRecentServerErrorRow[];
  range: AnalyticsRange;
}) {
  const [showRecentLog, setShowRecentLog] = useState(false);
  const total = rows.reduce((acc, row) => acc + row.count, 0);
  const callerCounts = rows.reduce<Record<string, number>>((acc, row) => {
    acc[row.caller] = (acc[row.caller] ?? 0) + row.count;
    return acc;
  }, {});
  const callerSummary = Object.entries(callerCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 4)
    .map(([caller, count]) => `${caller}x${count}`)
    .join("  ");

  return (
    <SectionCard
      title="Server errors"
      subtitle={`osu! API failures, ${formatAnalyticsRangeLabel(range).toLowerCase()}`}
      actions={recent.length > 0 ? (
        <button
          type="button"
          onClick={() => setShowRecentLog((value) => !value)}
          className="h-7 rounded-md border border-osu-b3/30 bg-osu-b5/70 px-2 text-[10px] font-semibold text-osu-c2 transition-colors duration-[120ms] hover:border-osu-red/35 hover:bg-osu-b3/50 hover:text-white cursor-pointer"
          title={showRecentLog ? "Hide detailed recent errors" : "Show detailed recent errors"}
        >
          {showRecentLog ? "Hide log" : "Show log"}
        </button>
      ) : null}
    >
      {rows.length === 0 && recent.length === 0 ? (
        <AnalyticsEmptyMessage text="No server errors recorded." />
      ) : (
        <div className="space-y-3">
          <div className="text-[10px] text-osu-f1 font-mono">
            {formatNumber(total)} total
            {callerSummary ? <span className="ml-2 text-osu-l2/70">· {callerSummary}</span> : null}
          </div>

          {rows.length > 0 ? (
            <div>
              <div className="text-[9px] uppercase tracking-wider text-osu-f1 font-semibold mb-1.5">Grouped</div>
              <div className="space-y-1.5">
                {rows.map((row, index) => {
                  const statusLabel = row.status == null ? "no-resp" : String(row.status);
                  return (
                    <div key={`${row.caller}-${row.path}-${row.status ?? "x"}-${index}`} className="relative rounded-md bg-osu-b5/60 border border-osu-b3/20 overflow-hidden">
                      <div className="absolute inset-y-0 left-0 bg-gradient-to-r from-osu-red/20 to-osu-red/5 w-full" />
                      <div className="relative px-2.5 py-1.5 flex items-center gap-2 min-w-0">
                        <span className={`text-[10px] font-mono font-bold ${analyticsStatusColorClass(row.status)} w-12 flex-shrink-0 text-right`}>{statusLabel}</span>
                        <span className="text-[11px] text-white font-medium truncate flex-shrink-0 max-w-[40%]">{row.caller || "unknown"}</span>
                        <span className="text-[10px] font-mono text-osu-f1 truncate flex-1 min-w-0">{row.path || "(unknown)"}</span>
                        <span className="text-[11px] font-bold text-white flex-shrink-0">{formatNumber(row.count)}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}

          {recent.length > 0 && !showRecentLog ? (
            <div className="rounded-md border border-osu-b3/20 bg-osu-b5/40 px-3 py-2 text-[10px] text-osu-f1">
              Detailed recent log hidden. Use Show log when you need raw error bodies and rate-limit context.
            </div>
          ) : null}

          {recent.length > 0 && showRecentLog ? (
            <div>
              <div className="text-[9px] uppercase tracking-wider text-osu-f1 font-semibold mb-1.5">Recent log</div>
              <div className="space-y-1.5 max-h-[420px] overflow-y-auto pr-1">
                {recent.map((row, index) => {
                  const statusLabel = row.status == null ? "no-resp" : String(row.status);
                  const rateContext = formatRateLimitContext(row);
                  return (
                    <div key={`${row.timestamp}-${index}`} className="rounded-md bg-osu-b5/60 border border-osu-b3/20 overflow-hidden">
                      <div className="px-2.5 py-1.5 flex items-center gap-2 min-w-0">
                        <span className="text-[10px] font-mono text-osu-f1 w-20 flex-shrink-0">{row.timestamp || "—"}</span>
                        <span className={`text-[10px] font-mono font-bold ${analyticsStatusColorClass(row.status)} w-10 flex-shrink-0 text-right`}>{statusLabel}</span>
                        <span className="text-[11px] text-white font-medium truncate flex-shrink-0 max-w-[35%]">{row.caller || "unknown"}</span>
                        <span className="text-[10px] font-mono text-osu-f1 truncate flex-1 min-w-0">{row.path || "(unknown)"}</span>
                        {row.attempts != null && row.attempts > 1 ? <span className="text-[9px] font-mono text-osu-yellow flex-shrink-0">x{row.attempts}</span> : null}
                      </div>
                      {row.bodyPreview ? (
                        <div className="px-2.5 pb-1.5 -mt-0.5 text-[10px] font-mono text-osu-l2/70 break-all">{row.bodyPreview}</div>
                      ) : null}
                      {row.context || rateContext ? (
                        <div className="px-2.5 pb-1.5 -mt-0.5 text-[10px] font-mono text-osu-f1 break-all">
                          {row.context ? <span className="text-osu-c2">{row.context}</span> : null}
                          {row.context && rateContext ? <span className="text-osu-l2/50"> · </span> : null}
                          {rateContext ? <span className="text-osu-yellow/90">{rateContext}</span> : null}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}
        </div>
      )}
    </SectionCard>
  );
}

function AnalyticsLoadingGrid() {
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="skeleton-pulse rounded-lg h-[88px]" />
        ))}
      </div>
      <div className="skeleton-pulse rounded-lg h-[260px]" />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="skeleton-pulse rounded-lg h-[320px]" />
        <div className="skeleton-pulse rounded-lg h-[320px]" />
      </div>
    </div>
  );
}

function AnalyticsErrorBanner({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-osu-red/30 bg-osu-red/10 px-4 py-3">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-osu-red-light">Analytics error</div>
      <div className="text-[12px] text-osu-l2 mt-1 break-words">{message}</div>
    </div>
  );
}

function AnalyticsInfoBanner({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-osu-yellow/25 bg-osu-yellow/10 px-4 py-3 text-[12px] text-osu-l2">
      {message}
    </div>
  );
}

function AnalyticsEmptyMessage({ text }: { text: string }) {
  return <div className="text-[11px] text-osu-f1 text-center py-6">{text}</div>;
}

function KpiCard({
  label,
  value,
  hint,
  tone,
  icon,
}: {
  label: string;
  value: string;
  hint: string;
  tone: StatusTone;
  icon: React.ReactNode;
}) {
  const toneClass = {
    good: "text-osu-green-light bg-osu-green-light/10 border-osu-green-light/25",
    warn: "text-osu-yellow bg-osu-yellow/10 border-osu-yellow/25",
    bad: "text-osu-red-light bg-osu-red/10 border-osu-red/30",
    neutral: "text-white bg-osu-b4/40 border-osu-b3/30",
  }[tone];
  return (
    <div className={`rounded-lg border px-4 py-3 ${toneClass}`}>
      <div className="flex items-center justify-between gap-3">
        <div className="text-[9px] uppercase tracking-wider text-osu-f1 font-semibold">{label}</div>
        <div className="text-current opacity-90">{icon}</div>
      </div>
      <div className="text-2xl font-bold tracking-tight leading-none mt-2 text-current">{value}</div>
      <div className="text-[10px] text-osu-f1 mt-1.5 truncate">{hint}</div>
    </div>
  );
}

function SectionCard({
  title,
  subtitle,
  actions,
  children,
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-osu-b3/30 bg-osu-b4/30 flex flex-col w-full">
      <div className="px-4 pt-3 pb-2 border-b border-osu-b3/20">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[11px] font-semibold text-osu-c2 uppercase tracking-wider">{title}</div>
            {subtitle ? <div className="text-[10px] text-osu-f1 mt-0.5">{subtitle}</div> : null}
          </div>
          {actions ? <div className="flex-shrink-0">{actions}</div> : null}
        </div>
      </div>
      <div className="p-3 flex-1 min-h-0">{children}</div>
    </div>
  );
}

const TONE_RANK: Record<StatusTone, number> = { neutral: 0, good: 1, warn: 2, bad: 3 };

function worstTone(...tones: StatusTone[]): StatusTone {
  return tones.reduce<StatusTone>((worst, tone) => (TONE_RANK[tone] > TONE_RANK[worst] ? tone : worst), "neutral");
}

function toneDotClass(tone: StatusTone): string {
  return { good: "bg-osu-green-light", warn: "bg-osu-yellow", bad: "bg-osu-red-light", neutral: "bg-osu-b3" }[tone];
}

interface StatusStat {
  label: string;
  value: string;
  tone?: StatusTone;
}

function MiniStat({ label, value, tone = "neutral" }: StatusStat) {
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${toneDotClass(tone)}`} />
      <span className="flex-shrink-0 text-[9px] font-semibold uppercase tracking-wider text-osu-f1">{label}</span>
      <span className="truncate text-[10px] text-osu-c2">{value}</span>
    </div>
  );
}

// One process-status group: a status dot, title, and a few key stats shown
// inline (so the important info is visible at a glance). Clicking the card
// opens a modal with the full detail rows for that group.
function StatusGroupCard({ title, tone, stats, onOpen }: { title: string; tone: StatusTone; stats: StatusStat[]; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full flex-col gap-1.5 self-start rounded-md border border-osu-b3/20 bg-osu-b5/50 px-3 py-2 text-left transition-colors duration-[120ms] hover:border-osu-b3/45 hover:bg-osu-b4/30 cursor-pointer"
    >
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 flex-shrink-0 rounded-full ${toneDotClass(tone)}`} />
        <span className="min-w-0 flex-1 truncate text-[10px] font-semibold uppercase tracking-wider text-osu-c2">{title}</span>
        <span className="flex-shrink-0 text-[9px] uppercase tracking-wider text-osu-f1">more</span>
        <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-osu-f1" />
      </div>
      <div className="space-y-1 pl-4">
        {stats.map((stat) => (
          <MiniStat key={stat.label} label={stat.label} value={stat.value} tone={stat.tone} />
        ))}
      </div>
    </button>
  );
}

function StatusGroupModal({ title, tone, onClose, children }: { title: string; tone: StatusTone; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/65 px-4" onClick={onClose}>
      <div
        className="w-full max-w-[460px] overflow-hidden rounded-lg border border-osu-b3/40 bg-osu-b5 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-osu-b3/20 px-4 pt-3 pb-2">
          <span className={`block h-2 w-2 flex-shrink-0 rounded-full ${toneDotClass(tone)}`} />
          <div className="min-w-0 flex-1 text-[11px] font-semibold uppercase tracking-wider text-osu-c2">{title}</div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-osu-b3/30 bg-osu-b4/60 px-2.5 py-1 text-[11px] text-osu-l2 transition-colors duration-[120ms] hover:bg-osu-b3/60 hover:text-white cursor-pointer"
          >
            Close
          </button>
        </div>
        <div className="max-h-[70vh] space-y-1.5 overflow-y-auto p-3">{children}</div>
      </div>
    </div>
  );
}

function SnapshotRow({ label, value, fetchedAt, suffix }: { label: string; value: number | null; fetchedAt: number | null; suffix: string }) {
  return (
    <div className="rounded-md bg-osu-b5/60 border border-osu-b3/20 px-3 py-2 flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <div className="text-[11px] font-semibold text-osu-c2">{label}</div>
        <div className="text-[10px] text-osu-f1">{fetchedAt ? `fetched ${formatTimeAgo(new Date(fetchedAt).toISOString())}` : "not fetched yet"}</div>
      </div>
      <div className="text-right">
        <div className="text-[18px] leading-none font-bold text-white">{value == null ? "—" : formatNumber(value)}</div>
        <div className="text-[9px] text-osu-f1">{suffix}</div>
      </div>
    </div>
  );
}

function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return "unknown";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function formatStorageHint(status: LiveBackendStatus | null): string {
  const storage = status?.storage;
  if (!storage || storage.bytes == null) return "libSQL / SQLite";
  const total = storage.bytes + (storage.walBytes ?? 0);
  return `${formatBytes(total)} / ${formatBytes(storage.maxBytes)}`;
}

function getOscFeedStatus(status: LiveBackendStatus | null): { value: string; hint: string; tone: StatusTone; batchTone: StatusTone } {
  if (!status) return { value: "unknown", hint: "status not loaded", tone: "neutral", batchTone: "neutral" };

  if (status.osc.lastBatchAt) {
    const lastBatchMs = Date.parse(status.osc.lastBatchAt);
    const batchHint = `batch ${formatTimeAgo(status.osc.lastBatchAt)}`;
    if (!status.osc.stale && Number.isFinite(lastBatchMs) && Date.now() - lastBatchMs <= OSC_FEED_STALE_MS) {
      return { value: "receiving", hint: batchHint, tone: "good", batchTone: "good" };
    }
    return { value: "stale", hint: batchHint, tone: "bad", batchTone: "bad" };
  }

  if (status.osc.connected) {
    return { value: "no batches", hint: "socket connected; feed idle", tone: "bad", batchTone: "bad" };
  }

  return { value: "closed", hint: "socket transport closed", tone: "bad", batchTone: "bad" };
}

// The fallback poller runs on its own osu! client with a dedicated rate limiter
// (separate bucket from the main `rate`), polling at most once per `intervalMs`
// (floored at 10s, so 6/min by default) and only while the oSC feed is stale.
// `used`/`target` come straight from that limiter, reported in `scoresFallback.rate`.
interface ScoresFallbackView {
  value: string;
  hint: string;
  tone: StatusTone;
  used: number;
  target: number;
  enabled: boolean;
  polling: boolean;
}

function getScoresFallbackStatus(status: LiveBackendStatus | null): ScoresFallbackView {
  const fallback = status?.scoresFallback;
  if (!fallback) {
    return { value: "—", hint: "status not loaded", tone: "neutral", used: 0, target: 0, enabled: false, polling: false };
  }
  const used = fallback.rate?.usedLastMinute ?? 0;
  const target = fallback.rate?.targetPerMinute ?? Math.max(1, Math.round(60_000 / Math.max(10_000, fallback.intervalMs)));
  if (!fallback.enabled) {
    return { value: "off", hint: "disabled by config", tone: "neutral", used, target, enabled: false, polling: false };
  }
  const bucket = `${formatNumber(used)}/${formatNumber(target)}`;
  const result = fallback.result;
  if (!fallback.updatedAt || !result) {
    return { value: bucket, hint: `polls up to ${formatNumber(target)}/min`, tone: "neutral", used, target, enabled: true, polling: false };
  }
  if (!result.ran) {
    const reason = result.reason === "osc_fresh" ? "oSC fresh, on standby" : `${result.reason ?? "idle"}, on standby`;
    return { value: bucket, hint: reason, tone: "neutral", used, target, enabled: true, polling: false };
  }
  return {
    value: bucket,
    hint: `polling, ${formatNumber(result.inserted)} new ${formatTimeAgo(fallback.updatedAt)}`,
    tone: "warn",
    used,
    target,
    enabled: true,
    polling: true,
  };
}

function StatusCard({ status, connectionState, country, snapshots }: { status: LiveBackendStatus | null; connectionState: ConnectionState; country: string; snapshots: SnapshotStats }) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const roster = status?.roster?.find((entry) => entry.country === country);
  const oscFeed = getOscFeedStatus(status);
  const fallback = getScoresFallbackStatus(status);
  const fallbackResult = status?.scoresFallback?.result;
  const fallbackRanResult = fallbackResult?.ran ? fallbackResult : null;

  const sseTone: StatusTone = connectionState === "open" ? "good" : "warn";
  const workersTone: StatusTone = status?.worker?.paused ? "warn" : "good";
  const transportTone: StatusTone = status?.osc.connected ? "good" : "warn";
  const errorTone: StatusTone = status?.osc.lastError ? "bad" : "good";
  const rosterTone: StatusTone = roster ? "good" : "warn";

  const batchAgo = status?.osc.lastBatchAt ? formatTimeAgo(status.osc.lastBatchAt) : "no batch";
  const fallbackUpdated = status?.scoresFallback?.updatedAt ? formatTimeAgo(status.scoresFallback.updatedAt) : "never";

  const groups: Array<{ key: string; title: string; tone: StatusTone; stats: StatusStat[]; detail: React.ReactNode }> = [
    {
      key: "serving",
      title: "Serving",
      tone: worstTone(sseTone, workersTone),
      stats: [
        { label: "SSE", value: connectionState, tone: sseTone },
        { label: "Workers", value: status?.worker?.paused ? "paused" : "running", tone: workersTone },
      ],
      detail: (
        <>
          <DetailRow label="SSE client" value={connectionState} tone={sseTone} />
          <DetailRow label="Last live event" value={status?.lastEventAt ? formatTimeAgo(status.lastEventAt) : "none"} />
          <DetailRow label="Workers" value={status?.worker?.paused ? "paused" : "running"} tone={workersTone} />
          <DetailRow label="Worker id" value={status?.worker?.workerId ?? "unknown"} />
        </>
      ),
    },
    {
      key: "osc",
      title: "oSC feed",
      tone: oscFeed.tone,
      stats: [
        { label: "Status", value: oscFeed.value, tone: oscFeed.tone },
        { label: "Last batch", value: batchAgo, tone: oscFeed.batchTone },
      ],
      detail: (
        <>
          <DetailRow label="Transport" value={status?.osc.connected ? "connected" : "closed"} tone={transportTone} />
          <DetailRow label="Last batch" value={status?.osc.lastBatchAt ? formatTimeAgo(status.osc.lastBatchAt) : "none"} tone={oscFeed.batchTone} />
          <DetailRow label="Error" value={status?.osc.lastError ?? "none"} tone={errorTone} />
        </>
      ),
    },
    {
      key: "fallback",
      title: "Fallback poller",
      tone: fallback.tone,
      stats: [
        { label: "Budget", value: fallback.enabled ? `${fallback.value} per min` : "off", tone: fallback.polling ? "warn" : "neutral" },
        fallback.polling
          ? { label: "New saved", value: formatNumber(fallbackRanResult?.inserted ?? 0), tone: (fallbackRanResult?.inserted ?? 0) > 0 ? "good" : "neutral" }
          : { label: "State", value: fallback.enabled ? "standby" : "disabled" },
      ],
      detail: (
        <>
          <div className="rounded-md bg-osu-b4/30 px-3 py-2 text-[10px] leading-relaxed text-osu-f1">
            Backup score poller. Runs only while the oSC feed is stale: each poll pulls the latest osu! mania scores, keeps the ones from tracked countries, then saves any that are new.
          </div>
          <DetailRow label="Poll budget" value={`${formatNumber(fallback.used)} / ${formatNumber(fallback.target)} per min`} tone={fallback.polling ? "warn" : "neutral"} />
          <DetailRow label="Last run" value={fallbackUpdated} />
          {fallbackRanResult ? (
            <>
              <DetailRow label="Scanned from osu!" value={`${formatNumber(fallbackRanResult.fetched)} scores`} />
              <DetailRow label="In tracked countries" value={formatNumber(fallbackRanResult.candidates)} />
              <DetailRow label="New, saved to DB" value={formatNumber(fallbackRanResult.inserted)} tone={fallbackRanResult.inserted > 0 ? "good" : "neutral"} />
            </>
          ) : (
            <DetailRow label="State" value={fallback.enabled ? "on standby (oSC feed is fresh)" : "disabled by config"} />
          )}
        </>
      ),
    },
    {
      key: "roster",
      title: "Roster",
      tone: rosterTone,
      stats: [
        { label: country, value: roster ? `${formatNumber(roster.users)} users` : "not loaded", tone: rosterTone },
        { label: "Refreshed", value: roster?.refreshedAt ? formatTimeAgo(roster.refreshedAt) : "never", tone: roster?.refreshedAt ? "good" : "warn" },
      ],
      detail: (
        <>
          <DetailRow label={`${country} roster`} value={roster ? `${formatNumber(roster.users)} users` : "not loaded"} tone={rosterTone} />
          <DetailRow label="Roster refreshed" value={roster?.refreshedAt ? formatTimeAgo(roster.refreshedAt) : "never"} tone={roster?.refreshedAt ? "good" : "warn"} />
        </>
      ),
    },
    {
      key: "snapshots",
      title: "Snapshots",
      tone: "neutral",
      stats: [
        { label: "Tracker", value: snapshots.trackerScores == null ? "—" : `${formatNumber(snapshots.trackerScores)} scores` },
        { label: "Top plays", value: snapshots.topPlays == null ? "—" : `${formatNumber(snapshots.topPlays)} events` },
        { label: "Snipes", value: snapshots.snipes == null ? "—" : `${formatNumber(snapshots.snipes)} events` },
      ],
      detail: (
        <>
          <div className="rounded-md bg-osu-b4/30 px-3 py-2 text-[10px] leading-relaxed text-osu-f1">
            Row counts the {country} REST snapshot endpoints return on page entry. Tracker and snipes sit at their fetch caps, so steady numbers are expected.
          </div>
          <SnapshotRow label="Tracker" value={snapshots.trackerScores} fetchedAt={snapshots.trackerFetchedAt} suffix="scores" />
          <SnapshotRow label="Top plays" value={snapshots.topPlays} fetchedAt={snapshots.topPlaysFetchedAt} suffix="events" />
          <SnapshotRow label="Snipes" value={snapshots.snipes} fetchedAt={snapshots.snipesFetchedAt} suffix="events" />
        </>
      ),
    },
  ];
  const openGroup = groups.find((group) => group.key === openKey) ?? null;

  return (
    <SectionCard title="Process status" subtitle="Key stats per area; click a group for the full detail.">
      <div className="grid grid-cols-1 items-start gap-2 sm:grid-cols-2">
        {groups.map((group) => (
          <StatusGroupCard
            key={group.key}
            title={group.title}
            tone={group.tone}
            stats={group.stats}
            onOpen={() => setOpenKey(group.key)}
          />
        ))}
      </div>
      {openGroup ? (
        <StatusGroupModal title={openGroup.title} tone={openGroup.tone} onClose={() => setOpenKey(null)}>
          {openGroup.detail}
        </StatusGroupModal>
      ) : null}
    </SectionCard>
  );
}

type CountryEntry = NonNullable<LiveBackendStatus["countries"]>[number];
type CountryCatchupState = NonNullable<LiveBackendStatus["catchup"]>[string];
type CountryLifecycleStatus = "active" | "warm" | "paused";
type CountryDisplayStatus = "active" | "warm" | "idle" | "paused";
type CountryFeatureTier = "indexed" | "maps_warm" | "live" | "snipes";
type CountrySortMode = "status" | "active-users" | "tracked-users" | "country";

const COUNTRY_FILTERS_STORAGE_KEY = "mania-hub:admin-live-backend:country-filters:v1";
const COUNTRY_STATUS_RANK: Record<CountryDisplayStatus, number> = { active: 0, warm: 1, idle: 2, paused: 3 };
const DEFAULT_COUNTRY_STATUS_FILTERS: Record<CountryDisplayStatus, boolean> = {
  active: true,
  warm: true,
  idle: true,
  paused: true,
};
const DEFAULT_COUNTRY_TIER_FILTERS: Record<CountryFeatureTier, boolean> = {
  indexed: true,
  maps_warm: true,
  live: true,
  snipes: true,
};
const COUNTRY_STATUS_OPTIONS: Array<{ value: CountryDisplayStatus; label: string; dot: string }> = [
  { value: "active", label: "Active", dot: "bg-osu-green-light" },
  { value: "warm", label: "Warm", dot: "bg-osu-yellow" },
  { value: "idle", label: "Idle", dot: "bg-osu-red-light" },
  { value: "paused", label: "Paused", dot: "bg-osu-red-light" },
];
const COUNTRY_LIFECYCLE_OPTIONS: Array<{ value: CountryLifecycleStatus; label: string; tone: string; dot: string; blurb: string }> = [
  { value: "active", label: "Active", tone: "text-osu-green", dot: "bg-osu-green-light", blurb: "Keep it marked as actively requested." },
  { value: "warm", label: "Warm", tone: "text-osu-yellow", dot: "bg-osu-yellow", blurb: "Keep projections warm without the active marker." },
  { value: "paused", label: "Paused", tone: "text-osu-red-light", dot: "bg-osu-red-light", blurb: "Exclude it from live warmup until resumed." },
];
const COUNTRY_SORT_OPTIONS: Array<{ value: CountrySortMode; label: string }> = [
  { value: "status", label: "Lifecycle" },
  { value: "active-users", label: "Page users" },
  { value: "tracked-users", label: "Roster" },
  { value: "country", label: "Name" },
];
// Feature tiers are cumulative: each tier does everything the cheaper ones do,
// plus its own work. They cap how much the backend will do for a country.
const COUNTRY_TIER_OPTIONS: Array<{ value: CountryFeatureTier; label: string; tone: string; dot: string; blurb: string }> = [
  { value: "indexed", label: "Indexed", tone: "text-osu-f1", dot: "bg-osu-f1", blurb: "Roster + rank snapshots only (powers Rankings)" },
  { value: "maps_warm", label: "Maps", tone: "text-osu-yellow", dot: "bg-osu-yellow", blurb: "Indexed + maps warmup (farmed / favourites)" },
  { value: "live", label: "Live", tone: "text-osu-green", dot: "bg-osu-green", blurb: "Maps + live score ingest (Tracker / Top Plays)" },
  { value: "snipes", label: "Snipes", tone: "text-osu-c2", dot: "bg-osu-c2", blurb: "Live + snipe board seeding (the expensive tier)" },
];

interface CountryFilterPreferences {
  sortMode: CountrySortMode;
  statusFilters: Record<CountryDisplayStatus, boolean>;
  tierFilters: Record<CountryFeatureTier, boolean>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeCountrySortMode(value: unknown): CountrySortMode {
  return COUNTRY_SORT_OPTIONS.some((option) => option.value === value) ? value as CountrySortMode : "status";
}

function normalizeCountryStatusFilters(value: unknown): Record<CountryDisplayStatus, boolean> {
  if (!isRecord(value)) return { ...DEFAULT_COUNTRY_STATUS_FILTERS };
  const next: Record<CountryDisplayStatus, boolean> = {
    active: value.active === true,
    warm: value.warm === true,
    idle: value.idle === true,
    paused: value.paused === true,
  };
  return next.active || next.warm || next.idle || next.paused ? next : { ...DEFAULT_COUNTRY_STATUS_FILTERS };
}

function normalizeCountryTierFilters(value: unknown): Record<CountryFeatureTier, boolean> {
  if (!isRecord(value)) return { ...DEFAULT_COUNTRY_TIER_FILTERS };
  const next: Record<CountryFeatureTier, boolean> = {
    indexed: value.indexed === true,
    maps_warm: value.maps_warm === true,
    live: value.live === true,
    snipes: value.snipes === true,
  };
  return next.indexed || next.maps_warm || next.live || next.snipes ? next : { ...DEFAULT_COUNTRY_TIER_FILTERS };
}

function readCountryFilterPreferences(): CountryFilterPreferences | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(COUNTRY_FILTERS_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    return {
      sortMode: normalizeCountrySortMode(parsed.sortMode),
      statusFilters: normalizeCountryStatusFilters(parsed.statusFilters),
      tierFilters: normalizeCountryTierFilters(parsed.tierFilters),
    };
  } catch {
    return null;
  }
}

function writeCountryFilterPreferences(preferences: CountryFilterPreferences): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(COUNTRY_FILTERS_STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // Preferences are nice-to-have; localStorage can be unavailable or full.
  }
}

function CountriesCard({
  status,
  busy,
  onSetCountryStatus,
  onDeleteCountry,
  onSetCountryTier,
  onCatchUpCountry,
  onCancelCatchUpCountry,
  onAddCountry,
}: {
  status: LiveBackendStatus | null;
  busy: string | null;
  onSetCountryStatus: (entry: CountryEntry, lifecycle: CountryLifecycleStatus) => void;
  onDeleteCountry: (entry: CountryEntry) => void;
  onSetCountryTier: (entry: CountryEntry, tier: CountryFeatureTier) => void;
  onCatchUpCountry: (entry: CountryEntry) => void;
  onCancelCatchUpCountry: (entry: CountryEntry) => void;
  onAddCountry: (country: string) => void;
}) {
  const [sortMode, setSortMode] = useState<CountrySortMode>("status");
  const [addCountryCode, setAddCountryCode] = useState("");
  const [statusFilters, setStatusFilters] = useState<Record<CountryDisplayStatus, boolean>>(DEFAULT_COUNTRY_STATUS_FILTERS);
  const [tierFilters, setTierFilters] = useState<Record<CountryFeatureTier, boolean>>(DEFAULT_COUNTRY_TIER_FILTERS);
  const [preferencesLoaded, setPreferencesLoaded] = useState(false);
  const [showTierHelp, setShowTierHelp] = useState(false);
  const countries = status?.countries ?? [];

  useEffect(() => {
    const preferences = readCountryFilterPreferences();
    if (preferences) {
      setSortMode(preferences.sortMode);
      setStatusFilters(preferences.statusFilters);
      setTierFilters(preferences.tierFilters);
    }
    setPreferencesLoaded(true);
  }, []);

  useEffect(() => {
    if (!preferencesLoaded) return;
    writeCountryFilterPreferences({ sortMode, statusFilters, tierFilters });
  }, [preferencesLoaded, sortMode, statusFilters, tierFilters]);

  const rosterByCountry = useMemo(() => {
    const map = new Map<string, number>();
    for (const entry of status?.roster ?? []) map.set(entry.country, entry.users);
    return map;
  }, [status?.roster]);
  const statusCounts = useMemo(() => {
    const counts: Record<CountryDisplayStatus, number> = { active: 0, warm: 0, idle: 0, paused: 0 };
    for (const entry of countries) counts[getCountryDisplayStatus(entry)] += 1;
    return counts;
  }, [countries]);
  const tierCounts = useMemo(() => {
    const counts: Record<CountryFeatureTier, number> = { indexed: 0, maps_warm: 0, live: 0, snipes: 0 };
    for (const entry of countries) counts[getCountryFeatureTier(entry)] += 1;
    return counts;
  }, [countries]);
  const toggleFilter = (value: CountryDisplayStatus) => {
    setStatusFilters((current) => {
      const next = { ...current, [value]: !current[value] };
      // never let every filter turn off; re-enable the one just toggled
      if (!next.active && !next.warm && !next.idle && !next.paused) next[value] = true;
      return next;
    });
  };
  const toggleTierFilter = (value: CountryFeatureTier) => {
    setTierFilters((current) => {
      const next = { ...current, [value]: !current[value] };
      // never let every tier turn off; re-enable the one just toggled
      if (!next.indexed && !next.maps_warm && !next.live && !next.snipes) next[value] = true;
      return next;
    });
  };
  const sorted = useMemo(
    () => {
      const filtered = countries.filter(
        (entry) => statusFilters[getCountryDisplayStatus(entry)] && tierFilters[getCountryFeatureTier(entry)],
      );
      return filtered.sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        if (sortMode === "active-users") {
          const activeRank = (b.activeUsers ?? 0) - (a.activeUsers ?? 0);
          if (activeRank !== 0) return activeRank;
          const activityRank = new Date(b.lastActiveAt ?? b.lastRequestedAt).getTime() - new Date(a.lastActiveAt ?? a.lastRequestedAt).getTime();
          if (activityRank !== 0) return activityRank;
        } else if (sortMode === "tracked-users") {
          const userRank = (rosterByCountry.get(b.country) ?? -1) - (rosterByCountry.get(a.country) ?? -1);
          if (userRank !== 0) return userRank;
        } else if (sortMode === "status") {
          const rank = COUNTRY_STATUS_RANK[getCountryDisplayStatus(a)] - COUNTRY_STATUS_RANK[getCountryDisplayStatus(b)];
          if (rank !== 0) return rank;
        }
        return a.country.localeCompare(b.country);
      });
    },
    [countries, rosterByCountry, sortMode, statusFilters, tierFilters],
  );
  const activeCount = countries.filter((entry) => entry.status !== "paused" && entry.isWarm).length;
  const activeUsers = countries.reduce((total, entry) => total + (entry.activeUsers ?? 0), 0);
  const tierSummary = COUNTRY_TIER_OPTIONS
    .filter((tier) => tierCounts[tier.value] > 0)
    .map((tier) => `${formatNumber(tierCounts[tier.value])} ${tier.label.toLowerCase()}`)
    .join(", ");
  return (
    <SectionCard
      title="Country lifecycle and tiers"
      subtitle={
        countries.length
          ? `${formatNumber(countries.length)} known: ${tierSummary}. ${formatNumber(activeCount)} warm, ${formatNumber(activeUsers)} page users connected now.`
          : "Country registry not loaded yet."
      }
    >
      <div className="mb-3 flex flex-col gap-2.5 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-1.5 text-[9px] font-semibold uppercase tracking-wider text-osu-f1">
            Lifecycle
            <div className="flex max-w-full flex-wrap items-center gap-1 rounded-md border border-osu-b3/25 bg-osu-b5/50 p-1">
              {COUNTRY_STATUS_OPTIONS.map((option) => {
                const on = statusFilters[option.value];
                const count = statusCounts[option.value];
                return (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => toggleFilter(option.value)}
                    aria-pressed={on}
                    className={`group flex items-center gap-1.5 rounded px-2 py-1 text-[10px] font-semibold uppercase tracking-wider transition-colors duration-[120ms] cursor-pointer ${
                      on ? "bg-osu-b3/55 text-white" : "text-osu-f1 hover:text-osu-l2"
                    }`}
                  >
                    <span className={`h-1.5 w-1.5 rounded-full ${on ? option.dot : "bg-osu-b3"}`} />
                    {option.label}
                    <span className={`font-mono ${on ? "text-osu-c2" : "text-osu-f1/70"}`}>{count}</span>
                  </button>
                );
              })}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-1.5 text-[9px] font-semibold uppercase tracking-wider text-osu-f1">
            Tier
            <div className="flex flex-wrap items-center gap-1 rounded-md border border-osu-b3/25 bg-osu-b5/50 p-1">
              {COUNTRY_TIER_OPTIONS.map((tier) => {
                const on = tierFilters[tier.value];
                return (
                  <button
                    key={tier.value}
                    type="button"
                    onClick={() => toggleTierFilter(tier.value)}
                    aria-pressed={on}
                    title={tier.blurb}
                    className={`group flex items-center gap-1.5 rounded px-2 py-1 text-[10px] font-semibold uppercase tracking-wider transition-colors duration-[120ms] cursor-pointer ${
                      on ? "bg-osu-b3/55 text-white" : "text-osu-f1 hover:text-osu-l2"
                    }`}
                  >
                    <span className={`h-1.5 w-1.5 rounded-full ${on ? tier.dot : "bg-osu-b3"}`} />
                    {tier.label}
                    <span className={`font-mono ${on ? "text-osu-c2" : "text-osu-f1/70"}`}>{tierCounts[tier.value]}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
        <div className="flex flex-col gap-1.5 lg:items-end">
          <div className="flex flex-wrap items-center gap-1.5 text-[9px] font-semibold uppercase tracking-wider text-osu-f1">
            Sort
            <div className="flex max-w-full flex-wrap items-center gap-1 rounded-md border border-osu-b3/25 bg-osu-b5/50 p-1">
              {COUNTRY_SORT_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setSortMode(option.value)}
                  aria-pressed={sortMode === option.value}
                  className={`rounded px-2 py-1 text-[10px] font-semibold uppercase tracking-wider transition-colors duration-[120ms] cursor-pointer ${
                    sortMode === option.value ? "bg-osu-b3/55 text-white" : "text-osu-f1 hover:text-osu-l2"
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
          <form
            className="flex flex-wrap items-center gap-1.5 text-[9px] font-semibold uppercase tracking-wider text-osu-f1"
            onSubmit={(event) => {
              event.preventDefault();
              if (!/^[A-Z]{2}$/.test(addCountryCode)) return;
              onAddCountry(addCountryCode);
              setAddCountryCode("");
            }}
          >
            Add
            <div className="flex items-center gap-1 rounded-md border border-osu-b3/25 bg-osu-b5/50 p-1">
              <input
                value={addCountryCode}
                onChange={(event) => setAddCountryCode(event.target.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 2))}
                placeholder="EG"
                maxLength={2}
                aria-label="Country code to start tracking"
                className="w-10 rounded bg-transparent px-2 py-1 text-center font-mono text-[10px] text-white placeholder:text-osu-f1/40 focus:outline-none"
              />
              <button
                type="submit"
                disabled={!/^[A-Z]{2}$/.test(addCountryCode) || busy?.startsWith("add-country") === true}
                title="Register this country as active + live and queue its roster"
                className="rounded px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-osu-f1 transition-colors duration-[120ms] hover:text-osu-l2 disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer"
              >
                Track
              </button>
            </div>
          </form>
        </div>
      </div>
      <div className="mb-3 rounded-md border border-osu-b3/25 bg-osu-b5/40">
        <button
          type="button"
          onClick={() => setShowTierHelp((value) => !value)}
          aria-expanded={showTierHelp}
          className="flex w-full items-center gap-1.5 px-2.5 py-2 text-left text-[9px] font-semibold uppercase tracking-wider text-osu-f1 transition-colors duration-[120ms] hover:text-osu-l2 cursor-pointer"
        >
          What the tiers mean (each builds on the one before it)
          <ChevronDown className={`ml-auto h-3 w-3 flex-shrink-0 transition-transform duration-150 ${showTierHelp ? "rotate-180" : ""}`} />
        </button>
        {showTierHelp ? (
          <div className="grid grid-cols-1 gap-x-4 gap-y-1 px-2.5 pb-2 sm:grid-cols-2">
            {COUNTRY_TIER_OPTIONS.map((tier) => (
              <div key={tier.value} className="flex items-center gap-1.5 text-[10px] text-osu-f1">
                <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${tier.dot}`} />
                <span className={`font-semibold uppercase tracking-wider ${tier.tone}`}>{tier.label}</span>
                <span className="text-osu-f1/70">{tier.blurb}</span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
      {sorted.length === 0 ? (
        <div className="text-[11px] text-osu-f1">{countries.length === 0 ? "No countries registered." : "No countries match these filters."}</div>
      ) : (
        // Cap the list height so the long country grid scrolls inside the card
        // instead of pushing the rest of the page (Workers, Activity) way down.
        <div className="grid max-h-[600px] grid-cols-1 gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
          {sorted.map((entry) => (
            <CountryRow
              key={entry.country}
              entry={entry}
              users={rosterByCountry.get(entry.country) ?? null}
              catchup={status?.catchup?.[entry.country] ?? null}
              busy={busy === `set-status-${entry.country}` || busy === `delete-country-${entry.country}` || busy === `set-tier-${entry.country}` || busy === `catch-up-country-${entry.country}`}
              onSetStatus={(lifecycle) => onSetCountryStatus(entry, lifecycle)}
              onDelete={() => onDeleteCountry(entry)}
              onSetTier={(tier) => onSetCountryTier(entry, tier)}
              onCatchUp={() => onCatchUpCountry(entry)}
              onCancelCatchUp={() => onCancelCatchUpCountry(entry)}
            />
          ))}
        </div>
      )}
    </SectionCard>
  );
}

function CountryRow({
  entry,
  users,
  catchup,
  busy,
  onSetStatus,
  onDelete,
  onSetTier,
  onCatchUp,
  onCancelCatchUp,
}: {
  entry: CountryEntry;
  users: number | null;
  catchup: CountryCatchupState | null;
  busy: boolean;
  onSetStatus: (lifecycle: CountryLifecycleStatus) => void;
  onDelete: () => void;
  onSetTier: (tier: CountryFeatureTier) => void;
  onCatchUp: () => void;
  onCancelCatchUp: () => void;
}) {
  const displayStatus = getCountryDisplayStatus(entry);
  const statusTone = displayStatus === "paused" || displayStatus === "idle" ? "text-osu-red" : displayStatus === "active" ? "text-osu-green" : "text-osu-yellow";
  const featureTier = getCountryFeatureTier(entry);
  const activeUsers = entry.activeUsers ?? 0;
  const catchupActive = (catchup?.pending ?? 0) + (catchup?.running ?? 0) > 0;
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Set when the Snipes tier cell is clicked: snipes enables the expensive
  // snipe board seeding, so it takes a second deliberate confirm click.
  const [confirmSnipes, setConfirmSnipes] = useState(false);
  const deleteRef = useRef<HTMLButtonElement | null>(null);
  const snipesRow = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!confirmDelete) return;
    const id = window.setTimeout(() => setConfirmDelete(false), 4_000);
    const onPointerDown = (event: PointerEvent) => {
      if (!deleteRef.current?.contains(event.target as Node)) setConfirmDelete(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [confirmDelete]);
  useEffect(() => {
    if (!confirmSnipes) return;
    const id = window.setTimeout(() => setConfirmSnipes(false), 5_000);
    const onPointerDown = (event: PointerEvent) => {
      if (!snipesRow.current?.contains(event.target as Node)) setConfirmSnipes(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [confirmSnipes]);
  useEffect(() => {
    if (busy) {
      setConfirmDelete(false);
      setConfirmSnipes(false);
    }
  }, [busy]);
  return (
    <div className="rounded-md bg-osu-b5/60 border border-osu-b3/20 px-3 py-2">
      <div className="flex items-center gap-2.5">
        <CountryFlag code={entry.country} size="md" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] font-bold text-white truncate">{getCountryName(entry.country)}</span>
            <span className="text-[10px] font-mono text-osu-c2">{entry.country}</span>
            {entry.pinned ? (
              <span className="text-[9px] uppercase tracking-wider font-semibold text-osu-c2/80">pinned</span>
            ) : null}
          </div>
          <div className="text-[10px] text-osu-f1">
            {users == null ? "roster not loaded" : `${formatNumber(users)} roster users`}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {catchupActive ? (
            <button
              type="button"
              title={`Cancel ${entry.country} score catch-up`}
              aria-label={`Cancel ${entry.country} score catch-up`}
              disabled={busy}
              onClick={onCancelCatchUp}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-osu-red/40 bg-osu-red/10 text-osu-red-light transition hover:border-osu-red-light/70 hover:bg-osu-red/20 hover:text-white disabled:opacity-50 cursor-pointer"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          ) : (
            <button
              type="button"
              title={`Queue ${entry.country} score catch-up from this country's last stored score`}
              aria-label={`Queue ${entry.country} score catch-up`}
              disabled={busy}
              onClick={onCatchUp}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-osu-b3/40 bg-osu-b4/70 text-osu-f1 transition hover:border-osu-c2/60 hover:text-white disabled:opacity-50 cursor-pointer"
            >
              <History className="h-3.5 w-3.5" />
            </button>
          )}
          {confirmDelete ? (
            <button
              ref={deleteRef}
              type="button"
              title={`Confirm delete of ${entry.country} country data. This cannot be undone.`}
              aria-label={`Confirm delete of ${entry.country} country data`}
              disabled={busy}
              onClick={() => {
                setConfirmDelete(false);
                onDelete();
              }}
              className="inline-flex h-7 items-center gap-1.5 rounded-md border border-osu-red/60 bg-osu-red/25 px-2 text-[10px] font-semibold uppercase tracking-wider text-white transition hover:bg-osu-red/35 disabled:opacity-50 cursor-pointer"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Confirm
            </button>
          ) : (
            <button
              type="button"
              title={`Delete ${entry.country} country data`}
              aria-label={`Delete ${entry.country} country data`}
              disabled={busy}
              onClick={() => setConfirmDelete(true)}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-osu-red/30 bg-osu-red/10 text-osu-red-light transition hover:border-osu-red-light/70 hover:bg-osu-red/20 hover:text-white disabled:opacity-50 cursor-pointer"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span className="text-[9px] font-semibold uppercase tracking-wider text-osu-f1">Lifecycle</span>
        <div className="flex items-center gap-1 rounded-md border border-osu-b3/25 bg-osu-b5/50 p-1">
          {COUNTRY_LIFECYCLE_OPTIONS.map((lifecycle) => {
            const active = lifecycle.value === entry.status;
            return (
              <button
                key={lifecycle.value}
                type="button"
                disabled={busy}
                aria-pressed={active}
                title={lifecycle.blurb}
                onClick={() => {
                  if (lifecycle.value === entry.status) return;
                  onSetStatus(lifecycle.value);
                }}
                className={`flex items-center gap-1.5 rounded px-2 py-1 text-[10px] font-semibold uppercase tracking-wider transition-colors duration-[120ms] disabled:opacity-50 ${
                  active
                    ? `bg-osu-b3/55 ${lifecycle.tone}`
                    : "text-osu-f1 hover:text-osu-l2 cursor-pointer"
                }`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${active ? lifecycle.dot : "bg-osu-b3"}`} />
                {lifecycle.label}
              </button>
            );
          })}
        </div>
        {displayStatus === "idle" ? (
          <span className={`text-[10px] font-semibold uppercase tracking-wider ${statusTone}`}>idle by TTL</span>
        ) : null}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <span className="text-[9px] font-semibold uppercase tracking-wider text-osu-f1">Tier</span>
        {confirmSnipes ? (
          <div
            ref={snipesRow}
            className="flex items-center gap-1 rounded-md border border-osu-pink/50 bg-osu-pink/10 p-1"
          >
            <span className="px-1.5 text-[10px] font-semibold uppercase tracking-wider text-osu-pink-light">
              Enable snipe board seeding?
            </span>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setConfirmSnipes(false);
                onSetTier("snipes");
              }}
              className="inline-flex h-6 items-center gap-1 rounded px-2 text-[10px] font-semibold uppercase tracking-wider text-white bg-osu-pink/30 transition hover:bg-osu-pink/45 disabled:opacity-50 cursor-pointer"
            >
              <Crosshair className="h-3 w-3" />
              Confirm
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirmSnipes(false)}
              aria-label="Cancel enabling snipes"
              className="inline-flex h-6 w-6 items-center justify-center rounded text-osu-f1 transition hover:text-white disabled:opacity-50 cursor-pointer"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-1 rounded-md border border-osu-b3/25 bg-osu-b5/50 p-1">
            {COUNTRY_TIER_OPTIONS.map((tier) => {
              const active = tier.value === featureTier;
              return (
                <button
                  key={tier.value}
                  type="button"
                  disabled={busy}
                  aria-pressed={active}
                  title={tier.blurb}
                  onClick={() => {
                    if (tier.value === featureTier) return;
                    // Snipes enables the expensive board seeding: confirm first.
                    if (tier.value === "snipes") {
                      setConfirmSnipes(true);
                      return;
                    }
                    onSetTier(tier.value);
                  }}
                  className={`flex items-center gap-1.5 rounded px-2 py-1 text-[10px] font-semibold uppercase tracking-wider transition-colors duration-[120ms] disabled:opacity-50 ${
                    active
                      ? `bg-osu-b3/55 ${tier.tone}`
                      : "text-osu-f1 hover:text-osu-l2 cursor-pointer"
                  }`}
                >
                  <span className={`h-1.5 w-1.5 rounded-full ${active ? tier.dot : "bg-osu-b3"}`} />
                  {tier.label}
                </button>
              );
            })}
          </div>
        )}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-osu-f1">
        <span>
          <span className="text-osu-c2/80">page users</span> {formatNumber(activeUsers)}
        </span>
        {activeUsers === 0 ? (
          <span>
            <span className="text-osu-c2/80">last page activity</span>{" "}
            {entry.lastActiveAt ? formatTimeAgo(entry.lastActiveAt) : "never"}
          </span>
        ) : null}
        <span>
          <span className="text-osu-c2/80">last score</span> {entry.lastScoreAt ? formatTimeAgo(entry.lastScoreAt) : "never"}
        </span>
        <span>
          <span className="text-osu-c2/80">roster refresh</span>{" "}
          {entry.lastRosterRefreshAt ? formatTimeAgo(entry.lastRosterRefreshAt) : "never"}
        </span>
      </div>
      <CountryCatchupLine catchup={catchup} />
    </div>
  );
}

// Surfaces what the per-country oSC catch-up job is doing: queued/running vs the
// last completed run's fetched/added counts. "+0 added (N fetched)" flags a run
// that pulled scores but matched none for this country (tier/roster gating);
// "+0 added (0 fetched)" flags that oSC has no history that far back.
function CountryCatchupLine({ catchup }: { catchup: CountryCatchupState | null }) {
  if (!catchup) return null;
  const active = catchup.pending + catchup.running > 0;
  const result = catchup.lastResult;
  const cursorBehind = catchup.cursorMs != null ? formatTimeAgo(new Date(catchup.cursorMs).toISOString()) : null;
  return (
    <div className="mt-1.5 rounded-md border border-osu-b3/20 bg-osu-b5/40 px-2 py-1.5 text-[10px]">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <span className="flex items-center gap-1.5 font-semibold uppercase tracking-wider text-osu-f1">
          <History className={`h-3 w-3 ${active ? "animate-spin text-osu-c2" : ""}`} />
          Catch-up
        </span>
        {active ? (
          <span className="text-osu-c2">
            {catchup.running > 0 ? "running" : "queued"}
            {cursorBehind ? <span className="text-osu-f1"> · up to {cursorBehind}</span> : null}
          </span>
        ) : result ? (
          <span className="text-osu-f1">
            last run {catchup.lastRunAt ? formatTimeAgo(catchup.lastRunAt) : ""}:{" "}
            <span className={result.inserted > 0 ? "text-osu-green" : "text-osu-f1"}>
              +{formatNumber(result.inserted)} added
            </span>{" "}
            <span className="text-osu-c2/70">({formatNumber(result.fetched)} fetched)</span>
            {result.hasMore ? <span className="text-osu-yellow"> · more pending</span> : null}
          </span>
        ) : (
          <span className="text-osu-f1/70">no runs yet</span>
        )}
      </div>
      {catchup.failed > 0 ? (
        <div className="mt-1 truncate text-osu-red-light" title={catchup.lastError ?? undefined}>
          {formatNumber(catchup.failed)} failed{catchup.lastError ? `: ${catchup.lastError}` : ""}
        </div>
      ) : null}
    </div>
  );
}

function getCountryFeatureTier(entry: CountryEntry): CountryFeatureTier {
  return entry.featureTier === "snipes" || entry.featureTier === "live" || entry.featureTier === "maps_warm" || entry.featureTier === "indexed"
    ? entry.featureTier
    : "indexed";
}

function getCountryDisplayStatus(entry: CountryEntry): CountryDisplayStatus {
  if (entry.status === "paused") return "paused";
  if (!entry.isWarm) return "idle";
  return entry.status;
}

function WorkerLanesCard({ status }: { status: LiveBackendStatus | null }) {
  const workerLanes = getVisibleWorkerLanes(status);
  const activeJobCount = workerLanes.reduce((total, lane) => total + (lane.activeJobs?.length ?? 0), 0);
  return (
    <SectionCard
      title="Worker lanes"
      subtitle={`${formatNumber(activeJobCount)} active. Idle means the lane is waiting for a matching queued job.`}
    >
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        {workerLanes.map((lane) => (
          <WorkerLaneRow key={lane.name} lane={lane} />
        ))}
      </div>
    </SectionCard>
  );
}

function getVisibleWorkerLanes(status: LiveBackendStatus | null) {
  return (status?.worker?.lanes ?? []).filter((lane) => !HIDDEN_WORKER_LANE_NAMES.has(lane.name));
}

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2.5">
      <div>
        <div className="text-[11px] font-semibold text-osu-c2 uppercase tracking-wider">{title}</div>
        {subtitle ? <div className="text-[11px] text-osu-f1 mt-0.5">{subtitle}</div> : null}
      </div>
      {children}
    </section>
  );
}

function WorkerLaneRow({ lane }: { lane: NonNullable<NonNullable<LiveBackendStatus["worker"]>["lanes"]>[number] }) {
  const jobTypes = lane.jobTypes?.join(", ") ?? "all jobs";
  const activeJobs = lane.activeJobs ?? [];
  return (
    <div className="rounded-md bg-osu-b5/60 border border-osu-b3/20 px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[11px] font-bold text-white">{lane.name}</span>
        <span className={`text-[10px] font-semibold ${activeJobs.length > 0 ? "text-osu-yellow" : "text-osu-f1"}`}>
          {activeJobs.length > 0 ? `${formatNumber(activeJobs.length)} active` : "idle"}
        </span>
        <span className="text-[10px] font-mono text-osu-c2">{formatNumber(lane.claimLimit)}x</span>
        <span className="text-[10px] font-mono text-osu-f1">{formatNumber(lane.intervalMs)}ms</span>
      </div>
      {activeJobs.length > 0 ? (
        <div className="mt-2 space-y-1">
          <div className="text-[9px] uppercase tracking-wider text-osu-yellow font-semibold">Currently doing</div>
          {activeJobs.map((job) => (
            <WorkerActiveJobRow key={job.id} job={job} />
          ))}
        </div>
      ) : (
        <div className="mt-1 space-y-1">
          <div className="text-[10px] text-osu-f1">
            <span className="font-semibold text-osu-c2">Currently doing:</span> nothing
          </div>
          <div className="truncate text-[10px] font-mono text-osu-f1">Handles: {jobTypes}</div>
        </div>
      )}
    </div>
  );
}

function WorkerActiveJobRow({ job }: { job: NonNullable<NonNullable<NonNullable<LiveBackendStatus["worker"]>["lanes"]>[number]["activeJobs"]>[number] }) {
  return (
    <div className="rounded bg-osu-b4/50 border border-osu-b3/20 px-2 py-1.5">
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-[10px] font-mono text-osu-yellow">#{job.id}</span>
        <span className="min-w-0 flex-1 truncate text-[10px] font-mono text-osu-c2">{job.type}</span>
        <span className="text-[10px] text-osu-f1 flex-shrink-0">{formatTimeAgo(job.startedAt)}</span>
        <span className="text-[10px] font-mono text-osu-f1 flex-shrink-0">try {formatNumber(job.attempts)}</span>
      </div>
      <div className="mt-1 text-[10px] font-mono text-osu-l2/75 truncate">{formatJobPayload(job.payload) || job.dedupeKey}</div>
    </div>
  );
}

function formatJobPayload(payload: unknown): string {
  if (payload == null) return "";
  if (typeof payload === "string") return payload;
  try {
    return JSON.stringify(payload);
  } catch {
    return String(payload);
  }
}

function DetailRow({ label, value, tone = "neutral" }: { label: string; value: string; tone?: StatusTone }) {
  const dot = {
    good: "bg-osu-green-light",
    warn: "bg-osu-yellow",
    bad: "bg-osu-red-light",
    neutral: "bg-osu-b3",
  }[tone];
  return (
    <div className="rounded-md bg-osu-b5/60 border border-osu-b3/20 px-3 py-2 flex items-center gap-2 min-w-0">
      <span className={`h-2 w-2 rounded-full flex-shrink-0 ${dot}`} />
      <div className="min-w-0">
        <div className="text-[9px] uppercase tracking-wider text-osu-f1 font-semibold">{label}</div>
        <div className="text-[11px] text-osu-c2 truncate">{value}</div>
      </div>
    </div>
  );
}

function EventStreamCard({ events, connectionState }: { events: LiveEventRow[]; connectionState: ConnectionState }) {
  const connected = connectionState === "open";
  return (
    <SectionCard title="SSE stream" subtitle="hello, heartbeat, tracker, top-play, snipe, and job events">
      <div className="space-y-2">
        <div className="rounded-md bg-osu-b5/60 border border-osu-b3/20 px-3 py-2 flex items-center gap-2">
          {connected ? <Wifi className="h-4 w-4 text-osu-green-light" /> : <WifiOff className="h-4 w-4 text-osu-yellow" />}
          <span className="text-[11px] text-osu-c2">EventSource is {connectionState}</span>
          <span className="ml-auto text-[10px] text-osu-f1">{events.length} shown</span>
        </div>
        <div className="space-y-1 max-h-[360px] overflow-auto pr-1">
          {events.length === 0 ? (
            <div className="text-[11px] text-osu-f1 text-center py-10">Waiting for live events...</div>
          ) : (
            events.map((event) => <EventRow key={event.id} event={event} />)
          )}
        </div>
      </div>
    </SectionCard>
  );
}

function EventRow({ event }: { event: LiveEventRow }) {
  return (
    <div className="rounded-md bg-osu-b5/60 border border-osu-b3/20 px-2.5 py-2">
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-[10px] font-mono text-osu-pink-light flex-shrink-0">{event.type}</span>
        <span className="text-[10px] text-osu-f1 ml-auto flex-shrink-0">{formatTimeAgo(new Date(event.receivedAt).toISOString())}</span>
      </div>
      <div className="mt-1 text-[10px] font-mono text-osu-l2/80 truncate">{event.preview}</div>
    </div>
  );
}

function RateBreakdownCard({ status }: { status: LiveBackendStatus | null }) {
  const callers = status?.rate.byCaller ?? [];
  const paths = status?.rate.byPath ?? [];
  const historyCallers = status?.apiCallHistory?.byCaller ?? [];
  const historyPaths = status?.apiCallHistory?.byPath ?? [];
  const windowMin = status?.apiCallHistory?.windowMinutes ?? 15;
  const max = Math.max(1, ...callers.map((row) => row.count), ...paths.map((row) => row.count), ...historyCallers.map((row) => row.count), ...historyPaths.map((row) => row.count));
  return (
    <SectionCard title="osu! API breakdown" subtitle="Compare live minute against the persisted recent window">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div>
          <div className="text-[9px] uppercase tracking-wider text-osu-f1 font-semibold mb-2">Callers, last 60s</div>
          <RateRows
            rows={callers.map((row) => ({ label: row.caller, count: row.count }))}
            max={max}
            empty="No calls in the last minute."
          />
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-wider text-osu-f1 font-semibold mb-2">Callers, last {windowMin}m</div>
          <RateRows
            rows={historyCallers.map((row) => ({ label: row.caller, count: row.count }))}
            max={max}
            empty="No persisted calls in the recent window."
          />
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-wider text-osu-f1 font-semibold mb-2">Paths, last {windowMin}m</div>
          <RateRows
            rows={(paths.length ? paths : historyPaths).map((row) => ({ label: row.path, count: row.count }))}
            max={max}
            empty="No recent paths."
          />
        </div>
      </div>
    </SectionCard>
  );
}

function RateRows({ rows, max, empty }: { rows: Array<{ label: string; count: number }>; max: number; empty: string }) {
  if (rows.length === 0) return <div className="text-[11px] text-osu-f1 py-3">{empty}</div>;
  return (
    <div className="space-y-1.5">
      {rows.map((row) => (
        <div key={row.label} className="relative rounded-md bg-osu-b5/60 border border-osu-b3/20 overflow-hidden">
          <div
            className="absolute inset-y-0 left-0 bg-osu-yellow/10"
            style={{ width: `${Math.max(4, (row.count / max) * 100)}%` }}
          />
          <div className="relative flex items-center gap-2 px-2.5 py-1.5">
            <span className="min-w-0 flex-1 truncate text-[10px] font-mono text-osu-c2">{row.label}</span>
            <span className="text-[11px] font-bold text-osu-yellow">{row.count}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function AbuseGuardCard({ status }: { status: LiveBackendStatus | null }) {
  const abuse = status?.abuse ?? null;
  return (
    <SectionCard title="Abuse guard" subtitle="Live backend public request limiter state">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <GuardMetric
          label="SSE connections"
          value={abuse ? formatNumber(abuse.sseTotal) : "—"}
          hint="open EventSource sockets"
          tone={abuse && abuse.sseTotal > 400 ? "warn" : "neutral"}
        />
        <GuardMetric
          label="SSE IPs"
          value={abuse ? formatNumber(abuse.sseIps) : "—"}
          hint="unique IPs with live sockets"
          tone="neutral"
        />
        <GuardMetric
          label="Rate windows"
          value={abuse ? formatNumber(abuse.windows) : "—"}
          hint="active limiter buckets"
          tone={abuse && abuse.windows > 5000 ? "warn" : "neutral"}
        />
      </div>
      {!abuse ? (
        <div className="mt-3 rounded-md bg-osu-b5/60 border border-osu-b3/20 px-3 py-2 text-[11px] text-osu-f1">
          This backend has not reported abuse guard state yet.
        </div>
      ) : null}
    </SectionCard>
  );
}

function GuardMetric({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint: string;
  tone: "warn" | "neutral";
}) {
  return (
    <div className={`rounded-md border px-3 py-2 ${tone === "warn" ? "bg-osu-yellow/10 border-osu-yellow/25" : "bg-osu-b5/60 border-osu-b3/20"}`}>
      <div className="text-[9px] uppercase tracking-wider text-osu-f1 font-semibold">{label}</div>
      <div className={tone === "warn" ? "mt-1 text-xl leading-none font-bold text-osu-yellow" : "mt-1 text-xl leading-none font-bold text-white"}>
        {value}
      </div>
      <div className="mt-1 text-[10px] text-osu-f1 truncate">{hint}</div>
    </div>
  );
}

function QueueSummaryCard({ status }: { status: LiveBackendStatus | null }) {
  const depth = status?.queueDepth ?? 0;
  const rows = status?.queueSummary ?? [];
  const activeRows = rows.filter((row) => row.status !== "deferred_pressure");
  const parkedRows = rows.filter((row) => row.status === "deferred_pressure");
  const parked = status?.queuePressure?.deferred ?? parkedRows.reduce((sum, row) => sum + row.count, 0);
  const pressure = status?.queuePressure;
  return (
    <SectionCard title="Job queue" subtitle="Counts by type and status">
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-md bg-osu-b5/60 border border-osu-b3/20 px-3 py-2">
            <div className="text-[9px] uppercase tracking-wider text-osu-f1 font-semibold">Active depth</div>
            <div className="mt-1 text-xl font-bold text-white">{formatNumber(depth)}</div>
            <div className="mt-1 text-[10px] text-osu-f1 truncate">
              {pressure ? `target ${formatNumber(pressure.targetDepth)}, recover below ${formatNumber(pressure.recoveryDepth ?? 60)}` : "queued / running / failed"}
            </div>
          </div>
          <div className={`rounded-md border px-3 py-2 ${parked > 0 ? "bg-osu-yellow/10 border-osu-yellow/25" : "bg-osu-b5/60 border-osu-b3/20"}`}>
            <div className="text-[9px] uppercase tracking-wider text-osu-f1 font-semibold">Parked</div>
            <div className={parked > 0 ? "mt-1 text-xl font-bold text-osu-yellow" : "mt-1 text-xl font-bold text-white"}>{formatNumber(parked)}</div>
            <div className="mt-1 text-[10px] text-osu-f1 truncate">saved for later, not deleted</div>
          </div>
        </div>
        {parkedRows.length > 0 ? (
          <div>
            <div className="text-[9px] uppercase tracking-wider text-osu-f1 font-semibold mb-2">Parked jobs</div>
            <div className="space-y-1.5 max-h-[150px] overflow-auto pr-1">
              {parkedRows.map((row) => <QueueSummaryRow key={`${row.status}:${row.type}`} row={row} />)}
            </div>
          </div>
        ) : null}
        <div className="space-y-1.5 max-h-[360px] overflow-auto pr-1">
          {activeRows.length === 0 ? (
            <div className="text-[11px] text-osu-f1 py-3">No jobs recorded.</div>
          ) : (
            activeRows.map((row) => <QueueSummaryRow key={`${row.status}:${row.type}`} row={row} />)
          )}
        </div>
      </div>
    </SectionCard>
  );
}

function ControlsCard({
  status,
  busy,
  onClearFailed,
  onRefreshRoster,
  onRunRetention,
  onOscSmoke,
  onRunOscBackfill,
  onToggleWorkers,
}: {
  status: LiveBackendStatus | null;
  busy: string | null;
  onClearFailed: () => void;
  onRefreshRoster: () => void;
  onRunRetention: () => void;
  onOscSmoke: () => void;
  onRunOscBackfill: () => void;
  onToggleWorkers: () => void;
}) {
  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-osu-b3/30 bg-osu-b4/30 p-3">
        <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
          <AdminButton
            label={status?.worker?.paused ? "Resume jobs" : "Pause jobs"}
            description={status?.worker?.paused ? "Let queued backend jobs start running again." : "Temporarily stop queued jobs. Live score intake can still write new scores."}
            icon={status?.worker?.paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
            busy={busy === "pause-workers" || busy === "resume-workers"}
            onClick={onToggleWorkers}
          />
          <AdminButton
            label="Refresh roster"
            description="Fetch the latest tracked players for this country from osu! rankings."
            icon={<UserRound className="h-3.5 w-3.5" />}
            busy={busy === "refresh-roster"}
            onClick={onRefreshRoster}
          />
          <AdminButton
            label="Clear failed jobs"
            description="Remove failed jobs from the queue list after you have inspected or fixed them."
            icon={<Trash2 className="h-3.5 w-3.5" />}
            busy={busy === "clear-failed"}
            onClick={onClearFailed}
          />
          <AdminButton
            label="Run cleanup"
            description="Delete old logs, completed jobs, and temporary event rows according to retention settings."
            icon={<RefreshCw className="h-3.5 w-3.5" />}
            busy={busy === "retention"}
            onClick={onRunRetention}
          />
          <AdminButton
            label="Test oSC API"
            description="Make one small oSC JSON request to confirm Kayla's API is reachable."
            icon={<Radio className="h-3.5 w-3.5" />}
            busy={busy === "osc-smoke"}
            onClick={onOscSmoke}
          />
          <AdminButton
            label="Catch up missed scores"
            description="Queue a paced oSC history scan to recover scores missed while the backend was offline."
            icon={<History className="h-3.5 w-3.5" />}
            busy={busy === "osc-backfill"}
            onClick={onRunOscBackfill}
          />
        </div>
      </div>
    </div>
  );
}

function AdminButton({
  label,
  description,
  icon,
  busy,
  onClick,
  danger,
}: {
  label: string;
  description: string;
  icon: React.ReactNode;
  busy: boolean;
  onClick: () => void;
  danger?: boolean;
}) {
  const base = danger
    ? "bg-osu-red/15 border-osu-red/40 text-osu-red-light hover:bg-osu-red/25 hover:text-white"
    : "bg-osu-b4/60 border-osu-b3/30 text-osu-l2 hover:bg-osu-b3/60 hover:text-white";
  return (
    <button
      onClick={onClick}
      disabled={busy}
      className={`group relative inline-grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-left text-[10px] font-semibold transition-colors duration-[120ms] disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer ${base}`}
      aria-label={`${label}. ${description}`}
    >
      <span className="flex h-4 w-4 items-center justify-center">
        {busy ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : icon}
      </span>
      <span className="min-w-0 truncate">{label}</span>
      <span
        className="relative flex h-4 w-4 items-center justify-center rounded-full text-osu-f1 group-hover:text-osu-pink-light"
        aria-hidden="true"
      >
        <HelpCircle className="h-3.5 w-3.5" />
        <span className="pointer-events-none absolute right-0 top-6 z-30 hidden w-56 rounded-md border border-osu-b3/40 bg-osu-b5 px-2.5 py-2 text-[10px] font-medium leading-relaxed text-osu-l2 shadow-xl shadow-black/30 group-hover:block group-focus-visible:block">
          {description}
        </span>
      </span>
    </button>
  );
}

function QueueSummaryRow({ row }: { row: NonNullable<LiveBackendStatus["queueSummary"]>[number] }) {
  const statusColor = row.status === "done"
    ? "text-osu-green-light"
    : row.status === "failed"
      ? "text-osu-red-light"
      : row.status === "running"
        ? "text-osu-yellow"
        : row.status === "deferred_pressure"
          ? "text-osu-yellow"
          : "text-osu-c2";
  return (
    <div className="rounded-md bg-osu-b5/60 border border-osu-b3/20 px-2.5 py-2">
      <div className="flex items-center gap-2">
        <span className={`text-[10px] font-mono ${statusColor}`}>{row.status}</span>
        <span className="min-w-0 flex-1 truncate text-[10px] font-mono text-osu-c2">{row.type}</span>
        <span className="text-[11px] font-bold text-white">{formatNumber(row.count)}</span>
      </div>
      {row.newestError ? <div className="mt-1 text-[10px] font-mono text-osu-red-light/80 truncate">{row.newestError}</div> : null}
    </div>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-osu-red/30 bg-osu-red/10 px-4 py-3">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-osu-red-light">Live backend error</div>
      <div className="text-[12px] text-osu-l2 mt-1 break-words">{message}</div>
    </div>
  );
}
