use leoblack_estimators::{run_mixed, EstimatorDebug, EstimatorOptions, EstimatorResult, MarathonInput, MixedResult, OdFlag, ReworkUpstream, Upstream};
use leoblack_parser::OsuFileParser;

#[derive(Clone, Debug, PartialEq)]
pub enum JsThrow {
    Message(String),
    Unported(String),
}

pub fn js_message(raw: String) -> JsThrow {
    if let Some(rest) = raw.strip_prefix("RangeError: ") {
        return JsThrow::Message(rest.to_string());
    }
    let exact = raw == "Beatmap parse failed"
        || raw == "Beatmap mode is not mania"
        || raw.starts_with("Invalid estimator output")
        || raw.starts_with("Unknown result code: ");
    if exact {
        JsThrow::Message(raw)
    } else {
        JsThrow::Unported(raw)
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum PlayedOd {
    Hr,
    Ez,
    Value(f64),
}

impl PlayedOd {
    pub fn estimator_flag(self) -> OdFlag {
        match self {
            PlayedOd::Hr => OdFlag::Str("HR".into()),
            PlayedOd::Ez => OdFlag::Str("EZ".into()),
            PlayedOd::Value(v) => OdFlag::Num(v),
        }
    }
}

pub fn resolve_played_od(file_od: f64, od_flag: Option<PlayedOd>) -> f64 {
    match od_flag {
        None => file_od,
        Some(PlayedOd::Hr) => 6.462 + (0.715 * file_od),
        Some(PlayedOd::Ez) => -20.761 + (2.566 * file_od),
        Some(PlayedOd::Value(v)) => {
            if v.is_finite() {
                v
            } else {
                file_od
            }
        }
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct LbOptions {
    pub speed_rate: f64,
    pub polaris_rate: Option<f64>,
    pub marathon: Option<MarathonInput>,
    pub od_flag: Option<PlayedOd>,
}

impl LbOptions {
    fn estimator(&self) -> EstimatorOptions<'static> {
        EstimatorOptions {
            speed_rate: Some(self.speed_rate),
            polaris_rate: self.polaris_rate,
            od_flag: self.od_flag.map(PlayedOd::estimator_flag),
            marathon_correction: self.marathon,
            ..Default::default()
        }
    }
}

pub fn run_leoblack_mixed(up: &ReworkUpstream, osu_text: &str, parsed: &OsuFileParser, options: &LbOptions) -> Result<MixedResult, JsThrow> {
    let base = options.estimator();
    let sunny = up.sunny(osu_text, &base, Some(parsed)).map_err(js_message)?;
    let with_sunny = EstimatorOptions { precomputed_sunny_result: Some(&sunny), ..base.clone() };
    let mut result = run_mixed(up, osu_text, &with_sunny, Some(parsed)).map_err(js_message)?;
    result.result.star = sunny.star;
    if let Some(plan) = &result.mixed_companella_plan {
        if let Some(fusion) = &plan.fusion {
            if fusion.on_disagree == leoblack_estimators::OnDisagree::Azusa
                && fusion.rc_numeric.map_or(true, |n| !n.is_finite() || n >= 11.0)
            {
                result.mixed_companella_plan = None;
            }
        }
    }
    Ok(result)
}

pub fn run_leoblack_sunny(
    up: &ReworkUpstream,
    osu_text: &str,
    parsed: &OsuFileParser,
    speed_rate: f64,
    od_flag: Option<PlayedOd>,
) -> Result<EstimatorResult, JsThrow> {
    let options = LbOptions { speed_rate, polaris_rate: None, marathon: None, od_flag }.estimator();
    up.sunny(osu_text, &options, Some(parsed)).map_err(js_message)
}

pub fn chart_sunny_rate_stars(osu_text: &str, parsed: &OsuFileParser, rate: f64) -> Option<f64> {
    let up = ReworkUpstream { spread_arg_limit: leoblack_rework::SPREAD_LIMIT_MAIN_THREAD };
    let star = run_leoblack_sunny(&up, osu_text, parsed, rate, None).ok()?.star;
    (star.is_finite() && star > 0.0).then_some(star)
}

pub fn debug_sunny_numeric(result: &EstimatorResult) -> f64 {
    match &result.debug {
        Some(EstimatorDebug::Azusa(d)) => d.sunny_numeric.unwrap_or(0.0),
        _ => f64::NAN,
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct ParsedDanPart {
    pub label: String,
    pub variant: Option<&'static str>,
    pub raw_dan: f64,
    pub boundary: Option<&'static str>,
}

const RC_TIERS: [&str; 5] = ["low", "mid/low", "mid/high", "mid", "high"];

fn rc_tier_variant(tier: &str) -> Option<&'static str> {
    match tier {
        "low" => Some("--"),
        "mid/low" => Some("-"),
        "mid/high" => Some("+"),
        "high" => Some("++"),
        _ => None,
    }
}

fn rc_tier_offset(tier: &str) -> f64 {
    match tier {
        "low" => -0.4,
        "mid/low" => -0.2,
        "mid/high" => 0.2,
        "high" => 0.4,
        _ => 0.0,
    }
}

fn is_line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

pub fn match_tier<'a>(s: &'a str, tiers: &[&'static str]) -> Option<(&'a str, &'static str)> {
    for (i, c) in s.char_indices() {
        if is_line_terminator(c) {
            return None;
        }
        let end = i + c.len_utf8();
        let rest = &s[end..];
        if let Some(tail) = rest.strip_prefix(' ') {
            if let Some(&tier) = tiers.iter().find(|&&t| t == tail) {
                return Some((&s[..end], tier));
            }
        }
    }
    None
}

fn all_digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

fn greek_level(base_lower: &str) -> Option<f64> {
    Some(match base_lower {
        "alpha" => 11.0,
        "beta" => 12.0,
        "gamma" => 13.0,
        "delta" => 14.0,
        "epsilon" => 15.0,
        "emik zeta" | "zeta" => 16.0,
        "thaumiel eta" | "eta" => 17.0,
        "cloverwisp theta" | "theta" => 18.0,
        "iota" => 19.0,
        "kappa" => 20.0,
        _ => return None,
    })
}

const GREEK_LABELS: [&str; 10] = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa"];

fn normal_label_for_level(level: f64) -> String {
    if level <= 0.0 {
        return "1".into();
    }
    if level <= 10.0 {
        return jsmath::number_to_string(level);
    }
    GREEK_LABELS[(jsmath::min(level, 20.0) - 11.0) as usize].to_string()
}

fn parse_rc_base_level(base: &str) -> Option<f64> {
    if let Some(d) = base.strip_prefix("Intro ") {
        if d.len() == 1 && matches!(d.as_bytes()[0], b'1'..=b'3') {
            return Some((d.as_bytes()[0] - b'0') as f64 - 3.0);
        }
    }
    if let Some(d) = base.strip_prefix("Reform ") {
        if all_digits(d) {
            return Some(jsmath::js_number_from_str(d));
        }
    }
    greek_level(&base.to_lowercase())
}

fn strip_boundary(text: &str) -> (Option<&'static str>, &str) {
    if let Some(rest) = text.strip_prefix("< ") {
        (Some("below"), jsmath::js_trim(rest))
    } else if let Some(rest) = text.strip_prefix("> ") {
        (Some("above"), jsmath::js_trim(rest))
    } else {
        (None, text)
    }
}

fn boundary_variant(boundary: Option<&'static str>) -> Option<Option<&'static str>> {
    match boundary {
        Some("below") => Some(Some("--")),
        Some(_) => Some(Some("++")),
        None => None,
    }
}

pub fn parse_leoblack_rc_half(text: &str, numeric: Option<f64>) -> Option<ParsedDanPart> {
    let (boundary, body) = strip_boundary(text);
    let numeric = numeric.unwrap_or(f64::NAN);
    if let Some((base, tier)) = match_tier(body, &RC_TIERS) {
        if let Some(level) = parse_rc_base_level(base) {
            let raw_dan = match boundary {
                Some("below") => level - 0.5,
                Some(_) => level + 0.5,
                None if numeric.is_finite() => numeric,
                None => level + rc_tier_offset(tier),
            };
            return Some(ParsedDanPart {
                label: normal_label_for_level(level),
                variant: boundary_variant(boundary).unwrap_or_else(|| rc_tier_variant(tier)),
                raw_dan,
                boundary,
            });
        }
    }
    if let Some((base, tier)) = match_tier(body, &["Low", "Mid", "High"]) {
        if let Some(level) = greek_level(&base.to_lowercase()) {
            let raw_dan = match boundary {
                Some("below") => level - 0.5,
                Some(_) => level + 0.5,
                None if numeric.is_finite() => numeric - 0.5,
                None => {
                    level
                        + match tier {
                            "Low" => -1.0 / 3.0,
                            "High" => 1.0 / 3.0,
                            _ => 0.0,
                        }
                }
            };
            let variant = boundary_variant(boundary).unwrap_or(match tier {
                "Low" => Some("-"),
                "High" => Some("+"),
                _ => None,
            });
            return Some(ParsedDanPart { label: normal_label_for_level(level), variant, raw_dan, boundary });
        }
    }
    None
}

fn ln_part_level(base: &str) -> Option<&str> {
    let tail = |s: &'_ str| -> Option<()> { s.strip_prefix("LN ").filter(|d| all_digits(d)).map(|_| ()) };
    if let Some(ws) = base.char_indices().find(|&(_, c)| jsmath::is_js_whitespace(c)) {
        let (i, c) = ws;
        if i > 0 && c == ' ' && tail(&base[i + 1..]).is_some() {
            return Some(&base[i + 1 + 3..]);
        }
    }
    tail(base).map(|_| &base[3..])
}

pub fn parse_leoblack_ln_half(text: &str) -> Option<ParsedDanPart> {
    let (boundary, body) = strip_boundary(text);
    let (base, tier) = match_tier(body, &RC_TIERS)?;
    let digits = ln_part_level(base)?;
    let level = jsmath::js_number_from_str(digits);
    let raw_dan = match boundary {
        Some("below") => level - 0.5,
        Some(_) => level + 0.5,
        None => level + rc_tier_offset(tier),
    };
    Some(ParsedDanPart {
        label: jsmath::number_to_string(level),
        variant: boundary_variant(boundary).unwrap_or_else(|| rc_tier_variant(tier)),
        raw_dan,
        boundary,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verdict_parsers() {
        let p = parse_leoblack_rc_half("Emik Zeta mid/low", None).unwrap();
        assert_eq!((p.label.as_str(), p.variant, p.raw_dan), ("zeta", Some("-"), 15.8));
        let p = parse_leoblack_rc_half("< Intro 1 low", Some(3.0)).unwrap();
        assert_eq!((p.label.as_str(), p.variant, p.raw_dan), ("1", Some("--"), -2.5));
        let p = parse_leoblack_rc_half("Gamma High", Some(13.7)).unwrap();
        assert_eq!((p.label.as_str(), p.variant, p.raw_dan), ("gamma", Some("+"), 13.2));
        let p = parse_leoblack_ln_half("Lnlism LN 12 mid/high").unwrap();
        assert_eq!((p.label.as_str(), p.variant, p.raw_dan), ("12", Some("+"), 12.2));
        let p = parse_leoblack_ln_half("LN 5 low").unwrap();
        assert_eq!(p.label, "5");
        assert!(parse_leoblack_ln_half("A B LN 5 low").is_none());
        assert_eq!(match_tier("Reform 3 mid/high", &RC_TIERS), Some(("Reform 3", "mid/high")));
    }
}
