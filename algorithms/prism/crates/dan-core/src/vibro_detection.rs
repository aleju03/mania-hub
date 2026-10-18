use crate::beatmap::{ManiaBeatmap, ManiaNote};
use crate::js::{bit, sort_nums, FxHashMap, NumMap, NumSet};
use crate::vibro_sections::{analyze_collapsed_notes, analyze_hold_vibro, analyze_stacked_heads, analyze_vibro_sections, analyze_wide_jumptrill, uses_section_vibro, VibroStatus};

const LN_VIBRO_MIN_ROWS: usize = 150;
const LN_VIBRO_MIN_HOLD_RATIO: f64 = 0.5;
const LN_VIBRO_MAX_P75_ROW_GAP_MS: f64 = 40.0;

const RICE_VIBRO_MIN_NOTES: usize = 300;
const RICE_VIBRO_COLUMN_GAP_MS: f64 = 92.0;
const RICE_VIBRO_COLUMN_MIN_RUN: f64 = 24.0;
const RICE_VIBRO_COLUMN_MIN_RATIO: f64 = 0.25;
const RICE_VIBRO_WALL_GAP_MS: f64 = 105.0;
const RICE_VIBRO_WALL_MIN_ROWS: f64 = 12.0;
const RICE_VIBRO_WALL_MIN_ROW_RATIO: f64 = 0.035;
const RICE_VIBRO_WALL_COLUMN_GAP_MS: f64 = 98.0;
const RICE_VIBRO_WALL_COLUMN_MIN_RATIO: f64 = 0.32;
const RICE_VIBRO_BURST_MIN_NOTES: usize = 200;
const RICE_VIBRO_BURST_GAP_MS: f64 = 100.0;
const RICE_VIBRO_BURST_MIN_RUN: f64 = 8.0;
const RICE_VIBRO_BURST_MIN_RUNS: f64 = 4.0;
const RICE_VIBRO_BURST_MIN_FRACTION: f64 = 0.2;
const RICE_VIBRO_ROW_RATE_WINDOW_MS: f64 = 1000.0;
const RICE_VIBRO_MAX_ROWS_PER_SECOND: f64 = 65.0;
const RICE_VIBRO_CHORD_WALL_GAP_MS: f64 = 70.0;
const RICE_VIBRO_CHORD_WALL_MIN_RATIO: f64 = 0.02;
const RICE_VIBRO_ROLL_GAP_MS: f64 = 70.0;
const RICE_VIBRO_ROLL_MIN_RATIO: f64 = 0.25;
const RICE_VIBRO_ROLL_ROW_GAP_MS: f64 = 25.0;
const RICE_VIBRO_ROLL_MIN_ROW_RATIO: f64 = 0.3;

fn times_by_column(map: &ManiaBeatmap) -> Vec<Vec<f64>> {
    let mut index: FxHashMap<i32, usize> = FxHashMap::default();
    let mut lists: Vec<Vec<f64>> = Vec::new();
    for note in &map.notes {
        let i = *index.entry(note.column).or_insert_with(|| {
            lists.push(Vec::new());
            lists.len() - 1
        });
        lists[i].push(note.time);
    }
    for list in &mut lists {
        sort_nums(list);
    }
    lists
}

fn column_fast_gaps(columns: &[Vec<f64>], cutoff_ms: f64) -> (f64, f64) {
    let mut max_run = 0f64;
    let mut fast = 0f64;
    let mut total = 0f64;
    for times in columns {
        let mut run = 0f64;
        for index in 1..times.len() {
            let gap = times[index] - times[index - 1];
            if gap <= 0.0 {
                continue;
            }
            total += 1.0;
            if gap <= cutoff_ms {
                fast += 1.0;
                run += 1.0;
                if run > max_run {
                    max_run = run;
                }
            } else {
                run = 0.0;
            }
        }
    }
    (max_run, if total > 0.0 { fast / total } else { 0.0 })
}

fn fast_roll_row_share(map: &ManiaBeatmap, cutoff_ms: f64) -> f64 {
    let mut rows: NumMap<Vec<i32>> = NumMap::new();
    for note in &map.notes {
        let cols = rows.entry_or_insert_with(note.time, Vec::new);
        if !cols.contains(&note.column) {
            cols.push(note.column);
        }
    }
    let mut order: Vec<usize> = (0..rows.len()).collect();
    order.sort_by(|&a, &b| crate::js::cmp_num(rows.entries[a].0, rows.entries[b].0));
    if order.len() < 2 {
        return 0.0;
    }
    let mut fast = 0f64;
    for index in 1..order.len() {
        let (t, ref cur) = rows.entries[order[index]];
        let (tp, ref prev) = rows.entries[order[index - 1]];
        if t - tp > cutoff_ms {
            continue;
        }
        let shared = cur.iter().any(|c| prev.contains(c));
        if !shared {
            fast += 1.0;
        }
    }
    fast / (order.len() as f64 - 1.0)
}

fn column_burst_runs(columns: &[Vec<f64>], cutoff_ms: f64, min_run: f64) -> (f64, f64) {
    let mut runs = 0f64;
    let mut in_runs = 0f64;
    let mut total = 0f64;
    for times in columns {
        let mut run = 0f64;
        for index in 1..times.len() {
            let gap = times[index] - times[index - 1];
            if gap <= 0.0 {
                continue;
            }
            total += 1.0;
            if gap <= cutoff_ms {
                run += 1.0;
            } else {
                if run >= min_run {
                    runs += 1.0;
                    in_runs += run;
                }
                run = 0.0;
            }
        }
        if run >= min_run {
            runs += 1.0;
            in_runs += run;
        }
    }
    (runs, if total > 0.0 { in_runs / total } else { 0.0 })
}

fn row_sizes(map: &ManiaBeatmap) -> Vec<(f64, f64)> {
    let mut sizes: NumMap<f64> = NumMap::new();
    for note in &map.notes {
        *sizes.entry_or_insert_with(note.time, || 0.0) += 1.0;
    }
    let mut entries = sizes.entries;
    entries.sort_by(|a, b| crate::js::cmp_num(a.0, b.0));
    entries
}

fn quad_wall_rows(rows: &[(f64, f64)], cutoff_ms: f64) -> (f64, f64) {
    let mut count = 0f64;
    for index in 1..rows.len() {
        let gap = rows[index].0 - rows[index - 1].0;
        if gap <= 0.0 || gap > cutoff_ms {
            continue;
        }
        if rows[index].1 >= 4.0 && rows[index - 1].1 >= 4.0 {
            count += 1.0;
        }
    }
    (count, if rows.len() > 1 { count / (rows.len() as f64 - 1.0) } else { 0.0 })
}

fn chord_wall_ratio(rows: &[(f64, f64)], key_count: i32, cutoff_ms: f64) -> f64 {
    if rows.len() < 2 {
        return 0.0;
    }
    let min_chord = jsmath::max(2.0, key_count as f64 - 1.0);
    let mut walls = 0f64;
    for index in 1..rows.len() {
        let gap = rows[index].0 - rows[index - 1].0;
        if gap <= 0.0 || gap > cutoff_ms {
            continue;
        }
        if rows[index].1 >= min_chord && rows[index - 1].1 >= min_chord {
            walls += 1.0;
        }
    }
    walls / (rows.len() as f64 - 1.0)
}

fn peak_rows_per_second(map: &ManiaBeatmap, window_ms: f64) -> f64 {
    let mut set = NumSet::new();
    for note in &map.notes {
        set.add(note.time);
    }
    let mut times = set.items;
    sort_nums(&mut times);
    let mut peak = 0f64;
    let mut start = 0usize;
    for index in 0..times.len() {
        while times[index] - times[start] > window_ms {
            start += 1;
        }
        let rows = (index - start + 1) as f64;
        if rows > peak {
            peak = rows;
        }
    }
    peak
}

pub fn detect_roll_vibro(map: &ManiaBeatmap, rate: f64) -> bool {
    if map.key_count != 4 || map.notes.len() < RICE_VIBRO_MIN_NOTES {
        return false;
    }
    let columns = times_by_column(map);
    column_fast_gaps(&columns, RICE_VIBRO_ROLL_GAP_MS * rate).1 >= RICE_VIBRO_ROLL_MIN_RATIO
        && fast_roll_row_share(map, RICE_VIBRO_ROLL_ROW_GAP_MS * rate) >= RICE_VIBRO_ROLL_MIN_ROW_RATIO
}

const RATE_VIBRO_CHORD_WALL_MIN_RATIO: f64 = 0.5;
const SUSTAINED_CHORD_VIBRO_BANDS: [(f64, f64); 2] = [(70.0, 0.4), (60.0, 0.35)];
const SUSTAINED_CHORD_VIBRO_MIN_ROW_SHARE: f64 = 0.2;
const SUSTAINED_CHORD_VIBRO_MIN_ROWS: f64 = 32.0;
const SUSTAINED_CHORD_VIBRO_MAX_HOLD_RATIO: f64 = 0.1;

pub fn detect_sustained_chord_vibro(map: &ManiaBeatmap, rate: f64) -> bool {
    if map.key_count != 4 || map.notes.len() < RICE_VIBRO_MIN_NOTES || !rate.is_finite() || rate <= 0.0 {
        return false;
    }
    let mut rows: NumMap<i32> = NumMap::new();
    let mut holds = 0f64;
    for note in &map.notes {
        let mask = rows.entry_or_insert_with(note.time, || 0);
        *mask |= bit(note.column);
        if note.is_hold {
            holds += 1.0;
        }
    }
    if holds / map.notes.len() as f64 > SUSTAINED_CHORD_VIBRO_MAX_HOLD_RATIO {
        return false;
    }
    let mut entries = rows.entries.clone();
    entries.sort_by(|a, b| crate::js::cmp_num(a.0, b.0));
    let row_count = rows.len() as f64;
    for &(gap_ms, column_share) in &SUSTAINED_CHORD_VIBRO_BANDS {
        let mut last_column_times = [f64::NEG_INFINITY; 4];
        let cutoff = gap_ms * rate;
        let mut column_gaps = 0f64;
        let mut fast_column_gaps = 0f64;
        let mut chord_rows = 0f64;
        let mut consecutive_rows = 0f64;
        let mut longest_run = 0f64;
        for &(time, mask) in &entries {
            let mut fast_fingers = 0;
            for column in 0..4 {
                if mask & (1 << column) == 0 {
                    continue;
                }
                let gap = time - last_column_times[column];
                if gap.is_finite() && gap > 0.0 {
                    column_gaps += 1.0;
                    if gap <= cutoff {
                        fast_column_gaps += 1.0;
                        fast_fingers += 1;
                    }
                }
                last_column_times[column] = time;
            }
            if fast_fingers >= 2 {
                chord_rows += 1.0;
                consecutive_rows += 1.0;
                longest_run = jsmath::max(longest_run, consecutive_rows);
            } else {
                consecutive_rows = 0.0;
            }
        }
        if column_gaps > 0.0
            && fast_column_gaps / column_gaps >= column_share
            && chord_rows / row_count >= SUSTAINED_CHORD_VIBRO_MIN_ROW_SHARE
            && longest_run >= SUSTAINED_CHORD_VIBRO_MIN_ROWS
        {
            return true;
        }
    }
    false
}

pub fn detect_rate_vibro(map: &ManiaBeatmap, rate: f64) -> bool {
    if uses_section_vibro(map) {
        return analyze_vibro_sections(map, rate).status == VibroStatus::Excluded;
    }
    if analyze_stacked_heads(map, rate).is_some()
        || analyze_wide_jumptrill(map, rate).is_some()
        || analyze_collapsed_notes(map, rate).is_some()
        || analyze_hold_vibro(map, rate).is_some()
    {
        return true;
    }
    if detect_roll_vibro(map, rate) {
        return true;
    }
    if detect_sustained_chord_vibro(map, rate) {
        return true;
    }
    if map.notes.len() < RICE_VIBRO_BURST_MIN_NOTES {
        return false;
    }
    chord_wall_ratio(&row_sizes(map), map.key_count, RICE_VIBRO_CHORD_WALL_GAP_MS * rate) >= RATE_VIBRO_CHORD_WALL_MIN_RATIO
}

pub fn detect_rice_vibro(map: &ManiaBeatmap, rate: f64) -> bool {
    if uses_section_vibro(map) {
        return analyze_vibro_sections(map, rate).status == VibroStatus::Excluded;
    }
    if analyze_stacked_heads(map, rate).is_some()
        || analyze_wide_jumptrill(map, rate).is_some()
        || analyze_collapsed_notes(map, rate).is_some()
        || analyze_hold_vibro(map, rate).is_some()
    {
        return true;
    }
    let mut columns: Option<Vec<Vec<f64>>> = None;
    let mut rows: Option<Vec<(f64, f64)>> = None;
    if map.notes.len() >= RICE_VIBRO_MIN_NOTES {
        let cols = columns.get_or_insert_with(|| times_by_column(map));
        let (max_run, ratio) = column_fast_gaps(cols, RICE_VIBRO_COLUMN_GAP_MS * rate);
        if max_run >= RICE_VIBRO_COLUMN_MIN_RUN && ratio >= RICE_VIBRO_COLUMN_MIN_RATIO {
            return true;
        }
        if detect_sustained_chord_vibro(map, rate) {
            return true;
        }
        if map.key_count == 4 {
            let rs = rows.get_or_insert_with(|| row_sizes(map));
            let (wall_rows, wall_ratio) = quad_wall_rows(rs, RICE_VIBRO_WALL_GAP_MS * rate);
            if wall_rows >= RICE_VIBRO_WALL_MIN_ROWS && wall_ratio >= RICE_VIBRO_WALL_MIN_ROW_RATIO {
                let cols = columns.get_or_insert_with(|| times_by_column(map));
                let fast = column_fast_gaps(cols, RICE_VIBRO_WALL_COLUMN_GAP_MS * rate);
                if fast.1 >= RICE_VIBRO_WALL_COLUMN_MIN_RATIO {
                    return true;
                }
            }
            if detect_roll_vibro(map, rate) {
                return true;
            }
        }
    }
    if map.notes.len() >= RICE_VIBRO_BURST_MIN_NOTES {
        let cols = columns.get_or_insert_with(|| times_by_column(map));
        let (runs, fraction) = column_burst_runs(cols, RICE_VIBRO_BURST_GAP_MS * rate, RICE_VIBRO_BURST_MIN_RUN);
        if runs >= RICE_VIBRO_BURST_MIN_RUNS && fraction >= RICE_VIBRO_BURST_MIN_FRACTION {
            return true;
        }
        if peak_rows_per_second(map, RICE_VIBRO_ROW_RATE_WINDOW_MS * rate) >= RICE_VIBRO_MAX_ROWS_PER_SECOND {
            return true;
        }
        let rs = rows.get_or_insert_with(|| row_sizes(map));
        if chord_wall_ratio(rs, map.key_count, RICE_VIBRO_CHORD_WALL_GAP_MS * rate) >= RICE_VIBRO_CHORD_WALL_MIN_RATIO {
            return true;
        }
    }
    false
}

pub fn detect_ln_vibro(map: &ManiaBeatmap, rate: f64) -> bool {
    detect_ln_vibro_notes(&map.notes, rate)
}

pub fn detect_ln_vibro_notes(notes: &[ManiaNote], rate: f64) -> bool {
    let mut holds = 0f64;
    let mut row_times = NumSet::new();
    for note in notes {
        if note.is_hold && note.end_time > note.time {
            holds += 1.0;
        }
        row_times.add(note.time);
    }
    if notes.is_empty() || row_times.len() < LN_VIBRO_MIN_ROWS {
        return false;
    }
    if holds / (notes.len() as f64) < LN_VIBRO_MIN_HOLD_RATIO {
        return false;
    }
    let mut times = row_times.items;
    sort_nums(&mut times);
    let mut gaps: Vec<f64> = Vec::with_capacity(times.len());
    for index in 1..times.len() {
        gaps.push(times[index] - times[index - 1]);
    }
    sort_nums(&mut gaps);
    let p75 = gaps[(gaps.len() - 1).min((gaps.len() as f64 * 0.75).floor() as usize)];
    p75 <= LN_VIBRO_MAX_P75_ROW_GAP_MS * rate
}
