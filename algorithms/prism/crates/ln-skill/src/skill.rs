use dan_core::ln::ln_primary_min_ratio_for;
use dan_core::ln_effective::{chart_is_ln, LN_EFFECTIVE_MIN_RATIO, LN_MIN_WORK_SHARE};
use jsmath::{exp, log, max, min, pow};

use crate::classifier::classify_ln_skillsets;
use crate::workload::{build_ln_workload, empty_ln_family_vector, LnFamilyVector, LnWorkSection, LnWorkload, LnWorkloadOptions};
use crate::{LnMap, LnSkillOptions};

pub const LN_SKILL_VERSION: u32 = 15;
pub const LN_SKILL_SCORE_GOAL: f64 = 0.93;
pub const LN_SKILL_SCALE: f64 = 3.6427;
pub const LN_SKILL_EXPONENT: f64 = 0.57;
pub const LN_SKILL_RATE_EXPONENT_UP: f64 = 0.06;
pub const LN_SKILL_RATE_EXPONENT_DOWN: f64 = -0.05;
const SECTION_RANK_DECAY: f64 = 0.95;
const LN_OVERALL_WEIGHT_AT_60: f64 = 0.5;
const LN_OVERALL_OFFSET: f64 = 1.0;
const LN_PUBLISHED_SCALE: f64 = 1.82;
const LN_PUBLISHED_EXPONENT: f64 = 0.84;

pub fn is_ln_skill_supported(key_count: i32) -> bool {
    crate::axis::has_ln_axis(Some(key_count))
}

pub fn ln_skill_rate_factor(rate: f64) -> f64 {
    pow(rate, if rate >= 1.0 { LN_SKILL_RATE_EXPONENT_UP } else { LN_SKILL_RATE_EXPONENT_DOWN })
}

#[derive(Clone, Debug, PartialEq)]
pub struct LnSkillResult {
    pub version: u32,
    pub key_count: i32,
    pub rating: Option<f64>,
    pub skillsets: Option<LnFamilyVector>,
    pub strain: f64,
    pub eligible: bool,
    pub rated: bool,
    pub hold_ratio: f64,
    pub effective_ratio: f64,
    pub effective_holds: f64,
    pub rate: f64,
    pub od: f64,
    pub score_goal: f64,
}

const FAMILY_VALUE_KEYS: [&str; 4] = ["LNHybrid", "LNTechnical", "LNWalls", "LNSpeed"];

pub fn without_ln_family_ratings(base: &[(String, f64)]) -> Vec<(String, f64)> {
    base.iter().filter(|(k, _)| !FAMILY_VALUE_KEYS.contains(&k.as_str())).cloned().collect()
}

pub fn published_ln_rating(skill: &LnSkillResult, overall: Option<f64>) -> f64 {
    let rating = match skill.rating {
        Some(r) if skill.rated && r > 0.0 => r,
        _ => return 0.0,
    };
    if prism::is_prism_key_count(skill.key_count) {
        return rating;
    }
    let native = overall.unwrap_or(0.0);
    let weight = if overall.is_some() && native.is_finite() && native > 0.0 {
        max(0.0, min(1.0, LN_OVERALL_WEIGHT_AT_60 - (skill.hold_ratio - 0.6)))
    } else {
        0.0
    };
    let blended = (1.0 - weight) * rating + weight * (native + LN_OVERALL_OFFSET);
    LN_PUBLISHED_SCALE * pow(max(0.0, blended), LN_PUBLISHED_EXPONENT)
}

pub fn ln_skill_display_values(skill: &LnSkillResult, base: &[(String, f64)]) -> Vec<(String, f64)> {
    let overall = base.iter().find(|(k, _)| k == "Overall").map_or(f64::NAN, |(_, v)| *v);
    let ln = published_ln_rating(skill, Some(overall));
    let mut values = without_ln_family_ratings(base);
    match values.iter_mut().find(|(k, _)| k == "LN") {
        Some(entry) => entry.1 = ln,
        None => values.push(("LN".to_string(), ln)),
    }
    prism::prism_ln_lead_values(skill.key_count, &mut values, ln, skill.hold_ratio);
    values
}

fn strain_at_goal(sections: &[LnWorkSection], goal: f64) -> f64 {
    if sections.is_empty() || goal == 0.0 {
        return 0.0;
    }
    let mut sorted = sections.to_vec();
    jsmath::js_sort_by(&mut sorted, |a, b| b.demand - a.demand);
    let weighted: Vec<(f64, f64)> =
        sorted.iter().enumerate().map(|(index, s)| (s.demand, s.work * pow(SECTION_RANK_DECAY, index as f64))).collect();
    let mut total = 0.0;
    for &(_, w) in &weighted {
        total += w;
    }
    if !(total > 0.0) {
        return 0.0;
    }
    let log_goal = log(LN_SKILL_SCORE_GOAL);
    let mut hi = weighted[0].0 * 10.0;
    let mut lo = 0.0;
    for _ in 0..40 {
        let skill = (lo + hi) / 2.0;
        let scale = max(skill, 1e-9);
        let mut score = 0.0;
        for &(demand, weight) in &weighted {
            score += weight * exp(log_goal * pow(demand / scale, 4.0));
        }
        if score / total < goal {
            lo = skill;
        } else {
            hi = skill;
        }
    }
    (lo + hi) / 2.0
}

fn ln_rating(strain: f64, rate: f64) -> f64 {
    LN_SKILL_SCALE * pow(strain, LN_SKILL_EXPONENT) * ln_skill_rate_factor(rate)
}

pub fn ln_rating_at_goal(workload: &LnWorkload, goal: f64) -> f64 {
    ln_rating(strain_at_goal(&workload.sections, goal), workload.timeline.playback_rate)
}

pub fn analyze_ln_skill(map: &LnMap, options: &LnSkillOptions) -> Option<LnSkillResult> {
    if prism::is_prism_key_count(map.key_count) {
        return None;
    }
    let workload =
        build_ln_workload(map, &LnWorkloadOptions { rate: options.rate, od: options.od, ..Default::default() })?;
    Some(ln_skill_of_workload(map, &workload, options))
}

pub fn ln_skill_of_workload(map: &LnMap, workload: &LnWorkload, options: &LnSkillOptions) -> LnSkillResult {
    let timeline = &workload.timeline;
    let effective = &workload.effective;
    let score_goal = match options.score_goal {
        Some(g) if g.is_finite() => max(0.0, min(0.999, g)),
        _ => LN_SKILL_SCORE_GOAL,
    };
    let worked = timeline.valid && effective.effective_holds > 0.0;
    let mut result = LnSkillResult {
        version: LN_SKILL_VERSION,
        key_count: map.key_count,
        rating: if timeline.valid { Some(0.0) } else { None },
        skillsets: None,
        strain: 0.0,
        eligible: worked
            && chart_is_ln(Some(4.0), Some(effective.hold_ratio), Some(effective.effective_ln_ratio)) == Some(true),
        rated: worked
            && effective.hold_ratio >= ln_primary_min_ratio_for(Some(4.0))
            && effective.identity_work_share >= LN_MIN_WORK_SHARE
            && (!effective.tap_covered || effective.effective_ln_ratio >= LN_EFFECTIVE_MIN_RATIO),
        hold_ratio: effective.hold_ratio,
        effective_ratio: effective.effective_ln_ratio,
        effective_holds: effective.effective_holds,
        rate: timeline.playback_rate,
        od: workload.od,
        score_goal,
    };
    if !timeline.valid {
        return result;
    }
    if options.include_skillsets != Some(false) {
        result.skillsets = Some(ln_skillsets_of_workload(map, workload));
    }
    if !worked || score_goal == 0.0 {
        return result;
    }
    result.strain = strain_at_goal(&workload.sections, score_goal);
    result.rating = Some(ln_rating(result.strain, timeline.playback_rate));
    result
}

pub fn ln_skillsets_of_workload(map: &LnMap, workload: &LnWorkload) -> LnFamilyVector {
    if workload.effective.identity_work_share >= LN_MIN_WORK_SHARE {
        classify_ln_skillsets(map.notes, workload.timeline.playback_rate).unwrap_or_else(empty_ln_family_vector)
    } else {
        empty_ln_family_vector()
    }
}
