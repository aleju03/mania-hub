use crate::polaris::calibrate_rc_half;
use crate::azusa::run_azusa;
use crate::jsnum::{js_trim, round_fixed};
use crate::marathon::compute_marathon_correction;
use crate::rc_format::numeric_to_rc_label;
use crate::roxy::run_roxy;
use crate::types::{CompanellaFusion, CompanellaPlan, EstimatorDebug, EstimatorOptions, EstimatorResult, MixedResult, OnDisagree, Upstream, Xdc1Candidate};
use crate::xdc1::run_xdc1;

const RC_AZUSA_COMPANELLA_FUSION_WEIGHT: f64 = 0.5;
const LOW_BAND_COMPANELLA_STAR_MAX: f64 = 9.0;
const RC_FUSION_LOW_BAND_MAX: f64 = 11.0;
const BALANCED_HAND_SCREEN_MAX_BIAS: f64 = 0.006;
const BALANCED_HAND_MAX_BIAS: f64 = 0.003;
const AZUSA_HIGHER_SCREEN_MIN_DELTA: f64 = 0.25;
const AZUSA_HIGHER_MIN_DELTA: f64 = 0.4;
const ANCHOR_HEAVY_SCREEN_MIN_RATE: f64 = 0.72;
const ANCHOR_HEAVY_MIN_RATE: f64 = 0.78;
const AZUSA_LOWER_SCREEN_MAX_DELTA: f64 = -0.55;
const AZUSA_LOWER_MAX_DELTA: f64 = -0.7;
const XDC1_RC_OVERRIDE_MIN_DELTA: f64 = 0.5;
const XDC1_RC_FUSION_WEIGHT: f64 = 0.5;

pub fn mode_tag_from_ln_ratio(ln_ratio: f64) -> &'static str {
    if !ln_ratio.is_finite() {
        return "Mix";
    }
    if ln_ratio <= 0.15 {
        return "RC";
    }
    if ln_ratio >= 0.9 {
        return "LN";
    }
    "Mix"
}

fn split_difficulty_parts(value: &str) -> (String, String) {
    let text = js_trim(value);
    if text.is_empty() {
        return ("-".into(), "-".into());
    }
    let parts: Vec<&str> = text.split("||").map(js_trim).filter(|p| !p.is_empty()).collect();
    if parts.len() >= 2 {
        return (parts[0].to_string(), parts[1].to_string());
    }
    let one = parts.first().copied().unwrap_or(text).to_string();
    (one.clone(), one)
}

pub fn compose_difficulty_from_rc_ln(rc_label: &str, ln_label: &str, ln_ratio: f64) -> String {
    let rc = js_trim(rc_label);
    let ln = js_trim(ln_label);
    if !ln_ratio.is_finite() || ln_ratio < 0.15 {
        return if !rc.is_empty() { rc.into() } else if !ln.is_empty() { ln.into() } else { "-".into() };
    }
    if rc.is_empty() {
        return if ln.is_empty() { "-".into() } else { ln.into() };
    }
    if ln.is_empty() {
        return rc.into();
    }
    format!("{rc} || {ln}")
}

fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

fn starts_with_word_ci(text: &str, word: &str) -> bool {
    let mut chars = text.chars();
    for w in word.chars() {
        match chars.next() {
            Some(c) if c.to_ascii_lowercase() == w => {}
            _ => return false,
        }
    }
    !chars.next().map_or(false, is_word)
}

pub fn is_daniel_too_low_difficulty(value: &str) -> bool {
    let text = js_trim(value);
    let Some(rest) = text.strip_prefix('<') else {
        return false;
    };
    starts_with_word_ci(rest.trim_start_matches(crate::jsnum::is_js_space), "alpha")
}

fn is_invalid_label(est_diff: &str) -> bool {
    starts_with_word_ci(est_diff, "invalid")
}

fn can_use_rc_result(result: Option<&EstimatorResult>) -> bool {
    let Some(r) = result else {
        return false;
    };
    if r.column_count != 4.0 {
        return false;
    }
    let est = js_trim(&r.est_diff);
    if est.is_empty() || is_invalid_label(est) {
        return false;
    }
    r.numeric_difficulty.is_some()
}

fn result_numeric_value(result: &EstimatorResult) -> Option<f64> {
    result.numeric_difficulty.filter(|v| v.is_finite())
}

fn xdc1_rc_preview<U: Upstream>(up: &U, osu_text: &str, options: &EstimatorOptions, parsed: Option<&U::Parsed>) -> Option<EstimatorResult> {
    let r = run_xdc1(up, osu_text, options, parsed).ok()?;
    if r.column_count != 4.0 {
        return None;
    }
    let est = js_trim(&r.est_diff);
    if est.is_empty() || starts_with_word_ci(est, "invalid") || starts_with_word_ci(est, "unsupported") {
        return None;
    }
    result_numeric_value(&r)?;
    Some(r)
}

fn has_active_marathon_correction(options: &EstimatorOptions, base_numeric: f64) -> bool {
    let Some(mc) = &options.marathon_correction else {
        return false;
    };
    if !mc.duration_s.is_finite() {
        return false;
    }
    compute_marathon_correction(mc.duration_s, mc.ett_values.as_ref(), Some(base_numeric)) > 0.0
}

fn is_delta_at_least(delta: f64, threshold: f64) -> bool {
    if !delta.is_finite() || !threshold.is_finite() {
        return false;
    }
    jsmath::round(delta * 1e4) >= jsmath::round(threshold * 1e4)
}

struct RcOutcome {
    selected: EstimatorResult,
    actual: &'static str,
    est_diff: String,
    numeric: Option<f64>,
    hint: Option<String>,
}

fn fused_rc_outcome(base: &EstimatorResult, xdc1_numeric: f64, base_numeric: f64, actual: &'static str) -> RcOutcome {
    let fused = round_fixed(xdc1_numeric * XDC1_RC_FUSION_WEIGHT + base_numeric * (1.0 - XDC1_RC_FUSION_WEIGHT), 2);
    RcOutcome { selected: base.clone(), actual, est_diff: numeric_to_rc_label(fused), numeric: Some(fused), hint: None }
}

fn resolve_roxy_xdc1<U: Upstream>(up: &U, osu_text: &str, options: &EstimatorOptions, parsed: Option<&U::Parsed>, roxy: &EstimatorResult) -> Option<RcOutcome> {
    let roxy_numeric = result_numeric_value(roxy)?;
    if has_active_marathon_correction(options, roxy_numeric) {
        return None;
    }
    let preview = xdc1_rc_preview(up, osu_text, options, parsed)?;
    let xdc1_numeric = result_numeric_value(&preview)?;
    Some(fused_rc_outcome(roxy, xdc1_numeric, roxy_numeric, "Roxy+XDC1"))
}

fn resolve_high_azusa_xdc1<U: Upstream>(up: &U, osu_text: &str, options: &EstimatorOptions, parsed: Option<&U::Parsed>, azusa: &EstimatorResult) -> Option<RcOutcome> {
    let azusa_numeric = result_numeric_value(azusa)?;
    if azusa_numeric < RC_FUSION_LOW_BAND_MAX || has_active_marathon_correction(options, azusa_numeric) {
        return None;
    }
    let preview = xdc1_rc_preview(up, osu_text, options, parsed)?;
    Some(fused_rc_outcome(azusa, result_numeric_value(&preview)?, azusa_numeric, "XDC1+Azusa"))
}

fn roxy_reference_daniel(roxy: &EstimatorResult) -> Option<&EstimatorResult> {
    roxy_debug(roxy).and_then(|d| d.reference_daniel_result.as_ref())
}

fn roxy_debug(result: &EstimatorResult) -> Option<&crate::roxy::RoxyDebug> {
    match &result.debug {
        Some(EstimatorDebug::Roxy(d)) => Some(d),
        _ => None,
    }
}

fn roxy_unquantized_numeric(result: &EstimatorResult) -> Option<f64> {
    if let Some(v) = roxy_debug(result).and_then(|d| d.final_numeric_fmt4()) {
        return Some(v);
    }
    result_numeric_value(result)
}

fn debug_hand_bias(result: &EstimatorResult) -> Option<f64> {
    roxy_debug(result).and_then(|d| d.hand_bias_fmt4())
}

fn debug_anchor_rate(result: &EstimatorResult) -> Option<f64> {
    roxy_debug(result).and_then(|d| d.anchor_rate_fmt4())
}

fn debug_reference_azusa(result: &EstimatorResult) -> Option<f64> {
    roxy_debug(result).and_then(|d| d.reference_azusa_fmt4())
}

fn should_evaluate_azusa_rc_preference(roxy: &EstimatorResult) -> bool {
    if !can_use_rc_result(Some(roxy)) {
        return false;
    }
    let (Some(roxy_numeric), Some(azusa_ref)) = (roxy_unquantized_numeric(roxy), debug_reference_azusa(roxy)) else {
        return false;
    };
    let hand_bias = debug_hand_bias(roxy);
    let anchor_rate = debug_anchor_rate(roxy);
    let delta = azusa_ref - roxy_numeric;
    let balanced = matches!(hand_bias, Some(h) if h <= BALANCED_HAND_SCREEN_MAX_BIAS) && delta >= AZUSA_HIGHER_SCREEN_MIN_DELTA;
    let anchor = matches!(anchor_rate, Some(a) if a >= ANCHOR_HEAVY_SCREEN_MIN_RATE) && delta <= AZUSA_LOWER_SCREEN_MAX_DELTA;
    let crossing = roxy_numeric >= 11.0 && azusa_ref < 11.0;
    balanced || anchor || crossing
}

pub fn should_prefer_azusa_rc_result(roxy: &EstimatorResult, azusa: Option<&EstimatorResult>) -> bool {
    if !can_use_rc_result(Some(roxy)) || !can_use_rc_result(azusa) {
        return false;
    }
    let azusa = azusa.unwrap();
    let (Some(roxy_numeric), Some(azusa_numeric)) = (roxy_unquantized_numeric(roxy), result_numeric_value(azusa)) else {
        return false;
    };
    let hand_bias = debug_hand_bias(roxy);
    let anchor_rate = debug_anchor_rate(roxy);
    let delta = azusa_numeric - roxy_numeric;
    let lift = matches!(hand_bias, Some(h) if h <= BALANCED_HAND_MAX_BIAS) && delta >= AZUSA_HIGHER_MIN_DELTA;
    let damp = matches!(anchor_rate, Some(a) if a >= ANCHOR_HEAVY_MIN_RATE) && delta <= AZUSA_LOWER_MAX_DELTA;
    let crossing = roxy_numeric >= 11.0 && azusa_numeric < 11.0;
    lift || damp || crossing
}

fn low_band_plan(rc: &EstimatorResult, ln_ratio: f64, ln_difficulty: &str, on_disagree: OnDisagree, xdc1_candidate: Option<Xdc1Candidate>) -> CompanellaPlan {
    CompanellaPlan {
        ln_ratio,
        ln_difficulty: ln_difficulty.to_string(),
        fusion: Some(CompanellaFusion {
            on_disagree,
            rc_est_diff: rc.est_diff.clone(),
            rc_numeric: result_numeric_value(rc),
            rc_numeric_hint: rc.numeric_difficulty_hint.clone(),
            xdc1_candidate,
        }),
    }
}

fn sunny_passthrough(sunny: &EstimatorResult) -> MixedResult {
    MixedResult { result: sunny.clone(), mixed_companella_plan: None, actual_estimator_algorithm: "Sunny", companella_capsule: None }
}

pub fn run_mixed<U: Upstream>(up: &U, osu_text: &str, options: &EstimatorOptions, parsed: Option<&U::Parsed>) -> Result<MixedResult, String> {
    let owned_sunny;
    let sunny: &EstimatorResult = match options.precomputed_sunny_result {
        Some(s) => s,
        None => {
            owned_sunny = up.sunny(osu_text, options, parsed)?;
            &owned_sunny
        }
    };
    let mut actual = "Sunny";
    let column_count = sunny.column_count;
    if !column_count.is_finite() || !(column_count == 4.0 || column_count == 6.0 || column_count == 7.0) {
        return Ok(sunny_passthrough(sunny));
    }
    let cvt_upper = options.cvt_flag.as_deref().unwrap_or("").to_uppercase();
    let in_enabled = cvt_upper.contains("IN");
    let ho_enabled = cvt_upper.contains("HO");
    let has_explicit_od = options.od_flag.is_some();
    let mode_tag = if ho_enabled { "RC" } else { mode_tag_from_ln_ratio(sunny.ln_ratio) };
    let (sunny_rc, sunny_ln) = split_difficulty_parts(&sunny.est_diff);
    let ln_ratio = sunny.ln_ratio;
    let ln_difficulty = sunny_ln;
    let rate = options.polaris_rate.or(options.speed_rate).unwrap_or(1.0);
    let polaris_rc = calibrate_rc_half(column_count, sunny.star, if rate.is_nan() || rate == 0.0 { 1.0 } else { rate },
        ln_ratio, options.extended_estimation_range);

    if mode_tag == "RC" && column_count != 4.0 {
        let Some(rc) = polaris_rc else {
            return Ok(sunny_passthrough(sunny));
        };
        let mut result = sunny.clone();
        result.est_diff = rc.label;
        result.numeric_difficulty = rc.numeric;
        result.numeric_difficulty_hint = None;
        return Ok(MixedResult { result, mixed_companella_plan: None, actual_estimator_algorithm: "Polaris", companella_capsule: None });
    }

    let azusa_options = EstimatorOptions {
        force_sunny_reference_ho: Some(false),
        precomputed_sunny_result: Some(sunny),
        ..options.clone()
    };

    let mut selected: EstimatorResult = sunny.clone();
    let mut est_diff = sunny.est_diff.clone();
    let mut numeric = sunny.numeric_difficulty;
    let mut hint = sunny.numeric_difficulty_hint.clone();
    let mut plan: Option<CompanellaPlan> = None;

    if mode_tag == "RC" {
        let roxy_options = EstimatorOptions { precomputed_sunny_result: Some(sunny), include_reference_results: true, ..options.clone() };
        let roxy = run_roxy(up, osu_text, &roxy_options, parsed);
        let roxy_daniel = roxy_reference_daniel(&roxy).cloned();
        let azusa_options = EstimatorOptions { precomputed_daniel_result: roxy_daniel.as_ref(), ..azusa_options.clone() };
        if can_use_rc_result(Some(&roxy)) {
            est_diff = roxy.est_diff.clone();
            numeric = roxy.numeric_difficulty;
            hint = roxy.numeric_difficulty_hint.clone();
            actual = "Roxy";
            let evaluate = !in_enabled && !has_explicit_od && should_evaluate_azusa_rc_preference(&roxy);
            if evaluate {
                let azusa = run_azusa(up, osu_text, &azusa_options, parsed).ok();
                if should_prefer_azusa_rc_result(&roxy, azusa.as_ref()) {
                    let azusa = azusa.unwrap();
                    est_diff = azusa.est_diff.clone();
                    numeric = azusa.numeric_difficulty;
                    hint = azusa.numeric_difficulty_hint.clone();
                    actual = "Azusa";
                    selected = azusa;
                }
            }
            if actual == "Roxy" && !in_enabled && !has_explicit_od {
                if let Some(o) = resolve_roxy_xdc1(up, osu_text, options, parsed, &roxy) {
                    selected = o.selected;
                    actual = o.actual;
                    est_diff = o.est_diff;
                    numeric = o.numeric;
                    hint = o.hint;
                }
            }
            if actual == "Roxy" {
                selected = roxy;
            }
        } else if !in_enabled {
            let azusa = run_azusa(up, osu_text, &azusa_options, parsed).ok();
            if can_use_rc_result(azusa.as_ref()) {
                let azusa = azusa.unwrap();
                est_diff = azusa.est_diff.clone();
                numeric = azusa.numeric_difficulty;
                hint = azusa.numeric_difficulty_hint.clone();
                actual = "Azusa";
                let mut high_fused = None;
                if sunny.star < LOW_BAND_COMPANELLA_STAR_MAX {
                    let xdc1_candidate = None;
                    plan = Some(low_band_plan(&azusa, ln_ratio, &ln_difficulty, OnDisagree::Azusa, xdc1_candidate));
                } else if !has_explicit_od {
                    high_fused = resolve_high_azusa_xdc1(up, osu_text, options, parsed, &azusa);
                }
                selected = azusa;
                if let Some(o) = high_fused {
                    selected = o.selected;
                    actual = o.actual;
                    est_diff = o.est_diff;
                    numeric = o.numeric;
                    hint = o.hint;
                }
            } else {
                let daniel = match roxy_daniel {
                    Some(d) => Ok(d),
                    None => up.daniel(osu_text, options, parsed),
                };
                if let Ok(daniel) = daniel {
                    if daniel.column_count == 4.0 && !is_daniel_too_low_difficulty(&daniel.est_diff) {
                        est_diff = daniel.est_diff.clone();
                        numeric = daniel.numeric_difficulty;
                        hint = daniel.numeric_difficulty_hint.clone();
                        actual = "Daniel";
                        selected = daniel;
                    }
                }
            }
        }
    } else {
        let mut rc_difficulty = sunny_rc;
        let mut rc_numeric = sunny.numeric_difficulty;
        let mut rc_hint = sunny.numeric_difficulty_hint.clone();
        if column_count == 4.0 {
            if sunny.star < LOW_BAND_COMPANELLA_STAR_MAX {
                let azusa = run_azusa(up, osu_text, &azusa_options, parsed).ok();
                if can_use_rc_result(azusa.as_ref()) {
                    let azusa = azusa.unwrap();
                    rc_difficulty = azusa.est_diff.clone();
                    rc_numeric = azusa.numeric_difficulty;
                    rc_hint = azusa.numeric_difficulty_hint.clone();
                    actual = "Azusa";
                    plan = Some(low_band_plan(&azusa, ln_ratio, &ln_difficulty, OnDisagree::Companella, None));
                } else {
                    plan = Some(CompanellaPlan { ln_ratio, ln_difficulty: ln_difficulty.clone(), fusion: None });
                    actual = "Companella";
                }
            } else if let Ok(daniel) = up.daniel(osu_text, options, parsed) {
                if daniel.column_count == 4.0 && !is_daniel_too_low_difficulty(&daniel.est_diff) {
                    rc_difficulty = daniel.est_diff.clone();
                    rc_numeric = daniel.numeric_difficulty;
                    rc_hint = daniel.numeric_difficulty_hint.clone();
                    actual = "Daniel";
                }
            }
        } else if let Some(rc) = polaris_rc {
            rc_difficulty = rc.label;
            rc_numeric = rc.numeric;
            rc_hint = None;
            actual = "Polaris";
        }
        est_diff = compose_difficulty_from_rc_ln(&rc_difficulty, &ln_difficulty, ln_ratio);
        numeric = rc_numeric;
        hint = rc_hint;
    }

    let normalized_ln_ratio = selected.ln_ratio;
    let forced = if ho_enabled { 0.0 } else { normalized_ln_ratio };
    selected.ln_ratio = if forced.is_finite() { forced } else { 0.0 };
    selected.est_diff = est_diff;
    selected.numeric_difficulty = numeric;
    selected.numeric_difficulty_hint = hint;
    Ok(MixedResult { result: selected, mixed_companella_plan: plan, actual_estimator_algorithm: actual, companella_capsule: None })
}

#[derive(Clone, Debug, PartialEq)]
pub struct CompanellaVerdict {
    pub est_diff: String,
    pub numeric_difficulty: Option<f64>,
    pub numeric_difficulty_hint: Option<String>,
}

pub fn apply_companella_to_mixed_result(mixed: &MixedResult, companella: &CompanellaVerdict) -> MixedResult {
    let Some(plan) = &mixed.mixed_companella_plan else {
        return mixed.clone();
    };
    let replace = |est_diff: String, numeric: Option<f64>, hint: Option<String>, capsule: &'static str| {
        let mut out = mixed.clone();
        out.companella_capsule = Some(capsule);
        out.result.est_diff = est_diff;
        out.result.numeric_difficulty = numeric;
        out.result.numeric_difficulty_hint = hint;
        out.mixed_companella_plan = None;
        out
    };
    if let Some(fusion) = &plan.fusion {
        let rc_numeric = fusion.rc_numeric.unwrap_or(0.0);
        let companella_numeric = companella.numeric_difficulty.unwrap_or(0.0);
        if !rc_numeric.is_finite() || !companella_numeric.is_finite() {
            return mixed.clone();
        }
        if rc_numeric >= RC_FUSION_LOW_BAND_MAX {
            if fusion.on_disagree == OnDisagree::Companella {
                return replace(
                    compose_difficulty_from_rc_ln(&companella.est_diff, &plan.ln_difficulty, plan.ln_ratio),
                    companella.numeric_difficulty,
                    companella.numeric_difficulty_hint.clone(),
                    "Companella",
                );
            }
            return mixed.clone();
        }
        let w = RC_AZUSA_COMPANELLA_FUSION_WEIGHT;
        let fused = round_fixed(rc_numeric * w + companella_numeric * (1.0 - w), 2);
        if let Some(c) = &fusion.xdc1_candidate {
            let xdc1_numeric = c.numeric_difficulty.filter(|v| v.is_finite()).unwrap_or(f64::NAN);
            if is_delta_at_least(xdc1_numeric - fused, XDC1_RC_OVERRIDE_MIN_DELTA) {
                let mut out = replace(
                    compose_difficulty_from_rc_ln(&c.est_diff, &plan.ln_difficulty, plan.ln_ratio),
                    c.numeric_difficulty,
                    c.numeric_difficulty_hint.clone(),
                    "XDC1",
                );
                out.actual_estimator_algorithm = "XDC1";
                return out;
            }
        }
        return replace(compose_difficulty_from_rc_ln(&numeric_to_rc_label(fused), &plan.ln_difficulty, plan.ln_ratio), Some(fused), None, "Azusa+Companella");
    }
    replace(
        compose_difficulty_from_rc_ln(&companella.est_diff, &plan.ln_difficulty, plan.ln_ratio),
        companella.numeric_difficulty,
        companella.numeric_difficulty_hint.clone(),
        "Companella",
    )
}
