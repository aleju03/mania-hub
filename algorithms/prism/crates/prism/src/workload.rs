use dan_core::ln_effective::{read_effective_holds, EffectiveLnOptions};
use dan_core::ManiaNote;
use jsmath::{max, min, pow, round};

use crate::params::PrismModel;

pub const PRISM_SECTION_MS: f64 = 500.0;
const MAX_CHART_SPAN_MS: f64 = 20.0 * 60.0 * 1000.0;
const MOTION_MAX_GAP_MS: f64 = 250.0;
const SPEED_REF_MS: f64 = 125.0;
const ACTION_CEILING_MS: f64 = 1000.0 / 23.0;
const CEILING_ACTIONS: usize = 4;
const HAND_PRESS_MS: f64 = 30.0;
const PRESS_GAP_SHARE: f64 = 0.4;
const PRESS_MAX_MS: f64 = 60.0;
const SWEEP_SPAN_MS: f64 = 90.0;
const SWEEP_ROW_GAP_MS: f64 = 25.0;
const SWEEP_MIN_ROWS: usize = 3;
const SWEEP_PAUSE: f64 = 2.0;
const SWEEP_CHAIN: usize = 4;
const SWEEP_CHAIN_GAP_MS: f64 = MOTION_MAX_GAP_MS;
const CARRIED_RATIOS: [f64; 9] = [1.0, 2.0, 0.5, 1.5, 2.0 / 3.0, 3.0, 1.0 / 3.0, 4.0, 0.25];
const RATIO_TOLERANCE: f64 = 0.08;
const RHYTHM_ROWS: usize = 24;
const RHYTHM_BUCKET_MS: f64 = 5.0;
const RHYTHM_CLASSES: usize = 3;
const RHYTHM_BUCKETS: usize = (2.0 * MOTION_MAX_GAP_MS / RHYTHM_BUCKET_MS) as usize + 1;

pub const PATTERNS: [&str; 8] = ["stream", "chordstream", "bracket", "jack", "chordjack", "ln", "technical", "speed"];
const STREAM: usize = 0;
const CHORDSTREAM: usize = 1;
const BRACKET: usize = 2;
const JACK: usize = 3;
const CHORDJACK: usize = 4;
const LN: usize = 5;
const TECHNICAL: usize = 6;
const SPEED: usize = 7;

#[derive(Clone, Debug, PartialEq)]
pub struct PrismChart {
    pub key_count: i32,
    pub rate: f64,
    pub time: Vec<f64>,
    pub press: Vec<u8>,
    pub release: Vec<u8>,
    pub held: Vec<u8>,
    pub held_body: Vec<f32>,
    pub od: f64,
    pub objects: f64,
    pub holds: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PrismSection {
    pub time_ms: f64,
    pub demand: f64,
    pub work: f64,
    pub mix: [f64; 8],
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
fn rolls_past(a: i32, b: i32) -> bool {
    highest(a) < lowest(b) || lowest(a) > highest(b)
}
#[inline]
fn clamp01(n: f64) -> f64 {
    if n <= 0.0 {
        0.0
    } else if n >= 1.0 {
        1.0
    } else {
        n
    }
}
#[inline]
fn bit(n: i32) -> i32 {
    1i32.wrapping_shl(n as u32 & 31)
}

pub fn prism_hands(key_count: i32, centre_hand: u8) -> [i32; 2] {
    let half = key_count.div_euclid(2);
    let left = bit(half).wrapping_sub(1);
    let right = bit(key_count).wrapping_sub(1) & !(bit(key_count - half).wrapping_sub(1));
    let centre = if key_count % 2 == 1 { bit(half) } else { 0 };
    if centre_hand == 0 {
        [left | centre, right]
    } else {
        [left, right | centre]
    }
}

pub fn build_prism_chart(notes: &[ManiaNote], key_count: i32, rate: f64, od: Option<f64>) -> PrismChart {
    let r = if rate.is_finite() && rate > 0.0 { rate } else { 1.0 };
    let od = od.filter(|od| od.is_finite());
    let effective = od.map(|od| {
        read_effective_holds(
            notes,
            &EffectiveLnOptions { rate: Some(1.0), od: Some(od), key_count: Some(key_count as f64) },
            false,
        )
        .mask
    });
    let mut valid: Vec<ManiaNote> = notes
        .iter()
        .enumerate()
        .map(|(index, note)| ManiaNote {
            is_hold: note.is_hold && effective.as_ref().map_or(true, |mask| mask.get(index).copied() == Some(true)),
            ..*note
        })
        .filter(|n| n.column >= 0 && n.column < key_count && n.time.is_finite())
        .collect();
    jsmath::js_sort_by(&mut valid, |a, b| {
        let d = a.time - b.time;
        if d != 0.0 && !d.is_nan() {
            d
        } else {
            (a.column - b.column) as f64
        }
    });
    let origin = valid.first().map_or(0.0, |n| n.time);
    let lanes = key_count.max(0) as usize;
    let mut busy_until = vec![f64::NEG_INFINITY; lanes];
    let mut last_start = vec![f64::NEG_INFINITY; lanes];
    let mut events: Vec<(f64, i32, i32)> = Vec::new();
    let mut event_index: std::collections::HashMap<u64, usize> = std::collections::HashMap::new();
    let mut at = |t: f64, events: &mut Vec<(f64, i32, i32)>| -> usize {
        let key = if t == 0.0 { 0u64 } else { t.to_bits() };
        *event_index.entry(key).or_insert_with(|| {
            events.push((t, 0, 0));
            events.len() - 1
        })
    };
    let mut spans: Vec<(i32, f64, f64)> = Vec::new();
    let mut objects = 0.0;
    let mut holds = 0.0;
    for note in &valid {
        if note.time - origin > MAX_CHART_SPAN_MS {
            break;
        }
        let lane = note.column as usize;
        if note.time == last_start[lane] || note.time < busy_until[lane] {
            continue;
        }
        let start = (note.time - origin) / r;
        last_start[lane] = note.time;
        objects += 1.0;
        let i = at(start, &mut events);
        events[i].1 |= bit(note.column);
        if note.is_hold && note.end_time.is_finite() && note.end_time > note.time {
            holds += 1.0;
            busy_until[lane] = note.end_time;
            let end = (note.end_time - origin) / r;
            let j = at(end, &mut events);
            events[j].2 |= bit(note.column);
            spans.push((note.column, start, end));
        }
    }
    let mut order: Vec<usize> = (0..events.len()).collect();
    jsmath::js_sort_by(&mut order, |&a, &b| events[a].0 - events[b].0);
    let n = order.len();
    let mut time = vec![0.0; n];
    let mut press = vec![0u8; n];
    let mut release = vec![0u8; n];
    let mut held = vec![0u8; n];
    let mut held_body = vec![0f32; n * lanes];
    for (i, &e) in order.iter().enumerate() {
        time[i] = events[e].0;
        press[i] = events[e].1 as u8;
        release[i] = events[e].2 as u8;
    }
    let index_of = |t: f64| -> usize {
        let i = time.partition_point(|&x| x < t);
        debug_assert!(time[i] == t);
        i
    };
    for &(lane, start, end) in &spans {
        let last = index_of(end);
        let mut i = index_of(start) + 1;
        while i < last {
            held[i] = (held[i] as i32 | bit(lane)) as u8;
            held_body[i * lanes + lane as usize] = (end - start) as f32;
            i += 1;
        }
    }
    let chart_od = match od {
        Some(od) => max(0.0, min(10.0, od)),
        None => 8.0,
    };
    PrismChart { key_count, rate: r, time, press, release, held, held_body, od: chart_od, objects, holds }
}

pub fn keyboard_sweeps(chart: &PrismChart) -> Vec<i32> {
    let time = &chart.time;
    let press = |i: usize| chart.press[i] as i32;
    let mut end = vec![-1i32; time.len()];
    let all = (1i32 << chart.key_count) - 1;
    let mut found: Vec<(usize, usize)> = Vec::new();
    let mut chain_from = 0usize;
    let close = |up_to: usize, chain_from: &mut usize, found: &Vec<(usize, usize)>, end: &mut Vec<i32>| {
        if up_to - *chain_from >= SWEEP_CHAIN {
            for s in *chain_from..up_to {
                for k in found[s].0..=found[s].1 {
                    end[k] = found[s].1 as i32;
                }
            }
        }
        *chain_from = up_to;
    };
    let mut i = 0usize;
    while i < time.len() {
        if press(i) == 0 {
            i += 1;
            continue;
        }
        let mut lanes = press(i);
        let mut last = i;
        let mut rows = 1usize;
        let mut widest = 0.0f64;
        let mut k = i + 1;
        while k < time.len() && time[k] - time[i] <= SWEEP_SPAN_MS {
            if press(k) == 0 {
                k += 1;
                continue;
            }
            if press(k) & lanes != 0 {
                break;
            }
            widest = max(widest, time[k] - time[last]);
            lanes |= press(k);
            last = k;
            rows += 1;
            k += 1;
        }
        let before = (0..i).rev().find(|&k| press(k) != 0).map_or(f64::INFINITY, |k| time[i] - time[k]);
        let after = ((last + 1)..time.len()).find(|&k| press(k) != 0).map_or(f64::INFINITY, |k| time[k] - time[last]);
        if rows >= SWEEP_MIN_ROWS && lanes == all && widest <= SWEEP_ROW_GAP_MS && min(before, after) >= SWEEP_PAUSE * widest {
            if found.len() > chain_from && time[i] - time[found[found.len() - 1].1] > SWEEP_CHAIN_GAP_MS {
                close(found.len(), &mut chain_from, &found, &mut end);
            }
            found.push((i, last));
            i = last + 1;
        } else {
            i += 1;
        }
    }
    close(found.len(), &mut chain_from, &found, &mut end);
    end
}

pub fn prism_sections(chart: &PrismChart, centre_hand: u8, p: &PrismModel) -> Vec<PrismSection> {
    let key_count = chart.key_count;
    let lanes = key_count.max(0) as usize;
    let time = &chart.time;
    let held_body_full_ms = p.held_body_full_ms;
    let release_long_units = p.release_long_units;
    let release_long_full_ms = p.release_long_full_ms;
    let release_repress_ms = p.release_repress_ms;
    let repress_share = 1.0 - p.release_repress_discount;
    let mut lane_presses: Vec<Vec<f64>> = vec![Vec::new(); lanes];
    if release_repress_ms > 0.0 {
        for r in 0..time.len() {
            for lane in 0..lanes {
                if (chart.press[r] as i32) & bit(lane as i32) != 0 {
                    lane_presses[lane].push(time[r]);
                }
            }
        }
    }
    let repressed_within = |lane: usize, t: f64| -> bool {
        let xs = &lane_presses[lane];
        let (mut lo, mut hi) = (0usize, xs.len());
        while lo < hi {
            let m = (lo + hi) >> 1;
            if xs[m] <= t {
                lo = m + 1;
            } else {
                hi = m;
            }
        }
        lo < xs.len() && xs[lo] - t <= release_repress_ms
    };
    let hands = prism_hands(key_count, centre_hand);
    let centre_bit = if key_count % 2 == 1 { bit(key_count.div_euclid(2)) } else { 0 };
    let mut last_press = vec![f64::NEG_INFINITY; lanes];
    let mut released_since = vec![false; lanes];
    let jack_after_hold_units = p.jack_after_hold_units.unwrap_or(p.jack_units);
    let mut last_action = [f64::NEG_INFINITY; 2];
    let mut last_gap = [0.0f64; 2];
    let mut last_shape = [0i32; 2];
    let mut shape_before = [0i32; 2];
    let mut last_step = [0i32; 2];
    let mut press_start = [f64::NEG_INFINITY; 2];
    let mut press_mask = [0i32; 2];
    let mut open_gap = [0.0f64; 2];
    let mut last_note = [f64::NEG_INFINITY; 2];
    let written_ms = max(1.0, chart.rate);
    let flam_units = p.flam_units;
    let jack_chord_share = p.jack_chord_share;
    let mut previous_press = [0i32; 2];
    let mut repeating = [false; 2];
    let repeat_waiver = p.hand_repeat;
    let sweep_end = keyboard_sweeps(chart);
    let mut slamming = [false; 2];
    let mut slam_end = [0.0f64; 2];
    let mut slam_mask = [0i32; 2];
    let mut recent = [[f64::NEG_INFINITY; CEILING_ACTIONS]; 2];
    let mut recent_at = [0usize; 2];
    let mut fast = [0.0f64; 2];
    let mut sustain = [0.0f64; 2];
    let mut stamina = [0.0f64; 2];
    let mut row1: i32 = 0;
    let mut row2: i32 = 0;
    let mut row1_at = f64::NEG_INFINITY;
    let mut gap_ring = [-1i32; RHYTHM_ROWS];
    let mut gap_count = [0u32; RHYTHM_BUCKETS];
    let mut gap_filled: u32 = 0;
    let mut gap_at = 0usize;
    let mut sections: Vec<PrismSection> = Vec::new();
    let mut last = 0.0f64;
    let speed_full = p.speed_full_ms;
    let speed_none = p.speed_none_ms;
    for i in 0..time.len() {
        let t = time[i];
        let elapsed = t - last;
        last = t;
        let decay = pow(0.5, elapsed / p.half_life_ms);
        let slow = pow(0.5, elapsed / (p.half_life_ms * p.sustain_ratio));
        let endurance = pow(0.5, elapsed / p.stamina_half_life_ms);
        let row = chart.press[i] as i32;
        let chord_row = bits(row) >= 2;
        let mut pattern = STREAM;
        let mut off_rhythm = false;
        if row != 0 && row1_at.is_finite() && t - row1_at <= MOTION_MAX_GAP_MS * 2.0 {
            let bucket = round((t - row1_at) / RHYTHM_BUCKET_MS) as i32;
            if gap_filled as usize >= RHYTHM_ROWS / 2 {
                let mine = gap_count[bucket as usize];
                let mut above = 0usize;
                for &n in gap_count.iter() {
                    if n > mine {
                        above += 1;
                    }
                }
                off_rhythm = above >= RHYTHM_CLASSES;
            }
            let old = gap_ring[gap_at];
            if old >= 0 {
                gap_count[old as usize] -= 1;
                gap_filled -= 1;
            }
            gap_ring[gap_at] = bucket;
            gap_count[bucket as usize] += 1;
            gap_filled += 1;
            gap_at = (gap_at + 1) % RHYTHM_ROWS;
        }
        if row != 0 {
            let close = t - row1_at <= MOTION_MAX_GAP_MS;
            if close && (row & row1) != 0 {
                pattern = if chord_row { CHORDJACK } else { JACK };
            } else if close
                && chord_row
                && bits(row1) >= 2
                && bits(row2) >= 2
                && (row2 & row1) == 0
                && (row1 & row) == 0
                && !rolls_past(row2, row1)
                && !rolls_past(row1, row)
            {
                pattern = BRACKET;
            } else if chord_row {
                pattern = CHORDSTREAM;
            }
        }
        let mut mix = [0.0f64; 8];
        let mut work = 0.0f64;
        for h in 0..2 {
            fast[h] *= decay;
            sustain[h] *= slow;
            stamina[h] *= endurance;
            let mask = hands[h];
            let mut pr = chart.press[i] as i32 & mask;
            let rl = chart.release[i] as i32 & mask;
            if pr == 0 && rl == 0 {
                continue;
            }
            let mut units = 0.0f64;
            let window = max(HAND_PRESS_MS, min(PRESS_MAX_MS, PRESS_GAP_SHARE * open_gap[h]));
            let in_slam = slamming[h] && t <= slam_end[h] && (press_mask[h] & pr) == 0 && (pr & !slam_mask[h]) == 0;
            if pr != 0 && (in_slam || (!slamming[h] && t - press_start[h] <= window && (press_mask[h] & pr) == 0)) {
                let again = repeating[h] && (pr & !previous_press[h]) == 0;
                let mut flam = 0.0;
                if t > press_start[h] && flam_units > 0.0 {
                    let span = (t - recent[h][recent_at[h]]) / CEILING_ACTIONS as f64;
                    flam = flam_units * (if span < ACTION_CEILING_MS { span / ACTION_CEILING_MS } else { 1.0 });
                }
                let joined = if slamming[h] {
                    0.0
                } else {
                    (p.chord_units + flam) * (if again { 1.0 - repeat_waiver } else { 1.0 }) * bits(pr) as f64
                };
                press_mask[h] |= pr;
                last_shape[h] |= pr;
                for lane in 0..lanes {
                    if pr & bit(lane as i32) != 0 {
                        if !slamming[h] {
                            last_press[lane] = t;
                        }
                        released_since[lane] = false;
                    }
                }
                mix[pattern] += joined;
                let after = (t - last_note[h]) * written_ms;
                if (t - press_start[h]) * written_ms > HAND_PRESS_MS && bits(pr) <= 2 && pattern != JACK && pattern != CHORDJACK {
                    mix[SPEED] += joined
                        * (if bits(pr) == 1 { 1.0 } else { 0.5 })
                        * clamp01((speed_none - after) / (speed_none - speed_full));
                }
                last_note[h] = t;
                units += joined;
            } else if pr != 0 {
                previous_press[h] = press_mask[h];
                open_gap[h] = if press_start[h].is_finite() { t - press_start[h] } else { 0.0 };
                press_start[h] = t;
                press_mask[h] = pr;
                let mut swept = pr;
                let mut end = t;
                if sweep_end[i] >= 0 {
                    for j in (i + 1)..=(sweep_end[i] as usize) {
                        let m = chart.press[j] as i32 & mask;
                        if m != 0 && (m & swept) == 0 {
                            swept |= m;
                            end = time[j];
                        }
                    }
                }
                slamming[h] = swept != pr;
                slam_end[h] = end;
                slam_mask[h] = swept;
                pr = swept;
                repeating[h] =
                    bits(previous_press[h]) >= 2 && (pr & !previous_press[h]) == 0 && last_action[1 - h] > last_action[h];
                let waive = if repeating[h] { 1.0 - repeat_waiver } else { 1.0 };
                let gap = t - last_action[h];
                let mut action = 1.0 + p.chord_units * (bits(pr) - 1) as f64 * waive;
                if gap < p.grace_ms {
                    action *= 1.0 - p.grace_discount * (1.0 - gap / p.grace_ms);
                }
                let mut step = 0;
                if bits(pr) == 1 && bits(last_shape[h]) == 1 && gap <= MOTION_MAX_GAP_MS {
                    step = if pr == last_shape[h] << 1 {
                        1
                    } else if pr == last_shape[h] >> 1 {
                        -1
                    } else {
                        0
                    };
                    if step != 0 && step == last_step[h] {
                        action *= 1.0 - p.roll_discount;
                    }
                }
                last_step[h] = step;
                if pr & centre_bit != 0 {
                    action += p.centre_units;
                }
                if gap.is_finite() {
                    action *= pow(SPEED_REF_MS / max(gap, ACTION_CEILING_MS), p.speed_power);
                }
                let span = (t - recent[h][recent_at[h]]) / CEILING_ACTIONS as f64;
                let vibrated = if span < ACTION_CEILING_MS { span / ACTION_CEILING_MS } else { 1.0 };
                action *= vibrated;
                recent[h][recent_at[h]] = t;
                recent_at[h] = (recent_at[h] + 1) % CEILING_ACTIONS;
                let bracket = shape_before[h] != 0
                    && (last_shape[h] & pr) == 0
                    && (shape_before[h] & pr) != 0
                    && (shape_before[h] & last_shape[h]) == 0
                    && bits(pr | last_shape[h]) >= 3
                    && gap <= MOTION_MAX_GAP_MS;
                mix[pattern] += action;
                let fingers = bits(pr);
                let note_gap = (t - last_note[h]) * written_ms;
                last_note[h] = t;
                if fingers <= 2 && pattern != JACK && pattern != CHORDJACK && note_gap.is_finite() {
                    mix[SPEED] += action
                        * (if fingers == 1 { 1.0 } else { 0.5 })
                        * clamp01((speed_none - note_gap) / (speed_none - speed_full));
                }
                let mut irregular = gap < p.grace_ms || off_rhythm;
                if !irregular && gap.is_finite() && last_gap[h] > 0.0 && gap <= MOTION_MAX_GAP_MS * 2.0 {
                    let ratio = gap / last_gap[h];
                    irregular = !CARRIED_RATIOS.iter().any(|&carried| (ratio - carried).abs() <= carried * RATIO_TOLERANCE);
                }
                if irregular {
                    mix[TECHNICAL] += action;
                }
                last_gap[h] = if gap.is_finite() { gap } else { 0.0 };
                units += action;
                let mut jack = 0.0f64;
                let mut one_finger = 0.0f64;
                for lane in 0..lanes {
                    if pr & bit(lane as i32) == 0 {
                        continue;
                    }
                    let lone = vibrated
                        * (if released_since[lane] { jack_after_hold_units } else { p.jack_units })
                        * clamp01(1.0 - (t - last_press[lane]) / p.jack_window_ms);
                    released_since[lane] = false;
                    jack += lone;
                    one_finger = max(one_finger, lone);
                    last_press[lane] = t;
                }
                if jack_chord_share != 1.0 {
                    jack = one_finger + jack_chord_share * (jack - one_finger);
                }
                if repeating[h] {
                    jack = waive * jack + (1.0 - waive) * one_finger;
                }
                let shape = if last_shape[h] != 0 && last_shape[h] != pr && (last_shape[h] & pr) != 0 {
                    vibrated * p.shape_units * waive
                } else {
                    0.0
                };
                let bracket_work = if bracket { vibrated * p.bracket_units } else { 0.0 };
                mix[pattern] += jack + shape + bracket_work;
                units += jack + shape + bracket_work;
                shape_before[h] = last_shape[h];
                last_shape[h] = pr;
                let held_mask = chart.held[i] as i32 & mask & !pr;
                if held_mask != 0 {
                    let mut held_fingers = bits(held_mask) as f64;
                    if held_body_full_ms > 0.0 {
                        held_fingers = 0.0;
                        for lane in 0..lanes {
                            if held_mask & bit(lane as i32) != 0 {
                                held_fingers += min(1.0, chart.held_body[i * lanes + lane] as f64 / held_body_full_ms);
                            }
                        }
                    }
                    let independence =
                        vibrated * p.independence_units * bits(pr) as f64 * pow(held_fingers, p.independence_held_power);
                    mix[LN] += independence;
                    units += independence;
                }
                last_action[h] = t;
            }
            if rl != 0 {
                for lane in 0..lanes {
                    if rl & bit(lane as i32) != 0 {
                        released_since[lane] = true;
                    }
                }
                let mut releases = p.release_units * bits(rl) as f64;
                if release_long_units > 0.0 {
                    for lane in 0..lanes {
                        if rl & bit(lane as i32) == 0 {
                            continue;
                        }
                        let share = if release_repress_ms > 0.0 && repressed_within(lane, t) { repress_share } else { 1.0 };
                        releases += share * release_long_units * min(1.0, (t - last_press[lane]) / release_long_full_ms);
                    }
                }
                mix[LN] += releases;
                units += releases;
            }
            fast[h] += units;
            sustain[h] += units / p.sustain_ratio;
            stamina[h] += units * (p.half_life_ms / p.stamina_half_life_ms);
            work += units;
        }
        if row != 0 {
            row2 = row1;
            row1 = row;
            row1_at = t;
        }
        if !(work > 0.0) {
            continue;
        }
        let slot = (t / PRISM_SECTION_MS).floor();
        let slot_ms = slot * PRISM_SECTION_MS;
        if sections.last().map_or(true, |s| s.time_ms != slot_ms) {
            sections.push(PrismSection { time_ms: slot_ms, demand: 0.0, work: 0.0, mix: [0.0; 8] });
        }
        let section = sections.last_mut().unwrap();
        let long = [
            p.sustain_weight * sustain[0] + p.stamina_weight * stamina[0],
            p.sustain_weight * sustain[1] + p.stamina_weight * stamina[1],
        ];
        let left = (1.0 - p.sustain_weight) * fast[0] + long[0];
        let right = (1.0 - p.sustain_weight) * fast[1] + long[1];
        let demand = max(left, right) + p.hand_share * min(left, right);
        if demand > section.demand {
            section.demand = demand;
        }
        section.work += work;
        for k in 0..8 {
            section.mix[k] += mix[k];
        }
    }
    if p.od_power != 0.0 && !p.od_power.is_nan() {
        let factor = pow((64.0 - 3.0 * chart.od) / 40.0, -p.od_power);
        for s in sections.iter_mut() {
            s.demand *= factor;
        }
    }
    sections
}
