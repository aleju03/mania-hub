use crate::intervals::{dan_index, IntervalRow};
use crate::jsnum::round_fixed;

const LEVEL_KNOTS: [f64; 29] = [
    -0.75, -0.25, 0.25, 0.75, 1.25, 1.75, 2.25, 2.75, 3.25, 3.75,
    4.25, 4.75, 5.25, 5.75, 6.25, 6.75, 7.25, 7.75, 8.25, 8.75,
    9.25, 9.75, 10.25, 10.75, 11.25, 11.75, 12.25, 12.75, 13.25,
];

const B_RC_FIT: [f64; 29] = [
    -0.376, -0.376, -0.228, 0.003, 0.116, 0.164, 0.252, 0.397, 0.486, 0.36,
    0.143, 0.042, 0.11, 0.209, 0.229, 0.223, 0.238, 0.212, 0.09, -0.033,
    -0.05, 0.012, 0.041, 0.039, 0.032, 0.0, -0.014, -0.036, -0.087,
];

const R_RC_FIT: [f64; 29] = [
    0.022, 0.022, 0.0, 0.0, 0.077, 0.0, 0.0, 0.0, 0.123, 0.441,
    0.567, 0.492, 0.678, 0.945, 0.914, 0.833, 0.926, 1.064, 1.133, 1.166,
    1.098, 0.957, 0.833, 0.729, 0.633, 0.511, 0.42, 0.324, 0.187,
];

const MIN_LEVEL_STEP: f64 = 0.05;

fn repaired_rc() -> ([f64; 29], [f64; 29]) {
    let mut r = R_RC_FIT;
    for v in r.iter_mut() {
        if *v < 0.0 {
            *v = 0.0;
        }
    }
    let mut b = B_RC_FIT;
    for i in 1..LEVEL_KNOTS.len() {
        let span = LEVEL_KNOTS[i] - LEVEL_KNOTS[i - 1];
        let required = MIN_LEVEL_STEP - span - jsmath::min(0.0, r[i] - r[i - 1]);
        if b[i] - b[i - 1] < required {
            b[i] = b[i - 1] + required;
        }
    }
    (b, r)
}

fn interp_curve(values: &[f64; 29], x: f64) -> f64 {
    let last = LEVEL_KNOTS.len() - 1;
    if x <= LEVEL_KNOTS[0] {
        return values[0];
    }
    if x >= LEVEL_KNOTS[last] {
        return values[last];
    }
    for i in 0..last {
        if x >= LEVEL_KNOTS[i] && x <= LEVEL_KNOTS[i + 1] {
            let t = (x - LEVEL_KNOTS[i]) / (LEVEL_KNOTS[i + 1] - LEVEL_KNOTS[i]);
            return values[i] + (values[i + 1] - values[i]) * t;
        }
    }
    values[last]
}

fn rc_correction(level: f64, rate: f64) -> f64 {
    if !level.is_finite() || !rate.is_finite() || rate < 1.0 {
        return 0.0;
    }
    let (b, r) = repaired_rc();
    let mut corr = interp_curve(&b, level);
    if rate > 1.0 {
        corr += interp_curve(&r, level) * jsmath::min(1.0, (rate - 1.0) / 0.5);
    }
    corr
}

fn tier_offset(tier: &str) -> f64 {
    match tier {
        "low" => -0.4,
        "mid/low" => -0.2,
        "mid" => 0.0,
        "mid/high" => 0.2,
        "high" => 0.4,
        _ => f64::NAN,
    }
}

struct LevelMap {
    xs: Vec<f64>,
    ys: Vec<f64>,
    s0: f64,
    s1: f64,
    band_levels: Vec<f64>,
    band_labels: Vec<&'static str>,
}

fn build_level_map(table: &[IntervalRow]) -> LevelMap {
    let mut seen: Vec<(String, f64)> = Vec::new();
    let mut xs: Vec<f64> = Vec::new();
    let mut ys: Vec<f64> = Vec::new();
    let mut band_levels = Vec::with_capacity(table.len());
    let mut band_labels = Vec::with_capacity(table.len());
    let mut prev_level: Option<f64> = None;
    for &(lo, hi, label) in table {
        let parts: Vec<&str> = label.split(' ').collect();
        let tier = parts[parts.len() - 1];
        let base = parts[..parts.len() - 1].join(" ");
        let base_level = match seen.iter().find(|(name, _)| *name == base) {
            Some(&(_, level)) => level,
            None => {
                let tok = base.split(' ').last().unwrap_or("");
                let numeric = !tok.is_empty() && tok.bytes().all(|c| c.is_ascii_digit());
                let level = if numeric && !base.starts_with("Wild") {
                    let n = jsmath::js_number_from_str(tok);
                    if base.starts_with("Intro") { n - 3.0 } else { n }
                } else {
                    prev_level.map_or(0.0, |p| p + 1.0)
                };
                seen.push((base.clone(), level));
                prev_level = Some(level);
                level
            }
        };
        let value = base_level + tier_offset(tier);
        for (x, y) in [(lo, value - 0.1), (hi, value + 0.1)] {
            if xs.is_empty() || x > xs[xs.len() - 1] {
                xs.push(x);
                ys.push(y);
            }
        }
        band_levels.push(value);
        band_labels.push(label);
    }
    let last = xs.len() - 1;
    let i0 = last.min(10);
    let i1 = last.saturating_sub(10);
    let s0 = if xs[i0] > xs[0] { (ys[i0] - ys[0]) / (xs[i0] - xs[0]) } else { 0.0 };
    let s1 = if xs[last] > xs[i1] { (ys[last] - ys[i1]) / (xs[last] - xs[i1]) } else { 0.0 };
    LevelMap { xs, ys, s0, s1, band_levels, band_labels }
}

fn star_to_level(map: &LevelMap, star: f64) -> f64 {
    let (xs, ys) = (&map.xs, &map.ys);
    let last = xs.len() - 1;
    if star <= xs[0] {
        return ys[0] + (star - xs[0]) * map.s0;
    }
    if star >= xs[last] {
        return ys[last] + (star - xs[last]) * map.s1;
    }
    let (mut lo, mut hi) = (0usize, last);
    while hi - lo > 1 {
        let mid = (lo + hi) >> 1;
        if xs[mid] <= star {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    let t = (star - xs[lo]) / (xs[hi] - xs[lo]);
    ys[lo] + (ys[hi] - ys[lo]) * t
}

fn level_to_label(map: &LevelMap, level: f64, star: f64, table: &[IntervalRow]) -> String {
    let first = table[0];
    let last = table[table.len() - 1];
    if star < first.0 {
        return format!("< {}", first.2);
    }
    if star > last.1 {
        return format!("> {}", last.2);
    }
    let mut best = 0;
    let mut best_distance = f64::INFINITY;
    for (i, band) in map.band_levels.iter().enumerate() {
        let distance = (level - band).abs();
        if distance < best_distance {
            best_distance = distance;
            best = i;
        }
    }
    map.band_labels[best].to_string()
}

#[derive(Clone, Debug, PartialEq)]
pub struct PolarisRc {
    pub label: String,
    pub numeric: Option<f64>,
}

pub fn calibrate_rc_half(column_count: f64, star: f64, rate: f64, ln_ratio: f64, extended: bool) -> Option<PolarisRc> {
    if column_count != 7.0 || !star.is_finite() || !rate.is_finite() || !ln_ratio.is_finite() {
        return None;
    }
    let tables = dan_index(column_count)?;
    let table = if extended { tables.rc_extended.unwrap_or(tables.rc_default) } else { tables.rc_default };
    let map = build_level_map(table);
    let base = star_to_level(&map, star);
    let level = base + rc_correction(base, rate);
    let in_range = star >= table[0].0 && star <= table[table.len() - 1].1;
    Some(PolarisRc {
        label: level_to_label(&map, level, star, table),
        numeric: if in_range { Some(round_fixed(level, 2)) } else { None },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repaired_curve_is_monotonic() {
        let (b, r) = repaired_rc();
        for f in [0.0, 1.0] {
            for i in 1..LEVEL_KNOTS.len() {
                let step = (LEVEL_KNOTS[i] - LEVEL_KNOTS[i - 1]) + (b[i] - b[i - 1]) + f * (r[i] - r[i - 1]);
                assert!(step >= MIN_LEVEL_STEP - 1e-9);
            }
        }
    }

    #[test]
    fn only_7k_is_calibrated() {
        assert!(calibrate_rc_half(4.0, 5.0, 1.0, 0.0, false).is_none());
        assert!(calibrate_rc_half(7.0, 5.0, 1.0, 0.0, false).is_some());
    }
}
