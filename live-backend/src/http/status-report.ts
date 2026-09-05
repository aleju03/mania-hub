import { getServingReadThread } from "../serving-read-thread.js";
import { readStatusAggregates } from "./status-reads.js";
import { getFarmHelperBuildThread } from "../features/farm-helper-thread.js";
import { dbHealth, exec, getSqliteBusyRetryStats, getWriteGateStats, parseJson, type Db } from "../db.js";
import { getCountryRegistry, getCountryRosterSizes } from "../countries.js";
import { packCommunitySnapshotStatus } from "../features/pack-community.js";
import { packCommunityThreadStatus } from "../features/pack-community-thread.js";
import { readJobMemoryMetric, readRuntimeStatus, type RuntimeStatusSnapshot } from "../live/runtime-status.js";
import type { OscStatus } from "../osc/client.js";
import { getDbDiskUsage, getLocalDbStorage, getStorageFootprint } from "../retention.js";
import { eventLoopStatus, type EventLoopStatus } from "../shared/event-loop.js";
import { readProcessMemory, type ProcessMemorySample } from "../shared/process-memory.js";
import { OSU_API_BOUND_JOB_TYPES } from "../workers.js";
import type { HttpContext } from "./context.js";
import { getMapsResponseCacheState, type MapsResponseCache } from "./maps-response-cache.js";
import { mapsSnapshotThreadStatus } from "./maps-snapshot-thread.js";

const HIDDEN_ADMIN_WORKER_LANE_NAMES = new Set([
  "dan-estimates",
  "replay-video-render",
  "replay-video-finalize",
]);

// Stale-while-revalidate cache over the assembled status body. A request that
// lands in a write-lock window (retention delete pass, WAL checkpoint) or
// behind a slow rebuild would otherwise wait out the whole build and trip the
// frontend's 30s abort; serving the last resolved body instantly keeps the
// admin page loading in milliseconds while a single-flight rebuild (started at
// most once per fresh window) refreshes it in the background. A body older
// than the stale budget is no longer served — those requests wait on (and
// coalesce onto) the rebuild, so the data can't lag unboundedly. Keyed by ctx
// (one long-lived object per server boot) so test contexts don't share entries.
const STATUS_BODY_FRESH_MS = 5_000;
const STATUS_BODY_STALE_SERVE_MS = 120_000;

interface StatusBodyCacheEntry {
  startedAt: number;
  settled: boolean;
  promise: Promise<Record<string, unknown>>;
  body: Record<string, unknown> | null;
  bodyAt: number;
}

const statusBodyCacheByCtx = new WeakMap<HttpContext, Map<string, StatusBodyCacheEntry>>();

// Fire-and-forget warm-up for the status body and the expensive count caches
// underneath it (osu-file / chart-analysis backfill counts), so the first
// status request after a boot never pays the cold build in the foreground.
export function warmStatusBodyCache(ctx: HttpContext): void {
  void statusBody(ctx, {}).catch(() => undefined);
}

export async function statusBody(ctx: HttpContext, options: { includeWorkerActivity?: boolean; snapshotCountry?: string } = {}) {
  let cache = statusBodyCacheByCtx.get(ctx);
  if (!cache) {
    cache = new Map();
    statusBodyCacheByCtx.set(ctx, cache);
  }
  const key = `${options.includeWorkerActivity ? "admin" : "public"}:${options.snapshotCountry ?? ""}`;
  const entry = cache.get(key);
  const now = Date.now();
  if (entry?.body) {
    const bodyAge = now - entry.bodyAt;
    if (bodyAge < STATUS_BODY_FRESH_MS) return entry.body;
    if (bodyAge < STATUS_BODY_STALE_SERVE_MS) {
      if (entry.settled && now - entry.startedAt >= STATUS_BODY_FRESH_MS) {
        void startStatusBodyBuild(ctx, options, entry).catch(() => undefined);
      }
      return entry.body;
    }
  }
  // No servable body: wait on the in-flight build if there is one, else build.
  if (entry && !entry.settled) return entry.promise;
  const next: StatusBodyCacheEntry = entry ?? {
    startedAt: now,
    settled: true,
    promise: Promise.resolve({}),
    body: null,
    bodyAt: 0,
  };
  cache.set(key, next);
  return startStatusBodyBuild(ctx, options, next);
}

function startStatusBodyBuild(
  ctx: HttpContext,
  options: { includeWorkerActivity?: boolean; snapshotCountry?: string },
  entry: StatusBodyCacheEntry,
): Promise<Record<string, unknown>> {
  entry.startedAt = Date.now();
  entry.settled = false;
  entry.promise = buildStatusBody(ctx, options)
    .then((body) => {
      entry.body = body;
      entry.bodyAt = Date.now();
      return body;
    })
    .finally(() => {
      entry.settled = true;
    });
  return entry.promise;
}

async function buildStatusBody(ctx: HttpContext, options: { includeWorkerActivity?: boolean; snapshotCountry?: string }): Promise<Record<string, unknown>> {
  // In a split deployment the worker runs in another process, so its live
  // status (lanes, OSC feed, osu! limiter) is mirrored to the DB. Prefer that
  // mirror in server-only mode; fall back to in-process state for "all" mode.
  const mirror = ctx.config.role === "server" ? await readRuntimeStatus(ctx.db) : null;
  // Written by the worker process, read here: it is the only way the serving
  // process can see how much memory a GLOBAL maps refresh actually took. A
  // read failure must degrade to "not reported" rather than take the whole
  // admin body down with it, since this is observability, not state.
  const globalMapsRefresh = options.includeWorkerActivity
    ? await readJobMemoryMetric(ctx.db, "refresh_global_maps").catch(() => null)
    : null;
  // Aggregate scans run on a dedicated read thread; Promise.all alone cannot
  // move synchronous local SQLite work off the serving event loop.
  // The event log, the osu! call history and the shared limiter's
  // reservations live in the journal database (journal.ts).
  const journalDb = ctx.journalDb ?? ctx.db;
  const [
    aggregates,
    db,
    lastEvent,
    storage,
    scoresFallback,
    countries,
    disk,
    storagePaths,
  ] = await Promise.all([
    getServingReadThread(ctx.db, "status")?.run({ kind: "status", options })
      ?? readStatusAggregates(ctx.db, journalDb, options, ctx.queue),
    dbHealth(ctx.db),
    exec(journalDb, "select created_at from live_event_log order by sequence desc limit 1"),
    getLocalDbStorage(ctx.config),
    scoresFallbackStatus(ctx, mirror),
    countryRegistryStatus(ctx),
    // Filesystem pressure and where the disk went. Admin-only, and only paid
    // for on an admin build: statfs is cheap, and the per-path walk behind
    // getStorageFootprint carries its own memo.
    options.includeWorkerActivity ? getDbDiskUsage(ctx.config) : Promise.resolve(undefined),
    options.includeWorkerActivity ? getStorageFootprint(ctx.config) : Promise.resolve(undefined),
  ]);
  const { queueDepth, queuePressure, queueSummary, roster, analysis, osuFileBackfill, apiCalls, catchup, snapshotStats, sharedRate, apiCallNames } = aggregates;
  const worker = (mirror?.worker as WorkerStatus | null | undefined) ?? ctx.workerStatus?.() ?? null;
  const osc = (mirror?.osc as OscStatus | undefined) ?? ctx.oscStatus();
  // The in-process limiter (or the worker's mirrored copy) only sees its own
  // process's calls; the shared reservation table spans server + worker +
  // scores-fallback, so its last-minute view wins when available.
  const rateBase = mirror?.osuRate ?? ctx.osu.limiter.state();
  const rate = sharedRate ? { ...(rateBase as object), ...sharedRate } : rateBase;
  const sqliteBusy = {
    server: getSqliteBusyRetryStats(),
    worker: mirror?.sqliteBusy ?? (ctx.config.role === "server" ? null : getSqliteBusyRetryStats()),
  };
  // The serve-write gate: queue depth / wait EWMA is the write-saturation
  // signal (see withWriteGate), and sheds counts the 429s it handed out.
  const writeGate = getWriteGateStats(ctx.serveWriteDb);
  const writeThread = ctx.serveWriteStatus?.() ?? null;
  // Same server/worker shape as sqliteBusy. The worker's copy rides the
  // live_meta mirror; a worker still running code that does not write it leaves
  // the field undefined, which must read as "unknown", not as a crash. In the
  // "all" role both sides are the same process, hence the pid in the sample.
  const memory = options.includeWorkerActivity
    ? {
      server: readProcessMemory(ctx.config.role ?? "all"),
      worker: (mirror?.memory as ProcessMemorySample | undefined)
        ?? (ctx.config.role === "server" ? null : readProcessMemory(ctx.config.role ?? "all")),
    }
    : undefined;
  // Event loop stalls, same server/worker shape and the same "undefined means
  // unknown" rule as memory. Null on the server side when the monitor was
  // never started (tests build a context without booting the process).
  const eventLoop = options.includeWorkerActivity
    ? {
      server: eventLoopStatus(),
      worker: (mirror?.eventLoop as EventLoopStatus | null | undefined)
        ?? (ctx.config.role === "server" ? null : eventLoopStatus()),
    }
    : undefined;
  // filePath is an absolute path on the server's filesystem and nothing public
  // renders it, so the public body gets everything except that.
  const publicStorage = {
    bytes: storage.bytes,
    walBytes: storage.walBytes,
    maxBytes: storage.maxBytes,
    targetBytes: storage.targetBytes,
    overLimit: storage.overLimit,
  };
  return {
    ok: db,
    db,
    storage: options.includeWorkerActivity ? storage : publicStorage,
    osc,
    lastEventAt: lastEvent.rows[0]?.created_at ?? null,
    queueDepth,
    queuePressure,
    queueSummary: queueSummary.map((row) => ({ ...row, osuApi: OSU_API_BOUND_JOB_TYPES.has(row.type) })),
    roster,
    analysis,
    osuFileBackfill,
    rate,
    sqliteBusy,
    writeGate,
    writeThread,
    scoresFallback,
    abuse: ctx.abuse?.state() ?? null,
    apiCallHistory: apiCallNames ? { ...apiCalls, names: apiCallNames } : apiCalls,
    countries,
    catchup,
    worker: options.includeWorkerActivity ? adminWorkerStatus(worker) : publicWorkerStatus(worker),
    ...(snapshotStats ? { snapshotStats } : {}),
    ...(memory ? { memory } : {}),
    ...(eventLoop ? { eventLoop } : {}),
    ...(options.includeWorkerActivity
      ? {
        // Asking for the thread's status must never be what constructs it.
        mapsSnapshotThread: mapsSnapshotThreadStatus(ctx.config),
        farmHelperThread: getFarmHelperBuildThread(ctx.db)?.status() ?? null,
        packCommunityThread: packCommunityThreadStatus(ctx.config),
        packCommunitySnapshots: packCommunitySnapshotStatus(ctx.db),
        responseCaches: mapsResponseCacheMetrics(ctx.db),
        disk: disk ?? null,
        storagePaths: storagePaths ?? null,
        globalMapsRefresh,
      }
      : {}),
  };
}

// Entry count and body bytes for the maps-page prepared-response cache, surfaced
// in /api/admin/status so the byte budgets are observable in production.
function mapsResponseCacheMetrics(db: Db) {
  const state = getMapsResponseCacheState(db);
  const describe = (cache: MapsResponseCache) => ({
    entries: cache.entries.size,
    bytes: cache.totalBytes,
    maxEntries: cache.maxEntries,
    maxBytes: cache.maxBytes,
    maxEntryBytes: cache.maxEntryBytes,
  });
  return {
    mapsPage: describe(state.pageResponses),
  };
}

export function healthBody(ctx: HttpContext, options: { db?: boolean } = {}) {
  const db = options.db;
  return {
    ok: db ?? true,
    ...(db == null ? {} : { db }),
    role: ctx.config.role ?? "all",
    at: new Date().toISOString(),
  };
}

async function scoresFallbackStatus(ctx: HttpContext, mirror?: RuntimeStatusSnapshot | null) {
  const resultRow = (await exec(ctx.db, "select value_json, updated_at from live_meta where key = 'osu_scores_fallback_last_result'")).rows[0];
  const cursorRow = (await exec(ctx.db, "select value_json, updated_at from live_meta where key = 'osu_scores_fallback_cursor_string'")).rows[0];
  // The fallback poller runs on its own osu! client, so its limiter is a bucket
  // separate from the main one shown in `rate`. Surface used/target/pending here
  // so the admin panel can show the fallback's real polling rate. In split mode
  // the poller lives in the worker process, so prefer its mirrored limiter state.
  const limiterState = (mirror?.scoresFallbackRate as ReturnType<NonNullable<HttpContext["scoresFallbackOsu"]>["limiter"]["state"]> | undefined)
    ?? ctx.scoresFallbackOsu?.limiter.state();
  return {
    enabled: ctx.config.enableOsuScoresFallback,
    intervalMs: ctx.config.osuScoresFallbackIntervalMs,
    updatedAt: resultRow?.updated_at == null ? null : String(resultRow.updated_at),
    result: parseJson(resultRow?.value_json, null),
    cursorUpdatedAt: cursorRow?.updated_at == null ? null : String(cursorRow.updated_at),
    hasCursor: cursorRow?.value_json != null,
    rate: limiterState
      ? {
          usedLastMinute: limiterState.usedLastMinute,
          targetPerMinute: limiterState.targetPerMinute,
          hardPerMinute: limiterState.hardPerMinute,
          pending: limiterState.pending,
        }
      : null,
  };
}

export async function countryFeaturesBody(ctx: HttpContext) {
  const countries = await getCountryRegistry(ctx.db, ctx.config, { ensure: false });
  // rosterSize rides along because the tier alone cannot say whether a country
  // has players: a single seen score puts a country on the 'live' tier, roster
  // or not. Surfaces that list countries as collections (the pack albums) need
  // the count instead.
  const rosterSizes = await getCountryRosterSizes(ctx.db);
  return {
    generatedAt: new Date().toISOString(),
    countries: countries.map((entry) => ({
      country: entry.country,
      featureTier: entry.featureTier,
      rosterSize: rosterSizes.get(entry.country) ?? 0,
    })),
  };
}

type WorkerStatus = ReturnType<NonNullable<HttpContext["workerStatus"]>>;

function visibleWorkerLanes(worker: WorkerStatus | null) {
  return worker?.lanes?.filter((lane) => !HIDDEN_ADMIN_WORKER_LANE_NAMES.has(lane.name));
}

function adminWorkerStatus(worker: WorkerStatus | null) {
  if (!worker) return null;
  return {
    paused: worker.paused,
    stopped: worker.stopped,
    workerId: worker.workerId,
    lanes: visibleWorkerLanes(worker)?.map((lane) => ({
      name: lane.name,
      claimLimit: lane.claimLimit,
      intervalMs: lane.intervalMs,
      jobTypes: lane.jobTypes,
      activeJobs: lane.activeJobs,
    })),
  };
}

function publicWorkerStatus(worker: WorkerStatus | null) {
  if (!worker) return null;
  return {
    paused: worker.paused,
    stopped: worker.stopped,
    workerId: worker.workerId,
    lanes: visibleWorkerLanes(worker)?.map((lane) => ({
      name: lane.name,
      claimLimit: lane.claimLimit,
      intervalMs: lane.intervalMs,
      jobTypes: lane.jobTypes,
      activeJobCount: lane.activeJobs.length,
    })),
  };
}

async function countryRegistryStatus(ctx: HttpContext) {
  const countries = await getCountryRegistry(ctx.db, ctx.config, { ensure: false });
  const clients = new Map((ctx.countryClients?.snapshot() ?? []).map((entry) => [entry.country, entry]));
  return countries.map((entry) => {
    const client = clients.get(entry.country);
    return {
      ...entry,
      activeUsers: client?.activeUsers ?? 0,
      lastActiveAt: client?.lastActiveAt ?? entry.lastRequestedAt,
    };
  });
}
