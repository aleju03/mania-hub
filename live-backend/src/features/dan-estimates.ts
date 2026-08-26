import type { Db } from "../db.js";
import { exec, parseJson } from "../db.js";
import { DAN_ESTIMATE_CACHE_VERSION } from "../dan/dan-estimator/cache-version.js";
import { classifyChartWithCompanella } from "../dan/companella.js";
import { computeMsd } from "../dan/msd.js";
import { parseManiaBeatmap, type ManiaBeatmap } from "../dan/beatmap-parser.js";
import type { JobQueue } from "../jobs/queue.js";
import { logWarn } from "../logger.js";
import type { OsuApiClient } from "../osu/client.js";
import { getCachedBeatmapFile } from "../osu/beatmap-file-cache.js";
import { isTerminalBeatmapFileError } from "../osu/beatmap-file-errors.js";
import { nowIso } from "../shared/score.js";

const MAX_DAN_ESTIMATE_BATCH = 32;
const INLINE_DAN_ESTIMATE_LIMIT = 6;
const INLINE_DAN_ESTIMATE_CONCURRENCY = 2;
const MIN_RATE_PERCENT = 50;
const MAX_RATE_PERCENT = 200;
const MAX_PARSED_DAN_BEATMAPS = 100;

interface ParsedDanBeatmap {
  map: ManiaBeatmap;
  osuText: string;
}

const parsedDanBeatmapCache = new Map<number, ParsedDanBeatmap>();
const parsedDanBeatmapInflight = new Map<number, Promise<ParsedDanBeatmap>>();

export interface LeanDanEstimate {
  label: string;
  variant: string | null;
  displayName: string;
  rawDan: number;
  family: string;
  confidence: number;
  estimatorVersion: number;
}

export interface DanEstimateRequest {
  beatmapId: number;
  starRating?: number;
  rate?: number;
}

export interface NormalizedDanEstimateRequest {
  beatmapId: number;
  starRating?: number;
  rate: number;
  ratePercent: number;
  key: string;
}

export interface DanEstimateBatchResponse {
  results: Record<string, LeanDanEstimate | null>;
  pending: string[];
  estimatorVersion: number;
}

type DanEstimateStatus = "ready" | "unsupported" | "unavailable";

interface ComputedDanEstimate {
  status: DanEstimateStatus;
  value: LeanDanEstimate | null;
  msd: Record<string, number> | null;
}

type CachedDanEstimate =
  | { found: true; status: DanEstimateStatus; value: LeanDanEstimate | null; msd: Record<string, number> | null }
  | { found: false };

export function normalizeDanEstimateItems(items: unknown[]): NormalizedDanEstimateRequest[] {
  const normalized: NormalizedDanEstimateRequest[] = [];
  const seen = new Set<string>();

  for (const item of items.slice(0, MAX_DAN_ESTIMATE_BATCH)) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    const beatmapId = Math.floor(Number(raw.beatmapId));
    if (!Number.isFinite(beatmapId) || beatmapId <= 0) continue;

    const rawRate = raw.rate == null ? 1 : Number(raw.rate);
    const safeRate = Number.isFinite(rawRate) && rawRate > 0 ? rawRate : 1;
    const ratePercent = Math.max(MIN_RATE_PERCENT, Math.min(MAX_RATE_PERCENT, Math.round(safeRate * 100)));
    const starRating = raw.starRating == null ? undefined : Number(raw.starRating);
    const key = responseKey(beatmapId, ratePercent);
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({
      beatmapId,
      starRating: starRating != null && Number.isFinite(starRating) && starRating > 0 ? starRating : undefined,
      rate: ratePercent / 100,
      ratePercent,
      key,
    });
  }

  return normalized;
}

export async function getDanEstimateBatch(
  db: Db,
  queue: JobQueue,
  osu: OsuApiClient,
  items: unknown[],
  options: { computeMissing?: boolean } = {},
): Promise<DanEstimateBatchResponse> {
  const requests = normalizeDanEstimateItems(items);
  const results: Record<string, LeanDanEstimate | null> = {};
  const missing: NormalizedDanEstimateRequest[] = [];

  for (const request of requests) {
    const cached = await readCachedDanEstimate(db, request);
    if (cached.found) {
      results[request.key] = cached.value;
    } else {
      missing.push(request);
    }
  }

  const computedKeys = new Set<string>();
  if (options.computeMissing && missing.length > 0) {
    const inline = missing.slice(0, INLINE_DAN_ESTIMATE_LIMIT);
    await mapWithConcurrency(inline, INLINE_DAN_ESTIMATE_CONCURRENCY, async (request) => {
      try {
        const computed = await computeAndStoreDanEstimate(db, osu, request, "api:dan_estimates");
        results[request.key] = computed.value;
        computedKeys.add(request.key);
      } catch (error) {
        logWarn("dan_estimate_inline_failed", {
          beatmap_id: request.beatmapId,
          rate_percent: request.ratePercent,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  const pending: string[] = [];
  for (const request of missing) {
    if (computedKeys.has(request.key)) continue;
    pending.push(request.key);
    await enqueueDanEstimate(queue, request);
  }

  return {
    results,
    pending,
    estimatorVersion: DAN_ESTIMATE_CACHE_VERSION,
  };
}

/* ── Rate-adjusted chart analysis (one chart, one rate) ───────────────────────
   The stored analysis is 1.0x, so a play set under DT/NC or HT/DC is described
   by numbers it was not played at. This returns the MSD and dan verdict at the
   play's own rate, computed once and cached in the same dan_estimates row the
   1.0x-or-any-rate dan estimate already uses (its key is (beatmap, rate)).
   MinaCalc is the CPU burst here, so callers must charge a costly rate bucket;
   the 1.5x fast path off the DT sweep's stored columns lives in the route. */

export interface RateAdjustedChartAnalysis {
  beatmapId: number;
  rate: number;
  ratePercent: number;
  status: DanEstimateStatus;
  // Same shape as the entry's 1.0x dan, so the frontend renders one badge either
  // way. Null when the estimator has no table for this keymode.
  dan: { label: string; family: string; rawDan: number } | null;
  msd: Record<string, number> | null;
}

export async function getRateAdjustedChartAnalysis(
  db: Db,
  osu: OsuApiClient,
  beatmapId: number,
  rate: number,
): Promise<RateAdjustedChartAnalysis | null> {
  const [request] = normalizeDanEstimateItems([{ beatmapId, rate }]);
  if (!request) return null;

  const cached = await readCachedDanEstimate(db, request);
  if (cached.found && (cached.msd != null || cached.status === "unavailable")) {
    return toRateAdjustedAnalysis(request, cached.status, cached.value, cached.msd);
  }
  if (cached.found) {
    // The verdict was cached before MSD was stored beside it (the batch
    // endpoint and its job still store the dan alone). Fill in the MSD rather
    // than re-running the estimator for a verdict already in hand.
    const msd = await fillCachedRateMsd(db, osu, request);
    return toRateAdjustedAnalysis(request, cached.status, cached.value, msd);
  }

  const computed = await computeAndStoreDanEstimate(db, osu, request, "api:chart_analysis_rate", { withMsd: true });
  return toRateAdjustedAnalysis(request, computed.status, computed.value, computed.msd);
}

function toRateAdjustedAnalysis(
  request: NormalizedDanEstimateRequest,
  status: DanEstimateStatus,
  estimate: LeanDanEstimate | null,
  msd: Record<string, number> | null,
): RateAdjustedChartAnalysis {
  return {
    beatmapId: request.beatmapId,
    rate: request.rate,
    ratePercent: request.ratePercent,
    status,
    dan: estimate ? { label: estimate.displayName, family: estimate.family, rawDan: estimate.rawDan } : null,
    msd,
  };
}

/** MSD alone for an already-cached verdict; null for keymodes MinaCalc skips. */
async function fillCachedRateMsd(
  db: Db,
  osu: OsuApiClient,
  request: NormalizedDanEstimateRequest,
): Promise<Record<string, number> | null> {
  let parsed: ParsedDanBeatmap;
  try {
    parsed = await getParsedDanBeatmap(db, osu, request.beatmapId, "api:chart_analysis_rate");
  } catch {
    return null;
  }
  const msd = await computeMsd(parsed.osuText, { keyCount: parsed.map.keyCount, rate: request.rate }).catch(() => null);
  if (!msd) return null;
  await exec(
    db,
    `update dan_estimates set msd_json = ?, updated_at = ?
     where estimator_version = ? and beatmap_id = ? and rate_percent = ?`,
    [JSON.stringify(msd), nowIso(), DAN_ESTIMATE_CACHE_VERSION, request.beatmapId, request.ratePercent],
  );
  return msd.values;
}

export async function enqueueDanEstimate(queue: JobQueue, request: NormalizedDanEstimateRequest): Promise<void> {
  await queue.enqueue(
    "compute_dan_estimate",
    danEstimateJobKey(request.beatmapId, request.ratePercent),
    {
      beatmapId: request.beatmapId,
      starRating: request.starRating,
      rate: request.rate,
    },
    { priority: 45 },
  );
}

export async function computeDanEstimateJob(db: Db, osu: OsuApiClient, payload: unknown): Promise<void> {
  const [request] = normalizeDanEstimateItems([payload]);
  if (!request) return;
  await computeAndStoreDanEstimate(db, osu, request, "job:compute_dan_estimate");
}

async function computeAndStoreDanEstimate(
  db: Db,
  osu: OsuApiClient,
  request: NormalizedDanEstimateRequest,
  caller: string,
  options: { withMsd?: boolean } = {},
): Promise<ComputedDanEstimate> {
  const cached = await readCachedDanEstimate(db, request);
  if (cached.found) return { status: cached.status, value: cached.value, msd: cached.msd };

  const starRating = request.starRating ?? await readBeatmapStarRating(db, request.beatmapId);
  let parsed: ParsedDanBeatmap;
  try {
    parsed = await getParsedDanBeatmap(db, osu, request.beatmapId, caller);
  } catch (error) {
    // The .osu file is gone from every mirror (404/invalid): retrying can never
    // succeed, so cache a terminal "unavailable" marker and stop the job from
    // failing on backoff forever. Transient errors still throw and retry.
    if (isTerminalBeatmapFileError(error instanceof Error ? error.message : String(error))) {
      await storeUnavailableDanEstimate(db, request);
      return { status: "unavailable", value: null, msd: null };
    }
    throw error;
  }
  const { map, osuText } = parsed;
  // Only the rate-analysis path asks for MSD; the batch endpoint and its job
  // want the dan verdict alone and must not pay a MinaCalc run for it. When it
  // is asked for it leads, so the Companella pass reuses it instead of running
  // the calc a second time.
  const msd = options.withMsd
    ? await computeMsd(osuText, { keyCount: map.keyCount, rate: request.rate }).catch(() => null)
    : null;
  const classification = await classifyChartWithCompanella(map, osuText, {
    starRating,
    totalLength: map.totalLength > 0 ? map.totalLength / 1000 : undefined,
    version: map.version,
    rate: request.rate !== 1 ? request.rate : undefined,
  }, { msdValues: msd?.values ?? null });
  const estimate = classification.estimate;
  if (!classification.supported || !estimate) {
    await storeUnsupportedDanEstimate(db, request, msd?.values ?? null);
    return { status: "unsupported", value: null, msd: msd?.values ?? null };
  }
  const lean: LeanDanEstimate = {
    label: estimate.label,
    variant: estimate.variant,
    displayName: estimate.displayName,
    rawDan: estimate.rawDan,
    family: estimate.family,
    confidence: estimate.confidence,
    estimatorVersion: DAN_ESTIMATE_CACHE_VERSION,
  };

  await exec(
    db,
    `insert into dan_estimates (
       estimator_version, beatmap_id, rate_percent, status, label, variant, display_name,
       raw_dan, family, confidence, star_rating, error, msd_json, computed_at, updated_at
     )
     values (?, ?, ?, 'ready', ?, ?, ?, ?, ?, ?, ?, null, ?, ?, ?)
     on conflict(estimator_version, beatmap_id, rate_percent) do update set
       status = excluded.status,
       label = excluded.label,
       variant = excluded.variant,
       display_name = excluded.display_name,
       raw_dan = excluded.raw_dan,
       family = excluded.family,
       confidence = excluded.confidence,
       star_rating = excluded.star_rating,
       error = excluded.error,
       msd_json = coalesce(excluded.msd_json, dan_estimates.msd_json),
       computed_at = excluded.computed_at,
       updated_at = excluded.updated_at`,
    [
      DAN_ESTIMATE_CACHE_VERSION,
      request.beatmapId,
      request.ratePercent,
      lean.label,
      lean.variant,
      lean.displayName,
      lean.rawDan,
      lean.family,
      lean.confidence,
      starRating ?? null,
      msd ? JSON.stringify(msd) : null,
      nowIso(),
      nowIso(),
    ],
  );

  return { status: "ready", value: lean, msd: msd?.values ?? null };
}

async function getParsedDanBeatmap(db: Db, osu: OsuApiClient, beatmapId: number, caller: string): Promise<ParsedDanBeatmap> {
  const cached = parsedDanBeatmapCache.get(beatmapId);
  if (cached) {
    parsedDanBeatmapCache.delete(beatmapId);
    parsedDanBeatmapCache.set(beatmapId, cached);
    return cached;
  }

  const inflight = parsedDanBeatmapInflight.get(beatmapId);
  if (inflight) return inflight;

  const promise = (async () => {
    const osuFile = await getCachedBeatmapFile(db, osu, beatmapId, caller);
    const map: ParsedDanBeatmap = { map: parseManiaBeatmap(osuFile), osuText: osuFile };
    parsedDanBeatmapCache.set(beatmapId, map);

    while (parsedDanBeatmapCache.size > MAX_PARSED_DAN_BEATMAPS) {
      const oldestKey = parsedDanBeatmapCache.keys().next().value;
      if (oldestKey === undefined) break;
      parsedDanBeatmapCache.delete(oldestKey);
    }

    return map;
  })();

  parsedDanBeatmapInflight.set(beatmapId, promise);
  try {
    return await promise;
  } finally {
    parsedDanBeatmapInflight.delete(beatmapId);
  }
}

async function readCachedDanEstimate(db: Db, request: NormalizedDanEstimateRequest): Promise<CachedDanEstimate> {
  const row = (await exec(
    db,
    `select *
     from dan_estimates
     where estimator_version = ? and beatmap_id = ? and rate_percent = ?
     limit 1`,
    [DAN_ESTIMATE_CACHE_VERSION, request.beatmapId, request.ratePercent],
  )).rows[0];
  if (!row) return { found: false };
  const status = String(row.status ?? "");
  const msd = readStoredMsd(row.msd_json);
  if (status === "unsupported" || status === "unavailable") {
    return { found: true, status, value: null, msd };
  }
  if (status !== "ready") return { found: false };
  if (row.star_rating == null && request.starRating != null) return { found: false };

  const label = row.label == null ? "" : String(row.label);
  const displayName = row.display_name == null ? "" : String(row.display_name);
  const family = row.family == null ? "" : String(row.family);
  const rawDan = Number(row.raw_dan);
  const confidence = Number(row.confidence);
  if (!label || !displayName || !family || !Number.isFinite(rawDan) || !Number.isFinite(confidence)) {
    return { found: false };
  }

  return {
    found: true,
    status: "ready",
    msd,
    value: {
      label,
      variant: row.variant == null ? null : String(row.variant),
      displayName,
      rawDan,
      family,
      confidence,
      estimatorVersion: DAN_ESTIMATE_CACHE_VERSION,
    },
  };
}

function readStoredMsd(raw: unknown): Record<string, number> | null {
  if (raw == null) return null;
  const parsed = parseJson<{ values?: Record<string, number> } | null>(String(raw), null);
  return parsed && parsed.values && typeof parsed.values === "object" ? parsed.values : null;
}

async function storeUnsupportedDanEstimate(
  db: Db,
  request: NormalizedDanEstimateRequest,
  msd: Record<string, number> | null = null,
): Promise<void> {
  // A keymode the dan estimator has no table for can still be one MinaCalc
  // rates (6K), so the MSD it did produce is stored beside the null verdict.
  await storeTerminalDanEstimate(db, request, "unsupported", "unsupported_keymode", msd);
}

// Caches a terminal null result so `readCachedDanEstimate` reports it as found
// (value null) and neither the API nor the job re-computes it.
async function storeUnavailableDanEstimate(db: Db, request: NormalizedDanEstimateRequest): Promise<void> {
  await storeTerminalDanEstimate(db, request, "unavailable", "beatmap_file_unavailable");
}

async function storeTerminalDanEstimate(
  db: Db,
  request: NormalizedDanEstimateRequest,
  status: "unsupported" | "unavailable",
  error: string,
  msd: Record<string, number> | null = null,
): Promise<void> {
  const now = nowIso();
  await exec(
    db,
    `insert into dan_estimates (
       estimator_version, beatmap_id, rate_percent, status, label, variant, display_name,
       raw_dan, family, confidence, star_rating, error, msd_json, computed_at, updated_at
     )
     values (?, ?, ?, ?, null, null, null, null, null, null, ?, ?, ?, ?, ?)
     on conflict(estimator_version, beatmap_id, rate_percent) do update set
       status = excluded.status,
       label = excluded.label,
       variant = excluded.variant,
       display_name = excluded.display_name,
       raw_dan = excluded.raw_dan,
       family = excluded.family,
       confidence = excluded.confidence,
       star_rating = excluded.star_rating,
       error = excluded.error,
       msd_json = coalesce(excluded.msd_json, dan_estimates.msd_json),
       computed_at = excluded.computed_at,
       updated_at = excluded.updated_at`,
    [
      DAN_ESTIMATE_CACHE_VERSION,
      request.beatmapId,
      request.ratePercent,
      status,
      request.starRating ?? null,
      error,
      msd ? JSON.stringify({ values: msd }) : null,
      now,
      now,
    ],
  );
}

async function readBeatmapStarRating(db: Db, beatmapId: number): Promise<number | undefined> {
  const row = (await exec(db, "select difficulty_rating from beatmaps where beatmap_id = ? limit 1", [beatmapId])).rows[0];
  const value = Number(row?.difficulty_rating);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function danEstimateJobKey(beatmapId: number, ratePercent: number): string {
  return `dan:${DAN_ESTIMATE_CACHE_VERSION}:${beatmapId}:r${ratePercent}`;
}

function responseKey(beatmapId: number, ratePercent: number): string {
  return ratePercent === 100 ? String(beatmapId) : `${beatmapId}:${ratePercent}`;
}

async function mapWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      if (item !== undefined) await worker(item);
    }
  });
  await Promise.all(workers);
}
