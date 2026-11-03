use crate::common::{clamp, fmt4, quantile_from_sorted, safe_div, sort_asc, ParsedRef};
use crate::jsnum::{round_fixed, to_fixed};
use crate::marathon::compute_marathon_correction;
use crate::rc_format::numeric_to_rc_label;
use crate::types::{EstimatorDebug, EstimatorOptions, EstimatorResult, ParseStatus, ParsedView, Upstream};

const RC_LN_RATIO_LIMIT: f64 = 0.18;
const MIN_NOTES: usize = 80;
const ROW_TOLERANCE_MS: f64 = 2.0;
const DECAY_WINDOWS_MS: [f64; 4] = [140.0, 280.0, 560.0, 980.0];
const DECAY_WEIGHTS: [f64; 4] = [0.34, 0.30, 0.22, 0.14];
const LENGTH_REF_NOTES: f64 = 600.0;
const LENGTH_EXPONENT: f64 = 0.22;
const LENGTH_CAP: f64 = 3.5;

const CALIBRATION_LOW_BLOCKS: [[f64; 3]; 17] = [
    [1.9220, 1.9220, 1.0000],
    [2.3660, 2.7684, 1.6667],
    [2.8394, 2.8394, 2.0000],
    [2.8584, 3.7162, 2.3333],
    [3.7798, 3.7798, 3.0000],
    [3.8667, 3.8667, 3.0000],
    [4.2067, 5.2039, 4.3333],
    [5.2506, 5.7713, 5.0667],
    [5.8603, 6.1512, 5.3333],
    [6.3292, 6.8785, 6.0000],
    [7.1715, 7.3617, 6.2000],
    [7.4079, 7.8734, 7.2000],
    [8.0160, 8.4003, 8.2500],
    [8.4133, 8.4133, 9.0000],
    [8.9031, 9.4775, 9.5667],
    [9.6488, 9.6488, 10.0000],
    [9.8301, 9.8301, 10.3000],
];

const CALIBRATION_HIGH_BLOCKS: [[f64; 3]; 43] = [
    [11.4336, 11.4336, 10.4000],
    [11.4436, 11.4436, 10.5000],
    [11.6012, 11.6665, 10.6500],
    [11.6696, 12.2317, 11.5000],
    [12.3295, 12.3919, 11.7500],
    [12.5238, 12.5238, 12.0000],
    [12.5318, 12.8329, 12.1400],
    [12.8605, 12.9781, 12.2800],
    [12.9868, 13.1170, 12.7800],
    [13.2003, 13.4418, 12.7857],
    [13.4660, 13.5829, 12.9250],
    [13.6044, 13.9924, 13.3667],
    [14.0583, 14.0583, 13.4000],
    [14.0795, 14.2266, 13.4600],
    [14.2346, 14.2346, 13.6000],
    [14.2414, 14.2414, 13.7000],
    [14.2903, 14.2903, 14.0000],
    [14.3258, 14.4760, 14.1200],
    [14.5365, 14.6006, 14.1333],
    [14.7269, 14.8716, 14.1333],
    [15.0048, 15.0048, 14.4000],
    [15.0521, 15.0521, 14.4000],
    [15.0521, 15.0521, 14.4000],
    [15.0950, 15.0950, 14.4000],
    [15.2335, 15.2335, 14.4000],
    [15.2388, 15.5821, 14.7385],
    [15.6977, 15.7002, 14.8500],
    [15.7535, 16.1593, 15.0667],
    [16.2009, 16.2958, 15.1000],
    [16.3172, 16.4748, 15.7600],
    [16.5620, 16.9083, 15.9833],
    [16.9485, 16.9485, 16.0000],
    [17.0216, 17.3799, 16.1000],
    [17.4616, 17.4616, 16.4000],
    [17.5167, 17.5167, 16.4000],
    [17.5306, 17.9077, 16.6400],
    [18.1973, 18.1973, 17.2000],
    [18.2026, 18.2026, 17.2000],
    [18.4562, 19.3477, 17.9500],
    [19.3477, 20.5000, 18.2000],
    [20.5000, 22.0000, 18.6000],
    [22.0000, 24.0000, 19.2000],
    [24.0000, 27.0000, 20.0000],
];

const ISOTONIC_POINTS: [[f64; 2]; 84] = [
    [1.3868, 1.0000],
    [1.4574, 1.0000],
    [1.5361, 1.0000],
    [1.6320, 1.5000],
    [1.9833, 2.5800],
    [2.2465, 2.6000],
    [2.3344, 2.8000],
    [2.5779, 3.4500],
    [3.8277, 3.6000],
    [4.2824, 4.3429],
    [4.5665, 4.6250],
    [4.8016, 4.6750],
    [4.9529, 5.1500],
    [5.1029, 5.4000],
    [5.2475, 5.4750],
    [5.5039, 5.9000],
    [5.6951, 6.0143],
    [5.9213, 6.4000],
    [6.0093, 6.9000],
    [6.1337, 7.2000],
    [6.7092, 7.4400],
    [7.2846, 7.5000],
    [7.4233, 7.8000],
    [7.9790, 8.6000],
    [8.2927, 8.6143],
    [9.0829, 9.5000],
    [9.4639, 9.6154],
    [9.8115, 10.0000],
    [9.8344, 10.4000],
    [10.0013, 10.4000],
    [10.0778, 10.5000],
    [10.1054, 10.5000],
    [10.1435, 10.6000],
    [10.4782, 10.6462],
    [10.8866, 10.8000],
    [11.0934, 11.1727],
    [11.3266, 11.2867],
    [11.4970, 11.4000],
    [11.6024, 11.4750],
    [11.6947, 11.6000],
    [11.8932, 12.0636],
    [12.0076, 12.3000],
    [12.2947, 12.4150],
    [12.7583, 12.4500],
    [12.8756, 12.9000],
    [12.9268, 12.9000],
    [13.0042, 13.2000],
    [13.2387, 13.2694],
    [13.4620, 13.4400],
    [13.5467, 13.5000],
    [13.6016, 13.7375],
    [13.9609, 13.9500],
    [14.1414, 14.0250],
    [14.2226, 14.0762],
    [14.3178, 14.1273],
    [14.3786, 14.1643],
    [14.4421, 14.2182],
    [14.4825, 14.3000],
    [14.5063, 14.3750],
    [14.5452, 14.4778],
    [14.6359, 14.5850],
    [14.7301, 14.6389],
    [14.8846, 14.7906],
    [15.0424, 14.9263],
    [15.2159, 15.0944],
    [15.3942, 15.1875],
    [15.5380, 15.3300],
    [15.8096, 15.5320],
    [16.0262, 16.1000],
    [16.0702, 16.1000],
    [16.2738, 16.1267],
    [16.4723, 16.3579],
    [16.7156, 16.8000],
    [17.1446, 17.0600],
    [17.5478, 17.2000],
    [17.6403, 17.2000],
    [17.7603, 17.2000],
    [17.8264, 17.6000],
    [18.1258, 17.9750],
    [18.5000, 18.2000],
    [19.2000, 18.7000],
    [20.0000, 19.2000],
    [21.2000, 19.8000],
    [22.5000, 20.0000],
];

#[derive(Clone, Debug, PartialEq)]
pub struct AzusaDebug {
    pub primary_numeric: Option<f64>,
    pub blend_numeric: Option<f64>,
    pub daniel_numeric: Option<f64>,
    pub daniel_numeric_for_blend: Option<f64>,
    pub daniel_has_native_numeric: bool,
    pub sunny_numeric: Option<f64>,
    pub notes: usize,
    pub calibrated_numeric: Option<f64>,
    pub curve_anchor_imbalance: Option<f64>,
    pub curve_chord_rate: Option<f64>,
    pub curve_jack_q95: Option<f64>,
    pub curve_gap_residual: Option<f64>,
    pub output_numeric: Option<f64>,
    pub post_curve_gap_residual: Option<f64>,
    pub final_numeric: Option<f64>,
    pub blend: [Option<String>; 5],
}

pub(crate) fn error_result(code: &str, message: String, ln_ratio: f64, column_count: f64) -> EstimatorResult {
    EstimatorResult {
        star: f64::NAN,
        ln_ratio: if ln_ratio.is_finite() { ln_ratio } else { 0.0 },
        column_count: if column_count.is_finite() { column_count } else { 0.0 },
        est_diff: format!("Invalid: {message}"),
        numeric_difficulty: None,
        numeric_difficulty_hint: Some(code.to_string()),
        raw_numeric_difficulty: None,
        debug: Some(EstimatorDebug::Error { code: code.to_string(), message }),
    }
}

fn piecewise_linear(x: f64, knots: &[[f64; 2]]) -> f64 {
    let v = x;
    if !v.is_finite() {
        return v;
    }
    if v <= knots[0][0] {
        return knots[0][1];
    }
    let last = knots.len() - 1;
    if v >= knots[last][0] {
        return knots[last][1];
    }
    for i in 0..last {
        let (x0, y0) = (knots[i][0], knots[i][1]);
        let (x1, y1) = (knots[i + 1][0], knots[i + 1][1]);
        if v >= x0 && v <= x1 {
            return y0 + safe_div((v - x0) * (y1 - y0), x1 - x0, 0.0);
        }
    }
    v
}

fn piecewise_block(x: f64, blocks: &[[f64; 3]]) -> f64 {
    let v = x;
    if !v.is_finite() {
        return v;
    }
    if v <= blocks[0][0] {
        return blocks[0][2];
    }
    let last = blocks.len() - 1;
    for i in 0..blocks.len() {
        let [x0, x1, y] = blocks[i];
        if v >= x0 && v <= x1 {
            return y;
        }
        if i < last && v > x1 && v < blocks[i + 1][0] {
            let t = safe_div(v - x1, blocks[i + 1][0] - x1, 0.0);
            return y * (1.0 - t) + blocks[i + 1][2] * t;
        }
    }
    blocks[last][2]
}

pub(crate) fn estimate_daniel_numeric(result: &EstimatorResult) -> Option<f64> {
    if let Some(n) = result.numeric_difficulty {
        if n.is_finite() {
            return Some(n);
        }
    }
    let star = result.star;
    if !star.is_finite() {
        return None;
    }
    if star >= 6.56 {
        let normalized = clamp((star - 6.56) / 0.58, 0.0, 9.99);
        return Some(round_fixed(11.0 + normalized, 2));
    }
    let low = -2.0 + 13.0 * jsmath::pow(clamp(star / 6.56, 0.0, 1.0), 1.72);
    Some(round_fixed(low, 2))
}

fn has_daniel_native_numeric(result: &EstimatorResult) -> bool {
    matches!(result.numeric_difficulty, Some(n) if n.is_finite())
}

pub(crate) fn estimate_sunny_numeric(result: &EstimatorResult) -> Option<f64> {
    let star = result.star;
    if !star.is_finite() {
        return None;
    }
    Some(round_fixed(clamp(2.85 + 1.33 * star, -2.0, 20.0), 2))
}

fn power_mean(values: &[f64], p: f64) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let mut acc = 0.0;
    for &v in values {
        acc += jsmath::pow(jsmath::max(v, 0.0), p);
    }
    jsmath::pow(acc / values.len() as f64, 1.0 / p)
}

#[derive(Clone, Copy)]
struct Tap {
    t: f64,
    c: usize,
    hand: usize,
    row_size: usize,
}

fn build_tap_notes<P: ParsedView>(parsed: &P) -> Vec<Tap> {
    let mut taps = Vec::with_capacity(parsed.note_count());
    for i in 0..parsed.note_count() {
        let col = parsed.column(i);
        let time = parsed.note_start(i);
        if !col.is_finite() || !time.is_finite() {
            continue;
        }
        taps.push(Tap { t: time, c: if col < 0.0 { usize::MAX } else { col as usize }, hand: if col < 2.0 { 0 } else { 1 }, row_size: 1 });
    }
    taps.sort_by(|a, b| {
        if a.t != b.t {
            a.t.partial_cmp(&b.t).unwrap()
        } else {
            a.c.cmp(&b.c)
        }
    });
    taps
}

fn annotate_rows(taps: &mut [Tap], tolerance: f64) {
    if taps.is_empty() {
        return;
    }
    let mut row_start = 0;
    for i in 1..=taps.len() {
        let flush = i == taps.len() || (taps[i].t - taps[row_start].t).abs() > tolerance;
        if !flush {
            continue;
        }
        let size = i - row_start;
        for tap in &mut taps[row_start..i] {
            tap.row_size = size;
        }
        row_start = i;
    }
}

#[inline]
fn exp_decay_factor(dt: f64, tau: f64) -> f64 {
    if !dt.is_finite() || dt <= 0.0 {
        return 1.0;
    }
    jsmath::exp(-dt / tau)
}

#[inline]
fn skill_from_states(states: &[f64; 4]) -> f64 {
    let mut sum = 0.0;
    for i in 0..4 {
        sum += states[i] * DECAY_WEIGHTS[i];
    }
    sum
}

struct Curve {
    local_len: usize,
    speed: Vec<f64>,
    stamina: Vec<f64>,
    chord: Vec<f64>,
    tech: Vec<f64>,
    jack: Vec<f64>,
    times: Vec<f64>,
    density250: Vec<f64>,
    density500: Vec<f64>,
    jack_raw: Vec<f64>,
    column_counts: [f64; 4],
    chord_note_count: f64,
}

fn build_difficulty_curve(taps: &[Tap]) -> Curve {
    let n = taps.len();
    let mut s_speed = [0.0f64; 4];
    let mut s_stamina = [0.0f64; 4];
    let mut s_chord = [0.0f64; 4];
    let mut s_tech = [0.0f64; 4];
    let mut s_jack = [0.0f64; 4];
    let mut last_by_column = [-1e9f64; 4];
    let mut last_by_hand = [-1e9f64; 2];
    let mut curve = Curve {
        local_len: 0,
        speed: Vec::with_capacity(n),
        stamina: Vec::with_capacity(n),
        chord: Vec::with_capacity(n),
        tech: Vec::with_capacity(n),
        jack: Vec::with_capacity(n),
        times: Vec::with_capacity(n),
        density250: Vec::with_capacity(n),
        density500: Vec::with_capacity(n),
        jack_raw: Vec::with_capacity(n),
        column_counts: [0.0; 4],
        chord_note_count: 0.0,
    };
    let mut cursor250 = 0usize;
    let mut cursor500 = 0usize;
    let mut prev_time = taps.first().map_or(0.0, |t| t.t);
    let mut prev_any1 = -1e9f64;
    let mut prev_any2 = -1e9f64;
    let mut prev_col = 0usize;

    for i in 0..n {
        let note = taps[i];
        let t = note.t;
        let c = note.c;
        curve.column_counts[c] += 1.0;
        if note.row_size >= 2 {
            curve.chord_note_count += 1.0;
        }
        let dt_global = if i == 0 { 0.0 } else { jsmath::max(0.0, t - prev_time) };
        let dt_same = jsmath::max(0.0, t - last_by_column[c]);
        let dt_hand = jsmath::max(0.0, t - last_by_hand[note.hand]);
        let dt_any = jsmath::max(0.0, t - prev_any1);

        while cursor250 < i && t - taps[cursor250].t > 250.0 {
            cursor250 += 1;
        }
        while cursor500 < i && t - taps[cursor500].t > 500.0 {
            cursor500 += 1;
        }
        let d250 = (i - cursor250 + 1) as f64 / 0.25;
        let d500 = (i - cursor500 + 1) as f64 / 0.5;
        curve.density250.push(d250);
        curve.density500.push(d500);

        let jack = jsmath::pow(190.0 / (dt_same + 35.0), 1.16);
        curve.jack_raw.push(jack);
        let stream = jsmath::pow(170.0 / (dt_any + 30.0), 1.07);
        let hand_stream = jsmath::pow(185.0 / (dt_hand + 42.0), 1.08);

        let movement = (c as f64 - prev_col as f64).abs() / 3.0;
        let rhythm_ratio = safe_div(jsmath::max(dt_any, 1.0), jsmath::max(t - prev_any2, 1.0), 1.0);
        let rhythm_chaos = jsmath::log2(clamp(rhythm_ratio, 0.2, 5.0)).abs();

        let row_chord = jsmath::max(0.0, note.row_size as f64 - 1.0);
        let chord = jsmath::pow(row_chord + 1.0, 1.22) - 1.0;

        let speed_input = 0.60 * stream + 0.30 * hand_stream + 0.10 * jack;
        let jack_input = jack * (1.0 + 0.15 * chord);
        let stamina_input = 0.48 * (d500 / 11.0) + 0.27 * (d250 / 15.0) + 0.25 * stream;
        let chord_input = chord * (1.0 + 0.10 * jsmath::min(1.5, stream));
        let tech_input = 0.45 * rhythm_chaos + 0.30 * movement + 0.25 * (if row_chord > 0.0 { 1.0 + 0.3 * row_chord } else { 0.0 });

        for j in 0..4 {
            let decay = exp_decay_factor(dt_global, DECAY_WINDOWS_MS[j]);
            s_speed[j] = s_speed[j] * decay + speed_input;
            s_stamina[j] = s_stamina[j] * decay + stamina_input;
            s_chord[j] = s_chord[j] * decay + chord_input;
            s_tech[j] = s_tech[j] * decay + tech_input;
            s_jack[j] = s_jack[j] * decay + jack_input;
        }

        let speed_skill = skill_from_states(&s_speed);
        let stamina_skill = skill_from_states(&s_stamina);
        let chord_skill = skill_from_states(&s_chord);
        let tech_skill = skill_from_states(&s_tech);
        let jack_skill = skill_from_states(&s_jack);

        curve.local_len += 1;
        curve.speed.push(speed_skill);
        curve.stamina.push(stamina_skill);
        curve.chord.push(chord_skill);
        curve.tech.push(tech_skill);
        curve.jack.push(jack_skill);
        curve.times.push(t);

        prev_any2 = prev_any1;
        prev_any1 = t;
        prev_time = t;
        prev_col = c;
        last_by_column[c] = t;
        last_by_hand[note.hand] = t;
    }
    curve
}

struct Summary {
    q97: f64,
    q90: f64,
    q75: f64,
    q50: f64,
    tail_mean: f64,
}

fn summarize(values: &[f64]) -> Summary {
    let mut sorted = values.to_vec();
    sort_asc(&mut sorted);
    let q97 = quantile_from_sorted(&sorted, 0.97);
    let q90 = quantile_from_sorted(&sorted, 0.90);
    let q75 = quantile_from_sorted(&sorted, 0.75);
    let q50 = quantile_from_sorted(&sorted, 0.50);
    let len = sorted.len() as i64;
    let tail_count = jsmath::max(8.0, (sorted.len() as f64 * 0.04).floor()) as i64;
    let mut start = len - tail_count;
    if start < 0 {
        start = (len + start).max(0);
    }
    let tail = &sorted[start as usize..];
    let mut sum = 0.0;
    for &v in tail {
        sum += v;
    }
    let tail_mean = sum / tail.len() as f64;
    Summary { q97, q90, q75, q50, tail_mean }
}

fn max4(a: [f64; 4]) -> f64 {
    jsmath::max(jsmath::max(jsmath::max(a[0], a[1]), a[2]), a[3])
}

fn compute_numeric_from_curve(curve: &Curve, note_count: usize) -> f64 {
    if curve.local_len == 0 {
        return 0.0;
    }
    let speed = summarize(&curve.speed);
    let stamina = summarize(&curve.stamina);
    let chord = summarize(&curve.chord);
    let tech = summarize(&curve.tech);
    let jack = summarize(&curve.jack);

    let density250 = power_mean(&curve.density250, 1.18);
    let density500 = power_mean(&curve.density500, 1.12);
    let nc = note_count as f64;
    let length_boost = jsmath::min(LENGTH_CAP, jsmath::pow(jsmath::max(nc, 1.0) / LENGTH_REF_NOTES, LENGTH_EXPONENT));

    let peak_blend = (0.26 * speed.q97)
        + (0.22 * stamina.q97)
        + (0.10 * chord.q97)
        + (0.10 * tech.q97)
        + (0.10 * jack.q97)
        + (0.06 * speed.q90)
        + (0.04 * stamina.q90)
        + (0.02 * chord.q90)
        + (0.02 * tech.q90)
        + (0.02 * jack.q90);
    let sustain_blend = (0.18 * speed.q75)
        + (0.16 * stamina.q75)
        + (0.08 * chord.q75)
        + (0.06 * tech.q75)
        + (0.08 * jack.q75)
        + (0.10 * speed.tail_mean)
        + (0.08 * stamina.tail_mean)
        + (0.04 * chord.tail_mean)
        + (0.04 * tech.tail_mean)
        + (0.04 * jack.tail_mean);
    let density_blend = (0.14 * jsmath::log1p(density250)) + (0.22 * jsmath::log1p(density500));
    let mid_blend = (0.16 * speed.q50) + (0.13 * stamina.q50) + (0.06 * chord.q50) + (0.06 * tech.q50) + (0.06 * jack.q50);
    let raw = (0.52 * peak_blend) + (0.26 * sustain_blend) + (0.10 * density_blend) + (0.08 * mid_blend) + (0.04 * length_boost);
    let scaled = 0.82 + (0.43 * raw);

    let max_column = max4(curve.column_counts);
    let anchor_imbalance = safe_div((max_column / jsmath::max(nc, 1.0)) - 0.25, 0.75, 0.0);
    let chord_rate = safe_div(curve.chord_note_count, jsmath::max(nc, 1.0), 0.0);
    let mut jack_sorted = curve.jack_raw.clone();
    sort_asc(&mut jack_sorted);
    let jack_q95 = quantile_from_sorted(&jack_sorted, 0.95);

    let chordjack_boost = clamp(
        2.5 * clamp((chord_rate - 0.40) * 3.5, 0.0, 1.0)
            * clamp((jack_q95 - 1.25) * 2.8, 0.0, 1.0)
            * clamp(1.0 - (anchor_imbalance * 8.0), 0.0, 1.0),
        0.0,
        2.2,
    );
    let total_time_sec = jsmath::max(1.0, (curve.times[curve.times.len() - 1] - curve.times[0]) / 1000.0);
    let avg_nps = nc / total_time_sec;
    let mid_speed_bonus = clamp((avg_nps - 9.0) * 0.04, 0.0, 0.35) * clamp((19.0 - avg_nps) * 0.25, 0.0, 1.0);
    let corrected = scaled + chordjack_boost + mid_speed_bonus;
    clamp(corrected, -2.0, 20.0)
}

struct Blend {
    value: Option<f64>,
    low_gate_source: Option<f64>,
    low_gate: Option<f64>,
    high_gate: Option<f64>,
    low_base: Option<f64>,
    high_base: Option<f64>,
}

fn fin(x: Option<f64>) -> Option<f64> {
    x.filter(|v| v.is_finite())
}

fn resolve_rc_blend(primary: Option<f64>, daniel: Option<f64>, sunny: Option<f64>, hints: (f64, f64, f64)) -> Blend {
    let primary = fin(primary);
    let daniel = fin(daniel);
    let sunny = fin(sunny);
    if daniel.is_none() && primary.is_none() && sunny.is_none() {
        return Blend { value: None, low_gate_source: None, low_gate: None, high_gate: None, low_base: None, high_base: None };
    }
    let lgs = daniel.unwrap_or_else(|| sunny.or(primary).unwrap_or(0.0));
    let low_gate = clamp((9.61 - lgs) / 4.94, 0.0, 1.0);
    let high_gate = 1.0 - low_gate;

    let low_base = sunny.map(|sunny| {
        let mut value = (-8.317) + (1.536 * sunny);
        if let Some(p) = primary {
            value += 0.011 * p;
        }
        if let Some(d) = daniel {
            value += 0.049 * d;
        }
        if low_gate > 0.0 {
            let primary_part = match primary {
                Some(p) => jsmath::max(0.0, p - 10.4),
                None => 0.0,
            };
            let sunny_part = jsmath::max(0.0, sunny - 9.84);
            let low_sunny_convex = jsmath::pow(jsmath::max(0.0, 7.935 - sunny), 2.0);
            value += low_gate * ((0.442 * sunny_part) + (0.016 * primary_part) + (0.235 * low_sunny_convex));
        }
        value
    });

    let high_base = {
        let d_use = if daniel.is_some() { daniel } else { sunny.or(primary) };
        d_use.map(|d_use| {
            let primary_use = primary.unwrap_or(d_use);
            let sunny_use = sunny.unwrap_or(d_use);
            let mut value = (0.809 * d_use) + (0.057 * primary_use) + (0.165 * sunny_use) + 0.183;
            let high_mask = clamp((lgs - 14.83) / 2.667, 0.0, 1.0);
            if high_mask > 0.0 {
                value += high_mask * ((-0.154 * jsmath::max(0.0, primary_use - d_use)) + (0.081 * jsmath::max(0.0, sunny_use - d_use)));
            }
            let (anchor_imbalance, chord_rate, jack_q95) = hints;
            if anchor_imbalance.is_finite() && chord_rate.is_finite() && jack_q95.is_finite() {
                let anchor_lift = clamp(
                    0.20 * jsmath::max(0.0, jack_q95 - 2.08) * jsmath::max(0.0, 0.24 - chord_rate) * jsmath::max(0.0, anchor_imbalance - 0.10),
                    0.0,
                    0.25,
                );
                value += anchor_lift;
            }
            value
        })
    };

    let low_lift = if lgs.is_finite() { jsmath::max(0.0, 9.889 - lgs) * 0.257 } else { 0.0 };
    let value = match (low_base, high_base) {
        (None, None) => None,
        (None, Some(h)) => Some(h),
        (Some(l), None) => Some(l + low_lift),
        (Some(l), Some(h)) => Some((l * low_gate) + ((h + low_lift) * high_gate)),
    };
    Blend { value, low_gate_source: Some(lgs), low_gate: Some(low_gate), high_gate: Some(high_gate), low_base, high_base }
}

fn calibrate_numeric(value: Option<f64>, low_gate: Option<f64>, high_gate: Option<f64>) -> f64 {
    let v = value.unwrap_or(0.0);
    if !v.is_finite() {
        return v;
    }
    let low = piecewise_block(v, &CALIBRATION_LOW_BLOCKS);
    let high = piecewise_block(v, &CALIBRATION_HIGH_BLOCKS);
    let lg = fin(low_gate).map(|g| clamp(g, 0.0, 1.0));
    let hg = fin(high_gate).map(|g| clamp(g, 0.0, 1.0));
    if lg.is_none() && hg.is_none() {
        return if v < 11.0 { low } else { high };
    }
    let lw = lg.unwrap_or_else(|| jsmath::max(0.0, 1.0 - hg.unwrap_or(0.0)));
    let hw = hg.unwrap_or_else(|| jsmath::max(0.0, 1.0 - lw));
    let ws = lw + hw;
    if ws <= 1e-6 {
        return if v < 11.0 { low } else { high };
    }
    (lw * low + hw * high) / ws
}

fn curve_gap_residual(base: f64, high_gate: Option<f64>, stats: (f64, f64, f64), primary: f64, sunny: Option<f64>, daniel: Option<f64>) -> f64 {
    let x = base;
    if !x.is_finite() {
        return 0.0;
    }
    let high_gate = match fin(high_gate) {
        Some(g) => clamp(g, 0.0, 1.0),
        None => 0.0,
    };
    let primary = if primary.is_finite() { primary } else { x };
    let sunny = fin(sunny).unwrap_or(x);
    let daniel = fin(daniel).unwrap_or(x);
    let ds = daniel - sunny;
    let sp = sunny - primary;
    let f0 = |v: f64| if v.is_finite() { v } else { 0.0 };
    let anchor_imbalance = f0(stats.0);
    let chord_rate = f0(stats.1);
    let jack_q95 = f0(stats.2);
    let residual = 4.335282
        + (-0.170459 * x)
        + (-1.622303 * jsmath::max(0.0, 11.0 - x))
        + (1.328125 * jsmath::max(0.0, 12.5 - x))
        + (-0.042829 * jsmath::max(0.0, 14.0 - x))
        + (-0.834997 * high_gate)
        + (3.060352 * high_gate * jsmath::max(0.0, 11.0 - x))
        + (-1.744638 * high_gate * jsmath::max(0.0, 12.5 - x))
        + (0.409922 * ds)
        + (0.041072 * sp)
        + (-0.388231 * high_gate * ds)
        + (-0.170185 * high_gate * sp)
        + (3.466868 * anchor_imbalance)
        + (-1.743778 * chord_rate)
        + (-0.094758 * jack_q95)
        + (2.626366 * anchor_imbalance * jack_q95)
        + (1.836357 * chord_rate * jack_q95)
        + (-2.612648 * high_gate * anchor_imbalance)
        + (-2.493596 * high_gate * chord_rate);
    clamp(residual, -1.2, 1.2)
}

fn reference_correction(azusa_est: f64, daniel: Option<f64>, sunny: Option<f64>, chord_rate: Option<f64>) -> f64 {
    let x = azusa_est;
    if !x.is_finite() {
        return 0.0;
    }
    if x < 10.0 || x > 17.5 {
        return 0.0;
    }
    let daniel = fin(daniel);
    let sunny = fin(sunny);
    let (gate, coeff_d, coeff_s) = if x < 11.5 {
        (clamp((x - 10.0) / 1.5, 0.0, 1.0), 0.10, 0.06)
    } else if x < 12.5 {
        let ref_d = daniel.unwrap_or(x);
        let stream_weight = match fin(chord_rate) {
            Some(cr) => clamp((0.45 - cr) / 0.15, 0.0, 1.0),
            None => 1.0,
        };
        if ref_d > 12.0 && stream_weight > 0.0 {
            let t = clamp((ref_d - 12.0) / 0.8, 0.0, 1.0) * stream_weight;
            (1.0, 0.20 + (0.20 * t), 0.13 + (0.12 * t))
        } else {
            (1.0, 0.20, 0.13)
        }
    } else if x < 16.0 {
        (1.0, 0.40, 0.25)
    } else {
        (clamp((17.5 - x) / 1.5, 0.0, 1.0), 0.28, 0.17)
    };
    let mut correction = 0.0;
    if let Some(d) = daniel {
        correction += coeff_d * (d - x);
    }
    if let Some(s) = sunny {
        correction += coeff_s * (s - x);
    }
    clamp(correction * gate, -1.2, 1.2)
}

fn fixed4(x: Option<f64>) -> Option<String> {
    x.map(|v| to_fixed(v, 4))
}

pub fn run_azusa<U: Upstream>(up: &U, osu_text: &str, options: &EstimatorOptions, parsed: Option<&U::Parsed>) -> Result<EstimatorResult, String> {
    let speed_rate = match options.speed_rate {
        Some(r) if r.is_finite() && r > 0.0 => r,
        _ => 1.0,
    };
    let force_sunny_reference_ho = options.force_sunny_reference_ho != Some(false);
    let precomputed_daniel = options.precomputed_daniel_result;
    let precomputed_sunny = options.precomputed_sunny_result;

    let owned;
    let parser: &U::Parsed = match parsed {
        Some(p) => p,
        None => {
            owned = up.parse(osu_text, None)?;
            &owned
        }
    };
    let pd = ParsedRef(parser);
    let ln_ratio = pd.ln_ratio_or0();
    let column_count = pd.column_count_or0();

    if parser.status() == ParseStatus::Fail {
        return Ok(error_result("ParseFailed", "Beatmap parse failed".into(), ln_ratio, column_count));
    }
    if parser.status() == ParseStatus::NotMania {
        return Ok(error_result("NotMania", "Beatmap mode is not mania".into(), ln_ratio, column_count));
    }
    if column_count != 4.0 {
        return Ok(error_result("UnsupportedKeys", "Azusa only supports 4K".into(), ln_ratio, column_count));
    }
    if ln_ratio > RC_LN_RATIO_LIMIT {
        return Ok(error_result(
            "UnsupportedLN",
            format!("Azusa RC scope rejects LN ratio {}%", to_fixed(ln_ratio * 100.0, 1)),
            ln_ratio,
            column_count,
        ));
    }

    let mut taps = build_tap_notes(parser);
    if taps.iter().any(|t| t.c > 3) {
        return Err("Azusa port: column index past 3 on a 4K chart".into());
    }
    if taps.len() < MIN_NOTES {
        return Ok(error_result(
            "TooShort",
            format!("Insufficient notes for stable estimate ({})", taps.len()),
            ln_ratio,
            column_count,
        ));
    }

    let time_scale = if speed_rate != 0.0 { 1.0 / speed_rate } else { 1.0 };
    if time_scale != 1.0 {
        for tap in &mut taps {
            tap.t *= time_scale;
        }
    }
    annotate_rows(&mut taps, ROW_TOLERANCE_MS * time_scale);

    let curve = build_difficulty_curve(&taps);
    let note_count = taps.len();
    let primary_numeric = compute_numeric_from_curve(&curve, note_count);

    let nc = note_count as f64;
    let max_column = max4(curve.column_counts);
    let anchor_imbalance = safe_div((max_column / jsmath::max(nc, 1.0)) - 0.25, 0.75, 0.0);
    let chord_rate = safe_div(curve.chord_note_count, jsmath::max(nc, 1.0), 0.0);
    let mut jack_sorted = curve.jack_raw.clone();
    sort_asc(&mut jack_sorted);
    let jack_q95 = quantile_from_sorted(&jack_sorted, 0.95);

    let (daniel_numeric, daniel_has_native) = match precomputed_daniel {
        Some(d) => (estimate_daniel_numeric(d), has_daniel_native_numeric(d)),
        None => match up.daniel(osu_text, options, parsed) {
            Ok(d) => (estimate_daniel_numeric(&d), has_daniel_native_numeric(&d)),
            Err(_) => (None, false),
        },
    };

    let sunny_numeric = match precomputed_sunny {
        Some(s) => estimate_sunny_numeric(s),
        None => {
            let result = if force_sunny_reference_ho {
                let ho = EstimatorOptions { cvt_flag: Some("HO".into()), ..options.clone() };
                up.sunny(osu_text, &ho, parsed)
            } else {
                up.sunny(osu_text, options, parsed)
            };
            match result {
                Ok(s) => estimate_sunny_numeric(&s),
                Err(_) => None,
            }
        }
    };

    let mut daniel_for_blend = daniel_numeric;
    if !daniel_has_native {
        if let Some(dn) = fin(daniel_numeric) {
            let high_signal = jsmath::max(
                jsmath::max(
                    if primary_numeric.is_finite() { primary_numeric } else { f64::NEG_INFINITY },
                    fin(sunny_numeric).unwrap_or(f64::NEG_INFINITY),
                ),
                dn,
            );
            if high_signal < 14.0 {
                let speed_delta = speed_rate - 1.0;
                let fallback_scale = if speed_delta < 0.0 {
                    clamp((-speed_delta) * 0.43, 0.0, 1.0)
                } else {
                    clamp(speed_delta * 0.35, 0.0, 1.0)
                };
                daniel_for_blend = Some(dn * fallback_scale);
            }
        }
    }

    let blend = resolve_rc_blend(Some(primary_numeric), daniel_for_blend, sunny_numeric, (anchor_imbalance, chord_rate, jack_q95));
    let numeric_difficulty = blend.value;
    let calibrated = calibrate_numeric(numeric_difficulty, blend.low_gate, blend.high_gate);
    let gap_residual = curve_gap_residual(
        calibrated,
        blend.high_gate,
        (anchor_imbalance, chord_rate, jack_q95),
        primary_numeric,
        sunny_numeric,
        daniel_for_blend,
    );
    let pre_output = clamp(calibrated + gap_residual, -2.0, 20.0);
    let output_numeric = piecewise_linear(pre_output, &ISOTONIC_POINTS);
    let ref_correction = reference_correction(output_numeric, daniel_for_blend, sunny_numeric, Some(chord_rate));
    let mut final_numeric = clamp(output_numeric + ref_correction, -2.0, 20.0);

    if let Some(mc) = &options.marathon_correction {
        if mc.duration_s.is_finite() {
            let corr = compute_marathon_correction(mc.duration_s, mc.ett_values.as_ref(), Some(final_numeric));
            if corr > 0.0 {
                final_numeric -= corr;
            }
        }
    }

    let est_diff = numeric_to_rc_label(final_numeric);
    Ok(EstimatorResult {
        star: round_fixed(3.4 + 0.38 * final_numeric, 4),
        ln_ratio,
        column_count,
        est_diff,
        numeric_difficulty: Some(round_fixed(final_numeric, 2)),
        numeric_difficulty_hint: Some("azusa-rc-v1".into()),
        raw_numeric_difficulty: Some(round_fixed(primary_numeric, 4)),
        debug: Some(EstimatorDebug::Azusa(Box::new(AzusaDebug {
            primary_numeric: fmt4(Some(primary_numeric)),
            blend_numeric: fmt4(numeric_difficulty),
            daniel_numeric: fmt4(daniel_numeric),
            daniel_numeric_for_blend: fmt4(daniel_for_blend),
            daniel_has_native_numeric: daniel_has_native,
            sunny_numeric: fmt4(sunny_numeric),
            notes: note_count,
            calibrated_numeric: fmt4(Some(calibrated)),
            curve_anchor_imbalance: fmt4(Some(anchor_imbalance)),
            curve_chord_rate: fmt4(Some(chord_rate)),
            curve_jack_q95: fmt4(Some(jack_q95)),
            curve_gap_residual: fmt4(Some(gap_residual)),
            output_numeric: fmt4(Some(output_numeric)),
            post_curve_gap_residual: fmt4(Some(ref_correction)),
            final_numeric: fmt4(Some(final_numeric)),
            blend: [
                fixed4(blend.low_gate_source),
                fixed4(blend.low_gate),
                fixed4(blend.high_gate),
                fixed4(blend.low_base),
                fixed4(blend.high_base),
            ],
        }))),
    })
}
