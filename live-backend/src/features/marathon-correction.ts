import { readConfig } from "../config.js";
import { exec, json, parseJson, type Db } from "../db.js";
import { parseManiaBeatmap } from "../dan/beatmap-parser.js";
import { chartNoteSpanSeconds, isMarathonCorrectionCandidate } from "../dan/chart-classifier.js";
import { classifyChartWithCompanella } from "../dan/companella.js";
import { computeMsd, msdChartErrorFallback, type MsdResult } from "../dan/msd.js";
import { DAN_ESTIMATE_CACHE_VERSION } from "../dan/dan-estimator/cache-version.js";
import { computeMarathonCorrection } from "../../vendor/leoblack/estimator/marathonCorrection.js";
import type { JobQueue } from "../jobs/queue.js";
import { logInfo } from "../logger.js";
import { readCachedBeatmapFile } from "../osu/beatmap-file-cache.js";
import { nowIso } from "../shared/score.js";
import { CHART_ANALYSIS_VERSION, leanClassification } from "./chart-analysis.js";
import { computeAndStoreRateDanVerdictFromText, VIBRO_ADJUSTED_VARIANT } from "./dan-estimates.js";

export const MARATHON_CORRECTION_JOB = "recompute_marathon_correction_sweep";
export const MARATHON_CORRECTION_META_KEY = "marathon_correction_done:v1";
const PAGE_SIZE = 200;
const REPAIRS_PER_CHUNK = 10;
// Freeze the migration's versions; a future cache bump must not promote an
// older verdict past whatever change that later version introduced.
const PREVIOUS_VERSION = 19;
const TARGET_VERSION = 20;
const RATE_VERSIONS_SQL = Array.from({ length: TARGET_VERSION }, (_, i) => i + 1).join(",");

function cachedMsd(value: unknown): MsdResult | null {
  const msd = parseJson<MsdResult | null>(value, null);
  return msd?.values && ["Overall", "Stream", "Jumpstream", "Handstream", "Stamina", "JackSpeed", "Chordjack", "Technical"]
    .every((key) => Number.isFinite(msd.values[key])) ? msd : null;
}

interface MarathonChunkResult {
  nextCursor: number;
  scanned: number;
  candidates: number;
  rewritten: number;
  ratesRewritten: number;
  missingFiles: number;
  done: boolean;
}

/** Cheap bounded metadata pages; only long 4K charts enter the classifier.
 * Includes rate-only cached charts as well as the main analysis projection. */
export async function recomputeMarathonCorrectionChunk(
  db: Db,
  cursor: number,
  options: { limit?: number; maxRepairs?: number; interMapPauseMs?: number; dryRun?: boolean } = {},
): Promise<MarathonChunkResult> {
  const limit = Math.max(1, Math.floor(options.limit ?? PAGE_SIZE));
  const page = (await exec(db, `
    with page as (
      select beatmap_id from beatmap_osu_files where beatmap_id > ? order by beatmap_id limit ?
    )
    select p.beatmap_id, a.status, coalesce(a.key_count, b.cs) as key_count,
      a.classification_json, a.msd_json, a.msd_dt_json, a.dan_dt_json, a.msd_ht_json, a.dan_ht_json,
      b.difficulty_rating, json_extract(b.metadata_json, '$.total_length') as total_length
    from page p
    left join beatmap_chart_analysis a on a.beatmap_id = p.beatmap_id and a.analysis_version = ?
    left join beatmaps b on b.beatmap_id = p.beatmap_id
    order by p.beatmap_id`, [Math.max(0, Math.floor(cursor)), limit, CHART_ANALYSIS_VERSION])).rows;
  const result: MarathonChunkResult = {
    nextCursor: cursor, scanned: 0, candidates: 0, rewritten: 0, ratesRewritten: 0, missingFiles: 0, done: false,
  };
  const unaffected: number[] = [];
  for (const row of page) {
    const beatmapId = Number(row.beatmap_id);
    result.nextCursor = beatmapId;
    result.scanned += 1;
    // API length is an upper bound on the note-start span. Keep integer 300
    // and missing metadata in the exact-file check to avoid rounding edges.
    if ((row.key_count != null && Number(row.key_count) !== 4)
      || (row.total_length != null && Number(row.total_length) < 300)) {
      unaffected.push(beatmapId);
      continue;
    }
    const rates = (await exec(db, `
      select rate_percent, estimator_version, status, msd_json, null as mod_variant from dan_estimates
        where beatmap_id = ? and estimator_version <= ?
      union all
      select rate_percent, estimator_version, status, msd_json, mod_variant from dan_mod_estimates
        where estimator_version in (${RATE_VERSIONS_SQL}) and beatmap_id = ? and mod_variant = ?
      order by rate_percent, estimator_version desc`,
    [beatmapId, TARGET_VERSION, beatmapId, VIBRO_ADJUSTED_VARIANT])).rows;
    if (row.status !== "ready" && rates.length === 0) continue;
    const osuText = await readCachedBeatmapFile(db, beatmapId, { touch: false });
    if (!osuText) { result.missingFiles += 1; continue; }
    const map = parseManiaBeatmap(osuText);
    if (!isMarathonCorrectionCandidate(map)) { unaffected.push(beatmapId); continue; }
    result.candidates += 1;
    if (!options.dryRun) {
      const durationS = chartNoteSpanSeconds(map);
      const starRating = Number(row.difficulty_rating) || undefined;
      const msds = new Map<number, MsdResult>();
      for (const [rate, raw] of [[100, row.msd_json], [150, row.msd_dt_json], [75, row.msd_ht_json]] as const) {
        const msd = cachedMsd(raw);
        if (msd) msds.set(rate, msd);
      }
      const getMsd = async (ratePercent: number, adjusted = false, stored: unknown = null): Promise<MsdResult> => {
        const cached = cachedMsd(stored);
        if (cached && (!adjusted || cached.vibroAdjusted === true)) return cached;
        if (!adjusted && msds.has(ratePercent)) return msds.get(ratePercent)!;
        const msd = await computeMsd(osuText, { keyCount: 4, rate: ratePercent / 100, adjustVibro: adjusted })
          .catch(msdChartErrorFallback);
        if (!msd) throw new Error(`Marathon repair could not calculate MSD for ${beatmapId}@${ratePercent}`);
        if (!adjusted) msds.set(ratePercent, msd);
        return msd;
      };
      // Test skill balance per rate. Do not screen on the stored final dan:
      // even a tapered-out Roxy verdict can move through its Azusa reference.
      const balanced = (msd: MsdResult) => computeMarathonCorrection({ durationS, ettValues: msd.values, numeric: 0 }) > 0;
      for (const ratePercent of [100, 150, 75]) {
        if (row.status !== "ready") continue;
        if (ratePercent === 150 && row.msd_dt_json == null && row.dan_dt_json == null) continue;
        if (ratePercent === 75 && row.msd_ht_json == null && row.dan_ht_json == null) continue;
        const msd = await getMsd(ratePercent);
        if (!balanced(msd)) continue;
        const classification = await classifyChartWithCompanella(map, osuText, {
          rate: ratePercent / 100, starRating, version: map.version, totalLength: map.totalLength / 1000,
        }, { msdValues: msd.values });
        if (!classification.supported || !classification.primary || classification.companellaPending) {
          throw new Error(`Marathon repair could not classify ${beatmapId}@${ratePercent}`);
        }
        const lean = leanClassification(classification);
        if (ratePercent === 100) {
          // Preserve patterns, motion, jack demand, tail MSD and the original
          // full-analysis timestamp. This rollout changes only the verdict.
          const old = parseJson<Record<string, unknown>>(row.classification_json, {});
          const patched = { ...old, sunnySr: lean.sunnySr, verdictText: lean.verdictText,
            rc: lean.rc, ln: lean.ln, primary: lean.primary, warnings: lean.warnings };
          if (json(patched) !== json(old)) {
            const written = await exec(db, `update beatmap_chart_analysis set classification_json = ?, primary_label = ?,
              primary_family = ?, raw_dan = ?, updated_at = ? where beatmap_id = ? and analysis_version = ?
              and status = 'ready' and classification_json is ? and msd_json is ?`,
            [json(patched), lean.primary!.displayName, lean.primary!.kind === "ln" ? "ln" : "dan",
              lean.primary!.rawDan, nowIso(), beatmapId, CHART_ANALYSIS_VERSION, row.classification_json, row.msd_json]);
            if (!written.rowsAffected) throw new Error(`Chart ${beatmapId} changed during marathon repair`);
            await import("./map-search.js").then((module) => module.upsertMapSearchIndexRow(db, beatmapId));
            result.rewritten += 1;
          }
        } else {
          const column = ratePercent === 150 ? "dan_dt_json" : "dan_ht_json";
          const previous = parseJson<Record<string, unknown>>(row[column], {});
          const verdict = { ...previous, primaryLabel: lean.primary!.displayName,
            primaryFamily: lean.primary!.kind === "ln" ? "ln" : "dan", rawDan: lean.primary!.rawDan };
          if (json(previous) !== json(verdict)) {
            const msdColumn = ratePercent === 150 ? "msd_dt_json" : "msd_ht_json";
            const written = await exec(db, `update beatmap_chart_analysis set ${column} = ?
              where beatmap_id = ? and analysis_version = ? and ${column} is ? and ${msdColumn} is ?`,
              [json(verdict), beatmapId, CHART_ANALYSIS_VERSION, row[column], row[msdColumn]]);
            if (!written.rowsAffected) throw new Error(`Rate ${beatmapId}@${ratePercent} changed during marathon repair`);
            result.ratesRewritten += 1;
          }
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      const seen = new Set<string>();
      for (const rate of rates) {
        const ratePercent = Number(rate.rate_percent);
        const adjusted = rate.mod_variant === VIBRO_ADJUSTED_VARIANT;
        const key = `${ratePercent}:${adjusted}`;
        if (seen.has(key)) continue;
        seen.add(key);
        // A current-version value already includes this correction. Leave it
        // in place, including one written by an interactive request mid-sweep.
        if (Number(rate.estimator_version) === TARGET_VERSION
          && ["ready", "unsupported", "unavailable"].includes(String(rate.status))) continue;
        const msd = await getMsd(ratePercent, adjusted, rate.msd_json);
        await computeAndStoreRateDanVerdictFromText(db, beatmapId, ratePercent, osuText,
          adjusted ? VIBRO_ADJUSTED_VARIANT : undefined, { msd, requireComplete: true });
        result.ratesRewritten += 1;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    const pause = Math.max(0, options.interMapPauseMs ?? 0);
    await new Promise<void>((resolve) => pause ? setTimeout(resolve, pause) : setImmediate(resolve));
    if (result.candidates >= (options.maxRepairs ?? REPAIRS_PER_CHUNK)) break;
  }
  if (!options.dryRun && unaffected.length > 0) {
    // Move only the immediate predecessor. Never bless pre-v19 stale values,
    // overwrite a new estimate, or force short/non-4K charts through a rerate.
    for (const table of ["dan_estimates", "dan_mod_estimates"]) {
      await exec(db, `update or ignore ${table} set estimator_version = ?
        where estimator_version = ? and status in ('ready', 'unsupported', 'unavailable')
        and beatmap_id in (${unaffected.map(() => "?").join(",")})`,
      [TARGET_VERSION, PREVIOUS_VERSION, ...unaffected]);
    }
  }
  result.done = result.scanned === page.length && page.length < limit;
  return result;
}

export async function ensureMarathonCorrectionSeeded(db: Db, queue: JobQueue): Promise<void> {
  if ((await exec(db, "select 1 from live_meta where key = ?", [MARATHON_CORRECTION_META_KEY])).rows.length) return;
  if ((await exec(db, "select 1 from jobs where type = ? and status in ('queued', 'running', 'failed', 'deferred_pressure') limit 1",
    [MARATHON_CORRECTION_JOB])).rows.length) return;
  await enqueueMarathon(queue, 0);
}

export async function runMarathonCorrectionJob(db: Db, queue: JobQueue, payload?: { cursor?: number }): Promise<void> {
  const cursor = Math.max(0, Math.floor(Number(payload?.cursor ?? 0)));
  const result = await recomputeMarathonCorrectionChunk(db, cursor, {
    interMapPauseMs: readConfig().role === "worker" ? 25 : 100,
  });
  logInfo("marathon_correction_sweep_chunk", { ...result });
  if (!result.done) { await enqueueMarathon(queue, result.nextCursor); return; }
  const now = nowIso();
  // Queue downstream work before stamping completion; a rejected enqueue is
  // retryable and must not leave the sweep looking finished.
  await queue.enqueue("rebuild_map_collections", "rebuild_map_collections", {}, { priority: -12, replaceDone: true });
  await exec(db, "insert or replace into live_meta (key, value_json, updated_at) values (?, ?, ?)",
    [MARATHON_CORRECTION_META_KEY, json({ finishedAt: now, estimatorVersion: DAN_ESTIMATE_CACHE_VERSION }), now]);
  const { ensurePlayerSkillDanSweepSeeded } = await import("./player-skills.js");
  await ensurePlayerSkillDanSweepSeeded(db, queue);
}

async function enqueueMarathon(queue: JobQueue, cursor: number): Promise<void> {
  await queue.enqueue(MARATHON_CORRECTION_JOB, `${MARATHON_CORRECTION_JOB}:${cursor}`, { cursor },
    { priority: -10, replaceDone: true });
}
