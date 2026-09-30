import type { ManiaNote } from "../chart/beatmap";
import type { LnFamilyVector } from "./workload";

// Which of the four 4K LN course skillsets a chart reads as, from the texture
// measures in FEATURES. Each is judged against ordinary LN charts of the same
// row rate, because most of them rise with density on their own.
//
// REFERENCE: quantiles of 10.7k cached 4K charts with at least 30% holds,
// grouped into 12 equal bins by row rate. Each entry is the bin's median
// rows/s, then the median and interquartile range of each feature in order.
// WEIGHTS: a multinomial logistic fit to 1,670 labeled 4K LN charts: the 64
// stages of the 4K LN Dan Courses (1st to 16th), whose mapper names each
// stage's skillset, plus charts whose pack title, difficulty name or mapper
// tags name one skillset (release and LN jack packs, wall and inverse packs,
// LN stream and speed tags), 31 charts from pack descriptions and course
// stage names that label each difficulty, and textbook patterns (flowing
// rolls, one-column and chord LN jacks, held walls, inverse, LN chords).
// Classes are balanced, tags count at 0.3, description labels at 3 and course
// stages at 5. The fit is held to physical signs: fast LN jacks and
// between-row releases only count toward Technical, held columns under a
// press toward Walls, rolls toward Speed, chords toward All-round and Walls.
// Holding out a tenth of the packs at a time, it names the labeled skillset
// on 54% of Technical, Walls and Speed charts (balanced; the previous
// course-only fit got 39%), on 22 of the 31 description charts and on 38 of
// 64 course stages; fitted on everything it places 47 of 64 stages and every
// textbook pattern.
// Full-LN stream packs are left out: every press lands under held columns,
// so they measure as walls.
const FEATURES = [
  "rowSize", // notes per row
  "chordRow", // rows of two or more notes
  "jackRow", // rows repeating a column of the row before
  "jackFast", // the same, at the chart's usual row gap or faster
  "rollRow", // a row entirely left or right of the one before, at the usual gap or faster
  "press1", // presses made while one other column is held
  "press2", // presses made while two or more other columns are held
  "sameHandHeld", // presses made while the same hand's other column is held
  "inverse", // holds pressed within a row gap of their column's last release
  "lock", // holds whose same-hand partner column is hit twice under them
  "shortHold", // holds no longer than about half the usual row gap
  "offGlobal", // tails between rows, measured against the usual row gap
  "offLocal", // tails between rows, measured against the two presses around them
  "splitRelease", // holds started together but released apart
  "asyncRelease", // holds released together but started apart
  "holdLength", // median hold length in row gaps
  "holdShare", // holds among all notes
  "pressFree", // presses made with no other column held
  "tailOnRow", // tails landing on a press
] as const;
type Feature = typeof FEATURES[number];
const REFERENCE: ReadonlyArray<readonly number[]> = [
  [4.055, 1.4509, 0.3515, 0.3949, 0.234, 0.2057, 0.2224, 0.1054, 0.1879, 0.4776, 0.212, 0.2504, 0.2474, 0.0361, 0.1104, 0.118, 0.1507, 0.4092, 0.3794, 0.0964, 0.109, 0.0992, 0.2899, 0.2213, 0.4994, 0.3308, 0.4189, 0.264, 0.3503, 0.2416, 0.2621, 1, 0.5, 0.6163, 0.3026, 0.674, 0.3659, 0.6528, 0.447],
  [5.574, 1.5561, 0.3189, 0.4582, 0.1928, 0.2494, 0.1895, 0.1358, 0.223, 0.4509, 0.1748, 0.2682, 0.1966, 0.0452, 0.0895, 0.1215, 0.1173, 0.4893, 0.3072, 0.1057, 0.0763, 0.1721, 0.3256, 0.3011, 0.452, 0.406, 0.3354, 0.302, 0.2424, 0.2676, 0.22, 1, 0.4941, 0.5983, 0.2432, 0.6715, 0.2748, 0.5876, 0.3451],
  [6.57, 1.6028, 0.2957, 0.4768, 0.1683, 0.2494, 0.1677, 0.1085, 0.2296, 0.4438, 0.1434, 0.2888, 0.1359, 0.0602, 0.0976, 0.1441, 0.1018, 0.5187, 0.2925, 0.1105, 0.0677, 0.1268, 0.3252, 0.2341, 0.4326, 0.4082, 0.2746, 0.3522, 0.2119, 0.3124, 0.1784, 1, 0.5, 0.6529, 0.2794, 0.6355, 0.2142, 0.5846, 0.2732],
  [7.373, 1.582, 0.2763, 0.469, 0.1737, 0.2199, 0.1483, 0.0289, 0.1537, 0.4586, 0.1503, 0.301, 0.1533, 0.0605, 0.0873, 0.145, 0.1, 0.4862, 0.2921, 0.1097, 0.0644, 0.0218, 0.2072, 0.1329, 0.3668, 0.3722, 0.2614, 0.3391, 0.2097, 0.3157, 0.1733, 1.007, 0.6667, 0.6496, 0.2821, 0.623, 0.2143, 0.6223, 0.2601],
  [8.079, 1.5771, 0.2826, 0.4512, 0.1621, 0.2117, 0.1496, 0.018, 0.1012, 0.4628, 0.1332, 0.3121, 0.1583, 0.0711, 0.0932, 0.1621, 0.0991, 0.483, 0.2767, 0.1137, 0.0643, 0.0114, 0.1162, 0.1086, 0.3274, 0.37, 0.2591, 0.3428, 0.1836, 0.3152, 0.1705, 1.0112, 0.6517, 0.6626, 0.2703, 0.5931, 0.203, 0.623, 0.2632],
  [8.707, 1.5498, 0.2426, 0.44, 0.1481, 0.1929, 0.136, 0.0148, 0.1104, 0.48, 0.1274, 0.3252, 0.1485, 0.0757, 0.0969, 0.1667, 0.1022, 0.5102, 0.279, 0.1123, 0.0619, 0.0102, 0.1234, 0.1265, 0.3238, 0.3489, 0.2515, 0.3334, 0.1983, 0.3165, 0.1541, 1.0116, 0.5173, 0.6867, 0.2776, 0.5856, 0.2026, 0.647, 0.2501],
  [9.335, 1.5354, 0.2309, 0.4287, 0.1468, 0.1805, 0.14, 0.0105, 0.0829, 0.5003, 0.1416, 0.3207, 0.1572, 0.0882, 0.1004, 0.1753, 0.1046, 0.5264, 0.2738, 0.1113, 0.0554, 0.0055, 0.0987, 0.1219, 0.3117, 0.3459, 0.2681, 0.3422, 0.1804, 0.3262, 0.1564, 1.0122, 0.6768, 0.715, 0.3057, 0.5747, 0.2255, 0.6465, 0.2666],
  [9.951, 1.5146, 0.2178, 0.4154, 0.1417, 0.163, 0.1219, 0.0091, 0.0594, 0.5243, 0.1321, 0.3338, 0.1468, 0.095, 0.1085, 0.1853, 0.1065, 0.55, 0.2726, 0.1106, 0.0576, 0.0017, 0.0421, 0.1072, 0.2764, 0.3309, 0.243, 0.351, 0.1793, 0.3364, 0.1725, 1.0792, 0.8367, 0.7383, 0.2958, 0.549, 0.2276, 0.6641, 0.2485],
  [10.62, 1.495, 0.1919, 0.4062, 0.1338, 0.1529, 0.1119, 0.0054, 0.045, 0.5325, 0.1277, 0.3353, 0.1555, 0.1013, 0.1187, 0.1946, 0.105, 0.5702, 0.27, 0.1122, 0.0523, 0.0025, 0.0451, 0.1234, 0.2602, 0.3174, 0.2449, 0.3461, 0.1709, 0.3328, 0.1634, 1.2514, 0.7199, 0.7615, 0.2988, 0.5358, 0.2143, 0.677, 0.2475],
  [11.41, 1.4584, 0.1823, 0.3765, 0.1269, 0.1379, 0.1014, 0.0018, 0.0272, 0.5524, 0.1412, 0.3373, 0.1574, 0.1133, 0.1247, 0.2015, 0.1181, 0.5643, 0.2943, 0.1113, 0.0548, 0.0005, 0.0174, 0.13, 0.2603, 0.3071, 0.2641, 0.3445, 0.1606, 0.3362, 0.1613, 1.3333, 0.8648, 0.7775, 0.3193, 0.5228, 0.2505, 0.6843, 0.2736],
  [12.468, 1.446, 0.1773, 0.357, 0.1293, 0.1306, 0.101, 0.0007, 0.0189, 0.5574, 0.1437, 0.345, 0.1457, 0.1361, 0.116, 0.218, 0.1151, 0.579, 0.3118, 0.1129, 0.0541, 0, 0.0158, 0.1343, 0.3023, 0.3107, 0.2595, 0.3382, 0.1626, 0.3376, 0.1751, 1.3429, 0.9678, 0.7902, 0.3079, 0.4991, 0.2325, 0.6833, 0.2633],
  [14.5, 1.3887, 0.1745, 0.3141, 0.1356, 0.0966, 0.089, 0, 0.0033, 0.5901, 0.1536, 0.3511, 0.1807, 0.1703, 0.1574, 0.2462, 0.1406, 0.5349, 0.4214, 0.11, 0.0569, 0, 0.0043, 0.1716, 0.3348, 0.331, 0.3109, 0.3088, 0.1942, 0.3072, 0.1975, 1.5319, 0.7947, 0.8011, 0.3288, 0.4449, 0.3037, 0.6633, 0.3162],
];
const WEIGHTS: Record<keyof LnFamilyVector, readonly number[]> = {
  // intercept, then one weight per FEATURES entry
  lnhybrid: [0.395, 0, 0.386, -0.244, -0.382, 0.652, -2.5, -2.491, 1.232, -0.809, 1.344, 0.226, -2.8, -1.406, -1.041, 0.322, -0.675, 1.224, -3.294, -2.703],
  lntechnical: [-0.128, -2.464, -0.3, 0.847, 0.529, 0, 1.089, 0.456, -1.436, 0.254, -0.603, -0.392, 0, 0, 1.485, -0.54, 0.568, -0.582, -0.456, 0],
  lnwalls: [0.05, -1.722, 1.073, -0.338, 0, 0.688, 0.166, 0.087, 0.771, 0.828, -0.58, -0.098, -1.977, -3.46, 0.638, 0.63, 0.146, -0.819, 0, -3.92],
  lnspeed: [-0.318, 0, -1.154, -0.265, -0.345, 0, 1.245, 0, -0.566, -0.273, -0.161, 0.264, 0, 0, -1.083, -0.412, -0.039, 0.176, 0, 0.409],
};
const ROW_MS = 5;
const HELD_MARGIN_MS = 10;
const TAIL_ON_ROW_MS = 8;
const MIN_ROW_GAP_MS = 20;
const OFFSET_LIMIT = 6;
// A chart with clearly more jacks than its row rate's usual, both in all rows
// and at the usual gap, is not Speed. A light hybrid with 1/2 jacks otherwise
// reads as Speed from its free presses and short holds alone. Fast jacks must
// also be a real share of the rows: the usual share at high row rates is near
// zero, so a few jumpjacks between rolls would clear the offset bar alone.
// The bar sits on 6% of the labeled Speed charts and 20% of the Technical ones.
const SPEED_JACK_VETO = 0.8;
const SPEED_JACK_VETO_MIN_SHARE = 0.05;

export type LnSkillsetFeatures = Record<Feature, number> & { rowsPerSecond: number };

const bits = (mask: number) => { let n = 0; for (; mask; mask &= mask - 1) n += 1; return n; };
const lowest = (mask: number) => 31 - Math.clz32(mask & -mask);
const highest = (mask: number) => 31 - Math.clz32(mask);
const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0; };
function lowerBound(values: readonly number[], x: number): number {
  let lo = 0, hi = values.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (values[mid] < x) lo = mid + 1; else hi = mid; }
  return lo;
}
type Note = Pick<ManiaNote, "column" | "time" | "endTime" | "isHold">;
/** Share of holds sitting in a group (keys within ROW_MS) whose other ends differ. */
function unevenGroups(holds: readonly Note[], key: (hold: Note) => number, other: (hold: Note) => number): number {
  const sorted = [...holds].sort((a, b) => key(a) - key(b));
  let count = 0;
  for (let i = 0; i < sorted.length;) {
    let j = i + 1;
    while (j < sorted.length && key(sorted[j]) - key(sorted[i]) <= ROW_MS) j += 1;
    const others = sorted.slice(i, j).map(other);
    if (j - i >= 2 && Math.max(...others) - Math.min(...others) > ROW_MS) count += j - i;
    i = j;
  }
  return count / Math.max(1, holds.length);
}

/** Notes are chart-time; rate divides once, so a baked rate reads the same. */
export function lnSkillsetFeatures(input: readonly ManiaNote[], rate = 1): LnSkillsetFeatures | null {
  if (input.length < 2) return null;
  const notes: Note[] = input.map(note => ({ column: note.column, time: note.time / rate, endTime: note.endTime / rate, isHold: note.isHold }))
    .sort((a, b) => a.time - b.time || a.column - b.column);
  const rows: Array<{ time: number; mask: number }> = [];
  for (const note of notes) {
    const last = rows[rows.length - 1];
    if (last && note.time - last.time <= ROW_MS) last.mask |= 1 << note.column;
    else rows.push({ time: note.time, mask: 1 << note.column });
  }
  const seconds = Math.max(1, (notes[notes.length - 1].time - notes[0].time) / 1000);
  const rowGap = Math.max(MIN_ROW_GAP_MS, median(rows.slice(1).map((row, i) => row.time - rows[i].time).filter(gap => gap > ROW_MS)));
  const holds = notes.filter(note => note.isHold), holdCount = Math.max(1, holds.length);

  let chordRows = 0, jackRow = 0, jackFast = 0, rollRow = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const mask = rows[i].mask;
    if (bits(mask) >= 2) chordRows += 1;
    if (!i) continue;
    const previous = rows[i - 1].mask, fast = rows[i].time - rows[i - 1].time <= 1.05 * rowGap;
    if (mask & previous) { jackRow += 1; if (fast) jackFast += 1; }
    else if (fast && (highest(mask) < lowest(previous) || lowest(mask) > highest(previous))) rollRow += 1;
  }

  const start = [0, 0, 0, 0], end = [-Infinity, -Infinity, -Infinity, -Infinity], lastEnd = [-Infinity, -Infinity, -Infinity, -Infinity];
  let pressFree = 0, press1 = 0, press2 = 0, sameHandHeld = 0, inverse = 0;
  for (const note of notes) {
    let held = 0, sameHand = false;
    for (let lane = 0; lane < 4; lane += 1) {
      if (lane === note.column || !(start[lane] < note.time - HELD_MARGIN_MS && end[lane] > note.time + HELD_MARGIN_MS)) continue;
      held += 1;
      if ((lane < 2) === (note.column < 2)) sameHand = true;
    }
    if (held === 0) pressFree += 1;
    if (held === 1) press1 += 1;
    if (held >= 2) press2 += 1;
    if (sameHand) sameHandHeld += 1;
    const sinceRelease = note.time - lastEnd[note.column];
    if (note.isHold && sinceRelease >= 0 && sinceRelease <= 1.05 * rowGap) inverse += 1;
    lastEnd[note.column] = note.endTime;
    if (note.isHold) { start[note.column] = note.time; end[note.column] = note.endTime; }
  }

  const starts = notes.map(note => note.time);
  const laneStarts = [0, 1, 2, 3].map(lane => notes.filter(note => note.column === lane).map(note => note.time));
  let lock = 0, shortHold = 0, offGlobal = 0, offLocal = 0, tailOnRow = 0;
  for (const hold of holds) {
    const partner = laneStarts[hold.column ^ 1];
    if (lowerBound(partner, hold.endTime + 1) - lowerBound(partner, hold.time) >= 2) lock += 1;
    if (hold.endTime - hold.time <= 0.55 * rowGap) shortHold += 1;
    const i = lowerBound(starts, hold.endTime - ROW_MS);
    const next = starts[i] ?? Infinity, previous = starts[i - 1] ?? -Infinity;
    const gap = Math.min(Math.abs(next - hold.endTime), Math.abs(hold.endTime - previous));
    if (gap <= TAIL_ON_ROW_MS) tailOnRow += 1;
    if (gap / rowGap > 0.1 && gap / rowGap < 0.9) offGlobal += 1;
    const span = next - previous;
    if (Number.isFinite(span) && span > 0 && gap > TAIL_ON_ROW_MS && gap / span > 0.15) offLocal += 1;
  }

  return {
    rowsPerSecond: rows.length / seconds,
    rowSize: notes.length / rows.length, chordRow: chordRows / rows.length,
    jackRow: jackRow / rows.length, jackFast: jackFast / rows.length, rollRow: rollRow / rows.length,
    press1: press1 / notes.length, press2: press2 / notes.length, sameHandHeld: sameHandHeld / notes.length,
    inverse: inverse / holdCount, lock: lock / holdCount, shortHold: shortHold / holdCount,
    offGlobal: offGlobal / holdCount, offLocal: offLocal / holdCount,
    splitRelease: unevenGroups(holds, hold => hold.time, hold => hold.endTime),
    asyncRelease: unevenGroups(holds, hold => hold.endTime, hold => hold.time),
    holdLength: median(holds.map(hold => hold.endTime - hold.time)) / rowGap,
    holdShare: holds.length / notes.length, pressFree: pressFree / notes.length, tailOnRow: tailOnRow / holdCount,
  };
}

function interpolate(x: number, column: number): number {
  const first = REFERENCE[0], last = REFERENCE[REFERENCE.length - 1];
  if (x <= first[0]) return first[column];
  if (x >= last[0]) return last[column];
  const upper = REFERENCE.findIndex(row => row[0] >= x);
  const a = REFERENCE[upper - 1], b = REFERENCE[upper];
  return a[column] + (b[column] - a[column]) * (x - a[0]) / (b[0] - a[0]);
}

/** Support for at most two families: the likeliest is 1, the runner-up is its
 * probability over the leader's, and the other two are 0. */
export function classifyLnSkillsets(notes: readonly ManiaNote[], rate = 1): LnFamilyVector | null {
  const features = lnSkillsetFeatures(notes, rate);
  if (!features || !Object.values(features).every(Number.isFinite)) return null;
  const offsets = FEATURES.map((feature, i) => {
    const iqr = Math.max(interpolate(features.rowsPerSecond, 2 + 2 * i), 1e-6);
    const offset = (features[feature] - interpolate(features.rowsPerSecond, 1 + 2 * i)) / iqr;
    return Math.max(-OFFSET_LIMIT, Math.min(OFFSET_LIMIT, offset));
  });
  const jackVeto = offsets[FEATURES.indexOf("jackRow")] > SPEED_JACK_VETO && offsets[FEATURES.indexOf("jackFast")] > SPEED_JACK_VETO
    && features.jackFast >= SPEED_JACK_VETO_MIN_SHARE;
  const logits = Object.entries(WEIGHTS).map(([id, [bias, ...weights]]) =>
    [id as keyof LnFamilyVector, id === "lnspeed" && jackVeto ? -Infinity : bias + weights.reduce((sum, weight, i) => sum + weight * offsets[i], 0)] as const)
    .sort((a, b) => b[1] - a[1]);
  const result: LnFamilyVector = { lnhybrid: 0, lntechnical: 0, lnwalls: 0, lnspeed: 0 };
  result[logits[0][0]] = 1;
  result[logits[1][0]] = Math.exp(logits[1][1] - logits[0][1]);
  return result;
}
