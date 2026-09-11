import type { Db } from "../db.js";
import { exec, parseJson } from "../db.js";
import { DAN_ESTIMATE_CACHE_VERSION } from "../dan/dan-estimator/cache-version.js";
import { classifyChartWithCompanella } from "../dan/companella.js";
import { computeMsd, msdChartErrorFallback, type MsdResult } from "../dan/msd.js";
import type { VibroAnalysis } from "../dan/vibro-sections.js";
import { parseManiaBeatmap, type ManiaBeatmap } from "../dan/beatmap-parser.js";
import { invertManiaOsuText } from "../dan/invert-mod.js";
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
// Enumerate version equality probes so SQLite can also seek beatmap_id in
// the composite primary key. A version range scans the whole estimate cache.
const SERVING_VERSIONS = Array.from({ length: DAN_ESTIMATE_CACHE_VERSION }, (_, index) => DAN_ESTIMATE_CACHE_VERSION - index);
// v16 mixed player-adjusted numbers into ordinary chart estimates. They are
// valid as fallback player evidence, never as a public chart estimate.
const SERVING_VERSIONS_SQL = SERVING_VERSIONS.filter((version) => version !== 16).join(", ");
const VARIANT_SERVING_VERSIONS_SQL = SERVING_VERSIONS.join(", ");

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

/**
 * Internal chart transformations with isolated cache keys. Invert rebuilds
 * the played notes; vibro-adjusted rates only the retained material for player
 * dan credit. Both use the existing variant table (dan_mod_estimates), so
 * neither can overwrite or be read as an ordinary full-chart estimate.
 */
export type DanChartVariant = "IN" | "vibro-adjusted";
export const INVERSE_MOD_VARIANT = "IN" satisfies DanChartVariant;
export const VIBRO_ADJUSTED_VARIANT = "vibro-adjusted" satisfies DanChartVariant;

function isDanChartVariant(value: unknown): value is DanChartVariant {
  return value === INVERSE_MOD_VARIANT || value === VIBRO_ADJUSTED_VARIANT;
}

export interface NormalizedDanEstimateRequest {
  beatmapId: number;
  rate: number;
  ratePercent: number;
  key: string;
  /** Set only by internal callers (the clear rules, their job); never off the wire. */
  modVariant?: DanChartVariant;
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
  vibroAnalysis?: VibroAnalysis;
}

type CachedDanEstimate =
  | { found: true; status: DanEstimateStatus; value: LeanDanEstimate | null; msd: Record<string, number> | null; vibroAnalysis?: VibroAnalysis; stale?: boolean }
  | { found: false };

export function normalizeDanEstimateItems(
  items: unknown[],
  // The public batch endpoint never sets this: a mod variant on an item is
  // honoured only for the job payloads the internal callers write.
  options: { modVariants?: boolean } = {},
): NormalizedDanEstimateRequest[] {
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
    const modVariant = options.modVariants && isDanChartVariant(raw.mod) ? raw.mod : undefined;
    const key = modVariant ? rateDanVerdictKey(beatmapId, ratePercent, modVariant) : responseKey(beatmapId, ratePercent);
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({
      beatmapId,
      rate: ratePercent / 100,
      ratePercent,
      key,
      ...(modVariant ? { modVariant } : {}),
    });
  }

  return normalized;
}

/** The request the clear rules make for one (chart, rate, mod) verdict. */
function normalizeRateDanRequest(
  beatmapId: number,
  ratePercent: number,
  modVariant?: DanChartVariant,
): NormalizedDanEstimateRequest | null {
  const [request] = normalizeDanEstimateItems(
    [{ beatmapId, rate: ratePercent / 100, ...(modVariant ? { mod: modVariant } : {}) }],
    { modVariants: true },
  );
  if (!request || request.ratePercent !== ratePercent) return null;
  return request;
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
  const refreshing: NormalizedDanEstimateRequest[] = [];

  for (const request of requests) {
    const cached = await readCachedDanEstimate(db, request, { allowPrevious: true });
    if (cached.found) {
      results[request.key] = cached.value;
      if (cached.stale) refreshing.push(request);
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
  for (const request of refreshing) {
    pending.push(request.key);
    await enqueueDanEstimate(queue, request).catch((error) => logWarn("dan_estimate_refresh_enqueue_failed", {
      beatmap_id: request.beatmapId, error: String(error),
    }));
  }
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
  vibroAnalysis?: VibroAnalysis;
}

export async function getRateAdjustedChartAnalysis(
  db: Db,
  osu: OsuApiClient,
  beatmapId: number,
  rate: number,
  queue?: JobQueue,
): Promise<RateAdjustedChartAnalysis | null> {
  const [request] = normalizeDanEstimateItems([{ beatmapId, rate }]);
  if (!request) return null;

  const cached = await readCachedDanEstimate(db, request, { allowPrevious: queue != null });
  if (cached.found && cached.stale && queue) {
    await enqueueDanEstimate(queue, request).catch((error) => logWarn("dan_estimate_refresh_enqueue_failed", {
      beatmap_id: request.beatmapId, error: String(error),
    }));
    return toRateAdjustedAnalysis(request, cached.status, cached.value, cached.msd, cached.vibroAnalysis);
  }
  if (cached.found && (cached.msd != null || cached.status === "unavailable")) {
    return toRateAdjustedAnalysis(request, cached.status, cached.value, cached.msd, cached.vibroAnalysis);
  }
  if (cached.found) {
    // The verdict was cached before MSD was stored beside it (the batch
    // endpoint and its job still store the dan alone). Fill in the MSD rather
    // than re-running the estimator for a verdict already in hand.
    const msd = await fillCachedRateMsd(db, osu, request);
    return toRateAdjustedAnalysis(request, cached.status, cached.value, msd?.values ?? null, msd?.vibroAnalysis);
  }

  const computed = await computeAndStoreDanEstimate(db, osu, request, "api:chart_analysis_rate", { withMsd: true });
  return toRateAdjustedAnalysis(request, computed.status, computed.value, computed.msd, computed.vibroAnalysis);
}

function toRateAdjustedAnalysis(
  request: NormalizedDanEstimateRequest,
  status: DanEstimateStatus,
  estimate: LeanDanEstimate | null,
  msd: Record<string, number> | null,
  vibroAnalysis?: VibroAnalysis,
): RateAdjustedChartAnalysis {
  return {
    beatmapId: request.beatmapId,
    rate: request.rate,
    ratePercent: request.ratePercent,
    status,
    dan: estimate ? { label: estimate.displayName, family: estimate.family, rawDan: estimate.rawDan } : null,
    msd,
    ...(vibroAnalysis ? { vibroAnalysis } : {}),
  };
}

/** MSD alone for an already-cached verdict; null for keymodes MinaCalc skips. */
async function fillCachedRateMsd(
  db: Db,
  osu: OsuApiClient,
  request: NormalizedDanEstimateRequest,
): Promise<MsdResult | null> {
  let parsed: ParsedDanBeatmap;
  try {
    parsed = await getParsedDanBeatmap(db, osu, request.beatmapId, "api:chart_analysis_rate");
  } catch {
    return null;
  }
  const msd = await computeMsd(parsed.osuText, { keyCount: parsed.map.keyCount, rate: request.rate }).catch(msdChartErrorFallback);
  if (!msd) return null;
  await exec(
    db,
    `update dan_estimates set msd_json = ?, updated_at = ?
     where estimator_version = ? and beatmap_id = ? and rate_percent = ?`,
    [JSON.stringify(msd), nowIso(), DAN_ESTIMATE_CACHE_VERSION, request.beatmapId, request.ratePercent],
  );
  return msd;
}

export async function enqueueDanEstimate(queue: JobQueue, request: NormalizedDanEstimateRequest): Promise<void> {
  await queue.enqueue(
    "compute_dan_estimate",
    danEstimateJobKey(request.beatmapId, request.ratePercent, request.modVariant),
    {
      beatmapId: request.beatmapId,
      rate: request.rate,
      ...(request.modVariant ? { mod: request.modVariant } : {}),
    },
    { priority: 45 },
  );
}

export async function computeDanEstimateJob(db: Db, osu: OsuApiClient, payload: unknown): Promise<void> {
  const [request] = normalizeDanEstimateItems([payload], { modVariants: true });
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
  if (cached.found) return { status: cached.status, value: cached.value, msd: cached.msd, vibroAnalysis: cached.vibroAnalysis };

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
  const variant = applyModVariant(parsed, request.modVariant);
  if (!variant) {
    // The file is fine but the mod cannot rebuild it (no [HitObjects] to
    // invert): terminal, like a keymode the estimator has no table for.
    await storeUnsupportedDanEstimate(db, request);
    return { status: "unsupported", value: null, msd: null };
  }
  return classifyAndStoreDanEstimate(db, request, variant, starRating, options);
}

/**
 * The chart a mod-variant request is about: the stored .osu rewritten the way
 * the mod rewrites it, re-parsed so the classifier sees the rewritten notes.
 * A request without a variant is the stored chart itself. Null when the
 * rewrite cannot be built or the result does not parse.
 */
function applyModVariant(parsed: ParsedDanBeatmap, modVariant: DanChartVariant | undefined): ParsedDanBeatmap | null {
  if (modVariant !== INVERSE_MOD_VARIANT) return parsed;
  const osuText = invertManiaOsuText(parsed.osuText);
  if (!osuText) return null;
  try {
    return { map: parseManiaBeatmap(osuText), osuText };
  } catch {
    return null;
  }
}

async function classifyAndStoreDanEstimate(
  db: Db,
  request: NormalizedDanEstimateRequest,
  parsed: ParsedDanBeatmap,
  starRating: number | undefined,
  options: { withMsd?: boolean; msd?: MsdResult | null; requireComplete?: boolean } = {},
): Promise<ComputedDanEstimate> {
  const { map, osuText } = parsed;
  // Rate analysis and verdict-only repairs can supply MSD up front. Other
  // requests obtain it lazily in the async adapter only when marathon
  // correction or Companella needs it.
  const adjustVibro = request.modVariant === VIBRO_ADJUSTED_VARIANT;
  const msd = options.msd ?? (options.withMsd
    ? await computeMsd(osuText, { keyCount: map.keyCount, rate: request.rate, adjustVibro }).catch(msdChartErrorFallback)
    : null);
  const classification = await classifyChartWithCompanella(map, osuText, {
    adjustVibro,
    starRating,
    totalLength: map.totalLength > 0 ? map.totalLength / 1000 : undefined,
    version: map.version,
    rate: request.rate !== 1 ? request.rate : undefined,
  }, { msdValues: msd?.values ?? null });
  if (options.requireComplete && classification.companellaPending) {
    throw new Error(`Companella unavailable for marathon rate repair ${request.beatmapId}@${request.rate}`);
  }
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

  await writeDanEstimateRow(db, request, {
    status: "ready",
    label: lean.label,
    variant: lean.variant,
    displayName: lean.displayName,
    rawDan: lean.rawDan,
    family: lean.family,
    confidence: lean.confidence,
    starRating: starRating ?? null,
    error: null,
    msdJson: msd ? JSON.stringify(msd) : null,
  });

  return { status: "ready", value: lean, msd: msd?.values ?? null, vibroAnalysis: classification.vibroAnalysis };
}

/**
 * Key a (chart, rate[, mod]) verdict is filed under in the maps the dan clear
 * rules read. A mod variant's key carries the mod, so an Invert play on a
 * chart and a plain play on it at the same rate read different verdicts.
 */
export function rateDanVerdictKey(beatmapId: number, ratePercent: number, modVariant?: DanChartVariant): string {
  return `${beatmapId}:${ratePercent}${modVariant ? `:${modVariant}` : ""}`;
}

/** One (chart, rate[, mod]) the clear rules want a verdict for. */
export interface RateDanVerdictPair {
  beatmapId: number;
  ratePercent: number;
  modVariant?: DanChartVariant;
}

export interface StoredRateDanVerdict {
  /** Still creditable while its current-version replacement is queued. */
  stale?: boolean;
  rawDan: number;
  // "ln" or "dan", the estimator's primary-family split (companella.ts).
  family: string;
  // The verdict's own printed label ("beta+"), so evidence surfaces can show
  // the words the verdict was stored under instead of re-banding rawDan.
  displayName: string | null;
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
  pairs: Iterable<RateDanVerdictPair>,
): Promise<Map<string, StoredRateDanVerdict | null>> {
  const wanted = new Set<string>();
  const beatmapIds = new Set<number>();
  const modBeatmapIds = new Set<number>();
  for (const pair of pairs) {
    if (!Number.isInteger(pair.beatmapId) || pair.beatmapId <= 0) continue;
    if (!Number.isInteger(pair.ratePercent)) continue;
    wanted.add(rateDanVerdictKey(pair.beatmapId, pair.ratePercent, pair.modVariant));
    (pair.modVariant ? modBeatmapIds : beatmapIds).add(pair.beatmapId);
  }
  const verdicts = new Map<string, StoredRateDanVerdict | null>();
  if (wanted.size === 0) return verdicts;
  await collectStoredRateDanVerdicts(db, "dan_estimates", [...beatmapIds], wanted, verdicts);
  await collectStoredRateDanVerdicts(db, "dan_mod_estimates", [...modBeatmapIds], wanted, verdicts);
  return verdicts;
}

/** One table's worth of loadStoredRateDanVerdicts; the mod table keys by mod too. */
async function collectStoredRateDanVerdicts(
  db: Db,
  table: "dan_estimates" | "dan_mod_estimates",
  ids: number[],
  wanted: Set<string>,
  verdicts: Map<string, StoredRateDanVerdict | null>,
): Promise<void> {
  const modColumn = table === "dan_mod_estimates" ? ", mod_variant" : "";
  // This reader serves player evidence. Existing v16 verdicts stay valid for
  // clean plays too; public chart reads reject them in readCachedDanEstimate.
  const servingVersions = VARIANT_SERVING_VERSIONS_SQL;
  for (let offset = 0; offset < ids.length; offset += RATE_VERDICT_QUERY_CHUNK) {
    const chunk = ids.slice(offset, offset + RATE_VERDICT_QUERY_CHUNK);
    const placeholders = chunk.map(() => "?").join(", ");
    // v16's ordinary cache already contains the adjusted player verdict.
    // Keep that evidence while its isolated current-version entry is queued.
    const legacyAdjusted = table === "dan_mod_estimates"
      ? `union all select estimator_version, beatmap_id, rate_percent, status, raw_dan, family, star_rating, display_name,
           '${VIBRO_ADJUSTED_VARIANT}' as mod_variant from dan_estimates
         where estimator_version = 16 and beatmap_id in (${placeholders})`
      : "";
    const rows = (await exec(
      db,
      `select estimator_version, beatmap_id, rate_percent, status, raw_dan, family, star_rating, display_name${modColumn} from ${table}
       where estimator_version in (${servingVersions}) and beatmap_id in (${placeholders})
       ${legacyAdjusted}
       order by estimator_version desc`,
      table === "dan_mod_estimates" ? [...chunk, ...chunk] : chunk,
    )).rows;
    // Changed or poisoned star ratings still invalidate a row, even when its
    // estimator version is otherwise eligible for a serving fallback.
    const currentStarRatings = new Map<number, number>();
    for (const row of (await exec(
      db,
      `select beatmap_id, difficulty_rating from beatmaps where beatmap_id in (${placeholders})`,
      chunk,
    )).rows) {
      const value = Number(row.difficulty_rating);
      if (Number.isFinite(value) && value > 0) currentStarRatings.set(Number(row.beatmap_id), value);
    }
    const seen = new Set<string>();
    for (const row of rows) {
      if (table === "dan_mod_estimates" && !isDanChartVariant(row.mod_variant)) continue;
      const modVariant = isDanChartVariant(row.mod_variant) ? row.mod_variant : undefined;
      const key = rateDanVerdictKey(Number(row.beatmap_id), Number(row.rate_percent), modVariant);
      if (!wanted.has(key) || seen.has(key)) continue;
      // A newer terminal or invalid result must never resurrect an older clear.
      seen.add(key);
      const stale = Number(row.estimator_version) !== DAN_ESTIMATE_CACHE_VERSION;
      const status = String(row.status ?? "");
      if (status === "unsupported" || status === "unavailable") {
        if (!stale) verdicts.set(key, null);
        continue;
      }
      // A malformed ready row stays absent, matching
      // readCachedDanEstimate: recomputable, not resolved. A zero or negative
      // raw_dan is not malformed: the regression runs below the table on a
      // bottom-rung chart and the row still carries the ladder's first label,
      // so it is served and the credit side clamps it to the ladder floor.
      const rawDan = row.raw_dan == null ? Number.NaN : Number(row.raw_dan);
      const family = row.family == null ? "" : String(row.family);
      if (status !== "ready" || !Number.isFinite(rawDan) || !family) continue;
      const storedStarRating = row.star_rating == null ? null : Number(row.star_rating);
      if (storedStarRatingInvalidatesRow(storedStarRating, currentStarRatings.get(Number(row.beatmap_id)))) continue;
      const displayName = typeof row.display_name === "string" && row.display_name.trim() ? row.display_name.trim() : null;
      verdicts.set(key, { rawDan, family, displayName, ...(stale ? { stale: true } : {}) });
    }
    if (offset + chunk.length < ids.length) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
}

/**
 * One (chart, rate[, mod]) dan verdict computed from the chart's already-loaded
 * .osu (the caller owns the fetch policy) and stored on the same terms as the
 * batch path, so every reader shares one cache. A mod variant is applied here
 * to the stored text, so the caller always hands over the chart's own file.
 * Returns the ready verdict, or null for anything uncreditable: an
 * already-stored terminal row, an unsupported keymode or an un-rebuildable
 * mod variant (both stored, so they will not recompute), or a chart the parser
 * rejects (not stored; the caller retries on a later pass).
 */
export async function computeAndStoreRateDanVerdictFromText(
  db: Db,
  beatmapId: number,
  ratePercent: number,
  osuText: string,
  modVariant?: DanChartVariant,
  options: { msd?: MsdResult | null; requireComplete?: boolean } = {},
): Promise<LeanDanEstimate | null> {
  const request = normalizeRateDanRequest(beatmapId, ratePercent, modVariant);
  if (!request) return null;
  const cached = await readCachedDanEstimate(db, request);
  if (cached.found) return cached.status === "ready" ? cached.value : null;
  let map: ManiaBeatmap;
  try {
    map = parseManiaBeatmap(osuText);
  } catch {
    return null;
  }
  const variant = applyModVariant({ map, osuText }, request.modVariant);
  if (!variant) {
    await storeUnsupportedDanEstimate(db, request);
    return null;
  }
  const starRating = await readBeatmapStarRating(db, request.beatmapId);
  const computed = await classifyAndStoreDanEstimate(db, request, variant, starRating, options);
  return computed.value;
}

/** Queue the (chart, rate[, mod]) verdict compute; the job key dedupes repeat asks. */
export async function enqueueRateDanEstimate(
  queue: JobQueue,
  beatmapId: number,
  ratePercent: number,
  modVariant?: DanChartVariant,
): Promise<void> {
  const request = normalizeRateDanRequest(beatmapId, ratePercent, modVariant);
  if (!request) return;
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

// Compute paths stay current-only so a serving fallback cannot suppress work.
async function readCachedDanEstimate(
  db: Db,
  request: NormalizedDanEstimateRequest,
  options: { allowPrevious?: boolean } = {},
): Promise<CachedDanEstimate> {
  const { table, keyColumns, keyValues } = danEstimateTable(request);
  const servingVersions = request.modVariant ? VARIANT_SERVING_VERSIONS_SQL : SERVING_VERSIONS_SQL;
  const versionFilter = options.allowPrevious ? `estimator_version in (${servingVersions})` : "estimator_version = ?";
  const row = (await exec(
    db,
    `select *
     from ${table}
     where ${versionFilter} and ${keyColumns.slice(1).map((column) => `${column} = ?`).join(" and ")}
     order by estimator_version desc
     limit 1`,
    options.allowPrevious ? keyValues.slice(1) : keyValues,
  )).rows[0];
  if (!row) return { found: false };
  const stale = Number(row.estimator_version) !== DAN_ESTIMATE_CACHE_VERSION;
  const status = String(row.status ?? "");
  const msd = readStoredMsd(row.msd_json);
  const vibroAnalysis = parseJson<MsdResult | null>(row.msd_json, null)?.vibroAnalysis;
  if (status === "unsupported" || status === "unavailable") {
    if (stale) return { found: false };
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
    vibroAnalysis,
    ...(stale ? { stale: true } : {}),
    value: {
      label,
      variant: row.variant == null ? null : String(row.variant),
      displayName,
      rawDan,
      family,
      confidence,
      estimatorVersion: Number(row.estimator_version),
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
  await writeDanEstimateRow(db, request, {
    status,
    label: null,
    variant: null,
    displayName: null,
    rawDan: null,
    family: null,
    confidence: null,
    // Terminal rows are resolved regardless of star rating (an unsupported
    // keymode or a gone .osu does not change with it), so none is recorded
    // and the freshness check above never re-opens them over it.
    starRating: null,
    error,
    msdJson: msd ? JSON.stringify({ values: msd }) : null,
  });
}

/**
 * Where a request's row lives. The chart's own verdicts are dan_estimates; a
 * mod variant's are dan_mod_estimates, the same columns keyed once more by the
 * mod, so the two can never be confused for each other on a read.
 */
function danEstimateTable(request: NormalizedDanEstimateRequest): { table: string; keyColumns: string[]; keyValues: Array<number | string> } {
  return request.modVariant
    ? {
      table: "dan_mod_estimates",
      keyColumns: ["estimator_version", "beatmap_id", "rate_percent", "mod_variant"],
      keyValues: [DAN_ESTIMATE_CACHE_VERSION, request.beatmapId, request.ratePercent, request.modVariant],
    }
    : {
      table: "dan_estimates",
      keyColumns: ["estimator_version", "beatmap_id", "rate_percent"],
      keyValues: [DAN_ESTIMATE_CACHE_VERSION, request.beatmapId, request.ratePercent],
    };
}

/** The one upsert both the ready and the terminal writers go through. */
async function writeDanEstimateRow(
  db: Db,
  request: NormalizedDanEstimateRequest,
  row: {
    status: DanEstimateStatus;
    label: string | null;
    variant: string | null;
    displayName: string | null;
    rawDan: number | null;
    family: string | null;
    confidence: number | null;
    starRating: number | null;
    error: string | null;
    msdJson: string | null;
  },
): Promise<void> {
  const { table, keyColumns, keyValues } = danEstimateTable(request);
  const now = nowIso();
  await exec(
    db,
    `insert into ${table} (
       ${keyColumns.join(", ")}, status, label, variant, display_name,
       raw_dan, family, confidence, star_rating, error, msd_json, computed_at, updated_at
     )
     values (${keyColumns.map(() => "?").join(", ")}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict(${keyColumns.join(", ")}) do update set
       status = excluded.status,
       label = excluded.label,
       variant = excluded.variant,
       display_name = excluded.display_name,
       raw_dan = excluded.raw_dan,
       family = excluded.family,
       confidence = excluded.confidence,
       star_rating = excluded.star_rating,
       error = excluded.error,
       msd_json = coalesce(excluded.msd_json, ${table}.msd_json),
       computed_at = excluded.computed_at,
       updated_at = excluded.updated_at`,
    [
      ...keyValues,
      row.status,
      row.label,
      row.variant,
      row.displayName,
      row.rawDan,
      row.family,
      row.confidence,
      row.starRating,
      row.error,
      row.msdJson,
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

function danEstimateJobKey(beatmapId: number, ratePercent: number, modVariant?: DanChartVariant): string {
  return `dan:${DAN_ESTIMATE_CACHE_VERSION}:${beatmapId}:r${ratePercent}${modVariant ? `:${modVariant}` : ""}`;
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
