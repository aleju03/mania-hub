use std::borrow::Cow;

use crate::core::*;
use crate::{OdFlag, OsuFileParser, ParseStatus, ReworkError, ReworkStar, SPREAD_LIMIT_WORKER_THREAD};
use jsmath::to_int32;

#[derive(Clone, Copy)]
struct Note {
    k: usize,
    h: f64,
    t: f64,
}

pub(crate) fn resolve_od(chart_od: f64, flag: OdFlag) -> f64 {
    match flag {
        OdFlag::Chart => chart_od,
        OdFlag::Hr => 6.462 + 0.715 * chart_od,
        OdFlag::Ez => -20.761 + 2.566 * chart_od,
        OdFlag::Value(v) => {
            if v.is_finite() {
                v
            } else {
                chart_od
            }
        }
    }
}

pub fn calculate_sunny(
    chart: &OsuFileParser,
    speed_rate: f64,
    od_flag: OdFlag,
    cvt_flag: Option<&str>,
) -> Result<ReworkStar, ReworkError> {
    calculate_sunny_with_spread_limit(chart, speed_rate, od_flag, cvt_flag, SPREAD_LIMIT_WORKER_THREAD)
}

pub fn calculate_sunny_with_spread_limit(
    chart: &OsuFileParser,
    speed_rate: f64,
    od_flag: OdFlag,
    cvt_flag: Option<&str>,
    spread_limit: usize,
) -> Result<ReworkStar, ReworkError> {
    let needs_in = cvt_flag.is_some_and(|c| !c.is_empty() && c.contains("IN"));
    let needs_ho = cvt_flag.is_some_and(|c| !c.is_empty() && c.contains("HO"));
    let p: Cow<OsuFileParser> = if needs_in || needs_ho {
        let mut c = chart.clone();
        if needs_in {
            c.mod_in();
        }
        if needs_ho {
            c.mod_ho();
        }
        Cow::Owned(c)
    } else {
        Cow::Borrowed(chart)
    };
    let ln_ratio = p.get_ln_ratio();
    let column_count = p.get_column_count();

    match p.status {
        ParseStatus::Fail => return Err(ReworkError::ParseFailed),
        ParseStatus::NotMania => return Err(ReworkError::NotMania),
        ParseStatus::Ok | ParseStatus::Init => {}
    }

    let od = resolve_od(p.od, od_flag);
    let time_scale = if speed_rate != 0.0 { 1.0 / speed_rate } else { 1.0 };

    let big_k = column_count;
    let n_raw = p.columns.len();
    let mut raw: Vec<(f64, f64, f64)> = Vec::with_capacity(n_raw);
    for i in 0..n_raw {
        let k = p.columns[i];
        let mut h = p.note_starts[i];
        let mut t = if (to_int32(p.note_types[i]) & 128) != 0 { p.note_ends[i] } else { -1.0 };
        h = (h * time_scale).floor();
        t = if t >= 0.0 { (t * time_scale).floor() } else { t };
        raw.push((k, h, t));
    }

    let mut x = 0.3 * jsmath::sqrt((64.5 - (od * 3.0).ceil()) / 500.0);
    x = jsmath::min(x, 0.6 * (x - 0.09) + 0.09);

    let n_after_shift = raw.len().saturating_sub(1);
    if big_k > 4294967295.0 {
        return Err(ReworkError::Throw("RangeError: Invalid array length"));
    }
    if n_after_shift > spread_limit {
        return Err(ReworkError::Throw("RangeError: Maximum call stack size exceeded"));
    }
    if n_after_shift == 0 || big_k <= 0.0 {
        return Err(ReworkError::ParseFailed);
    }
    if big_k.is_nan() {
        return Err(ReworkError::Throw("TypeError: NaN key count"));
    }
    if big_k > 4096.0 {
        return Err(ReworkError::Throw("key count outside the ported domain"));
    }
    if raw.iter().any(|n| n.0.is_nan() || n.1.is_nan() || n.2.is_nan()) {
        return Err(ReworkError::Throw("NaN column or note time"));
    }
    raw.sort_by(|a, b| {
        if a.1 != b.1 {
            a.1.partial_cmp(&b.1).unwrap()
        } else {
            a.0.partial_cmp(&b.0).unwrap()
        }
    });
    raw.remove(0);

    let kk = big_k as usize;
    if raw.iter().any(|n| !(n.0 >= 0.0 && n.0 < big_k && n.0.fract() == 0.0)) {
        return Err(ReworkError::Throw("TypeError: column outside key count"));
    }
    let note_seq: Vec<Note> = raw.iter().map(|&(k, h, t)| Note { k: k as usize, h, t }).collect();
    drop(raw);

    let mut heads_by_col: Vec<Vec<f64>> = vec![Vec::new(); kk];
    for n in &note_seq {
        heads_by_col[n.k].push(n.h);
    }
    let ln_seq: Vec<Note> = note_seq.iter().copied().filter(|n| n.t >= 0.0).collect();
    let mut tail_seq = ln_seq.clone();
    tail_seq.sort_by(|a, b| a.t.partial_cmp(&b.t).unwrap());

    let mut max_head = f64::NEG_INFINITY;
    let mut max_tail = f64::NEG_INFINITY;
    for n in &note_seq {
        max_head = jsmath::max(max_head, n.h);
        max_tail = jsmath::max(max_tail, n.t);
    }
    let big_t = jsmath::max(max_head, max_tail) + 1.0;

    let mut base_vals = Vec::with_capacity(note_seq.len() * 8 + 2);
    let mut a_vals = Vec::with_capacity(note_seq.len() * 6 + 2);
    {
        let mut push_corner = |s: f64| {
            base_vals.push(s);
            base_vals.push(s + 501.0);
            base_vals.push(s - 499.0);
            base_vals.push(s + 1.0);
            a_vals.push(s);
            a_vals.push(s + 1000.0);
            a_vals.push(s - 1000.0);
        };
        for n in &note_seq {
            push_corner(n.h);
            if n.t >= 0.0 {
                push_corner(n.t);
            }
        }
    }
    base_vals.push(0.0);
    base_vals.push(big_t);
    a_vals.push(0.0);
    a_vals.push(big_t);
    let base = corner_set(base_vals, big_t);
    let a_corners = corner_set(a_vals, big_t);
    let all = merge_unique(&base, &a_corners);
    let nb = base.len();
    let bx = CornerIndex::new(&base);

    let mut ku = vec![false; nb * kk];
    for n in &note_seq {
        let start = jsmath::max(n.h - 150.0, 0.0);
        let end = if n.t < 0.0 { n.h + 150.0 } else { jsmath::min(n.t + 150.0, big_t - 1.0) };
        let l = bx.left(start);
        let r = bx.left(end);
        for idx in l..r.max(l) {
            ku[idx * kk + n.k] = true;
        }
    }

    let anchor = {
        let mut ku400 = vec![0.0f64; nb * kk];
        let corner_coeff = 3.75 / jsmath::pow(400.0, 2.0);
        for n in &note_seq {
            let start = jsmath::max(n.h, 0.0);
            let end = if n.t < 0.0 { n.h } else { jsmath::min(n.t, big_t - 1.0) };
            let l400 = bx.left(start - 400.0);
            let l = bx.left(start);
            let r = bx.left(end);
            let r400 = bx.left(end + 400.0);
            let ramp = 3.75 + jsmath::min(end - start, 1500.0) / 150.0;
            for idx in l..r {
                ku400[idx * kk + n.k] += ramp;
            }
            for idx in l400..l {
                ku400[idx * kk + n.k] += 3.75 - corner_coeff * jsmath::pow(base[idx] - start, 2.0);
            }
            for idx in r..r400 {
                ku400[idx * kk + n.k] += 3.75 - corner_coeff * jsmath::pow((base[idx] - end).abs(), 2.0);
            }
        }
        let mut anchor = vec![0.0f64; nb];
        let mut counts: Vec<f64> = Vec::with_capacity(kk);
        for idx in 0..nb {
            counts.clear();
            counts.extend_from_slice(&ku400[idx * kk..idx * kk + kk]);
            counts.sort_by(|a, b| b.partial_cmp(a).unwrap());
            counts.retain(|&v| v != 0.0);
            let a = if counts.len() > 1 {
                let mut walk = 0.0f64;
                let mut max_walk = 0.0f64;
                for i in 0..counts.len() - 1 {
                    walk += counts[i] * (1.0 - 4.0 * jsmath::pow(0.5 - (counts[i + 1] / counts[i]), 2.0));
                    max_walk += counts[i];
                }
                walk / max_walk
            } else {
                0.0
            };
            anchor[idx] = 1.0 + jsmath::min(a - 0.18, 5.0 * jsmath::pow(a - 0.22, 3.0));
        }
        anchor
    };

    let mut delta_ks: Vec<Vec<f64>> = Vec::with_capacity(kk);
    let jbar_base = {
        let x_term = 0.11 * jsmath::pow(x, 0.25);
        let mut jbar_ks: Vec<Vec<f64>> = Vec::with_capacity(kk);
        for k in 0..kk {
            let mut jks = vec![0.0f64; nb];
            let mut dks = vec![1e9f64; nb];
            let notes = &heads_by_col[k];
            for i in 0..notes.len().saturating_sub(1) {
                let start = notes[i];
                let end = notes[i + 1];
                let l = bx.left(start);
                let r = bx.left(end);
                if l >= r {
                    continue;
                }
                let delta = 0.001 * (end - start);
                let val = jsmath::pow(delta, -1.0) * jsmath::pow(delta + x_term, -1.0);
                let j_val = val * jack_nerfer(delta);
                for idx in l..r {
                    jks[idx] = j_val;
                    dks[idx] = delta;
                }
            }
            jbar_ks.push(smooth_on_corners(&base, &jks, 500.0, 0.001, false));
            delta_ks.push(dks);
        }
        let mut jbar = vec![0.0f64; nb];
        for i in 0..nb {
            let mut num = 0.0f64;
            let mut den = 0.0f64;
            for k in 0..kk {
                let v = jbar_ks[k][i];
                let w = 1.0 / delta_ks[k][i];
                num += jsmath::pow(jsmath::max(v, 0.0), 5.0) * w;
                den += w;
            }
            let raw = num / jsmath::max(1e-9, den);
            jbar[i] = jsmath::pow(raw, 1.0 / 5.0);
        }
        jbar
    };
    let jbar = interp_values(&all, &base, &jbar_base);
    drop(jbar_base);

    let xbar_base = if kk < 1 || kk > 10 {
        vec![0.0f64; nb]
    } else {
        let cc = CROSS_MATRIX[kk];
        let mut xks = vec![0.0f64; (kk + 1) * nb];
        let mut fast = vec![0.0f64; (kk + 1) * nb];
        let mut pair: Vec<f64> = Vec::new();
        for k in 0..=kk {
            let heads: &[f64] = if k == 0 {
                &heads_by_col[0]
            } else if k == kk {
                &heads_by_col[kk - 1]
            } else {
                merge_heads(&heads_by_col[k - 1], &heads_by_col[k], &mut pair);
                &pair
            };
            for i in 1..heads.len() {
                let start = heads[i - 1];
                let end = heads[i];
                let is = bx.left(start);
                let ie = bx.left(end);
                if is >= ie {
                    continue;
                }
                let delta = 0.001 * (end - start);
                let mut val = 0.16 * jsmath::pow(jsmath::max(x, delta), -2.0);
                let li = is.min(nb - 1);
                let ri = ie.min(nb - 1);
                let active = |i: usize, c: isize| c >= 0 && (c as usize) < kk && ku[i * kk + c as usize];
                let kc = k as isize;
                if (!active(li, kc - 1) && !active(ri, kc - 1)) || (!active(li, kc) && !active(ri, kc)) {
                    val *= 1.0 - cc[k];
                }
                let f = jsmath::max(
                    0.0,
                    0.4 * jsmath::pow(jsmath::max(jsmath::max(delta, 0.06), 0.75 * x), -2.0) - 80.0,
                );
                let row = &mut xks[k * nb..(k + 1) * nb];
                for v in &mut row[is..ie] {
                    *v = val;
                }
                let row = &mut fast[k * nb..(k + 1) * nb];
                for v in &mut row[is..ie] {
                    *v = f;
                }
            }
        }
        let mut x_base = vec![0.0f64; nb];
        for i in 0..nb {
            let mut sum1 = 0.0f64;
            for k in 0..=kk {
                sum1 += xks[k * nb + i] * cc[k];
            }
            let mut sum2 = 0.0f64;
            for k in 0..kk {
                sum2 += jsmath::sqrt(fast[k * nb + i] * cc[k] * fast[(k + 1) * nb + i] * cc[k + 1]);
            }
            x_base[i] = sum1 + sum2;
        }
        smooth_on_corners(&base, &x_base, 500.0, 0.001, false)
    };
    let xbar = interp_values(&all, &base, &xbar_base);
    drop(xbar_base);

    let (ln_points, ln_cumsum, ln_values) = {
        let mut events: Vec<(f64, f64)> = Vec::with_capacity(ln_seq.len() * 3);
        for n in &ln_seq {
            let t0 = jsmath::min(n.h + 60.0, n.t);
            let t1 = jsmath::min(n.h + 120.0, n.t);
            events.push((t0, 1.3));
            events.push((t1, -1.3 + 1.0));
            events.push((n.t, -1.0));
        }
        events.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
        let mut keys: Vec<(f64, f64)> = Vec::new();
        for &(t, d) in &events {
            match keys.last_mut() {
                Some(last) if last.0 == t => {
                    last.1 = last.1 + d;
                }
                _ => keys.push((t, 0.0 + d)),
            }
        }
        let mut pts: Vec<f64> = keys.iter().map(|e| e.0).collect();
        pts.push(0.0);
        pts.push(big_t);
        pts.sort_by(|a, b| a.partial_cmp(b).unwrap());
        pts.dedup();
        let mut values = Vec::with_capacity(pts.len());
        let mut cumsum = Vec::with_capacity(pts.len());
        cumsum.push(0.0f64);
        let mut curr = 0.0f64;
        let mut kp = 0usize;
        for i in 0..pts.len().saturating_sub(1) {
            let t = pts[i];
            while kp < keys.len() && keys[kp].0 < t {
                kp += 1;
            }
            if kp < keys.len() && keys[kp].0 == t {
                curr += keys[kp].1;
            }
            let v = jsmath::min(curr, 2.5 + 0.5 * curr);
            values.push(v);
            let seg = pts[i + 1] - pts[i];
            cumsum.push(cumsum[cumsum.len() - 1] + seg * v);
        }
        (pts, cumsum, values)
    };
    let ln_sum = |a: f64, b: f64| -> f64 {
        let i = bisect_right(&ln_points, a) as isize - 1;
        let j = bisect_right(&ln_points, b) as isize - 1;
        if i == j {
            return (b - a) * at(&ln_values, i);
        }
        let mut total = 0.0f64;
        total += (at(&ln_points, i + 1) - a) * at(&ln_values, i);
        total += at(&ln_cumsum, j) - at(&ln_cumsum, i + 1);
        total += (b - at(&ln_points, j)) * at(&ln_values, j);
        total
    };

    let pbar_base = {
        let stream_booster = |delta: f64| -> f64 {
            let expr = 7.5 / delta;
            if 160.0 < expr && expr < 360.0 {
                return 1.0 + 1.7e-7 * (expr - 160.0) * jsmath::pow(expr - 360.0, 2.0);
            }
            1.0
        };
        let mut p_step = vec![0.0f64; nb];
        let x_inv = jsmath::pow(x, -1.0);
        let two_thirds_x = (2.0 * x) / 3.0;
        let base_inc = jsmath::pow(0.08 * x_inv * (1.0 - 24.0 * x_inv * jsmath::pow(x / 6.0, 2.0)), 0.25);
        let spike = 1000.0 * jsmath::pow(0.02 * (4.0 / x - 24.0), 0.25);
        for i in 0..note_seq.len().saturating_sub(1) {
            let hl = note_seq[i].h;
            let hr = note_seq[i + 1].h;
            let delta_time = hr - hl;
            if delta_time < 1e-9 {
                let l = bx.left(hl);
                let r = bx.right(hl);
                for idx in l..r {
                    p_step[idx] += spike;
                }
                continue;
            }
            let l = bx.left(hl);
            let r = bx.left(hr);
            if l >= r {
                continue;
            }
            let delta = 0.001 * delta_time;
            let v = 1.0 + 6.0 * 0.001 * ln_sum(hl, hr);
            let b_val = stream_booster(delta);
            let inc = if delta < two_thirds_x {
                jsmath::pow(delta, -1.0)
                    * jsmath::pow(0.08 * x_inv * (1.0 - 24.0 * x_inv * jsmath::pow(delta - x / 2.0, 2.0)), 0.25)
                    * jsmath::max(b_val, v)
            } else {
                jsmath::pow(delta, -1.0) * base_inc * jsmath::max(b_val, v)
            };
            let inc_max = jsmath::max(inc, inc * 2.0 - 10.0);
            for idx in l..r {
                p_step[idx] += jsmath::min(inc * anchor[idx], inc_max);
            }
        }
        smooth_on_corners(&base, &p_step, 500.0, 0.001, false)
    };
    let pbar = interp_values(&all, &base, &pbar_base);
    drop(pbar_base);

    let abar_base = {
        let mut active: Vec<usize> = Vec::with_capacity(kk);
        let pairs_at = |i: usize, active: &mut Vec<usize>| {
            active.clear();
            for k in 0..kk {
                if ku[i * kk + k] {
                    active.push(k);
                }
            }
        };
        let nd = kk.saturating_sub(1);
        let mut dks = vec![0.0f64; nd * nb];
        for i in 0..nb {
            pairs_at(i, &mut active);
            for j in 0..active.len().saturating_sub(1) {
                let k0 = active[j];
                let k1 = active[j + 1];
                let d0 = delta_ks[k0][i];
                let d1 = delta_ks[k1][i];
                dks[k0 * nb + i] = (d0 - d1).abs() + 0.4 * jsmath::max(0.0, jsmath::max(d0, d1) - 0.11);
            }
        }
        let mut a_step = vec![1.0f64; a_corners.len()];
        let mut bi = 0usize;
        for i in 0..a_corners.len() {
            let s = a_corners[i];
            while bi < nb && base[bi] < s {
                bi += 1;
            }
            let idx = if bi >= nb { nb - 1 } else { bi };
            pairs_at(idx, &mut active);
            for j in 0..active.len().saturating_sub(1) {
                let k0 = active[j];
                let k1 = active[j + 1];
                let d_val = dks[k0 * nb + idx];
                if d_val < 0.02 {
                    a_step[i] *= jsmath::min(0.75 + 0.5 * jsmath::max(delta_ks[k0][idx], delta_ks[k1][idx]), 1.0);
                } else if d_val < 0.07 {
                    a_step[i] *= jsmath::min(
                        0.65 + 5.0 * d_val + 0.5 * jsmath::max(delta_ks[k0][idx], delta_ks[k1][idx]),
                        1.0,
                    );
                }
            }
        }
        smooth_on_corners(&a_corners, &a_step, 250.0, 1.0, true)
    };
    let abar = interp_values(&all, &a_corners, &abar_base);
    drop(abar_base);

    let rbar_base = {
        let mut r_step = vec![0.0f64; nb];
        let mut i_list = Vec::with_capacity(tail_seq.len());
        for n in &tail_seq {
            let times = &heads_by_col[n.k];
            let idx = bisect_left(times, n.h);
            let h_j = if idx + 1 < times.len() { times[idx + 1] } else { 1e9 };
            let i_h = 0.001 * (n.t - n.h - 80.0).abs() / x;
            let i_t = 0.001 * (h_j - n.t - 80.0).abs() / x;
            i_list.push(2.0 / (2.0 + jsmath::exp(-5.0 * (i_h - 0.75)) + jsmath::exp(-5.0 * (i_t - 0.75))));
        }
        for i in 0..tail_seq.len().saturating_sub(1) {
            let t_start = tail_seq[i].t;
            let t_end = tail_seq[i + 1].t;
            let l = bx.left(t_start);
            let r = bx.left(t_end);
            if l >= r {
                continue;
            }
            let delta_r = 0.001 * (t_end - t_start);
            let r_value = 0.08
                * jsmath::pow(delta_r, -0.5)
                * jsmath::pow(x, -1.0)
                * (1.0 + 0.8 * (i_list[i] + i_list[i + 1]));
            for v in &mut r_step[l..r] {
                *v = r_value;
            }
        }
        smooth_on_corners(&base, &r_step, 500.0, 0.001, false)
    };
    let rbar = interp_values(&all, &base, &rbar_base);
    drop(rbar_base);

    let (c_step, c_step_v2, ks_step) = {
        let mut hit: Vec<f64> = note_seq.iter().map(|n| n.h).collect();
        hit.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let mut hit2: Vec<f64> = Vec::with_capacity(note_seq.len() + ln_seq.len());
        for n in &note_seq {
            hit2.push(n.h);
            if n.t >= 0.0 {
                hit2.push(n.t);
            }
        }
        hit2.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let mut c = vec![0.0f64; nb];
        let mut c2 = vec![0.0f64; nb];
        let (mut lo, mut hi, mut lo2, mut hi2) = (0usize, 0usize, 0usize, 0usize);
        for i in 0..nb {
            let s = base[i];
            let low = s - 500.0;
            let high = s + 500.0;
            while lo < hit.len() && hit[lo] < low {
                lo += 1;
            }
            while hi < hit.len() && hit[hi] < high {
                hi += 1;
            }
            c[i] = hi as f64 - lo as f64;
            while lo2 < hit2.len() && hit2[lo2] < low {
                lo2 += 1;
            }
            while hi2 < hit2.len() && hit2[hi2] < high {
                hi2 += 1;
            }
            c2[i] = hi2 as f64 - lo2 as f64;
        }
        let mut ks = vec![0.0f64; nb];
        for i in 0..nb {
            let mut count = 0usize;
            for k in 0..kk {
                if ku[i * kk + k] {
                    count += 1;
                }
            }
            ks[i] = jsmath::max(count as f64, 1.0);
        }
        (c, c2, ks)
    };
    let c_arr = step_interp(&all, &base, &c_step, true);
    let c_arr_v2 = step_interp(&all, &base, &c_step_v2, true);
    let ks_arr = step_interp(&all, &base, &ks_step, true);

    let na = all.len();
    let mut d_all = vec![0.0f64; na];
    for i in 0..na {
        let a3 = jsmath::pow(abar[i], 3.0 / ks_arr[i]);
        let left_part = 0.4 * jsmath::pow(a3 * jsmath::min(jbar[i], 8.0 + 0.85 * jbar[i]), 1.5);
        let right_part = 0.6
            * jsmath::pow(
                jsmath::pow(abar[i], 2.0 / 3.0) * (0.8 * pbar[i] + rbar[i] * 35.0 / (c_arr[i] + 8.0)),
                1.5,
            );
        let s_all = jsmath::pow(left_part + right_part, 2.0 / 3.0);
        let t_all = (a3 * xbar[i]) / (xbar[i] + s_all + 1.0);
        d_all[i] = 2.7 * jsmath::pow(s_all, 0.5) * jsmath::pow(t_all, 1.5) + s_all * 0.27;
    }

    let gaps = corner_gaps(&all);
    let eff: Vec<f64> = (0..na).map(|i| c_arr_v2[i] * at(&gaps, i as isize)).collect();
    let agg = aggregate(&d_all, &eff, false, false).expect("sunny has no total-weight guard");

    let mut sr = (0.88 * agg.percentile93) * 0.25 + (0.94 * agg.percentile83) * 0.2 + agg.weighted_mean * 0.55;
    let mut ln_length_term = 0.0f64;
    for n in &ln_seq {
        ln_length_term += jsmath::min(n.t - n.h, 1000.0) / 200.0;
    }
    let total_notes = note_seq.len() as f64 + 0.5 * ln_length_term;
    sr *= total_notes / (total_notes + 60.0);
    sr = rescale_high(sr);
    sr *= 0.975;

    Ok(ReworkStar { star: sr, ln_ratio, column_count })
}
