#[inline]
pub fn at(arr: &[f64], i: isize) -> f64 {
    if i >= 0 && (i as usize) < arr.len() {
        arr[i as usize]
    } else {
        f64::NAN
    }
}

#[inline]
pub fn bisect_left(arr: &[f64], target: f64) -> usize {
    let mut lo = 0usize;
    let mut hi = arr.len();
    while lo < hi {
        let mid = (lo + hi) >> 1;
        if arr[mid] < target {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    lo
}

#[inline]
pub fn bisect_right(arr: &[f64], target: f64) -> usize {
    let mut lo = 0usize;
    let mut hi = arr.len();
    while lo < hi {
        let mid = (lo + hi) >> 1;
        if arr[mid] <= target {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    lo
}

pub fn cumulative_sum(x: &[f64], f: &[f64]) -> Vec<f64> {
    let mut big_f = vec![0.0f64; x.len()];
    for i in 1..x.len() {
        big_f[i] = big_f[i - 1] + f[i - 1] * (x[i] - x[i - 1]);
    }
    big_f
}

struct CumsumCursor {
    p: usize,
}

impl CumsumCursor {
    #[inline]
    fn query(&mut self, q: f64, x: &[f64], big_f: &[f64], f: &[f64]) -> f64 {
        let n = x.len();
        if q <= x[0] {
            return 0.0;
        }
        if q >= x[n - 1] {
            return big_f[big_f.len() - 1];
        }
        while self.p + 1 < n && x[self.p + 1] <= q {
            self.p += 1;
        }
        big_f[self.p] + f[self.p] * (q - x[self.p])
    }
}

pub fn smooth_on_corners(x: &[f64], f: &[f64], window: f64, scale: f64, avg: bool) -> Vec<f64> {
    let n = x.len();
    let mut g = vec![0.0f64; f.len()];
    if n == 0 {
        return g;
    }
    let big_f = cumulative_sum(x, f);
    let x0 = x[0];
    let xl = x[n - 1];
    let mut ca = CumsumCursor { p: 0 };
    let mut cb = CumsumCursor { p: 0 };
    for i in 0..n {
        let s = x[i];
        let a = jsmath::max(s - window, x0);
        let b = jsmath::min(s + window, xl);
        let val = cb.query(b, x, &big_f, f) - ca.query(a, x, &big_f, f);
        if avg {
            g[i] = if b - a > 0.0 { val / (b - a) } else { 0.0 };
        } else {
            g[i] = scale * val;
        }
    }
    g
}

pub fn interp_values(new_x: &[f64], old_x: &[f64], old_vals: &[f64]) -> Vec<f64> {
    let mut out = vec![0.0f64; new_x.len()];
    if new_x.is_empty() {
        return out;
    }
    let first = at(old_x, 0);
    let last = at(old_x, old_x.len() as isize - 1);
    let mut idx = 0usize;
    for i in 0..new_x.len() {
        let x = new_x[i];
        if x <= first {
            out[i] = at(old_vals, 0);
            continue;
        }
        if x >= last {
            out[i] = at(old_vals, old_vals.len() as isize - 1);
            continue;
        }
        while idx + 1 < old_x.len() && old_x[idx + 1] < x {
            idx += 1;
        }
        let x0 = old_x[idx];
        let x1 = old_x[idx + 1];
        let y0 = old_vals[idx];
        let y1 = old_vals[idx + 1];
        if x1 == x0 {
            out[i] = y0;
            continue;
        }
        let t = (x - x0) / (x1 - x0);
        out[i] = y0 + t * (y1 - y0);
    }
    out
}

pub fn step_interp(new_x: &[f64], old_x: &[f64], old_vals: &[f64], strict: bool) -> Vec<f64> {
    let mut out = vec![0.0f64; new_x.len()];
    let mut idx = 0usize;
    for i in 0..new_x.len() {
        let x = new_x[i];
        if strict {
            while idx + 1 < old_x.len() && old_x[idx + 1] < x {
                idx += 1;
            }
        } else {
            while idx + 1 < old_x.len() && old_x[idx + 1] <= x {
                idx += 1;
            }
        }
        let clamped = (idx as isize).min(old_vals.len() as isize - 1).max(0);
        out[i] = at(old_vals, clamped);
    }
    out
}

#[inline]
pub fn rescale_high(sr: f64) -> f64 {
    if sr <= 9.0 {
        return sr;
    }
    9.0 + (sr - 9.0) * (1.0 / 1.2)
}

pub fn merge_heads(a: &[f64], b: &[f64], out: &mut Vec<f64>) {
    out.clear();
    out.reserve(a.len() + b.len());
    let (mut i, mut j) = (0usize, 0usize);
    while i < a.len() && j < b.len() {
        if a[i] <= b[j] {
            out.push(a[i]);
            i += 1;
        } else {
            out.push(b[j]);
            j += 1;
        }
    }
    out.extend_from_slice(&a[i..]);
    out.extend_from_slice(&b[j..]);
}

#[inline]
pub fn jack_nerfer(delta: f64) -> f64 {
    1.0 - 7e-5 * jsmath::pow(0.15 + (delta - 0.08).abs(), -4.0)
}

pub const TARGET_PERCENTILES: [f64; 8] = [0.945, 0.935, 0.925, 0.915, 0.845, 0.835, 0.825, 0.815];

pub const CROSS_MATRIX: [&[f64]; 11] = [
    &[-1.0],
    &[0.075, 0.075],
    &[0.125, 0.05, 0.125],
    &[0.125, 0.125, 0.125, 0.125],
    &[0.175, 0.25, 0.05, 0.25, 0.175],
    &[0.175, 0.25, 0.175, 0.175, 0.25, 0.175],
    &[0.225, 0.35, 0.25, 0.05, 0.25, 0.35, 0.225],
    &[0.225, 0.35, 0.25, 0.225, 0.225, 0.25, 0.35, 0.225],
    &[0.275, 0.45, 0.35, 0.25, 0.05, 0.25, 0.35, 0.45, 0.275],
    &[0.275, 0.45, 0.35, 0.25, 0.275, 0.275, 0.25, 0.35, 0.45, 0.275],
    &[0.325, 0.55, 0.45, 0.35, 0.25, 0.05, 0.25, 0.35, 0.45, 0.55, 0.325],
];

pub fn sorted_unique_in_range(mut values: Vec<f64>, t_max: f64) -> Vec<f64> {
    values.retain(|&s| s >= 0.0 && s <= t_max);
    values.sort_unstable_by(|a, b| a.partial_cmp(b).unwrap());
    values.dedup();
    values
}

const TABLE_MAX_SPAN: f64 = 4_000_000.0;

#[inline]
fn is_int(v: f64) -> bool {
    v == v.trunc()
}

pub fn corner_set(values: Vec<f64>, t_max: f64) -> Vec<f64> {
    if !(t_max >= 0.0 && t_max <= TABLE_MAX_SPAN && is_int(t_max)) || !values.iter().all(|&v| is_int(v)) {
        return sorted_unique_in_range(values, t_max);
    }
    let span = t_max as usize + 1;
    let mut seen = vec![0u64; span.div_ceil(64)];
    for &v in &values {
        if v >= 0.0 && v <= t_max {
            let i = v as usize;
            seen[i >> 6] |= 1u64 << (i & 63);
        }
    }
    let mut out = Vec::with_capacity(values.len() / 2 + 2);
    for (w, &bits) in seen.iter().enumerate() {
        let mut b = bits;
        while b != 0 {
            let tz = b.trailing_zeros() as usize;
            out.push(((w << 6) + tz) as f64);
            b &= b - 1;
        }
    }
    out
}

pub struct CornerIndex<'a> {
    corners: &'a [f64],
    lower: Vec<u32>,
    span: f64,
}

impl<'a> CornerIndex<'a> {
    pub fn new(corners: &'a [f64]) -> Self {
        let last = corners.last().copied().unwrap_or(-1.0);
        let usable = !corners.is_empty()
            && corners[0] >= 0.0
            && last <= TABLE_MAX_SPAN
            && corners.len() < u32::MAX as usize
            && corners.iter().all(|&c| is_int(c));
        if !usable {
            return CornerIndex { corners, lower: Vec::new(), span: -1.0 };
        }
        let span = last as usize;
        let mut lower = vec![0u32; span + 1];
        let mut j = 0usize;
        for (v, slot) in lower.iter_mut().enumerate() {
            while (corners[j] as usize) < v {
                j += 1;
            }
            *slot = j as u32;
        }
        CornerIndex { corners, lower, span: last }
    }

    #[inline]
    pub fn left(&self, target: f64) -> usize {
        if self.span >= 0.0 && is_int(target) {
            if target <= 0.0 {
                return if target <= self.corners[0] { 0 } else { bisect_left(self.corners, target) };
            }
            if target > self.span {
                return self.corners.len();
            }
            return self.lower[target as usize] as usize;
        }
        bisect_left(self.corners, target)
    }

    #[inline]
    pub fn right(&self, target: f64) -> usize {
        if self.span >= 0.0 && is_int(target) && target.abs() < 9.0e15 {
            return self.left(target + 1.0);
        }
        bisect_right(self.corners, target)
    }
}

pub fn merge_unique(a: &[f64], b: &[f64]) -> Vec<f64> {
    let mut out = Vec::with_capacity(a.len() + b.len());
    let (mut i, mut j) = (0usize, 0usize);
    while i < a.len() && j < b.len() {
        if a[i] < b[j] {
            out.push(a[i]);
            i += 1;
        } else if b[j] < a[i] {
            out.push(b[j]);
            j += 1;
        } else {
            out.push(a[i]);
            i += 1;
            j += 1;
        }
    }
    out.extend_from_slice(&a[i..]);
    out.extend_from_slice(&b[j..]);
    out
}

pub fn corner_gaps(ac: &[f64]) -> Vec<f64> {
    let n = ac.len() as isize;
    let len = ac.len().max(1);
    let mut gaps = vec![0.0f64; len];
    gaps[0] = (at(ac, 1) - at(ac, 0)) / 2.0;
    let last = gaps.len() - 1;
    gaps[last] = (at(ac, n - 1) - at(ac, n - 2)) / 2.0;
    for i in 1..(ac.len().saturating_sub(1)) {
        gaps[i] = (ac[i + 1] - ac[i - 1]) / 2.0;
    }
    gaps
}

pub fn sorted_indices(d: &[f64]) -> Vec<usize> {
    if d.iter().any(|v| v.is_nan()) {
        let mut idx: Vec<usize> = (0..d.len()).collect();
        jsmath::js_sort_by(&mut idx, |&a, &b| d[a] - d[b]);
        return idx;
    }
    if d.len() < u32::MAX as usize && d.iter().all(|v| v.to_bits() >> 63 == 0) {
        return radix_sort_indices(d);
    }
    let mut keyed: Vec<(f64, u32)> = d.iter().enumerate().map(|(i, &v)| (v, i as u32)).collect();
    keyed.sort_unstable_by(|a, b| a.0.partial_cmp(&b.0).unwrap().then(a.1.cmp(&b.1)));
    keyed.into_iter().map(|(_, i)| i as usize).collect()
}

fn radix_sort_indices(d: &[f64]) -> Vec<usize> {
    const BITS: u32 = 11;
    const BUCKETS: usize = 1 << BITS;
    let n = d.len();
    let mut a: Vec<(u64, u32)> = d.iter().enumerate().map(|(i, v)| (v.to_bits(), i as u32)).collect();
    let mut b: Vec<(u64, u32)> = vec![(0, 0); n];
    let mut shift = 0u32;
    while shift < 63 {
        let mut count = [0usize; BUCKETS];
        for e in &a {
            count[((e.0 >> shift) as usize) & (BUCKETS - 1)] += 1;
        }
        if count.iter().any(|&c| c == n) {
            shift += BITS;
            continue;
        }
        let mut pos = 0usize;
        for c in count.iter_mut() {
            let next = pos + *c;
            *c = pos;
            pos = next;
        }
        for e in &a {
            let digit = ((e.0 >> shift) as usize) & (BUCKETS - 1);
            b[count[digit]] = *e;
            count[digit] += 1;
        }
        std::mem::swap(&mut a, &mut b);
        shift += BITS;
    }
    a.into_iter().map(|(_, i)| i as usize).collect()
}

pub struct Aggregate {
    pub percentile93: f64,
    pub percentile83: f64,
    pub weighted_mean: f64,
}

pub fn aggregate(d_all: &[f64], effective_weights: &[f64], den_floor: bool, daniel_guard: bool) -> Option<Aggregate> {
    let order = sorted_indices(d_all);
    let n = order.len();
    let mut d_sorted = Vec::with_capacity(n);
    let mut w_sorted = Vec::with_capacity(n);
    for &i in &order {
        d_sorted.push(d_all[i]);
        w_sorted.push(at(effective_weights, i as isize));
    }
    let mut cum = Vec::with_capacity(n);
    let mut running = 0.0f64;
    for &w in &w_sorted {
        running += w;
        cum.push(running);
    }
    let total_weight = at(&cum, n as isize - 1);
    if daniel_guard && (!total_weight.is_finite() || total_weight <= 0.0) {
        return None;
    }
    let mut idxs = [0usize; 8];
    {
        for (slot, &p) in idxs.iter_mut().zip(TARGET_PERCENTILES.iter()) {
            let (mut lo, mut hi) = (0usize, n);
            while lo < hi {
                let mid = (lo + hi) >> 1;
                if cum[mid] / total_weight < p {
                    lo = mid + 1;
                } else {
                    hi = mid;
                }
            }
            *slot = lo;
        }
    }
    let pick = |idx: usize| at(&d_sorted, (idx as isize).min(n as isize - 1));
    let mut s1 = 0.0f64;
    for &i in &idxs[0..4] {
        s1 += pick(i);
    }
    let mut s2 = 0.0f64;
    for &i in &idxs[4..8] {
        s2 += pick(i);
    }
    let percentile93 = s1 / 4.0;
    let percentile83 = s2 / 4.0;
    let mut num = 0.0f64;
    let mut den = 0.0f64;
    for i in 0..n {
        num += jsmath::pow(d_sorted[i], 5.0) * w_sorted[i];
        den += w_sorted[i];
    }
    let weighted_mean = if den_floor {
        jsmath::pow(num / jsmath::max(den, 1e-9), 0.2)
    } else {
        jsmath::pow(num / den, 1.0 / 5.0)
    };
    Some(Aggregate { percentile93, percentile83, weighted_mean })
}
