use std::collections::BTreeMap;

use crate::common::clamp;
use crate::jsnum::{round_fixed, to_int32};
use crate::rc_format::numeric_to_rc_label;
use crate::types::{EstimatorOptions, EstimatorResult, ParseStatus, ParsedView, Upstream};

const WINDOW_MS: f64 = 500.0;
const LN_TAP_MS: f64 = 80.0;

fn max(a: f64, b: f64) -> f64 {
    jsmath::max(a, b)
}

fn min(a: f64, b: f64) -> f64 {
    jsmath::min(a, b)
}

fn lower_bound(sorted: &[f64], value: f64) -> usize {
    let (mut lo, mut hi) = (0usize, sorted.len());
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

fn upper_bound(sorted: &[f64], value: f64) -> usize {
    let (mut lo, mut hi) = (0usize, sorted.len());
    while lo < hi {
        let mid = (lo + hi) >> 1;
        if sorted[mid] <= value {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    lo
}

fn hit_window_unit() -> f64 {
    let x = 0.3 * jsmath::sqrt((64.5 - (9.0f64 * 3.0).ceil()) / 500.0);
    min(x, 0.6 * (x - 0.09) + 0.09)
}

fn window_integral(x: &[f64], f: &[f64], window: f64) -> Vec<f64> {
    let n = x.len();
    let mut out = vec![0.0; n];
    if n < 2 {
        return out;
    }
    let mut prefix = vec![0.0; n];
    for i in 1..n {
        prefix[i] = prefix[i - 1] + f[i - 1] * (x[i] - x[i - 1]);
    }
    let (mut ca, mut cb) = (0usize, 0usize);
    for i in 0..n {
        let a = clamp(x[i] - window, x[0], x[n - 1]);
        let b = clamp(x[i] + window, x[0], x[n - 1]);
        while ca < n && x[ca] < a {
            ca += 1;
        }
        while cb < n && x[cb] < b {
            cb += 1;
        }
        let ia = if ca > 0 { ca - 1 } else { 0 };
        let ib = if cb > 0 { cb - 1 } else { 0 };
        out[i] = (prefix[ib] + f[ib] * (b - x[ib])) - (prefix[ia] + f[ia] * (a - x[ia]));
    }
    out
}

fn window_sum(x: &[f64], f: &[f64], window: f64, scale: f64) -> Vec<f64> {
    let mut out = window_integral(x, f, window);
    for v in out.iter_mut() {
        *v *= scale;
    }
    out
}

fn window_avg(x: &[f64], f: &[f64], window: f64) -> Vec<f64> {
    let n = x.len();
    let mut out = window_integral(x, f, window);
    let (mut ca, mut cb) = (0usize, 0usize);
    for i in 0..n {
        let a = clamp(x[i] - window, x[0], x[n - 1]);
        let b = clamp(x[i] + window, x[0], x[n - 1]);
        while ca < n && x[ca] < a {
            ca += 1;
        }
        while cb < n && x[cb] < b {
            cb += 1;
        }
        let span = b - a;
        out[i] = if span > 0.0 { out[i] / span } else { 0.0 };
    }
    out
}

fn add_span(f: &mut [f64], grid: &[f64], t0: f64, t1: f64, val: f64) {
    if grid.len() < 2 || t1 <= t0 {
        return;
    }
    let mut q = upper_bound(grid, t0);
    if q > 0 {
        q -= 1;
    }
    while q + 1 < grid.len() && grid[q] < t1 {
        let lo = max(t0, grid[q]);
        let hi = min(t1, grid[q + 1]);
        if hi > lo {
            f[q] += val * (hi - lo) / (grid[q + 1] - grid[q]);
        }
        q += 1;
    }
}

#[derive(Clone, Copy, Debug)]
struct Note {
    k: usize,
    h: f64,
    t: f64,
}

#[derive(Clone, Copy, Debug)]
struct Row {
    t: f64,
    mask: u32,
    size: u32,
}

fn head_times(notes: &[Note]) -> Vec<f64> {
    notes.iter().map(|n| n.h).collect()
}

fn column_count(mask: u32) -> u32 {
    (mask & 1) + ((mask >> 1) & 1) + ((mask >> 2) & 1) + ((mask >> 3) & 1)
}

fn build_rows(notes: &[Note]) -> Vec<Row> {
    let mut rows: Vec<Row> = Vec::new();
    for note in notes {
        if rows.last().map_or(true, |r| r.t != note.h) {
            rows.push(Row { t: note.h, mask: 0, size: 0 });
        }
        let row = rows.last_mut().unwrap();
        row.mask |= 1 << note.k;
        row.size = column_count(row.mask);
    }
    rows
}

const TECH_WINDOW_MS: f64 = 244.92;
const TECH_SCALE: f64 = 0.001;

const MOTION_X_COEF: f64 = 0.39104;
const MOTION_W: f64 = 5.7561;
const MOTION_REPEAT_W: f64 = 0.55187;
const FINGER_MIX_P: f64 = 2.3762;
const FLAM_MS: f64 = 11.247;
const FINGER_JACK_CRIT_MS: f64 = 218.21;
const JACK_FLOOR_MS: f64 = 35.809;
const MINIJACK_MS: f64 = 72.836;
const LN_HOLD_OCC: f64 = 0.754;
const ALT_CRIT_MS: f64 = 21.197;

const WRIST_W: f64 = 3.3377;
const WRIST_CHORD_W: f64 = 0.81919;
const WRIST_GAP_POW: f64 = 2.6413;
const WRIST_GAP_PIVOT_MS: f64 = 100.0;
const STROKE_CAP_MS: f64 = 1000.0;
const STROKE_TIE_FRAC: f64 = 0.125;

const CHORD_PHASE: f64 = 0.26009;
const ANCHOR_RUN_LO: f64 = 16.0;
const ANCHOR_RUN_HI: f64 = 48.0;
const MANIP_TOL_MS: f64 = 76.009;
const MANIP_TOL_POW: f64 = 2.6;
const MANIP_WINDOW: usize = 12;
const MANIP_PERIOD_MAX: usize = 12;
const MANIP_PERIOD_COST: f64 = 0.02;
const MANIP_PACE: f64 = 0.25;
const MANIP_PACE_FLOOR_MS: f64 = 4.0;
const MANIP_FLAM_MS: f64 = 10.0;
const MANIP_CONS_LO: f64 = 0.15;
const MANIP_CONS_HI: f64 = 0.75;
const WRIST_BLEND_MS: f64 = 64.443;

const JITTER_ONSET_MS: f64 = 95.0;
const JITTER_POW: f64 = 1.5;
const JITTER_REP_LO: f64 = 3.0;
const JITTER_REP_HI: f64 = 7.0;

#[derive(Clone, Copy, Debug)]
struct HandNote {
    t: f64,
    f: usize,
    tail: f64,
}

fn soften_gap(gap_ms: f64) -> f64 {
    jsmath::sqrt(gap_ms * gap_ms + FLAM_MS * FLAM_MS)
}

fn gap_rate(delta_ms: f64, x_term: f64) -> f64 {
    let d = 0.001 * delta_ms;
    if d > 0.0 { (1.0 / d) * (1.0 / (d + x_term)) } else { 0.0 }
}

fn tech_sum(grid: &[f64], f: &[f64]) -> Vec<f64> {
    window_sum(grid, f, TECH_WINDOW_MS, TECH_SCALE)
}

fn smoothstep01(u: f64) -> f64 {
    let t = clamp(u, 0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

fn minijack_gaps(times: &[f64]) -> Vec<f64> {
    let count = if times.len() > 1 { times.len() - 1 } else { 0 };
    let gaps: Vec<f64> = (0..count).map(|i| times[i + 1] - times[i]).collect();
    let mut out = gaps.clone();
    for i in 0..count {
        if gaps[i] >= MINIJACK_MS {
            continue;
        }
        let before = if i > 0 { max(0.5 * (gaps[i - 1] - gaps[i]), 0.0) } else { MINIJACK_MS };
        let after = if i + 1 < count { max(0.5 * (gaps[i + 1] - gaps[i]), 0.0) } else { MINIJACK_MS };
        out[i] = min(gaps[i] + before + after, MINIJACK_MS);
    }
    out
}

fn repeat_cost(hand_notes: &[HandNote], grid: &[f64]) -> Vec<f64> {
    let mut finger_times: [Vec<f64>; 2] = [Vec::new(), Vec::new()];
    for note in hand_notes {
        finger_times[note.f].push(note.t);
    }
    let soft_gaps = [minijack_gaps(&finger_times[0]), minijack_gaps(&finger_times[1])];
    let mut index = [0usize, 0usize];
    let mut rate = vec![0.0; grid.len()];
    let mut last = [-1.0f64, -1.0f64];
    let mut free_at = [0.0f64, 0.0f64];
    for note in hand_notes {
        let f = note.f;
        let l = last[f];
        if l >= 0.0 && note.t > l {
            let raw = soft_gaps[f][index[f] - 1];
            let gap = soften_gap(raw - min(LN_HOLD_OCC * free_at[f], raw - 1.0));
            let c = FINGER_JACK_CRIT_MS / jsmath::sqrt(gap * gap + JACK_FLOOR_MS * JACK_FLOOR_MS);
            let pen = c * c;
            add_span(&mut rate, grid, l, note.t, (1.0 + pen) * gap_rate(gap, 0.0) * raw / (note.t - l));
        }
        index[f] += 1;
        last[f] = note.t;
        free_at[f] = if note.tail >= note.t { max(note.tail - note.t - LN_TAP_MS, 0.0) } else { 0.0 };
    }
    tech_sum(grid, &rate)
}

fn motion_cost(x: f64, hand_notes: &[HandNote], grid: &[f64]) -> Vec<f64> {
    let mut times: Vec<f64> = Vec::new();
    let mut masks: Vec<u32> = Vec::new();
    for note in hand_notes {
        if times.last() == Some(&note.t) {
            *masks.last_mut().unwrap() |= 1 << note.f;
            continue;
        }
        times.push(note.t);
        masks.push(1 << note.f);
    }
    let xt = MOTION_X_COEF * jsmath::pow(x, 0.25);
    let mut rate = vec![0.0; grid.len()];
    let mut i = 0usize;
    while i + 1 < times.len() {
        let gap = soften_gap(times[i + 1] - times[i]);
        let w = if masks[i + 1] == 3 {
            1.0
        } else if masks[i + 1] & masks[i] != 0 {
            MOTION_REPEAT_W
        } else {
            1.0 + (ALT_CRIT_MS / gap) * (ALT_CRIT_MS / gap)
        };
        add_span(&mut rate, grid, times[i], times[i + 1], w * gap_rate(gap, xt));
        i += 1;
    }
    tech_sum(grid, &rate)
}

fn finger_mix(jack: f64, motion: f64) -> f64 {
    let a = jack;
    let b = MOTION_W * motion;
    let hi = max(a, b);
    if hi <= 0.0 {
        return 0.0;
    }
    hi * jsmath::pow(1.0 + jsmath::pow(min(a, b) / hi, FINGER_MIX_P), 1.0 / FINGER_MIX_P)
}

#[derive(Default)]
struct Strokes {
    t: Vec<f64>,
    width: Vec<f64>,
    size: Vec<usize>,
    mask: Vec<u32>,
    first: Vec<usize>,
}

fn group_strokes(hn: &[HandNote]) -> Strokes {
    let mut finger_times: [Vec<f64>; 2] = [Vec::new(), Vec::new()];
    for i in 0..hn.len() {
        let note = hn[i];
        let chord = (i > 0 && hn[i - 1].t == note.t) || (i + 1 < hn.len() && hn[i + 1].t == note.t);
        if !chord {
            finger_times[note.f].push(note.t);
        }
    }
    let mut s = Strokes::default();
    let mut i = 0usize;
    while i < hn.len() {
        let mut j = i + 1;
        if j < hn.len()
            && hn[j].f != hn[i].f
            && hn[j].t - hn[i].t <= STROKE_CAP_MS
            && !(j + 1 < hn.len()
                && hn[j + 1].f == hn[i].f
                && hn[j + 1].t - hn[j].t < (hn[j].t - hn[i].t) * (1.0 - STROKE_TIE_FRAC))
        {
            j += 1;
        }
        s.t.push(0.5 * (hn[i].t + hn[j - 1].t));
        let mut width = hn[j - 1].t - hn[i].t;
        if j - i == 1 {
            let other = &finger_times[1 - hn[i].f];
            let mut d = STROKE_CAP_MS;
            let q = lower_bound(other, hn[i].t);
            if q < other.len() {
                d = min(d, other[q] - hn[i].t);
            }
            if q > 0 {
                d = min(d, hn[i].t - other[q - 1]);
            }
            width = if d < STROKE_CAP_MS { d } else { 0.0 };
        }
        s.width.push(width);
        s.size.push(j - i);
        s.first.push(i);
        let mut mask = 0u32;
        for note in &hn[i..j] {
            mask |= 1 << note.f;
        }
        s.mask.push(mask);
        i = j;
    }
    s
}

fn note_consistency(note_times: &[f64], note_columns: &[usize], i: usize) -> f64 {
    let n = note_times.len();
    let a = if i >= MANIP_WINDOW { i - MANIP_WINDOW } else { 0 };
    let b = n.min(i + MANIP_WINDOW + 1);
    let mut best = 0.0;
    for p in 1..=MANIP_PERIOD_MAX {
        if b < a + p + 4 {
            break;
        }
        let mut miss = 0.0;
        let mut count = 0usize;
        let mut q = a;
        while q + p < b {
            if q + p + 1 >= b {
                break;
            }
            if note_columns[q] != note_columns[q + p] || note_columns[q + 1] != note_columns[q + p + 1] {
                miss += 1.0;
                count += 1;
                q += 1;
                continue;
            }
            let g1 = note_times[q + 1] - note_times[q];
            let g2 = note_times[q + p + 1] - note_times[q + p];
            let med = 0.5 * (g1 + g2);
            let tol = jsmath::sqrt(MANIP_PACE * med * MANIP_PACE * med + MANIP_PACE_FLOOR_MS * MANIP_PACE_FLOOR_MS);
            miss += smoothstep01((g1 - g2).abs() / tol);
            count += 1;
            q += 1;
        }
        if count == 0 {
            continue;
        }
        best = max(best, 1.0 - miss / count as f64 - MANIP_PERIOD_COST * (p as f64 - 1.0));
    }
    best
}

#[derive(Clone, Copy)]
struct ConsEvent {
    t: f64,
    c: usize,
    h: usize,
    q: usize,
}

fn stroke_consistency(hand_notes: &[Vec<HandNote>; 2], strokes: &[Strokes; 2]) -> [Vec<f64>; 2] {
    let mut all: Vec<ConsEvent> = Vec::new();
    for h in 0..2 {
        for (q, note) in hand_notes[h].iter().enumerate() {
            all.push(ConsEvent { t: note.t, c: 2 * h + note.f, h, q });
        }
    }
    all.sort_by(|a, b| a.t.partial_cmp(&b.t).unwrap_or(std::cmp::Ordering::Equal).then(a.c.cmp(&b.c)));
    let mut e = 0usize;
    while e < all.len() {
        let mut f = e + 1;
        while f < all.len() && all[f].t - all[e].t <= MANIP_FLAM_MS {
            all[f].t = all[e].t;
            f += 1;
        }
        all[e..f].sort_by(|a, b| a.c.cmp(&b.c));
        e = f;
    }
    let note_times: Vec<f64> = all.iter().map(|ev| ev.t).collect();
    let note_columns: Vec<usize> = all.iter().map(|ev| ev.c).collect();
    let mut per = [vec![0.0; hand_notes[0].len()], vec![0.0; hand_notes[1].len()]];
    for (e, ev) in all.iter().enumerate() {
        per[ev.h][ev.q] = note_consistency(&note_times, &note_columns, e);
    }
    let mut out: [Vec<f64>; 2] = [Vec::new(), Vec::new()];
    for h in 0..2 {
        let s = &strokes[h];
        out[h] = (0..s.t.len())
            .map(|k| {
                let mut sum = 0.0;
                for q in 0..s.size[k] {
                    sum += per[h][s.first[k] + q];
                }
                sum / s.size[k] as f64
            })
            .collect();
    }
    out
}

struct Wrist {
    cost: Vec<f64>,
    cost_manip: Vec<f64>,
    able: Vec<f64>,
    manip: Vec<f64>,
    jitw: Vec<f64>,
}

fn wrist_cost(hand_notes: &[HandNote], strokes: &Strokes, consistency: &[f64], other_times: &[f64], grid: &[f64]) -> Wrist {
    let n = strokes.t.len();
    let mut chord = vec![0.0; n];
    let mut manip = vec![0.0; n];
    let mut merged = vec![0.0; n];
    let mut strike = vec![0.0; n];
    for k in 0..n {
        let mut period = 0.0;
        if k > 0 {
            period = max(period, strokes.t[k] - strokes.t[k - 1]);
        }
        if k + 1 < n {
            period = max(period, strokes.t[k + 1] - strokes.t[k]);
        }
        let phase = if strokes.width[k] <= 0.0 { 0.0 } else if period > 0.0 { strokes.width[k] / period } else { 1.0 };
        let near = 1.0 - smoothstep01(phase / CHORD_PHASE);
        let pair = strokes.size[k] == 2 && strokes.width[k] > 0.0;
        chord[k] = if pair { 0.0 } else { near };
        let lo = strokes.t[k] - 0.5 * strokes.width[k];
        let hi = strokes.t[k] + 0.5 * strokes.width[k];
        let q = lower_bound(other_times, lo);
        let across = q < other_times.len() && other_times[q] > lo && other_times[q] < hi;
        manip[k] = if pair && !across {
            1.0 - (1.0 - near) * (1.0 - smoothstep01((consistency[k] - MANIP_CONS_LO) / (MANIP_CONS_HI - MANIP_CONS_LO)))
        } else {
            0.0
        };
        merged[k] = 1.0 - (1.0 - chord[k]) * (1.0 - manip[k]);
        strike[k] = if strokes.size[k] == 1 { 1.0 } else { smoothstep01((merged[k] - 0.2) / 0.6) };
    }

    let mut run = vec![0.0; n];
    for f in [1u32, 2u32] {
        let mut forward = vec![0.0; n];
        let mut backward = vec![0.0; n];
        for k in 0..n {
            if strokes.mask[k] & f != 0 {
                forward[k] = strike[k] * (1.0 + if k > 0 && strokes.mask[k - 1] & f != 0 { forward[k - 1] } else { 0.0 });
            }
        }
        for k in (0..n).rev() {
            if strokes.mask[k] & f != 0 {
                backward[k] = strike[k] * (1.0 + if k + 1 < n && strokes.mask[k + 1] & f != 0 { backward[k + 1] } else { 0.0 });
            }
        }
        for k in 0..n {
            if strokes.mask[k] & f != 0 {
                run[k] = max(run[k], forward[k] + backward[k] - strike[k]);
            }
        }
    }

    let mut rep = vec![1.0; n];
    {
        let mut row_times: Vec<f64> = Vec::new();
        let mut row_masks: Vec<u32> = Vec::new();
        let mut row_of = vec![0usize; hand_notes.len()];
        for (q, note) in hand_notes.iter().enumerate() {
            if row_times.last() != Some(&note.t) {
                row_times.push(note.t);
                row_masks.push(0);
            }
            *row_masks.last_mut().unwrap() |= 1 << note.f;
            row_of[q] = row_times.len() - 1;
        }
        let nr = row_times.len();
        let jacked: Vec<bool> = (0..nr)
            .map(|k| (k > 0 && row_masks[k - 1] == row_masks[k]) || (k + 1 < nr && row_masks[k + 1] == row_masks[k]))
            .collect();
        let pace = |g1: f64, g2: f64| 1.0 - smoothstep01(max(g1, g2) / max(min(g1, g2), 1.0) - 2.0);
        let mut same = vec![0.0; nr];
        for k in 1..nr {
            if row_masks[k] == row_masks[k - 1] || (jacked[k] && jacked[k - 1] && row_masks[k] != 3 && row_masks[k - 1] != 3) {
                same[k] = pace(
                    if k >= 2 { row_times[k - 1] - row_times[k - 2] } else { row_times[k] - row_times[k - 1] },
                    row_times[k] - row_times[k - 1],
                );
            }
        }
        let mut forward = vec![0.0; nr];
        let mut backward = vec![0.0; nr];
        for k in 1..nr {
            forward[k] = same[k] * (1.0 + forward[k - 1]);
        }
        for k in (1..nr).rev() {
            backward[k - 1] = same[k] * (1.0 + backward[k]);
        }

        let mut stroke_same = vec![0.0; n];
        for k in 1..n {
            if strokes.mask[k] == strokes.mask[k - 1] {
                stroke_same[k] = pace(
                    if k >= 2 { strokes.t[k - 1] - strokes.t[k - 2] } else { strokes.t[k] - strokes.t[k - 1] },
                    strokes.t[k] - strokes.t[k - 1],
                );
            }
        }
        let mut stroke_forward = vec![0.0; n];
        let mut stroke_backward = vec![0.0; n];
        for k in 1..n {
            stroke_forward[k] = stroke_same[k] * (1.0 + stroke_forward[k - 1]);
        }
        for k in (1..n).rev() {
            stroke_backward[k - 1] = stroke_same[k] * (1.0 + stroke_backward[k]);
        }

        for k in 0..n {
            let r = row_of[strokes.first[k]];
            rep[k] = 1.0 + max(forward[r] + backward[r], stroke_forward[k] + stroke_backward[k]);
        }
    }

    let g = grid.len();
    let mut rate = vec![0.0; g];
    let mut rate_manip = vec![0.0; g];
    let mut able = vec![0.0; g];
    let mut manip_curve = vec![0.0; g];
    let mut jitter_weight = vec![0.0; g];
    let mut i = 0usize;
    while i + 1 < n {
        let gap = strokes.t[i + 1] - strokes.t[i];
        let r = if strokes.mask[i + 1] & strokes.mask[i] != 0 {
            smoothstep01((run[i] - ANCHOR_RUN_LO) / (ANCHOR_RUN_HI - ANCHOR_RUN_LO))
        } else {
            0.0
        };
        let a = 1.0 - (1.0 - chord[i]) * (1.0 - r);
        add_span(&mut able, grid, strokes.t[i], strokes.t[i + 1], a);
        add_span(&mut manip_curve, grid, strokes.t[i], strokes.t[i + 1], manip[i]);
        let j = smoothstep01((rep[i] - JITTER_REP_LO) / (JITTER_REP_HI - JITTER_REP_LO));
        let share = if gap > 0.0 && gap < JITTER_ONSET_MS { jsmath::pow(gap / JITTER_ONSET_MS, JITTER_POW) } else { 1.0 };
        add_span(&mut jitter_weight, grid, strokes.t[i], strokes.t[i + 1], j * min(1.0, (1.0 - share) / 0.1));
        let load = 1.0 + WRIST_CHORD_W * (strokes.size[i + 1] as f64 - 1.0);
        let off = if strokes.size[i + 1] == 2 { strokes.width[i + 1] / MANIP_TOL_MS } else { 0.0 };
        let c = load
            * gap_rate(gap, 0.0)
            * (if gap > 0.0 { jsmath::pow(WRIST_GAP_PIVOT_MS / gap, WRIST_GAP_POW - 2.0) } else { 1.0 })
            * (1.0 - j * (1.0 - share));
        add_span(&mut rate, grid, strokes.t[i], strokes.t[i + 1], c);
        add_span(&mut rate_manip, grid, strokes.t[i], strokes.t[i + 1], c * (1.0 + jsmath::pow(off, MANIP_TOL_POW)));
        i += 1;
    }

    Wrist {
        cost: tech_sum(grid, &rate).into_iter().map(|v| v * WRIST_W).collect(),
        cost_manip: tech_sum(grid, &rate_manip).into_iter().map(|v| v * WRIST_W).collect(),
        able: window_avg(grid, &able, WRIST_BLEND_MS),
        manip: window_avg(grid, &manip_curve, WRIST_BLEND_MS),
        jitw: window_avg(grid, &jitter_weight, WRIST_BLEND_MS),
    }
}

fn hand_cost(finger: f64, wrist: &Wrist, index: usize) -> f64 {
    let w = clamp(wrist.able[index], 0.0, 1.0);
    let m = clamp(wrist.manip[index], 0.0, 1.0);
    let h = (1.0 - w) * ((1.0 - m) * finger + m * min(finger, wrist.cost_manip[index])) + w * wrist.cost[index];
    let j = clamp(wrist.jitw[index], 0.0, 1.0);
    (1.0 - j) * h + j * min(h, wrist.cost_manip[index])
}

fn technique_strain(x: f64, by_column: &[Vec<Note>; 4], grid: &[f64]) -> ([Vec<f64>; 2], [Vec<f64>; 2]) {
    let mut hand_notes: [Vec<HandNote>; 2] = [Vec::new(), Vec::new()];
    for h in 0..2 {
        let list = &mut hand_notes[h];
        for c in 2 * h..2 * h + 2 {
            for note in &by_column[c] {
                list.push(HandNote { t: note.h, f: c - 2 * h, tail: note.t });
            }
        }
        list.sort_by(|a, b| a.t.partial_cmp(&b.t).unwrap_or(std::cmp::Ordering::Equal).then(a.f.cmp(&b.f)));
    }
    let strokes = [group_strokes(&hand_notes[0]), group_strokes(&hand_notes[1])];
    let consistency = stroke_consistency(&hand_notes, &strokes);

    let mut out: [Vec<f64>; 2] = [Vec::new(), Vec::new()];
    let mut able: [Vec<f64>; 2] = [Vec::new(), Vec::new()];
    for h in 0..2 {
        let notes = &hand_notes[h];
        let jack = repeat_cost(notes, grid);
        let motion = motion_cost(x, notes, grid);
        let other: Vec<f64> = hand_notes[1 - h].iter().map(|n| n.t).collect();
        let wrist = wrist_cost(notes, &strokes[h], &consistency[h], &other, grid);
        out[h] = vec![0.0; grid.len()];
        able[h] = vec![0.0; grid.len()];
        for i in 0..grid.len() {
            out[h][i] = hand_cost(finger_mix(jack[i], motion[i]), &wrist, i);
            let w = clamp(wrist.able[i], 0.0, 1.0);
            let m = clamp(wrist.manip[i], 0.0, 1.0);
            able[h][i] = w + (1.0 - w) * m;
        }
    }
    (out, able)
}

const STAMINA_GAIN: f64 = 2.2908;
const STAMINA_PROP: f64 = 0.90996;
const STAMINA_CAP: f64 = 1.6526;
const STAMINA_TANK: f64 = 50.918;
const STAMINA_REFILL_REST_MS: f64 = 5000.0;
const STAMINA_REFILL_LEVEL_MS: f64 = 15000.0;
const STAM_INTERVAL_MS: f64 = 500.0;
const STAMINA_DURABILITY: f64 = 0.029925;
const STAMINA_LEVEL_POW: f64 = 5.0;
const STAMINA_EASY: f64 = 0.17545;
const STAMINA_EASY_WINDOW_MS: f64 = 4000.0;

fn map_level(grid: &[f64], strain: &[Vec<f64>; 2], weight: &[Vec<f64>; 2]) -> f64 {
    let n = strain[0].len();
    let both: Vec<f64> = (0..n).map(|i| 0.5 * (strain[0][i] + strain[1][i])).collect();
    let g = window_avg(grid, &both, STAMINA_EASY_WINDOW_MS);
    let mut acc = 0.0;
    let mut total_weight = 0.0;
    for h in 0..2 {
        for i in 0..n {
            if !(g[i] > 0.0) {
                continue;
            }
            let wd = jsmath::pow(g[i], STAMINA_LEVEL_POW) * weight[h][i];
            acc += wd * g[i];
            total_weight += wd;
        }
    }
    if total_weight <= 0.0 || acc <= 0.0 {
        return 0.0;
    }
    let easy = STAMINA_EASY * acc / total_weight;
    let mut acc5 = 0.0;
    let mut weight5 = 0.0;
    for h in 0..2 {
        for i in 0..n {
            if g[i] < easy {
                continue;
            }
            let d = strain[h][i];
            let d2 = d * d;
            acc5 += d2 * d2 * d * weight[h][i];
            weight5 += weight[h][i];
        }
    }
    if weight5 <= 0.0 || acc5 <= 0.0 {
        return 0.0;
    }
    jsmath::pow(acc5 / weight5, 0.2)
}

fn run_tank(grid: &[f64], strain: &[f64], level: f64) -> Vec<f64> {
    let mut mod_curve = vec![1.0; strain.len()];
    let mut tank = 1.0;
    let mut prev = 0.0;
    let mut work = 0.0;
    for i in 0..strain.len() {
        let step = if i == 0 { 0.0 } else { (grid[i] - grid[i - 1]) / STAM_INTERVAL_MS };
        let average = 0.5 * (prev + strain[i]);
        prev = strain[i];
        let rel = average / level;
        if rel > 1.0 {
            tank -= (rel - 1.0) * step / STAMINA_TANK;
        } else {
            let tau = STAMINA_REFILL_REST_MS + STAMINA_REFILL_LEVEL_MS * rel * rel;
            tank += (1.0 - tank) * (1.0 - jsmath::exp(-step * STAM_INTERVAL_MS / tau));
        }
        tank = max(tank, 0.0);
        work += rel * step * STAM_INTERVAL_MS / 60000.0;
        mod_curve[i] = (1.0 + (STAMINA_CAP - 1.0) * (1.0 - tank)) * (1.0 + STAMINA_DURABILITY * jsmath::sqrt(work));
    }
    mod_curve
}

fn apply_stamina(grid: &[f64], strain: &mut [Vec<f64>; 2], weight: &[Vec<f64>; 2]) {
    let level = STAMINA_PROP * map_level(grid, strain, weight);
    if !(level > 0.0) {
        return;
    }
    for h in 0..2 {
        let m = run_tank(grid, &strain[h], level);
        for (i, v) in m.iter().enumerate() {
            strain[h][i] *= max(0.0, 1.0 + STAMINA_GAIN * (v - 1.0));
        }
    }
}

const HAND_P_SYNC: f64 = 6.1324;
const HAND_P_ALT: f64 = 2.526;
const SWITCH_MIX: f64 = 0.16864;
const SWITCH_WINDOW_MS: f64 = 500.0;

fn hand_sync(able: &[Vec<f64>; 2], rows: &[Row], grid: &[f64]) -> Vec<f64> {
    let mut points: Vec<f64> = Vec::new();
    let mut changes: Vec<f64> = Vec::new();
    for r in 1..rows.len() {
        let a = rows[r - 1].mask;
        let b = rows[r].mask;
        if rows[r - 1].size != 1 || rows[r].size != 1 {
            continue;
        }
        points.push(rows[r].t);
        changes.push(if ((a & 3) != 0) != ((b & 3) != 0) { 1.0 } else { 0.0 });
    }
    let mut cumulative = vec![0.0; changes.len() + 1];
    for k in 0..changes.len() {
        cumulative[k + 1] = cumulative[k] + changes[k];
    }
    let mut switch_curve = vec![0.0; grid.len()];
    let (mut lo, mut hi) = (0usize, 0usize);
    for i in 0..grid.len() {
        while lo < points.len() && points[lo] < grid[i] - SWITCH_WINDOW_MS {
            lo += 1;
        }
        while hi < points.len() && points[hi] <= grid[i] + SWITCH_WINDOW_MS {
            hi += 1;
        }
        switch_curve[i] = if hi > lo { (cumulative[hi] - cumulative[lo]) / (hi - lo) as f64 } else { 0.0 };
    }
    (0..able[0].len())
        .map(|i| {
            let a = clamp(0.5 * (able[0][i] + able[1][i]), 0.0, 1.0);
            clamp((1.0 - SWITCH_MIX) * a + SWITCH_MIX * (1.0 - switch_curve[i]), 0.0, 1.0)
        })
        .collect()
}

fn combine_hands(strain: &[Vec<f64>; 2], sync: &[f64]) -> Vec<f64> {
    let mut out = vec![0.0; strain[0].len()];
    for i in 0..out.len() {
        let a = max(strain[0][i], 0.0);
        let b = max(strain[1][i], 0.0);
        let hi = max(a, b);
        if hi <= 0.0 {
            continue;
        }
        if min(a, b) <= 0.0 {
            out[i] = hi;
            continue;
        }
        let s = clamp(sync[i], 0.0, 1.0);
        let p = HAND_P_ALT + (HAND_P_SYNC - HAND_P_ALT) * s;
        let lo = min(a, b) / hi;
        out[i] = hi * jsmath::pow(1.0 + jsmath::pow(lo, p), 1.0 / p);
    }
    out
}

const HOLD_PRESS_W: [[f64; 4]; 4] = [
    [0.00, 1.00, 0.20, 0.15],
    [1.00, 0.00, 0.20, 0.20],
    [0.20, 0.20, 0.00, 1.00],
    [0.15, 0.20, 1.00, 0.00],
];
const LN_WEIGHT: f64 = 0.05;
const REL_GAIN: f64 = 0.75;
const REL_MID: f64 = 0.75;
const REL_GAP_WEIGHT: f64 = 0.5;
const LX_GAIN: f64 = 0.8;
const LX_RAMP_MS: f64 = 150.0;
const LX_STACK: f64 = 1.0;

struct HoldCosts {
    rel: Vec<f64>,
    weight: Vec<f64>,
    cross: Vec<f64>,
}

fn hold_costs(x: f64, by_column: &[Vec<Note>; 4], note_sequence: &[Note], grid: &[f64]) -> HoldCosts {
    let mut tail_sequence: Vec<Note> = note_sequence.iter().copied().filter(|n| n.t >= 0.0).collect();
    tail_sequence.sort_by(|a, b| a.t.partial_cmp(&b.t).unwrap_or(std::cmp::Ordering::Equal));
    let g = grid.len();
    let mut release_step = vec![0.0; g];
    let mut weight_step = vec![0.0; g];
    let mut cross_step = vec![0.0; g];
    let inv_x = 1.0 / x;
    let sigmoid = |value: f64| 1.0 / (1.0 + jsmath::exp(-5.0 * (value - REL_MID)));
    let column_times: Vec<Vec<f64>> = by_column.iter().map(|notes| head_times(notes)).collect();

    let mut releases: Vec<Note> = Vec::new();
    let mut intensities: Vec<f64> = Vec::new();
    for note in &tail_sequence {
        let length = note.t - note.h;
        if length <= LN_TAP_MS {
            continue;
        }
        let mut next_head = 1e9;
        let times = &column_times[note.k];
        let index = lower_bound(times, note.h);
        if index + 1 < times.len() {
            next_head = times[index + 1];
        }
        let s_head = sigmoid(0.001 * (length - LN_TAP_MS) * inv_x);
        let s_tail = sigmoid(0.001 * max(next_head - note.t, 0.0) * inv_x);
        releases.push(*note);
        intensities.push((s_head + REL_GAP_WEIGHT * s_tail) / (1.0 + REL_GAP_WEIGHT));
    }
    let mut i = 0usize;
    while i + 1 < releases.len() {
        let t_start = releases[i].t;
        let t_end = releases[i + 1].t;
        if t_end > t_start {
            let delta = 0.001 * (t_end - t_start);
            let value = REL_GAIN * 0.08 / jsmath::sqrt(delta) * inv_x * (1.0 + 0.8 * (intensities[i] + intensities[i + 1]));
            add_span(&mut release_step, grid, t_start, t_end, value);
        }
        i += 1;
    }

    for note in note_sequence {
        if note.t < 0.0 {
            continue;
        }
        add_span(&mut weight_step, grid, note.h, note.h + 1.0, 1000.0 * LN_WEIGHT);
    }

    let holds: Vec<Vec<Note>> = by_column.iter().map(|col| col.iter().copied().filter(|n| n.t >= 0.0).collect()).collect();
    let mut cursor = [0usize; 4];
    for press in note_sequence {
        let t = press.h;
        let mut sum = 0.0;
        let mut worst = 0.0;
        for k in 0..4 {
            if k == press.k {
                continue;
            }
            let column_holds = &holds[k];
            while cursor[k] < column_holds.len() && column_holds[cursor[k]].t < t {
                cursor[k] += 1;
            }
            if cursor[k] >= column_holds.len() {
                continue;
            }
            let hold = column_holds[cursor[k]];
            let d = min(t - hold.h, hold.t - t);
            if d <= 0.0 {
                continue;
            }
            let pair = HOLD_PRESS_W[k][press.k] * min(1.0, d / LX_RAMP_MS);
            sum += pair;
            worst = max(worst, pair);
        }
        if sum <= 0.0 {
            continue;
        }
        let accumulated = worst + LX_STACK * (sum - worst);
        add_span(&mut cross_step, grid, t, t + 1.0, 1000.0 * LX_GAIN * accumulated);
    }

    HoldCosts {
        rel: window_sum(grid, &release_step, WINDOW_MS, 0.001),
        weight: window_sum(grid, &weight_step, WINDOW_MS, 0.001),
        cross: window_sum(grid, &cross_step, WINDOW_MS, 0.001),
    }
}

const RATING_SCALE: f64 = 7.528655953984781;
const AGG_POWER: f64 = 3.8724;
const AGG_TARGET_LOSS: f64 = 0.02;
const SOLVE_STEPS: usize = 40;
const NOTE_DAMP_N: f64 = 60.0;
const SCALE_A: f64 = 30.0;
const SCALE_C: f64 = 290.0;

struct Binned {
    bin: Vec<isize>,
    dp: Vec<f64>,
}

fn bin_strain(strain: &[f64]) -> Binned {
    let mut bin = vec![-1isize; strain.len()];
    let lo = jsmath::log(1e-4);
    let step = jsmath::log(1.01);
    let mut groups: BTreeMap<i64, Vec<usize>> = BTreeMap::new();
    for (i, &s) in strain.iter().enumerate() {
        if !(s > 1e-4) {
            continue;
        }
        let key = ((jsmath::log(s) - lo) / step).trunc() as i64;
        groups.entry(key).or_default().push(i);
    }
    let mut dp: Vec<f64> = Vec::new();
    for indexes in groups.values() {
        let mut sum = 0.0;
        for &index in indexes {
            sum += strain[index];
        }
        for &index in indexes {
            bin[index] = dp.len() as isize;
        }
        dp.push(jsmath::pow(sum / indexes.len() as f64, AGG_POWER));
    }
    Binned { bin, dp }
}

fn solve_skill(bin_weights: &[f64], dp: &[f64], mean_weight: f64) -> f64 {
    let target = AGG_TARGET_LOSS * mean_weight;
    let mut capacity = 0.0;
    let mut max_dp = 0.0;
    for b in 0..bin_weights.len() {
        if bin_weights[b] > 0.0 {
            capacity += bin_weights[b];
            max_dp = max(max_dp, dp[b]);
        }
    }
    if capacity <= target || max_dp <= 0.0 {
        return 0.0;
    }
    let mut lo = jsmath::log(max_dp) - 200.0;
    let mut hi = jsmath::log(max_dp) + 60.0;
    for _ in 0..SOLVE_STEPS {
        let mid = 0.5 * (lo + hi);
        let inv = jsmath::exp(-mid);
        let mut loss = 0.0;
        for b in 0..bin_weights.len() {
            if bin_weights[b] > 0.0 {
                loss += bin_weights[b] * (1.0 - jsmath::exp(-0.05 * dp[b] * inv));
            }
        }
        if loss > target {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    jsmath::exp(0.5 * (lo + hi) / AGG_POWER)
}

fn rating_from_bins(binned: &Binned, weights: &[f64], total_notes: usize) -> f64 {
    let mut total_weight = 0.0;
    for &w in weights {
        total_weight += w;
    }
    if total_weight <= 0.0 {
        return 0.0;
    }
    let mut bin_weights = vec![0.0; binned.dp.len()];
    for (i, &w) in weights.iter().enumerate() {
        if binned.bin[i] >= 0 {
            bin_weights[binned.bin[i] as usize] += w;
        }
    }
    let mut raw = solve_skill(&bin_weights, &binned.dp, total_weight);
    raw *= total_notes as f64 / (total_notes as f64 + NOTE_DAMP_N);
    raw * 0.975 * RATING_SCALE
}

fn note_weights(grid: &[f64], notes: &[Note]) -> Vec<f64> {
    let times = head_times(notes);
    let n = grid.len();
    let mut weights = vec![0.0; n];
    let (mut lo, mut hi) = (0usize, 0usize);
    for i in 0..n {
        while lo < times.len() && times[lo] < grid[i] - WINDOW_MS {
            lo += 1;
        }
        while hi < times.len() && times[hi] < grid[i] + WINDOW_MS {
            hi += 1;
        }
        let gap = if i == 0 {
            (grid[1] - grid[0]) / 2.0
        } else if i == n - 1 {
            (grid[n - 1] - grid[n - 2]) / 2.0
        } else {
            (grid[i + 1] - grid[i - 1]) / 2.0
        };
        weights[i] = (hi - lo) as f64 * gap;
    }
    weights
}

fn rating_points(raw: f64) -> f64 {
    if raw > 0.0 { SCALE_A * jsmath::log1p(raw / SCALE_C) } else { 0.0 }
}

const GRID_MS: f64 = 25.0;
const DUP_MS: f64 = 10.0;
const LN_W: f64 = 3.997;
const LN_X: f64 = 1.3275;

fn analyse(notes: &[Note]) -> f64 {
    let mut sequence: Vec<Note> = Vec::new();
    let mut last: [Option<usize>; 4] = [None; 4];
    for note in notes {
        if let Some(j) = last[note.k] {
            if note.h - sequence[j].h <= DUP_MS {
                sequence[j].t = max(sequence[j].t, note.t);
                continue;
            }
        }
        last[note.k] = Some(sequence.len());
        sequence.push(*note);
    }
    if sequence.len() < 2 {
        return 0.0;
    }

    let mut by_column: [Vec<Note>; 4] = Default::default();
    let mut by_hand: [Vec<Note>; 2] = Default::default();
    let mut end = 0.0;
    for note in &sequence {
        by_column[note.k].push(*note);
        by_hand[note.k / 2].push(*note);
        end = max(end, max(note.h, note.t));
    }
    let mut grid: Vec<f64> = Vec::new();
    let mut t = 0.0;
    while t <= end + 1000.0 {
        grid.push(t);
        t += GRID_MS;
    }
    let x = hit_window_unit();

    let (mut strain, able) = technique_strain(x, &by_column, &grid);

    for h in 0..2 {
        let mut columns: [Vec<Note>; 4] = Default::default();
        for c in 2 * h..2 * h + 2 {
            columns[c] = by_column[c].clone();
        }
        let holds = hold_costs(x, &columns, &by_hand[h], &grid);
        for i in 0..grid.len() {
            let l = holds.rel[i] + holds.weight[i] + holds.cross[i];
            if l > 0.0 {
                strain[h][i] += LN_W * jsmath::pow(l, LN_X);
            }
        }
    }

    let weights = [note_weights(&grid, &by_hand[0]), note_weights(&grid, &by_hand[1])];
    apply_stamina(&grid, &mut strain, &weights);

    let rows = build_rows(&sequence);
    let sync = hand_sync(&able, &rows, &grid);
    let combined = combine_hands(&strain, &sync);

    let overall_weights = note_weights(&grid, &sequence);
    let binned = bin_strain(&combined);
    let raw = rating_from_bins(&binned, &overall_weights, sequence.len());
    rating_points(raw)
}

const XDC1_SCOPE_MIN_RATING: f64 = 56.2281;

#[rustfmt::skip]
const XDC1_RATING_DAN_KNOTS: [[f64; 2]; 302] = [
    [56.2457, 10.5], [56.2855, 10.52], [56.4662, 10.58], [56.6748, 10.66], [56.6979, 10.66], [56.8091, 10.7],
    [56.9228, 10.75], [56.9387, 10.75], [56.9793, 10.77], [56.9979, 10.77], [57.0081, 10.78], [57.2723, 10.88],
    [57.7027, 11.03], [57.7613, 11.06], [57.8102, 11.07], [57.8729, 11.1], [58.0741, 11.17], [58.0859, 11.18],
    [58.8904, 11.47], [59.0046, 11.52], [59.1394, 11.56], [59.2864, 11.62], [59.3629, 11.64], [59.5332, 11.71],
    [59.7566, 11.78], [59.9043, 11.84], [59.9836, 11.86], [60.4924, 12.04], [60.8486, 12.15], [61.1076, 12.24],
    [61.225, 12.27], [61.3015, 12.3], [61.3909, 12.32], [61.8702, 12.47], [62.0354, 12.51], [62.1477, 12.55],
    [62.2152, 12.56], [62.2251, 12.57], [62.4736, 12.64], [62.5819, 12.66], [62.7811, 12.72], [62.9239, 12.75],
    [63.1747, 12.82], [63.2892, 12.84], [63.6497, 12.93], [64.0341, 13.01], [64.0417, 13.02], [64.1167, 13.03],
    [64.2274, 13.06], [64.6646, 13.14], [64.6774, 13.15], [64.776, 13.17], [64.9719, 13.2], [65.1055, 13.23],
    [65.1436, 13.23], [65.1539, 13.24], [65.2878, 13.26], [65.3145, 13.27], [65.4167, 13.28], [65.7317, 13.34],
    [65.7761, 13.34], [65.7848, 13.35], [65.8349, 13.35], [66.0271, 13.39], [66.147, 13.4], [66.3024, 13.43],
    [66.3418, 13.43], [66.3663, 13.44], [66.5209, 13.46], [66.5409, 13.47], [66.6634, 13.48], [66.7362, 13.5],
    [66.7933, 13.5], [66.8095, 13.51], [66.8476, 13.51], [66.8772, 13.52], [67.2771, 13.57], [67.5118, 13.61],
    [67.5686, 13.61], [67.7197, 13.64], [67.7625, 13.64], [67.7925, 13.65], [67.9381, 13.67], [67.9881, 13.67],
    [68.0871, 13.69], [68.1492, 13.69], [68.1598, 13.7], [68.2924, 13.71], [68.3093, 13.72], [68.38, 13.72],
    [68.4731, 13.74], [68.615, 13.75], [68.6215, 13.76], [68.7583, 13.77], [68.7744, 13.78], [68.8377, 13.78],
    [68.8557, 13.79], [68.9151, 13.79], [68.9306, 13.8], [69.0069, 13.8], [69.017, 13.81], [69.0842, 13.81],
    [69.1041, 13.82], [69.1629, 13.82], [69.175, 13.83], [69.2287, 13.83], [69.248, 13.84], [69.3271, 13.84],
    [69.3657, 13.85], [69.4067, 13.85], [69.4107, 13.86], [69.4818, 13.86], [69.5068, 13.87], [69.5477, 13.87],
    [69.5719, 13.88], [69.6477, 13.88], [69.6548, 13.89], [69.7284, 13.89], [69.7482, 13.9], [69.8116, 13.9],
    [69.8224, 13.91], [69.8932, 13.91], [69.92, 13.92], [69.9782, 13.92], [69.9869, 13.93], [70.0357, 13.93],
    [70.0666, 13.94], [70.1457, 13.94], [70.1506, 13.95], [70.2254, 13.95], [70.244, 13.96], [70.3066, 13.96],
    [70.3194, 13.97], [70.3934, 13.97], [70.402, 13.98], [70.4753, 13.98], [70.4834, 13.99], [70.5603, 13.99],
    [70.5692, 14.0], [70.647, 14.0], [70.65, 14.01], [70.7332, 14.01], [70.7368, 14.02], [70.8105, 14.02],
    [70.8187, 14.03], [70.8975, 14.03], [70.9041, 14.04], [70.9857, 14.04], [70.9969, 14.05], [71.053, 14.05],
    [71.0759, 14.06], [71.1564, 14.06], [71.1613, 14.07], [71.2388, 14.07], [71.2423, 14.08], [71.3266, 14.08],
    [71.3522, 14.09], [71.4048, 14.09], [71.4122, 14.1], [71.5797, 14.11], [71.6064, 14.12], [71.6637, 14.12],
    [71.6789, 14.13], [71.751, 14.13], [71.7559, 14.14], [71.8359, 14.14], [71.8491, 14.15], [71.922, 14.15],
    [71.9238, 14.16], [72.0061, 14.16], [72.0124, 14.17], [72.0811, 14.17], [72.0966, 14.18], [72.1747, 14.18],
    [72.1799, 14.19], [72.257, 14.19], [72.2684, 14.2], [72.3338, 14.2], [72.35, 14.21], [72.4286, 14.21],
    [72.4397, 14.22], [72.5129, 14.22], [72.5221, 14.23], [72.5981, 14.23], [72.6134, 14.24], [72.6868, 14.24],
    [72.6932, 14.25], [72.7629, 14.25], [72.7733, 14.26], [72.8507, 14.26], [72.8653, 14.27], [72.9365, 14.27],
    [72.9603, 14.28], [73.0111, 14.28], [73.0397, 14.29], [73.0927, 14.29], [73.3052, 14.32], [73.3518, 14.32],
    [73.3702, 14.33], [73.4169, 14.33], [73.5323, 14.35], [73.5941, 14.35], [73.6983, 14.37], [73.7752, 14.37],
    [73.8081, 14.38], [73.8526, 14.38], [73.8734, 14.39], [74.1039, 14.41], [74.1103, 14.42], [74.1779, 14.42],
    [74.1987, 14.43], [74.3418, 14.44], [74.3572, 14.45], [74.5098, 14.46], [74.5352, 14.47], [74.9719, 14.52],
    [75.0777, 14.54], [75.3078, 14.56], [75.3196, 14.57], [75.3833, 14.57], [75.4193, 14.58], [75.7882, 14.63],
    [75.906, 14.64], [75.9489, 14.65], [76.001, 14.65], [76.0137, 14.66], [76.2776, 14.69], [76.3135, 14.7],
    [76.3765, 14.7], [76.4059, 14.71], [76.6656, 14.74], [76.688, 14.75], [76.7485, 14.75], [76.7591, 14.76],
    [77.0198, 14.79], [77.1932, 14.82], [77.2617, 14.82], [77.2816, 14.83], [77.746, 14.89], [77.9723, 14.93],
    [78.1229, 14.95], [78.1682, 14.95], [78.1856, 14.96], [78.4403, 14.99], [78.4634, 15.0], [78.7372, 15.04],
    [78.7869, 15.04], [78.7955, 15.05], [78.9889, 15.07], [79.3872, 15.14], [79.4355, 15.14], [79.5183, 15.16],
    [79.6351, 15.17], [79.8522, 15.21], [79.896, 15.21], [79.9137, 15.22], [80.0735, 15.24], [80.0883, 15.25],
    [80.1513, 15.26], [80.2043, 15.26], [80.2763, 15.28], [80.4111, 15.3], [80.4514, 15.3], [80.4731, 15.31],
    [80.7166, 15.35], [80.7612, 15.35], [80.7761, 15.36], [81.1938, 15.42], [81.3234, 15.45], [81.484, 15.47],
    [81.5002, 15.48], [81.7908, 15.53], [81.8287, 15.53], [81.9506, 15.55], [82.4888, 15.65], [82.7535, 15.69],
    [82.7743, 15.7], [82.8119, 15.7], [83.1718, 15.77], [83.3822, 15.8], [83.6818, 15.86], [83.9397, 15.9],
    [83.9539, 15.91], [84.23, 15.96], [84.2587, 15.96], [84.2792, 15.97], [84.3806, 15.98], [85.0276, 16.1],
    [85.2025, 16.14], [85.6174, 16.21], [86.5663, 16.39], [86.838, 16.45], [86.8875, 16.45], [89.0059, 16.86],
    [91.2128, 17.26], [91.3217, 17.27], [92.4651, 17.46], [94.525, 17.77], [97.0001, 18.11], [97.8078, 18.23],
    [98.3042, 18.29], [100.2364, 18.56],
];

fn xdc1_rating_to_dan(rating: f64) -> f64 {
    let value = rating;
    if !value.is_finite() || value <= 0.0 {
        return 0.0;
    }
    if value < XDC1_SCOPE_MIN_RATING {
        return value * (10.5 / XDC1_SCOPE_MIN_RATING);
    }
    let knots = &XDC1_RATING_DAN_KNOTS;
    if value <= knots[0][0] {
        return knots[0][1];
    }
    let last = knots.len() - 1;
    if value >= knots[last][0] {
        return knots[last][1];
    }
    let (mut lo, mut hi) = (0usize, last);
    while hi - lo > 1 {
        let mid = (lo + hi) >> 1;
        if knots[mid][0] <= value {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    let [x0, y0] = knots[lo];
    let [x1, y1] = knots[hi];
    y0 + ((value - x0) / (x1 - x0)) * (y1 - y0)
}

fn build_notes<P: ParsedView>(parsed: &P, speed_rate: f64) -> Result<Vec<Note>, String> {
    let rate = if speed_rate > 0.0 { speed_rate } else { 1.0 };
    let mut notes: Vec<Note> = Vec::new();
    for i in 0..parsed.note_count() {
        let column = parsed.column(i);
        let mut head = parsed.note_start(i);
        let mut tail = if to_int32(parsed.note_type(i)) & 128 != 0 { parsed.note_end(i) } else { -1.0 };
        if rate != 1.0 {
            head = (head / rate).floor();
            if tail >= 0.0 {
                tail = (tail / rate).floor();
            }
        }
        if head < 0.0 {
            continue;
        }
        if tail >= 0.0 && tail < head {
            tail = -1.0;
        }
        if !(column == 0.0 || column == 1.0 || column == 2.0 || column == 3.0) || !head.is_finite() {
            return Err("XDC1: unexpected note".into());
        }
        notes.push(Note { k: column as usize, h: head, t: tail });
    }
    notes.sort_by(|a, b| a.h.partial_cmp(&b.h).unwrap_or(std::cmp::Ordering::Equal).then(a.k.cmp(&b.k)));
    Ok(notes)
}

fn unsupported_result(column_count: f64, ln_ratio: f64, reason: &str) -> EstimatorResult {
    EstimatorResult::basic(f64::NAN, ln_ratio, column_count, format!("Unsupported: {reason}"), None, None)
}

pub fn run_xdc1<U: Upstream>(up: &U, osu_text: &str, options: &EstimatorOptions, parsed: Option<&U::Parsed>) -> Result<EstimatorResult, String> {
    let speed_rate = options.speed_rate.unwrap_or(1.0);
    let cvt = options.cvt_flag.as_deref().unwrap_or("").to_uppercase();
    let owned;
    let parser: &U::Parsed = if cvt.contains("IN") || cvt.contains("HO") {
        let flag = if cvt.contains("IN") { "IN" } else { "HO" };
        owned = up.parse(osu_text, Some(flag)).or_else(|_| up.parse(osu_text, None))?;
        &owned
    } else if let Some(p) = parsed {
        p
    } else {
        owned = up.parse(osu_text, None)?;
        &owned
    };
    let column_count = parser.column_count();
    let column_count = if column_count.is_nan() { 0.0 } else { column_count };
    let ln_ratio = parser.ln_ratio();
    let ln_ratio = if ln_ratio.is_nan() { 0.0 } else { ln_ratio };

    if column_count != 4.0 {
        return Ok(unsupported_result(column_count, ln_ratio, "4K only"));
    }
    if matches!(parser.status(), ParseStatus::Fail | ParseStatus::NotMania) {
        return Ok(unsupported_result(column_count, ln_ratio, "parse failed"));
    }
    let notes = build_notes(parser, speed_rate)?;
    if notes.len() < 2 {
        return Ok(unsupported_result(column_count, ln_ratio, "too few notes"));
    }
    let rating = analyse(&notes);
    if !rating.is_finite() {
        return Ok(unsupported_result(column_count, ln_ratio, "calculation failed"));
    }
    if rating < XDC1_SCOPE_MIN_RATING {
        return Ok(unsupported_result(column_count, ln_ratio, "below Alpha Low"));
    }
    let dan = xdc1_rating_to_dan(rating);
    let est_diff = if dan < 10.52 { "Alpha low".to_string() } else { numeric_to_rc_label(dan) };
    Ok(EstimatorResult {
        star: round_fixed(3.4 + 0.38 * dan, 4),
        ln_ratio,
        column_count,
        est_diff,
        numeric_difficulty: Some(round_fixed(dan, 2)),
        numeric_difficulty_hint: Some("xdc1-v1".into()),
        raw_numeric_difficulty: Some(round_fixed(rating, 4)),
        debug: None,
    })
}
