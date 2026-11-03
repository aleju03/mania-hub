use crate::intervals::{dan_index, IntervalRow};
use crate::jsnum::round_fixed;

const DAN_MEANS: [(f64, &str); 8] = [
    (6.562, "Alpha"),
    (6.957, "Beta"),
    (7.459, "Gamma"),
    (7.939, "Delta"),
    (9.095, "Epsilon"),
    (9.473, "Emik Zeta"),
    (10.162, "Thaumiel Eta"),
    (10.782, "CloverWisp Theta"),
];

const DAN_ORDER_START: f64 = 11.0;

fn dan_boundaries() -> [(f64, f64); 8] {
    let mut out = [(0.0, 0.0); 8];
    let n = DAN_MEANS.len();
    for i in 0..n {
        let mean = DAN_MEANS[i].0;
        let lower = if i > 0 {
            (DAN_MEANS[i - 1].0 + mean) / 2.0
        } else {
            mean - (((DAN_MEANS[1].0 + mean) / 2.0) - mean)
        };
        let upper = if i < n - 1 {
            (mean + DAN_MEANS[i + 1].0) / 2.0
        } else {
            mean + ((mean - DAN_MEANS[i - 1].0) / 2.0)
        };
        out[i] = (lower, upper);
    }
    out
}

#[derive(Clone, Debug, PartialEq)]
pub struct DanielDan {
    pub label: String,
    pub numeric: Option<f64>,
}

pub fn estimate_daniel_dan(sr: f64) -> DanielDan {
    if !sr.is_finite() {
        return DanielDan { label: "Unknown".into(), numeric: None };
    }
    let b = dan_boundaries();
    if sr < b[0].0 {
        return DanielDan { label: format!("< {} Low", DAN_MEANS[0].1), numeric: None };
    }
    if sr >= b[b.len() - 1].1 {
        return DanielDan { label: format!("> {} High", DAN_MEANS[DAN_MEANS.len() - 1].1), numeric: None };
    }
    for i in 0..DAN_MEANS.len() {
        let (lower, upper) = b[i];
        if sr >= lower && sr < upper {
            let t_raw = (sr - lower) / (upper - lower);
            let t = jsmath::max(0.0, jsmath::min(t_raw, 1.0));
            let numeric = round_fixed(DAN_ORDER_START + i as f64 + t, 2);
            let tier = if t < 1.0 / 3.0 {
                "Low"
            } else if t < 2.0 / 3.0 {
                "Mid"
            } else {
                "High"
            };
            return DanielDan { label: format!("{} {}", DAN_MEANS[i].1, tier), numeric: Some(numeric) };
        }
    }
    DanielDan { label: "Unknown".into(), numeric: None }
}

fn interval_lookup(sr: f64, table: &[IntervalRow], fallback: &str) -> String {
    for &(lower, upper, name) in table {
        if lower <= sr && sr <= upper {
            return name.to_string();
        }
    }
    if sr < table[0].0 {
        return format!("< {}", table[0].2);
    }
    let last = table[table.len() - 1];
    if sr > last.1 {
        return format!("> {}", last.2);
    }
    fallback.to_string()
}

pub fn est_diff(sr: f64, ln_ratio: f64, column_count: f64, use_extended: bool, always_show_ln: bool) -> String {
    let Some(keys) = dan_index(column_count) else {
        return "Unknown difficulty".into();
    };
    let rc_table = if use_extended { keys.rc_extended.unwrap_or(keys.rc_default) } else { keys.rc_default };
    let rc = interval_lookup(sr, rc_table, "Unknown RC difficulty");
    if ln_ratio < 0.15 && !always_show_ln {
        return rc;
    }
    let ln_table = if use_extended { keys.ln_extended.or(keys.ln_default) } else { keys.ln_default };
    let Some(ln_table) = ln_table else {
        return rc;
    };
    let ln = interval_lookup(sr, ln_table, "Unknown LN difficulty");
    format!("{rc} || {ln}")
}

pub fn est_diff2(sr: f64, sr_ln: f64, column_count: f64, use_extended: bool) -> String {
    let Some(keys) = dan_index(column_count) else {
        return "Unknown difficulty".into();
    };
    let rc_table = if use_extended { keys.rc_extended.unwrap_or(keys.rc_default) } else { keys.rc_default };
    let rc = interval_lookup(sr, rc_table, "Unknown RC difficulty");
    if sr_ln <= 0.0 {
        return rc;
    }
    let ln_table = if use_extended { keys.ln_extended.or(keys.ln_default) } else { keys.ln_default };
    let Some(ln_table) = ln_table else {
        return rc;
    };
    let ln = interval_lookup(sr_ln, ln_table, "Unknown LN difficulty");
    format!("{rc} || {ln}")
}

pub fn normalize_rework_result(star: f64, ln_ratio: f64, column_count: f64) -> Result<(f64, f64, f64), String> {
    if !star.is_finite() || !ln_ratio.is_finite() || !column_count.is_finite() {
        return Err(format!(
            "Invalid estimator output{}{}{}",
            crate::jsnum::number_to_string(star),
            crate::jsnum::number_to_string(ln_ratio),
            crate::jsnum::number_to_string(column_count)
        ));
    }
    Ok((star, ln_ratio, column_count))
}

pub fn normalize_rework_code_error(code: f64) -> String {
    if code == -1.0 {
        "Beatmap parse failed".into()
    } else if code == -2.0 {
        "Beatmap mode is not mania".into()
    } else {
        format!("Unknown result code: {}", crate::jsnum::number_to_string(code))
    }
}
