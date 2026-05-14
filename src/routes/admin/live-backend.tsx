import { createFileRoute, notFound } from "@tanstack/react-router";
import { Activity, AlertTriangle, Database, HelpCircle, History, Pause, Play, Radio, RefreshCw, Server, Signal, Trash2, UserRound, Wifi, WifiOff } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { canUseAdminFeatures } from "../../lib/auth-shared";
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
  rate: {
    hardPerMinute: number;
    usedLastMinute: number;
    byCaller?: Array<{ caller: string; count: number }>;
    byPath?: Array<{ path: string; count: number }>;
  };
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

const REFRESH_MS = 5_000;
const DEFAULT_COUNTRY = "CR";

export const Route = createFileRoute("/admin/live-backend")({
  head: () => ({
    meta: [
      { title: "Live backend - admin" },
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
    const quiet = refreshNonce > 0;
    void load(quiet);
  }, [load, refreshNonce]);

  useEffect(() => {
    if (!autoRefresh) return;
    const id = window.setInterval(() => {
      setRefreshNonce((value) => value + 1);
    }, REFRESH_MS);
    return () => window.clearInterval(id);
  }, [autoRefresh]);

  useEffect(() => {
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
  }, [countryCode]);

  return (
    <div className="flex-1">
      <LiveBackendHeader
        backendUrl={backendUrl}
        refreshing={refreshing}
        autoRefresh={autoRefresh}
        connectionState={connectionState}
        onRefresh={() => setRefreshNonce((value) => value + 1)}
        onToggleAutoRefresh={() => setAutoRefresh((value) => !value)}
      />
      <div className="bg-osu-b5 min-h-[calc(100vh-60px)]">
        <div className="max-w-[1200px] mx-auto px-4 sm:px-5 py-5 space-y-6">
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

          <Section title="osu! API pressure" subtitle="Who and what is burning rate-limit budget">
            <RateBreakdownCard status={status} />
          </Section>

          <Section title="Controls" subtitle="Admin actions. Safe actions on top, destructive at the bottom.">
            <ControlsCard
              status={status}
              busy={actionBusy}
              onClearFailed={() => void runAdminAction("clear-failed", "/api/admin/clear-failed-jobs")}
              onRefreshRoster={() => void runAdminAction("refresh-roster", `/api/admin/refresh-roster?country=${encodeURIComponent(countryCode)}`)}
              onRunRetention={() => void runAdminAction("retention", "/api/admin/run-retention")}
              onOscSmoke={() => void runAdminAction("osc-smoke", "/api/admin/osc-smoke")}
              onRunOscBackfill={() => void runAdminAction("osc-backfill", "/api/admin/run-osc-backfill")}
              onResetLocalDb={() => void runAdminAction("reset-local-db", "/api/admin/reset-local-db")}
              onToggleWorkers={() => void runAdminAction(
                status?.worker?.paused ? "resume-workers" : "pause-workers",
                status?.worker?.paused ? "/api/admin/resume-workers" : "/api/admin/pause-workers",
              )}
            />
          </Section>
        </div>
      </div>
    </div>
  );
}

function LiveBackendHeader({
  backendUrl,
  refreshing,
  autoRefresh,
  connectionState,
  onRefresh,
  onToggleAutoRefresh,
}: {
  backendUrl: string | null;
  refreshing: boolean;
  autoRefresh: boolean;
  connectionState: ConnectionState;
  onRefresh: () => void;
  onToggleAutoRefresh: () => void;
}) {
  const connected = connectionState === "open";
  return (
    <div className="bg-osu-d5 border-b border-osu-b3/40">
      <div className="max-w-[1200px] mx-auto px-4 sm:px-5 py-3 flex items-center gap-3">
        <div className="relative flex-shrink-0">
          <span className={`block w-2.5 h-2.5 rounded-full ${connected ? "bg-osu-green-light" : "bg-osu-yellow"}`} />
          {connected ? <span className="absolute inset-0 rounded-full bg-osu-green-light animate-ping opacity-75" /> : null}
        </div>
        <h2 className="text-[13px] sm:text-[15px] font-medium text-osu-c2">Live backend</h2>
        <span className="text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-osu-yellow/15 text-osu-yellow">
          admin
        </span>
        <span className="hidden sm:inline text-[11px] text-osu-f1 font-mono truncate">{backendUrl ?? "not configured"}</span>
        <div className="ml-auto flex items-center gap-2 text-[11px] text-osu-f1">
          <span className={refreshing ? "text-osu-pink-light" : ""}>{refreshing ? "refreshing..." : connectionState}</span>
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
        </div>
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

function SectionCard({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-osu-b3/30 bg-osu-b4/30 flex flex-col w-full">
      <div className="px-4 pt-3 pb-2 border-b border-osu-b3/20">
        <div className="text-[11px] font-semibold text-osu-c2 uppercase tracking-wider">{title}</div>
        {subtitle ? <div className="text-[10px] text-osu-f1 mt-0.5">{subtitle}</div> : null}
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
  onResetLocalDb,
  onToggleWorkers,
}: {
  status: LiveBackendStatus | null;
  busy: string | null;
  onClearFailed: () => void;
  onRefreshRoster: () => void;
  onRunRetention: () => void;
  onOscSmoke: () => void;
  onRunOscBackfill: () => void;
  onResetLocalDb: () => void;
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
      <div className="rounded-lg border border-osu-red/30 bg-osu-red/5 p-3">
        <div className="flex items-center gap-2 mb-2">
          <AlertTriangle className="h-3.5 w-3.5 text-osu-red-light" />
          <div className="text-[10px] uppercase tracking-wider text-osu-red-light font-semibold">Danger zone</div>
          <div className="text-[10px] text-osu-f1">Destructive. Local development only.</div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
          <AdminButton
            label="Reset local DB"
            description="Local development only. Clears the live backend database tables."
            icon={<Trash2 className="h-3.5 w-3.5" />}
            busy={busy === "reset-local-db"}
            onClick={onResetLocalDb}
            danger
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
