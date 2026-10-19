use dan_core::ln::ln_primary_min_ratio_for;
use dan_core::ln_effective::{analyze_effective_ln, EffectiveLnOptions, LN_MIN_WORK_SHARE};
use dan_core::ManiaNote;
use jsmath::{max, max_of, min};
use prism::{analyze_prism_ln_within, is_prism_key_count, prism_ln_spans, PrismOptions, PRISM_BASE_GOAL};

use crate::skill::{analyze_ln_skill, is_ln_skill_supported, LnSkillResult, LN_SKILL_VERSION};
use crate::{LnMap, LnSkillOptions};

const HELD_TIME_MIN_SHARE: f64 = 0.8;
const HELD_PRESS_MIN_SHARE: f64 = 0.3;
const HELD_PRESSES_PER_SECOND_MIN: f64 = 2.5;
const HELD_EDGE_MS: f64 = 10.0;

pub fn is_held_through(notes: &[ManiaNote], rate: f64) -> bool {
    if notes.is_empty() {
        return false;
    }
    let mut sorted = notes.to_vec();
    jsmath::js_sort_by(&mut sorted, |a, b| a.time - b.time);
    let holds: Vec<ManiaNote> = sorted.iter().copied().filter(|n| n.is_hold && n.end_time > n.time).collect();
    if holds.is_empty() {
        return false;
    }
    let mut held = 0.0;
    let mut start = holds[0].time;
    let mut end = holds[0].end_time;
    for hold in &holds {
        if hold.time > end {
            held += end - start;
            start = hold.time;
            end = hold.end_time;
        } else {
            end = max(end, hold.end_time);
        }
    }
    held += end - start;
    let first = sorted[0].time;
    let last = max_of(&sorted.iter().map(|n| max(n.time, n.end_time)).collect::<Vec<_>>());
    let span = last - first;
    if span <= 0.0 || held / span < HELD_TIME_MIN_SHARE {
        return false;
    }
    let edge = HELD_EDGE_MS * rate;
    let mut open: Vec<ManiaNote> = Vec::new();
    let mut next = 0usize;
    let mut under = 0.0;
    for note in &sorted {
        while next < holds.len() && holds[next].time <= note.time - edge {
            open.push(holds[next]);
            next += 1;
        }
        let mut i = open.len();
        while i > 0 {
            i -= 1;
            if open[i].end_time < note.time + edge {
                open.remove(i);
            }
        }
        if open.iter().any(|hold| hold.column != note.column) {
            under += 1.0;
        }
    }
    under / sorted.len() as f64 >= HELD_PRESS_MIN_SHARE && under / (span / 1000.0 / rate) >= HELD_PRESSES_PER_SECOND_MIN
}

pub fn prism_ln_skill(map: &LnMap, options: &LnSkillOptions) -> Option<LnSkillResult> {
    rate_ln(map, options, true)
}

fn play_section_min_ratio(key_count: i32) -> f64 {
    if key_count == 7 { 0.36 } else { f64::INFINITY }
}

pub fn prism_play_ln_skill(map: &LnMap, options: &LnSkillOptions) -> Option<LnSkillResult> {
    rate_ln(map, options, false)
}

const PRISM_LN_TAPPED_MAX_SHARE: f64 = 0.05;

fn rate_ln(map: &LnMap, options: &LnSkillOptions, chart: bool) -> Option<LnSkillResult> {
    if !is_prism_key_count(map.key_count) {
        return None;
    }
    let score_goal = match options.score_goal {
        Some(g) if g.is_finite() => max(0.0, min(0.999, g)),
        _ => PRISM_BASE_GOAL,
    };
    let holds = map.notes.iter().filter(|n| n.is_hold && n.end_time > n.time).count();
    let hold_ratio = if map.notes.is_empty() { 0.0 } else { holds as f64 / map.notes.len() as f64 };
    let rate = match options.rate {
        Some(r) if r.is_finite() && r > 0.0 => r,
        _ => 1.0,
    };
    let raw_od = options.od.unwrap_or(map.od);
    let od = if raw_od.is_finite() { max(0.0, min(10.0, raw_od)) } else { 8.0 };
    let effective = analyze_effective_ln(
        map.notes,
        &EffectiveLnOptions { rate: Some(rate), od: Some(od), key_count: Some(map.key_count as f64) },
    );
    let line = ln_primary_min_ratio_for(Some(map.key_count as f64));
    let held_through = holds > 0 && is_held_through(map.notes, rate);
    let tapped = effective.tap_covered && effective.tracked_share < PRISM_LN_TAPPED_MAX_SHARE && !held_through;
    let whole = holds > 0
        && (hold_ratio >= line || held_through)
        && effective.identity_work_share >= LN_MIN_WORK_SHARE
        && !effective.ln_vibro
        && !tapped;
    let sections = chart || hold_ratio >= play_section_min_ratio(map.key_count);
    let spans = if sections && !whole && holds > 0 && hold_ratio < line && !effective.ln_vibro {
        prism_ln_spans(map.notes, map.key_count, Some(od))
    } else {
        Vec::new()
    };
    let ln = whole || !spans.is_empty();
    let rating = if ln && score_goal > 0.0 {
        analyze_prism_ln_within(
            map.notes,
            map.key_count,
            map.od,
            &PrismOptions { rate: Some(rate), od: Some(od), goal: Some(score_goal), overall_only: true },
            if whole { None } else { Some(&spans) },
        )
        .unwrap_or(0.0)
    } else {
        0.0
    };
    Some(LnSkillResult {
        version: LN_SKILL_VERSION,
        key_count: map.key_count,
        rating: Some(rating),
        skillsets: None,
        strain: 0.0,
        eligible: ln,
        rated: ln,
        hold_ratio,
        effective_ratio: effective.effective_ln_ratio,
        effective_holds: effective.effective_holds,
        rate,
        od,
        score_goal,
    })
}

pub fn analyze_any_ln_skill(map: &LnMap, options: &LnSkillOptions) -> Option<LnSkillResult> {
    if !is_prism_key_count(map.key_count) {
        return analyze_ln_skill(map, options);
    }
    if is_ln_skill_supported(map.key_count) {
        prism_ln_skill(map, options)
    } else {
        None
    }
}

pub fn analyze_any_ln_skill_from_text(osu_text: &str, options: &LnSkillOptions) -> Option<LnSkillResult> {
    let parsed = chart_parser::parse_mania_beatmap(osu_text);
    let notes = prism::chart_notes(&parsed);
    analyze_any_ln_skill(&LnMap { notes: &notes, key_count: parsed.key_count, od: parsed.od }, options)
}
