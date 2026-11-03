use leoblack_parser::OsuFileParser;
use leoblack_rework::{run_daniel_estimator, run_sunny_estimator, DifficultyTable, EstimatorError, ReworkEstimate, SPREAD_LIMIT_WORKER_THREAD};

use crate::jsnum::{number_to_string, parse_float};
use crate::types::{EstimatorOptions, EstimatorResult, OdFlag, ParseStatus, ParsedView, Upstream};

#[derive(Clone, Copy, Debug, Default)]
pub struct DanIndexTable;

impl DifficultyTable for DanIndexTable {
    fn est_diff(&self, sr: f64, ln_ratio: f64, column_count: f64, use_extended: bool, always_show_ln: bool) -> String {
        crate::rework_utils::est_diff(sr, ln_ratio, column_count, use_extended, always_show_ln)
    }
}

impl ParsedView for OsuFileParser {
    fn status(&self) -> ParseStatus {
        match self.status {
            leoblack_parser::ParseStatus::Init => ParseStatus::Init,
            leoblack_parser::ParseStatus::Ok => ParseStatus::Ok,
            leoblack_parser::ParseStatus::Fail => ParseStatus::Fail,
            leoblack_parser::ParseStatus::NotMania => ParseStatus::NotMania,
        }
    }
    fn column_count(&self) -> f64 { self.column_count }
    fn ln_ratio(&self) -> f64 { self.ln_ratio }
    fn od(&self) -> f64 { self.od }
    fn note_count(&self) -> usize { self.columns.len() }
    fn column(&self, i: usize) -> f64 { self.columns.get(i).copied().unwrap_or(f64::NAN) }
    fn note_start(&self, i: usize) -> f64 { self.note_starts.get(i).copied().unwrap_or(f64::NAN) }
    fn note_type(&self, i: usize) -> f64 { self.note_types.get(i).copied().unwrap_or(f64::NAN) }
}

#[derive(Clone, Copy, Debug)]
pub struct ReworkUpstream {
    pub spread_arg_limit: usize,
}

impl Default for ReworkUpstream {
    fn default() -> Self {
        ReworkUpstream { spread_arg_limit: SPREAD_LIMIT_WORKER_THREAD }
    }
}

fn rework_od_flag(od: Option<&OdFlag>) -> leoblack_rework::OdFlag {
    match od {
        None => leoblack_rework::OdFlag::Chart,
        Some(OdFlag::Str(s)) if s == "HR" => leoblack_rework::OdFlag::Hr,
        Some(OdFlag::Str(s)) if s == "EZ" => leoblack_rework::OdFlag::Ez,
        Some(OdFlag::Str(s)) => leoblack_rework::OdFlag::Value(parse_float(s)),
        Some(OdFlag::Num(n)) => leoblack_rework::OdFlag::Value(*n),
    }
}

fn error_message(e: EstimatorError) -> String {
    match e {
        EstimatorError::ParseFailed => "Beatmap parse failed".into(),
        EstimatorError::NotMania => "Beatmap mode is not mania".into(),
        EstimatorError::InvalidOutput { star, ln_ratio, column_count } => format!(
            "Invalid estimator output{}{}{}",
            number_to_string(star),
            number_to_string(ln_ratio),
            number_to_string(column_count)
        ),
        EstimatorError::Throw(m) => m.to_string(),
    }
}

fn to_result(r: ReworkEstimate) -> EstimatorResult {
    EstimatorResult::basic(r.star, r.ln_ratio, r.column_count, r.est_diff, r.numeric_difficulty, r.numeric_difficulty_hint.map(String::from))
}

impl ReworkUpstream {
    fn rework_options(&self, options: &EstimatorOptions) -> leoblack_rework::EstimatorOptions {
        leoblack_rework::EstimatorOptions {
            speed_rate: options.speed_rate.unwrap_or(1.0),
            od_flag: rework_od_flag(options.od_flag.as_ref()),
            cvt_flag: options.cvt_flag.clone(),
            extended_estimation_range: options.extended_estimation_range,
            enable_always_show_ln_difficulty: options.enable_always_show_ln_difficulty,
            spread_arg_limit: self.spread_arg_limit,
        }
    }

    fn with_parsed<T>(&self, text: &str, parsed: Option<&OsuFileParser>, f: impl FnOnce(&OsuFileParser) -> T) -> T {
        match parsed {
            Some(p) => f(p),
            None => f(&OsuFileParser::parse(text)),
        }
    }
}

impl Upstream for ReworkUpstream {
    type Parsed = OsuFileParser;

    fn parse(&self, text: &str, cvt: Option<&str>) -> Result<OsuFileParser, String> {
        let mut p = OsuFileParser::parse(text);
        match cvt {
            Some("HO") => p.mod_ho(),
            Some("IN") => p.mod_in(),
            _ => {}
        }
        Ok(p)
    }

    fn sunny(&self, text: &str, options: &EstimatorOptions, parsed: Option<&OsuFileParser>) -> Result<EstimatorResult, String> {
        let o = self.rework_options(options);
        self.with_parsed(text, parsed, |p| run_sunny_estimator(p, &o, &DanIndexTable)).map(to_result).map_err(error_message)
    }

    fn daniel(&self, text: &str, options: &EstimatorOptions, parsed: Option<&OsuFileParser>) -> Result<EstimatorResult, String> {
        let o = self.rework_options(options);
        self.with_parsed(text, parsed, |p| run_daniel_estimator(p, &o, &DanIndexTable)).map(to_result).map_err(error_message)
    }
}
