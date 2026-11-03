use crate::core::*;
use crate::{OdFlag, OsuFileParser, ParseStatus, ReworkError, ReworkStar};

pub fn calculate_daniel(chart: &OsuFileParser, speed_rate: f64, _od_flag: OdFlag) -> Result<ReworkStar, ReworkError> {
    let or0 = |v: f64| if v.is_nan() || v == 0.0 { 0.0 } else { v };
    let ln_ratio = or0(chart.ln_ratio);
    let column_count = or0(chart.column_count);
    match chart.status {
        ParseStatus::Fail => return Err(ReworkError::ParseFailed),
        ParseStatus::NotMania => return Err(ReworkError::NotMania),
        ParseStatus::Ok | ParseStatus::Init => {}
    }
    if column_count != 4.0 {
        return Err(ReworkError::UnsupportedKeys);
    }
    let od = 9.0f64;
    let time_scale = if speed_rate != 0.0 { 1.0 / speed_rate } else { 1.0 };
    let n_raw = chart.columns.len();
    let mut raw: Vec<(f64, f64)> = Vec::with_capacity(n_raw);
    for i in 0..n_raw {
        let k = chart.columns[i];
        let h = (chart.note_starts[i] * time_scale).floor();
        raw.push((k, h));
    }
    if raw.is_empty() {
        return Err(ReworkError::ParseFailed);
    }
    if raw.iter().any(|n| n.0.is_nan() || n.1.is_nan()) {
        return Err(ReworkError::Throw("NaN column or note time"));
    }
    raw.sort_by(|a, b| {
        if a.1 != b.1 {
            a.1.partial_cmp(&b.1).unwrap()
        } else {
            a.0.partial_cmp(&b.0).unwrap()
        }
    });
    const KK: usize = 4;
    let mut x = 0.3 * jsmath::sqrt((64.5 - (od * 3.0).ceil()) / 500.0);
    x = jsmath::min(x, 0.6 * (x - 0.09) + 0.09);
    let big_t = raw[raw.len() - 1].1 + 1.0;
    if big_t <= 0.0 {
        return Err(ReworkError::ParseFailed);
    }
    if raw.iter().any(|n| !(n.0 >= 0.0 && n.0 < 4.0 && n.0.fract() == 0.0)) {
        return Err(ReworkError::Throw("TypeError: column outside key count"));
    }
    let note_seq: Vec<(usize, f64)> = raw.iter().map(|&(k, h)| (k as usize, h)).collect();
    drop(raw);
    let mut heads_by_col: Vec<Vec<f64>> = vec![Vec::new(); KK];
    for &(k, h) in &note_seq {
        heads_by_col[k].push(h);
    }

    let mut base_vals = Vec::with_capacity(note_seq.len() * 4 + 2);
    let mut a_vals = Vec::with_capacity(note_seq.len() * 3 + 2);
    for &(_, h) in &note_seq {
        base_vals.push(h);
        base_vals.push(h + 501.0);
        base_vals.push(h - 499.0);
        base_vals.push(h + 1.0);
        a_vals.push(h);
        a_vals.push(h + 1000.0);
        a_vals.push(h - 1000.0);
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

    let mut ku = vec![false; nb * KK];
    for &(k, h) in &note_seq {
        let start = jsmath::max(h - 150.0, 0.0);
        let end = jsmath::min(h + 150.0, big_t - 1.0);
        let l = bx.left(start);
        let r = bx.left(end);
        for idx in l..r {
            ku[idx * KK + k] = true;
        }
    }

    let anchor = {
        let mut ku400 = vec![0.0f64; nb * KK];
        let k400_scale = 3.75 / jsmath::pow(400.0, 2.0);
        for &(k, h) in &note_seq {
            let l400 = bx.left(h - 400.0);
            let c = bx.left(h);
            let r400 = bx.left(h + 400.0);
            if c < nb {
                ku400[c * KK + k] += 3.75;
            }
            for idx in l400..c {
                ku400[idx * KK + k] += 3.75 - k400_scale * jsmath::pow(base[idx] - h, 2.0);
            }
            for idx in (c + 1)..r400 {
                ku400[idx * KK + k] += 3.75 - k400_scale * jsmath::pow(base[idx] - h, 2.0);
            }
        }
        let mut anchor = vec![0.0f64; nb];
        let mut counts = [0.0f64; KK];
        for idx in 0..nb {
            counts.copy_from_slice(&ku400[idx * KK..idx * KK + KK]);
            counts.sort_by(|a, b| b.partial_cmp(a).unwrap());
            let nz = counts.iter().take_while(|&&v| v > 0.0).count();
            let mut raw = 0.0f64;
            if nz > 1 {
                let mut walk = 0.0f64;
                let mut max_walk = 0.0f64;
                for i in 0..nz - 1 {
                    let ratio = counts[i + 1] / counts[i];
                    let weight = 1.0 - 4.0 * jsmath::pow(0.5 - ratio, 2.0);
                    walk += counts[i] * weight;
                    max_walk += counts[i];
                }
                raw = if max_walk > 0.0 { walk / max_walk } else { 0.0 };
            }
            anchor[idx] = 1.0 + jsmath::min(raw - 0.18, 5.0 * jsmath::pow(raw - 0.22, 3.0));
        }
        anchor
    };

    let mut delta_ks: Vec<Vec<f64>> = Vec::with_capacity(KK);
    let jbar_base = {
        let x_pow_quarter = 0.11 * jsmath::pow(x, 0.25);
        let mut jbar_ks: Vec<Vec<f64>> = Vec::with_capacity(KK);
        for k in 0..KK {
            let mut jks = vec![0.0f64; nb];
            let mut dks = vec![1e9f64; nb];
            let notes = &heads_by_col[k];
            for i in 0..notes.len().saturating_sub(1) {
                let start = notes[i];
                let end = notes[i + 1];
                if end <= start {
                    continue;
                }
                let l = bx.left(start);
                let r = bx.left(end);
                if l >= r {
                    continue;
                }
                let delta = 0.001 * (end - start);
                let val = jsmath::pow(delta, -1.0) * jsmath::pow(delta + x_pow_quarter, -1.0) * jack_nerfer(delta);
                for idx in l..r {
                    jks[idx] = val;
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
            for k in 0..KK {
                let v = jbar_ks[k][i];
                let w = 1.0 / jsmath::max(delta_ks[k][i], 1e-9);
                num += jsmath::pow(jsmath::max(v, 0.0), 5.0) * w;
                den += w;
            }
            jbar[i] = jsmath::pow(num / jsmath::max(den, 1e-9), 0.2);
        }
        jbar
    };
    let jbar = interp_values(&all, &base, &jbar_base);
    drop(jbar_base);

    let xbar_base = {
        let cc = CROSS_MATRIX[KK];
        let mut xks = vec![0.0f64; (KK + 1) * nb];
        let mut fast = vec![0.0f64; (KK + 1) * nb];
        let mut pair: Vec<f64> = Vec::new();
        for k in 0..=KK {
            let heads: &[f64] = if k == 0 {
                &heads_by_col[0]
            } else if k == KK {
                &heads_by_col[KK - 1]
            } else {
                merge_heads(&heads_by_col[k - 1], &heads_by_col[k], &mut pair);
                &pair
            };
            for i in 1..heads.len() {
                let start = heads[i - 1];
                let end = heads[i];
                if end <= start {
                    continue;
                }
                let l = bx.left(start);
                let r = bx.left(end);
                if r <= l {
                    continue;
                }
                let delta = 0.001 * (end - start);
                let mut val = 0.16 * jsmath::pow(jsmath::max(x, delta), -2.0);
                let active = |i: usize, c: isize| i < nb && c >= 0 && (c as usize) < KK && ku[i * KK + c as usize];
                let kc = k as isize;
                let left_inactive = !active(l, kc - 1) && !active(r, kc - 1);
                let right_inactive = !active(l, kc) && !active(r, kc);
                if left_inactive || right_inactive {
                    val *= 1.0 - cc[k];
                }
                let fast_val = jsmath::max(
                    0.0,
                    0.4 * jsmath::pow(jsmath::max(jsmath::max(delta, 0.06), 0.75 * x), -2.0) - 80.0,
                );
                for v in &mut xks[k * nb + l..k * nb + r] {
                    *v = val;
                }
                for v in &mut fast[k * nb + l..k * nb + r] {
                    *v = fast_val;
                }
            }
        }
        let mut x_base = vec![0.0f64; nb];
        for i in 0..nb {
            let mut sum1 = 0.0f64;
            let mut sum2 = 0.0f64;
            for k in 0..=KK {
                sum1 += xks[k * nb + i] * cc[k];
            }
            for k in 0..KK {
                let p = fast[k * nb + i] * cc[k] * fast[(k + 1) * nb + i] * cc[k + 1];
                if p > 0.0 {
                    sum2 += jsmath::sqrt(p);
                }
            }
            x_base[i] = sum1 + sum2;
        }
        smooth_on_corners(&base, &x_base, 500.0, 0.001, false)
    };
    let xbar = interp_values(&all, &base, &xbar_base);
    drop(xbar_base);

    let pbar_base = {
        let stream_booster = |delta: f64| -> f64 {
            let bpm = jsmath::max(0.0, jsmath::min(7.5 / jsmath::max(delta, 1e-9), 420.0));
            let primary = 0.10 / (1.0 + jsmath::exp(-0.06 * (bpm - 175.0)));
            let secondary = if bpm >= 200.0 && bpm <= 350.0 {
                0.30 * (1.0 - jsmath::exp(-0.02 * (bpm - 200.0)))
            } else {
                0.0
            };
            1.0 + primary + secondary
        };
        let mut p_step = vec![0.0f64; nb];
        let x_inv = jsmath::pow(x, -1.0);
        let x_sixth = x / 6.0;
        let x_half = x / 2.0;
        let two_thirds_x = (2.0 * x) / 3.0;
        let base_inc = jsmath::pow(0.08 * x_inv * (1.0 - 24.0 * x_inv * jsmath::pow(x_sixth, 2.0)), 0.25);
        let spike = 1000.0 * jsmath::pow(0.02 * (4.0 / x - 24.0), 0.25);
        for i in 0..note_seq.len().saturating_sub(1) {
            let hl = note_seq[i].1;
            let hr = note_seq[i + 1].1;
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
            if r <= l {
                continue;
            }
            let delta = 0.001 * delta_time;
            let b_val = stream_booster(delta);
            let inc = if delta < two_thirds_x {
                jsmath::pow(delta, -1.0)
                    * jsmath::pow(0.08 * x_inv * (1.0 - 24.0 * x_inv * jsmath::pow(delta - x_half, 2.0)), 0.25)
                    * jsmath::max(b_val, 1.0)
            } else {
                jsmath::pow(delta, -1.0) * base_inc * jsmath::max(b_val, 1.0)
            };
            for idx in l..r {
                let boosted = inc * anchor[idx];
                p_step[idx] += jsmath::min(boosted, jsmath::max(inc, inc * 2.0 - 10.0));
            }
        }
        smooth_on_corners(&base, &p_step, 500.0, 0.001, false)
    };
    let pbar = interp_values(&all, &base, &pbar_base);
    drop(pbar_base);

    let abar_base = {
        let mut active: Vec<usize> = Vec::with_capacity(KK);
        let pairs_at = |i: usize, active: &mut Vec<usize>| {
            active.clear();
            for k in 0..KK {
                if ku[i * KK + k] {
                    active.push(k);
                }
            }
        };
        let mut dks = vec![0.0f64; (KK - 1) * nb];
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
            let idx = bi.min(nb - 1);
            pairs_at(idx, &mut active);
            for j in 0..active.len().saturating_sub(1) {
                let k0 = active[j];
                let k1 = active[j + 1];
                let d_val = dks[k0 * nb + idx];
                let dk0 = delta_ks[k0][idx];
                let dk1 = delta_ks[k1][idx];
                if d_val < 0.02 {
                    a_step[i] *= jsmath::min(0.75 + 0.5 * jsmath::max(dk0, dk1), 1.0);
                } else if d_val < 0.07 {
                    a_step[i] *= jsmath::min(0.65 + 5.0 * d_val + 0.5 * jsmath::max(dk0, dk1), 1.0);
                }
            }
        }
        smooth_on_corners(&a_corners, &a_step, 250.0, 1.0, true)
    };
    let abar = interp_values(&all, &a_corners, &abar_base);
    drop(abar_base);

    let (c_step, ks_step) = {
        let mut hit: Vec<f64> = note_seq.iter().map(|n| n.1).collect();
        hit.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let mut c = vec![0.0f64; nb];
        let (mut lo, mut hi) = (0usize, 0usize);
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
        }
        let mut ks = vec![0.0f64; nb];
        for i in 0..nb {
            let mut count = 0usize;
            for k in 0..KK {
                if ku[i * KK + k] {
                    count += 1;
                }
            }
            ks[i] = jsmath::max(count as f64, 1.0);
        }
        (c, ks)
    };
    let c_arr = step_interp(&all, &base, &c_step, false);
    let ks_arr = step_interp(&all, &base, &ks_step, false);

    let na = all.len();
    let mut d_all = vec![0.0f64; na];
    for i in 0..na {
        let a3 = jsmath::pow(abar[i], 3.0 / ks_arr[i]);
        let left_part = 0.4 * jsmath::pow(a3 * jsmath::min(jbar[i], 8.0 + 0.85 * jbar[i]), 1.5);
        let right_part = 0.6 * jsmath::pow(jsmath::pow(abar[i], 2.0 / 3.0) * (0.8 * pbar[i]), 1.5);
        let s_all = jsmath::pow(left_part + right_part, 2.0 / 3.0);
        let t_all = (a3 * xbar[i]) / (xbar[i] + s_all + 1.0);
        d_all[i] = 2.7 * jsmath::pow(s_all, 0.5) * jsmath::pow(t_all, 1.5) + s_all * 0.27;
    }

    let gaps = corner_gaps(&all);
    let eff: Vec<f64> = (0..na).map(|i| c_arr[i] * at(&gaps, i as isize)).collect();
    let Some(agg) = aggregate(&d_all, &eff, true, true) else {
        return Ok(ReworkStar { star: 0.0, ln_ratio, column_count });
    };
    let mut sr = (0.88 * agg.percentile93) * 0.25 + (0.94 * agg.percentile83) * 0.2 + agg.weighted_mean * 0.55;
    let n = note_seq.len() as f64;
    sr *= n / (n + 60.0);
    sr = rescale_high(sr) * 0.975;
    Ok(ReworkStar { star: sr, ln_ratio, column_count })
}
