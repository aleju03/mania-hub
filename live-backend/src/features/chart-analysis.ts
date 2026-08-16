import { randomUUID } from "node:crypto";
import type { Db } from "../db.js";
import { exec, json, parseJson } from "../db.js";
import { parseManiaBeatmap } from "../dan/beatmap-parser.js";
import { extractDanFeatures } from "../dan/dan-estimator/features.js";
import { estimateLnDan } from "../dan/dan-estimator/ln.js";
import { analyzeManiaPatterns } from "../dan/dan-estimator/patterns.js";
import { detectLnVibro, detectRiceVibro, sunnyLowEndReroute, type ChartClassification, type DanVerdictHalf } from "../dan/chart-classifier.js";
import { classifyChartWithCompanella } from "../dan/companella.js";
import { runLeoBlackMixed } from "../dan/leoblack-estimator.js";
import { LN_TAIL_MIN_RATIO, computeMsd } from "../dan/msd.js";
import { computeNoteBpm } from "../dan/note-bpm.js";
import type { JobQueue } from "../jobs/queue.js";
import { readConfig } from "../config.js";
import { getCachedBeatmapFile, readCachedBeatmapFile } from "../osu/beatmap-file-cache.js";
import { isTerminalBeatmapFileError } from "../osu/beatmap-file-errors.js";
import type { OsuApiClient } from "../osu/client.js";
import { nowIso } from "../shared/score.js";
import { MSD_SKILLSETS } from "./farm-helper-shape.js";

// Per-beatmap chart analysis at 1.0x: the unified classifier verdict (dan
// estimate, pattern clusters, in-house pattern hits) plus the Etterna MSD
// skillset values. Stored durably in beatmap_chart_analysis keyed by
// CHART_ANALYSIS_VERSION; bump the version to reprocess every chart (the .osu
// cache means no re-downloading).

export const CHART_ANALYSIS_VERSION = 1;
export const CHART_ANALYSIS_JOB = "analyze_beatmap_chart";

const RUNNING_REQUEUE_MS = 10 * 60_000;
const FAILED_RETRY_MS = 5 * 60_000;
const BACKFILL_DEFAULT_LIMIT = 2000;

interface LeanVerdictHalf {
  kind: "rc" | "ln";
  source: string;
  label: string;
  variant: string | null;
  displayName: string;
  rawDan: number;
  estimatedSr: number;
  confidence: number;
}

interface LeanChartClassification {
  keyCount: number;
  supported: boolean;
  lnRatio: number;
  sunnySr: number | null;
  vibro: boolean;
  verdictText: string | null;
  rc: LeanVerdictHalf | null;
  ln: LeanVerdictHalf | null;
  primary: LeanVerdictHalf | null;
  category: string | null;
  patterns: Array<{ id: string; label: string; score: number; confidence: number }>;
  clusters: Array<{ label: string; pattern: string; bpm: number; mixed: boolean; amount: number; importance: number }>;
  clusterCategory: string | null;
  modeTag: string | null;
  warnings: string[];
  // Note-weighted song tempo at 1.0x (dan/note-bpm.ts); null when the chart
  // has no timing points or notes. Serves profile BPM stats via readNoteBpms.
  noteBpm: number | null;
}

function leanHalf(half: DanVerdictHalf | null): LeanVerdictHalf | null {
  if (!half) return null;
  return {
    kind: half.kind,
    source: half.source,
    label: half.label,
    variant: half.variant,
    displayName: half.displayName,
    rawDan: half.rawDan,
    estimatedSr: half.estimatedSr,
    confidence: half.confidence,
  };
}

function leanClassification(classification: ChartClassification, noteBpm: number | null = null): LeanChartClassification {
  return {
    noteBpm,
    keyCount: classification.keyCount,
    supported: classification.supported,
    lnRatio: classification.lnRatio,
    sunnySr: classification.sunnySr,
    vibro: classification.vibro,
    verdictText: classification.verdictText,
    rc: leanHalf(classification.rc),
    ln: leanHalf(classification.ln),
    primary: leanHalf(classification.primary),
    category: classification.patterns.primary?.label ?? null,
    patterns: classification.patterns.patterns.map((hit) => ({
      id: hit.id,
      label: hit.label,
      score: hit.score,
      confidence: hit.confidence,
    })),
    clusters: (classification.clusters?.topFiveClusters ?? []).map((cluster) => ({
      label: cluster.format(1),
      pattern: cluster.Pattern,
      bpm: cluster.BPM,
      mixed: cluster.Mixed,
      amount: cluster.Amount,
      importance: cluster.Importance,
    })),
    clusterCategory: classification.clusters?.report.Category ?? null,
    modeTag: classification.clusters?.report.ModeTag ?? null,
    warnings: classification.warnings,
  };
}

export async function computeBeatmapChartAnalysis(
  db: Db,
  osu: Pick<OsuApiClient, "getBeatmapFile">,
  payload: { beatmapId: number },
): Promise<void> {
  const beatmapId = Math.floor(Number(payload.beatmapId));
  if (!Number.isFinite(beatmapId) || beatmapId <= 0) return;

  const now = nowIso();
  await exec(
    db,
    `insert into beatmap_chart_analysis (beatmap_id, analysis_version, status, updated_at)
     values (?, ?, 'running', ?)
     on conflict(beatmap_id, analysis_version) do update set
       status = 'running',
       error = null,
       updated_at = excluded.updated_at`,
    [beatmapId, CHART_ANALYSIS_VERSION, now],
  );

  try {
    // Cache-first; the network fallback is the job's only osu! traffic, so it
    // honors the API-jobs switch (dev boxes analyze cached charts, fetch nothing).
    const osuText = readConfig().enableOsuApiJobs
      ? await getCachedBeatmapFile(db, osu, beatmapId, "job:analyze_beatmap_chart")
      : await readCachedBeatmapFile(db, beatmapId);
    if (osuText == null) {
      throw new Error(".osu file not cached and osu API jobs are disabled");
    }
    // The backend parser has no std->mania convert support and would silently
    // read a standard chart's x positions as columns; gate on the mode header.
    if (!/^Mode\s*:\s*3\s*$/m.test(osuText)) {
      throw new Error("Not a mania beatmap (Mode header is not 3)");
    }
    const map = parseManiaBeatmap(osuText);
    const starRating = Number((await exec(
      db,
      "select difficulty_rating from beatmaps where beatmap_id = ? limit 1",
      [beatmapId],
    )).rows[0]?.difficulty_rating ?? 0);

    // MSD first: it is stored either way, and Companella needs the same raw
    // values, so computing it up front saves the 4K LN-hybrid slice a second
    // MinaCalc pass.
    const msd = await computeMsd(osuText, { keyCount: map.keyCount }).catch(() => null);

    // Let the event loop breathe between the two CPU bursts.
    await new Promise<void>((resolve) => setImmediate(resolve));

    const classification = await classifyChartWithCompanella(map, osuText, {
      starRating: Number.isFinite(starRating) && starRating > 0 ? starRating : undefined,
      totalLength: map.totalLength > 0 ? map.totalLength / 1000 : undefined,
      version: map.version,
    }, { msdValues: msd?.values });

    // Tail-aware MSD for hold-bearing charts (stored raw; readers blend by
    // the keymode weight). Same shape as msd_json.
    let msdLn: Awaited<ReturnType<typeof computeMsd>> = null;
    if (msd && classification.lnRatio > LN_TAIL_MIN_RATIO) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      msdLn = await computeMsd(osuText, { keyCount: map.keyCount, lnTailTaps: true }).catch(() => null);
    }

    const lean = leanClassification(classification, computeNoteBpm(osuText));
    const computedAt = nowIso();
    await exec(
      db,
      `insert into beatmap_chart_analysis
         (beatmap_id, analysis_version, status, key_count, primary_label, primary_family,
          raw_dan, msd_overall, classification_json, msd_json, msd_ln_json, error, computed_at, updated_at)
       values (?, ?, 'ready', ?, ?, ?, ?, ?, ?, ?, ?, null, ?, ?)
       on conflict(beatmap_id, analysis_version) do update set
         status = excluded.status,
         key_count = excluded.key_count,
         primary_label = excluded.primary_label,
         primary_family = excluded.primary_family,
         raw_dan = excluded.raw_dan,
         msd_overall = excluded.msd_overall,
         classification_json = excluded.classification_json,
         msd_json = excluded.msd_json,
         msd_ln_json = excluded.msd_ln_json,
         error = excluded.error,
         computed_at = excluded.computed_at,
         updated_at = excluded.updated_at`,
      [
        beatmapId,
        CHART_ANALYSIS_VERSION,
        map.keyCount,
        lean.primary?.displayName ?? null,
        lean.primary ? (lean.primary.kind === "ln" ? "ln" : "dan") : null,
        lean.primary?.rawDan ?? null,
        msd?.values.Overall ?? null,
        json(lean),
        msd ? json(msd) : null,
        msdLn ? json(msdLn) : null,
        computedAt,
        computedAt,
      ],
    );
    // Surface the fresh analysis in map search without waiting for a rebuild.
    // Dynamic import keeps the static graph acyclic (map-search imports this
    // module for the version constant).
    await import("./map-search.js")
      .then((module) => module.upsertMapSearchIndexRow(db, beatmapId))
      .catch(() => {});
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failedAt = nowIso();
    const status = isTerminalChartAnalysisError(message) ? "unavailable" : "failed";
    await exec(
      db,
      `insert into beatmap_chart_analysis (beatmap_id, analysis_version, status, error, updated_at)
       values (?, ?, ?, ?, ?)
       on conflict(beatmap_id, analysis_version) do update set
         status = excluded.status,
         error = excluded.error,
         updated_at = excluded.updated_at`,
      [beatmapId, CHART_ANALYSIS_VERSION, status, message.slice(0, 500), failedAt],
    );
    if (status === "failed") throw error;
  }
}

// Same shape as the activity analyzer's terminal-error detection: exhausted
// 404s and invalid files never heal, so retrying is wasted API budget. Parse
// failures (non-mania charts the backend parser rejects) are terminal too.
function isTerminalChartAnalysisError(message: string): boolean {
  // Parse failures (non-mania charts the backend parser rejects) are terminal
  // on top of the shared exhausted-.osu-fetch cases.
  if (message.startsWith("Not a mania beatmap") || message.startsWith("Invalid .osu")) return true;
  return isTerminalBeatmapFileError(message);
}

export async function enqueueChartAnalysisIfNeeded(db: Db, queue: JobQueue, beatmapId: number): Promise<void> {
  if (!Number.isInteger(beatmapId) || beatmapId <= 0) return;
  const row = (await exec(
    db,
    `select status, updated_at from beatmap_chart_analysis
     where beatmap_id = ? and analysis_version = ?
     limit 1`,
    [beatmapId, CHART_ANALYSIS_VERSION],
  )).rows[0];
  if (row && shouldSkipChartAnalysis(row)) return;
  await enqueueChartAnalysis(queue, beatmapId);
}

export async function enqueueMissingChartAnalyses(db: Db, queue: JobQueue, beatmapIds: number[]): Promise<void> {
  const ids = [...new Set(beatmapIds)].filter((id) => Number.isInteger(id) && id > 0).slice(0, 300);
  if (ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(", ");
  const rows = (await exec(
    db,
    `select beatmap_id, status, updated_at from beatmap_chart_analysis
     where analysis_version = ? and beatmap_id in (${placeholders})`,
    [CHART_ANALYSIS_VERSION, ...ids],
  )).rows;
  const rowByBeatmapId = new Map(rows.map((row) => [Number(row.beatmap_id), row]));
  for (const beatmapId of ids) {
    const row = rowByBeatmapId.get(beatmapId);
    if (row && shouldSkipChartAnalysis(row)) continue;
    await enqueueChartAnalysis(queue, beatmapId);
  }
}

// The farm-count-ordered candidate query aggregates the whole
// country_maps_farmed_scores table, and local libsql runs synchronously, so it
// must not run on every ~20s top-up tick. The ordered id list barely changes
// while a backfill drains, so it is cached per Db with a cursor; each top-up
// serves the next slice and re-checks only that slice's statuses (indexed pk
// lookup). Admin includeFailed passes bypass the cache entirely.
const BACKFILL_CANDIDATES_TTL_MS = 10 * 60_000;
interface CachedBackfillCandidates {
  ids: number[];
  cursor: number;
  expiresAt: number;
}
const backfillCandidatesCache = new WeakMap<Db, CachedBackfillCandidates>();

/**
 * Enqueue analysis for beatmaps whose .osu text is already cached but have no
 * row at the current version. No osu! API cost: it only sweeps the local cache.
 * Returns how many jobs were enqueued.
 */
export async function enqueueChartAnalysisBackfill(
  db: Db,
  queue: JobQueue,
  limit = BACKFILL_DEFAULT_LIMIT,
  options: { includeFailed?: boolean } = {},
): Promise<number> {
  const safeLimit = Math.max(1, Math.min(20_000, Math.floor(limit)));

  // Manual admin retry pass: uncached direct query, failed rows included.
  if (options.includeFailed) {
    const ids = await queryBackfillCandidates(db, safeLimit, true);
    let enqueued = 0;
    for (const beatmapId of ids) {
      await enqueueChartAnalysis(queue, beatmapId);
      enqueued += 1;
    }
    return enqueued;
  }

  const now = Date.now();
  let cached = backfillCandidatesCache.get(db);
  if (!cached || cached.expiresAt <= now || cached.cursor >= cached.ids.length) {
    cached = {
      ids: await queryBackfillCandidates(db, BACKFILL_CANDIDATES_FETCH, false),
      cursor: 0,
      expiresAt: now + BACKFILL_CANDIDATES_TTL_MS,
    };
    backfillCandidatesCache.set(db, cached);
  }

  let enqueued = 0;
  while (enqueued < safeLimit && cached.cursor < cached.ids.length) {
    const slice = cached.ids.slice(cached.cursor, cached.cursor + Math.min(900, safeLimit - enqueued));
    cached.cursor += slice.length;
    // The cached list can be minutes stale: a slice entry may have gained a row
    // (ready, running, recently failed) since the fetch. Re-check just the slice.
    const placeholders = slice.map(() => "?").join(", ");
    const rows = (await exec(
      db,
      `select beatmap_id, status, updated_at from beatmap_chart_analysis
       where analysis_version = ? and beatmap_id in (${placeholders})`,
      [CHART_ANALYSIS_VERSION, ...slice],
    )).rows;
    const rowByBeatmapId = new Map(rows.map((row) => [Number(row.beatmap_id), row]));
    for (const beatmapId of slice) {
      const row = rowByBeatmapId.get(beatmapId);
      if (row && shouldSkipChartAnalysis(row)) continue;
      await enqueueChartAnalysis(queue, beatmapId);
      enqueued += 1;
    }
  }
  return enqueued;
}

// How many ordered candidates one expensive query buys. At the top-up rate
// (BACKFILL_TOP_UP per drain) this outlives the cache TTL comfortably.
const BACKFILL_CANDIDATES_FETCH = 20_000;

async function queryBackfillCandidates(db: Db, limit: number, includeFailed: boolean): Promise<number[]> {
  // The self-chaining runner sweeps missing rows only: failed rows already get
  // queue-level retries, and re-sweeping them each pass would keep the run
  // alive forever on a chart that permanently fails. The manual admin endpoint
  // includes them for an explicit retry pass.
  const missingClause = includeFailed
    ? "(a.beatmap_id is null or a.status in ('failed'))"
    : "a.beatmap_id is null";
  // Prioritize charts the farm helper actually ranks: analyze the most-farmed
  // maps first so the ~half of farmed maps still missing analysis close their
  // coverage gap before the long tail of never-farmed charts.
  const rows = (await exec(
    db,
    `select f.beatmap_id as beatmap_id
     from beatmap_osu_files f
     left join beatmap_chart_analysis a
       on a.beatmap_id = f.beatmap_id and a.analysis_version = ?
     left join (
       select beatmap_id, count(*) as farm_count
       from country_maps_farmed_scores
       group by beatmap_id
     ) fc on fc.beatmap_id = f.beatmap_id
     where f.error is null
       and (f.content != '' or f.content_blob is not null)
       and ${missingClause}
     order by coalesce(fc.farm_count, 0) desc, f.beatmap_id
     limit ?`,
    [CHART_ANALYSIS_VERSION, limit],
  )).rows;
  return rows
    .map((row) => Number(row.beatmap_id))
    .filter((id) => Number.isInteger(id) && id > 0);
}

function shouldSkipChartAnalysis(row: Record<string, unknown>): boolean {
  const status = String(row.status);
  const updatedAt = typeof row.updated_at === "string" ? row.updated_at : "";
  if (status === "ready") return true;
  if (status === "unavailable") return true;
  if (status === "running" && isRecent(updatedAt, RUNNING_REQUEUE_MS)) return true;
  if (status === "failed" && isRecent(updatedAt, FAILED_RETRY_MS)) return true;
  return false;
}

function isRecent(updatedAt: string, cooldownMs: number): boolean {
  const updatedAtMs = Date.parse(updatedAt);
  if (!Number.isFinite(updatedAtMs)) return false;
  return Date.now() - updatedAtMs < cooldownMs;
}

async function enqueueChartAnalysis(queue: JobQueue, beatmapId: number): Promise<void> {
  await queue.enqueue(
    CHART_ANALYSIS_JOB,
    `chart-analysis:${CHART_ANALYSIS_VERSION}:${beatmapId}`,
    { beatmapId },
    { priority: 4, replaceDone: true },
  );
}

// ── Fire-and-forget backfill run ─────────────────────────────────────────────
// One admin click starts a self-chaining runner that keeps the analysis queue
// topped up from the cached .osu corpus until nothing is missing. State lives
// in live_meta so the admin page can show progress across restarts.

export const CHART_ANALYSIS_BACKFILL_JOB = "chart_analysis_backfill";

const BACKFILL_META_KEY = "chart_analysis_backfill_state";
const BACKFILL_LOW_WATER = 200;
const BACKFILL_TOP_UP = 1000;
const BACKFILL_CHAIN_DELAY_MS = 20_000;
const BACKFILL_COUNTS_TTL_MS = 60_000;

type ChartBackfillRunStatus = "idle" | "running" | "done" | "cancelled";

interface ChartBackfillState {
  runId: string | null;
  status: ChartBackfillRunStatus;
  enqueued: number;
  startedAt: string | null;
  updatedAt: string;
  finishedAt: string | null;
}

interface ChartBackfillCounts {
  eligible: number;
  ready: number;
  unavailable: number;
  failed: number;
}

export interface ChartAnalysisBackfillStatus extends ChartBackfillState, ChartBackfillCounts {
  version: number;
  remaining: number;
  percent: number;
  active: boolean;
  stalled: boolean;
  jobs: { queued: number; running: number; failed: number; deferred: number };
}

export async function getChartAnalysisBackfillStatus(
  db: Db,
  options: { cacheCounts?: boolean } = {},
): Promise<ChartAnalysisBackfillStatus> {
  const [state, counts, jobs] = await Promise.all([
    readBackfillState(db),
    options.cacheCounts ? readCachedBackfillCounts(db) : readBackfillCounts(db),
    readAnalysisJobCounts(db),
  ]);
  const covered = counts.ready + counts.unavailable;
  const remaining = Math.max(0, counts.eligible - covered);
  const activeJobs = jobs.queued + jobs.running + jobs.deferred + jobs.failed;
  const active = state.status === "running" && remaining > 0;
  return {
    ...state,
    ...counts,
    version: CHART_ANALYSIS_VERSION,
    remaining,
    percent: counts.eligible > 0 ? Math.min(100, Math.max(0, (covered / counts.eligible) * 100)) : 100,
    active,
    stalled: active && activeJobs === 0,
    jobs,
  };
}

export async function startChartAnalysisBackfill(db: Db, queue: JobQueue): Promise<ChartAnalysisBackfillStatus> {
  const current = await getChartAnalysisBackfillStatus(db);
  if (current.active && !current.stalled) return current;

  const now = nowIso();
  if (current.remaining <= 0) {
    await writeBackfillState(db, { ...readableState(current), status: "done", updatedAt: now, finishedAt: current.finishedAt ?? now });
    return getChartAnalysisBackfillStatus(db);
  }

  const runId = current.active && current.runId ? current.runId : randomUUID();
  await writeBackfillState(db, {
    runId,
    status: "running",
    enqueued: current.active ? current.enqueued : 0,
    startedAt: current.active ? current.startedAt ?? now : now,
    updatedAt: now,
    finishedAt: null,
  });
  await enqueueBackfillRunner(queue, runId, 0, 0);
  return getChartAnalysisBackfillStatus(db);
}

export async function cancelChartAnalysisBackfill(db: Db): Promise<ChartAnalysisBackfillStatus> {
  const state = await readBackfillState(db);
  const now = nowIso();
  await exec(
    db,
    `delete from jobs
     where type in (?, ?)
       and status in ('queued', 'failed', 'deferred_pressure')`,
    [CHART_ANALYSIS_BACKFILL_JOB, CHART_ANALYSIS_JOB],
  );
  await writeBackfillState(db, { ...state, status: "cancelled", updatedAt: now, finishedAt: now });
  return getChartAnalysisBackfillStatus(db);
}

export async function runChartAnalysisBackfillJob(
  db: Db,
  queue: JobQueue,
  payload: { runId?: string; tick?: number },
): Promise<void> {
  const state = await readBackfillState(db);
  if (!payload?.runId || state.runId !== payload.runId) return;
  if (state.status !== "running") return;

  const jobs = await readAnalysisJobCounts(db);
  const activeJobs = jobs.queued + jobs.running + jobs.deferred;

  let newlyEnqueued = 0;
  if (activeJobs < BACKFILL_LOW_WATER) {
    newlyEnqueued = await enqueueChartAnalysisBackfill(db, queue, BACKFILL_TOP_UP);
  }

  const now = nowIso();
  if (newlyEnqueued === 0 && activeJobs === 0) {
    await writeBackfillState(db, { ...state, status: "done", updatedAt: now, finishedAt: now });
    return;
  }

  await writeBackfillState(db, { ...state, enqueued: state.enqueued + newlyEnqueued, updatedAt: now });
  await enqueueBackfillRunner(queue, payload.runId, (payload.tick ?? 0) + 1, BACKFILL_CHAIN_DELAY_MS);
}

async function enqueueBackfillRunner(queue: JobQueue, runId: string, tick: number, delayMs: number): Promise<void> {
  await queue.enqueue(
    CHART_ANALYSIS_BACKFILL_JOB,
    `${CHART_ANALYSIS_BACKFILL_JOB}:${runId}:${tick}`,
    { runId, tick },
    { priority: 3, runAfter: delayMs > 0 ? new Date(Date.now() + delayMs) : undefined, replaceDone: true },
  );
}

function readableState(status: ChartAnalysisBackfillStatus): ChartBackfillState {
  return {
    runId: status.runId,
    status: status.status,
    enqueued: status.enqueued,
    startedAt: status.startedAt,
    updatedAt: status.updatedAt,
    finishedAt: status.finishedAt,
  };
}

async function readBackfillState(db: Db): Promise<ChartBackfillState> {
  const row = (await exec(db, "select value_json from live_meta where key = ?", [BACKFILL_META_KEY])).rows[0];
  const parsed = parseJson<Partial<ChartBackfillState> | null>(row?.value_json, null);
  const status = parsed?.status === "running" || parsed?.status === "done" || parsed?.status === "cancelled" ? parsed.status : "idle";
  return {
    runId: typeof parsed?.runId === "string" && parsed.runId ? parsed.runId : null,
    status,
    enqueued: Number.isFinite(Number(parsed?.enqueued)) && Number(parsed?.enqueued) >= 0 ? Math.floor(Number(parsed?.enqueued)) : 0,
    startedAt: typeof parsed?.startedAt === "string" ? parsed.startedAt : null,
    updatedAt: typeof parsed?.updatedAt === "string" ? parsed.updatedAt : nowIso(),
    finishedAt: typeof parsed?.finishedAt === "string" ? parsed.finishedAt : null,
  };
}

async function writeBackfillState(db: Db, state: ChartBackfillState): Promise<void> {
  await exec(
    db,
    `insert into live_meta (key, value_json, updated_at)
     values (?, ?, ?)
     on conflict(key) do update set value_json = excluded.value_json, updated_at = excluded.updated_at`,
    [BACKFILL_META_KEY, json(state), state.updatedAt],
  );
}

async function readBackfillCounts(db: Db): Promise<ChartBackfillCounts> {
  // "eligible" tests compressed_bytes alone so the aggregate is answered from
  // idx_beatmap_osu_files_meta without touching the blob-laden table pages
  // (milliseconds instead of a 10-40s event-loop-stalling scan). The cache
  // writer only ever stores files compressed (content stays '', and
  // compressed_bytes is set together with content_blob), so this matches the
  // picker's content/content_blob eligibility test for every stored row.
  // INDEXED BY pins the covering-index scan so the planner can't fall back to
  // the blob-laden table B-tree.
  const row = (await exec(
    db,
    `select
       sum(case when f.error is null and f.compressed_bytes > 0 then 1 else 0 end) as eligible,
       sum(case when a.status = 'ready' then 1 else 0 end) as ready,
       sum(case when a.status = 'unavailable' then 1 else 0 end) as unavailable,
       sum(case when a.status = 'failed' then 1 else 0 end) as failed
     from beatmap_osu_files as f indexed by idx_beatmap_osu_files_meta
     left join beatmap_chart_analysis a
       on a.beatmap_id = f.beatmap_id and a.analysis_version = ?`,
    [CHART_ANALYSIS_VERSION],
  )).rows[0];
  return {
    eligible: Number(row?.eligible ?? 0),
    ready: Number(row?.ready ?? 0),
    unavailable: Number(row?.unavailable ?? 0),
    failed: Number(row?.failed ?? 0),
  };
}

// The counts scan the .osu blob table (largest in the DB); the status endpoint
// serves stale cached counts while a single-flight refresh runs, mirroring the
// .osu backfill's approach.
const backfillCountsCache = new WeakMap<Db, { expiresAt: number; value: ChartBackfillCounts }>();
const backfillCountsRefresh = new WeakMap<Db, Promise<ChartBackfillCounts>>();

async function readCachedBackfillCounts(db: Db): Promise<ChartBackfillCounts> {
  const cached = backfillCountsCache.get(db);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  let refresh = backfillCountsRefresh.get(db);
  if (!refresh) {
    refresh = readBackfillCounts(db).then((value) => {
      backfillCountsCache.set(db, { value, expiresAt: Date.now() + BACKFILL_COUNTS_TTL_MS });
      return value;
    }).finally(() => {
      backfillCountsRefresh.delete(db);
    });
    backfillCountsRefresh.set(db, refresh);
  }
  if (cached) {
    refresh.catch(() => undefined);
    return cached.value;
  }
  return refresh;
}

// ── One-shot vibro recompute sweep ───────────────────────────────────────────
// Vibro detectors arrive after the corpus was analyzed (v1: LN vibro; v2: rice
// vibro for sustained jack hammering and 4K chord walls). Re-running every
// analysis (a CHART_ANALYSIS_VERSION bump) would burn hours of CPU to refresh
// one boolean; instead a boot-seeded job sweeps unflagged charts from the
// cached .osu corpus once per meta-key version, patches classification_json
// and the search index in place, and marks itself done in live_meta. Purely
// local work, no osu! API.

export const VIBRO_RECOMPUTE_JOB = "recompute_vibro_sweep";
// v3: v2 was burned by a dev-watch restart that ran the sweep mid-edit with
// the old holds-heavy candidate filter; the rice sweep needs the full corpus.
// v4: rice tier 3 (burst-soak vibro) plus the relaxed tier-2 column-ratio
// floor; the v3 corpus left 8-23-note burst packs unflagged.
const VIBRO_RECOMPUTE_META_KEY = "vibro_recompute_done:v4";
const VIBRO_RECOMPUTE_CHUNK = 50;

export interface VibroRecomputeChunkResult {
  nextCursor: number;
  scanned: number;
  flagged: number[];
  done: boolean;
}

export async function recomputeVibroChunk(
  db: Db,
  cursor: number,
  limit = VIBRO_RECOMPUTE_CHUNK,
  options: { dryRun?: boolean } = {},
): Promise<VibroRecomputeChunkResult> {
  const rows = (await exec(
    db,
    `select a.beatmap_id as beatmap_id
     from beatmap_chart_analysis a
     where a.analysis_version = ? and a.status = 'ready'
       and a.beatmap_id > ?
       and coalesce(json_extract(a.classification_json, '$.vibro'), 0) != 1
     order by a.beatmap_id
     limit ?`,
    [CHART_ANALYSIS_VERSION, Math.max(0, Math.floor(cursor)), Math.max(1, Math.floor(limit))],
  )).rows;

  let nextCursor = cursor;
  const flagged: number[] = [];
  for (const row of rows) {
    const beatmapId = Number(row.beatmap_id);
    nextCursor = Math.max(nextCursor, beatmapId);
    const osuText = await readCachedBeatmapFile(db, beatmapId).catch(() => null);
    if (!osuText) continue;
    let vibro = false;
    try {
      const map = parseManiaBeatmap(osuText);
      vibro = detectRiceVibro(map) || detectLnVibro(map);
    } catch {
      continue;
    }
    // Parsing is the CPU burst; yield between charts so ingest/SSE keep moving.
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (!vibro) continue;

    flagged.push(beatmapId);
    if (options.dryRun) continue;
    await exec(
      db,
      `update beatmap_chart_analysis
       set classification_json = json_set(classification_json, '$.vibro', json('true'))
       where beatmap_id = ? and analysis_version = ?`,
      [beatmapId, CHART_ANALYSIS_VERSION],
    );
    await exec(db, "update map_search_index set vibro = 1 where beatmap_id = ?", [beatmapId]);
  }

  return { nextCursor, scanned: rows.length, flagged, done: rows.length < limit };
}

// Boot watchdog: seed the sweep once per meta-key version, resume if a chain
// died mid-way (each chunk's job carries its own cursor dedupe key).
export async function ensureVibroRecomputeSeeded(db: Db, queue: JobQueue): Promise<void> {
  const done = (await exec(db, "select 1 from live_meta where key = ? limit 1", [VIBRO_RECOMPUTE_META_KEY])).rows[0];
  if (done) return;
  const pending = (await exec(
    db,
    "select 1 from jobs where type = ? and status in ('queued', 'running', 'failed', 'deferred_pressure') limit 1",
    [VIBRO_RECOMPUTE_JOB],
  )).rows[0];
  if (pending) return;
  await enqueueVibroRecompute(queue, 0);
}

export async function runVibroRecomputeJob(db: Db, queue: JobQueue, payload: { cursor?: number } | undefined): Promise<void> {
  const cursor = Math.max(0, Math.floor(Number(payload?.cursor ?? 0)));
  const result = await recomputeVibroChunk(db, cursor);
  if (result.done) {
    const now = nowIso();
    await exec(
      db,
      "insert or replace into live_meta (key, value_json, updated_at) values (?, ?, ?)",
      [VIBRO_RECOMPUTE_META_KEY, json({ finishedAt: now }), now],
    );
    // Freshly flagged charts must leave the auto-curated packs now, not on the
    // next scheduled rotation.
    await queue.enqueue("rebuild_map_collections", "rebuild_map_collections", {}, { priority: -12, replaceDone: true });
    return;
  }
  await enqueueVibroRecompute(queue, result.nextCursor);
}

async function enqueueVibroRecompute(queue: JobQueue, cursor: number): Promise<void> {
  await queue.enqueue(
    VIBRO_RECOMPUTE_JOB,
    `${VIBRO_RECOMPUTE_JOB}:${cursor}`,
    { cursor },
    { priority: -10, replaceDone: true },
  );
}

// ── One-shot note-BPM backfill sweep ─────────────────────────────────────────
// noteBpm (dan/note-bpm.ts) arrived after the corpus was analyzed: stored
// classifications lack the field, so profile BPM stats would fall back to the
// nominal osu! bpm for every existing chart. Same playbook as the vibro sweep
// above: a boot-seeded chunked job patches classification_json in place from
// the cached .osu corpus, once per meta-key version. The parse is a light
// timing+notes scan (no classifier, no MinaCalc). Purely local work, no osu!
// API.

export const NOTE_BPM_RECOMPUTE_JOB = "recompute_note_bpm_sweep";
// v2: v1 ran against a pre-fold computeNoteBpm (a dev-watch restart picked the
// sweep up mid-edit), so inflated-timing charts were stored raw (666 instead
// of 333). The scan below revisits stored values above the fold trigger.
// v3: v2 was burned the same way - a dev-watch restart booted between the key
// bump and the widened scan landing, saw zero missing rows, and wrote the
// done-key. Key bumps must ship in the same write as their scan change.
const NOTE_BPM_RECOMPUTE_META_KEY = "note_bpm_recompute_done:v3";
const NOTE_BPM_RECOMPUTE_CHUNK = 50;
// Keep in sync with FOLD_TRIGGER_BPM (dan/note-bpm.ts): stored medians above
// it are the only ones a fold-rule change can move.
const NOTE_BPM_RESCAN_MIN_BPM = 300;

export interface NoteBpmRecomputeChunkResult {
  nextCursor: number;
  scanned: number;
  patched: number[];
  done: boolean;
}

export async function recomputeNoteBpmChunk(
  db: Db,
  cursor: number,
  limit = NOTE_BPM_RECOMPUTE_CHUNK,
): Promise<NoteBpmRecomputeChunkResult> {
  // json_extract as a scan filter is fine here: this is the background sweep,
  // not a serving query, and it lets an interrupted chain skip already-patched
  // rows. Rows with a stored value above the fold trigger re-match so sweep
  // version bumps can apply fold-rule changes; the cursor only moves forward,
  // so each run still visits each row once.
  const rows = (await exec(
    db,
    `select beatmap_id
     from beatmap_chart_analysis
     where analysis_version = ? and status = 'ready'
       and beatmap_id > ?
       and (
         json_extract(classification_json, '$.noteBpm') is null
         or json_extract(classification_json, '$.noteBpm') > ?
       )
     order by beatmap_id
     limit ?`,
    [CHART_ANALYSIS_VERSION, Math.max(0, Math.floor(cursor)), NOTE_BPM_RESCAN_MIN_BPM, Math.max(1, Math.floor(limit))],
  )).rows;

  let nextCursor = cursor;
  const patched: number[] = [];
  for (const row of rows) {
    const beatmapId = Number(row.beatmap_id);
    nextCursor = Math.max(nextCursor, beatmapId);
    const osuText = await readCachedBeatmapFile(db, beatmapId).catch(() => null);
    if (!osuText) continue;
    const noteBpm = computeNoteBpm(osuText);
    // Store the null verdict too, so fresh analyses and swept rows read alike.
    await exec(
      db,
      `update beatmap_chart_analysis
       set classification_json = json_set(classification_json, '$.noteBpm', json(?))
       where beatmap_id = ? and analysis_version = ?`,
      [JSON.stringify(noteBpm), beatmapId, CHART_ANALYSIS_VERSION],
    );
    if (noteBpm != null) patched.push(beatmapId);
    // Light work per chart, but the chunk still yields so ingest/SSE keep moving.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  return { nextCursor, scanned: rows.length, patched, done: rows.length < limit };
}

// Boot watchdog: seed the sweep once per meta-key version, resume if a chain
// died mid-way (each chunk's job carries its own cursor dedupe key).
export async function ensureNoteBpmRecomputeSeeded(db: Db, queue: JobQueue): Promise<void> {
  const done = (await exec(db, "select 1 from live_meta where key = ? limit 1", [NOTE_BPM_RECOMPUTE_META_KEY])).rows[0];
  if (done) return;
  const pending = (await exec(
    db,
    "select 1 from jobs where type = ? and status in ('queued', 'running', 'failed', 'deferred_pressure') limit 1",
    [NOTE_BPM_RECOMPUTE_JOB],
  )).rows[0];
  if (pending) return;
  await enqueueNoteBpmRecompute(queue, 0);
}

export async function runNoteBpmRecomputeJob(db: Db, queue: JobQueue, payload: { cursor?: number } | undefined): Promise<void> {
  const cursor = Math.max(0, Math.floor(Number(payload?.cursor ?? 0)));
  const result = await recomputeNoteBpmChunk(db, cursor);
  if (result.done) {
    const now = nowIso();
    await exec(
      db,
      "insert or replace into live_meta (key, value_json, updated_at) values (?, ?, ?)",
      [NOTE_BPM_RECOMPUTE_META_KEY, json({ finishedAt: now }), now],
    );
    return;
  }
  await enqueueNoteBpmRecompute(queue, result.nextCursor);
}

async function enqueueNoteBpmRecompute(queue: JobQueue, cursor: number): Promise<void> {
  await queue.enqueue(
    NOTE_BPM_RECOMPUTE_JOB,
    `${NOTE_BPM_RECOMPUTE_JOB}:${cursor}`,
    { cursor },
    { priority: -10, replaceDone: true },
  );
}

// Reads stored note-weighted BPMs for the given beatmaps (profile snapshot
// serving attaches them as beatmap.note_bpm). Indexed pk IN lookup; rows
// without a positive stored noteBpm are simply absent from the map.
export async function readNoteBpms(db: Db, beatmapIds: number[]): Promise<Map<number, number>> {
  const ids = [...new Set(beatmapIds.filter((id) => Number.isSafeInteger(id) && id > 0))];
  const result = new Map<number, number>();
  for (let i = 0; i < ids.length; i += 900) {
    const chunk = ids.slice(i, i + 900);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "?").join(",");
    const rows = (await exec(
      db,
      `select beatmap_id, json_extract(classification_json, '$.noteBpm') as note_bpm
       from beatmap_chart_analysis
       where analysis_version = ? and status = 'ready' and beatmap_id in (${placeholders})`,
      [CHART_ANALYSIS_VERSION, ...chunk],
    )).rows;
    for (const row of rows) {
      const beatmapId = Number(row.beatmap_id);
      const noteBpm = Number(row.note_bpm);
      if (!Number.isSafeInteger(beatmapId) || beatmapId <= 0) continue;
      if (!Number.isFinite(noteBpm) || noteBpm <= 0) continue;
      result.set(beatmapId, noteBpm);
    }
  }
  return result;
}

// ── One-shot dan floor-pin recompute sweep ───────────────────────────────────
// The classifier's Roxy floor-pin guard (chart-classifier.ts) arrived after the
// corpus was analyzed: trivial 4K charts with enough taps to clear Roxy's note
// gate were stored as ~"Reform 4" and leaked into the 4-6 dan collections and
// the dan search facet. Same playbook as the vibro sweep above: a boot-seeded
// chunked job re-checks stored 4K dan verdicts in the plausible pinned band
// with the cheap mixed run, and re-enqueues the full analysis job (which now
// applies the guard) for the ones whose raw signal is pinned. Purely local
// work, no osu! API.

export const DAN_FLOOR_PIN_RECOMPUTE_JOB = "recompute_dan_floor_pin_sweep";
const DAN_FLOOR_PIN_META_KEY = "dan_floor_pin_recompute_done:v1";
const DAN_FLOOR_PIN_CHUNK = 50;
// Stored finals of pinned charts are meta-model extrapolations off a 2.9
// structural floor and cluster at 3.5-4.5; 6.5 bounds the candidate scan with
// generous headroom while skipping the mid/high corpus (~17k of 75k rows).
const DAN_FLOOR_PIN_MAX_RAW_DAN = 6.5;

export interface DanFloorPinChunkResult {
  nextCursor: number;
  scanned: number;
  pinned: number[];
  done: boolean;
}

export async function recomputeDanFloorPinChunk(
  db: Db,
  cursor: number,
  limit = DAN_FLOOR_PIN_CHUNK,
): Promise<DanFloorPinChunkResult> {
  const rows = (await exec(
    db,
    `select beatmap_id
     from beatmap_chart_analysis
     where analysis_version = ? and status = 'ready'
       and key_count = 4 and primary_family = 'dan'
       and raw_dan is not null and raw_dan < ?
       and beatmap_id > ?
     order by beatmap_id
     limit ?`,
    [CHART_ANALYSIS_VERSION, DAN_FLOOR_PIN_MAX_RAW_DAN, Math.max(0, Math.floor(cursor)), Math.max(1, Math.floor(limit))],
  )).rows;

  let nextCursor = cursor;
  const pinned: number[] = [];
  for (const row of rows) {
    const beatmapId = Number(row.beatmap_id);
    nextCursor = Math.max(nextCursor, beatmapId);
    const osuText = await readCachedBeatmapFile(db, beatmapId).catch(() => null);
    if (!osuText) continue;
    try {
      // Same predicate the classifier applies (pinned raw + Sunny agreeing the
      // chart is sub-Reform-1), so only charts whose verdict will actually
      // change re-analyze.
      if (sunnyLowEndReroute(runLeoBlackMixed(osuText), osuText, 1) != null) pinned.push(beatmapId);
    } catch {
      // A chart the estimator rejects keeps its stored verdict; the full
      // analysis job would fail the same way.
    }
    // The mixed run is the CPU burst; yield between charts like the vibro sweep.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  return { nextCursor, scanned: rows.length, pinned, done: rows.length < limit };
}

// Boot watchdog: seed the sweep once per meta-key version, resume if a chain
// died mid-way (each chunk's job carries its own cursor dedupe key).
export async function ensureDanFloorPinRecomputeSeeded(db: Db, queue: JobQueue): Promise<void> {
  const done = (await exec(db, "select 1 from live_meta where key = ? limit 1", [DAN_FLOOR_PIN_META_KEY])).rows[0];
  if (done) return;
  const pending = (await exec(
    db,
    "select 1 from jobs where type = ? and status in ('queued', 'running', 'failed', 'deferred_pressure') limit 1",
    [DAN_FLOOR_PIN_RECOMPUTE_JOB],
  )).rows[0];
  if (pending) return;
  await enqueueDanFloorPinRecompute(queue, 0);
}

export async function runDanFloorPinRecomputeJob(db: Db, queue: JobQueue, payload: { cursor?: number } | undefined): Promise<void> {
  const cursor = Math.max(0, Math.floor(Number(payload?.cursor ?? 0)));
  const result = await recomputeDanFloorPinChunk(db, cursor);
  // The re-analysis jobs run at higher priority than this sweep and the
  // collections rebuild, and each one upserts its search-index row on
  // completion, so the rebuild below sees a mostly-updated index; the weekly
  // rotation covers any stragglers.
  for (const beatmapId of result.pinned) await enqueueChartAnalysis(queue, beatmapId);
  if (result.done) {
    const now = nowIso();
    await exec(
      db,
      "insert or replace into live_meta (key, value_json, updated_at) values (?, ?, ?)",
      [DAN_FLOOR_PIN_META_KEY, json({ finishedAt: now }), now],
    );
    // Re-verdicted charts must leave the dan packs now, not on the next
    // scheduled rotation.
    await queue.enqueue("rebuild_map_collections", "rebuild_map_collections", {}, { priority: -12, replaceDone: true });
    return;
  }
  await enqueueDanFloorPinRecompute(queue, result.nextCursor);
}

async function enqueueDanFloorPinRecompute(queue: JobQueue, cursor: number): Promise<void> {
  await queue.enqueue(
    DAN_FLOOR_PIN_RECOMPUTE_JOB,
    `${DAN_FLOOR_PIN_RECOMPUTE_JOB}:${cursor}`,
    { cursor },
    { priority: -10, replaceDone: true },
  );
}

// The LN subtypes (lngeneral/lninverse/lntech) now fire on 4K as well, so every
// stored 4K LN chart predates the tags it should carry. Same playbook as the v1
// sweep (which fixed the tempo-aware inverse gap cap on 7K): a boot-seeded
// chunked job recomputes the pattern analyzer verdict for stored LN charts from
// the cached .osu and re-enqueues the full analysis job for the ones whose
// visible pattern tags or primary changed. Purely local work, no osu! API.
//
// v2 scans 4K and 7K. 4K subtype scores are all new, and 7K picks up the
// subtypes that used to be dropped by the top-5 visible slice (~1% of stored
// 7K LN verdicts), so both keymodes can differ from what is stored.
export const LN_SUBTYPE_RECOMPUTE_JOB = "recompute_ln_subtype_sweep";
const LN_SUBTYPE_META_KEY = "ln_subtype_recompute_done:v2";
const LN_SUBTYPE_SWEEP_KEY_COUNTS = [4, 7];
const LN_SUBTYPE_CHUNK = 50;
// Subtype scores are gated on the composite LN score, which needs some hold
// presence; charts with near-zero LN share can't change tags.
const LN_SUBTYPE_MIN_LN_RATIO = 0.02;

export interface LnSubtypeChunkResult {
  nextCursor: number;
  scanned: number;
  changed: number[];
  done: boolean;
}

export async function recomputeLnSubtypeChunk(
  db: Db,
  cursor: number,
  limit = LN_SUBTYPE_CHUNK,
): Promise<LnSubtypeChunkResult> {
  const rows = (await exec(
    db,
    `select beatmap_id, classification_json
     from beatmap_chart_analysis
     where analysis_version = ? and status = 'ready'
       and key_count in (${LN_SUBTYPE_SWEEP_KEY_COUNTS.join(", ")})
       and json_extract(classification_json, '$.lnRatio') >= ?
       and beatmap_id > ?
     order by beatmap_id
     limit ?`,
    [CHART_ANALYSIS_VERSION, LN_SUBTYPE_MIN_LN_RATIO, Math.max(0, Math.floor(cursor)), Math.max(1, Math.floor(limit))],
  )).rows;

  let nextCursor = cursor;
  const changed: number[] = [];
  for (const row of rows) {
    const beatmapId = Number(row.beatmap_id);
    nextCursor = Math.max(nextCursor, beatmapId);
    const stored = parseJson<Pick<LeanChartClassification, "category" | "patterns"> | null>(row.classification_json, null);
    if (!stored) continue;
    const osuText = await readCachedBeatmapFile(db, beatmapId).catch(() => null);
    if (!osuText) continue;
    try {
      const map = parseManiaBeatmap(osuText);
      if (!LN_SUBTYPE_SWEEP_KEY_COUNTS.includes(map.keyCount)) continue;
      // Same analyzer inputs the full analysis job uses, so a matching verdict
      // here means re-analysis would store the same tags.
      const analysis = analyzeManiaPatterns(map, {
        totalLength: map.totalLength > 0 ? map.totalLength / 1000 : undefined,
        version: map.version,
      });
      const storedTags = [...new Set((stored.patterns ?? []).map((hit) => String(hit?.id ?? "")))].sort();
      const freshTags = [...new Set(analysis.patterns.map((hit) => hit.id))].sort();
      const storedCategory = stored.category ?? null;
      const freshCategory = analysis.primary?.label ?? null;
      if (storedTags.join(",") !== freshTags.join(",") || storedCategory !== freshCategory) {
        changed.push(beatmapId);
      }
    } catch {
      // A chart the analyzer rejects keeps its stored verdict; the full
      // analysis job would fail the same way.
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  return { nextCursor, scanned: rows.length, changed, done: rows.length < limit };
}

export async function ensureLnSubtypeRecomputeSeeded(db: Db, queue: JobQueue): Promise<void> {
  const done = (await exec(db, "select 1 from live_meta where key = ? limit 1", [LN_SUBTYPE_META_KEY])).rows[0];
  if (done) return;
  const pending = (await exec(
    db,
    "select 1 from jobs where type = ? and status in ('queued', 'running', 'failed', 'deferred_pressure') limit 1",
    [LN_SUBTYPE_RECOMPUTE_JOB],
  )).rows[0];
  if (pending) return;
  await enqueueLnSubtypeRecompute(queue, 0);
}

export async function runLnSubtypeRecomputeJob(db: Db, queue: JobQueue, payload: { cursor?: number } | undefined): Promise<void> {
  const cursor = Math.max(0, Math.floor(Number(payload?.cursor ?? 0)));
  const result = await recomputeLnSubtypeChunk(db, cursor);
  // Each re-analysis upserts its own search-index row on completion, so the
  // refreshed tags reach /maps without a full index rebuild. Collections key
  // off the primary family, which the subtags don't change - no rebuild needed.
  for (const beatmapId of result.changed) await enqueueChartAnalysis(queue, beatmapId);
  if (result.done) {
    const now = nowIso();
    await exec(
      db,
      "insert or replace into live_meta (key, value_json, updated_at) values (?, ?, ?)",
      [LN_SUBTYPE_META_KEY, json({ finishedAt: now }), now],
    );
    return;
  }
  await enqueueLnSubtypeRecompute(queue, result.nextCursor);
}

async function enqueueLnSubtypeRecompute(queue: JobQueue, cursor: number): Promise<void> {
  await queue.enqueue(
    LN_SUBTYPE_RECOMPUTE_JOB,
    `${LN_SUBTYPE_RECOMPUTE_JOB}:${cursor}`,
    { cursor },
    { priority: -10, replaceDone: true },
  );
}

// One-shot sweep re-analyzing the charts whose RC verdict changed when
// Companella was wired (dan/companella.ts). Mixed reaches for Companella on 4K
// charts whose mode tag is not RC and whose Sunny star is under 9; everything
// stored before the wiring carries the Sunny fallback there instead.
//
// Unlike the other sweeps this needs no .osu read and no re-run of the
// analyzer: the gate is a pure function of two values already in
// classification_json. `modeTagFromLnRatio` in mixedEstimator.js returns "RC"
// at lnRatio <= 0.15, and Mixed only builds a Companella plan outside that,
// under 9 stars, on 4K. So the SQL below *is* the predicate, verified against
// classifyChart's companellaPending over 500 stored 4K rows with zero false
// negatives (2026-08-02). A null sunnySr means Mixed produced no star and no
// plan, and NULL < 9 already excludes it.
//
// This is deliberately a targeted sweep rather than a CHART_ANALYSIS_VERSION
// bump: bumping would hide all ~122k stored rows at once, blanking the
// analysis-derived columns in /maps and, worse, opening farm-helper's DT
// feasibility gate (readDtRateMsd finds no row and the chart passes) until the
// backfill caught up. 6K/7K charts cannot change here at all.
export const COMPANELLA_RECOMPUTE_JOB = "recompute_companella_sweep";
const COMPANELLA_META_KEY = "companella_recompute_done:v1";
const COMPANELLA_CHUNK = 200;
const COMPANELLA_MODE_TAG_MIN_LN_RATIO = 0.15;
const COMPANELLA_MAX_SUNNY_STAR = 9;

export interface CompanellaRecomputeChunkResult {
  nextCursor: number;
  scanned: number;
  changed: number[];
  done: boolean;
}

export async function recomputeCompanellaChunk(
  db: Db,
  cursor: number,
  limit = COMPANELLA_CHUNK,
): Promise<CompanellaRecomputeChunkResult> {
  const rows = (await exec(
    db,
    `select beatmap_id
     from beatmap_chart_analysis
     where analysis_version = ? and status = 'ready' and key_count = 4
       and json_extract(classification_json, '$.lnRatio') > ?
       and json_extract(classification_json, '$.sunnySr') < ?
       and beatmap_id > ?
     order by beatmap_id
     limit ?`,
    [
      CHART_ANALYSIS_VERSION,
      COMPANELLA_MODE_TAG_MIN_LN_RATIO,
      COMPANELLA_MAX_SUNNY_STAR,
      Math.max(0, Math.floor(cursor)),
      Math.max(1, Math.floor(limit)),
    ],
  )).rows;

  let nextCursor = cursor;
  const changed: number[] = [];
  for (const row of rows) {
    const beatmapId = Number(row.beatmap_id);
    nextCursor = Math.max(nextCursor, beatmapId);
    changed.push(beatmapId);
  }

  return { nextCursor, scanned: rows.length, changed, done: rows.length < limit };
}

export async function ensureCompanellaRecomputeSeeded(db: Db, queue: JobQueue): Promise<void> {
  const done = (await exec(db, "select 1 from live_meta where key = ? limit 1", [COMPANELLA_META_KEY])).rows[0];
  if (done) return;
  const pending = (await exec(
    db,
    "select 1 from jobs where type = ? and status in ('queued', 'running', 'failed', 'deferred_pressure') limit 1",
    [COMPANELLA_RECOMPUTE_JOB],
  )).rows[0];
  if (pending) return;
  await enqueueCompanellaRecompute(queue, 0);
}

export async function runCompanellaRecomputeJob(
  db: Db,
  queue: JobQueue,
  payload: { cursor?: number } | undefined,
): Promise<void> {
  const cursor = Math.max(0, Math.floor(Number(payload?.cursor ?? 0)));
  const result = await recomputeCompanellaChunk(db, cursor);
  // Each re-analysis upserts its own search-index row, so refreshed verdicts
  // reach /maps without a full index rebuild.
  for (const beatmapId of result.changed) await enqueueChartAnalysis(queue, beatmapId);
  if (result.done) {
    const now = nowIso();
    await exec(
      db,
      "insert or replace into live_meta (key, value_json, updated_at) values (?, ?, ?)",
      [COMPANELLA_META_KEY, json({ finishedAt: now }), now],
    );
    return;
  }
  await enqueueCompanellaRecompute(queue, result.nextCursor);
}

async function enqueueCompanellaRecompute(queue: JobQueue, cursor: number): Promise<void> {
  await queue.enqueue(
    COMPANELLA_RECOMPUTE_JOB,
    `${COMPANELLA_RECOMPUTE_JOB}:${cursor}`,
    { cursor },
    { priority: -10, replaceDone: true },
  );
}

// One-shot sweep re-checking stored chordjack-tagged verdicts against the
// column-overlap-gated analyzer: dense bracket/jumpstream files used to mint
// chordjack tags off chord density alone. Same playbook as the LN subtype
// sweep - re-run the analyzer from the cached .osu, and where the verdict
// changed, enqueue a full re-analysis so the stored row and its search-index
// entry re-mint. Charts never tagged chordjack cannot lose or gain a tag from
// this change (the gate only ever lowers the chordjack family scores), so the
// LIKE filter bounds the scan to the affected rows.
export const CHORDJACK_TAG_RECOMPUTE_JOB = "recompute_chordjack_tag_sweep";
const CHORDJACK_TAG_META_KEY = "chordjack_tag_recompute_done:v1";
const CHORDJACK_TAG_CHUNK = 50;

export interface ChordjackTagChunkResult {
  nextCursor: number;
  scanned: number;
  changed: number[];
  done: boolean;
}

export async function recomputeChordjackTagChunk(
  db: Db,
  cursor: number,
  limit = CHORDJACK_TAG_CHUNK,
): Promise<ChordjackTagChunkResult> {
  const rows = (await exec(
    db,
    `select beatmap_id, classification_json
     from beatmap_chart_analysis
     where analysis_version = ? and status = 'ready'
       and classification_json like '%"chordjack"%'
       and beatmap_id > ?
     order by beatmap_id
     limit ?`,
    [CHART_ANALYSIS_VERSION, Math.max(0, Math.floor(cursor)), Math.max(1, Math.floor(limit))],
  )).rows;

  let nextCursor = cursor;
  const changed: number[] = [];
  for (const row of rows) {
    const beatmapId = Number(row.beatmap_id);
    nextCursor = Math.max(nextCursor, beatmapId);
    const stored = parseJson<Pick<LeanChartClassification, "category" | "patterns"> | null>(row.classification_json, null);
    if (!stored) continue;
    const osuText = await readCachedBeatmapFile(db, beatmapId).catch(() => null);
    if (!osuText) continue;
    try {
      const map = parseManiaBeatmap(osuText);
      // Same analyzer inputs the full analysis job uses, so a matching verdict
      // here means re-analysis would store the same tags.
      const analysis = analyzeManiaPatterns(map, {
        totalLength: map.totalLength > 0 ? map.totalLength / 1000 : undefined,
        version: map.version,
      });
      const storedTags = [...new Set((stored.patterns ?? []).map((hit) => String(hit?.id ?? "")))].sort();
      const freshTags = [...new Set(analysis.patterns.map((hit) => hit.id))].sort();
      const storedCategory = stored.category ?? null;
      const freshCategory = analysis.primary?.label ?? null;
      if (storedTags.join(",") !== freshTags.join(",") || storedCategory !== freshCategory) {
        changed.push(beatmapId);
      }
    } catch {
      // A chart the analyzer rejects keeps its stored verdict; the full
      // analysis job would fail the same way.
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  return { nextCursor, scanned: rows.length, changed, done: rows.length < limit };
}

export async function ensureChordjackTagRecomputeSeeded(db: Db, queue: JobQueue): Promise<void> {
  const done = (await exec(db, "select 1 from live_meta where key = ? limit 1", [CHORDJACK_TAG_META_KEY])).rows[0];
  if (done) return;
  const pending = (await exec(
    db,
    "select 1 from jobs where type = ? and status in ('queued', 'running', 'failed', 'deferred_pressure') limit 1",
    [CHORDJACK_TAG_RECOMPUTE_JOB],
  )).rows[0];
  if (pending) return;
  await enqueueChordjackTagRecompute(queue, 0);
}

export async function runChordjackTagRecomputeJob(db: Db, queue: JobQueue, payload: { cursor?: number } | undefined): Promise<void> {
  const cursor = Math.max(0, Math.floor(Number(payload?.cursor ?? 0)));
  const result = await recomputeChordjackTagChunk(db, cursor);
  // Each re-analysis upserts its own search-index row on completion, so the
  // refreshed tags reach /maps without a full index rebuild.
  for (const beatmapId of result.changed) await enqueueChartAnalysis(queue, beatmapId);
  if (result.done) {
    const now = nowIso();
    await exec(
      db,
      "insert or replace into live_meta (key, value_json, updated_at) values (?, ?, ?)",
      [CHORDJACK_TAG_META_KEY, json({ finishedAt: now }), now],
    );
    return;
  }
  await enqueueChordjackTagRecompute(queue, result.nextCursor);
}

async function enqueueChordjackTagRecompute(queue: JobQueue, cursor: number): Promise<void> {
  await queue.enqueue(
    CHORDJACK_TAG_RECOMPUTE_JOB,
    `${CHORDJACK_TAG_RECOMPUTE_JOB}:${cursor}`,
    { cursor },
    { priority: -10, replaceDone: true },
  );
}

// One-shot sweep re-checking stored bracket-tagged verdicts against the
// overlap-gated bracket detector: a chordjack chart's chords are bracket-shaped
// row by row, so dense CJ files used to mint saturated bracket tags (and
// "Bracket" primaries) off row shape alone. Same playbook as the chordjack tag
// sweep above - re-run the analyzer from the cached .osu, and where the verdict
// changed, enqueue a full re-analysis so the stored row and its search-index
// entry re-mint. The gate only ever lowers the bracket score, so charts never
// tagged bracket cannot change and the LIKE filter bounds the scan.
export const BRACKET_TAG_RECOMPUTE_JOB = "recompute_bracket_tag_sweep";
const BRACKET_TAG_META_KEY = "bracket_tag_recompute_done:v1";
const BRACKET_TAG_CHUNK = 50;

export interface BracketTagChunkResult {
  nextCursor: number;
  scanned: number;
  changed: number[];
  done: boolean;
}

export async function recomputeBracketTagChunk(
  db: Db,
  cursor: number,
  limit = BRACKET_TAG_CHUNK,
): Promise<BracketTagChunkResult> {
  const rows = (await exec(
    db,
    `select beatmap_id, classification_json
     from beatmap_chart_analysis
     where analysis_version = ? and status = 'ready'
       and key_count in (6, 7)
       and classification_json like '%"bracket"%'
       and beatmap_id > ?
     order by beatmap_id
     limit ?`,
    [CHART_ANALYSIS_VERSION, Math.max(0, Math.floor(cursor)), Math.max(1, Math.floor(limit))],
  )).rows;

  let nextCursor = cursor;
  const changed: number[] = [];
  for (const row of rows) {
    const beatmapId = Number(row.beatmap_id);
    nextCursor = Math.max(nextCursor, beatmapId);
    const stored = parseJson<Pick<LeanChartClassification, "category" | "patterns"> | null>(row.classification_json, null);
    if (!stored) continue;
    const osuText = await readCachedBeatmapFile(db, beatmapId).catch(() => null);
    if (!osuText) continue;
    try {
      const map = parseManiaBeatmap(osuText);
      // Same analyzer inputs the full analysis job uses, so a matching verdict
      // here means re-analysis would store the same tags.
      const analysis = analyzeManiaPatterns(map, {
        totalLength: map.totalLength > 0 ? map.totalLength / 1000 : undefined,
        version: map.version,
      });
      const storedTags = [...new Set((stored.patterns ?? []).map((hit) => String(hit?.id ?? "")))].sort();
      const freshTags = [...new Set(analysis.patterns.map((hit) => hit.id))].sort();
      const storedCategory = stored.category ?? null;
      const freshCategory = analysis.primary?.label ?? null;
      if (storedTags.join(",") !== freshTags.join(",") || storedCategory !== freshCategory) {
        changed.push(beatmapId);
      }
    } catch {
      // A chart the analyzer rejects keeps its stored verdict; the full
      // analysis job would fail the same way.
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  return { nextCursor, scanned: rows.length, changed, done: rows.length < limit };
}

export async function ensureBracketTagRecomputeSeeded(db: Db, queue: JobQueue): Promise<void> {
  const done = (await exec(db, "select 1 from live_meta where key = ? limit 1", [BRACKET_TAG_META_KEY])).rows[0];
  if (done) return;
  const pending = (await exec(
    db,
    "select 1 from jobs where type = ? and status in ('queued', 'running', 'failed', 'deferred_pressure') limit 1",
    [BRACKET_TAG_RECOMPUTE_JOB],
  )).rows[0];
  if (pending) return;
  await enqueueBracketTagRecompute(queue, 0);
}

export async function runBracketTagRecomputeJob(db: Db, queue: JobQueue, payload: { cursor?: number } | undefined): Promise<void> {
  const cursor = Math.max(0, Math.floor(Number(payload?.cursor ?? 0)));
  const result = await recomputeBracketTagChunk(db, cursor);
  // Each re-analysis upserts its own search-index row on completion, so the
  // refreshed tags reach /maps without a full index rebuild.
  for (const beatmapId of result.changed) await enqueueChartAnalysis(queue, beatmapId);
  if (result.done) {
    const now = nowIso();
    await exec(
      db,
      "insert or replace into live_meta (key, value_json, updated_at) values (?, ?, ?)",
      [BRACKET_TAG_META_KEY, json({ finishedAt: now }), now],
    );
    return;
  }
  await enqueueBracketTagRecompute(queue, result.nextCursor);
}

async function enqueueBracketTagRecompute(queue: JobQueue, cursor: number): Promise<void> {
  await queue.enqueue(
    BRACKET_TAG_RECOMPUTE_JOB,
    `${BRACKET_TAG_RECOMPUTE_JOB}:${cursor}`,
    { cursor },
    { priority: -10, replaceDone: true },
  );
}

// ── One-shot rate-adjusted (DT / 1.5x) analysis sweep ─────────────────────────
// Stored analysis is 1.0x only, so the farm helper's feasibility gate can only
// screen normal-speed recs; DT recs bypass it and far-too-hard-under-1.5x maps
// slip through. This boot-seeded chunked sweep computes 1.5x MSD (and a lean dan
// verdict) for the 4K and 7K charts that are actually DT-farmed, storing them in
// the msd_dt_json / dan_dt_json columns so the gate can screen DT recs too. Same
// playbook as the vibro sweep above: chunked, self-chaining, boot-seeded, done in
// live_meta. Purely local work (cached .osu corpus), no osu! API.
// v2: the v1 sweep was 4K-only; the bump reseeds it so 7K charts backfill (4K
// rows already carrying msd_dt_json are skipped by the null filter).

export const DT_RATE_ANALYSIS_JOB = "recompute_dt_rate_analysis_sweep";
const DT_RATE_ANALYSIS_META_KEY = "dt_rate_analysis_done:v2";
const DT_RATE_ANALYSIS_CHUNK = 40;
const DT_RATE = 1.5;

export interface DtRateAnalysisChunkResult {
  nextCursor: number;
  scanned: number;
  computed: number[];
  done: boolean;
}

export async function recomputeDtRateChunk(
  db: Db,
  cursor: number,
  limit = DT_RATE_ANALYSIS_CHUNK,
): Promise<DtRateAnalysisChunkResult> {
  // Correlated EXISTS (indexed seek on country_maps_farmed_scores.beatmap_id per
  // candidate) instead of `in (select ... where mods_json like ...)`: the latter
  // is a full LIKE scan of the ~1.4M-row farmed table on every chunk (~3-7s
  // synchronous, i.e. a worker event-loop stall each tick). The EXISTS form seeks
  // the (beatmap_id, ...) index and stays sub-second. beatmap_id is unique per
  // (beatmap_id, analysis_version), so no DISTINCT is needed.
  const rows = (await exec(
    db,
    `select a.beatmap_id as beatmap_id
     from beatmap_chart_analysis a
     where a.analysis_version = ? and a.status = 'ready'
       and a.key_count in (4, 7) and a.msd_dt_json is null
       and a.beatmap_id > ?
       and exists (
         select 1 from country_maps_farmed_scores f
         where f.beatmap_id = a.beatmap_id
           and (f.mods_json like '%"DT"%' or f.mods_json like '%"NC"%')
       )
     order by a.beatmap_id
     limit ?`,
    [CHART_ANALYSIS_VERSION, Math.max(0, Math.floor(cursor)), Math.max(1, Math.floor(limit))],
  )).rows;

  let nextCursor = cursor;
  const computed: number[] = [];
  for (const row of rows) {
    const beatmapId = Number(row.beatmap_id);
    nextCursor = Math.max(nextCursor, beatmapId);
    const osuText = await readCachedBeatmapFile(db, beatmapId).catch(() => null);
    if (!osuText) continue;
    try {
      const map = parseManiaBeatmap(osuText);
      // The .osu is the truth for the keymode; a stored key_count the parser
      // disagrees with keeps its null DT columns.
      if (map.keyCount !== 4 && map.keyCount !== 7) continue;
      const starRating = Number((await exec(
        db,
        "select difficulty_rating from beatmaps where beatmap_id = ? limit 1",
        [beatmapId],
      )).rows[0]?.difficulty_rating ?? 0);
      // The classifier and MinaCalc are the CPU bursts; yield between them and
      // between charts so ingest/SSE keep moving. MinaCalc rates 4K and 7K the
      // same way at 1.5x as it does at 1.0x (musicRate passes straight through).
      // MSD leads so Companella can reuse it instead of running MinaCalc twice.
      const msd = await computeMsd(osuText, { keyCount: map.keyCount, rate: DT_RATE }).catch(() => null);
      if (!msd) continue;
      await new Promise<void>((resolve) => setImmediate(resolve));
      const classification = await classifyChartWithCompanella(map, osuText, {
        rate: DT_RATE,
        starRating: Number.isFinite(starRating) && starRating > 0 ? starRating : undefined,
        totalLength: map.totalLength > 0 ? map.totalLength / 1000 : undefined,
        version: map.version,
      }, { msdValues: msd.values });

      const lean = leanClassification(classification);
      const danDt = {
        primaryLabel: lean.primary?.displayName ?? null,
        primaryFamily: lean.primary ? (lean.primary.kind === "ln" ? "ln" : "dan") : null,
        rawDan: lean.primary?.rawDan ?? null,
      };
      await exec(
        db,
        `update beatmap_chart_analysis
         set msd_dt_json = json(?), dan_dt_json = json(?)
         where beatmap_id = ? and analysis_version = ?`,
        [json(msd), json(danDt), beatmapId, CHART_ANALYSIS_VERSION],
      );
      computed.push(beatmapId);
    } catch {
      // A chart the parser/estimator rejects keeps its null DT columns; the full
      // analysis job (at 1.0x) would fail the same way.
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  return { nextCursor, scanned: rows.length, computed, done: rows.length < limit };
}

// Boot watchdog: seed the sweep once per meta-key version, resume if a chain
// died mid-way (each chunk's job carries its own cursor dedupe key).
export async function ensureDtRateAnalysisSeeded(db: Db, queue: JobQueue): Promise<void> {
  const done = (await exec(db, "select 1 from live_meta where key = ? limit 1", [DT_RATE_ANALYSIS_META_KEY])).rows[0];
  if (done) return;
  const pending = (await exec(
    db,
    "select 1 from jobs where type = ? and status in ('queued', 'running', 'failed', 'deferred_pressure') limit 1",
    [DT_RATE_ANALYSIS_JOB],
  )).rows[0];
  if (pending) return;
  await enqueueDtRateAnalysis(queue, 0);
}

export async function runDtRateAnalysisJob(db: Db, queue: JobQueue, payload: { cursor?: number } | undefined): Promise<void> {
  const cursor = Math.max(0, Math.floor(Number(payload?.cursor ?? 0)));
  const result = await recomputeDtRateChunk(db, cursor);
  if (result.done) {
    const now = nowIso();
    await exec(
      db,
      "insert or replace into live_meta (key, value_json, updated_at) values (?, ?, ?)",
      [DT_RATE_ANALYSIS_META_KEY, json({ finishedAt: now }), now],
    );
    return;
  }
  await enqueueDtRateAnalysis(queue, result.nextCursor);
}

async function enqueueDtRateAnalysis(queue: JobQueue, cursor: number): Promise<void> {
  await queue.enqueue(
    DT_RATE_ANALYSIS_JOB,
    `${DT_RATE_ANALYSIS_JOB}:${cursor}`,
    { cursor },
    { priority: -10, replaceDone: true },
  );
}

// ── One-shot LN-tail MSD backfill sweep ──────────────────────────────────────
// Stored analyses predate msd_ln_json; this backfills the tail-aware MSD for
// every ready hold-bearing chart from the cached .osu corpus so map pages can
// show LN-adjusted MSD. Same playbook as the DT sweep: chunked, self-chaining,
// boot-seeded, done-key in live_meta. Purely local work, no osu! API.

export const LN_MSD_SWEEP_JOB = "recompute_ln_msd_sweep";
const LN_MSD_SWEEP_META_KEY = "ln_msd_backfill_done:v1";
const LN_MSD_SWEEP_CHUNK = 40;

export interface LnMsdSweepChunkResult {
  nextCursor: number;
  scanned: number;
  computed: number[];
  done: boolean;
}

export async function recomputeLnMsdChunk(
  db: Db,
  cursor: number,
  limit = LN_MSD_SWEEP_CHUNK,
): Promise<LnMsdSweepChunkResult> {
  // The json_extract predicate cannot use an index, but the PK walk stops at
  // `limit` candidates, so each chunk's scan cost is proportional to the gap
  // between candidates (roughly every other ready row qualifies).
  const rows = (await exec(
    db,
    `select a.beatmap_id as beatmap_id, a.key_count as key_count
     from beatmap_chart_analysis a
     where a.analysis_version = ? and a.status = 'ready'
       and a.msd_json is not null and a.msd_ln_json is null
       and a.key_count in (4, 6, 7)
       and cast(json_extract(a.classification_json, '$.lnRatio') as real) > ?
       and a.beatmap_id > ?
     order by a.beatmap_id
     limit ?`,
    [CHART_ANALYSIS_VERSION, LN_TAIL_MIN_RATIO, Math.max(0, Math.floor(cursor)), Math.max(1, Math.floor(limit))],
  )).rows;

  let nextCursor = cursor;
  const computed: number[] = [];
  for (const row of rows) {
    const beatmapId = Number(row.beatmap_id);
    nextCursor = Math.max(nextCursor, beatmapId);
    const osuText = await readCachedBeatmapFile(db, beatmapId).catch(() => null);
    if (!osuText) continue;
    try {
      const msdLn = await computeMsd(osuText, { keyCount: Number(row.key_count), lnTailTaps: true }).catch(() => null);
      if (!msdLn) continue;
      await exec(
        db,
        `update beatmap_chart_analysis set msd_ln_json = json(?)
         where beatmap_id = ? and analysis_version = ?`,
        [json(msdLn), beatmapId, CHART_ANALYSIS_VERSION],
      );
      computed.push(beatmapId);
    } catch {
      // A chart the calc rejects keeps its null column; the map page falls
      // back to the base MSD.
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  return { nextCursor, scanned: rows.length, computed, done: rows.length < limit };
}

export async function ensureLnMsdSweepSeeded(db: Db, queue: JobQueue): Promise<void> {
  const done = (await exec(db, "select 1 from live_meta where key = ? limit 1", [LN_MSD_SWEEP_META_KEY])).rows[0];
  if (done) return;
  const pending = (await exec(
    db,
    "select 1 from jobs where type = ? and status in ('queued', 'running', 'failed', 'deferred_pressure') limit 1",
    [LN_MSD_SWEEP_JOB],
  )).rows[0];
  if (pending) return;
  await enqueueLnMsdSweep(queue, 0);
}

export async function runLnMsdSweepJob(db: Db, queue: JobQueue, payload: { cursor?: number } | undefined): Promise<void> {
  const cursor = Math.max(0, Math.floor(Number(payload?.cursor ?? 0)));
  const result = await recomputeLnMsdChunk(db, cursor);
  if (result.computed.length > 0) {
    // The sweep updates the analysis row in place, so the map_search_index
    // copy of msd_ln_json goes stale without a per-row refresh. Dynamic import
    // keeps the static graph acyclic (map-search imports this module).
    await import("./map-search.js")
      .then(async (module) => {
        for (const beatmapId of result.computed) {
          await module.upsertMapSearchIndexRow(db, beatmapId);
        }
      })
      .catch(() => {});
  }
  if (result.done) {
    const now = nowIso();
    await exec(
      db,
      "insert or replace into live_meta (key, value_json, updated_at) values (?, ?, ?)",
      [LN_MSD_SWEEP_META_KEY, json({ finishedAt: now }), now],
    );
    return;
  }
  await enqueueLnMsdSweep(queue, result.nextCursor);
}

async function enqueueLnMsdSweep(queue: JobQueue, cursor: number): Promise<void> {
  await queue.enqueue(
    LN_MSD_SWEEP_JOB,
    `${LN_MSD_SWEEP_JOB}:${cursor}`,
    { cursor },
    { priority: -10, replaceDone: true },
  );
}

// ── One-shot 4K LN estimate sweep ────────────────────────────────────────────
// The LN kNN's reference set was extended with the curated benchmark corpus
// (dan-estimator/ln.ts): out-of-corpus charts previously fell through to the
// ln-pressure regression, which over-rates them (ranked LN charts reading a
// dan high). Stored analyses whose LN half came from the kNN predate the new
// anchors. Same playbook as the sweeps above: a boot-seeded chunked job
// recomputes the cheap kNN half for each candidate; unchanged verdicts are
// skipped, the rest re-enqueue the full analysis job after refreshing their DT
// dan verdict inline, because the full job never touches the DT columns.
// Purely local work, no osu! API.

export const LN_SOURCE_RECOMPUTE_JOB = "recompute_ln_estimate_sweep";
const LN_SOURCE_META_KEY = "ln_estimate_recompute_done:v1";
const LN_SOURCE_CHUNK = 40;

export interface LnSourceChunkResult {
  nextCursor: number;
  scanned: number;
  changed: number[];
  done: boolean;
}

export async function recomputeLnSourceChunk(
  db: Db,
  cursor: number,
  limit = LN_SOURCE_CHUNK,
): Promise<LnSourceChunkResult> {
  const rows = (await exec(
    db,
    `select beatmap_id, classification_json, dan_dt_json is not null as has_dt
     from beatmap_chart_analysis
     where analysis_version = ? and status = 'ready'
       and key_count = 4
       and json_extract(classification_json, '$.ln.source') = 'inhouse-ln-knn'
       and beatmap_id > ?
     order by beatmap_id
     limit ?`,
    [CHART_ANALYSIS_VERSION, Math.max(0, Math.floor(cursor)), Math.max(1, Math.floor(limit))],
  )).rows;

  let nextCursor = cursor;
  const changed: number[] = [];
  for (const row of rows) {
    const beatmapId = Number(row.beatmap_id);
    nextCursor = Math.max(nextCursor, beatmapId);
    const stored = parseJson<Pick<LeanChartClassification, "ln"> | null>(row.classification_json, null);
    const storedLn = stored?.ln?.displayName ?? null;
    const osuText = await readCachedBeatmapFile(db, beatmapId).catch(() => null);
    if (!osuText || !storedLn) continue;
    try {
      const map = parseManiaBeatmap(osuText);
      // The candidate SQL above is 4K-scoped (the LN kNN corpus extension was a
      // 4K change); this parse re-check only rejects files that disagree with
      // the stored key_count, and matches the DT sweep's 4K/7K coverage so the
      // inline dan_dt refresh below never hardcodes a keymode.
      if (map.keyCount !== 4 && map.keyCount !== 7) continue;
      // Recompute just the kNN half with the same inputs the full analysis job
      // uses; a matching verdict means re-analysis would store the same thing.
      const starRating = Number((await exec(
        db,
        "select difficulty_rating from beatmaps where beatmap_id = ? limit 1",
        [beatmapId],
      )).rows[0]?.difficulty_rating ?? 0);
      const input = {
        totalLength: map.totalLength > 0 ? map.totalLength / 1000 : undefined,
        version: map.version,
        starRating: Number.isFinite(starRating) && starRating > 0 ? starRating : undefined,
      };
      const features = extractDanFeatures(map, input, 1);
      const fresh = estimateLnDan(
        map,
        input,
        features.metrics,
        Number.isFinite(starRating) && starRating > 0 ? starRating : 0,
        features.durationMs,
        1,
      );
      if (fresh && `${fresh.label}${fresh.variant ?? ""}` === storedLn) continue;
      // Refresh the DT dan verdict before the full analysis job runs, so its
      // search-index upsert reads current DT columns.
      if (Number(row.has_dt)) {
        const classification = await classifyChartWithCompanella(map, osuText, {
          rate: DT_RATE,
          starRating: Number.isFinite(starRating) && starRating > 0 ? starRating : undefined,
          totalLength: map.totalLength > 0 ? map.totalLength / 1000 : undefined,
          version: map.version,
        });
        const danDt = {
          primaryLabel: classification.primary?.displayName ?? null,
          primaryFamily: classification.primary ? (classification.primary.kind === "ln" ? "ln" : "dan") : null,
          rawDan: classification.primary?.rawDan ?? null,
        };
        await exec(
          db,
          `update beatmap_chart_analysis
           set dan_dt_json = json(?)
           where beatmap_id = ? and analysis_version = ?`,
          [json(danDt), beatmapId, CHART_ANALYSIS_VERSION],
        );
      }
      changed.push(beatmapId);
    } catch {
      // A chart the parser/estimator rejects keeps its stored verdict; the full
      // analysis job would fail the same way.
    }
    // The feature extraction / DT classifier run is the CPU burst; yield
    // between charts like the sweeps above.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  return { nextCursor, scanned: rows.length, changed, done: rows.length < limit };
}

export async function ensureLnSourceRecomputeSeeded(db: Db, queue: JobQueue): Promise<void> {
  const done = (await exec(db, "select 1 from live_meta where key = ? limit 1", [LN_SOURCE_META_KEY])).rows[0];
  if (done) return;
  const pending = (await exec(
    db,
    "select 1 from jobs where type = ? and status in ('queued', 'running', 'failed', 'deferred_pressure') limit 1",
    [LN_SOURCE_RECOMPUTE_JOB],
  )).rows[0];
  if (pending) return;
  await enqueueLnSourceRecompute(queue, 0);
}

export async function runLnSourceRecomputeJob(db: Db, queue: JobQueue, payload: { cursor?: number } | undefined): Promise<void> {
  const cursor = Math.max(0, Math.floor(Number(payload?.cursor ?? 0)));
  const result = await recomputeLnSourceChunk(db, cursor);
  // Re-analysis jobs run at higher priority than this sweep and upsert their
  // search-index row on completion, same as the floor-pin sweep.
  for (const beatmapId of result.changed) await enqueueChartAnalysis(queue, beatmapId);
  if (result.done) {
    const now = nowIso();
    await exec(
      db,
      "insert or replace into live_meta (key, value_json, updated_at) values (?, ?, ?)",
      [LN_SOURCE_META_KEY, json({ finishedAt: now }), now],
    );
    // Re-verdicted charts must move between LN dan collections now, not on the
    // next scheduled rotation.
    await queue.enqueue("rebuild_map_collections", "rebuild_map_collections", {}, { priority: -12, replaceDone: true });
    return;
  }
  await enqueueLnSourceRecompute(queue, result.nextCursor);
}

async function enqueueLnSourceRecompute(queue: JobQueue, cursor: number): Promise<void> {
  await queue.enqueue(
    LN_SOURCE_RECOMPUTE_JOB,
    `${LN_SOURCE_RECOMPUTE_JOB}:${cursor}`,
    { cursor },
    { priority: -10, replaceDone: true },
  );
}

// One-shot full-corpus re-analysis after the leoblack re-pin at upstream
// 261e76f: Sunny SR now matches the authoritative C# osu-author-port
// (exact-match step interpolation, LN tails in the percentile weights, first
// note dropped), so every stored sunnySr is slightly stale and verdicts near
// interval boundaries can move; hold-bearing charts move the most. No inline
// diff pass: the SR shift touches every row, so each chunk enqueues a full
// re-analysis per ready row and priority ordering paces the whole run - the
// analysis jobs (priority 4) drain ahead of the continuation chunk (priority
// -10) in the same worker lane, so the queue never holds much more than one
// chunk of sweep work at a time.
//
// Same reasoning as the Companella sweep for staying off a
// CHART_ANALYSIS_VERSION bump: hiding every stored row at once would blank
// the analysis-derived columns in /maps and open farm-helper's DT
// feasibility gate until the backfill caught up.
export const SUNNY_REPIN_RECOMPUTE_JOB = "recompute_sunny_repin_sweep";
const SUNNY_REPIN_META_KEY = "sunny_repin_recompute_done:v1";
const SUNNY_REPIN_CHUNK = 200;

export interface SunnyRepinRecomputeChunkResult {
  nextCursor: number;
  scanned: number;
  changed: number[];
  done: boolean;
}

export async function recomputeSunnyRepinChunk(
  db: Db,
  cursor: number,
  limit = SUNNY_REPIN_CHUNK,
): Promise<SunnyRepinRecomputeChunkResult> {
  const rows = (await exec(
    db,
    `select beatmap_id
     from beatmap_chart_analysis
     where analysis_version = ? and status = 'ready'
       and beatmap_id > ?
     order by beatmap_id
     limit ?`,
    [CHART_ANALYSIS_VERSION, Math.max(0, Math.floor(cursor)), Math.max(1, Math.floor(limit))],
  )).rows;

  let nextCursor = cursor;
  const changed: number[] = [];
  for (const row of rows) {
    const beatmapId = Number(row.beatmap_id);
    nextCursor = Math.max(nextCursor, beatmapId);
    changed.push(beatmapId);
  }

  return { nextCursor, scanned: rows.length, changed, done: rows.length < limit };
}

export async function ensureSunnyRepinRecomputeSeeded(db: Db, queue: JobQueue): Promise<void> {
  const done = (await exec(db, "select 1 from live_meta where key = ? limit 1", [SUNNY_REPIN_META_KEY])).rows[0];
  if (done) return;
  const pending = (await exec(
    db,
    "select 1 from jobs where type = ? and status in ('queued', 'running', 'failed', 'deferred_pressure') limit 1",
    [SUNNY_REPIN_RECOMPUTE_JOB],
  )).rows[0];
  if (pending) return;
  await enqueueSunnyRepinRecompute(queue, 0);
}

export async function runSunnyRepinRecomputeJob(
  db: Db,
  queue: JobQueue,
  payload: { cursor?: number } | undefined,
): Promise<void> {
  const cursor = Math.max(0, Math.floor(Number(payload?.cursor ?? 0)));
  const result = await recomputeSunnyRepinChunk(db, cursor);
  // Each re-analysis upserts its own search-index row, so refreshed verdicts
  // reach /maps without a full index rebuild.
  for (const beatmapId of result.changed) await enqueueChartAnalysis(queue, beatmapId);
  if (result.done) {
    const now = nowIso();
    await exec(
      db,
      "insert or replace into live_meta (key, value_json, updated_at) values (?, ?, ?)",
      [SUNNY_REPIN_META_KEY, json({ finishedAt: now }), now],
    );
    // Re-verdicted charts must move between dan collections now, not on the
    // next scheduled rotation.
    await queue.enqueue("rebuild_map_collections", "rebuild_map_collections", {}, { priority: -12, replaceDone: true });
    return;
  }
  await enqueueSunnyRepinRecompute(queue, result.nextCursor);
}

async function enqueueSunnyRepinRecompute(queue: JobQueue, cursor: number): Promise<void> {
  await queue.enqueue(
    SUNNY_REPIN_RECOMPUTE_JOB,
    `${SUNNY_REPIN_RECOMPUTE_JOB}:${cursor}`,
    { cursor },
    { priority: -10, replaceDone: true },
  );
}

// DT-verdict companion to the sunny re-pin sweep above. The main sweep's full
// re-analysis deliberately preserves the DT columns, which is right for
// msd_dt_json (pure MinaCalc, unchanged by the re-pin) but leaves dan_dt_json
// (the 1.5x lean dan verdict, Sunny-derived) at pre-re-pin values, and the
// DT-rate sweep never returns to a row that already carries msd_dt_json. This
// sweep walks exactly those rows and re-derives just the verdict, feeding the
// stored 1.5x MSD into the classifier instead of re-running MinaCalc, so each
// chart costs one classifier pass. Consumers: the DT-play dan credit in
// player-skills and the DT verdict on /maps cards.
export const SUNNY_REPIN_DT_RECOMPUTE_JOB = "recompute_sunny_repin_dt_sweep";
const SUNNY_REPIN_DT_META_KEY = "sunny_repin_dt_recompute_done:v1";
const SUNNY_REPIN_DT_CHUNK = 40;

export interface SunnyRepinDtChunkResult {
  nextCursor: number;
  scanned: number;
  computed: number[];
  done: boolean;
}

export async function recomputeSunnyRepinDtChunk(
  db: Db,
  cursor: number,
  limit = SUNNY_REPIN_DT_CHUNK,
): Promise<SunnyRepinDtChunkResult> {
  const rows = (await exec(
    db,
    `select beatmap_id, msd_dt_json
     from beatmap_chart_analysis
     where analysis_version = ? and status = 'ready'
       and dan_dt_json is not null
       and beatmap_id > ?
     order by beatmap_id
     limit ?`,
    [CHART_ANALYSIS_VERSION, Math.max(0, Math.floor(cursor)), Math.max(1, Math.floor(limit))],
  )).rows;

  let nextCursor = cursor;
  const computed: number[] = [];
  for (const row of rows) {
    const beatmapId = Number(row.beatmap_id);
    nextCursor = Math.max(nextCursor, beatmapId);
    // A row with a verdict but unusable stored MSD keeps its stored verdict:
    // re-running MinaCalc here would defeat the point of the cheap pass, and
    // such a row is already invisible to readDtRateMsd's null filter.
    const storedMsd = parseJson<{ values?: Record<string, number> } | null>(String(row.msd_dt_json ?? ""), null);
    const msdValues = storedMsd?.values;
    if (!msdValues || typeof msdValues !== "object") continue;
    const osuText = await readCachedBeatmapFile(db, beatmapId).catch(() => null);
    if (!osuText) continue;
    try {
      const map = parseManiaBeatmap(osuText);
      if (map.keyCount !== 4 && map.keyCount !== 7) continue;
      const starRating = Number((await exec(
        db,
        "select difficulty_rating from beatmaps where beatmap_id = ? limit 1",
        [beatmapId],
      )).rows[0]?.difficulty_rating ?? 0);
      // Same inputs as the DT-rate sweep's mint, so the verdict differs only
      // through the re-pinned estimator code.
      const classification = await classifyChartWithCompanella(map, osuText, {
        rate: DT_RATE,
        starRating: Number.isFinite(starRating) && starRating > 0 ? starRating : undefined,
        totalLength: map.totalLength > 0 ? map.totalLength / 1000 : undefined,
        version: map.version,
      }, { msdValues });

      const lean = leanClassification(classification);
      const danDt = {
        primaryLabel: lean.primary?.displayName ?? null,
        primaryFamily: lean.primary ? (lean.primary.kind === "ln" ? "ln" : "dan") : null,
        rawDan: lean.primary?.rawDan ?? null,
      };
      await exec(
        db,
        `update beatmap_chart_analysis
         set dan_dt_json = json(?)
         where beatmap_id = ? and analysis_version = ?`,
        [json(danDt), beatmapId, CHART_ANALYSIS_VERSION],
      );
      computed.push(beatmapId);
    } catch {
      // A chart the parser/estimator rejects keeps its stored verdict; the
      // DT-rate sweep would have failed the same way.
    }
    // The classifier run is the CPU burst; yield between charts like the
    // sweeps above so ingest/SSE keep moving.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  return { nextCursor, scanned: rows.length, computed, done: rows.length < limit };
}

export async function ensureSunnyRepinDtRecomputeSeeded(db: Db, queue: JobQueue): Promise<void> {
  const done = (await exec(db, "select 1 from live_meta where key = ? limit 1", [SUNNY_REPIN_DT_META_KEY])).rows[0];
  if (done) return;
  const pending = (await exec(
    db,
    "select 1 from jobs where type = ? and status in ('queued', 'running', 'failed', 'deferred_pressure') limit 1",
    [SUNNY_REPIN_DT_RECOMPUTE_JOB],
  )).rows[0];
  if (pending) return;
  await enqueueSunnyRepinDtRecompute(queue, 0);
}

export async function runSunnyRepinDtRecomputeJob(
  db: Db,
  queue: JobQueue,
  payload: { cursor?: number } | undefined,
): Promise<void> {
  const cursor = Math.max(0, Math.floor(Number(payload?.cursor ?? 0)));
  const result = await recomputeSunnyRepinDtChunk(db, cursor);
  if (result.done) {
    const now = nowIso();
    await exec(
      db,
      "insert or replace into live_meta (key, value_json, updated_at) values (?, ?, ?)",
      [SUNNY_REPIN_DT_META_KEY, json({ finishedAt: now }), now],
    );
    return;
  }
  await enqueueSunnyRepinDtRecompute(queue, result.nextCursor);
}

async function enqueueSunnyRepinDtRecompute(queue: JobQueue, cursor: number): Promise<void> {
  await queue.enqueue(
    SUNNY_REPIN_DT_RECOMPUTE_JOB,
    `${SUNNY_REPIN_DT_RECOMPUTE_JOB}:${cursor}`,
    { cursor },
    { priority: -10, replaceDone: true },
  );
}

// One beatmap's stored 1.5x (DT-rate) MSD: the raw skillset vector in
// MSD_SKILLSETS order plus the sweep's own Overall (null when the stored
// JSON predates the Overall field or carries an invalid value).
export interface DtRateMsd {
  msd: number[];
  overall: number | null;
}

// Reads stored 1.5x MSD for the given beatmaps, as raw skillset vectors in
// MSD_SKILLSETS order (the farm helper's feasibility gate compares absolute
// values) plus the sweep's Overall (the accuracy model's DT difficulty axis).
// Rows without a valid msd_dt_json are skipped. Mirrors the normal-speed raw
// MSD read in farm-helper-shape.ts.
export async function readDtRateMsd(db: Db, beatmapIds: number[]): Promise<Map<number, DtRateMsd>> {
  const ids = [...new Set(beatmapIds.filter((id) => Number.isSafeInteger(id) && id > 0))];
  const result = new Map<number, DtRateMsd>();
  for (let i = 0; i < ids.length; i += 900) {
    const chunk = ids.slice(i, i + 900);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "?").join(",");
    const rows = (await exec(
      db,
      `select beatmap_id, msd_dt_json from beatmap_chart_analysis
       where analysis_version = ? and beatmap_id in (${placeholders}) and msd_dt_json is not null`,
      [CHART_ANALYSIS_VERSION, ...chunk],
    )).rows;
    for (const row of rows) {
      const beatmapId = Number(row.beatmap_id);
      if (!Number.isSafeInteger(beatmapId) || beatmapId <= 0) continue;
      const parsed = parseJson<{ values?: Record<string, number> }>(row.msd_dt_json, {});
      const values = parsed?.values;
      if (!values || typeof values !== "object") continue;
      const vector = MSD_SKILLSETS.map((skill) => Number(values[skill]));
      if (!vector.every((v) => Number.isFinite(v))) continue;
      const overall = Number(values.Overall);
      result.set(beatmapId, {
        msd: vector,
        overall: Number.isFinite(overall) && overall > 0 ? overall : null,
      });
    }
  }
  return result;
}

async function readAnalysisJobCounts(db: Db): Promise<{ queued: number; running: number; failed: number; deferred: number }> {
  const rows = (await exec(
    db,
    "select status, count(*) as count from jobs where type = ? group by status",
    [CHART_ANALYSIS_JOB],
  )).rows;
  const counts = { queued: 0, running: 0, failed: 0, deferred: 0 };
  for (const row of rows) {
    const status = String(row.status);
    const count = Number(row.count ?? 0);
    if (status === "queued") counts.queued += count;
    if (status === "running") counts.running += count;
    if (status === "failed") counts.failed += count;
    if (status === "deferred_pressure") counts.deferred += count;
  }
  return counts;
}

// ── One-shot MSD poisoning recovery sweep ────────────────────────────────────
// Recovery from the 2026-08-14 MinaCalc wasm poisoning: a raw wasm throw on
// beatmap 4038663 ("Hello (BPM) 2023" [4K] For SEXY CN Player Collab, 19.9
// stars) left the shared 4K calc instance corrupted from 2026-08-14T17:44Z
// until the eviction fix in vendor/leoblack/ett/calc.js, and every 4K MSD
// computed on it came back as the calc's resting floor: Stream, Jumpstream,
// Handstream, JackSpeed, Chordjack and Technical all identical (~9.63,
// Overall ~10.16). The analysis job feeds its MSD into Companella, so those
// rows' stored dan verdicts are junk too (the 7K/6K instance is a separate
// cached module and stayed healthy). Healthy computes never produce
// exactly-equal skillsets - the corpus-wide signature count matches the
// poisoned-window count - so the sweep keys on the stored values themselves
// instead of a time window: any ready row whose base or LN-tail MSD carries
// the signature gets a full re-analysis, and a re-run only ever finds newly
// poisoned rows. Same playbook as the sunny re-pin sweep above: chunked,
// self-chaining, boot-seeded, done in meta.
//
// DT columns need their own path: the full re-analysis a matched row gets
// deliberately preserves msd_dt_json / dan_dt_json, so a poisoned DT MSD would
// survive it. Rows whose DT MSD carries the signature get the 1.5x mint redone
// inline in the chunk (same mint as the DT-rate sweep above), and a chart the
// mint can no longer rate has its DT columns nulled rather than kept as junk.
export const MSD_POISON_RECOVERY_JOB = "recompute_msd_poison_sweep";
const MSD_POISON_RECOVERY_META_KEY = "msd_poison_recovery_done:v1";
const MSD_POISON_RECOVERY_CHUNK = 200;

// json_extract as a scan filter is fine here for the same reason as the
// note-BPM sweep above: chunked background work against a ~130k-row table.
function msdPoisonSignatureSql(column: string): string {
  return `(
    json_extract(${column}, '$.values.Stream') > 0
    and json_extract(${column}, '$.values.Stream') = json_extract(${column}, '$.values.Technical')
    and json_extract(${column}, '$.values.Stream') = json_extract(${column}, '$.values.Chordjack')
  )`;
}

export interface MsdPoisonRecoveryChunkResult {
  nextCursor: number;
  scanned: number;
  changed: number[];
  dtRecomputed: number[];
  done: boolean;
}

export async function recomputeMsdPoisonChunk(
  db: Db,
  cursor: number,
  limit = MSD_POISON_RECOVERY_CHUNK,
): Promise<MsdPoisonRecoveryChunkResult> {
  const rows = (await exec(
    db,
    `select beatmap_id,
       case when ${msdPoisonSignatureSql("msd_json")} or ${msdPoisonSignatureSql("msd_ln_json")} then 1 else 0 end as base_poisoned,
       case when ${msdPoisonSignatureSql("msd_dt_json")} then 1 else 0 end as dt_poisoned
     from beatmap_chart_analysis
     where analysis_version = ? and status = 'ready'
       and beatmap_id > ?
       and (${msdPoisonSignatureSql("msd_json")} or ${msdPoisonSignatureSql("msd_ln_json")} or ${msdPoisonSignatureSql("msd_dt_json")})
     order by beatmap_id
     limit ?`,
    [CHART_ANALYSIS_VERSION, Math.max(0, Math.floor(cursor)), Math.max(1, Math.floor(limit))],
  )).rows;

  let nextCursor = cursor;
  const changed: number[] = [];
  const dtRecomputed: number[] = [];
  for (const row of rows) {
    const beatmapId = Number(row.beatmap_id);
    nextCursor = Math.max(nextCursor, beatmapId);
    if (Number(row.base_poisoned) === 1) changed.push(beatmapId);
    if (Number(row.dt_poisoned) === 1) {
      await recomputePoisonedDtColumns(db, beatmapId);
      dtRecomputed.push(beatmapId);
      // The mint is a MinaCalc plus classifier burst; yield between charts
      // like the DT-rate sweep so ingest/SSE keep moving. Poisoned DT rows
      // are rare (DT columns only exist on DT-farmed charts), so a chunk
      // stays overwhelmingly enqueue-only.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  return { nextCursor, scanned: rows.length, changed, dtRecomputed, done: rows.length < limit };
}

// Redo the 1.5x mint for one row whose stored DT MSD is the poisoned floor.
// Same inputs as the DT-rate sweep's mint; when the chart can no longer be
// rated (file gone, parser rejects it) the junk columns are nulled instead,
// which readDtRateMsd already treats as no data.
async function recomputePoisonedDtColumns(db: Db, beatmapId: number): Promise<void> {
  const clearDtColumns = () => exec(
    db,
    `update beatmap_chart_analysis
     set msd_dt_json = null, dan_dt_json = null
     where beatmap_id = ? and analysis_version = ?`,
    [beatmapId, CHART_ANALYSIS_VERSION],
  );

  const osuText = await readCachedBeatmapFile(db, beatmapId).catch(() => null);
  if (!osuText) {
    await clearDtColumns();
    return;
  }
  try {
    const map = parseManiaBeatmap(osuText);
    if (map.keyCount !== 4 && map.keyCount !== 7) {
      await clearDtColumns();
      return;
    }
    const starRating = Number((await exec(
      db,
      "select difficulty_rating from beatmaps where beatmap_id = ? limit 1",
      [beatmapId],
    )).rows[0]?.difficulty_rating ?? 0);
    const msd = await computeMsd(osuText, { keyCount: map.keyCount, rate: DT_RATE }).catch(() => null);
    if (!msd) {
      await clearDtColumns();
      return;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    const classification = await classifyChartWithCompanella(map, osuText, {
      rate: DT_RATE,
      starRating: Number.isFinite(starRating) && starRating > 0 ? starRating : undefined,
      totalLength: map.totalLength > 0 ? map.totalLength / 1000 : undefined,
      version: map.version,
    }, { msdValues: msd.values });

    const lean = leanClassification(classification);
    const danDt = {
      primaryLabel: lean.primary?.displayName ?? null,
      primaryFamily: lean.primary ? (lean.primary.kind === "ln" ? "ln" : "dan") : null,
      rawDan: lean.primary?.rawDan ?? null,
    };
    await exec(
      db,
      `update beatmap_chart_analysis
       set msd_dt_json = json(?), dan_dt_json = json(?)
       where beatmap_id = ? and analysis_version = ?`,
      [json(msd), json(danDt), beatmapId, CHART_ANALYSIS_VERSION],
    );
  } catch {
    await clearDtColumns();
  }
}

// Junk minted from poisoned MSD outside beatmap_chart_analysis has no stored
// signature to key on, so the incident window does the targeting for the
// one-shot cleanups that ride the seed below.
const MSD_POISON_WINDOW_START = "2026-08-14T17:44";

export async function ensureMsdPoisonRecoverySeeded(db: Db, queue: JobQueue): Promise<void> {
  const done = (await exec(db, "select 1 from live_meta where key = ? limit 1", [MSD_POISON_RECOVERY_META_KEY])).rows[0];
  if (done) return;
  const pending = (await exec(
    db,
    "select 1 from jobs where type = ? and status in ('queued', 'running', 'failed', 'deferred_pressure') limit 1",
    [MSD_POISON_RECOVERY_JOB],
  )).rows[0];
  if (pending) return;
  // Rows written after this boot come from a healthy instance; the upper
  // bound keeps them if anything computes between listen and this seed.
  const seededAt = nowIso();
  // v13 dan estimates minted in the window came from Companella reading the
  // floor MSD; a deleted row recomputes on the next request for it. The
  // version stays a literal: the incident happened at 13, and rows minted at
  // any later version postdate the fix.
  await exec(
    db,
    "delete from dan_estimates where estimator_version = 13 and computed_at >= ? and computed_at < ?",
    [MSD_POISON_WINDOW_START, seededAt],
  );
  // Skill ratings computed in the window folded floor per-play SSRs into the
  // stored vector; a missing row recomputes on the next profile view, which
  // reads better than serving deflated numbers until the player happens to
  // set a new top play.
  await exec(
    db,
    "delete from player_skill_ratings where updated_at >= ? and updated_at < ?",
    [MSD_POISON_WINDOW_START, seededAt],
  );
  await enqueueMsdPoisonRecovery(queue, 0);
}

export async function runMsdPoisonRecoveryJob(
  db: Db,
  queue: JobQueue,
  payload: { cursor?: number } | undefined,
): Promise<void> {
  const cursor = Math.max(0, Math.floor(Number(payload?.cursor ?? 0)));
  const result = await recomputeMsdPoisonChunk(db, cursor);
  // Each re-analysis upserts its own search-index row, so recovered MSD and
  // verdicts reach /maps without a full index rebuild.
  for (const beatmapId of result.changed) await enqueueChartAnalysis(queue, beatmapId);
  if (result.done) {
    const now = nowIso();
    await exec(
      db,
      "insert or replace into live_meta (key, value_json, updated_at) values (?, ?, ?)",
      [MSD_POISON_RECOVERY_META_KEY, json({ finishedAt: now }), now],
    );
    // Recovered verdicts must move between dan collections now, not on the
    // next scheduled rotation.
    await queue.enqueue("rebuild_map_collections", "rebuild_map_collections", {}, { priority: -12, replaceDone: true });
    return;
  }
  await enqueueMsdPoisonRecovery(queue, result.nextCursor);
}

async function enqueueMsdPoisonRecovery(queue: JobQueue, cursor: number): Promise<void> {
  await queue.enqueue(
    MSD_POISON_RECOVERY_JOB,
    `${MSD_POISON_RECOVERY_JOB}:${cursor}`,
    { cursor },
    { priority: -10, replaceDone: true },
  );
}

// One-shot sweep for the inverse cluster BPM bug (fixed 2026-08-16 in
// vendor/leoblack/patterns/clustering.js). Density/Inverse pattern windows
// carry MsPerBeat 0 as a "no meaningful tempo" sentinel, but the mixed-BPM
// cluster pool averaged those zeros in with real windows, so an inverse-heavy
// chart's mixed Density cluster read as a four-digit BPM ("~4497BPM Mixed
// Inverse") and its importance (amount x multiplier x BPM) inflated with it,
// sorting the junk chip first on /maps. The wrong number is baked into
// classification_json, so affected rows need a re-analysis; the signature (a
// mixed Density cluster with a nonzero BPM) selects every row whose pool
// could have contained sentinels. Rows whose pool had none re-store the same
// clusters, and all-sentinel pools were already BPM 0 and are skipped. Same
// playbook as the sweeps above: chunked, self-chaining, boot-seeded, done in
// meta. Enqueue-only chunks; no inline recompute.
export const INVERSE_CLUSTER_BPM_JOB = "recompute_inverse_cluster_bpm_sweep";
const INVERSE_CLUSTER_BPM_META_KEY = "inverse_cluster_bpm_recovery_done:v1";
const INVERSE_CLUSTER_BPM_CHUNK = 200;

const INVERSE_CLUSTER_BPM_SIGNATURE_SQL = `exists (
  select 1 from json_each(classification_json, '$.clusters') as cluster
  where json_extract(cluster.value, '$.pattern') = 'Density'
    and json_extract(cluster.value, '$.mixed') = 1
    and json_extract(cluster.value, '$.bpm') > 0
)`;

export interface InverseClusterBpmChunkResult {
  nextCursor: number;
  scanned: number;
  changed: number[];
  done: boolean;
}

export async function recomputeInverseClusterBpmChunk(
  db: Db,
  cursor: number,
  limit = INVERSE_CLUSTER_BPM_CHUNK,
): Promise<InverseClusterBpmChunkResult> {
  const rows = (await exec(
    db,
    `select beatmap_id
     from beatmap_chart_analysis
     where analysis_version = ? and status = 'ready'
       and beatmap_id > ?
       and ${INVERSE_CLUSTER_BPM_SIGNATURE_SQL}
     order by beatmap_id
     limit ?`,
    [CHART_ANALYSIS_VERSION, Math.max(0, Math.floor(cursor)), Math.max(1, Math.floor(limit))],
  )).rows;

  let nextCursor = cursor;
  const changed: number[] = [];
  for (const row of rows) {
    const beatmapId = Number(row.beatmap_id);
    nextCursor = Math.max(nextCursor, beatmapId);
    changed.push(beatmapId);
  }

  return { nextCursor, scanned: rows.length, changed, done: rows.length < limit };
}

export async function ensureInverseClusterBpmRecoverySeeded(db: Db, queue: JobQueue): Promise<void> {
  const done = (await exec(db, "select 1 from live_meta where key = ? limit 1", [INVERSE_CLUSTER_BPM_META_KEY])).rows[0];
  if (done) return;
  const pending = (await exec(
    db,
    "select 1 from jobs where type = ? and status in ('queued', 'running', 'failed', 'deferred_pressure') limit 1",
    [INVERSE_CLUSTER_BPM_JOB],
  )).rows[0];
  if (pending) return;
  await enqueueInverseClusterBpmRecovery(queue, 0);
}

export async function runInverseClusterBpmRecoveryJob(
  db: Db,
  queue: JobQueue,
  payload: { cursor?: number } | undefined,
): Promise<void> {
  const cursor = Math.max(0, Math.floor(Number(payload?.cursor ?? 0)));
  const result = await recomputeInverseClusterBpmChunk(db, cursor);
  // Each re-analysis upserts its own search-index row, so corrected cluster
  // chips reach /maps without a full index rebuild. Collections key off the
  // dan/MSD buckets, which cluster BPM never feeds - no rebuild needed.
  for (const beatmapId of result.changed) await enqueueChartAnalysis(queue, beatmapId);
  if (result.done) {
    const now = nowIso();
    await exec(
      db,
      "insert or replace into live_meta (key, value_json, updated_at) values (?, ?, ?)",
      [INVERSE_CLUSTER_BPM_META_KEY, json({ finishedAt: now }), now],
    );
    return;
  }
  await enqueueInverseClusterBpmRecovery(queue, result.nextCursor);
}

async function enqueueInverseClusterBpmRecovery(queue: JobQueue, cursor: number): Promise<void> {
  await queue.enqueue(
    INVERSE_CLUSTER_BPM_JOB,
    `${INVERSE_CLUSTER_BPM_JOB}:${cursor}`,
    { cursor },
    { priority: -10, replaceDone: true },
  );
}

// One-shot heal for charts MinaCalc used to crash on (fixed 2026-08-16 in
// vendor/leoblack/ett/calc.js): a note before the audio leads in (osu! allows
// negative timestamps) walked the calc's interval index out of bounds and the
// wasm threw, which computeMsd swallowed into a null MSD on an otherwise
// ready row. The harness now shifts such charts to start at zero, so a
// re-analysis stores real values. The signature (ready, MinaCalc-supported
// keymode, no msd_json) matches exactly the charts that threw; every other
// null-MSD row is an unsupported keymode. Small enough (one chart on prod)
// to enqueue directly at boot, no chunked scanner; the done key keeps a
// chart that still throws for some new reason from re-enqueueing every boot.
const NEGATIVE_TIME_MSD_META_KEY = "negative_time_msd_recovery_done:v1";

export async function ensureNegativeTimeMsdRecoverySeeded(db: Db, queue: JobQueue): Promise<void> {
  const done = (await exec(db, "select 1 from live_meta where key = ? limit 1", [NEGATIVE_TIME_MSD_META_KEY])).rows[0];
  if (done) return;
  const rows = (await exec(
    db,
    `select beatmap_id from beatmap_chart_analysis
     where analysis_version = ? and status = 'ready' and key_count in (4, 6, 7) and msd_json is null
     order by beatmap_id`,
    [CHART_ANALYSIS_VERSION],
  )).rows;
  for (const row of rows) await enqueueChartAnalysis(queue, Number(row.beatmap_id));
  const now = nowIso();
  await exec(
    db,
    "insert or replace into live_meta (key, value_json, updated_at) values (?, ?, ?)",
    [NEGATIVE_TIME_MSD_META_KEY, json({ finishedAt: now, enqueued: rows.length }), now],
  );
}
