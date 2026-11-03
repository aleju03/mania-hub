use crate::jsnum::round_fixed;
use crate::types::ParsedView;

#[inline]
pub fn clamp(value: f64, min: f64, max: f64) -> f64 {
    jsmath::max(min, jsmath::min(max, value))
}

#[inline]
pub fn safe_div(a: f64, b: f64, fallback: f64) -> f64 {
    if !a.is_finite() || !b.is_finite() || b.abs() < 1e-9 {
        return fallback;
    }
    a / b
}

#[inline]
pub fn fmt4(value: Option<f64>) -> Option<f64> {
    match value {
        Some(v) if v.is_finite() => Some(round_fixed(v, 4)),
        _ => None,
    }
}

pub fn sort_asc(values: &mut [f64]) {
    values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
}

pub fn sort_desc(values: &mut [f64]) {
    values.sort_by(|a, b| b.partial_cmp(a).unwrap_or(std::cmp::Ordering::Equal));
}

pub fn quantile_from_sorted(sorted: &[f64], q: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let t = clamp(q, 0.0, 1.0) * (sorted.len() - 1) as f64;
    let left = t.floor();
    let li = left as usize;
    let ri = (sorted.len() - 1).min(li + 1);
    let w = t - left;
    sorted[li] * (1.0 - w) + sorted[ri] * w
}

pub struct ParsedRef<'a, P: ParsedView>(pub &'a P);

impl<P: ParsedView> ParsedRef<'_, P> {
    pub fn ln_ratio_or0(&self) -> f64 {
        or0(self.0.ln_ratio())
    }
    pub fn column_count_or0(&self) -> f64 {
        or0(self.0.column_count())
    }
}

#[inline]
pub fn or0(x: f64) -> f64 {
    if x.is_nan() || x == 0.0 { 0.0 } else { x }
}
