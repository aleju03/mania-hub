use crate::beatmap::{ManiaNote, ManiaTimingPoint};
use crate::js::cmp_num;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RiceShape {
    pub two_back: f64,
    pub tech_sections: f64,
    pub motif_repeat: f64,
    pub speed_peak: f64,
    pub roll_sections: f64,
}

const TWO_BACK_MAX_SPAN_MS: f64 = 500.0;
const SECTION_MS: f64 = 8000.0;
const SECTION_MIN_NOTES: f64 = 40.0;
const TECH_BAND_LOW: f64 = 0.15;
const TECH_BAND_HIGH: f64 = 0.25;
const MOTIF_ROWS: usize = 4;
const MOTIF_BASE: u64 = 129;
const SPEED_OFF_GRID_SHARE: f64 = 0.5;
const SPEED_TWO_BACK: f64 = 0.15;
const SPEED_PEAK_QUANTILE: f64 = 0.75;
const ROLL_SECTION_MIN_ROWS: f64 = 136.0;
const OFF_GRID_FAST_GAP_MS: f64 = 55.0;
const SNAP_DIVISORS: [f64; 10] = [1.0, 2.0, 3.0, 4.0, 6.0, 8.0, 12.0, 16.0, 24.0, 32.0];

fn gap_snap_divisor(gap_ms: f64, beat_length_ms: f64) -> f64 {
    let tolerance = 2.0 + gap_ms * 0.01;
    for &divisor in &SNAP_DIVISORS {
        let unit = beat_length_ms / divisor;
        let steps = jsmath::round(gap_ms / unit);
        if steps >= 1.0 && (steps * unit - gap_ms).abs() <= tolerance {
            return divisor;
        }
    }
    0.0
}

#[inline]
fn round4(value: f64) -> f64 {
    jsmath::round(value * 10000.0) / 10000.0
}

pub fn rice_shape(notes: &[ManiaNote], key_count: f64, timing_points: Option<&[ManiaTimingPoint]>, bpm: f64) -> Option<RiceShape> {
    if key_count != 7.0 {
        return None;
    }
    let mut rows: Vec<(f64, u32, f64)> = Vec::new();
    let mut index: std::collections::HashMap<u64, usize> = std::collections::HashMap::new();
    let mut total = 0.0f64;
    for note in notes {
        if note.column < 0 || note.column as f64 >= key_count {
            continue;
        }
        let key = if note.time == 0.0 { 0u64 } else { note.time.to_bits() };
        match index.get(&key) {
            Some(&i) => {
                rows[i].1 |= 1 << note.column;
                rows[i].2 += 1.0;
            }
            None => {
                index.insert(key, rows.len());
                rows.push((note.time, 1 << note.column, 1.0));
            }
        }
        total += 1.0;
    }
    if total == 0.0 {
        return None;
    }
    rows.sort_by(|a, b| cmp_num(a.0, b.0));
    let mut timing: Vec<(f64, f64)> = timing_points
        .unwrap_or(&[])
        .iter()
        .filter(|p| p.time.is_finite() && p.beat_length > 0.0)
        .map(|p| (p.time, p.beat_length))
        .collect();
    timing.sort_by(|a, b| cmp_num(a.0, b.0));
    let fallback_beat_length = if bpm > 0.0 { 60000.0 / bpm } else { f64::INFINITY };
    let mut timing_index = 0usize;
    let mut sections: Vec<(f64, f64, f64, f64, f64)> = Vec::new();
    let mut hits = 0.0f64;
    for i in 0..rows.len() {
        let (time, mask, count) = rows[i];
        let key = (time / SECTION_MS).floor();
        let slot = match sections.iter().position(|s| s.0 == key) {
            Some(p) => p,
            None => {
                sections.push((key, 0.0, 0.0, 0.0, 0.0));
                sections.len() - 1
            }
        };
        sections[slot].1 += count;
        sections[slot].3 += 1.0;
        if i >= 1 {
            while timing_index + 1 < timing.len() && timing[timing_index + 1].0 <= time + 1.0 {
                timing_index += 1;
            }
            let beat_length = if !timing.is_empty() && timing[timing_index].0 <= time + 1.0 {
                timing[timing_index].1
            } else {
                timing.first().map(|p| p.1).unwrap_or(fallback_beat_length)
            };
            let gap = time - rows[i - 1].0;
            if gap <= OFF_GRID_FAST_GAP_MS {
                sections[slot].4 += 1.0;
            } else if gap <= beat_length {
                let divisor = gap_snap_divisor(gap, beat_length);
                if divisor >= 6.0 || (divisor == 0.0 && gap <= beat_length / 2.0) {
                    sections[slot].4 += 1.0;
                }
            }
        }
        if i >= 2 && time - rows[i - 2].0 <= TWO_BACK_MAX_SPAN_MS {
            let rehits = (mask & rows[i - 2].1).count_ones() as f64;
            hits += rehits;
            sections[slot].2 += rehits;
        }
    }
    let mut counted = 0.0f64;
    let mut in_band = 0.0f64;
    let mut full: Vec<(f64, f64, f64, f64)> = Vec::new();
    for &(_, n, h, r, off) in &sections {
        if n < SECTION_MIN_NOTES {
            continue;
        }
        full.push((n, h, r, off));
        counted += n;
        let share = h / n;
        if share >= TECH_BAND_LOW && share < TECH_BAND_HIGH {
            in_band += n;
        }
    }
    let mut speed_peak = 0.0f64;
    let mut roll_sections = 0.0f64;
    if !full.is_empty() {
        let mut sizes: Vec<f64> = full.iter().map(|s| s.0).collect();
        sizes.sort_by(|a, b| cmp_num(*a, *b));
        let line = sizes[(sizes.len() as f64 * SPEED_PEAK_QUANTILE).floor() as usize];
        let mut peak = 0.0f64;
        let mut rolling = 0.0f64;
        for &(n, h, r, off) in &full {
            if n < line {
                continue;
            }
            peak += n;
            if off / r >= SPEED_OFF_GRID_SHARE && h / n < SPEED_TWO_BACK {
                rolling += n;
                if r >= ROLL_SECTION_MIN_ROWS {
                    roll_sections += 1.0;
                }
            }
        }
        speed_peak = if peak > 0.0 { rolling / peak } else { 0.0 };
    }
    let mut motif_repeat = 0.0f64;
    if rows.len() >= MOTIF_ROWS + 1 {
        let mut seen: std::collections::HashSet<u64> = std::collections::HashSet::new();
        let mut repeated = 0.0f64;
        let mut windows = 0.0f64;
        for i in 0..=(rows.len() - MOTIF_ROWS) {
            let mut key = 0u64;
            for k in 0..MOTIF_ROWS {
                key = key * MOTIF_BASE + rows[i + k].1 as u64;
            }
            if !seen.insert(key) {
                repeated += 1.0;
            }
            windows += 1.0;
        }
        motif_repeat = repeated / windows;
    }
    Some(RiceShape {
        two_back: round4(hits / total),
        tech_sections: round4(if counted > 0.0 { in_band / counted } else { 0.0 }),
        motif_repeat: round4(motif_repeat),
        speed_peak: round4(speed_peak),
        roll_sections,
    })
}
