use crate::chart::Chart;
use crate::config::PATTERN_STABILITY_THRESHOLD;
use crate::defs::*;
use crate::primitives::{calculate_primitives, Prim, MAX_KEYS};

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FoundPattern {
    pub pattern: CorePattern,
    pub specific_type: Option<Specific>,
    pub mixed: bool,
    pub start: f64,
    pub end: f64,
    pub ms_per_beat: f64,
}

const MATCHER_WINDOW: usize = 8;

fn resolved_mspb(pattern: CorePattern, specific: Option<Specific>, mean_mspb: f64) -> f64 {
    if pattern == CorePattern::Density && specific == Some(Specific::Inverse) {
        return 0.0;
    }
    mean_mspb
}

fn append_found_pattern(
    results: &mut Vec<FoundPattern>,
    pattern: CorePattern,
    specific: Option<Specific>,
    n2: usize,
    remaining: &[Prim],
    last_note: f64,
) {
    let d = &remaining[..n2.min(remaining.len())];
    let mut sum = 0.0;
    for x in d {
        sum += x.ms_per_beat;
    }
    let mean_mspb = sum / d.len() as f64;
    let mixed = !d.iter().all(|x| (x.ms_per_beat - mean_mspb).abs() < PATTERN_STABILITY_THRESHOLD);

    let start = remaining[0].time;
    let end_candidate = if n2 < remaining.len() { remaining[n2].time } else { last_note };
    let end = if pattern == CorePattern::Jacks {
        jsmath::max(remaining[0].time + remaining[0].ms_per_beat * 0.5, end_candidate)
    } else {
        end_candidate
    };

    results.push(FoundPattern {
        pattern,
        specific_type: specific,
        mixed,
        start,
        end,
        ms_per_beat: resolved_mspb(pattern, specific, mean_mspb),
    });
}

fn append_core_matches(
    results: &mut Vec<FoundPattern>,
    pattern: CorePattern,
    core_n: u32,
    specific_list: &[Specific],
    remaining: &[Prim],
    last_note: f64,
) {
    if core_n == 0 {
        return;
    }
    let mut any = false;
    for &specific in specific_list {
        let m = specific.eval(remaining);
        if m != 0 {
            any = true;
            append_found_pattern(results, pattern, Some(specific), core_n.max(m) as usize, remaining, last_note);
        }
    }
    if !any {
        append_found_pattern(results, pattern, None, core_n as usize, remaining, last_note);
    }
}

fn matches(sp: &SpecificPatterns, last_note: f64, primitives: &[Prim]) -> Vec<FoundPattern> {
    let mut results = Vec::new();
    for start in 0..primitives.len() {
        let remaining = &primitives[start..(start + MATCHER_WINDOW).min(primitives.len())];
        append_core_matches(&mut results, CorePattern::Stream, core_stream(remaining), sp.stream, remaining, last_note);
        append_core_matches(&mut results, CorePattern::Chordstream, core_chordstream(remaining), sp.chordstream, remaining, last_note);
        append_core_matches(&mut results, CorePattern::Jacks, core_jacks(remaining), sp.jack, remaining, last_note);
        append_core_matches(&mut results, CorePattern::Coordination, core_coordination(remaining), sp.coordination, remaining, last_note);
        append_core_matches(&mut results, CorePattern::Density, core_density(remaining), sp.density, remaining, last_note);
        append_core_matches(&mut results, CorePattern::Wildcard, core_wildcard(remaining), sp.wildcard, remaining, last_note);
    }
    results
}

pub fn find(chart: &Chart) -> Result<Vec<FoundPattern>, String> {
    let keys = chart_keys(chart)?;
    let primitives = calculate_primitives(chart, keys);
    let sp = match keys {
        4 => &SPECIFIC_4K,
        7 => &SPECIFIC_7K,
        _ => &SPECIFIC_OTHER,
    };
    Ok(matches(sp, chart.last_note() - chart.first_note(), &primitives))
}

pub fn chart_keys(chart: &Chart) -> Result<usize, String> {
    let k = chart.keys;
    if !(k >= 1.0 && k <= MAX_KEYS as f64 && k.fract() == 0.0) || chart.notes.iter().any(|r| r.data.len() != k as usize) {
        return Err(format!("leoblack-patterns: unsupported key count {}", jsmath::number_to_string(k)));
    }
    Ok(k as usize)
}
