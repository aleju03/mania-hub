use dan_core::vibro_sections::VibroAnalysis;
use dan_core::parse_mania_beatmap;
use leoblack_estimators::MsdValues;
use leoblack_parser::OsuFileParser;

use crate::analysis::{guarded, PipelineError};
use crate::classifier::{ChartContext, ClassifyInput, Unported};
use crate::companella::classify_chart_with_companella;
use crate::json::{num, opt_str, str, stringify, Js, Obj};
use crate::leoblack::PlayedOd;
use crate::msd::{compute_msd, values_js, vibro_analysis_js, MsdOptions};

#[derive(Clone, Copy, Debug)]
pub struct DanEstimateInputs {
    pub rate: f64,
    pub adjust_vibro: bool,
    pub od_flag: Option<PlayedOd>,
    pub star_rating: Option<f64>,
    pub with_msd: bool,
    pub msd_values: Option<MsdValues>,
    pub file_speed: Option<f64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct EstimateVerdict {
    pub label: String,
    pub variant: Option<&'static str>,
    pub display_name: String,
    pub raw_dan: f64,
    pub family: &'static str,
    pub confidence: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct DanEstimateColumns {
    pub msd_json: Option<String>,
    pub msd_values: Option<Vec<(String, f64)>>,
    pub supported: bool,
    pub companella_pending: bool,
    pub estimate: Option<EstimateVerdict>,
    pub vibro_analysis: Option<VibroAnalysis>,
}

impl DanEstimateColumns {
    pub fn to_js(&self) -> Js {
        let estimate = self.estimate.as_ref().map_or(Js::Null, |e| {
            Obj::new()
                .with("label", str(&e.label))
                .with("variant", opt_str(e.variant))
                .with("displayName", str(&e.display_name))
                .with("rawDan", num(e.raw_dan))
                .with("family", str(e.family))
                .with("confidence", num(e.confidence))
                .into()
        });
        let mut o = Obj::new()
            .with("msdJson", opt_str(self.msd_json.as_deref()))
            .with("msdValues", self.msd_values.as_deref().map_or(Js::Null, values_js))
            .with("supported", Js::Bool(self.supported))
            .with("companellaPending", Js::Bool(self.companella_pending))
            .with("estimate", estimate);
        if let Some(a) = &self.vibro_analysis {
            o.set("vibroAnalysis", vibro_analysis_js(a));
        }
        o.into()
    }
}

pub fn dan_estimate(osu_text: &str, inputs: &DanEstimateInputs) -> Result<DanEstimateColumns, PipelineError> {
    guarded(|| dan_estimate_inner(osu_text, inputs))
}

fn dan_estimate_inner(osu_text: &str, inputs: &DanEstimateInputs) -> Result<DanEstimateColumns, Unported> {
    let map = parse_mania_beatmap(osu_text);
    let parsed = OsuFileParser::parse(osu_text);
    let msd = if inputs.with_msd {
        let options = MsdOptions {
            key_count: Some(map.key_count),
            rate: Some(inputs.rate),
            adjust_vibro: inputs.adjust_vibro,
            include_ln_skill: true,
            ..Default::default()
        };
        compute_msd(osu_text, &options, &map, Some(&parsed))
    } else {
        None
    };
    let ctx = ChartContext::new(osu_text, &map, &parsed);
    let input = ClassifyInput {
        rate: if inputs.rate != 1.0 { Some(inputs.rate) } else { None },
        star_rating: inputs.star_rating,
        total_length: if map.total_length > 0.0 { Some(map.total_length / 1000.0) } else { None },
        version: map.version.clone(),
        od_flag: inputs.od_flag,
        adjust_vibro: inputs.adjust_vibro,
        file_speed: Some(inputs.file_speed.unwrap_or(1.0)),
        ..Default::default()
    };
    let msd_values = msd.as_ref().map(|m| m.msd_values()).or(inputs.msd_values);
    let classification = classify_chart_with_companella(&ctx, &input, msd_values)?;
    let estimate = classification.primary.as_ref().map(|p| EstimateVerdict {
        label: p.label.clone(),
        variant: p.variant,
        display_name: p.display_name.clone(),
        raw_dan: p.raw_dan,
        family: if p.kind == "ln" { "ln" } else { "dan" },
        confidence: p.confidence,
    });
    Ok(DanEstimateColumns {
        msd_json: msd.as_ref().map(|m| stringify(&m.to_js()).unwrap()),
        msd_values: msd.map(|m| m.values),
        supported: classification.supported,
        companella_pending: classification.companella_pending,
        estimate,
        vibro_analysis: classification.analysis.vibro_analysis.clone(),
    })
}
