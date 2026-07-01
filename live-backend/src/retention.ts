import { stat, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { exec } from "./db.js";
import { logInfo } from "./logger.js";

export interface LocalDbStorage {
  filePath: string | null;
  bytes: number | null;
  walBytes: number | null;
  maxBytes: number;
  targetBytes: number;
  overLimit: boolean;
}

export async function runRetention(db: Db, config: Pick<Config, "databaseUrl" | "scoreEventRetentionDays" | "liveEventRetentionDays" | "doneJobRetentionDays" | "apiCallLogRetentionDays" | "replayVideoJobRetentionDays" | "rankSnapshotRetentionDays" | "activityRetentionYears" | "replayVideoWorkDir" | "maxLocalDbBytes" | "targetLocalDbBytes">): Promise<Record<string, number>> {
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
  const results = {
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
  };
  const storageBefore = await getLocalDbStorage(config);
  const emergency = storageBefore.overLimit ? await pruneForLocalDbLimit(db, config, storageBefore) : {};
  if (storageBefore.bytes != null) await checkpointLocalDb(db);
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

let storageBreakdownCache: { at: number; value: StorageBreakdown } | null = null;
const STORAGE_BREAKDOWN_TTL_MS = 60_000;

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
  let rows;
  try {
    rows = (await exec(
      db,
      `select m.tbl_name as name, sum(d.pgsize) as bytes
       from dbstat d
       join sqlite_master m on m.name = d.name
       where m.type in ('table', 'index')
       group by m.tbl_name
       order by bytes desc`,
    )).rows;
  } catch {
    return null;
  }
  const tables = rows.map((row) => ({ name: String(row.name), bytes: Number(row.bytes ?? 0) }));
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
