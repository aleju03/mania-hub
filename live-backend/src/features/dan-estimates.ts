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
export const MIN_RATE_PERCENT = 50;
export const MAX_RATE_PERCENT = 200;
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
  // Accepted on the wire for compatibility but IGNORED: the estimator's star
  // rating always comes from the beatmaps row. The batch endpoint is public
  // and the row it writes is keyed only by (beatmap, rate), so a
  // client-supplied rating was a cache-poisoning vector - and since the dan
  // clear rules started crediting these rows toward player dans, a poisoned
  // verdict would rank players, not just mislabel a card.
  starRating?: number;
  rate?: number;
}

export interface NormalizedDanEstimateRequest {
  beatmapId: number;
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
    const key = responseKey(beatmapId, ratePercent);
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({
      beatmapId,
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

  const starRating = await readBeatmapStarRating(db, request.beatmapId);
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
  return classifyAndStoreDanEstimate(db, request, parsed, starRating, options);
}

async function classifyAndStoreDanEstimate(
  db: Db,
  request: NormalizedDanEstimateRequest,
  parsed: ParsedDanBeatmap,
  starRating: number | undefined,
  options: { withMsd?: boolean } = {},
): Promise<ComputedDanEstimate> {
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

/** Key a (chart, rate) verdict is filed under in the maps the dan clear rules read. */
export function rateDanVerdictKey(beatmapId: number, ratePercent: number): string {
  return `${beatmapId}:${ratePercent}`;
}

export interface StoredRateDanVerdict {
  rawDan: number;
  // "ln" or "dan", the estimator's primary-family split (companella.ts).
  family: string;
}

// The verdict lookup loads by beatmap id and filters to the asked pairs in JS:
// a chart holds only a handful of rate rows, so the over-fetch is cheaper than
// a tuple-IN SQLite cannot index. Chunked and yielded like loadChartSkillInfo,
// for the same corpus-sweep caller.
const RATE_VERDICT_QUERY_CHUNK = 400;

/**
 * The stored dan verdicts for a set of (chart, rate) pairs, keyed by
 * rateDanVerdictKey. A null value is a stored terminal row (unsupported
 * keymode or a permanently missing .osu): resolved, nothing to credit, not
 * worth recomputing. An absent key is a verdict nobody has computed yet.
 */
export async function loadStoredRateDanVerdicts(
  db: Db,
  pairs: Iterable<{ beatmapId: number; ratePercent: number }>,
): Promise<Map<string, StoredRateDanVerdict | null>> {
  const wanted = new Set<string>();
  const beatmapIds = new Set<number>();
  for (const pair of pairs) {
    if (!Number.isInteger(pair.beatmapId) || pair.beatmapId <= 0) continue;
    if (!Number.isInteger(pair.ratePercent)) continue;
    wanted.add(rateDanVerdictKey(pair.beatmapId, pair.ratePercent));
    beatmapIds.add(pair.beatmapId);
  }
  const verdicts = new Map<string, StoredRateDanVerdict | null>();
  if (wanted.size === 0) return verdicts;
  const ids = [...beatmapIds];
  for (let offset = 0; offset < ids.length; offset += RATE_VERDICT_QUERY_CHUNK) {
    const chunk = ids.slice(offset, offset + RATE_VERDICT_QUERY_CHUNK);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = (await exec(
      db,
      `select beatmap_id, rate_percent, status, raw_dan, family, star_rating from dan_estimates
       where estimator_version = ? and beatmap_id in (${placeholders})`,
      [DAN_ESTIMATE_CACHE_VERSION, ...chunk],
    )).rows;
    // Current star ratings for the chunk, so stale or poisoned rows read as
    // absent (recomputable with the canonical rating) instead of crediting.
    const currentStarRatings = new Map<number, number>();
    for (const row of (await exec(
      db,
      `select beatmap_id, difficulty_rating from beatmaps where beatmap_id in (${placeholders})`,
      chunk,
    )).rows) {
      const value = Number(row.difficulty_rating);
      if (Number.isFinite(value) && value > 0) currentStarRatings.set(Number(row.beatmap_id), value);
    }
    for (const row of rows) {
      const key = rateDanVerdictKey(Number(row.beatmap_id), Number(row.rate_percent));
      if (!wanted.has(key)) continue;
      const status = String(row.status ?? "");
      if (status === "unsupported" || status === "unavailable") {
        verdicts.set(key, null);
        continue;
      }
      // A malformed or out-of-date ready row stays absent, matching
      // readCachedDanEstimate: recomputable, not resolved.
      const rawDan = Number(row.raw_dan);
      const family = row.family == null ? "" : String(row.family);
      if (status !== "ready" || !Number.isFinite(rawDan) || rawDan <= 0 || !family) continue;
      const storedStarRating = row.star_rating == null ? null : Number(row.star_rating);
      if (storedStarRatingInvalidatesRow(storedStarRating, currentStarRatings.get(Number(row.beatmap_id)))) continue;
      verdicts.set(key, { rawDan, family });
    }
    if (offset + chunk.length < ids.length) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  return verdicts;
}

/**
 * One (chart, rate) dan verdict computed from an already-loaded .osu (the
 * caller owns the fetch policy) and stored in dan_estimates on the same terms
 * as the batch path, so every reader shares one cache. Returns the ready
 * verdict, or null for anything uncreditable: an already-stored terminal row,
 * an unsupported keymode (stored, so it will not recompute), or a chart the
 * parser rejects (not stored; the caller retries on a later pass).
 */
export async function computeAndStoreRateDanVerdictFromText(
  db: Db,
  beatmapId: number,
  ratePercent: number,
  osuText: string,
): Promise<LeanDanEstimate | null> {
  const [request] = normalizeDanEstimateItems([{ beatmapId, rate: ratePercent / 100 }]);
  if (!request || request.ratePercent !== ratePercent) return null;
  const cached = await readCachedDanEstimate(db, request);
  if (cached.found) return cached.status === "ready" ? cached.value : null;
  let map: ManiaBeatmap;
  try {
    map = parseManiaBeatmap(osuText);
  } catch {
    return null;
  }
  const starRating = await readBeatmapStarRating(db, request.beatmapId);
  const computed = await classifyAndStoreDanEstimate(db, request, { map, osuText }, starRating);
  return computed.value;
}

/** Queue the (chart, rate) verdict compute; the job key dedupes repeat asks. */
export async function enqueueRateDanEstimate(
  queue: JobQueue,
  beatmapId: number,
  ratePercent: number,
): Promise<void> {
  const [request] = normalizeDanEstimateItems([{ beatmapId, rate: ratePercent / 100 }]);
  if (!request || request.ratePercent !== ratePercent) return;
  await enqueueDanEstimate(queue, request);
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
  const storedStarRating = row.star_rating == null ? null : Number(row.star_rating);
  if (storedStarRatingInvalidatesRow(storedStarRating, await readBeatmapStarRating(db, request.beatmapId))) {
    return { found: false };
  }

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

// A stored ready row is only current while the star rating it was computed
// under matches the beatmaps row today. Beyond this band the row recomputes:
// either it predates enrichment (null stored, rating known now), osu! recalced
// the chart (a refresh is wanted anyway), or it was poisoned back when the
// batch endpoint still trusted a client-supplied rating. Within the band tiny
// float drift is not worth a MinaCalc run. A chart whose beatmaps row is
// missing cannot be validated and keeps its stored verdict.
const STORED_STAR_RATING_TOLERANCE = 0.05;

function storedStarRatingInvalidatesRow(stored: number | null, current: number | undefined): boolean {
  if (current == null) return false;
  if (stored == null || !Number.isFinite(stored)) return true;
  return Math.abs(stored - current) > STORED_STAR_RATING_TOLERANCE;
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
      // Terminal rows are resolved regardless of star rating (an unsupported
      // keymode or a gone .osu does not change with it), so none is recorded
      // and the freshness check above never re-opens them over it.
      null,
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
