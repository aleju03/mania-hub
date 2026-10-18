use dan_core::ln_effective::{read_effective_holds, EffectiveLnAnalysis, EffectiveLnOptions, LN_SAME_MOTION_TOLERANCE_MS};
use jsmath::{hypot, max, min, pow};

use crate::timeline::{build_ln_timeline_4k, LnTimeline4K};
use crate::LnMap;

pub const LN_SKILLSET_IDS: [&str; 4] = ["lnhybrid", "lntechnical", "lnwalls", "lnspeed"];
pub type LnFamilyVector = [f64; 4];
pub const fn empty_ln_family_vector() -> LnFamilyVector {
    [0.0; 4]
}

pub const LN_SECTION_MS: f64 = 500.0;
pub const LN_STRAIN_HALF_LIFE_MS: f64 = 700.0;
const SUSTAIN_RATIO: f64 = 4.0;
const RELEASE_WORK: f64 = 1.0 / 3.0;
const CROSS_HAND_RELEASE: f64 = 0.5;
const JACK_UNITS: f64 = 8.0;
const JACK_WINDOW_MS: f64 = 200.0;
const IDENTITY_RELEASE_WORK: f64 = 1.0 / 1.5;
const TOLERANCE: f64 = LN_SAME_MOTION_TOLERANCE_MS;
const HANDS: [i32; 2] = [3, 12];

pub fn combine_ln_demand(left_fast: f64, left_sustain: f64, right_fast: f64, right_sustain: f64) -> f64 {
    let left = hypot(left_fast, left_sustain) / std::f64::consts::SQRT_2;
    let right = hypot(right_fast, right_sustain) / std::f64::consts::SQRT_2;
    max(left, right) + 0.3 * min(left, right)
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LnWorkSection {
    pub time_ms: f64,
    pub demand: f64,
    pub work: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct LnWorkload {
    pub timeline: LnTimeline4K,
    pub od: f64,
    pub effective: EffectiveLnAnalysis,
    pub sections: Vec<LnWorkSection>,
    pub rice_share: f64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum LnPricing {
    #[default]
    Rating,
    Identity,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct LnWorkloadOptions {
    pub rate: Option<f64>,
    pub od: Option<f64>,
    pub pricing: LnPricing,
}

#[inline]
fn bits(mask: i32) -> i32 {
    mask.count_ones() as i32
}
#[inline]
fn clamp(n: f64) -> f64 {
    max(0.0, min(1.0, n))
}
fn lane_mask(ids: &[usize], lane: &[i8]) -> i32 {
    let mut mask = 0;
    for &id in ids {
        mask |= 1i32 << lane[id];
    }
    mask
}

fn timing_conflict(gap: f64, head_window: f64, tail_window: f64) -> f64 {
    if !(gap > TOLERANCE) {
        return 0.0;
    }
    clamp((gap - TOLERANCE) / head_window) * clamp((head_window + tail_window - gap) / head_window)
}

fn rice_share_of(timeline: &LnTimeline4K, effective: &[bool], lane: &[i8], end: &[f64]) -> f64 {
    let eff = |id: usize| effective.get(id).copied() == Some(true);
    let mut held = [-1i64; 4];
    let mut last = 0.0f64;
    let mut run_objects = 0i32;
    let mut run_rows = 0i32;
    let mut rice_objects = 0i32;
    let flush = |run_objects: &mut i32, run_rows: &mut i32, rice_objects: &mut i32| {
        if *run_rows >= 4 {
            *rice_objects += *run_objects;
        }
        *run_objects = 0;
        *run_rows = 0;
    };
    let mut taps: Vec<usize> = Vec::new();
    for row in &timeline.rows {
        let heads: Vec<usize> = row.head_ids.iter().copied().filter(|&id| eff(id)).collect();
        let tails: Vec<usize> = row.tail_ids.iter().copied().filter(|&id| eff(id)).collect();
        taps.clear();
        taps.extend(row.tap_ids.iter().copied());
        taps.extend(row.head_ids.iter().copied().filter(|&id| !eff(id)));
        if heads.is_empty() && tails.is_empty() && taps.is_empty() {
            continue;
        }
        if max(0.0, row.time_ms - last) > LN_STRAIN_HALF_LIFE_MS * SUSTAIN_RATIO {
            flush(&mut run_objects, &mut run_rows, &mut rice_objects);
        }
        last = row.time_ms;
        let active = held.iter().any(|&id| id >= 0 && end[id as usize] > row.time_ms);
        if !heads.is_empty() || !tails.is_empty() || active {
            flush(&mut run_objects, &mut run_rows, &mut rice_objects);
        } else if !taps.is_empty() {
            run_objects += bits(lane_mask(&taps, lane));
            run_rows += 1;
        }
        for &id in &tails {
            held[lane[id] as usize] = -1;
        }
        for &id in &heads {
            held[lane[id] as usize] = id as i64;
        }
    }
    flush(&mut run_objects, &mut run_rows, &mut rice_objects);
    if timeline.objects.is_empty() {
        0.0
    } else {
        rice_objects as f64 / timeline.objects.len() as f64
    }
}

struct Row<'a> {
    time_ms: f64,
    heads: &'a [usize],
    tails: &'a [usize],
    taps: &'a [usize],
    head_mask: i32,
    tail_mask: i32,
    tap_mask: i32,
}

pub fn build_ln_workload(map: &LnMap, options: &LnWorkloadOptions) -> Option<LnWorkload> {
    if map.key_count != 4 {
        return None;
    }
    let rate = match options.rate {
        Some(r) if r.is_finite() && r > 0.0 => r,
        _ => 1.0,
    };
    let raw_od = options.od.unwrap_or(map.od);
    let od = if raw_od.is_finite() { max(0.0, min(10.0, raw_od)) } else { 8.0 };
    let timeline = build_ln_timeline_4k(map.notes, rate);
    let identity_pricing = options.pricing == LnPricing::Identity;
    let holds = read_effective_holds(
        if timeline.valid { map.notes } else { &[] },
        &EffectiveLnOptions { rate: Some(rate), od: Some(od), key_count: Some(4.0) },
        false,
    );
    if !timeline.valid {
        return Some(LnWorkload { timeline, od, effective: holds.analysis, sections: Vec::new(), rice_share: 0.0 });
    }

    let count = map.notes.len();
    let mut lane = vec![0i8; count];
    let mut start = vec![0.0f64; count];
    let mut end = vec![0.0f64; count];
    let mut is_hold = vec![false; count];
    let mut next = vec![-1i64; count];
    let mut last_in_lane = [-1i64; 4];
    for object in &timeline.objects {
        lane[object.id] = object.lane as i8;
        start[object.id] = object.start_ms;
        end[object.id] = if object.is_hold { object.end_ms } else { object.start_ms };
        is_hold[object.id] = object.is_hold;
        let l = object.lane as usize;
        if last_in_lane[l] >= 0 {
            next[last_in_lane[l] as usize] = object.id as i64;
        }
        last_in_lane[l] = object.id as i64;
    }
    let rice_share = rice_share_of(&timeline, &holds.mask, &lane, &end);
    let rows: Vec<Row> = timeline
        .rows
        .iter()
        .map(|row| Row {
            time_ms: row.time_ms,
            heads: &row.head_ids,
            tails: &row.tail_ids,
            taps: &row.tap_ids,
            head_mask: lane_mask(&row.head_ids, &lane),
            tail_mask: lane_mask(&row.tail_ids, &lane),
            tap_mask: lane_mask(&row.tap_ids, &lane),
        })
        .filter(|row| !row.heads.is_empty() || !row.tails.is_empty() || !row.taps.is_empty())
        .collect();

    let head_window = 64.0 - 3.0 * od;
    let tail_window = head_window * 1.5;
    let hand_press_times: [Vec<f64>; 2] = [0, 1].map(|h| {
        rows.iter().filter(|row| (row.head_mask | row.tap_mask) & HANDS[h] != 0).map(|row| row.time_ms).collect()
    });
    let mut hand_press_cursor = [0usize; 2];
    let mut held = [-1i64; 4];
    let mut previous = [-1i64; 4];
    let mut release_at = [f64::NEG_INFINITY; 4];
    let mut fast = [0.0f64; 2];
    let mut sustain = [0.0f64; 2];
    let mut sections: Vec<(f64, LnWorkSection)> = Vec::new();
    let origin = rows.iter().find(|row| !row.heads.is_empty()).map_or(0.0, |row| row.time_ms);
    let mut last = 0.0f64;

    for row in &rows {
        let time = row.time_ms;
        let elapsed = max(0.0, time - last);
        let decay = pow(0.5, elapsed / LN_STRAIN_HALF_LIFE_MS);
        let slow_decay = pow(0.5, elapsed / (LN_STRAIN_HALF_LIFE_MS * SUSTAIN_RATIO));
        last = time;
        let head_mask = row.head_mask;
        let tail_mask = row.tail_mask;
        let mut inside = 0i32;
        for l in 0..4 {
            let id = held[l];
            if id >= 0 {
                let id = id as usize;
                if end[id] > time && time - start[id] > TOLERANCE && end[id] - time > TOLERANCE {
                    inside |= 1 << l;
                }
            }
        }

        let mut work = 0.0f64;
        for hand in 0..2usize {
            fast[hand] *= decay;
            sustain[hand] *= slow_decay;
            let hand_mask = HANDS[hand];
            let add = |units: f64, fast: &mut [f64; 2], sustain: &mut [f64; 2], work: &mut f64| {
                if !(units > 0.0) {
                    return;
                }
                fast[hand] += units;
                sustain[hand] += units / SUSTAIN_RATIO;
                *work += units;
            };
            let relevant = |l: i32, id: usize| -> bool {
                let n = next[id];
                let shield = n >= 0 && is_hold[n as usize] && start[n as usize] - time <= head_window * 2.0;
                shield
                    || time - release_at[l as usize] <= tail_window
                    || (inside & (1 << (l ^ 1))) != 0
                    || ((head_mask | tail_mask) & hand_mask) != 0
            };
            let mut presses = head_mask & hand_mask;
            for &id in row.taps {
                let l = lane[id] as i32;
                if hand_mask & (1 << l) != 0 && relevant(l, id) {
                    presses |= 1 << l;
                }
            }
            if !identity_pricing {
                for l in hand * 2..hand * 2 + 2 {
                    if presses & (1 << l) == 0 || previous[l] < 0 || is_hold[previous[l] as usize] {
                        continue;
                    }
                    add(
                        JACK_UNITS * clamp(1.0 - (time - start[previous[l] as usize]) / JACK_WINDOW_MS),
                        &mut fast,
                        &mut sustain,
                        &mut work,
                    );
                }
            }
            let releases = tail_mask & hand_mask;
            let moves = presses | releases;
            if moves == 0 {
                continue;
            }
            add(bits(presses) as f64, &mut fast, &mut sustain, &mut work);
            let other_hand_presses = (row.head_mask | row.tap_mask) & HANDS[hand ^ 1];
            add(
                if identity_pricing {
                    IDENTITY_RELEASE_WORK * bits(releases) as f64
                } else {
                    (if other_hand_presses != 0 && (presses & !releases) == 0 { CROSS_HAND_RELEASE } else { 1.0 })
                        * RELEASE_WORK
                        * bits(releases) as f64
                },
                &mut fast,
                &mut sustain,
                &mut work,
            );
            for l in hand * 2..hand * 2 + 2 {
                let bit = 1i32 << l;
                if moves & bit == 0 {
                    continue;
                }
                if held[l ^ 1] >= 0 && (inside & (1 << (l ^ 1))) != 0 {
                    add(1.0, &mut fast, &mut sustain, &mut work);
                }
                if presses & bit == 0 {
                    continue;
                }
                add(
                    if tail_mask & bit != 0 { 1.0 } else { clamp(1.0 - (time - release_at[l]) / tail_window) },
                    &mut fast,
                    &mut sustain,
                    &mut work,
                );
                if previous[l] >= 0 && !is_hold[previous[l] as usize] && head_mask & bit != 0 {
                    add(
                        clamp(1.0 - (time - start[previous[l] as usize]) / (head_window * 2.0)),
                        &mut fast,
                        &mut sustain,
                        &mut work,
                    );
                }
            }
            let press_only = presses & !releases;
            let partners = ((press_only & 5) << 1) | ((press_only & 10) >> 1);
            if partners & releases & !presses != 0 {
                add(1.0, &mut fast, &mut sustain, &mut work);
            }
            if releases == 0 {
                continue;
            }
            let times = &hand_press_times[hand];
            while hand_press_cursor[hand] < times.len() && times[hand_press_cursor[hand]] < time {
                hand_press_cursor[hand] += 1;
            }
            let cursor = hand_press_cursor[hand];
            let before = if cursor >= 1 { times[cursor - 1] } else { f64::NEG_INFINITY };
            let after = if cursor < times.len() { times[cursor] } else { f64::INFINITY };
            let gap = min(time - before, (after - time).abs());
            add(timing_conflict(gap, head_window, tail_window), &mut fast, &mut sustain, &mut work);
            let split = row.tails.iter().any(|&id| {
                hand_mask & (1 << lane[id]) != 0
                    && held.iter().any(|&other| {
                        other >= 0 && {
                            let o = other as usize;
                            hand_mask & (1 << lane[o]) == 0
                                && (start[o] - start[id]).abs() <= TOLERANCE
                                && end[o] - time > TOLERANCE
                        }
                    })
            });
            if split {
                add(1.0 / 2.0, &mut fast, &mut sustain, &mut work);
            }
        }
        if work > 0.0 {
            let slot = ((time - origin) / LN_SECTION_MS).floor();
            if sections.last().map_or(true, |(s, _)| *s != slot) {
                sections.push((slot, LnWorkSection { time_ms: slot * LN_SECTION_MS, demand: 0.0, work: 0.0 }));
            }
            let section = &mut sections.last_mut().unwrap().1;
            section.demand = max(section.demand, combine_ln_demand(fast[0], sustain[0], fast[1], sustain[1]));
            section.work += work;
        }
        for &id in row.tails {
            release_at[lane[id] as usize] = time;
            held[lane[id] as usize] = -1;
        }
        for &id in row.heads {
            previous[lane[id] as usize] = id as i64;
            held[lane[id] as usize] = id as i64;
        }
        for &id in row.taps {
            previous[lane[id] as usize] = id as i64;
        }
    }
    Some(LnWorkload {
        timeline,
        od,
        effective: holds.analysis,
        sections: sections.into_iter().map(|(_, s)| s).collect(),
        rice_share,
    })
}
