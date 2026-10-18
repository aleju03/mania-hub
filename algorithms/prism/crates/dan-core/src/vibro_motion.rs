use crate::beatmap::ManiaBeatmap;
use crate::js::{bit, sort_nums, NumMap, NumSet};
use crate::vibro_sections::VibroReason;

pub const REPEATED_QUAD_GAP_MS: f64 = 95.0;
pub const SLOW_QUAD_MIN_ROWS: usize = 24;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MotionInterval {
    pub start_time: f64,
    pub end_time: f64,
    pub reason: VibroReason,
}

const SPLIT_WINDOW_MS: f64 = 30.0;
const SPLIT_RUN_GAP_MS: f64 = 250.0;
const SPLIT_RUN_MIN_ACTIONS: f64 = 16.0;
const SPLIT_RUN_MIN_CYCLE_RATE: f64 = 12.0;
const FINGER_CEILING_RATE: f64 = 13.5;
const FINGER_CEILING_WINDOW_MS: f64 = 1000.0;
const ANCHOR_CEILING_RATE: f64 = 14.1;
const ANCHOR_MIN_QUAD_SHARE: f64 = 0.2;

pub(crate) fn decompose(map: &ManiaBeatmap) -> (Vec<f64>, Vec<i32>) {
    let mut masks: NumMap<i32> = NumMap::with_capacity(map.notes.len());
    for note in &map.notes {
        *masks.entry_or_insert_with(note.time, || 0) |= bit(note.column);
    }
    let mut entries = masks.entries;
    entries.sort_by(|a, b| crate::js::cmp_num(a.0, b.0));
    entries.into_iter().unzip()
}

pub fn scan_split_hand_doubles(map: &ManiaBeatmap, rate: f64) -> Vec<MotionInterval> {
    let (times, rows) = decompose(map);
    scan_split_hand_doubles_rows(&times, &rows, rate)
}

fn scan_split_hand_doubles_rows(times: &[f64], rows: &[i32], rate: f64) -> Vec<MotionInterval> {
    let mut out = Vec::new();
    for hand in 0..2 {
        let mask = if hand == 0 { 0b0011 } else { 0b1100 };
        let mut instants: Vec<f64> = Vec::new();
        for i in 0..rows.len() {
            if rows[i] & mask != 0 {
                instants.push(times[i]);
            }
        }
        let mut actions: Vec<(f64, bool)> = Vec::new();
        for &time in &instants {
            match actions.last_mut() {
                Some(last) if (time - last.0) / rate <= SPLIT_WINDOW_MS => last.1 = true,
                _ => actions.push((time, false)),
            }
        }
        let mut start: isize = -1;
        let close = |end_index: isize, start: &mut isize, out: &mut Vec<MotionInterval>| {
            if *start < 0 {
                return;
            }
            let s = *start as usize;
            let e = end_index as usize;
            let count = (end_index - *start + 1) as f64;
            let span = (actions[e].0 - actions[s].0) / rate / 1000.0;
            let cycle_rate = if span > 0.0 { (count - 1.0) / span } else { 0.0 };
            if count >= SPLIT_RUN_MIN_ACTIONS && cycle_rate >= SPLIT_RUN_MIN_CYCLE_RATE {
                out.push(MotionInterval {
                    start_time: actions[s].0,
                    end_time: actions[e].0,
                    reason: VibroReason::SplitHandDouble,
                });
            }
            *start = -1;
        };
        for i in 0..actions.len() as isize {
            if !actions[i as usize].1 {
                close(i - 1, &mut start, &mut out);
                continue;
            }
            if start >= 0 && (actions[i as usize].0 - actions[i as usize - 1].0) / rate > SPLIT_RUN_GAP_MS {
                close(i - 1, &mut start, &mut out);
            }
            if start < 0 {
                start = i;
            }
        }
        close(actions.len() as isize - 1, &mut start, &mut out);
    }
    out
}

fn lower_bound(values: &[f64], target: f64) -> usize {
    let mut lo = 0usize;
    let mut hi = values.len();
    while lo < hi {
        let mid = (lo + hi) >> 1;
        if values[mid] < target {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    lo
}

fn four_columns(map: &ManiaBeatmap) -> [Vec<f64>; 4] {
    let mut columns: [Vec<f64>; 4] = [Vec::new(), Vec::new(), Vec::new(), Vec::new()];
    for note in &map.notes {
        if note.column >= 0 && note.column < 4 {
            columns[note.column as usize].push(note.time);
        }
    }
    columns
}

pub fn scan_finger_rate_ceiling(map: &ManiaBeatmap, rate: f64) -> Vec<MotionInterval> {
    let (times, rows) = decompose(map);
    scan_finger_rate_ceiling_rows(map, &times, &rows, rate)
}

fn scan_finger_rate_ceiling_rows(map: &ManiaBeatmap, times: &[f64], rows: &[i32], rate: f64) -> Vec<MotionInterval> {
    let mut out = Vec::new();
    let mut columns = four_columns(map);
    let mut fast_rows = 0f64;
    let mut fast_quads = 0f64;
    for k in 1..times.len() {
        if (times[k] - times[k - 1]) / rate > REPEATED_QUAD_GAP_MS {
            continue;
        }
        fast_rows += 1.0;
        if rows[k] == 0b1111 {
            fast_quads += 1.0;
        }
    }
    let anchors_allowed = fast_rows > 0.0 && fast_quads / fast_rows >= ANCHOR_MIN_QUAD_SHARE;
    for column in columns.iter_mut() {
        sort_nums(column);
        let mut start = 0usize;
        let mut open_from = -1f64;
        let mut open_to = -1f64;
        for i in 0..column.len() {
            while (column[i] - column[start]) / rate > FINGER_CEILING_WINDOW_MS {
                start += 1;
            }
            let span = (column[i] - column[start]) / rate;
            if span < FINGER_CEILING_WINDOW_MS * 0.9 {
                continue;
            }
            let anchored = anchors_allowed
                && lower_bound(times, column[i]) as isize - lower_bound(times, column[start]) as isize
                    == (i - start) as isize;
            let ceiling = if anchored { ANCHOR_CEILING_RATE } else { FINGER_CEILING_RATE };
            if (i - start) as f64 / (span / 1000.0) < ceiling {
                continue;
            }
            if open_from >= 0.0 && column[start] <= open_to {
                open_to = column[i];
                continue;
            }
            if open_from >= 0.0 {
                out.push(MotionInterval { start_time: open_from, end_time: open_to, reason: VibroReason::FingerRateCeiling });
            }
            open_from = column[start];
            open_to = column[i];
        }
        if open_from >= 0.0 {
            out.push(MotionInterval { start_time: open_from, end_time: open_to, reason: VibroReason::FingerRateCeiling });
        }
    }
    out
}

const HAND_CEILING_RATE: f64 = 23.0;
const HAND_CEILING_WINDOW_MS: f64 = 1000.0;

pub fn scan_hand_action_ceiling(map: &ManiaBeatmap, rate: f64) -> Vec<MotionInterval> {
    let mut out = Vec::new();
    for hand in [0b0011, 0b1100] {
        let mut instants = NumSet::new();
        for note in &map.notes {
            if hand & bit(note.column) != 0 {
                instants.add(note.time);
            }
        }
        let mut times = instants.items;
        sort_nums(&mut times);
        let mut start = 0usize;
        let mut open_from = -1f64;
        let mut open_to = -1f64;
        for i in 0..times.len() {
            while (times[i] - times[start]) / rate > HAND_CEILING_WINDOW_MS {
                start += 1;
            }
            let span = (times[i] - times[start]) / rate;
            if span < HAND_CEILING_WINDOW_MS * 0.9 {
                continue;
            }
            if (i - start) as f64 / (span / 1000.0) < HAND_CEILING_RATE {
                continue;
            }
            if open_from >= 0.0 && times[start] <= open_to {
                open_to = times[i];
                continue;
            }
            if open_from >= 0.0 {
                out.push(MotionInterval { start_time: open_from, end_time: open_to, reason: VibroReason::HandActionCeiling });
            }
            open_from = times[start];
            open_to = times[i];
        }
        if open_from >= 0.0 {
            out.push(MotionInterval { start_time: open_from, end_time: open_to, reason: VibroReason::HandActionCeiling });
        }
    }
    out
}

const CYCLE_TOLERANCE_MS: f64 = 43.0;
const CYCLE_PURITY: f64 = 0.98;
const CYCLE_MIN_PERIOD_MS: f64 = 55.0;
const CYCLE_MAX_PERIOD_MS: f64 = 105.0;
const CYCLE_MIN_PULSES: f64 = 12.0;
const CYCLE_QUAD_SPREAD_MS: f64 = 10.0;
const CYCLE_PERIOD_STEP_MS: f64 = 2.0;
const CYCLE_PHASE_DIVISOR: f64 = 8.0;
const CYCLE_BODY_SHARE: f64 = 0.12;

fn could_carry_cycle(columns: &[Vec<f64>; 4], rate: f64) -> bool {
    let window = CYCLE_MIN_PULSES * CYCLE_MAX_PERIOD_MS * rate;
    for column in columns {
        if (column.len() as f64) < CYCLE_MIN_PULSES - 1.0 {
            return false;
        }
    }
    for &anchor in &columns[0] {
        let mut ok = true;
        for column in columns {
            let mut count = 0f64;
            let mut i = lower_bound(column, anchor);
            while i < column.len() && column[i] <= anchor + window {
                count += 1.0;
                i += 1;
            }
            if count < CYCLE_MIN_PULSES - 1.0 {
                ok = false;
                break;
            }
        }
        if ok {
            return true;
        }
    }
    false
}

pub fn scan_four_key_cycles(map: &ManiaBeatmap, rate: f64) -> Vec<MotionInterval> {
    let mut columns: [Vec<f64>; 4] = [Vec::new(), Vec::new(), Vec::new(), Vec::new()];
    let mut all: Vec<f64> = Vec::new();
    for note in &map.notes {
        if note.column >= 4 || note.column < 0 {
            continue;
        }
        columns[note.column as usize].push(note.time);
        all.push(note.time);
    }
    for column in columns.iter_mut() {
        sort_nums(column);
    }
    sort_nums(&mut all);
    if !could_carry_cycle(&columns, rate) {
        return Vec::new();
    }

    let tolerance = CYCLE_TOLERANCE_MS * rate;
    let first_note = all[0];
    let last_note = all[all.len() - 1];
    let notes_inside = |from: f64, to: f64| -> f64 { lower_bound(&all, to + 1e-6) as f64 - lower_bound(&all, from) as f64 };

    let mut found: Vec<MotionInterval> = Vec::new();
    let mut step = CYCLE_MIN_PERIOD_MS;
    while step <= CYCLE_MAX_PERIOD_MS {
        let period = step * rate;
        let mut phase = 0f64;
        while phase < period {
            let mut cursor = [0usize; 4];
            let mut from = f64::INFINITY;
            let mut to = f64::NEG_INFINITY;
            let mut pulses = 0f64;
            let mut spread = 0f64;
            let close = |from: &mut f64, to: &mut f64, pulses: &mut f64, spread: &mut f64, found: &mut Vec<MotionInterval>| {
                let slow_quads = *spread <= CYCLE_QUAD_SPREAD_MS * rate
                    && (*to - *from) / jsmath::max(1.0, *pulses - 1.0) > REPEATED_QUAD_GAP_MS * rate;
                let min_pulses = if slow_quads { SLOW_QUAD_MIN_ROWS as f64 } else { CYCLE_MIN_PULSES };
                if *pulses >= min_pulses && *pulses * 4.0 >= notes_inside(*from, *to) * CYCLE_PURITY {
                    found.push(MotionInterval { start_time: *from, end_time: *to, reason: VibroReason::FourKeyCycle });
                }
                *from = f64::INFINITY;
                *to = f64::NEG_INFINITY;
                *pulses = 0.0;
                *spread = 0.0;
            };
            let mut time = first_note - tolerance + phase;
            while time <= last_note + tolerance {
                let mut take = [0usize; 4];
                let mut complete = true;
                for column in 0..4 {
                    let notes = &columns[column];
                    let mut i = cursor[column];
                    while i < notes.len() && notes[i] < time - tolerance {
                        i += 1;
                    }
                    if i < notes.len() && notes[i] <= time + tolerance {
                        take[column] = i + 1;
                    } else {
                        take[column] = i;
                        complete = false;
                    }
                }
                if !complete {
                    close(&mut from, &mut to, &mut pulses, &mut spread, &mut found);
                    cursor = take;
                    time += period;
                    continue;
                }
                let mut first = f64::INFINITY;
                let mut last = f64::NEG_INFINITY;
                for c in 0..4 {
                    first = jsmath::min(first, columns[c][take[c] - 1]);
                    last = jsmath::max(last, columns[c][take[c] - 1]);
                    cursor[c] = take[c];
                }
                from = jsmath::min(from, first);
                to = jsmath::max(to, last);
                spread = jsmath::max(spread, last - first);
                pulses += 1.0;
                time += period;
            }
            close(&mut from, &mut to, &mut pulses, &mut spread, &mut found);
            phase += period / CYCLE_PHASE_DIVISOR;
        }
        step += CYCLE_PERIOD_STEP_MS;
    }
    if covers_enough(&found, &all) {
        found
    } else {
        Vec::new()
    }
}

fn covers_enough(found: &[MotionInterval], all: &[f64]) -> bool {
    if found.is_empty() || all.is_empty() {
        return false;
    }
    let mut spans: Vec<(f64, f64)> = found.iter().map(|i| (i.start_time, i.end_time)).collect();
    spans.sort_by(|a, b| crate::js::cmp_num(a.0, b.0));
    let mut merged: Vec<(f64, f64)> = Vec::new();
    for (start, end) in spans {
        match merged.last_mut() {
            Some(last) if start <= last.1 => last.1 = jsmath::max(last.1, end),
            _ => merged.push((start, end)),
        }
    }
    let mut covered = 0f64;
    for &(start, end) in &merged {
        covered += lower_bound(all, end + 1e-6) as f64 - lower_bound(all, start) as f64;
    }
    covered >= all.len() as f64 * CYCLE_BODY_SHARE
}

pub fn scan_motion_vibro(map: &ManiaBeatmap, rate: f64) -> Vec<MotionInterval> {
    let (times, rows) = decompose(map);
    let mut out = scan_split_hand_doubles_rows(&times, &rows, rate);
    out.extend(scan_four_key_cycles(map, rate));
    out.extend(scan_finger_rate_ceiling_rows(map, &times, &rows, rate));
    out.extend(scan_hand_action_ceiling(map, rate));
    out
}
