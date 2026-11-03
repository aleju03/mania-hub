pub mod chart_builder;
pub mod difficulty;

pub use chart_builder::{build_rows_from_parsed, InterludeRow, ParsedNotes};
pub use difficulty::{calculate_interlude_difficulty, interlude_overall, InterludeDifficulty};
pub use leoblack_parser::{OsuFileParser, ParseStatus};

pub fn normalize_rate(rate: f64) -> f64 {
    if !rate.is_finite() || rate <= 0.0 {
        1.0
    } else {
        rate
    }
}

pub fn check_status(status: ParseStatus) -> Result<(), String> {
    match status {
        ParseStatus::NotMania => Err("Beatmap mode is not mania".to_string()),
        ParseStatus::Fail => Err("Beatmap parse failed".to_string()),
        _ => Ok(()),
    }
}

fn normalize_cvt_flag(cvt_flag: Option<&str>) -> Option<&'static str> {
    let normalized = jsmath::js_trim(cvt_flag.unwrap_or("")).to_uppercase();
    match normalized.as_str() {
        "IN" => Some("IN"),
        "HO" => Some("HO"),
        _ => None,
    }
}

fn apply_conversion_flag(parser: &mut OsuFileParser, cvt: Option<&'static str>) {
    match cvt {
        Some("IN") => parser.mod_in(),
        Some("HO") => parser.mod_ho(),
        _ => {}
    }
}

fn star_from_rows(rows: &[InterludeRow], rate: f64) -> Result<f64, String> {
    let overall = interlude_overall(normalize_rate(rate), rows)?;
    Ok(if overall.is_finite() { overall } else { 0.0 })
}

pub fn calculate_interlude_star(osu_text: &str, rate: f64, cvt_flag: Option<&str>) -> Result<f64, String> {
    if !(osu_text.contains("[HitObjects]") && (osu_text.contains('\n') || osu_text.contains('\r'))) {
        return Err("leoblack-interlude: source is not osu! text (the JS would fetch() it)".to_string());
    }
    let resolved_rate = normalize_rate(rate);
    let mut parser = OsuFileParser::parse(osu_text);
    apply_conversion_flag(&mut parser, normalize_cvt_flag(cvt_flag));
    check_status(parser.status)?;
    star_from_rows(&build_rows_from_parsed(&ParsedNotes::from_parser(&parser)), resolved_rate)
}

pub fn calculate_interlude_star_from_parser(parser: &OsuFileParser, rate: f64, cvt_flag: Option<&str>) -> Result<f64, String> {
    let resolved_rate = normalize_rate(rate);
    check_status(parser.status)?;
    let rows = match normalize_cvt_flag(cvt_flag) {
        Some(cvt) => {
            let mut clone = parser.clone();
            apply_conversion_flag(&mut clone, Some(cvt));
            build_rows_from_parsed(&ParsedNotes::from_parser(&clone))
        }
        None => build_rows_from_parsed(&ParsedNotes::from_parser(parser)),
    };
    star_from_rows(&rows, resolved_rate)
}
