use crate::jsnum::round_fixed;
use crate::rc_format::numeric_to_rc_label;
use crate::types::MsdValues;

pub const MARATHON_DURATION_THRESHOLD_S: f64 = 300.0;
pub const MARATHON_CORRECTION_SCALE: f64 = 0.40;
pub const MARATHON_CORRECTION_CAP: f64 = 0.50;
pub const MARATHON_BALANCE_RATIO: f64 = 0.45;
pub const MARATHON_TAPER_LO: f64 = 10.0;
pub const MARATHON_TAPER_HI: f64 = 16.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SkillAggregate {
    pub jk: f64,
    pub st: f64,
    pub te: f64,
    pub en: f64,
    pub total: f64,
}

fn or0(x: f64) -> f64 {
    if x.is_nan() || x == 0.0 { 0.0 } else { x }
}

pub fn aggregate_skillsets(ett: Option<&MsdValues>) -> Option<SkillAggregate> {
    let ett = ett?;
    let jk = jsmath::max(or0(ett.jack_speed), or0(ett.chordjack));
    let st = jsmath::max(or0(ett.stream), or0(ett.jumpstream));
    let te = or0(ett.technical);
    let en = 0.7 * or0(ett.stamina) + 0.3 * or0(ett.handstream);
    let total = jk + st + te + en;
    if !(total > 1.0) {
        return None;
    }
    Some(SkillAggregate { jk, st, te, en, total })
}

pub fn compute_marathon_correction(duration_s: f64, ett: Option<&MsdValues>, numeric: Option<f64>) -> f64 {
    if !(duration_s > MARATHON_DURATION_THRESHOLD_S) {
        return 0.0;
    }
    let Some(num) = numeric.filter(|n| n.is_finite()) else {
        return 0.0;
    };
    let Some(agg) = aggregate_skillsets(ett) else {
        return 0.0;
    };
    let max = jsmath::max(jsmath::max(jsmath::max(agg.jk, agg.st), agg.te), agg.en);
    if max / agg.total >= MARATHON_BALANCE_RATIO {
        return 0.0;
    }
    let excess_min = (duration_s - MARATHON_DURATION_THRESHOLD_S) / 60.0;
    let raw = jsmath::min(MARATHON_CORRECTION_CAP, MARATHON_CORRECTION_SCALE * jsmath::log(1.0 + excess_min));
    if raw <= 0.0 {
        return 0.0;
    }
    let mut taper = 1.0;
    if num >= MARATHON_TAPER_HI {
        taper = 0.0;
    } else if num > MARATHON_TAPER_LO {
        taper = (MARATHON_TAPER_HI - num) / (MARATHON_TAPER_HI - MARATHON_TAPER_LO);
    }
    if !(taper > 0.0) {
        return 0.0;
    }
    raw * taper
}

pub fn apply_marathon_correction_to_numeric(numeric: f64, corr: f64) -> f64 {
    if !numeric.is_finite() || !(corr > 0.0) {
        return numeric;
    }
    numeric - corr
}

pub fn apply_marathon_correction_to_rc(numeric: Option<f64>, duration_s: f64, ett: Option<&MsdValues>) -> Option<(f64, String)> {
    let numeric = numeric.filter(|n| n.is_finite())?;
    let corr = compute_marathon_correction(duration_s, ett, Some(numeric));
    if !(corr > 0.0) {
        return None;
    }
    let corrected = apply_marathon_correction_to_numeric(numeric, corr);
    Some((round_fixed(corrected, 2), numeric_to_rc_label(corrected)))
}
