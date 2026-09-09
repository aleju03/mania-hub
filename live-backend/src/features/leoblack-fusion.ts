import { readConfig } from "../config.js";
import { exec, json, type Db } from "../db.js";
import type { JobQueue } from "../jobs/queue.js";
import { logInfo } from "../logger.js";
import { readCachedBeatmapFile } from "../osu/beatmap-file-cache.js";
import { nowIso } from "../shared/score.js";
import { CHART_ANALYSIS_VERSION, computeBeatmapChartAnalysis, storeDtRateVerdict, storeHtRateVerdict } from "./chart-analysis.js";
import { computeAndStoreRateDanVerdictFromText } from "./dan-estimates.js";

export const LEOBLACK_FUSION_JOB = "recompute_leoblack_fusion_sweep";
export const LEOBLACK_FUSION_META_KEY = "leoblack_fusion_done:v1";
const CHUNK = 10;

// September 2026: Mixed's new fusion can move 4K RC/Mix charts with at most
// 18% holds and Sunny < 9. Rate columns have no Sunny SR, so include every
// stored rate on that LN/keymode slice: an HT chart can cross below 9 even
// when its normal-speed rating cannot. Keep serving rows during the repair.
export async function recomputeLeoblackFusionChunk(
  db: Db,
  cursor: number,
  options: { limit?: number; interMapPauseMs?: number } = {},
): Promise<{ nextCursor: number; scanned: number; rewritten: number; done: boolean }> {
  const limit = Math.max(1, Math.floor(options.limit ?? CHUNK));
  // Bound the primary-key walk before testing eligibility. Filtering on
  // status first made SQLite scan/sort the whole ready corpus for every ten
  // repairs; on production that blocked ingest for ~16 seconds per chunk.
  const page = (await exec(db, `
    select a.beatmap_id, a.status, a.key_count,
           json_extract(a.classification_json, '$.lnRatio') as ln_ratio,
           a.msd_dt_json is not null as has_dt,
           a.msd_ht_json is not null as has_ht,
           json_extract(a.classification_json, '$.sunnySr') < 9 as refresh_base
    from beatmap_chart_analysis a
    where a.analysis_version = ? and a.beatmap_id > ?
    order by a.beatmap_id limit ?`,
  [CHART_ANALYSIS_VERSION, Math.max(0, Math.floor(cursor)), limit])).rows;
  let nextCursor = cursor;
  let rewritten = 0;
  let scanned = 0;
  for (const row of page) {
    const beatmapId = Number(row.beatmap_id);
    nextCursor = beatmapId;
    if (row.status !== "ready" || Number(row.key_count) !== 4
      || row.ln_ratio == null || Number(row.ln_ratio) > 0.18) continue;
    const rates = (await exec(db,
      "select distinct rate_percent from dan_estimates where beatmap_id = ? order by rate_percent",
      [beatmapId])).rows;
    if (!Number(row.refresh_base) && !Number(row.has_dt) && !Number(row.has_ht) && rates.length === 0) continue;
    scanned += 1;
    const osuText = await readCachedBeatmapFile(db, beatmapId);
    if (osuText) {
      try {
        if (Number(row.refresh_base)) {
          // The adapter is cache-only even if a concurrent retention pass
          // removes the file between this read and the analyzer's own read.
          await computeBeatmapChartAnalysis(db, { getBeatmapFile: async () => osuText }, { beatmapId });
        }
        if (Number(row.has_dt) && !await storeDtRateVerdict(db, beatmapId)) {
          throw new Error(`LeoBlack fusion DT repair failed for ${beatmapId}`);
        }
        if (Number(row.has_ht) && !await storeHtRateVerdict(db, beatmapId)) {
          throw new Error(`LeoBlack fusion HT repair failed for ${beatmapId}`);
        }
        for (const rate of rates) {
          await computeAndStoreRateDanVerdictFromText(db, beatmapId, Number(rate.rate_percent), osuText);
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        rewritten += 1;
      } catch (error) {
        // A transient worker failure must not hide a previously usable chart
        // or advance the durable cursor past its stale verdicts.
        await exec(db, `update beatmap_chart_analysis set status = 'ready'
          where beatmap_id = ? and analysis_version = ? and status = 'failed'`,
        [beatmapId, CHART_ANALYSIS_VERSION]);
        throw error;
      }
    }
    const pauseMs = Math.max(0, options.interMapPauseMs ?? 0);
    if (pauseMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, pauseMs));
    else await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return { nextCursor, scanned, rewritten, done: page.length < limit };
}

export async function ensureLeoblackFusionSeeded(db: Db, queue: JobQueue): Promise<void> {
  if ((await exec(db, "select 1 from live_meta where key = ?", [LEOBLACK_FUSION_META_KEY])).rows.length) return;
  const pending = (await exec(db,
    "select 1 from jobs where type = ? and status in ('queued', 'running', 'failed', 'deferred_pressure') limit 1",
    [LEOBLACK_FUSION_JOB])).rows.length;
  if (!pending) await enqueueFusion(queue, 0);
}

export async function runLeoblackFusionJob(db: Db, queue: JobQueue, payload: { cursor?: number } | undefined): Promise<void> {
  const cursor = Math.max(0, Math.floor(Number(payload?.cursor ?? 0)));
  if (cursor === 0) {
    // The combined v15 -> v16 rollout changes 4K rice/low-LN charts.
    // Preserve valid rate evidence
    // elsewhere instead of making the player-dan fold drop it until a visit
    // causes a lazy recompute. Never promote older, already-stale versions or
    // replace a v16 value computed since deployment (the composite PK wins).
    await exec(db, `update or ignore dan_estimates set estimator_version = 16
      where estimator_version = 15 and beatmap_id in (
        select beatmap_id from beatmap_chart_analysis
        where analysis_version = ? and status = 'ready'
          and (key_count != 4 or json_extract(classification_json, '$.lnRatio') > 0.18)
      )`, [CHART_ANALYSIS_VERSION]);
    // The only supported chart-rewriting mod is 7K Invert; this 4K-only
    // estimator change cannot move its result at any rate.
    await exec(db, `update or ignore dan_mod_estimates set estimator_version = 16
      where estimator_version = 15 and mod_variant = 'IN' and beatmap_id in (
        select beatmap_id from beatmap_chart_analysis
        where analysis_version = ? and status = 'ready' and key_count = 7
      )`, [CHART_ANALYSIS_VERSION]);
  }
  const result = await recomputeLeoblackFusionChunk(db, cursor, {
    interMapPauseMs: readConfig().role === "worker" ? 25 : 100,
  });
  logInfo("leoblack_fusion_sweep_chunk", { ...result });
  if (!result.done) {
    await enqueueFusion(queue, result.nextCursor);
    return;
  }
  const now = nowIso();
  await exec(db, "insert or replace into live_meta (key, value_json, updated_at) values (?, ?, ?)",
    [LEOBLACK_FUSION_META_KEY, json({ finishedAt: now }), now]);
  await queue.enqueue("rebuild_map_collections", "rebuild_map_collections", {}, { priority: -12, replaceDone: true });
  const { ensurePlayerSkillDanSweepSeeded } = await import("./player-skills.js");
  await ensurePlayerSkillDanSweepSeeded(db, queue);
}

async function enqueueFusion(queue: JobQueue, cursor: number): Promise<void> {
  await queue.enqueue(LEOBLACK_FUSION_JOB, `${LEOBLACK_FUSION_JOB}:${cursor}`, { cursor },
    { priority: -10, replaceDone: true });
}
