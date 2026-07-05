import type { Db } from "../db.js";
import { exec, parseJson } from "../db.js";

// Chart-derived "shape" of a beatmap and a player, used to weight the farm-helper
// peer cohort toward players whose charts look like the subject's (LN mains vs
// jack mains at the same pp should not get identical recs). Peer shapes come from
// the chart side only (map_search_index), never from per-peer skill ratings.

// Pattern-mix vector: the 8 map_search_index pat_* columns in this fixed order.
const PAT_COLUMNS = [
  "pat_jack", "pat_stream", "pat_jumpstream", "pat_handstream",
  "pat_stamina", "pat_chordjack", "pat_tech", "pat_ln",
] as const;
// MinaCalc skillsets (excluding Overall), normalized by Overall to capture shape
// rather than level. 4K only (msd is a 4K MinaCalc output).
const MSD_SKILLSETS = ["Stream", "Jumpstream", "Handstream", "Stamina", "JackSpeed", "Chordjack", "Technical"] as const;

export const SHAPE_MIN_CHARTS = 10;
export const SHAPE_MSD_MIN_CHARTS = 10;
export const SHAPE_FLOOR = 0.3;
export const SHAPE_SPAN = 0.7;
const SHAPE_NEUTRAL_DEFAULT = 0.65;

export interface ChartShape {
  pat: number[] | null;
  msd: number[] | null;
}

export interface UserShape {
  pat: number[] | null;
  msd: number[] | null;
  n: number;
}

// Batch-reads chart shapes from map_search_index. Uses the real pat_* columns and
// a single JSON.parse of msd_json per row (never json_extract in SQL).
export async function readChartShapes(db: Db, beatmapIds: number[]): Promise<Map<number, ChartShape>> {
  const ids = [...new Set(beatmapIds.filter((id) => Number.isSafeInteger(id) && id > 0))];
  const result = new Map<number, ChartShape>();
  const patCols = PAT_COLUMNS.join(", ");
  for (let i = 0; i < ids.length; i += 900) {
    const chunk = ids.slice(i, i + 900);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "?").join(",");
    const rows = (await exec(
      db,
      `select beatmap_id, key_count, ${patCols}, msd_overall, msd_json
       from map_search_index where beatmap_id in (${placeholders})`,
      chunk,
    )).rows;
    for (const row of rows) {
      const beatmapId = Number(row.beatmap_id);
      if (!Number.isSafeInteger(beatmapId) || beatmapId <= 0) continue;
      result.set(beatmapId, { pat: readPatVector(row), msd: readMsdVector(row) });
    }
  }
  return result;
}

function readPatVector(row: Record<string, unknown>): number[] | null {
  const vector: number[] = [];
  let anyPresent = false;
  for (const col of PAT_COLUMNS) {
    const value = row[col];
    if (value != null && Number.isFinite(Number(value))) {
      anyPresent = true;
      vector.push(Number(value));
    } else {
      vector.push(0);
    }
  }
  return anyPresent ? vector : null;
}

function readMsdVector(row: Record<string, unknown>): number[] | null {
  if (Number(row.key_count) !== 4) return null;
  if (row.msd_json == null) return null;
  const parsed = parseJson<{ values?: Record<string, number> }>(row.msd_json, {});
  const values = parsed?.values;
  if (!values || typeof values !== "object") return null;
  const overall = Number(values.Overall ?? row.msd_overall);
  if (!Number.isFinite(overall) || overall <= 0) return null;
  const vector: number[] = [];
  for (const skill of MSD_SKILLSETS) {
    const raw = Number(values[skill]);
    vector.push(Number.isFinite(raw) ? raw / overall : 0);
  }
  return vector;
}

// Weight-averages per-chart shapes into a user profile. `pat` is null unless at
// least SHAPE_MIN_CHARTS covered charts carry one; `msd` likewise. Null members
// are honest "unknown", never zero vectors. Returns null when nothing is covered.
export function aggregateShape(entries: Array<{ shape: ChartShape; weight: number }>): UserShape | null {
  const pat = weightedAverageVector(entries.map((e) => ({ vector: e.shape.pat, weight: e.weight })), PAT_COLUMNS.length, SHAPE_MIN_CHARTS);
  const msd = weightedAverageVector(entries.map((e) => ({ vector: e.shape.msd, weight: e.weight })), MSD_SKILLSETS.length, SHAPE_MSD_MIN_CHARTS);
  const patCovered = entries.reduce((count, e) => count + (e.shape.pat ? 1 : 0), 0);
  if (pat == null && msd == null) return null;
  return { pat, msd, n: patCovered };
}

function weightedAverageVector(
  entries: Array<{ vector: number[] | null; weight: number }>,
  length: number,
  minCharts: number,
): number[] | null {
  const covered = entries.filter((e) => e.vector != null && e.weight > 0 && Number.isFinite(e.weight));
  if (covered.length < minCharts) return null;
  const sum = new Array(length).fill(0);
  let totalWeight = 0;
  for (const entry of covered) {
    const vector = entry.vector as number[];
    if (vector.length !== length) continue;
    totalWeight += entry.weight;
    for (let i = 0; i < length; i++) sum[i] += vector[i] * entry.weight;
  }
  if (totalWeight <= 0) return null;
  return sum.map((v) => v / totalWeight);
}

// Cosine-based shape similarity in [-1, 1] (in practice [0, 1] for non-negative
// vectors). Combines pat and msd when both sides carry them; null when neither
// axis is comparable (missing vectors or a zero vector with no direction).
export function shapeSimilarity(a: UserShape, b: UserShape): number | null {
  const cosPat = a.pat && b.pat ? cosine(a.pat, b.pat) : null;
  const cosMsd = a.msd && b.msd ? cosine(a.msd, b.msd) : null;
  if (cosPat != null && cosMsd != null) return 0.5 * cosPat + 0.5 * cosMsd;
  if (cosPat != null) return cosPat;
  if (cosMsd != null) return cosMsd;
  return null;
}

function cosine(a: number[], b: number[]): number | null {
  if (a.length !== b.length) return null;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA <= 0 || magB <= 0) return null;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

// Per-cohort shape weights: wS = SHAPE_FLOOR + SHAPE_SPAN * similarity, with a
// bias-aware neutral (the mean wS of shaped peers) for peers whose shape is
// unknown, so they ride the cohort average instead of being floored or maxed.
export function computeShapeWeights(
  subjectShape: UserShape,
  peerShapes: Map<number, UserShape>,
  userIds: number[],
): Map<number, number> {
  const sims = new Map<number, number | null>();
  const shapedWeights: number[] = [];
  for (const userId of userIds) {
    const peerShape = peerShapes.get(userId) ?? null;
    const sim = peerShape ? shapeSimilarity(subjectShape, peerShape) : null;
    sims.set(userId, sim);
    if (sim != null) shapedWeights.push(SHAPE_FLOOR + SHAPE_SPAN * clamp01(sim));
  }
  const neutralW = shapedWeights.length
    ? shapedWeights.reduce((sum, w) => sum + w, 0) / shapedWeights.length
    : SHAPE_NEUTRAL_DEFAULT;
  const weights = new Map<number, number>();
  for (const userId of userIds) {
    const sim = sims.get(userId);
    weights.set(userId, sim != null ? SHAPE_FLOOR + SHAPE_SPAN * clamp01(sim) : neutralW);
  }
  return weights;
}

// Reads stored per-peer shape profiles for a set of users at one keyCount.
export async function readPeerShapes(db: Db, userIds: number[], keyCount: number): Promise<Map<number, UserShape>> {
  const ids = [...new Set(userIds.filter((id) => Number.isSafeInteger(id) && id > 0))];
  const result = new Map<number, UserShape>();
  for (let i = 0; i < ids.length; i += 900) {
    const chunk = ids.slice(i, i + 900);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "?").join(",");
    const rows = (await exec(
      db,
      `select user_id, shape_json from farm_helper_user_key_stats
       where key_count = ? and user_id in (${placeholders}) and shape_json is not null`,
      [keyCount, ...chunk],
    )).rows;
    for (const row of rows) {
      const userId = Number(row.user_id);
      if (!Number.isSafeInteger(userId) || userId <= 0) continue;
      const shape = parseUserShape(row.shape_json);
      if (shape) result.set(userId, shape);
    }
  }
  return result;
}

export function parseUserShape(shapeJson: unknown): UserShape | null {
  if (shapeJson == null) return null;
  const parsed = parseJson<{ pat?: unknown; msd?: unknown; n?: unknown }>(shapeJson, {});
  const pat = readVectorMember(parsed.pat, PAT_COLUMNS.length);
  const msd = readVectorMember(parsed.msd, MSD_SKILLSETS.length);
  if (pat == null && msd == null) return null;
  return { pat, msd, n: Number(parsed.n) || 0 };
}

function readVectorMember(value: unknown, length: number): number[] | null {
  if (!Array.isArray(value) || value.length !== length) return null;
  const vector = value.map((v) => Number(v));
  if (vector.some((v) => !Number.isFinite(v))) return null;
  return vector;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
