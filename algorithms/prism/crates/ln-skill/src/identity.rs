use std::collections::HashMap;

use dan_core::ln::ln_primary_min_ratio_for;
use dan_core::ln_effective::{
    analyze_effective_ln, chart_is_ln, EffectiveLnOptions, LN_EFFECTIVE_KEY_COUNTS, LN_EFFECTIVE_MIN_RATIO,
    LN_SAME_MOTION_TOLERANCE_MS, LN_TRACKED_MIN_SHARE,
};
use jsmath::{max, round};

use crate::skill::ln_skill_of_workload;
use crate::workload::{build_ln_workload, LnPricing, LnWorkload, LnWorkloadOptions};
use crate::{LnMap, LnSkillOptions};

pub const LN_RATING_IDENTITY_MARGIN: f64 = 1.0;
pub const LN_HELD_THROUGH_MIN_SHARE: f64 = 0.022;
pub const LN_HELD_THROUGH_MIN_ROWS: usize = 2;
const HELD_THROUGH_WINDOW_MS: f64 = 2000.0;
const HELD_THROUGH_TOP_SHARE: f64 = 0.2;
const HELD_THROUGH_MIN_NOTES: f64 = 4.0;

#[derive(Clone, Copy, Default)]
struct Window {
    notes: f64,
    held: f64,
    demand: f64,
}

pub fn ln_held_through_share(workload: &LnWorkload) -> f64 {
    let mut objects = workload.timeline.objects.clone();
    jsmath::js_sort_by(&mut objects, |a, b| a.start_ms - b.start_ms);
    if objects.is_empty() || workload.sections.is_empty() {
        return 0.0;
    }
    let origin = objects[0].start_ms;
    let mut windows: Vec<Window> = Vec::new();
    let mut index: HashMap<u64, usize> = HashMap::new();
    let mut window_at = |time_ms: f64, windows: &mut Vec<Window>| -> usize {
        let key = ((time_ms - origin) / HELD_THROUGH_WINDOW_MS).floor();
        let key = if key == 0.0 { 0 } else { key.to_bits() };
        *index.entry(key).or_insert_with(|| {
            windows.push(Window::default());
            windows.len() - 1
        })
    };
    let tolerance = LN_SAME_MOTION_TOLERANCE_MS;
    for (i, object) in objects.iter().enumerate() {
        let w = window_at(object.start_ms, &mut windows);
        windows[w].notes += 1.0;
        if !object.is_hold {
            continue;
        }
        let mut rows = 0usize;
        let mut last_row = f64::NAN;
        let mut next = i + 1;
        while next < objects.len() && objects[next].start_ms < object.end_ms - tolerance {
            let other = &objects[next];
            if other.lane != object.lane && other.start_ms > object.start_ms + tolerance {
                let r = round(other.start_ms);
                if rows == 0 || r != last_row {
                    rows += 1;
                    last_row = r;
                    if rows >= LN_HELD_THROUGH_MIN_ROWS {
                        break;
                    }
                }
            }
            next += 1;
        }
        if rows >= LN_HELD_THROUGH_MIN_ROWS {
            windows[w].held += 1.0;
        }
    }
    let section_origin = objects.iter().find(|o| o.is_hold).map_or(origin, |o| o.start_ms);
    for section in &workload.sections {
        let w = window_at(section_origin + section.time_ms, &mut windows);
        windows[w].demand = max(windows[w].demand, section.demand);
    }
    let mut ranked: Vec<Window> = windows.into_iter().filter(|w| w.notes >= HELD_THROUGH_MIN_NOTES).collect();
    jsmath::js_sort_by(&mut ranked, |a, b| b.demand - a.demand);
    let take = max(1.0, (ranked.len() as f64 * HELD_THROUGH_TOP_SHARE).ceil()) as usize;
    let top = &ranked[..take.min(ranked.len())];
    let mut notes = 0.0;
    for w in top {
        notes += w.notes;
    }
    if notes > 0.0 {
        let mut held = 0.0;
        for w in top {
            held += w.held;
        }
        held / notes
    } else {
        0.0
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct LnIdentityShares {
    pub ln_ratio: Option<f64>,
    pub ln_effective_ratio: Option<f64>,
    pub ln_tap_covered: Option<bool>,
    pub ln_held_peak_light: Option<bool>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct LnIdentityResolution {
    pub ln_effective_ratio: Option<f64>,
    pub ln_rating_identity: bool,
    pub ln_structural_ratio: Option<f64>,
    pub ln_work_share: Option<f64>,
    pub ln_rice_share: Option<f64>,
    pub hold_ratio: Option<f64>,
}

pub fn ln_rating_identity_undecided(key_count: Option<i32>, shares: &LnIdentityShares) -> bool {
    let Some(key_count) = key_count else { return false };
    if !LN_EFFECTIVE_KEY_COUNTS.contains(&key_count)
        || shares.ln_tap_covered == Some(true)
        || shares.ln_held_peak_light == Some(true)
    {
        return false;
    }
    let effective = shares.ln_effective_ratio.unwrap_or(f64::NAN);
    let hold = shares.ln_ratio.unwrap_or(f64::NAN);
    if !effective.is_finite() || !hold.is_finite() {
        return false;
    }
    let kc = Some(key_count as f64);
    hold >= ln_primary_min_ratio_for(kc) && chart_is_ln(kc, shares.ln_ratio, shares.ln_effective_ratio) != Some(true)
}

pub fn resolve_ln_identity_share(
    key_count: Option<i32>,
    shares: &LnIdentityShares,
    ln_rating: Option<f64>,
    rated: bool,
    overall: Option<f64>,
) -> LnIdentityResolution {
    let effective = shares.ln_effective_ratio;
    let base = LnIdentityResolution {
        ln_effective_ratio: effective.filter(|e| e.is_finite()),
        ln_rating_identity: false,
        ..Default::default()
    };
    if !ln_rating_identity_undecided(key_count, shares) {
        return base;
    }
    let (Some(ln), Some(overall)) = (ln_rating, overall) else { return base };
    if !rated || !ln.is_finite() || !overall.is_finite() || !(ln >= overall + LN_RATING_IDENTITY_MARGIN) {
        return base;
    }
    LnIdentityResolution {
        ln_effective_ratio: Some(LN_EFFECTIVE_MIN_RATIO),
        ln_rating_identity: true,
        ln_structural_ratio: base.ln_effective_ratio,
        ..Default::default()
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct LnIdentityOptions {
    pub rate: f64,
    pub od: Option<f64>,
    pub hold_ratio: Option<f64>,
    pub overall: Option<f64>,
}

pub fn resolve_chart_ln_identity(map: &LnMap, options: &LnIdentityOptions) -> LnIdentityResolution {
    let od = options.od.unwrap_or(map.od);
    let workload = build_ln_workload(
        map,
        &LnWorkloadOptions { rate: Some(options.rate), od: Some(od), pricing: LnPricing::Identity },
    );
    let valid = workload.as_ref().map_or(false, |w| w.timeline.valid);
    let analysis = match &workload {
        Some(w) if valid => w.effective,
        _ => analyze_effective_ln(
            map.notes,
            &EffectiveLnOptions { rate: Some(options.rate), od: Some(od), key_count: Some(map.key_count as f64) },
        ),
    };
    let hold_ratio = match options.hold_ratio {
        Some(h) if h.is_finite() => h,
        _ => analysis.hold_ratio,
    };
    let shares = LnIdentityShares {
        ln_ratio: Some(hold_ratio),
        ln_effective_ratio: Some(analysis.effective_ln_ratio),
        ln_tap_covered: Some(analysis.tap_covered),
        ln_held_peak_light: Some(analysis.held_peak_light),
    };
    let measured = LnIdentityResolution {
        hold_ratio: Some(hold_ratio),
        ln_work_share: Some(analysis.identity_work_share),
        ln_rice_share: if valid { workload.as_ref().map(|w| w.rice_share) } else { None },
        ..Default::default()
    };
    let chains_only = analysis.tracked_share < LN_TRACKED_MIN_SHARE;
    let structural = LnIdentityResolution {
        ln_effective_ratio: Some(analysis.effective_ln_ratio),
        ln_rating_identity: false,
        ..measured
    };
    let Some(workload) = workload else { return structural };
    if !ln_rating_identity_undecided(Some(map.key_count), &shares)
        || options.overall.is_none()
        || (chains_only && ln_held_through_share(&workload) < LN_HELD_THROUGH_MIN_SHARE)
    {
        return structural;
    }
    let skill = ln_skill_of_workload(map, &workload, &LnSkillOptions { include_skillsets: Some(false), ..Default::default() });
    let resolved = resolve_ln_identity_share(Some(map.key_count), &shares, skill.rating, skill.rated, options.overall);
    LnIdentityResolution {
        ln_effective_ratio: resolved.ln_effective_ratio,
        ln_rating_identity: resolved.ln_rating_identity,
        ln_structural_ratio: resolved.ln_structural_ratio,
        ..measured
    }
}
