use dan_core::ln::ln_primary_min_ratio_for;
use dan_core::ln_effective::{read_effective_holds, EffectiveLnOptions};
use dan_core::ManiaNote;

pub const PRISM_LN_SECTION_WINDOW_MS: f64 = 15_000.0;
pub const PRISM_LN_SECTION_STEP_MS: f64 = 1_000.0;
pub const PRISM_LN_SECTION_MIN_NOTES_PER_SECOND: f64 = 1.0;
pub const PRISM_LN_SECTION_MIN_MS: f64 = 30_000.0;

pub fn prism_ln_section_line(key_count: i32) -> f64 {
    ln_primary_min_ratio_for(Some(key_count as f64))
}

pub fn prism_ln_spans(notes: &[ManiaNote], key_count: i32, od: Option<f64>) -> Vec<(f64, f64)> {
    let effective = od.filter(|od| od.is_finite()).map(|od| {
        read_effective_holds(notes, &EffectiveLnOptions { rate: Some(1.0), od: Some(od), key_count: Some(key_count as f64) }, false).mask
    });
    let mut valid: Vec<(f64, bool)> = Vec::new();
    for (index, note) in notes.iter().enumerate() {
        if note.column < 0 || note.column >= key_count || !note.time.is_finite() {
            continue;
        }
        let hold = note.is_hold
            && note.end_time > note.time
            && effective.as_ref().map_or(true, |mask| mask.get(index).copied() == Some(true));
        valid.push((note.time, hold));
    }
    if valid.is_empty() {
        return Vec::new();
    }
    jsmath::js_sort_by(&mut valid, |a, b| a.0 - b.0);
    let origin = valid[0].0;
    let last = valid[valid.len() - 1].0 - origin;
    let line = prism_ln_section_line(key_count);
    let min_notes = (PRISM_LN_SECTION_WINDOW_MS / 1000.0) * PRISM_LN_SECTION_MIN_NOTES_PER_SECOND;
    let mut spans: Vec<(f64, f64)> = Vec::new();
    let mut total = 0.0;
    let (mut lo, mut hi) = (0usize, 0usize);
    let (mut count, mut holds) = (0.0f64, 0.0f64);
    let mut step = 0.0f64;
    while step * PRISM_LN_SECTION_STEP_MS <= last {
        let start = step * PRISM_LN_SECTION_STEP_MS;
        step += 1.0;
        let centre = start + PRISM_LN_SECTION_STEP_MS / 2.0;
        let from = centre - PRISM_LN_SECTION_WINDOW_MS / 2.0;
        let to = centre + PRISM_LN_SECTION_WINDOW_MS / 2.0;
        while hi < valid.len() && valid[hi].0 - origin < to {
            count += 1.0;
            if valid[hi].1 {
                holds += 1.0;
            }
            hi += 1;
        }
        while lo < hi && valid[lo].0 - origin < from {
            count -= 1.0;
            if valid[lo].1 {
                holds -= 1.0;
            }
            lo += 1;
        }
        if count < min_notes || holds / count < line {
            continue;
        }
        let end = start + PRISM_LN_SECTION_STEP_MS;
        match spans.last_mut() {
            Some(open) if open.1 == start => open.1 = end,
            _ => spans.push((start, end)),
        }
        total += PRISM_LN_SECTION_STEP_MS;
    }
    if total >= PRISM_LN_SECTION_MIN_MS {
        spans
    } else {
        Vec::new()
    }
}
