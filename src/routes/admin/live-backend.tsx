import { createFileRoute, notFound } from "@tanstack/react-router";
import { Activity, ArrowLeft, Ban, ChevronDown, ChevronRight, Crosshair, Database, History, RefreshCw, RotateCcw, Search, Server, Signal, Table2, Trash2, Wifi, WifiOff, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { canUseAdminFeatures } from "../../lib/auth-shared";
import {
  fetchLiveBackendAdminStatus,
  fetchLiveBackendStorageBreakdown,
  fetchLiveBackendSweeps,
  fetchLiveBackendTableRows,
  getLiveBackendUrl,
  openLiveEventSource,
  previewLiveBackendUserWipe,
  runLiveBackendAdminAction,
  setLiveBackendUserActive,
  wipeLiveBackendUserData,
  type LiveBackendStorageBreakdown,
  type LiveBackendSweep,
  type LiveBackendTableCell,
  type LiveBackendTablePreview,
  type LiveBackendUserActiveResult,
  type LiveBackendUserWipePreview,
  type LiveBackendUserWipeResult,
  type LiveEventName,
} from "../../lib/live-backend";
import { formatNumber, formatTimeAgo } from "../../lib/format";
import {
  describeOsuCaller,
  describeOsuPath,
  OSU_CALL_ORIGINS,
  type OsuCallOrigin,
  type OsuEntityNames,
} from "../../lib/osu-api-callers";
import { COUNTRY_OPTIONS, getCountryName } from "../../lib/country";
import { CountryFlag } from "../../components/ui/CountryFlag";
import { SectionCard } from "../../components/admin/SectionCard";
import { AnalyticsMonitorPanel } from "../../components/admin/analytics/AnalyticsMonitorPanel";

type ConnectionState = "idle" | "connecting" | "open" | "error";
type StatusTone = "good" | "warn" | "bad" | "neutral";


interface LiveBackendStatus {
  ok: boolean;
  db: boolean;
  storage?: {
    // Admin-only: the public /api/status body omits the absolute path.
    filePath?: string | null;
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
  // The serving process's write gate (db.ts withWriteGate): queue depth and
  // wait EWMA are the write-saturation signal, sheds the 429s it handed out.
  writeGate?: {
    depth: number;
    peakDepth: number;
    gatedCalls: number;
    sheds: number;
    lastWaitMs: number;
    ewmaWaitMs: number;
  } | null;
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
    osuApi?: boolean;
  }>;
  roster?: Array<{ country: string; users: number; refreshedAt: string | null }>;
  analysis?: {
    version: number;
    analyzed: number;
    running: number;
    failed: number;
    unavailable: number;
    searchIndexed: number;
  };
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
    byLane?: Array<{ lane: string; count: number }>;
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
    byCaller: Array<{ caller: string; count: number; avgMs?: number | null; maxMs?: number | null; errors?: number }>;
    byPath: Array<{ path: string; count: number; avgMs?: number | null; maxMs?: number | null; errors?: number }>;
    // Player/map names for the ids inside those paths, admin bodies only.
    names?: OsuEntityNames;
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
  // Operational counters below are admin-only: /api/admin/status emits them,
  // the public /api/status body (the 404 fallback in fetchLiveBackendAdminStatus)
  // does not. They are also all optional so a backend running older code during
  // a rolling deploy renders as "not reported" instead of crashing the page.
  memory?: {
    server: ProcessMemorySample | null;
    // Null when the serving process cannot see the worker's sample: a
    // server-role process reads it from the live_meta mirror, and a worker on
    // older code writes no sample at all.
    worker: ProcessMemorySample | null;
  };
  mapsSnapshotThread?: MapsSnapshotThreadStatus;
  // Same shape as the maps thread, since it is the same pattern.
  packCommunityThread?: MapsSnapshotThreadStatus;
  packCommunitySnapshots?: PackCommunitySnapshotsStatus;
  // Last completed GLOBAL maps refresh, measured in the worker process and
  // persisted to live_meta so the serving process can report it.
  globalMapsRefresh?: JobMemoryRecord | null;
  responseCaches?: {
    mapsPage: ResponseCacheMetrics;
  };
  // Null when the database is remote: there is no local disk to run out of.
  disk?: DiskUsage | null;
  storagePaths?: StorageFootprint | null;
}

// process.memoryUsage() plus resourceUsage().maxRSS, taken in one process.
interface ProcessMemorySample {
  pid: number;
  role: string;
  at: string;
  uptimeSec: number;
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
  // Process-lifetime high-water mark (VmHWM), or null where the runtime
  // refuses to report it.
  peakRssBytes: number | null;
  hint?: string;
}

interface MapsSnapshotThreadStatus {
  enabled: boolean;
  disabledReason: string | null;
  spawned: boolean;
  everOnline: boolean;
  available: boolean;
  cooldownMsRemaining: number;
  /** Builds handed to the thread and not yet answered; there is no queue behind it. */
  inFlight: number;
  requested: number;
  ok: number;
  failed: number;
  timeouts: number;
  lastBuildMs: number | null;
  lastBuildAt: string | null;
  lastBuildBytes: number | null;
  lastErrorAt: string | null;
  lastError: string | null;
  lastFailureReason: string | null;
}

/* The three prepared answers behind /packs/collections. "source" is where the
   one in hand came from: disk is a restart that started warm, inline means the
   thread is not running here. */
interface PackCommunitySlotStatus {
  source: string;
  computedAt: string | null;
  ageMs: number | null;
  ttlMs: number;
  building: boolean;
  builds: number;
  lastBuildMs: number | null;
  lastBuildAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
}

interface PackCommunitySnapshotsStatus {
  collector: PackCommunitySlotStatus;
  card: PackCommunitySlotStatus;
  totals: PackCommunitySlotStatus;
  diskCache: boolean;
}

interface JobMemoryRecord {
  jobType: string;
  at: string;
  pid: number;
  durationMs: number;
  ok: boolean;
  error: string | null;
  startRssBytes: number;
  peakRssBytes: number;
  endRssBytes: number;
  startHeapUsedBytes: number;
  peakHeapUsedBytes: number;
  processPeakRssBytes: number | null;
  samples: number;
  concurrentJobs: number;
  hint?: string;
}

interface ResponseCacheMetrics {
  entries: number;
  bytes: number;
  maxEntries: number;
  maxBytes: number;
  maxEntryBytes: number;
}

interface DiskUsage {
  path: string;
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  usedPct: number;
  warnPct: number;
  criticalPct: number;
  level: "ok" | "warn" | "critical";
}

interface StorageFootprint {
  db: number | null;
  dbWal: number | null;
  dbShm: number | null;
  analytics: number | null;
  analyticsWal: number | null;
  journal?: number | null;
  journalWal?: number | null;
  backups: number | null;
  replayVideoWork: number | null;
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

const BACKEND_REFRESH_MS = 5_000;
const DEFAULT_COUNTRY = "CR";
const MONITORING_TABS = ["backend", "analytics"] as const;
type MonitoringTab = (typeof MONITORING_TABS)[number];
const HIDDEN_WORKER_LANE_NAMES = new Set([
  "dan-estimates",
  "replay-video-render",
  "replay-video-finalize",
]);

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
  const [storageOpen, setStorageOpen] = useState(false);

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
      setError(err instanceof Error ? err.message : "Could not reach server.");
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
      return err instanceof Error ? err.message : "Could not reach server.";
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

  const patchCountryTier = useCallback((country: string, featureTier: CountryFeatureTier) => {
    setStatus((current) => {
      if (!current?.countries) return current;
      return {
        ...current,
        countries: current.countries.map((entry) =>
          entry.country === country
            ? { ...entry, featureTier }
            : entry,
        ),
      };
    });
  }, []);

  const patchAddCountry = useCallback((country: string) => {
    const normalized = country.trim().toUpperCase().slice(0, 2);
    if (!/^[A-Z]{2}$/.test(normalized)) return;
    setStatus((current) => {
      if (!current?.countries || current.countries.some((entry) => entry.country === normalized)) return current;
      const now = new Date().toISOString();
      return {
        ...current,
        countries: [
          {
            country: normalized,
            status: "active",
            featureTier: "live",
            pinned: false,
            firstRequestedAt: now,
            lastRequestedAt: now,
            lastRosterRefreshAt: null,
            lastScoreAt: null,
            activeUsers: 0,
            lastActiveAt: null,
            isWarm: true,
          },
          ...current.countries,
        ],
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
      ["pack_pull", addEvent("pack_pull")],
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
              <div className="text-[9px] uppercase tracking-wider text-osu-f1 font-semibold">Server</div>
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

          <Section title="Health" subtitle="Is the server up and ingesting?">
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
                onClick={() => setStorageOpen(true)}
              />
              <KpiCard
                label="Ingest"
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
              <KpiCard
                label="Write gate"
                value={status?.writeGate ? `${formatNumber(status.writeGate.ewmaWaitMs)}ms` : "—"}
                hint={status?.writeGate ? `depth ${formatNumber(status.writeGate.depth)} (peak ${formatNumber(status.writeGate.peakDepth)}), ${formatNumber(status.writeGate.sheds)} shed` : "avg wait for the write lock queue"}
                tone={status?.writeGate && (status.writeGate.sheds > 0 || status.writeGate.ewmaWaitMs > 2000) ? "warn" : "neutral"}
                icon={<Database className="h-4 w-4" />}
              />
            </div>
          </Section>

          {storageOpen ? <StorageBreakdownModal status={status} onClose={() => setStorageOpen(false)} /> : null}

          <Section title="Status" subtitle="Process, ingest, roster, and country snapshots">
            <StatusCard status={status} connectionState={connectionState} country={countryCode} snapshots={snapshots} />
          </Section>

          <Section title="Countries" subtitle="Which countries the server is currently tracking">
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
              onSetCountryTier={(entry, tier) => {
                void runAdminAction(
                  `set-tier-${entry.country}`,
                  `/api/admin/set-country-tier?country=${encodeURIComponent(entry.country)}&tier=${encodeURIComponent(tier)}`,
                  () => patchCountryTier(entry.country, tier),
                );
              }}
              onAddCountry={(country) => {
                void runAdminAction(
                  `add-country-${country}`,
                  `/api/admin/add-country?country=${encodeURIComponent(country)}`,
                  () => patchAddCountry(country),
                );
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

          <Section title="Sweeps" subtitle="Background sweeps and folds coordinated through live_meta done keys">
            <SweepsCard />
          </Section>

          <Section title="Traffic guard" subtitle="In-memory abuse guard pressure for public traffic and SSE connections">
            <AbuseGuardCard status={status} />
          </Section>

          <Section title="osu! API pressure" subtitle="Who and what is burning rate-limit budget, in plain terms">
            <RateBreakdownCard status={status} />
          </Section>

          <Section title="Users" subtitle="Two controls: a reversible soft-deactivate/reactivate (untracks the player and marks them inactive, deletes nothing), and an irreversible wipe that also deletes their board/score projections, profile page and activity.">
            <UserModerationCard />
            <UserWipeCard />
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
  const contextLabel = activeTab === "backend" ? backendUrl ?? "not configured" : "visitor analytics";
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
    { value: "backend", label: "Server", hint: "ingest, SSE, jobs, countries" },
    { value: "analytics", label: "Analytics", hint: "who is here and what they are doing" },
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

function KpiCard({
  label,
  value,
  hint,
  tone,
  icon,
  onClick,
}: {
  label: string;
  value: string;
  hint: string;
  tone: StatusTone;
  icon: React.ReactNode;
  onClick?: () => void;
}) {
  const toneClass = {
    good: "text-osu-green-light bg-osu-green-light/10 border-osu-green-light/25",
    warn: "text-osu-yellow bg-osu-yellow/10 border-osu-yellow/25",
    bad: "text-osu-red-light bg-osu-red/10 border-osu-red/30",
    neutral: "text-white bg-osu-b4/40 border-osu-b3/30",
  }[tone];
  const inner = (
    <>
      <div className="flex items-center justify-between gap-3">
        <div className="text-[9px] uppercase tracking-wider text-osu-f1 font-semibold">{label}</div>
        <div className="text-current opacity-90">{icon}</div>
      </div>
      <div className="text-2xl font-bold tracking-tight leading-none mt-2 text-current">{value}</div>
      <div className="text-[10px] text-osu-f1 mt-1.5 truncate">{hint}</div>
    </>
  );
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={`rounded-lg border px-4 py-3 text-left w-full transition-[filter] hover:brightness-125 cursor-pointer ${toneClass}`}>
        {inner}
      </button>
    );
  }
  return <div className={`rounded-lg border px-4 py-3 ${toneClass}`}>{inner}</div>;
}

// Modal opened from the Database KPI: per-table storage distribution, fetched on
// demand from /api/admin/storage-breakdown (dbstat). Bars are sized relative to the
// largest table; the percentage is each table's share of on-disk table data.
function StorageBreakdownModal({ status, onClose }: { status: LiveBackendStatus | null; onClose: () => void }) {
  const [data, setData] = useState<LiveBackendStorageBreakdown | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [stale, setStale] = useState(false);
  const [loading, setLoading] = useState(true);
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [showAllTables, setShowAllTables] = useState(false);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Escape steps back out of a table view first, then closes the modal.
      setSelectedTable((current) => {
        if (current) return null;
        onClose();
        return current;
      });
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = (initial: boolean) => {
      if (initial) setLoading(true);
      setError(null);
      fetchLiveBackendStorageBreakdown()
        .then((res) => {
          if (cancelled) return;
          if (res.storage) setData(res.storage);
          setScanning(!!res.scanning);
          setStale(!!res.stale);
          setLoading(false);
          if (res.scanning) {
            timer = setTimeout(() => load(false), 2_500);
          }
        })
        .catch((err) => {
          if (cancelled) return;
          setError(err instanceof Error ? err.message : "Could not load storage.");
          setScanning(false);
          setLoading(false);
        });
    };
    load(true);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  const dbFileBytes = data?.fileBytes ?? status?.storage?.bytes ?? null;
  const walBytes = data?.walBytes ?? status?.storage?.walBytes ?? null;
  const fileTotal = dbFileBytes != null || walBytes != null ? (dbFileBytes ?? 0) + (walBytes ?? 0) : null;
  const maxBytes = data?.maxBytes ?? status?.storage?.maxBytes ?? 0;
  const TOP_N = 14;
  const rows = data?.tables ?? [];
  const shown = rows.slice(0, TOP_N);
  const rest = rows.slice(TOP_N);
  const restBytes = rest.reduce((sum, table) => sum + table.bytes, 0);
  const largest = shown[0]?.bytes ?? 1;
  const totalTableBytes = data?.tableBytes ?? 0;
  const unassignedBytes = fileTotal == null || totalTableBytes <= 0 ? null : Math.max(fileTotal - totalTableBytes, 0);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/65 px-4" onClick={onClose}>
      <div className="flex max-h-[85vh] w-full max-w-[560px] flex-col overflow-hidden rounded-lg border border-osu-b3/40 bg-osu-b5 shadow-2xl" onClick={(event) => event.stopPropagation()}>
        {selectedTable ? (
          <TableBrowserView
            table={selectedTable}
            sizeBytes={rows.find((row) => row.name === selectedTable)?.bytes ?? null}
            onBack={() => setSelectedTable(null)}
            onClose={onClose}
          />
        ) : (
          <>
            <div className="flex items-center gap-3 border-b border-osu-b3/20 px-4 pt-3 pb-2.5">
              <Database className="h-4 w-4 flex-shrink-0 text-osu-c2" />
              <div className="min-w-0 flex-1">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-osu-c2">Database storage</div>
                <div className="text-[10px] text-osu-f1">
                  {formatBytes(fileTotal)} file + WAL of {formatBytes(maxBytes)} limit{data ? ` · ${formatBytes(totalTableBytes)} table pages · ${data.tables.length} tables` : ""}
                  {scanning ? " · scanning" : stale ? " · cached" : ""}
                </div>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="flex-shrink-0 rounded-md border border-osu-b3/30 bg-osu-b4/60 px-2.5 py-1 text-[11px] text-osu-l2 transition-colors duration-[120ms] hover:bg-osu-b3/60 hover:text-white cursor-pointer"
              >
                Close
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              {(loading || (scanning && !data)) ? (
                <div className="py-12 text-center text-[12px] text-osu-f1">Scanning tables...</div>
              ) : error ? (
                <div className="py-12 text-center text-[12px] text-osu-red-light">{error}</div>
              ) : !data || shown.length === 0 ? (
                <div className="py-12 text-center text-[12px] text-osu-f1">Per-table sizes are not available on this database build.</div>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {shown.map((table) => {
                    const pct = totalTableBytes > 0 ? (table.bytes / totalTableBytes) * 100 : 0;
                    const width = largest > 0 ? (table.bytes / largest) * 100 : 0;
                    return (
                      <button
                        key={table.name}
                        type="button"
                        onClick={() => setSelectedTable(table.name)}
                        className="group rounded-md bg-osu-b4/30 px-2.5 py-1.5 text-left transition-colors hover:bg-osu-b4/60 cursor-pointer"
                      >
                        <div className="flex items-center justify-between gap-3">
                          <span className="flex min-w-0 items-center gap-1.5">
                            <span className="truncate font-mono text-[11px] text-osu-l2 group-hover:text-white">{table.name}</span>
                            <ChevronRight className="h-3 w-3 flex-shrink-0 text-osu-f1/50 transition-transform group-hover:translate-x-0.5 group-hover:text-osu-c2" />
                          </span>
                          <span className="flex-shrink-0 text-[11px] tabular-nums text-white">
                            {formatBytes(table.bytes)} <span className="text-osu-f1">· {pct.toFixed(1)}%</span>
                          </span>
                        </div>
                        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-osu-b5/70">
                          <div className="h-full rounded-full bg-osu-pink" style={{ width: `${Math.max(width, 1.5)}%` }} />
                        </div>
                      </button>
                    );
                  })}
                  {rest.length > 0 ? (
                    showAllTables ? (
                      <div className="flex flex-col gap-1 rounded-md bg-osu-b4/20 p-1.5">
                        {rest.map((table) => (
                          <button
                            key={table.name}
                            type="button"
                            onClick={() => setSelectedTable(table.name)}
                            className="flex items-center justify-between gap-3 rounded px-2 py-1 text-left transition-colors hover:bg-osu-b4/60 cursor-pointer"
                          >
                            <span className="truncate font-mono text-[11px] text-osu-f1 hover:text-osu-l2">{table.name}</span>
                            <span className="flex-shrink-0 text-[10px] tabular-nums text-osu-f1">{formatBytes(table.bytes)}</span>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setShowAllTables(true)}
                        className="flex items-center justify-between gap-3 rounded-md px-2.5 py-1.5 text-[11px] text-osu-f1 transition-colors hover:text-osu-l2 cursor-pointer"
                      >
                        <span className="flex items-center gap-1"><ChevronDown className="h-3 w-3" /> {rest.length} smaller {rest.length === 1 ? "table" : "tables"}</span>
                        <span className="tabular-nums">
                          {formatBytes(restBytes)} · {totalTableBytes > 0 ? ((restBytes / totalTableBytes) * 100).toFixed(1) : "0"}%
                        </span>
                      </button>
                    )
                  ) : null}
                  <div className="mt-1 text-[9px] leading-relaxed text-osu-f1">
                    Click a table to read its newest rows. Sizes total {formatBytes(totalTableBytes)} of table b-tree/index pages, grouped by owning table{data.capturedAt ? ` · measured ${formatTimeAgo(data.capturedAt)}` : ""}. File/WAL outside these rows: {formatBytes(unassignedBytes)}.
                    {scanning ? " Refreshing in the background." : ""}
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// Read-only drill-in from the storage list: pages the newest rows of one table
// and renders each as a labelled record card (JSON columns pretty-printed,
// long/blob cells clipped) so the data is legible without a SQL client.
function TableBrowserView({
  table,
  sizeBytes,
  onBack,
  onClose,
}: {
  table: string;
  sizeBytes: number | null;
  onBack: () => void;
  onClose: () => void;
}) {
  const [data, setData] = useState<LiveBackendTablePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const PAGE = 25;

  // Debounce keystrokes into the query that actually drives fetches.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const load = useCallback((offset: number, append: boolean) => {
    if (append) setLoadingMore(true);
    else setLoading(true);
    setError(null);
    fetchLiveBackendTableRows({ data: { table, limit: PAGE, offset, search } })
      .then((res) => {
        if (!res) {
          setError("Table not found.");
          return;
        }
        setData((prev) => (append && prev ? { ...res, rows: [...prev.rows, ...res.rows] } : res));
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Could not read table."))
      .finally(() => {
        setLoading(false);
        setLoadingMore(false);
      });
  }, [table, search]);

  useEffect(() => {
    setData(null);
    load(0, false);
  }, [load]);

  const rows = data?.rows ?? [];
  const hasMore = data ? rows.length < data.totalRows : false;
  const searching = search.length > 0;

  return (
    <>
      <div className="flex items-center gap-2.5 border-b border-osu-b3/20 px-3 pt-3 pb-2.5">
        <button
          type="button"
          onClick={onBack}
          className="flex flex-shrink-0 items-center gap-1 rounded-md border border-osu-b3/30 bg-osu-b4/60 px-2 py-1 text-[11px] text-osu-l2 transition-colors hover:bg-osu-b3/60 hover:text-white cursor-pointer"
        >
          <ArrowLeft className="h-3 w-3" /> Tables
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <Table2 className="h-3.5 w-3.5 flex-shrink-0 text-osu-c2" />
            <span className="truncate font-mono text-[12px] font-semibold text-white">{table}</span>
          </div>
          <div className="text-[10px] text-osu-f1">
            {data
              ? searching
                ? `${formatNumber(data.totalRows)} ${data.totalRows === 1 ? "match" : "matches"}`
                : `${formatNumber(data.totalRows)} ${data.totalRows === 1 ? "row" : "rows"} · ${data.columns.length} columns`
              : "Reading..."}
            {sizeBytes != null && !searching ? ` · ${formatBytes(sizeBytes)}` : ""}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="flex-shrink-0 rounded-md border border-osu-b3/30 bg-osu-b4/60 px-2.5 py-1 text-[11px] text-osu-l2 transition-colors hover:bg-osu-b3/60 hover:text-white cursor-pointer"
        >
          Close
        </button>
      </div>
      <div className="flex items-center gap-2 border-b border-osu-b3/20 px-3 py-2">
        <Search className="h-3.5 w-3.5 flex-shrink-0 text-osu-f1" />
        <input
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
          placeholder="Search this table (username, title, id...)"
          className="min-w-0 flex-1 bg-transparent text-[12px] text-osu-l2 placeholder:text-osu-f1/50 focus:outline-none"
        />
        {searchInput ? (
          <button type="button" onClick={() => setSearchInput("")} className="flex-shrink-0 text-osu-f1 hover:text-white cursor-pointer" title="Clear">
            <X className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {loading ? (
          <div className="py-12 text-center text-[12px] text-osu-f1">{searching ? "Searching..." : "Reading rows..."}</div>
        ) : error ? (
          <div className="py-12 text-center text-[12px] text-osu-red-light">{error}</div>
        ) : rows.length === 0 ? (
          <div className="py-12 text-center text-[12px] text-osu-f1">{searching ? `No rows match "${search}".` : "This table is empty."}</div>
        ) : (
          <div className="flex flex-col gap-2">
            {rows.map((row, index) => (
              <TableRowCard key={index} columns={data!.columns} row={row} index={index} />
            ))}
            {hasMore ? (
              <button
                type="button"
                disabled={loadingMore}
                onClick={() => load(rows.length, true)}
                className="mt-1 rounded-md border border-osu-b3/30 bg-osu-b4/40 px-3 py-2 text-[11px] text-osu-l2 transition-colors hover:bg-osu-b4/70 hover:text-white disabled:opacity-50 cursor-pointer"
              >
                {loadingMore ? "Loading..." : `Load more (${formatNumber(rows.length)} of ${formatNumber(data!.totalRows)})`}
              </button>
            ) : (
              <div className="mt-1 text-center text-[10px] text-osu-f1">
                {searching
                  ? `All ${formatNumber(rows.length)} ${rows.length === 1 ? "match" : "matches"} shown.`
                  : rows.length === data!.totalRows ? "All rows shown." : `Showing newest ${formatNumber(rows.length)}.`}
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}

// One DB row, presented like the entity it represents instead of a raw column
// dump: a player/map header (avatar or cover art + name + the key-stat badges),
// a compact multi-column grid for the remaining scalar fields, and JSON blobs
// collapsed at the bottom. The extraction is convention-based (avatar_url,
// username, covers_json, stars/bpm/pp, ...) so it lights up across every table
// that shares those column names, including fields nested inside *_json.
function TableRowCard({
  columns,
  row,
  index,
}: {
  columns: LiveBackendTablePreview["columns"];
  row: Record<string, LiveBackendTableCell>;
  index: number;
}) {
  const entity = useMemo(() => extractRowEntity(row), [row]);
  const scalars = columns.filter((col) => !entity.consumed.has(col.name) && !isWideCell(row[col.name]));
  const wides = columns.filter((col) => !entity.consumed.has(col.name) && isWideCell(row[col.name]));
  const hasHeader = !!(entity.avatar || entity.cover || entity.title || entity.badges.length);
  const userId = resolveUserId(row);
  const initialActive = typeof row["is_active"] === "number" ? row["is_active"] !== 0 : null;

  return (
    <div className="overflow-hidden rounded-lg border border-osu-b3/25 bg-osu-b4/25">
      {hasHeader ? (
        <div className="flex items-center gap-2.5 border-b border-osu-b3/15 bg-osu-b4/40 px-3 py-2">
          {entity.avatar ? (
            <img src={entity.avatar} alt="" className="h-9 w-9 flex-shrink-0 rounded-full bg-osu-b5 object-cover" />
          ) : entity.cover ? (
            <div className="h-9 w-16 flex-shrink-0 overflow-hidden rounded bg-osu-b5">
              <img src={entity.cover} alt="" className="h-full w-full object-cover" />
            </div>
          ) : null}
          <div className="min-w-0 flex-1">
            {entity.title ? <div className="truncate text-[13px] font-semibold text-white">{entity.title}</div> : null}
            <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[10px] text-osu-f1">
              {entity.subtitle ? <span className="truncate">{entity.subtitle}</span> : null}
              {entity.subtitle && entity.badges.length ? <span className="text-osu-b3">·</span> : null}
              {entity.badges.map((badge, badgeIndex) => (
                <span key={badgeIndex} className="inline-flex items-center gap-1 rounded bg-osu-b5/70 px-1.5 py-0.5 text-osu-l2">
                  {badge.country ? <CountryFlag code={badge.country} size="xs" decorative /> : null}
                  {badge.label ? <span className="text-osu-f1">{badge.label}</span> : null}
                  <span className="tabular-nums">{badge.value}</span>
                </span>
              ))}
            </div>
          </div>
          {userId ? (
            <UserActiveButton userId={userId} username={entity.title} initialActive={initialActive} />
          ) : null}
          <span className="flex-shrink-0 self-start text-[9px] tabular-nums text-osu-f1/50">#{index + 1}</span>
        </div>
      ) : (
        <div className="border-b border-osu-b3/15 px-3 py-1 text-[9px] font-semibold uppercase tracking-wider text-osu-f1/60">Row {index + 1}</div>
      )}
      {scalars.length ? (
        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 p-2.5 sm:grid-cols-3">
          {scalars.map((col) => <ScalarCell key={col.name} col={col} value={row[col.name]} />)}
        </div>
      ) : null}
      {wides.length ? (
        <div className="flex flex-col gap-1 border-t border-osu-b3/10 p-2">
          {wides.map((col) => <WideField key={col.name} col={col} value={row[col.name]} />)}
        </div>
      ) : null}
    </div>
  );
}

// The osu! user id a row belongs to, if any: a top-level user_id/osu_user_id
// column, or the id nested inside a user_json/profile_json blob.
function resolveUserId(row: Record<string, LiveBackendTableCell>): number | null {
  for (const key of ["user_id", "osu_user_id"]) {
    const value = Number(row[key]);
    if (Number.isInteger(value) && value > 0) return value;
  }
  for (const key of ["user_json", "profile_json"]) {
    const raw = row[key];
    if (typeof raw !== "string") continue;
    try {
      const parsed = JSON.parse(raw) as { id?: unknown };
      const id = Number(parsed?.id);
      if (Number.isInteger(id) && id > 0) return id;
    } catch { /* not a user blob */ }
  }
  return null;
}

// The reversible "delete this cheater" control on a player row: soft-deactivate
// (untrack from rosters + mark inactive, the same path ban-detection uses) or
// reactivate. Two-step confirm since it hits prod, but nothing is deleted.
function UserActiveButton({ userId, username, initialActive }: { userId: number; username: string | null; initialActive: boolean | null }) {
  const [active, setActive] = useState<boolean | null>(initialActive);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<LiveBackendUserActiveResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  // When state is unknown (row has no is_active column), assume active so the
  // primary offered action is Deactivate.
  const isActive = active ?? true;

  const run = (next: boolean) => {
    setBusy(true);
    setError(null);
    setLiveBackendUserActive({ data: { userId, active: next } })
      .then((res) => { setResult(res); setActive(res.active); setConfirming(false); })
      .catch((err) => setError(err instanceof Error ? err.message : "Action failed."))
      .finally(() => setBusy(false));
  };

  if (result) {
    return (
      <span className="flex-shrink-0 self-start text-[10px] text-osu-f1">
        {busy ? "..." : result.active ? "reactivated" : "deactivated"}
        <button type="button" disabled={busy} onClick={() => run(!result.active)} className="ml-1 text-osu-c2 hover:text-white disabled:opacity-50 cursor-pointer">undo</button>
      </span>
    );
  }

  if (confirming) {
    return (
      <span className="flex flex-shrink-0 items-center gap-1 self-start">
        <button
          type="button"
          disabled={busy}
          onClick={() => run(!isActive)}
          className={`rounded px-1.5 py-0.5 text-[10px] font-semibold text-white disabled:opacity-50 cursor-pointer ${isActive ? "bg-osu-red hover:bg-osu-red-light" : "bg-osu-green hover:bg-osu-green-light"}`}
        >
          {busy ? "..." : isActive ? "Confirm deactivate" : "Confirm reactivate"}
        </button>
        <button type="button" disabled={busy} onClick={() => setConfirming(false)} className="rounded px-1 py-0.5 text-[10px] text-osu-f1 hover:text-white cursor-pointer">cancel</button>
      </span>
    );
  }

  return (
    <span className="flex flex-shrink-0 flex-col items-end gap-0.5 self-start">
      <button
        type="button"
        onClick={() => setConfirming(true)}
        title={isActive ? `Deactivate ${username ?? `user ${userId}`}` : `Reactivate ${username ?? `user ${userId}`}`}
        className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] transition-colors cursor-pointer ${
          isActive
            ? "border-osu-red/40 text-osu-red-light hover:bg-osu-red/20"
            : "border-osu-green/40 text-osu-green-light hover:bg-osu-green/20"
        }`}
      >
        {isActive ? <Ban className="h-3 w-3" /> : <RotateCcw className="h-3 w-3" />}
        {isActive ? "Deactivate" : "Reactivate"}
      </button>
      {error ? <span className="text-[9px] text-osu-red-light">{error}</span> : null}
    </span>
  );
}

// A short scalar field in the grid: tiny column label over a formatted value.
// pat_* pattern weights (0..1) render as a mini bar so map rows read visually.
function ScalarCell({ col, value }: { col: { name: string; type: string }; value: LiveBackendTableCell }) {
  if (col.name.startsWith("pat_") && typeof value === "number" && Number.isFinite(value)) {
    const pct = Math.max(0, Math.min(1, value)) * 100;
    return (
      <div>
        <div className="truncate font-mono text-[9px] text-osu-c2/80" title={col.name}>{col.name.replace("pat_", "")}</div>
        <div className="mt-1 flex items-center gap-1.5">
          <div className="h-1 flex-1 overflow-hidden rounded-full bg-osu-b5/70">
            <div className="h-full rounded-full bg-osu-pink" style={{ width: `${pct}%` }} />
          </div>
          <span className="tabular-nums text-[10px] text-osu-l2">{value.toFixed(2)}</span>
        </div>
      </div>
    );
  }
  return (
    <div className="min-w-0">
      <div className="truncate font-mono text-[9px] text-osu-c2/80" title={`${col.name}${col.type ? ` (${col.type})` : ""}`}>{col.name}</div>
      <div className="mt-0.5 break-words text-[11px] text-osu-l2">{formatScalar(col.name, value)}</div>
    </div>
  );
}

const BOOLEAN_COLUMNS = new Set(["is_active", "is_tracked", "passed", "processed", "pinned", "keep_warm", "preserve"]);

function formatScalar(name: string, value: LiveBackendTableCell): React.ReactNode {
  if (value === null) return <span className="italic text-osu-f1/40">null</span>;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") {
    if ((value === 0 || value === 1) && (/^(is_|has_)/.test(name) || BOOLEAN_COLUMNS.has(name))) {
      return value === 1 ? "Yes" : "No";
    }
    if (Number.isInteger(value) && Math.abs(value) >= 10_000) {
      return <span className="tabular-nums" title={String(value)}>{formatNumber(value)}</span>;
    }
    return <span className="tabular-nums">{String(value)}</span>;
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return <span title={value}>{formatTimeAgo(value)}</span>;
  return <span>{value}</span>;
}

// A large/JSON field, collapsed by default so it never dominates the card. Opens
// into a pretty-printed, scrollable block.
function WideField({ col, value }: { col: { name: string; type: string }; value: LiveBackendTableCell }) {
  const [open, setOpen] = useState(false);
  const pretty = typeof value === "string" ? tryPrettyJson(value) : null;
  const text = pretty ?? String(value ?? "");
  const preview = text.replace(/\s+/g, " ").trim().slice(0, 90);
  return (
    <div className="rounded border border-osu-b3/15 bg-osu-b5/40">
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-1.5 px-2 py-1 text-left cursor-pointer">
        {open ? <ChevronDown className="h-3 w-3 flex-shrink-0 text-osu-f1" /> : <ChevronRight className="h-3 w-3 flex-shrink-0 text-osu-f1" />}
        <span className="flex-shrink-0 font-mono text-[10px] text-osu-c2">{col.name}</span>
        {!open ? <span className="truncate text-[10px] text-osu-f1/80">{preview}</span> : null}
      </button>
      {open ? (
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words px-2 pb-2 font-mono text-[10px] leading-relaxed text-osu-l2">{text}</pre>
      ) : null}
    </div>
  );
}

type JsonObject = Record<string, unknown>;

interface RowEntity {
  avatar: string | null;
  cover: string | null;
  title: string | null;
  subtitle: string | null;
  badges: Array<{ label: string; value: string; country?: string }>;
  consumed: Set<string>;
}

// Pull a human-facing header out of an arbitrary DB row using column-name
// conventions shared across the schema, reaching into user_json/profile_json for
// player rows where the identity lives inside the blob.
function extractRowEntity(row: Record<string, LiveBackendTableCell>): RowEntity {
  const consumed = new Set<string>();
  const asStr = (value: unknown): string | null =>
    typeof value === "string" ? (value.trim() || null) : typeof value === "number" ? String(value) : null;

  let nested: JsonObject = {};
  for (const key of ["user_json", "profile_json"]) {
    const raw = row[key];
    if (typeof raw !== "string") continue;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) { nested = parsed as JsonObject; break; }
    } catch { /* leave nested empty */ }
  }
  const stats = nested.statistics && typeof nested.statistics === "object" ? (nested.statistics as JsonObject) : {};
  const deepValue = (keys: string[]): unknown => {
    for (const key of keys) if (row[key] != null) return row[key];
    for (const key of keys) if (nested[key] != null) return nested[key];
    for (const key of keys) if (stats[key] != null) return stats[key];
    return null;
  };

  const avatar = asStr(deepValue(["avatar_url"]));
  if (avatar && row["avatar_url"] != null) consumed.add("avatar_url");

  let title: string | null = null;
  let subtitle: string | null = null;
  const username = asStr(deepValue(["username"]));
  if (username) {
    title = username;
    if (row["username"] != null) consumed.add("username");
  } else if (asStr(row["username_key"])) {
    title = asStr(row["username_key"]);
    consumed.add("username_key");
  } else if (asStr(row["title"])) {
    const artist = asStr(row["artist"]);
    title = artist ? `${artist} - ${asStr(row["title"])}` : asStr(row["title"]);
    consumed.add("title");
    if (artist) consumed.add("artist");
    const version = asStr(row["version"]);
    const creator = asStr(row["creator"]);
    if (version) { subtitle = version; consumed.add("version"); }
    if (creator) { subtitle = subtitle ? `${subtitle} · mapped by ${creator}` : `mapped by ${creator}`; consumed.add("creator"); }
  } else {
    const name = asStr(deepValue(["name", "display_name"]));
    if (name) title = name;
  }

  let cover: string | null = null;
  const coverSource = row["covers_json"] ?? (typeof nested.covers === "object" ? JSON.stringify(nested.covers) : null);
  if (typeof coverSource === "string") {
    try {
      const covers = JSON.parse(coverSource) as JsonObject;
      const url = covers["cover@2x"] ?? covers.cover ?? covers.card ?? covers.list ?? covers.slimcover;
      if (typeof url === "string") { cover = url; if (row["covers_json"] != null) consumed.add("covers_json"); }
    } catch { /* not a cover object */ }
  }

  const badges: RowEntity["badges"] = [];
  const addBadge = (label: string, keys: string[], format: (value: unknown) => string | null, isCountry = false) => {
    const value = deepValue(keys);
    if (value == null || value === "") return;
    const formatted = format(value);
    if (formatted == null) return;
    badges.push(isCountry ? { label, value: formatted, country: formatted } : { label, value: formatted });
    for (const key of keys) if (row[key] != null) { consumed.add(key); break; }
  };

  addBadge("", ["country_code", "country"], (value) => {
    const code = String(value).toUpperCase();
    return /^[A-Z]{2}$/.test(code) ? code : null;
  }, true);
  addBadge("pp", ["pp"], (value) => (Number.isFinite(Number(value)) ? `${Math.round(Number(value))}pp` : null));
  addBadge("global", ["global_rank"], (value) => (Number(value) > 0 ? `#${formatNumber(Number(value))}` : null));
  addBadge("country", ["country_rank"], (value) => (Number(value) > 0 ? `#${formatNumber(Number(value))}` : null));
  addBadge("", ["key_count"], (value) => (Number(value) > 0 ? `${Number(value)}K` : null));
  addBadge("", ["stars", "difficulty_rating"], (value) => (Number.isFinite(Number(value)) ? `${Number(value).toFixed(2)}★` : null));
  addBadge("", ["bpm"], (value) => (Number(value) > 0 ? `${Math.round(Number(value))} BPM` : null));
  addBadge("", ["status"], (value) => (typeof value === "string" && value ? value : null));

  return { avatar, cover, title, subtitle, badges, consumed };
}

// A cell is "wide" (rendered as a collapsed block, not a grid chip) when it is a
// JSON object/array string or just a long string.
function isWideCell(value: LiveBackendTableCell): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed[0] === "{" || trimmed[0] === "[") {
    try { JSON.parse(trimmed); return true; } catch { /* not JSON */ }
  }
  return value.length > 100;
}

// Pretty-print a value only when it is genuinely a JSON object/array string;
// leaves plain strings (and JSON scalars like a bare number) untouched.
function tryPrettyJson(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length < 2) return null;
  const first = trimmed[0];
  if (first !== "{" && first !== "[") return null;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return null;
  }
}

// Danger-zone counterpart to the row button: deactivate/reactivate a player by
// id or username without hunting for their row in the table browser.
function UserModerationCard() {
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<"deactivate" | "reactivate" | null>(null);
  const [result, setResult] = useState<LiveBackendUserActiveResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = (active: boolean) => {
    const trimmed = query.trim();
    if (!trimmed) { setError("Enter a user id or username."); return; }
    const asId = Number(trimmed);
    const payload = Number.isInteger(asId) && asId > 0 ? { userId: asId, active } : { username: trimmed, active };
    setBusy(active ? "reactivate" : "deactivate");
    setError(null);
    setResult(null);
    setLiveBackendUserActive({ data: payload })
      .then((res) => setResult(res))
      .catch((err) => setError(err instanceof Error ? err.message : "Action failed."))
      .finally(() => setBusy(null));
  };

  return (
    <div className="rounded-lg border border-osu-b3/30 bg-osu-b4/30 p-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") submit(false); }}
          placeholder="User id or username"
          className="min-w-0 flex-1 rounded-md border border-osu-b3/40 bg-osu-b5 px-2.5 py-1.5 text-[12px] text-osu-l2 placeholder:text-osu-f1/50 focus:border-osu-c2/60 focus:outline-none"
        />
        <div className="flex gap-2">
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => submit(false)}
            className="inline-flex items-center gap-1.5 rounded-md border border-osu-red/40 bg-osu-red/15 px-3 py-1.5 text-[12px] text-osu-red-light transition-colors hover:bg-osu-red/30 disabled:opacity-50 cursor-pointer"
          >
            <Ban className="h-3.5 w-3.5" /> {busy === "deactivate" ? "..." : "Deactivate"}
          </button>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => submit(true)}
            className="inline-flex items-center gap-1.5 rounded-md border border-osu-green/40 bg-osu-green/15 px-3 py-1.5 text-[12px] text-osu-green-light transition-colors hover:bg-osu-green/30 disabled:opacity-50 cursor-pointer"
          >
            <RotateCcw className="h-3.5 w-3.5" /> {busy === "reactivate" ? "..." : "Reactivate"}
          </button>
        </div>
      </div>
      {error ? <div className="mt-2 text-[11px] text-osu-red-light">{error}</div> : null}
      {result ? (
        <div className="mt-2 text-[11px] text-osu-f1">
          {result.username ?? `User ${result.userId}`} (#{result.userId}) is now{" "}
          <span className={result.active ? "text-osu-green-light" : "text-osu-red-light"}>{result.active ? "active" : "inactive"}</span>
          {result.active
            ? result.retrackedRosters ? ` · re-tracked ${result.retrackedRosters} roster${result.retrackedRosters === 1 ? "" : "s"}` : ""
            : `${result.untrackedRosters ? ` · untracked ${result.untrackedRosters} roster${result.untrackedRosters === 1 ? "" : "s"}` : ""}${result.deletedJobs ? ` · cleared ${result.deletedJobs} pending job${result.deletedJobs === 1 ? "" : "s"}` : ""}`}.
        </div>
      ) : null}
    </div>
  );
}

// The heavier, irreversible counterpart to UserModerationCard: deactivates the
// player AND permanently deletes their board/score projections. Same
// id-or-username input flow, but with its own confirm step (the same two-step
// pattern as the row button) since nothing here can be undone.
function UserWipeCard() {
  const [query, setQuery] = useState("");
  const [preview, setPreview] = useState<LiveBackendUserWipePreview | null>(null);
  const [busy, setBusy] = useState<"preview" | "wipe" | null>(null);
  const [result, setResult] = useState<LiveBackendUserWipeResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const arm = () => {
    if (!query.trim()) { setError("Enter a user id or username."); return; }
    setBusy("preview");
    setError(null);
    setResult(null);
    setPreview(null);
    previewLiveBackendUserWipe({ data: { query: query.trim() } })
      .then((value) => setPreview(value))
      .catch((err) => setError(err instanceof Error ? err.message : "Preview failed."))
      .finally(() => setBusy(null));
  };

  const submit = () => {
    if (!preview || !preview.canWipe) { setError("Preview a tracked-only account before wiping it."); return; }
    setBusy("wipe");
    setError(null);
    setResult(null);
    wipeLiveBackendUserData({
      data: {
        userId: preview.userId,
        expectedUsername: preview.username,
        confirmation: `WIPE ${preview.userId}`,
      },
    })
      .then((res) => { setResult(res); setPreview(null); })
      .catch((err) => setError(err instanceof Error ? err.message : "Action failed."))
      .finally(() => setBusy(null));
  };

  const deletedEntries = result ? Object.entries(result.deleted ?? {}) : [];
  const deletedTotal = deletedEntries.reduce((sum, [, count]) => sum + count, 0);
  const updatedEntries = result ? Object.entries(result.updated ?? {}) : [];

  return (
    <div className="rounded-lg border border-osu-red/30 bg-osu-b4/30 p-3">
      <div className="text-[11px] text-osu-f1">
        Purge a banned tracked player: keeps one inactive tombstone so ingest, roster refreshes,
        jobs and profile lookups cannot restore them, then removes their Tracker scores, boards,
        histories, maps, profile/activity/skills data and any maniacards of that player. The lookup
        always previews the exact username and immutable osu! id first; plain numeric text is treated
        as a username, while <span className="font-mono text-osu-l2">#123</span> forces user id 123.
        The purge refuses accounts with login-owned data such as goals, wallets, skins, uploads,
        signatures, collections or linked Discord data.
      </div>
      <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
        <input
          value={query}
          onChange={(event) => { setQuery(event.target.value); setPreview(null); setError(null); }}
          onKeyDown={(event) => { if (event.key === "Enter" && busy === null) arm(); }}
          placeholder="Username or #user id"
          disabled={busy !== null}
          className="min-w-0 flex-1 rounded-md border border-osu-b3/40 bg-osu-b5 px-2.5 py-1.5 text-[12px] text-osu-l2 placeholder:text-osu-f1/50 focus:border-osu-c2/60 focus:outline-none"
        />
        <div className="flex gap-2">
          <button
            type="button"
            disabled={busy !== null}
            onClick={arm}
            className="inline-flex items-center gap-1.5 rounded-md border border-osu-red/40 bg-osu-red/15 px-3 py-1.5 text-[12px] text-osu-red-light transition-colors hover:bg-osu-red/30 disabled:opacity-50 cursor-pointer"
          >
            <Search className="h-3.5 w-3.5" /> {busy === "preview" ? "Checking..." : "Preview purge"}
          </button>
        </div>
      </div>
      {preview ? (
        <div className="mt-3 rounded-md border border-osu-b3/40 bg-osu-b5/70 p-3 text-[11px] text-osu-f1">
          <div className="flex flex-wrap items-center gap-2 text-osu-l2">
            {preview.avatarUrl ? <img src={preview.avatarUrl} alt="" className="h-8 w-8 rounded-full object-cover" /> : null}
            <span className="font-semibold">{preview.username}</span>
            <span className="font-mono text-osu-f1">#{preview.userId}</span>
            {preview.countryCode ? <CountryFlag code={preview.countryCode} size="xs" decorative /> : null}
            <span className={preview.active ? "text-osu-green-light" : "text-osu-f1"}>{preview.active ? "active" : "already inactive"}</span>
          </div>
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10px] text-osu-f1/85">
            <span>tracker: {formatNumber(preview.impact.trackerScores)}</span>
            <span>snipes: {formatNumber(preview.impact.snipeEvents)}</span>
            <span>map rows: {formatNumber(preview.impact.mapRows)}</span>
            <span>card holdings: {formatNumber(preview.impact.packHoldings)}</span>
            <span>card owners: {formatNumber(preview.impact.packOwners)}</span>
            <span>card copies: {formatNumber(preview.impact.packCopies)}</span>
          </div>
          {preview.canWipe ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={busy !== null}
                onClick={submit}
                className="inline-flex items-center gap-1.5 rounded-md bg-osu-red px-3 py-1.5 text-[12px] font-semibold text-white transition-colors hover:bg-osu-red-light disabled:opacity-50 cursor-pointer"
              >
                <Trash2 className="h-3.5 w-3.5" /> {busy === "wipe" ? "Purging..." : `Confirm purge ${preview.username} (#${preview.userId})`}
              </button>
              <button type="button" disabled={busy !== null} onClick={() => setPreview(null)} className="rounded-md px-2 py-1.5 text-[12px] text-osu-f1 hover:text-white disabled:opacity-50 cursor-pointer">cancel</button>
            </div>
          ) : (
            <div className="mt-2 text-osu-red-light">
              Refused: this account has {formatNumber(preview.impact.accountDataRows)} login-owned row{preview.impact.accountDataRows === 1 ? "" : "s"}. Use a purpose-built account deletion workflow instead.
            </div>
          )}
        </div>
      ) : null}
      {error ? <div className="mt-2 text-[11px] text-osu-red-light">{error}</div> : null}
      {result ? (
        <div className="mt-2 text-[11px] text-osu-f1">
          <div>
            Purged {result.username ?? `User ${result.userId}`} (#{result.userId}): deleted {formatNumber(deletedTotal)} row{deletedTotal === 1 ? "" : "s"}
            {result.untrackedRosters ? ` · untracked ${result.untrackedRosters} roster${result.untrackedRosters === 1 ? "" : "s"}` : ""}
            {result.deletedJobs ? ` · cleared ${result.deletedJobs} pending job${result.deletedJobs === 1 ? "" : "s"}` : ""}. The user row stays as an inactive tombstone.
          </div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[10px] text-osu-f1/80">
            {deletedEntries.map(([table, count]) => (
              <span key={table}>{table}: <span className="text-osu-l2">{formatNumber(count)}</span></span>
            ))}
            {updatedEntries.map(([table, count]) => (
              <span key={`updated:${table}`}>{table} updated: <span className="text-osu-l2">{formatNumber(count)}</span></span>
            ))}
          </div>
        </div>
      ) : null}
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
    const reason = result.reason === "osc_fresh" ? "socket feed fresh, on standby" : `${result.reason ?? "idle"}, on standby`;
    return { value: bucket, hint: reason, tone: "neutral", used, target, enabled: true, polling: false };
  }
  return {
    value: bucket,
    hint: `polling, ${formatNumber(result.inserted)} new ${formatTimeAgo(fallback.updatedAt)}`,
    tone: "good",
    used,
    target,
    enabled: true,
    polling: true,
  };
}

// Resident-set thresholds from the production baseline (4 GB VPS, no swap):
// the serving process sits ~410 MB flat, the worker ~300 MB with 1.3-1.6 GB
// transients while a GLOBAL maps refresh runs, so the worker gets the looser
// budget. Only current RSS feeds the card tone: peak RSS is a process-lifetime
// high-water mark, and grading on it would pin the card red forever after the
// first refresh spike.
const SERVER_RSS_WARN_BYTES = 1.0 * 1024 ** 3;
const SERVER_RSS_BAD_BYTES = 1.5 * 1024 ** 3;
const WORKER_RSS_WARN_BYTES = 1.3 * 1024 ** 3;
const WORKER_RSS_BAD_BYTES = 1.9 * 1024 ** 3;

function rssTone(bytes: number | null | undefined, warnBytes: number, badBytes: number): StatusTone {
  if (bytes == null || !Number.isFinite(bytes)) return "neutral";
  if (bytes > badBytes) return "bad";
  if (bytes > warnBytes) return "warn";
  return "good";
}

interface MemoryView {
  server: ProcessMemorySample | null;
  worker: ProcessMemorySample | null;
  // True when one process both serves and runs jobs (LIVE_BACKEND_ROLE=all,
  // which is the local dev setup): both samples come from the same pid, so
  // rendering them twice would invent a second process.
  singleProcess: boolean;
  serverTone: StatusTone;
  workerTone: StatusTone;
  tone: StatusTone;
}

function getMemoryView(status: LiveBackendStatus | null): MemoryView {
  const server = status?.memory?.server ?? null;
  const worker = status?.memory?.worker ?? null;
  const singleProcess = server != null && worker != null && server.pid === worker.pid;
  // A single process also does the worker's work, so it is graded on the looser
  // worker budget: a GLOBAL refresh transient there is expected, not a warning.
  const serverTone = rssTone(
    server?.rssBytes,
    singleProcess ? WORKER_RSS_WARN_BYTES : SERVER_RSS_WARN_BYTES,
    singleProcess ? WORKER_RSS_BAD_BYTES : SERVER_RSS_BAD_BYTES,
  );
  const workerTone = singleProcess ? serverTone : rssTone(worker?.rssBytes, WORKER_RSS_WARN_BYTES, WORKER_RSS_BAD_BYTES);
  return { server, worker, singleProcess, serverTone, workerTone, tone: worstTone(serverTone, workerTone) };
}

function formatUptime(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "unknown";
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function ProcessMemoryRows({ label, sample, tone }: { label: string; sample: ProcessMemorySample | null; tone: StatusTone }) {
  if (!sample) return <DetailRow label={label} value="not reported by this backend" />;
  return (
    <>
      <DetailRow label={`${label} RSS`} value={`${formatBytes(sample.rssBytes)} now · ${formatBytes(sample.peakRssBytes)} peak`} tone={tone} />
      <DetailRow label={`${label} heap`} value={`${formatBytes(sample.heapUsedBytes)} used of ${formatBytes(sample.heapTotalBytes)}`} />
      <DetailRow label={`${label} off-heap`} value={`${formatBytes(sample.externalBytes)} external · ${formatBytes(sample.arrayBuffersBytes)} array buffers`} />
      <DetailRow label={`${label} process`} value={`pid ${sample.pid} · role ${sample.role} · up ${formatUptime(sample.uptimeSec)} · sampled ${formatTimeAgo(sample.at)}`} />
    </>
  );
}

function getSnapshotThreadView(thread: MapsSnapshotThreadStatus | undefined): { value: string; tone: StatusTone } {
  if (!thread) return { value: "not reported", tone: "neutral" };
  // Disabled is the expected state under tsx/vitest and for a remote database,
  // so it is never an alarm.
  if (!thread.enabled) return { value: `off (${thread.disabledReason ?? "disabled"})`, tone: "neutral" };
  if (!thread.available) return { value: `cooling down ${formatCallMs(thread.cooldownMsRemaining)}`, tone: "bad" };
  if (thread.inFlight > 0) return { value: `building ${formatNumber(thread.inFlight)}`, tone: "good" };
  if (!thread.spawned) return { value: thread.everOnline ? "respawn pending" : "idle", tone: "neutral" };
  return { value: "ready", tone: "good" };
}

/* One of the three reads. Past three lifetimes with nothing building means the
   refresh clock has stopped, which is the failure worth seeing here: the page
   keeps answering either way, it just answers with something older. */
function PackCommunityReadRow({ label, slot }: { label: string; slot: PackCommunitySlotStatus | undefined }) {
  if (!slot) return <DetailRow label={label} value="not reported" />;
  const age = slot.ageMs == null ? "never built" : `${formatCallMs(slot.ageMs)} old`;
  const stalled = slot.ageMs != null && slot.ageMs > slot.ttlMs * 3 && !slot.building;
  const parts = [slot.source, age, `every ${formatCallMs(slot.ttlMs)}`, `${formatNumber(slot.builds)} builds`];
  if (slot.building) parts.push("building");
  return (
    <DetailRow
      label={label}
      value={parts.join(" · ")}
      tone={slot.lastError ? "warn" : stalled ? "warn" : "neutral"}
    />
  );
}

function ResponseCacheRow({ label, cache }: { label: string; cache: ResponseCacheMetrics | undefined }) {
  // Sitting at the byte budget is the design, not a fault: these are bounded
  // LRUs, so the row stays neutral however full it is.
  if (!cache) return <DetailRow label={label} value="not reported" />;
  return (
    <DetailRow
      label={label}
      value={`${formatNumber(cache.entries)}/${formatNumber(cache.maxEntries)} entries · ${formatBytes(cache.bytes)} of ${formatBytes(cache.maxBytes)} · ${formatBytes(cache.maxEntryBytes)} cap each`}
    />
  );
}

function diskTone(disk: DiskUsage | null | undefined): StatusTone {
  if (!disk || !Number.isFinite(disk.usedPct)) return "neutral";
  // Regraded from the thresholds the backend reports (70% warn, 85% critical)
  // so the dashboard cannot drift from the alarm the box logs against.
  const warnPct = Number.isFinite(disk.warnPct) ? disk.warnPct : 70;
  const criticalPct = Number.isFinite(disk.criticalPct) ? disk.criticalPct : 85;
  if (disk.usedPct >= criticalPct) return "bad";
  if (disk.usedPct >= warnPct) return "warn";
  return "good";
}

function StoragePathRows({ paths }: { paths: StorageFootprint | null | undefined }) {
  if (!paths) return <DetailRow label="Storage paths" value="not reported" />;
  const rows: Array<{ label: string; bytes: number | null }> = [
    { label: "Database file", bytes: paths.db },
    { label: "Database WAL", bytes: paths.dbWal },
    { label: "Database -shm", bytes: paths.dbShm },
    { label: "Analytics database", bytes: paths.analytics },
    { label: "Analytics WAL", bytes: paths.analyticsWal },
    { label: "Journal database", bytes: paths.journal ?? null },
    { label: "Journal WAL", bytes: paths.journalWal ?? null },
    { label: "Backups directory", bytes: paths.backups },
    { label: "Replay video work dir", bytes: paths.replayVideoWork },
  ];
  return (
    <>
      {rows.map((row) => (
        // null means the path is not configured or not on disk - an absent
        // replay-video work dir is how "that feature stayed off" reads here.
        <DetailRow key={row.label} label={row.label} value={row.bytes == null ? "absent" : formatBytes(row.bytes)} />
      ))}
    </>
  );
}

function StatusCard({ status, connectionState, country, snapshots }: { status: LiveBackendStatus | null; connectionState: ConnectionState; country: string; snapshots: SnapshotStats }) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const roster = status?.roster?.find((entry) => entry.country === country);
  const analysis = status?.analysis;
  const fallback = getScoresFallbackStatus(status);
  const fallbackResult = status?.scoresFallback?.result;
  const fallbackRanResult = fallbackResult?.ran ? fallbackResult : null;

  const sseTone: StatusTone = connectionState === "open" ? "good" : "warn";
  const workersTone: StatusTone = status?.worker?.paused ? "warn" : "good";
  const rosterTone: StatusTone = roster ? "good" : "warn";

  const fallbackUpdated = status?.scoresFallback?.updatedAt ? formatTimeAgo(status.scoresFallback.updatedAt) : "never";

  const memory = getMemoryView(status);
  const globalRefresh = status?.globalMapsRefresh ?? null;
  const thread = status?.mapsSnapshotThread;
  const threadView = getSnapshotThreadView(thread);
  const packThread = status?.packCommunityThread;
  const packThreadView = getSnapshotThreadView(packThread);
  const packReads = status?.packCommunitySnapshots;
  const packTotals = packReads?.totals;
  const caches = status?.responseCaches;
  const cacheBytes = caches?.mapsPage.bytes ?? null;
  const cacheEntries = caches?.mapsPage.entries ?? null;
  const disk = status?.disk ?? null;
  const diskCardTone = diskTone(disk);

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
      key: "fallback",
      title: "Ingest",
      tone: fallback.tone,
      stats: [
        { label: "Budget", value: fallback.enabled ? `${fallback.value} per min` : "off", tone: fallback.polling ? "good" : "neutral" },
        fallback.polling
          ? { label: "New saved", value: formatNumber(fallbackRanResult?.inserted ?? 0), tone: (fallbackRanResult?.inserted ?? 0) > 0 ? "good" : "neutral" }
          : { label: "State", value: fallback.enabled ? "standby" : "disabled" },
      ],
      detail: (
        <>
          <div className="rounded-md bg-osu-b4/30 px-3 py-2 text-[10px] leading-relaxed text-osu-f1">
            Score ingest poller. Each poll pulls the latest osu! mania scores, keeps the ones from tracked countries, then saves any that are new.
          </div>
          <DetailRow label="Poll budget" value={`${formatNumber(fallback.used)} / ${formatNumber(fallback.target)} per min`} tone={fallback.polling ? "good" : "neutral"} />
          <DetailRow label="Last run" value={fallbackUpdated} />
          {fallbackRanResult ? (
            <>
              <DetailRow label="Scanned from osu!" value={`${formatNumber(fallbackRanResult.fetched)} scores`} />
              <DetailRow label="In tracked countries" value={formatNumber(fallbackRanResult.candidates)} />
              <DetailRow label="New, saved to DB" value={formatNumber(fallbackRanResult.inserted)} tone={fallbackRanResult.inserted > 0 ? "good" : "neutral"} />
            </>
          ) : (
            <DetailRow label="State" value={fallback.enabled ? "on standby (socket feed is fresh)" : "disabled by config"} />
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
    {
      key: "analysis",
      title: "Map analysis",
      tone: analysis ? "good" : "neutral",
      stats: [
        { label: "Analyzed", value: analysis ? `${formatNumber(analysis.analyzed)} maps` : "—", tone: analysis ? "good" : "neutral" },
        { label: "Searchable", value: analysis ? `${formatNumber(analysis.searchIndexed)} indexed` : "—" },
      ],
      detail: (
        <>
          <div className="rounded-md bg-osu-b4/30 px-3 py-2 text-[10px] leading-relaxed text-osu-f1">
            Chart-pattern analysis coverage{analysis ? ` (analysis v${analysis.version})` : ""}. Analyzed maps have a ready skill vector and form the pool behind pattern search and collections; searchable maps are the subset denormalized into the search index.
          </div>
          <DetailRow label="Analyzed" value={analysis ? `${formatNumber(analysis.analyzed)} maps` : "—"} tone={analysis ? "good" : "neutral"} />
          <DetailRow label="Searchable (indexed)" value={analysis ? formatNumber(analysis.searchIndexed) : "—"} />
          <DetailRow label="In progress" value={analysis ? formatNumber(analysis.running) : "—"} tone={analysis && analysis.running > 0 ? "warn" : "neutral"} />
          <DetailRow label="Failed" value={analysis ? formatNumber(analysis.failed) : "—"} tone={analysis && analysis.failed > 0 ? "warn" : "neutral"} />
          <DetailRow label="Unavailable" value={analysis ? formatNumber(analysis.unavailable) : "—"} />
        </>
      ),
    },
    {
      key: "memory",
      title: "Memory",
      tone: memory.tone,
      stats: memory.singleProcess
        ? [
          { label: "Process", value: formatBytes(memory.server?.rssBytes), tone: memory.serverTone },
          { label: "Peak", value: formatBytes(memory.server?.peakRssBytes) },
        ]
        : [
          { label: "Server", value: memory.server ? formatBytes(memory.server.rssBytes) : "—", tone: memory.serverTone },
          { label: "Worker", value: memory.worker ? formatBytes(memory.worker.rssBytes) : "—", tone: memory.workerTone },
        ],
      detail: (
        <>
          <div className="rounded-md bg-osu-b4/30 px-3 py-2 text-[10px] leading-relaxed text-osu-f1">
            {memory.singleProcess ? "One process is serving and running jobs (same pid), so these numbers are the whole backend. " : ""}
            Sampled while the status body was built: up to 5s old normally, and up to 120s old whenever a stale body is served. RSS and peak RSS cover the whole process; heap used is per-isolate, so the serving process's maps snapshot thread counts in RSS but never in heap used. Peak RSS is a lifetime high-water mark and never falls.
          </div>
          {memory.singleProcess ? (
            <ProcessMemoryRows label="Process" sample={memory.server} tone={memory.serverTone} />
          ) : (
            <>
              <ProcessMemoryRows label="Server" sample={memory.server} tone={memory.serverTone} />
              <ProcessMemoryRows label="Worker" sample={memory.worker} tone={memory.workerTone} />
            </>
          )}
          {globalRefresh ? (
            <>
              <DetailRow
                label="Last GLOBAL maps refresh"
                value={`${formatTimeAgo(globalRefresh.at)} · ran ${formatCallMs(globalRefresh.durationMs)} · ${globalRefresh.ok ? "ok" : "failed"}`}
                tone={globalRefresh.ok ? "neutral" : "bad"}
              />
              <DetailRow
                label="Refresh peak"
                value={`${formatBytes(globalRefresh.peakRssBytes)} RSS from ${formatBytes(globalRefresh.startRssBytes)} · ${formatBytes(globalRefresh.peakHeapUsedBytes)} heap`}
                tone={rssTone(globalRefresh.peakRssBytes, WORKER_RSS_WARN_BYTES, WORKER_RSS_BAD_BYTES)}
              />
              <DetailRow
                label="Refresh sampling"
                value={`${formatNumber(globalRefresh.samples)} samples · ${formatNumber(globalRefresh.concurrentJobs)} jobs in flight at rollup`}
              />
              {globalRefresh.error ? <DetailRow label="Refresh error" value={globalRefresh.error} tone="bad" /> : null}
              <div className="rounded-md bg-osu-b4/30 px-3 py-2 text-[10px] leading-relaxed text-osu-f1">
                {globalRefresh.hint ?? "Refresh peak RSS is the whole worker process while the job ran, not the job's own allocation; concurrent lanes count toward it."}
              </div>
            </>
          ) : (
            <DetailRow label="Last GLOBAL maps refresh" value="not reported" />
          )}
        </>
      ),
    },
    {
      key: "mapsServing",
      title: "Maps serving",
      tone: threadView.tone,
      stats: [
        { label: "Thread", value: threadView.value, tone: threadView.tone },
        { label: "Cached", value: cacheBytes == null ? "—" : `${formatBytes(cacheBytes)} · ${formatNumber(cacheEntries ?? 0)} entries` },
      ],
      detail: (
        <>
          <div className="rounded-md bg-osu-b4/30 px-3 py-2 text-[10px] leading-relaxed text-osu-f1">
            Maps pages kept in memory already serialized and compressed, and the worker thread that builds the GLOBAL maps page off the request path. The cache is bounded by entry count, by total bytes, and by the size of a single response.
          </div>
          <ResponseCacheRow label="Maps page cache" cache={caches?.mapsPage} />
          {thread ? (
            <>
              <DetailRow label="Snapshot thread" value={threadView.value} tone={threadView.tone} />
              <DetailRow
                label="Builds"
                value={`${formatNumber(thread.ok)} ok · ${formatNumber(thread.failed)} failed · ${formatNumber(thread.timeouts)} timed out · ${formatNumber(thread.inFlight)} in flight`}
                tone={thread.failed + thread.timeouts > 0 ? "warn" : "neutral"}
              />
              <DetailRow
                label="Last build"
                value={thread.lastBuildAt
                  ? `${formatTimeAgo(thread.lastBuildAt)}${thread.lastBuildMs == null ? "" : ` · ${formatCallMs(thread.lastBuildMs)}`}${thread.lastBuildBytes == null ? "" : ` · ${formatBytes(thread.lastBuildBytes)}`}`
                  : "none yet"}
              />
              {thread.lastError ? (
                <DetailRow label="Last thread error" value={`${thread.lastFailureReason ?? "error"}: ${thread.lastError}`} tone="bad" />
              ) : null}
            </>
          ) : (
            <DetailRow label="Snapshot thread" value="not reported" />
          )}
        </>
      ),
    },
    {
      key: "packCollections",
      title: "Pack collections",
      tone: packThreadView.tone,
      stats: [
        { label: "Thread", value: packThreadView.value, tone: packThreadView.tone },
        {
          label: "Totals",
          value: packTotals?.ageMs == null ? "—" : `${formatCallMs(packTotals.ageMs)} old`,
          tone: packTotals?.lastError ? "warn" : "neutral",
        },
      ],
      detail: (
        <>
          <div className="rounded-md bg-osu-b4/30 px-3 py-2 text-[10px] leading-relaxed text-osu-f1">
            The three prepared answers behind /packs/collections, and the worker thread that builds them off the request path. A visitor is only ever handed one that already exists, so these clocks are the whole cost of that page. The thread is also what keeps the maintained collector and card counts level with the ownership table.
          </div>
          <PackCommunityReadRow label="Totals" slot={packReads?.totals} />
          <PackCommunityReadRow label="Collectors" slot={packReads?.collector} />
          <PackCommunityReadRow label="Cards" slot={packReads?.card} />
          <DetailRow label="Warm restart cache" value={packReads ? (packReads.diskCache ? "on disk" : "memory only") : "not reported"} />
          {packThread ? (
            <>
              <DetailRow label="Snapshot thread" value={packThreadView.value} tone={packThreadView.tone} />
              <DetailRow
                label="Builds"
                value={`${formatNumber(packThread.ok)} ok · ${formatNumber(packThread.failed)} failed · ${formatNumber(packThread.timeouts)} timed out · ${formatNumber(packThread.inFlight)} in flight`}
                tone={packThread.failed + packThread.timeouts > 0 ? "warn" : "neutral"}
              />
              <DetailRow
                label="Last build"
                value={packThread.lastBuildAt
                  ? `${formatTimeAgo(packThread.lastBuildAt)}${packThread.lastBuildMs == null ? "" : ` · ${formatCallMs(packThread.lastBuildMs)}`}${packThread.lastBuildBytes == null ? "" : ` · ${formatBytes(packThread.lastBuildBytes)}`}`
                  : "none yet"}
              />
              {packThread.lastError ? (
                <DetailRow label="Last thread error" value={`${packThread.lastFailureReason ?? "error"}: ${packThread.lastError}`} tone="bad" />
              ) : null}
            </>
          ) : (
            <DetailRow label="Snapshot thread" value="not reported" />
          )}
          {[packReads?.totals, packReads?.collector, packReads?.card].map((slot, index) =>
            slot?.lastError ? (
              <DetailRow
                key={index}
                label={`Last ${["totals", "collectors", "cards"][index]} error`}
                value={slot.lastError}
                tone="warn"
              />
            ) : null,
          )}
        </>
      ),
    },
    {
      key: "disk",
      title: "Disk",
      tone: diskCardTone,
      stats: [
        { label: "Used", value: disk ? `${disk.usedPct}%` : "—", tone: diskCardTone },
        { label: "Free", value: disk ? formatBytes(disk.freeBytes) : "—" },
      ],
      detail: (
        <>
          <div className="rounded-md bg-osu-b4/30 px-3 py-2 text-[10px] leading-relaxed text-osu-f1">
            The filesystem holding the live database. The database size cap cannot see backups, the analytics database, or logs filling the same disk, so this is graded separately. Percentages follow df: blocks the filesystem reserves for root count as neither used nor free.
          </div>
          {disk ? (
            <>
              <DetailRow label="Mount" value={disk.path} />
              <DetailRow
                label="Used"
                value={`${disk.usedPct}% · ${formatBytes(disk.usedBytes)} of ${formatBytes(disk.usedBytes + disk.freeBytes)}`}
                tone={diskCardTone}
              />
              <DetailRow label="Free" value={formatBytes(disk.freeBytes)} tone={diskCardTone} />
              <DetailRow label="Thresholds" value={`warn at ${disk.warnPct}% · critical at ${disk.criticalPct}%`} />
            </>
          ) : (
            <DetailRow label="Disk" value="not reported (no local database file)" />
          )}
          <StoragePathRows paths={status?.storagePaths} />
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
  { value: "idle", label: "Reduced", dot: "bg-osu-red-light" },
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

function normalizeCountrySearchText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\u2019/g, "'");
}

function AddCountryPicker({
  trackedCodes,
  busy,
  onAddCountry,
}: {
  trackedCodes: Set<string>;
  busy: boolean;
  onAddCountry: (country: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<{ code: string; name: string } | null>(null);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    return () => document.removeEventListener("mousedown", onPointer);
  }, [open]);

  const matches = useMemo(() => {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const text = normalizeCountrySearchText(trimmed);
    const code = trimmed.toUpperCase();
    const ranked: Array<{ option: { code: string; name: string }; rank: number }> = [];
    for (const option of COUNTRY_OPTIONS) {
      const name = normalizeCountrySearchText(option.name);
      const rank = option.code === code
        ? 0
        : name.startsWith(text)
          ? 1
          : option.code.startsWith(code)
            ? 2
            : name.includes(text)
              ? 3
              : -1;
      if (rank >= 0) ranked.push({ option, rank });
    }
    ranked.sort((a, b) => a.rank - b.rank || a.option.name.localeCompare(b.option.name));
    return ranked.slice(0, 8).map((entry) => entry.option);
  }, [query]);

  const pick = (option: { code: string; name: string }) => {
    if (trackedCodes.has(option.code)) return;
    setSelected(option);
    setQuery(option.name);
    setOpen(false);
  };

  return (
    <form
      className="flex flex-wrap items-center gap-1.5 text-[9px] font-semibold uppercase tracking-wider text-osu-f1"
      onSubmit={(event) => {
        event.preventDefault();
        if (!selected || trackedCodes.has(selected.code)) return;
        onAddCountry(selected.code);
        setSelected(null);
        setQuery("");
      }}
    >
      Add
      <div ref={ref} className="relative">
        <div className="flex items-center gap-1 rounded-md border border-osu-b3/25 bg-osu-b5/50 p-1">
          {selected ? <CountryFlag code={selected.code} size="xs" decorative className="ml-1.5" /> : null}
          <input
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSelected(null);
              setHighlight(0);
              setOpen(true);
            }}
            onFocus={() => {
              if (query.trim() && !selected) setOpen(true);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                if (!open) {
                  setOpen(true);
                  return;
                }
                if (matches.length === 0) return;
                const delta = event.key === "ArrowDown" ? 1 : -1;
                setHighlight((value) => (value + delta + matches.length) % matches.length);
              } else if (event.key === "Enter" && open && matches.length > 0) {
                event.preventDefault();
                pick(matches[Math.min(highlight, matches.length - 1)]);
              } else if (event.key === "Escape") {
                setOpen(false);
              }
            }}
            placeholder="Search country"
            role="combobox"
            aria-expanded={open}
            aria-label="Search for a country to start tracking"
            className="w-36 rounded bg-transparent px-2 py-1 text-[10px] font-medium normal-case tracking-normal text-white placeholder:text-osu-f1/40 focus:outline-none"
          />
          <button
            type="submit"
            disabled={!selected || busy}
            title="Register this country as active + live and queue its roster"
            className="rounded px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-osu-f1 transition-colors duration-[120ms] hover:text-osu-l2 disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer"
          >
            Track
          </button>
        </div>
        {open && query.trim() ? (
          <div
            role="listbox"
            className="absolute left-0 top-full z-50 mt-1 max-h-[240px] w-56 overflow-y-auto overscroll-contain rounded-lg border border-osu-b3/50 bg-osu-b5 py-1 normal-case tracking-normal shadow-[0_10px_25px_rgba(0,0,0,0.5)] lg:left-auto lg:right-0"
          >
            {matches.length === 0 ? (
              <div className="px-2.5 py-1.5 text-[10px] font-medium text-osu-f1">No country matches "{query.trim()}"</div>
            ) : (
              matches.map((option, index) => {
                const tracked = trackedCodes.has(option.code);
                return (
                  <button
                    key={option.code}
                    type="button"
                    role="option"
                    aria-selected={selected?.code === option.code}
                    disabled={tracked}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      pick(option);
                    }}
                    onMouseEnter={() => setHighlight(index)}
                    className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[10px] font-medium transition-colors duration-[80ms] ${
                      tracked
                        ? "cursor-default text-osu-f1/50"
                        : index === highlight
                          ? "cursor-pointer bg-osu-b3/45 text-white"
                          : "cursor-pointer text-osu-c2"
                    }`}
                  >
                    <CountryFlag code={option.code} size="xs" decorative muted={tracked} />
                    <span className="truncate">{option.name}</span>
                    <span className={`ml-auto flex-shrink-0 font-mono ${tracked ? "text-osu-f1/40" : "text-osu-f1/70"}`}>
                      {tracked ? "tracked" : option.code}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        ) : null}
      </div>
    </form>
  );
}

function CountriesCard({
  status,
  busy,
  onSetCountryStatus,
  onSetCountryTier,
  onAddCountry,
}: {
  status: LiveBackendStatus | null;
  busy: string | null;
  onSetCountryStatus: (entry: CountryEntry, lifecycle: CountryLifecycleStatus) => void;
  onSetCountryTier: (entry: CountryEntry, tier: CountryFeatureTier) => void;
  onAddCountry: (country: string) => void;
}) {
  const [sortMode, setSortMode] = useState<CountrySortMode>("status");
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
  const trackedCountryCodes = useMemo(
    () => new Set(countries.map((entry) => entry.country.trim().toUpperCase())),
    [countries],
  );
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
          <AddCountryPicker
            trackedCodes={trackedCountryCodes}
            busy={busy?.startsWith("add-country") === true}
            onAddCountry={onAddCountry}
          />
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
              busy={busy === `set-status-${entry.country}` || busy === `set-tier-${entry.country}`}
              onSetStatus={(lifecycle) => onSetCountryStatus(entry, lifecycle)}
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
  catchup,
  busy,
  onSetStatus,
  onSetTier,
}: {
  entry: CountryEntry;
  users: number | null;
  catchup: CountryCatchupState | null;
  busy: boolean;
  onSetStatus: (lifecycle: CountryLifecycleStatus) => void;
  onSetTier: (tier: CountryFeatureTier) => void;
}) {
  const displayStatus = getCountryDisplayStatus(entry);
  const statusTone = displayStatus === "paused" || displayStatus === "idle" ? "text-osu-red" : displayStatus === "active" ? "text-osu-green" : "text-osu-yellow";
  const featureTier = getCountryFeatureTier(entry);
  const activeUsers = entry.activeUsers ?? 0;
  // Set when the Snipes tier cell is clicked: snipes enables the expensive
  // snipe board seeding, so it takes a second deliberate confirm click.
  const [confirmSnipes, setConfirmSnipes] = useState(false);
  const snipesRow = useRef<HTMLDivElement | null>(null);
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
    if (busy) setConfirmSnipes(false);
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
          <span className={`text-[10px] font-semibold uppercase tracking-wider ${statusTone}`}>reduced by TTL</span>
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

function formatCallMs(ms: number): string {
  if (ms >= 10_000) return `${(ms / 1000).toFixed(0)}s`;
  if (ms >= 1_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

function rateTimingHint(row: { avgMs?: number | null; maxMs?: number | null }): string | undefined {
  if (row.avgMs == null) return undefined;
  const avg = `${formatCallMs(row.avgMs)} each`;
  return row.maxMs != null && row.maxMs > row.avgMs ? `${avg} · ${formatCallMs(row.maxMs)} slowest` : avg;
}

/* One colour per origin, so the stacked bar, the group headers and the row
   tints all say the same thing without a legend lookup. */
const ORIGIN_STYLES: Record<OsuCallOrigin, { dot: string; text: string; bar: string; tint: string }> = {
  page: { dot: "bg-osu-pink-light", text: "text-osu-pink-light", bar: "bg-osu-pink-light", tint: "bg-osu-pink-light/10" },
  job: { dot: "bg-osu-yellow", text: "text-osu-yellow", bar: "bg-osu-yellow", tint: "bg-osu-yellow/10" },
  ingest: { dot: "bg-osu-blue", text: "text-osu-blue", bar: "bg-osu-blue", tint: "bg-osu-blue/10" },
  admin: { dot: "bg-osu-purple-light", text: "text-osu-purple-light", bar: "bg-osu-purple-light", tint: "bg-osu-purple-light/10" },
  other: { dot: "bg-osu-b1", text: "text-osu-f1", bar: "bg-osu-b1", tint: "bg-osu-b1/15" },
};

/* The limiter's priority lanes, named the way an admin would say them. */
const LIMITER_LANE_LABELS: Record<string, string> = {
  interactive: "page loads",
  job: "jobs",
  bulk: "bulk sweeps",
  default: "other",
};

type RateWindowKey = "live" | "recent";

type RateCallerRow = {
  caller: string;
  count: number;
  avgMs?: number | null;
  maxMs?: number | null;
  errors?: number;
};

/* Same widening as RateCallerRow: the live limiter's rows carry no timings or
   error counts, only the history rows do, and the panel renders both. */
type RatePathRow = {
  path: string;
  count: number;
  avgMs?: number | null;
  maxMs?: number | null;
  errors?: number;
};

function share(count: number, total: number): number {
  return total > 0 ? Math.round((count / total) * 100) : 0;
}

function RateBreakdownCard({ status }: { status: LiveBackendStatus | null }) {
  const [windowKey, setWindowKey] = useState<RateWindowKey>("recent");
  const windowMinutes = status?.apiCallHistory?.windowMinutes ?? 15;
  const live = windowKey === "live";
  const rawCallers: RateCallerRow[] = (live ? status?.rate.byCaller : status?.apiCallHistory?.byCaller) ?? [];
  const livePaths: RatePathRow[] = status?.rate.byPath ?? [];
  const historyPaths: RatePathRow[] = status?.apiCallHistory?.byPath ?? [];
  const paths = live && livePaths.length ? livePaths : historyPaths;
  const names = status?.apiCallHistory?.names;

  const { groups, total } = useMemo(() => {
    const described = rawCallers.map((row) => ({ ...row, label: describeOsuCaller(row.caller) }));
    const sum = described.reduce((count, row) => count + row.count, 0);
    return {
      total: sum,
      groups: OSU_CALL_ORIGINS
        .map((origin) => {
          const rows = described.filter((row) => row.label.origin === origin.id).sort((a, b) => b.count - a.count);
          return { origin, rows, count: rows.reduce((count, row) => count + row.count, 0) };
        })
        .filter((group) => group.rows.length > 0)
        .sort((a, b) => b.count - a.count),
    };
  }, [rawCallers]);

  const used = status?.rate.usedLastMinute ?? 0;
  const target = status?.rate.targetPerMinute ?? status?.rate.hardPerMinute ?? 0;
  const hard = status?.rate.hardPerMinute ?? 0;
  const verdict = rateVerdict(used, target, hard);
  const topGroup = groups[0];
  const topRow = topGroup?.rows[0];
  const windowLabel = live ? "the last minute" : `the last ${windowMinutes} minutes`;

  return (
    <SectionCard
      title="Where the osu! API budget goes"
      subtitle="Every call is tagged with what asked for it. Pick a window, then read down: page loads, background upkeep, or score catch-up."
      actions={
        <div className="flex items-center gap-1 rounded-md border border-osu-b3/25 bg-osu-b5/50 p-1">
          {([
            { value: "live" as const, label: "Last minute" },
            { value: "recent" as const, label: `Last ${windowMinutes} min` },
          ]).map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => setWindowKey(option.value)}
              aria-pressed={windowKey === option.value}
              className={`rounded px-2 py-1 text-[10px] font-semibold uppercase tracking-wider transition-colors duration-[120ms] cursor-pointer ${
                windowKey === option.value ? "bg-osu-b3/55 text-white" : "text-osu-f1 hover:text-osu-l2"
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      }
    >
      <div className="space-y-3">
        <div className="rounded-md border border-osu-b3/25 bg-osu-b5/50 px-3 py-2.5">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className={`text-2xl font-bold leading-none tracking-tight ${verdict.tone}`}>{formatNumber(used)}</span>
            <span className="text-[11px] text-osu-f1">calls in the last minute, out of a paced {formatNumber(target)} a minute</span>
            <span className={`ml-auto text-[11px] font-semibold ${verdict.tone}`}>{verdict.label}</span>
          </div>
          <div className="relative mt-2 h-2 rounded-full bg-osu-b4/70 overflow-hidden">
            <div
              className={`absolute inset-y-0 left-0 rounded-full ${verdict.fill}`}
              style={{ width: `${Math.min(100, hard > 0 ? (used / hard) * 100 : 0)}%` }}
            />
            {hard > 0 && target > 0 && target < hard ? (
              <div className="absolute inset-y-0 w-px bg-osu-c2/70" style={{ left: `${(target / hard) * 100}%` }} />
            ) : null}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-osu-f1">
            <span>Target {formatNumber(target)}/min (the marker)</span>
            <span>Hard ceiling {formatNumber(hard)}/min (bar end)</span>
            {status?.rate.pending ? <span className="text-osu-yellow">{formatNumber(status.rate.pending)} calls waiting for a slot</span> : null}
            {status?.rate.byLane?.length ? (
              <span className="ml-auto">
                Priority in the last minute: {status.rate.byLane.map((row) => `${LIMITER_LANE_LABELS[row.lane] ?? row.lane} ${formatNumber(row.count)}`).join(" · ")}
              </span>
            ) : null}
          </div>
          {topGroup && topRow ? (
            <div className="mt-2 border-t border-osu-b3/20 pt-2 text-[11px] text-osu-c2">
              Biggest driver over {windowLabel}:{" "}
              <span className={`font-semibold ${ORIGIN_STYLES[topGroup.origin.id].text}`}>{topGroup.origin.label.toLowerCase()}</span>
              {" "}at {share(topGroup.count, total)}% of all calls, led by <span className="font-semibold text-white">{topRow.label.title.toLowerCase()}</span>.
            </div>
          ) : null}
        </div>

        {total > 0 ? (
          <div className="rounded-md border border-osu-b3/25 bg-osu-b5/40 px-3 py-2.5">
            <div className="text-[9px] uppercase tracking-wider text-osu-f1 font-semibold">Who asked for it, over {windowLabel}</div>
            <div className="mt-2 flex h-2.5 w-full overflow-hidden rounded-full bg-osu-b4/70">
              {groups.map((group) => (
                <div
                  key={group.origin.id}
                  className={ORIGIN_STYLES[group.origin.id].bar}
                  style={{ width: `${share(group.count, total)}%` }}
                  title={`${group.origin.label}: ${formatNumber(group.count)}`}
                />
              ))}
            </div>
            <div className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
              {groups.map((group) => (
                <div key={group.origin.id} className="flex items-baseline gap-1.5 text-[10px]">
                  <span className={`h-1.5 w-1.5 flex-shrink-0 translate-y-[-1px] rounded-full ${ORIGIN_STYLES[group.origin.id].dot}`} />
                  <span className={`font-semibold ${ORIGIN_STYLES[group.origin.id].text}`}>{group.origin.label}</span>
                  <span className="font-mono text-osu-c2">{formatNumber(group.count)}</span>
                  <span className="text-osu-f1">{share(group.count, total)}%</span>
                  <span className="min-w-0 truncate text-osu-f1/70">{group.origin.blurb}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <div className="grid grid-cols-1 gap-3 lg:grid-cols-5">
          <div className="lg:col-span-3">
            <div className="text-[9px] uppercase tracking-wider text-osu-f1 font-semibold mb-2">
              What is calling, over {windowLabel}
            </div>
            {groups.length === 0 ? (
              <div className="rounded-md border border-osu-b3/20 bg-osu-b5/50 px-3 py-4 text-[11px] text-osu-f1">
                {live ? "No osu! calls in the last minute — nothing is spending budget right now." : "No osu! calls recorded in this window yet."}
              </div>
            ) : (
              <div className="max-h-[560px] space-y-2.5 overflow-y-auto pr-1">
                {groups.map((group) => (
                  <div key={group.origin.id} className="space-y-1.5">
                    <div className="flex items-center gap-2">
                      <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${ORIGIN_STYLES[group.origin.id].dot}`} />
                      <span className={`text-[9px] font-semibold uppercase tracking-wider ${ORIGIN_STYLES[group.origin.id].text}`}>
                        {group.origin.label}
                      </span>
                      <span className="text-[10px] text-osu-f1">
                        {formatNumber(group.count)} calls · {share(group.count, total)}%
                      </span>
                    </div>
                    {group.rows.map((row) => (
                      <RateCallerRowView
                        key={row.caller}
                        caller={row.caller}
                        label={row.label}
                        count={row.count}
                        percent={share(row.count, total)}
                        widthPercent={share(row.count, group.rows[0].count)}
                        timing={rateTimingHint(row)}
                        errors={row.errors}
                      />
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="lg:col-span-2">
            <div className="text-[9px] uppercase tracking-wider text-osu-f1 font-semibold mb-2">What it fetched from osu!</div>
            {paths.length === 0 ? (
              <div className="rounded-md border border-osu-b3/20 bg-osu-b5/50 px-3 py-4 text-[11px] text-osu-f1">Nothing fetched in this window.</div>
            ) : (
              <div className="max-h-[560px] space-y-1.5 overflow-y-auto pr-1">
                {paths.map((row) => {
                  const described = describeOsuPath(row.path, names);
                  return (
                    <div key={row.path} className="relative overflow-hidden rounded-md border border-osu-b3/20 bg-osu-b5/60">
                      <div
                        className="absolute inset-y-0 left-0 bg-osu-b1/15"
                        style={{ width: `${Math.max(4, share(row.count, paths[0].count))}%` }}
                      />
                      <div className="relative px-2.5 py-1.5">
                        <div className="flex items-baseline gap-2">
                          <span className="min-w-0 flex-1 truncate text-[11px] text-white">
                            {described.title}
                            {described.subject ? <span className="text-osu-f1"> · {described.subject}</span> : null}
                          </span>
                          <span className="flex-shrink-0 text-[11px] font-bold text-osu-yellow tabular-nums">{formatNumber(row.count)}</span>
                        </div>
                        <div className="mt-0.5 flex items-center gap-2 text-[9px]">
                          {rateTimingHint(row) ? <span className="flex-shrink-0 text-osu-f1/80">{rateTimingHint(row)}</span> : null}
                          {row.errors ? <span className="flex-shrink-0 font-semibold text-osu-red-light">{formatNumber(row.errors)} failed</span> : null}
                          <span className="ml-auto min-w-0 truncate font-mono text-osu-f1/45" title={row.path}>{row.path}</span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </SectionCard>
  );
}

function rateVerdict(used: number, target: number, hard: number): { label: string; tone: string; fill: string } {
  if (hard > 0 && used >= hard) return { label: "At the hard ceiling", tone: "text-osu-red-light", fill: "bg-osu-red-light" };
  if (target > 0 && used >= target) return { label: "Over target, calls are being paced", tone: "text-osu-yellow", fill: "bg-osu-yellow" };
  if (target > 0 && used >= target * 0.75) return { label: "Busy, still under target", tone: "text-white", fill: "bg-osu-c2" };
  return { label: "Comfortably under target", tone: "text-osu-green-light", fill: "bg-osu-green-light" };
}

function RateCallerRowView({
  caller,
  label,
  count,
  percent,
  widthPercent,
  timing,
  errors,
}: {
  caller: string;
  label: ReturnType<typeof describeOsuCaller>;
  count: number;
  percent: number;
  widthPercent: number;
  timing?: string;
  errors?: number;
}) {
  const style = ORIGIN_STYLES[label.origin];
  return (
    <div className="relative overflow-hidden rounded-md border border-osu-b3/20 bg-osu-b5/60">
      <div className={`absolute inset-y-0 left-0 ${style.tint}`} style={{ width: `${Math.max(4, widthPercent)}%` }} />
      <div className="relative px-2.5 py-2">
        <div className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-white">{label.title}</span>
          {label.surface ? (
            <span className={`flex-shrink-0 text-[9px] font-semibold uppercase tracking-wider ${style.text}`}>{label.surface}</span>
          ) : null}
          <span className="flex-shrink-0 text-[11px] font-bold text-osu-yellow tabular-nums">{formatNumber(count)}</span>
          <span className="w-8 flex-shrink-0 text-right text-[10px] text-osu-f1 tabular-nums">{percent}%</span>
        </div>
        <div className="mt-0.5 text-[10px] leading-snug text-osu-f1">{label.detail}</div>
        <div className="mt-1 flex items-center gap-2 text-[9px]">
          {timing ? <span className="flex-shrink-0 text-osu-f1/80">{timing}</span> : null}
          {errors ? <span className="flex-shrink-0 font-semibold text-osu-red-light">{formatNumber(errors)} failed</span> : null}
          <span className="ml-auto min-w-0 truncate font-mono text-osu-f1/45" title={caller}>{caller}</span>
        </div>
      </div>
    </div>
  );
}

function AbuseGuardCard({ status }: { status: LiveBackendStatus | null }) {
  const abuse = status?.abuse ?? null;
  return (
    <SectionCard title="Abuse guard" subtitle="Server public request limiter state">
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
          The server has not reported abuse guard state yet.
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
  const osuApiDepth = activeRows.reduce((sum, row) => sum + (row.osuApi ? row.count : 0), 0);
  const localDepth = activeRows.reduce((sum, row) => sum + (row.osuApi ? 0 : row.count), 0);
  return (
    <SectionCard title="Job queue" subtitle="Counts by type and status">
      <div className="space-y-3">
        <div className="grid grid-cols-3 gap-2">
          <div className="rounded-md bg-osu-b5/60 border border-osu-b3/20 px-3 py-2">
            <div className="text-[9px] uppercase tracking-wider text-osu-f1 font-semibold">Active depth</div>
            <div className="mt-1 text-xl font-bold text-white">{formatNumber(depth)}</div>
            <div className="mt-1 text-[10px] text-osu-f1 truncate">
              {pressure ? `target ${formatNumber(pressure.targetDepth)}, recover below ${formatNumber(pressure.recoveryDepth ?? 60)}` : "queued / running / failed"}
            </div>
          </div>
          <div className="rounded-md bg-osu-b5/60 border border-osu-b3/20 px-3 py-2">
            <div className="text-[9px] uppercase tracking-wider text-osu-f1 font-semibold">osu! API-bound</div>
            <div className="mt-1 text-xl font-bold text-white">{formatNumber(osuApiDepth)}</div>
            <div className="mt-1 text-[10px] text-osu-f1 truncate">{`need API budget · ${formatNumber(localDepth)} local-only`}</div>
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
        {row.osuApi ? (
          <span className="flex-shrink-0 rounded bg-osu-yellow/10 border border-osu-yellow/25 px-1 py-px text-[8px] font-semibold uppercase tracking-wider text-osu-yellow" title="Consumes osu! API budget">
            api
          </span>
        ) : null}
        <span className="text-[11px] font-bold text-white">{formatNumber(row.count)}</span>
      </div>
      {row.newestError ? <div className="mt-1 text-[10px] font-mono text-osu-red-light/80 truncate">{row.newestError}</div> : null}
    </div>
  );
}

const SWEEPS_REFRESH_MS = 30_000;

const SWEEP_STATUS_CHIP: Record<LiveBackendSweep["status"], string> = {
  done: "bg-osu-green/15 text-osu-green-light",
  running: "bg-osu-blue/15 text-osu-blue animate-pulse",
  pending: "bg-osu-b3/30 text-osu-f1",
  unknown: "bg-osu-yellow/15 text-osu-yellow",
};

function SweepsCard() {
  const [sweeps, setSweeps] = useState<LiveBackendSweep[] | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const result = await fetchLiveBackendSweeps();
        if (cancelled) return;
        if (result === null) {
          setUnsupported(true);
          setSweeps([]);
        } else {
          setUnsupported(false);
          setSweeps(result.sweeps);
        }
        setError(null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    };
    void load();
    const id = window.setInterval(() => {
      void load();
    }, SWEEPS_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  const running = sweeps?.filter((sweep) => sweep.status === "running").length ?? 0;
  const done = sweeps?.filter((sweep) => sweep.status === "done").length ?? 0;

  return (
    <SectionCard
      title="Background sweeps"
      subtitle="One-time backfills and recurring folds; refreshes every 30s"
      actions={
        sweeps ? (
          <span className="text-[10px] text-osu-f1">
            {formatNumber(done)}/{formatNumber(sweeps.length)} done{running > 0 ? `, ${formatNumber(running)} running` : ""}
          </span>
        ) : null
      }
    >
      {error ? (
        <div className="text-[11px] text-osu-red-light">{error}</div>
      ) : unsupported ? (
        <div className="text-[11px] text-osu-f1">The backend does not expose /api/admin/sweeps yet (deploy pending).</div>
      ) : sweeps === null ? (
        <div className="text-[11px] text-osu-f1 text-center py-6">Loading sweeps...</div>
      ) : sweeps.length === 0 ? (
        <div className="text-[11px] text-osu-f1 text-center py-6">No sweeps reported.</div>
      ) : (
        <div className="space-y-1.5">
          {sweeps.map((sweep) => (
            <SweepRow key={sweep.id} sweep={sweep} />
          ))}
        </div>
      )}
    </SectionCard>
  );
}

function formatSweepCounters(progress: Record<string, number>): string {
  return Object.entries(progress)
    .filter(([key]) => key !== "total")
    .map(([key, value]) => `${key} ${formatNumber(value)}`)
    .join(" · ");
}

function SweepRow({ sweep }: { sweep: LiveBackendSweep }) {
  const progress = sweep.progress ?? {};
  const hasFraction = typeof progress.total === "number" && progress.total > 0 && typeof progress.processed === "number";
  const fraction = hasFraction ? Math.min(1, Math.max(0, progress.processed! / progress.total!)) : null;
  const counters = formatSweepCounters(progress);
  return (
    <div className="rounded-md bg-osu-b5/60 border border-osu-b3/20 px-3 py-2" title={sweep.description}>
      <div className="flex items-center gap-2 min-w-0">
        <span className="min-w-0 flex-1 truncate text-[11px] font-bold text-white">{sweep.label}</span>
        <span className="flex-shrink-0 rounded-full bg-osu-b3/30 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-osu-f1 font-semibold">
          {sweep.kind}
        </span>
        <span className={`flex-shrink-0 rounded-full px-1.5 py-0.5 text-[9px] uppercase tracking-wider font-semibold ${SWEEP_STATUS_CHIP[sweep.status] ?? SWEEP_STATUS_CHIP.unknown}`}>
          {sweep.status}
        </span>
        {sweep.updatedAt ? (
          <span className="flex-shrink-0 text-[10px] text-osu-f1">{formatTimeAgo(sweep.updatedAt)}</span>
        ) : null}
      </div>
      {hasFraction ? (
        <div className="mt-1.5">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-mono text-osu-c2">
              {formatNumber(progress.processed!)} / {formatNumber(progress.total!)}
            </span>
            <span className="text-[10px] text-osu-f1">{Math.round((fraction ?? 0) * 100)}%</span>
          </div>
          <div className="mt-1 h-1 rounded-full bg-osu-b3/30 overflow-hidden">
            <div className="h-full rounded-full bg-osu-blue" style={{ width: `${(fraction ?? 0) * 100}%` }} />
          </div>
        </div>
      ) : counters ? (
        <div className="mt-1 text-[10px] font-mono text-osu-c2 truncate">{counters}</div>
      ) : null}
      <div className="mt-1 flex items-baseline gap-2 min-w-0">
        <span className="min-w-0 flex-1 truncate text-[10px] text-osu-f1">{sweep.description}</span>
        {sweep.detail ? <span className="flex-shrink-0 max-w-[45%] truncate text-[10px] font-mono text-osu-l2/75">{sweep.detail}</span> : null}
      </div>
    </div>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-osu-red/30 bg-osu-red/10 px-4 py-3">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-osu-red-light">Server error</div>
      <div className="text-[12px] text-osu-l2 mt-1 break-words">{message}</div>
    </div>
  );
}
