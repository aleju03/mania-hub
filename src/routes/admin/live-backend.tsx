import { createFileRoute, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Activity, Crosshair, Database, HelpCircle, History, Pause, Play, Radio, RefreshCw, Server, Signal, Trash2, UserRound, Wifi, WifiOff, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { canUseAdminFeatures } from "../../lib/auth-shared";
import { requireAdminAccess } from "../../lib/auth";
import {
  fetchLiveBackendAdminStatus,
  fetchLiveSnipesSnapshot,
  fetchLiveTopPlaysSnapshot,
  fetchLiveTrackerSnapshot,
  getLiveBackendUrl,
  openLiveEventSource,
  runLiveBackendAdminAction,
  type LiveEventName,
} from "../../lib/live-backend";
import { formatNumber, formatTimeAgo } from "../../lib/format";
import { getCountryFlagUrl, getCountryName } from "../../lib/country";

type ConnectionState = "idle" | "connecting" | "open" | "error";

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
  };
  lastEventAt: string | null;
  queueDepth: number;
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
  rate: {
    hardPerMinute: number;
    usedLastMinute: number;
    byCaller?: Array<{ caller: string; count: number }>;
    byPath?: Array<{ path: string; count: number }>;
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

interface AnalyticsRecentEventRow {
  timestamp: string;
  event: string;
  path: string;
  country: string | null;
  selectedCountry: string | null;
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

interface AnalyticsMonitorData {
  range: AnalyticsRange;
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
const ANALYTICS_REFRESH_MS = 15_000;
const DEFAULT_COUNTRY = "CR";
const MONITORING_TABS = ["backend", "analytics"] as const;
type MonitoringTab = (typeof MONITORING_TABS)[number];
const ANALYTICS_RANGES = ["1h", "24h", "7d", "30d"] as const;
type AnalyticsRange = (typeof ANALYTICS_RANGES)[number];
const ANALYTICS_RANGE_STORAGE_KEY = "mh_monitor_range";
const ANALYTICS_RANGE_SQL: Record<AnalyticsRange, string> = {
  "1h": "now() - interval 1 hour",
  "24h": "now() - interval 1 day",
  "7d": "now() - interval 7 day",
  "30d": "now() - interval 30 day",
};
const ANALYTICS_RANGE_LABEL: Record<AnalyticsRange, string> = {
  "1h": "Last hour",
  "24h": "Last 24h",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
};
const POSTHOG_QUERY_TIMEOUT_MS = 15_000;

function isAnalyticsRange(value: unknown): value is AnalyticsRange {
  return typeof value === "string" && (ANALYTICS_RANGES as readonly string[]).includes(value);
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

const getAnalyticsMonitorData = createServerFn({ method: "POST" })
  .inputValidator((data: { range?: string; recentCountry?: unknown }) => ({
    range: isAnalyticsRange(data?.range) ? data.range : ("24h" as AnalyticsRange),
    recentCountry: normalizeAnalyticsCountryFilter(data?.recentCountry),
  }))
  .handler(async ({ data }: { data: { range: AnalyticsRange; recentCountry: string | null } }): Promise<AnalyticsMonitorData> => {
    await requireAdminAccess("Monitoring analytics");

    const apiKey = process.env.POSTHOG_PERSONAL_API_KEY;
    const projectId = process.env.POSTHOG_PROJECT_ID;
    if (!apiKey || !projectId) {
      throw new Error("Set POSTHOG_PERSONAL_API_KEY and POSTHOG_PROJECT_ID in .env to use analytics monitoring.");
    }

    const endpoint = `https://us.posthog.com/api/projects/${projectId}/query/`;
    const since = ANALYTICS_RANGE_SQL[data.range];
    const recentCountryClause = data.recentCountry ? ` AND properties.$geoip_country_code = '${data.recentCountry}'` : "";

    async function runQuery(query: string): Promise<unknown[][]> {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), POSTHOG_QUERY_TIMEOUT_MS);
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ query: { kind: "HogQLQuery", query } }),
        signal: controller.signal,
      }).finally(() => {
        clearTimeout(timeout);
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`PostHog query failed (${res.status}): ${text.slice(0, 400)}`);
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
      runQuery(`SELECT count(DISTINCT distinct_id) FROM events WHERE timestamp > now() - interval 5 minute`),
      runQuery(`SELECT count() FROM events WHERE event = '$pageview' AND timestamp > ${since} AND properties.$pathname NOT LIKE '/admin/%'`),
      runQuery(`SELECT count(DISTINCT distinct_id) FROM events WHERE timestamp > ${since}`),
      runQuery(`SELECT count() FROM events WHERE timestamp > ${since}`),
      runQuery(
        `SELECT properties.$pathname AS p, count() AS c FROM events WHERE event = '$pageview' AND timestamp > ${since} AND properties.$pathname IS NOT NULL AND properties.$pathname != '/' AND properties.$pathname NOT LIKE '/admin/%' GROUP BY p ORDER BY c DESC LIMIT 10`,
      ),
      runQuery(
        `SELECT formatDateTime(toTimeZone(timestamp, 'America/Costa_Rica'), '%h:%i:%S %p'), event, properties.$pathname, properties.$geoip_country_code, properties.selected_country, distinct_id, properties.maps_tab, properties.rankings_page, properties.profile_username, properties.replay_player, properties.replay_score_id FROM events WHERE timestamp > ${since} AND distinct_id != 'server'${recentCountryClause} AND (properties.$pathname IS NULL OR properties.$pathname NOT LIKE '/admin/%') AND NOT (event = '$pageview' AND properties.$pathname = '/') ORDER BY timestamp DESC LIMIT 30`,
      ),
      runQuery(
        `SELECT properties.$geoip_country_code AS c, count(DISTINCT distinct_id) AS n FROM events WHERE timestamp > ${since} AND properties.$geoip_country_code IS NOT NULL GROUP BY c ORDER BY n DESC LIMIT 20`,
      ),
      runQuery(
        `SELECT properties.profile_username AS u, count() AS n, max(timestamp) AS last_viewed_at, formatDateTime(toTimeZone(max(timestamp), 'America/Costa_Rica'), '%Y-%m-%d %h:%i %p') AS last_viewed_label, argMax(properties.$geoip_country_code, timestamp) AS last_country FROM events WHERE event = '$pageview' AND properties.profile_username IS NOT NULL AND timestamp > ${since} GROUP BY u ORDER BY n DESC, last_viewed_at DESC LIMIT 10`,
      ),
      runQuery(
        `SELECT properties.replay_score_id AS score_id, any(properties.replay_title) AS title, any(properties.replay_artist) AS artist, any(properties.replay_difficulty) AS difficulty, any(properties.replay_player) AS player, any(properties.replay_cover_url) AS cover_url, count() AS n, max(timestamp) AS last_viewed_at, formatDateTime(toTimeZone(max(timestamp), 'America/Costa_Rica'), '%Y-%m-%d %h:%i %p') AS last_viewed_label, argMax(properties.$geoip_country_code, timestamp) AS last_country FROM events WHERE event = 'replay_view' AND properties.replay_score_id IS NOT NULL AND timestamp > ${since} GROUP BY score_id ORDER BY n DESC, last_viewed_at DESC LIMIT 10`,
      ),
      runQuery(
        `SELECT properties.$referring_domain AS d, count(DISTINCT distinct_id) AS n FROM events WHERE event = '$pageview' AND timestamp > ${since} AND properties.$referring_domain IS NOT NULL AND properties.$referring_domain NOT IN ('localhost', '127.0.0.1', '::1') AND properties.$referring_domain NOT LIKE '%-aleju03s-projects.vercel.app' GROUP BY d ORDER BY n DESC LIMIT 10`,
      ),
      runQuery(
        `SELECT properties.caller AS c, properties.path AS p, properties.status AS s, count() AS n FROM events WHERE event = 'osu_api_error' AND timestamp > ${since} AND properties.caller IS NOT NULL GROUP BY c, p, s ORDER BY n DESC LIMIT 10`,
      ),
      runQuery(
        `SELECT formatDateTime(toTimeZone(timestamp, 'America/Costa_Rica'), '%h:%i:%S %p'), properties.caller, properties.path, properties.status, properties.body_preview, properties.attempts, properties.kind, properties.context, properties.rate_per_min, properties.rate_remaining, properties.rate_limit, properties.retry_after FROM events WHERE event = 'osu_api_error' AND timestamp > ${since} AND properties.caller IS NOT NULL ORDER BY timestamp DESC LIMIT 15`,
      ),
      runQuery(
        `SELECT countIf(pv_count = 1) AS bounced, count() AS landers FROM (SELECT distinct_id, count() AS pv_count FROM events WHERE event = '$pageview' AND timestamp > ${since} GROUP BY distinct_id HAVING countIf(properties.$pathname = '/') > 0)`,
      ),
    ]);

    return {
      range: data.range,
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
  const [refreshNonce, setRefreshNonce] = useState(0);

  const countryCode = useMemo(() => country.trim().toUpperCase().slice(0, 2) || DEFAULT_COUNTRY, [country]);

  const load = useCallback(async (quiet = false): Promise<void> => {
    const requestId = ++requestIdRef.current;
    if (!quiet) setRefreshing(true);
    try {
      const [nextStatus, tracker, topPlays, snipes] = await Promise.all([
        fetchLiveBackendAdminStatus() as Promise<LiveBackendStatus>,
        fetchLiveTrackerSnapshot(countryCode, 100),
        fetchLiveTopPlaysSnapshot(countryCode, "7d"),
        fetchLiveSnipesSnapshot(countryCode, 500),
      ]);
      if (requestId !== requestIdRef.current) return;
      setStatus(nextStatus);
      setSnapshots({
        trackerScores: tracker.scores.length,
        trackerFetchedAt: tracker.fetchedAt,
        topPlays: topPlays.popoffs.length,
        topPlaysFetchedAt: topPlays.scannedAt,
        snipes: snipes.events.length,
        snipesFetchedAt: snipes.scannedAt,
      });
      setError(null);
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      setError(err instanceof Error ? err.message : "Could not reach live backend.");
    } finally {
      if (requestId === requestIdRef.current) setRefreshing(false);
    }
  }, [countryCode]);

  const runAdminAction = useCallback(async (action: string, path: string) => {
    setActionBusy(action);
    try {
      await runLiveBackendAdminAction({ data: { path } });
      await load(true);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Admin action failed.");
    } finally {
      setActionBusy(null);
    }
  }, [load]);

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
    const source = openLiveEventSource(countryCode);
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
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
              <KpiCard
                label="Backend"
                value={status?.ok ? "online" : "offline"}
                hint={backendUrl ?? "not configured"}
                tone={status?.ok ? "good" : "bad"}
                icon={<Server className="h-4 w-4" />}
              />
              <KpiCard
                label="Database"
                value={status?.db ? "ready" : "down"}
                hint={formatStorageHint(status)}
                tone={status?.storage?.overLimit ? "bad" : status?.db ? "good" : "bad"}
                icon={<Database className="h-4 w-4" />}
              />
              <KpiCard
                label="oSC socket"
                value={status?.osc.connected ? "connected" : "closed"}
                hint={status?.osc.lastBatchAt ? `batch ${formatTimeAgo(status.osc.lastBatchAt)}` : "waiting for batch"}
                tone={status?.osc.connected ? "good" : "warn"}
                icon={<Radio className="h-4 w-4" />}
              />
              <KpiCard
                label="Queue"
                value={status?.queueDepth == null ? "—" : formatNumber(status.queueDepth)}
                hint="queued / running jobs"
                tone={(status?.queueDepth ?? 0) > 1000 ? "warn" : "neutral"}
                icon={<Activity className="h-4 w-4" />}
              />
              <KpiCard
                label="osu! rate"
                value={status ? `${status.rate.usedLastMinute}/${status.rate.hardPerMinute}` : "—"}
                hint="calls in last minute"
                tone={status && status.rate.usedLastMinute >= status.rate.hardPerMinute ? "warn" : "neutral"}
                icon={<Signal className="h-4 w-4" />}
              />
            </div>
          </Section>

          <Section title="Status" subtitle="Process, socket, roster, and country snapshots">
            <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
              <div className="lg:col-span-3 flex">
                <StatusCard status={status} connectionState={connectionState} country={countryCode} />
              </div>
              <div className="lg:col-span-2 flex">
                <SnapshotCard snapshots={snapshots} country={countryCode} />
              </div>
            </div>
          </Section>

          <Section title="Countries" subtitle="Which countries the backend is currently tracking">
            <CountriesCard
              status={status}
              busy={actionBusy}
              onToggleCountry={(entry) => {
                const shouldPause = entry.status !== "paused" && entry.isWarm;
                const action = shouldPause ? `pause-country-${entry.country}` : `resume-country-${entry.country}`;
                const path = shouldPause ? "/api/admin/pause-country" : "/api/admin/resume-country";
                void runAdminAction(action, `${path}?country=${encodeURIComponent(entry.country)}`);
              }}
              onDeleteCountry={(entry) => {
                void runAdminAction(`delete-country-${entry.country}`, `/api/admin/delete-country?country=${encodeURIComponent(entry.country)}`);
              }}
              onSetCountryTier={(entry, tier) => {
                void runAdminAction(`set-tier-${entry.country}`, `/api/admin/set-country-tier?country=${encodeURIComponent(entry.country)}&tier=${encodeURIComponent(tier)}`);
              }}
            />
          </Section>

          {(status?.worker?.lanes?.length ?? 0) > 0 ? (
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
  const [range, setRangeState] = useState<AnalyticsRange>("24h");
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

  const setRange = useCallback((next: AnalyticsRange) => {
    setRangeState(next);
    setRecentCountry(null);
    try {
      window.localStorage.setItem(ANALYTICS_RANGE_STORAGE_KEY, next);
    } catch {
      // ignore
    }
  }, []);

  const load = useCallback(
    async (targetRange: AnalyticsRange, targetRecentCountry: string | null, isInitial: boolean) => {
      const requestId = ++requestIdRef.current;
      if (!isInitial) setRefreshing(true);
      try {
        const result = await getAnalyticsMonitorData({ data: { range: targetRange, recentCountry: targetRecentCountry } });
        if (!mountedRef.current) return;
        if (requestId !== requestIdRef.current) return;
        setData(result);
        setDataRange(targetRange);
        setDataRecentCountry(targetRecentCountry);
        setError(null);
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
      if (isAnalyticsRange(stored)) {
        setRangeState(stored);
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
    void load(range, recentCountry, true);
  }, [hydrated, range, recentCountry, load]);

  useEffect(() => {
    if (!hydrated) return;
    if (!autoRefresh) return;
    const id = window.setInterval(() => {
      void load(range, recentCountry, false);
    }, ANALYTICS_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [hydrated, autoRefresh, range, recentCountry, load]);

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
          {data?.fetchedAt ? (
            <span className={`text-[11px] ${refreshing ? "text-osu-pink-light" : "text-osu-f1"}`}>
              {refreshing ? "refreshing..." : `updated ${formatTimeAgo(new Date(data.fetchedAt).toISOString())}`}
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

      {data && dataRange === range && dataRecentCountry === recentCountry ? (
        <>
          <AnalyticsKpiRow data={data} range={range} />
          <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
            <div className="lg:col-span-3 flex">
              <AnalyticsTopReplaysCard rows={data.topReplays} range={range} />
            </div>
            <div className="lg:col-span-2 flex">
              <AnalyticsRecentEventsCard
                rows={data.recentEvents}
                countries={data.topPhysicalCountries}
                country={recentCountry}
                onCountryChange={setRecentCountry}
              />
            </div>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <AnalyticsCountriesCard
              title="Physical country"
              subtitle={`unique visitors, ${ANALYTICS_RANGE_LABEL[range].toLowerCase()}`}
              rows={data.topPhysicalCountries}
            />
            <AnalyticsReferrersCard rows={data.topReferrers} range={range} />
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <AnalyticsServerErrorsCard
              rows={data.serverErrors}
              recent={data.recentServerErrors}
              range={range}
            />
            <AnalyticsTopRoutesCard rows={data.topRoutes} range={range} />
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <AnalyticsTopProfilesCard rows={data.topProfiles} range={range} />
          </div>
        </>
      ) : (
        <AnalyticsLoadingGrid />
      )}
    </div>
  );
}

function AnalyticsRangeSelector({ range, onChange }: { range: AnalyticsRange; onChange: (range: AnalyticsRange) => void }) {
  return (
    <div className="flex items-center gap-2">
      <div className="text-[9px] uppercase tracking-wider text-osu-f1 font-semibold">Range</div>
      <div className="flex flex-wrap items-center gap-1 rounded-lg bg-osu-b4/40 border border-osu-b3/30 p-1">
        {ANALYTICS_RANGES.map((entry) => {
          const active = entry === range;
          return (
            <button
              key={entry}
              type="button"
              onClick={() => onChange(entry)}
              className={`px-3 py-1 rounded-md text-[11px] font-medium transition-colors duration-[120ms] cursor-pointer ${
                active
                  ? "bg-osu-pink/20 text-white"
                  : "text-osu-l2 hover:text-white hover:bg-osu-b3/40"
              }`}
            >
              {ANALYTICS_RANGE_LABEL[entry]}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function AnalyticsKpiRow({ data, range }: { data: AnalyticsMonitorData; range: AnalyticsRange }) {
  const hint = ANALYTICS_RANGE_LABEL[range].toLowerCase();
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
    <SectionCard title="Top routes" subtitle={`pageviews, ${ANALYTICS_RANGE_LABEL[range].toLowerCase()}`}>
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

function AnalyticsRecentEventsCard({
  rows,
  countries,
  country,
  onCountryChange,
}: {
  rows: AnalyticsRecentEventRow[];
  countries: AnalyticsCountryRow[];
  country: string | null;
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
  const subtitle = `last ${rows.length}${countryLabel} from ${visitorCount} visitor${visitorCount === 1 ? "" : "s"}`;
  return (
    <SectionCard
      title="Recent activity"
      subtitle={subtitle}
      actions={
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <select
            value={country ?? "all"}
            onChange={(event) => onCountryChange(event.target.value === "all" ? null : event.target.value)}
            className="h-7 max-w-[150px] rounded-md border border-osu-b3/30 bg-osu-b5/70 px-2 text-[10px] font-semibold text-osu-c2 outline-none transition-colors duration-[120ms] hover:border-osu-pink/30 focus:border-osu-pink/50"
            aria-label="Recent activity country"
            title="Filter recent activity by physical country"
          >
            <option value="all">All countries</option>
            {countryOptions.map((entry) => {
              const name = getCountryName(entry.country) || entry.country;
              return (
                <option key={entry.country} value={entry.country}>
                  {name} ({entry.country})
                </option>
              );
            })}
          </select>
        </div>
      }
    >
      {rows.length === 0 ? (
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
                  <img src={getCountryFlagUrl(row.country)} alt={row.country} className="w-[14px] h-[10px] object-cover rounded-[1px] flex-shrink-0" loading="lazy" />
                ) : (
                  <span className="w-[14px] h-[10px] rounded-[1px] bg-osu-b3/40 flex-shrink-0" />
                )}
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
                  <img src={getCountryFlagUrl(code)} alt={code} className="w-[18px] h-[12px] object-cover rounded-[1px] flex-shrink-0" loading="lazy" />
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
    <img
      src={getCountryFlagUrl(code)}
      alt={code}
      title={getCountryName(code) || code}
      className="inline-block h-[10px] w-[14px] flex-shrink-0 rounded-[1px] object-cover align-middle"
      loading="lazy"
    />
  );
}

function AnalyticsTopProfilesCard({ rows, range }: { rows: AnalyticsTopProfileRow[]; range: AnalyticsRange }) {
  const max = Math.max(1, ...rows.map((row) => row.views));
  return (
    <SectionCard title="Top profile visits" subtitle={ANALYTICS_RANGE_LABEL[range].toLowerCase()}>
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
    <SectionCard title="Top replay views" subtitle={`each replay open, ${ANALYTICS_RANGE_LABEL[range].toLowerCase()}`}>
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
    <SectionCard title="Top referrers" subtitle={`unique visitors by referring domain, ${ANALYTICS_RANGE_LABEL[range].toLowerCase()}`}>
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
      subtitle={`osu! API failures, ${ANALYTICS_RANGE_LABEL[range].toLowerCase()}`}
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
  tone: "good" | "warn" | "bad" | "neutral";
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

function SnapshotCard({ snapshots, country }: { snapshots: SnapshotStats; country: string }) {
  return (
    <SectionCard title="Snapshots" subtitle={`${country} REST surfaces`}>
      <div className="space-y-2">
        <SnapshotRow label="Tracker" value={snapshots.trackerScores} fetchedAt={snapshots.trackerFetchedAt} suffix="scores" />
        <SnapshotRow label="Top plays" value={snapshots.topPlays} fetchedAt={snapshots.topPlaysFetchedAt} suffix="events" />
        <SnapshotRow label="Snipes" value={snapshots.snipes} fetchedAt={snapshots.snipesFetchedAt} suffix="events" />
      </div>
    </SectionCard>
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

function StatusCard({ status, connectionState, country }: { status: LiveBackendStatus | null; connectionState: ConnectionState; country: string }) {
  const roster = status?.roster?.find((entry) => entry.country === country);
  return (
    <SectionCard title="Process status" subtitle="Health, readiness, socket, and roster">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <DetailRow label="SSE client" value={connectionState} tone={connectionState === "open" ? "good" : "warn"} />
        <DetailRow label="Last live event" value={status?.lastEventAt ? formatTimeAgo(status.lastEventAt) : "none"} />
        <DetailRow label="Last oSC batch" value={status?.osc.lastBatchAt ? formatTimeAgo(status.osc.lastBatchAt) : "none"} />
        <DetailRow label="oSC error" value={status?.osc.lastError ?? "none"} tone={status?.osc.lastError ? "bad" : "good"} />
        <DetailRow label={`${country} roster`} value={roster ? `${formatNumber(roster.users)} users` : "not loaded"} tone={roster ? "good" : "warn"} />
        <DetailRow label="Roster refreshed" value={roster?.refreshedAt ? formatTimeAgo(roster.refreshedAt) : "never"} tone={roster?.refreshedAt ? "good" : "warn"} />
        <DetailRow label="Workers" value={status?.worker?.paused ? "paused" : "running"} tone={status?.worker?.paused ? "warn" : "good"} />
        <DetailRow label="Worker id" value={status?.worker?.workerId ?? "unknown"} />
      </div>
    </SectionCard>
  );
}

type CountryEntry = NonNullable<LiveBackendStatus["countries"]>[number];
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
  onToggleCountry,
  onDeleteCountry,
  onSetCountryTier,
}: {
  status: LiveBackendStatus | null;
  busy: string | null;
  onToggleCountry: (entry: CountryEntry) => void;
  onDeleteCountry: (entry: CountryEntry) => void;
  onSetCountryTier: (entry: CountryEntry, tier: CountryFeatureTier) => void;
}) {
  const [sortMode, setSortMode] = useState<CountrySortMode>("status");
  const [statusFilters, setStatusFilters] = useState<Record<CountryDisplayStatus, boolean>>(DEFAULT_COUNTRY_STATUS_FILTERS);
  const [tierFilters, setTierFilters] = useState<Record<CountryFeatureTier, boolean>>(DEFAULT_COUNTRY_TIER_FILTERS);
  const [preferencesLoaded, setPreferencesLoaded] = useState(false);
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
      </div>
      <div className="mb-3 rounded-md border border-osu-b3/25 bg-osu-b5/40 px-2.5 py-2">
        <div className="text-[9px] font-semibold uppercase tracking-wider text-osu-f1">
          What the tiers mean (each builds on the one before it)
        </div>
        <div className="mt-1.5 grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
          {COUNTRY_TIER_OPTIONS.map((tier) => (
            <div key={tier.value} className="flex items-center gap-1.5 text-[10px] text-osu-f1">
              <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${tier.dot}`} />
              <span className={`font-semibold uppercase tracking-wider ${tier.tone}`}>{tier.label}</span>
              <span className="text-osu-f1/70">{tier.blurb}</span>
            </div>
          ))}
        </div>
      </div>
      {sorted.length === 0 ? (
        <div className="text-[11px] text-osu-f1">{countries.length === 0 ? "No countries registered." : "No countries match these filters."}</div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {sorted.map((entry) => (
            <CountryRow
              key={entry.country}
              entry={entry}
              users={rosterByCountry.get(entry.country) ?? null}
              busy={busy === `pause-country-${entry.country}` || busy === `resume-country-${entry.country}` || busy === `delete-country-${entry.country}` || busy === `set-tier-${entry.country}`}
              onToggle={() => onToggleCountry(entry)}
              onDelete={() => onDeleteCountry(entry)}
              onSetTier={(tier) => onSetCountryTier(entry, tier)}
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
  busy,
  onToggle,
  onDelete,
  onSetTier,
}: {
  entry: CountryEntry;
  users: number | null;
  busy: boolean;
  onToggle: () => void;
  onDelete: () => void;
  onSetTier: (tier: CountryFeatureTier) => void;
}) {
  const displayStatus = getCountryDisplayStatus(entry);
  const statusTone = displayStatus === "paused" || displayStatus === "idle" ? "text-osu-red" : displayStatus === "active" ? "text-osu-green" : "text-osu-yellow";
  const featureTier = getCountryFeatureTier(entry);
  const activeUsers = entry.activeUsers ?? 0;
  const shouldResume = entry.status === "paused" || !entry.isWarm;
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
        <img
          src={getCountryFlagUrl(entry.country)}
          alt={entry.country}
          className="h-4 w-6 rounded-sm object-cover flex-shrink-0"
          loading="lazy"
        />
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
          <div className="flex flex-col items-end leading-none">
            <span className="text-[8px] font-semibold uppercase tracking-wider text-osu-f1">lifecycle</span>
            <span className={`text-[10px] font-semibold uppercase tracking-wider ${statusTone}`}>{displayStatus}</span>
          </div>
          <button
            type="button"
            title={shouldResume ? `Resume ${entry.country} country warmup` : `Pause ${entry.country} country warmup`}
            aria-label={shouldResume ? `Resume ${entry.country} country warmup` : `Pause ${entry.country} country warmup`}
            disabled={busy}
            onClick={onToggle}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-osu-b3/40 bg-osu-b4/70 text-osu-f1 transition hover:border-osu-c2/60 hover:text-white disabled:opacity-50"
          >
            {shouldResume ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
          </button>
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
  const workerLanes = status?.worker?.lanes ?? [];
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

function DetailRow({ label, value, tone = "neutral" }: { label: string; value: string; tone?: "good" | "warn" | "bad" | "neutral" }) {
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
  return (
    <SectionCard title="Job queue" subtitle="Counts by type and status">
      <div className="space-y-3">
        <div className="rounded-md bg-osu-b5/60 border border-osu-b3/20 px-3 py-2 flex items-center gap-3">
          <div className="text-[9px] uppercase tracking-wider text-osu-f1 font-semibold">Active depth</div>
          <div className="ml-auto text-xl font-bold text-white">{formatNumber(depth)}</div>
        </div>
        <div className="space-y-1.5 max-h-[360px] overflow-auto pr-1">
          {rows.length === 0 ? (
            <div className="text-[11px] text-osu-f1 py-3">No jobs recorded.</div>
          ) : (
            rows.map((row) => <QueueSummaryRow key={`${row.status}:${row.type}`} row={row} />)
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
