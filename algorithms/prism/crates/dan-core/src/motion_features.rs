use crate::beatmap::ManiaNote;
use crate::js::cmp_num;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MotionFeatures {
    pub same_hand: f64,
    pub mini_jack: f64,
    pub anchor: f64,
    pub one_hand_trill: f64,
    pub cross_hand_trill: f64,
    pub roll4: f64,
    pub rhythm_break: f64,
    pub chord_swing: f64,
    pub density_swing: f64,
}

const ROW_EPSILON_MS: f64 = 10.0;
const MIN_GAP_MS: f64 = 25.0;
const MAX_GAP_MS: f64 = 400.0;
const MIN_ROWS: usize = 24;
const PACE_QUANTILE: f64 = 0.25;
const PACE_SLACK: f64 = 1.6;
const PACE_CONTEXT: usize = 8;

struct Row {
    time: f64,
    columns: Vec<i32>,
}

#[inline]
fn hand(column: i32) -> i32 {
    if column < 2 {
        0
    } else {
        1
    }
}

fn build_rows(notes: &[ManiaNote]) -> Vec<Row> {
    let mut sorted: Vec<&ManiaNote> = notes.iter().collect();
    sorted.sort_by(|a, b| cmp_num(a.time, b.time));
    let mut rows: Vec<Row> = Vec::new();
    for note in sorted {
        match rows.last_mut() {
            Some(last) if note.time - last.time <= ROW_EPSILON_MS => last.columns.push(note.column),
            _ => rows.push(Row { time: note.time, columns: vec![note.column] }),
        }
    }
    for row in &mut rows {
        row.columns.sort();
    }
    rows
}

#[inline]
fn weight_for(gap: f64) -> f64 {
    1.0 / jsmath::max(gap, MIN_GAP_MS)
}

fn at_pace(rows: &[Row]) -> Vec<bool> {
    let mut gaps: Vec<f64> = Vec::with_capacity(rows.len());
    for i in 0..rows.len().saturating_sub(1) {
        gaps.push(rows[i + 1].time - rows[i].time);
    }
    let mut valid: Vec<f64> = gaps.iter().copied().filter(|&g| g > 0.0 && g <= MAX_GAP_MS).collect();
    valid.sort_by(|a, b| cmp_num(*a, *b));
    if valid.is_empty() {
        return gaps.iter().map(|_| false).collect();
    }
    let pace = valid[(valid.len() - 1).min((valid.len() as f64 * PACE_QUANTILE).floor() as usize)];
    let limit = pace * PACE_SLACK;
    let mut around: Vec<f64> = Vec::with_capacity(2 * PACE_CONTEXT + 1);
    (0..gaps.len())
        .map(|index| {
            around.clear();
            let lo = index.saturating_sub(PACE_CONTEXT);
            let hi = (gaps.len() - 1).min(index + PACE_CONTEXT);
            for j in lo..=hi {
                if gaps[j] > 0.0 && gaps[j] <= MAX_GAP_MS {
                    around.push(gaps[j]);
                }
            }
            if around.is_empty() {
                return false;
            }
            around.sort_by(|a, b| cmp_num(*a, *b));
            around[around.len() / 2] <= limit
        })
        .collect()
}

fn ratio_is_musical(ratio: f64) -> bool {
    for target in [1.0, 2.0, 0.5, 1.5, 2.0 / 3.0, 3.0, 1.0 / 3.0, 4.0, 0.25] {
        if (ratio - target).abs() <= target * 0.08 {
            return true;
        }
    }
    false
}

#[inline]
fn round4(value: f64) -> f64 {
    jsmath::round(value * 10000.0) / 10000.0
}

pub fn motion_features(notes: &[ManiaNote], key_count: f64) -> Option<MotionFeatures> {
    if key_count != 4.0 || notes.len() < 32 {
        return None;
    }
    let rows = build_rows(notes);
    if rows.len() < MIN_ROWS {
        return None;
    }
    let in_pace = at_pace(&rows);

    let (mut pair_w, mut same_hand_w, mut mini_jack_w, mut anchor_w, mut chord_swing_w) = (0f64, 0f64, 0f64, 0f64, 0f64);
    let (mut trip_w, mut trill_w, mut cross_trill_w) = (0f64, 0f64, 0f64);
    let (mut quad_w, mut roll4_w) = (0f64, 0f64);
    let (mut rhythm_w, mut rhythm_break_w) = (0f64, 0f64);

    for i in 0..rows.len() - 1 {
        let a = &rows[i];
        let b = &rows[i + 1];
        let gap = b.time - a.time;
        if gap <= 0.0 || gap > MAX_GAP_MS || !in_pace[i] {
            continue;
        }
        let w = weight_for(gap);
        pair_w += w;
        if a.columns.len() != b.columns.len() {
            chord_swing_w += w;
        }
        if a.columns.len() == 1 && b.columns.len() == 1 {
            let (ca, cb) = (a.columns[0], b.columns[0]);
            if ca == cb {
                mini_jack_w += w;
            } else if hand(ca) == hand(cb) {
                same_hand_w += w;
            }
        } else if a.columns.iter().any(|c| b.columns.contains(c)) {
            let identical = a.columns.len() == b.columns.len() && a.columns.iter().zip(&b.columns).all(|(x, y)| x == y);
            if !identical {
                anchor_w += w;
            }
        }
    }

    for i in 0..rows.len().saturating_sub(2) {
        let (a, b, c) = (&rows[i], &rows[i + 1], &rows[i + 2]);
        let g0 = b.time - a.time;
        let g1 = c.time - b.time;
        if g0 <= 0.0 || g1 <= 0.0 || g0 > MAX_GAP_MS || g1 > MAX_GAP_MS || !in_pace[i] {
            continue;
        }
        let w = weight_for(jsmath::max(g0, g1));
        rhythm_w += w;
        if !ratio_is_musical(g1 / g0) {
            rhythm_break_w += w;
        }
        if a.columns.len() != 1 || b.columns.len() != 1 || c.columns.len() != 1 {
            continue;
        }
        trip_w += w;
        let (ca, cb, cc) = (a.columns[0], b.columns[0], c.columns[0]);
        if ca == cc && ca != cb {
            if hand(ca) == hand(cb) {
                trill_w += w;
            } else {
                cross_trill_w += w;
            }
        }
    }

    for i in 0..rows.len().saturating_sub(3) {
        let window = [&rows[i], &rows[i + 1], &rows[i + 2], &rows[i + 3]];
        let gaps = [window[1].time - window[0].time, window[2].time - window[1].time, window[3].time - window[2].time];
        if gaps.iter().any(|&g| g <= 0.0 || g > MAX_GAP_MS) || !in_pace[i] {
            continue;
        }
        if window.iter().any(|r| r.columns.len() != 1) {
            continue;
        }
        let w = weight_for(jsmath::max(jsmath::max(gaps[0], gaps[1]), gaps[2]));
        quad_w += w;
        let columns = [window[0].columns[0], window[1].columns[0], window[2].columns[0], window[3].columns[0]];
        let steps = [columns[1] - columns[0], columns[2] - columns[1], columns[3] - columns[2]];
        if steps.iter().all(|&s| s == 1) || steps.iter().all(|&s| s == -1) {
            roll4_w += w;
        }
    }

    let first = rows[0].time;
    let last = rows[rows.len() - 1].time;
    let seconds = jsmath::max(1.0, ((last - first) / 1000.0).ceil()) as usize;
    let mut per_second = vec![0f64; seconds];
    for row in &rows {
        let index = jsmath::min(seconds as f64 - 1.0, ((row.time - first) / 1000.0).floor()) as usize;
        per_second[index] += row.columns.len() as f64;
    }
    let active: Vec<f64> = per_second.iter().copied().filter(|&c| c > 0.0).collect();
    let mean = if !active.is_empty() {
        let mut s = 0.0;
        for &n in &active {
            s += n;
        }
        s / active.len() as f64
    } else {
        0.0
    };
    let variance = if !active.is_empty() {
        let mut s = 0.0;
        for &n in &active {
            s += (n - mean) * (n - mean);
        }
        s / active.len() as f64
    } else {
        0.0
    };
    let share = |n: f64, d: f64| if d > 0.0 { n / d } else { 0.0 };
    Some(MotionFeatures {
        same_hand: round4(share(same_hand_w, pair_w)),
        mini_jack: round4(share(mini_jack_w, pair_w)),
        anchor: round4(share(anchor_w, pair_w)),
        one_hand_trill: round4(share(trill_w, trip_w)),
        cross_hand_trill: round4(share(cross_trill_w, trip_w)),
        roll4: round4(share(roll4_w, quad_w)),
        rhythm_break: round4(share(rhythm_break_w, rhythm_w)),
        chord_swing: round4(share(chord_swing_w, pair_w)),
        density_swing: round4(if mean > 0.0 { jsmath::sqrt(variance) / mean } else { 0.0 }),
    })
}
