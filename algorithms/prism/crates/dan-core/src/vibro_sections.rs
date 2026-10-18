use crate::beatmap::{clone_without_notes, ManiaBeatmap};
use crate::dan_eligibility::inspect_chart_dan_eligibility;
use crate::js::{bit, cmp_num, number, number_opt, to_int32, trim, FxHashMap};
use crate::vibro_motion::{decompose, scan_motion_vibro, REPEATED_QUAD_GAP_MS, SLOW_QUAD_MIN_ROWS};

pub const VIBRO_SECTION_VERSION: f64 = 11.0;

const RECURRING_REPETITION_GAP_MS: f64 = 80.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum VibroReason {
    RepeatedWall,
    SustainedJack,
    RepeatedJackStream,
    RepeatedChord,
    RapidJackBurst,
    IsolatedJack,
    FastRoll,
    ExtremeDensity,
    SplitHandDouble,
    FingerRateCeiling,
    HandActionCeiling,
    FourKeyCycle,
    LockedHands,
    FastTrill,
    Jumptrill,
    StackedHeads,
    FlamChords,
    SustainedDensity,
}

impl VibroReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::RepeatedWall => "repeated_wall",
            Self::SustainedJack => "sustained_jack",
            Self::RepeatedJackStream => "repeated_jack_stream",
            Self::RepeatedChord => "repeated_chord",
            Self::RapidJackBurst => "rapid_jack_burst",
            Self::IsolatedJack => "isolated_jack",
            Self::FastRoll => "fast_roll",
            Self::ExtremeDensity => "extreme_density",
            Self::SplitHandDouble => "split_hand_double",
            Self::FingerRateCeiling => "finger_rate_ceiling",
            Self::HandActionCeiling => "hand_action_ceiling",
            Self::FourKeyCycle => "four_key_cycle",
            Self::LockedHands => "locked_hands",
            Self::FastTrill => "fast_trill",
            Self::Jumptrill => "jumptrill",
            Self::StackedHeads => "stacked_heads",
            Self::FlamChords => "flam_chords",
            Self::SustainedDensity => "sustained_density",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct VibroSection {
    pub start_time: f64,
    pub end_time: f64,
    pub reasons: Vec<VibroReason>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VibroStatus {
    Clean,
    Adjusted,
    Excluded,
}

impl VibroStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Clean => "clean",
            Self::Adjusted => "adjusted",
            Self::Excluded => "excluded",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct VibroAnalysis {
    pub version: f64,
    pub status: VibroStatus,
    pub sections: Vec<VibroSection>,
    pub excluded_duration_ms: f64,
    pub active_duration_ms: f64,
    pub time_share: f64,
    pub note_share: f64,
    pub judgement_share: f64,
    pub remaining_notes: f64,
    pub repeat_share: f64,
    pub reason_shares: Vec<(VibroReason, f64)>,
}

impl VibroAnalysis {
    pub fn reason_share(&self, reason: VibroReason) -> Option<f64> {
        self.reason_shares.iter().find(|(r, _)| *r == reason).map(|(_, v)| *v)
    }
}

pub const UNRATEABLE_REASONS: [&str; 3] = ["jumptrill", "stacked_heads", "flam_chords"];

pub fn is_unrateable_exclusion(analysis: Option<&VibroAnalysis>) -> bool {
    match analysis {
        Some(a) if a.status == VibroStatus::Excluded => {
            !a.reason_shares.is_empty() && a.reason_shares.iter().all(|(r, _)| UNRATEABLE_REASONS.contains(&r.as_str()))
        }
        _ => false,
    }
}

pub fn analyze_stacked_heads(map: &ManiaBeatmap, rate: f64) -> Option<VibroAnalysis> {
    if map.notes.is_empty() || !rate.is_finite() || rate <= 0.0 || inspect_chart_dan_eligibility(map).eligible {
        return None;
    }
    let active_duration_ms = measure_active_duration(&build_vibro_scan(map, rate));
    let mut first = f64::INFINITY;
    let mut last = f64::NEG_INFINITY;
    for note in &map.notes {
        first = jsmath::min(first, note.time);
        last = jsmath::max(last, note.time);
    }
    Some(VibroAnalysis {
        version: VIBRO_SECTION_VERSION,
        status: VibroStatus::Excluded,
        sections: vec![VibroSection { start_time: first, end_time: last, reasons: vec![VibroReason::StackedHeads] }],
        excluded_duration_ms: active_duration_ms,
        active_duration_ms,
        time_share: 1.0,
        note_share: 1.0,
        judgement_share: 1.0,
        remaining_notes: 0.0,
        repeat_share: 0.0,
        reason_shares: vec![(VibroReason::StackedHeads, 1.0)],
    })
}

const FLAM_PRESS_MS: f64 = 40.0;
const FLAM_FINGER_FREE_MS: f64 = 100.0;
const FLAM_CHART_SHARE: f64 = 0.3;

pub fn analyze_collapsed_notes(map: &ManiaBeatmap, rate: f64) -> Option<VibroAnalysis> {
    if map.key_count != 4 || map.notes.is_empty() || !rate.is_finite() || rate <= 0.0 {
        return None;
    }
    let mut tap_map = clone_without_notes(map);
    tap_map.notes = map.notes.iter().filter(|note| !note.is_hold).copied().collect();
    let taps = build_vibro_scan(&tap_map, rate);
    if taps.times.is_empty() || count_flam_chord_notes(&taps) < map.notes.len() as f64 * FLAM_CHART_SHARE {
        return None;
    }
    let scan = build_vibro_scan(map, rate);
    let active_duration_ms = measure_active_duration(&scan);
    Some(VibroAnalysis {
        version: VIBRO_SECTION_VERSION,
        status: VibroStatus::Excluded,
        sections: vec![VibroSection {
            start_time: scan.times[0],
            end_time: scan.times[scan.times.len() - 1],
            reasons: vec![VibroReason::FlamChords],
        }],
        excluded_duration_ms: active_duration_ms,
        active_duration_ms,
        time_share: 1.0,
        note_share: 1.0,
        judgement_share: 1.0,
        remaining_notes: 0.0,
        repeat_share: 0.0,
        reason_shares: vec![(VibroReason::FlamChords, 1.0)],
    })
}

fn count_flam_chord_notes(scan: &VibroScan) -> f64 {
    let n = scan.times.len();
    let mut next_on_columns = vec![f64::INFINITY; n];
    let mut next_on_column = [f64::INFINITY; 4];
    for i in (0..n).rev() {
        let mut next = f64::INFINITY;
        for column in 0..4 {
            if scan.rows[i] & bit(column) == 0 {
                continue;
            }
            next = jsmath::min(next, next_on_column[column as usize]);
            next_on_column[column as usize] = scan.times[i];
        }
        next_on_columns[i] = next;
    }
    let mut flam_notes = 0f64;
    let mut start = 0usize;
    let mut mask = scan.rows[0];
    let close_press = |start: usize, end: usize, flam_notes: &mut f64| {
        if end - start < 2 || (start..end).any(|k| scan.prefix_notes[k + 1] - scan.prefix_notes[k] < 2.0) {
            return;
        }
        *flam_notes += scan.prefix_notes[end] - scan.prefix_notes[start];
    };
    for i in 1..n {
        let mut joins = scan.times[i] - scan.times[start] <= FLAM_PRESS_MS * scan.rate && scan.rows[i] & mask == 0;
        let mut k = start;
        while joins && k < i {
            joins = next_on_columns[k] - scan.times[i] >= FLAM_FINGER_FREE_MS * scan.rate;
            k += 1;
        }
        if joins {
            mask |= scan.rows[i];
            continue;
        }
        close_press(start, i, &mut flam_notes);
        start = i;
        mask = scan.rows[i];
    }
    close_press(start, n, &mut flam_notes);
    flam_notes
}

pub fn uses_section_vibro(map: &ManiaBeatmap) -> bool {
    map.key_count == 4
        && !map.notes.is_empty()
        && map.notes.iter().filter(|n| n.is_hold).count() as f64 / map.notes.len() as f64 <= 0.1
}

#[inline]
fn bit_count(mask: i32) -> i32 {
    (mask as u32).count_ones() as i32
}

struct VibroScan {
    times: Vec<f64>,
    rows: Vec<i32>,
    prefix_notes: Vec<f64>,
    rate: f64,
    intervals: Vec<VibroSection>,
    repetition_bursts: Vec<VibroSection>,
}

impl VibroScan {
    #[inline]
    fn total_notes(&self) -> f64 {
        self.prefix_notes[self.prefix_notes.len() - 1]
    }
}

pub fn analyze_vibro_sections(map: &ManiaBeatmap, rate: f64) -> VibroAnalysis {
    let mut result = VibroAnalysis {
        version: VIBRO_SECTION_VERSION,
        status: VibroStatus::Clean,
        sections: Vec::new(),
        excluded_duration_ms: 0.0,
        active_duration_ms: 0.0,
        time_share: 0.0,
        note_share: 0.0,
        judgement_share: 0.0,
        remaining_notes: map.notes.len() as f64,
        repeat_share: 0.0,
        reason_shares: Vec::new(),
    };
    if !uses_section_vibro(map) || !rate.is_finite() || rate <= 0.0 {
        return result;
    }
    if let Some(unrateable) = analyze_stacked_heads(map, rate).or_else(|| analyze_collapsed_notes(map, rate)) {
        return unrateable;
    }
    let mut scan = build_vibro_scan(map, rate);
    result.active_duration_ms = measure_active_duration(&scan);

    for motion in scan_motion_vibro(map, rate) {
        add_section(&mut scan, motion.start_time, motion.end_time, motion.reason);
    }
    scan_repeated_rows(&mut scan);
    scan_quad_body(&mut scan);
    scan_locked_hands(&mut scan);
    scan_fast_trills(&mut scan);
    scan_jumptrills(&mut scan);
    scan_hammered_chords(&mut scan);
    scan_one_finger_body(&mut scan);
    scan_repeated_jack_streams(&mut scan);
    scan_repeated_pairs(&mut scan);
    scan_fixed_finger_windows(&mut scan);
    scan_isolated_jacks(&mut scan);
    let returns = count_fast_finger_returns(&scan, 70.0);
    scan_fast_rolls(&mut scan, &returns);
    scan_extreme_density(&mut scan);
    scan_sustained_density(&mut scan);
    scan_recurring_repetitions(&mut scan);

    result.reason_shares = measure_reason_shares(&scan.intervals, rate, result.active_duration_ms);
    result.sections = merge_sections(&scan.intervals, true);
    if !result.sections.is_empty() {
        measure_section_coverage(&mut result, map, &scan);
    }
    result
}

fn build_vibro_scan(map: &ManiaBeatmap, rate: f64) -> VibroScan {
    let (times, rows) = decompose(map);
    let mut prefix_notes = Vec::with_capacity(rows.len() + 1);
    prefix_notes.push(0.0);
    let mut acc = 0f64;
    for &mask in &rows {
        acc += bit_count(mask) as f64;
        prefix_notes.push(acc);
    }
    VibroScan { times, rows, prefix_notes, rate, intervals: Vec::new(), repetition_bursts: Vec::new() }
}

fn measure_reason_shares(intervals: &[VibroSection], rate: f64, active_duration_ms: f64) -> Vec<(VibroReason, f64)> {
    let mut shares = Vec::new();
    if active_duration_ms <= 0.0 {
        return shares;
    }
    let mut by_reason: Vec<(VibroReason, Vec<VibroSection>)> = Vec::new();
    for interval in intervals {
        for &reason in &interval.reasons {
            match by_reason.iter_mut().find(|(r, _)| *r == reason) {
                Some((_, bucket)) => bucket.push(interval.clone()),
                None => by_reason.push((reason, vec![interval.clone()])),
            }
        }
    }
    for (reason, group) in by_reason {
        let mut covered = 0f64;
        for merged in merge_sections(&group, true) {
            covered += (merged.end_time - merged.start_time) / rate;
        }
        shares.push((reason, covered / active_duration_ms));
    }
    shares
}

fn add_section(scan: &mut VibroScan, start: f64, end: f64, reason: VibroReason) {
    if end > start {
        scan.intervals.push(VibroSection { start_time: start, end_time: end, reasons: vec![reason] });
    }
}

fn scan_consecutive_rows(scan: &mut VibroScan, matches: impl Fn(&VibroScan, usize) -> bool, min_transitions: usize, reason: VibroReason) {
    let n = scan.times.len();
    let mut start = 1usize;
    let mut i = 1usize;
    while i <= n {
        if i < n && matches(scan, i) {
            i += 1;
            continue;
        }
        if i >= start && i - start >= min_transitions {
            let (a, b) = (scan.times[start - 1], scan.times[i - 1]);
            add_section(scan, a, b, reason);
        }
        start = i + 1;
        i += 1;
    }
}

const REPEATED_ROW_GAP_MS: f64 = 92.0;
#[inline]
fn repeated_row_gap_ms(mask: i32) -> f64 {
    if mask == 15 {
        REPEATED_QUAD_GAP_MS
    } else {
        REPEATED_ROW_GAP_MS
    }
}
const SLOW_QUAD_GAP_MS: f64 = 105.0;
const IDLE_WALL_MIN_ROWS: usize = 12;
const IDLE_WALL_MIN_COUNT: usize = 2;
const IDLE_WALL_CONTEXT_ROWS: usize = 16;
const IDLE_WALL_ACTIVE_SHARE: f64 = 0.4;

fn scan_idle_quad_walls(scan: &mut VibroScan) {
    let n = scan.times.len();
    let rate = scan.rate;
    let mut idle: Vec<(f64, f64)> = Vec::new();
    let mut start: isize = -1;
    for i in 0..=n {
        let quad = i < n && scan.rows[i] == 15;
        if quad && start >= 0 && scan.times[i] - scan.times[i - 1] <= SLOW_QUAD_GAP_MS * rate {
            continue;
        }
        if start >= 0 && i - start as usize >= IDLE_WALL_MIN_ROWS {
            let s = start as usize;
            let mut active = 0f64;
            let mut context = 0f64;
            let rows = &scan.rows;
            let mut count = |k: usize| {
                context += 1.0;
                if bit_count(rows[k]) >= 2 && rows[k] != rows[k - 1] {
                    active += 1.0;
                }
            };
            let from = if s >= IDLE_WALL_CONTEXT_ROWS { (s - IDLE_WALL_CONTEXT_ROWS).max(1) } else { 1 };
            for k in from..s {
                count(k);
            }
            for k in i..n.min(i + IDLE_WALL_CONTEXT_ROWS) {
                count(k);
            }
            if context > 0.0 && active / context < IDLE_WALL_ACTIVE_SHARE {
                idle.push((scan.times[s], scan.times[i - 1]));
            }
        }
        start = if quad { i as isize } else { -1 };
    }
    if idle.len() < IDLE_WALL_MIN_COUNT {
        return;
    }
    for (from, to) in idle {
        add_section(scan, from, to, VibroReason::RepeatedWall);
    }
}

fn scan_repeated_rows(scan: &mut VibroScan) {
    scan_consecutive_rows(
        scan,
        |s, i| {
            s.rows[i] == s.rows[i - 1]
                && bit_count(s.rows[i]) >= 2
                && s.times[i] - s.times[i - 1] <= repeated_row_gap_ms(s.rows[i]) * s.rate
        },
        11,
        VibroReason::RepeatedWall,
    );
    scan_consecutive_rows(
        scan,
        |s, i| s.rows[i] == 15 && s.rows[i - 1] == 15 && s.times[i] - s.times[i - 1] <= SLOW_QUAD_GAP_MS * s.rate,
        SLOW_QUAD_MIN_ROWS - 1,
        VibroReason::RepeatedWall,
    );
    scan_idle_quad_walls(scan);
    scan_consecutive_rows(
        scan,
        |s, i| s.rows[i] == s.rows[i - 1] && s.times[i] - s.times[i - 1] <= 92.0 * s.rate,
        24,
        VibroReason::SustainedJack,
    );
}

const QUAD_BODY_TIERS: [(f64, usize, f64); 2] = [(125.0, 12, 0.25), (100.0, 3, 0.3)];

fn scan_quad_body(scan: &mut VibroScan) {
    let n = scan.times.len();
    for &(gap_ms, min_rows, share) in &QUAD_BODY_TIERS {
        let mut walls: Vec<(usize, usize)> = Vec::new();
        let mut wall_notes = 0f64;
        let mut start: isize = -1;
        for i in 0..=n {
            let quad = i < n && scan.rows[i] == 15;
            if quad && start >= 0 && scan.times[i] - scan.times[i - 1] <= gap_ms * scan.rate {
                continue;
            }
            if start >= 0 && i - start as usize >= min_rows {
                walls.push((start as usize, i - 1));
                wall_notes += ((i - start as usize) * 4) as f64;
            }
            start = if quad { i as isize } else { -1 };
        }
        if wall_notes < scan.total_notes() * share {
            continue;
        }
        for (first, last) in walls {
            let (a, b) = (scan.times[first], scan.times[last]);
            add_section(scan, a, b, VibroReason::RepeatedWall);
        }
    }
}

const LOCKED_HAND_GAP_MS: f64 = 95.0;
const LOCKED_HAND_MIN_ROWS: usize = 24;
const LOCKED_HAND_LONG_ROWS: usize = 64;
const LOCKED_HAND_SHARE: f64 = 0.4;

fn scan_locked_hands(scan: &mut VibroScan) {
    let n = scan.times.len();
    let mut runs: Vec<(usize, usize)> = Vec::new();
    let mut run_notes = 0f64;
    let mut start: isize = -1;
    for i in 0..=n {
        let locked = i < n && (scan.rows[i] == 3 || scan.rows[i] == 12 || scan.rows[i] == 15);
        if locked
            && start >= 0
            && (scan.rows[i] & scan.rows[i - 1]) != 0
            && scan.times[i] - scan.times[i - 1] <= LOCKED_HAND_GAP_MS * scan.rate
        {
            continue;
        }
        if start >= 0 && i - start as usize >= LOCKED_HAND_MIN_ROWS {
            let s = start as usize;
            let mut left = false;
            let mut right = false;
            for k in s..i {
                if scan.rows[k] == 3 {
                    left = true;
                }
                if scan.rows[k] == 12 {
                    right = true;
                }
            }
            if left && right {
                runs.push((s, i - 1));
                run_notes += scan.prefix_notes[i] - scan.prefix_notes[s];
            }
        }
        start = if locked { i as isize } else { -1 };
    }
    let body = run_notes >= scan.total_notes() * LOCKED_HAND_SHARE;
    for (first, last) in runs {
        if body || last - first + 1 >= LOCKED_HAND_LONG_ROWS {
            let (a, b) = (scan.times[first], scan.times[last]);
            add_section(scan, a, b, VibroReason::LockedHands);
        }
    }
}

const FAST_TRILL_GAP_MS: f64 = 45.0;
const FAST_TRILL_MIN_ROWS: usize = 48;
const FAST_TRILL_RETURN_SHARE: f64 = 0.8;

fn scan_fast_trills(scan: &mut VibroScan) {
    let n = scan.times.len();
    let single = |mask: i32| mask != 0 && (mask & mask.wrapping_sub(1)) == 0;
    let mut start = 0usize;
    let mut returns = 0f64;
    let mut i = 1usize;
    while i <= n {
        if i < n
            && single(scan.rows[i])
            && single(scan.rows[i - 1])
            && scan.rows[i] != scan.rows[i - 1]
            && scan.times[i] - scan.times[i - 1] <= FAST_TRILL_GAP_MS * scan.rate
        {
            if i - start >= 2 && scan.rows[i] == scan.rows[i - 2] {
                returns += 1.0;
            }
            i += 1;
            continue;
        }
        let length = i - start;
        if length >= FAST_TRILL_MIN_ROWS && returns >= (length as f64 - 2.0) * FAST_TRILL_RETURN_SHARE {
            let (a, b) = (scan.times[start], scan.times[i - 1]);
            add_section(scan, a, b, VibroReason::FastTrill);
        }
        start = i;
        returns = 0.0;
        i += 1;
    }
}

const JUMPTRILL_PRESS_MS: f64 = 30.0;
const JUMPTRILL_GAP_MS: f64 = 65.0;
const JUMPTRILL_MIN_PRESSES: usize = 8;
const JUMPTRILL_FULL_SHARE: f64 = 0.75;
const JUMPTRILL_CHART_SHARE: f64 = 0.3;

fn scan_jumptrills(scan: &mut VibroScan) {
    let (bursts, burst_notes) = find_jumptrill_bursts(&scan.times, &scan.rows, scan.rate, [0b0011, 0b1100], -1, JUMPTRILL_GAP_MS);
    if burst_notes >= scan.total_notes() * JUMPTRILL_CHART_SHARE {
        scan.intervals.extend(bursts);
    }
}

#[derive(Clone, Copy)]
struct Press {
    start: f64,
    end: f64,
    hand: usize,
    mask: i32,
}

fn find_jumptrill_bursts(
    times: &[f64],
    rows: &[i32],
    rate: f64,
    hand_masks: [i32; 2],
    middle_column: i32,
    gap_ms: f64,
) -> (Vec<VibroSection>, f64) {
    let mut presses: Vec<Press> = Vec::new();
    let mut open: [Option<usize>; 2] = [None, None];
    let middle_bit = if middle_column >= 0 { bit(middle_column) } else { 0 };
    for i in 0..times.len() {
        let mut sides = [rows[i] & hand_masks[0], rows[i] & hand_masks[1]];
        if rows[i] & middle_bit != 0 {
            if sides[0] != 0 && sides[1] == 0 {
                sides[0] |= middle_bit;
            } else if sides[1] != 0 && sides[0] == 0 {
                sides[1] |= middle_bit;
            } else if sides[0] == 0 && sides[1] == 0 {
                let hand = (0..2).find(|&h| match open[h] {
                    Some(p) => {
                        let press = &presses[p];
                        times[i] - press.start <= JUMPTRILL_PRESS_MS * rate && press.mask & middle_bit == 0
                    }
                    None => false,
                });
                if let Some(h) = hand {
                    sides[h] |= middle_bit;
                }
            }
        }
        for hand in 0..2 {
            let bits = sides[hand];
            if bits == 0 {
                continue;
            }
            if let Some(p) = open[hand] {
                let press = &mut presses[p];
                if times[i] - press.start <= JUMPTRILL_PRESS_MS * rate && press.mask & bits == 0 {
                    press.mask |= bits;
                    press.end = times[i];
                    continue;
                }
            }
            presses.push(Press { start: times[i], end: times[i], hand, mask: bits });
            open[hand] = Some(presses.len() - 1);
        }
    }
    let mut bursts = Vec::new();
    let mut burst_notes = 0f64;
    let mut start = 0usize;
    let full = |press: &Press| (press.mask & hand_masks[press.hand]) == hand_masks[press.hand];
    for i in 1..=presses.len() {
        if i < presses.len()
            && presses[i].hand != presses[i - 1].hand
            && presses[i].start - presses[i - 1].start <= gap_ms * rate
        {
            continue;
        }
        let run = &presses[start..i];
        if run.len() >= JUMPTRILL_MIN_PRESSES
            && run.iter().filter(|p| full(p)).count() as f64 >= run.len() as f64 * JUMPTRILL_FULL_SHARE
        {
            bursts.push(VibroSection {
                start_time: run[0].start,
                end_time: run[run.len() - 1].end,
                reasons: vec![VibroReason::Jumptrill],
            });
            let mut sum = 0f64;
            for p in run {
                sum += bit_count(p.mask) as f64;
            }
            burst_notes += sum;
        }
        start = i;
    }
    (bursts, burst_notes)
}

pub fn analyze_hold_vibro(map: &ManiaBeatmap, rate: f64) -> Option<VibroAnalysis> {
    if map.key_count != 4 || map.notes.is_empty() || uses_section_vibro(map) || !rate.is_finite() || rate <= 0.0 {
        return None;
    }
    let mut scan = build_vibro_scan(map, rate);
    for motion in scan_motion_vibro(map, rate) {
        add_section(&mut scan, motion.start_time, motion.end_time, motion.reason);
    }
    if scan.intervals.is_empty() {
        return None;
    }
    let active_duration_ms = measure_active_duration(&scan);
    let sections = merge_sections(&scan.intervals, true);
    scan.intervals.sort_by(|a, b| cmp_num(a.start_time, b.start_time));
    let reason_shares = measure_reason_shares(&scan.intervals, rate, active_duration_ms);
    let mut result = VibroAnalysis {
        version: VIBRO_SECTION_VERSION,
        status: VibroStatus::Clean,
        sections,
        excluded_duration_ms: 0.0,
        active_duration_ms,
        time_share: 0.0,
        note_share: 0.0,
        judgement_share: 0.0,
        remaining_notes: map.notes.len() as f64,
        repeat_share: 0.0,
        reason_shares,
    };
    measure_section_coverage(&mut result, map, &scan);
    if result.status == VibroStatus::Excluded { Some(result) } else { None }
}

const WIDE_JUMPTRILL_GAP_MS: f64 = 75.0;

pub const PRISM_ENABLED: bool = true;

fn uses_prism(key_count: i32) -> bool {
    PRISM_ENABLED && matches!(key_count, 6 | 7 | 8)
}

pub fn analyze_wide_jumptrill(map: &ManiaBeatmap, rate: f64) -> Option<VibroAnalysis> {
    if map.key_count < 4
        || (map.key_count == 4 && uses_section_vibro(map))
        || uses_prism(map.key_count)
        || map.notes.is_empty()
        || !rate.is_finite()
        || rate <= 0.0
    {
        return None;
    }
    let half = map.key_count / 2;
    let middle_column = if map.key_count % 2 != 0 { half } else { -1 };
    let mut hand_masks = [0i32; 2];
    for column in 0..map.key_count {
        if column != middle_column {
            hand_masks[if column < half { 0 } else { 1 }] |= bit(column);
        }
    }
    let scan = build_vibro_scan(map, rate);
    let four_key = map.key_count == 4;
    let taps;
    let read = if four_key {
        let mut tap_map = clone_without_notes(map);
        tap_map.notes = map.notes.iter().filter(|note| !note.is_hold).copied().collect();
        taps = build_vibro_scan(&tap_map, rate);
        &taps
    } else {
        &scan
    };
    let gap_ms = if four_key { JUMPTRILL_GAP_MS } else { WIDE_JUMPTRILL_GAP_MS };
    let (bursts, burst_notes) = find_jumptrill_bursts(&read.times, &read.rows, rate, hand_masks, middle_column, gap_ms);
    let n_notes = map.notes.len() as f64;
    if burst_notes < n_notes * JUMPTRILL_CHART_SHARE {
        return None;
    }
    let active_duration_ms = measure_active_duration(&scan);
    let sections = merge_sections(&bursts, true);
    let mut excluded_duration_ms = 0f64;
    for section in &sections {
        excluded_duration_ms += (section.end_time - section.start_time) / rate;
    }
    let time_share = if active_duration_ms > 0.0 { jsmath::min(1.0, excluded_duration_ms / active_duration_ms) } else { 1.0 };
    let note_share = burst_notes / n_notes;
    Some(VibroAnalysis {
        version: VIBRO_SECTION_VERSION,
        status: VibroStatus::Excluded,
        sections,
        excluded_duration_ms,
        active_duration_ms,
        time_share,
        note_share,
        judgement_share: note_share,
        remaining_notes: n_notes - burst_notes,
        repeat_share: 0.0,
        reason_shares: vec![(VibroReason::Jumptrill, time_share)],
    })
}

const HAMMER_GAP_MS: f64 = 92.0;
const HAMMER_MIN_REPEATS: usize = 4;
const HAMMER_MIN_ROWS: usize = 24;
const HAMMER_RUN_SHARE: f64 = 0.66;

fn scan_hammered_chords(scan: &mut VibroScan) {
    let n = scan.times.len();
    let mut start = 0usize;
    for i in 1..=n {
        if i < n
            && bit_count(scan.rows[i]) >= 3
            && bit_count(scan.rows[i - 1]) >= 3
            && scan.times[i] - scan.times[i - 1] <= HAMMER_GAP_MS * scan.rate
        {
            continue;
        }
        if i - start >= HAMMER_MIN_ROWS && bit_count(scan.rows[start]) >= 3 {
            let mut in_runs = 0usize;
            let mut run_start = start;
            for k in (start + 1)..=i {
                if k < i && scan.rows[k] == scan.rows[k - 1] {
                    continue;
                }
                if k - run_start >= HAMMER_MIN_REPEATS && bit_count(scan.rows[run_start]) == 3 {
                    in_runs += k - run_start;
                }
                run_start = k;
            }
            if in_runs as f64 >= (i - start) as f64 * HAMMER_RUN_SHARE {
                let (a, b) = (scan.times[start], scan.times[i - 1]);
                add_section(scan, a, b, VibroReason::RepeatedChord);
            }
        }
        start = i;
    }
}

const ONE_FINGER_GAP_MS: f64 = 90.0;
const ONE_FINGER_MIN_HITS: usize = 7;
const ONE_FINGER_COVERAGE: f64 = 0.9;
const ONE_FINGER_DOMINANCE: f64 = 0.4;
const ONE_FINGER_SHARE: f64 = 0.25;

fn column_indices(rows: &[i32], column: i32) -> Vec<usize> {
    let b = bit(column);
    (0..rows.len()).filter(|&i| rows[i] & b != 0).collect()
}

fn scan_one_finger_body(scan: &mut VibroScan) {
    let n = scan.times.len();
    let mut runs: Vec<(usize, usize)> = Vec::new();
    let mut covered = vec![0u8; n];
    for column in 0..4 {
        let indices = column_indices(&scan.rows, column);
        let mut start = 0usize;
        for i in 1..=indices.len() {
            if i < indices.len() && scan.times[indices[i]] - scan.times[indices[i - 1]] <= ONE_FINGER_GAP_MS * scan.rate {
                continue;
            }
            let count = i - start;
            let first = indices[start];
            let last = indices[i - 1];
            if count >= ONE_FINGER_MIN_HITS
                && count as f64 / (last - first + 1) as f64 >= ONE_FINGER_COVERAGE
                && count as f64 / (scan.prefix_notes[last + 1] - scan.prefix_notes[first]) >= ONE_FINGER_DOMINANCE
            {
                runs.push((first, last));
                for c in &mut covered[first..=last] {
                    *c = 1;
                }
            }
            start = i;
        }
    }
    let mut covered_notes = 0f64;
    for i in 0..n {
        if covered[i] != 0 {
            covered_notes += scan.prefix_notes[i + 1] - scan.prefix_notes[i];
        }
    }
    if covered_notes < scan.total_notes() * ONE_FINGER_SHARE {
        return;
    }
    for (first, last) in runs {
        let (a, b) = (scan.times[first], scan.times[last]);
        add_section(scan, a, b, VibroReason::IsolatedJack);
    }
}

fn scan_repeated_jack_streams(scan: &mut VibroScan) {
    let n = scan.times.len();
    let rate = scan.rate;
    let mut burst_rows = vec![0u8; n];
    let mut burst_shapes = vec![0u8; n];
    let mut repeat_start = 0usize;
    let mut max_repeat_gap = 0f64;
    for i in 1..=n {
        if i < n && scan.rows[i] == scan.rows[i - 1] && scan.times[i] - scan.times[i - 1] <= 100.0 * rate {
            max_repeat_gap = jsmath::max(max_repeat_gap, scan.times[i] - scan.times[i - 1]);
            continue;
        }
        let count = i - repeat_start;
        if count >= 3 && count < 12 && max_repeat_gap <= repeated_row_gap_ms(scan.rows[repeat_start]) * rate {
            let shape = scan.rows[repeat_start] as u8;
            for k in repeat_start..i {
                burst_rows[k] = 1;
                burst_shapes[k] = shape;
            }
        }
        repeat_start = i;
        max_repeat_gap = 0.0;
    }
    let mut fast_start = 0usize;
    let mut repeated_in_window = 0f64;
    let mut repeated_chords_in_window = 0f64;
    let mut shape_counts = [0i32; 16];
    let mut distinct_shapes = 0i32;
    let burst_window_rows = 64usize;
    for i in 0..n {
        if i > 0 && scan.times[i] - scan.times[i - 1] > 100.0 * rate {
            fast_start = i;
        }
        repeated_in_window += burst_rows[i] as f64;
        repeated_chords_in_window += if burst_rows[i] != 0 && bit_count(scan.rows[i]) >= 2 { 1.0 } else { 0.0 };
        let s = burst_shapes[i] as usize;
        if s != 0 && s < 16 {
            shape_counts[s] += 1;
            if shape_counts[s] == 1 {
                distinct_shapes += 1;
            }
        }
        if i >= burst_window_rows {
            let o = i - burst_window_rows;
            repeated_in_window -= burst_rows[o] as f64;
            repeated_chords_in_window -= if burst_rows[o] != 0 && bit_count(scan.rows[o]) >= 2 { 1.0 } else { 0.0 };
            let so = burst_shapes[o] as usize;
            if so != 0 && so < 16 {
                shape_counts[so] -= 1;
                if shape_counts[so] == 0 {
                    distinct_shapes -= 1;
                }
            }
        }
        if i + 1 >= fast_start + burst_window_rows
            && repeated_in_window / burst_window_rows as f64 >= 0.7
            && repeated_chords_in_window / burst_window_rows as f64 >= 0.35
            && distinct_shapes >= 2
        {
            let (a, b) = (scan.times[i + 1 - burst_window_rows], scan.times[i]);
            add_section(scan, a, b, VibroReason::RepeatedJackStream);
        }
    }
}

fn scan_repeated_pairs(scan: &mut VibroScan) {
    for pair in [3, 5, 6, 9, 10, 12] {
        scan_consecutive_rows(
            scan,
            move |s, i| (s.rows[i] & pair) == pair && (s.rows[i - 1] & pair) == pair && s.times[i] - s.times[i - 1] <= 70.0 * s.rate,
            11,
            VibroReason::RepeatedChord,
        );
    }
}

#[derive(Clone, Copy)]
struct RepetitionBand {
    gap_ms: f64,
    average_gap_ms: f64,
    min_hits: usize,
    min_share: f64,
    reason: VibroReason,
}

const SINGLE_FINGER_BANDS: [RepetitionBand; 2] = [
    RepetitionBand { gap_ms: 30.0, average_gap_ms: 30.0, min_hits: 4, min_share: 0.0, reason: VibroReason::RapidJackBurst },
    RepetitionBand { gap_ms: 85.0, average_gap_ms: 55.0, min_hits: 9, min_share: 0.0, reason: VibroReason::RapidJackBurst },
];
const PAIR_LOCK_GAP_MS: f64 = 85.0;
const PAIR_BANDS: [RepetitionBand; 3] = [
    RepetitionBand { gap_ms: 55.0, average_gap_ms: 55.0, min_hits: 4, min_share: 0.0, reason: VibroReason::RapidJackBurst },
    RepetitionBand { gap_ms: 60.0, average_gap_ms: 60.0, min_hits: 6, min_share: 0.0, reason: VibroReason::RapidJackBurst },
    RepetitionBand { gap_ms: 92.0, average_gap_ms: 92.0, min_hits: 12, min_share: 0.7, reason: VibroReason::RepeatedChord },
];
const QUAD_BANDS: [RepetitionBand; 1] =
    [RepetitionBand { gap_ms: 92.0, average_gap_ms: 92.0, min_hits: 8, min_share: 0.0, reason: VibroReason::RepeatedWall }];

fn scan_fixed_finger_windows(scan: &mut VibroScan) {
    let rate = scan.rate;
    for mask in [1, 2, 4, 8, 3, 5, 6, 9, 10, 12, 15] {
        let fingers = bit_count(mask);
        let indices: Vec<usize> = (0..scan.rows.len()).filter(|&i| (scan.rows[i] & mask) == mask).collect();
        let bands: &[RepetitionBand] = if fingers == 1 {
            &SINGLE_FINGER_BANDS
        } else if fingers == 4 {
            &QUAD_BANDS
        } else {
            &PAIR_BANDS
        };
        for band in bands {
            let mut phrase_start = 0usize;
            let mut phrase_end = 0usize;
            for i in 0..indices.len() {
                if i > 0 && scan.times[indices[i]] - scan.times[indices[i - 1]] > band.gap_ms * rate {
                    phrase_start = i;
                }
                if fingers == 2 && band.min_share > 0.0 && i == phrase_start {
                    phrase_end = i;
                    while phrase_end + 1 < indices.len()
                        && scan.times[indices[phrase_end + 1]] - scan.times[indices[phrase_end]] <= band.gap_ms * rate
                    {
                        phrase_end += 1;
                    }
                }
                if i + 1 < band.min_hits {
                    continue;
                }
                let first_hit = i + 1 - band.min_hits;
                if first_hit < phrase_start {
                    continue;
                }
                let first = indices[first_hit];
                let last = indices[i];
                if scan.times[last] - scan.times[first] > (band.min_hits as f64 - 1.0) * band.average_gap_ms * rate {
                    continue;
                }
                let local_notes = scan.prefix_notes[last + 1] - scan.prefix_notes[first];
                if fingers == 2 && band.min_share > 0.0 {
                    let locked = (scan.times[last] - scan.times[first]) / (last as f64 - first as f64) <= PAIR_LOCK_GAP_MS * rate;
                    let mut held_rows = 0f64;
                    for row in first..=last {
                        let ok = if locked { (scan.rows[row] & mask) == mask } else { scan.rows[row] == mask };
                        if ok {
                            held_rows += 1.0;
                        }
                    }
                    let phrase_hits = (phrase_end as f64) - (phrase_start as f64) + 1.0;
                    let phrase_notes =
                        scan.prefix_notes[indices[phrase_end] + 1] - scan.prefix_notes[indices[phrase_start]];
                    let sustained_pair = phrase_hits >= 25.0 && phrase_hits * fingers as f64 / phrase_notes >= band.min_share;
                    if !sustained_pair && held_rows / ((last - first + 1) as f64) < 2.0 / 3.0 {
                        continue;
                    }
                }
                if band.min_hits as f64 * fingers as f64 / local_notes >= band.min_share {
                    let (a, b) = (scan.times[first], scan.times[last]);
                    add_section(scan, a, b, band.reason);
                }
            }
        }
        collect_short_repetitions(scan, &indices, fingers);
    }
}

fn collect_short_repetitions(scan: &mut VibroScan, indices: &[usize], fingers: i32) {
    let rate = scan.rate;
    let min_hits = if fingers == 1 { 6 } else { 4 };
    let max_hits = if fingers == 1 {
        24
    } else if fingers == 2 {
        11
    } else {
        7
    };
    let mut start = 0usize;
    for end in 1..=indices.len() {
        if end < indices.len() && scan.times[indices[end]] - scan.times[indices[end - 1]] <= 100.0 * rate {
            continue;
        }
        let hits = end - start;
        if hits >= min_hits && hits <= max_hits {
            for i in (start + min_hits - 1)..end {
                let first = indices[i + 1 - min_hits];
                let last = indices[i];
                if scan.times[last] - scan.times[first] > (min_hits as f64 - 1.0) * RECURRING_REPETITION_GAP_MS * rate {
                    continue;
                }
                let share = (min_hits as f64 * fingers as f64) / (scan.prefix_notes[last + 1] - scan.prefix_notes[first]);
                let skip = if fingers == 1 {
                    share <= 0.5 || (min_hits as f64) / ((last - first + 1) as f64) < 0.9
                } else {
                    fingers == 2 && share < 2.0 / 3.0
                };
                if skip {
                    continue;
                }
                let reason = if fingers == 1 {
                    VibroReason::IsolatedJack
                } else if fingers == 2 {
                    VibroReason::RepeatedChord
                } else {
                    VibroReason::RepeatedWall
                };
                scan.repetition_bursts.push(VibroSection {
                    start_time: scan.times[first],
                    end_time: scan.times[last],
                    reasons: vec![reason],
                });
            }
        }
        start = end;
    }
}

fn scan_isolated_jacks(scan: &mut VibroScan) {
    let rate = scan.rate;
    let mut bursts: Vec<VibroSection> = Vec::new();
    let mut slower_runs: Vec<(VibroSection, i32)> = Vec::new();
    let mut isolated_burst_notes = 0f64;
    for column in 0..4 {
        let indices = column_indices(&scan.rows, column);
        let mut start = 0usize;
        for i in 1..=indices.len() {
            if i < indices.len() && scan.times[indices[i]] - scan.times[indices[i - 1]] <= 100.0 * rate {
                continue;
            }
            let count = i - start;
            if count >= 9 {
                let first = indices[start];
                let last = indices[i - 1];
                let local_notes = scan.prefix_notes[last + 1] - scan.prefix_notes[first];
                let countf = count as f64;
                let dominant = countf / local_notes >= 0.65;
                let long_run = count >= 25 && (scan.times[last] - scan.times[first]) / (countf - 1.0) <= 92.0 * rate;
                let accompanied_long_jack =
                    long_run && countf / local_notes > 0.5 && countf / (last - first + 1) as f64 >= 0.9;
                if !long_run
                    && count >= 25
                    && (scan.times[last] - scan.times[first]) / (countf - 1.0) <= 100.0 * rate
                    && countf / local_notes > 0.5
                    && countf / (last - first + 1) as f64 >= 0.9
                {
                    slower_runs.push((
                        VibroSection {
                            start_time: scan.times[first],
                            end_time: scan.times[last],
                            reasons: vec![VibroReason::IsolatedJack],
                        },
                        column,
                    ));
                }
                if dominant || accompanied_long_jack {
                    let section = VibroSection {
                        start_time: scan.times[first],
                        end_time: scan.times[last],
                        reasons: vec![VibroReason::IsolatedJack],
                    };
                    if dominant {
                        bursts.push(section.clone());
                        isolated_burst_notes += countf;
                    }
                    if long_run {
                        scan.intervals.push(section);
                    }
                }
            }
            start = i;
        }
    }
    if bursts.len() >= 4 && isolated_burst_notes / scan.total_notes() >= 0.2 {
        scan.intervals.extend(bursts);
    }
    let walls: Vec<VibroSection> = scan
        .intervals
        .iter()
        .filter(|s| s.reasons.contains(&VibroReason::RepeatedWall) || s.reasons.contains(&VibroReason::RepeatedChord))
        .cloned()
        .collect();
    let wall_sections: Vec<VibroSection> =
        merge_sections(&walls, true).into_iter().filter(|s| s.end_time - s.start_time >= 1000.0 * rate).collect();
    slower_runs.sort_by(|a, b| cmp_num(a.0.start_time, b.0.start_time));
    let mut start = 0usize;
    for end in 1..=slower_runs.len() {
        if end < slower_runs.len() && slower_runs[end].0.start_time - slower_runs[end - 1].0.end_time <= 2000.0 * rate {
            continue;
        }
        let phrase = &slower_runs[start..end];
        let mut columns: Vec<i32> = Vec::new();
        for (_, c) in phrase {
            if !columns.contains(c) {
                columns.push(*c);
            }
        }
        let phrase_start = phrase[0].0.start_time;
        let phrase_end = phrase[phrase.len() - 1].0.end_time;
        if columns.len() >= 2
            && wall_sections
                .iter()
                .any(|w| w.start_time <= phrase_end + 2000.0 * rate && w.end_time >= phrase_start - 2000.0 * rate)
        {
            for (section, _) in phrase {
                scan.intervals.push(section.clone());
            }
        }
        start = end;
    }
}

fn count_fast_finger_returns(scan: &VibroScan, gap_ms: f64) -> Vec<f64> {
    let mut last_times = [f64::NEG_INFINITY; 4];
    let mut repeated = Vec::with_capacity(scan.times.len());
    for i in 0..scan.times.len() {
        let mut fast = 0f64;
        for column in 0..4 {
            if scan.rows[i] & (1 << column) == 0 {
                continue;
            }
            if scan.times[i] - last_times[column] <= gap_ms * scan.rate {
                fast += 1.0;
            }
            last_times[column] = scan.times[i];
        }
        repeated.push(fast);
    }
    repeated
}

fn scan_fast_rolls(scan: &mut VibroScan, repeated_fingers: &[f64]) {
    let n = scan.times.len();
    let rate = scan.rate;
    let mut roll_start = 1usize;
    let mut roll_bursts: Vec<VibroSection> = Vec::new();
    let mut roll_burst_notes = 0f64;
    for i in 1..=n {
        if i < n && (scan.rows[i] & scan.rows[i - 1]) == 0 && scan.times[i] - scan.times[i - 1] <= 25.0 * rate {
            continue;
        }
        if i >= roll_start && i - roll_start >= 8 {
            let mut fast = 0f64;
            for &v in &repeated_fingers[roll_start..i] {
                fast += v;
            }
            let notes = scan.prefix_notes[i] - scan.prefix_notes[roll_start];
            let mut last_times = [f64::NEG_INFINITY; 4];
            let mut contextual_fast = 0f64;
            for row in (roll_start - 1)..i {
                for column in 0..4 {
                    if scan.rows[row] & (1 << column) == 0 {
                        continue;
                    }
                    if scan.times[row] - last_times[column] <= RECURRING_REPETITION_GAP_MS * rate {
                        contextual_fast += 1.0;
                    }
                    last_times[column] = scan.times[row];
                }
            }
            if contextual_fast / notes >= 0.25 {
                scan.repetition_bursts.push(VibroSection {
                    start_time: scan.times[roll_start - 1],
                    end_time: scan.times[i - 1],
                    reasons: vec![VibroReason::FastRoll],
                });
            }
            if fast / notes >= 0.25 {
                let section = VibroSection {
                    start_time: scan.times[roll_start - 1],
                    end_time: scan.times[i - 1],
                    reasons: vec![VibroReason::FastRoll],
                };
                if i - roll_start >= 24 {
                    scan.intervals.push(section.clone());
                }
                roll_bursts.push(section);
                roll_burst_notes += notes;
            }
        }
        roll_start = i + 1;
    }
    if roll_bursts.len() >= 4 && roll_burst_notes / scan.total_notes() >= 0.2 {
        scan.intervals.extend(roll_bursts);
    }
}

fn collect_alternating_chords(scan: &mut VibroScan) {
    let n = scan.times.len();
    let rate = scan.rate;
    let mut start = 0usize;
    for i in 1..=n {
        if i < n
            && bit_count(scan.rows[i]) == 2
            && bit_count(scan.rows[i - 1]) == 2
            && (scan.rows[i] & scan.rows[i - 1]) == 0
            && scan.times[i] - scan.times[i - 1] <= 50.0 * rate
            && (i == start + 1
                || (scan.rows[i] == scan.rows[i - 2]
                    && scan.times[i] - scan.times[i - 2] <= RECURRING_REPETITION_GAP_MS * rate))
        {
            continue;
        }
        if i - start >= 8 {
            scan.repetition_bursts.push(VibroSection {
                start_time: scan.times[start],
                end_time: scan.times[i - 1],
                reasons: vec![VibroReason::RepeatedChord],
            });
        }
        start = i;
    }
}

fn scan_recurring_repetitions(scan: &mut VibroScan) {
    collect_alternating_chords(scan);
    let bursts = merge_sections(&scan.repetition_bursts, false);
    if bursts.len() < 3 {
        return;
    }
    let mut indices: FxHashMap<u64, usize> = FxHashMap::default();
    for (index, &time) in scan.times.iter().enumerate() {
        indices.insert(crate::js::key(time), index);
    }
    let idx = |t: f64| -> f64 { indices.get(&crate::js::key(t)).map(|&i| i as f64).unwrap_or(f64::NAN) };
    let mut prefix_duration = vec![0f64];
    let mut prefix_rows = vec![0f64];
    let mut prefix_jacks = vec![0f64];
    for (i, burst) in bursts.iter().enumerate() {
        prefix_duration.push(prefix_duration[prefix_duration.len() - 1] + burst.end_time - burst.start_time);
        let shared_row = i > 0 && bursts[i - 1].end_time == burst.start_time;
        prefix_rows.push(
            prefix_rows[prefix_rows.len() - 1] + idx(burst.end_time) - idx(burst.start_time) + if shared_row { 0.0 } else { 1.0 },
        );
        prefix_jacks.push(
            prefix_jacks[prefix_jacks.len() - 1]
                + if burst.reasons.iter().any(|r| *r != VibroReason::FastRoll) { 1.0 } else { 0.0 },
        );
    }
    let rate = scan.rate;
    let mut included = vec![0i32; bursts.len() + 1];
    let mut phrase_start = 0usize;
    for end in 0..bursts.len() {
        if end > 0 && bursts[end].start_time - bursts[end - 1].end_time > 1000.0 * rate {
            phrase_start = end;
        }
        let mut start = end as isize - 2;
        while start >= phrase_start as isize {
            let s = start as usize;
            let span = bursts[end].end_time - bursts[s].start_time;
            if span > 6400.0 * rate {
                break;
            }
            let duration = prefix_duration[end + 1] - prefix_duration[s];
            let shared_first_row = s > 0 && bursts[s - 1].end_time == bursts[s].start_time;
            let rows = prefix_rows[end + 1] - prefix_rows[s] + if shared_first_row { 1.0 } else { 0.0 };
            let jacks = prefix_jacks[end + 1] - prefix_jacks[s];
            if jacks >= 2.0 && rows >= 24.0 && duration / span >= 0.7 {
                included[s] += 1;
                included[end + 1] -= 1;
            }
            start -= 1;
        }
    }
    let mut support = 0i32;
    for i in 0..bursts.len() {
        support += included[i];
        if support > 0 {
            scan.intervals.push(bursts[i].clone());
        }
    }
}

fn scan_extreme_density(scan: &mut VibroScan) {
    let n = scan.times.len();
    let mut window_start = 0usize;
    for i in 0..n {
        while scan.times[i] - scan.times[window_start] > 1000.0 * scan.rate {
            window_start += 1;
        }
        if i - window_start + 1 >= 65 {
            let (a, b) = (scan.times[window_start], scan.times[i]);
            add_section(scan, a, b, VibroReason::ExtremeDensity);
        }
    }
}

const SUSTAINED_WINDOW_MS: f64 = 10_000.0;
const SUSTAINED_FINGER_RATE: f64 = 12.2;

fn scan_sustained_density(scan: &mut VibroScan) {
    let n = scan.times.len();
    let min_notes = SUSTAINED_FINGER_RATE * 4.0 * SUSTAINED_WINDOW_MS / 1000.0;
    let mut window_start = 0usize;
    for i in 0..n {
        while (scan.times[i] - scan.times[window_start]) / scan.rate > SUSTAINED_WINDOW_MS + 1e-6 {
            window_start += 1;
        }
        if scan.prefix_notes[i + 1] - scan.prefix_notes[window_start] >= min_notes {
            let (a, b) = (scan.times[window_start], scan.times[i]);
            add_section(scan, a, b, VibroReason::SustainedDensity);
        }
    }
}

fn merge_sections(intervals: &[VibroSection], merge_touching: bool) -> Vec<VibroSection> {
    let mut order: Vec<&VibroSection> = intervals.iter().collect();
    order.sort_by(|a, b| cmp_num(a.start_time, b.start_time));
    let mut sections: Vec<VibroSection> = Vec::new();
    for section in order {
        if let Some(previous) = sections.last_mut() {
            if section.start_time < previous.end_time || (merge_touching && section.start_time == previous.end_time) {
                previous.end_time = jsmath::max(previous.end_time, section.end_time);
                for r in &section.reasons {
                    if !previous.reasons.contains(r) {
                        previous.reasons.push(*r);
                    }
                }
                continue;
            }
        }
        sections.push(section.clone());
    }
    sections
}

fn measure_active_duration(scan: &VibroScan) -> f64 {
    let mut duration = 0f64;
    for i in 1..scan.times.len() {
        duration += jsmath::min(scan.times[i] - scan.times[i - 1], 1000.0 * scan.rate) / scan.rate;
    }
    duration
}

const REPEAT_RUN_GAP_MS: f64 = 95.0;
const REPEAT_RUN_MIN_HITS: usize = 4;
const REPEAT_BODY_SHARE: f64 = 0.25;
const REPEAT_BODY_NOTE_CAP: f64 = 0.13;
const CHORD_RUN_GAP_MS: f64 = 95.0;
const CHORD_RUN_MIN_REPEATS: usize = 4;
const CHORD_RUN_BODY_SHARE: f64 = 0.3;

fn measure_section_coverage(result: &mut VibroAnalysis, map: &ManiaBeatmap, scan: &VibroScan) {
    let rate = scan.rate;
    let times = &scan.times;
    let mut removed_notes = 0f64;
    let mut removed_weight = 0f64;
    for note in &map.notes {
        if !overlaps_vibro(note.time, note.end_time, &result.sections) {
            continue;
        }
        removed_notes += 1.0;
        removed_weight += if note.is_hold { 2.0 } else { 1.0 };
    }
    result.remaining_notes -= removed_notes;
    result.note_share = removed_notes / map.notes.len() as f64;
    let read_rate = if scan.rate > 1.0 { 1.0 } else { scan.rate };
    result.repeat_share = measure_repeat_share(scan, read_rate);
    result.judgement_share = removed_weight / (removed_weight + result.remaining_notes);
    let mut section_index = 0usize;
    for i in 1..times.len() {
        while section_index < result.sections.len() && result.sections[section_index].end_time < times[i - 1] {
            section_index += 1;
        }
        let mut j = section_index;
        while j < result.sections.len() && result.sections[j].start_time < times[i] {
            let section = &result.sections[j];
            let overlap = jsmath::min(times[i], section.end_time) - jsmath::max(times[i - 1], section.start_time);
            if overlap > 0.0 {
                result.excluded_duration_ms += jsmath::min(overlap, 1000.0 * rate) / rate;
            }
            j += 1;
        }
    }
    result.time_share =
        if result.active_duration_ms > 0.0 { result.excluded_duration_ms / result.active_duration_ms } else { 1.0 };
    let note_cap = if result.repeat_share >= REPEAT_BODY_SHARE { REPEAT_BODY_NOTE_CAP } else { 0.25 };
    let hammered = measure_chord_run_share(scan, read_rate) >= CHORD_RUN_BODY_SHARE;
    let sustained = result.reason_share(VibroReason::SustainedDensity).map_or(false, crate::js::truthy);
    result.status = if !sustained
        && !hammered
        && result.time_share <= 0.15
        && result.note_share <= note_cap
        && result.remaining_notes >= 300.0
        && result.active_duration_ms - result.excluded_duration_ms >= 20_000.0
    {
        VibroStatus::Adjusted
    } else {
        VibroStatus::Excluded
    };
}

fn measure_repeat_share(scan: &VibroScan, rate: f64) -> f64 {
    let total = scan.total_notes();
    if total == 0.0 {
        return 0.0;
    }
    let mut covered = vec![0u8; scan.rows.len()];
    for column in 0..4 {
        let indices = column_indices(&scan.rows, column);
        let mut start = 0usize;
        for i in 1..=indices.len() {
            if i < indices.len()
                && indices[i] == indices[i - 1] + 1
                && scan.times[indices[i]] - scan.times[indices[i - 1]] <= REPEAT_RUN_GAP_MS * rate
            {
                continue;
            }
            if i - start >= REPEAT_RUN_MIN_HITS {
                for k in start..i {
                    covered[indices[k]] = 1;
                }
            }
            start = i;
        }
    }
    let mut notes = 0f64;
    for i in 0..scan.rows.len() {
        if covered[i] != 0 {
            notes += bit_count(scan.rows[i]) as f64;
        }
    }
    notes / total
}

fn measure_chord_run_share(scan: &VibroScan, rate: f64) -> f64 {
    let total = scan.total_notes();
    if total == 0.0 {
        return 0.0;
    }
    let n = scan.rows.len();
    let mut notes = 0f64;
    let mut start = 0usize;
    for i in 1..=n {
        if i < n
            && scan.rows[i] == scan.rows[i - 1]
            && bit_count(scan.rows[i]) >= 2
            && scan.times[i] - scan.times[i - 1] <= CHORD_RUN_GAP_MS * rate
        {
            continue;
        }
        if i - start >= CHORD_RUN_MIN_REPEATS && bit_count(scan.rows[start]) >= 2 {
            notes += scan.prefix_notes[i] - scan.prefix_notes[start];
        }
        start = i;
    }
    notes / total
}

fn overlaps_vibro(start: f64, end: f64, sections: &[VibroSection]) -> bool {
    let mut low = 0usize;
    let mut high = sections.len();
    while low < high {
        let mid = (low + high) >> 1;
        if sections[mid].end_time < start {
            low = mid + 1;
        } else {
            high = mid;
        }
    }
    low < sections.len() && sections[low].start_time <= end
}

pub fn remove_vibro_sections(osu_text: &str, sections: &[VibroSection]) -> String {
    let mut hit_objects = false;
    let mut out: Vec<&str> = Vec::new();
    for line in osu_text.split('\n') {
        let trimmed = trim(line);
        if trimmed.starts_with('[') {
            hit_objects = trimmed == "[HitObjects]";
        }
        if !hit_objects || !trimmed.contains(',') {
            out.push(line);
            continue;
        }
        let parts: Vec<&str> = trimmed.split(',').collect();
        let start = number_opt(parts.get(2).copied());
        let end = if to_int32(number_opt(parts.get(3).copied())) & 128 != 0 {
            match parts.get(5) {
                Some(p) => number(p.split(':').next().unwrap_or("")),
                None => f64::NAN,
            }
        } else {
            start
        };
        if !overlaps_vibro(start, end, sections) {
            out.push(line);
        }
    }
    out.join("\n")
}

pub fn prepare_vibro_chart(osu_text: &str, rate: f64, map: &ManiaBeatmap) -> (VibroAnalysis, Option<String>) {
    let analysis = analyze_vibro_sections(map, rate);
    let text = if analysis.status == VibroStatus::Adjusted {
        Some(remove_vibro_sections(osu_text, &analysis.sections))
    } else {
        None
    };
    (analysis, text)
}

pub fn conservative_vibro_accuracy(accuracy: f64, removed_share: f64) -> f64 {
    if !accuracy.is_finite() || !removed_share.is_finite() || removed_share >= 1.0 {
        return 0.0;
    }
    jsmath::max(0.0, jsmath::min(1.0, 1.0 - (1.0 - accuracy) / (1.0 - jsmath::max(0.0, removed_share))))
}

pub fn prepare_vibro_chart_text(osu_text: &str, rate: f64) -> (VibroAnalysis, Option<String>) {
    let map = chart_parser::parse_mania_beatmap(osu_text);
    prepare_vibro_chart(osu_text, rate, &map)
}
