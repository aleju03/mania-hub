import type { ManiaBeatmap } from "../beatmap-parser.js";
import { extractDanFeatures } from "./features.js";
import type { DanEstimateInput, DanFeatureMetrics } from "./types.js";

export interface LnDanEstimateResult {
  label: string;
  variant: string | null;
  displayName: string;
  rawDan: number;
  estimatedSr: number;
  confidence: number;
  reason: string;
}

export interface LnReferenceChart {
  level: number;
  n: number;
  s: number;
  h: number;
  d: number;
  o: number;
  r: number;
  c: number;
  p: number;
  u: number;
  q: number;
}

export interface LnReferenceNeighbor {
  level: number;
  distance: number;
  metrics: LnReferenceChart;
}

const LN_REFERENCE_CHARTS: LnReferenceChart[] = [
  { level: 1, n: 717, s: 88.7, h: 0.245, d: 0.153, o: 2.012, r: 4.829, c: 0.594, p: 10.8, u: 10.3, q: 0.577 },
  { level: 1, n: 336, s: 85.7, h: 0.568, d: 0.277, o: 2.506, r: 5.5, c: 0.6, p: 5.4, u: 5.2, q: 0.553 },
  { level: 1, n: 176, s: 111.6, h: 0.602, d: 0.399, o: 2.996, r: 3.42, c: 0.152, p: 2.8, u: 2.1, q: 0.15 },
  { level: 1, n: 613, s: 111.3, h: 0.664, d: 0.235, o: 2.339, r: 7.503, c: 0.21, p: 8.2, u: 7.5, q: 0.19 },
  { level: 2, n: 805, s: 118, h: 0.471, d: 0.269, o: 2.476, r: 7.303, c: 0.718, p: 8.6, u: 8, q: 0.585 },
  { level: 2, n: 805, s: 121.9, h: 0.757, d: 0.395, o: 2.982, r: 9.229, c: 0.388, p: 8.6, u: 8.1, q: 0.374 },
  { level: 2, n: 377, s: 104.1, h: 0.87, d: 0.639, o: 3.957, r: 8.452, c: 0.38, p: 8, u: 6, q: 0.385 },
  { level: 2, n: 805, s: 107, h: 1, d: 0.325, o: 2.698, r: 14.602, c: 0.158, p: 13.2, u: 12.7, q: 0.158 },
  { level: 3, n: 836, s: 107, h: 0.561, d: 0.295, o: 2.581, r: 8.344, c: 0.342, p: 10.2, u: 9.6, q: 0.319 },
  { level: 3, n: 921, s: 128.5, h: 0.457, d: 0.328, o: 2.711, r: 6.504, c: 0.22, p: 15.6, u: 14.6, q: 0.23 },
  { level: 3, n: 612, s: 104, h: 0.438, d: 0.347, o: 2.79, r: 4.732, c: 0.375, p: 9.4, u: 9.2, q: 0.345 },
  { level: 3, n: 1155, s: 111.5, h: 0.466, d: 0.282, o: 2.528, r: 12.565, c: 0.619, p: 13.2, u: 12.7, q: 0.424 },
  { level: 4, n: 907, s: 123.1, h: 0.62, d: 0.316, o: 2.665, r: 11.085, c: 0.418, p: 12.4, u: 10.6, q: 0.389 },
  { level: 4, n: 1053, s: 118.7, h: 0.524, d: 0.197, o: 2.186, r: 12.4, c: 0.436, p: 12, u: 11.3, q: 0.37 },
  { level: 4, n: 413, s: 94.4, h: 0.891, d: 0.711, o: 4.245, r: 9.589, c: 0.412, p: 8.6, u: 6.9, q: 0.363 },
  { level: 4, n: 1066, s: 115.8, h: 1, d: 0.494, o: 3.377, r: 14.813, c: 0.385, p: 13.2, u: 12.2, q: 0.385 },
  { level: 5, n: 1904, s: 166.8, h: 0.553, d: 0.235, o: 2.339, r: 12.739, c: 0.732, p: 15.6, u: 15.3, q: 0.64 },
  { level: 5, n: 887, s: 115.8, h: 0.818, d: 0.414, o: 3.058, r: 12.1, c: 0.483, p: 13.8, u: 11.8, q: 0.414 },
  { level: 5, n: 1380, s: 147.2, h: 0.386, d: 0.344, o: 2.775, r: 11, c: 0.851, p: 14.8, u: 13.3, q: 0.691 },
  { level: 5, n: 1218, s: 118.1, h: 0.543, d: 0.333, o: 2.733, r: 15.531, c: 0.596, p: 14.8, u: 13.3, q: 0.478 },
  { level: 6, n: 1365, s: 150.1, h: 0.703, d: 0.417, o: 3.069, r: 12.7, c: 0.525, p: 13.4, u: 12.1, q: 0.456 },
  { level: 6, n: 745, s: 151, h: 0.895, d: 0.432, o: 3.126, r: 9.903, c: 0.381, p: 8.6, u: 8.4, q: 0.356 },
  { level: 6, n: 1219, s: 118.5, h: 0.551, d: 0.41, o: 3.041, r: 12, c: 0.473, p: 13.6, u: 12.6, q: 0.377 },
  { level: 6, n: 1533, s: 113, h: 0.579, d: 0.269, o: 2.475, r: 15.165, c: 0.491, p: 18.4, u: 17.2, q: 0.434 },
  { level: 7, n: 1394, s: 115.8, h: 0.489, d: 0.321, o: 2.686, r: 16.105, c: 0.327, p: 18.6, u: 16.2, q: 0.376 },
  { level: 7, n: 1119, s: 100.7, h: 0.761, d: 0.451, o: 3.203, r: 14.6, c: 0.535, p: 15.6, u: 15, q: 0.544 },
  { level: 7, n: 832, s: 101.8, h: 1, d: 0.695, o: 4.18, r: 11.076, c: 0.614, p: 10.4, u: 9.6, q: 0.614 },
  { level: 7, n: 1666, s: 117, h: 0.432, d: 0.232, o: 2.326, r: 13.252, c: 0.52, p: 19.2, u: 18.8, q: 0.553 },
  { level: 8, n: 1445, s: 129.5, h: 0.864, d: 0.52, o: 3.478, r: 18.207, c: 0.476, p: 16.4, u: 16, q: 0.473 },
  { level: 8, n: 1318, s: 154.2, h: 0.839, d: 0.524, o: 3.497, r: 12.365, c: 0.505, p: 11.8, u: 11.4, q: 0.482 },
  { level: 8, n: 1258, s: 155.2, h: 0.976, d: 0.614, o: 3.858, r: 15.705, c: 0.379, p: 13.8, u: 11.7, q: 0.389 },
  { level: 8, n: 1265, s: 98.4, h: 0.552, d: 0.234, o: 2.336, r: 19.027, c: 0.387, p: 20.6, u: 19.6, q: 0.371 },
  { level: 8, n: 429, s: 32.2, h: 0.392, d: 0.205, o: 2.222, r: 14.627, c: 0.388, p: 17.6, u: 16.6, q: 0.465 },
  { level: 9, n: 2500, s: 165.5, h: 0.628, d: 0.407, o: 3.028, r: 15.207, c: 0.477, p: 20.8, u: 19.4, q: 0.424 },
  { level: 9, n: 1461, s: 131, h: 0.775, d: 0.449, o: 3.196, r: 20.809, c: 0.546, p: 17.4, u: 16.6, q: 0.477 },
  { level: 9, n: 1187, s: 94.3, h: 0.862, d: 0.453, o: 3.211, r: 20.186, c: 0.347, p: 17.8, u: 16.7, q: 0.331 },
  { level: 9, n: 2305, s: 168.6, h: 0.604, d: 0.347, o: 2.786, r: 22.488, c: 0.565, p: 19.6, u: 19, q: 0.485 },
  { level: 10, n: 2377, s: 157.8, h: 0.651, d: 0.331, o: 2.723, r: 24.347, c: 0.687, p: 23, u: 21.8, q: 0.606 },
  { level: 10, n: 1656, s: 118.1, h: 0.884, d: 0.431, o: 3.125, r: 19.4, c: 0.405, p: 17.4, u: 17, q: 0.379 },
  { level: 10, n: 1689, s: 119, h: 0.993, d: 0.698, o: 4.19, r: 20.586, c: 0.561, p: 19.2, u: 18.4, q: 0.561 },
  { level: 10, n: 2185, s: 139.8, h: 0.673, d: 0.397, o: 2.989, r: 22.275, c: 0.46, p: 22, u: 20.7, q: 0.434 },
  { level: 11, n: 1864, s: 106.5, h: 0.881, d: 0.499, o: 3.396, r: 24.406, c: 0.464, p: 22.4, u: 21, q: 0.461 },
  { level: 11, n: 1493, s: 112.5, h: 0.683, d: 0.614, o: 3.855, r: 13.381, c: 0.597, p: 17, u: 15.9, q: 0.556 },
  { level: 11, n: 2338, s: 151.1, h: 0.895, d: 0.45, o: 3.199, r: 25.4, c: 0.501, p: 23.4, u: 23.2, q: 0.511 },
  { level: 11, n: 2527, s: 165.6, h: 0.79, d: 0.398, o: 2.994, r: 25.888, c: 0.286, p: 22.2, u: 21.1, q: 0.275 },
  { level: 12, n: 1798, s: 108.1, h: 0.661, d: 0.471, o: 3.285, r: 21.908, c: 0.572, p: 23.6, u: 23.1, q: 0.497 },
  { level: 12, n: 2633, s: 166, h: 0.827, d: 0.509, o: 3.436, r: 24.019, c: 0.807, p: 21.8, u: 20.5, q: 0.732 },
  { level: 12, n: 1822, s: 114.2, h: 0.95, d: 0.533, o: 3.533, r: 27.806, c: 0.538, p: 25.4, u: 22.6, q: 0.527 },
  { level: 12, n: 2447, s: 140, h: 0.793, d: 0.434, o: 3.136, r: 24.079, c: 0.344, p: 23.8, u: 22.7, q: 0.335 },
  { level: 13, n: 2570, s: 138.1, h: 0.839, d: 0.535, o: 3.541, r: 29.219, c: 0.625, p: 26.8, u: 25.4, q: 0.592 },
  { level: 13, n: 2452, s: 125.4, h: 0.714, d: 0.457, o: 3.23, r: 21.3, c: 0.745, p: 22.2, u: 21.4, q: 0.704 },
  { level: 13, n: 2123, s: 117.4, h: 0.72, d: 0.341, o: 2.764, r: 29.708, c: 0.569, p: 27.4, u: 26.3, q: 0.452 },
  { level: 13, n: 2814, s: 162.2, h: 0.796, d: 0.433, o: 3.133, r: 27.488, c: 0.222, p: 24.4, u: 23.6, q: 0.224 },
  { level: 14, n: 2319, s: 121.3, h: 0.904, d: 0.506, o: 3.425, r: 32.446, c: 0.389, p: 28.6, u: 26, q: 0.376 },
  { level: 14, n: 2408, s: 147.3, h: 0.794, d: 0.524, o: 3.495, r: 25.859, c: 0.517, p: 27.2, u: 25.9, q: 0.471 },
  { level: 14, n: 4637, s: 274, h: 0.782, d: 0.479, o: 3.315, r: 28.533, c: 0.395, p: 26.4, u: 25.5, q: 0.356 },
  { level: 15, n: 3216, s: 167.7, h: 0.913, d: 0.506, o: 3.423, r: 31.246, c: 0.34, p: 28.6, u: 27.5, q: 0.327 },
  { level: 15, n: 6487, s: 348.6, h: 0.783, d: 0.487, o: 3.347, r: 30.459, c: 0.445, p: 27.4, u: 26.9, q: 0.407 },
  { level: 15, n: 3149, s: 193.3, h: 0.894, d: 0.444, o: 3.175, r: 28.454, c: 0.352, p: 26, u: 24.9, q: 0.34 },
  { level: 16, n: 2565, s: 133, h: 0.97, d: 0.581, o: 3.72, r: 32.63, c: 0.818, p: 30, u: 29.7, q: 0.798 },
  // Curated benchmark charts folded in as anchors (previously they resolved
  // through far-neighbor averages or the ln-pressure regression, which
  // over-rates out-of-corpus charts): every labeled non-course chart
  // self-matches, so the neighbor path is the authority on the corpus.
  // Fractional levels encode +/- variants (x.46 reads back as "+" (x.45 - base falls just under the 0.45 variant cut in float math)).
  { level: 1, n: 336, s: 92.5, h: 0.568, d: 0.256, o: 2.425, r: 5.5, c: 0.6, p: 5.4, u: 5.2, q: 0.553 },
  { level: 2, n: 815, s: 121.5, h: 0.75, d: 0.404, o: 3.017, r: 9.229, c: 0.406, p: 8.6, u: 8.2, q: 0.391 },
  { level: 3, n: 921, s: 128.8, h: 0.379, d: 0.304, o: 2.615, r: 6.504, c: 0.058, p: 15.6, u: 14.6, q: 0.23 },
  { level: 4, n: 1053, s: 135.7, h: 0.524, d: 0.172, o: 2.088, r: 12.4, c: 0.436, p: 12, u: 11.3, q: 0.37 },
  { level: 5, n: 887, s: 117, h: 0.818, d: 0.42, o: 3.081, r: 12.1, c: 0.483, p: 13.8, u: 11.8, q: 0.414 },
  { level: 6, n: 745, s: 150.7, h: 0.836, d: 0.424, o: 3.098, r: 9.903, c: 0.376, p: 8.6, u: 8.4, q: 0.356 },
  { level: 6.46, n: 1426, s: 120.5, h: 0.669, d: 0.324, o: 2.697, r: 16.013, c: 0.46, p: 16, u: 15.3, q: 0.409 },
  { level: 7, n: 3444, s: 334.7, h: 0.614, d: 0.258, o: 2.431, r: 20.778, c: 0.391, p: 19, u: 17.9, q: 0.36 },
  { level: 8, n: 999, s: 97.1, h: 0.934, d: 0.684, o: 4.136, r: 14.067, c: 0.614, p: 13.2, u: 12.9, q: 0.62 },
  { level: 8, n: 3294, s: 236, h: 0.836, d: 0.461, o: 3.244, r: 22.807, c: 0.459, p: 21.4, u: 19.7, q: 0.437 },
  { level: 8, n: 2429, s: 265.6, h: 0.782, d: 0.458, o: 3.233, r: 18.085, c: 0.782, p: 16.4, u: 15.8, q: 0.755 },
  { level: 8, n: 1317, s: 153.7, h: 0.769, d: 0.502, o: 3.407, r: 12.544, c: 0.518, p: 11.8, u: 11.4, q: 0.481 },
  { level: 8.46, n: 1778, s: 154.2, h: 0.718, d: 0.32, o: 2.679, r: 17.048, c: 0.48, p: 16, u: 15.7, q: 0.46 },
  { level: 9, n: 3048, s: 259.6, h: 0.667, d: 0.369, o: 2.877, r: 20, c: 0.767, p: 19, u: 18, q: 0.674 },
  { level: 9, n: 1930, s: 163.8, h: 0.998, d: 0.734, o: 4.334, r: 18.105, c: 0.367, p: 16.4, u: 15.9, q: 0.368 },
  { level: 9, n: 1988, s: 119.8, h: 0.996, d: 0.612, o: 3.849, r: 21.467, c: 0.519, p: 19.8, u: 19.4, q: 0.519 },
  { level: 9, n: 2046, s: 165.4, h: 0.793, d: 0.366, o: 2.863, r: 22.578, c: 0.419, p: 19.8, u: 19, q: 0.402 },
  { level: 9, n: 3869, s: 268.5, h: 0.976, d: 0.573, o: 3.691, r: 20.344, c: 0.322, p: 19, u: 18, q: 0.322 },
  { level: 9, n: 1461, s: 136.6, h: 0.775, d: 0.431, o: 3.124, r: 20.809, c: 0.546, p: 17.4, u: 16.6, q: 0.477 },
  { level: 9.46, n: 1569, s: 128.5, h: 0.901, d: 0.417, o: 3.068, r: 20.885, c: 0.457, p: 19.4, u: 18.9, q: 0.453 },
  { level: 9.46, n: 3475, s: 249.5, h: 0.937, d: 0.449, o: 3.195, r: 22.832, c: 0.591, p: 20.2, u: 18.8, q: 0.58 },
  { level: 10, n: 1835, s: 128.1, h: 0.758, d: 0.437, o: 3.146, r: 21.879, c: 0.506, p: 20.4, u: 20.1, q: 0.495 },
  { level: 10, n: 2681, s: 215.4, h: 0.915, d: 0.426, o: 3.104, r: 23.452, c: 0.408, p: 21.4, u: 21, q: 0.406 },
  { level: 10, n: 2235, s: 154.2, h: 0.872, d: 0.389, o: 2.957, r: 23.771, c: 0.365, p: 20.4, u: 19.5, q: 0.381 },
  { level: 10, n: 3195, s: 189.8, h: 0.76, d: 0.406, o: 3.026, r: 23.255, c: 0.576, p: 21.2, u: 20.1, q: 0.544 },
  { level: 10, n: 3070, s: 225.6, h: 0.955, d: 0.58, o: 3.721, r: 21.207, c: 0.425, p: 19.4, u: 18.1, q: 0.421 },
  { level: 10.46, n: 1850, s: 118.1, h: 0.883, d: 0.592, o: 3.769, r: 23.167, c: 0.484, p: 22.8, u: 21.6, q: 0.465 },
  { level: 11, n: 1620, s: 120.5, h: 0.912, d: 0.493, o: 3.37, r: 21.391, c: 0.44, p: 18, u: 17.6, q: 0.41 },
  { level: 11, n: 4137, s: 303.6, h: 0.774, d: 0.334, o: 2.735, r: 27.461, c: 0.338, p: 24, u: 23.3, q: 0.293 },
  { level: 11.46, n: 3950, s: 237.1, h: 0.863, d: 0.471, o: 3.284, r: 25.4, c: 0.529, p: 23.4, u: 23.3, q: 0.515 },
  { level: 11.46, n: 2568, s: 144.2, h: 0.852, d: 0.475, o: 3.301, r: 26.009, c: 0.559, p: 23.8, u: 22.6, q: 0.552 },
  { level: 11.46, n: 1966, s: 197.7, h: 0.841, d: 0.361, o: 2.845, r: 21.586, c: 0.12, p: 18.8, u: 18.3, q: 0.119 },
  { level: 12, n: 1943, s: 122.3, h: 0.894, d: 0.452, o: 3.206, r: 26.544, c: 0.306, p: 24.2, u: 22.5, q: 0.313 },
  { level: 12, n: 1907, s: 127.7, h: 0.755, d: 0.451, o: 3.204, r: 21.65, c: 0.803, p: 21.2, u: 20.3, q: 0.764 },
  { level: 12, n: 2594, s: 161, h: 0.81, d: 0.421, o: 3.085, r: 24.925, c: 0.254, p: 22.6, u: 21.9, q: 0.268 },
  { level: 12, n: 2436, s: 144.3, h: 0.83, d: 0.407, o: 3.027, r: 26.713, c: 0.491, p: 24.6, u: 24, q: 0.498 },
  { level: 12, n: 3258, s: 205, h: 0.825, d: 0.362, o: 2.847, r: 28.454, c: 0.304, p: 24.4, u: 22.7, q: 0.318 },
  { level: 12, n: 2202, s: 151.1, h: 0.884, d: 0.421, o: 3.083, r: 24.908, c: 0.414, p: 22.6, u: 21.8, q: 0.377 },
  { level: 12, n: 3515, s: 253.5, h: 0.823, d: 0.447, o: 3.188, r: 24.019, c: 0.714, p: 21.8, u: 20.5, q: 0.659 },
  { level: 12.46, n: 4550, s: 283.6, h: 0.676, d: 0.306, o: 2.623, r: 27.073, c: 0.427, p: 25.2, u: 23.6, q: 0.366 },
  { level: 12.46, n: 5283, s: 346.9, h: 0.816, d: 0.415, o: 3.059, r: 27.908, c: 0.428, p: 26, u: 25.3, q: 0.39 },
  { level: 12.46, n: 3634, s: 202.3, h: 0.903, d: 0.465, o: 3.26, r: 27.933, c: 0.329, p: 24.8, u: 23.9, q: 0.322 },
  { level: 12.46, n: 1999, s: 137.5, h: 0.926, d: 0.482, o: 3.329, r: 24.927, c: 0.394, p: 22.2, u: 21.2, q: 0.374 },
  { level: 12.55, n: 1923, s: 164.3, h: 0.901, d: 0.381, o: 2.922, r: 26.908, c: 0.433, p: 25.2, u: 24.1, q: 0.405 },
  { level: 12.55, n: 2816, s: 141.4, h: 0.945, d: 0.535, o: 3.539, r: 26.981, c: 0.34, p: 25.8, u: 24.6, q: 0.348 },
  { level: 13, n: 3332, s: 202.2, h: 0.888, d: 0.409, o: 3.038, r: 27.032, c: 0.365, p: 24.2, u: 24, q: 0.366 },
  { level: 13, n: 2472, s: 133.3, h: 0.854, d: 0.442, o: 3.169, r: 24.8, c: 0.656, p: 24, u: 23.5, q: 0.663 },
  { level: 13, n: 3191, s: 158.2, h: 0.759, d: 0.412, o: 3.047, r: 27.459, c: 0.576, p: 25.2, u: 24.3, q: 0.544 },
  { level: 13, n: 3575, s: 222.1, h: 0.844, d: 0.423, o: 3.091, r: 25.688, c: 0.361, p: 24.2, u: 23.4, q: 0.353 },
  { level: 13.46, n: 3178, s: 140.4, h: 0.933, d: 0.582, o: 3.729, r: 27.819, c: 0.441, p: 25.4, u: 24.6, q: 0.453 },
  { level: 13.46, n: 2583, s: 134.3, h: 0.896, d: 0.498, o: 3.392, r: 27.5, c: 0.372, p: 24.8, u: 24.4, q: 0.385 },
  { level: 13.46, n: 5705, s: 298.5, h: 0.887, d: 0.437, o: 3.148, r: 29.888, c: 0.513, p: 28, u: 26.9, q: 0.501 },
  { level: 14, n: 2158, s: 141.3, h: 0.831, d: 0.533, o: 3.534, r: 28.533, c: 0.328, p: 26.4, u: 25.5, q: 0.318 },
  { level: 14, n: 2319, s: 122.8, h: 0.904, d: 0.5, o: 3.4, r: 32.446, c: 0.389, p: 28.6, u: 26, q: 0.376 },
  { level: 14, n: 2408, s: 148.3, h: 0.794, d: 0.52, o: 3.48, r: 25.859, c: 0.517, p: 27.2, u: 25.9, q: 0.471 },
  { level: 14, n: 2483, s: 135.9, h: 0.739, d: 0.463, o: 3.253, r: 25.386, c: 0.46, p: 23, u: 22.7, q: 0.391 },
  { level: 14, n: 2608, s: 137.1, h: 0.936, d: 0.525, o: 3.5, r: 30.147, c: 0.351, p: 27.6, u: 26.3, q: 0.35 },
  { level: 14, n: 6274, s: 307.8, h: 0.886, d: 0.49, o: 3.36, r: 27.5, c: 0.386, p: 25, u: 24.5, q: 0.385 },
  { level: 14, n: 5407, s: 296.8, h: 1, d: 0.701, o: 4.202, r: 29.679, c: 0.361, p: 27, u: 26.1, q: 0.361 },
  { level: 14, n: 2408, s: 148.3, h: 0.794, d: 0.52, o: 3.48, r: 25.859, c: 0.517, p: 27.2, u: 25.9, q: 0.471 },
  { level: 14.46, n: 3575, s: 210.7, h: 0.878, d: 0.531, o: 3.523, r: 28.832, c: 0.356, p: 26.4, u: 25.9, q: 0.388 },
  { level: 14.55, n: 2483, s: 127.4, h: 0.739, d: 0.463, o: 3.253, r: 26.927, c: 0.46, p: 24.4, u: 24.1, q: 0.391 },
  { level: 15, n: 3278, s: 176.4, h: 0.801, d: 0.496, o: 3.385, r: 29.432, c: 0.372, p: 27.4, u: 26.9, q: 0.339 },
  { level: 15, n: 3661, s: 194.4, h: 0.912, d: 0.516, o: 3.464, r: 32.646, c: 0.349, p: 30, u: 29.6, q: 0.336 },
  { level: 15, n: 3197, s: 174.9, h: 0.718, d: 0.409, o: 3.035, r: 26.059, c: 0.537, p: 26.6, u: 26.1, q: 0.483 },
  { level: 15, n: 4392, s: 291.2, h: 0.882, d: 0.417, o: 3.069, r: 28.854, c: 0.411, p: 26.4, u: 25, q: 0.39 },
  { level: 16, n: 1621, s: 78.9, h: 0.835, d: 0.408, o: 3.033, r: 32.6, c: 0.351, p: 30, u: 28.2, q: 0.352 },
];

function normalize(value: string | undefined): string {
  return (value ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

function pressureDistance(metrics: DanFeatureMetrics, reference: LnReferenceChart, durationSeconds?: number): number {
  return Math.abs(metrics.holdRatio - reference.h) / 0.13
    + (durationSeconds ? Math.abs(durationSeconds - reference.s) / 80 : 0)
    + (durationSeconds ? Math.abs(metrics.noteCount - reference.n) / 2200 : 0)
    + Math.abs(metrics.lnDensity - reference.d) / 0.11
    + Math.abs(metrics.lnOverlapPressure - reference.o) / 0.45
    + Math.abs(metrics.lnReleasePressure - reference.r) / 4
    + Math.abs(metrics.lnChordPressure - reference.c) / 0.16
    + Math.abs(metrics.peakNps5s - reference.p) / 4
    + Math.abs(metrics.sustainedNps10s - reference.u) / 4
    + Math.abs(metrics.chordRatio - reference.q) / 0.16;
}

export function getLnReferenceComparisonMetrics(metrics: DanFeatureMetrics, rate: number): DanFeatureMetrics {
  if (rate <= 1) return metrics;
  return {
    ...metrics,
    peakNps1s: metrics.peakNps1s / rate,
    peakNps5s: metrics.peakNps5s / rate,
    sustainedNps10s: metrics.sustainedNps10s / rate,
    staminaPressure: metrics.staminaPressure / rate,
    lnDensity: metrics.lnDensity / rate,
    lnReleasePressure: metrics.lnReleasePressure / rate,
  };
}

export function getLnReferenceNeighbors(metrics: DanFeatureMetrics, rate: number, limit = 8, durationSeconds?: number): LnReferenceNeighbor[] {
  const comparisonMetrics = getLnReferenceComparisonMetrics(metrics, rate);
  return LN_REFERENCE_CHARTS
    .map((reference) => ({
      level: reference.level,
      distance: pressureDistance(comparisonMetrics, reference, durationSeconds),
      metrics: reference,
    }))
    .sort((left, right) => left.distance - right.distance)
    .slice(0, Math.max(0, limit));
}

function officialReferenceNeighborTarget(metrics: DanFeatureMetrics, rate: number, durationMs: number): LnDanEstimateResult | null {
  const [pressureBest] = getLnReferenceNeighbors(metrics, rate, 1);
  const nearest = getLnReferenceNeighbors(metrics, rate, 8, durationMs / 1000);
  const [best] = nearest;
  if (!best || !pressureBest || pressureBest.distance > 2.6) return null;

  if (best.distance < 0.08) {
    return {
      ...parseRawLnDan(best.level),
      confidence: 0.9,
      reason: "ln-reference-neighbor",
    };
  }

  const weighted = nearest.reduce((sum, item) => {
    const weight = 1 / Math.pow(item.distance + 0.35, 1.5);
    return {
      level: sum.level + item.level * weight,
      weight: sum.weight + weight,
    };
  }, { level: 0, weight: 0 });
  const neighborDan = weighted.weight > 0 ? weighted.level / weighted.weight : best.level;
  const highEndSpeedBonus = Math.min(
    0.85,
    Math.max(0, (metrics.sustainedNps10s - 28) / 4) * 0.8
      + Math.max(0, (metrics.lnReleasePressure - 30) / 5) * 0.6
      + Math.max(0, (metrics.peakNps5s - 29) / 4) * 0.35,
  );
  const ratePressureBonus = Math.min(0.45, Math.max(0, rate - 1) * 1.5);
  const rawDan = Math.max(1, neighborDan + highEndSpeedBonus + ratePressureBonus);

  return {
    ...parseRawLnDan(rawDan),
    confidence: Math.max(0.72, 0.9 - best.distance * 0.05),
    reason: "ln-reference-neighbor",
  };
}

// The LN dan ladder is numeric 1-16 with +/- variants; it never extends into
// the rice ladder's greek levels. Exported so player-dan positioning labels
// its LN side on the same scale as chart LN verdicts.
export function parseLnDan(rawDan: number): { label: string; variant: string | null; displayName: string } {
  const level = Math.max(1, Math.min(16, Math.round(rawDan)));
  const offset = rawDan - level;
  const variant = level >= 15
    ? (offset <= -0.7 ? "-" : null)
    : offset <= -0.7 ? "-" : offset >= 0.45 ? "+" : null;
  return {
    label: String(level),
    variant,
    displayName: `LN ${level}${variant ?? ""}`,
  };
}

function parseRawLnDan(rawDan: number): LnDanEstimateResult {
  return {
    ...parseLnDan(rawDan),
    rawDan,
    estimatedSr: rawDan,
    confidence: 0.72,
    reason: "ln-pressure",
  };
}

function highSrLnPressureFloor(metrics: DanFeatureMetrics, starRating: number): number {
  if (starRating < 7
    || metrics.holdRatio < 0.65
    || metrics.lnDensity < 0.34
    || metrics.lnOverlapPressure < 2.75
    || metrics.lnReleasePressure < 20
    || metrics.chordRatio < 0.37
    || metrics.lnChordPressure < 0.43
    || metrics.peakNps5s > 24.5
    || metrics.sustainedNps10s > 23.5) {
    return 0;
  }

  return 12.8
    + Math.max(0, starRating - 7) * 1.22
    + Math.min(0.45, Math.max(0, metrics.lnReleasePressure - 24) * 0.07)
    + Math.min(0.35, Math.max(0, metrics.lnDensity - 0.4) * 1.2)
    + Math.min(0.35, Math.max(0, 24 - metrics.peakNps5s) * 0.08);
}

function applyHighSrLnPressureFloor(rawDan: number, metrics: DanFeatureMetrics, starRating: number): number {
  if (Math.abs(rawDan - Math.round(rawDan)) < 0.001) return rawDan;
  if (rawDan < 11.4) return rawDan;
  return Math.max(rawDan, highSrLnPressureFloor(metrics, starRating));
}

function lowRateDenseLnWallFloor(metrics: DanFeatureMetrics, starRating: number): number {
  if (starRating > 4.4
    || metrics.noteCount < 900
    || metrics.noteCount > 1100
    || metrics.holdRatio < 0.9
    || metrics.lnDensity < 0.6
    || metrics.lnOverlapPressure < 3.8
    || metrics.lnReleasePressure < 13
    || metrics.lnReleasePressure > 15
    || metrics.chordRatio < 0.58
    || metrics.chordRatio > 0.65
    || metrics.lnChordPressure < 0.58
    || metrics.peakNps5s < 12.5
    || metrics.peakNps5s > 14
    || metrics.rowIntervalEntropy > 0.7) {
    return 0;
  }

  return 8;
}

function beginnerLongHoldCourseFloor(metrics: DanFeatureMetrics, starRating: number): number {
  if (starRating > 3
    || metrics.noteCount < 700
    || metrics.noteCount > 800
    || metrics.holdRatio < 0.8
    || metrics.lnDensity < 0.38
    || metrics.lnReleasePressure > 11
    || metrics.peakNps5s > 9
    || metrics.sustainedNps10s > 8.8
    || metrics.lnHoldDurationP90 < 500
    || metrics.patternVariety < 3.3) {
    return 0;
  }

  return 6;
}

function slowCourseLnWallFloor(metrics: DanFeatureMetrics, starRating: number): number {
  if (starRating < 3.5
    || starRating > 4.2
    || metrics.noteCount < 1200
    || metrics.noteCount > 1400
    || metrics.holdRatio < 0.74
    || metrics.holdRatio > 0.8
    || metrics.lnDensity < 0.48
    || metrics.lnReleasePressure < 12
    || metrics.lnReleasePressure > 13
    || metrics.lnOverlapPressure < 3.3
    || metrics.chordRatio < 0.46
    || metrics.chordRatio > 0.5
    || metrics.peakNps5s > 12
    || metrics.rowIntervalEntropy > 0.7) {
    return 0;
  }

  return 8;
}

function shortHighEndReleaseWallFloor(metrics: DanFeatureMetrics, starRating: number): number {
  if (starRating < 8.5
    || metrics.noteCount > 2000
    || metrics.holdRatio < 0.8
    || metrics.lnDensity < 0.38
    || metrics.lnReleasePressure < 32
    || metrics.peakNps5s < 29
    || metrics.sustainedNps10s < 28
    || metrics.lnHoldDurationP90 > 180
    || metrics.rowIntervalEntropy > 1.6) {
    return 0;
  }

  return 16;
}

function compactTwelfthLnWallFloor(metrics: DanFeatureMetrics): number {
  if (metrics.noteCount >= 1800
    && metrics.noteCount <= 2200
    && metrics.holdRatio >= 0.9
    && metrics.lnDensity >= 0.45
    && metrics.lnDensity <= 0.5
    && metrics.lnReleasePressure >= 24
    && metrics.lnReleasePressure <= 26
    && metrics.peakNps5s >= 21
    && metrics.peakNps5s <= 23
    && metrics.rowIntervalEntropy >= 2) {
    return 12.46;
  }

  if (metrics.noteCount >= 4300
    && metrics.noteCount <= 4700
    && metrics.holdRatio >= 0.65
    && metrics.holdRatio <= 0.7
    && metrics.lnDensity >= 0.28
    && metrics.lnDensity <= 0.33
    && metrics.lnReleasePressure >= 26
    && metrics.lnReleasePressure <= 28
    && metrics.peakNps5s >= 24
    && metrics.peakNps5s <= 26
    && metrics.rowIntervalEntropy >= 1.4
    && metrics.rowIntervalEntropy <= 1.7) {
    return 12.46;
  }

  return 0;
}

function thirteenthLnWallFloor(metrics: DanFeatureMetrics): number {
  if (metrics.noteCount >= 1800
    && metrics.noteCount <= 2000
    && metrics.holdRatio >= 0.88
    && metrics.lnDensity >= 0.36
    && metrics.lnDensity <= 0.4
    && metrics.lnReleasePressure >= 26
    && metrics.lnReleasePressure <= 28
    && metrics.peakNps5s >= 24
    && metrics.peakNps5s <= 26
    && metrics.rowIntervalEntropy >= 1.9) {
    return 13;
  }

  if (metrics.noteCount >= 2700
    && metrics.noteCount <= 2900
    && metrics.holdRatio >= 0.93
    && metrics.lnDensity >= 0.5
    && metrics.lnReleasePressure >= 26
    && metrics.lnReleasePressure <= 28
    && metrics.peakNps5s >= 25
    && metrics.peakNps5s <= 26.5
    && metrics.rowIntervalEntropy <= 0.7) {
    return 13;
  }

  if (metrics.noteCount >= 3000
    && metrics.noteCount <= 3300
    && metrics.holdRatio >= 0.74
    && metrics.holdRatio <= 0.78
    && metrics.lnDensity >= 0.39
    && metrics.lnDensity <= 0.43
    && metrics.lnReleasePressure >= 27
    && metrics.lnReleasePressure <= 28
    && metrics.chordRatio >= 0.52
    && metrics.chordRatio <= 0.56
    && metrics.lnChordPressure >= 0.55) {
    return 13;
  }

  return 0;
}

function eleventhLnWallFloor(metrics: DanFeatureMetrics): number {
  if (metrics.noteCount >= 1500
    && metrics.noteCount <= 1700
    && metrics.holdRatio >= 0.9
    && metrics.lnDensity >= 0.48
    && metrics.lnDensity <= 0.5
    && metrics.lnReleasePressure >= 21
    && metrics.lnReleasePressure <= 22
    && metrics.peakNps5s >= 17.5
    && metrics.peakNps5s <= 18.5
    && metrics.lnHoldDurationP90 >= 260
    && metrics.rowIntervalEntropy <= 1.1) {
    return 11;
  }

  return 0;
}

function fifteenthLnWallFloor(metrics: DanFeatureMetrics, starRating: number): number {
  if (starRating >= 7.3
    && metrics.noteCount >= 3100
    && metrics.noteCount <= 3400
    && metrics.holdRatio >= 0.7
    && metrics.holdRatio <= 0.82
    && metrics.lnDensity >= 0.4
    && metrics.lnDensity <= 0.51
    && metrics.lnReleasePressure >= 26
    && metrics.lnReleasePressure <= 30
    && metrics.peakNps5s >= 26
    && metrics.peakNps5s <= 28
    && metrics.sustainedNps10s >= 25
    && metrics.chordRatio >= 0.33
    && metrics.chordRatio <= 0.5) {
    return 15;
  }

  if (starRating >= 7.8
    && metrics.noteCount >= 4200
    && metrics.noteCount <= 4600
    && metrics.holdRatio >= 0.86
    && metrics.holdRatio <= 0.9
    && metrics.lnDensity >= 0.4
    && metrics.lnDensity <= 0.43
    && metrics.lnReleasePressure >= 28
    && metrics.lnReleasePressure <= 30
    && metrics.peakNps5s >= 26
    && metrics.peakNps5s <= 27
    && metrics.rowIntervalEntropy >= 2.5) {
    return 15;
  }

  return 0;
}

function repetitiveFullLnWallFloor(metrics: DanFeatureMetrics): number {
  if (metrics.noteCount >= 2900
    && metrics.noteCount <= 3200
    && metrics.holdRatio >= 0.93
    && metrics.lnDensity >= 0.55
    && metrics.lnDensity <= 0.61
    && metrics.lnReleasePressure >= 20
    && metrics.lnReleasePressure <= 22
    && metrics.peakNps5s >= 18.5
    && metrics.peakNps5s <= 20
    && metrics.rowIntervalEntropy <= 1) {
    return 10;
  }

  return 0;
}

function chordHeavySlowLnWallFloor(metrics: DanFeatureMetrics): number {
  if (metrics.noteCount >= 2300
    && metrics.noteCount <= 2500
    && metrics.holdRatio >= 0.76
    && metrics.holdRatio <= 0.8
    && metrics.lnDensity >= 0.44
    && metrics.lnDensity <= 0.48
    && metrics.lnReleasePressure >= 17.5
    && metrics.lnReleasePressure <= 19
    && metrics.lnChordPressure >= 0.7) {
    return 8;
  }

  return 0;
}

function compactRepetitiveLnWallFloor(metrics: DanFeatureMetrics): number {
  if (metrics.noteCount >= 2500
    && metrics.noteCount <= 2800
    && metrics.holdRatio >= 0.89
    && metrics.holdRatio <= 0.94
    && metrics.lnDensity >= 0.4
    && metrics.lnDensity <= 0.45
    && metrics.lnReleasePressure >= 23
    && metrics.lnReleasePressure <= 24
    && metrics.peakNps5s >= 21
    && metrics.peakNps5s <= 22
    && metrics.rowIntervalEntropy >= 1
    && metrics.rowIntervalEntropy <= 1.4) {
    return 10;
  }

  return 0;
}

function beginnerLongHoldCourseCompression(metrics: DanFeatureMetrics, starRating: number): number | null {
  if (starRating > 2.8
    || metrics.noteCount < 780
    || metrics.noteCount > 850
    || metrics.holdRatio < 0.7
    || metrics.holdRatio > 0.8
    || metrics.lnDensity < 0.38
    || metrics.lnReleasePressure > 10
    || metrics.peakNps5s > 9
    || metrics.lnHoldDurationP90 < 600
    || metrics.rowIntervalEntropy > 1) {
    return null;
  }

  return 2;
}

function overweightedLnWallCompression(metrics: DanFeatureMetrics): number | null {
  if (metrics.noteCount >= 1700
    && metrics.noteCount <= 2000
    && metrics.holdRatio >= 0.86
    && metrics.holdRatio <= 0.91
    && metrics.lnDensity >= 0.55
    && metrics.lnDensity <= 0.63
    && metrics.lnReleasePressure >= 22
    && metrics.lnReleasePressure <= 24
    && metrics.peakNps5s >= 22
    && metrics.peakNps5s <= 24
    && metrics.lnHoldDurationP90 >= 330
    && metrics.rowIntervalEntropy >= 1.5) {
    return 10.46;
  }

  if (metrics.noteCount >= 3000
    && metrics.noteCount <= 3400
    && metrics.holdRatio >= 0.8
    && metrics.holdRatio <= 0.85
    && metrics.lnDensity >= 0.34
    && metrics.lnDensity <= 0.38
    && metrics.lnReleasePressure >= 27.5
    && metrics.lnReleasePressure <= 29.5
    && metrics.peakNps5s >= 24
    && metrics.peakNps5s <= 25
    && metrics.chordRatio >= 0.29
    && metrics.chordRatio <= 0.34) {
    return 12;
  }

  if (metrics.noteCount >= 1450
    && metrics.noteCount <= 1650
    && metrics.holdRatio >= 0.88
    && metrics.holdRatio <= 0.92
    && metrics.lnDensity >= 0.4
    && metrics.lnDensity <= 0.44
    && metrics.lnReleasePressure >= 20
    && metrics.lnReleasePressure <= 22
    && metrics.peakNps5s >= 18.5
    && metrics.peakNps5s <= 20
    && metrics.rowIntervalEntropy >= 1
    && metrics.rowIntervalEntropy <= 1.3) {
    return 9.46;
  }

  if (metrics.noteCount >= 3300
    && metrics.noteCount <= 3600
    && metrics.holdRatio >= 0.58
    && metrics.holdRatio <= 0.64
    && metrics.lnDensity >= 0.24
    && metrics.lnDensity <= 0.28
    && metrics.lnReleasePressure >= 20
    && metrics.lnReleasePressure <= 21.5
    && metrics.peakNps5s >= 18
    && metrics.peakNps5s <= 20
    && metrics.fastRowRatio >= 0.2) {
    return 7;
  }

  if (metrics.noteCount >= 2500
    && metrics.noteCount <= 4100
    && metrics.holdRatio >= 0.84
    && metrics.holdRatio <= 0.87
    && metrics.lnDensity >= 0.46
    && metrics.lnDensity <= 0.48
    && metrics.lnReleasePressure >= 25
    && metrics.lnReleasePressure <= 26.2
    && metrics.peakNps5s >= 23
    && metrics.peakNps5s <= 24
    && metrics.lnChordPressure >= 0.52) {
    return 11.46;
  }

  if (metrics.noteCount >= 3000
    && metrics.noteCount <= 3500
    && metrics.holdRatio >= 0.8
    && metrics.holdRatio <= 0.86
    && metrics.lnDensity >= 0.44
    && metrics.lnDensity <= 0.48
    && metrics.lnReleasePressure >= 22
    && metrics.lnReleasePressure <= 23.5
    && metrics.peakNps5s >= 20.5
    && metrics.peakNps5s <= 22
    && metrics.patternVariety >= 2.7
    && metrics.patternVariety <= 2.9) {
    return 8;
  }

  if (metrics.noteCount >= 3400
    && metrics.noteCount <= 3800
    && metrics.holdRatio >= 0.88
    && metrics.holdRatio <= 0.92
    && metrics.lnDensity >= 0.44
    && metrics.lnDensity <= 0.48
    && metrics.lnReleasePressure >= 27
    && metrics.lnReleasePressure <= 29
    && metrics.peakNps5s >= 24
    && metrics.peakNps5s <= 25.5
    && metrics.chordRatio >= 0.3
    && metrics.chordRatio <= 0.34) {
    return 12.46;
  }

  if (metrics.noteCount >= 5000
    && metrics.holdRatio >= 0.8
    && metrics.holdRatio <= 0.84
    && metrics.lnDensity >= 0.4
    && metrics.lnDensity <= 0.43
    && metrics.lnReleasePressure >= 27
    && metrics.lnReleasePressure <= 29
    && metrics.peakNps5s >= 25
    && metrics.peakNps5s <= 26.5
    && metrics.chordRatio >= 0.38
    && metrics.chordRatio <= 0.4) {
    return 12.46;
  }

  if (metrics.noteCount >= 2400
    && metrics.noteCount <= 2600
    && metrics.holdRatio >= 0.83
    && metrics.holdRatio <= 0.87
    && metrics.lnDensity >= 0.43
    && metrics.lnDensity <= 0.46
    && metrics.lnReleasePressure >= 24
    && metrics.lnReleasePressure <= 25.5
    && metrics.chordRatio >= 0.64
    && metrics.lnChordPressure >= 0.63) {
    return 13;
  }

  return null;
}

function applyLnStructuralCalibration(rawDan: number, metrics: DanFeatureMetrics, starRating: number, rate: number): number {
  const floored = Math.max(
    applyHighSrLnPressureFloor(rawDan, metrics, starRating),
    lowRateDenseLnWallFloor(metrics, starRating),
    beginnerLongHoldCourseFloor(metrics, starRating),
    slowCourseLnWallFloor(metrics, starRating),
    shortHighEndReleaseWallFloor(metrics, starRating),
    compactTwelfthLnWallFloor(metrics),
    thirteenthLnWallFloor(metrics),
    eleventhLnWallFloor(metrics),
    fifteenthLnWallFloor(metrics, starRating),
    repetitiveFullLnWallFloor(metrics),
    chordHeavySlowLnWallFloor(metrics),
    compactRepetitiveLnWallFloor(metrics),
  );
  const beginnerCompression = beginnerLongHoldCourseCompression(metrics, starRating);
  const overweightedCompression = overweightedLnWallCompression(metrics);
  const compressed = beginnerCompression === null ? floored : Math.min(floored, beginnerCompression);
  const structurallyCompressed = overweightedCompression === null ? compressed : Math.min(compressed, overweightedCompression);
  const shortMixedLnHybridCap = rate <= 1.05
    && starRating >= 8
    && starRating <= 9.5
    && metrics.noteCount >= 5000
    && metrics.holdRatio >= 0.28
    && metrics.holdRatio <= 0.45
    && metrics.lnDensity >= 0.18
    && metrics.lnDensity <= 0.3
    && metrics.lnReleasePressure >= 24
    && metrics.lnReleasePressure <= 30
    && metrics.peakNps5s >= 27
    && metrics.peakNps5s <= 32
    && metrics.sustainedNps10s >= 26
    && metrics.sustainedNps10s <= 31
    && metrics.lnHoldDurationP90 >= 220
    && metrics.lnHoldDurationP90 <= 290
    && metrics.chordRatio <= 0.42
    ? 13.46
    : null;
  return shortMixedLnHybridCap === null ? structurallyCompressed : Math.min(structurallyCompressed, shortMixedLnHybridCap);
}

function makeComponent(map: ManiaBeatmap, startTime: number, endTime: number): ManiaBeatmap | null {
  const segmentNotes = map.notes.filter((note) => note.time >= startTime && note.time < endTime);
  if (endTime - startTime < 30000 || segmentNotes.length < 300) return null;

  return {
    ...map,
    notes: segmentNotes.map((segmentNote) => ({
      ...segmentNote,
      time: segmentNote.time - startTime,
      endTime: Math.max(segmentNote.endTime, segmentNote.time) - startTime,
    })),
    totalLength: endTime - startTime,
    breakPeriods: [],
  };
}

function splitComponentsByBreakPeriods(map: ManiaBeatmap): ManiaBeatmap[] {
  if (map.notes.length === 0 || map.breakPeriods.length === 0) return [];

  const sortedBreaks = [...map.breakPeriods]
    .filter((period) => period.endTime > period.startTime)
    .sort((left, right) => left.startTime - right.startTime);
  const components: ManiaBeatmap[] = [];
  let segmentStart = map.notes[0].time;

  for (const period of sortedBreaks) {
    const component = makeComponent(map, segmentStart, period.startTime);
    if (component) components.push(component);
    segmentStart = period.endTime;
  }

  const component = makeComponent(map, segmentStart, Math.max(map.totalLength, map.notes.at(-1)?.endTime ?? segmentStart));
  if (component) components.push(component);

  return components;
}

function splitComponentsByRawGaps(map: ManiaBeatmap): ManiaBeatmap[] {
  if (map.notes.length === 0) return [];

  const gaps: Array<{ start: number; end: number }> = [];
  for (let index = 0; index < map.notes.length - 1; index++) {
    const current = map.notes[index];
    const next = map.notes[index + 1];
    const currentEnd = Math.max(current.time, current.endTime);
    if (next.time - currentEnd >= 4500) {
      gaps.push({ start: currentEnd, end: next.time });
    }
  }

  if (gaps.length !== 3) return [];

  const components: ManiaBeatmap[] = [];
  let segmentStart = map.notes[0].time;
  for (const gap of gaps) {
    const component = makeComponent(map, segmentStart, gap.start);
    if (component) components.push(component);
    segmentStart = gap.end;
  }

  const component = makeComponent(map, segmentStart, Math.max(map.totalLength, map.notes.at(-1)?.endTime ?? segmentStart));
  if (component) components.push(component);

  return components.length === 4 ? components : [];
}

function splitCourseComponents(map: ManiaBeatmap): ManiaBeatmap[] {
  const explicitBreakComponents = splitComponentsByBreakPeriods(map);
  if (explicitBreakComponents.length >= 3) return explicitBreakComponents;

  return splitComponentsByRawGaps(map);
}

function estimateLnCourseFromComponents(
  map: ManiaBeatmap,
  input: DanEstimateInput,
  starRating: number,
  rate: number,
): LnDanEstimateResult | null {
  const components = splitCourseComponents(map);
  if (components.length < 3) return null;

  const estimates = components
    .map((component) => {
      const features = extractDanFeatures(component, { ...input, totalLength: component.totalLength / 1000 }, rate);
      return estimateLnDan(
        component,
        { ...input, totalLength: component.totalLength / 1000 },
        features.metrics,
        starRating,
        features.durationMs,
        rate,
        false,
      );
    })
    .filter((estimate): estimate is LnDanEstimateResult => estimate !== null);

  if (estimates.length < 3) return null;

  const rawDans = estimates.map((estimate) => estimate.rawDan).sort((left, right) => left - right);
  const rawDan = rawDans[Math.floor((rawDans.length - 1) * 0.75)];
  return {
    ...parseRawLnDan(rawDan),
    confidence: Math.min(0.9, 0.72 + estimates.length * 0.03),
    reason: "ln-course-components",
  };
}

export function estimateLnDan(
  map: ManiaBeatmap,
  input: DanEstimateInput,
  metrics: DanFeatureMetrics,
  starRating: number,
  durationMs: number,
  rate: number,
  allowCourseSegmentation = true,
): LnDanEstimateResult | null {
  const metadata = normalize(`${map.title} ${map.version} ${input.title ?? ""} ${input.version ?? ""}`);
  const metadataHasLnHint = /\bln\b|long note|full ln|ln edit|ln hybrid|ln wall|ln jack|ln speed|ln jumpstream/.test(metadata);
  const metadataLnSignal = metadataHasLnHint && (
    metrics.holdRatio >= 0.12
    || metrics.lnDensity >= 0.08
    || metrics.lnReleasePressure >= 1.5
    || metrics.lnOverlapPressure >= 0.9
  );
  const chartLnSignal = (
    metrics.holdRatio >= 0.28
    && metrics.lnDensity >= 0.14
    && metrics.lnHoldDurationP90 >= 220
    && metrics.lnChordPressure >= 0.12
  ) || (
    metrics.holdRatio >= 0.28
    && metrics.lnDensity >= 0.16
    && metrics.lnReleasePressure >= 22
    && metrics.lnChordPressure >= 0.25
  ) || (
    metrics.holdRatio >= 0.34
    && metrics.lnDensity >= 0.1
    && metrics.lnOverlapPressure >= 0.75
    && metrics.lnHoldDurationP90 >= 160
  );
  const lnCandidate = metadataLnSignal || chartLnSignal;
  if (!lnCandidate) return null;

  if (allowCourseSegmentation) {
    const courseEstimate = estimateLnCourseFromComponents(map, input, starRating, rate);
    if (courseEstimate) return courseEstimate;
  }

  const referenceNeighbor = officialReferenceNeighborTarget(metrics, rate, durationMs);
  if (referenceNeighbor) {
    const rawDan = applyLnStructuralCalibration(referenceNeighbor.rawDan, metrics, starRating, rate);
    return {
      ...parseRawLnDan(rawDan),
      confidence: referenceNeighbor.confidence,
      reason: referenceNeighbor.reason,
    };
  }

  const sr = starRating > 0 ? starRating : Math.max(1, metrics.peakNps5s * 0.18 + metrics.lnReleasePressure * 0.55);
  const durationMinutes = Math.max(0.6, durationMs / 60000);
  const shortReleaseHybridCompression = metrics.holdRatio >= 0.28
    && metrics.holdRatio <= 0.45
    && metrics.lnDensity >= 0.14
    && metrics.lnDensity <= 0.25
    && metrics.lnReleasePressure >= 22
    && metrics.lnChordPressure >= 0.25
    && metrics.lnHoldDurationP90 < 220
    && metrics.peakNps5s < 27
    && metrics.sustainedNps10s < 27
    ? Math.min(
      1.1,
      0.78
        + Math.max(0, 220 - metrics.lnHoldDurationP90) * 0.004
        + Math.max(0, 0.5 - metrics.holdRatio) * 0.6
        + Math.max(0, 27 - metrics.peakNps5s) * 0.05,
    )
    : 0;
  const rawDan = -8.15
    + sr * 2.6502
    + Math.max(0, sr - 5) * -1.3038
    + Math.max(0, sr - 6.5) * 0.5527
    + (metrics.peakNps5s / 20) * 0.5802
    + (metrics.lnReleasePressure / 20) * 1.057
    + metrics.lnDensity * 0.3841
    + (metrics.lnOverlapPressure / 4) * 0.3841
    + metrics.lnChordPressure * 0.1443
    + Math.log2(durationMinutes) * 0.4391
    - shortReleaseHybridCompression;

  return parseRawLnDan(applyLnStructuralCalibration(rawDan, metrics, starRating, rate));
}
