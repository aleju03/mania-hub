use dan_core::labels::rate_or_one;
use leoblack_estimators::{classify_companella_difficulty, CompanellaEstimate, MsdValues};
use leoblack_interlude::calculate_interlude_star_from_parser;
use ln_skill::{ln_rating_identity_undecided, LnIdentityShares};

use crate::classifier::{
    classify_chart, classify_chart_rc, is_marathon_correction_candidate, ChartClassification, ChartContext, ChartRcClassification,
    ChartView, ClassifyInput, RcFloor, Unported,
};
use crate::msd::{compute_msd, MsdOptions};

const COMPANELLA_RATE_FLOOR_STEPS: [f64; 2] = [0.05, 0.1];
const COMPANELLA_RATE_FLOOR_MIN_RATE: f64 = 0.5;

trait CompanellaGate {
    fn sunny_sr(&self) -> Option<f64>;
    fn companella_pending(&self) -> bool;
}

impl CompanellaGate for ChartClassification {
    fn sunny_sr(&self) -> Option<f64> {
        self.sunny_sr
    }
    fn companella_pending(&self) -> bool {
        self.companella_pending
    }
}

impl CompanellaGate for ChartRcClassification {
    fn sunny_sr(&self) -> Option<f64> {
        self.sunny_sr
    }
    fn companella_pending(&self) -> bool {
        self.companella_pending
    }
}

fn native_msd_values(chart: ChartView, rate: f64, key_count: i32) -> Option<MsdValues> {
    let options = MsdOptions { rate: Some(rate), key_count: Some(key_count), values_only: true, ..Default::default() };
    compute_msd(chart.text, &options, chart.map, Some(chart.parsed)).map(|m| m.msd_values())
}

pub fn compute_companella_estimate(chart: ChartView, rate: f64, key_count: i32, sunny_star: f64) -> Option<CompanellaEstimate> {
    if key_count != 4 || !sunny_star.is_finite() {
        return None;
    }
    let options = MsdOptions {
        rate: Some(rate),
        key_count: Some(key_count),
        etterna_version: Some("0.74.0"),
        include_ln_skill: false,
        values_only: true,
        ..Default::default()
    };
    let msd = compute_msd(chart.text, &options, chart.map, Some(chart.parsed));
    let interlude = calculate_interlude_star_from_parser(chart.parsed, rate, None);
    let (msd, interlude) = (msd?, interlude.ok()?);
    classify_companella_difficulty(Some(&msd.msd_values()), interlude, sunny_star).ok()
}

struct Resolved<T> {
    first: T,
    classify_input: ClassifyInput,
    companella: Option<CompanellaEstimate>,
}

fn resolve_companella<T: CompanellaGate>(
    ctx: &ChartContext,
    input: &ClassifyInput,
    classify: impl Fn(&ChartContext, &ClassifyInput) -> Result<T, Unported>,
    msd_values: Option<MsdValues>,
    needs_native_msd: Option<&dyn Fn(&T) -> bool>,
) -> Result<Resolved<T>, Unported> {
    let rate = rate_or_one(input.rate);
    let prepared = ctx.prepared(input);
    let effective = ctx.view_of(&prepared);
    let key_count = ctx.map.key_count;
    let marathon = is_marathon_correction_candidate(effective.map);
    let mut msd_values = msd_values.or(input.marathon_msd_values);
    if marathon && msd_values.is_none() {
        msd_values = native_msd_values(effective, rate, key_count);
    }
    let mut classify_input = ClassifyInput { marathon_msd_values: msd_values, ..input.clone() };
    let mut first = classify(ctx, &classify_input)?;
    if msd_values.is_none() && needs_native_msd.map_or(false, |f| f(&first)) {
        msd_values = native_msd_values(effective, rate, key_count);
        if msd_values.is_some() {
            classify_input = ClassifyInput { marathon_msd_values: msd_values, ..input.clone() };
            first = classify(ctx, &classify_input)?;
        }
    }
    let sunny = match first.sunny_sr() {
        Some(s) if first.companella_pending() => s,
        _ => return Ok(Resolved { first, classify_input, companella: None }),
    };
    if marathon && msd_values.is_none() {
        return Ok(Resolved { first, classify_input, companella: None });
    }
    let companella = compute_companella_estimate(effective, rate, key_count, sunny);
    Ok(Resolved { first, classify_input, companella })
}

/// The highest Companella dan of the chart at the rates just below, so a
/// higher rate never rates lower.
///
/// Each of those rates is a whole estimate of its own and none uses another's
/// work, so they run at the same time: the first on this thread, the others on
/// threads of their own, each with its own context (whose caches are
/// single-threaded). Their results are then taken in order, as one after the
/// other: the first error wins, and of equal dans the first.
fn companella_rc_floor(ctx: &ChartContext, input: &ClassifyInput) -> Result<Option<RcFloor>, Unported> {
    let rate = rate_or_one(input.rate);
    let rates: Vec<f64> = COMPANELLA_RATE_FLOOR_STEPS
        .iter()
        .map(|step| jsmath::round((rate - step) * 100.0) / 100.0)
        .take_while(|&lower_rate| lower_rate >= COMPANELLA_RATE_FLOOR_MIN_RATE)
        .collect();
    let Some((&first, rest)) = rates.split_first() else { return Ok(None) };

    let (text, map, parsed, up) = (ctx.osu_text, ctx.map, ctx.parsed, ctx.up);
    let floors: Vec<Result<Option<RcFloor>, Unported>> = std::thread::scope(|scope| {
        let others: Vec<_> = rest
            .iter()
            .map(|&lower_rate| {
                scope.spawn(move || {
                    let mut ctx = ChartContext::new(text, map, parsed);
                    ctx.up = up;
                    companella_floor_at(&ctx, input, lower_rate)
                })
            })
            .collect();
        let first = companella_floor_at(ctx, input, first);
        std::iter::once(first)
            .chain(others.into_iter().map(|other| other.join().unwrap_or_else(|panic| std::panic::resume_unwind(panic))))
            .collect()
    });

    let mut floor: Option<RcFloor> = None;
    for candidate in floors {
        if let Some(candidate) = candidate? {
            if candidate.numeric > floor.as_ref().map_or(f64::NEG_INFINITY, |f| f.numeric) {
                floor = Some(candidate);
            }
        }
    }
    Ok(floor)
}

/// The Companella dan of the chart at `lower_rate`, if Companella rates it.
fn companella_floor_at(ctx: &ChartContext, input: &ClassifyInput, lower_rate: f64) -> Result<Option<RcFloor>, Unported> {
    let probe = ClassifyInput { rate: Some(lower_rate), marathon_msd_values: None, companella: None, rc_floor: None, ..input.clone() };
    let lower = resolve_companella(ctx, &probe, classify_chart_rc, None, None)?;
    let Some(companella) = lower.companella else { return Ok(None) };
    let refined = classify_chart_rc(ctx, &ClassifyInput { companella: Some(companella), ..lower.classify_input })?;
    Ok(match refined.rc {
        Some((source, raw, raw_dan)) if source == "leoblack-companella" => Some(RcFloor { text: raw, numeric: raw_dan }),
        _ => None,
    })
}

pub fn classify_chart_with_companella(
    ctx: &ChartContext,
    input: &ClassifyInput,
    msd_values: Option<MsdValues>,
) -> Result<ChartClassification, Unported> {
    let needs = |first: &ChartClassification| {
        ln_rating_identity_undecided(
            Some(first.key_count),
            &LnIdentityShares {
                ln_ratio: Some(first.ln_ratio),
                ln_effective_ratio: first.ln_effective_ratio,
                ln_tap_covered: None,
                ln_held_peak_light: None,
            },
        )
    };
    let resolved = resolve_companella(ctx, input, classify_chart, msd_values, Some(&needs))?;
    let Some(companella) = resolved.companella else { return Ok(resolved.first) };
    let rc_floor = companella_rc_floor(ctx, input)?;
    classify_chart(ctx, &ClassifyInput { companella: Some(companella), rc_floor, ..resolved.classify_input })
}
