import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { exec } from "./db.js";
import { logInfo } from "./logger.js";

export async function runRetention(db: Db, config: Pick<Config, "scoreEventRetentionDays" | "liveEventRetentionDays" | "doneJobRetentionDays" | "apiCallLogRetentionDays" | "replayVideoJobRetentionDays" | "replayVideoWorkDir">): Promise<Record<string, number>> {
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
