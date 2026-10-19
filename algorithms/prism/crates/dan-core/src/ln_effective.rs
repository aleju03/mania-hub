use crate::beatmap::ManiaNote;
use crate::js::{cmp_num, num_to_string, number, to_int32, trim, NumMap};
use crate::ln::ln_primary_min_ratio_for;
use crate::vibro_detection::detect_ln_vibro_notes;

pub type EffectiveLnNote = ManiaNote;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct EffectiveLnOptions {
    pub rate: Option<f64>,
    pub od: Option<f64>,
    pub key_count: Option<f64>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct EffectiveLnAnalysis {
    pub notes: f64,
    pub holds: f64,
    pub effective_holds: f64,
    pub hold_ratio: f64,
    pub effective_hold_ratio: f64,
    pub effective_ln_ratio: f64,
    pub short_tails: f64,
    pub short_spanning: f64,
    pub long_tails: f64,
    pub chained_short_holds: f64,
    pub identity_work_share: f64,
    pub tracked_share: f64,
    pub tap_covered: bool,
    pub held_peak_pinned: f64,
    pub held_peak_under_hold: f64,
    pub held_peak_light: bool,
    pub ln_vibro: bool,
}

const RELEASE_WINDOW_MULTIPLIER: f64 = 1.5;
const GREAT_WINDOW_BASE_MS: f64 = 64.0;
const OD_WINDOW_STEP_MS: f64 = 3.0;
const ASSUMED_OD: f64 = 8.0;
pub const LN_IDENTITY_MIN_OD: f64 = 5.0;
pub const LN_MIN_WORK_SHARE: f64 = 0.1;
pub const LN_SAME_MOTION_TOLERANCE_MS: f64 = 20.0;
const WINDOW_MS: f64 = 10_000.0;
const WINDOW_MIN_NOTES: f64 = 8.0;
pub const LN_EFFECTIVE_KEY_COUNTS: [i32; 1] = [4];
pub const LN_EFFECTIVE_MODEL_VERSION: f64 = 15.0;
pub const LN_EFFECTIVE_MIN_RATIO: f64 = 0.4;
pub const LN_CHAINED_MIN_RATIO: f64 = 0.6;
const TAP_MEDIAN_BASE_MS: f64 = 36.0;
const TAP_MEDIAN_PER_GAP: f64 = 0.213;
const TAP_MEDIAN_MAX_MS: f64 = 80.0;
const TAP_LOG_SPREAD: f64 = 0.29;
pub const LN_TRACKED_MIN_SHARE: f64 = 0.1;
pub const LN_TAP_GATE_CHAIN_EXEMPT_SHARE: f64 = 0.1;
pub const LN_TAP_GATE_CHAIN_EXEMPT_LONG_SHARE: f64 = 0.15;
pub const LN_HELD_PEAK_QUANTILE: f64 = 0.9;
pub const LN_HELD_PEAK_MIN_PINNED_SHARE: f64 = 0.15;
pub const LN_HELD_PEAK_MIN_UNDER_HOLD_SHARE: f64 = 0.08;

pub fn uses_effective_ln(key_count: Option<f64>) -> bool {
    key_count == Some(4.0)
}

pub fn chart_is_ln(key_count: Option<f64>, ln_ratio: Option<f64>, ln_effective_ratio: Option<f64>) -> Option<bool> {
    let share = chart_ln_share_for(key_count, ln_ratio, ln_effective_ratio)?;
    let on_effective = key_count.is_some()
        && uses_effective_ln(key_count)
        && ln_effective_ratio.map_or(false, |v| v.is_finite());
    if !on_effective {
        return Some(share >= ln_primary_min_ratio_for(key_count));
    }
    let hold_share = ln_ratio.unwrap_or(f64::NAN);
    if !hold_share.is_finite() {
        return None;
    }
    Some(
        jsmath::max(0.0, jsmath::min(1.0, hold_share)) >= ln_primary_min_ratio_for(key_count)
            && share >= LN_EFFECTIVE_MIN_RATIO,
    )
}

pub fn release_great_window_ms(od: Option<f64>) -> f64 {
    let clamped = match od {
        Some(v) if v.is_finite() => jsmath::max(0.0, jsmath::min(10.0, v)),
        _ => ASSUMED_OD,
    };
    RELEASE_WINDOW_MULTIPLIER * (GREAT_WINDOW_BASE_MS - OD_WINDOW_STEP_MS * clamped)
}

pub fn chart_ln_share_for(key_count: Option<f64>, ln_ratio: Option<f64>, ln_effective_ratio: Option<f64>) -> Option<f64> {
    let effective = ln_effective_ratio.unwrap_or(f64::NAN);
    if key_count.is_some() && uses_effective_ln(key_count) && effective.is_finite() {
        return Some(jsmath::max(0.0, jsmath::min(1.0, effective)));
    }
    let raw = ln_ratio.unwrap_or(f64::NAN);
    if raw.is_finite() {
        Some(jsmath::max(0.0, jsmath::min(1.0, raw)))
    } else {
        None
    }
}

fn lower_bound(sorted: &[f64], value: f64) -> usize {
    let mut lo = 0usize;
    let mut hi = sorted.len();
    while lo < hi {
        let mid = (lo + hi) >> 1;
        if sorted[mid] < value {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    lo
}

fn played_rate(rate: Option<f64>) -> f64 {
    match rate {
        Some(r) if r.is_finite() && r > 0.0 => r,
        _ => 1.0,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum HoldKind {
    Short,
    ShortSpanning,
    Long,
    Chained,
}

#[derive(Clone, Copy, Debug)]
struct HoldVerdict {
    kind: HoldKind,
    effective: bool,
    in_chain: bool,
}

pub fn is_ln_vibro_chart(notes: &[EffectiveLnNote], options: &EffectiveLnOptions) -> bool {
    detect_ln_vibro_notes(notes, played_rate(options.rate))
}

struct SortedChart<'a> {
    notes: &'a [EffectiveLnNote],
    order: Vec<usize>,
    lanes: Vec<Vec<usize>>,
}

fn sort_chart(notes: &[EffectiveLnNote]) -> SortedChart<'_> {
    let mut order: Vec<usize> = (0..notes.len()).collect();
    order.sort_by(|&a, &b| cmp_num(notes[a].time, notes[b].time));
    let mut lane_index: crate::js::FxHashMap<i32, usize> = crate::js::FxHashMap::default();
    let mut lanes: Vec<Vec<usize>> = Vec::new();
    for &index in &order {
        let col = notes[index].column;
        match lane_index.get(&col) {
            Some(&l) => lanes[l].push(index),
            None => {
                lane_index.insert(col, lanes.len());
                lanes.push(vec![index]);
            }
        }
    }
    SortedChart { notes, order, lanes }
}

fn judge_holds(chart: &SortedChart, rate: f64, window_ms: f64, ln_vibro: bool) -> Vec<Option<HoldVerdict>> {
    let notes = chart.notes;
    let tolerance = LN_SAME_MOTION_TOLERANCE_MS;
    let mut chained = vec![false; notes.len()];
    if !ln_vibro {
        for lane in &chart.lanes {
            let mut run: Vec<usize> = Vec::new();
            let flush = |run: &mut Vec<usize>, chained: &mut Vec<bool>| {
                if run.len() >= 2 {
                    for &index in run.iter() {
                        chained[index] = true;
                    }
                }
                run.clear();
            };
            let mut i = 0usize;
            while i + 1 < lane.len() {
                let note = &notes[lane[i]];
                let next = &notes[lane[i + 1]];
                let duration = (note.end_time - note.time) / rate;
                let gap = (next.time - note.end_time) / rate;
                if note.is_hold
                    && next.is_hold
                    && next.end_time > next.time
                    && duration >= window_ms - tolerance
                    && duration > 0.0
                    && gap >= 0.0
                    && gap <= window_ms
                {
                    run.push(lane[i]);
                } else {
                    flush(&mut run, &mut chained);
                }
                i += 1;
            }
            flush(&mut run, &mut chained);
        }
    }
    let head_times: Vec<f64> = chart.order.iter().map(|&i| notes[i].time / rate).collect();
    let verdict = |kind: HoldKind, in_chain: bool| HoldVerdict {
        kind,
        effective: kind == HoldKind::Long || kind == HoldKind::Chained,
        in_chain,
    };
    notes
        .iter()
        .enumerate()
        .map(|(index, note)| {
            if !note.is_hold || !(note.end_time > note.time) {
                return None;
            }
            let start = note.time / rate;
            let end = note.end_time / rate;
            let in_chain = chained[index];
            if end - start > window_ms {
                return Some(verdict(HoldKind::Long, in_chain));
            }
            if in_chain {
                return Some(verdict(HoldKind::Chained, in_chain));
            }
            let mut i = lower_bound(&head_times, start + tolerance);
            while i < head_times.len() && head_times[i] < end - tolerance {
                if notes[chart.order[i]].column != note.column {
                    return Some(verdict(HoldKind::ShortSpanning, in_chain));
                }
                i += 1;
            }
            Some(verdict(HoldKind::Short, in_chain))
        })
        .collect()
}

fn erf(x: f64) -> f64 {
    let t = 1.0 / (1.0 + 0.3275911 * x.abs());
    let y = 1.0
        - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592)
            * t
            * jsmath::exp(-x * x);
    if x >= 0.0 {
        y
    } else {
        -y
    }
}

fn tap_shortfall_chance(body_ms: f64, gap_ms: f64, window_ms: f64) -> f64 {
    let needed = body_ms - window_ms;
    if !(needed > 0.0) {
        return 0.0;
    }
    let median = jsmath::min(TAP_MEDIAN_MAX_MS, TAP_MEDIAN_BASE_MS + TAP_MEDIAN_PER_GAP * gap_ms);
    let chance = 0.5 * (1.0 + erf(jsmath::log(needed / median) / (TAP_LOG_SPREAD * std::f64::consts::SQRT_2)));
    if chance > 0.999 {
        1.0
    } else if chance < 0.001 {
        0.0
    } else {
        chance
    }
}

fn tap_chances(chart: &SortedChart, rate: f64, window_ms: f64) -> Vec<f64> {
    let notes = chart.notes;
    let mut chances = vec![0f64; notes.len()];
    for lane in &chart.lanes {
        for (at, &index) in lane.iter().enumerate() {
            let note = &notes[index];
            if !note.is_hold || !(note.end_time > note.time) {
                continue;
            }
            let next_head = if at + 1 < lane.len() { notes[lane[at + 1]].time } else { f64::INFINITY };
            chances[index] =
                tap_shortfall_chance((note.end_time - note.time) / rate, (next_head - note.time) / rate, window_ms);
        }
    }
    chances
}

pub fn tap_shortfall_chances(notes: &[EffectiveLnNote], options: &EffectiveLnOptions, window_ms: Option<f64>) -> Vec<f64> {
    let chart = sort_chart(notes);
    tap_chances(&chart, played_rate(options.rate), window_ms.unwrap_or_else(|| release_great_window_ms(options.od)))
}

#[derive(Default, Clone, Copy)]
struct PeakSlot {
    notes: f64,
    under: f64,
    pinned_ms: f64,
}

fn held_peak(chart: &SortedChart, rate: f64, window_ms: f64) -> (f64, f64) {
    let notes = chart.notes;
    let pins: Vec<(i32, Vec<(f64, f64)>)> = chart
        .lanes
        .iter()
        .map(|lane| {
            let mut spans = Vec::new();
            for &index in lane {
                let note = &notes[index];
                if !note.is_hold {
                    continue;
                }
                let start = note.time / rate + TAP_MEDIAN_MAX_MS;
                let end = note.end_time / rate - window_ms;
                if end > start {
                    spans.push((start, end));
                }
            }
            (notes[lane[0]].column, spans)
        })
        .collect();
    let pinned_at = |spans: &[(f64, f64)], time: f64| -> bool {
        let mut lo: isize = 0;
        let mut hi: isize = spans.len() as isize - 1;
        let mut at: isize = -1;
        while lo <= hi {
            let mid = (lo + hi) >> 1;
            if spans[mid as usize].0 <= time {
                at = mid;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }
        at >= 0 && time < spans[at as usize].1
    };
    let mut first = f64::INFINITY;
    let mut last = f64::NEG_INFINITY;
    for note in notes {
        first = jsmath::min(first, note.time / rate);
        last = jsmath::max(
            last,
            (if note.is_hold && note.end_time > note.time { note.end_time } else { note.time }) / rate,
        );
    }
    let mut slots: NumMap<PeakSlot> = NumMap::new();
    for note in notes {
        let key = ((note.time / rate - first) / WINDOW_MS).floor();
        let t = note.time / rate;
        let under = pins.iter().any(|(column, spans)| *column != note.column && pinned_at(spans, t));
        let window = slots.entry_or_insert_with(key, PeakSlot::default);
        window.notes += 1.0;
        if under {
            window.under += 1.0;
        }
    }
    let mut merged: Vec<(f64, f64)> = pins.iter().flat_map(|(_, spans)| spans.iter().copied()).collect();
    merged.sort_by(|a, b| cmp_num(a.0, b.0));
    let mut run_start = f64::NEG_INFINITY;
    let mut run_end = f64::NEG_INFINITY;
    let add_pinned = |slots: &mut NumMap<PeakSlot>, start: f64, end: f64| {
        let mut key = ((start - first) / WINDOW_MS).floor();
        while first + key * WINDOW_MS < end {
            let from = jsmath::max(start, first + key * WINDOW_MS);
            let to = jsmath::min(end, first + (key + 1.0) * WINDOW_MS);
            if to > from {
                slots.entry_or_insert_with(key, PeakSlot::default).pinned_ms += to - from;
            }
            key += 1.0;
        }
    };
    for &(start, end) in &merged {
        if start > run_end {
            if run_end > run_start {
                add_pinned(&mut slots, run_start, run_end);
            }
            run_start = start;
            run_end = end;
        } else {
            run_end = jsmath::max(run_end, end);
        }
    }
    if run_end > run_start {
        add_pinned(&mut slots, run_start, run_end);
    }
    let mut pinned_values: Vec<f64> = Vec::new();
    let mut under_values: Vec<f64> = Vec::new();
    for &(key, window) in &slots.entries {
        if window.notes < WINDOW_MIN_NOTES {
            continue;
        }
        pinned_values.push(window.pinned_ms / jsmath::max(1.0, jsmath::min(WINDOW_MS, last - (first + key * WINDOW_MS))));
        under_values.push(window.under / window.notes);
    }
    let quantile = |values: &mut Vec<f64>| -> f64 {
        if values.is_empty() {
            return 0.0;
        }
        values.sort_by(|a, b| cmp_num(*a, *b));
        values[((values.len() as f64 - 1.0) * LN_HELD_PEAK_QUANTILE).floor() as usize]
    };
    (quantile(&mut pinned_values), quantile(&mut under_values))
}

fn weighted_median(entries: &[(f64, f64)]) -> Option<f64> {
    let mut sorted = entries.to_vec();
    sorted.sort_by(|a, b| cmp_num(a.0, b.0));
    let mut total = 0f64;
    for e in &sorted {
        total += e.1;
    }
    if !(total > 0.0) {
        return None;
    }
    let mut cumulative = 0f64;
    for e in &sorted {
        cumulative += e.1;
        if cumulative * 2.0 >= total {
            return Some(e.0);
        }
    }
    None
}

#[derive(Default, Clone, Copy)]
struct IdentityWindow {
    notes: f64,
    long: f64,
    chained: f64,
    in_chain: f64,
    tracked: f64,
}

fn identity_share(window: &IdentityWindow, tap_covered: bool) -> f64 {
    if !(window.notes > 0.0) {
        return 0.0;
    }
    let scale = LN_EFFECTIVE_MIN_RATIO / LN_CHAINED_MIN_RATIO;
    if tap_covered {
        return (window.in_chain / window.notes) * scale;
    }
    jsmath::max(window.long / window.notes, ((window.long + window.chained) / window.notes) * scale)
}

fn analyze_sorted(
    chart: &SortedChart,
    options: &EffectiveLnOptions,
    played: &[Option<HoldVerdict>],
    ln_vibro: bool,
) -> EffectiveLnAnalysis {
    let notes = chart.notes;
    let rate = played_rate(options.rate);
    let total = notes.len() as f64;
    let (mut short, mut short_spanning, mut long, mut chained) = (0f64, 0f64, 0f64, 0f64);
    for v in played.iter().flatten() {
        match v.kind {
            HoldKind::Short => short += 1.0,
            HoldKind::ShortSpanning => short_spanning += 1.0,
            HoldKind::Long => long += 1.0,
            HoldKind::Chained => chained += 1.0,
        }
    }
    let holds = short + short_spanning + long + chained;
    let effective_holds = long + chained;

    let played_od = match options.od {
        Some(v) if v.is_finite() => Some(v),
        _ => None,
    };
    let identity_od = match played_od {
        Some(p) if p < LN_IDENTITY_MIN_OD => Some(LN_IDENTITY_MIN_OD),
        _ => options.od,
    };
    let identity_window = release_great_window_ms(identity_od);
    let replaced = matches!(played_od, Some(p) if p < LN_IDENTITY_MIN_OD);
    let rejudged;
    let identity: &[Option<HoldVerdict>] = if !replaced {
        played
    } else {
        rejudged = judge_holds(chart, rate, identity_window, ln_vibro);
        &rejudged
    };
    let tracked = tap_chances(chart, rate, identity_window);

    let mut whole = IdentityWindow { notes: total, ..Default::default() };
    let mut slots: NumMap<IdentityWindow> = NumMap::new();
    let mut first_time = f64::INFINITY;
    for note in notes {
        first_time = jsmath::min(first_time, note.time / rate);
    }
    for (index, note) in notes.iter().enumerate() {
        let slot = ((note.time / rate - first_time) / WINDOW_MS).floor();
        let window = slots.entry_or_insert_with(slot, IdentityWindow::default);
        let verdict = identity[index];
        window.notes += 1.0;
        window.tracked += tracked[index];
        whole.tracked += tracked[index];
        if verdict.map_or(false, |v| v.in_chain) {
            window.in_chain += 1.0;
            whole.in_chain += 1.0;
        }
        match verdict.map(|v| v.kind) {
            Some(HoldKind::Long) => {
                window.long += 1.0;
                whole.long += 1.0;
            }
            Some(HoldKind::Chained) => {
                window.chained += 1.0;
                whole.chained += 1.0;
            }
            _ => {}
        }
    }
    let windows: Vec<IdentityWindow> = slots.values().filter(|w| w.notes >= WINDOW_MIN_NOTES).copied().collect();
    let by_notes = weighted_median(&windows.iter().map(|w| (w.tracked / w.notes, w.notes)).collect::<Vec<_>>());
    let by_time = weighted_median(&windows.iter().map(|w| (w.tracked / w.notes, 1.0)).collect::<Vec<_>>());
    let tracked_share = match (by_notes, by_time) {
        (Some(a), Some(b)) => jsmath::max(a, b),
        _ => {
            if total > 0.0 {
                whole.tracked / total
            } else {
                0.0
            }
        }
    };
    let chain_exempt =
        whole.chained / total >= LN_TAP_GATE_CHAIN_EXEMPT_SHARE && whole.long / total >= LN_TAP_GATE_CHAIN_EXEMPT_LONG_SHARE;
    let tap_covered = total > 0.0 && tracked_share < LN_TRACKED_MIN_SHARE && !chain_exempt;
    let effective_ln_ratio = weighted_median(
        &windows.iter().map(|w| (identity_share(w, tap_covered), w.notes)).collect::<Vec<_>>(),
    )
    .unwrap_or_else(|| identity_share(&whole, tap_covered));
    let (pinned, under_hold) = held_peak(chart, rate, identity_window);
    let mut held_peak_light = pinned < LN_HELD_PEAK_MIN_PINNED_SHARE && under_hold < LN_HELD_PEAK_MIN_UNDER_HOLD_SHARE;
    if held_peak_light && total > 0.0 {
        let written_owned;
        let written: &[Option<HoldVerdict>] = if rate == 1.0 {
            identity
        } else {
            let vibro_at_one = is_ln_vibro_chart(notes, &EffectiveLnOptions { rate: Some(1.0), ..*options });
            written_owned = judge_holds(chart, 1.0, identity_window, vibro_at_one);
            &written_owned
        };
        let written_chained = written.iter().filter(|v| v.map_or(false, |v| v.kind == HoldKind::Chained)).count() as f64;
        if written_chained / total >= LN_TAP_GATE_CHAIN_EXEMPT_SHARE {
            held_peak_light = false;
        }
    }

    EffectiveLnAnalysis {
        notes: total,
        holds,
        effective_holds,
        hold_ratio: if total > 0.0 { holds / total } else { 0.0 },
        effective_hold_ratio: if total > 0.0 { effective_holds / total } else { 0.0 },
        effective_ln_ratio,
        short_tails: short,
        short_spanning,
        long_tails: long,
        chained_short_holds: chained,
        identity_work_share: if holds > 0.0 { (whole.long + whole.chained) / holds } else { 0.0 },
        tracked_share,
        tap_covered,
        held_peak_pinned: pinned,
        held_peak_under_hold: under_hold,
        held_peak_light,
        ln_vibro,
    }
}

pub fn analyze_effective_ln(notes: &[EffectiveLnNote], options: &EffectiveLnOptions) -> EffectiveLnAnalysis {
    read_effective_holds(notes, options, false).analysis
}

#[derive(Clone, Debug, PartialEq)]
pub struct EffectiveHolds {
    pub analysis: EffectiveLnAnalysis,
    pub mask: Vec<bool>,
    pub weights: Vec<f64>,
}

pub fn read_effective_holds(notes: &[EffectiveLnNote], options: &EffectiveLnOptions, want_weights: bool) -> EffectiveHolds {
    let chart = sort_chart(notes);
    let rate = played_rate(options.rate);
    let window = release_great_window_ms(options.od);
    let ln_vibro = is_ln_vibro_chart(notes, options);
    let played = judge_holds(&chart, rate, window, ln_vibro);
    let analysis = analyze_sorted(&chart, options, &played, ln_vibro);
    let mask: Vec<bool> = played.iter().map(|v| v.map_or(false, |v| v.effective)).collect();
    if !want_weights {
        return EffectiveHolds { analysis, mask, weights: Vec::new() };
    }
    let written_owned;
    let written: &[Option<HoldVerdict>] = if rate == 1.0 {
        &played
    } else {
        let vibro_at_one = is_ln_vibro_chart(notes, &EffectiveLnOptions { rate: Some(1.0), ..*options });
        written_owned = judge_holds(&chart, 1.0, window, vibro_at_one);
        &written_owned
    };
    let chances = tap_chances(&chart, rate, window);
    let weights = played
        .iter()
        .enumerate()
        .map(|(index, v)| {
            if !v.map_or(false, |v| v.effective) {
                0.0
            } else if written[index].map_or(false, |w| w.in_chain) {
                1.0
            } else {
                chances[index]
            }
        })
        .collect();
    EffectiveHolds { analysis, mask, weights }
}

pub fn effective_hold_mask(notes: &[EffectiveLnNote], options: &EffectiveLnOptions) -> Vec<bool> {
    read_effective_holds(notes, options, false).mask
}

pub fn effective_hold_weights(notes: &[EffectiveLnNote], options: &EffectiveLnOptions) -> Vec<f64> {
    read_effective_holds(notes, options, true).weights
}

pub fn ln_tail_pass_text(osu_text: &str, key_count: f64, options: &EffectiveLnOptions, min_hold_ratio: f64) -> Option<String> {
    let mut parsed = parse_hit_objects(osu_text)?;
    if !uses_effective_ln(Some(key_count)) {
        let holds = parsed.objects.iter().filter(|o| o.note.is_hold).count() as f64;
        return if holds / jsmath::max(1.0, parsed.objects.len() as f64) > min_hold_ratio {
            Some(osu_text.to_string())
        } else {
            None
        };
    }
    let notes: Vec<EffectiveLnNote> = parsed.objects.iter().map(|o| o.note).collect();
    let opts = EffectiveLnOptions { od: options.od.or(parsed.od), ..*options };
    let EffectiveHolds { analysis, mask, .. } = read_effective_holds(&notes, &opts, false);
    if analysis.hold_ratio < ln_primary_min_ratio_for(Some(key_count)) || !(analysis.effective_hold_ratio > min_hold_ratio) {
        return None;
    }
    Some(rewrite_free_holds(&mut parsed, &mask))
}

struct HitObjectLine {
    index: usize,
    x: f64,
    y: f64,
    time: f64,
    kind: f64,
    hit_sound: f64,
    extras: String,
    note: EffectiveLnNote,
}

struct ParsedHitObjects<'a> {
    lines: Vec<std::borrow::Cow<'a, str>>,
    objects: Vec<HitObjectLine>,
    od: Option<f64>,
}

fn is_line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

fn header_value<'a>(text: &'a str, name: &str) -> Option<&'a str> {
    let mut line_start = true;
    let mut iter = text.char_indices().peekable();
    while let Some((pos, ch)) = iter.next() {
        if line_start && text[pos..].starts_with(name) {
            let rest = &text[pos + name.len()..];
            let after_ws = rest.trim_start_matches(crate::js::is_js_space);
            if let Some(after_colon) = after_ws.strip_prefix(':') {
                let value_start = after_colon.trim_start_matches(crate::js::is_js_space);
                let len = value_start.bytes().take_while(|b| b.is_ascii_digit() || *b == b'.').count();
                if len > 0 {
                    return Some(&value_start[..len]);
                }
            }
        }
        line_start = is_line_terminator(ch);
    }
    None
}

fn parse_hit_objects(osu_text: &str) -> Option<ParsedHitObjects<'_>> {
    let lines: Vec<std::borrow::Cow<'_, str>> = osu_text.split('\n').map(std::borrow::Cow::Borrowed).collect();
    let cs = number(header_value(osu_text, "CircleSize").unwrap_or("4"));
    let kc = jsmath::max(1.0, jsmath::round(cs));
    let key_count = if kc.is_nan() || kc == 0.0 { 4.0 } else { kc };
    let od = header_value(osu_text, "OverallDifficulty").map(number);
    let start = lines.iter().position(|line| trim(line) == "[HitObjects]")?;
    let mut objects = Vec::new();
    for index in (start + 1)..lines.len() {
        let raw = trim(&lines[index]);
        if raw.starts_with('[') {
            break;
        }
        if raw.is_empty() || raw.starts_with("//") {
            continue;
        }
        let parts: Vec<&str> = raw.split(',').collect();
        if parts.len() < 5 {
            continue;
        }
        let x = number(parts[0]);
        let y = number(parts[1]);
        let time = number(parts[2]);
        let kind = number(parts[3]);
        let hit_sound = number(parts[4]);
        if !x.is_finite() || !time.is_finite() || !kind.is_finite() {
            continue;
        }
        let extras = parts[5..].join(",");
        let end_time = if to_int32(kind) & 128 != 0 {
            number(extras.split(':').next().unwrap_or(""))
        } else {
            f64::NAN
        };
        let is_hold = end_time.is_finite() && end_time > time;
        let column = jsmath::max(0.0, jsmath::min(key_count - 1.0, ((x * key_count) / 512.0).floor()));
        objects.push(HitObjectLine {
            index,
            x,
            y,
            time,
            kind,
            hit_sound,
            extras,
            note: EffectiveLnNote {
                column: column as i32,
                time,
                end_time: if end_time.is_finite() { end_time } else { time },
                is_hold,
            },
        });
    }
    Some(ParsedHitObjects { lines, objects, od: od.filter(|v| v.is_finite()) })
}

fn rewrite_free_holds(parsed: &mut ParsedHitObjects, mask: &[bool]) -> String {
    for (i, object) in parsed.objects.iter().enumerate() {
        if !object.note.is_hold || mask[i] {
            continue;
        }
        let sample = match object.extras.find(':') {
            Some(p) => object.extras[p + 1..].to_string(),
            None => "0:0:0:0:".to_string(),
        };
        parsed.lines[object.index] = std::borrow::Cow::Owned(format!(
            "{},{},{},{},{},{}",
            num_to_string(object.x),
            num_to_string(object.y),
            num_to_string(object.time),
            (to_int32(object.kind) & !128) | 1,
            num_to_string(object.hit_sound),
            sample
        ));
    }
    parsed.lines.join("\n")
}

pub fn demote_free_holds(osu_text: &str, options: &EffectiveLnOptions) -> String {
    let mut parsed = match parse_hit_objects(osu_text) {
        Some(p) => p,
        None => return osu_text.to_string(),
    };
    let notes: Vec<EffectiveLnNote> = parsed.objects.iter().map(|o| o.note).collect();
    let opts = EffectiveLnOptions { od: options.od.or(parsed.od), ..*options };
    let mask = read_effective_holds(&notes, &opts, false).mask;
    rewrite_free_holds(&mut parsed, &mask)
}
