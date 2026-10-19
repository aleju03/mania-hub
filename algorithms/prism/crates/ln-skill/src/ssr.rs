use jsmath::{max, min, pow};
use prism::{is_prism_key_count, uses_prism, PRISM_BASE_GOAL, PRISM_MAX_GOAL};

use crate::prism_ln::prism_play_ln_skill;
use crate::skill::{is_ln_skill_supported, ln_rating_at_goal, ln_skill_of_workload, LnSkillResult};
use crate::workload::{build_ln_workload, LnWorkloadOptions};
use crate::{LnMap, LnSkillOptions};

pub const SSR_CALC_GOAL_CAP: f64 = 0.965;
pub const SSR_EXTRAPOLATION_BASE_GOAL: f64 = 0.93;
pub const SSR_EXTRAPOLATION_MAX_SLOPE: f64 = 1.2;

pub fn ssr_goal_anchors(key_count: Option<i32>) -> (f64, f64) {
    if uses_prism(key_count) {
        (PRISM_MAX_GOAL, PRISM_BASE_GOAL)
    } else {
        (SSR_CALC_GOAL_CAP, SSR_EXTRAPOLATION_BASE_GOAL)
    }
}

pub fn ln_ssr_solver_goal(goal: f64, key_count: Option<i32>) -> f64 {
    min(ssr_goal_anchors(key_count).0, max(0.0, min(0.999, goal)))
}

fn extrapolated(at_cap: f64, at_base: f64, goal: f64) -> f64 {
    if !(at_base > 0.0) || at_cap <= at_base {
        return at_cap;
    }
    let exponent = (goal - SSR_CALC_GOAL_CAP) / (SSR_CALC_GOAL_CAP - SSR_EXTRAPOLATION_BASE_GOAL);
    at_cap * pow(min(at_cap / at_base, SSR_EXTRAPOLATION_MAX_SLOPE), exponent)
}

pub fn analyze_ln_ssr(map: &LnMap, rate: f64, od: Option<f64>, score_goal: f64) -> Option<LnSkillResult> {
    let goal = max(0.0, min(0.999, score_goal));
    let solver_goal = ln_ssr_solver_goal(goal, None);
    if is_prism_key_count(map.key_count) {
        if !is_ln_skill_supported(map.key_count) {
            return None;
        }
        let skill = prism_play_ln_skill(map, &LnSkillOptions { rate: Some(rate), od, score_goal: Some(goal), include_skillsets: None })?;
        return Some(LnSkillResult { score_goal: ln_ssr_solver_goal(goal, Some(map.key_count)), ..skill });
    }
    let workload = build_ln_workload(map, &LnWorkloadOptions { rate: Some(rate), od, ..Default::default() })?;
    let capped =
        ln_skill_of_workload(map, &workload, &LnSkillOptions { score_goal: Some(solver_goal), ..Default::default() });
    let rating = match capped.rating {
        Some(r) if goal > SSR_CALC_GOAL_CAP && r > 0.0 => r,
        _ => return Some(capped),
    };
    let at_base = ln_rating_at_goal(&workload, SSR_EXTRAPOLATION_BASE_GOAL);
    Some(LnSkillResult { rating: Some(extrapolated(rating, at_base, goal)), ..capped })
}

pub fn analyze_ln_ssr_from_text(osu_text: &str, rate: f64, od: Option<f64>, score_goal: f64) -> Option<LnSkillResult> {
    let parsed = chart_parser::parse_mania_beatmap(osu_text);
    let notes = prism::chart_notes(&parsed);
    analyze_ln_ssr(&LnMap { notes: &notes, key_count: parsed.key_count, od: parsed.od }, rate, od, score_goal)
}
