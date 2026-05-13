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

export async function runRetention(db: Db, config: Pick<Config, "databaseUrl" | "scoreEventRetentionDays" | "liveEventRetentionDays" | "doneJobRetentionDays" | "apiCallLogRetentionDays" | "replayVideoJobRetentionDays" | "replayVideoWorkDir" | "maxLocalDbBytes" | "targetLocalDbBytes">): Promise<Record<string, number>> {
  const scoreCutoff = daysAgo(config.scoreEventRetentionDays);
  const liveCutoff = daysAgo(config.liveEventRetentionDays);
  const doneJobCutoff = daysAgo(config.doneJobRetentionDays);
  const apiCutoff = daysAgo(config.apiCallLogRetentionDays);
  const replayVideoCutoff = daysAgo(config.replayVideoJobRetentionDays);
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

async function pruneForLocalDbLimit(db: Db, config: Pick<Config, "targetLocalDbBytes">, storage: LocalDbStorage): Promise<Record<string, number>> {
  const deleted: Record<string, number> = {};
  let currentBytes = (storage.bytes ?? 0) + (storage.walBytes ?? 0);
  const prunePlan = [
    ["api_call_log", "started_at"],
    ["live_event_log", "created_at"],
    ["score_events", "received_at"],
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
      await checkpointLocalDb(db);
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

async function checkpointLocalDb(db: Db): Promise<void> {
  await exec(db, "pragma wal_checkpoint(TRUNCATE)").catch(() => undefined);
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
