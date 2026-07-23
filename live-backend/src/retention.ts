import { stat, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { Worker } from "node:worker_threads";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { exec } from "./db.js";
import { pruneAvatarAccents } from "./features/avatar-accents.js";
import { pruneOsuProxyCache } from "./features/osu-proxy-cache.js";
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
  const replayVideoCutoff = daysAgo(config.replayVideoJobRetentionDays);
  const rankSnapshotCutoff = daysAgo(config.rankSnapshotRetentionDays);
  const activityCutoffDay = activityRetentionCutoffDay(config.activityRetentionYears);
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
  const results = {
    skinsPendingExpired,
    scoreEvents: Number((await exec(db, "delete from score_events where received_at < ?", [scoreCutoff])).rowsAffected ?? 0),
    liveEvents: Number((await exec(db, "delete from live_event_log where created_at < ?", [liveCutoff])).rowsAffected ?? 0),
    doneJobs: Number((await exec(db, "delete from jobs where status = 'done' and updated_at < ?", [doneJobCutoff])).rowsAffected ?? 0),
    apiCalls: Number((await exec(db, "delete from api_call_log where started_at < ?", [apiCutoff])).rowsAffected ?? 0),
    replayVideoJobs: Number((await exec(db, "delete from replay_video_exports where status in ('done', 'failed', 'cancelled') and updated_at < ?", [replayVideoCutoff])).rowsAffected ?? 0),
    rankSnapshots: Number((await exec(db, "delete from country_rank_snapshots where captured_at < ?", [rankSnapshotCutoff])).rowsAffected ?? 0),
    activityScoreRefs: Number((await exec(db, "delete from player_activity_score_refs where day < ?", [activityCutoffDay])).rowsAffected ?? 0),
    activityMaps: Number((await exec(db, "delete from player_activity_maps where day < ?", [activityCutoffDay])).rowsAffected ?? 0),
    activityDays: Number((await exec(db, "delete from player_activity_days where day < ?", [activityCutoffDay])).rowsAffected ?? 0),
    // Discord "last map in channel" memory is only useful while fresh, so 30d is
    // plenty; stale rows just mean /pb asks the user to run /recent again.
    discordChannelContext: Number((await exec(db, "delete from discord_channel_map_context where updated_at < ?", [daysAgo(30)])).rowsAffected ?? 0),
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
  logInfo("retention_complete", results);
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

function localDbFilePath(databaseUrl: string): string | null {
  if (!databaseUrl.startsWith("file:")) return null;
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
