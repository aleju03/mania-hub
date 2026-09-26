// Converts an osu!mania score's judgement counts into an estimated Etterna
// Wife3 accuracy, the score goal MinaCalc rates a play at. One monotone model
// covers every native keycount, taps and holds, and any constant rate; a
// second fitted adapter handles scores whose counts are gone and only the
// recorded accuracy survives. Also holds the Wife3 curve and osu!mania timing
// windows the model is built on.
//
// Two targets, both keeping osu!mania's note and hold-failure semantics:
// - "press": Wife3 points on taps and LN heads, minus 2.25 per failed hold,
//   divided by original objects. Feeds native MinaCalc SSRs.
// - "ln": mean Wife3 points over press and release actions, a broken hold's
//   tail counting as failed. Feeds the separate 4K LN rating only.
// Neither is an independently played Etterna score.

/** Wife3's miss weight, normalized to a marvelous = 1. */
export const WIFE3_MISS_POINTS = -2.75;

export interface TimingWindowOptions {
  /** Constant music rate; judgement windows are converted to real milliseconds. */
  rate?: number;
  /** EZ = 1.4, HR = 1/1.4; applied before the client's window rounding. */
  windowScale?: number;
}

export interface WifeCalibrationOptions extends TimingWindowOptions {
  od: number;
  /** Which client judged the play. ScoreV2 uses lazer windows on stable. */
  scoring: "stable" | "lazer" | "stable-scorev2";
  /** Lazer's Classic mod, which judges on stable's fixed MAX window. */
  classicWindows?: boolean;
  /** Hold objects / original objects (0-1), not tails / lazer judgement count. */
  holdRatio: number;
  /** "press" (default) for native MSD, "ln" for the release-aware LN target. */
  target?: "press" | "ln";
}

// Fitted model coefficients. They are static arrays produced offline by
// nonnegative least squares (ridge 0.00001) over replay-reconstructed plays,
// and are not part of this snapshot.
//
// The powers applied to each cumulative bad-judgement share (the docs list
// 0.5, 1 and 2), three per threshold.
declare const WIFE_BASIS_POWERS: readonly number[];
// Hold-share anchors the coefficient rows interpolate between (the docs list
// 0, 0.15, 0.5 and 1).
declare const WIFE_HOLD_ANCHORS: readonly number[];
// Count-based press model: row 0 is the shared tap anchor, rows 1-3 the stable
// hold contexts, rows 4-6 the lazer ones; each row has 5 thresholds x 3 powers.
declare const WIFE_ORDINAL_COEFFICIENTS: ReadonlyArray<readonly number[]>;
// Count-based LN-action model, same layout as WIFE_ORDINAL_COEFFICIENTS.
declare const WIFE_LN_COEFFICIENTS: ReadonlyArray<readonly number[]>;
// Accuracy-only press model: rows 0-3 stable anchors, rows 4-7 lazer anchors.
declare const WIFE_ACCURACY_COEFFICIENTS: ReadonlyArray<readonly number[]>;
// Accuracy-only LN-action model, same layout as WIFE_ACCURACY_COEFFICIENTS.
declare const WIFE_LN_ACCURACY_COEFFICIENTS: ReadonlyArray<readonly number[]>;

/**
 * Estimated Wife3 accuracy from the six judgement counts (MAX, 300, 200, 100,
 * 50, miss), or null when an input is invalid.
 *
 * Each cumulative bad-judgement share (everything worse than MAX, worse than
 * 300, ...) is monotone in play quality. The model sums, per threshold, the
 * Wife3 cost of crossing that threshold times nonnegative coefficients on
 * powers of the share, so improving any judgement can never lower the
 * estimate. Coefficients interpolate linearly across hold share; hold share
 * conditions how counts are read and never multiplies chart difficulty. Counts
 * cannot recover individual hold failures, so this is an empirical estimate.
 */
export function estimateManiaWifeAccuracy(counts: readonly number[], options: WifeCalibrationOptions): number | null {
  if (counts.length !== 6 || counts.some((count) => !Number.isSafeInteger(count) || count < 0)
    || !Number.isFinite(options.holdRatio) || options.holdRatio < 0 || options.holdRatio > 1
    || !["stable", "lazer", "stable-scorev2"].includes(options.scoring)) return null;
  const total = counts.reduce((sum, count) => sum + count, 0);
  if (!Number.isSafeInteger(total) || total === 0) return null;
  const classic = options.scoring !== "stable-scorev2" && (options.scoring === "stable" || options.classicWindows === true);
  const edges = maniaTimingEdges(options.od, classic, options);
  if (!edges) return null;
  // Every note missed and every hold failed.
  const minimum = options.target === "ln" ? -2.75 : -2.75 - 2.25 * options.holdRatio;
  if (counts[5] === total) return minimum;
  const costs = thresholdCosts(edges);
  const group = options.scoring === "stable" ? 0 : 1;
  let segment = 0;
  while (segment < WIFE_HOLD_ANCHORS.length - 2 && options.holdRatio > WIFE_HOLD_ANCHORS[segment + 1]) segment += 1;
  const fraction = (options.holdRatio - WIFE_HOLD_ANCHORS[segment]) / (WIFE_HOLD_ANCHORS[segment + 1] - WIFE_HOLD_ANCHORS[segment]);
  // The first segment starts from the tap anchor both clients share.
  const lowerIndex = segment === 0 ? 0 : 1 + group * 3 + segment - 1;
  const upperIndex = 1 + group * 3 + segment;
  const coefficients = options.target === "ln" ? WIFE_LN_COEFFICIENTS : WIFE_ORDINAL_COEFFICIENTS;
  const lower = coefficients[lowerIndex], upper = coefficients[upperIndex];
  let loss = 0;
  let bad = total - counts[0];
  for (let j = 0; j < 5; j += 1) {
    const share = bad / total;
    for (let p = 0; p < WIFE_BASIS_POWERS.length; p += 1) {
      const coefficient = lower[j * 3 + p] * (1 - fraction) + upper[j * 3 + p] * fraction;
      loss += coefficient * costs.costs[j] * Math.pow(share, WIFE_BASIS_POWERS[p]);
    }
    bad -= counts[j + 1];
  }
  let lowerBound = minimum, upperBound = 1;
  if (options.holdRatio === 0) {
    // On a tap chart each judgement pins its hit inside a known band, so the
    // estimate cannot leave the range those bands allow. Min/max of monotone
    // functions stays monotone.
    lowerBound = (counts.slice(0, 5).reduce((sum, count, i) => sum + count * wife3PointsAt(edges[i]), 0) - 2.75 * counts[5]) / total;
    upperBound = (counts.slice(0, 5).reduce((sum, count, i) => sum + count * wife3PointsAt(i ? edges[i - 1] : 0), 0) - 2.75 * counts[5]) / total;
  }
  return Math.max(lowerBound, Math.min(upperBound, costs.maximum - loss));
}

/**
 * Lower-information conversion when only the recorded osu! accuracy survives
 * (0-1). A separately fitted adapter, not a raw-accuracy passthrough.
 */
export function estimateManiaWifeAccuracyFromAccuracy(accuracy: number, options: WifeCalibrationOptions): number | null {
  if (!Number.isFinite(accuracy) || accuracy < 0 || accuracy > 1
    || !Number.isFinite(options.holdRatio) || options.holdRatio < 0 || options.holdRatio > 1
    || !["stable", "lazer", "stable-scorev2"].includes(options.scoring)) return null;
  const classic = options.scoring !== "stable-scorev2" && (options.scoring === "stable" || options.classicWindows === true);
  const edges = maniaTimingEdges(options.od, classic, options);
  if (!edges) return null;
  const costs = thresholdCosts(edges);
  let segment = 0;
  while (segment < WIFE_HOLD_ANCHORS.length - 2 && options.holdRatio > WIFE_HOLD_ANCHORS[segment + 1]) segment += 1;
  const fraction = (options.holdRatio - WIFE_HOLD_ANCHORS[segment]) / (WIFE_HOLD_ANCHORS[segment + 1] - WIFE_HOLD_ANCHORS[segment]);
  const index = (options.scoring === "stable" ? 0 : 4) + segment;
  const coefficients = options.target === "ln" ? WIFE_LN_ACCURACY_COEFFICIENTS : WIFE_ACCURACY_COEFFICIENTS;
  const lower = coefficients[index], upper = coefficients[index + 1];
  let loss = 0;
  for (let j = 0; j < 5; j += 1) for (let p = 0; p < WIFE_BASIS_POWERS.length; p += 1) {
    const coefficient = lower[j * 3 + p] * (1 - fraction) + upper[j * 3 + p] * fraction;
    loss += coefficient * costs.costs[j] * Math.pow(1 - accuracy, WIFE_BASIS_POWERS[p]);
  }
  return Math.max(options.target === "ln" ? -2.75 : -2.75 - 2.25 * options.holdRatio, Math.min(1, costs.maximum - loss));
}

/** Abramowitz-Stegun approximation of the error function. */
export function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const poly = ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  return sign * (1 - poly * Math.exp(-ax * ax));
}

/**
 * Etterna Wife3 at judge 4, normalized to marvelous = 1, for a hit `ms` off
 * (real milliseconds): full points inside 5 ms, an erf falloff crossing zero at
 * 65 ms, then linear down to the miss weight at 180 ms.
 */
export function wife3PointsAt(ms: number): number {
  const t = Math.abs(ms);
  if (t <= 5) return 1;
  if (t <= 65) return erf((65 - t) / 22.7);
  if (t >= 180) return WIFE3_MISS_POINTS;
  return WIFE3_MISS_POINTS * (t - 65) / 115;
}

/**
 * The five judgement window edges (MAX, 300, 200, 100, 50) in real
 * milliseconds at an OD, or null for invalid input. Stable and Classic keep a
 * fixed 16 ms MAX window; lazer's MAX runs 22.4 / 19.4 / 13.9 ms at OD 0 / 5 /
 * 10. Each edge includes the client's rounding:
 * (floor(window * rate * scale) + 0.5) / rate.
 */
export function maniaTimingEdges(od: number, classicWindows: boolean, options: TimingWindowOptions = {}): number[] | null {
  const rate = options.rate ?? 1;
  const scale = options.windowScale ?? 1;
  if (!Number.isFinite(od) || od < 0 || od > 10 || !Number.isFinite(rate) || rate <= 0
    || !Number.isFinite(scale) || scale <= 0) return null;
  const maxWindow = classicWindows ? 16 : od > 5 ? 19.4 + (13.9 - 19.4) * (od - 5) / 5
    : 19.4 + (19.4 - 22.4) * (od - 5) / 5;
  const edges = [maxWindow, 64 - 3 * od, 97 - 3 * od, 127 - 3 * od, 151 - 3 * od]
    .map((edge) => (Math.floor(edge * rate * scale) + 0.5) / rate);
  return edges.every((edge, i) => Number.isFinite(edge) && edge > (i ? edges[i - 1] : 0)) ? edges : null;
}

/**
 * Reference tap-only estimator, kept for comparison with the calibrated model
 * above; ratings do not use it. Counts ordered MAX, 300, 200, 100, 50, miss.
 *
 * Fits a fixed generalized-normal timing spread, exp(-(t / spread)^1.25), to
 * the non-miss histogram, then takes the expected Wife3 points of each
 * judgement band under that spread. Misses are a separate point mass rather
 * than inferred timing outliers.
 */
export function estimateTapWifeAccuracy(counts: readonly number[], od: number, classicWindows: boolean, options: TimingWindowOptions = {}): number | null {
  if (!Number.isFinite(od) || od < 0 || od > 10 || counts.length !== 6
    || counts.some((count) => !Number.isSafeInteger(count) || count < 0)) return null;
  const total = counts.reduce((sum, count) => sum + count, 0);
  if (!Number.isSafeInteger(total) || total === 0) return null;
  const edges = maniaTimingEdges(od, classicWindows, options);
  if (!edges) return null;
  const hits = total - counts[5];
  if (hits === 0) return WIFE3_MISS_POINTS;
  const model = tapWindowModel(edges);
  const loss = (template: SpreadTemplate) => counts.slice(0, 5)
    .reduce((sum, count, i) => sum - (count / hits) * template.logProbabilities[i], 0);
  let bestIndex = 0;
  let bestLoss = Infinity;
  for (let i = 0; i < model.grid.length; i += 1) {
    const value = loss(model.grid[i]);
    if (value < bestLoss) { bestIndex = i; bestLoss = value; }
  }
  // Refine continuously around the best grid cell (golden-section search):
  // snapping to the grid alone can lower the estimate when one miss becomes a
  // hit near a cell edge.
  let lo = TAP_SPREAD.logMin + Math.max(0, bestIndex - 1) * TAP_SPREAD.logStep;
  let hi = TAP_SPREAD.logMin + Math.min(TAP_SPREAD.gridSteps, bestIndex + 1) * TAP_SPREAD.logStep;
  const ratio = (Math.sqrt(5) - 1) / 2;
  let x = hi - ratio * (hi - lo);
  let y = lo + ratio * (hi - lo);
  let a = evaluateSpread(model.bands, x);
  let b = evaluateSpread(model.bands, y);
  for (let i = 0; i < 25; i += 1) {
    if (loss(a) < loss(b)) {
      hi = y; y = x; b = a; x = hi - ratio * (hi - lo); a = evaluateSpread(model.bands, x);
    } else {
      lo = x; x = y; a = b; y = lo + ratio * (hi - lo); b = evaluateSpread(model.bands, y);
    }
  }
  const fitted = loss(a) < loss(b) ? a : b;
  return (counts.slice(0, 5).reduce((sum, count, i) => sum + count * fitted.points[i], 0)
    + counts[5] * WIFE3_MISS_POINTS) / total;
}

/**
 * Per-threshold Wife3 costs for a set of window edges: the mean Wife3 points
 * of each band (96-step midpoint average), `maximum` being the MAX band's, and
 * the cost of each threshold being the drop from one band's mean to the next
 * (the band after the 50 is a miss, -2.75), floored at zero.
 */
function thresholdCosts(edges: number[]): { maximum: number; costs: number[] } {
  const weights = edges.map((end, i) => {
    const start = i ? edges[i - 1] : 0;
    let sum = 0;
    for (let j = 0; j < 96; j += 1) sum += wife3PointsAt(start + (j + 0.5) * (end - start) / 96);
    return sum / 96;
  });
  weights.push(-2.75);
  return { maximum: weights[0], costs: weights.slice(0, 5).map((value, i) => Math.max(0, value - weights[i + 1])) };
}

// Timing-spread search space for the reference tap estimator: the shape
// exponent, quadrature steps per band, and a log-spaced spread grid from 2 ms
// to 240 ms.
const TAP_SPREAD = {
  shape: 1.25,
  quadratureSteps: 96,
  gridSteps: 100,
  logMin: Math.log(2),
  logMax: Math.log(240),
  logStep: (Math.log(240) - Math.log(2)) / 100,
} as const;

interface SpreadBand {
  step: number;
  powers: Float64Array;
  points: Float64Array;
  lowerPoints: number;
}

interface SpreadTemplate {
  logProbabilities: number[];
  points: number[];
}

/** Judgement probabilities and expected Wife3 points per band at one spread. */
function evaluateSpread(bands: SpreadBand[], logSpread: number): SpreadTemplate {
  const inverseSpreadPower = Math.exp(-TAP_SPREAD.shape * logSpread);
  const masses: number[] = [];
  const points: number[] = [];
  for (const band of bands) {
    let mass = 0;
    let weightedPoints = 0;
    for (let i = 0; i < TAP_SPREAD.quadratureSteps; i += 1) {
      const density = Math.exp(-band.powers[i] * inverseSpreadPower);
      mass += density;
      weightedPoints += density * band.points[i];
    }
    masses.push(mass * band.step);
    points.push(mass > 1e-200 ? weightedPoints / mass : band.lowerPoints);
  }
  const total = masses.reduce((sum, mass) => sum + mass, 0);
  return { points, logProbabilities: masses.map((mass) => Math.log(Math.max(1e-250, mass / total))) };
}

function tapWindowModel(edges: number[]): { bands: SpreadBand[]; grid: SpreadTemplate[] } {
  const bands = edges.map((end, index): SpreadBand => {
    const start = index === 0 ? 0 : edges[index - 1];
    const step = (end - start) / TAP_SPREAD.quadratureSteps;
    const powers = new Float64Array(TAP_SPREAD.quadratureSteps);
    const points = new Float64Array(TAP_SPREAD.quadratureSteps);
    for (let i = 0; i < TAP_SPREAD.quadratureSteps; i += 1) {
      const t = start + (i + 0.5) * step;
      powers[i] = Math.pow(t, TAP_SPREAD.shape);
      points[i] = wife3PointsAt(t);
    }
    return { step, powers, points, lowerPoints: wife3PointsAt(start) };
  });
  const grid = Array.from({ length: TAP_SPREAD.gridSteps + 1 },
    (_, i) => evaluateSpread(bands, TAP_SPREAD.logMin + i * TAP_SPREAD.logStep));
  return { bands, grid };
}
