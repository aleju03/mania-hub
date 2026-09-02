import { dbHealth, exec, getSqliteBusyRetryStats, getWriteGateStats, parseJson, type Db } from "../db.js";
import { getCountryRegistry, getCountryRosterSizes, isGlobalCountry } from "../countries.js";
import { ACTIVITY_SKILL_ANALYSIS_VERSION } from "../features/activity.js";
import { getBeatmapOsuFileBackfillStatus } from "../features/beatmap-osu-file-backfill.js";
import { packCommunitySnapshotStatus } from "../features/pack-community.js";
import { packCommunityThreadStatus } from "../features/pack-community-thread.js";
import { readJobMemoryMetric, readRuntimeStatus, type RuntimeStatusSnapshot } from "../live/runtime-status.js";
import type { OscStatus } from "../osc/client.js";
import { getDbDiskUsage, getLocalDbStorage, getStorageFootprint } from "../retention.js";
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
  // The reads are independent, so they run concurrently: latency is the slowest
  // query, and a write-lock window is waited out once rather than once per
  // query down a sequential chain.
  // The event log, the osu! call history and the shared limiter's
  // reservations live in the journal database (journal.ts).
  const journalDb = ctx.journalDb ?? ctx.db;
  const [
    db,
    lastEvent,
    storage,
    queueDepth,
    queuePressure,
    queueSummary,
    roster,
    analysis,
    osuFileBackfill,
    scoresFallback,
    apiCalls,
    countries,
    catchup,
    snapshotStats,
    sharedRate,
    disk,
    storagePaths,
  ] = await Promise.all([
    dbHealth(ctx.db),
    exec(journalDb, "select created_at from live_event_log order by sequence desc limit 1"),
    getLocalDbStorage(ctx.config),
    ctx.queue.depth(),
    ctx.queue.pressure(),
    ctx.queue.summary(),
    rosterSummary(ctx.db),
    analysisStats(ctx.db),
    getBeatmapOsuFileBackfillStatus(ctx.db, { cacheCounts: true }),
    scoresFallbackStatus(ctx, mirror),
    apiCallHistory(journalDb),
    countryRegistryStatus(ctx),
    countryCatchupStatus(ctx),
    options.snapshotCountry ? adminSnapshotStats(ctx.db, options.snapshotCountry) : Promise.resolve(undefined),
    sharedRateBreakdown(journalDb),
    // Filesystem pressure and where the disk went. Admin-only, and only paid
    // for on an admin build: statfs is cheap, and the per-path walk behind
    // getStorageFootprint carries its own memo.
    options.includeWorkerActivity ? getDbDiskUsage(ctx.config) : Promise.resolve(undefined),
    options.includeWorkerActivity ? getStorageFootprint(ctx.config) : Promise.resolve(undefined),
  ]);
  const worker = (mirror?.worker as WorkerStatus | null | undefined) ?? ctx.workerStatus?.() ?? null;
  const osc = (mirror?.osc as OscStatus | undefined) ?? ctx.oscStatus();
  // Only the admin panel renders paths, so the public body never pays for the
  // name lookups behind them.
  const apiCallNames = options.includeWorkerActivity
    ? await apiCallPathNames(ctx.db, [...apiCalls.byPath.map((row) => row.path), ...(sharedRate?.byPath ?? []).map((row) => row.path)])
    : null;
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
    ...(options.includeWorkerActivity
      ? {
        // Asking for the thread's status must never be what constructs it.
        mapsSnapshotThread: mapsSnapshotThreadStatus(ctx.config),
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

// Beatmap chart-analysis progress: how many maps have a ready skill vector at the
// current analysis version (the pool that powers pattern search + collections),
// plus what is still in flight, failed, or un-analyzable, and how many are indexed.
async function analysisStats(db: Db) {
  const [vectors, indexed] = await Promise.all([
    exec(
      db,
      "select status, count(*) as count from beatmap_skill_vectors where analysis_version = ? group by status",
      [ACTIVITY_SKILL_ANALYSIS_VERSION],
    ),
    exec(db, "select count(*) as count from map_search_index"),
  ]);
  const byStatus: Record<string, number> = {};
  for (const row of vectors.rows) byStatus[String(row.status)] = Number(row.count ?? 0);
  return {
    version: ACTIVITY_SKILL_ANALYSIS_VERSION,
    analyzed: byStatus.ready ?? 0,
    running: byStatus.running ?? 0,
    failed: byStatus.failed ?? 0,
    unavailable: byStatus.unavailable ?? 0,
    searchIndexed: Number(indexed.rows[0]?.count ?? 0),
  };
}

async function adminSnapshotStats(db: Db, country: string) {
  const normalized = country.toUpperCase();
  const global = isGlobalCountry(normalized);
  const now = Date.now();
  const topPlaysCutoff = new Date(now - 7 * 24 * 60 * 60_000).toISOString();
  const [tracker, topPlays, snipes] = await Promise.all([
    exec(
      db,
      `select count(*) as count
       from (
         select 1
         from score_events
         where ${global ? "" : "country = ? and "}passed = 1
         order by ended_at desc
         limit 100
       )`,
      global ? [] : [normalized],
    ),
    exec(
      db,
      `select count(*) as count
       from (
         select 1
         from top_play_events
         where ${global ? "" : "country = ? and "}detected_at >= ?
         order by pp desc, detected_at desc
         limit 200
       )`,
      global ? [topPlaysCutoff] : [normalized, topPlaysCutoff],
    ),
    exec(
      db,
      `select count(*) as count
       from (
         select 1
         from snipe_events
         where ${global ? "1 = 1" : "country = ?"}
         order by detected_at desc
         limit 500
       )`,
      global ? [] : [normalized],
    ),
  ]);

  return {
    trackerScores: Number(tracker.rows[0]?.count ?? 0),
    trackerFetchedAt: now,
    topPlays: Number(topPlays.rows[0]?.count ?? 0),
    topPlaysFetchedAt: now,
    snipes: Number(snipes.rows[0]?.count ?? 0),
    snipesFetchedAt: now,
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

interface CountryCatchupResult {
  fetched: number;
  inserted: number;
  skipped: number;
  after: number;
  nextAfter: number | null;
  hasMore: boolean;
}

interface CountryCatchupState {
  pending: number;
  running: number;
  failed: number;
  lastError: string | null;
  lastRunAt: string | null;
  cursorMs: number | null;
  lastResult: CountryCatchupResult | null;
}

async function countryCatchupStatus(ctx: HttpContext): Promise<Record<string, CountryCatchupState>> {
  const meta = (await exec(
    ctx.db,
    "select key, value_json, updated_at from live_meta where key like 'osc_country_catchup_last_result:%' or key like 'osc_country_catchup_cursor_ms:%'",
  )).rows;
  const jobs = (await exec(
    ctx.db,
    "select status, payload_json, last_error from jobs where type = 'osc_country_catchup' and status in ('queued', 'running', 'failed')",
  )).rows;
  const byCountry = new Map<string, CountryCatchupState>();
  const ensure = (country: string): CountryCatchupState => {
    let state = byCountry.get(country);
    if (!state) {
      state = { pending: 0, running: 0, failed: 0, lastError: null, lastRunAt: null, cursorMs: null, lastResult: null };
      byCountry.set(country, state);
    }
    return state;
  };
  for (const row of meta) {
    const key = String(row.key);
    const country = key.split(":")[1]?.toUpperCase();
    if (!country) continue;
    const state = ensure(country);
    if (key.startsWith("osc_country_catchup_last_result:")) {
      state.lastResult = parseJson<CountryCatchupResult | null>(row.value_json, null);
      state.lastRunAt = row.updated_at == null ? null : String(row.updated_at);
    } else {
      const cursor = parseJson<number>(row.value_json, Number.NaN);
      state.cursorMs = Number.isFinite(cursor) ? cursor : null;
    }
  }
  for (const row of jobs) {
    const payload = parseJson<{ country?: string }>(row.payload_json, {});
    const country = typeof payload.country === "string" ? payload.country.toUpperCase() : null;
    if (!country) continue;
    const state = ensure(country);
    const status = String(row.status);
    if (status === "running") state.running += 1;
    else if (status === "queued") state.pending += 1;
    else if (status === "failed") {
      state.failed += 1;
      if (row.last_error != null) state.lastError = String(row.last_error);
    }
  }
  return Object.fromEntries(byCountry);
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

async function rosterSummary(db: Db) {
  const rows = (await exec(
    db,
    `select country, count(*) as users, max(refreshed_at) as refreshed_at
     from country_rosters
     where is_tracked = 1
     group by country
     order by country asc`,
  )).rows;
  return rows.map((row) => ({
    country: String(row.country),
    users: Number(row.users),
    refreshedAt: row.refreshed_at == null ? null : String(row.refreshed_at),
  }));
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

// Cross-process last-minute osu! rate view from the shared limiter's
// reservation log: unlike the per-process limiter state, this covers server
// interactive calls, worker jobs, and the scores-fallback poller together.
async function sharedRateBreakdown(db: Db): Promise<{
  usedLastMinute: number;
  byCaller: Array<{ caller: string; count: number }>;
  byPath: Array<{ path: string; count: number }>;
  byLane: Array<{ lane: string; count: number }>;
} | null> {
  try {
    const rows = (await exec(
      db,
      "select caller, path, lane from api_rate_limit_reservations where provider = 'osu' and started_at_ms > ?",
      [Date.now() - 60_000],
    )).rows;
    const tally = (key: "caller" | "path" | "lane") => {
      const counts = new Map<string, number>();
      for (const row of rows) {
        const value = String(row[key] ?? "unknown");
        counts.set(value, (counts.get(value) ?? 0) + 1);
      }
      return [...counts.entries()].sort((a, b) => b[1] - a[1]);
    };
    return {
      usedLastMinute: rows.length,
      byCaller: tally("caller").map(([caller, count]) => ({ caller, count })),
      byPath: tally("path").slice(0, 10).map(([path, count]) => ({ path, count })),
      byLane: tally("lane").map(([lane, count]) => ({ lane, count })),
    };
  } catch {
    return null;
  }
}

async function apiCallHistory(db: Db) {
  const since = new Date(Date.now() - 15 * 60_000).toISOString();
  const [byCaller, byPath] = await Promise.all([
    exec(
      db,
      `select coalesce(t.caller, l.caller) as caller, count(*) as count,
              round(avg(l.duration_ms)) as avg_ms, max(l.duration_ms) as max_ms,
              sum(case when l.status >= 400 then 1 else 0 end) as errors
       from api_call_log l
       left join api_call_targets t on t.id = l.target_id
       where l.provider = 'osu' and l.started_at >= ?
       group by coalesce(t.caller, l.caller)
       order by count desc
       limit 20`,
      [since],
    ),
    exec(
      db,
      `select coalesce(t.path, l.path) as path, count(*) as count,
              round(avg(l.duration_ms)) as avg_ms, max(l.duration_ms) as max_ms,
              sum(case when l.status >= 400 then 1 else 0 end) as errors
       from api_call_log l
       left join api_call_targets t on t.id = l.target_id
       where l.provider = 'osu' and l.started_at >= ?
       group by coalesce(t.path, l.path)
       order by count desc
       limit 20`,
      [since],
    ),
  ]);
  const stats = (row: Record<string, unknown>) => ({
    count: Number(row.count),
    avgMs: row.avg_ms == null ? null : Number(row.avg_ms),
    maxMs: row.max_ms == null ? null : Number(row.max_ms),
    errors: Number(row.errors ?? 0),
  });
  return {
    windowMinutes: 15,
    byCaller: byCaller.rows.map((row) => ({ caller: String(row.caller), ...stats(row) })),
    byPath: byPath.rows.map((row) => ({ path: String(row.path), ...stats(row) })),
  };
}

/* Names for the ids inside logged osu! paths, so the admin panel can render
   "Top 100 · Rii" instead of "/users/39867808/scores/best?mode=mania&...".
   Admin-only and best-effort: a lookup miss (or a whole failed query) just
   leaves the panel showing the bare id it already had. */
const API_PATH_ID_LIMIT = 60;

async function apiCallPathNames(db: Db, paths: string[]): Promise<{
  users: Record<string, string>;
  beatmaps: Record<string, string>;
  beatmapsets: Record<string, string>;
}> {
  const empty = { users: {}, beatmaps: {}, beatmapsets: {} };
  const userIds = new Set<string>();
  const beatmapIds = new Set<string>();
  const beatmapsetIds = new Set<string>();
  for (const path of paths) {
    for (const [, id] of path.matchAll(/\/users\/(\d+)/g)) userIds.add(id);
    // /osu/<id> is the .osu file download, the same beatmap id by another name.
    for (const [, id] of path.matchAll(/\/(?:beatmaps|osu)\/(\d+)/g)) beatmapIds.add(id);
    for (const [, id] of path.matchAll(/\/beatmapsets\/(\d+)/g)) beatmapsetIds.add(id);
  }
  const ids = (set: Set<string>) => [...set].slice(0, API_PATH_ID_LIMIT).map((id) => Number(id));
  const userList = ids(userIds);
  const beatmapList = ids(beatmapIds);
  const beatmapsetList = ids(beatmapsetIds);
  if (!userList.length && !beatmapList.length && !beatmapsetList.length) return empty;
  const holes = (count: number) => new Array(count).fill("?").join(",");
  try {
    const [users, beatmaps, sets] = await Promise.all([
      userList.length
        ? exec(db, `select user_id, username from users where user_id in (${holes(userList.length)})`, userList)
        : null,
      beatmapList.length
        ? exec(
          db,
          `select b.beatmap_id as id, s.artist as artist, s.title as title, b.version as version
             from beatmaps b left join beatmapsets s on s.beatmapset_id = b.beatmapset_id
            where b.beatmap_id in (${holes(beatmapList.length)})`,
          beatmapList,
        )
        : null,
      beatmapsetList.length
        ? exec(
          db,
          `select beatmapset_id as id, artist, title from beatmapsets where beatmapset_id in (${holes(beatmapsetList.length)})`,
          beatmapsetList,
        )
        : null,
    ]);
    const mapTitle = (row: Record<string, unknown>) => {
      const artist = row.artist ? String(row.artist) : "";
      const title = row.title ? String(row.title) : "";
      const name = [artist, title].filter(Boolean).join(" - ") || `map ${row.id}`;
      return row.version ? `${name} [${String(row.version)}]` : name;
    };
    return {
      users: Object.fromEntries((users?.rows ?? []).map((row) => [String(row.user_id), String(row.username)])),
      beatmaps: Object.fromEntries((beatmaps?.rows ?? []).map((row) => [String(row.id), mapTitle(row)])),
      beatmapsets: Object.fromEntries((sets?.rows ?? []).map((row) => [String(row.id), mapTitle(row)])),
    };
  } catch {
    return empty;
  }
}
