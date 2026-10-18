use crate::beatmap::{ManiaBeatmap, ManiaNote};
use crate::features::extract_dan_features;
use crate::js::{bit, num_to_string, to_fixed, NumMap, NumSet};
use crate::labels::get_input_rate;
use crate::math::{clamp01, min_gate, quantile};
use crate::types::{
    DanEstimateInput, DanFeatureExtractionResult, ManiaPatternAnalysis, ManiaPatternHit, ManiaPatternId,
};

pub const LN_SKILLSET_IDS: [ManiaPatternId; 4] =
    [ManiaPatternId::Lnhybrid, ManiaPatternId::Lntechnical, ManiaPatternId::Lnwalls, ManiaPatternId::Lnspeed];

pub type LnSkillsetsFn<'a> = &'a dyn Fn(&ManiaBeatmap, f64) -> Option<[f64; 4]>;

pub const SUPPORTED_MANIA_PATTERN_IDS: [ManiaPatternId; 22] = [
    ManiaPatternId::Jack,
    ManiaPatternId::Chordjack,
    ManiaPatternId::Speedjack,
    ManiaPatternId::Handjack,
    ManiaPatternId::Tech,
    ManiaPatternId::Stream,
    ManiaPatternId::Dumpstream,
    ManiaPatternId::Jumpstream,
    ManiaPatternId::Handstream,
    ManiaPatternId::Quadstream,
    ManiaPatternId::Delay,
    ManiaPatternId::Bracket,
    ManiaPatternId::Chordstream,
    ManiaPatternId::Ln,
    ManiaPatternId::Lnhybrid,
    ManiaPatternId::Lntechnical,
    ManiaPatternId::Lnwalls,
    ManiaPatternId::Lnspeed,
    ManiaPatternId::Lngeneral,
    ManiaPatternId::Lnrelease,
    ManiaPatternId::Lninverse,
    ManiaPatternId::Lntech,
];

fn is_ln_subtype(id: ManiaPatternId) -> bool {
    matches!(
        id,
        ManiaPatternId::Lnhybrid
            | ManiaPatternId::Lntechnical
            | ManiaPatternId::Lnwalls
            | ManiaPatternId::Lnspeed
            | ManiaPatternId::Lngeneral
            | ManiaPatternId::Lnrelease
            | ManiaPatternId::Lninverse
            | ManiaPatternId::Lntech
    )
}

struct RowPatternStats {
    row_count: f64,
    chord_rows: f64,
    two_note_rows: f64,
    three_note_rows: f64,
    four_plus_rows: f64,
    three_plus_rows: f64,
    #[allow(dead_code)]
    single_rows: f64,
    repeated_chord_rows: f64,
    bracket_window_rows: f64,
    average_chord_size: f64,
    chord_pairs: f64,
    multi_overlap_chord_pairs: f64,
    chord_runs: f64,
}

struct LnPatternStats {
    inverse_release_ratio: f64,
    same_column_release_gap_p50: f64,
    release_only_ratio: f64,
    head_tail_switch_ratio: f64,
    mixed_row_ratio: f64,
    tap_while_holding_ratio: f64,
    active_release_ratio: f64,
    coordinated_release_ratio: f64,
    held_while_release_ratio: f64,
    hold_duration_p50: f64,
    inverse_window_coverage: f64,
    held_time_share: f64,
}

const INVERSE_WINDOW_MS: f64 = 8000.0;
const INVERSE_WINDOW_MIN_PAIRS: f64 = 20.0;
const INVERSE_WINDOW_MIN_WINDOWS: f64 = 3.0;
const INVERSE_WINDOW_RATIO: f64 = 0.65;

fn row_columns(row_notes: &[ManiaNote]) -> Vec<i32> {
    let mut out: Vec<i32> = Vec::with_capacity(row_notes.len());
    for note in row_notes {
        if !out.contains(&note.column) {
            out.push(note.column);
        }
    }
    out.sort();
    out
}

fn is_roll_between(previous: &[i32], current: &[i32]) -> bool {
    if previous.is_empty() || current.is_empty() {
        return false;
    }
    previous[0] > current[current.len() - 1] || previous[previous.len() - 1] < current[0]
}

fn shared_column_count(previous: &[i32], current: &[i32]) -> usize {
    current.iter().filter(|c| previous.contains(c)).count()
}

#[inline]
fn bit_count(mask: i32) -> f64 {
    (mask as u32).count_ones() as f64
}

fn get_row_pattern_stats(ordered_rows: &[(f64, Vec<ManiaNote>)], key_count: f64) -> RowPatternStats {
    let mut chord_rows = 0f64;
    let mut two_note_rows = 0f64;
    let mut three_note_rows = 0f64;
    let mut four_plus_rows = 0f64;
    let mut three_plus_rows = 0f64;
    let mut single_rows = 0f64;
    let mut repeated_chord_rows = 0f64;
    let mut bracket_window_rows = 0f64;
    let mut total_chord_size = 0f64;
    let mut chord_pairs = 0f64;
    let mut multi_overlap_chord_pairs = 0f64;
    let mut chord_runs = 0f64;
    let mut previous_chord_mask: Option<i32> = None;
    let mut previous_row_mask: i32 = 0;
    let mut previous_row_size = 0usize;
    let mut previous_row_time = f64::NEG_INFINITY;
    let mut previous_columns: Vec<i32> = Vec::new();
    let mut before_previous_columns: Vec<i32> = Vec::new();

    for (time, row_notes) in ordered_rows {
        let time = *time;
        let columns = row_columns(row_notes);
        let size = columns.len();
        let mut mask: i32 = 0;
        for &column in &columns {
            mask |= bit(column);
        }
        if size <= 1 {
            single_rows += 1.0;
        }
        if size >= 2 {
            chord_rows += 1.0;
            total_chord_size += size as f64;
            if Some(mask) == previous_chord_mask {
                repeated_chord_rows += 1.0;
            }
            previous_chord_mask = Some(mask);
            if previous_row_size < 2 {
                chord_runs += 1.0;
            }
            if previous_row_size >= 2 && time - previous_row_time < 1000.0 {
                chord_pairs += 1.0;
                if bit_count(mask & previous_row_mask) >= 2.0 {
                    multi_overlap_chord_pairs += 1.0;
                }
            }
        } else {
            previous_chord_mask = None;
        }
        previous_row_mask = mask;
        previous_row_size = size;
        previous_row_time = time;
        if size == 2 {
            two_note_rows += 1.0;
        }
        if size == 3 {
            three_note_rows += 1.0;
        }
        if size >= 4 {
            four_plus_rows += 1.0;
        }
        if size >= 3 {
            three_plus_rows += 1.0;
        }
        if key_count >= 6.0
            && size >= 2
            && before_previous_columns.len() >= 2
            && previous_columns.len() >= 2
            && !is_roll_between(&before_previous_columns, &previous_columns)
            && !is_roll_between(&previous_columns, &columns)
            && shared_column_count(&before_previous_columns, &previous_columns) == 0
            && shared_column_count(&previous_columns, &columns) == 0
        {
            bracket_window_rows += 1.0;
        }
        before_previous_columns = std::mem::replace(&mut previous_columns, columns);
    }

    RowPatternStats {
        row_count: ordered_rows.len() as f64,
        chord_rows,
        two_note_rows,
        three_note_rows,
        four_plus_rows,
        three_plus_rows,
        single_rows,
        repeated_chord_rows,
        bracket_window_rows,
        average_chord_size: if chord_rows != 0.0 { total_chord_size / chord_rows } else { 0.0 },
        chord_pairs,
        multi_overlap_chord_pairs,
        chord_runs,
    }
}

fn get_single_jack_stats(ordered_rows: &[(f64, Vec<ManiaNote>)]) -> (f64, f64) {
    let mut masks: Vec<i32> = Vec::with_capacity(ordered_rows.len());
    let mut times: Vec<f64> = Vec::with_capacity(ordered_rows.len());
    let mut note_count = 0f64;
    let mut jack1 = 0f64;
    for (time, row_notes) in ordered_rows {
        let time = *time;
        let mut mask: i32 = 0;
        for note in row_notes {
            mask |= bit(note.column);
        }
        note_count += row_notes.len() as f64;
        if let Some(&last_mask) = masks.last() {
            if time - times[times.len() - 1] <= 400.0 {
                jack1 += bit_count(mask & last_mask);
            }
        }
        masks.push(mask);
        times.push(time);
    }
    let mut trill_notes = 0f64;
    let mut i: isize = 0;
    let len = masks.len() as isize;
    while i < len - 5 {
        let iu = i as usize;
        let a = masks[iu];
        let b = masks[iu + 1];
        if a == 0 || b == 0 || a == b || times[iu + 1] - times[iu] > 200.0 {
            i += 1;
            continue;
        }
        let mut j = iu + 2;
        while j < masks.len() && masks[j] == (if (j - iu) % 2 == 0 { a } else { b }) && times[j] - times[j - 1] <= 200.0 {
            j += 1;
        }
        if j - iu >= 6 {
            for m in iu..j {
                trill_notes += bit_count(masks[m]);
            }
            i = j as isize;
        } else {
            i += 1;
        }
    }
    (
        if note_count > 0.0 { jack1 / note_count } else { 0.0 },
        if note_count > 0.0 { trill_notes / note_count } else { 0.0 },
    )
}

fn inverse_gap_cap_ms(beat_length_ms: f64) -> f64 {
    if !beat_length_ms.is_finite() || beat_length_ms <= 0.0 {
        return 120.0;
    }
    jsmath::min(250.0, jsmath::max(120.0, beat_length_ms * 0.27))
}

fn get_ln_pattern_stats(
    notes: &[ManiaNote],
    ordered_rows: &[(f64, Vec<ManiaNote>)],
    key_count: f64,
    beat_length_ms: f64,
) -> LnPatternStats {
    let mut release_rows: NumMap<usize> = NumMap::new();
    let mut head_times = NumSet::new();
    let mut hold_events: Vec<(f64, f64)> = Vec::new();
    let mut hold_spans: Vec<ManiaNote> = Vec::new();
    let lanes = jsmath::max(1.0, key_count) as usize;
    let mut notes_by_column: Vec<Vec<ManiaNote>> = vec![Vec::new(); lanes];

    for note in notes {
        if note.column >= 0 && (note.column as usize) < notes_by_column.len() {
            notes_by_column[note.column as usize].push(*note);
        }
        if !note.is_hold || note.end_time <= note.time {
            continue;
        }
        hold_spans.push(*note);
        *release_rows.entry_or_insert_with(note.end_time, || 0) += 1;
        hold_events.push((note.time, 1.0));
        hold_events.push((note.end_time, -1.0));
    }

    hold_events.sort_by(|l, r| {
        let d = l.0 - r.0;
        if d != 0.0 && !d.is_nan() {
            return crate::js::cmp_num(l.0, r.0);
        }
        crate::js::cmp_num(r.1, l.1)
    });

    let mut mixed_rows = 0f64;
    let mut tap_while_holding_rows = 0f64;
    let mut head_tail_switch_rows = 0f64;
    let mut active_holds = 0f64;
    let mut event_index = 0usize;

    for (time, row_notes) in ordered_rows {
        let time = *time;
        head_times.add(time);
        while event_index < hold_events.len() && hold_events[event_index].0 < time {
            active_holds = jsmath::max(0.0, active_holds + hold_events[event_index].1);
            event_index += 1;
        }
        let has_hold = row_notes.iter().any(|n| n.is_hold);
        let has_tap = row_notes.iter().any(|n| !n.is_hold);
        if has_hold && has_tap {
            mixed_rows += 1.0;
        }
        if has_tap && active_holds > 0.0 {
            tap_while_holding_rows += 1.0;
        }
        if release_rows.contains(time) {
            head_tail_switch_rows += 1.0;
        }
    }

    let mut release_only_rows = 0f64;
    for time in release_rows.keys() {
        if !head_times.has(time) {
            release_only_rows += 1.0;
        }
    }

    let mut same_column_gaps: Vec<f64> = Vec::new();
    let gap_cap = inverse_gap_cap_ms(beat_length_ms);
    let mut inverse_like_holds = 0f64;
    let mut same_column_next_holds = 0f64;

    let mut holds_by_start = hold_spans.clone();
    holds_by_start.sort_by(|l, r| crate::js::cmp_num(l.time, r.time));
    let hold_starts: Vec<f64> = holds_by_start.iter().map(|h| h.time).collect();
    let mut latest_end_by_start: Vec<f64> = Vec::with_capacity(holds_by_start.len());
    let mut latest_end = f64::NEG_INFINITY;
    for hold in &holds_by_start {
        latest_end = jsmath::max(latest_end, hold.end_time);
        latest_end_by_start.push(latest_end);
    }
    let held_through = |time: f64| -> bool {
        let mut low = 0usize;
        let mut high = hold_starts.len();
        while low < high {
            let mid = (low + high) >> 1;
            if hold_starts[mid] < time {
                low = mid + 1;
            } else {
                high = mid;
            }
        }
        low > 0 && latest_end_by_start[low - 1] > time
    };

    let mut active_release_holds = 0f64;
    let mut coordinated_release_holds = 0f64;
    let mut held_while_release_holds = 0f64;
    let mut hold_durations: Vec<f64> = Vec::new();
    let mut window_pairs: NumMap<(f64, f64)> = NumMap::new();

    for column_notes in notes_by_column.iter_mut() {
        column_notes.sort_by(|l, r| {
            let d = l.time - r.time;
            if d != 0.0 && !d.is_nan() {
                return crate::js::cmp_num(l.time, r.time);
            }
            crate::js::cmp_num(l.end_time, r.end_time)
        });
        for index in 0..column_notes.len() {
            let note = column_notes[index];
            if !note.is_hold || note.end_time <= note.time {
                continue;
            }
            let hold_duration = jsmath::max(1.0, note.end_time - note.time);
            hold_durations.push(hold_duration);
            let next_note = column_notes.get(index + 1).copied();
            let gap = match next_note {
                Some(n) => n.time - note.end_time,
                None => f64::INFINITY,
            };
            if next_note.is_some() && gap >= 0.0 {
                same_column_next_holds += 1.0;
                same_column_gaps.push(gap);
                let window_key = (note.time / INVERSE_WINDOW_MS).floor();
                let window = window_pairs.entry_or_insert_with(window_key, || (0.0, 0.0));
                window.0 += 1.0;
                if gap <= gap_cap && gap <= hold_duration {
                    window.1 += 1.0;
                }
            }
            if gap >= 0.0 && gap <= gap_cap && gap / hold_duration <= 0.7 {
                if next_note.is_some() {
                    inverse_like_holds += 1.0;
                }
                continue;
            }
            active_release_holds += 1.0;
            if head_times.has(note.end_time) {
                coordinated_release_holds += 1.0;
            }
            if held_through(note.end_time) {
                held_while_release_holds += 1.0;
            }
        }
    }

    let row_count = jsmath::max(1.0, ordered_rows.len() as f64);
    let release_row_count = release_rows.len() as f64;
    let hold_count = jsmath::max(1.0, hold_durations.len() as f64);

    let mut held_ms = 0f64;
    for hold in &hold_spans {
        held_ms += hold.end_time - hold.time;
    }
    let mut first_time = f64::INFINITY;
    let mut last_time = f64::NEG_INFINITY;
    for note in notes {
        if note.time < first_time {
            first_time = note.time;
        }
        let end = if note.is_hold { jsmath::max(note.time, note.end_time) } else { note.time };
        if end > last_time {
            last_time = end;
        }
    }
    let chart_span_ms = if last_time > first_time { last_time - first_time } else { 0.0 };
    let held_time_share =
        if chart_span_ms > 0.0 { clamp01(held_ms / (chart_span_ms * jsmath::max(1.0, key_count))) } else { 0.0 };

    let mut judged_windows = 0f64;
    let mut inverse_windows = 0f64;
    for &(pairs, inverse) in release_rows_free(&window_pairs) {
        if pairs < INVERSE_WINDOW_MIN_PAIRS {
            continue;
        }
        judged_windows += 1.0;
        if inverse / pairs >= INVERSE_WINDOW_RATIO {
            inverse_windows += 1.0;
        }
    }

    LnPatternStats {
        inverse_release_ratio: if same_column_next_holds != 0.0 {
            inverse_like_holds / same_column_next_holds
        } else {
            0.0
        },
        same_column_release_gap_p50: quantile(&same_column_gaps, 0.5),
        release_only_ratio: if release_row_count != 0.0 { release_only_rows / release_row_count } else { 0.0 },
        head_tail_switch_ratio: head_tail_switch_rows / row_count,
        mixed_row_ratio: mixed_rows / row_count,
        tap_while_holding_ratio: tap_while_holding_rows / row_count,
        active_release_ratio: active_release_holds / hold_count,
        coordinated_release_ratio: coordinated_release_holds / hold_count,
        held_while_release_ratio: held_while_release_holds / hold_count,
        hold_duration_p50: quantile(&hold_durations, 0.5),
        inverse_window_coverage: if judged_windows >= INVERSE_WINDOW_MIN_WINDOWS {
            inverse_windows / judged_windows
        } else {
            0.0
        },
        held_time_share,
    }
}

fn release_rows_free(map: &NumMap<(f64, f64)>) -> impl Iterator<Item = &(f64, f64)> {
    map.values()
}

fn ratio(count: f64, total: f64) -> f64 {
    if total > 0.0 {
        count / total
    } else {
        0.0
    }
}

fn pressure(value: f64, low: f64, high: f64) -> f64 {
    clamp01((value - low) / jsmath::max(0.001, high - low))
}

fn rounded_score(value: f64) -> f64 {
    jsmath::round(clamp01(value) * 1000.0) / 1000.0
}

fn hit(id: ManiaPatternId, score: f64, data_confidence: f64, evidence: String) -> ManiaPatternHit {
    ManiaPatternHit {
        id,
        label: id.label(),
        score: rounded_score(score),
        confidence: rounded_score(score * data_confidence),
        evidence,
    }
}

fn compact_percent(value: f64) -> String {
    format!("{}%", num_to_string(jsmath::round(value * 100.0)))
}

fn round_str(value: f64) -> String {
    num_to_string(jsmath::round(value))
}

pub fn analyze_mania_patterns(
    map: &ManiaBeatmap,
    input: &DanEstimateInput,
    precomputed_features: Option<&DanFeatureExtractionResult>,
    ln_skillsets: LnSkillsetsFn<'_>,
) -> ManiaPatternAnalysis {
    let rate = get_input_rate(input);
    let owned;
    let features = match precomputed_features {
        Some(f) => f,
        None => {
            owned = extract_dan_features(map, input, rate);
            &owned
        }
    };
    let metrics = &features.metrics;
    let ordered_rows = &features.ordered_rows;
    let kc = metrics.key_count;
    let stats = get_row_pattern_stats(ordered_rows, kc);
    let row_count = jsmath::max(1.0, stats.row_count);
    let chord_ratio = metrics.chord_ratio;
    let two_note_ratio = ratio(stats.two_note_rows, row_count);
    let three_note_ratio = ratio(stats.three_note_rows, row_count);
    let three_plus_ratio = ratio(stats.three_plus_rows, row_count);
    let four_plus_ratio = ratio(stats.four_plus_rows, row_count);
    let repeated_chord_ratio = ratio(stats.repeated_chord_rows, jsmath::max(1.0, stats.chord_rows - 1.0));
    let low_chord_gate = clamp01((0.34 - chord_ratio) / 0.3);
    let wide = kc >= 6.0;
    let stream_activity = jsmath::max(
        pressure(metrics.stream_pressure, 1.5, 5.5),
        pressure(metrics.sustained_nps10s, if wide { 7.0 } else { 12.0 }, if wide { 18.0 } else { 27.0 }),
    );
    let chordstream_gate = min_gate(&[
        pressure(chord_ratio, if wide { 0.14 } else { 0.24 }, if wide { 0.5 } else { 0.58 }),
        pressure(metrics.sustained_nps10s, if wide { 6.0 } else { 11.0 }, if wide { 17.0 } else { 25.0 }),
    ]);
    let chord_overlap_gate = pressure(metrics.chord_column_overlap_ratio, 0.18, 0.4);
    let chordjack_base = jsmath::max(
        min_gate(&[
            pressure(chord_ratio, 0.28, 0.64),
            pressure(metrics.chordjack_pressure, 70.0, 185.0),
            chord_overlap_gate,
        ]),
        min_gate(&[pressure(chord_ratio, 0.36, 0.72), pressure(metrics.jack_pressure, 80.0, 180.0), chord_overlap_gate]),
    );
    let tech_score = jsmath::max(
        min_gate(&[pressure(metrics.tech_pressure, 3.5, 8.5), pressure(metrics.row_pattern_change_rate, 0.34, 0.66)]),
        min_gate(&[
            pressure(metrics.chord_size_change_rate, 0.25, 0.58),
            pressure(metrics.direction_change_rate, 0.35, 0.72),
            pressure(metrics.row_interval_entropy, 1.1, 2.4),
        ]),
    );
    let data_confidence = clamp01(
        0.35 + jsmath::min(0.4, metrics.note_count / 2500.0) + jsmath::min(0.25, stats.row_count / 900.0),
    );
    let mut candidates: Vec<ManiaPatternHit> = Vec::new();
    let beat_length_ms = if map.bpm.is_finite() && map.bpm > 0.0 { 60000.0 / (map.bpm * rate) } else { 0.0 };
    let ln_stats = get_ln_pattern_stats(&features.notes, ordered_rows, kc, beat_length_ms);
    let ln_score = jsmath::max(
        jsmath::max(
            jsmath::max(
                pressure(metrics.hold_ratio, 0.03, 0.32),
                min_gate(&[pressure(metrics.ln_density, 0.02, 0.18), pressure(metrics.ln_overlap_pressure, 0.4, 2.4)]),
            ),
            min_gate(&[pressure(metrics.ln_release_pressure, 1.2, 5.5), pressure(metrics.hold_ratio, 0.015, 0.16)]),
        ),
        min_gate(&[pressure(metrics.ln_chord_pressure, 0.15, 0.65), pressure(metrics.hold_ratio, 0.02, 0.18)]),
    );
    let ln_subtype_keys = kc == 7.0 || kc == 4.0;
    let ln_subtype_gate = if ln_subtype_keys { pressure(ln_score, 0.18, 0.58) } else { 0.0 };
    let ln_inverse_shape = jsmath::max(
        pressure(ln_stats.inverse_release_ratio, 0.24, 0.62) * clamp01((0.16 - ln_stats.mixed_row_ratio) / 0.16),
        if kc == 7.0 {
            pressure(ln_stats.inverse_window_coverage, 0.35, 0.75) * clamp01((0.45 - ln_stats.mixed_row_ratio) / 0.25)
        } else {
            0.0
        },
    );
    let ln_inverse_held_gate = if kc == 4.0 { pressure(ln_stats.held_time_share, 0.4, 0.55) } else { 1.0 };
    let ln_inverse_score = ln_subtype_gate
        * min_gate(&[
            ln_inverse_shape,
            pressure(metrics.ln_density, 0.12, 0.5),
            jsmath::max(
                pressure(metrics.ln_overlap_pressure, 1.1, 3.1),
                pressure(metrics.ln_hold_duration_p90, 260.0, 520.0),
            ),
            ln_inverse_held_gate,
        ]);
    let ln_release_wall = min_gate(&[
        pressure(metrics.hold_ratio, 0.85, 0.97),
        pressure(ln_stats.held_while_release_ratio, 0.45, 0.65),
        pressure(metrics.ln_release_pressure, 32.0, 46.0),
        clamp01((0.5 - ln_stats.inverse_release_ratio) / 0.15),
    ]);
    let ln_release_score = if kc == 7.0 {
        ln_subtype_gate
            * min_gate(&[
                pressure(metrics.hold_ratio, 0.2, 0.46),
                jsmath::max(pressure(ln_stats.active_release_ratio, 0.55, 0.88), ln_release_wall),
                pressure(metrics.ln_release_pressure, 2.5, 6.0),
                jsmath::max(
                    jsmath::max(
                        min_gate(&[
                            pressure(ln_stats.hold_duration_p50, 150.0, 330.0),
                            jsmath::max(
                                pressure(ln_stats.coordinated_release_ratio, 0.34, 0.68),
                                pressure(ln_stats.held_while_release_ratio, 0.32, 0.62),
                            ),
                        ]),
                        min_gate(&[
                            pressure(ln_stats.held_while_release_ratio, 0.45, 0.7),
                            pressure(metrics.hold_ratio, 0.6, 0.85),
                            pressure(ln_stats.active_release_ratio, 0.7, 0.9),
                        ]),
                    ),
                    ln_release_wall,
                ),
            ])
    } else {
        0.0
    };
    let ln_tech_burst =
        jsmath::max(pressure(metrics.fast_row_ratio, 0.18, 0.36), pressure(metrics.row_burst_pressure, 16.0, 26.0));
    let ln_tech_coordination = if kc == 4.0 {
        jsmath::max(
            pressure(ln_stats.tap_while_holding_ratio, 0.1, 0.25),
            pressure(ln_stats.head_tail_switch_ratio, 0.3, 0.55),
        )
    } else {
        jsmath::max(
            jsmath::max(
                pressure(ln_stats.tap_while_holding_ratio, 0.04, 0.11),
                pressure(ln_stats.head_tail_switch_ratio, 0.52, 0.72),
            ),
            pressure(metrics.chord_size_change_rate, 0.55, 0.78),
        )
    };
    let ln_tech_content_floor = if kc == 4.0 { pressure(metrics.hold_ratio, 0.2, 0.4) } else { 1.0 };
    let ln_tech_score = ln_subtype_gate
        * min_gate(&[
            ln_tech_burst,
            ln_tech_coordination,
            ln_tech_content_floor,
            jsmath::max(pressure(metrics.tech_pressure, 4.2, 8.4), pressure(metrics.row_interval_entropy, 2.0, 2.45)),
            clamp01((0.6 - ln_stats.inverse_release_ratio) / 0.34),
            clamp01((0.66 - ln_stats.release_only_ratio) / 0.22),
        ]);
    let ln_general_coverage = jsmath::max(
        min_gate(&[
            pressure(metrics.hold_ratio, 0.35, 0.82),
            pressure(metrics.ln_chord_pressure, 0.32, 0.66),
            pressure(ln_stats.head_tail_switch_ratio, 0.35, 0.62),
        ]),
        min_gate(&[
            pressure(metrics.ln_density, 0.12, 0.42),
            pressure(metrics.ln_release_pressure, 8.0, 24.0),
            pressure(chord_ratio, 0.28, 0.62),
        ]),
    );
    let ln_specialty_score = jsmath::max(jsmath::max(ln_inverse_score, ln_release_score), ln_tech_score);
    let ln_general_score = ln_subtype_gate * ln_general_coverage * clamp01((0.7 - ln_specialty_score) / 0.4);

    candidates.push(hit(
        ManiaPatternId::Ln,
        if kc == 7.0 { ln_score * 0.62 } else { ln_score },
        data_confidence,
        format!(
            "{} holds, release pressure {}",
            compact_percent(metrics.hold_ratio),
            to_fixed(metrics.ln_release_pressure, 1)
        ),
    ));
    if kc == 4.0 && metrics.hold_ratio >= 0.25 {
        if let Some(scores) = ln_skillsets(map, get_input_rate(input)) {
            for (k, id) in LN_SKILLSET_IDS.iter().enumerate() {
                candidates.push(hit(
                    *id,
                    scores[k] * ln_subtype_gate,
                    data_confidence,
                    "4K hold/head/release geometry across LN sections".to_string(),
                ));
            }
        }
    }
    if kc == 7.0 {
        candidates.push(hit(
            ManiaPatternId::Lngeneral,
            ln_general_score,
            data_confidence,
            format!(
                "{} LN chord rows, {} head/tail switches",
                compact_percent(metrics.ln_chord_pressure),
                compact_percent(ln_stats.head_tail_switch_ratio)
            ),
        ));
        candidates.push(hit(
            ManiaPatternId::Lninverse,
            ln_inverse_score,
            data_confidence,
            format!(
                "{} short same-column release gaps, p50 gap {}ms, {} of the chart in inverse sections, columns held {} of the time",
                compact_percent(ln_stats.inverse_release_ratio),
                round_str(ln_stats.same_column_release_gap_p50),
                compact_percent(ln_stats.inverse_window_coverage),
                compact_percent(ln_stats.held_time_share)
            ),
        ));
        candidates.push(hit(
            ManiaPatternId::Lntech,
            ln_tech_score,
            data_confidence,
            format!(
                "{} tap-with-hold rows, burst pressure {}",
                compact_percent(ln_stats.tap_while_holding_ratio),
                to_fixed(metrics.row_burst_pressure, 1)
            ),
        ));
        candidates.push(hit(
            ManiaPatternId::Lnrelease,
            ln_release_score,
            data_confidence,
            format!(
                "{} releases timed on their own, p50 tail {}ms, {} released under other holds",
                compact_percent(ln_stats.active_release_ratio),
                round_str(ln_stats.hold_duration_p50),
                compact_percent(ln_stats.held_while_release_ratio)
            ),
        ));
    }

    if kc == 4.0 {
        let jack_score = jsmath::max(
            pressure(metrics.jack_pressure, 75.0, 185.0) * (0.55 + low_chord_gate * 0.35),
            min_gate(&[pressure(metrics.jack_pressure, 110.0, 200.0), pressure(metrics.fast_row_ratio, 0.05, 0.28)]),
        );
        candidates.push(hit(
            ManiaPatternId::Jack,
            jack_score,
            data_confidence,
            format!("same-lane pressure {}", round_str(metrics.jack_pressure)),
        ));
        candidates.push(hit(
            ManiaPatternId::Chordjack,
            chordjack_base,
            data_confidence,
            format!("{} chord rows, jack pressure {}", compact_percent(chord_ratio), round_str(metrics.jack_pressure)),
        ));
        candidates.push(hit(
            ManiaPatternId::Speedjack,
            chordjack_base
                * min_gate(&[
                    pressure(two_note_ratio, 0.18, 0.42),
                    pressure(metrics.jack_pressure, 115.0, 205.0),
                    clamp01((0.68 - three_plus_ratio) / 0.35),
                ]),
            data_confidence,
            format!("{} two-note rows, light dense jacks", compact_percent(two_note_ratio)),
        ));
        candidates.push(hit(
            ManiaPatternId::Handjack,
            chordjack_base
                * min_gate(&[
                    pressure(three_plus_ratio, 0.08, 0.28),
                    pressure(stats.average_chord_size, 2.15, 3.1),
                    pressure(metrics.jack_pressure, 95.0, 180.0),
                ]),
            data_confidence,
            format!("{} 3+ note rows in jack pressure", compact_percent(three_plus_ratio)),
        ));
        candidates.push(hit(
            ManiaPatternId::Tech,
            tech_score,
            data_confidence,
            format!(
                "pattern change {}, tech pressure {}",
                compact_percent(metrics.row_pattern_change_rate),
                to_fixed(metrics.tech_pressure, 1)
            ),
        ));
        candidates.push(hit(
            ManiaPatternId::Stream,
            low_chord_gate * stream_activity * clamp01((150.0 - metrics.jack_pressure) / 120.0),
            data_confidence,
            format!("{} chord rows, sustained flow", compact_percent(chord_ratio)),
        ));
        candidates.push(hit(
            ManiaPatternId::Dumpstream,
            low_chord_gate
                * stream_activity
                * min_gate(&[
                    pressure(metrics.row_pattern_entropy, 1.8, 3.5),
                    pressure(metrics.row_interval_entropy, 1.2, 2.7),
                    clamp01((0.75 - metrics.rhythm_motif_repeat_ratio) / 0.45),
                ]),
            data_confidence,
            format!("irregular stream entropy {}", to_fixed(metrics.row_interval_entropy, 1)),
        ));
        candidates.push(hit(
            ManiaPatternId::Jumpstream,
            min_gate(&[
                pressure(two_note_ratio, 0.14, 0.36),
                pressure(chord_ratio, 0.24, 0.56),
                pressure(metrics.jumpstream_pressure, 8.0, 22.0),
            ]),
            data_confidence,
            format!("{} two-note chord rows", compact_percent(two_note_ratio)),
        ));
        candidates.push(hit(
            ManiaPatternId::Handstream,
            min_gate(&[
                pressure(three_note_ratio, 0.06, 0.22),
                pressure(chord_ratio, 0.32, 0.62),
                pressure(metrics.sustained_nps10s, 13.0, 27.0),
                clamp01((175.0 - metrics.jack_pressure) / 120.0),
            ]),
            data_confidence,
            format!("{} three-note rows in stream", compact_percent(three_note_ratio)),
        ));
        candidates.push(hit(
            ManiaPatternId::Quadstream,
            min_gate(&[
                pressure(four_plus_ratio, 0.015, 0.08),
                pressure(chord_ratio, 0.36, 0.72),
                pressure(metrics.sustained_nps10s, 12.0, 25.0),
            ]),
            data_confidence,
            format!("{} quad rows in stream", compact_percent(four_plus_ratio)),
        ));
    } else if kc >= 6.0 && kc <= 8.0 {
        let non_ln_flow_gate = clamp01((0.3 - metrics.hold_ratio) / 0.22);
        let non_ln_pattern_gate = clamp01((0.68 - metrics.hold_ratio) / 0.56);
        let bracket_overlap_gate = clamp01((0.62 - metrics.chord_column_overlap_ratio) / 0.17);
        let bracket_window_ratio = ratio(stats.bracket_window_rows, row_count);
        let wide_chordstream = jsmath::max(
            chordstream_gate,
            min_gate(&[pressure(chord_ratio, 0.2, 0.62), pressure(metrics.chord_size_change_rate, 0.18, 0.52)]),
        );
        let (jack1_share, trill_run_share) = get_single_jack_stats(ordered_rows);
        let chord_repeat_gate = jsmath::max(
            jsmath::max(
                pressure(ratio(stats.multi_overlap_chord_pairs, jsmath::max(1.0, stats.chord_pairs)), 0.16, 0.26),
                pressure(jack1_share, 0.16, 0.26),
            ),
            pressure(stats.chord_rows / jsmath::max(1.0, stats.chord_runs), 4.0, 8.0),
        );
        let chordjack_score = non_ln_pattern_gate
            * chord_repeat_gate
            * jsmath::max(
                chordjack_base,
                min_gate(&[pressure(chord_ratio, 0.34, 0.72), pressure(repeated_chord_ratio, 0.04, 0.22)]),
            );
        let delay_chordjack_veto = clamp01((0.8 - chordjack_score) / 0.05);
        let delay_score = non_ln_flow_gate * delay_chordjack_veto * pressure(metrics.off_grid_row_share, 0.2, 0.5);
        let jack_score = non_ln_pattern_gate
            * jsmath::max(pressure(jack1_share, 0.08, 0.28), pressure(trill_run_share, 0.03, 0.12));
        candidates.push(hit(
            ManiaPatternId::Delay,
            delay_score,
            data_confidence,
            format!("{} rows off the 16th grid (1/6, 1/8, 1/12)", compact_percent(metrics.off_grid_row_share)),
        ));
        candidates.push(hit(
            ManiaPatternId::Jack,
            jack_score,
            data_confidence,
            format!(
                "{} consecutive-row column re-hits, {} notes in two-row trill runs",
                compact_percent(jack1_share),
                compact_percent(trill_run_share)
            ),
        ));
        candidates.push(hit(
            ManiaPatternId::Chordjack,
            chordjack_score,
            data_confidence,
            format!(
                "{} chord rows, {} repeated chord rows",
                compact_percent(chord_ratio),
                compact_percent(repeated_chord_ratio)
            ),
        ));
        candidates.push(hit(
            ManiaPatternId::Tech,
            non_ln_pattern_gate
                * jsmath::max(
                    tech_score,
                    wide_chordstream
                        * min_gate(&[
                            pressure(metrics.row_pattern_change_rate, 0.38, 0.72),
                            pressure(metrics.fast_row_ratio, 0.08, 0.36),
                        ]),
                ),
            data_confidence,
            format!(
                "chord changes {}, tech pressure {}",
                compact_percent(metrics.chord_size_change_rate),
                to_fixed(metrics.tech_pressure, 1)
            ),
        ));
        candidates.push(hit(
            ManiaPatternId::Bracket,
            non_ln_pattern_gate
                * bracket_overlap_gate
                * min_gate(&[pressure(chord_ratio, 0.28, 0.62), pressure(bracket_window_ratio, 0.18, 0.38)]),
            data_confidence,
            format!(
                "{} sustained non-jacking chord runs, {} consecutive-chord column re-hits",
                compact_percent(bracket_window_ratio),
                compact_percent(metrics.chord_column_overlap_ratio)
            ),
        ));
        candidates.push(hit(
            ManiaPatternId::Chordstream,
            non_ln_pattern_gate * wide_chordstream * clamp01((165.0 - metrics.jack_pressure) / 130.0),
            data_confidence,
            format!("{} chord rows mixed into stream", compact_percent(chord_ratio)),
        ));
    } else {
        candidates.push(hit(
            ManiaPatternId::Stream,
            low_chord_gate * stream_activity,
            data_confidence,
            format!("{}K low-chord stream flow", num_to_string(kc)),
        ));
        candidates.push(hit(
            ManiaPatternId::Chordstream,
            chordstream_gate,
            data_confidence,
            format!("{} chord rows mixed into stream", compact_percent(chord_ratio)),
        ));
        candidates.push(hit(
            ManiaPatternId::Chordjack,
            chordjack_base,
            data_confidence,
            format!("{} chord rows, jack pressure {}", compact_percent(chord_ratio), round_str(metrics.jack_pressure)),
        ));
        candidates.push(hit(
            ManiaPatternId::Tech,
            tech_score,
            data_confidence,
            format!("pattern change {}", compact_percent(metrics.row_pattern_change_rate)),
        ));
    }

    let mut all_patterns: Vec<ManiaPatternHit> = candidates
        .into_iter()
        .map(|c| ManiaPatternHit { score: rounded_score(c.score), confidence: rounded_score(c.confidence), ..c })
        .collect();
    all_patterns.sort_by(|a, b| {
        let d = b.score - a.score;
        if d != 0.0 && !d.is_nan() {
            return if d < 0.0 { std::cmp::Ordering::Less } else { std::cmp::Ordering::Greater };
        }
        crate::js::locale_compare(a.label, b.label)
    });
    let visible: Vec<ManiaPatternHit> = all_patterns.iter().filter(|p| p.score >= 0.2).take(5).cloned().collect();
    let ln_pattern = all_patterns.iter().find(|p| p.id == ManiaPatternId::Ln).cloned();
    let has_ln_signal = ln_pattern.as_ref().map_or(false, |p| p.score > 0.0 || metrics.hold_ratio > 0.0);
    let ln_axis_patterns: Vec<ManiaPatternHit> = match &ln_pattern {
        Some(lp) if has_ln_signal && !visible.iter().any(|p| p.id == ManiaPatternId::Ln) => {
            let mut v = visible.clone();
            v.push(lp.clone());
            v
        }
        _ => visible,
    };
    let subtype_overflow: Vec<ManiaPatternHit> = all_patterns
        .iter()
        .filter(|p| is_ln_subtype(p.id) && p.score >= 0.2 && !ln_axis_patterns.iter().any(|v| v.id == p.id))
        .cloned()
        .collect();
    let patterns = if !subtype_overflow.is_empty() {
        let mut v = ln_axis_patterns;
        v.extend(subtype_overflow);
        v
    } else {
        ln_axis_patterns
    };
    let primary = patterns.first().cloned().or_else(|| all_patterns.first().cloned());

    ManiaPatternAnalysis {
        key_count: kc,
        primary,
        patterns,
        all_patterns,
        metrics: *metrics,
        warnings: features.warnings.clone(),
    }
}
