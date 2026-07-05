// Port of osu!lazer's mania star rating calculator (ManiaDifficultyCalculator
// Version 20241007): Strain skill + Individual/Overall strain evaluators over
// 400ms section peaks, weighted 0.9^n and scaled by 0.018. Runs on the parsed
// (convert/keymod-applied) note list, so it supports arbitrary clock rates -
// which the osu! API attributes endpoint cannot do (it ignores lazer's custom
// speed_change settings). Validated against the API's star_rating for
// nomod/DT/HT; keep every quirk below (legacy unstable sort, banker's
// rounding, DefinitelyBigger's 1ms epsilon) - they are load-bearing.

export interface StarRatingNote {
  time: number;
  endTime: number;
  column: number;
}

const INDIVIDUAL_DECAY_BASE = 0.125;
const OVERALL_DECAY_BASE = 0.3;
const RELEASE_THRESHOLD = 30;
const SECTION_LENGTH = 400;
const DECAY_WEIGHT = 0.9;
const DIFFICULTY_MULTIPLIER = 0.018;

interface Dho {
  startTime: number;
  endTime: number;
  deltaTime: number;
  columnStrainTime: number;
  column: number;
  // Last object seen in each column before this one, in processing order
  // ("intentionally depends on processing order to match live").
  prevs: (Dho | null)[];
}

export function calculateManiaStarRating(
  notes: readonly StarRatingNote[],
  columnCount: number,
  clockRate: number,
): number {
  if (notes.length < 2 || columnCount <= 0 || !(clockRate > 0)) return 0;

  const sorted = notes.slice();
  legacySort(sorted, (a, b) => roundHalfToEven(a.time) - roundHalfToEven(b.time));

  // Strain skill state (Strain.cs). StrainDecayBase is 1, so currentStrain
  // never decays and always equals highestIndividualStrain + overallStrain.
  const individualStrains = new Array<number>(columnCount).fill(0);
  let highestIndividualStrain = 0;
  let overallStrain = 1;
  let currentStrain = 0;

  // Section-peak state (StrainSkill.cs).
  const strainPeaks: number[] = [];
  let currentSectionPeak = 0;
  let currentSectionEnd = 0;

  const lastInColumn = new Array<Dho | null>(columnCount).fill(null);
  let prevDho: Dho | null = null;
  let prevStartTime = 0;

  for (let i = 1; i < sorted.length; i++) {
    const note = sorted[i];
    const startTime = note.time / clockRate;
    const endTime = note.endTime / clockRate;
    const inColumn = lastInColumn[note.column];
    const dho: Dho = {
      startTime,
      endTime,
      deltaTime: (note.time - sorted[i - 1].time) / clockRate,
      columnStrainTime: inColumn ? startTime - inColumn.startTime : startTime,
      column: note.column,
      prevs: prevDho ? prevDho.prevs.slice() : new Array<Dho | null>(columnCount).fill(null),
    };
    if (prevDho) dho.prevs[prevDho.column] = prevDho;

    // StrainSkill.ProcessInternal: flush section peaks up to this object.
    if (prevDho === null) {
      currentSectionEnd = Math.ceil(startTime / SECTION_LENGTH) * SECTION_LENGTH;
    }
    while (startTime > currentSectionEnd) {
      strainPeaks.push(currentSectionPeak);
      // Strain.CalculateInitialStrain, with Previous(0) = the last processed object.
      const elapsed = currentSectionEnd - prevStartTime;
      currentSectionPeak =
        applyDecay(highestIndividualStrain, elapsed, INDIVIDUAL_DECAY_BASE) +
        applyDecay(overallStrain, elapsed, OVERALL_DECAY_BASE);
      currentSectionEnd += SECTION_LENGTH;
    }

    // Strain.StrainValueOf.
    const col = dho.column;
    individualStrains[col] = applyDecay(individualStrains[col], dho.columnStrainTime, INDIVIDUAL_DECAY_BASE);
    individualStrains[col] += evaluateIndividualStrain(dho);
    highestIndividualStrain = dho.deltaTime <= 1
      ? Math.max(highestIndividualStrain, individualStrains[col])
      : individualStrains[col];
    overallStrain = applyDecay(overallStrain, dho.deltaTime, OVERALL_DECAY_BASE);
    overallStrain += evaluateOverallStrain(dho);

    // StrainDecaySkill.StrainValueAt: currentStrain += StrainValueOf, which
    // subtracts the pre-update currentStrain.
    currentStrain += highestIndividualStrain + overallStrain - currentStrain;
    currentSectionPeak = Math.max(currentStrain, currentSectionPeak);

    lastInColumn[dho.column] = dho;
    prevDho = dho;
    prevStartTime = startTime;
  }

  // StrainSkill.DifficultyValue: weighted sum of section peaks, highest first.
  const peaks = [...strainPeaks, currentSectionPeak].filter((p) => p > 0).sort((a, b) => b - a);
  let difficulty = 0;
  let weight = 1;
  for (const peak of peaks) {
    difficulty += peak * weight;
    weight *= DECAY_WEIGHT;
  }
  return difficulty * DIFFICULTY_MULTIPLIER;
}

// IndividualStrainEvaluator: bonus if this note starts and ends inside
// another column's hold.
function evaluateIndividualStrain(dho: Dho): number {
  let holdFactor = 1.0;
  for (const prev of dho.prevs) {
    if (!prev) continue;
    if (definitelyBigger(prev.endTime, dho.endTime) && definitelyBigger(dho.startTime, prev.startTime)) {
      holdFactor = 1.25;
      break;
    }
  }
  return 2.0 * holdFactor;
}

// OverallStrainEvaluator: hold-release awkwardness bonus.
function evaluateOverallStrain(dho: Dho): number {
  let closestEndTime = Math.abs(dho.endTime - dho.startTime);
  let holdFactor = 1.0;
  let isOverlapping = false;
  for (const prev of dho.prevs) {
    if (!prev) continue;
    isOverlapping ||= definitelyBigger(prev.endTime, dho.startTime)
      && definitelyBigger(dho.endTime, prev.endTime)
      && definitelyBigger(dho.startTime, prev.startTime);
    if (definitelyBigger(prev.endTime, dho.endTime) && definitelyBigger(dho.startTime, prev.startTime)) {
      holdFactor = 1.25;
    }
    closestEndTime = Math.min(closestEndTime, Math.abs(dho.endTime - prev.endTime));
  }
  const holdAddition = isOverlapping
    ? 1 / (1 + Math.exp(0.27 * (RELEASE_THRESHOLD - closestEndTime)))
    : 0;
  return (1 + holdAddition) * holdFactor;
}

function applyDecay(value: number, deltaTime: number, decayBase: number): number {
  return value * Math.pow(decayBase, deltaTime / 1000);
}

// osu.Framework Precision.DefinitelyBigger with the calculator's 1ms epsilon.
function definitelyBigger(value1: number, value2: number): boolean {
  return value1 - 1 > value2;
}

// C# Math.Round default: round half to even (banker's rounding).
function roundHalfToEven(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

// .NET 4.0 unstable Array.Sort (LegacySortHelper.cs): depth-limited quicksort
// falling back to heapsort. The tie order it produces feeds the strain
// calculation's processing-order dependence, so a stable sort is NOT a valid
// substitute.
function legacySort<T>(keys: T[], compare: (a: T, b: T) => number): void {
  if (keys.length === 0) return;
  depthLimitedQuickSort(keys, 0, keys.length - 1, compare, 32);
}

function depthLimitedQuickSort<T>(keys: T[], left: number, right: number, compare: (a: T, b: T) => number, depthLimit: number): void {
  do {
    if (depthLimit === 0) {
      heapsort(keys, left, right, compare);
      return;
    }

    let i = left;
    let j = right;
    const middle = i + ((j - i) >> 1);
    swapIfGreater(keys, compare, i, middle);
    swapIfGreater(keys, compare, i, j);
    swapIfGreater(keys, compare, middle, j);

    const x = keys[middle];

    do {
      while (compare(keys[i], x) < 0) i++;
      while (compare(x, keys[j]) < 0) j--;
      if (i > j) break;
      if (i < j) {
        const tmp = keys[i];
        keys[i] = keys[j];
        keys[j] = tmp;
      }
      i++;
      j--;
    } while (i <= j);

    depthLimit--;

    if (j - left <= right - i) {
      if (left < j) depthLimitedQuickSort(keys, left, j, compare, depthLimit);
      left = i;
    } else {
      if (i < right) depthLimitedQuickSort(keys, i, right, compare, depthLimit);
      right = j;
    }
  } while (left < right);
}

function swapIfGreater<T>(keys: T[], compare: (a: T, b: T) => number, a: number, b: number): void {
  if (a !== b && compare(keys[a], keys[b]) > 0) {
    const tmp = keys[a];
    keys[a] = keys[b];
    keys[b] = tmp;
  }
}

function heapsort<T>(keys: T[], lo: number, hi: number, compare: (a: T, b: T) => number): void {
  const n = hi - lo + 1;
  for (let i = Math.floor(n / 2); i >= 1; i--) {
    downHeap(keys, i, n, lo, compare);
  }
  for (let i = n; i > 1; i--) {
    const tmp = keys[lo];
    keys[lo] = keys[lo + i - 1];
    keys[lo + i - 1] = tmp;
    downHeap(keys, 1, i - 1, lo, compare);
  }
}

function downHeap<T>(keys: T[], i: number, n: number, lo: number, compare: (a: T, b: T) => number): void {
  const d = keys[lo + i - 1];
  while (i <= Math.floor(n / 2)) {
    let child = 2 * i;
    if (child < n && compare(keys[lo + child - 1], keys[lo + child]) < 0) {
      child++;
    }
    if (!(compare(d, keys[lo + child - 1]) < 0)) break;
    keys[lo + i - 1] = keys[lo + child - 1];
    i = child;
  }
  keys[lo + i - 1] = d;
}
