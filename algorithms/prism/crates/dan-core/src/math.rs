use crate::js::{sort_nums, NumMap};

pub fn clamp(value: f64, min: f64, max: f64) -> f64 {
    jsmath::max(min, jsmath::min(max, value))
}

pub fn clamp01(value: f64) -> f64 {
    clamp(value, 0.0, 1.0)
}

pub fn gate_when(condition: bool, value: f64) -> f64 {
    if condition {
        value
    } else {
        0.0
    }
}

pub fn min_gate(values: &[f64]) -> f64 {
    let mut m = f64::INFINITY;
    for &v in values {
        m = jsmath::min(m, v);
    }
    clamp01(m)
}

pub fn quantile(values: &[f64], q: f64) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let index = quantile_index(values.len(), q);
    let mut copy = values.to_vec();
    if copy.iter().any(|v| v.is_nan() || (*v == 0.0 && v.is_sign_negative())) {
        return quickselect(&mut copy, index);
    }
    let (_, nth, _) = copy.select_nth_unstable_by(index, |a, b| a.partial_cmp(b).unwrap());
    *nth
}

pub fn quantiles(values: &[f64], qs: &[f64]) -> Vec<f64> {
    if values.is_empty() {
        return qs.iter().map(|_| 0.0).collect();
    }
    let mut sorted = values.to_vec();
    sort_nums(&mut sorted);
    qs.iter().map(|&q| sorted[quantile_index(sorted.len(), q)]).collect()
}

fn quantile_index(length: usize, q: f64) -> usize {
    let raw = ((length as f64 - 1.0) * q).floor();
    jsmath::min(length as f64 - 1.0, jsmath::max(0.0, raw)) as usize
}

fn quickselect(values: &mut [f64], target: usize) -> f64 {
    let mut left: isize = 0;
    let mut right: isize = values.len() as isize - 1;
    let target = target as isize;
    while left < right {
        let pivot_index = partition(values, left as usize, right as usize, ((left + right) as f64 / 2.0).floor() as usize) as isize;
        if target == pivot_index {
            return values[target as usize];
        }
        if target < pivot_index {
            right = pivot_index - 1;
        } else {
            left = pivot_index + 1;
        }
    }
    values[left as usize]
}

fn partition(values: &mut [f64], left: usize, right: usize, pivot_index: usize) -> usize {
    let pivot_value = values[pivot_index];
    values.swap(pivot_index, right);
    let mut store_index = left;
    for index in left..right {
        if values[index] < pivot_value {
            values.swap(store_index, index);
            store_index += 1;
        }
    }
    values.swap(right, store_index);
    store_index
}

pub fn count_in_window(times: &[f64], window_ms: f64) -> f64 {
    let mut best = 0f64;
    let mut start = 0usize;
    for end in 0..times.len() {
        while times[end] - times[start] > window_ms {
            start += 1;
        }
        best = jsmath::max(best, (end - start + 1) as f64);
    }
    best
}

pub fn average(values: &[f64]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let mut sum = 0.0;
    for &v in values {
        sum += v;
    }
    sum / values.len() as f64
}

pub fn bucket_entropy(values: &[f64], bucket_size: f64) -> f64 {
    if values.is_empty() || bucket_size <= 0.0 {
        return 0.0;
    }
    let mut buckets: NumMap<f64> = NumMap::new();
    for &value in values {
        let bucket = jsmath::round(value / bucket_size) * bucket_size;
        let slot = buckets.entry_or_insert_with(bucket, || 0.0);
        *slot += 1.0;
    }
    let mut entropy = 0.0;
    let n = values.len() as f64;
    for &count in buckets.values() {
        let probability = count / n;
        entropy -= probability * jsmath::log2(probability);
    }
    entropy
}

pub fn bucket_values(values: &[f64], bucket_size: f64) -> Vec<f64> {
    if bucket_size <= 0.0 {
        return values.to_vec();
    }
    values.iter().map(|&v| jsmath::round(v / bucket_size) * bucket_size).collect()
}

pub fn rao_quadratic_entropy_log(values: &[f64], log_iterations: usize) -> f64 {
    if values.len() < 2 {
        return 0.0;
    }
    let mut counts: NumMap<f64> = NumMap::new();
    for &value in values {
        *counts.entry_or_insert_with(value, || 0.0) += 1.0;
    }
    let total = values.len() as f64;
    let mut entropy = 0.0;
    for &(left, left_count) in &counts.entries {
        for &(right, right_count) in &counts.entries {
            let mut distance = (left - right).abs();
            for _ in 0..log_iterations {
                distance = jsmath::log1p(distance);
            }
            entropy += (left_count / total) * (right_count / total) * distance;
        }
    }
    entropy
}

pub fn power_mean(values: &[f64], weights: &[f64], exponent: f64) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let mut weight_sum = 0.0;
    for &w in weights {
        weight_sum += w;
    }
    if weight_sum <= 0.0 {
        return 0.0;
    }
    let mut sum = 0.0;
    for (index, &value) in values.iter().enumerate() {
        sum += jsmath::pow(value, exponent) * weight_at(weights, index);
    }
    jsmath::pow(sum / weight_sum, 1.0 / exponent)
}

#[inline]
fn weight_at(weights: &[f64], index: usize) -> f64 {
    weights.get(index).copied().unwrap_or(f64::NAN)
}

pub fn strain_spikiness(values: &[f64], weights: &[f64]) -> f64 {
    if values.len() < 3 {
        return 0.0;
    }
    let mean = power_mean(values, weights, 5.0);
    if mean <= 0.0 {
        return 0.0;
    }
    let mut weight_sum = 0.0;
    for &w in weights {
        weight_sum += w;
    }
    if weight_sum <= 0.0 {
        return 0.0;
    }
    let mut sum = 0.0;
    for (index, &value) in values.iter().enumerate() {
        let diff = jsmath::pow(value, 8.0) - jsmath::pow(mean, 8.0);
        sum += diff * diff * weight_at(weights, index);
    }
    let variance = sum / weight_sum;
    jsmath::sqrt(jsmath::pow(variance, 1.0 / 8.0)) / mean
}
