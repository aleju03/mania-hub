//! Dan estimates for osu!mania charts, as Mania Tracker computes them.
//!
//! ```no_run
//! let osu = std::fs::read_to_string("chart.osu").unwrap();
//! let result = dan_calc::estimate(&osu, &dan_calc::Options::default()).unwrap();
//! if let Some(dan) = result.primary {
//!     println!("{} ({:?}, {:.2})", dan.display_name, dan.family, dan.raw_dan);
//! }
//! ```

use std::panic::{catch_unwind, AssertUnwindSafe};

use chart_pipeline::classifier::{ChartContext, ClassifyInput, DanVerdictHalf, Unported};
use chart_pipeline::companella::classify_chart_with_companella;
use chart_pipeline::msd::{compute_msd, MsdOptions};
use dan_core::parse_mania_beatmap;
use dan_core::star_rating::calculate_mania_star_rating;
use leoblack_parser::OsuFileParser;

pub use chart_pipeline;
pub use chart_pipeline::PlayedOd;
pub use dan_core::vibro_sections::{VibroAnalysis, VibroStatus};

#[derive(Clone, Copy, Debug)]
pub struct Options {
    pub rate: f64,
    pub od: Option<PlayedOd>,
    pub vibro_adjusted: bool,
    pub star_rating: Option<f64>,
}

impl Default for Options {
    fn default() -> Self {
        Options { rate: 1.0, od: None, vibro_adjusted: false, star_rating: None }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Family {
    Rice,
    Ln,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Dan {
    pub family: Family,
    pub label: String,
    pub variant: Option<&'static str>,
    pub display_name: String,
    pub raw_dan: f64,
    pub confidence: f64,
    pub source: &'static str,
}

#[derive(Clone, Debug)]
pub struct Estimate {
    pub key_count: i32,
    pub supported: bool,
    pub primary: Option<Dan>,
    pub rice: Option<Dan>,
    pub ln: Option<Dan>,
    pub msd: Option<Vec<(String, f64)>>,
    pub vibro: Option<VibroAnalysis>,
    pub ln_ratio: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Error(pub String);

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Error {}

fn dan(half: &DanVerdictHalf) -> Dan {
    Dan {
        family: if half.kind == "ln" { Family::Ln } else { Family::Rice },
        label: half.label.clone(),
        variant: half.variant,
        display_name: half.display_name.clone(),
        raw_dan: half.raw_dan,
        confidence: half.confidence,
        source: half.source,
    }
}

pub fn estimate(osu_text: &str, options: &Options) -> Result<Estimate, Error> {
    match catch_unwind(AssertUnwindSafe(|| estimate_inner(osu_text, options))) {
        Ok(Ok(e)) => Ok(e),
        Ok(Err(Unported(message))) => Err(Error(message)),
        Err(panic) => Err(Error(
            panic
                .downcast_ref::<String>()
                .cloned()
                .or_else(|| panic.downcast_ref::<&str>().map(|s| s.to_string()))
                .unwrap_or_else(|| "panic".into()),
        )),
    }
}

fn estimate_inner(osu_text: &str, options: &Options) -> Result<Estimate, Unported> {
    let map = parse_mania_beatmap(osu_text);
    let parsed = OsuFileParser::parse(osu_text);
    let msd = compute_msd(
        osu_text,
        &MsdOptions {
            key_count: Some(map.key_count),
            rate: Some(options.rate),
            adjust_vibro: options.vibro_adjusted,
            include_ln_skill: true,
            ..Default::default()
        },
        &map,
        Some(&parsed),
    );
    let star_rating = options
        .star_rating
        .or_else(|| Some(calculate_mania_star_rating(&map.notes, map.key_count, 1.0)))
        .filter(|s| s.is_finite() && *s > 0.0);
    let ctx = ChartContext::new(osu_text, &map, &parsed);
    let input = ClassifyInput {
        rate: if options.rate != 1.0 { Some(options.rate) } else { None },
        star_rating,
        total_length: if map.total_length > 0.0 { Some(map.total_length / 1000.0) } else { None },
        version: map.version.clone(),
        od_flag: options.od,
        adjust_vibro: options.vibro_adjusted,
        file_speed: Some(1.0),
        ..Default::default()
    };
    let c = classify_chart_with_companella(&ctx, &input, msd.as_ref().map(|m| m.msd_values()))?;
    Ok(Estimate {
        key_count: c.key_count,
        supported: c.supported,
        primary: c.primary.as_ref().map(dan),
        rice: c.rc.as_ref().map(dan),
        ln: c.ln.as_ref().map(dan),
        msd: msd.map(|m| m.values),
        vibro: c.analysis.vibro_analysis.clone(),
        ln_ratio: c.ln_ratio,
    })
}
