use dan_core::ManiaNote;
use jsmath::{exp, max, max_of, min, min_of};

use crate::classifier_data::{REFERENCE, WEIGHTS};
use crate::workload::LnFamilyVector;

pub const FEATURES: [&str; 19] = [
    "rowSize",
    "chordRow",
    "jackRow",
    "jackFast",
    "rollRow",
    "press1",
    "press2",
    "sameHandHeld",
    "inverse",
    "lock",
    "shortHold",
    "offGlobal",
    "offLocal",
    "splitRelease",
    "asyncRelease",
    "holdLength",
    "holdShare",
    "pressFree",
    "tailOnRow",
];
const JACK_ROW: usize = 2;
const JACK_FAST: usize = 3;
const ROW_MS: f64 = 5.0;
const HELD_MARGIN_MS: f64 = 10.0;
const TAIL_ON_ROW_MS: f64 = 8.0;
const MIN_ROW_GAP_MS: f64 = 20.0;
const OFFSET_LIMIT: f64 = 6.0;
const SPEED_JACK_VETO: f64 = 0.8;
const SPEED_JACK_VETO_MIN_SHARE: f64 = 0.05;
const LN_SPEED: usize = 3;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LnSkillsetFeatures {
    pub rows_per_second: f64,
    pub values: [f64; 19],
}

impl LnSkillsetFeatures {
    pub fn entries(&self) -> Vec<(&'static str, f64)> {
        let mut out = vec![("rowsPerSecond", self.rows_per_second)];
        for (i, name) in FEATURES.iter().enumerate() {
            out.push((name, self.values[i]));
        }
        out
    }
}

#[derive(Clone, Copy)]
struct Note {
    column: i32,
    time: f64,
    end_time: f64,
    is_hold: bool,
}

#[inline]
fn bits(mask: i32) -> i32 {
    mask.count_ones() as i32
}
#[inline]
fn lowest(mask: i32) -> i32 {
    31 - ((mask & mask.wrapping_neg()) as u32).leading_zeros() as i32
}
#[inline]
fn highest(mask: i32) -> i32 {
    31 - (mask as u32).leading_zeros() as i32
}
#[inline]
fn bit(n: i32) -> i32 {
    1i32.wrapping_shl(n as u32 & 31)
}
fn median(values: &[f64]) -> f64 {
    let mut sorted = values.to_vec();
    jsmath::js_sort_numbers_asc(&mut sorted);
    if sorted.is_empty() {
        0.0
    } else {
        sorted[sorted.len() / 2]
    }
}
fn lower_bound(values: &[f64], x: f64) -> usize {
    let mut lo = 0usize;
    let mut hi = values.len();
    while lo < hi {
        let mid = (lo + hi) >> 1;
        if values[mid] < x {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    lo
}

fn uneven_groups(holds: &[Note], key: fn(&Note) -> f64, other: fn(&Note) -> f64) -> f64 {
    let mut sorted = holds.to_vec();
    jsmath::js_sort_by(&mut sorted, |a, b| key(a) - key(b));
    let mut count = 0usize;
    let mut i = 0usize;
    while i < sorted.len() {
        let mut j = i + 1;
        while j < sorted.len() && key(&sorted[j]) - key(&sorted[i]) <= ROW_MS {
            j += 1;
        }
        let others: Vec<f64> = sorted[i..j].iter().map(other).collect();
        if j - i >= 2 && max_of(&others) - min_of(&others) > ROW_MS {
            count += j - i;
        }
        i = j;
    }
    count as f64 / max(1.0, holds.len() as f64)
}

pub fn ln_skillset_features(input: &[ManiaNote], rate: f64) -> Option<LnSkillsetFeatures> {
    if input.len() < 2 {
        return None;
    }
    let mut notes: Vec<Note> = input
        .iter()
        .map(|n| Note { column: n.column, time: n.time / rate, end_time: n.end_time / rate, is_hold: n.is_hold })
        .collect();
    jsmath::js_sort_by(&mut notes, |a, b| {
        let d = a.time - b.time;
        if d != 0.0 && !d.is_nan() {
            d
        } else {
            (a.column - b.column) as f64
        }
    });
    let mut rows: Vec<(f64, i32)> = Vec::new();
    for note in &notes {
        match rows.last_mut() {
            Some(last) if note.time - last.0 <= ROW_MS => last.1 |= bit(note.column),
            _ => rows.push((note.time, bit(note.column))),
        }
    }
    let seconds = max(1.0, (notes[notes.len() - 1].time - notes[0].time) / 1000.0);
    let gaps: Vec<f64> = (1..rows.len()).map(|i| rows[i].0 - rows[i - 1].0).filter(|&gap| gap > ROW_MS).collect();
    let row_gap = max(MIN_ROW_GAP_MS, median(&gaps));
    let holds: Vec<Note> = notes.iter().copied().filter(|n| n.is_hold).collect();
    let hold_count = max(1.0, holds.len() as f64);

    let mut chord_rows = 0.0;
    let mut jack_row = 0.0;
    let mut jack_fast = 0.0;
    let mut roll_row = 0.0;
    for i in 0..rows.len() {
        let mask = rows[i].1;
        if bits(mask) >= 2 {
            chord_rows += 1.0;
        }
        if i == 0 {
            continue;
        }
        let previous = rows[i - 1].1;
        let fast = rows[i].0 - rows[i - 1].0 <= 1.05 * row_gap;
        if mask & previous != 0 {
            jack_row += 1.0;
            if fast {
                jack_fast += 1.0;
            }
        } else if fast && (highest(mask) < lowest(previous) || lowest(mask) > highest(previous)) {
            roll_row += 1.0;
        }
    }

    let lane_of = |c: i32| c as usize;
    let mut start = [0.0f64; 4];
    let mut end = [f64::NEG_INFINITY; 4];
    let mut last_end = [f64::NEG_INFINITY; 4];
    let mut press_free = 0.0;
    let mut press1 = 0.0;
    let mut press2 = 0.0;
    let mut same_hand_held = 0.0;
    let mut inverse = 0.0;
    for note in &notes {
        let mut held = 0;
        let mut same_hand = false;
        for lane in 0..4i32 {
            let l = lane as usize;
            if lane == note.column || !(start[l] < note.time - HELD_MARGIN_MS && end[l] > note.time + HELD_MARGIN_MS) {
                continue;
            }
            held += 1;
            if (lane < 2) == (note.column < 2) {
                same_hand = true;
            }
        }
        if held == 0 {
            press_free += 1.0;
        }
        if held == 1 {
            press1 += 1.0;
        }
        if held >= 2 {
            press2 += 1.0;
        }
        if same_hand {
            same_hand_held += 1.0;
        }
        let c = lane_of(note.column);
        let since_release = note.time - last_end[c];
        if note.is_hold && since_release >= 0.0 && since_release <= 1.05 * row_gap {
            inverse += 1.0;
        }
        last_end[c] = note.end_time;
        if note.is_hold {
            start[c] = note.time;
            end[c] = note.end_time;
        }
    }

    let starts: Vec<f64> = notes.iter().map(|n| n.time).collect();
    let lane_starts: [Vec<f64>; 4] =
        [0, 1, 2, 3].map(|lane| notes.iter().filter(|n| n.column == lane).map(|n| n.time).collect());
    let mut lock = 0.0;
    let mut short_hold = 0.0;
    let mut off_global = 0.0;
    let mut off_local = 0.0;
    let mut tail_on_row = 0.0;
    for hold in &holds {
        let partner = &lane_starts[lane_of(hold.column ^ 1)];
        if lower_bound(partner, hold.end_time + 1.0) as f64 - lower_bound(partner, hold.time) as f64 >= 2.0 {
            lock += 1.0;
        }
        if hold.end_time - hold.time <= 0.55 * row_gap {
            short_hold += 1.0;
        }
        let i = lower_bound(&starts, hold.end_time - ROW_MS);
        let next = if i < starts.len() { starts[i] } else { f64::INFINITY };
        let previous = if i >= 1 { starts[i - 1] } else { f64::NEG_INFINITY };
        let gap = min((next - hold.end_time).abs(), (hold.end_time - previous).abs());
        if gap <= TAIL_ON_ROW_MS {
            tail_on_row += 1.0;
        }
        if gap / row_gap > 0.1 && gap / row_gap < 0.9 {
            off_global += 1.0;
        }
        let span = next - previous;
        if span.is_finite() && span > 0.0 && gap > TAIL_ON_ROW_MS && gap / span > 0.15 {
            off_local += 1.0;
        }
    }

    let rows_len = rows.len() as f64;
    let notes_len = notes.len() as f64;
    let hold_lengths: Vec<f64> = holds.iter().map(|h| h.end_time - h.time).collect();
    Some(LnSkillsetFeatures {
        rows_per_second: rows_len / seconds,
        values: [
            notes_len / rows_len,
            chord_rows / rows_len,
            jack_row / rows_len,
            jack_fast / rows_len,
            roll_row / rows_len,
            press1 / notes_len,
            press2 / notes_len,
            same_hand_held / notes_len,
            inverse / hold_count,
            lock / hold_count,
            short_hold / hold_count,
            off_global / hold_count,
            off_local / hold_count,
            uneven_groups(&holds, |h| h.time, |h| h.end_time),
            uneven_groups(&holds, |h| h.end_time, |h| h.time),
            median(&hold_lengths) / row_gap,
            holds.len() as f64 / notes_len,
            press_free / notes_len,
            tail_on_row / hold_count,
        ],
    })
}

fn interpolate(x: f64, column: usize) -> f64 {
    let first = &REFERENCE[0];
    let last = &REFERENCE[REFERENCE.len() - 1];
    if x <= first[0] {
        return first[column];
    }
    if x >= last[0] {
        return last[column];
    }
    let upper = REFERENCE.iter().position(|row| row[0] >= x).map_or(-1, |i| i as isize);
    let upper = upper as usize;
    let a = &REFERENCE[upper - 1];
    let b = &REFERENCE[upper];
    a[column] + (b[column] - a[column]) * (x - a[0]) / (b[0] - a[0])
}

pub fn classify_ln_skillsets(notes: &[ManiaNote], rate: f64) -> Option<LnFamilyVector> {
    let features = ln_skillset_features(notes, rate)?;
    if !features.rows_per_second.is_finite() || !features.values.iter().all(|v| v.is_finite()) {
        return None;
    }
    let rps = features.rows_per_second;
    let mut offsets = [0.0f64; 19];
    for i in 0..FEATURES.len() {
        let iqr = max(interpolate(rps, 2 + 2 * i), 1e-6);
        let offset = (features.values[i] - interpolate(rps, 1 + 2 * i)) / iqr;
        offsets[i] = max(-OFFSET_LIMIT, min(OFFSET_LIMIT, offset));
    }
    let jack_veto = offsets[JACK_ROW] > SPEED_JACK_VETO
        && offsets[JACK_FAST] > SPEED_JACK_VETO
        && features.values[JACK_FAST] >= SPEED_JACK_VETO_MIN_SHARE;
    let mut logits: Vec<(usize, f64)> = (0..4)
        .map(|id| {
            let w = &WEIGHTS[id];
            let value = if id == LN_SPEED && jack_veto {
                f64::NEG_INFINITY
            } else {
                let mut sum = 0.0;
                for i in 0..offsets.len() {
                    sum += w[i + 1] * offsets[i];
                }
                w[0] + sum
            };
            (id, value)
        })
        .collect();
    jsmath::js_sort_by(&mut logits, |a, b| b.1 - a.1);
    let mut result = [0.0f64; 4];
    result[logits[0].0] = 1.0;
    result[logits[1].0] = exp(logits[1].1 - logits[0].1);
    Some(result)
}
