use crate::beatmap::{ManiaBeatmap, ManiaNote};
use crate::js::{bit, cmp_num, sort_nums, truthy, FxHashSet, NumMap};
use crate::math::{
    average, bucket_entropy, bucket_values, count_in_window, quantile, quantiles, rao_quadratic_entropy_log,
    strain_spikiness,
};
use crate::types::{DanEstimateInput, DanFeatureExtractionResult, DanFeatureMetrics};

fn get_rated_notes(map: &ManiaBeatmap, rate: f64) -> Vec<ManiaNote> {
    let mut notes = Vec::with_capacity(map.notes.len());
    for note in &map.notes {
        if note.column < 0 || note.column >= map.key_count {
            continue;
        }
        if rate == 1.0 {
            notes.push(*note);
        } else {
            notes.push(ManiaNote { time: note.time / rate, end_time: note.end_time / rate, ..*note });
        }
    }
    notes
}

pub(crate) fn group_notes_by_time<'a, I: IntoIterator<Item = &'a ManiaNote>>(notes: I) -> Vec<(f64, Vec<ManiaNote>)> {
    let mut rows: NumMap<Vec<ManiaNote>> = NumMap::new();
    for note in notes {
        rows.entry_or_insert_with(note.time, Vec::new).push(*note);
    }
    let mut entries = rows.entries;
    entries.sort_by(|a, b| cmp_num(a.0, b.0));
    entries
}

#[inline]
fn bit_count_pos(value: i32) -> f64 {
    if value <= 0 {
        0.0
    } else {
        value.count_ones() as f64
    }
}

fn numeric_ngram_repeat_ratio(values: &[f64], size: usize, base: f64) -> f64 {
    if values.len() < size + 1 {
        return 0.0;
    }
    let mut seen: FxHashSet<u64> = FxHashSet::default();
    seen.reserve(values.len());
    let mut repeated = 0f64;
    let mut total = 0f64;
    for index in 0..=(values.len() - size) {
        let mut key = 0f64;
        for offset in 0..size {
            key = key * base + values[index + offset];
        }
        if !seen.insert(crate::js::key(key)) {
            repeated += 1.0;
        }
        total += 1.0;
    }
    if total != 0.0 {
        repeated / total
    } else {
        0.0
    }
}

fn adjacent_ngram_repeat_ratio(values: &[f64], size: usize) -> f64 {
    if values.len() < size * 2 {
        return 0.0;
    }
    let mut repeated = 0f64;
    let mut total = 0f64;
    for index in size..=(values.len() - size) {
        total += 1.0;
        let mut matches = true;
        for offset in 0..size {
            if values[index + offset] != values[index - size + offset] {
                matches = false;
                break;
            }
        }
        if matches {
            repeated += 1.0;
        }
    }
    if total != 0.0 {
        repeated / total
    } else {
        0.0
    }
}

fn sampled_window_nps(note_times: &[f64], window_ms: f64, duration_ms: f64) -> Vec<f64> {
    if note_times.is_empty() || !(duration_ms > 0.0) {
        return Vec::new();
    }
    let mut samples = Vec::new();
    let mut left = 0usize;
    let mut right = 0usize;
    let mut start = 0f64;
    while start <= duration_ms {
        while left < note_times.len() && note_times[left] < start {
            left += 1;
        }
        while right < note_times.len() && note_times[right] < start + window_ms {
            right += 1;
        }
        samples.push((right as f64 - left as f64) / (window_ms / 1000.0));
        start += 1000.0;
    }
    samples
}

const SNAP_DIVISORS: [f64; 10] = [1.0, 2.0, 3.0, 4.0, 6.0, 8.0, 12.0, 16.0, 24.0, 32.0];

fn gap_snap_divisor(gap_ms: f64, beat_length_ms: f64) -> f64 {
    let tolerance = 2.0 + gap_ms * 0.01;
    for &divisor in &SNAP_DIVISORS {
        let unit = beat_length_ms / divisor;
        let steps = jsmath::round(gap_ms / unit);
        if steps >= 1.0 && (steps * unit - gap_ms).abs() <= tolerance {
            return divisor;
        }
    }
    0.0
}

pub fn off_grid_row_share(map: &ManiaBeatmap) -> f64 {
    let mut timing_points: Vec<(f64, f64)> = map
        .timing_points
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .filter(|p| p.time.is_finite() && p.beat_length > 0.0)
        .map(|p| (p.time, p.beat_length))
        .collect();
    timing_points.sort_by(|a, b| cmp_num(a.0, b.0));
    let fallback_beat_length = if map.bpm > 0.0 { 60000.0 / map.bpm } else { f64::INFINITY };
    let rows = group_notes_by_time(map.notes.iter().filter(|n| n.column >= 0 && n.column < map.key_count));
    if rows.len() < 2 {
        return 0.0;
    }
    let mut off_grid = 0f64;
    let mut timing_index = 0usize;
    for i in 1..rows.len() {
        let time = rows[i].0;
        while timing_index + 1 < timing_points.len() && timing_points[timing_index + 1].0 <= time + 1.0 {
            timing_index += 1;
        }
        let beat_length = if !timing_points.is_empty() && timing_points[timing_index].0 <= time + 1.0 {
            timing_points[timing_index].1
        } else {
            timing_points.first().map(|p| p.1).unwrap_or(fallback_beat_length)
        };
        let gap = time - rows[i - 1].0;
        if gap <= 55.0 {
            off_grid += 1.0;
            continue;
        }
        if gap > beat_length {
            continue;
        }
        let divisor = gap_snap_divisor(gap, beat_length);
        if divisor >= 6.0 || (divisor == 0.0 && gap <= beat_length / 2.0) {
            off_grid += 1.0;
        }
    }
    off_grid / rows.len() as f64
}

pub fn extract_dan_features(map: &ManiaBeatmap, input: &DanEstimateInput, rate: f64) -> DanFeatureExtractionResult {
    let notes = get_rated_notes(map, rate);
    let mut warnings: Vec<String> = Vec::new();
    let mut note_times: Vec<f64> = Vec::with_capacity(notes.len());
    let mut release_times: Vec<f64> = Vec::new();
    let mut hold_durations: Vec<f64> = Vec::new();
    let mut hold_events: Vec<(f64, f64)> = Vec::new();
    let mut hold_note_count = 0f64;
    let mut total_hold_ms = 0f64;
    let mut note_times_sorted = true;
    let mut release_times_sorted = true;
    let mut previous_note_time = f64::NEG_INFINITY;
    let mut previous_release_time = f64::NEG_INFINITY;

    for note in &notes {
        if note.time < previous_note_time {
            note_times_sorted = false;
        }
        previous_note_time = note.time;
        note_times.push(note.time);
        if note.is_hold {
            hold_note_count += 1.0;
            if note.end_time > note.time {
                let hold_duration = note.end_time - note.time;
                hold_durations.push(hold_duration);
                total_hold_ms += hold_duration;
                if note.end_time < previous_release_time {
                    release_times_sorted = false;
                }
                previous_release_time = note.end_time;
                release_times.push(note.end_time);
                hold_events.push((note.time, 1.0));
                hold_events.push((note.end_time, -1.0));
            }
        }
    }

    if !note_times_sorted {
        sort_nums(&mut note_times);
    }
    if !release_times_sorted {
        sort_nums(&mut release_times);
    }
    let input_total = input.total_length.unwrap_or(f64::NAN);
    let from_input = if truthy(input_total) { (input_total * 1000.0) / rate } else { 0.0 };
    let duration_ms = jsmath::max(
        jsmath::max(from_input, map.total_length / rate),
        note_times.last().copied().unwrap_or(0.0),
    );

    if notes.len() < 50 || duration_ms <= 0.0 {
        warnings.push("This map has very little note data, so the estimate is low confidence.".to_string());
    }

    let ordered_rows = group_notes_by_time(notes.iter());
    let n_notes = notes.len() as f64;
    let hold_ratio = if !notes.is_empty() { hold_note_count / n_notes } else { 0.0 };
    let key_count = map.key_count;
    let lanes = jsmath::max(1.0, key_count as f64) as usize;

    let mut last_by_column = vec![f64::NEG_INFINITY; lanes];
    let mut jack_values: Vec<f64> = Vec::new();
    let mut stream_values: Vec<f64> = Vec::new();
    let mut jumpstream_values: Vec<f64> = Vec::new();
    let mut row_densities: Vec<f64> = Vec::new();
    let mut row_density_weights: Vec<f64> = Vec::new();
    let mut row_intervals: Vec<f64> = Vec::new();
    let mut row_rates: Vec<f64> = Vec::new();
    let mut column_intervals: Vec<f64> = Vec::new();
    let mut column_rates: Vec<f64> = Vec::new();
    let mut tail_intervals: Vec<f64> = Vec::new();
    let mut tail_rates: Vec<f64> = Vec::new();
    let mut column_counts = vec![0f64; lanes];
    let mut chord_rows = 0f64;
    let mut two_note_chord_rows = 0f64;
    let mut hold_rows = 0f64;
    let mut ln_chord_rows = 0f64;
    let mut long_gap_count = 0f64;
    let mut long_gap_ms = 0f64;
    let mut fast_row_count = 0f64;
    let mut direction_changes = 0f64;
    let mut previous_column: Option<i32> = None;
    let mut previous_direction = 0f64;
    let mut previous_chord_size = 0usize;
    let mut chord_size_changes = 0f64;
    let mut previous_row_time: Option<f64> = None;
    let mut previous_row_mask: Option<i32> = None;
    let mut row_mask_two_back: Option<i32> = None;
    let mut repeated_row_patterns = 0f64;
    let mut alternating_row_patterns = 0f64;
    let mut chord_pair_count = 0f64;
    let mut chord_pair_overlap_count = 0f64;
    let mut adjacent_column_rehit_notes = 0f64;
    let mut two_back_column_rehit_notes = 0f64;
    let mut row_pattern_change_sum = 0f64;
    let mut row_masks: Vec<f64> = Vec::with_capacity(ordered_rows.len());
    let mut row_times: Vec<f64> = Vec::with_capacity(ordered_rows.len());
    let mut row_signatures: Vec<f64> = Vec::with_capacity(ordered_rows.len());
    let row_mask_base = jsmath::max(32.0, jsmath::pow(2.0, jsmath::max(1.0, key_count as f64)) + 1.0);
    let row_signature_base = row_mask_base * 256.0;
    let kc_div = jsmath::max(1.0, key_count as f64);

    let mut columns: Vec<i32> = Vec::new();
    for (time, row_notes) in &ordered_rows {
        let time = *time;
        columns.clear();
        let mut row_mask: i32 = 0;
        let mut row_has_hold = false;
        for note in row_notes {
            columns.push(note.column);
            row_mask |= bit(note.column);
            if note.is_hold {
                row_has_hold = true;
            }
        }
        columns.sort();
        let len = columns.len();

        if len >= 2 {
            chord_rows += 1.0;
        }
        if len == 2 {
            two_note_chord_rows += 1.0;
        }
        if row_has_hold {
            hold_rows += 1.0;
            if len >= 2 {
                ln_chord_rows += 1.0;
            }
        }

        if let (Some(prev_mask), Some(prev_time)) = (previous_row_mask, previous_row_time) {
            if previous_chord_size >= 2 && len >= 2 && time - prev_time < 1000.0 {
                chord_pair_count += 1.0;
                if (row_mask & prev_mask) != 0 {
                    chord_pair_overlap_count += 1.0;
                }
            }
        }

        row_masks.push(row_mask as f64);
        row_times.push(time);
        if let Some(prev_mask) = previous_row_mask {
            if let Some(prev_time) = previous_row_time {
                if time - prev_time <= 500.0 {
                    adjacent_column_rehit_notes += bit_count_pos(row_mask & prev_mask);
                }
            }
            if row_mask == prev_mask {
                repeated_row_patterns += 1.0;
            }
            row_pattern_change_sum += bit_count_pos(row_mask ^ prev_mask) / kc_div;
        }
        if let Some(two_back) = row_mask_two_back {
            if row_times.len() >= 3 && time - row_times[row_times.len() - 3] <= 500.0 {
                two_back_column_rehit_notes += bit_count_pos(row_mask & two_back);
            }
            if row_mask == two_back {
                alternating_row_patterns += 1.0;
            }
        }
        row_mask_two_back = previous_row_mask;
        previous_row_mask = Some(row_mask);
        for &column in &columns {
            column_counts[column as usize] += 1.0;
        }
        if previous_chord_size != 0 && previous_chord_size != len {
            chord_size_changes += 1.0;
        }
        let mut interval_bucket = 0f64;
        if let Some(prev_time) = previous_row_time {
            let row_delta = time - prev_time;
            if row_delta >= 2500.0 {
                long_gap_count += 1.0;
                long_gap_ms += row_delta;
            }
            if row_delta > 0.0 && row_delta < 1200.0 {
                row_intervals.push(row_delta);
                row_rates.push(1000.0 / row_delta);
                row_densities.push((len as f64 * 1000.0) / row_delta);
                row_density_weights.push(jsmath::max(1.0, row_delta));
                if len == 2 {
                    jumpstream_values.push(jsmath::min(60.0, (len as f64 * 1000.0) / row_delta));
                }
                if row_delta <= 80.0 {
                    fast_row_count += 1.0;
                }
                interval_bucket = jsmath::round(row_delta / 5.0);
            } else {
                interval_bucket = -1.0;
            }
        }
        row_signatures.push(row_mask as f64 * 256.0 + interval_bucket + 1.0);
        previous_chord_size = len;
        previous_row_time = Some(time);

        for &column in &columns {
            let cu = column as usize;
            let same_delta = time - last_by_column[cu];
            if same_delta > 0.0 && same_delta < 1000.0 {
                jack_values.push(jsmath::min(230.0, 15000.0 / same_delta));
            }
            if same_delta > 0.0 && same_delta < 1600.0 {
                column_intervals.push(same_delta);
                column_rates.push(1000.0 / same_delta);
            }
            let left_neighbor = column - 1;
            if left_neighbor >= 0 {
                let delta = time - last_by_column[left_neighbor as usize];
                if delta > 0.0 && delta < 260.0 {
                    stream_values.push((260.0 - delta) / 35.0);
                }
            }
            let right_neighbor = column + 1;
            if right_neighbor < key_count {
                let delta = time - last_by_column[right_neighbor as usize];
                if delta > 0.0 && delta < 260.0 {
                    stream_values.push((260.0 - delta) / 35.0);
                }
            }
            if let Some(prev_col) = previous_column {
                let direction = (column - prev_col).signum() as f64;
                if direction != 0.0 && previous_direction != 0.0 && direction != previous_direction {
                    direction_changes += 1.0;
                }
                if direction != 0.0 {
                    previous_direction = direction;
                }
            }
            previous_column = Some(column);
            last_by_column[cu] = time;
        }
    }

    for i in 1..release_times.len() {
        let tail_delta = release_times[i] - release_times[i - 1];
        if tail_delta > 0.0 && tail_delta < 1600.0 {
            tail_intervals.push(tail_delta);
            tail_rates.push(1000.0 / tail_delta);
        }
    }

    let n_rows = ordered_rows.len() as f64;
    let chord_ratio = if !ordered_rows.is_empty() { chord_rows / n_rows } else { 0.0 };
    let two_note_chord_ratio = if !ordered_rows.is_empty() { two_note_chord_rows / n_rows } else { 0.0 };
    let peak_nps1s = count_in_window(&note_times, 1000.0);
    let peak_nps5s = count_in_window(&note_times, 5000.0) / 5.0;
    let nps5s_samples = sampled_window_nps(&note_times, 5000.0, duration_ms);
    let qs = quantiles(&nps5s_samples, &[0.5, 0.9, 0.95]);
    let (nps5s_p50, nps5s_p90, nps5s_p95) = (qs[0], qs[1], qs[2]);
    let sustained_nps10s = count_in_window(&note_times, 10000.0) / 10.0;
    let sustained_nps30s = count_in_window(&note_times, 30000.0) / 30.0;
    let sustained_nps60s = count_in_window(&note_times, 60000.0) / 60.0;
    let note_span_ms = if note_times.len() >= 2 {
        jsmath::max(1.0, note_times[note_times.len() - 1] - note_times[0])
    } else {
        duration_ms
    };
    let active_nps = n_notes / jsmath::max(1.0, note_span_ms / 1000.0);
    let long_gap_ratio = if duration_ms > 0.0 { long_gap_ms / duration_ms } else { 0.0 };
    let jack_pressure = quantile(&jack_values, 0.92);
    let stream_pressure = quantile(&stream_values, 0.9);
    let jumpstream_pressure = quantile(&jumpstream_values, 0.9);
    let burst_density = quantile(&row_densities, 0.9);
    let row_burst_pressure = quantile(&row_rates, 0.9);
    let fast_row_ratio = if !row_intervals.is_empty() { fast_row_count / row_intervals.len() as f64 } else { 0.0 };
    let row_interval_entropy = bucket_entropy(&row_intervals, 5.0);
    let off_grid_share = off_grid_row_share(map);
    let row_pattern_entropy = bucket_entropy(&row_masks, 1.0);
    let row_pattern_variety = if !row_masks.is_empty() {
        let mut distinct: FxHashSet<u64> = FxHashSet::default();
        for &m in &row_masks {
            distinct.insert(crate::js::key(m));
        }
        distinct.len() as f64
            / jsmath::min(row_masks.len() as f64, jsmath::pow(2.0, jsmath::max(1.0, key_count as f64)))
    } else {
        0.0
    };
    let row_motif_repeat_ratio = numeric_ngram_repeat_ratio(&row_masks, 4, row_mask_base);
    let rhythm_motif_repeat_ratio = numeric_ngram_repeat_ratio(&row_signatures, 4, row_signature_base);
    let adjacent_motif_repeat_ratio = adjacent_ngram_repeat_ratio(&row_signatures, 4);
    let repeated_row_pattern_ratio =
        if ordered_rows.len() > 1 { repeated_row_patterns / (n_rows - 1.0) } else { 0.0 };
    let alternating_row_pattern_ratio =
        if ordered_rows.len() > 2 { alternating_row_patterns / (n_rows - 2.0) } else { 0.0 };
    let row_pattern_change_rate = if ordered_rows.len() > 1 { row_pattern_change_sum / (n_rows - 1.0) } else { 0.0 };
    let pattern_variety = 0.5 * rao_quadratic_entropy_log(&bucket_values(&row_intervals, 5.0), 1)
        + 1.125 * rao_quadratic_entropy_log(&bucket_values(&column_intervals, 5.0), 2)
        + 0.11 * rao_quadratic_entropy_log(&bucket_values(&tail_intervals, 5.0), 1);
    let spikiness = strain_spikiness(&row_densities, &row_density_weights);
    let sustained_pressure_ratio = sustained_nps10s / jsmath::max(jsmath::max(1.0, peak_nps1s), peak_nps5s);
    let average_column_count = average(&column_counts);
    let column_imbalance = if average_column_count > 0.0 {
        let mut sum = 0.0;
        for &count in &column_counts {
            sum += (count - average_column_count).abs();
        }
        sum / (column_counts.len() as f64 * average_column_count)
    } else {
        0.0
    };
    let anchor_pressure = column_imbalance * (0.5 + jsmath::min(1.5, jack_pressure / 150.0))
        + jsmath::max(0.0, quantile(&column_rates, 0.9) - 7.0) * 0.04;
    let ln_release_pressure = if !release_times.is_empty() {
        count_in_window(&release_times, 5000.0) / 5.0 + quantile(&tail_rates, 0.9) * 0.15
    } else {
        0.0
    };
    let ln_density = if duration_ms > 0.0 { total_hold_ms / (duration_ms * kc_div) } else { 0.0 };
    let ln_chord_pressure = if hold_rows != 0.0 { ln_chord_rows / hold_rows } else { 0.0 };
    let ln_hold_duration_avg = average(&hold_durations);
    let ln_hold_duration_p90 = quantile(&hold_durations, 0.9);
    hold_events.sort_by(|l, r| {
        let d = l.0 - r.0;
        if d != 0.0 && !d.is_nan() {
            return cmp_num(l.0, r.0);
        }
        cmp_num(r.1, l.1)
    });
    let mut active_holds = 0f64;
    let mut active_hold_peak = 0f64;
    let mut active_hold_area = 0f64;
    let mut previous_hold_event_time = hold_events.first().map(|e| e.0).unwrap_or(0.0);
    for &(etime, delta) in &hold_events {
        active_hold_area += jsmath::max(0.0, etime - previous_hold_event_time) * active_holds;
        active_holds = jsmath::max(0.0, active_holds + delta);
        active_hold_peak = jsmath::max(active_hold_peak, active_holds);
        previous_hold_event_time = etime;
    }
    let average_active_holds = if duration_ms > 0.0 { active_hold_area / duration_ms } else { 0.0 };
    let ln_overlap_pressure = average_active_holds + active_hold_peak * 0.35;
    let chord_size_change_rate = if !ordered_rows.is_empty() { chord_size_changes / n_rows } else { 0.0 };
    let direction_change_rate = if !notes.is_empty() { direction_changes / n_notes } else { 0.0 };
    let chordjack_pressure = jack_pressure * (0.28 + chord_ratio * 1.35) + burst_density * chord_ratio * 0.6;
    let chord_column_overlap_ratio =
        if chord_pair_count != 0.0 { chord_pair_overlap_count / chord_pair_count } else { 0.0 };
    let adjacent_column_rehit_share = if !notes.is_empty() { adjacent_column_rehit_notes / n_notes } else { 0.0 };
    let two_back_column_rehit_share = if !notes.is_empty() { two_back_column_rehit_notes / n_notes } else { 0.0 };
    let two_back_column_rehit_excess = two_back_column_rehit_share - adjacent_column_rehit_share;
    let tech_pressure = if !ordered_rows.is_empty() {
        (direction_changes / n_rows) * 4.4
            + (chord_size_changes / n_rows) * 3.5
            + chord_ratio * 1.6
            + average(&row_densities) * 0.018
    } else {
        0.0
    };

    let metrics = DanFeatureMetrics {
        key_count: key_count as f64,
        note_count: n_notes,
        duration_ms,
        hold_ratio,
        chord_ratio,
        two_note_chord_ratio,
        peak_nps1s,
        peak_nps5s,
        nps5s_p50,
        nps5s_p90,
        nps5s_p95,
        sustained_nps10s,
        sustained_nps30s,
        sustained_nps60s,
        active_nps,
        long_gap_ratio,
        long_gap_count,
        jack_pressure,
        stream_pressure,
        jumpstream_pressure,
        chordjack_pressure,
        chord_column_overlap_ratio,
        adjacent_column_rehit_share,
        two_back_column_rehit_share,
        two_back_column_rehit_excess,
        tech_pressure,
        row_burst_pressure,
        fast_row_ratio,
        row_interval_entropy,
        off_grid_row_share: off_grid_share,
        pattern_variety,
        row_pattern_entropy,
        row_pattern_variety,
        repeated_row_pattern_ratio,
        alternating_row_pattern_ratio,
        row_pattern_change_rate,
        row_motif_repeat_ratio,
        rhythm_motif_repeat_ratio,
        adjacent_motif_repeat_ratio,
        strain_spikiness: spikiness,
        sustained_pressure_ratio,
        anchor_pressure,
        ln_release_pressure,
        ln_density,
        ln_overlap_pressure,
        ln_chord_pressure,
        ln_hold_duration_avg,
        ln_hold_duration_p90,
        chord_size_change_rate,
        direction_change_rate,
        stamina_pressure: sustained_nps10s,
    };

    DanFeatureExtractionResult { notes, note_times, duration_ms, ordered_rows, metrics, warnings }
}
