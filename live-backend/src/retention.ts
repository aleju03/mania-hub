import { readdir, stat, statfs, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { deleteInBatches, exec } from "./db.js";
import { pruneAvatarAccents } from "./features/avatar-accents.js";
import { pruneOsuProxyCache } from "./features/osu-proxy-cache.js";
import { PROFILE_SNAPSHOT_REFRESH_JOB, PROFILE_USER_REFRESH_JOB } from "./features/player-profiles.js";
import { sweepAbandonedStreakRuns } from "./features/pack-streak.js";
import { deleteSkin, listExpiredPendingSkins } from "./features/skins.js";
import { logInfo, logWarn, errorContext } from "./logger.js";
import { deleteSkinObjects, type SkinStorageConfig } from "./skins/r2.js";

export interface LocalDbStorage {
  filePath: string | null;
  bytes: number | null;
  walBytes: number | null;
  maxBytes: number;
  targetBytes: number;
  overLimit: boolean;
}

export async function runRetention(db: Db, config: Pick<Config, "databaseUrl" | "scoreEventRetentionDays" | "liveEventRetentionDays" | "doneJobRetentionDays" | "apiCallLogRetentionDays" | "replayVideoJobRetentionDays" | "rankSnapshotRetentionDays" | "activityRetentionYears" | "replayVideoWorkDir" | "maxLocalDbBytes" | "targetLocalDbBytes"> & SkinStorageConfig): Promise<Record<string, number>> {
  const scoreCutoff = daysAgo(config.scoreEventRetentionDays);
  const liveCutoff = daysAgo(config.liveEventRetentionDays);
  const doneJobCutoff = daysAgo(config.doneJobRetentionDays);
  const apiCutoff = daysAgo(config.apiCallLogRetentionDays);
  const parkedOnDemandCutoff = new Date(Date.now() - PARKED_ON_DEMAND_JOB_RETENTION_HOURS * 60 * 60 * 1000).toISOString();
  const replayVideoCutoff = daysAgo(config.replayVideoJobRetentionDays);
  const rankSnapshotCutoff = daysAgo(config.rankSnapshotRetentionDays);
  const activityCutoffDay = activityRetentionCutoffDay(config.activityRetentionYears);
  // farm_helper_feedback stores epoch-ms timestamps, so its cutoff is numeric.
  const resolvedFeedbackCutoffMs = Date.now() - RESOLVED_FARM_HELPER_FEEDBACK_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  // pack_pull_events also stores epoch-ms. Ordinary pulls only matter while
  // recent (7-day "got pulled" counts); notable ones back the feed and keep a
  // longer tail. Durable ownership counts live in pack_collection_cards.
  const packPullCutoffMs = Date.now() - PACK_PULL_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const packPullNotableCutoffMs = Date.now() - NOTABLE_PACK_PULL_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  // A finished blitz run is a transient record of one game: what it is worth
  // to the board already lives in pack_streak_bests, so the row only has to
  // outlive the question "was that run played by a human". Runs somebody
  // walked away from are closed first, since a run reaches the board (and gets
  // paid) by ending.
  const streakRunCutoffMs = Date.now() - BLITZ_STREAK_RUN_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const streakRunsSwept = await sweepAbandonedStreakRuns(db);
  const oldReplayVideoJobs = (await exec(
    db,
    "select id from replay_video_exports where status in ('done', 'failed', 'cancelled') and updated_at < ?",
    [replayVideoCutoff],
  )).rows.map((row) => String(row.id));
  // Abandoned skin uploads: pending rows whose ticket expired over an hour ago
  // never got finished, so the row and any half-uploaded R2 objects go away.
  // Published/hidden skins are durable and never pruned.
  const expiredPendingSkins = await listExpiredPendingSkins(db, new Date(Date.now() - 60 * 60 * 1000).toISOString());
  let skinsPendingExpired = 0;
  for (const skin of expiredPendingSkins) {
    if (await deleteSkin(db, skin.id)) skinsPendingExpired += 1;
  }
  if (expiredPendingSkins.length > 0) {
    await deleteSkinObjects(config, expiredPendingSkins.flatMap((skin) => skin.keys)).catch((error) => {
      logWarn("retention_skin_r2_cleanup_failed", errorContext(error));
    });
  }
  // Every prune goes through deleteInBatches: a backlogged table (post-outage
  // catch-up, a lowered cutoff, the once-a-year activity purge) must never hold
  // the write lock for one giant statement while both processes' writers burn
  // their busy budgets behind it.
  const results = {
    skinsPendingExpired,
    scoreEvents: await deleteInBatches(db, "score_events", "received_at < ?", [scoreCutoff]),
    liveEvents: await deleteInBatches(db, "live_event_log", "created_at < ?", [liveCutoff]),
    doneJobs: await deleteInBatches(db, "jobs", "status = 'done' and updated_at < ?", [doneJobCutoff]),
    parkedOnDemandJobs: await deleteInBatches(
      db,
      "jobs",
      `status = 'deferred_pressure'
         and updated_at < ?
         and type in (${PARKED_ON_DEMAND_JOB_TYPES.map(() => "?").join(", ")})`,
      [parkedOnDemandCutoff, ...PARKED_ON_DEMAND_JOB_TYPES],
    ),
    apiCalls: await deleteInBatches(db, "api_call_log", "started_at < ?", [apiCutoff]),
    replayVideoJobs: await deleteInBatches(db, "replay_video_exports", "status in ('done', 'failed', 'cancelled') and updated_at < ?", [replayVideoCutoff]),
    rankSnapshots: await deleteInBatches(db, "country_rank_snapshots", "captured_at < ?", [rankSnapshotCutoff]),
    activityScoreRefs: await deleteInBatches(db, "player_activity_score_refs", "day < ?", [activityCutoffDay]),
    activityMaps: await deleteInBatches(db, "player_activity_maps", "day < ?", [activityCutoffDay]),
    activityDays: await deleteInBatches(db, "player_activity_days", "day < ?", [activityCutoffDay]),
    // Discord "last map in channel" memory is only useful while fresh, so 30d is
    // plenty; stale rows just mean /pb asks the user to run /recent again.
    discordChannelContext: await deleteInBatches(db, "discord_channel_map_context", "updated_at < ?", [daysAgo(30)]),
    // Resolved farm-helper feedback marks are spent evidence (the play that
    // retired them drives recs now); active (unresolved) marks are the
    // player's standing preferences and are never pruned.
    farmHelperFeedbackResolved: await deleteInBatches(db, "farm_helper_feedback", "resolved_at is not null and resolved_at < ?", [resolvedFeedbackCutoffMs]),
    packPullEvents: await deleteInBatches(db, "pack_pull_events", "notable = 0 and pulled_at < ?", [packPullCutoffMs]),
    packPullEventsNotable: await deleteInBatches(db, "pack_pull_events", "notable = 1 and pulled_at < ?", [packPullNotableCutoffMs]),
    streakRunsSwept,
    streakRuns: await deleteInBatches(db, "pack_streak_runs", "status = 'ended' and updated_at < ?", [streakRunCutoffMs]),
    // Slow self-healing refresh: a pruned accent recomputes the next time the
    // avatar shows up in a payload. Also bounds churn from avatar changes.
    avatarAccents: await pruneAvatarAccents(db),
    // osu! proxy response cache rows past their stale window.
    osuProxyCache: await pruneOsuProxyCache(db),
  };
  const storageBefore = await getLocalDbStorage(config);
  const emergency = storageBefore.overLimit ? await pruneForLocalDbLimit(db, config, storageBefore) : {};
  // The WAL is kept bounded by startWalCheckpointer (a dedicated ~15s TRUNCATE
  // brake); a redundant PASSIVE here only contends for the same checkpoint lock.
  // The emergency over-limit path (pruneForLocalDbLimit) still TRUNCATEs to
  // reclaim disk when the DB is over its hard cap.
  Object.assign(results, emergency);
  await Promise.allSettled(oldReplayVideoJobs.map((id) => rm(resolve(config.replayVideoWorkDir, id), { recursive: true, force: true })));
  // The hourly tick is the only thing that reliably runs on the box, so it
  // doubles as the disk alarm: the DB cap alone cannot catch backups, the
  // analytics DB or logs filling the same filesystem.
  const disk = await getDbDiskUsage(config);
  if (disk && disk.level !== "ok") {
    logWarn("disk_usage_high", {
      path: disk.path,
      level: disk.level,
      used_pct: disk.usedPct,
      free_bytes: disk.freeBytes,
      total_bytes: disk.totalBytes,
    });
  }
  logInfo("retention_complete", { ...results, ...(disk ? { disk_used_pct: disk.usedPct } : {}) });
  return results;
}

export function startRetentionScheduler(db: Db, config: Config): () => void {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    await runRetention(db, config).catch((error) => {
      console.warn("[retention] failed", error);
    });
    if (!stopped) setTimeout(tick, config.retentionIntervalMs).unref();
  };
  setTimeout(tick, config.retentionIntervalMs).unref();
  return () => {
    stopped = true;
  };
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

// Long enough that "you already beat this" history stays visible on the
// feedback list for a couple of seasons, short enough that resolved rows do
// not accumulate forever alongside the never-pruned active marks.
export const RESOLVED_FARM_HELPER_FEEDBACK_RETENTION_DAYS = 180;

// Ordinary pack pulls feed only short-window stats (the hourly pull cap, the
// 7-day "got pulled" count, the recent-pulls ticker), and first-global checks
// read the durable serial registry rather than this log, so two weeks covers
// every reader with margin. Notable ones back the community feed and are rare
// enough to keep for a year.
export const PACK_PULL_EVENT_RETENTION_DAYS = 14;
export const NOTABLE_PACK_PULL_EVENT_RETENTION_DAYS = 365;

// Long enough that a suspicious board entry can still be checked against the
// run that set it (guess_ms_json lives on the run row), short enough that the
// log of every game ever played does not become permanent. The board itself is
// durable and unaffected.
export const BLITZ_STREAK_RUN_LOG_RETENTION_DAYS = 45;

// Parked jobs whose only reason to exist was "someone is looking at this
// profile right now". They are enqueued from the profile read path alone, and
// enqueue()'s dedupe-key upsert flips a parked row straight back to queued, so
// the next view revives the work by itself. Once one has sat parked for hours
// nobody is waiting on it: draining it would spend an osu! call refreshing a
// profile no one has open, and while it sits there it outranks real work in the
// priority-desc reactivation order. Six hours is well past the point where the
// viewer who triggered it has gone.
export const PARKED_ON_DEMAND_JOB_RETENTION_HOURS = 6;
export const PARKED_ON_DEMAND_JOB_TYPES = [PROFILE_SNAPSHOT_REFRESH_JOB, PROFILE_USER_REFRESH_JOB] as const;

export function activityRetentionCutoffDay(retentionYears: number, now = new Date()): string {
  const years = Math.max(1, Math.floor(retentionYears));
  const cutoffYear = now.getUTCFullYear() - years + 1;
  return `${cutoffYear}-01-01`;
}

export async function getLocalDbStorage(config: Pick<Config, "databaseUrl" | "maxLocalDbBytes" | "targetLocalDbBytes">): Promise<LocalDbStorage> {
  const filePath = localDbFilePath(config.databaseUrl);
  const [bytes, walBytes] = filePath
    ? await Promise.all([fileSize(filePath), fileSize(`${filePath}-wal`)])
    : [null, null];
  const totalBytes = (bytes ?? 0) + (walBytes ?? 0);
  return {
    filePath,
    bytes,
    walBytes,
    maxBytes: config.maxLocalDbBytes,
    targetBytes: Math.min(config.targetLocalDbBytes, config.maxLocalDbBytes),
    overLimit: filePath != null && totalBytes > config.maxLocalDbBytes,
  };
}

// Disk pressure is measured for the whole filesystem the database lives on, not
// just the DB file: the WAL, the analytics DB, snapshots and the journal all
// share it, so an over-limit DB is only one of several ways to run out of room.
const DISK_WARN_PCT = 70;
const DISK_CRITICAL_PCT = 85;

export interface DiskUsage {
  path: string;
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  usedPct: number;
  warnPct: number;
  criticalPct: number;
  level: "ok" | "warn" | "critical";
}

export interface StorageFootprint {
  db: number | null;
  dbWal: number | null;
  dbShm: number | null;
  analytics: number | null;
  analyticsWal: number | null;
  backups: number | null;
  replayVideoWork: number | null;
}

// Follows df rather than raw block counts: the blocks a filesystem reserves for
// root count as neither used nor available, so this percentage matches what an
// operator reads off the box (and the thresholds they set there).
export async function getDiskUsage(path: string): Promise<DiskUsage | null> {
  const stats = await statfs(path).catch(() => null);
  if (!stats) return null;
  const blockSize = Number(stats.bsize);
  const blocks = Number(stats.blocks);
  if (!(blockSize > 0) || !(blocks > 0)) return null;
  const usedBytes = (blocks - Number(stats.bfree)) * blockSize;
  const freeBytes = Number(stats.bavail) * blockSize;
  const capacity = usedBytes + freeBytes;
  const usedPct = capacity > 0 ? Math.round((usedBytes / capacity) * 1000) / 10 : 0;
  return {
    path,
    totalBytes: blocks * blockSize,
    usedBytes,
    freeBytes,
    usedPct,
    warnPct: DISK_WARN_PCT,
    criticalPct: DISK_CRITICAL_PCT,
    level: usedPct >= DISK_CRITICAL_PCT ? "critical" : usedPct >= DISK_WARN_PCT ? "warn" : "ok",
  };
}

// The filesystem holding the database, which is the one that matters: a remote
// database has no local disk to run out of, hence the null.
export async function getDbDiskUsage(config: Pick<Config, "databaseUrl">): Promise<DiskUsage | null> {
  const filePath = localDbFilePath(config.databaseUrl);
  return filePath ? getDiskUsage(dirname(filePath)) : null;
}

// Where the disk actually went, per path. Callers hand over whatever slice of
// the config they hold and optional fields may genuinely be missing at runtime,
// so every path is derived defensively; a null means "not configured or absent"
// (an absent replay-video work dir is the signal that it stayed disabled).
export async function getStorageFootprint(
  config: Pick<Config, "databaseUrl"> & Partial<Pick<Config, "analyticsDatabaseUrl" | "replayVideoWorkDir">>,
): Promise<StorageFootprint> {
  const dbPath = localDbFilePath(config.databaseUrl);
  const analyticsPath = localDbFilePath(config.analyticsDatabaseUrl);
  const backupsDir = dbPath ? join(dirname(dbPath), BACKUPS_DIR_NAME) : null;
  const workDir = config.replayVideoWorkDir ? resolve(config.replayVideoWorkDir) : null;
  const [db, dbWal, dbShm, analytics, analyticsWal, backups, replayVideoWork] = await Promise.all([
    optionalFileSize(dbPath),
    optionalFileSize(dbPath && `${dbPath}-wal`),
    optionalFileSize(dbPath && `${dbPath}-shm`),
    optionalFileSize(analyticsPath),
    optionalFileSize(analyticsPath && `${analyticsPath}-wal`),
    optionalDirSize(backupsDir),
    optionalDirSize(workDir),
  ]);
  return { db, dbWal, dbShm, analytics, analyticsWal, backups, replayVideoWork };
}

// Index-building migrations can transiently need a large multiple of the table
// they cover, and a half-applied migration on a full disk is worse than a
// refused boot. The warn floor stays non-fatal on purpose: the worker restarts
// on failure and would crash-loop, taking the server role down with it through
// waitForSchema. Below the hard floor writes fail anyway, so failing loudly
// there is the honest outcome.
const MIGRATION_WARN_FREE_BYTES = 2 * 1024 * 1024 * 1024;
const MIGRATION_MIN_FREE_BYTES = 256 * 1024 * 1024;

export async function assertMigrationDiskHeadroom(config: Pick<Config, "databaseUrl">): Promise<void> {
  const disk = await getDbDiskUsage(config);
  if (!disk) return;
  if (disk.freeBytes < MIGRATION_MIN_FREE_BYTES) {
    throw new Error(
      `Refusing to migrate: only ${mib(disk.freeBytes)} MiB free on ${disk.path}, need at least ${mib(MIGRATION_MIN_FREE_BYTES)} MiB.`,
    );
  }
  if (disk.freeBytes < MIGRATION_WARN_FREE_BYTES) {
    logWarn("migration_disk_headroom_low", {
      path: disk.path,
      free_bytes: disk.freeBytes,
      used_pct: disk.usedPct,
      warn_free_bytes: MIGRATION_WARN_FREE_BYTES,
      min_free_bytes: MIGRATION_MIN_FREE_BYTES,
    });
  }
}

function mib(bytes: number): number {
  return Math.round(bytes / (1024 * 1024));
}

const BACKUPS_DIR_NAME = "backups";
// A directory walk is not free and the status body is rebuilt on every admin
// poll, so the walk is both bounded and memoised. The real layout is a handful
// of `backups/online-<stamp>/<file>` entries; the bounds only exist so a
// surprise (an unpruned tree, a work dir full of frames) cannot turn an admin
// page into a filesystem crawl.
const DIR_WALK_MAX_DEPTH = 3;
const DIR_WALK_MAX_ENTRIES = 2_000;
const DIR_SIZE_TTL_MS = 60_000;

const dirSizeCache = new Map<string, { at: number; bytes: number | null }>();

async function cachedDirSize(path: string): Promise<number | null> {
  const nowMs = Date.now();
  const cached = dirSizeCache.get(path);
  if (cached && nowMs - cached.at < DIR_SIZE_TTL_MS) return cached.bytes;
  const bytes = await dirSize(path);
  dirSizeCache.set(path, { at: nowMs, bytes });
  return bytes;
}

async function dirSize(root: string): Promise<number | null> {
  let total = 0;
  let seen = 0;
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (queue.length > 0 && seen < DIR_WALK_MAX_ENTRIES) {
    const next = queue.shift();
    if (!next) break;
    const entries = await readdir(next.dir, { withFileTypes: true }).catch(() => null);
    if (!entries) {
      // The root being unreadable means "there is nothing here", which is a
      // different answer from "there is nothing in it".
      if (next.dir === root) return null;
      continue;
    }
    for (const entry of entries) {
      if (seen >= DIR_WALK_MAX_ENTRIES) break;
      seen += 1;
      const child = join(next.dir, entry.name);
      if (entry.isDirectory()) {
        if (next.depth < DIR_WALK_MAX_DEPTH) queue.push({ dir: child, depth: next.depth + 1 });
      } else if (entry.isFile()) {
        total += (await fileSize(child)) ?? 0;
      }
    }
  }
  return total;
}

async function optionalFileSize(path: string | null): Promise<number | null> {
  return path ? fileSize(path) : null;
}

async function optionalDirSize(path: string | null): Promise<number | null> {
  return path ? cachedDirSize(path) : null;
}

export interface StorageBreakdown {
  tables: Array<{ name: string; bytes: number }>;
  tableBytes: number;
  fileBytes: number | null;
  walBytes: number | null;
  maxBytes: number;
  capturedAt: string;
}

export interface StorageBreakdownSnapshot {
  storage: StorageBreakdown | null;
  scanning: boolean;
  stale: boolean;
}

let storageBreakdownCache: { at: number; value: StorageBreakdown } | null = null;
let storageBreakdownInFlight: Promise<StorageBreakdown | null> | null = null;
const STORAGE_BREAKDOWN_TTL_MS = 30 * 60_000;
const STORAGE_BREAKDOWN_WAIT_MS = 2_500;

// Per-table storage from the dbstat virtual table (table b-tree + its indexes,
// aggregated by owning table). dbstat walks page metadata, so this is not free on
// a multi-GB file: it is admin-only, on-demand, and cached for a minute. Returns
// null if this libsql build lacks dbstat rather than throwing.
export async function getStorageBreakdown(
  db: Db,
  config: Pick<Config, "databaseUrl" | "maxLocalDbBytes">,
): Promise<StorageBreakdown | null> {
  const nowMs = Date.now();
  if (storageBreakdownCache && nowMs - storageBreakdownCache.at < STORAGE_BREAKDOWN_TTL_MS) {
    return storageBreakdownCache.value;
  }
  return getOrStartStorageBreakdownScan(db, config);
}

export async function getStorageBreakdownSnapshot(
  db: Db,
  config: Pick<Config, "databaseUrl" | "maxLocalDbBytes">,
): Promise<StorageBreakdownSnapshot> {
  const nowMs = Date.now();
  if (storageBreakdownCache && nowMs - storageBreakdownCache.at < STORAGE_BREAKDOWN_TTL_MS) {
    return { storage: storageBreakdownCache.value, scanning: false, stale: false };
  }

  const alreadyScanning = !!storageBreakdownInFlight;
  const scan = getOrStartStorageBreakdownScan(db, config);
  const result = await settleWithin(scan, alreadyScanning ? 250 : STORAGE_BREAKDOWN_WAIT_MS);
  if (result.settled) {
    return { storage: result.value, scanning: false, stale: false };
  }

  return {
    storage: storageBreakdownCache?.value ?? null,
    scanning: true,
    stale: !!storageBreakdownCache,
  };
}

function getOrStartStorageBreakdownScan(
  db: Db,
  config: Pick<Config, "databaseUrl" | "maxLocalDbBytes">,
): Promise<StorageBreakdown | null> {
  if (storageBreakdownInFlight) return storageBreakdownInFlight;
  storageBreakdownInFlight = scanStorageBreakdown(db, config).finally(() => {
    storageBreakdownInFlight = null;
  });
  return storageBreakdownInFlight;
}

// Generous: the chunked walk deliberately idles ~50% of the time, so a cold
// multi-GB scan can run for several minutes.
const STORAGE_SCAN_TIMEOUT_MS = 15 * 60_000;

// Runs the dbstat walk in a one-shot worker thread: local libsql executes
// synchronously on the calling thread, and walking every page of a multi-GB
// file from the serving event loop froze the whole site for its duration.
// Resolves the per-table sizes, or null when the thread ran but the scan
// failed (dbstat unavailable, crash, timeout). Rejects only when the thread
// itself cannot start — the compiled worker file is missing, i.e. vitest/dev —
// where an inline scan of a small local database is an acceptable substitute.
function scanTablesInThread(databaseUrl: string): Promise<Array<{ name: string; bytes: number }> | null> {
  return new Promise((resolvePromise, rejectPromise) => {
    const worker = new Worker(new URL("./storage-scan-worker.js", import.meta.url), {
      workerData: { databaseUrl },
    });
    // The thread must never keep an exiting process alive.
    worker.unref();
    let online = false;
    let settled = false;
    const settle = (value: Array<{ name: string; bytes: number }> | null, spawnError?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate().catch(() => undefined);
      if (spawnError !== undefined) rejectPromise(spawnError instanceof Error ? spawnError : new Error(String(spawnError)));
      else resolvePromise(value);
    };
    const timer = setTimeout(() => settle(null), STORAGE_SCAN_TIMEOUT_MS);
    timer.unref();
    worker.on("online", () => {
      online = true;
    });
    const startedAt = Date.now();
    worker.on("message", (result: { ok: boolean; tables?: Array<{ name: string; bytes: number }>; error?: string }) => {
      if (result.ok) logInfo("storage_scan_done", { tables: result.tables?.length ?? 0, duration_ms: Date.now() - startedAt });
      else logWarn("storage_scan_failed", { error: result.error, duration_ms: Date.now() - startedAt });
      settle(result.ok ? result.tables ?? null : null);
    });
    worker.on("error", (error) => {
      if (online) {
        logWarn("storage_scan_thread_error", errorContext(error));
        settle(null);
      } else {
        settle(null, error);
      }
    });
    worker.on("exit", () => settle(null));
  });
}

async function scanTablesInline(db: Db): Promise<Array<{ name: string; bytes: number }> | null> {
  try {
    const rows = (await exec(
      db,
      `select m.tbl_name as name, sum(d.pgsize) as bytes
       from dbstat d
       join sqlite_master m on m.name = d.name
       where m.type in ('table', 'index')
       group by m.tbl_name
       order by bytes desc`,
    )).rows;
    return rows.map((row) => ({ name: String(row.name), bytes: Number(row.bytes ?? 0) }));
  } catch {
    return null;
  }
}

async function scanStorageBreakdown(
  db: Db,
  config: Pick<Config, "databaseUrl" | "maxLocalDbBytes">,
): Promise<StorageBreakdown | null> {
  const nowMs = Date.now();
  let tables: Array<{ name: string; bytes: number }> | null = null;
  if (config.databaseUrl.startsWith("file:")) {
    if (import.meta.url.endsWith(".ts")) {
      tables = await scanTablesInline(db);
    } else {
      try {
        tables = await scanTablesInThread(config.databaseUrl);
      } catch {
        tables = await scanTablesInline(db);
      }
    }
  } else {
    // Remote databases execute asynchronously, so inline is already non-blocking.
    tables = await scanTablesInline(db);
  }
  if (!tables) return null;
  const tableBytes = tables.reduce((sum, table) => sum + table.bytes, 0);
  const filePath = localDbFilePath(config.databaseUrl);
  const [fileBytes, walBytes] = filePath
    ? await Promise.all([fileSize(filePath), fileSize(`${filePath}-wal`)])
    : [null, null];
  const value: StorageBreakdown = {
    tables,
    tableBytes,
    fileBytes,
    walBytes,
    maxBytes: config.maxLocalDbBytes,
    capturedAt: new Date(nowMs).toISOString(),
  };
  storageBreakdownCache = { at: nowMs, value };
  return value;
}

// -----------------------------------------------------------------------------
// Admin table browser: read one page of rows from any real table so the storage
// modal can drill from "this table is 768 MB" into "here is what a row actually
// looks like". Admin-only and strictly read-only. Table identifiers cannot be
// bound as SQL parameters, so the name is validated against sqlite_master (and
// shape-checked to a bare identifier) before it is ever interpolated.
// -----------------------------------------------------------------------------

export type TableCell = string | number | boolean | null;

export interface TablePreviewColumn {
  name: string;
  type: string;
}

export interface TablePreview {
  table: string;
  columns: TablePreviewColumn[];
  totalRows: number;
  limit: number;
  offset: number;
  rows: Array<Record<string, TableCell>>;
}

const TABLE_PREVIEW_MAX_LIMIT = 100;
// Longest cell handed back verbatim; longer strings (big JSON blobs) are clipped
// so a single fat row cannot balloon the response.
const TABLE_CELL_MAX_CHARS = 20_000;

async function tableExists(db: Db, table: string): Promise<boolean> {
  if (!/^[A-Za-z0-9_]+$/.test(table)) return false;
  const rows = (await exec(
    db,
    "select 1 from sqlite_master where type = 'table' and name = ? limit 1",
    [table],
  )).rows;
  return rows.length > 0;
}

export async function getTablePreview(
  db: Db,
  table: string,
  limit: number,
  offset: number,
  search = "",
): Promise<TablePreview | null> {
  if (!(await tableExists(db, table))) return null;
  const safeLimit = Math.min(Math.max(Math.trunc(limit) || 25, 1), TABLE_PREVIEW_MAX_LIMIT);
  const safeOffset = Math.max(Math.trunc(offset) || 0, 0);
  // `table` is now a validated bare identifier; quote it defensively anyway.
  const quoted = `"${table}"`;
  const columns: TablePreviewColumn[] = (await exec(db, `pragma table_info(${quoted})`)).rows.map((row) => ({
    name: String(row.name),
    type: String(row.type ?? "").toUpperCase(),
  }));
  const { where, args } = buildTableSearch(columns, search);
  const totalRows = Number((await exec(db, `select count(*) as n from ${quoted} ${where}`, args)).rows[0]?.n ?? 0);
  // Newest first: every table here carries a rowid, and ORDER BY rowid is
  // index-free and cheap even on the multi-GB tables.
  const result = await exec(
    db,
    `select * from ${quoted} ${where} order by rowid desc limit ? offset ?`,
    [...args, safeLimit, safeOffset],
  );
  const rows = result.rows.map((row) => {
    const record: Record<string, TableCell> = {};
    for (const col of columns) {
      record[col.name] = normalizeCell((row as Record<string, unknown>)[col.name]);
    }
    return record;
  });
  return { table, columns, totalRows, limit: safeLimit, offset: safeOffset, rows };
}

// Free-text search over a table: substring-match every short text column (LIKE),
// and exact-match id columns when the query is a number, so "jaza77" and a raw
// user id both work. Big *_json blob columns are skipped so we never scan the
// multi-GB payloads. Returns `where 0` (no matches) when a query targets nothing
// searchable, so a search never silently falls back to "all rows".
function buildTableSearch(columns: TablePreviewColumn[], search: string): { where: string; args: (string | number)[] } {
  const query = search.trim();
  if (!query) return { where: "", args: [] };
  const conditions: string[] = [];
  const args: (string | number)[] = [];
  const like = `%${query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
  for (const col of columns) {
    const isTextish = col.type === "" || /TEXT|CHAR|CLOB/.test(col.type);
    if (isTextish && !col.name.endsWith("_json")) {
      conditions.push(`"${col.name}" like ? escape '\\'`);
      args.push(like);
    }
  }
  if (/^\d+$/.test(query)) {
    const asInt = Number(query);
    if (Number.isSafeInteger(asInt)) {
      for (const col of columns) {
        if (col.type.includes("INT") && (col.name === "id" || col.name.endsWith("_id"))) {
          conditions.push(`"${col.name}" = ?`);
          args.push(asInt);
        }
      }
    }
  }
  if (conditions.length === 0) return { where: "where 0", args: [] };
  return { where: `where (${conditions.join(" or ")})`, args };
}

function normalizeCell(value: unknown): TableCell {
  if (value == null) return null;
  if (typeof value === "string") {
    return value.length > TABLE_CELL_MAX_CHARS
      ? `${value.slice(0, TABLE_CELL_MAX_CHARS)}... (+${value.length - TABLE_CELL_MAX_CHARS} more chars)`
      : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  if (value instanceof Uint8Array) return `<blob: ${value.byteLength} bytes>`;
  return String(value);
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<{ settled: true; value: T } | { settled: false }> {
  let timeout: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise.then((value) => ({ settled: true as const, value })),
      new Promise<{ settled: false }>((resolve) => {
        timeout = setTimeout(() => resolve({ settled: false }), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function pruneForLocalDbLimit(db: Db, config: Pick<Config, "targetLocalDbBytes">, storage: LocalDbStorage): Promise<Record<string, number>> {
  const deleted: Record<string, number> = {};
  let currentBytes = (storage.bytes ?? 0) + (storage.walBytes ?? 0);
  const prunePlan = [
    ["api_call_log", "started_at"],
    ["live_event_log", "created_at"],
    ["score_events", "received_at"],
    ["country_rank_snapshots", "captured_at"],
    ["jobs", "updated_at", "status in ('done', 'failed')"],
    ["replay_video_exports", "updated_at", "status in ('done', 'failed', 'cancelled')"],
  ] as const;

  for (const [table, column, extraWhere] of prunePlan) {
    while (currentBytes > config.targetLocalDbBytes) {
      const result = await exec(
        db,
        `delete from ${table}
         where rowid in (
           select rowid from ${table}
           ${extraWhere ? `where ${extraWhere}` : ""}
           order by ${column} asc
           limit 5000
         )`,
      );
      const rows = Number(result.rowsAffected ?? 0);
      if (rows === 0) break;
      deleted[`emergency_${table}`] = (deleted[`emergency_${table}`] ?? 0) + rows;
      await checkpointLocalDb(db, "TRUNCATE");
      const updated = await getApproxLocalDbBytes(storage.filePath);
      if (updated == null) break;
      currentBytes = updated;
    }
  }

  return deleted;
}

async function getApproxLocalDbBytes(filePath: string | null): Promise<number | null> {
  if (!filePath) return null;
  const [bytes, walBytes] = await Promise.all([fileSize(filePath), fileSize(`${filePath}-wal`)]);
  return (bytes ?? 0) + (walBytes ?? 0);
}

// PASSIVE checkpoints whatever it can without waiting on active readers, so it
// never stalls the event loop; TRUNCATE blocks until it can reclaim the whole
// WAL file and is reserved for the emergency over-limit prune where freeing
// disk space is the point.
async function checkpointLocalDb(db: Db, mode: "PASSIVE" | "TRUNCATE" = "PASSIVE"): Promise<void> {
  await exec(db, `pragma wal_checkpoint(${mode})`).catch(() => undefined);
}

// Optional config slices reach here with the URL missing, so an absent value is
// treated the same as a non-local database: there is no file to measure.
function localDbFilePath(databaseUrl: string | undefined): string | null {
  if (!databaseUrl?.startsWith("file:")) return null;
  const rawPath = databaseUrl.slice("file:".length);
  if (!rawPath || rawPath === ":memory:") return null;
  return resolve(rawPath);
}

async function fileSize(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch {
    return null;
  }
}
