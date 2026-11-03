use crate::workload::{prism_hands, PrismChart, PRISM_SECTION_MS};

pub const MASH_PERIODS_MS: [f64; 4] = [115.0, 130.0, 145.0, 160.0];
const MASH_SECTION_ACCURACY: f64 = 0.9;
pub const MASH_ROUTE_EASIER: f64 = 1.6;
pub const MASH_MAX_OD: f64 = 5.0;
pub const MASH_MIN_LOSS_SHARE: f64 = 0.02;

pub struct MashRoute {
    pub chart: PrismChart,
    pub accuracy: Vec<f64>,
}

pub(crate) fn slot_of(start: f64) -> usize {
    (start / PRISM_SECTION_MS) as usize
}

fn windows_at(od: f64) -> [f64; 6] {
    [16.0, 64.0 - 3.0 * od, 97.0 - 3.0 * od, 127.0 - 3.0 * od, 151.0 - 3.0 * od, 188.0 - 3.0 * od]
}

const POINTS: [i32; 5] = [305, 300, 200, 100, 50];

fn locked_strikes(rows: &[f64], period: f64, middle: bool, out: &mut Vec<f64>) {
    out.clear();
    let mut last = f64::NEG_INFINITY;
    fn fill(out: &mut Vec<f64>, last: &mut f64, to: f64, period: f64) {
        if !last.is_finite() {
            return;
        }
        let mut at = *last + period;
        while to - at >= 0.75 * period && at - *last < 1.6 * period {
            out.push(at);
            *last = at;
            at += period;
        }
    }
    if !middle {
        for &row in rows {
            if row - last < 0.75 * period {
                continue;
            }
            fill(out, &mut last, row, period);
            out.push(row);
            last = row;
        }
        return;
    }
    let mut i = 0usize;
    while i < rows.len() {
        let mut j = i;
        while j + 1 < rows.len() && rows[j + 1] - rows[i] <= 0.85 * period {
            j += 1;
        }
        let strike = (rows[i] + rows[j]) / 2.0;
        fill(out, &mut last, strike, period);
        out.push(strike);
        last = strike;
        i = j + 1;
    }
}

struct Notes {
    time: Vec<f64>,
    section: Vec<usize>,
    row_end: Vec<usize>,
    lane: Vec<u8>,
    hand: Vec<u8>,
}

fn judge(notes: &Notes, strikes: &[f64], turns: bool, windows: &[f64; 6], last: &mut [i64], points: &mut [i32]) {
    let step: i64 = if turns { 2 } else { 1 };
    let parity: i64 = if turns { 1 } else { 0 };
    let (w0, w1, w2, w3, meh, miss) = (windows[0], windows[1], windows[2], windows[3], windows[4], windows[5]);
    let mut g = 0usize;
    let mut e = 0usize;
    for r in 0..notes.time.len() {
        let t = notes.time[r];
        while strikes[g] < t - miss {
            g += 1;
        }
        let (late, early, section, end) = (t + meh, t - meh, notes.section[r], notes.row_end[r]);
        let gi = g as i64;
        while e < end {
            let lane = notes.lane[e] as usize;
            let first = gi + ((gi ^ notes.hand[e] as i64) & parity);
            let next = last[lane] + step;
            let k = if first > next { first } else { next };
            let press = strikes[k as usize];
            e += 1;
            if press > late {
                continue;
            }
            last[lane] = k;
            if press < early {
                continue;
            }
            let off = (press - t).abs();
            let q = (off > w0) as usize + (off > w1) as usize + (off > w2) as usize + (off > w3) as usize + (off > meh) as usize;
            if q < POINTS.len() {
                points[section] += POINTS[q];
            }
        }
    }
}

fn judge_fresh(notes: &Notes, strikes: &[f64], turns: bool, windows: &[f64; 6], last: &mut [i64], points: &mut [i32]) {
    let step: i64 = if turns { 2 } else { 1 };
    let parity: i64 = if turns { 1 } else { 0 };
    let (w0, w1, w2, w3, meh, miss) = (windows[0], windows[1], windows[2], windows[3], windows[4], windows[5]);
    let mut g = 0usize;
    let mut e = 0usize;
    let mut section = usize::MAX;
    let mut from = 0usize;
    for r in 0..notes.time.len() {
        let t = notes.time[r];
        if notes.section[r] != section {
            section = notes.section[r];
            while strikes[from] < t - w1 {
                from += 1;
            }
            last.iter_mut().for_each(|l| *l = from as i64 - step);
        }
        while strikes[g] < t - miss {
            g += 1;
        }
        let (late, early, end) = (t + meh, t - meh, notes.row_end[r]);
        let gi = g as i64;
        while e < end {
            let lane = notes.lane[e] as usize;
            let hand = notes.hand[e] as i64;
            let first = gi + ((gi ^ hand) & parity);
            let mut next = last[lane] + step;
            next += (next ^ hand) & parity;
            let k = if first > next { first } else { next };
            let press = strikes[k as usize];
            e += 1;
            if press > late {
                continue;
            }
            last[lane] = k;
            if press < early {
                continue;
            }
            let off = (press - t).abs();
            let q = (off > w0) as usize + (off > w1) as usize + (off > w2) as usize + (off > w3) as usize + (off > meh) as usize;
            if q < POINTS.len() {
                points[section] += POINTS[q];
            }
        }
    }
}

pub fn prism_mash_routes(chart: &PrismChart, centre_hand: u8, loss: &[(f64, f64)], resync: bool) -> Vec<MashRoute> {
    if !(chart.od < MASH_MAX_OD) {
        return Vec::new();
    }
    let key_count = chart.key_count;
    let lanes = key_count.max(0) as usize;
    let w = windows_at(chart.od);
    let tap_ms = w[3];
    let mut windows = [0.0f64; 6];
    let mut most = f64::NEG_INFINITY;
    for q in 0..6 {
        most = if w[q] > most { w[q] } else { most };
        windows[q] = if q < 5 { most } else { w[q] };
    }
    let [left, _] = prism_hands(key_count, centre_hand);
    let all: i32 = ((1i64 << key_count) - 1) as i32;
    let rows_n = chart.time.len();
    let mut rows: Vec<f64> = Vec::with_capacity(rows_n);
    let (mut note_row, mut note_lane, mut note_kept, mut note_section) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    let mut count: Vec<i32> = Vec::new();
    let mut lowest_lane: Vec<u8> = Vec::new();
    let mut open: Vec<i64> = vec![-1; lanes];
    for i in 0..rows_n {
        if chart.press[i] != 0 {
            rows.push(chart.time[i]);
        }
        let pressed = chart.press[i] as i32 & all;
        let released = chart.release[i] as i32 & all;
        if (pressed | released) == 0 {
            continue;
        }
        let mut section = 0usize;
        if pressed != 0 {
            section = (chart.time[i] / PRISM_SECTION_MS).floor() as usize;
            if count.len() <= section {
                count.resize(section + 1, 0);
                lowest_lane.resize(section + 1, 255);
            }
            count[section] += pressed.count_ones() as i32;
            let lowest = pressed.trailing_zeros() as u8;
            if lowest < lowest_lane[section] {
                lowest_lane[section] = lowest;
            }
        }
        let mut bits = pressed | released;
        while bits != 0 {
            let lane = bits.trailing_zeros() as usize;
            bits &= bits - 1;
            let bit = 1i32 << lane;
            if released & bit != 0 && open[lane] >= 0 {
                let n = open[lane] as usize;
                note_kept[n] = chart.time[i] - chart.time[note_row[n]] <= tap_ms;
                open[lane] = -1;
            }
            if pressed & bit != 0 {
                open[lane] = note_row.len() as i64;
                note_row.push(i);
                note_lane.push(lane as u8);
                note_kept.push(true);
                note_section.push(section);
            }
        }
    }
    let sections = count.len();
    let mut kept = vec![0i32; sections];
    let mut notes = Notes { time: Vec::new(), section: Vec::new(), row_end: Vec::new(), lane: Vec::new(), hand: Vec::new() };
    let mut row = usize::MAX;
    for n in 0..note_row.len() {
        if !note_kept[n] {
            continue;
        }
        if note_row[n] != row {
            if row != usize::MAX {
                notes.row_end.push(notes.lane.len());
            }
            row = note_row[n];
            notes.time.push(chart.time[row]);
            notes.section.push(note_section[n]);
        }
        notes.lane.push(note_lane[n]);
        notes.hand.push(if left & (1i32 << note_lane[n]) != 0 { 0 } else { 1 });
        kept[note_section[n]] += 1;
    }
    if row != usize::MAX {
        notes.row_end.push(notes.lane.len());
    }
    let mut order: Vec<usize> = Vec::with_capacity(sections);
    for lane in 0..lanes as u8 {
        for i in 0..sections {
            if lowest_lane[i] == lane {
                order.push(i);
            }
        }
    }
    let mut loss_by_slot = vec![0.0f64; sections];
    let mut total_loss = 0.0;
    for &(at, l) in loss {
        let slot = slot_of(at);
        if slot < sections {
            loss_by_slot[slot] = l;
        }
        total_loss += l;
    }
    let loss_of: Vec<f64> = (0..sections).map(|i| if count[i] != 0 { loss_by_slot[i] } else { 0.0 }).collect();
    let whole: Vec<f64> = count.iter().map(|&c| POINTS[0] as f64 * c as f64).collect();
    let need = MASH_MIN_LOSS_SHARE * total_loss;
    let mut reachable = 0.0;
    let mut any = false;
    for &i in &order {
        if POINTS[0] as f64 * kept[i] as f64 / whole[i] >= MASH_SECTION_ACCURACY {
            any = true;
            reachable += loss_of[i];
        }
    }
    if !any || reachable < need {
        return Vec::new();
    }
    let mut routes: Vec<MashRoute> = Vec::new();
    let mut seen: [Vec<Vec<f64>>; 2] = [Vec::new(), Vec::new()];
    let mut strikes: Vec<f64> = Vec::new();
    let mut points = vec![0i32; sections];
    let mut fresh = vec![0i32; sections];
    let mut last = vec![0i64; lanes];
    for middle in [false, true] {
        for turns in [false, true] {
            for &period in MASH_PERIODS_MS.iter() {
                locked_strikes(&rows, if turns { period / 2.0 } else { period }, middle, &mut strikes);
                let n = strikes.len();
                let judged = &mut seen[turns as usize];
                if judged.iter().any(|other| *other == strikes) {
                    continue;
                }
                judged.push(strikes.clone());
                strikes.push(f64::INFINITY);
                strikes.push(f64::INFINITY);
                points.iter_mut().for_each(|p| *p = 0);
                let step: i64 = if turns { 2 } else { 1 };
                for lane in 0..lanes {
                    last[lane] = (if turns && left & (1i32 << lane) == 0 { 1 } else { 0 }) - step;
                }
                judge(&notes, &strikes, turns, &windows, &mut last, &mut points);
                if resync {
                    fresh.iter_mut().for_each(|p| *p = 0);
                    judge_fresh(&notes, &strikes, turns, &windows, &mut last, &mut fresh);
                    for i in 0..sections {
                        if fresh[i] > points[i] {
                            points[i] = fresh[i];
                        }
                    }
                }
                strikes.truncate(n);
                let mut best = 0.0f64;
                let mut covered = 0.0f64;
                for &i in &order {
                    let value = points[i] as f64 / whole[i];
                    if value > best {
                        best = value;
                    }
                    if value >= MASH_SECTION_ACCURACY {
                        covered += loss_of[i];
                    }
                }
                if best < MASH_SECTION_ACCURACY || covered < need {
                    continue;
                }
                let mut accuracy = vec![f64::NAN; sections];
                for &i in &order {
                    accuracy[i] = points[i] as f64 / whole[i];
                }
                let masks: Vec<u8> = (0..n).map(|k| (if turns { if k % 2 == 0 { left } else { all & !left } } else { all }) as u8).collect();
                routes.push(MashRoute {
                    chart: PrismChart {
                        key_count,
                        rate: chart.rate,
                        time: strikes.clone(),
                        press: masks,
                        release: vec![0; n],
                        held: vec![0; n],
                        held_body: vec![0.0; n * lanes],
                        od: chart.od,
                        objects: (n * lanes) as f64,
                        holds: 0.0,
                    },
                    accuracy,
                });
            }
        }
    }
    routes
}

pub const HAND_STRIKE_GAP_MS: f64 = 35.0;
pub const HAND_STRIKE_SPAN_MS: f64 = 70.0;
pub const HAND_STRIKE_FLAM_MS: f64 = 25.0;
const HAND_STRIKE_MIN_SHARE: f64 = 0.02;

pub fn prism_hand_strike_route(chart: &PrismChart, centre_hand: u8) -> Option<MashRoute> {
    let key_count = chart.key_count;
    let lanes = key_count.max(0) as usize;
    let w = windows_at(chart.od);
    let mut windows = [0.0f64; 6];
    let mut most = f64::NEG_INFINITY;
    for q in 0..6 {
        most = if w[q] > most { w[q] } else { most };
        windows[q] = if q < 5 { most } else { w[q] };
    }
    let tap_ms = w[3];
    let hands = prism_hands(key_count, centre_hand);
    let (mut note_time, mut note_lane, mut kept): (Vec<f64>, Vec<usize>, Vec<bool>) = (Vec::new(), Vec::new(), Vec::new());
    let mut open: Vec<i64> = vec![-1; lanes];
    for i in 0..chart.time.len() {
        for lane in 0..lanes {
            let bit = 1i32 << lane;
            if chart.release[i] as i32 & bit != 0 && open[lane] >= 0 {
                let n = open[lane] as usize;
                kept[n] = chart.time[i] - note_time[n] <= tap_ms;
                open[lane] = -1;
            }
            if chart.press[i] as i32 & bit != 0 {
                open[lane] = note_time.len() as i64;
                note_time.push(chart.time[i]);
                note_lane.push(lane);
                kept.push(true);
            }
        }
    }
    if note_time.is_empty() {
        return None;
    }
    let mut strike_at = vec![0.0f64; note_time.len()];
    let mut strikes: Vec<(f64, i32)> = Vec::new();
    let mut joined = 0usize;
    for &hand in hands.iter() {
        let mut members: Vec<usize> = Vec::new();
        let mut mask = 0i32;
        let close = |members: &mut Vec<usize>, mask: &mut i32, strike_at: &mut Vec<f64>, strikes: &mut Vec<(f64, i32)>, joined: &mut usize| {
            if members.is_empty() {
                return;
            }
            let first = note_time[members[0]];
            let last = note_time[members[members.len() - 1]];
            if members.len() > 1 && last - first <= HAND_STRIKE_FLAM_MS {
                for &n in members.iter() {
                    strike_at[n] = note_time[n];
                    strikes.push((note_time[n], 1i32 << note_lane[n]));
                }
            } else {
                let at = (first + last) / 2.0;
                for &n in members.iter() {
                    strike_at[n] = at;
                }
                if members.len() > 1 {
                    *joined += members.len();
                }
                strikes.push((at, *mask));
            }
            members.clear();
            *mask = 0;
        };
        for n in 0..note_time.len() {
            let bit = 1i32 << note_lane[n];
            if hand & bit == 0 {
                continue;
            }
            if !members.is_empty()
                && ((mask & bit) != 0
                    || note_time[n] - note_time[members[0]] > HAND_STRIKE_SPAN_MS
                    || note_time[n] - note_time[members[members.len() - 1]] > HAND_STRIKE_GAP_MS)
            {
                close(&mut members, &mut mask, &mut strike_at, &mut strikes, &mut joined);
            }
            members.push(n);
            mask |= bit;
        }
        close(&mut members, &mut mask, &mut strike_at, &mut strikes, &mut joined);
    }
    if (joined as f64) < HAND_STRIKE_MIN_SHARE * note_time.len() as f64 {
        return None;
    }
    let sections = (note_time[note_time.len() - 1] / PRISM_SECTION_MS).floor() as usize + 1;
    let mut points = vec![0.0f64; sections];
    let mut whole = vec![0.0f64; sections];
    for n in 0..note_time.len() {
        let section = (note_time[n] / PRISM_SECTION_MS).floor() as usize;
        whole[section] += POINTS[0] as f64;
        if !kept[n] {
            continue;
        }
        let off = (strike_at[n] - note_time[n]).abs();
        let judgement = (off > windows[0]) as usize + (off > windows[1]) as usize + (off > windows[2]) as usize + (off > windows[3]) as usize + (off > windows[4]) as usize;
        if judgement < POINTS.len() {
            points[section] += POINTS[judgement] as f64;
        }
    }
    let accuracy: Vec<f64> = (0..sections).map(|i| if whole[i] > 0.0 { points[i] / whole[i] } else { f64::NAN }).collect();
    strikes.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    let mut row_time: Vec<f64> = Vec::new();
    let mut row_press: Vec<i32> = Vec::new();
    for (at, lanes_struck) in strikes {
        if row_time.last() == Some(&at) {
            *row_press.last_mut().unwrap() |= lanes_struck;
        } else {
            row_time.push(at);
            row_press.push(lanes_struck);
        }
    }
    let rows = row_time.len();
    Some(MashRoute {
        chart: PrismChart {
            key_count,
            rate: chart.rate,
            time: row_time,
            press: row_press.iter().map(|&p| p as u8).collect(),
            release: vec![0; rows],
            held: vec![0; rows],
            held_body: vec![0.0; rows * lanes],
            od: chart.od,
            objects: note_time.len() as f64,
            holds: 0.0,
        },
        accuracy,
    })
}
