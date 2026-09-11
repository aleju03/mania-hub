// Count-to-Wife3 calibration for native 4K taps at 1.0x. The caller owns the
// chart/mod/provenance gate; this module has no IO or chart identity inputs.
// A fixed generalized-normal shape, exp(-(t / spread)^1.25), models the
// concentration toward the favorable edge of each judgment interval. Fit
// spread from the non-miss histogram, then condition Wife3 on each observed
// judgment. Misses are a separate point mass, not inferred timing outliers.
// Validated on the 2026-09-10 cached-replay audit (613 robust 1.0x tap plays,
// player- and chart-grouped validation). This remains an estimate, not a
// replay rescore or a per-play guarantee at the 80% SSR eligibility boundary.

export const WIFE3_MISS_POINTS = -2.75;

export function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const poly = ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  return sign * (1 - poly * Math.exp(-ax * ax));
}

/** Etterna Wife3 J4, normalized to MAX = 1; t is in real milliseconds. */
export function wife3PointsAt(ms: number): number {
  const t = Math.abs(ms);
  if (t <= 5) return 1;
  if (t <= 65) return erf((65 - t) / 22.7);
  if (t >= 180) return WIFE3_MISS_POINTS;
  return WIFE3_MISS_POINTS * (t - 65) / 115;
}

const SHAPE = 1.25;
const QUADRATURE_STEPS = 96;
const GRID_STEPS = 100;
const LOG_MIN_SPREAD = Math.log(2);
const LOG_MAX_SPREAD = Math.log(240);
const LOG_STEP = (LOG_MAX_SPREAD - LOG_MIN_SPREAD) / GRID_STEPS;
const CACHE_LIMIT = 64;

interface Band {
  step: number;
  powers: Float64Array;
  points: Float64Array;
  lowerPoints: number;
}

interface Template {
  logProbabilities: number[];
  points: number[];
}

interface WindowModel {
  bands: Band[];
  grid: Template[];
}

// Keyed by actual (quantized) window edges, not unbounded raw OD strings.
// Lazy, bounded caching keeps this pure model out of boot-time work.
const windowModels = new Map<string, WindowModel>();

function evaluate(bands: Band[], logSpread: number): Template {
  const inverseSpreadPower = Math.exp(-SHAPE * logSpread);
  const masses: number[] = [];
  const points: number[] = [];
  for (const band of bands) {
    let mass = 0;
    let weightedPoints = 0;
    for (let i = 0; i < QUADRATURE_STEPS; i += 1) {
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

function modelFor(od: number, classicWindows: boolean): WindowModel {
  // Same native 1.0x windows as the replay simulator. Stable/CL keep a fixed
  // MAX window; lazer MAX ranges from 22.4 to 19.4 to 13.9 at OD 0/5/10.
  const maxWindow = classicWindows ? 16 : od > 5 ? 19.4 + (13.9 - 19.4) * (od - 5) / 5
    : 19.4 + (19.4 - 22.4) * (od - 5) / 5;
  const edges = [maxWindow, 64 - 3 * od, 97 - 3 * od, 127 - 3 * od, 151 - 3 * od]
    .map((edge) => Math.floor(edge) + 0.5);
  const key = edges.join("|");
  const cached = windowModels.get(key);
  if (cached) {
    windowModels.delete(key);
    windowModels.set(key, cached);
    return cached;
  }
  const bands = edges.map((end, index): Band => {
    const start = index === 0 ? 0 : edges[index - 1];
    const step = (end - start) / QUADRATURE_STEPS;
    const powers = new Float64Array(QUADRATURE_STEPS);
    const points = new Float64Array(QUADRATURE_STEPS);
    for (let i = 0; i < QUADRATURE_STEPS; i += 1) {
      const t = start + (i + 0.5) * step;
      powers[i] = Math.pow(t, SHAPE);
      points[i] = wife3PointsAt(t);
    }
    return { step, powers, points, lowerPoints: wife3PointsAt(start) };
  });
  const model = { bands, grid: Array.from({ length: GRID_STEPS + 1 }, (_, i) => evaluate(bands, LOG_MIN_SPREAD + i * LOG_STEP)) };
  if (windowModels.size >= CACHE_LIMIT) windowModels.delete(windowModels.keys().next().value!);
  windowModels.set(key, model);
  return model;
}

/** Counts ordered MAX, 300, 200, 100, 50, miss. Unknown facts return null. */
export function estimateTapWifeAccuracy(counts: readonly number[], od: number, classicWindows: boolean): number | null {
  if (!Number.isFinite(od) || od < 0 || od > 10 || counts.length !== 6
    || counts.some((count) => !Number.isSafeInteger(count) || count < 0)) return null;
  const total = counts.reduce((sum, count) => sum + count, 0);
  if (!Number.isSafeInteger(total) || total === 0) return null;
  const hits = total - counts[5];
  if (hits === 0) return WIFE3_MISS_POINTS;
  const model = modelFor(od, classicWindows);
  const loss = (template: Template) => counts.slice(0, 5)
    .reduce((sum, count, i) => sum - (count / hits) * template.logProbabilities[i], 0);
  let bestIndex = 0;
  let bestLoss = Infinity;
  for (let i = 0; i < model.grid.length; i += 1) {
    const value = loss(model.grid[i]);
    if (value < bestLoss) { bestIndex = i; bestLoss = value; }
  }
  // Continuous refinement is essential: selecting only a grid cell can
  // lower the estimate when a single miss becomes a hit near a cell edge.
  let lo = LOG_MIN_SPREAD + Math.max(0, bestIndex - 1) * LOG_STEP;
  let hi = LOG_MIN_SPREAD + Math.min(GRID_STEPS, bestIndex + 1) * LOG_STEP;
  const ratio = (Math.sqrt(5) - 1) / 2;
  let x = hi - ratio * (hi - lo);
  let y = lo + ratio * (hi - lo);
  let a = evaluate(model.bands, x);
  let b = evaluate(model.bands, y);
  for (let i = 0; i < 25; i += 1) {
    if (loss(a) < loss(b)) {
      hi = y; y = x; b = a; x = hi - ratio * (hi - lo); a = evaluate(model.bands, x);
    } else {
      lo = x; x = y; a = b; y = lo + ratio * (hi - lo); b = evaluate(model.bands, y);
    }
  }
  const fitted = loss(a) < loss(b) ? a : b;
  return (counts.slice(0, 5).reduce((sum, count, i) => sum + count * fitted.points[i], 0)
    + counts[5] * WIFE3_MISS_POINTS) / total;
}
