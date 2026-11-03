use crate::{calculate_daniel, calculate_sunny_with_spread_limit, OdFlag, OsuFileParser, ReworkError, ReworkStar, SPREAD_LIMIT_WORKER_THREAD};

pub trait DifficultyTable {
    fn est_diff(&self, sr: f64, ln_ratio: f64, column_count: f64, use_extended: bool, always_show_ln: bool) -> String;
}

#[derive(Clone, Debug, PartialEq)]
pub struct EstimatorOptions {
    pub speed_rate: f64,
    pub od_flag: OdFlag,
    pub cvt_flag: Option<String>,
    pub extended_estimation_range: bool,
    pub enable_always_show_ln_difficulty: bool,
    pub spread_arg_limit: usize,
}

impl Default for EstimatorOptions {
    fn default() -> Self {
        EstimatorOptions {
            speed_rate: 1.0,
            od_flag: OdFlag::Chart,
            cvt_flag: None,
            extended_estimation_range: false,
            enable_always_show_ln_difficulty: false,
            spread_arg_limit: SPREAD_LIMIT_WORKER_THREAD,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct ReworkEstimate {
    pub star: f64,
    pub ln_ratio: f64,
    pub column_count: f64,
    pub est_diff: String,
    pub numeric_difficulty: Option<f64>,
    pub numeric_difficulty_hint: Option<&'static str>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum EstimatorError {
    ParseFailed,
    NotMania,
    InvalidOutput { star: f64, ln_ratio: f64, column_count: f64 },
    Throw(&'static str),
}

fn normalize(raw: Result<ReworkStar, ReworkError>) -> Result<ReworkStar, EstimatorError> {
    match raw {
        Ok(r) => {
            if !r.star.is_finite() || !r.ln_ratio.is_finite() || !r.column_count.is_finite() {
                return Err(EstimatorError::InvalidOutput { star: r.star, ln_ratio: r.ln_ratio, column_count: r.column_count });
            }
            Ok(r)
        }
        Err(ReworkError::ParseFailed) => Err(EstimatorError::ParseFailed),
        Err(ReworkError::NotMania) => Err(EstimatorError::NotMania),
        Err(ReworkError::UnsupportedKeys) => Err(EstimatorError::Throw("Unknown result code: -3")),
        Err(ReworkError::Throw(m)) => Err(EstimatorError::Throw(m)),
    }
}

pub fn run_sunny_estimator(
    chart: &OsuFileParser,
    options: &EstimatorOptions,
    table: &dyn DifficultyTable,
) -> Result<ReworkEstimate, EstimatorError> {
    let raw = calculate_sunny_with_spread_limit(
        chart,
        options.speed_rate,
        options.od_flag,
        options.cvt_flag.as_deref(),
        options.spread_arg_limit,
    );
    let r = normalize(raw)?;
    Ok(ReworkEstimate {
        star: r.star,
        ln_ratio: r.ln_ratio,
        column_count: r.column_count,
        est_diff: table.est_diff(
            r.star,
            r.ln_ratio,
            r.column_count,
            options.extended_estimation_range,
            options.enable_always_show_ln_difficulty,
        ),
        numeric_difficulty: None,
        numeric_difficulty_hint: None,
    })
}

pub fn run_daniel_estimator(
    chart: &OsuFileParser,
    options: &EstimatorOptions,
    table: &dyn DifficultyTable,
) -> Result<ReworkEstimate, EstimatorError> {
    let raw = calculate_daniel(chart, options.speed_rate, options.od_flag);
    if let Err(ReworkError::UnsupportedKeys) = raw {
        return run_sunny_estimator(chart, options, table);
    }
    let r = normalize(raw)?;
    let use_daniel = r.column_count == 4.0;
    if use_daniel {
        let dan = estimate_daniel_dan(r.star);
        let hint = if dan.numeric.map_or(true, |v| !v.is_finite()) { Some("N/A") } else { None };
        return Ok(ReworkEstimate {
            star: r.star,
            ln_ratio: r.ln_ratio,
            column_count: r.column_count,
            est_diff: dan.label,
            numeric_difficulty: dan.numeric,
            numeric_difficulty_hint: hint,
        });
    }
    Ok(ReworkEstimate {
        star: r.star,
        ln_ratio: r.ln_ratio,
        column_count: r.column_count,
        est_diff: table.est_diff(
            r.star,
            r.ln_ratio,
            r.column_count,
            options.extended_estimation_range,
            options.enable_always_show_ln_difficulty,
        ),
        numeric_difficulty: None,
        numeric_difficulty_hint: None,
    })
}

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
    let m: Vec<f64> = DAN_MEANS.iter().map(|d| d.0).collect();
    let mut out = [(0.0, 0.0); 8];
    for i in 0..m.len() {
        let mean = m[i];
        let lower = if i > 0 { (m[i - 1] + mean) / 2.0 } else { mean - (((m[1] + mean) / 2.0) - mean) };
        let upper = if i < m.len() - 1 { (mean + m[i + 1]) / 2.0 } else { mean + ((mean - m[i - 1]) / 2.0) };
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
            let numeric = jsmath::js_number_from_str(&jsmath::to_fixed(DAN_ORDER_START + i as f64 + t, 2));
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
