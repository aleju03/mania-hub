use crate::defs::Specific;
use crate::summary::PatternReport;

pub fn detect_vibro_from_longjack_pattern(report: Option<&PatternReport>, threshold: f64, min_bpm: f64) -> bool {
    let Some(report) = report else { return false };
    let bpm_limit = if min_bpm.is_finite() && min_bpm > 0.0 { min_bpm } else { 0.0 };
    for cluster in &report.clusters {
        let cluster_bpm = cluster.bpm;
        if !cluster_bpm.is_finite() || cluster_bpm < bpm_limit {
            continue;
        }
        for &(name, ratio) in &cluster.specific_types {
            if name == Specific::Longjacks && ratio.is_finite() && ratio >= threshold {
                return true;
            }
        }
    }
    false
}

pub fn detect_longjack_vibro_at_rate(report: Option<&PatternReport>, rate: f64) -> bool {
    detect_vibro_from_longjack_pattern(
        report,
        crate::config::LONGJACK_VIBRO_RATIO_THRESHOLD,
        crate::config::LONGJACK_VIBRO_MIN_BPM / rate,
    )
}

pub fn detect_vibro(lookup: impl Fn(&str) -> f64, threshold: f64) -> bool {
    let pick = |keys: &[&str]| keys.iter().map(|k| lookup(k)).find(|v| v.is_finite());
    let overall = pick(&["Overall", "overall"]);
    let jack_speed = pick(&["JackSpeed", "Jackspeed", "jackSpeed", "jackspeed"]);
    match (overall, jack_speed) {
        (Some(overall), Some(jack_speed)) if overall > 0.0 => (jack_speed / overall) >= threshold,
        _ => false,
    }
}
