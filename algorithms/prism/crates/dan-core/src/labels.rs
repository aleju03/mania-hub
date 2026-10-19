use crate::types::{DanEstimateInput, DanSkillFamily};

pub const DAN_LABELS: [&str; 20] = [
    "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta",
    "theta", "iota", "kappa",
];

const MAX_SUPPORTED_DAN_INDEX: usize = DAN_LABELS.len() - 1;

fn dan_means(family: DanSkillFamily) -> &'static [f64; 20] {
    match family {
        DanSkillFamily::Jack => &[3.15, 3.55, 3.95, 4.35, 4.75, 5.15, 5.45, 5.7, 5.92, 6.1, 6.35, 6.75, 7.15, 7.65, 8.25, 8.85, 9.55, 10.25, 11.0, 11.8],
        DanSkillFamily::Stream => &[3.1, 3.5, 3.9, 4.3, 4.7, 5.05, 5.35, 5.6, 5.78, 5.92, 6.12, 6.5, 6.92, 7.42, 8.08, 8.8, 9.65, 10.42, 11.2, 12.0],
        DanSkillFamily::Jumpstream => &[3.15, 3.55, 3.95, 4.35, 4.75, 5.1, 5.4, 5.66, 5.86, 6.02, 6.35, 6.72, 7.08, 7.55, 8.15, 8.85, 9.65, 10.38, 11.14, 11.95],
        DanSkillFamily::Handstream => &[3.2, 3.6, 4.0, 4.4, 4.8, 5.15, 5.45, 5.72, 5.92, 6.08, 6.6, 6.9, 6.96, 7.72, 8.48, 9.18, 9.98, 10.72, 11.46, 12.2],
        DanSkillFamily::Stamina => &[3.2, 3.6, 4.0, 4.4, 4.8, 5.15, 5.45, 5.72, 5.92, 6.08, 6.3, 6.7, 7.12, 7.62, 8.28, 8.98, 9.78, 10.52, 11.26, 12.0],
        DanSkillFamily::Chordjack => &[3.2, 3.6, 4.0, 4.42, 4.82, 5.18, 5.48, 5.75, 5.95, 6.12, 6.35, 6.75, 7.15, 7.65, 8.25, 8.85, 9.55, 10.25, 11.0, 11.8],
        DanSkillFamily::Tech | DanSkillFamily::Ln | DanSkillFamily::Dan => &[3.25, 3.65, 4.05, 4.48, 4.88, 5.25, 5.55, 5.82, 6.02, 6.18, 6.42, 6.82, 7.22, 7.72, 8.35, 9.02, 9.8, 10.52, 11.26, 12.0],
    }
}

fn raw_dan_from_means(value: f64, means: &[f64]) -> f64 {
    let max_index = MAX_SUPPORTED_DAN_INDEX;
    let capped = &means[..(max_index + 1).min(means.len())];
    let n = capped.len();
    let mut boundaries: Vec<(f64, f64, f64)> = Vec::with_capacity(n);
    for (index, &mean) in capped.iter().enumerate() {
        let lower = if index == 0 {
            mean - (capped.get(1).copied().unwrap_or(f64::NAN) - mean) / 2.0
        } else {
            (capped[index - 1] + mean) / 2.0
        };
        let upper = if index == n - 1 {
            mean + (mean - if index >= 1 { capped[index - 1] } else { f64::NAN }) / 2.0
        } else {
            (mean + capped[index + 1]) / 2.0
        };
        boundaries.push((lower, upper, (index + 1) as f64));
    }
    if value < boundaries[0].0 {
        return 1.0;
    }
    let last = boundaries[boundaries.len() - 1];
    if value >= last.1 {
        return (max_index + 1) as f64;
    }
    for &(lower, upper, level) in &boundaries {
        if value >= lower && value < upper {
            let t = (value - lower) / jsmath::max(0.001, upper - lower);
            return level + t - 0.5;
        }
    }
    1.0
}

struct Calibration {
    slope: f64,
    offset: f64,
    gate_start: f64,
    gate_width: f64,
}

fn sr_calibration(family: DanSkillFamily) -> Calibration {
    let (slope, offset, gate_start, gate_width) = match family {
        DanSkillFamily::Jack => (0.74, 1.3, 7.4, 0.3),
        DanSkillFamily::Stream => (0.92, -0.4, 7.0, 0.9),
        DanSkillFamily::Jumpstream => (1.02, -0.45, 7.25, 0.55),
        DanSkillFamily::Handstream => (1.16, -2.0, 7.4, 0.2),
        DanSkillFamily::Stamina => (1.12, -1.5, 7.3, 0.55),
        DanSkillFamily::Chordjack => (1.0, 0.0, 7.15, 0.85),
        _ => (0.95, -0.9, 7.6, 0.9),
    };
    Calibration { slope, offset, gate_start, gate_width }
}

fn clamp01(value: f64) -> f64 {
    jsmath::max(0.0, jsmath::min(1.0, value))
}

fn calibrate_sr_for_family(sr: f64, family: DanSkillFamily) -> f64 {
    let c = sr_calibration(family);
    let target_sr = sr * c.slope + c.offset;
    let gate = clamp01((sr - c.gate_start) / c.gate_width);
    sr + (target_sr - sr) * gate
}

fn calibration_family(family: DanSkillFamily) -> DanSkillFamily {
    if family == DanSkillFamily::Jumpstream {
        DanSkillFamily::Handstream
    } else {
        family
    }
}

pub fn get_input_rate(input: &DanEstimateInput) -> f64 {
    rate_or_one(input.rate)
}

pub fn rate_or_one(rate: Option<f64>) -> f64 {
    let rate = rate.unwrap_or(f64::NAN);
    if rate.is_finite() && rate > 0.4 && rate < 2.5 {
        rate
    } else {
        1.0
    }
}

pub fn sr_to_raw_dan(sr: f64, family: DanSkillFamily, calibrate: bool) -> f64 {
    let family = calibration_family(family);
    let calibrated = if !calibrate { sr } else { calibrate_sr_for_family(sr, family) };
    raw_dan_from_means(calibrated, dan_means(family))
}

pub fn dan_level_for_label(label: &str) -> Option<i32> {
    let wanted = crate::js::trim(label).to_lowercase();
    DAN_LABELS.iter().position(|l| *l == wanted).map(|i| i as i32 + 1)
}

pub fn dan_variant_for_offset(offset: f64) -> Option<&'static str> {
    let rounded = jsmath::round(offset * 1e6) / 1e6;
    if rounded < -0.3 {
        Some("--")
    } else if rounded < -0.1 {
        Some("-")
    } else if rounded < 0.1 {
        None
    } else if rounded < 0.3 {
        Some("+")
    } else {
        Some("++")
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct ParsedDan {
    pub label: String,
    pub variant: Option<&'static str>,
    pub display_name: String,
}

pub fn parse_dan(raw_dan: f64) -> ParsedDan {
    let max_level = (MAX_SUPPORTED_DAN_INDEX + 1) as f64;
    let level = jsmath::min(max_level, jsmath::max(1.0, jsmath::round(raw_dan)));
    let variant = dan_variant_for_offset(raw_dan - level);
    let label = if level.is_nan() { "undefined".to_string() } else { DAN_LABELS[level as usize - 1].to_string() };
    let display_name = format!("{}{}", label, variant.unwrap_or(""));
    ParsedDan { label, variant, display_name }
}
