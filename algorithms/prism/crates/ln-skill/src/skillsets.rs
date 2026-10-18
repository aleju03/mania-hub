use crate::skill::ln_skillsets_of_workload;
use crate::workload::{build_ln_workload, LnFamilyVector, LnWorkloadOptions};
use crate::LnMap;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LnSkillsets {
    pub scores: LnFamilyVector,
    pub rice_share: f64,
}

pub fn analyze_ln_skillsets(map: &LnMap, rate: Option<f64>, od: Option<f64>) -> Option<LnSkillsets> {
    let workload = build_ln_workload(map, &LnWorkloadOptions { rate, od, ..Default::default() })?;
    if !workload.timeline.valid {
        return None;
    }
    Some(LnSkillsets { scores: ln_skillsets_of_workload(map, &workload), rice_share: workload.rice_share })
}

pub fn ln_skillsets_for_patterns(map: &dan_core::ManiaBeatmap, rate: f64) -> Option<[f64; 4]> {
    let map = LnMap { notes: &map.notes, key_count: map.key_count, od: map.od };
    analyze_ln_skillsets(&map, Some(rate), None).map(|s| s.scores)
}
