use crate::beatmap::ManiaBeatmap;
use crate::js::FxHashMap;

pub const DAN_INELIGIBLE_STACKED_HEAD_MIN: f64 = 8.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ChartDanEligibility {
    pub eligible: bool,
    pub reason: Option<&'static str>,
    pub max_same_column_head_stack: f64,
    pub redundant_same_column_heads: f64,
}

pub fn inspect_chart_dan_eligibility(map: &ManiaBeatmap) -> ChartDanEligibility {
    let mut heads: FxHashMap<(i32, u64), f64> = FxHashMap::default();
    for note in &map.notes {
        *heads.entry((note.column, crate::js::key(note.time))).or_insert(0.0) += 1.0;
    }
    let mut max_stack = 0f64;
    let mut redundant = 0f64;
    for &count in heads.values() {
        max_stack = jsmath::max(max_stack, count);
        redundant += jsmath::max(0.0, count - 1.0);
    }
    let eligible = max_stack < DAN_INELIGIBLE_STACKED_HEAD_MIN;
    ChartDanEligibility {
        eligible,
        reason: if eligible { None } else { Some("stacked_same_column_heads") },
        max_same_column_head_stack: max_stack,
        redundant_same_column_heads: redundant,
    }
}
