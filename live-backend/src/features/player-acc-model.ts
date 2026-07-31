import type { Db } from "../db.js";
import { exec, parseJson } from "../db.js";
import { CHART_ANALYSIS_VERSION } from "./chart-analysis.js";
import { PAT_COLUMNS, PAT_FAMILY_IDS, primaryPatternFamily } from "./farm-helper-shape.js";
import type { PlayerSkillModeBreakdown } from "./player-skills.js";

// Personal accuracy curve model (task A7): per keymode and pattern family, a
// model of what accuracy THIS player would score on a chart, as a function of
// the difficulty gap between the chart and the player.
//
// Trained inside the skills job from the same per-play SSR cache the skill
// ratings use (player_skill_ratings.plays_json), never on the request path.
// Persisted next to the ratings in player_skill_ratings.acc_model_json;
// consumers (farm helper A8 target scaling, A10 survival term) read it with
// readPlayerAccModel and call predictPlayerAccuracy / predictPlayerChoke.
//
// Predicted quantity: the 320-weighted CUSTOM accuracy of mania pp
// (calculateManiaCustomAccuracy in shared/score.ts). For a fixed map+mods,
// mania pp is linear in (5 * customAcc - 4), so an A8 consumer can scale a
// peer benchmark pp by (5 * accYou - 4) / (5 * accTypical - 4) directly.
// StoredPlaySsr.accuracy is the DISPLAYED accuracy (lazer accuracy for lazer
// scores, stable formula for stable) and stableAccuracy is the stable
// formula; neither is the custom accuracy, so plays now carry an explicit
// customAccuracy field, and plays cached before that field existed fall back
// to an estimate from stableAccuracy plus the play's wife goal (see
// resolvePlayCustomAccuracy).
//
// Difficulty axis: gap = chartOverall - playerRating, where chartOverall is
// the chart's MSD Overall at the lane's rate from the chart-side stores
// (map_search_index.msd_overall at 1.0x, the DT-rate analysis sweep at 1.5x,
// linear 0.75x scaling for HT - the same sources and approximations the
// feasibility gate uses), and playerRating is the keymode's aggregate Overall
// rating at fit time (stored in the model so predict-time gaps use the same
// anchor). Training deliberately uses the chart-side MSD rather than the
// play's own SSR: the SSR is computed at the play's accuracy goal, so using
// it as the difficulty axis would leak the outcome into the regressor.
//
// Functional form: ln(errorRate) = a + bn * min(gap, 0) + bp * max(gap, 0)
// with errorRate = 1 - customAcc. Measured on the prod DB (2026-07, ~100k
// plays across ~1.1k players) the log error rate is close to linear in gap
// with a kink at gap 0: error grows ~e^0.085 per MSD point below the
// player's level and ~e^0.15 per point above it. The hinge captures that.
// Median predicted acc = 1 - exp(mu); other percentiles come from the
// residual spread s (normal in log-error space).
//
// Shrinkage hierarchy: global prior (constants below, measured on the prod
// DB) -> per-keymode curve (shrunk toward the prior, with a sparse keymode's
// prior seeded by the best-evidenced donor keymode) -> per-family curve
// (shrunk toward the keymode curve). A family the player has NEVER played
// serves the keymode curve at reduced confidence; a keymode with zero plays
// serves the donor keymode's curve at low confidence. Predictions therefore
// degrade to "prior, wide uncertainty" instead of returning null - the only
// null case is a model with no rated keymode at all.
//
// Low confidence lowers the served percentile: accConservative sits at the
// 50th percentile at full confidence and slides toward the 20th as
// confidence drops (with the residual spread widening at the same time), so
// thin evidence always reads as a more cautious accuracy, never a more
// optimistic one.

export const ACC_MODEL_VERSION = 1;

// Global prior, fitted pooled across players on the prod-synced DB
// (2026-07): ln e = A0 + BN0 * min(g,0) + BP0 * max(g,0), residual std S0.
// At gap 0 this predicts ~93.9% custom accuracy.
const PRIOR_A = -2.8;
const PRIOR_BN = 0.085;
const PRIOR_BP = 0.15;
const PRIOR_S = 0.45;

// The prior's predicted custom accuracy at gap 0 (~93.9%): what a typical
// player scores on an on-level chart. The farm helper's benchmark scaling
// (A8) anchors its "typical peer accuracy" fallback here while the stored
// peer-accuracy columns (A9) are still mostly null, so an on-level chart
// gets a multiplier near 1 and only outgrown charts get discounted.
export const ACC_MODEL_PRIOR_TYPICAL_ACC = 1 - Math.exp(PRIOR_A);

// Error-rate clamp: 5e-4 (99.95% custom acc, all-MAX territory) to 0.5.
const E_MIN = 5e-4;
const E_MAX = 0.5;

// Slope sanity bounds. bn is the below-level slope, bp the above-level one;
// convexity (bp >= bn >= 0) is enforced so extrapolation past the player's
// level always degrades accuracy at least as fast as under it.
const BN_MAX = 0.4;
const BP_MAX = 0.9;

// Shrinkage pseudo-counts (in units of effective play weight).
const K_MODE = 25;
const K_FAM = 12;
// Donor keymode influence on a sparse keymode's prior caps here.
const DONOR_PRIOR_MAX_T = 0.7;

// Recency weighting of training plays: full weight for fresh plays, halving
// yearly, floored so old evidence still counts (mirrors the farm helper's
// recency treatment).
const RECENCY_HALF_LIFE_MS = 365 * 86_400_000;
const RECENCY_FLOOR = 0.25;

// A keymode below this effective weight is transfer-seeded and flagged
// (mirrors the feasibility gate's FEASIBILITY_MIN_ANALYZED_PLAYS).
const TRANSFER_BELOW_WEIGHT = 30;

// Residual-spread bounds; the fit blends toward PRIOR_S inside these.
const S_MIN = 0.25;
const S_MAX = 0.8;

// Choke curve: fixed gap bins per keymode, capturing missShare as a function
// of gap for A10's P(finish) term. Edges partition (-inf, +inf).
const CHOKE_BIN_EDGES = [-6, -4, -2, 0, 2] as const;
const CHOKE_BIN_CENTERS = [-7, -5, -3, -1, 1, 3] as const;
const CHOKE_MISS_SHARE_THRESHOLD = 0.015;
const CHOKE_BIN_MIN_N = 3;

// Fallback custom-accuracy estimate for plays cached before customAccuracy
// existed: customAcc = 0.9375 * stableAcc + 0.0625 * maxShare exactly (320-
// vs 300-weighting differ only in the MAX term), with maxShare estimated
// from the stable accuracy and the play's wife goal. Coefficients fitted on
// ~100k plays with known judgement counts (custom-acc MAE 0.003).
const MAXSHARE_C0 = -2.262;
const MAXSHARE_C_STABLE = 2.328;
const MAXSHARE_C_GOAL = 0.681;

// Minimal play shape the model consumes (structurally satisfied by
// player-skills' StoredPlaySsr).
export interface AccModelPlay {
  identity: string;
  beatmapId: number;
  keyCount: number;
  rate: number;
  goal: number;
  patterns: string[];
  customAccuracy?: number | null;
  accuracy?: number;
  stableAccuracy?: number | null;
  missShare?: number | null;
  endedAt?: string | null;
}

export interface AccModelFamilyCurve {
  n: number;
  a: number;
  bn: number;
  bp: number;
}

export interface AccModelChokeBin {
  n: number;
  // Fraction of plays in the bin with missShare above the choke threshold.
  c: number;
  // Mean missShare of the bin.
  m: number;
}

export interface AccModelMode {
  keys: number;
  // Aggregate Overall rating the gaps were computed against at fit time.
  rating: number;
  // Raw sample count and effective (recency-weighted) weight.
  n: number;
  w: number;
  a: number;
  bn: number;
  bp: number;
  s: number;
  // Weighted mean custom accuracy (the naive baseline).
  mean: number;
  // Observed gap 5th/95th percentiles; predictions extrapolating past them
  // lose confidence.
  lo: number;
  hi: number;
  fam: Record<string, AccModelFamilyCurve>;
  choke: AccModelChokeBin[];
  // Set when the keymode had too little own evidence and its prior was
  // seeded from a donor keymode.
  transfer?: boolean;
}

export interface PlayerAccModel {
  v: number;
  modes: Record<string, AccModelMode>;
}

export interface PlayerAccPrediction {
  // Median predicted custom accuracy on this chart.
  accMedian: number;
  // Good-day accuracy (85th percentile of the predictive distribution).
  accP85: number;
  // Confidence-shaded accuracy for discounting: the 50th percentile at full
  // confidence, sliding toward the 20th as confidence drops.
  accConservative: number;
  confidence: number;
  gap: number;
  // own: the requested keymode carried enough evidence; transfer: the
  // keymode was fitted but prior-dominated via the donor keymode; donor: the
  // keymode had zero fitted entry and the donor keymode's curve served.
  source: "own" | "transfer" | "donor";
  // Rated plays backing the family curve that served (0 = keymode curve).
  familyPlays: number;
}

export interface PlayerChokePrediction {
  // Expected missShare at this gap.
  missShare: number;
  // Probability of a choked play (missShare above the dan-clear threshold).
  chokeRate: number;
  confidence: number;
}

// One training sample: a play joined with its chart-side difficulty.
export interface AccSample {
  identity: string;
  keyCount: number;
  chartOverall: number;
  gap: number;
  acc: number;
  weight: number;
  family: string | null;
  missShare: number | null;
}

export interface AccChartDifficulty {
  overall: number | null;
  dtOverall: number | null;
  family: string | null;
}

/**
 * The custom (320-weighted) accuracy of a stored play: the explicit field
 * when the play was cached after it shipped, otherwise an estimate from the
 * stable accuracy and wife goal (see MAXSHARE_* above). Null when the play
 * carries no usable accuracy at all.
 */
export function resolvePlayCustomAccuracy(play: Pick<AccModelPlay, "customAccuracy" | "accuracy" | "stableAccuracy" | "goal">): number | null {
  const custom = Number(play.customAccuracy);
  if (Number.isFinite(custom) && custom > 0 && custom <= 1) return custom;
  const stable = play.stableAccuracy ?? play.accuracy ?? null;
  if (stable == null || !(stable > 0) || stable > 1) return null;
  const goal = Number.isFinite(play.goal) ? play.goal : stable;
  const maxShare = clamp01(MAXSHARE_C0 + MAXSHARE_C_STABLE * stable + MAXSHARE_C_GOAL * goal);
  return clamp01(0.9375 * stable + 0.0625 * maxShare);
}

/**
 * Chart-side difficulty facts for the model: MSD Overall at 1.0x
 * (map_search_index), at 1.5x (the DT-rate analysis sweep), and the primary
 * pattern family from the pat_* vector - the same family axis the farm
 * helper's gate keys on, so train-time and predict-time families agree.
 */
export async function loadAccChartDifficulty(db: Db, beatmapIds: number[]): Promise<Map<number, AccChartDifficulty>> {
  const ids = [...new Set(beatmapIds.filter((id) => Number.isSafeInteger(id) && id > 0))];
  const result = new Map<number, AccChartDifficulty>();
  for (let i = 0; i < ids.length; i += 900) {
    const chunk = ids.slice(i, i + 900);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "?").join(",");
    const rows = (await exec(
      db,
      `select beatmap_id, msd_overall, ${PAT_COLUMNS.join(", ")} from map_search_index
       where beatmap_id in (${placeholders})`,
      chunk,
    )).rows;
    for (const row of rows) {
      const beatmapId = Number(row.beatmap_id);
      if (!Number.isSafeInteger(beatmapId) || beatmapId <= 0) continue;
      const overall = Number(row.msd_overall);
      const pat = PAT_COLUMNS.map((col) => Number(row[col] ?? 0));
      result.set(beatmapId, {
        overall: Number.isFinite(overall) && overall > 0 ? overall : null,
        dtOverall: null,
        family: primaryPatternFamily(pat),
      });
    }
    const dtRows = (await exec(
      db,
      `select beatmap_id, msd_dt_json from beatmap_chart_analysis
       where analysis_version = ? and beatmap_id in (${placeholders}) and msd_dt_json is not null`,
      [CHART_ANALYSIS_VERSION, ...chunk],
    )).rows;
    for (const row of dtRows) {
      const beatmapId = Number(row.beatmap_id);
      const entry = result.get(beatmapId);
      const parsed = parseJson<{ values?: Record<string, number> }>(row.msd_dt_json, {});
      const dtOverall = Number(parsed?.values?.Overall);
      if (!(Number.isFinite(dtOverall) && dtOverall > 0)) continue;
      if (entry) entry.dtOverall = dtOverall;
      else result.set(beatmapId, { overall: null, dtOverall, family: null });
    }
  }
  return result;
}

/**
 * Joins plays with chart-side difficulty into training samples. Plays whose
 * chart has no stored difficulty at the played rate contribute nothing (never
 * guess difficulty from the play's own SSR - it embeds the outcome).
 */
export function buildAccSamples(
  plays: AccModelPlay[],
  ratingByKeys: Map<number, number>,
  chartData: Map<number, AccChartDifficulty>,
  now = Date.now(),
): AccSample[] {
  const samples: AccSample[] = [];
  for (const play of plays) {
    const rating = ratingByKeys.get(play.keyCount);
    if (!(rating != null && rating > 0)) continue;
    const chart = chartData.get(play.beatmapId);
    if (!chart) continue;
    let chartOverall: number | null = null;
    if (play.rate === 1) chartOverall = chart.overall;
    else if (play.rate === 1.5) {
      // Prefer the stored DT sweep; linear rate scaling is the same
      // approximation the gate's HT lane uses when no sweep exists.
      chartOverall = chart.dtOverall ?? (chart.overall != null ? chart.overall * 1.5 : null);
    } else if (play.rate > 0) {
      chartOverall = chart.overall != null ? chart.overall * play.rate : null;
    }
    if (!(chartOverall != null && chartOverall > 0)) continue;
    const acc = resolvePlayCustomAccuracy(play);
    if (acc == null) continue;
    const endedMs = Date.parse(String(play.endedAt ?? ""));
    const ageMs = Number.isFinite(endedMs) ? Math.max(0, now - endedMs) : 0;
    const weight = Math.max(RECENCY_FLOOR, Math.pow(0.5, ageMs / RECENCY_HALF_LIFE_MS));
    const family = chart.family ?? fallbackFamilyFromTags(play.patterns);
    const missShare = play.missShare != null && Number.isFinite(play.missShare) ? Math.max(0, play.missShare) : null;
    samples.push({
      identity: play.identity,
      keyCount: play.keyCount,
      chartOverall,
      gap: chartOverall - rating,
      acc,
      weight,
      family,
      missShare,
    });
  }
  return samples;
}

function fallbackFamilyFromTags(patterns: string[] | undefined): string | null {
  for (const tag of patterns ?? []) {
    if ((PAT_FAMILY_IDS as readonly string[]).includes(tag)) return tag;
  }
  return null;
}

interface HingeCurve {
  a: number;
  bn: number;
  bp: number;
}

// Weighted least squares of ln(e) on [1, min(g,0), max(g,0)] via the 3x3
// normal equations, with the convexity clamp (0 <= bn <= bp) and an
// intercept refit after clamping. Streaming accumulation only - no matrices
// of samples are ever materialized.
function fitHinge(samples: Array<{ gap: number; y: number; weight: number }>): HingeCurve | null {
  let sw = 0;
  const sx = [0, 0];
  const sxx = [0, 0, 0]; // x1x1, x1x2, x2x2
  let sy = 0;
  const sxy = [0, 0];
  for (const { gap, y, weight } of samples) {
    const x1 = Math.min(gap, 0);
    const x2 = Math.max(gap, 0);
    sw += weight;
    sx[0] += weight * x1;
    sx[1] += weight * x2;
    sxx[0] += weight * x1 * x1;
    sxx[1] += weight * x1 * x2; // always 0, kept for clarity of the equations
    sxx[2] += weight * x2 * x2;
    sy += weight * y;
    sxy[0] += weight * x1 * y;
    sxy[1] += weight * x2 * y;
  }
  if (!(sw > 0)) return null;
  const solved = solve3(
    [
      [sw, sx[0], sx[1]],
      [sx[0], sxx[0], sxx[1]],
      [sx[1], sxx[1], sxx[2]],
    ],
    [sy, sxy[0], sxy[1]],
  );
  let a: number;
  let bn: number;
  let bp: number;
  if (solved && solved.every((v) => Number.isFinite(v))) {
    [a, bn, bp] = solved;
  } else {
    // Degenerate design (all gaps on one side, or a single distinct gap):
    // keep the prior slopes and fit the intercept alone.
    bn = PRIOR_BN;
    bp = PRIOR_BP;
    a = (sy - bn * sx[0] - bp * sx[1]) / sw;
  }
  bn = Math.min(BN_MAX, Math.max(0, bn));
  bp = Math.min(BP_MAX, Math.max(bn, bp));
  // Refit the intercept under the clamped slopes so the curve still passes
  // through the weighted center of the data.
  a = (sy - bn * sx[0] - bp * sx[1]) / sw;
  if (!Number.isFinite(a)) return null;
  return { a, bn, bp };
}

function solve3(m: number[][], v: number[]): number[] | null {
  const a = m.map((row) => [...row]);
  const b = [...v];
  for (let i = 0; i < 3; i++) {
    let pivot = i;
    for (let r = i + 1; r < 3; r++) if (Math.abs(a[r][i]) > Math.abs(a[pivot][i])) pivot = r;
    if (Math.abs(a[pivot][i]) < 1e-9) return null;
    if (pivot !== i) {
      [a[i], a[pivot]] = [a[pivot], a[i]];
      [b[i], b[pivot]] = [b[pivot], b[i]];
    }
    for (let r = 0; r < 3; r++) {
      if (r === i) continue;
      const f = a[r][i] / a[i][i];
      for (let c = i; c < 3; c++) a[r][c] -= f * a[i][c];
      b[r] -= f * b[i];
    }
  }
  return [b[0] / a[0][0], b[1] / a[1][1], b[2] / a[2][2]];
}

function blendCurve(fit: HingeCurve, prior: HingeCurve, weight: number, pseudo: number): HingeCurve {
  const t = weight / (weight + pseudo);
  return {
    a: t * fit.a + (1 - t) * prior.a,
    bn: t * fit.bn + (1 - t) * prior.bn,
    bp: t * fit.bp + (1 - t) * prior.bp,
  };
}

function curveMu(curve: HingeCurve, gap: number): number {
  return curve.a + curve.bn * Math.min(gap, 0) + curve.bp * Math.max(gap, 0);
}

function logError(acc: number): number {
  return Math.log(Math.max(E_MIN, Math.min(E_MAX, 1 - acc)));
}

interface ModeMeta {
  keyCount: number;
  rating: number;
}

/**
 * Fits the full model from pre-built samples. `modes` supplies the per-
 * keymode Overall ratings the gaps were computed against (they are persisted
 * so predictions anchor on the same rating).
 */
export function fitAccModelFromSamples(samples: AccSample[], modes: ModeMeta[]): PlayerAccModel | null {
  const byKeys = new Map<number, AccSample[]>();
  for (const sample of samples) {
    const list = byKeys.get(sample.keyCount);
    if (list) list.push(sample);
    else byKeys.set(sample.keyCount, [sample]);
  }
  const ratingByKeys = new Map(modes.filter((m) => m.rating > 0).map((m) => [m.keyCount, m.rating]));
  if (ratingByKeys.size === 0) return null;

  // First pass: raw per-keymode fits, to pick the donor (largest evidence).
  interface RawMode {
    keyCount: number;
    samples: AccSample[];
    weight: number;
    fit: HingeCurve | null;
  }
  const raw: RawMode[] = [];
  for (const [keyCount, list] of byKeys) {
    if (!ratingByKeys.has(keyCount)) continue;
    const weight = list.reduce((sum, s) => sum + s.weight, 0);
    const fit = fitHinge(list.map((s) => ({ gap: s.gap, y: logError(s.acc), weight: s.weight })));
    raw.push({ keyCount, samples: list, weight, fit });
  }
  if (raw.length === 0) {
    // No samples anywhere, but ratings exist: serve prior-only modes so
    // predictions still anchor on the rating instead of returning null.
    const model: PlayerAccModel = { v: ACC_MODEL_VERSION, modes: {} };
    for (const [keyCount, rating] of ratingByKeys) {
      model.modes[String(keyCount)] = emptyMode(keyCount, rating);
    }
    return model;
  }
  const donor = [...raw].sort((a, b) => b.weight - a.weight)[0];

  const globalPrior: HingeCurve = { a: PRIOR_A, bn: PRIOR_BN, bp: PRIOR_BP };
  const model: PlayerAccModel = { v: ACC_MODEL_VERSION, modes: {} };

  // Donor posterior first, so sparse keymodes can seed from it.
  const donorPosterior = donor.fit ? blendCurve(donor.fit, globalPrior, donor.weight, K_MODE) : globalPrior;

  for (const [keyCount, rating] of ratingByKeys) {
    const rawMode = raw.find((m) => m.keyCount === keyCount) ?? null;
    const list = rawMode?.samples ?? [];
    const weight = rawMode?.weight ?? 0;
    const sparse = weight < TRANSFER_BELOW_WEIGHT;
    // A sparse keymode's prior leans on the donor keymode's posterior (the
    // cross-keymode transfer); a well-evidenced one shrinks straight to the
    // global prior, which its own weight mostly overrides anyway.
    let prior = globalPrior;
    if (sparse && rawMode !== donor && donor.weight > 0) {
      const t = Math.min(DONOR_PRIOR_MAX_T, donor.weight / (donor.weight + 40));
      prior = {
        a: (1 - t) * globalPrior.a + t * donorPosterior.a,
        bn: (1 - t) * globalPrior.bn + t * donorPosterior.bn,
        bp: (1 - t) * globalPrior.bp + t * donorPosterior.bp,
      };
    }
    const posterior = rawMode?.fit ? blendCurve(rawMode.fit, prior, weight, K_MODE) : prior;

    // Residual spread around the shrunk curve, itself shrunk toward the
    // prior spread.
    let ssr = 0;
    let accSum = 0;
    for (const s of list) {
      const r = logError(s.acc) - curveMu(posterior, s.gap);
      ssr += s.weight * r * r;
      accSum += s.weight * s.acc;
    }
    const sFit = weight > 0 ? Math.sqrt(ssr / weight) : PRIOR_S;
    const s = Math.min(S_MAX, Math.max(S_MIN, Math.sqrt((weight * sFit * sFit + K_MODE * PRIOR_S * PRIOR_S) / (weight + K_MODE))));
    const mean = weight > 0 ? accSum / weight : 0;

    // Gap coverage (weighted 5th/95th percentiles).
    const { lo, hi } = weightedGapRange(list);

    // Per-family curves, shrunk toward the keymode posterior.
    const fam: Record<string, AccModelFamilyCurve> = {};
    const byFamily = new Map<string, AccSample[]>();
    for (const sample of list) {
      if (!sample.family) continue;
      const famList = byFamily.get(sample.family);
      if (famList) famList.push(sample);
      else byFamily.set(sample.family, [sample]);
    }
    for (const [family, famSamples] of byFamily) {
      const famWeight = famSamples.reduce((sum, sample) => sum + sample.weight, 0);
      const famFit = fitHinge(famSamples.map((sample) => ({ gap: sample.gap, y: logError(sample.acc), weight: sample.weight })));
      const famPosterior = famFit ? blendCurve(famFit, posterior, famWeight, K_FAM) : posterior;
      fam[family] = {
        n: famSamples.length,
        a: round4(famPosterior.a),
        bn: round4(famPosterior.bn),
        bp: round4(famPosterior.bp),
      };
    }

    model.modes[String(keyCount)] = {
      keys: keyCount,
      rating: Math.round(rating * 100) / 100,
      n: list.length,
      w: Math.round(weight * 10) / 10,
      a: round4(posterior.a),
      bn: round4(posterior.bn),
      bp: round4(posterior.bp),
      s: round4(s),
      mean: round4(mean),
      lo: Math.round(lo * 10) / 10,
      hi: Math.round(hi * 10) / 10,
      fam,
      choke: buildChokeBins(list),
      ...(sparse ? { transfer: true } : {}),
    };
  }
  return model;
}

function emptyMode(keyCount: number, rating: number): AccModelMode {
  return {
    keys: keyCount,
    rating: Math.round(rating * 100) / 100,
    n: 0,
    w: 0,
    a: PRIOR_A,
    bn: PRIOR_BN,
    bp: PRIOR_BP,
    s: PRIOR_S,
    mean: 0,
    lo: 0,
    hi: 0,
    fam: {},
    choke: [],
    transfer: true,
  };
}

function weightedGapRange(samples: AccSample[]): { lo: number; hi: number } {
  if (samples.length === 0) return { lo: 0, hi: 0 };
  const sorted = [...samples].sort((a, b) => a.gap - b.gap);
  const total = sorted.reduce((sum, s) => sum + s.weight, 0);
  let acc = 0;
  let lo = sorted[0].gap;
  let hi = sorted[sorted.length - 1].gap;
  for (const s of sorted) {
    acc += s.weight;
    if (acc >= 0.05 * total) {
      lo = s.gap;
      break;
    }
  }
  acc = 0;
  for (const s of sorted) {
    acc += s.weight;
    if (acc >= 0.95 * total) {
      hi = s.gap;
      break;
    }
  }
  return { lo, hi };
}

function buildChokeBins(samples: AccSample[]): AccModelChokeBin[] {
  const bins: Array<{ n: number; choked: number; missSum: number }> = Array.from(
    { length: CHOKE_BIN_EDGES.length + 1 },
    () => ({ n: 0, choked: 0, missSum: 0 }),
  );
  for (const sample of samples) {
    if (sample.missShare == null) continue;
    let idx = 0;
    while (idx < CHOKE_BIN_EDGES.length && sample.gap >= CHOKE_BIN_EDGES[idx]) idx++;
    const bin = bins[idx];
    bin.n += 1;
    bin.missSum += sample.missShare;
    if (sample.missShare > CHOKE_MISS_SHARE_THRESHOLD) bin.choked += 1;
  }
  return bins.map((bin) => ({
    n: bin.n,
    c: bin.n > 0 ? round4(bin.choked / bin.n) : 0,
    m: bin.n > 0 ? round4(bin.missSum / bin.n) : 0,
  }));
}

/**
 * Fits the model for one player: loads chart-side difficulty for the played
 * charts, joins, fits. Called from the skills job only (one batched
 * map_search_index read plus one chart-analysis read); never call this on a
 * request path.
 */
export async function buildPlayerAccModel(
  db: Db,
  plays: AccModelPlay[],
  modes: PlayerSkillModeBreakdown[],
  now = Date.now(),
): Promise<PlayerAccModel | null> {
  const ratingByKeys = new Map<number, number>();
  for (const mode of modes) {
    const rating = Number(mode.ratings?.Overall ?? 0);
    if (rating > 0) ratingByKeys.set(mode.keyCount, rating);
  }
  if (ratingByKeys.size === 0) return null;
  const chartData = await loadAccChartDifficulty(db, plays.map((play) => play.beatmapId));
  const samples = buildAccSamples(plays, ratingByKeys, chartData, now);
  return fitAccModelFromSamples(
    samples,
    [...ratingByKeys.entries()].map(([keyCount, rating]) => ({ keyCount, rating })),
  );
}

/**
 * Read API for consumers (farm helper A8/A10). Serves the persisted model
 * from the ready skills row; null when the player has no ready ratings or
 * the stored model predates ACC_MODEL_VERSION.
 */
export async function readPlayerAccModel(db: Db, userId: number): Promise<PlayerAccModel | null> {
  const row = (await exec(
    db,
    `select acc_model_json from player_skill_ratings
     where user_id = ? and status = 'ready' and acc_model_json is not null
     order by analysis_version desc limit 1`,
    [userId],
  )).rows[0];
  if (!row) return null;
  return parsePlayerAccModel(row.acc_model_json);
}

export function parsePlayerAccModel(raw: unknown): PlayerAccModel | null {
  const parsed = parseJson<PlayerAccModel | null>(String(raw ?? ""), null);
  if (!parsed || parsed.v !== ACC_MODEL_VERSION || parsed.modes == null || typeof parsed.modes !== "object") return null;
  return parsed;
}

// z-values: p85 of the accuracy distribution = 15th percentile of the error
// distribution.
const Z_P85 = -1.0364;
// The conservative percentile slides from 50 (z 0) at full confidence toward
// 20 (z 0.8416) at zero confidence.
const Z_CONSERVATIVE_MAX = 0.8416;

const ACC_OUT_MIN = 0.5;
const ACC_OUT_MAX = 0.999;

/**
 * Predicts this player's custom accuracy on a chart. `chartOverall` is the
 * chart's MSD Overall at the lane's rate (msd_overall for 1.0x, the DT
 * sweep's Overall for 1.5x, 0.75 * msd_overall for HT - the same values the
 * feasibility gate compares). `family` is the chart's primary pattern family
 * (primaryPatternFamily); families the player never played are served by the
 * keymode curve at reduced confidence, never null. Returns null only when
 * the model itself is empty or the input is invalid.
 */
export function predictPlayerAccuracy(
  model: PlayerAccModel | null,
  input: { keyCount: number; chartOverall: number; family?: string | null },
): PlayerAccPrediction | null {
  if (!model || !(input.chartOverall > 0)) return null;
  const resolved = resolveMode(model, input.keyCount);
  if (!resolved) return null;
  const { mode, source } = resolved;
  const gap = input.chartOverall - mode.rating;

  const famEntry = input.family ? mode.fam[input.family] ?? null : null;
  const curve: HingeCurve = famEntry ?? mode;
  const famPlays = famEntry?.n ?? 0;
  const mu = curveMu(curve, gap);

  // Confidence: keymode evidence, family evidence (only when a family was
  // asked about), extrapolation past the observed gap range, and the
  // transfer/donor haircuts.
  const confMode = mode.w / (mode.w + 30);
  const confFam = input.family ? famPlays / (famPlays + 6) : 1;
  let confidence = confMode * (input.family ? 0.45 + 0.55 * confFam : 1);
  const extrapolation = Math.max(0, gap - mode.hi, mode.lo - gap);
  confidence /= 1 + 0.12 * extrapolation;
  if (source === "transfer") confidence *= 0.6;
  if (source === "donor") confidence *= 0.35;
  confidence = Math.min(0.99, Math.max(0.02, confidence));

  // Thin evidence widens the predictive spread and slides the conservative
  // percentile down.
  const sigma = mode.s * (1 + 0.8 * (1 - confidence));
  const median = clampAcc(1 - Math.exp(mu));
  const p85 = clampAcc(1 - Math.exp(mu + Z_P85 * sigma));
  const conservative = clampAcc(1 - Math.exp(mu + Z_CONSERVATIVE_MAX * (1 - confidence) * sigma));

  return {
    accMedian: median,
    accP85: Math.max(p85, median),
    accConservative: Math.min(conservative, median),
    confidence,
    gap,
    source,
    familyPlays: famPlays,
  };
}

/**
 * The player's expected missShare / choke probability at a chart's gap, for
 * A10's P(finish) term. Interpolated over the stored gap bins; bins with too
 * few plays are skipped. Null when the model (or every bin) is empty.
 */
export function predictPlayerChoke(
  model: PlayerAccModel | null,
  input: { keyCount: number; chartOverall: number },
): PlayerChokePrediction | null {
  if (!model || !(input.chartOverall > 0)) return null;
  const resolved = resolveMode(model, input.keyCount);
  if (!resolved) return null;
  const { mode, source } = resolved;
  const gap = input.chartOverall - mode.rating;
  const points: Array<{ center: number; c: number; m: number; n: number }> = [];
  mode.choke.forEach((bin, idx) => {
    if (bin.n >= CHOKE_BIN_MIN_N) points.push({ center: CHOKE_BIN_CENTERS[idx] ?? 0, c: bin.c, m: bin.m, n: bin.n });
  });
  if (points.length === 0) return null;
  const totalN = points.reduce((sum, p) => sum + p.n, 0);
  let confidence = totalN / (totalN + 30);
  if (source !== "own") confidence *= source === "transfer" ? 0.6 : 0.35;
  return {
    missShare: interpolate(points.map((p) => ({ x: p.center, y: p.m })), gap),
    chokeRate: interpolate(points.map((p) => ({ x: p.center, y: p.c })), gap),
    confidence: Math.min(0.99, Math.max(0.02, confidence)),
  };
}

function resolveMode(model: PlayerAccModel, keyCount: number): { mode: AccModelMode; source: "own" | "transfer" | "donor" } | null {
  const own = model.modes[String(keyCount)];
  if (own && own.rating > 0) return { mode: own, source: own.transfer ? "transfer" : "own" };
  // Zero fitted entry for the keymode: the best-evidenced other keymode
  // serves as donor. Cross-keymode MSD rulers differ, so this is a coarse
  // estimate; the donor haircut on confidence prices that in.
  const donor = Object.values(model.modes)
    .filter((mode) => mode.rating > 0)
    .sort((a, b) => b.w - a.w)[0];
  return donor ? { mode: donor, source: "donor" } : null;
}

function interpolate(points: Array<{ x: number; y: number }>, x: number): number {
  if (points.length === 1) return points[0].y;
  const sorted = [...points].sort((a, b) => a.x - b.x);
  if (x <= sorted[0].x) return sorted[0].y;
  const last = sorted[sorted.length - 1];
  if (x >= last.x) return last.y;
  for (let i = 1; i < sorted.length; i++) {
    if (x <= sorted[i].x) {
      const t = (x - sorted[i - 1].x) / (sorted[i].x - sorted[i - 1].x);
      return sorted[i - 1].y + t * (sorted[i].y - sorted[i - 1].y);
    }
  }
  return last.y;
}

export interface AccHoldoutResult {
  n: number;
  // MAE of the model's median prediction vs held-out custom accuracy.
  mae: number;
  // MAE of the naive baseline (the player's train-set mean accuracy per
  // keymode) on the same holdout.
  naiveMae: number;
}

/**
 * Per-player 80/20 holdout: a deterministic hash of each play's identity
 * assigns ~20% of samples to the holdout, the model fits on the rest, and
 * both the model's median prediction and the player-mean baseline are scored
 * on the holdout. Used by the farm-helper backtest's accuracy metric and the
 * unit tests. Null when either split is empty.
 */
export function evaluateAccHoldout(samples: AccSample[], modes: ModeMeta[]): AccHoldoutResult | null {
  const train: AccSample[] = [];
  const holdout: AccSample[] = [];
  for (const sample of samples) {
    (hashIdentity(sample.identity) % 5 === 0 ? holdout : train).push(sample);
  }
  if (train.length === 0 || holdout.length === 0) return null;
  const model = fitAccModelFromSamples(train, modes);
  if (!model) return null;
  const meanByKeys = new Map<number, { sum: number; weight: number }>();
  for (const sample of train) {
    const entry = meanByKeys.get(sample.keyCount) ?? { sum: 0, weight: 0 };
    entry.sum += sample.weight * sample.acc;
    entry.weight += sample.weight;
    meanByKeys.set(sample.keyCount, entry);
  }
  let n = 0;
  let errSum = 0;
  let naiveSum = 0;
  for (const sample of holdout) {
    const prediction = predictPlayerAccuracy(model, {
      keyCount: sample.keyCount,
      chartOverall: sample.chartOverall,
      family: sample.family,
    });
    if (!prediction) continue;
    const meanEntry = meanByKeys.get(sample.keyCount);
    const naive = meanEntry && meanEntry.weight > 0 ? meanEntry.sum / meanEntry.weight : prediction.accMedian;
    n += 1;
    errSum += Math.abs(prediction.accMedian - sample.acc);
    naiveSum += Math.abs(naive - sample.acc);
  }
  if (n === 0) return null;
  return { n, mae: errSum / n, naiveMae: naiveSum / n };
}

function hashIdentity(identity: string): number {
  let hash = 5381;
  for (let i = 0; i < identity.length; i++) {
    hash = ((hash << 5) + hash + identity.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function clampAcc(value: number): number {
  return Math.min(ACC_OUT_MAX, Math.max(ACC_OUT_MIN, value));
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
