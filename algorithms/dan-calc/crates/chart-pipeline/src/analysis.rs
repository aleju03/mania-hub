use std::borrow::Cow;
use std::panic::{catch_unwind, AssertUnwindSafe};

use dan_core::ln_effective::{ln_tail_pass_text, EffectiveLnOptions, LN_EFFECTIVE_KEY_COUNTS};
use dan_core::motion_features::motion_features;
use dan_core::rice_shape::rice_shape;
use dan_core::note_bpm::compute_note_bpm;
use dan_core::{parse_mania_beatmap, ManiaBeatmap};
use leoblack_parser::OsuFileParser;

use crate::classifier::{ChartContext, ClassifyInput, Unported};
use crate::companella::classify_chart_with_companella;
use crate::json::{stringify, Js, Obj};
use crate::lean::{hybrid_ln_sections_for, lean_classification};
use crate::msd::{compute_msd, MsdOptions};

const LN_TAIL_MIN_RATIO: f64 = 0.02;

#[derive(Clone, Copy, Debug)]
pub struct ChartInputs {
    pub star_rating: f64,
    pub file_speed: f64,
}

impl ChartInputs {
    pub fn new(star_rating: f64) -> ChartInputs {
        ChartInputs { star_rating, file_speed: 1.0 }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct ChartAnalysisColumns {
    pub key_count: i32,
    pub primary_label: Option<String>,
    pub primary_family: Option<&'static str>,
    pub raw_dan: Option<f64>,
    pub msd_overall: Option<f64>,
    pub classification_json: String,
    pub msd_json: Option<String>,
    pub msd_ln_json: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RateVerdictColumns {
    pub msd_json: String,
    pub dan_json: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PipelineError(pub String);

impl std::fmt::Display for PipelineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for PipelineError {}

pub(crate) fn guarded<T>(f: impl FnOnce() -> Result<T, Unported>) -> Result<T, PipelineError> {
    match catch_unwind(AssertUnwindSafe(f)) {
        Ok(Ok(v)) => Ok(v),
        Ok(Err(Unported(message))) => Err(PipelineError(format!("unported path: {message}"))),
        Err(panic) => {
            let message = panic
                .downcast_ref::<String>()
                .cloned()
                .or_else(|| panic.downcast_ref::<&str>().map(|s| s.to_string()))
                .unwrap_or_else(|| "panic".into());
            Err(PipelineError(format!("native panic: {message}")))
        }
    }
}

fn classify_input(map: &ManiaBeatmap, star_rating: f64, rate: Option<f64>, file_speed: f64) -> ClassifyInput {
    ClassifyInput {
        rate,
        file_speed: Some(file_speed),
        star_rating: if star_rating.is_finite() && star_rating > 0.0 { Some(star_rating) } else { None },
        total_length: if map.total_length > 0.0 { Some(map.total_length / 1000.0) } else { None },
        version: map.version.clone(),
        ..Default::default()
    }
}

pub fn analyze_chart(osu_text: &str, inputs: &ChartInputs) -> Result<ChartAnalysisColumns, PipelineError> {
    guarded(|| analyze_chart_inner(osu_text, inputs.star_rating, inputs.file_speed))
}

fn analyze_chart_inner(osu_text: &str, star_rating: f64, file_speed: f64) -> Result<ChartAnalysisColumns, Unported> {
    let map = parse_mania_beatmap(osu_text);
    let parsed = OsuFileParser::parse(osu_text);
    let kc = map.key_count;
    let msd = compute_msd(
        osu_text,
        &MsdOptions { key_count: Some(kc), include_ln_skill: true, ..Default::default() },
        &map,
        Some(&parsed),
    );
    let ctx = ChartContext::new(osu_text, &map, &parsed);
    let classification = classify_chart_with_companella(&ctx, &classify_input(&map, star_rating, None, file_speed), msd.as_ref().map(|m| m.msd_values()))?;

    let tail_text: Option<Cow<str>> = if msd.is_none() || kc == 4 {
        None
    } else if LN_EFFECTIVE_KEY_COUNTS.contains(&kc) {
        ln_tail_pass_text(osu_text, kc as f64, &EffectiveLnOptions { od: Some(map.od), ..Default::default() }, LN_TAIL_MIN_RATIO)
            .map(Cow::Owned)
    } else if classification.ln_ratio > LN_TAIL_MIN_RATIO {
        Some(Cow::Borrowed(osu_text))
    } else {
        None
    };
    let msd_ln = tail_text.and_then(|text| {
        let options = MsdOptions { key_count: Some(kc), ln_tail_taps: true, include_ln_skill: true, ..Default::default() };
        if text.as_ref() == osu_text {
            compute_msd(osu_text, &options, &map, Some(&parsed))
        } else {
            compute_msd(&text, &options, &parse_mania_beatmap(&text), None)
        }
    });

    let mut lean = lean_classification(classification, compute_note_bpm(osu_text), motion_features(&map.notes, kc as f64), rice_shape(&map.notes, kc as f64, map.timing_points.as_deref(), map.bpm));
    lean.ln_sections = hybrid_ln_sections_for(&lean, osu_text)?;
    let primary = lean.primary();
    Ok(ChartAnalysisColumns {
        key_count: kc,
        primary_label: primary.map(|p| p.display_name.clone()),
        primary_family: primary.map(|p| if p.kind == "ln" { "ln" } else { "dan" }),
        raw_dan: primary.map(|p| p.raw_dan),
        msd_overall: msd.as_ref().and_then(|m| m.value("Overall")),
        classification_json: stringify(&lean.to_js()).unwrap(),
        msd_json: msd.as_ref().map(|m| stringify(&m.to_js()).unwrap()),
        msd_ln_json: msd_ln.as_ref().map(|m| stringify(&m.to_js()).unwrap()),
    })
}

pub fn rate_verdict(
    osu_text: &str,
    rate: f64,
    inputs: &ChartInputs,
    with_vibro_analysis: bool,
) -> Result<Option<RateVerdictColumns>, PipelineError> {
    guarded(|| rate_verdict_inner(osu_text, rate, inputs.star_rating, inputs.file_speed, with_vibro_analysis))
}

fn rate_verdict_inner(osu_text: &str, rate: f64, star_rating: f64, file_speed: f64, with_vibro_analysis: bool) -> Result<Option<RateVerdictColumns>, Unported> {
    let map = parse_mania_beatmap(osu_text);
    let parsed = OsuFileParser::parse(osu_text);
    let options = MsdOptions { key_count: Some(map.key_count), rate: Some(rate), include_ln_skill: true, ..Default::default() };
    let Some(msd) = compute_msd(osu_text, &options, &map, Some(&parsed)) else { return Ok(None) };
    let ctx = ChartContext::new(osu_text, &map, &parsed);
    let classification = classify_chart_with_companella(&ctx, &classify_input(&map, star_rating, Some(rate), file_speed), Some(msd.msd_values()))?;
    let lean = lean_classification(classification, None, None, None);
    let verdict = lean.rate_verdict_js();
    let dan = if with_vibro_analysis {
        let vibro = lean.classification.analysis.vibro_analysis.as_ref().map_or(Js::Undefined, crate::msd::vibro_analysis_js);
        let mut o = Obj::new().with("vibroAnalysis", vibro);
        o.spread(verdict);
        o
    } else {
        verdict
    };
    Ok(Some(RateVerdictColumns { msd_json: stringify(&msd.to_js()).unwrap(), dan_json: stringify(&dan.into()).unwrap() }))
}
