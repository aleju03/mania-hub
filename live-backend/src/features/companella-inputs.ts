import { readConfig } from "../config.js";
import { exec, json, parseJson, type Db } from "../db.js";
import { parseManiaBeatmap } from "../dan/beatmap-parser.js";
import { classifyChartWithCompanella } from "../dan/companella.js";
import type { MsdResult } from "../dan/msd.js";
import type { JobQueue } from "../jobs/queue.js";
import { logInfo } from "../logger.js";
import { readCachedBeatmapFile } from "../osu/beatmap-file-cache.js";
import { nowIso } from "../shared/score.js";
import { CHART_ANALYSIS_VERSION, leanClassification } from "./chart-analysis.js";
import { computeAndStoreRateDanVerdictFromText, parseStoredDanVariant } from "./dan-estimates.js";

export const COMPANELLA_INPUTS_JOB = "recompute_companella_inputs_sweep";
export const COMPANELLA_INPUTS_META_KEY = "companella_inputs_done:v1";
// Freeze this migration's promotion boundary. Older estimates must not be
// blessed past unrelated model changes, nor replace already-corrected rows.
const TARGET_VERSION = 30;
// dan_mod_estimates is indexed by (version, beatmap, ...), not beatmap alone.
const RATE_VERSIONS_SQL = Array.from({ length: TARGET_VERSION }, (_, i) => i + 1).join(",");

/** Repair cached 4K verdicts, keeping native MSD/SSR and analysis readable.
 * Page the file PK first, including maps with only custom/OD rate estimates.
 * Missing files retain stale serving fallbacks for normal on-demand recovery. */
export async function recomputeCompanellaInputsChunk(
  db: Db,
  cursor: number,
  options: { limit?: number; maxRepairs?: number; interMapPauseMs?: number } = {},
): Promise<{ nextCursor: number; scanned: number; rewritten: number; ratesRewritten: number; missingFiles: number; done: boolean }> {
  const limit = Math.max(1, Math.floor(options.limit ?? 200));
  const page = (await exec(db, `
    with page as (
      select beatmap_id from beatmap_osu_files where beatmap_id > ? order by beatmap_id limit ?
    )
    select p.beatmap_id, a.status, coalesce(a.key_count, b.cs) as key_count,
      a.classification_json, a.msd_json, a.msd_dt_json, a.dan_dt_json, a.msd_ht_json, a.dan_ht_json,
      b.difficulty_rating
    from page p
    left join beatmap_chart_analysis a on a.beatmap_id = p.beatmap_id and a.analysis_version = ?
    left join beatmaps b on b.beatmap_id = p.beatmap_id
    order by p.beatmap_id`, [Math.max(0, Math.floor(cursor)), limit, CHART_ANALYSIS_VERSION])).rows;
  const result = { nextCursor: cursor, scanned: 0, rewritten: 0, ratesRewritten: 0, missingFiles: 0, done: false };
  let repairs = 0;
  for (const row of page) {
    const beatmapId = Number(row.beatmap_id);
    result.nextCursor = beatmapId;
    result.scanned += 1;
    if (row.key_count != null && Number(row.key_count) !== 4) {
      for (const table of ["dan_estimates", "dan_mod_estimates"]) {
        await exec(db, `update or ignore ${table} set estimator_version = ?
          where beatmap_id = ? and estimator_version = ? and status in ('ready', 'unsupported', 'unavailable')`,
        [TARGET_VERSION, beatmapId, TARGET_VERSION - 1]);
      }
      continue;
    }
    const rates = (await exec(db, `
      select rate_percent, estimator_version, status, null as mod_variant from dan_estimates
        where beatmap_id = ? and estimator_version in (${RATE_VERSIONS_SQL})
      union all
      select rate_percent, estimator_version, status, mod_variant from dan_mod_estimates
        where beatmap_id = ? and estimator_version in (${RATE_VERSIONS_SQL})
      order by rate_percent, estimator_version desc`, [beatmapId, beatmapId])).rows;
    if (row.status !== "ready" && rates.length === 0) continue;
    const osuText = await readCachedBeatmapFile(db, beatmapId, { touch: false });
    if (!osuText) { result.missingFiles += 1; continue; }
    const map = parseManiaBeatmap(osuText);
    if (map.keyCount !== 4) continue;
    repairs += 1;
    for (const [ratePercent, msdColumn, verdictColumn] of [
      [100, "msd_json", "classification_json"],
      [150, "msd_dt_json", "dan_dt_json"],
      [75, "msd_ht_json", "dan_ht_json"],
    ] as const) {
      if (row.status !== "ready" || (ratePercent !== 100 && row[msdColumn] == null && row[verdictColumn] == null)) continue;
      const msd = parseJson<MsdResult | null>(row[msdColumn], null);
      const classification = await classifyChartWithCompanella(map, osuText, {
        rate: ratePercent / 100, version: map.version, starRating: Number(row.difficulty_rating) || undefined,
      }, { msdValues: msd?.values });
      if (classification.companellaPending) {
        throw new Error(`Companella input repair incomplete for ${beatmapId}@${ratePercent}`);
      }
      // No verdict to repair: LeoBlack refuses the chart (a one-note
      // placeholder diff, say). The stored row already says unsupported;
      // failing the chunk here pinned the whole sweep on one such map.
      if (!classification.primary) continue;
      const lean = leanClassification(classification);
      const primary = lean.primary!;
      const previous = parseJson<Record<string, unknown>>(row[verdictColumn], {});
      const patched = ratePercent === 100
        ? { ...previous, sunnySr: lean.sunnySr, verdictText: lean.verdictText,
          rc: lean.rc, ln: lean.ln, primary, warnings: lean.warnings }
        : { ...previous, primaryLabel: primary.displayName, primaryFamily: primary.kind === "ln" ? "ln" : "dan",
          rawDan: primary.rawDan };
      if (json(patched) !== json(previous)) {
        const written = ratePercent === 100
          ? await exec(db, `update beatmap_chart_analysis set classification_json = ?, primary_label = ?,
              primary_family = ?, raw_dan = ?, updated_at = ? where beatmap_id = ? and analysis_version = ?
              and status = 'ready' and classification_json is ? and msd_json is ?`,
            [json(patched), primary.displayName, primary.kind === "ln" ? "ln" : "dan", primary.rawDan,
              nowIso(), beatmapId, CHART_ANALYSIS_VERSION, row.classification_json, row.msd_json])
          : await exec(db, `update beatmap_chart_analysis set ${verdictColumn} = ?
              where beatmap_id = ? and analysis_version = ? and ${verdictColumn} is ? and ${msdColumn} is ?`,
            [json(patched), beatmapId, CHART_ANALYSIS_VERSION, row[verdictColumn], row[msdColumn]]);
        if (!written.rowsAffected) throw new Error(`Chart ${beatmapId}@${ratePercent} changed during Companella repair`);
        if (ratePercent === 100) {
          await import("./map-search.js").then((module) => module.upsertMapSearchIndexRow(db, beatmapId));
          result.rewritten += 1;
        } else result.ratesRewritten += 1;
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const seen = new Set<string>();
    for (const rate of rates) {
      const key = `${rate.rate_percent}:${rate.mod_variant ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (Number(rate.estimator_version) >= TARGET_VERSION
        && ["ready", "unsupported", "unavailable"].includes(String(rate.status))) continue;
      const variant = rate.mod_variant == null ? {} : parseStoredDanVariant(rate.mod_variant);
      if (!variant) continue;
      await computeAndStoreRateDanVerdictFromText(db, beatmapId, Number(rate.rate_percent), osuText,
        variant.modVariant, { odFlag: variant.odFlag, requireComplete: true });
      result.ratesRewritten += 1;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const pause = Math.max(0, options.interMapPauseMs ?? 0);
    await new Promise<void>((resolve) => pause ? setTimeout(resolve, pause) : setImmediate(resolve));
    if (repairs >= (options.maxRepairs ?? 10)) break;
  }
  result.done = result.scanned === page.length && page.length < limit;
  return result;
}

export async function ensureCompanellaInputsSeeded(db: Db, queue: JobQueue): Promise<void> {
  if ((await exec(db, "select 1 from live_meta where key = ?", [COMPANELLA_INPUTS_META_KEY])).rows.length) return;
  if ((await exec(db, "select 1 from jobs where type = ? and status in ('queued', 'running', 'failed', 'deferred_pressure') limit 1",
    [COMPANELLA_INPUTS_JOB])).rows.length) return;
  await enqueue(queue, 0);
}

export async function runCompanellaInputsJob(db: Db, queue: JobQueue, payload?: { cursor?: number }): Promise<void> {
  const result = await recomputeCompanellaInputsChunk(db, Math.max(0, Math.floor(Number(payload?.cursor ?? 0))), {
    interMapPauseMs: readConfig().role === "worker" ? 25 : 100,
  });
  logInfo("companella_inputs_sweep_chunk", result);
  if (!result.done) { await enqueue(queue, result.nextCursor); return; }
  await queue.enqueue("rebuild_map_collections", "rebuild_map_collections", {}, { priority: -12, replaceDone: true });
  const now = nowIso();
  await exec(db, "insert or replace into live_meta (key, value_json, updated_at) values (?, ?, ?)",
    [COMPANELLA_INPUTS_META_KEY, json({ finishedAt: now, estimatorVersion: TARGET_VERSION }), now]);
  const { ensurePlayerSkillDanSweepSeeded } = await import("./player-skills.js");
  await ensurePlayerSkillDanSweepSeeded(db, queue);
}

async function enqueue(queue: JobQueue, cursor: number): Promise<void> {
  await queue.enqueue(COMPANELLA_INPUTS_JOB, `${COMPANELLA_INPUTS_JOB}:${cursor}`, { cursor },
    { priority: -10, replaceDone: true });
}
