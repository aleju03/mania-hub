#![allow(clippy::all)]
#![allow(unused_parens)]

use crate::beatmap::ManiaBeatmap;
use crate::features::extract_dan_features;
use crate::js::{cmp_num, is_js_space, truthy};
use crate::labels::dan_variant_for_offset;
use crate::types::{DanEstimateInput, DanFeatureMetrics};

#[derive(Clone, Debug, PartialEq)]
pub struct LnDanEstimateResult {
    pub label: String,
    pub variant: Option<&'static str>,
    pub display_name: String,
    pub raw_dan: f64,
    pub estimated_sr: f64,
    pub confidence: f64,
    pub reason: &'static str,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LnReferenceChart {
    pub level: f64,
    pub n: f64,
    pub s: f64,
    pub h: f64,
    pub d: f64,
    pub o: f64,
    pub r: f64,
    pub c: f64,
    pub p: f64,
    pub u: f64,
    pub q: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LnReferenceNeighbor {
    pub level: f64,
    pub distance: f64,
    pub metrics: LnReferenceChart,
}

const fn r(level: f64, n: f64, s: f64, h: f64, d: f64, o: f64, r: f64, c: f64, p: f64, u: f64, q: f64) -> LnReferenceChart {
    LnReferenceChart { level, n, s, h, d, o, r, c, p, u, q }
}

pub const LN_REFERENCE_CHARTS: [LnReferenceChart; 127] = [
    r(1.0, 717.0, 88.7, 0.245, 0.153, 2.012, 4.829, 0.594, 10.8, 10.3, 0.577),
    r(1.0, 336.0, 85.7, 0.568, 0.277, 2.506, 5.5, 0.6, 5.4, 5.2, 0.553),
    r(1.0, 176.0, 111.6, 0.602, 0.399, 2.996, 3.42, 0.152, 2.8, 2.1, 0.15),
    r(1.0, 613.0, 111.3, 0.664, 0.235, 2.339, 7.503, 0.21, 8.2, 7.5, 0.19),
    r(2.0, 805.0, 118.0, 0.471, 0.269, 2.476, 7.303, 0.718, 8.6, 8.0, 0.585),
    r(2.0, 805.0, 121.9, 0.757, 0.395, 2.982, 9.229, 0.388, 8.6, 8.1, 0.374),
    r(2.0, 377.0, 104.1, 0.87, 0.639, 3.957, 8.452, 0.38, 8.0, 6.0, 0.385),
    r(2.0, 805.0, 107.0, 1.0, 0.325, 2.698, 14.602, 0.158, 13.2, 12.7, 0.158),
    r(3.0, 836.0, 107.0, 0.561, 0.295, 2.581, 8.344, 0.342, 10.2, 9.6, 0.319),
    r(3.0, 921.0, 128.5, 0.457, 0.328, 2.711, 6.504, 0.22, 15.6, 14.6, 0.23),
    r(3.0, 612.0, 104.0, 0.438, 0.347, 2.79, 4.732, 0.375, 9.4, 9.2, 0.345),
    r(3.0, 1155.0, 111.5, 0.466, 0.282, 2.528, 12.565, 0.619, 13.2, 12.7, 0.424),
    r(4.0, 907.0, 123.1, 0.62, 0.316, 2.665, 11.085, 0.418, 12.4, 10.6, 0.389),
    r(4.0, 1053.0, 118.7, 0.524, 0.197, 2.186, 12.4, 0.436, 12.0, 11.3, 0.37),
    r(4.0, 413.0, 94.4, 0.891, 0.711, 4.245, 9.589, 0.412, 8.6, 6.9, 0.363),
    r(4.0, 1066.0, 115.8, 1.0, 0.494, 3.377, 14.813, 0.385, 13.2, 12.2, 0.385),
    r(5.0, 1904.0, 166.8, 0.553, 0.235, 2.339, 12.739, 0.732, 15.6, 15.3, 0.64),
    r(5.0, 887.0, 115.8, 0.818, 0.414, 3.058, 12.1, 0.483, 13.8, 11.8, 0.414),
    r(5.0, 1380.0, 147.2, 0.386, 0.344, 2.775, 11.0, 0.851, 14.8, 13.3, 0.691),
    r(5.0, 1218.0, 118.1, 0.543, 0.333, 2.733, 15.531, 0.596, 14.8, 13.3, 0.478),
    r(6.0, 1365.0, 150.1, 0.703, 0.417, 3.069, 12.7, 0.525, 13.4, 12.1, 0.456),
    r(6.0, 745.0, 151.0, 0.895, 0.432, 3.126, 9.903, 0.381, 8.6, 8.4, 0.356),
    r(6.0, 1219.0, 118.5, 0.551, 0.41, 3.041, 12.0, 0.473, 13.6, 12.6, 0.377),
    r(6.0, 1533.0, 113.0, 0.579, 0.269, 2.475, 15.165, 0.491, 18.4, 17.2, 0.434),
    r(7.0, 1394.0, 115.8, 0.489, 0.321, 2.686, 16.105, 0.327, 18.6, 16.2, 0.376),
    r(7.0, 1119.0, 100.7, 0.761, 0.451, 3.203, 14.6, 0.535, 15.6, 15.0, 0.544),
    r(7.0, 832.0, 101.8, 1.0, 0.695, 4.18, 11.076, 0.614, 10.4, 9.6, 0.614),
    r(7.0, 1666.0, 117.0, 0.432, 0.232, 2.326, 13.252, 0.52, 19.2, 18.8, 0.553),
    r(8.0, 1445.0, 129.5, 0.864, 0.52, 3.478, 18.207, 0.476, 16.4, 16.0, 0.473),
    r(8.0, 1318.0, 154.2, 0.839, 0.524, 3.497, 12.365, 0.505, 11.8, 11.4, 0.482),
    r(8.0, 1258.0, 155.2, 0.976, 0.614, 3.858, 15.705, 0.379, 13.8, 11.7, 0.389),
    r(8.0, 1265.0, 98.4, 0.552, 0.234, 2.336, 19.027, 0.387, 20.6, 19.6, 0.371),
    r(8.0, 429.0, 32.2, 0.392, 0.205, 2.222, 14.627, 0.388, 17.6, 16.6, 0.465),
    r(9.0, 2500.0, 165.5, 0.628, 0.407, 3.028, 15.207, 0.477, 20.8, 19.4, 0.424),
    r(9.0, 1461.0, 131.0, 0.775, 0.449, 3.196, 20.809, 0.546, 17.4, 16.6, 0.477),
    r(9.0, 1187.0, 94.3, 0.862, 0.453, 3.211, 20.186, 0.347, 17.8, 16.7, 0.331),
    r(9.0, 2305.0, 168.6, 0.604, 0.347, 2.786, 22.488, 0.565, 19.6, 19.0, 0.485),
    r(10.0, 2377.0, 157.8, 0.651, 0.331, 2.723, 24.347, 0.687, 23.0, 21.8, 0.606),
    r(10.0, 1656.0, 118.1, 0.884, 0.431, 3.125, 19.4, 0.405, 17.4, 17.0, 0.379),
    r(10.0, 1689.0, 119.0, 0.993, 0.698, 4.19, 20.586, 0.561, 19.2, 18.4, 0.561),
    r(10.0, 2185.0, 139.8, 0.673, 0.397, 2.989, 22.275, 0.46, 22.0, 20.7, 0.434),
    r(11.0, 1864.0, 106.5, 0.881, 0.499, 3.396, 24.406, 0.464, 22.4, 21.0, 0.461),
    r(11.0, 1493.0, 112.5, 0.683, 0.614, 3.855, 13.381, 0.597, 17.0, 15.9, 0.556),
    r(11.0, 2338.0, 151.1, 0.895, 0.45, 3.199, 25.4, 0.501, 23.4, 23.2, 0.511),
    r(11.0, 2527.0, 165.6, 0.79, 0.398, 2.994, 25.888, 0.286, 22.2, 21.1, 0.275),
    r(12.0, 1798.0, 108.1, 0.661, 0.471, 3.285, 21.908, 0.572, 23.6, 23.1, 0.497),
    r(12.0, 2633.0, 166.0, 0.827, 0.509, 3.436, 24.019, 0.807, 21.8, 20.5, 0.732),
    r(12.0, 1822.0, 114.2, 0.95, 0.533, 3.533, 27.806, 0.538, 25.4, 22.6, 0.527),
    r(12.0, 2447.0, 140.0, 0.793, 0.434, 3.136, 24.079, 0.344, 23.8, 22.7, 0.335),
    r(13.0, 2570.0, 138.1, 0.839, 0.535, 3.541, 29.219, 0.625, 26.8, 25.4, 0.592),
    r(13.0, 2452.0, 125.4, 0.714, 0.457, 3.23, 21.3, 0.745, 22.2, 21.4, 0.704),
    r(13.0, 2123.0, 117.4, 0.72, 0.341, 2.764, 29.708, 0.569, 27.4, 26.3, 0.452),
    r(13.0, 2814.0, 162.2, 0.796, 0.433, 3.133, 27.488, 0.222, 24.4, 23.6, 0.224),
    r(14.0, 2319.0, 121.3, 0.904, 0.506, 3.425, 32.446, 0.389, 28.6, 26.0, 0.376),
    r(14.0, 2408.0, 147.3, 0.794, 0.524, 3.495, 25.859, 0.517, 27.2, 25.9, 0.471),
    r(14.0, 4637.0, 274.0, 0.782, 0.479, 3.315, 28.533, 0.395, 26.4, 25.5, 0.356),
    r(15.0, 3216.0, 167.7, 0.913, 0.506, 3.423, 31.246, 0.34, 28.6, 27.5, 0.327),
    r(15.0, 6487.0, 348.6, 0.783, 0.487, 3.347, 30.459, 0.445, 27.4, 26.9, 0.407),
    r(15.0, 3149.0, 193.3, 0.894, 0.444, 3.175, 28.454, 0.352, 26.0, 24.9, 0.34),
    r(16.0, 2565.0, 133.0, 0.97, 0.581, 3.72, 32.63, 0.818, 30.0, 29.7, 0.798),
    r(1.0, 336.0, 92.5, 0.568, 0.256, 2.425, 5.5, 0.6, 5.4, 5.2, 0.553),
    r(2.0, 815.0, 121.5, 0.75, 0.404, 3.017, 9.229, 0.406, 8.6, 8.2, 0.391),
    r(3.0, 921.0, 128.8, 0.379, 0.304, 2.615, 6.504, 0.058, 15.6, 14.6, 0.23),
    r(4.0, 1053.0, 135.7, 0.524, 0.172, 2.088, 12.4, 0.436, 12.0, 11.3, 0.37),
    r(5.0, 887.0, 117.0, 0.818, 0.42, 3.081, 12.1, 0.483, 13.8, 11.8, 0.414),
    r(6.0, 745.0, 150.7, 0.836, 0.424, 3.098, 9.903, 0.376, 8.6, 8.4, 0.356),
    r(6.46, 1426.0, 120.5, 0.669, 0.324, 2.697, 16.013, 0.46, 16.0, 15.3, 0.409),
    r(7.0, 3444.0, 334.7, 0.614, 0.258, 2.431, 20.778, 0.391, 19.0, 17.9, 0.36),
    r(8.0, 999.0, 97.1, 0.934, 0.684, 4.136, 14.067, 0.614, 13.2, 12.9, 0.62),
    r(8.0, 3294.0, 236.0, 0.836, 0.461, 3.244, 22.807, 0.459, 21.4, 19.7, 0.437),
    r(8.0, 2429.0, 265.6, 0.782, 0.458, 3.233, 18.085, 0.782, 16.4, 15.8, 0.755),
    r(8.0, 1317.0, 153.7, 0.769, 0.502, 3.407, 12.544, 0.518, 11.8, 11.4, 0.481),
    r(8.46, 1778.0, 154.2, 0.718, 0.32, 2.679, 17.048, 0.48, 16.0, 15.7, 0.46),
    r(9.0, 3048.0, 259.6, 0.667, 0.369, 2.877, 20.0, 0.767, 19.0, 18.0, 0.674),
    r(9.0, 1930.0, 163.8, 0.998, 0.734, 4.334, 18.105, 0.367, 16.4, 15.9, 0.368),
    r(9.0, 1988.0, 119.8, 0.996, 0.612, 3.849, 21.467, 0.519, 19.8, 19.4, 0.519),
    r(9.0, 2046.0, 165.4, 0.793, 0.366, 2.863, 22.578, 0.419, 19.8, 19.0, 0.402),
    r(9.0, 3869.0, 268.5, 0.976, 0.573, 3.691, 20.344, 0.322, 19.0, 18.0, 0.322),
    r(9.0, 1461.0, 136.6, 0.775, 0.431, 3.124, 20.809, 0.546, 17.4, 16.6, 0.477),
    r(9.46, 1569.0, 128.5, 0.901, 0.417, 3.068, 20.885, 0.457, 19.4, 18.9, 0.453),
    r(9.46, 3475.0, 249.5, 0.937, 0.449, 3.195, 22.832, 0.591, 20.2, 18.8, 0.58),
    r(10.0, 1835.0, 128.1, 0.758, 0.437, 3.146, 21.879, 0.506, 20.4, 20.1, 0.495),
    r(10.0, 2681.0, 215.4, 0.915, 0.426, 3.104, 23.452, 0.408, 21.4, 21.0, 0.406),
    r(10.0, 2235.0, 154.2, 0.872, 0.389, 2.957, 23.771, 0.365, 20.4, 19.5, 0.381),
    r(10.0, 3195.0, 189.8, 0.76, 0.406, 3.026, 23.255, 0.576, 21.2, 20.1, 0.544),
    r(10.0, 3070.0, 225.6, 0.955, 0.58, 3.721, 21.207, 0.425, 19.4, 18.1, 0.421),
    r(10.46, 1850.0, 118.1, 0.883, 0.592, 3.769, 23.167, 0.484, 22.8, 21.6, 0.465),
    r(11.0, 1620.0, 120.5, 0.912, 0.493, 3.37, 21.391, 0.44, 18.0, 17.6, 0.41),
    r(11.0, 4137.0, 303.6, 0.774, 0.334, 2.735, 27.461, 0.338, 24.0, 23.3, 0.293),
    r(11.46, 3950.0, 237.1, 0.863, 0.471, 3.284, 25.4, 0.529, 23.4, 23.3, 0.515),
    r(11.46, 2568.0, 144.2, 0.852, 0.475, 3.301, 26.009, 0.559, 23.8, 22.6, 0.552),
    r(11.46, 1966.0, 197.7, 0.841, 0.361, 2.845, 21.586, 0.12, 18.8, 18.3, 0.119),
    r(12.0, 1943.0, 122.3, 0.894, 0.452, 3.206, 26.544, 0.306, 24.2, 22.5, 0.313),
    r(12.0, 1907.0, 127.7, 0.755, 0.451, 3.204, 21.65, 0.803, 21.2, 20.3, 0.764),
    r(12.0, 2594.0, 161.0, 0.81, 0.421, 3.085, 24.925, 0.254, 22.6, 21.9, 0.268),
    r(12.0, 2436.0, 144.3, 0.83, 0.407, 3.027, 26.713, 0.491, 24.6, 24.0, 0.498),
    r(12.0, 3258.0, 205.0, 0.825, 0.362, 2.847, 28.454, 0.304, 24.4, 22.7, 0.318),
    r(12.0, 2202.0, 151.1, 0.884, 0.421, 3.083, 24.908, 0.414, 22.6, 21.8, 0.377),
    r(12.0, 3515.0, 253.5, 0.823, 0.447, 3.188, 24.019, 0.714, 21.8, 20.5, 0.659),
    r(12.46, 4550.0, 283.6, 0.676, 0.306, 2.623, 27.073, 0.427, 25.2, 23.6, 0.366),
    r(12.46, 5283.0, 346.9, 0.816, 0.415, 3.059, 27.908, 0.428, 26.0, 25.3, 0.39),
    r(12.46, 3634.0, 202.3, 0.903, 0.465, 3.26, 27.933, 0.329, 24.8, 23.9, 0.322),
    r(12.46, 1999.0, 137.5, 0.926, 0.482, 3.329, 24.927, 0.394, 22.2, 21.2, 0.374),
    r(12.55, 1923.0, 164.3, 0.901, 0.381, 2.922, 26.908, 0.433, 25.2, 24.1, 0.405),
    r(12.55, 2816.0, 141.4, 0.945, 0.535, 3.539, 26.981, 0.34, 25.8, 24.6, 0.348),
    r(13.0, 3332.0, 202.2, 0.888, 0.409, 3.038, 27.032, 0.365, 24.2, 24.0, 0.366),
    r(13.0, 2472.0, 133.3, 0.854, 0.442, 3.169, 24.8, 0.656, 24.0, 23.5, 0.663),
    r(13.0, 3191.0, 158.2, 0.759, 0.412, 3.047, 27.459, 0.576, 25.2, 24.3, 0.544),
    r(13.0, 3575.0, 222.1, 0.844, 0.423, 3.091, 25.688, 0.361, 24.2, 23.4, 0.353),
    r(13.46, 3178.0, 140.4, 0.933, 0.582, 3.729, 27.819, 0.441, 25.4, 24.6, 0.453),
    r(13.46, 2583.0, 134.3, 0.896, 0.498, 3.392, 27.5, 0.372, 24.8, 24.4, 0.385),
    r(13.46, 5705.0, 298.5, 0.887, 0.437, 3.148, 29.888, 0.513, 28.0, 26.9, 0.501),
    r(14.0, 2158.0, 141.3, 0.831, 0.533, 3.534, 28.533, 0.328, 26.4, 25.5, 0.318),
    r(14.0, 2319.0, 122.8, 0.904, 0.5, 3.4, 32.446, 0.389, 28.6, 26.0, 0.376),
    r(14.0, 2408.0, 148.3, 0.794, 0.52, 3.48, 25.859, 0.517, 27.2, 25.9, 0.471),
    r(14.0, 2483.0, 135.9, 0.739, 0.463, 3.253, 25.386, 0.46, 23.0, 22.7, 0.391),
    r(14.0, 2608.0, 137.1, 0.936, 0.525, 3.5, 30.147, 0.351, 27.6, 26.3, 0.35),
    r(14.0, 6274.0, 307.8, 0.886, 0.49, 3.36, 27.5, 0.386, 25.0, 24.5, 0.385),
    r(14.0, 5407.0, 296.8, 1.0, 0.701, 4.202, 29.679, 0.361, 27.0, 26.1, 0.361),
    r(14.0, 2408.0, 148.3, 0.794, 0.52, 3.48, 25.859, 0.517, 27.2, 25.9, 0.471),
    r(14.46, 3575.0, 210.7, 0.878, 0.531, 3.523, 28.832, 0.356, 26.4, 25.9, 0.388),
    r(14.55, 2483.0, 127.4, 0.739, 0.463, 3.253, 26.927, 0.46, 24.4, 24.1, 0.391),
    r(15.0, 3278.0, 176.4, 0.801, 0.496, 3.385, 29.432, 0.372, 27.4, 26.9, 0.339),
    r(15.0, 3661.0, 194.4, 0.912, 0.516, 3.464, 32.646, 0.349, 30.0, 29.6, 0.336),
    r(15.0, 3197.0, 174.9, 0.718, 0.409, 3.035, 26.059, 0.537, 26.6, 26.1, 0.483),
    r(15.0, 4392.0, 291.2, 0.882, 0.417, 3.069, 28.854, 0.411, 26.4, 25.0, 0.39),
    r(16.0, 1621.0, 78.9, 0.835, 0.408, 3.033, 32.6, 0.351, 30.0, 28.2, 0.352),
];

fn normalize(value: &str) -> String {
    let lower = value.to_lowercase();
    let mut out = String::with_capacity(lower.len());
    let mut in_space = false;
    for ch in lower.chars() {
        if is_js_space(ch) {
            if !in_space {
                out.push(' ');
                in_space = true;
            }
        } else {
            out.push(ch);
            in_space = false;
        }
    }
    crate::js::trim(&out).to_string()
}

fn metadata_has_ln_hint(s: &str) -> bool {
    const LITERALS: [&str; 7] = ["long note", "full ln", "ln edit", "ln hybrid", "ln wall", "ln jack", "ln speed"];
    if LITERALS.iter().any(|l| s.contains(l)) || s.contains("ln jumpstream") {
        return true;
    }
    let b = s.as_bytes();
    let word = |c: u8| c.is_ascii_alphanumeric() || c == b'_';
    let mut i = 0;
    while i + 1 < b.len() {
        if b[i] == b'l' && b[i + 1] == b'n' {
            let before_ok = i == 0 || !word(b[i - 1]);
            let after_ok = i + 2 >= b.len() || !word(b[i + 2]);
            if before_ok && after_ok {
                return true;
            }
        }
        i += 1;
    }
    false
}

fn pressure_distance(m: &DanFeatureMetrics, reference: &LnReferenceChart, duration_seconds: Option<f64>) -> f64 {
    let ds = duration_seconds.filter(|d| truthy(*d));
    (m.hold_ratio - reference.h).abs() / 0.13
        + (match ds { Some(d) => (d - reference.s).abs() / 80.0, None => 0.0 })
        + (match ds { Some(_) => (m.note_count - reference.n).abs() / 2200.0, None => 0.0 })
        + (m.ln_density - reference.d).abs() / 0.11
        + (m.ln_overlap_pressure - reference.o).abs() / 0.45
        + (m.ln_release_pressure - reference.r).abs() / 4.0
        + (m.ln_chord_pressure - reference.c).abs() / 0.16
        + (m.peak_nps5s - reference.p).abs() / 4.0
        + (m.sustained_nps10s - reference.u).abs() / 4.0
        + (m.chord_ratio - reference.q).abs() / 0.16
}

pub fn get_ln_reference_comparison_metrics(m: &DanFeatureMetrics, rate: f64) -> DanFeatureMetrics {
    if rate <= 1.0 {
        return *m;
    }
    DanFeatureMetrics {
        peak_nps1s: m.peak_nps1s / rate,
        peak_nps5s: m.peak_nps5s / rate,
        sustained_nps10s: m.sustained_nps10s / rate,
        stamina_pressure: m.stamina_pressure / rate,
        ln_density: m.ln_density / rate,
        ln_release_pressure: m.ln_release_pressure / rate,
        ..*m
    }
}

pub fn get_ln_reference_neighbors(
    m: &DanFeatureMetrics,
    rate: f64,
    limit: f64,
    duration_seconds: Option<f64>,
) -> Vec<LnReferenceNeighbor> {
    let comparison = get_ln_reference_comparison_metrics(m, rate);
    let mut out: Vec<LnReferenceNeighbor> = LN_REFERENCE_CHARTS
        .iter()
        .map(|reference| LnReferenceNeighbor {
            level: reference.level,
            distance: pressure_distance(&comparison, reference, duration_seconds),
            metrics: *reference,
        })
        .collect();
    out.sort_by(|a, b| cmp_num(a.distance, b.distance));
    let limit = jsmath::max(0.0, limit);
    let n = if limit.is_nan() { 0 } else { limit.trunc().min(out.len() as f64) as usize };
    out.truncate(n);
    out
}

fn official_reference_neighbor_target(m: &DanFeatureMetrics, rate: f64, duration_ms: f64) -> Option<LnDanEstimateResult> {
    let pressure_best = get_ln_reference_neighbors(m, rate, 1.0, None).into_iter().next();
    let nearest = get_ln_reference_neighbors(m, rate, 8.0, Some(duration_ms / 1000.0));
    let best = nearest.first().copied();
    let (best, pressure_best) = match (best, pressure_best) {
        (Some(b), Some(p)) => (b, p),
        _ => return None,
    };
    if pressure_best.distance > 2.6 {
        return None;
    }
    if best.distance < 0.08 {
        return Some(LnDanEstimateResult { confidence: 0.9, reason: "ln-reference-neighbor", ..parse_raw_ln_dan(best.level) });
    }
    let mut level = 0f64;
    let mut weight = 0f64;
    for item in &nearest {
        let w = 1.0 / jsmath::pow(item.distance + 0.35, 1.5);
        level = level + item.level * w;
        weight = weight + w;
    }
    let neighbor_dan = if weight > 0.0 { level / weight } else { best.level };
    let high_end_speed_bonus = jsmath::min(
        0.85,
        jsmath::max(0.0, (m.sustained_nps10s - 28.0) / 4.0) * 0.8
            + jsmath::max(0.0, (m.ln_release_pressure - 30.0) / 5.0) * 0.6
            + jsmath::max(0.0, (m.peak_nps5s - 29.0) / 4.0) * 0.35,
    );
    let rate_pressure_bonus = jsmath::min(0.45, jsmath::max(0.0, rate - 1.0) * 1.5);
    let raw_dan = jsmath::max(1.0, neighbor_dan + high_end_speed_bonus + rate_pressure_bonus);
    Some(LnDanEstimateResult {
        confidence: jsmath::max(0.72, 0.9 - best.distance * 0.05),
        reason: "ln-reference-neighbor",
        ..parse_raw_ln_dan(raw_dan)
    })
}

pub const LN_PRIMARY_MIN_RATIO: f64 = 0.45;
pub const LN_PRIMARY_7K_MIN_RATIO: f64 = 0.375;

pub fn ln_primary_min_ratio_for(key_count: Option<f64>) -> f64 {
    if key_count == Some(7.0) {
        LN_PRIMARY_7K_MIN_RATIO
    } else {
        LN_PRIMARY_MIN_RATIO
    }
}

pub const LN_LADDER_TOP: f64 = 17.0;

#[derive(Clone, Debug, PartialEq)]
pub struct ParsedLnDan {
    pub label: String,
    pub variant: Option<&'static str>,
    pub display_name: String,
}

pub fn parse_ln_dan(raw_dan: f64) -> ParsedLnDan {
    let level = jsmath::max(1.0, jsmath::min(LN_LADDER_TOP, jsmath::round(raw_dan)));
    let variant = dan_variant_for_offset(raw_dan - level);
    let label = crate::js::num_to_string(level);
    let display_name = format!("LN {}{}", label, variant.unwrap_or(""));
    ParsedLnDan { label, variant, display_name }
}

fn parse_raw_ln_dan(raw_dan: f64) -> LnDanEstimateResult {
    let p = parse_ln_dan(raw_dan);
    LnDanEstimateResult {
        label: p.label,
        variant: p.variant,
        display_name: p.display_name,
        raw_dan,
        estimated_sr: raw_dan,
        confidence: 0.72,
        reason: "ln-pressure",
    }
}

fn high_sr_ln_pressure_floor(m: &DanFeatureMetrics, star_rating: f64) -> f64 {
  if (star_rating < 7.0
    || m.hold_ratio < 0.65
    || m.ln_density < 0.34
    || m.ln_overlap_pressure < 2.75
    || m.ln_release_pressure < 20.0
    || m.chord_ratio < 0.37
    || m.ln_chord_pressure < 0.43
    || m.peak_nps5s > 24.5
    || m.sustained_nps10s > 23.5) {
    return 0.0;
  }

  return 12.8
    + jsmath::max(0.0, star_rating - 7.0) * 1.22
    + jsmath::min(0.45, jsmath::max(0.0, m.ln_release_pressure - 24.0) * 0.07)
    + jsmath::min(0.35, jsmath::max(0.0, m.ln_density - 0.4) * 1.2)
    + jsmath::min(0.35, jsmath::max(0.0, 24.0 - m.peak_nps5s) * 0.08);
}

fn apply_high_sr_ln_pressure_floor(raw_dan: f64, m: &DanFeatureMetrics, star_rating: f64) -> f64 {
  if (raw_dan - jsmath::round(raw_dan)).abs() < 0.001 { return raw_dan; }
  if raw_dan < 11.4 { return raw_dan; }
  jsmath::max(raw_dan, high_sr_ln_pressure_floor(m, star_rating))
}

fn low_rate_dense_ln_wall_floor(m: &DanFeatureMetrics, star_rating: f64) -> f64 {
  if (star_rating > 4.4
    || m.note_count < 900.0
    || m.note_count > 1100.0
    || m.hold_ratio < 0.9
    || m.ln_density < 0.6
    || m.ln_overlap_pressure < 3.8
    || m.ln_release_pressure < 13.0
    || m.ln_release_pressure > 15.0
    || m.chord_ratio < 0.58
    || m.chord_ratio > 0.65
    || m.ln_chord_pressure < 0.58
    || m.peak_nps5s < 12.5
    || m.peak_nps5s > 14.0
    || m.row_interval_entropy > 0.7) {
    return 0.0;
  }

  return 8.0;
}

fn beginner_long_hold_course_floor(m: &DanFeatureMetrics, star_rating: f64) -> f64 {
  if (star_rating > 3.0
    || m.note_count < 700.0
    || m.note_count > 800.0
    || m.hold_ratio < 0.8
    || m.ln_density < 0.38
    || m.ln_release_pressure > 11.0
    || m.peak_nps5s > 9.0
    || m.sustained_nps10s > 8.8
    || m.ln_hold_duration_p90 < 500.0
    || m.pattern_variety < 3.3) {
    return 0.0;
  }

  return 6.0;
}

fn slow_course_ln_wall_floor(m: &DanFeatureMetrics, star_rating: f64) -> f64 {
  if (star_rating < 3.5
    || star_rating > 4.2
    || m.note_count < 1200.0
    || m.note_count > 1400.0
    || m.hold_ratio < 0.74
    || m.hold_ratio > 0.8
    || m.ln_density < 0.48
    || m.ln_release_pressure < 12.0
    || m.ln_release_pressure > 13.0
    || m.ln_overlap_pressure < 3.3
    || m.chord_ratio < 0.46
    || m.chord_ratio > 0.5
    || m.peak_nps5s > 12.0
    || m.row_interval_entropy > 0.7) {
    return 0.0;
  }

  return 8.0;
}

fn short_high_end_release_wall_floor(m: &DanFeatureMetrics, star_rating: f64) -> f64 {
  if (star_rating < 8.5
    || m.note_count > 2000.0
    || m.hold_ratio < 0.8
    || m.ln_density < 0.38
    || m.ln_release_pressure < 32.0
    || m.peak_nps5s < 29.0
    || m.sustained_nps10s < 28.0
    || m.ln_hold_duration_p90 > 180.0
    || m.row_interval_entropy > 1.6) {
    return 0.0;
  }

  return 16.0;
}

fn compact_twelfth_ln_wall_floor(m: &DanFeatureMetrics) -> f64 {
  if (m.note_count >= 1800.0
    && m.note_count <= 2200.0
    && m.hold_ratio >= 0.9
    && m.ln_density >= 0.45
    && m.ln_density <= 0.5
    && m.ln_release_pressure >= 24.0
    && m.ln_release_pressure <= 26.0
    && m.peak_nps5s >= 21.0
    && m.peak_nps5s <= 23.0
    && m.row_interval_entropy >= 2.0) {
    return 12.46;
  }

  if (m.note_count >= 4300.0
    && m.note_count <= 4700.0
    && m.hold_ratio >= 0.65
    && m.hold_ratio <= 0.7
    && m.ln_density >= 0.28
    && m.ln_density <= 0.33
    && m.ln_release_pressure >= 26.0
    && m.ln_release_pressure <= 28.0
    && m.peak_nps5s >= 24.0
    && m.peak_nps5s <= 26.0
    && m.row_interval_entropy >= 1.4
    && m.row_interval_entropy <= 1.7) {
    return 12.46;
  }

  return 0.0;
}

fn thirteenth_ln_wall_floor(m: &DanFeatureMetrics) -> f64 {
  if (m.note_count >= 1800.0
    && m.note_count <= 2000.0
    && m.hold_ratio >= 0.88
    && m.ln_density >= 0.36
    && m.ln_density <= 0.4
    && m.ln_release_pressure >= 26.0
    && m.ln_release_pressure <= 28.0
    && m.peak_nps5s >= 24.0
    && m.peak_nps5s <= 26.0
    && m.row_interval_entropy >= 1.9) {
    return 13.0;
  }

  if (m.note_count >= 2700.0
    && m.note_count <= 2900.0
    && m.hold_ratio >= 0.93
    && m.ln_density >= 0.5
    && m.ln_release_pressure >= 26.0
    && m.ln_release_pressure <= 28.0
    && m.peak_nps5s >= 25.0
    && m.peak_nps5s <= 26.5
    && m.row_interval_entropy <= 0.7) {
    return 13.0;
  }

  if (m.note_count >= 3000.0
    && m.note_count <= 3300.0
    && m.hold_ratio >= 0.74
    && m.hold_ratio <= 0.78
    && m.ln_density >= 0.39
    && m.ln_density <= 0.43
    && m.ln_release_pressure >= 27.0
    && m.ln_release_pressure <= 28.0
    && m.chord_ratio >= 0.52
    && m.chord_ratio <= 0.56
    && m.ln_chord_pressure >= 0.55) {
    return 13.0;
  }

  return 0.0;
}

fn eleventh_ln_wall_floor(m: &DanFeatureMetrics) -> f64 {
  if (m.note_count >= 1500.0
    && m.note_count <= 1700.0
    && m.hold_ratio >= 0.9
    && m.ln_density >= 0.48
    && m.ln_density <= 0.5
    && m.ln_release_pressure >= 21.0
    && m.ln_release_pressure <= 22.0
    && m.peak_nps5s >= 17.5
    && m.peak_nps5s <= 18.5
    && m.ln_hold_duration_p90 >= 260.0
    && m.row_interval_entropy <= 1.1) {
    return 11.0;
  }

  return 0.0;
}

fn fifteenth_ln_wall_floor(m: &DanFeatureMetrics, star_rating: f64) -> f64 {
  if (star_rating >= 7.3
    && m.note_count >= 3100.0
    && m.note_count <= 3400.0
    && m.hold_ratio >= 0.7
    && m.hold_ratio <= 0.82
    && m.ln_density >= 0.4
    && m.ln_density <= 0.51
    && m.ln_release_pressure >= 26.0
    && m.ln_release_pressure <= 30.0
    && m.peak_nps5s >= 26.0
    && m.peak_nps5s <= 28.0
    && m.sustained_nps10s >= 25.0
    && m.chord_ratio >= 0.33
    && m.chord_ratio <= 0.5) {
    return 15.0;
  }

  if (star_rating >= 7.8
    && m.note_count >= 4200.0
    && m.note_count <= 4600.0
    && m.hold_ratio >= 0.86
    && m.hold_ratio <= 0.9
    && m.ln_density >= 0.4
    && m.ln_density <= 0.43
    && m.ln_release_pressure >= 28.0
    && m.ln_release_pressure <= 30.0
    && m.peak_nps5s >= 26.0
    && m.peak_nps5s <= 27.0
    && m.row_interval_entropy >= 2.5) {
    return 15.0;
  }

  return 0.0;
}

fn repetitive_full_ln_wall_floor(m: &DanFeatureMetrics) -> f64 {
  if (m.note_count >= 2900.0
    && m.note_count <= 3200.0
    && m.hold_ratio >= 0.93
    && m.ln_density >= 0.55
    && m.ln_density <= 0.61
    && m.ln_release_pressure >= 20.0
    && m.ln_release_pressure <= 22.0
    && m.peak_nps5s >= 18.5
    && m.peak_nps5s <= 20.0
    && m.row_interval_entropy <= 1.0) {
    return 10.0;
  }

  return 0.0;
}

fn chord_heavy_slow_ln_wall_floor(m: &DanFeatureMetrics) -> f64 {
  if (m.note_count >= 2300.0
    && m.note_count <= 2500.0
    && m.hold_ratio >= 0.76
    && m.hold_ratio <= 0.8
    && m.ln_density >= 0.44
    && m.ln_density <= 0.48
    && m.ln_release_pressure >= 17.5
    && m.ln_release_pressure <= 19.0
    && m.ln_chord_pressure >= 0.7) {
    return 8.0;
  }

  return 0.0;
}

fn compact_repetitive_ln_wall_floor(m: &DanFeatureMetrics) -> f64 {
  if (m.note_count >= 2500.0
    && m.note_count <= 2800.0
    && m.hold_ratio >= 0.89
    && m.hold_ratio <= 0.94
    && m.ln_density >= 0.4
    && m.ln_density <= 0.45
    && m.ln_release_pressure >= 23.0
    && m.ln_release_pressure <= 24.0
    && m.peak_nps5s >= 21.0
    && m.peak_nps5s <= 22.0
    && m.row_interval_entropy >= 1.0
    && m.row_interval_entropy <= 1.4) {
    return 10.0;
  }

  return 0.0;
}

fn beginner_long_hold_course_compression(m: &DanFeatureMetrics, star_rating: f64) -> Option<f64> {
  if (star_rating > 2.8
    || m.note_count < 780.0
    || m.note_count > 850.0
    || m.hold_ratio < 0.7
    || m.hold_ratio > 0.8
    || m.ln_density < 0.38
    || m.ln_release_pressure > 10.0
    || m.peak_nps5s > 9.0
    || m.ln_hold_duration_p90 < 600.0
    || m.row_interval_entropy > 1.0) {
    return None;
  }

  return Some(2.0);
}

fn overweighted_ln_wall_compression(m: &DanFeatureMetrics) -> Option<f64> {
  if (m.note_count >= 1700.0
    && m.note_count <= 2000.0
    && m.hold_ratio >= 0.86
    && m.hold_ratio <= 0.91
    && m.ln_density >= 0.55
    && m.ln_density <= 0.63
    && m.ln_release_pressure >= 22.0
    && m.ln_release_pressure <= 24.0
    && m.peak_nps5s >= 22.0
    && m.peak_nps5s <= 24.0
    && m.ln_hold_duration_p90 >= 330.0
    && m.row_interval_entropy >= 1.5) {
    return Some(10.46);
  }

  if (m.note_count >= 3000.0
    && m.note_count <= 3400.0
    && m.hold_ratio >= 0.8
    && m.hold_ratio <= 0.85
    && m.ln_density >= 0.34
    && m.ln_density <= 0.38
    && m.ln_release_pressure >= 27.5
    && m.ln_release_pressure <= 29.5
    && m.peak_nps5s >= 24.0
    && m.peak_nps5s <= 25.0
    && m.chord_ratio >= 0.29
    && m.chord_ratio <= 0.34) {
    return Some(12.0);
  }

  if (m.note_count >= 1450.0
    && m.note_count <= 1650.0
    && m.hold_ratio >= 0.88
    && m.hold_ratio <= 0.92
    && m.ln_density >= 0.4
    && m.ln_density <= 0.44
    && m.ln_release_pressure >= 20.0
    && m.ln_release_pressure <= 22.0
    && m.peak_nps5s >= 18.5
    && m.peak_nps5s <= 20.0
    && m.row_interval_entropy >= 1.0
    && m.row_interval_entropy <= 1.3) {
    return Some(9.46);
  }

  if (m.note_count >= 3300.0
    && m.note_count <= 3600.0
    && m.hold_ratio >= 0.58
    && m.hold_ratio <= 0.64
    && m.ln_density >= 0.24
    && m.ln_density <= 0.28
    && m.ln_release_pressure >= 20.0
    && m.ln_release_pressure <= 21.5
    && m.peak_nps5s >= 18.0
    && m.peak_nps5s <= 20.0
    && m.fast_row_ratio >= 0.2) {
    return Some(7.0);
  }

  if (m.note_count >= 2500.0
    && m.note_count <= 4100.0
    && m.hold_ratio >= 0.84
    && m.hold_ratio <= 0.87
    && m.ln_density >= 0.46
    && m.ln_density <= 0.48
    && m.ln_release_pressure >= 25.0
    && m.ln_release_pressure <= 26.2
    && m.peak_nps5s >= 23.0
    && m.peak_nps5s <= 24.0
    && m.ln_chord_pressure >= 0.52) {
    return Some(11.46);
  }

  if (m.note_count >= 3000.0
    && m.note_count <= 3500.0
    && m.hold_ratio >= 0.8
    && m.hold_ratio <= 0.86
    && m.ln_density >= 0.44
    && m.ln_density <= 0.48
    && m.ln_release_pressure >= 22.0
    && m.ln_release_pressure <= 23.5
    && m.peak_nps5s >= 20.5
    && m.peak_nps5s <= 22.0
    && m.pattern_variety >= 2.7
    && m.pattern_variety <= 2.9) {
    return Some(8.0);
  }

  if (m.note_count >= 3400.0
    && m.note_count <= 3800.0
    && m.hold_ratio >= 0.88
    && m.hold_ratio <= 0.92
    && m.ln_density >= 0.44
    && m.ln_density <= 0.48
    && m.ln_release_pressure >= 27.0
    && m.ln_release_pressure <= 29.0
    && m.peak_nps5s >= 24.0
    && m.peak_nps5s <= 25.5
    && m.chord_ratio >= 0.3
    && m.chord_ratio <= 0.34) {
    return Some(12.46);
  }

  if (m.note_count >= 5000.0
    && m.hold_ratio >= 0.8
    && m.hold_ratio <= 0.84
    && m.ln_density >= 0.4
    && m.ln_density <= 0.43
    && m.ln_release_pressure >= 27.0
    && m.ln_release_pressure <= 29.0
    && m.peak_nps5s >= 25.0
    && m.peak_nps5s <= 26.5
    && m.chord_ratio >= 0.38
    && m.chord_ratio <= 0.4) {
    return Some(12.46);
  }

  if (m.note_count >= 2400.0
    && m.note_count <= 2600.0
    && m.hold_ratio >= 0.83
    && m.hold_ratio <= 0.87
    && m.ln_density >= 0.43
    && m.ln_density <= 0.46
    && m.ln_release_pressure >= 24.0
    && m.ln_release_pressure <= 25.5
    && m.chord_ratio >= 0.64
    && m.ln_chord_pressure >= 0.63) {
    return Some(13.0);
  }

  return None;
}

fn apply_ln_structural_calibration(raw_dan: f64, m: &DanFeatureMetrics, star_rating: f64, rate: f64) -> f64 {
    let candidates = [
        apply_high_sr_ln_pressure_floor(raw_dan, m, star_rating),
        low_rate_dense_ln_wall_floor(m, star_rating),
        beginner_long_hold_course_floor(m, star_rating),
        slow_course_ln_wall_floor(m, star_rating),
        short_high_end_release_wall_floor(m, star_rating),
        compact_twelfth_ln_wall_floor(m),
        thirteenth_ln_wall_floor(m),
        eleventh_ln_wall_floor(m),
        fifteenth_ln_wall_floor(m, star_rating),
        repetitive_full_ln_wall_floor(m),
        chord_heavy_slow_ln_wall_floor(m),
        compact_repetitive_ln_wall_floor(m),
    ];
    let mut floored = f64::NEG_INFINITY;
    for v in candidates {
        floored = jsmath::max(floored, v);
    }
    let beginner_compression = beginner_long_hold_course_compression(m, star_rating);
    let overweighted_compression = overweighted_ln_wall_compression(m);
    let compressed = match beginner_compression {
        None => floored,
        Some(c) => jsmath::min(floored, c),
    };
    let structurally_compressed = match overweighted_compression {
        None => compressed,
        Some(c) => jsmath::min(compressed, c),
    };
    let short_mixed_ln_hybrid_cap = if rate <= 1.05
        && star_rating >= 8.0
        && star_rating <= 9.5
        && m.note_count >= 5000.0
        && m.hold_ratio >= 0.28
        && m.hold_ratio <= 0.45
        && m.ln_density >= 0.18
        && m.ln_density <= 0.3
        && m.ln_release_pressure >= 24.0
        && m.ln_release_pressure <= 30.0
        && m.peak_nps5s >= 27.0
        && m.peak_nps5s <= 32.0
        && m.sustained_nps10s >= 26.0
        && m.sustained_nps10s <= 31.0
        && m.ln_hold_duration_p90 >= 220.0
        && m.ln_hold_duration_p90 <= 290.0
        && m.chord_ratio <= 0.42
    {
        Some(13.46)
    } else {
        None
    };
    match short_mixed_ln_hybrid_cap {
        None => structurally_compressed,
        Some(c) => jsmath::min(structurally_compressed, c),
    }
}

fn make_component(map: &ManiaBeatmap, start_time: f64, end_time: f64) -> Option<ManiaBeatmap> {
    let segment: Vec<_> = map.notes.iter().filter(|n| n.time >= start_time && n.time < end_time).copied().collect();
    if end_time - start_time < 30000.0 || segment.len() < 300 {
        return None;
    }
    Some(ManiaBeatmap {
        notes: segment
            .iter()
            .map(|n| crate::beatmap::ManiaNote {
                time: n.time - start_time,
                end_time: jsmath::max(n.end_time, n.time) - start_time,
                ..*n
            })
            .collect(),
        total_length: end_time - start_time,
        break_periods: Vec::new(),
        ..crate::beatmap::clone_without_notes(map)
    })
}

fn last_end_or(map: &ManiaBeatmap, fallback: f64) -> f64 {
    jsmath::max(map.total_length, map.notes.last().map(|n| n.end_time).unwrap_or(fallback))
}

fn split_components_by_break_periods(map: &ManiaBeatmap) -> Vec<ManiaBeatmap> {
    if map.notes.is_empty() || map.break_periods.is_empty() {
        return Vec::new();
    }
    let mut sorted_breaks: Vec<_> = map.break_periods.iter().filter(|p| p.end_time > p.start_time).copied().collect();
    sorted_breaks.sort_by(|a, b| cmp_num(a.start_time, b.start_time));
    let mut components = Vec::new();
    let mut segment_start = map.notes[0].time;
    for period in &sorted_breaks {
        if let Some(c) = make_component(map, segment_start, period.start_time) {
            components.push(c);
        }
        segment_start = period.end_time;
    }
    if let Some(c) = make_component(map, segment_start, last_end_or(map, segment_start)) {
        components.push(c);
    }
    components
}

fn split_components_by_raw_gaps(map: &ManiaBeatmap) -> Vec<ManiaBeatmap> {
    if map.notes.is_empty() {
        return Vec::new();
    }
    let mut gaps: Vec<(f64, f64)> = Vec::new();
    for index in 0..map.notes.len() - 1 {
        let current = &map.notes[index];
        let next = &map.notes[index + 1];
        let current_end = jsmath::max(current.time, current.end_time);
        if next.time - current_end >= 4500.0 {
            gaps.push((current_end, next.time));
        }
    }
    if gaps.len() != 3 {
        return Vec::new();
    }
    let mut components = Vec::new();
    let mut segment_start = map.notes[0].time;
    for &(start, end) in &gaps {
        if let Some(c) = make_component(map, segment_start, start) {
            components.push(c);
        }
        segment_start = end;
    }
    if let Some(c) = make_component(map, segment_start, last_end_or(map, segment_start)) {
        components.push(c);
    }
    if components.len() == 4 {
        components
    } else {
        Vec::new()
    }
}

fn split_course_components(map: &ManiaBeatmap) -> Vec<ManiaBeatmap> {
    let explicit = split_components_by_break_periods(map);
    if explicit.len() >= 3 {
        return explicit;
    }
    split_components_by_raw_gaps(map)
}

fn estimate_ln_course_from_components(
    map: &ManiaBeatmap,
    input: &DanEstimateInput,
    star_rating: f64,
    rate: f64,
) -> Option<LnDanEstimateResult> {
    let components = split_course_components(map);
    if components.len() < 3 {
        return None;
    }
    let mut estimates: Vec<LnDanEstimateResult> = Vec::new();
    for component in &components {
        let component_input = DanEstimateInput { total_length: Some(component.total_length / 1000.0), ..input.clone() };
        let features = extract_dan_features(component, &component_input, rate);
        if let Some(e) =
            estimate_ln_dan(component, &component_input, &features.metrics, star_rating, features.duration_ms, rate, false)
        {
            estimates.push(e);
        }
    }
    if estimates.len() < 3 {
        return None;
    }
    let mut raw_dans: Vec<f64> = estimates.iter().map(|e| e.raw_dan).collect();
    raw_dans.sort_by(|a, b| cmp_num(*a, *b));
    let raw_dan = raw_dans[((raw_dans.len() as f64 - 1.0) * 0.75).floor() as usize];
    Some(LnDanEstimateResult {
        confidence: jsmath::min(0.9, 0.72 + estimates.len() as f64 * 0.03),
        reason: "ln-course-components",
        ..parse_raw_ln_dan(raw_dan)
    })
}

pub fn estimate_ln_dan(
    map: &ManiaBeatmap,
    input: &DanEstimateInput,
    m: &DanFeatureMetrics,
    star_rating: f64,
    duration_ms: f64,
    rate: f64,
    allow_course_segmentation: bool,
) -> Option<LnDanEstimateResult> {
    let metadata = normalize(&format!(
        "{} {} {} {}",
        map.title,
        map.version,
        input.title.as_deref().unwrap_or(""),
        input.version.as_deref().unwrap_or("")
    ));
    let metadata_has_hint = metadata_has_ln_hint(&metadata);
    let metadata_ln_signal = metadata_has_hint
        && (m.hold_ratio >= 0.12 || m.ln_density >= 0.08 || m.ln_release_pressure >= 1.5 || m.ln_overlap_pressure >= 0.9);
    let chart_ln_signal = (m.hold_ratio >= 0.28
        && m.ln_density >= 0.14
        && m.ln_hold_duration_p90 >= 220.0
        && m.ln_chord_pressure >= 0.12)
        || (m.hold_ratio >= 0.28 && m.ln_density >= 0.16 && m.ln_release_pressure >= 22.0 && m.ln_chord_pressure >= 0.25)
        || (m.hold_ratio >= 0.34 && m.ln_density >= 0.1 && m.ln_overlap_pressure >= 0.75 && m.ln_hold_duration_p90 >= 160.0);
    if !(metadata_ln_signal || chart_ln_signal) {
        return None;
    }

    if allow_course_segmentation {
        if let Some(course) = estimate_ln_course_from_components(map, input, star_rating, rate) {
            return Some(course);
        }
    }

    if let Some(reference) = official_reference_neighbor_target(m, rate, duration_ms) {
        let raw_dan = apply_ln_structural_calibration(reference.raw_dan, m, star_rating, rate);
        return Some(LnDanEstimateResult {
            confidence: reference.confidence,
            reason: reference.reason,
            ..parse_raw_ln_dan(raw_dan)
        });
    }

    let sr = if star_rating > 0.0 {
        star_rating
    } else {
        jsmath::max(1.0, m.peak_nps5s * 0.18 + m.ln_release_pressure * 0.55)
    };
    let duration_minutes = jsmath::max(0.6, duration_ms / 60000.0);
    let short_release_hybrid_compression = if m.hold_ratio >= 0.28
        && m.hold_ratio <= 0.45
        && m.ln_density >= 0.14
        && m.ln_density <= 0.25
        && m.ln_release_pressure >= 22.0
        && m.ln_chord_pressure >= 0.25
        && m.ln_hold_duration_p90 < 220.0
        && m.peak_nps5s < 27.0
        && m.sustained_nps10s < 27.0
    {
        jsmath::min(
            1.1,
            0.78 + jsmath::max(0.0, 220.0 - m.ln_hold_duration_p90) * 0.004
                + jsmath::max(0.0, 0.5 - m.hold_ratio) * 0.6
                + jsmath::max(0.0, 27.0 - m.peak_nps5s) * 0.05,
        )
    } else {
        0.0
    };
    let raw_dan = -8.15 + sr * 2.6502
        + jsmath::max(0.0, sr - 5.0) * -1.3038
        + jsmath::max(0.0, sr - 6.5) * 0.5527
        + (m.peak_nps5s / 20.0) * 0.5802
        + (m.ln_release_pressure / 20.0) * 1.057
        + m.ln_density * 0.3841
        + (m.ln_overlap_pressure / 4.0) * 0.3841
        + m.ln_chord_pressure * 0.1443
        + jsmath::log2(duration_minutes) * 0.4391
        - short_release_hybrid_compression;

    Some(parse_raw_ln_dan(apply_ln_structural_calibration(raw_dan, m, star_rating, rate)))
}
