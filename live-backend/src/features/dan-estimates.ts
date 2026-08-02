import type { Db } from "../db.js";
import { exec } from "../db.js";
import { DAN_ESTIMATE_CACHE_VERSION } from "../dan/dan-estimator/cache-version.js";
import { classifyChartWithCompanella } from "../dan/companella.js";
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

type CachedDanEstimate = { found: true; value: LeanDanEstimate | null } | { found: false };

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
        const value = await computeAndStoreDanEstimate(db, osu, request, "api:dan_estimates");
        results[request.key] = value;
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
): Promise<LeanDanEstimate | null> {
  const cached = await readCachedDanEstimate(db, request);
  if (cached.found) return cached.value;

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
      return null;
    }
    throw error;
  }
  const { map, osuText } = parsed;
  const classification = await classifyChartWithCompanella(map, osuText, {
    starRating,
    totalLength: map.totalLength > 0 ? map.totalLength / 1000 : undefined,
    version: map.version,
    rate: request.rate !== 1 ? request.rate : undefined,
  });
  const estimate = classification.estimate;
  if (!classification.supported || !estimate) {
    await storeUnsupportedDanEstimate(db, request);
    return null;
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
       raw_dan, family, confidence, star_rating, error, computed_at, updated_at
     )
     values (?, ?, ?, 'ready', ?, ?, ?, ?, ?, ?, ?, null, ?, ?)
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
      nowIso(),
      nowIso(),
    ],
  );

  return lean;
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
  if (status === "unsupported" || status === "unavailable") return { found: true, value: null };
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

async function storeUnsupportedDanEstimate(db: Db, request: NormalizedDanEstimateRequest): Promise<void> {
  await storeTerminalDanEstimate(db, request, "unsupported", "unsupported_keymode");
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
): Promise<void> {
  const now = nowIso();
  await exec(
    db,
    `insert into dan_estimates (
       estimator_version, beatmap_id, rate_percent, status, label, variant, display_name,
       raw_dan, family, confidence, star_rating, error, computed_at, updated_at
     )
     values (?, ?, ?, ?, null, null, null, null, null, null, ?, ?, ?, ?)
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
       computed_at = excluded.computed_at,
       updated_at = excluded.updated_at`,
    [DAN_ESTIMATE_CACHE_VERSION, request.beatmapId, request.ratePercent, status, request.starRating ?? null, error, now, now],
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
