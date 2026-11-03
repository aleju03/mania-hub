use crate::beatmap::ManiaNote;

const INDIVIDUAL_DECAY_BASE: f64 = 0.125;
const OVERALL_DECAY_BASE: f64 = 0.3;
const RELEASE_THRESHOLD: f64 = 30.0;
const SECTION_LENGTH: f64 = 400.0;
const DECAY_WEIGHT: f64 = 0.9;
const DIFFICULTY_MULTIPLIER: f64 = 0.018;

#[derive(Clone, Copy)]
struct Span {
    start: f64,
    end: f64,
}

pub fn calculate_mania_star_rating(notes: &[ManiaNote], column_count: i32, clock_rate: f64) -> f64 {
    if notes.len() < 2 || column_count <= 0 || !(clock_rate > 0.0) {
        return 0.0;
    }
    if notes.iter().any(|n| n.column < 0 || n.column >= column_count) {
        return f64::NAN;
    }
    let columns = column_count as usize;
    let mut sorted: Vec<(f64, ManiaNote)> = notes.iter().map(|n| (round_half_to_even(n.time), *n)).collect();
    legacy_sort(&mut sorted);

    let mut individual_strains = vec![0.0f64; columns];
    let mut highest_individual_strain = 0.0f64;
    let mut overall_strain = 1.0f64;
    let mut current_strain = 0.0f64;

    let mut strain_peaks: Vec<f64> = Vec::new();
    let mut current_section_peak = 0.0f64;
    let mut current_section_end = 0.0f64;

    let mut last_in_column: Vec<Option<Span>> = vec![None; columns];
    let mut first = true;
    let mut prev_start_time = 0.0f64;

    for i in 1..sorted.len() {
        let note = sorted[i].1;
        let col = note.column as usize;
        let start_time = note.time / clock_rate;
        let end_time = note.end_time / clock_rate;
        let delta_time = (note.time - sorted[i - 1].1.time) / clock_rate;
        let column_strain_time = match last_in_column[col] {
            Some(prev) => start_time - prev.start,
            None => start_time,
        };

        if first {
            current_section_end = (start_time / SECTION_LENGTH).ceil() * SECTION_LENGTH;
            first = false;
        }
        while start_time > current_section_end {
            strain_peaks.push(current_section_peak);
            let elapsed = current_section_end - prev_start_time;
            current_section_peak = apply_decay(highest_individual_strain, elapsed, INDIVIDUAL_DECAY_BASE)
                + apply_decay(overall_strain, elapsed, OVERALL_DECAY_BASE);
            current_section_end += SECTION_LENGTH;
        }

        let span = Span { start: start_time, end: end_time };
        individual_strains[col] = apply_decay(individual_strains[col], column_strain_time, INDIVIDUAL_DECAY_BASE);
        individual_strains[col] += evaluate_individual_strain(span, &last_in_column);
        highest_individual_strain = if delta_time <= 1.0 {
            jsmath::max(highest_individual_strain, individual_strains[col])
        } else {
            individual_strains[col]
        };
        overall_strain = apply_decay(overall_strain, delta_time, OVERALL_DECAY_BASE);
        overall_strain += evaluate_overall_strain(span, &last_in_column);

        current_strain += highest_individual_strain + overall_strain - current_strain;
        current_section_peak = jsmath::max(current_strain, current_section_peak);

        last_in_column[col] = Some(span);
        prev_start_time = start_time;
    }

    strain_peaks.push(current_section_peak);
    aggregate_difficulty(strain_peaks) * DIFFICULTY_MULTIPLIER
}

fn aggregate_difficulty(mut peaks: Vec<f64>) -> f64 {
    peaks.retain(|p| *p > 0.0);
    peaks.sort_by(|a, b| b.partial_cmp(a).unwrap_or(std::cmp::Ordering::Equal));
    let mut difficulty = 0.0;
    let mut weight = 1.0;
    for peak in peaks {
        difficulty += peak * weight;
        weight *= DECAY_WEIGHT;
    }
    difficulty
}

fn evaluate_individual_strain(dho: Span, prevs: &[Option<Span>]) -> f64 {
    let inside_hold = prevs.iter().flatten().any(|prev| definitely_bigger(prev.end, dho.end) && definitely_bigger(dho.start, prev.start));
    2.0 * if inside_hold { 1.25 } else { 1.0 }
}

fn evaluate_overall_strain(dho: Span, prevs: &[Option<Span>]) -> f64 {
    let mut closest_end_time = (dho.end - dho.start).abs();
    let mut hold_factor = 1.0;
    let mut is_overlapping = false;
    for prev in prevs.iter().flatten() {
        is_overlapping = is_overlapping
            || (definitely_bigger(prev.end, dho.start) && definitely_bigger(dho.end, prev.end) && definitely_bigger(dho.start, prev.start));
        if definitely_bigger(prev.end, dho.end) && definitely_bigger(dho.start, prev.start) {
            hold_factor = 1.25;
        }
        closest_end_time = jsmath::min(closest_end_time, (dho.end - prev.end).abs());
    }
    let hold_addition = if is_overlapping { 1.0 / (1.0 + jsmath::exp(0.27 * (RELEASE_THRESHOLD - closest_end_time))) } else { 0.0 };
    (1.0 + hold_addition) * hold_factor
}

fn apply_decay(value: f64, delta_time: f64, decay_base: f64) -> f64 {
    value * jsmath::pow(decay_base, delta_time / 1000.0)
}

fn definitely_bigger(value1: f64, value2: f64) -> bool {
    value1 - 1.0 > value2
}

fn round_half_to_even(value: f64) -> f64 {
    let floor = value.floor();
    let diff = value - floor;
    if diff < 0.5 {
        floor
    } else if diff > 0.5 {
        floor + 1.0
    } else if floor % 2.0 == 0.0 {
        floor
    } else {
        floor + 1.0
    }
}

fn less(a: &(f64, ManiaNote), b: &(f64, ManiaNote)) -> bool {
    a.0 - b.0 < 0.0
}

fn greater(a: &(f64, ManiaNote), b: &(f64, ManiaNote)) -> bool {
    a.0 - b.0 > 0.0
}

fn legacy_sort(keys: &mut [(f64, ManiaNote)]) {
    if keys.is_empty() {
        return;
    }
    let right = keys.len() as isize - 1;
    depth_limited_quick_sort(keys, 0, right, 32);
}

fn depth_limited_quick_sort(keys: &mut [(f64, ManiaNote)], mut left: isize, mut right: isize, mut depth_limit: i32) {
    loop {
        if depth_limit == 0 {
            heapsort(keys, left, right);
            return;
        }
        let mut i = left;
        let mut j = right;
        let middle = i + ((j - i) >> 1);
        swap_if_greater(keys, i, middle);
        swap_if_greater(keys, i, j);
        swap_if_greater(keys, middle, j);

        let x = keys[middle as usize];
        loop {
            while less(&keys[i as usize], &x) {
                i += 1;
            }
            while less(&x, &keys[j as usize]) {
                j -= 1;
            }
            if i > j {
                break;
            }
            if i < j {
                keys.swap(i as usize, j as usize);
            }
            i += 1;
            j -= 1;
            if i > j {
                break;
            }
        }

        depth_limit -= 1;

        if j - left <= right - i {
            if left < j {
                depth_limited_quick_sort(keys, left, j, depth_limit);
            }
            left = i;
        } else {
            if i < right {
                depth_limited_quick_sort(keys, i, right, depth_limit);
            }
            right = j;
        }
        if left >= right {
            break;
        }
    }
}

fn swap_if_greater(keys: &mut [(f64, ManiaNote)], a: isize, b: isize) {
    if a != b && greater(&keys[a as usize], &keys[b as usize]) {
        keys.swap(a as usize, b as usize);
    }
}

fn heapsort(keys: &mut [(f64, ManiaNote)], lo: isize, hi: isize) {
    let n = hi - lo + 1;
    let mut i = n / 2;
    while i >= 1 {
        down_heap(keys, i, n, lo);
        i -= 1;
    }
    let mut i = n;
    while i > 1 {
        keys.swap(lo as usize, (lo + i - 1) as usize);
        down_heap(keys, 1, i - 1, lo);
        i -= 1;
    }
}

fn down_heap(keys: &mut [(f64, ManiaNote)], mut i: isize, n: isize, lo: isize) {
    let d = keys[(lo + i - 1) as usize];
    while i <= n / 2 {
        let mut child = 2 * i;
        if child < n && less(&keys[(lo + child - 1) as usize], &keys[(lo + child) as usize]) {
            child += 1;
        }
        if !less(&d, &keys[(lo + child - 1) as usize]) {
            break;
        }
        keys[(lo + i - 1) as usize] = keys[(lo + child - 1) as usize];
        i = child;
    }
    keys[(lo + i - 1) as usize] = d;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note(column: i32, time: f64, end_time: f64) -> ManiaNote {
        ManiaNote { column, time, end_time, is_hold: end_time > time }
    }

    #[test]
    fn degenerate_inputs() {
        assert_eq!(calculate_mania_star_rating(&[note(0, 0.0, 0.0)], 4, 1.0), 0.0);
        assert_eq!(calculate_mania_star_rating(&[note(0, 0.0, 0.0), note(1, 100.0, 100.0)], 4, 0.0), 0.0);
        assert!(calculate_mania_star_rating(&[note(0, 0.0, 0.0), note(5, 100.0, 100.0)], 4, 1.0).is_nan());
    }

    #[test]
    fn faster_is_harder() {
        let notes: Vec<ManiaNote> = (0..400).map(|i| note(i % 4, i as f64 * 120.0, i as f64 * 120.0)).collect();
        let ht = calculate_mania_star_rating(&notes, 4, 0.75);
        let nm = calculate_mania_star_rating(&notes, 4, 1.0);
        let dt = calculate_mania_star_rating(&notes, 4, 1.5);
        assert!(ht < nm && nm < dt, "{ht} {nm} {dt}");
    }
}
