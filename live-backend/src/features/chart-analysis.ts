import { randomUUID } from "node:crypto";
import type { Db } from "../db.js";
import { exec, json, parseJson } from "../db.js";
import { parseManiaBeatmap } from "../dan/beatmap-parser.js";
import { analyzeManiaPatterns } from "../dan/dan-estimator/patterns.js";
import { classifyChart, detectLnVibro, detectRiceVibro, sunnyLowEndReroute, type ChartClassification, type DanVerdictHalf } from "../dan/chart-classifier.js";
import { runLeoBlackMixed } from "../dan/leoblack-estimator.js";
import { computeMsd } from "../dan/msd.js";
import type { JobQueue } from "../jobs/queue.js";
import { readConfig } from "../config.js";
import { getCachedBeatmapFile, readCachedBeatmapFile } from "../osu/beatmap-file-cache.js";
import type { OsuApiClient } from "../osu/client.js";
import { nowIso } from "../shared/score.js";

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

function leanClassification(classification: ChartClassification): LeanChartClassification {
  return {
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

    const classification = classifyChart(map, osuText, {
      starRating: Number.isFinite(starRating) && starRating > 0 ? starRating : undefined,
      totalLength: map.totalLength > 0 ? map.totalLength / 1000 : undefined,
      version: map.version,
    });

    // Let the event loop breathe between the two CPU bursts.
    await new Promise<void>((resolve) => setImmediate(resolve));

    const msd = await computeMsd(osuText, { keyCount: map.keyCount }).catch(() => null);

    const lean = leanClassification(classification);
    const computedAt = nowIso();
    await exec(
      db,
      `insert into beatmap_chart_analysis
         (beatmap_id, analysis_version, status, key_count, primary_label, primary_family,
          raw_dan, msd_overall, classification_json, msd_json, error, computed_at, updated_at)
       values (?, ?, 'ready', ?, ?, ?, ?, ?, ?, ?, null, ?, ?)
       on conflict(beatmap_id, analysis_version) do update set
         status = excluded.status,
         key_count = excluded.key_count,
         primary_label = excluded.primary_label,
         primary_family = excluded.primary_family,
         raw_dan = excluded.raw_dan,
         msd_overall = excluded.msd_overall,
         classification_json = excluded.classification_json,
         msd_json = excluded.msd_json,
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
  if (message.startsWith("Not a mania beatmap") || message.startsWith("Invalid .osu")) return true;
  if (!message.startsWith("Failed to fetch .osu file for beatmap ")) return false;
  const separatorIndex = message.indexOf(": ");
  if (separatorIndex < 0) return false;
  const sourceErrors = message
    .slice(separatorIndex + 2)
    .split(";")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  return sourceErrors.length > 0 && sourceErrors.every((part) => part.includes("(404)") || part.includes("invalid .osu file"));
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
  // The self-chaining runner sweeps missing rows only: failed rows already get
  // queue-level retries, and re-sweeping them each pass would keep the run
  // alive forever on a chart that permanently fails. The manual admin endpoint
  // includes them for an explicit retry pass.
  const missingClause = options.includeFailed
    ? "(a.beatmap_id is null or a.status in ('failed'))"
    : "a.beatmap_id is null";
  const rows = (await exec(
    db,
    `select f.beatmap_id as beatmap_id
     from beatmap_osu_files f
     left join beatmap_chart_analysis a
       on a.beatmap_id = f.beatmap_id and a.analysis_version = ?
     where f.error is null
       and (f.content != '' or f.content_blob is not null)
       and ${missingClause}
     limit ?`,
    [CHART_ANALYSIS_VERSION, safeLimit],
  )).rows;
  let enqueued = 0;
  for (const row of rows) {
    const beatmapId = Number(row.beatmap_id);
    if (!Number.isInteger(beatmapId) || beatmapId <= 0) continue;
    await enqueueChartAnalysis(queue, beatmapId);
    enqueued += 1;
  }
  return enqueued;
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

// The LN inverse gap cap became tempo-aware (dan-estimator/patterns.ts) after
// the corpus was analyzed: slow 7K inverse charts (release gaps charted as
// 1/8-1/4 beat, over the old fixed 120ms cap) were stored without the
// lninverse tag. Same playbook again: a boot-seeded chunked job recomputes the
// pattern analyzer verdict for stored 7K LN charts from the cached .osu and
// re-enqueues the full analysis job for the ones whose visible pattern tags or
// primary changed. Purely local work, no osu! API.

export const LN_SUBTYPE_RECOMPUTE_JOB = "recompute_ln_subtype_sweep";
const LN_SUBTYPE_META_KEY = "ln_subtype_recompute_done:v1";
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
       and key_count = 7
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
      if (map.keyCount !== 7) continue;
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
