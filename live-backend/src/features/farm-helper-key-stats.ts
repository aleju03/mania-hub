import type { Db } from "../db.js";
import { exec, json, parseJson } from "../db.js";
import { calculateWeightedPpTotal, nowIso } from "../shared/score.js";
import { buildWeightedUserShape, readChartShapes, type ChartShape } from "./farm-helper-shape.js";

export type FarmHelperKeyCount = 4 | 7;

// Bumped when the seeded row shape changes so an existing DB rebuilds. v2 adds the
// per-peer shape_json profile (Stage 3).
const KEY_STATS_VERSION = 2;

export interface FarmHelperKeyStat {
  userId: number;
  weightedPp: number;
  scoreCount: number;
}

const KEY_COUNTS: FarmHelperKeyCount[] = [4, 7];
const SEEDED_META_PREFIX = "farm_helper_key_stats_seeded:";

const seedLocks = new WeakMap<Db, Map<FarmHelperKeyCount, Promise<void>>>();

export async function ensureFarmHelperKeyStatsSeeded(db: Db, keyCount: FarmHelperKeyCount): Promise<void> {
  // Version-driven: an existing DB seeded at an older version (or the legacy
  // boolean marker, which reads as 1) rebuilds so shape_json gets populated.
  const meta = (await exec(db, "select value_json from live_meta where key = ? limit 1", [seededMetaKey(keyCount)])).rows[0];
  if (meta) {
    const version = Number(parseJson<number | boolean>(meta.value_json, 0));
    if (Number.isFinite(version) && version >= KEY_STATS_VERSION) return;
  }

  let locks = seedLocks.get(db);
  if (!locks) seedLocks.set(db, (locks = new Map()));
  const current = locks.get(keyCount);
  if (current) return current;

  const lock = rebuildFarmHelperKeyStats(db, keyCount).finally(() => {
    locks?.delete(keyCount);
  });
  locks.set(keyCount, lock);
  return lock;
}

export async function readFarmHelperKeyStatsForUsers(
  db: Db,
  keyCount: FarmHelperKeyCount,
  userIds: number[],
): Promise<Map<number, FarmHelperKeyStat>> {
  await ensureFarmHelperKeyStatsSeeded(db, keyCount);

  const ids = uniqueUserIds(userIds);
  const result = new Map<number, FarmHelperKeyStat>();
  for (let i = 0; i < ids.length; i += 900) {
    const chunk = ids.slice(i, i + 900);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "?").join(",");
    const rows = (await exec(
      db,
      `select user_id, weighted_pp, score_count
       from farm_helper_user_key_stats
       where key_count = ? and user_id in (${placeholders})`,
      [keyCount, ...chunk],
    )).rows;
    for (const row of rows) {
      const userId = Number(row.user_id);
      const weightedPp = Number(row.weighted_pp);
      const scoreCount = Number(row.score_count);
      if (!Number.isSafeInteger(userId) || userId <= 0 || !Number.isFinite(weightedPp) || weightedPp <= 0) continue;
      result.set(userId, { userId, weightedPp, scoreCount: Number.isFinite(scoreCount) ? scoreCount : 0 });
    }
  }
  return result;
}

// --- Kernel-kNN peer pool + proxy calibration (Stage 2) ---

const KEYMODE_MIN_PROXY_SCORES = 8;
const CALIBRATION_DECILE_MIN_PAIRS = 300;
const CALIBRATION_MIN_PAIRS = 50;
const CALIBRATION_TTL_MS = 24 * 60 * 60_000;
const POOL_CACHE_TTL_MS = 5 * 60_000;

export interface RawKeyModePeer {
  userId: number;
  pp: number;
  weightedPp: number;
  variantPp: number | null;
}

export interface ProxyCalibrationBucket {
  proxyCenter: number;
  ratio: number;
}

// Maps the farmed-coverage proxy (weighted_pp) onto the real variant-pp scale so
// proxy-matched peers sit at the right distance from a variant-matched subject.
export interface ProxyCalibration {
  keyCount: FarmHelperKeyCount;
  pairs: number;
  buckets: ProxyCalibrationBucket[] | null;
  globalRatio: number | null;
  computedAt: string;
}

interface CachedPool {
  peers: RawKeyModePeer[];
  calibration: ProxyCalibration;
  expiresAt: number;
}

interface CachedCalibration {
  calibration: ProxyCalibration;
  expiresAt: number;
}

const poolCache = new WeakMap<Db, Map<FarmHelperKeyCount, CachedPool>>();
const calibrationCache = new WeakMap<Db, Map<FarmHelperKeyCount, CachedCalibration>>();

// Fetches every qualifying key-mode peer once per keyCount (subject-independent,
// cached 5 min) alongside the proxy calibration. Per-subject kernel selection
// then runs in JS, replacing the old per-subject band-ladder SQL.
export async function getKeyModePeerPool(
  db: Db,
  keyCount: FarmHelperKeyCount,
): Promise<{ peers: RawKeyModePeer[]; calibration: ProxyCalibration }> {
  await ensureFarmHelperKeyStatsSeeded(db, keyCount);
  const cache = mapFor(poolCache, db);
  const now = Date.now();
  const cached = cache.get(keyCount);
  if (cached && cached.expiresAt > now) return { peers: cached.peers, calibration: cached.calibration };

  const rows = (await exec(
    db,
    `select s.user_id, u.pp, s.weighted_pp, ${variantPpColumn(keyCount)} as variant_pp
     from farm_helper_user_key_stats s
     join users u on u.user_id = s.user_id
     where s.key_count = ?
       and s.score_count >= ?
       and u.pp is not null
       and u.pp > 0`,
    [keyCount, KEYMODE_MIN_PROXY_SCORES],
  )).rows;
  const peers: RawKeyModePeer[] = [];
  for (const row of rows) {
    const userId = Number(row.user_id);
    const pp = Number(row.pp);
    const weightedPp = Number(row.weighted_pp);
    if (!Number.isSafeInteger(userId) || userId <= 0) continue;
    if (!Number.isFinite(pp) || pp <= 0) continue;
    if (!Number.isFinite(weightedPp) || weightedPp <= 0) continue;
    const variantRaw = Number(row.variant_pp);
    const variantPp = row.variant_pp != null && Number.isFinite(variantRaw) && variantRaw > 0 ? variantRaw : null;
    peers.push({ userId, pp, weightedPp, variantPp });
  }
  const calibration = await getProxyCalibration(db, keyCount);
  cache.set(keyCount, { peers, calibration, expiresAt: now + POOL_CACHE_TTL_MS });
  return { peers, calibration };
}

// Lazily computes (and caches 24h) the proxy->variant calibration from paired
// users that have both a key-stat proxy and a real variant pp. Persisted to
// live_meta purely for admin observability.
export async function getProxyCalibration(db: Db, keyCount: FarmHelperKeyCount): Promise<ProxyCalibration> {
  const cache = mapFor(calibrationCache, db);
  const now = Date.now();
  const cached = cache.get(keyCount);
  if (cached && cached.expiresAt > now) return cached.calibration;

  const rows = (await exec(
    db,
    `select s.weighted_pp, ${variantPpColumn(keyCount)} as variant_pp
     from farm_helper_user_key_stats s
     join users u on u.user_id = s.user_id
     where s.key_count = ?
       and s.score_count >= ?
       and ${variantPpColumn(keyCount)} is not null
       and ${variantPpColumn(keyCount)} > 0`,
    [keyCount, KEYMODE_MIN_PROXY_SCORES],
  )).rows;
  const pairs: Array<{ proxy: number; variant: number }> = [];
  for (const row of rows) {
    const proxy = Number(row.weighted_pp);
    const variant = Number(row.variant_pp);
    if (Number.isFinite(proxy) && proxy > 0 && Number.isFinite(variant) && variant > 0) {
      pairs.push({ proxy, variant });
    }
  }
  const calibration = buildCalibration(keyCount, pairs);
  cache.set(keyCount, { calibration, expiresAt: now + CALIBRATION_TTL_MS });
  await persistCalibration(db, calibration);
  return calibration;
}

function buildCalibration(keyCount: FarmHelperKeyCount, pairs: Array<{ proxy: number; variant: number }>): ProxyCalibration {
  const computedAt = nowIso();
  if (pairs.length >= CALIBRATION_DECILE_MIN_PAIRS) {
    const sorted = [...pairs].sort((a, b) => a.proxy - b.proxy);
    const buckets: ProxyCalibrationBucket[] = [];
    const bucketCount = 10;
    for (let i = 0; i < bucketCount; i++) {
      const start = Math.floor((i * sorted.length) / bucketCount);
      const end = Math.floor(((i + 1) * sorted.length) / bucketCount);
      const slice = sorted.slice(start, end);
      if (slice.length === 0) continue;
      buckets.push({
        proxyCenter: median(slice.map((p) => p.proxy)),
        ratio: median(slice.map((p) => p.variant / p.proxy)),
      });
    }
    if (buckets.length >= 2) return { keyCount, pairs: pairs.length, buckets, globalRatio: null, computedAt };
  }
  if (pairs.length >= CALIBRATION_MIN_PAIRS) {
    return { keyCount, pairs: pairs.length, buckets: null, globalRatio: median(pairs.map((p) => p.variant / p.proxy)), computedAt };
  }
  return { keyCount, pairs: pairs.length, buckets: null, globalRatio: null, computedAt };
}

// Applies the calibration to a proxy weighted_pp. Piecewise-linear over the
// decile bucket centers (clamped to the end buckets), else a global ratio, else
// identity (too few pairs to trust any adjustment).
export function calibrateProxy(calibration: ProxyCalibration, weightedPp: number): number {
  if (!Number.isFinite(weightedPp) || weightedPp <= 0) return weightedPp;
  const buckets = calibration.buckets;
  if (buckets && buckets.length > 0) {
    return weightedPp * interpolateRatio(buckets, weightedPp);
  }
  if (calibration.globalRatio != null && calibration.globalRatio > 0) {
    return weightedPp * calibration.globalRatio;
  }
  return weightedPp;
}

function interpolateRatio(buckets: ProxyCalibrationBucket[], proxy: number): number {
  if (proxy <= buckets[0].proxyCenter) return buckets[0].ratio;
  const last = buckets[buckets.length - 1];
  if (proxy >= last.proxyCenter) return last.ratio;
  for (let i = 1; i < buckets.length; i++) {
    const hi = buckets[i];
    if (proxy <= hi.proxyCenter) {
      const lo = buckets[i - 1];
      const span = hi.proxyCenter - lo.proxyCenter;
      const t = span > 0 ? (proxy - lo.proxyCenter) / span : 0;
      return lo.ratio + t * (hi.ratio - lo.ratio);
    }
  }
  return last.ratio;
}

async function persistCalibration(db: Db, calibration: ProxyCalibration): Promise<void> {
  try {
    await exec(
      db,
      `insert into live_meta (key, value_json, updated_at) values (?, ?, ?)
       on conflict(key) do update set value_json = excluded.value_json, updated_at = excluded.updated_at`,
      [`farm_helper_proxy_calibration:v1:${calibration.keyCount}`, json(calibration), calibration.computedAt],
    );
  } catch {
    // Observability only; never fail peer selection because the meta write failed.
  }
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mapFor<K, V>(weak: WeakMap<Db, Map<K, V>>, db: Db): Map<K, V> {
  let map = weak.get(db);
  if (!map) weak.set(db, (map = new Map()));
  return map;
}

export async function refreshFarmHelperKeyStatsForUser(db: Db, userId: number, updatedAt = nowIso()): Promise<void> {
  if (!Number.isSafeInteger(userId) || userId <= 0) return;
  await exec(db, "delete from farm_helper_user_key_stats where user_id = ?", [userId]);
  const rows = (await exec(
    db,
    `select s.user_id, s.beatmap_id, s.pp, s.updated_at, round(coalesce(mb.cs, b.cs, 0)) as key_count
     from country_maps_farmed_scores s
     left join maps_beatmaps mb on mb.beatmap_id = s.beatmap_id
     left join beatmaps b on b.beatmap_id = s.beatmap_id
     where s.user_id = ?`,
    [userId],
  )).rows;
  const stats = collectStats(rows);
  const chartShapes = await readChartShapes(db, collectBeatmapIds(stats));
  await writeStats(db, stats, updatedAt, chartShapes);
}

async function rebuildFarmHelperKeyStats(db: Db, keyCount: FarmHelperKeyCount): Promise<void> {
  const rows = (await exec(
    db,
    `select s.user_id, s.beatmap_id, s.pp, s.updated_at, round(coalesce(mb.cs, b.cs, 0)) as key_count
     from country_maps_farmed_scores s
     left join maps_beatmaps mb on mb.beatmap_id = s.beatmap_id
     left join beatmaps b on b.beatmap_id = s.beatmap_id
     where round(coalesce(mb.cs, b.cs, 0)) = ?`,
    [keyCount],
  )).rows;

  const stats = collectStats(rows);
  const chartShapes = await readChartShapes(db, collectBeatmapIds(stats));
  await exec(db, "delete from farm_helper_user_key_stats where key_count = ?", [keyCount]);
  await writeStats(db, stats, nowIso(), chartShapes);
  const updatedAt = nowIso();
  await exec(
    db,
    `insert into live_meta (key, value_json, updated_at)
     values (?, ?, ?)
     on conflict(key) do update set value_json = excluded.value_json, updated_at = excluded.updated_at`,
    [seededMetaKey(keyCount), json(KEY_STATS_VERSION), updatedAt],
  );
}

function collectStats(rows: Record<string, unknown>[]): Map<FarmHelperKeyCount, Map<number, { scores: Map<number, number>; sourceUpdatedAt: string }>> {
  const stats = new Map<FarmHelperKeyCount, Map<number, { scores: Map<number, number>; sourceUpdatedAt: string }>>();
  for (const row of rows) {
    const keyCount = Number(row.key_count);
    if (!isFarmHelperKeyCount(keyCount)) continue;
    const userId = Number(row.user_id);
    const beatmapId = Number(row.beatmap_id);
    const pp = Number(row.pp);
    if (!Number.isSafeInteger(userId) || userId <= 0) continue;
    if (!Number.isSafeInteger(beatmapId) || beatmapId <= 0) continue;
    if (!Number.isFinite(pp) || pp <= 0) continue;

    let byUser = stats.get(keyCount);
    if (!byUser) stats.set(keyCount, (byUser = new Map()));
    let userStats = byUser.get(userId);
    if (!userStats) {
      userStats = { scores: new Map(), sourceUpdatedAt: "" };
      byUser.set(userId, userStats);
    }

    const current = userStats.scores.get(beatmapId) ?? 0;
    if (pp > current) userStats.scores.set(beatmapId, pp);
    const updatedAt = typeof row.updated_at === "string" ? row.updated_at : "";
    if (updatedAt > userStats.sourceUpdatedAt) userStats.sourceUpdatedAt = updatedAt;
  }
  return stats;
}

async function writeStats(
  db: Db,
  stats: Map<FarmHelperKeyCount, Map<number, { scores: Map<number, number>; sourceUpdatedAt: string }>>,
  updatedAt: string,
  chartShapes: Map<number, ChartShape>,
): Promise<void> {
  for (const keyCount of KEY_COUNTS) {
    const byUser = stats.get(keyCount);
    if (!byUser) continue;
    for (const [userId, userStats] of byUser) {
      const values = [...userStats.scores.values()];
      if (values.length === 0) continue;
      await exec(
        db,
        `insert into farm_helper_user_key_stats
           (key_count, user_id, weighted_pp, score_count, source_updated_at, updated_at, shape_json)
         values (?, ?, ?, ?, ?, ?, ?)
         on conflict(key_count, user_id) do update set
           weighted_pp = excluded.weighted_pp,
           score_count = excluded.score_count,
           source_updated_at = excluded.source_updated_at,
           updated_at = excluded.updated_at,
           shape_json = excluded.shape_json`,
        [
          keyCount,
          userId,
          calculateWeightedPpTotal(values.map((pp) => ({ pp }))),
          values.length,
          userStats.sourceUpdatedAt || updatedAt,
          updatedAt,
          computeUserShapeJson(userStats.scores, chartShapes),
        ],
      );
    }
  }
}

// Weight-averages the user's farmed charts' shapes, weighting each by its
// weighted-pp contribution (0.95^rank * pp) so their strongest farm maps set the
// profile. Returns null (stored as SQL NULL) when too few charts are covered.
function computeUserShapeJson(scores: Map<number, number>, chartShapes: Map<number, ChartShape>): string | null {
  const sorted = [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([beatmapId, pp]) => ({ beatmapId, pp }));
  const { shape } = buildWeightedUserShape(sorted, chartShapes);
  if (!shape) return null;
  return JSON.stringify({ pat: shape.pat, msd: shape.msd, n: shape.n });
}

// Collects every distinct farmed beatmap id across the collected stats so their
// chart shapes can be read in one batch before writing per-user profiles.
function collectBeatmapIds(stats: Map<FarmHelperKeyCount, Map<number, { scores: Map<number, number>; sourceUpdatedAt: string }>>): number[] {
  const ids = new Set<number>();
  for (const byUser of stats.values()) {
    for (const userStats of byUser.values()) {
      for (const beatmapId of userStats.scores.keys()) ids.add(beatmapId);
    }
  }
  return [...ids];
}

// The variant column is chosen from a validated keyCount (4 | 7), so the inlined
// column name cannot be attacker-controlled.
function variantPpColumn(keyCount: FarmHelperKeyCount): string {
  return keyCount === 7 ? "u.pp_7k" : "u.pp_4k";
}

function uniqueUserIds(userIds: number[]): number[] {
  return [...new Set(userIds.filter((id) => Number.isSafeInteger(id) && id > 0))];
}

function isFarmHelperKeyCount(value: number): value is FarmHelperKeyCount {
  return value === 4 || value === 7;
}

function seededMetaKey(keyCount: FarmHelperKeyCount): string {
  return `${SEEDED_META_PREFIX}${keyCount}`;
}
