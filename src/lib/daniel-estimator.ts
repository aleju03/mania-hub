import type { ManiaBeatmap, ManiaNote } from "./beatmap-parser";
import type { DanEstimate, DanEstimateInput, DanSkillFamily } from "./dan-estimator";

type DanielFactorName = "Pressing Intensity" | "Unevenness" | "Same-Column Pressure" | "Cross-Column Pressure";

interface DanielCalculation {
  sr: number;
  times: number[];
  factors: Record<DanielFactorName, number[]>;
}

const DANIEL_DAN_MEANS = {
  Alpha: 6.562,
  Beta: 6.957,
  Gamma: 7.459,
  Delta: 7.939,
  Epsilon: 9.095,
  Zeta: 9.473,
  Eta: 10.162,
  Theta: 10.782,
} as const;

const DANIEL_ORDER = Object.keys(DANIEL_DAN_MEANS) as Array<keyof typeof DANIEL_DAN_MEANS>;
const DANIEL_ORDER_START = 11;
const DANIEL_BOUNDARIES = DANIEL_ORDER.map((dan, index) => {
  const mean = DANIEL_DAN_MEANS[dan];
  const previous = DANIEL_ORDER[index - 1] ? DANIEL_DAN_MEANS[DANIEL_ORDER[index - 1]] : null;
  const next = DANIEL_ORDER[index + 1] ? DANIEL_DAN_MEANS[DANIEL_ORDER[index + 1]] : null;
  const lower = previous == null ? mean - ((next ?? mean) + mean) / 2 + mean : (previous + mean) / 2;
  const upper = next == null ? mean + (mean - (previous ?? mean)) / 2 : (mean + next) / 2;
  return { lower, upper };
});

const GRAPH_RESAMPLE_INTERVAL_MS = 100;
const BREAK_ZERO_THRESHOLD_MS = 400;
const SMOOTH_SIGMA_MS = 800;

function getInputRate(input: DanEstimateInput): number {
  const rate = Number(input.rate);
  return Number.isFinite(rate) && rate > 0.4 && rate < 2.5 ? rate : 1;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function searchSorted(values: number[], needle: number, side: "left" | "right" = "left"): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (values[mid] < needle || (side === "right" && values[mid] <= needle)) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function zeros(length: number): number[] {
  return Array.from({ length }, () => 0);
}

function bools(length: number): boolean[] {
  return Array.from({ length }, () => false);
}

function cumulativeSum(x: number[], f: number[]): number[] {
  const result = zeros(x.length);
  for (let index = 1; index < x.length; index++) {
    result[index] = result[index - 1] + f[index - 1] * (x[index] - x[index - 1]);
  }
  return result;
}

function smoothOnCorners(
  x: number[],
  f: number[],
  windowMs: number,
  scale = 1,
  mode: "sum" | "avg" = "sum",
): number[] {
  if (x.length < 2) return zeros(x.length);

  const cumulative = cumulativeSum(x, f);
  const query = (value: number): number => {
    const index = clamp(searchSorted(x, value) - 1, 0, x.length - 2);
    return cumulative[index] + f[index] * (value - x[index]);
  };

  return x.map((time) => {
    const a = clamp(time - windowMs, x[0], x[x.length - 1]);
    const b = clamp(time + windowMs, x[0], x[x.length - 1]);
    const value = query(b) - query(a);
    if (mode === "avg") return b > a ? value / (b - a) : 0;
    return scale * value;
  });
}

function interpValues(newX: number[], oldX: number[], oldValues: number[]): number[] {
  if (oldX.length === 0) return zeros(newX.length);
  if (oldX.length === 1) return newX.map(() => oldValues[0] ?? 0);

  return newX.map((value) => {
    if (value <= oldX[0]) return oldValues[0] ?? 0;
    if (value >= oldX[oldX.length - 1]) return oldValues[oldValues.length - 1] ?? 0;
    const right = searchSorted(oldX, value, "left");
    const left = Math.max(0, right - 1);
    const span = Math.max(1e-9, oldX[right] - oldX[left]);
    const t = (value - oldX[left]) / span;
    return (oldValues[left] ?? 0) * (1 - t) + (oldValues[right] ?? 0) * t;
  });
}

function stepInterp(newX: number[], oldX: number[], oldValues: number[]): number[] {
  if (oldX.length === 0) return zeros(newX.length);
  return newX.map((value) => {
    const index = clamp(searchSorted(oldX, value, "right") - 1, 0, oldValues.length - 1);
    return oldValues[index] ?? 0;
  });
}

function gaussianFilter1d(data: number[], sigma: number): number[] {
  if (data.length === 0) return [];

  const kernelRadius = Math.floor(4 * sigma + 0.5);
  const kernel: number[] = [];
  let kernelSum = 0;
  for (let offset = -kernelRadius; offset <= kernelRadius; offset++) {
    const value = Math.exp(-0.5 * (offset / sigma) ** 2);
    kernel.push(value);
    kernelSum += value;
  }
  for (let index = 0; index < kernel.length; index++) kernel[index] /= kernelSum;

  return data.map((_, index) => {
    let sum = 0;
    for (let kernelIndex = 0; kernelIndex < kernel.length; kernelIndex++) {
      const dataIndex = index + kernelIndex - kernelRadius;
      sum += (data[dataIndex] ?? 0) * kernel[kernelIndex];
    }
    return sum;
  });
}

function rescaleHigh(sr: number): number {
  return sr <= 9 ? sr : 9 + (sr - 9) / 1.2;
}

function buildDanielNoteSequence(map: ManiaBeatmap, rate: number): Array<[number, number]> {
  return map.notes
    .filter((note) => note.column >= 0 && note.column < map.keyCount)
    .map((note) => [note.column, Math.floor(note.time / rate)] as [number, number])
    .sort((a, b) => a[1] - b[1] || a[0] - b[0]);
}

function getDanielCorners(totalTime: number, noteSeq: Array<[number, number]>) {
  const base = new Set<number>([0, totalTime]);
  const a = new Set<number>([0, totalTime]);

  for (const [, time] of noteSeq) {
    for (const corner of [time, time + 501, time - 499, time + 1]) {
      if (corner >= 0 && corner <= totalTime) base.add(corner);
    }
    for (const corner of [time, time + 1000, time - 1000]) {
      if (corner >= 0 && corner <= totalTime) a.add(corner);
    }
  }

  const baseCorners = [...base].sort((left, right) => left - right);
  const aCorners = [...a].sort((left, right) => left - right);
  const allCorners = [...new Set([...baseCorners, ...aCorners])].sort((left, right) => left - right);
  return { allCorners, baseCorners, aCorners };
}

function getKeyUsage(keyCount: number, totalTime: number, noteSeq: Array<[number, number]>, baseCorners: number[]) {
  const keyUsage = Array.from({ length: keyCount }, () => bools(baseCorners.length));
  for (const [column, time] of noteSeq) {
    const start = Math.max(time - 150, 0);
    const end = Math.min(time + 150, totalTime - 1);
    const left = searchSorted(baseCorners, start);
    const right = searchSorted(baseCorners, end);
    for (let index = left; index < right; index++) keyUsage[column][index] = true;
  }
  return keyUsage;
}

function getKeyUsage400(keyCount: number, noteSeq: Array<[number, number]>, baseCorners: number[]) {
  const keyUsage = Array.from({ length: keyCount }, () => zeros(baseCorners.length));
  for (const [column, time] of noteSeq) {
    const left = searchSorted(baseCorners, time - 400);
    const right = searchSorted(baseCorners, time + 400);
    const mid = searchSorted(baseCorners, time);

    if (mid >= 0 && mid < baseCorners.length) keyUsage[column][mid] += 3.75;
    for (let index = left; index < mid; index++) {
      if (index >= 0 && index < baseCorners.length) {
        keyUsage[column][index] += 3.75 - (3.75 / 400 ** 2) * (baseCorners[index] - time) ** 2;
      }
    }
    for (let index = mid + 1; index < right; index++) {
      if (index >= 0 && index < baseCorners.length) {
        keyUsage[column][index] += 3.75 - (3.75 / 400 ** 2) * (baseCorners[index] - time) ** 2;
      }
    }
  }
  return keyUsage;
}

function computeAnchor(keyUsage400: number[][]): number[] {
  const length = keyUsage400[0]?.length ?? 0;
  const anchor = zeros(length);

  for (let index = 0; index < length; index++) {
    const counts = keyUsage400.map((column) => column[index]).sort((left, right) => right - left);
    let nonzero = 0;
    let walk = 0;
    let maxWalk = 0;

    for (const count of counts) if (count > 0) nonzero++;
    for (let column = 0; column < counts.length - 1; column++) {
      const c0 = counts[column];
      const c1 = counts[column + 1];
      if (c0 <= 0 || c1 <= 0) continue;
      const ratio = c1 / c0;
      const weight = 1 - 4 * (0.5 - ratio) ** 2;
      walk += c0 * weight;
      maxWalk += c0;
    }

    const rawAnchor = nonzero > 1 ? walk / Math.max(maxWalk, 1e-9) : 0;
    anchor[index] = 1 + Math.min(rawAnchor - 0.18, 5 * (rawAnchor - 0.22) ** 3);
  }

  return anchor;
}

function computeJbar(
  keyCount: number,
  x: number,
  noteSeqByColumn: Array<Array<[number, number]>>,
  baseCorners: number[],
) {
  const jackNerfer = (delta: number) => 1 - 7e-5 * (0.15 + Math.abs(delta - 0.08)) ** -4;
  const jByKey = Array.from({ length: keyCount }, () => zeros(baseCorners.length));
  const deltaByKey = Array.from({ length: keyCount }, () => Array.from({ length: baseCorners.length }, () => 1e9));

  for (let column = 0; column < keyCount; column++) {
    const notes = noteSeqByColumn[column] ?? [];
    for (let index = 0; index < notes.length - 1; index++) {
      const start = notes[index][1];
      const end = notes[index + 1][1];
      const delta = 0.001 * (end - start);
      const value = delta ** -1 * (delta + 0.11 * x ** 0.25) ** -1 * jackNerfer(delta);
      const left = searchSorted(baseCorners, start);
      const right = searchSorted(baseCorners, end);
      for (let corner = left; corner < right; corner++) {
        jByKey[column][corner] = value;
        deltaByKey[column][corner] = delta;
      }
    }
  }

  const jbarByKey = jByKey.map((values) => smoothOnCorners(baseCorners, values, 500, 0.001));
  const jbar = zeros(baseCorners.length);

  for (let index = 0; index < baseCorners.length; index++) {
    let numerator = 0;
    let denominator = 0;
    for (let column = 0; column < keyCount; column++) {
      const weight = 1 / deltaByKey[column][index];
      numerator += Math.max(jbarByKey[column][index], 0) ** 5 * weight;
      denominator += weight;
    }
    jbar[index] = (numerator / Math.max(denominator, 1e-9)) ** 0.2;
  }

  return { deltaByKey, jbar };
}

function computeXbar(
  keyCount: number,
  x: number,
  noteSeqByColumn: Array<Array<[number, number]>>,
  activeColumns: number[][],
  baseCorners: number[],
) {
  const crossMatrix = [
    [-1],
    [0.075, 0.075],
    [0.125, 0.05, 0.125],
    [0.125, 0.125, 0.125, 0.125],
    [0.175, 0.25, 0.05, 0.25, 0.175],
    [0.175, 0.25, 0.175, 0.175, 0.25, 0.175],
    [0.225, 0.35, 0.25, 0.05, 0.25, 0.35, 0.225],
    [0.225, 0.35, 0.25, 0.225, 0.225, 0.25, 0.35, 0.225],
    [0.275, 0.45, 0.35, 0.25, 0.05, 0.25, 0.35, 0.45, 0.275],
    [0.275, 0.45, 0.35, 0.25, 0.275, 0.275, 0.25, 0.35, 0.45, 0.275],
    [0.325, 0.55, 0.45, 0.35, 0.25, 0.05, 0.25, 0.35, 0.45, 0.55, 0.325],
  ];
  const crossCoeff = crossMatrix[keyCount] ?? crossMatrix[4];
  const xByKey = Array.from({ length: keyCount + 1 }, () => zeros(baseCorners.length));
  const fastCross = Array.from({ length: keyCount + 1 }, () => zeros(baseCorners.length));

  for (let key = 0; key <= keyCount; key++) {
    const notesInPair = key === 0
      ? [...(noteSeqByColumn[0] ?? [])]
      : key === keyCount
        ? [...(noteSeqByColumn[keyCount - 1] ?? [])]
        : [...(noteSeqByColumn[key - 1] ?? []), ...(noteSeqByColumn[key] ?? [])].sort((a, b) => a[1] - b[1]);

    for (let index = 1; index < notesInPair.length; index++) {
      const start = notesInPair[index - 1][1];
      const end = notesInPair[index][1];
      const left = searchSorted(baseCorners, start);
      const right = searchSorted(baseCorners, end);
      if (right <= left) continue;

      const delta = 0.001 * (end - start);
      let value = 0.16 * Math.max(x, delta) ** -2;
      const leftInactive = !activeColumns[left]?.includes(key - 1) && !activeColumns[right]?.includes(key - 1);
      const rightInactive = !activeColumns[left]?.includes(key) && !activeColumns[right]?.includes(key);
      if (leftInactive || rightInactive) value *= 1 - crossCoeff[key];

      for (let corner = left; corner < right; corner++) {
        xByKey[key][corner] = value;
        fastCross[key][corner] = Math.max(0, 0.4 * Math.max(delta, 0.06, 0.75 * x) ** -2 - 80);
      }
    }
  }

  const xBase = zeros(baseCorners.length);
  for (let index = 0; index < baseCorners.length; index++) {
    let value = 0;
    for (let key = 0; key <= keyCount; key++) value += xByKey[key][index] * crossCoeff[key];
    for (let key = 0; key < keyCount; key++) {
      value += Math.sqrt(
        fastCross[key][index] * crossCoeff[key] * fastCross[key + 1][index] * crossCoeff[key + 1],
      );
    }
    xBase[index] = value;
  }

  return smoothOnCorners(baseCorners, xBase, 500, 0.001);
}

function computePbar(
  x: number,
  noteSeq: Array<[number, number]>,
  anchor: number[],
  baseCorners: number[],
) {
  const streamBooster = (delta: number) => {
    const bpm = clamp(7.5 / delta, 0, 420);
    const primary = 0.10 / (1 + Math.exp(-0.06 * (bpm - 175)));
    const secondary = bpm >= 200 && bpm <= 350 ? 0.30 * (1 - Math.exp(-0.02 * (bpm - 200))) : 0;
    return 1 + primary + secondary;
  };
  const pStep = zeros(baseCorners.length);

  for (let index = 0; index < noteSeq.length - 1; index++) {
    const leftTime = noteSeq[index][1];
    const rightTime = noteSeq[index + 1][1];
    const deltaTime = rightTime - leftTime;

    if (deltaTime < 1e-9) {
      const spike = 1000 * (0.02 * (4 / x - 24)) ** 0.25;
      const left = searchSorted(baseCorners, leftTime);
      const right = searchSorted(baseCorners, leftTime, "right");
      for (let corner = left; corner < right; corner++) pStep[corner] += spike;
      continue;
    }

    const left = searchSorted(baseCorners, leftTime);
    const right = searchSorted(baseCorners, rightTime);
    if (right <= left) continue;

    const delta = 0.001 * deltaTime;
    const boost = streamBooster(delta);
    const baseInc = (0.08 * x ** -1 * (1 - 24 * x ** -1 * (x / 6) ** 2)) ** 0.25;
    const inc = delta < (2 * x) / 3
      ? delta ** -1 * (0.08 * x ** -1 * (1 - 24 * x ** -1 * (delta - x / 2) ** 2)) ** 0.25 * Math.max(boost, 1)
      : delta ** -1 * baseInc * Math.max(boost, 1);

    for (let corner = left; corner < right; corner++) {
      pStep[corner] += Math.min(inc * anchor[corner], Math.max(inc, inc * 2 - 10));
    }
  }

  return smoothOnCorners(baseCorners, pStep, 500, 0.001);
}

function computeAbar(
  keyCount: number,
  activeColumns: number[][],
  deltaByKey: number[][],
  aCorners: number[],
  baseCorners: number[],
) {
  const dks = Array.from({ length: keyCount - 1 }, () => zeros(baseCorners.length));
  for (let index = 0; index < baseCorners.length; index++) {
    const columns = activeColumns[index] ?? [];
    for (let columnIndex = 0; columnIndex < columns.length - 1; columnIndex++) {
      const key0 = columns[columnIndex];
      const key1 = columns[columnIndex + 1];
      if (!dks[key0]) continue;
      dks[key0][index] = Math.abs(deltaByKey[key0][index] - deltaByKey[key1][index])
        + 0.4 * Math.max(0, Math.max(deltaByKey[key0][index], deltaByKey[key1][index]) - 0.11);
    }
  }

  const aStep = Array.from({ length: aCorners.length }, () => 1);
  for (let index = 0; index < aCorners.length; index++) {
    const baseIndex = clamp(searchSorted(baseCorners, aCorners[index]), 0, baseCorners.length - 1);
    const columns = activeColumns[baseIndex] ?? [];
    for (let columnIndex = 0; columnIndex < columns.length - 1; columnIndex++) {
      const key0 = columns[columnIndex];
      const key1 = columns[columnIndex + 1];
      if (!dks[key0]) continue;
      const dValue = dks[key0][baseIndex];
      const delta0 = deltaByKey[key0][baseIndex];
      const delta1 = deltaByKey[key1][baseIndex];
      if (dValue < 0.02) {
        aStep[index] *= Math.min(0.75 + 0.5 * Math.max(delta0, delta1), 1);
      } else if (dValue < 0.07) {
        aStep[index] *= Math.min(0.65 + 5 * dValue + 0.5 * Math.max(delta0, delta1), 1);
      }
    }
  }

  return smoothOnCorners(aCorners, aStep, 250, 1, "avg");
}

function computeCAndKs(
  keyCount: number,
  noteSeq: Array<[number, number]>,
  keyUsage: boolean[][],
  baseCorners: number[],
) {
  const noteHitTimes = noteSeq.map(([, time]) => time).sort((a, b) => a - b);
  const cStep = zeros(baseCorners.length);
  const ksStep = zeros(baseCorners.length);

  for (let index = 0; index < baseCorners.length; index++) {
    const left = searchSorted(noteHitTimes, baseCorners[index] - 500);
    const right = searchSorted(noteHitTimes, baseCorners[index] + 500);
    cStep[index] = right - left;

    let active = 0;
    for (let key = 0; key < keyCount; key++) if (keyUsage[key][index]) active++;
    ksStep[index] = Math.max(active, 1);
  }

  return { cStep, ksStep };
}

function applyProximityEnvelope(allCorners: number[], values: number[], noteSeq: Array<[number, number]>): number[] {
  if (noteSeq.length === 0) return [...values];

  const noteTimes = noteSeq.map(([, time]) => time).sort((a, b) => a - b);
  return allCorners.map((time, index) => {
    const insertIndex = searchSorted(noteTimes, time);
    const after = Math.abs((noteTimes[clamp(insertIndex, 0, noteTimes.length - 1)] ?? time) - time);
    const before = Math.abs((noteTimes[clamp(insertIndex - 1, 0, noteTimes.length - 1)] ?? time) - time);
    const distance = Math.min(after, before);
    const envelope = 0.5 * (1 + Math.cos(Math.PI * clamp(distance / 500, 0, 1)));
    return values[index] * envelope;
  });
}

function smoothDForGraph(allCorners: number[], values: number[], noteSeq: Array<[number, number]>): number[] {
  if (allCorners.length === 0) return [];

  const noteTimes = noteSeq.map(([, time]) => time).sort((a, b) => a - b);
  const uniformTimes: number[] = [];
  for (let time = allCorners[0]; time <= allCorners[allCorners.length - 1]; time += GRAPH_RESAMPLE_INTERVAL_MS) {
    uniformTimes.push(time);
  }

  const breakMask = uniformTimes.map((time) => {
    if (noteTimes.length === 0) return false;
    const index = searchSorted(noteTimes, time);
    const after = Math.abs((noteTimes[clamp(index, 0, noteTimes.length - 1)] ?? time) - time);
    const before = Math.abs((noteTimes[clamp(index - 1, 0, noteTimes.length - 1)] ?? time) - time);
    return Math.min(after, before) > BREAK_ZERO_THRESHOLD_MS;
  });

  const uniformValues = interpValues(uniformTimes, allCorners, values).map((value, index) => breakMask[index] ? 0 : value);
  const smoothed = gaussianFilter1d(uniformValues, SMOOTH_SIGMA_MS / GRAPH_RESAMPLE_INTERVAL_MS)
    .map((value, index) => breakMask[index] ? 0 : value);
  return interpValues(allCorners, uniformTimes, smoothed);
}

function weightedPercentile(values: number[], weights: number[], percentile: number): number {
  const indices = values.map((_, index) => index).sort((left, right) => values[left] - values[right]);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (total <= 0) return 0;

  let cumulative = 0;
  for (const index of indices) {
    cumulative += weights[index];
    if (cumulative / total >= percentile) return values[index];
  }
  return values[indices[indices.length - 1]] ?? 0;
}

function weightedPowerMean(values: number[], weights: number[], power: number): number {
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < values.length; index++) {
    numerator += values[index] ** power * weights[index];
    denominator += weights[index];
  }
  return denominator > 0 ? (numerator / denominator) ** (1 / power) : 0;
}

function calculateDaniel(map: ManiaBeatmap, rate: number): DanielCalculation {
  const noteSeq = buildDanielNoteSequence(map, rate);
  if (noteSeq.length === 0) {
    return {
      sr: 0,
      times: [0],
      factors: {
        "Pressing Intensity": [0],
        Unevenness: [0],
        "Same-Column Pressure": [0],
        "Cross-Column Pressure": [0],
      },
    };
  }

  const noteSeqByColumn = Array.from({ length: map.keyCount }, () => [] as Array<[number, number]>);
  for (const note of noteSeq) noteSeqByColumn[note[0]].push(note);

  const od = 9;
  let x = 0.3 * Math.sqrt((64.5 - Math.ceil(od * 3)) / 500);
  x = Math.min(x, 0.6 * (x - 0.09) + 0.09);

  const totalTime = Math.max(...noteSeq.map(([, time]) => time)) + 1;
  const { allCorners, baseCorners, aCorners } = getDanielCorners(totalTime, noteSeq);
  const keyUsage = getKeyUsage(map.keyCount, totalTime, noteSeq, baseCorners);
  const activeColumns = baseCorners.map((_, index) => {
    const active: number[] = [];
    for (let key = 0; key < map.keyCount; key++) if (keyUsage[key][index]) active.push(key);
    return active;
  });
  const keyUsage400 = getKeyUsage400(map.keyCount, noteSeq, baseCorners);
  const anchor = computeAnchor(keyUsage400);
  const { deltaByKey, jbar: baseJbar } = computeJbar(map.keyCount, x, noteSeqByColumn, baseCorners);
  const baseXbar = computeXbar(map.keyCount, x, noteSeqByColumn, activeColumns, baseCorners);
  const basePbar = computePbar(x, noteSeq, anchor, baseCorners);
  const baseAbar = computeAbar(map.keyCount, activeColumns, deltaByKey, aCorners, baseCorners);

  const jbar = interpValues(allCorners, baseCorners, baseJbar);
  const xbar = interpValues(allCorners, baseCorners, baseXbar);
  const pbar = interpValues(allCorners, baseCorners, basePbar);
  const abar = interpValues(allCorners, aCorners, baseAbar);
  const { cStep, ksStep } = computeCAndKs(map.keyCount, noteSeq, keyUsage, baseCorners);
  const cArr = stepInterp(allCorners, baseCorners, cStep);
  const ksArr = stepInterp(allCorners, baseCorners, ksStep);

  const dAll = allCorners.map((_, index) => {
    const sAll = (
      0.4 * (abar[index] ** (3 / ksArr[index]) * Math.min(jbar[index], 8 + 0.85 * jbar[index])) ** 1.5
      + 0.6 * (abar[index] ** (2 / 3) * (0.8 * pbar[index])) ** 1.5
    ) ** (2 / 3);
    const tAll = (abar[index] ** (3 / ksArr[index]) * xbar[index]) / (xbar[index] + sAll + 1);
    return 2.7 * sAll ** 0.5 * tAll ** 1.5 + sAll * 0.27;
  });

  const gaps = allCorners.map((time, index) => {
    if (allCorners.length === 1) return 0;
    if (index === 0) return (allCorners[1] - time) / 2;
    if (index === allCorners.length - 1) return (time - allCorners[index - 1]) / 2;
    return (allCorners[index + 1] - allCorners[index - 1]) / 2;
  });
  const effectiveWeights = cArr.map((value, index) => value * gaps[index]);
  const percentile93 = [0.945, 0.935, 0.925, 0.915]
    .map((percentile) => weightedPercentile(dAll, effectiveWeights, percentile))
    .reduce((sum, value) => sum + value, 0) / 4;
  const percentile83 = [0.845, 0.835, 0.825, 0.815]
    .map((percentile) => weightedPercentile(dAll, effectiveWeights, percentile))
    .reduce((sum, value) => sum + value, 0) / 4;
  const weightedMean = weightedPowerMean(dAll, effectiveWeights, 5);

  let sr = 0.88 * percentile93 * 0.25 + 0.94 * percentile83 * 0.2 + weightedMean * 0.55;
  sr *= noteSeq.length / (noteSeq.length + 60);
  sr = rescaleHigh(sr) * 0.975;

  const dGraph = smoothDForGraph(allCorners, applyProximityEnvelope(allCorners, dAll, noteSeq), noteSeq);
  void dGraph;

  return {
    sr,
    times: allCorners,
    factors: {
      "Pressing Intensity": pbar,
      Unevenness: abar,
      "Same-Column Pressure": jbar,
      "Cross-Column Pressure": xbar,
    },
  };
}

function trapezoidAverage(times: number[], values: number[]): number {
  if (times.length < 2 || values.length < 2) return values[0] ?? 0;

  let integral = 0;
  for (let index = 1; index < times.length; index++) {
    integral += ((values[index - 1] ?? 0) + (values[index] ?? 0)) * 0.5 * (times[index] - times[index - 1]);
  }
  const duration = times[times.length - 1] - times[0];
  return duration > 0 ? integral / duration : 0;
}

function countInWindow(times: number[], windowMs: number): number {
  let best = 0;
  let start = 0;
  for (let end = 0; end < times.length; end++) {
    while (times[end] - times[start] > windowMs) start++;
    best = Math.max(best, end - start + 1);
  }
  return best;
}

function buildMetrics(map: ManiaBeatmap, rate: number): DanEstimate["metrics"] {
  const notes = map.notes
    .filter((note) => note.column >= 0 && note.column < map.keyCount)
    .map((note) => rate === 1 ? note : {
      ...note,
      time: note.time / rate,
      endTime: note.endTime / rate,
    });
  const rows = new Map<number, ManiaNote[]>();
  for (const note of notes) {
    const row = rows.get(note.time);
    if (row) row.push(note);
    else rows.set(note.time, [note]);
  }

  const orderedRows = [...rows.entries()].sort((a, b) => a[0] - b[0]);
  const noteTimes = notes.map((note) => note.time).sort((a, b) => a - b);
  const chordRows = orderedRows.filter(([, rowNotes]) => rowNotes.length >= 2).length;
  const holdRatio = notes.length ? notes.filter((note) => note.isHold).length / notes.length : 0;
  const chordRatio = orderedRows.length ? chordRows / orderedRows.length : 0;
  const lastByColumn = Array.from({ length: Math.max(1, map.keyCount) }, () => -Infinity);
  const jackValues: number[] = [];
  const streamValues: number[] = [];

  for (const [time, rowNotes] of orderedRows) {
    for (const column of rowNotes.map((note) => note.column).sort((a, b) => a - b)) {
      const sameDelta = time - lastByColumn[column];
      if (sameDelta > 0 && sameDelta < 1000) jackValues.push(Math.min(230, 15000 / sameDelta));
      for (const neighbor of [column - 1, column + 1]) {
        if (neighbor < 0 || neighbor >= map.keyCount) continue;
        const delta = time - lastByColumn[neighbor];
        if (delta > 0 && delta < 260) streamValues.push((260 - delta) / 35);
      }
      lastByColumn[column] = time;
    }
  }

  const quantile = (values: number[], q: number) => {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[clamp(Math.floor((sorted.length - 1) * q), 0, sorted.length - 1)];
  };

  return {
    keyCount: map.keyCount,
    noteCount: notes.length,
    holdRatio,
    chordRatio,
    peakNps1s: countInWindow(noteTimes, 1000),
    peakNps5s: countInWindow(noteTimes, 5000) / 5,
    sustainedNps10s: countInWindow(noteTimes, 10000) / 10,
    jackPressure: quantile(jackValues, 0.92),
    streamPressure: quantile(streamValues, 0.9),
    chordjackPressure: quantile(jackValues, 0.92) * (0.28 + chordRatio * 1.35),
    techPressure: 0,
    staminaPressure: countInWindow(noteTimes, 10000) / 10,
  };
}

function parseDanielDan(sr: number) {
  if (sr < DANIEL_BOUNDARIES[0].lower) {
    return {
      label: "alpha",
      variant: "Low",
      displayName: "<Alpha Low",
      rawDan: DANIEL_ORDER_START - 0.01,
    };
  }

  const lastBoundary = DANIEL_BOUNDARIES[DANIEL_BOUNDARIES.length - 1];
  if (sr >= lastBoundary.upper) {
    return {
      label: "theta",
      variant: "High",
      displayName: "? ? ? ? ?",
      rawDan: DANIEL_ORDER_START + DANIEL_ORDER.length,
    };
  }

  for (let index = 0; index < DANIEL_ORDER.length; index++) {
    const boundary = DANIEL_BOUNDARIES[index];
    if (sr < boundary.lower || sr >= boundary.upper) continue;

    const t = clamp((sr - boundary.lower) / (boundary.upper - boundary.lower), 0, 1);
    const tier = t < 1 / 3 ? "Low" : t < 2 / 3 ? "Mid" : "High";
    const dan = DANIEL_ORDER[index];
    return {
      label: dan.toLowerCase(),
      variant: tier,
      displayName: `${dan} ${tier}`,
      rawDan: Math.round((DANIEL_ORDER_START + index + t) * 100) / 100,
    };
  }

  return {
    label: "theta",
    variant: "High",
    displayName: "? ? ? ? ?",
    rawDan: DANIEL_ORDER_START + DANIEL_ORDER.length,
  };
}

export function estimateDanielDan(map: ManiaBeatmap, input: DanEstimateInput = {}): DanEstimate {
  if (map.keyCount !== 4) {
    throw new Error("Daniel estimates are currently only supported for 4K beatmaps.");
  }

  const rate = getInputRate(input);
  const result = calculateDaniel(map, rate);
  const parsed = parseDanielDan(result.sr);
  const factorAverages = Object.fromEntries(
    Object.entries(result.factors).map(([name, values]) => [name, trapezoidAverage(result.times, values)]),
  ) as Record<DanielFactorName, number>;
  const metrics = buildMetrics(map, rate);
  const skillScores: Record<DanSkillFamily, number> = {
    jack: factorAverages["Same-Column Pressure"],
    stream: factorAverages["Pressing Intensity"],
    handstream: 0,
    stamina: result.sr,
    chordjack: factorAverages["Cross-Column Pressure"],
    tech: factorAverages.Unevenness,
    ln: 0,
    dan: result.sr,
  };
  const warnings: string[] = [
    "Daniel port: LNs are treated as rice and OD is fixed at 9, matching Daniel's Python calculator.",
  ];

  if (metrics.holdRatio > 0.05) {
    warnings.push("This map has long notes; Daniel intentionally ignores LN releases.");
  }

  return {
    ...parsed,
    estimatedSr: result.sr,
    family: "dan",
    confidence: parsed.displayName === "? ? ? ? ?" ? 0.35 : 0.78,
    metrics,
    skillScores,
    warnings,
  };
}
