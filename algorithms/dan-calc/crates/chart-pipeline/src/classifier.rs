use std::cell::RefCell;
use std::rc::Rc;
use std::sync::OnceLock;

use dan_core::dan_eligibility::{inspect_chart_dan_eligibility, ChartDanEligibility};
use dan_core::features::extract_dan_features;
use dan_core::labels::rate_or_one;
use dan_core::ln::estimate_ln_dan;
use dan_core::ln_effective::chart_is_ln;
use dan_core::patterns::analyze_mania_patterns;
use dan_core::types::{DanEstimateInput, DanFeatureExtractionResult, ManiaPatternAnalysis};
use dan_core::vibro_detection::{detect_ln_vibro, detect_rice_vibro};
use dan_core::vibro_sections::{analyze_collapsed_notes, analyze_stacked_heads, analyze_vibro_sections, analyze_wide_jumptrill, prepare_vibro_chart, uses_section_vibro, VibroAnalysis, VibroStatus};
use dan_core::{parse_mania_beatmap, ManiaBeatmap};
use leoblack_estimators::intervals::{dan_index, IntervalRow};
use leoblack_estimators::{apply_companella_to_mixed_result, CompanellaEstimate, MarathonInput, MixedResult, MsdValues, ReworkUpstream};
use leoblack_parser::OsuFileParser;
use leoblack_patterns::{analyze_pattern_from_text, detect_longjack_vibro_at_rate, PatternReport};
use ln_skill::{resolve_chart_ln_identity, LnIdentityOptions, LnMap};

use crate::leoblack::{
    debug_sunny_numeric, match_tier, parse_leoblack_ln_half, parse_leoblack_rc_half, resolve_played_od, run_leoblack_mixed,
    run_leoblack_sunny, JsThrow, LbOptions, ParsedDanPart, PlayedOd,
};

#[derive(Clone, Debug, PartialEq)]
pub struct Unported(pub String);

#[derive(Clone, Debug, PartialEq)]
pub struct DanVerdictHalf {
    pub kind: &'static str,
    pub source: &'static str,
    pub label: String,
    pub variant: Option<&'static str>,
    pub display_name: String,
    pub raw_dan: f64,
    pub estimated_sr: f64,
    pub confidence: f64,
    pub boundary: Option<&'static str>,
    pub raw: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RcFloor {
    pub text: String,
    pub numeric: f64,
}

#[derive(Clone, Debug, Default)]
pub struct ClassifyInput {
    pub rate: Option<f64>,
    pub star_rating: Option<f64>,
    pub total_length: Option<f64>,
    pub version: String,
    pub marathon_msd_values: Option<MsdValues>,
    pub companella: Option<CompanellaEstimate>,
    pub rc_floor: Option<RcFloor>,
    pub od_flag: Option<PlayedOd>,
    pub adjust_vibro: bool,
    pub file_speed: Option<f64>,
}

impl ClassifyInput {
    pub fn dan_input(&self) -> DanEstimateInput {
        DanEstimateInput {
            star_rating: self.star_rating,
            total_length: self.total_length,
            title: None,
            version: Some(self.version.clone()),
            rate: self.rate,
        }
    }
}

pub struct ChartAnalysis {
    pub warnings: Vec<String>,
    pub features: DanFeatureExtractionResult,
    pub patterns: ManiaPatternAnalysis,
    pub clusters: Option<PatternReport>,
    pub vibro: bool,
    pub vibro_analysis: Option<VibroAnalysis>,
    pub ln_vibro: bool,
    pub dan_eligibility: ChartDanEligibility,
}

pub struct ChartClassification {
    pub key_count: i32,
    pub supported: bool,
    pub ln_ratio: f64,
    pub ln_effective_ratio: Option<f64>,
    pub ln_work_share: Option<f64>,
    pub ln_rice_share: Option<f64>,
    pub ln_rating_identity: bool,
    pub ln_structural_ratio: Option<f64>,
    pub sunny_sr: Option<f64>,
    pub verdict_text: Option<String>,
    pub rc: Option<DanVerdictHalf>,
    pub ln: Option<DanVerdictHalf>,
    pub primary: Option<DanVerdictHalf>,
    pub analysis: Rc<ChartAnalysis>,
    pub companella_pending: bool,
    pub warnings: Vec<String>,
}

pub struct ChartRcClassification {
    pub sunny_sr: Option<f64>,
    pub companella_pending: bool,
    pub rc: Option<(&'static str, String, f64)>,
}

pub struct ChartContext<'a> {
    pub osu_text: &'a str,
    pub map: &'a ManiaBeatmap,
    pub parsed: &'a OsuFileParser,
    pub up: ReworkUpstream,
    mixed_cache: RefCell<Vec<(String, Rc<MixedResult>)>>,
    analysis_cache: RefCell<Vec<(u64, Rc<ChartAnalysis>)>>,
    prepared_cache: RefCell<Vec<(u64, Rc<PreparedChart>)>>,
}

pub struct PreparedChart {
    pub analysis: VibroAnalysis,
    pub adjusted: Option<OwnedChart>,
}

pub struct OwnedChart {
    pub text: String,
    pub map: ManiaBeatmap,
    pub parsed: OsuFileParser,
}

#[derive(Clone, Copy)]
pub struct ChartView<'b> {
    pub text: &'b str,
    pub map: &'b ManiaBeatmap,
    pub parsed: &'b OsuFileParser,
}

impl<'a> ChartContext<'a> {
    pub fn new(osu_text: &'a str, map: &'a ManiaBeatmap, parsed: &'a OsuFileParser) -> Self {
        ChartContext {
            osu_text,
            map,
            parsed,
            up: ReworkUpstream::default(),
            mixed_cache: RefCell::new(Vec::new()),
            analysis_cache: RefCell::new(Vec::new()),
            prepared_cache: RefCell::new(Vec::new()),
        }
    }

    pub fn view(&self) -> ChartView<'_> {
        ChartView { text: self.osu_text, map: self.map, parsed: self.parsed }
    }

    pub fn prepared(&self, input: &ClassifyInput) -> Option<Rc<PreparedChart>> {
        if !input.adjust_vibro {
            return None;
        }
        let rate = rate_or_one(input.rate);
        let key = rate.to_bits();
        if let Some((_, hit)) = self.prepared_cache.borrow().iter().find(|(k, _)| *k == key) {
            return Some(hit.clone());
        }
        let (analysis, text) = prepare_vibro_chart(self.osu_text, rate, self.map);
        let adjusted = text.map(|text| {
            let mut map = parse_mania_beatmap(&text);
            map.total_length = self.map.total_length;
            let parsed = OsuFileParser::parse(&text);
            OwnedChart { text, map, parsed }
        });
        let prepared = Rc::new(PreparedChart { analysis, adjusted });
        self.prepared_cache.borrow_mut().push((key, prepared.clone()));
        Some(prepared)
    }

    pub fn view_of<'b>(&'b self, prepared: &'b Option<Rc<PreparedChart>>) -> ChartView<'b> {
        match prepared.as_deref().and_then(|p| p.adjusted.as_ref()) {
            Some(c) => ChartView { text: &c.text, map: &c.map, parsed: &c.parsed },
            None => self.view(),
        }
    }

    fn mixed_once(&self, chart: ChartView, options: &LbOptions) -> Result<Rc<MixedResult>, JsThrow> {
        let key = format!("{}|{:p}", mixed_key(options), chart.text.as_ptr());
        if let Some((_, hit)) = self.mixed_cache.borrow().iter().find(|(k, _)| *k == key) {
            return Ok(hit.clone());
        }
        let result = Rc::new(run_leoblack_mixed(&self.up, chart.text, chart.parsed, options)?);
        self.mixed_cache.borrow_mut().push((key, result.clone()));
        Ok(result)
    }

    fn analysis_once(&self, input: &ClassifyInput, prepared: Option<&PreparedChart>) -> Result<Rc<ChartAnalysis>, Unported> {
        let key = rate_or_one(input.rate).to_bits();
        if let Some((_, hit)) = self.analysis_cache.borrow().iter().find(|(k, _)| *k == key) {
            return Ok(hit.clone());
        }
        let analysis = Rc::new(analyze_chart_prepared(self.map, self.osu_text, input, prepared));
        self.analysis_cache.borrow_mut().push((key, analysis.clone()));
        Ok(analysis)
    }
}

fn mixed_key(options: &LbOptions) -> String {
    let mut key = format!("{:x}", options.speed_rate.to_bits());
    if let Some(p) = options.polaris_rate {
        key.push_str(&format!("|p{:x}", p.to_bits()));
    }
    match options.od_flag {
        None => {}
        Some(PlayedOd::Hr) => key.push_str("|HR"),
        Some(PlayedOd::Ez) => key.push_str("|EZ"),
        Some(PlayedOd::Value(v)) => key.push_str(&format!("|od{:x}", v.to_bits())),
    }
    if let Some(m) = &options.marathon {
        key.push_str(&format!("|{:x}", m.duration_s.to_bits()));
        if let Some(v) = &m.ett_values {
            for x in [v.overall, v.stream, v.jumpstream, v.handstream, v.stamina, v.jack_speed, v.chordjack, v.technical] {
                key.push_str(&format!(",{:x}", x.to_bits()));
            }
        }
    }
    key
}

const MARATHON_CORRECTION_MIN_DURATION_S: f64 = 300.0;

pub fn chart_note_span_seconds(map: &ManiaBeatmap) -> f64 {
    if map.notes.len() < 2 {
        return 0.0;
    }
    let mut earliest = f64::INFINITY;
    let mut latest = f64::NEG_INFINITY;
    for note in &map.notes {
        if note.time < earliest {
            earliest = note.time;
        }
        if note.time > latest {
            latest = note.time;
        }
    }
    if latest > earliest {
        (latest - earliest) / 1000.0
    } else {
        0.0
    }
}

pub fn is_marathon_correction_candidate(map: &ManiaBeatmap) -> bool {
    map.key_count == 4 && chart_note_span_seconds(map) > MARATHON_CORRECTION_MIN_DURATION_S
}

pub fn analyze_chart(map: &ManiaBeatmap, osu_text: &str, input: &ClassifyInput) -> ChartAnalysis {
    if !input.adjust_vibro {
        return analyze_chart_prepared(map, osu_text, input, None);
    }
    let (analysis, text) = prepare_vibro_chart(osu_text, rate_or_one(input.rate), map);
    let adjusted = text.map(|text| {
        let mut adjusted_map = parse_mania_beatmap(&text);
        adjusted_map.total_length = map.total_length;
        let parsed = OsuFileParser::parse(&text);
        OwnedChart { text, map: adjusted_map, parsed }
    });
    analyze_chart_prepared(map, osu_text, input, Some(&PreparedChart { analysis, adjusted }))
}

fn analyze_chart_prepared(map: &ManiaBeatmap, osu_text: &str, input: &ClassifyInput, prepared: Option<&PreparedChart>) -> ChartAnalysis {
    let rate = rate_or_one(input.rate);
    let mut warnings = Vec::new();
    let dan_eligibility = inspect_chart_dan_eligibility(map);
    let section_vibro = uses_section_vibro(map);
    let vibro_analysis = if section_vibro {
        Some(match prepared {
            Some(p) => p.analysis.clone(),
            None => analyze_vibro_sections(map, rate),
        })
    } else {
        analyze_stacked_heads(map, rate)
            .or_else(|| analyze_wide_jumptrill(map, rate))
            .or_else(|| analyze_collapsed_notes(map, rate))
            .or_else(|| prism::mash_exclusion::analyze_prism_mash(map, rate))
    };
    let (map, osu_text) = match prepared.and_then(|p| p.adjusted.as_ref()) {
        Some(adjusted) => {
            warnings.push(format!(
                "Adjusted rating: {}s of vibro excluded; remaining patterns rated at their original timestamps.",
                jsmath::to_fixed(prepared.map_or(0.0, |p| p.analysis.excluded_duration_ms) / 1000.0, 1)
            ));
            (&adjusted.map, adjusted.text.as_str())
        }
        None => (map, osu_text),
    };
    if !dan_eligibility.eligible {
        warnings.push(format!(
            "Player dan disabled: {} objects share one column and head time.",
            jsmath::number_to_string(dan_eligibility.max_same_column_head_stack)
        ));
    }
    let dan_input = input.dan_input();
    let features = extract_dan_features(map, &dan_input, rate);
    let patterns = analyze_mania_patterns(map, &dan_input, Some(&features), &ln_skill::ln_skillsets_for_patterns);
    let clusters = match analyze_pattern_from_text(osu_text) {
        Ok(report) => Some(report),
        Err(message) => {
            warnings.push(format!("Pattern clustering failed: {message}."));
            None
        }
    };
    let longjack_vibro = !section_vibro && clusters.is_some() && detect_longjack_vibro_at_rate(clusters.as_ref(), rate);
    let ln_vibro = detect_ln_vibro(map, rate);
    let rice_vibro = match &vibro_analysis {
        Some(a) => a.status == VibroStatus::Excluded,
        None => detect_rice_vibro(map, rate),
    };
    let vibro = longjack_vibro || ln_vibro || rice_vibro;
    if ln_vibro {
        warnings.push("Staggered LN-spam (vibro) detected; LN difficulty is likely overestimated.".into());
    }
    ChartAnalysis { warnings, features, patterns, clusters, vibro, vibro_analysis, ln_vibro, dan_eligibility }
}

const ROXY_RAW_FLOOR_PIN: f64 = -2.45;
const SUNNY_LOW_END_MAX_STAR: f64 = 3.0;
const AZUSA_SUSPECT_MIN_NUMERIC: f64 = 2.0;
const AZUSA_SUNNY_REFERENCE_MAX_NUMERIC: f64 = 6.84;

fn is_roxy_floor_pinned(mixed: &MixedResult) -> bool {
    if mixed.result.numeric_difficulty_hint.as_deref() != Some("roxy-meta-ridge-v3") {
        return false;
    }
    let raw = mixed.result.raw_numeric_difficulty.unwrap_or(f64::NAN);
    raw.is_finite() && raw <= ROXY_RAW_FLOOR_PIN
}

fn is_azusa_low_end_suspect(mixed: &MixedResult) -> bool {
    if mixed.result.numeric_difficulty_hint.as_deref() != Some("azusa-rc-v1") {
        return false;
    }
    let numeric = mixed.result.numeric_difficulty.unwrap_or(0.0);
    if !numeric.is_finite() || numeric < AZUSA_SUSPECT_MIN_NUMERIC {
        return false;
    }
    let reference = debug_sunny_numeric(&mixed.result);
    reference.is_finite() && reference < AZUSA_SUNNY_REFERENCE_MAX_NUMERIC
}

fn sunny_low_end_reroute(
    up: &ReworkUpstream,
    osu_text: &str,
    parsed: &OsuFileParser,
    mixed: &MixedResult,
    rate: f64,
    od_flag: Option<PlayedOd>,
) -> Result<Option<(f64, f64, String)>, JsThrow> {
    if !is_roxy_floor_pinned(mixed) && !is_azusa_low_end_suspect(mixed) {
        return Ok(None);
    }
    let sunny = run_leoblack_sunny(up, osu_text, parsed, rate, od_flag)?;
    Ok(if sunny.star < SUNNY_LOW_END_MAX_STAR { Some((sunny.star, sunny.ln_ratio, sunny.est_diff)) } else { None })
}

pub fn split_verdict(verdict: &str) -> (String, Option<String>) {
    let parts: Vec<&str> = verdict.split("||").map(jsmath::js_trim).filter(|p| !p.is_empty()).collect();
    let rc = parts.first().map_or(String::new(), |s| s.to_string());
    let ln = if parts.len() >= 2 { Some(parts[parts.len() - 1].to_string()) } else { None };
    (rc, ln)
}

fn apply_rc_floor(mut mixed: MixedResult, floor: Option<&RcFloor>) -> MixedResult {
    let numeric = mixed.result.numeric_difficulty.unwrap_or(f64::NAN);
    let Some(floor) = floor else { return mixed };
    if !numeric.is_finite() || floor.numeric <= numeric {
        return mixed;
    }
    let (_, ln_text) = split_verdict(&mixed.result.est_diff);
    mixed.result.est_diff = match ln_text {
        Some(ln) => format!("{} || {}", floor.text, ln),
        None => floor.text.clone(),
    };
    mixed.result.numeric_difficulty = Some(floor.numeric);
    mixed.result.numeric_difficulty_hint = None;
    mixed
}

fn starts_with_word_ci(s: &str, word: &str) -> bool {
    let n = word.len();
    if s.len() < n || !s.is_char_boundary(n) || !s[..n].eq_ignore_ascii_case(word) {
        return false;
    }
    !s[n..].chars().next().map_or(false, |c| c.is_ascii_alphanumeric() || c == '_')
}

fn verdict_usable(verdict: &str) -> bool {
    !verdict.is_empty() && !starts_with_word_ci(verdict, "Invalid") && !starts_with_word_ci(verdict, "Unknown")
}

fn resolve_mixed_verdict(
    ctx: &ChartContext,
    chart: ChartView,
    up: &ReworkUpstream,
    cached: bool,
    input: &ClassifyInput,
    rate: f64,
    warnings: &mut Vec<String>,
) -> Result<(Option<MixedResult>, bool), Unported> {
    let fail = |throw: JsThrow, warnings: &mut Vec<String>| match throw {
        JsThrow::Message(m) => {
            warnings.push(format!("LeoBlack estimator failed: {m}."));
            Ok((None, false))
        }
        JsThrow::Unported(m) => Err(Unported(m)),
    };
    let marathon = match &input.marathon_msd_values {
        Some(values) if is_marathon_correction_candidate(chart.map) => {
            Some(MarathonInput { duration_s: chart_note_span_seconds(chart.map), ett_values: Some(*values) })
        }
        _ => None,
    };
    let file_speed = input.file_speed.filter(|s| s.is_finite() && *s > 1.0).unwrap_or(1.0);
    let polaris_rate = (file_speed > 1.0).then(|| rate * file_speed);
    let options = LbOptions { speed_rate: rate, polaris_rate, marathon, od_flag: input.od_flag };
    let raw = if cached {
        ctx.mixed_once(chart, &options)
    } else {
        run_leoblack_mixed(up, chart.text, chart.parsed, &options).map(Rc::new)
    };
    let raw = match raw {
        Ok(r) => r,
        Err(throw) => return fail(throw, warnings),
    };
    let valid_companella = input.companella.as_ref().map_or(false, |c| c.numeric_difficulty.is_finite());
    let mut companella_applied = valid_companella && raw.mixed_companella_plan.is_some();
    let candidate = match (&input.companella, valid_companella) {
        (Some(c), true) => apply_companella_to_mixed_result(&raw, &c.verdict()),
        _ => (*raw).clone(),
    };
    let candidate_differs = raw.mixed_companella_plan.is_some() && candidate.mixed_companella_plan.is_none();
    let reroute = match sunny_low_end_reroute(up, chart.text, chart.parsed, &raw, rate, input.od_flag) {
        Ok(Some(r)) => Some(r),
        Ok(None) if candidate_differs => match sunny_low_end_reroute(up, chart.text, chart.parsed, &candidate, rate, input.od_flag) {
            Ok(r) => r,
            Err(throw) => return fail(throw, warnings),
        },
        Ok(None) => None,
        Err(throw) => return fail(throw, warnings),
    };
    let mixed = if let Some((star, ln_ratio, est_diff)) = reroute {
        let mut m = candidate;
        m.result.star = star;
        m.result.ln_ratio = ln_ratio;
        m.result.est_diff = est_diff;
        m.result.numeric_difficulty = None;
        m.result.numeric_difficulty_hint = None;
        m.mixed_companella_plan = None;
        companella_applied = false;
        warnings.push(if is_roxy_floor_pinned(&raw) {
            "Roxy raw difficulty pinned at its scale floor; using the Sunny low-end verdict.".into()
        } else {
            "Azusa low-end verdict contradicts its own Sunny reference; using the Sunny low-end verdict.".into()
        });
        m
    } else {
        apply_rc_floor(candidate, if companella_applied { input.rc_floor.as_ref() } else { None })
    };
    Ok((Some(mixed), companella_applied))
}

fn to_half(parsed: &ParsedDanPart, kind: &'static str, source: &'static str, estimated_sr: f64, confidence: f64, raw: &str) -> DanVerdictHalf {
    DanVerdictHalf {
        kind,
        source,
        label: parsed.label.clone(),
        variant: parsed.variant,
        display_name: format!("{}{}", parsed.label, parsed.variant.unwrap_or("")),
        raw_dan: jsmath::round(parsed.raw_dan * 100.0) / 100.0,
        estimated_sr,
        confidence,
        boundary: parsed.boundary,
        raw: raw.to_string(),
    }
}

const TABLE_TIERS: [&str; 5] = ["low", "mid/low", "mid/high", "mid", "high"];

fn table_levels(table: &'static [IntervalRow]) -> &'static [(String, f64)] {
    static CACHE: OnceLock<std::sync::Mutex<Vec<(usize, &'static [(String, f64)])>>> = OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);
    let id = table.as_ptr() as usize;
    let mut guard = cache.lock().unwrap();
    if let Some((_, levels)) = guard.iter().find(|(k, _)| *k == id) {
        return levels;
    }
    let mut levels: Vec<(String, f64)> = Vec::new();
    let mut last_numeric = 0.0;
    for &(_, _, name) in table {
        let base = match_tier(name, &TABLE_TIERS).map_or(name, |(b, _)| b);
        if levels.iter().any(|(b, _)| b == base) {
            continue;
        }
        let digits = base.len() - base.bytes().rev().take_while(|b| b.is_ascii_digit()).count();
        if digits < base.len() {
            last_numeric = jsmath::js_number_from_str(&base[digits..]);
        } else {
            last_numeric += 1.0;
        }
        levels.push((base.to_string(), last_numeric));
    }
    let leaked: &'static [(String, f64)] = Box::leak(levels.into_boxed_slice());
    guard.push((id, leaked));
    leaked
}

fn leading_ws(s: &str) -> usize {
    s.len() - s.trim_start_matches(jsmath::is_js_whitespace).len()
}

fn table_label_for_base(base: &str) -> String {
    let mut s = base;
    for word in ["Regular", "LN"] {
        if let Some(rest) = s.strip_prefix(word) {
            let ws = leading_ws(rest);
            if ws > 0 {
                s = &rest[ws..];
                break;
            }
        }
    }
    let word = s.len() - s.trim_start_matches(|c: char| !jsmath::is_js_whitespace(c)).len();
    if word > 0 {
        let rest = &s[word..];
        let ws = leading_ws(rest);
        if ws > 0 {
            if let Some(after) = rest[ws..].strip_prefix("LN") {
                let ws2 = leading_ws(after);
                if ws2 > 0 {
                    s = &after[ws2..];
                }
            }
        }
    }
    s.to_lowercase()
}

fn tier_variant(tier: &str) -> Option<&'static str> {
    match tier {
        "low" => Some("--"),
        "mid/low" => Some("-"),
        "mid/high" => Some("+"),
        "high" => Some("++"),
        _ => None,
    }
}

fn tier_offset(tier: &str) -> f64 {
    match tier {
        "low" => -0.4,
        "mid/low" => -0.2,
        "mid/high" => 0.2,
        "high" => 0.4,
        _ => 0.0,
    }
}

fn parse_table_half(text: &str, table: &'static [IntervalRow]) -> Option<ParsedDanPart> {
    let mut boundary = None;
    let mut body = jsmath::js_trim(text);
    if let Some(rest) = body.strip_prefix("< ") {
        boundary = Some("below");
        body = jsmath::js_trim(rest);
    } else if let Some(rest) = body.strip_prefix("> ") {
        boundary = Some("above");
        body = jsmath::js_trim(rest);
    }
    let (base, tier) = match_tier(body, &TABLE_TIERS)?;
    let (entry_base, level) = table_levels(table).iter().find(|(b, _)| b == base)?;
    Some(ParsedDanPart {
        label: table_label_for_base(entry_base),
        variant: match boundary {
            Some("below") => Some("--"),
            Some(_) => Some("++"),
            None => tier_variant(tier),
        },
        raw_dan: match boundary {
            Some("below") => level - 0.5,
            Some(_) => level + 0.5,
            None => level + tier_offset(tier),
        },
        boundary,
    })
}

pub fn classify_chart(ctx: &ChartContext, input: &ClassifyInput) -> Result<ChartClassification, Unported> {
    let rate = rate_or_one(input.rate);
    let prepared = ctx.prepared(input);
    let analysis = ctx.analysis_once(input, prepared.as_deref())?;
    let chart = ctx.view_of(&prepared);
    let map = chart.map;
    let mut warnings = analysis.warnings.clone();
    let (mixed, companella_applied) = resolve_mixed_verdict(ctx, chart, &ctx.up, true, input, rate, &mut warnings)?;

    let verdict_text = mixed.as_ref().map(|m| jsmath::js_trim(&m.result.est_diff).to_string());
    let usable = verdict_text.as_deref().map_or(false, verdict_usable);
    let ln_ratio = match &mixed {
        Some(m) if m.result.ln_ratio.is_finite() => m.result.ln_ratio,
        _ => analysis.features.metrics.hold_ratio,
    };
    let kc = map.key_count;
    let ln_identity = if kc == 4 {
        Some(resolve_chart_ln_identity(
            &LnMap { notes: &map.notes, key_count: kc, od: map.od },
            &LnIdentityOptions {
                rate,
                od: Some(resolve_played_od(map.od, input.od_flag)),
                hold_ratio: Some(ln_ratio),
                overall: input.marathon_msd_values.as_ref().map(|v| v.overall),
            },
        ))
    } else {
        None
    };
    let ln_effective_ratio = ln_identity.and_then(|l| l.ln_effective_ratio);
    let chart_reads_ln = chart_is_ln(Some(kc as f64), Some(ln_ratio), ln_effective_ratio) == Some(true);
    let sunny_sr = mixed.as_ref().map(|m| m.result.star).filter(|s| s.is_finite());

    let vibro = analysis.vibro;
    let rc_confidence = if vibro { 0.35 } else { 0.72 };
    if vibro {
        warnings.push("Vibro detected; ordinary difficulty estimates are unreliable.".into());
    }

    let mut rc: Option<DanVerdictHalf> = None;
    let mut ln_from_tables: Option<DanVerdictHalf> = None;
    let sr = sunny_sr.unwrap_or(0.0);
    if let (true, Some(m)) = (usable, &mixed) {
        let (rc_text, ln_text) = split_verdict(verdict_text.as_deref().unwrap());
        if kc == 4 {
            if let Some(p) = parse_leoblack_rc_half(&rc_text, m.result.numeric_difficulty) {
                let source = if companella_applied { "leoblack-companella" } else { "leoblack-mixed" };
                rc = Some(to_half(&p, "rc", source, sr, if p.boundary.is_some() { 0.4 } else { rc_confidence }, &rc_text));
            }
            if let Some(ln_text) = &ln_text {
                if let Some(p) = parse_leoblack_ln_half(ln_text) {
                    ln_from_tables =
                        Some(to_half(&p, "ln", "leoblack-sunny-table", sr, if p.boundary.is_some() { 0.4 } else { 0.6 }, ln_text));
                }
            }
            if m.mixed_companella_plan.is_some() {
                warnings.push(
                    "RC estimate below 9 stars wants Companella, which was not supplied; showing the unrefined estimate.".into(),
                );
            }
        } else if kc == 6 || kc == 7 {
            let tables = dan_index(kc as f64);
            if let Some(t) = &tables {
                if let Some(p) = parse_table_half(&rc_text, t.rc_default) {
                    rc = Some(to_half(&p, "rc", "leoblack-sunny-table", sr, if p.boundary.is_some() { 0.35 } else { 0.55 }, &rc_text));
                }
                if let (Some(ln_text), Some(ln_table)) = (&ln_text, t.ln_default) {
                    if let Some(p) = parse_table_half(ln_text, ln_table) {
                        ln_from_tables = Some(to_half(
                            &p,
                            "ln",
                            "leoblack-sunny-table",
                            sr,
                            if p.boundary.is_some() { 0.35 } else { 0.55 },
                            ln_text,
                        ));
                    }
                }
            }
        }
    }

    let mut ln = ln_from_tables.clone().filter(|h| h.boundary != Some("below"));
    if ln.is_none() && kc == 4 {
        let base_star = match input.star_rating {
            Some(s) if s.is_finite() => jsmath::max(0.0, s),
            _ => 0.0,
        };
        let star = if base_star > 0.0 { base_star * jsmath::pow(rate, 0.7) } else { 0.0 };
        let dan_input = input.dan_input();
        if let Some(e) = estimate_ln_dan(map, &dan_input, &analysis.features.metrics, star, analysis.features.duration_ms, rate, true) {
            ln = Some(DanVerdictHalf {
                kind: "ln",
                source: "inhouse-ln-knn",
                label: e.label.clone(),
                variant: e.variant,
                display_name: format!("{}{}", e.label, e.variant.unwrap_or("")),
                raw_dan: e.raw_dan,
                estimated_sr: e.estimated_sr,
                confidence: e.confidence,
                boundary: None,
                raw: e.display_name.clone(),
            });
        }
    }
    if ln.is_none() {
        ln = ln_from_tables;
    }
    if analysis.ln_vibro {
        if let Some(h) = &mut ln {
            h.confidence = jsmath::min(h.confidence, 0.35);
        }
    }
    let primary = if chart_reads_ln && ln.is_some() { ln.clone() } else { rc.clone().or_else(|| ln.clone()) };

    Ok(ChartClassification {
        key_count: kc,
        supported: primary.is_some(),
        ln_ratio,
        ln_effective_ratio,
        ln_work_share: ln_identity.and_then(|l| l.ln_work_share),
        ln_rice_share: ln_identity.and_then(|l| l.ln_rice_share),
        ln_rating_identity: ln_identity.map_or(false, |l| l.ln_rating_identity),
        ln_structural_ratio: ln_identity.and_then(|l| l.ln_structural_ratio),
        sunny_sr,
        verdict_text,
        rc,
        ln,
        primary,
        companella_pending: mixed.as_ref().map_or(false, |m| m.mixed_companella_plan.is_some()),
        analysis,
        warnings,
    })
}

pub fn classify_chart_rc(ctx: &ChartContext, input: &ClassifyInput) -> Result<ChartRcClassification, Unported> {
    let rate = rate_or_one(input.rate);
    let prepared = ctx.prepared(input);
    let chart = ctx.view_of(&prepared);
    let mut warnings = Vec::new();
    let (mixed, companella_applied) = resolve_mixed_verdict(ctx, chart, &ctx.up, true, input, rate, &mut warnings)?;
    let verdict = mixed.as_ref().map_or(String::new(), |m| jsmath::js_trim(&m.result.est_diff).to_string());
    let (rc_text, _) = split_verdict(&verdict);
    let parsed = if chart.map.key_count == 4 && !verdict.is_empty() && !starts_with_word_ci(&verdict, "Invalid") && !starts_with_word_ci(&verdict, "Unknown") {
        parse_leoblack_rc_half(&rc_text, mixed.as_ref().and_then(|m| m.result.numeric_difficulty))
    } else {
        None
    };
    Ok(ChartRcClassification {
        sunny_sr: mixed.as_ref().map(|m| m.result.star).filter(|s| s.is_finite()),
        companella_pending: mixed.as_ref().map_or(false, |m| m.mixed_companella_plan.is_some()),
        rc: parsed.map(|p| {
            (
                if companella_applied { "leoblack-companella" } else { "leoblack-mixed" },
                rc_text.clone(),
                jsmath::round(p.raw_dan * 100.0) / 100.0,
            )
        }),
    })
}

pub fn classify_chart_ln_table_half(ctx: &ChartContext) -> Result<Option<(String, String, f64)>, Unported> {
    if ctx.map.key_count != 4 {
        return Ok(None);
    }
    let up = ReworkUpstream { spread_arg_limit: leoblack_rework::SPREAD_LIMIT_MAIN_THREAD };
    let input = ClassifyInput::default();
    let (mixed, _) = resolve_mixed_verdict(ctx, ctx.view(), &up, false, &input, 1.0, &mut Vec::new())?;
    let verdict = mixed.as_ref().map_or(String::new(), |m| jsmath::js_trim(&m.result.est_diff).to_string());
    if !verdict_usable(&verdict) {
        return Ok(None);
    }
    let (_, ln_text) = split_verdict(&verdict);
    let Some(ln_text) = ln_text else { return Ok(None) };
    let Some(parsed) = parse_leoblack_ln_half(&ln_text) else { return Ok(None) };
    if parsed.boundary == Some("below") {
        return Ok(None);
    }
    let half = to_half(&parsed, "ln", "leoblack-sunny-table", mixed.as_ref().map_or(0.0, |m| m.result.star), 0.6, &ln_text);
    Ok(Some((half.label, half.display_name, half.raw_dan)))
}
