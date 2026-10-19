use crate::beatmap::ManiaBeatmap;
use crate::vibro_detection::detect_rate_vibro;
use crate::vibro_sections::{analyze_collapsed_notes, analyze_stacked_heads, analyze_vibro_sections, analyze_wide_jumptrill, is_unrateable_exclusion, uses_section_vibro, VibroStatus};

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RateVibroAdjustment {
    pub excluded_duration_ms: f64,
    pub time_share: f64,
    pub note_share: f64,
    pub judgement_share: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RateVibroCheck {
    pub vibro: bool,
    pub unrateable: bool,
    pub adjustment: Option<RateVibroAdjustment>,
}

pub fn check_rate_vibro(map: &ManiaBeatmap, rate: f64, has_pp_trust: bool, base_vibro: bool) -> RateVibroCheck {
    let analysis = if uses_section_vibro(map) {
        Some(analyze_vibro_sections(map, rate))
    } else {
        analyze_stacked_heads(map, rate).or_else(|| analyze_wide_jumptrill(map, rate)).or_else(|| analyze_collapsed_notes(map, rate))
    };
    let vibro = match &analysis {
        Some(a) => a.status == VibroStatus::Excluded,
        None => (!has_pp_trust && base_vibro) || (rate != 1.0 && detect_rate_vibro(map, rate)),
    };
    RateVibroCheck {
        vibro,
        unrateable: is_unrateable_exclusion(analysis.as_ref()),
        adjustment: analysis.as_ref().filter(|a| a.status == VibroStatus::Adjusted).map(|a| RateVibroAdjustment {
            excluded_duration_ms: a.excluded_duration_ms,
            time_share: a.time_share,
            note_share: a.note_share,
            judgement_share: a.judgement_share,
        }),
    }
}

pub fn check_rate_vibro_text(osu_text: &str, rate: f64, has_pp_trust: bool, base_vibro: bool) -> Option<RateVibroCheck> {
    let map = chart_parser::parse_mania_beatmap(osu_text);
    Some(check_rate_vibro(&map, rate, has_pp_trust, base_vibro))
}
