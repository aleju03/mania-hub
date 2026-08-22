import { randomUUID } from "node:crypto";
import type { Db } from "../db.js";
import { exec, json, parseJson } from "../db.js";
import type { JobQueue } from "../jobs/queue.js";
import { CHART_ANALYSIS_VERSION } from "./chart-analysis.js";
import {
  PLAYER_SKILLS_VERSION,
  SKILL_RATING_SKILLSETS,
  SSR_CALC_GOAL_CAP,
  SSR_EXTRAPOLATION_BASE_GOAL,
  aggregateSsrs,
  getPlayRate,
  ssrGoalForScore,
  type PlayerSkillBreakdown,
  type PlayerSkillModeBreakdown,
} from "./player-skills.js";
import { nowIso } from "../shared/score.js";
import { logInfo } from "../logger.js";
import type { OscScore } from "../shared/types.js";

// Population baseline for the skill ratings: an approximate SSR per stored top
// play, computed with zero wasm from data already in SQLite —
//
//   ssrApprox(play, skillset) = msd_1x(chart, s) · R(rate, s) · A(goal)
//
// where msd_1x comes from beatmap_chart_analysis.msd_json, R is an exact
// DT/base ratio when the DT sweep stored one and a fitted power law rate^γ_s
// otherwise, and A derates by accuracy along the calc's own 0.93→0.965 slope.
// Per user and keymode the same erfc aggregation as the exact pipeline turns
// those into an approximate rating vector; per (keymode, axis) a quantile
// curve over all tracked users makes any single rating legible as a
// percentile. Subject and population sit on the same approximate scale, so
// the comparison is self-consistent; the exact rating stays the headline
// number. Running the real calc for every tracked user would be ~600k
// serialized wasm bursts (days of CPU) — the wrong tool for a baseline.
//
// Chunked, self-chaining, done-key-in-live_meta playbook like the DT sweep:
// each job invocation processes a batch of users into player_skill_baseline,
// then the final chunk folds the table into quantile curves stored in
// live_meta. The heavy chart map is cached per run at module level; a worker
// restart mid-run just rebuilds it on the next chunk.

export const SKILL_BASELINE_JOB = "refresh_skill_baseline";
// Bump to invalidate stored baselines (also bump when the goal function or
// PLAYER_SKILLS_VERSION semantics change enough to shift the approximate scale).
// v2: goals valued against each chart's real OD windows (player-skills v16).
export const SKILL_BASELINE_VERSION = 2;
export const SKILL_BASELINE_CURVES_META_KEY = `skill_baseline_curves:v${SKILL_BASELINE_VERSION}`;

const BASELINE_REFRESH_INTERVAL_MS = 7 * 24 * 60 * 60_000;
const BASELINE_USER_CHUNK = 100;
// A rating from a handful of plays is noise; the population only counts users
// with a real stack in the keymode.
export const BASELINE_MIN_PLAYS = 20;
// Quantile curves with too few users behind them read as precision they do
// not have; below this the axis publishes no percentile.
const BASELINE_MIN_USERS_PER_CURVE = 20;
const BASELINE_QUANTILE_POINTS = 200;
// Accuracy derate anchored on the calc's measured 0.93→0.965 window: the
// per-chart slope over that window sits at ~1.07-1.11 on real charts
// (player-skills.ts extrapolation bounds), so the global value is its
// midpoint. A(goal) = slope^((goal - 0.93) / 0.035).
const ACC_DERATE_SLOPE = 1.09;
const ACC_DERATE_WINDOW = SSR_CALC_GOAL_CAP - SSR_EXTRAPOLATION_BASE_GOAL;
// γ_s fit safety: ignore ratio samples where either side is near zero, fall
// back to a neutral exponent when the paired-chart corpus is too thin.
const GAMMA_MIN_SAMPLE = 50;
const GAMMA_FALLBACK = 1.0;
const PATTERN_TAG_MIN_SCORE = 0.5;
const BASELINE_PATTERN_MIN_PLAYS = 3;

const AXES = SKILL_RATING_SKILLSETS;

export interface BaselineChartEntry {
  keyCount: number;
  // Skillset values in SKILL_RATING_SKILLSETS order.
  msd: Float64Array;
  dtMsd: Float64Array | null;
  lnRatio: number | null;
  // Overall difficulty from the beatmaps row, for OD-aware wife goals.
  od: number | null;
  patterns: string[];
}

export interface BaselineFitParams {
  gamma: Record<string, number>;
  accSlope: number;
  pairs: number;
}

export interface ApproxPlay {
  beatmapId: number;
  rate: number;
  goal: number;
  patterns: string[];
  // Epoch ms of the play; feeds the per-keymode recency signal the farm
  // helper's cohort affinity reads. Optional: callers without timestamps
  // (the serving-side percentile path) just skip recency.
  endedAtMs?: number | null;
}

export interface BaselineCurves {
  computedAt: string;
  baselineVersion: number;
  playerSkillsVersion: number;
  gamma: Record<string, number>;
  accSlope: number;
  minPlays: number;
  // keyCount -> axis -> { count, curve } where curve is BASELINE_QUANTILE_POINTS
  // ascending quantile values and axis is a skillset name or `pattern:{id}`.
  curves: Record<string, Record<string, { count: number; curve: number[] }>>;
  users: Record<string, number>;
}

// Exact-scale population curves: quantiles of the stored exact ratings in
// player_skill_ratings, one blob for the whole roster. These exist so the
// served percentile ranks the SAME number the profile shows as its headline —
// the approximate scale above made the two disagree whenever a player's
// tracked-history plays (absent from the top-plays-only corpus) carried their
// rating. Affordable only since the roster-wide drip finished: every member
// has a stored exact rating, so the fold is a plain table scan, no wasm. The
// approximate baseline stays for the farm helper's cohort vectors and as the
// serving fallback until the first finalize writes this blob.
export const EXACT_SKILL_CURVES_META_KEY = "skill_exact_curves:v1";

// Per-(keymode, axis) curve entry. `median` is the raw population median the
// display shrink uses; curve values are already shrunk with it, so subject
// and population meet on exactly the displayed scale. The approximate curves
// predate the field and fall back to their curve midpoint.
interface AxisCurveEntry {
  count: number;
  curve: number[];
  median?: number;
}

type AxisCurveMap = Record<string, AxisCurveEntry>;

// Exact curves always carry the raw median their values were shrunk with.
interface ExactAxisCurveEntry extends AxisCurveEntry {
  median: number;
}

export interface ExactSkillCurves {
  computedAt: string;
  playerSkillsVersion: number;
  minPlays: number;
  // keyCount -> axis -> entry; axis is a skillset name or `pattern:{id}`.
  curves: Record<string, Record<string, ExactAxisCurveEntry>>;
  users: Record<string, number>;
}

export interface PlayerSkillAxisPercentile {
  // Share of the tracked population rating below the subject, 0-100.
  value: number;
  population: number;
}

export interface PublicPlayerSkillMode extends PlayerSkillModeBreakdown {
  percentiles?: Record<string, PlayerSkillAxisPercentile>;
  // Thin evidence base: fewer analyzed plays than the population baseline
  // requires of its own members (BASELINE_MIN_PLAYS). Ratings for such a
  // keymode are served shrunk hard toward the population median and should
  // read as rough estimates, not standings.
  provisional?: boolean;
}

export interface PublicPlayerSkillBreakdown extends PlayerSkillBreakdown {
  modes: PublicPlayerSkillMode[];
  baseline: { computedAt: string; users: Record<string, number> } | null;
}

function msdVector(values: Record<string, unknown> | undefined): Float64Array | null {
  if (!values) return null;
  const vector = new Float64Array(AXES.length);
  let any = false;
  for (let i = 0; i < AXES.length; i += 1) {
    const value = Number(values[AXES[i]]);
    if (Number.isFinite(value) && value > 0) {
      vector[i] = value;
      any = true;
    }
  }
  return any ? vector : null;
}

/** A(goal): accuracy derate along the global 0.93-anchored slope. */
function accuracyFactor(goal: number, accSlope: number): number {
  return Math.pow(accSlope, (goal - SSR_EXTRAPOLATION_BASE_GOAL) / ACC_DERATE_WINDOW);
}

/** R(rate, s): exact DT ratio when stored, fitted power law otherwise. */
function rateFactor(entry: BaselineChartEntry, axisIndex: number, rate: number, gamma: Record<string, number>): number {
  if (rate === 1) return 1;
  if (rate === 1.5 && entry.dtMsd && entry.dtMsd[axisIndex] > 0 && entry.msd[axisIndex] > 0) {
    return entry.dtMsd[axisIndex] / entry.msd[axisIndex];
  }
  return Math.pow(rate, gamma[AXES[axisIndex]] ?? GAMMA_FALLBACK);
}

/**
 * Approximate rating vectors per keymode from a set of plays: per-play
 * approximate SSRs aggregated with the same erfc fold as the exact pipeline,
 * plus pattern axes (`pattern:{id}`) over the plays' chart tags.
 */
export function computeApproxRatings(
  plays: ApproxPlay[],
  charts: Map<number, BaselineChartEntry>,
  params: Pick<BaselineFitParams, "gamma" | "accSlope">,
): Map<number, { analyzedPlays: number; ratings: Record<string, number>; latestPlayedAtMs: number | null }> {
  const byKeyCount = new Map<number, { ssrs: number[][]; patternOveralls: Map<string, number[]>; latestPlayedAtMs: number | null }>();
  for (const play of plays) {
    const entry = charts.get(play.beatmapId);
    if (!entry) continue;
    let bucket = byKeyCount.get(entry.keyCount);
    if (!bucket) {
      bucket = { ssrs: AXES.map(() => []), patternOveralls: new Map(), latestPlayedAtMs: null };
      byKeyCount.set(entry.keyCount, bucket);
    }
    if (play.endedAtMs != null && Number.isFinite(play.endedAtMs)) {
      bucket.latestPlayedAtMs = Math.max(bucket.latestPlayedAtMs ?? 0, play.endedAtMs);
    }
    const acc = accuracyFactor(play.goal, params.accSlope);
    let overall = 0;
    for (let i = 0; i < AXES.length; i += 1) {
      const base = entry.msd[i];
      if (!(base > 0)) continue;
      const ssr = base * rateFactor(entry, i, play.rate, params.gamma) * acc;
      bucket.ssrs[i].push(ssr);
      if (AXES[i] === "Overall") overall = ssr;
    }
    if (overall > 0) {
      for (const pattern of play.patterns) {
        const list = bucket.patternOveralls.get(pattern);
        if (list) list.push(overall);
        else bucket.patternOveralls.set(pattern, [overall]);
      }
    }
  }
  const result = new Map<number, { analyzedPlays: number; ratings: Record<string, number>; latestPlayedAtMs: number | null }>();
  for (const [keyCount, bucket] of byKeyCount) {
    const ratings: Record<string, number> = {};
    let analyzedPlays = 0;
    for (let i = 0; i < AXES.length; i += 1) {
      analyzedPlays = Math.max(analyzedPlays, bucket.ssrs[i].length);
      const rating = aggregateSsrs(bucket.ssrs[i]);
      if (rating > 0) ratings[AXES[i]] = rating;
    }
    for (const [pattern, overalls] of bucket.patternOveralls) {
      if (overalls.length < BASELINE_PATTERN_MIN_PLAYS) continue;
      const rating = aggregateSsrs(overalls);
      if (rating > 0) ratings[`pattern:${pattern}`] = rating;
    }
    result.set(keyCount, { analyzedPlays, ratings, latestPlayedAtMs: bucket.latestPlayedAtMs });
  }
  return result;
}

/**
 * Fit γ_s from the charts that carry both 1.0x and DT MSD: the median of
 * ln(msd_dt/msd_1x)/ln(1.5) per skillset. Purely statistical, no chart
 * identity involved. The corpus is 4K (the DT sweep's scope); other keymodes
 * reuse the same exponents as an approximation.
 */
export async function fitBaselineParams(db: Db): Promise<BaselineFitParams> {
  const samples: Record<string, number[]> = Object.fromEntries(AXES.map((axis) => [axis, []]));
  let cursor = 0;
  let pairs = 0;
  for (;;) {
    const rows = (await exec(
      db,
      `select beatmap_id, msd_json, msd_dt_json from beatmap_chart_analysis
       where analysis_version = ? and status = 'ready'
         and msd_json is not null and msd_dt_json is not null
         and beatmap_id > ?
       order by beatmap_id
       limit 2000`,
      [CHART_ANALYSIS_VERSION, cursor],
    )).rows;
    for (const row of rows) {
      cursor = Math.max(cursor, Number(row.beatmap_id));
      const base = parseJson<{ values?: Record<string, number> }>(String(row.msd_json ?? ""), {}).values;
      const dt = parseJson<{ values?: Record<string, number> }>(String(row.msd_dt_json ?? ""), {}).values;
      if (!base || !dt) continue;
      pairs += 1;
      for (const axis of AXES) {
        const baseValue = Number(base[axis]);
        const dtValue = Number(dt[axis]);
        // Near-zero skillset values are calc noise, not a rate signal.
        if (baseValue > 0.5 && dtValue > 0.5) {
          samples[axis].push(Math.log(dtValue / baseValue) / Math.log(1.5));
        }
      }
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (rows.length < 2000) break;
  }
  const gamma: Record<string, number> = {};
  for (const axis of AXES) {
    const values = samples[axis];
    if (values.length < GAMMA_MIN_SAMPLE) {
      gamma[axis] = GAMMA_FALLBACK;
      continue;
    }
    values.sort((a, b) => a - b);
    const median = values[Math.floor(values.length / 2)];
    gamma[axis] = Math.round(Math.max(0, Math.min(2.5, median)) * 1000) / 1000;
  }
  return { gamma, accSlope: ACC_DERATE_SLOPE, pairs };
}

/**
 * Load minimal chart entries (keyCount + MSD vectors + lnRatio + qualifying
 * pattern tags) for a bounded id set. Used by the serving-side percentile
 * decoration; the baseline job streams the whole corpus via
 * loadBaselineChartMap instead.
 */
export async function loadBaselineChartEntries(db: Db, beatmapIds: number[]): Promise<Map<number, BaselineChartEntry>> {
  const ids = [...new Set(beatmapIds)].filter((id) => Number.isInteger(id) && id > 0);
  const map = new Map<number, BaselineChartEntry>();
  if (ids.length === 0) return map;
  const placeholders = ids.map(() => "?").join(", ");
  const rows = (await exec(
    db,
    `select a.beatmap_id, a.key_count, a.msd_json, a.msd_dt_json, a.classification_json,
            json_extract(b.metadata_json, '$.accuracy') as od
     from beatmap_chart_analysis a
     left join beatmaps b on b.beatmap_id = a.beatmap_id and json_valid(b.metadata_json)
     where a.analysis_version = ? and a.status = 'ready' and a.msd_json is not null and a.beatmap_id in (${placeholders})`,
    [CHART_ANALYSIS_VERSION, ...ids],
  )).rows;
  for (const row of rows) {
    const entry = rowToChartEntry(row);
    if (entry) map.set(Number(row.beatmap_id), entry);
  }
  return map;
}

function rowToChartEntry(row: Record<string, unknown>): BaselineChartEntry | null {
  const keyCount = Number(row.key_count);
  if (!Number.isInteger(keyCount) || keyCount <= 0) return null;
  const msd = msdVector(parseJson<{ values?: Record<string, number> }>(String(row.msd_json ?? ""), {}).values);
  if (!msd) return null;
  const dtMsd = msdVector(parseJson<{ values?: Record<string, number> }>(String(row.msd_dt_json ?? ""), {}).values);
  const classification = parseJson<{ lnRatio?: unknown; vibro?: unknown; patterns?: Array<{ id?: unknown; score?: unknown }> } | null>(
    String(row.classification_json ?? ""),
    null,
  );
  // No vibro skip here: every baseline input is a pp-backed top play, so its
  // chart is ranked, and true vibro does not pass mania ranking criteria - a
  // vibro flag on these charts is a detector misfire, same trust rule as the
  // exact pipeline in player-skills.ts.
  const lnRatio = Number(classification?.lnRatio);
  const patterns = Array.isArray(classification?.patterns)
    ? [...new Set(classification.patterns
        .filter((hit) => Number(hit?.score ?? 0) >= PATTERN_TAG_MIN_SCORE)
        .map((hit) => String(hit?.id ?? ""))
        .filter(Boolean))]
    : [];
  // json_extract yields NULL for charts without a stored OD; Number(null)
  // would read as a real OD 0.
  const od = row.od == null ? Number.NaN : Number(row.od);
  return {
    keyCount,
    msd,
    dtMsd,
    lnRatio: Number.isFinite(lnRatio) ? Math.max(0, Math.min(1, lnRatio)) : null,
    od: Number.isFinite(od) && od >= 0 && od <= 10 ? od : null,
    patterns,
  };
}

// The full ~87k-chart map is expensive to build (a streamed scan with JSON
// parsing), so it is cached per run id at module level: chunk N+1 of the same
// run reuses chunk N's map, and a worker restart mid-run just rebuilds once.
let chartMapCache: { runId: string; map: Map<number, BaselineChartEntry>; params: BaselineFitParams } | null = null;

async function loadBaselineRunState(db: Db, runId: string): Promise<{ map: Map<number, BaselineChartEntry>; params: BaselineFitParams }> {
  if (chartMapCache && chartMapCache.runId === runId) return chartMapCache;
  const params = await fitBaselineParams(db);
  const map = new Map<number, BaselineChartEntry>();
  let cursor = 0;
  for (;;) {
    const rows = (await exec(
      db,
      `select a.beatmap_id, a.key_count, a.msd_json, a.msd_dt_json, a.classification_json,
              json_extract(b.metadata_json, '$.accuracy') as od
       from beatmap_chart_analysis a
       left join beatmaps b on b.beatmap_id = a.beatmap_id and json_valid(b.metadata_json)
       where a.analysis_version = ? and a.status = 'ready' and a.msd_json is not null and a.beatmap_id > ?
       order by a.beatmap_id
       limit 2000`,
      [CHART_ANALYSIS_VERSION, cursor],
    )).rows;
    for (const row of rows) {
      const beatmapId = Number(row.beatmap_id);
      cursor = Math.max(cursor, beatmapId);
      const entry = rowToChartEntry(row);
      if (entry) map.set(beatmapId, entry);
    }
    // Chunked scan + a breath per chunk: never park the worker loop on one
    // giant materialized read.
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (rows.length < 2000) break;
  }
  chartMapCache = { runId, map, params };
  logInfo("skill_baseline_chart_map_ready", { run_id: runId, charts: map.size, msd_pairs: params.pairs });
  return chartMapCache;
}

function scoreToApproxPlay(score: OscScore, charts: Map<number, BaselineChartEntry>): ApproxPlay | null {
  if (!(typeof score.pp === "number" && score.pp > 0)) return null;
  const beatmapId = Number(score.beatmap_id ?? score.beatmap?.id ?? 0);
  if (!Number.isInteger(beatmapId) || beatmapId <= 0) return null;
  const entry = charts.get(beatmapId);
  if (!entry) return null;
  const rate = getPlayRate(score.mods);
  if (rate == null) return null;
  // Same sub-floor exclusion as the exact pipeline: a play the calc would
  // rate at its 0.8 goal floor does not count toward the baseline either.
  const goal = ssrGoalForScore(score, entry.lnRatio, entry.od);
  if (goal == null) return null;
  const endedAtMs = Date.parse(String(score.ended_at ?? score.created_at ?? ""));
  return {
    beatmapId,
    rate,
    goal,
    patterns: entry.patterns,
    endedAtMs: Number.isFinite(endedAtMs) ? endedAtMs : null,
  };
}

export interface SkillBaselineChunkResult {
  nextCursor: number;
  usersProcessed: number;
  done: boolean;
}

export async function runSkillBaselineChunk(
  db: Db,
  runId: string,
  cursor: number,
  limit = BASELINE_USER_CHUNK,
): Promise<SkillBaselineChunkResult> {
  const { map, params } = await loadBaselineRunState(db, runId);
  const userRows = (await exec(
    db,
    "select distinct user_id from user_top_scores where user_id > ? order by user_id limit ?",
    [Math.max(0, Math.floor(cursor)), Math.max(1, Math.floor(limit))],
  )).rows;

  let nextCursor = cursor;
  const now = nowIso();
  for (const userRow of userRows) {
    const userId = Number(userRow.user_id);
    nextCursor = Math.max(nextCursor, userId);
    const scoreRows = (await exec(
      db,
      "select score_json from user_top_scores where user_id = ?",
      [userId],
    )).rows;
    const plays: ApproxPlay[] = [];
    for (const row of scoreRows) {
      const score = parseJson<OscScore | null>(String(row.score_json ?? ""), null);
      if (!score) continue;
      const play = scoreToApproxPlay(score, map);
      if (play) plays.push(play);
    }
    const byKeyCount = computeApproxRatings(plays, map, params);
    for (const [keyCount, mode] of byKeyCount) {
      await exec(
        db,
        `insert into player_skill_baseline (user_id, key_count, baseline_version, analyzed_plays, ratings_json, latest_played_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?)
         on conflict(user_id, key_count, baseline_version) do update set
           analyzed_plays = excluded.analyzed_plays,
           ratings_json = excluded.ratings_json,
           latest_played_at = excluded.latest_played_at,
           updated_at = excluded.updated_at`,
        [
          userId,
          keyCount,
          SKILL_BASELINE_VERSION,
          mode.analyzedPlays,
          json(mode.ratings),
          mode.latestPlayedAtMs != null ? new Date(mode.latestPlayedAtMs).toISOString() : null,
          now,
        ],
      );
    }
    // Parsing ~200 score payloads per user is the CPU burst; breathe per user.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  return { nextCursor, usersProcessed: userRows.length, done: userRows.length < limit };
}

function quantileCurve(sortedValues: number[], points = BASELINE_QUANTILE_POINTS): number[] {
  const curve: number[] = [];
  const last = sortedValues.length - 1;
  for (let i = 0; i < points; i += 1) {
    const position = (i / (points - 1)) * last;
    const low = Math.floor(position);
    const high = Math.min(last, low + 1);
    const t = position - low;
    curve.push(Math.round((sortedValues[low] * (1 - t) + sortedValues[high] * t) * 100) / 100);
  }
  return curve;
}

const EXACT_CURVES_USER_CHUNK = 500;

/**
 * Fold every roster member's stored exact ratings (modes_json) into
 * per-(keymode, axis) quantile curves. Values entering a curve are the
 * display-shrunk ratings — shrinkRating against the raw population median,
 * exactly what decoratePlayerSkillBreakdown serves — so a percentile is a
 * monotone function of the number on the page. Chunked with a breath per
 * chunk; runs at the tail of the baseline job, never on the serving path.
 */
export async function buildExactSkillCurves(db: Db): Promise<ExactSkillCurves> {
  const samples = new Map<number, Map<string, Array<{ value: number; plays: number }>>>();
  const members = new Map<number, number>();
  let cursor = 0;
  for (;;) {
    const rows = (await exec(
      db,
      `select user_id, modes_json from player_skill_ratings
       where analysis_version = ? and status = 'ready' and user_id > ?
         and user_id in (select distinct user_id from country_rosters)
       order by user_id
       limit ?`,
      [PLAYER_SKILLS_VERSION, cursor, EXACT_CURVES_USER_CHUNK],
    )).rows;
    for (const row of rows) {
      cursor = Math.max(cursor, Number(row.user_id));
      const modes = parseJson<{ modes?: PlayerSkillModeBreakdown[] }>(String(row.modes_json ?? ""), {}).modes;
      if (!Array.isArray(modes)) continue;
      for (const mode of modes) {
        const keyCount = Number(mode?.keyCount);
        const analyzedPlays = Number(mode?.analyzedPlays);
        if (!Number.isInteger(keyCount) || keyCount <= 0) continue;
        if (!(analyzedPlays >= BASELINE_MIN_PLAYS)) continue;
        let axes = samples.get(keyCount);
        if (!axes) samples.set(keyCount, (axes = new Map()));
        members.set(keyCount, (members.get(keyCount) ?? 0) + 1);
        const push = (axis: string, value: number, plays: number) => {
          if (!(value > 0)) return;
          const list = axes!.get(axis);
          if (list) list.push({ value, plays });
          else axes!.set(axis, [{ value, plays }]);
        };
        for (const axis of percentileAxes(keyCount, mode.ratings ?? {})) {
          push(axis, Number(mode.ratings?.[axis]), analyzedPlays);
        }
        for (const entry of mode.patterns ?? []) {
          const plays = Number(entry?.plays);
          if (!(plays >= BASELINE_PATTERN_MIN_PLAYS)) continue;
          push(`pattern:${entry.id}`, Number(entry?.rating), plays);
        }
      }
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (rows.length < EXACT_CURVES_USER_CHUNK) break;
  }

  const curves: ExactSkillCurves["curves"] = {};
  const users: Record<string, number> = {};
  for (const [keyCount, axes] of samples) {
    users[String(keyCount)] = members.get(keyCount) ?? 0;
    const axisCurves: Record<string, ExactAxisCurveEntry> = {};
    for (const [axis, list] of axes) {
      if (list.length < BASELINE_MIN_USERS_PER_CURVE) continue;
      const raw = list.map((sample) => sample.value).sort((a, b) => a - b);
      const median = raw[Math.floor((raw.length - 1) / 2)];
      const shrunk = list.map((sample) => shrinkRating(sample.value, sample.plays, median)).sort((a, b) => a - b);
      axisCurves[axis] = { count: list.length, curve: quantileCurve(shrunk), median };
    }
    curves[String(keyCount)] = axisCurves;
  }
  return {
    computedAt: nowIso(),
    playerSkillsVersion: PLAYER_SKILLS_VERSION,
    minPlays: BASELINE_MIN_PLAYS,
    curves,
    users,
  };
}

// An exact blob with no populated keymode (empty dev DB, roster wiped) is
// written anyway so the due-check settles, but serving treats it as absent
// and keeps the approximate fallback.
function exactCurvesUsable(curves: ExactSkillCurves | null): curves is ExactSkillCurves {
  return curves != null && Object.values(curves.curves).some((axes) => Object.keys(axes).length > 0);
}

async function finalizeSkillBaseline(db: Db, runId: string): Promise<void> {
  const rows = (await exec(
    db,
    "select user_id, key_count, analyzed_plays, ratings_json from player_skill_baseline where baseline_version = ? and analyzed_plays >= ?",
    [SKILL_BASELINE_VERSION, BASELINE_MIN_PLAYS],
  )).rows;
  const byKeyCount = new Map<number, Array<Record<string, number>>>();
  for (const row of rows) {
    const keyCount = Number(row.key_count);
    const ratings = parseJson<Record<string, number>>(String(row.ratings_json ?? ""), {});
    const list = byKeyCount.get(keyCount);
    if (list) list.push(ratings);
    else byKeyCount.set(keyCount, [ratings]);
  }

  const params = chartMapCache && chartMapCache.runId === runId ? chartMapCache.params : await fitBaselineParams(db);
  const curves: BaselineCurves["curves"] = {};
  const users: Record<string, number> = {};
  for (const [keyCount, ratingRows] of byKeyCount) {
    users[String(keyCount)] = ratingRows.length;
    const axisValues = new Map<string, number[]>();
    for (const ratings of ratingRows) {
      for (const [axis, value] of Object.entries(ratings)) {
        if (!(Number(value) > 0)) continue;
        const list = axisValues.get(axis);
        if (list) list.push(Number(value));
        else axisValues.set(axis, [Number(value)]);
      }
    }
    const axisCurves: Record<string, Omit<AxisCurveEntry, "median">> = {};
    for (const [axis, values] of axisValues) {
      if (values.length < BASELINE_MIN_USERS_PER_CURVE) continue;
      values.sort((a, b) => a - b);
      axisCurves[axis] = { count: values.length, curve: quantileCurve(values) };
    }
    curves[String(keyCount)] = axisCurves;
  }

  const now = nowIso();
  const blob: BaselineCurves = {
    computedAt: now,
    baselineVersion: SKILL_BASELINE_VERSION,
    playerSkillsVersion: PLAYER_SKILLS_VERSION,
    gamma: params.gamma,
    accSlope: params.accSlope,
    minPlays: BASELINE_MIN_PLAYS,
    curves,
    users,
  };
  await exec(
    db,
    `insert into live_meta (key, value_json, updated_at) values (?, ?, ?)
     on conflict(key) do update set value_json = excluded.value_json, updated_at = excluded.updated_at`,
    [SKILL_BASELINE_CURVES_META_KEY, json(blob), now],
  );
  const exactCurves = await buildExactSkillCurves(db);
  await exec(
    db,
    `insert into live_meta (key, value_json, updated_at) values (?, ?, ?)
     on conflict(key) do update set value_json = excluded.value_json, updated_at = excluded.updated_at`,
    [EXACT_SKILL_CURVES_META_KEY, json(exactCurves), nowIso()],
  );
  // Superseded-version rows are dead weight once the new curves are live.
  await exec(db, "delete from player_skill_baseline where baseline_version != ?", [SKILL_BASELINE_VERSION]);
  chartMapCache = null;
  curvesCache = null;
  exactCurvesCache = null;
  logInfo("skill_baseline_done", {
    run_id: runId,
    users: users,
    curve_keymodes: Object.keys(curves),
    exact_users: exactCurves.users,
    exact_keymodes: Object.keys(exactCurves.curves),
  });
}

export async function runSkillBaselineJob(db: Db, queue: JobQueue, payload: { runId?: string; cursor?: number } | undefined): Promise<void> {
  const runId = typeof payload?.runId === "string" && payload.runId ? payload.runId : randomUUID();
  const cursor = Math.max(0, Math.floor(Number(payload?.cursor ?? 0)));
  const result = await runSkillBaselineChunk(db, runId, cursor);
  if (result.done) {
    await finalizeSkillBaseline(db, runId);
    return;
  }
  await enqueueSkillBaselineChunk(queue, runId, result.nextCursor);
}

async function enqueueSkillBaselineChunk(queue: JobQueue, runId: string, cursor: number): Promise<void> {
  await queue.enqueue(
    SKILL_BASELINE_JOB,
    `${SKILL_BASELINE_JOB}:${runId}:${cursor}`,
    { runId, cursor },
    { priority: -10, replaceDone: true },
  );
}

/**
 * Weekly staleness check: (re)start the baseline chain when the stored curves
 * are missing, from an older baseline version, or past the refresh interval,
 * and no chain link is already pending. Pure DB/CPU work, no osu! API.
 */
export async function enqueueSkillBaselineIfDue(db: Db, queue: JobQueue, intervalMs = BASELINE_REFRESH_INTERVAL_MS): Promise<boolean> {
  const row = (await exec(db, "select value_json from live_meta where key = ? limit 1", [SKILL_BASELINE_CURVES_META_KEY])).rows[0];
  const stored = parseJson<BaselineCurves | null>(String(row?.value_json ?? ""), null);
  const computedAtMs = Date.parse(stored?.computedAt ?? "");
  const approxFresh =
    stored?.playerSkillsVersion === PLAYER_SKILLS_VERSION && Number.isFinite(computedAtMs) && Date.now() - computedAtMs < intervalMs;
  // The exact curves ride the same chain: a missing or version-stale exact
  // blob makes an otherwise-fresh run due again (one-time on the deploy that
  // introduces them; afterwards both blobs refresh in the same finalize).
  const exactRow = (await exec(db, "select value_json from live_meta where key = ? limit 1", [EXACT_SKILL_CURVES_META_KEY])).rows[0];
  const exactStored = parseJson<ExactSkillCurves | null>(String(exactRow?.value_json ?? ""), null);
  if (approxFresh && exactStored?.playerSkillsVersion === PLAYER_SKILLS_VERSION) {
    return false;
  }
  // After a PLAYER_SKILLS_VERSION bump this check fires immediately, but the
  // drip recomputes strongest players first, so curves rebuilt from its early
  // arrivals would skew every percentile low for the whole refresh interval
  // (the exact curves ARE those rows, so the same gate guards them). Keep
  // serving the previous version's curves until the new version covers the
  // majority of rated players.
  if (stored || exactStored) {
    const counts = (await exec(
      db,
      "select sum(case when analysis_version = ? then 1 else 0 end) as current, count(*) as total from player_skill_ratings where status = 'ready'",
      [PLAYER_SKILLS_VERSION],
    )).rows[0];
    if (Number(counts?.current ?? 0) * 2 < Number(counts?.total ?? 0)) return false;
  }
  const pending = (await exec(
    db,
    "select 1 from jobs where type = ? and status in ('queued', 'running', 'failed', 'deferred_pressure') limit 1",
    [SKILL_BASELINE_JOB],
  )).rows[0];
  if (pending) return false;
  await enqueueSkillBaselineChunk(queue, randomUUID(), 0);
  return true;
}

// --- Cohort vectors for the farm helper's skill/recency-aware neighbors ---

export interface BaselineUserVector {
  userId: number;
  analyzedPlays: number;
  ratings: Record<string, number>;
  latestPlayedAtMs: number | null;
}

interface CachedUserVectors {
  vectors: Map<number, BaselineUserVector>;
  expiresAt: number;
}

const userVectorsCache = new WeakMap<Db, Map<number, CachedUserVectors>>();
const USER_VECTORS_CACHE_TTL_MS = 5 * 60_000;

/**
 * All tracked users' approximate rating vectors for a keymode, cached per Db
 * like the farm helper's peer pools. Empty until the first baseline run has
 * landed, which callers must treat as "no signal", never as an empty cohort.
 */
export async function getBaselineUserVectors(db: Db, keyCount: number): Promise<Map<number, BaselineUserVector>> {
  let byKeyCount = userVectorsCache.get(db);
  if (!byKeyCount) userVectorsCache.set(db, (byKeyCount = new Map()));
  const now = Date.now();
  const cached = byKeyCount.get(keyCount);
  if (cached && cached.expiresAt > now) return cached.vectors;
  const rows = (await exec(
    db,
    "select user_id, analyzed_plays, ratings_json, latest_played_at from player_skill_baseline where baseline_version = ? and key_count = ?",
    [SKILL_BASELINE_VERSION, keyCount],
  )).rows;
  const vectors = new Map<number, BaselineUserVector>();
  for (const row of rows) {
    const userId = Number(row.user_id);
    if (!Number.isSafeInteger(userId) || userId <= 0) continue;
    const latestMs = Date.parse(String(row.latest_played_at ?? ""));
    vectors.set(userId, {
      userId,
      analyzedPlays: Math.max(0, Number(row.analyzed_plays) || 0),
      ratings: parseJson<Record<string, number>>(String(row.ratings_json ?? ""), {}),
      latestPlayedAtMs: Number.isFinite(latestMs) ? latestMs : null,
    });
  }
  byKeyCount.set(keyCount, { vectors, expiresAt: now + USER_VECTORS_CACHE_TTL_MS });
  return vectors;
}

// Serving-side curve cache: one small live_meta read, refreshed lazily. The
// serving process never builds the chart map or scans user_top_scores.
let curvesCache: { readAt: number; curves: BaselineCurves | null } | null = null;
const CURVES_CACHE_TTL_MS = 5 * 60_000;

export async function readBaselineCurves(db: Db): Promise<BaselineCurves | null> {
  if (curvesCache && Date.now() - curvesCache.readAt < CURVES_CACHE_TTL_MS) return curvesCache.curves;
  const row = (await exec(db, "select value_json from live_meta where key = ? limit 1", [SKILL_BASELINE_CURVES_META_KEY])).rows[0];
  const curves = parseJson<BaselineCurves | null>(String(row?.value_json ?? ""), null);
  curvesCache = { readAt: Date.now(), curves };
  return curves;
}

let exactCurvesCache: { readAt: number; curves: ExactSkillCurves | null } | null = null;

export async function readExactSkillCurves(db: Db): Promise<ExactSkillCurves | null> {
  if (exactCurvesCache && Date.now() - exactCurvesCache.readAt < CURVES_CACHE_TTL_MS) return exactCurvesCache.curves;
  const row = (await exec(db, "select value_json from live_meta where key = ? limit 1", [EXACT_SKILL_CURVES_META_KEY])).rows[0];
  const curves = parseJson<ExactSkillCurves | null>(String(row?.value_json ?? ""), null);
  exactCurvesCache = { readAt: Date.now(), curves };
  return curves;
}

function percentileFromCurve(curve: number[], value: number): number {
  if (curve.length === 0) return 0;
  if (value <= curve[0]) return 0;
  const last = curve.length - 1;
  if (value >= curve[last]) return 100;
  let low = 0;
  let high = last;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if (curve[mid] <= value) low = mid;
    else high = mid;
  }
  const span = curve[high] - curve[low];
  const t = span > 0 ? (value - curve[low]) / span : 0;
  return Math.round(((low + t) / last) * 1000) / 10;
}

// Axes eligible for a percentile per keymode: 4K speaks the native MSD
// skillsets (plus pattern axes); other keymodes publish Overall + pattern
// axes only, since MinaCalc's non-4K skillset names are unreliable.
function percentileAxes(keyCount: number, ratings: Record<string, number>): string[] {
  const axes = Object.keys(ratings);
  if (keyCount === 4) return axes;
  return axes.filter((axis) => axis === "Overall" || axis.startsWith("pattern:"));
}

// Evidence-weighted display shrink: aggregateSsrs is an absolute erfc fold,
// so a handful of all-killer plays converges near their own SSR level while a
// deep stack settles at what the player sustains - a 9-play 4K pool can
// outrank a 228-play 7K main. Served ratings therefore shrink toward the
// population median with the empirical-Bayes weight n/(n+k): thin pools
// become mostly prior, deep stacks stay essentially untouched. One-sided by
// design - a thin pool's bias is always upward (every play in it is a peak),
// so the shrink may lower a rating but never gifts one to a below-median
// pool. Display-layer only: stored ratings, farm-helper gating, and the
// percentile comparison (raw approx vs raw population) keep unshrunk values.
const RATING_SHRINK_K = 12;

function shrinkRating(value: number, plays: number, median: number | undefined): number {
  if (!(value > 0) || !(median != null && median > 0)) return value;
  const weight = Math.max(0, plays) / (Math.max(0, plays) + RATING_SHRINK_K);
  return Math.min(value, Math.round((value * weight + median * (1 - weight)) * 100) / 100);
}

function curveMedian(axisCurves: AxisCurveMap | undefined, axis: string): number | undefined {
  const entry = axisCurves?.[axis];
  if (!entry) return undefined;
  // Exact curves carry the raw median their values were shrunk with; using it
  // here keeps the subject's shrink identical to the population's. The
  // approximate curves predate the field and fall back to the curve midpoint.
  if (entry.median != null && entry.median > 0) return entry.median;
  if (!entry.curve || entry.curve.length === 0) return undefined;
  return entry.curve[Math.floor((entry.curve.length - 1) / 2)];
}

function shrinkMode(mode: PublicPlayerSkillMode, axisCurves: AxisCurveMap | undefined): PublicPlayerSkillMode {
  const ratings: Record<string, number> = {};
  for (const [axis, value] of Object.entries(mode.ratings)) {
    ratings[axis] = shrinkRating(Number(value), mode.analyzedPlays, curveMedian(axisCurves, axis));
  }
  const patterns = (mode.patterns ?? [])
    .map((entry) => ({ ...entry, rating: shrinkRating(entry.rating, entry.plays, curveMedian(axisCurves, `pattern:${entry.id}`)) }))
    .sort((a, b) => b.rating - a.rating);
  return { ...mode, ratings, patterns };
}

/**
 * Decorate an exact skill breakdown with population percentiles. Preferred
 * path: the display-shrunk exact ratings interpolated into the exact-scale
 * curves, so the percentile ranks precisely the number the page shows — one
 * live_meta read, nothing else. Fallback (until the first finalize writes the
 * exact blob): the subject's approximate ratings, recomputed from their
 * stored per-play cache with the same formula the approximate population
 * used, interpolated into the approximate curves.
 */
export async function decoratePlayerSkillBreakdown(
  db: Db,
  userId: number,
  breakdown: PlayerSkillBreakdown,
): Promise<PublicPlayerSkillBreakdown> {
  // Thin keymodes are flagged even before any baseline exists: the evidence
  // count is the mode's own datum.
  const marked: PublicPlayerSkillMode[] = breakdown.modes.map((mode) =>
    mode.analyzedPlays < BASELINE_MIN_PLAYS ? { ...mode, provisional: true } : { ...mode },
  );
  const base: PublicPlayerSkillBreakdown = { ...breakdown, modes: marked, baseline: null };
  if (breakdown.status !== "ready" || breakdown.modes.length === 0) return base;

  const exact = await readExactSkillCurves(db);
  if (exactCurvesUsable(exact)) {
    const minPlays = Math.max(1, Number(exact.minPlays) || 0);
    const modes: PublicPlayerSkillMode[] = marked.map((mode) => {
      const axisCurves = exact.curves[String(mode.keyCount)];
      const shrunk = shrinkMode(mode, axisCurves);
      // The population only admits keymodes with minPlays+ analyzed plays;
      // a subject below that floor gets no percentile.
      if (!axisCurves || mode.analyzedPlays < minPlays) return shrunk;
      const percentiles: Record<string, PlayerSkillAxisPercentile> = {};
      for (const axis of percentileAxes(mode.keyCount, shrunk.ratings)) {
        const axisCurve = axisCurves[axis];
        const value = Number(shrunk.ratings[axis]);
        if (!axisCurve || !(value > 0)) continue;
        percentiles[axis] = { value: percentileFromCurve(axisCurve.curve, value), population: axisCurve.count };
      }
      for (const entry of shrunk.patterns ?? []) {
        if (!(Number(entry.plays) >= BASELINE_PATTERN_MIN_PLAYS) || !(entry.rating > 0)) continue;
        const axisCurve = axisCurves[`pattern:${entry.id}`];
        if (!axisCurve) continue;
        percentiles[`pattern:${entry.id}`] = { value: percentileFromCurve(axisCurve.curve, entry.rating), population: axisCurve.count };
      }
      return Object.keys(percentiles).length > 0 ? { ...shrunk, percentiles } : shrunk;
    });
    return { ...base, modes, baseline: { computedAt: exact.computedAt, users: exact.users } };
  }

  const curves = await readBaselineCurves(db);
  if (!curves) return base;
  base.modes = marked.map((mode) => shrinkMode(mode, curves.curves[String(mode.keyCount)]));

  const playsRow = (await exec(
    db,
    "select plays_json from player_skill_ratings where user_id = ? and analysis_version = ?",
    [userId, PLAYER_SKILLS_VERSION],
  )).rows[0];
  const storedPlays = parseJson<{ plays?: Array<{ beatmapId?: number; rate?: number; goal?: number; patterns?: string[]; source?: string }> }>(
    String(playsRow?.plays_json ?? ""),
    {},
  ).plays ?? [];
  // The population curves are built from top plays only, so the subject's
  // approximate rating compares top-sourced plays only - tracked-history
  // plays would put the subject on a different scale than the population.
  const plays: ApproxPlay[] = storedPlays
    .filter((play) => play.source !== "tracked")
    .filter((play) => Number.isInteger(play.beatmapId) && Number(play.rate) > 0 && Number(play.goal) > 0)
    .map((play) => ({
      beatmapId: Number(play.beatmapId),
      rate: Number(play.rate),
      goal: Number(play.goal),
      patterns: Array.isArray(play.patterns) ? play.patterns : [],
    }));
  if (plays.length === 0) return base;

  const charts = await loadBaselineChartEntries(db, plays.map((play) => play.beatmapId));
  const approxByKeyCount = computeApproxRatings(plays, charts, { gamma: curves.gamma, accSlope: curves.accSlope });

  const modes: PublicPlayerSkillMode[] = base.modes.map((mode) => {
    const axisCurves = curves.curves[String(mode.keyCount)];
    const approx = approxByKeyCount.get(mode.keyCount);
    if (!axisCurves || !approx) return { ...mode };
    // The population only admits users with minPlays+ rated plays; a subject
    // below that floor gets no percentile - "top 1%" from a 9-play pool is
    // precision the evidence does not carry.
    if (approx.analyzedPlays < Math.max(1, Number(curves.minPlays) || 0)) return { ...mode };
    const percentiles: Record<string, PlayerSkillAxisPercentile> = {};
    for (const axis of percentileAxes(mode.keyCount, approx.ratings)) {
      const axisCurve = axisCurves[axis];
      if (!axisCurve) continue;
      percentiles[axis] = {
        value: percentileFromCurve(axisCurve.curve, approx.ratings[axis]),
        population: axisCurve.count,
      };
    }
    return Object.keys(percentiles).length > 0 ? { ...mode, percentiles } : { ...mode };
  });

  return { ...base, modes, baseline: { computedAt: curves.computedAt, users: curves.users } };
}
