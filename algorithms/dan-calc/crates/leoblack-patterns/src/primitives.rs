use crate::chart::{Chart, NoteType};
use crate::config::*;

pub type Mask = u128;
pub const MAX_KEYS: usize = 128;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Direction {
    None,
    Left,
    Right,
    Outwards,
    Inwards,
}

impl Direction {
    pub fn as_str(self) -> &'static str {
        match self {
            Direction::None => "None",
            Direction::Left => "Left",
            Direction::Right => "Right",
            Direction::Outwards => "Outwards",
            Direction::Inwards => "Inwards",
        }
    }

    #[inline]
    pub fn is_left_or_right(self) -> bool {
        matches!(self, Direction::Left | Direction::Right)
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Prim {
    pub index: usize,
    pub time: f64,
    pub ms_per_beat: f64,
    pub beat_length: f64,
    pub notes: u32,
    pub jacks: u32,
    pub direction: Direction,
    pub roll: bool,
    pub keys: usize,
    pub left_hand_keys: usize,
    pub ln_heads: Mask,
    pub ln_bodies: Mask,
    pub ln_tails: Mask,
    pub normal_notes: Mask,
    pub raw_notes: Mask,
}

#[inline]
pub fn lowest(mask: Mask) -> i64 {
    mask.trailing_zeros() as i64
}

#[inline]
pub fn highest(mask: Mask) -> i64 {
    127 - mask.leading_zeros() as i64
}

#[inline]
pub fn count(mask: Mask) -> u32 {
    mask.count_ones()
}

#[inline]
pub fn has(mask: Mask, col: i64) -> bool {
    (0..128).contains(&col) && (mask >> col) & 1 == 1
}

pub fn keys_on_left_hand(keymode: usize) -> usize {
    match keymode {
        3 | 4 => 2,
        5 | 6 => 3,
        7 | 8 => 4,
        9 | 10 => 5,
        _ => std::cmp::max(1, keymode / 2),
    }
}

pub fn detect_direction(previous: Mask, current: Mask) -> (Direction, bool) {
    let pleftmost = lowest(previous);
    let prightmost = highest(previous);
    let cleftmost = lowest(current);
    let crightmost = highest(current);

    let leftmost_change = cleftmost - pleftmost;
    let rightmost_change = crightmost - prightmost;

    let mut direction = Direction::None;
    if leftmost_change > 0 {
        direction = if rightmost_change > 0 { Direction::Right } else { Direction::Inwards };
    } else if leftmost_change < 0 {
        direction = if rightmost_change < 0 { Direction::Left } else { Direction::Outwards };
    } else if rightmost_change < 0 {
        direction = Direction::Inwards;
    } else if rightmost_change > 0 {
        direction = Direction::Outwards;
    }

    let is_roll = pleftmost > crightmost || prightmost < cleftmost;
    (direction, is_roll)
}

struct BeatLengthCursor<'a> {
    chart: &'a Chart,
    first_later: usize,
    last_time: f64,
}

impl<'a> BeatLengthCursor<'a> {
    fn new(chart: &'a Chart) -> Self {
        Self { chart, first_later: 0, last_time: f64::NEG_INFINITY }
    }

    fn at(&mut self, time: f64) -> f64 {
        let bpm = &self.chart.bpm;
        if bpm.is_empty() {
            return 500.0;
        }
        if !(time >= self.last_time) {
            self.first_later = 0;
        }
        self.last_time = time;
        while self.first_later < bpm.len() && !(bpm[self.first_later].time > time) {
            self.first_later += 1;
        }
        if self.first_later == 0 {
            bpm[0].data.ms_per_beat
        } else {
            bpm[self.first_later - 1].data.ms_per_beat
        }
    }
}

pub fn calculate_primitives(chart: &Chart, keys: usize) -> Vec<Prim> {
    let first_note = chart.notes[0].time;
    let first_row = &chart.notes[0].data;

    let mut previous_row: Mask = 0;
    for k in 0..keys {
        let n = first_row[k];
        if n == NoteType::Normal || n == NoteType::HoldHead {
            previous_row |= 1 << k;
        }
    }
    if previous_row == 0 {
        return Vec::new();
    }

    let mut previous_time = first_note;
    let mut index = 0usize;
    let left_hand_keys = keys_on_left_hand(keys);
    let mut cursor = BeatLengthCursor::new(chart);
    let mut out = Vec::with_capacity(chart.notes.len());

    for item in &chart.notes[1..] {
        let t = item.time;
        let row = &item.data;
        index += 1;

        let mut current_row: Mask = 0;
        let mut normal_notes: Mask = 0;
        let mut ln_heads: Mask = 0;
        let mut ln_bodies: Mask = 0;
        let mut ln_tails: Mask = 0;
        for k in 0..keys {
            let bit: Mask = 1 << k;
            match row[k] {
                NoteType::Normal => {
                    current_row |= bit;
                    normal_notes |= bit;
                }
                NoteType::HoldHead => {
                    current_row |= bit;
                    ln_heads |= bit;
                }
                NoteType::HoldBody => ln_bodies |= bit,
                NoteType::HoldTail => ln_tails |= bit,
                _ => {}
            }
        }

        if current_row == 0 && ln_heads == 0 && ln_bodies == 0 && ln_tails == 0 {
            continue;
        }

        let mut direction = Direction::None;
        let mut is_roll = false;
        let mut jacks = 0;
        if current_row != 0 {
            (direction, is_roll) = detect_direction(previous_row, current_row);
            jacks = count(current_row & previous_row);
        }

        out.push(Prim {
            index,
            time: t - first_note,
            ms_per_beat: (t - previous_time) * 4.0,
            beat_length: cursor.at(t),
            notes: count(current_row),
            jacks,
            direction,
            roll: is_roll,
            keys,
            left_hand_keys,
            ln_heads,
            ln_bodies,
            ln_tails,
            normal_notes,
            raw_notes: current_row,
        });

        if current_row != 0 {
            previous_row = current_row;
        }
        previous_time = t;
    }

    out
}

pub fn ln_percent(chart: &Chart) -> f64 {
    let mut notes = 0u64;
    let mut lnotes = 0u64;
    for item in &chart.notes {
        for &n in &item.data {
            if n == NoteType::Normal {
                notes += 1;
            } else if n == NoteType::HoldHead {
                notes += 1;
                lnotes += 1;
            }
        }
    }
    if notes > 0 {
        lnotes as f64 / notes as f64
    } else {
        0.0
    }
}

#[inline]
fn non_one(vel: f64) -> bool {
    !vel.is_finite() || (vel - 1.0).abs() > SV_SPEED_EPS
}

pub fn sv_time(chart: &Chart) -> f64 {
    if chart.sv.is_empty() {
        return 0.0;
    }

    let mut total = 0.0;
    let mut time = chart.first_note();
    let mut vel = 1.0;
    let mut non_one_intervals = 0;
    let mut in_non_one = false;

    for sv in &chart.sv {
        let cur_vel = sv.data;
        let cur_non_one = non_one(cur_vel);

        if non_one(vel) {
            total += sv.time - time;
        }

        if cur_non_one && !in_non_one {
            non_one_intervals += 1;
            in_non_one = true;
        } else if !cur_non_one {
            in_non_one = false;
        }

        vel = cur_vel;
        time = sv.time;
    }

    if non_one(vel) {
        total += chart.last_note() - time;
    }

    if non_one_intervals <= 1 {
        return 0.0;
    }

    let mut extreme = false;
    let mut prev_ms_per_beat: Option<f64> = None;
    for item in &chart.bpm {
        let ms_per_beat = item.data.ms_per_beat;
        if !ms_per_beat.is_finite() || ms_per_beat <= 0.0 {
            extreme = true;
            break;
        }

        let bpm = 60000.0 / ms_per_beat;
        if bpm <= SV_EXTREME_BPM_MIN || bpm >= SV_EXTREME_BPM_MAX {
            extreme = true;
            break;
        }

        if let Some(prev) = prev_ms_per_beat {
            if prev.is_finite() && prev > 0.0 {
                let ratio = jsmath::max(prev / ms_per_beat, ms_per_beat / prev);
                if ratio >= SV_EXTREME_BPM_RATIO {
                    extreme = true;
                    break;
                }
            }
        }

        prev_ms_per_beat = Some(ms_per_beat);
    }

    if extreme {
        return jsmath::max(total, SV_AMOUNT_THRESHOLD + 1.0);
    }

    total
}
