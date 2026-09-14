import { maniaTimingEdges, wife3PointsAt, type TimingWindowOptions } from "./tap-wife-accuracy.js";
import { WIFE_BASIS_POWERS, WIFE_HOLD_ANCHORS, WIFE_ORDINAL_COEFFICIENTS } from "./wife-calibration-model.js";
import { WIFE_ACCURACY_COEFFICIENTS } from "./wife-calibration-accuracy-model.js";
import { WIFE_LN_ACCURACY_COEFFICIENTS, WIFE_LN_COEFFICIENTS } from "./wife-calibration-ln-model.js";

export const WIFE_CALIBRATION_VERSION = 2;
export interface WifeCalibrationOptions extends TimingWindowOptions {
  od: number;
  scoring: "stable" | "lazer" | "stable-scorev2";
  classicWindows?: boolean;
  /** Hold objects / original objects, not tails / lazer judgment count. */
  holdRatio: number;
  /** Native press/hold-failure quality, or release-aware quality for the LN sidecar. */
  target?: "press" | "ln";
}

interface ThresholdCosts { maximum: number; costs: number[] }
const costsCache = new Map<string, ThresholdCosts>();
const CACHE_LIMIT = 128;

function costsFor(edges: number[]): ThresholdCosts {
  const key = edges.join("|");
  const cached = costsCache.get(key);
  if (cached) { costsCache.delete(key); costsCache.set(key, cached); return cached; }
  const weights = edges.map((end, i) => {
    const start = i ? edges[i - 1] : 0;
    let sum = 0;
    for (let j = 0; j < 96; j += 1) sum += wife3PointsAt(start + (j + 0.5) * (end - start) / 96);
    return sum / 96;
  });
  weights.push(-2.75);
  const result = { maximum: weights[0], costs: weights.slice(0, 5).map((value, i) => Math.max(0, value - weights[i + 1])) };
  if (costsCache.size >= CACHE_LIMIT) costsCache.delete(costsCache.keys().next().value!);
  costsCache.set(key, result);
  return result;
}

/**
 * Shared calibration for taps, hybrids and LN scores at every native keycount
 * and constant playback rate. Target: Wife3 on presses, minus normalized 2.25
 * per osu!-judged hold failure. Counts cannot recover individual hold failures;
 * this is an empirical estimate, not an Etterna replay or a release SSR.
 *
 * Each cumulative bad-hit fraction is monotone in judgment quality. Positive
 * coefficients and convex interpolation preserve that ordering, unlike fitting
 * latent head/tail ownership separately for each new histogram. Hold share
 * conditions the observation model; it never multiplies chart difficulty.
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
  const minimum = options.target === "ln" ? -2.75 : -2.75 - 2.25 * options.holdRatio;
  if (counts[5] === total) return minimum;
  const costs = costsFor(edges);
  const group = options.scoring === "stable" ? 0 : 1;
  let segment = 0;
  while (segment < WIFE_HOLD_ANCHORS.length - 2 && options.holdRatio > WIFE_HOLD_ANCHORS[segment + 1]) segment += 1;
  const fraction = (options.holdRatio - WIFE_HOLD_ANCHORS[segment]) / (WIFE_HOLD_ANCHORS[segment + 1] - WIFE_HOLD_ANCHORS[segment]);
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
    // Exact tap-judgment bounds remain valid even outside the training
    // distribution. Min/max of monotone functions preserve monotonicity.
    lowerBound = (counts.slice(0, 5).reduce((sum, count, i) => sum + count * wife3PointsAt(edges[i]), 0) - 2.75 * counts[5]) / total;
    upperBound = (counts.slice(0, 5).reduce((sum, count, i) => sum + count * wife3PointsAt(i ? edges[i - 1] : 0), 0) - 2.75 * counts[5]) / total;
  }
  return Math.max(lowerBound, Math.min(upperBound, costs.maximum - loss));
}

/** Lower-confidence conversion when only the recorded osu accuracy survives. */
export function estimateManiaWifeAccuracyFromAccuracy(accuracy: number, options: WifeCalibrationOptions): number | null {
  if (!Number.isFinite(accuracy) || accuracy < 0 || accuracy > 1
    || !Number.isFinite(options.holdRatio) || options.holdRatio < 0 || options.holdRatio > 1
    || !["stable", "lazer", "stable-scorev2"].includes(options.scoring)) return null;
  const classic = options.scoring !== "stable-scorev2" && (options.scoring === "stable" || options.classicWindows === true);
  const edges = maniaTimingEdges(options.od, classic, options);
  if (!edges) return null;
  const costs = costsFor(edges);
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
