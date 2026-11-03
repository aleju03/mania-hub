use std::borrow::Cow;

use crate::azusa::{error_result, run_azusa};
use crate::common::{clamp, fmt4, or0, quantile_from_sorted, safe_div, sort_asc, sort_desc};
use crate::jsnum::{is_js_space, js_trim, number_to_string, parse_float, round_fixed, split_lines, string_to_number, to_fixed, to_int32};
use crate::marathon::compute_marathon_correction;
use crate::rc_format::{numeric_to_rc_label, rc_label_to_numeric};
use crate::roxy_meta::{evaluate_roxy_meta_model, feature_index, FEATURE_COUNT};
use crate::types::{EstimatorDebug, EstimatorOptions, EstimatorResult, OdFlag, ParseStatus, ParsedView, Upstream};

const RC_LN_RATIO_LIMIT: f64 = 0.18;
const MIN_NOTES: usize = 80;
const ROW_TOLERANCE_MS: f64 = 2.0;
const ENTROPY_WINDOW_MS: f64 = 750.0;
const SECTION_MS: f64 = 400.0;
const SECTION_DECAY: f64 = 0.9;
const SECTION_EMA_ALPHA: f64 = 0.15;
const CORRECTION_CLAMP: f64 = 1.25;
const RAW_MAP_P02: f64 = 3.9947;
const RAW_MAP_P98: f64 = 7.5454;

const STREAMS: [(&str, f64, f64, f64, f64); 7] = [
    ("speed", 0.22, 220.0, 1600.0, 0.78),
    ("handStream", 0.18, 260.0, 2200.0, 0.80),
    ("jack", 0.16, 300.0, 1800.0, 0.88),
    ("chordjack", 0.16, 260.0, 2400.0, 0.82),
    ("tech", 0.12, 450.0, 3200.0, 0.70),
    ("stamina", 0.11, 1200.0, 10000.0, 0.58),
    ("course", 0.05, 30000.0, 120000.0, 0.35),
];

const ISOTONIC_KNOTS: [[f64; 2]; 33] = [
    [-2.6250, 2.4444],
    [-2.5000, 2.9000],
    [-2.1782, 3.2000],
    [-1.6429, 3.4667],
    [-0.8081, 4.9333],
    [-0.5781, 5.0000],
    [-0.3751, 5.1250],
    [0.0878, 5.7000],
    [0.5414, 7.3500],
    [0.7248, 9.6000],
    [1.2435, 9.7625],
    [2.2100, 9.8379],
    [3.3439, 10.3810],
    [4.1521, 10.8619],
    [4.6770, 12.2111],
    [7.5944, 12.8954],
    [10.3796, 12.9333],
    [10.7539, 13.1211],
    [11.2944, 13.1733],
    [12.4106, 13.4225],
    [13.3667, 13.7143],
    [14.0177, 14.0761],
    [15.2659, 14.1489],
    [16.4144, 14.3000],
    [16.9566, 14.3174],
    [17.5080, 14.6000],
    [17.9004, 14.8917],
    [18.1870, 15.0000],
    [18.5160, 15.0636],
    [19.5870, 15.2889],
    [20.2551, 15.6111],
    [21.0298, 16.0000],
    [21.3373, 16.5833],
];

const THETA_HIGH_NUMERIC: f64 = 18.4;
const THETA_HIGH_LABEL: &str = "> CloverWisp Theta high";
const NUMERIC_OUTPUT_MAX: f64 = 30.0;
const OD_NEUTRAL: f64 = 9.0;
const CANONICAL_FIRST_OBJECT_MS: f64 = 1000.0;
const AZUSA_FUSION_WEIGHT: f64 = 0.4;
const SCOPE_MIN: f64 = 11.0;
const SCOPE_MIN_LABEL: &str = "< Alpha Low";
const SCOPE_MAX: f64 = 17.0;
const SCOPE_MAX_LABEL: &str = "> Emik Zeta high";

const REFERENCE_GAP_FEATURE_MEAN: [f64; 10] = [
    0.07809006, 0.29256211, -0.02192547, 0.26793478, 0.32663043, 0.04266659, 0.02789153, 0.00078517, 0.14369285, -0.51494749,
];
const REFERENCE_GAP_FEATURE_SCALE: [f64; 10] = [
    0.34015787, 0.32576873, 2.49325258, 0.22364344, 0.29159975, 0.17146345, 0.19191325, 0.00597972, 0.19899545, 1.40898167,
];
const REFERENCE_GAP_BETA: [f64; 11] = [
    -0.0060869565,
    0.0605011303,
    -0.1187884725,
    -0.0070736868,
    -0.0590087101,
    0.1468674261,
    0.0562217676,
    -0.1003859899,
    0.1116677492,
    -0.0281818287,
    0.0297534048,
];
const REFERENCE_GAP_CORRECTION_SCALE: f64 = 0.33;

#[derive(Clone, Debug, PartialEq, Default)]
pub struct RoxyStats {
    pub inactive_ms: f64,
    pub break_count: f64,
    pub active_duration_sec: f64,
    pub break_density: f64,
    pub avg_nps: f64,
    pub chord_rate: f64,
    pub three_rate: f64,
    pub overlap_rate: f64,
    pub rotation_rate: f64,
    pub same_hand_q10: f64,
    pub fast_jack_rate: f64,
    pub anchor_rate: f64,
    pub anchor_imbalance: f64,
    pub left_load: f64,
    pub right_load: f64,
    pub hand_bias: f64,
    pub peak_to_sustain_gap: f64,
    pub column_counts: [f64; 4],
    pub rows: f64,
    pub taps: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub struct StreamSummary {
    pub q50: f64,
    pub q75: f64,
    pub q90: f64,
    pub q97: f64,
    pub tail_mean: f64,
    pub power_mean: f64,
    pub aggregate: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub struct Corrections {
    pub low_cj: f64,
    pub high_stream: f64,
    pub high_cj_damp: f64,
    pub course_break_damp: f64,
    pub course_sustain_lift: f64,
    pub dense_js_lift: f64,
    pub dense_js_damp: f64,
    pub anchor_lift: f64,
    pub hand_bias_lift: f64,
    pub raw_sum: f64,
    pub total: f64,
}

impl Corrections {
    pub fn values(&self) -> [(&'static str, f64); 11] {
        [
            ("lowCj", self.low_cj),
            ("highStream", self.high_stream),
            ("highCjDamp", self.high_cj_damp),
            ("courseBreakDamp", self.course_break_damp),
            ("courseSustainLift", self.course_sustain_lift),
            ("denseJsLift", self.dense_js_lift),
            ("denseJsDamp", self.dense_js_damp),
            ("anchorLift", self.anchor_lift),
            ("handBiasLift", self.hand_bias_lift),
            ("rawSum", self.raw_sum),
            ("total", self.total),
        ]
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub struct References {
    pub azusa: Option<f64>,
    pub sunny: Option<f64>,
    pub daniel: Option<f64>,
    pub roxy: Option<f64>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct HighReferenceFloor {
    pub floor: f64,
    pub activation: f64,
    pub missing_reference_boost: f64,
    pub pressure: f64,
    pub confidence: f64,
    pub reference_floor: f64,
    pub structural_floor: f64,
    pub reference_target: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RoxyDebug {
    pub notes: usize,
    pub rows: usize,
    pub raw_agg: f64,
    pub log_raw: f64,
    pub pre_numeric: f64,
    pub raw_numeric: f64,
    pub structural_numeric: f64,
    pub meta_numeric: f64,
    pub base_unguarded_numeric: f64,
    pub structural_backstop_applied: bool,
    pub structural_backstop_floor: Option<f64>,
    pub structural_backstop_strength: f64,
    pub unguarded_numeric: f64,
    pub final_numeric: f64,
    pub high_reference_structural_floor: Option<HighReferenceFloor>,
    pub od_flag: Option<String>,
    pub od_base: f64,
    pub od_neutral: f64,
    pub od_effective: f64,
    pub od_base_window: Option<f64>,
    pub od_effective_window: Option<f64>,
    pub od_pressure_ratio: f64,
    pub od_correction: f64,
    pub reference_gap_correction: f64,
    pub azusa_high_gap_lift: f64,
    pub speed_rate: f64,
    pub analysis_speed_rate: f64,
    pub original_first_object_ms: Option<f64>,
    pub canonicalized: bool,
    pub feature_count: usize,
    pub references: References,
    pub stats: RoxyStats,
    pub corrections: Corrections,
    pub streams: [StreamSummary; 7],
}

impl RoxyDebug {
    pub fn final_numeric_fmt4(&self) -> Option<f64> {
        fmt4(Some(self.final_numeric))
    }
    pub fn hand_bias_fmt4(&self) -> Option<f64> {
        fmt4(Some(self.stats.hand_bias))
    }
    pub fn anchor_rate_fmt4(&self) -> Option<f64> {
        fmt4(Some(self.stats.anchor_rate))
    }
    pub fn reference_azusa_fmt4(&self) -> Option<f64> {
        fmt4(self.references.azusa)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct RoxyScopeDebug {
    pub code: String,
    pub message: String,
    pub structural_numeric: Option<f64>,
    pub notes: usize,
    pub rows: usize,
}

pub const STREAM_NAMES: [&str; 7] = ["speed", "handStream", "jack", "chordjack", "tech", "stamina", "course"];

fn gate(value: f64, min: f64, max: f64) -> f64 {
    clamp(safe_div(value - min, max - min, 0.0), 0.0, 1.0)
}

fn inverse_gate(value: f64, min: f64, max: f64) -> f64 {
    clamp(safe_div(max - value, max - min, 0.0), 0.0, 1.0)
}

#[inline]
fn strain_rate(dt: f64, base: f64, offset: f64, power: f64) -> f64 {
    let effective = jsmath::max(16.0, dt + offset);
    let value = jsmath::pow(base / effective, power);
    if value.is_finite() { jsmath::min(8.0, value) } else { 0.0 }
}

#[inline]
fn decay_state(state: f64, input: f64, dt: f64, tau: f64) -> f64 {
    let delta = if dt.is_finite() && dt > 0.0 { dt } else { 0.0 };
    let decay = jsmath::exp(-delta / tau);
    state * decay + input
}

fn piecewise_linear(x: f64, knots: &[[f64; 2]]) -> f64 {
    let value = x;
    if !value.is_finite() {
        return value;
    }
    if value <= knots[0][0] {
        return knots[0][1];
    }
    let last = knots.len() - 1;
    if value >= knots[last][0] {
        return knots[last][1];
    }
    for i in 0..last {
        let [x0, y0] = knots[i];
        let [x1, y1] = knots[i + 1];
        if value >= x0 && value <= x1 {
            return y0 + safe_div((value - x0) * (y1 - y0), x1 - x0, 0.0);
        }
    }
    value
}

fn linear_map(value: f64, x0: f64, x1: f64, y0: f64, y1: f64) -> f64 {
    y0 + safe_div((value - x0) * (y1 - y0), x1 - x0, 0.0)
}

fn quantile(values: &[f64], q: f64) -> f64 {
    let mut sorted: Vec<f64> = values.iter().copied().filter(|v| v.is_finite()).collect();
    sort_asc(&mut sorted);
    quantile_from_sorted(&sorted, q)
}

fn power_mean(values: &[f64], p: f64) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let mut acc = 0.0;
    for &v in values {
        acc += jsmath::pow(jsmath::max(0.0, v), p);
    }
    jsmath::pow(acc / values.len() as f64, 1.0 / p)
}

fn top_tail_mean(sorted: &[f64], ratio: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let count = jsmath::max(1.0, (sorted.len() as f64 * ratio).ceil()) as usize;
    let mut sum = 0.0;
    for &v in &sorted[sorted.len() - count..] {
        sum += v;
    }
    sum / count as f64
}

fn bit_count4(mask: u32) -> u32 {
    (mask & 15).count_ones()
}

fn entropy_from_counts(counts: &[i32], total: f64, normalizer: f64) -> f64 {
    if !total.is_finite() || total <= 0.0 {
        return 0.0;
    }
    let mut entropy = 0.0;
    for &count in counts {
        if count <= 0 {
            continue;
        }
        let p = count as f64 / total;
        entropy -= p * jsmath::log2(p);
    }
    clamp(entropy / normalizer, 0.0, 1.0)
}

fn normalize_cvt_flag(cvt: Option<&str>) -> Option<&'static str> {
    let normalized = js_trim(cvt.unwrap_or("")).to_uppercase();
    match normalized.as_str() {
        "HO" => Some("HO"),
        "IN" => Some("IN"),
        _ => None,
    }
}

pub(crate) fn normalize_roxy_od_flag(od: Option<&OdFlag>) -> Option<OdFlag> {
    match od? {
        OdFlag::Num(n) => n.is_finite().then_some(OdFlag::Num(*n)),
        OdFlag::Str(s) => {
            if s.is_empty() {
                return None;
            }
            let text = js_trim(s);
            if text.is_empty() {
                return None;
            }
            let upper = text.to_uppercase();
            if upper == "HR" || upper == "EZ" {
                return Some(OdFlag::Str(upper));
            }
            let numeric = parse_float(text);
            numeric.is_finite().then_some(OdFlag::Num(numeric))
        }
    }
}

fn sunny_judgement_window_from_od(od: f64) -> Option<f64> {
    if !od.is_finite() {
        return None;
    }
    let raw = 0.3 * jsmath::sqrt(jsmath::max(1e-6, (64.5 - (od * 3.0).ceil()) / 500.0));
    Some(jsmath::min(raw, 0.6 * (raw - 0.09) + 0.09))
}

fn resolve_roxy_od(base: f64, od: Option<&OdFlag>) -> f64 {
    match od {
        None => base,
        Some(OdFlag::Str(s)) if s == "HR" => 6.462 + (0.715 * base),
        Some(OdFlag::Str(s)) if s == "EZ" => -20.761 + (2.566 * base),
        Some(OdFlag::Num(n)) => {
            if n.is_finite() { *n } else { base }
        }
        Some(OdFlag::Str(s)) => {
            let n = string_to_number(s);
            if n.is_finite() { n } else { base }
        }
    }
}

struct OdDetails {
    flag: Option<String>,
    base: f64,
    effective: f64,
    base_window: Option<f64>,
    effective_window: Option<f64>,
    pressure_ratio: f64,
}

fn compute_od_details(base_od: f64, od: Option<&OdFlag>) -> OdDetails {
    let base = if base_od.is_finite() { base_od } else { 8.0 };
    let effective = resolve_roxy_od(base, od);
    let base_window = sunny_judgement_window_from_od(OD_NEUTRAL);
    let effective_window = sunny_judgement_window_from_od(effective);
    let pressure_ratio = match (base_window, effective_window) {
        (Some(b), Some(e)) if e > 1e-9 => clamp(b / e, 0.55, 1.85),
        _ => 1.0,
    };
    OdDetails {
        flag: od.map(|f| match f {
            OdFlag::Num(n) => number_to_string(*n),
            OdFlag::Str(s) => s.clone(),
        }),
        base,
        effective,
        base_window,
        effective_window,
        pressure_ratio,
    }
}

fn compute_od_correction(od: &OdDetails, numeric: f64) -> f64 {
    if od.flag.is_none() {
        return 0.0;
    }
    let ratio = od.pressure_ratio;
    if !ratio.is_finite() || (ratio - 1.0).abs() < 1e-6 {
        return 0.0;
    }
    let difficulty_gate = gate(numeric, 6.0, 18.0);
    let high_gate = gate(numeric, 14.0, 18.4);
    let correction = jsmath::log(ratio) * (3.20 + (1.90 * difficulty_gate) + (0.60 * high_gate));
    clamp(correction, -2.20, 2.20)
}

fn parse_osu_csv_line(line: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut in_quote = false;
    for ch in line.chars() {
        if ch == '"' {
            in_quote = !in_quote;
            current.push(ch);
        } else if ch == ',' && !in_quote {
            parts.push(std::mem::take(&mut current));
        } else {
            current.push(ch);
        }
    }
    parts.push(current);
    parts
}

fn is_section_header(trimmed: &str) -> bool {
    trimmed.starts_with('[') && trimmed.ends_with(']')
}

fn detect_first_hit_object_time(text: &str) -> Option<f64> {
    let mut in_hit_objects = false;
    let mut first = f64::INFINITY;
    for line in split_lines(text) {
        let trimmed = js_trim(line);
        if trimmed.is_empty() || trimmed.starts_with("//") {
            continue;
        }
        if is_section_header(trimmed) {
            in_hit_objects = trimmed == "[HitObjects]";
            continue;
        }
        if !in_hit_objects {
            continue;
        }
        let parts = parse_osu_csv_line(line);
        let time = parts.get(2).map_or(f64::NAN, |p| string_to_number(p));
        if time.is_finite() {
            first = jsmath::min(first, time);
        }
    }
    first.is_finite().then_some(first)
}

pub struct CanonicalTiming<'a> {
    pub text: Cow<'a, str>,
    pub speed_rate: f64,
    pub first_time: Option<f64>,
    pub applied: bool,
}

pub fn canonicalize_osu_timing(text: &str, speed_rate: f64) -> CanonicalTiming<'_> {
    let rate = speed_rate;
    let first_time = detect_first_hit_object_time(text);
    let Some(first) = first_time.filter(|_| rate.is_finite() && rate > 0.0) else {
        return CanonicalTiming { text: Cow::Borrowed(text), speed_rate: rate, first_time, applied: false };
    };
    let first_scaled = first / rate;
    let scale_time = |raw: &str, out: &mut String| {
        let numeric = string_to_number(raw);
        if !numeric.is_finite() {
            out.push_str(raw);
            return;
        }
        let scaled = (numeric / rate) - first_scaled + CANONICAL_FIRST_OBJECT_MS;
        out.push_str(&number_to_string(scaled.floor()));
    };
    let scale_beat_length = |raw: &str, out: &mut String| {
        let numeric = string_to_number(raw);
        if !numeric.is_finite() || numeric <= 0.0 {
            out.push_str(raw);
            return;
        }
        out.push_str(&number_to_string(round_fixed(numeric / rate, 12)));
    };

    #[derive(PartialEq)]
    enum Section {
        Other,
        Timing,
        Events,
        HitObjects,
    }
    let mut section = Section::Other;
    let mut out = String::with_capacity(text.len() + text.len() / 8);
    let mut first_line = true;
    for line in split_lines(text) {
        if !first_line {
            out.push('\n');
        }
        first_line = false;
        let trimmed = js_trim(line);
        if is_section_header(trimmed) {
            section = match trimmed {
                "[TimingPoints]" => Section::Timing,
                "[Events]" => Section::Events,
                "[HitObjects]" => Section::HitObjects,
                _ => Section::Other,
            };
            out.push_str(line);
            continue;
        }
        if trimmed.is_empty() || trimmed.starts_with("//") {
            out.push_str(line);
            continue;
        }
        match section {
            Section::Timing => {
                let parts = parse_osu_csv_line(line);
                for (i, part) in parts.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    match i {
                        0 => scale_time(part, &mut out),
                        1 => scale_beat_length(part, &mut out),
                        _ => out.push_str(part),
                    }
                }
                continue;
            }
            Section::Events => {
                let parts = parse_osu_csv_line(line);
                if js_trim(&parts[0]) == "2" && parts.len() >= 3 {
                    for (i, part) in parts.iter().enumerate() {
                        if i > 0 {
                            out.push(',');
                        }
                        if i == 1 || i == 2 {
                            scale_time(part, &mut out);
                        } else {
                            out.push_str(part);
                        }
                    }
                    continue;
                }
            }
            Section::HitObjects => {
                let parts = parse_osu_csv_line(line);
                if parts.len() >= 5 {
                    let ty = or0(string_to_number(&parts[3]));
                    let is_hold = (to_int32(ty) & 128) != 0 && !parts.get(5).map_or(true, |p| p.is_empty());
                    for (i, part) in parts.iter().enumerate() {
                        if i > 0 {
                            out.push(',');
                        }
                        if i == 2 {
                            scale_time(part, &mut out);
                        } else if i == 5 && is_hold {
                            let mut params = part.split(':');
                            let head = params.next().unwrap_or("");
                            scale_time(head, &mut out);
                            for p in params {
                                out.push(':');
                                out.push_str(p);
                            }
                        } else {
                            out.push_str(part);
                        }
                    }
                    continue;
                }
            }
            Section::Other => {}
        }
        out.push_str(line);
    }
    CanonicalTiming { text: Cow::Owned(out), speed_rate: 1.0, first_time, applied: true }
}

#[derive(Clone, Copy)]
struct Tap {
    t: f64,
    c: u32,
}

#[derive(Clone, Copy)]
struct Row {
    t: f64,
    mask: u32,
    row_size: u32,
    left_count: u32,
    right_count: u32,
    hand_mask: [u32; 2],
    nps1000: f64,
    nps4000: f64,
}

fn build_tap_rows<P: ParsedView>(parsed: &P, speed_rate: f64, tolerance: f64) -> (Vec<Tap>, Vec<Row>) {
    let mut taps = Vec::with_capacity(parsed.note_count());
    for i in 0..parsed.note_count() {
        let raw_type = or0(parsed.note_type(i));
        if (to_int32(raw_type) & 128) != 0 {
            continue;
        }
        let column = parsed.column(i);
        let start = parsed.note_start(i);
        if !column.is_finite() || column < 0.0 || column > 3.0 || !start.is_finite() {
            continue;
        }
        taps.push(Tap { t: start / speed_rate, c: (to_int32(column) & 31) as u32 });
    }
    taps.sort_by(|a, b| {
        if a.t != b.t {
            a.t.partial_cmp(&b.t).unwrap()
        } else {
            a.c.cmp(&b.c)
        }
    });
    let mut rows = Vec::new();
    let mut i = 0;
    while i < taps.len() {
        let start_time = taps[i].t;
        let mut j = i;
        let mut mask = 0u32;
        let mut row_size = 0u32;
        while j < taps.len() && (taps[j].t - start_time).abs() <= tolerance {
            let bit = 1u32 << taps[j].c;
            if mask & bit == 0 {
                row_size += 1;
            }
            mask |= bit;
            j += 1;
        }
        let left = mask & 0b0011;
        let right = mask & 0b1100;
        rows.push(Row {
            t: start_time,
            mask,
            row_size,
            left_count: bit_count4(left),
            right_count: bit_count4(right),
            hand_mask: [left, right],
            nps1000: 0.0,
            nps4000: 0.0,
        });
        i = j;
    }
    (taps, rows)
}

#[derive(Clone, Copy)]
struct Activity {
    inactive_ms: f64,
    break_count: f64,
    active_duration_sec: f64,
    break_density: f64,
    avg_nps: f64,
}

fn compute_activity_stats(rows: &[Row], tap_count: usize) -> Activity {
    if rows.len() < 2 {
        return Activity { inactive_ms: 0.0, break_count: 0.0, active_duration_sec: 1.0, break_density: 0.0, avg_nps: tap_count as f64 };
    }
    let mut inactive_ms = 0.0;
    let mut break_count = 0.0;
    for i in 1..rows.len() {
        let gap = rows[i].t - rows[i - 1].t;
        if gap > 1000.0 {
            inactive_ms += gap - 1000.0;
            break_count += 1.0;
        }
    }
    let duration_ms = jsmath::max(1.0, rows[rows.len() - 1].t - rows[0].t - inactive_ms);
    let active = duration_ms / 1000.0;
    Activity {
        inactive_ms,
        break_count,
        active_duration_sec: active,
        break_density: break_count / jsmath::max(active / 60.0, 1.0),
        avg_nps: tap_count as f64 / jsmath::max(active, 1.0),
    }
}

fn compute_nps_rows(rows: &mut [Row], tap_times: &[f64]) {
    let mut start1000 = 0usize;
    let mut start4000 = 0usize;
    let mut end = 0usize;
    let n = tap_times.len();
    for row in rows.iter_mut() {
        while end < n && tap_times[end] <= row.t + 1e-9 {
            end += 1;
        }
        let min1000 = row.t - 1000.0;
        while start1000 < n && tap_times[start1000] <= min1000 {
            start1000 += 1;
        }
        row.nps1000 = (end as f64 - start1000 as f64) / (1000.0 / 1000.0);
        let min4000 = row.t - 4000.0;
        while start4000 < n && tap_times[start4000] <= min4000 {
            start4000 += 1;
        }
        row.nps4000 = (end as f64 - start4000 as f64) / (4000.0 / 1000.0);
    }
}

fn summarize_stream(values: &[f64]) -> StreamSummary {
    let mut sorted: Vec<f64> = values.iter().copied().filter(|v| v.is_finite()).collect();
    if sorted.is_empty() {
        return StreamSummary::default();
    }
    sort_asc(&mut sorted);
    let q50 = quantile_from_sorted(&sorted, 0.50);
    let q75 = quantile_from_sorted(&sorted, 0.75);
    let q90 = quantile_from_sorted(&sorted, 0.90);
    let q97 = quantile_from_sorted(&sorted, 0.97);
    let tail_mean = top_tail_mean(&sorted, 0.04);
    let pm = power_mean(&sorted, 2.4);
    let aggregate = (0.30 * q97) + (0.22 * q90) + (0.18 * tail_mean) + (0.15 * q75) + (0.10 * pm) + (0.05 * q50);
    StreamSummary { q50, q75, q90, q97, tail_mean, power_mean: pm, aggregate }
}

fn compute_section_aggregate(rows: &[Row], local_raw: &[f64]) -> f64 {
    if rows.is_empty() || local_raw.is_empty() {
        return 0.0;
    }
    let first_time = rows[0].t;
    let mut section_max: Vec<f64> = Vec::new();
    let mut smoothed = or0(local_raw[0]);
    for i in 0..rows.len() {
        let section = jsmath::max(0.0, ((rows[i].t - first_time) / SECTION_MS).floor()) as usize;
        let raw = or0(local_raw.get(i).copied().unwrap_or(f64::NAN));
        smoothed += SECTION_EMA_ALPHA * (raw - smoothed);
        if section >= section_max.len() {
            section_max.resize(section + 1, f64::NAN);
        }
        section_max[section] = jsmath::max(or0(section_max[section]), smoothed);
    }
    let mut values: Vec<f64> = section_max.into_iter().filter(|v| v.is_finite() && *v > 0.0).collect();
    sort_desc(&mut values);
    if values.is_empty() {
        return 0.0;
    }
    let mut weight = 1.0;
    let mut total = 0.0;
    let mut weight_total = 0.0;
    for v in values {
        total += v * weight;
        weight_total += weight;
        weight *= SECTION_DECAY;
    }
    safe_div(total, weight_total, 0.0)
}

struct Curve {
    summaries: [StreamSummary; 7],
    weighted_agg: f64,
    section_agg: f64,
    stats: RoxyStats,
}

fn max_slice(values: &[f64]) -> f64 {
    let mut m = f64::NEG_INFINITY;
    for &v in values {
        m = jsmath::max(m, v);
    }
    m
}

fn compute_roxy_curve(rows: &mut [Row], tap_count: usize, activity: Activity) -> Curve {
    let mut streams: [Vec<f64>; 7] = Default::default();
    for s in streams.iter_mut() {
        s.reserve(rows.len());
    }
    let mut states = [(0.0f64, 0.0f64); 7];
    let mut last_column_time = [f64::NAN; 4];
    let mut last_hand_time = [f64::NAN; 2];
    let mut prev_hand_mask = [0u32; 2];
    let mut hand_stamina = [0.0f64; 2];
    let mut column_counts = [0.0f64; 4];
    let mut dt_same_values: Vec<f64> = Vec::with_capacity(tap_count);
    let mut dt_hand_values: Vec<f64> = Vec::with_capacity(rows.len() * 2);
    let mut local_raw: Vec<f64> = Vec::with_capacity(rows.len());

    let mut mask_counts = [0i32; 16];
    let mut transition_counts = vec![0i32; 256];
    let mut entropy_queue: Vec<(f64, u32, i32)> = Vec::with_capacity(rows.len());
    let mut entropy_back = 0usize;
    let mut mask_total = 0i64;
    let mut transition_total = 0i64;

    let mut prev_row_time = if rows.is_empty() { 0.0 } else { rows[0].t - 1000.0 };
    let mut prev_dt_row = 1000.0;
    let mut prev_mask = 0u32;
    let mut left_load = 0.0;
    let mut right_load = 0.0;
    let mut chord_rows = 0.0;
    let mut three_rows = 0.0;
    let mut overlap_sum = 0.0;
    let mut rotation_sum = 0.0;
    let mut eligible_hand_events = 0.0;
    let mut anchor_row_strength_sum = 0.0;
    let mut fast_jack_strength_sum = 0.0;

    let log24 = jsmath::log(24.0);
    let course_gate = gate(activity.active_duration_sec, 90.0, 300.0);
    let course_break = 1.0 - 0.25 * gate(activity.break_density, 0.006, 0.018);

    for i in 0..rows.len() {
        let row = rows[i];
        let dt_row = if i > 0 { jsmath::max(1.0, row.t - prev_row_time) } else { 1000.0 };
        let hand_masks = row.hand_mask;
        let mut dt_hand = [f64::NAN; 2];
        let mut rotation = [0.0f64; 2];
        let mut overlap_events = 0.0;
        for h in 0..2 {
            if hand_masks[h] == 0 {
                continue;
            }
            if last_hand_time[h].is_finite() {
                dt_hand[h] = jsmath::max(1.0, row.t - last_hand_time[h]);
                dt_hand_values.push(dt_hand[h]);
                eligible_hand_events += 1.0;
                if (hand_masks[h] & prev_hand_mask[h]) == 0 && prev_hand_mask[h] != 0 {
                    rotation[h] = 1.0;
                    rotation_sum += 1.0;
                }
                if (hand_masks[h] & prev_hand_mask[h]) != 0 {
                    overlap_events += 1.0;
                }
            }
        }
        let same_hand_overlap = overlap_events / 2.0;
        overlap_sum += same_hand_overlap;

        let mut jack_max = 0.0;
        let mut anchor_row = 0.0;
        for c in 0..4 {
            if row.mask & (1 << c) == 0 {
                continue;
            }
            column_counts[c] += 1.0;
            if last_column_time[c].is_finite() {
                let dt_same = jsmath::max(1.0, row.t - last_column_time[c]);
                dt_same_values.push(dt_same);
                anchor_row = jsmath::max(anchor_row, inverse_gate(dt_same, 220.0, 260.0));
                fast_jack_strength_sum += inverse_gate(dt_same, 120.0, 150.0);
                jack_max = jsmath::max(jack_max, strain_rate(dt_same, 185.0, 35.0, 1.18));
            }
        }
        anchor_row_strength_sum += anchor_row;

        left_load += row.left_count as f64;
        right_load += row.right_count as f64;
        if row.row_size >= 2 {
            chord_rows += 1.0;
        }
        if row.row_size >= 3 {
            three_rows += 1.0;
        }

        mask_counts[row.mask as usize] += 1;
        mask_total += 1;
        let mut transition_code = -1i32;
        if i > 0 {
            transition_code = ((prev_mask << 4) | row.mask) as i32;
            transition_counts[transition_code as usize] += 1;
            transition_total += 1;
        }
        entropy_queue.push((row.t, row.mask, transition_code));
        while entropy_back < entropy_queue.len() && entropy_queue[entropy_back].0 < row.t - ENTROPY_WINDOW_MS {
            let (_, old_mask, old_code) = entropy_queue[entropy_back];
            mask_counts[old_mask as usize] -= 1;
            mask_total -= 1;
            if old_code >= 0 {
                transition_counts[old_code as usize] -= 1;
                transition_total -= 1;
            }
            entropy_back += 1;
        }
        let entropy750 = entropy_from_counts(&mask_counts, mask_total as f64, 4.0);
        let transition_entropy750 = entropy_from_counts(&transition_counts, transition_total as f64, 8.0);
        let row_chord = (row.row_size as f64 - 1.0) / 3.0;
        let same_hand_chord = (jsmath::max(0.0, row.left_count as f64 - 1.0) + jsmath::max(0.0, row.right_count as f64 - 1.0)) / 2.0;

        let mut hand_rates = [0.0f64; 2];
        let mut hand_rate_count = 0;
        for h in 0..2 {
            if hand_masks[h] == 0 {
                continue;
            }
            let hand_dt = if dt_hand[h].is_finite() { dt_hand[h] } else { 1000.0 };
            hand_rates[hand_rate_count] = strain_rate(hand_dt, 180.0, 40.0, 1.08);
            hand_rate_count += 1;
            hand_stamina[h] = decay_state(hand_stamina[h], strain_rate(hand_dt, 180.0, 40.0, 1.08), hand_dt, 8000.0);
        }
        for h in 0..2 {
            if hand_masks[h] != 0 {
                continue;
            }
            hand_stamina[h] = decay_state(hand_stamina[h], 0.0, dt_row, 8000.0);
        }
        let rates = &hand_rates[..hand_rate_count];
        let hand_max = if rates.is_empty() { 0.0 } else { max_slice(rates) };
        let hand_mean = if rates.is_empty() {
            0.0
        } else {
            let mut sum = 0.0;
            for &r in rates {
                sum += r;
            }
            sum / rates.len() as f64
        };
        let speed_in = (0.55 * strain_rate(dt_row, 155.0, 30.0, 1.06)) + (0.30 * hand_max) + (0.15 * hand_mean);
        let jack_in = jack_max * (1.0 + 0.20 * row_chord + 0.15 * anchor_row);
        let mut hand_in = 0.0;
        for h in 0..2 {
            if hand_masks[h] == 0 {
                continue;
            }
            let hand_dt = if dt_hand[h].is_finite() { dt_hand[h] } else { 1000.0 };
            hand_in = jsmath::max(
                hand_in,
                (0.70 * strain_rate(hand_dt, 180.0, 38.0, 1.10)) + (0.30 * rotation[h] * strain_rate(hand_dt, 205.0, 45.0, 1.05)),
            );
        }
        let _ = same_hand_chord;
        let chordjack_in = row_chord * ((0.55 * jack_in) + (0.30 * same_hand_overlap) + (0.15 * hand_in));
        let rhythm_chaos = if i > 0 {
            jsmath::min(2.0, jsmath::log2((dt_row + 24.0) / (prev_dt_row + 24.0)).abs()) / 2.0
        } else {
            0.0
        };
        let tech_in = (0.32 * rhythm_chaos)
            + (0.24 * entropy750)
            + (0.24 * transition_entropy750)
            + (0.20 * (if row.mask != prev_mask { 1.0 } else { 0.0 }));
        let max_hand_stamina = jsmath::max(hand_stamina[0], hand_stamina[1]);
        let stamina_in = (0.40 * jsmath::log1p(or0(row.nps1000)) / log24)
            + (0.35 * jsmath::log1p(or0(row.nps4000)) / log24)
            + (0.25 * max_hand_stamina);
        let course_in = stamina_in * course_gate * course_break;

        let inputs = [speed_in, hand_in, jack_in, chordjack_in, tech_in, stamina_in, course_in];
        let mut raw = 0.0;
        for s in 0..7 {
            let (_, weight, burst_tau, stamina_tau, burst_mix) = STREAMS[s];
            let input = or0(inputs[s]);
            let state = &mut states[s];
            state.0 = decay_state(state.0, input, dt_row, burst_tau);
            state.1 = decay_state(state.1, input, dt_row, stamina_tau);
            let value = burst_mix * state.0 + (1.0 - burst_mix) * state.1;
            streams[s].push(value);
            raw += weight * value;
        }
        local_raw.push(raw);

        for c in 0..4 {
            if row.mask & (1 << c) != 0 {
                last_column_time[c] = row.t;
            }
        }
        for h in 0..2 {
            if hand_masks[h] != 0 {
                last_hand_time[h] = row.t;
                prev_hand_mask[h] = hand_masks[h];
            }
        }
        prev_row_time = row.t;
        prev_dt_row = dt_row;
        prev_mask = row.mask;
    }

    let mut summaries = [StreamSummary::default(); 7];
    let mut weighted_agg = 0.0;
    for s in 0..7 {
        summaries[s] = summarize_stream(&streams[s]);
        weighted_agg += STREAMS[s].1 * summaries[s].aggregate;
    }
    let section_agg = compute_section_aggregate(rows, &local_raw);
    let q97_local = quantile(&local_raw, 0.97);
    let q75_local = quantile(&local_raw, 0.75);
    let peak_to_sustain_gap = clamp(safe_div(q97_local - q75_local, jsmath::max(q97_local, 1e-6), 0.0), 0.0, 1.0);
    let finite_same_count = dt_same_values.len() as f64;
    let max_column_count = max_slice(&column_counts);
    let mut min_column_count = f64::INFINITY;
    for &c in &column_counts {
        min_column_count = jsmath::min(min_column_count, c);
    }
    let n_rows = rows.len() as f64;
    let stats = RoxyStats {
        inactive_ms: activity.inactive_ms,
        break_count: activity.break_count,
        active_duration_sec: activity.active_duration_sec,
        break_density: activity.break_density,
        avg_nps: activity.avg_nps,
        chord_rate: chord_rows / jsmath::max(n_rows, 1.0),
        three_rate: three_rows / jsmath::max(n_rows, 1.0),
        overlap_rate: overlap_sum / jsmath::max(n_rows, 1.0),
        rotation_rate: rotation_sum / jsmath::max(eligible_hand_events, 1.0),
        same_hand_q10: quantile(&dt_hand_values, 0.10),
        fast_jack_rate: fast_jack_strength_sum / jsmath::max(finite_same_count, 1.0),
        anchor_rate: anchor_row_strength_sum / jsmath::max(n_rows, 1.0),
        anchor_imbalance: (max_column_count - min_column_count) / jsmath::max(tap_count as f64, 1.0),
        left_load,
        right_load,
        hand_bias: (left_load - right_load).abs() / jsmath::max(jsmath::max(left_load, right_load), 1e-6),
        peak_to_sustain_gap,
        column_counts,
        rows: n_rows,
        taps: tap_count as f64,
    };
    Curve { summaries, weighted_agg, section_agg, stats }
}

fn compute_corrections(s: &RoxyStats) -> Corrections {
    let low_cj = 0.75
        * gate(s.chord_rate, 0.48, 0.68)
        * gate(s.overlap_rate, 0.75, 1.25)
        * (1.0 - gate(s.avg_nps, 19.0, 23.0))
        * (1.0 - gate(s.anchor_imbalance, 0.06, 0.12));
    let high_stream = 0.65
        * gate(s.rotation_rate, 0.68, 0.86)
        * inverse_gate(s.same_hand_q10, 100.0, 130.0)
        * (1.0 - gate(s.chord_rate, 0.25, 0.42))
        * (1.0 - gate(s.overlap_rate, 0.65, 0.95));
    let high_cj_damp = -0.55 * gate(s.chord_rate, 0.78, 0.90) * gate(s.three_rate, 0.18, 0.38) * (1.0 - gate(s.fast_jack_rate, 0.55, 0.75));
    let course_break_damp = -0.70
        * gate(s.active_duration_sec, 240.0, 480.0)
        * gate(s.break_density, 0.006, 0.018)
        * gate(s.peak_to_sustain_gap, 0.35, 0.75)
        * inverse_gate(s.avg_nps, 12.0, 18.0);
    let course_sustain_lift = 0.30
        * gate(s.active_duration_sec, 240.0, 600.0)
        * inverse_gate(s.break_density, 0.004, 0.012)
        * inverse_gate(s.peak_to_sustain_gap, 0.15, 0.45)
        * gate(s.avg_nps, 15.0, 21.0);
    let dense_js_lift = 0.35 * gate(s.chord_rate, 0.35, 0.52) * gate(s.rotation_rate, 0.62, 0.80) * inverse_gate(s.same_hand_q10, 90.0, 125.0);
    let dense_js_damp = -0.25 * gate(s.chord_rate, 0.58, 0.75) * inverse_gate(s.rotation_rate, 0.45, 0.62);
    let anchor_lift = 0.30 * gate(s.anchor_rate, 0.18, 0.38) * gate(s.fast_jack_rate, 0.25, 0.55) * (1.0 - gate(s.chord_rate, 0.65, 0.85));
    let hand_bias_lift = 0.25 * gate(s.hand_bias, 0.25, 0.55) * gate(s.avg_nps, 12.0, 20.0);
    let raw_sum = low_cj
        + high_stream
        + high_cj_damp
        + course_break_damp
        + course_sustain_lift
        + dense_js_lift
        + dense_js_damp
        + anchor_lift
        + hand_bias_lift;
    let total = clamp(raw_sum, -CORRECTION_CLAMP, CORRECTION_CLAMP);
    Corrections {
        low_cj,
        high_stream,
        high_cj_damp,
        course_break_damp,
        course_sustain_lift,
        dense_js_lift,
        dense_js_damp,
        anchor_lift,
        hand_bias_lift,
        raw_sum,
        total,
    }
}

struct NumericDetails {
    raw_agg: f64,
    log_raw: f64,
    pre_numeric: f64,
    corrections: Corrections,
    raw_numeric: f64,
    numeric: f64,
}

fn compute_roxy_numeric(curve: &Curve) -> NumericDetails {
    let raw_agg = (0.80 * curve.weighted_agg) + (0.20 * curve.section_agg);
    let log_raw = jsmath::log1p(jsmath::max(0.0, raw_agg));
    let pre_numeric = clamp(linear_map(log_raw, RAW_MAP_P02, RAW_MAP_P98, -2.0, 20.0), -2.5, 21.0);
    let corrections = compute_corrections(&curve.stats);
    let raw_numeric = pre_numeric + corrections.total;
    let numeric = clamp(piecewise_linear(raw_numeric, &ISOTONIC_KNOTS), -2.0, 20.0);
    NumericDetails { raw_agg, log_raw, pre_numeric, corrections, raw_numeric, numeric }
}

#[inline]
fn to_feature_number(v: f64) -> f64 {
    if v.is_finite() { v } else { 0.0 }
}

fn rounded_feature(v: f64) -> f64 {
    if v.is_finite() { round_fixed(v, 4) } else { 0.0 }
}

fn quantize_feature(v: f64, step: f64) -> f64 {
    if !v.is_finite() || !step.is_finite() || step <= 0.0 {
        return 0.0;
    }
    round_fixed(jsmath::round(v / step) * step, 4)
}

#[inline]
fn num_or_null0(v: Option<f64>) -> f64 {
    v.unwrap_or(0.0)
}

fn compute_reference_gap_correction(refs: &References, structural: f64, base: f64, stats: &RoxyStats) -> f64 {
    if !base.is_finite() {
        return 0.0;
    }
    let has_azusa = matches!(refs.azusa, Some(v) if v.is_finite());
    let has_daniel = matches!(refs.daniel, Some(v) if v.is_finite());
    if !has_azusa && !has_daniel {
        return 0.0;
    }
    let azusa = if has_azusa { refs.azusa.unwrap() } else { base };
    let daniel = if has_daniel { refs.daniel.unwrap() } else { base };
    let structural = if structural.is_finite() { structural } else { base };
    let azusa_gap = azusa - base;
    let daniel_gap = daniel - base;
    let structural_gap = structural - base;
    let chord_rate = to_feature_number(stats.chord_rate);
    let rotation_rate = to_feature_number(stats.rotation_rate);
    let same_hand_q10 = to_feature_number(stats.same_hand_q10);
    let avg_nps_gate = gate(to_feature_number(stats.avg_nps), 12.0, 24.0);
    let features = [
        azusa_gap,
        daniel_gap,
        structural_gap,
        azusa_gap.abs(),
        daniel_gap.abs(),
        azusa_gap * chord_rate,
        azusa_gap * rotation_rate,
        azusa_gap / (same_hand_q10 + 1.0),
        daniel_gap * chord_rate,
        structural_gap * avg_nps_gate,
    ];
    let mut value = REFERENCE_GAP_BETA[0];
    for i in 0..features.len() {
        let s = REFERENCE_GAP_FEATURE_SCALE[i];
        let scale = if s == 0.0 || s.is_nan() { 1.0 } else { s };
        value += REFERENCE_GAP_BETA[i + 1] * ((features[i] - REFERENCE_GAP_FEATURE_MEAN[i]) / scale);
    }
    clamp(value, -0.30, 0.30) * REFERENCE_GAP_CORRECTION_SCALE
}

fn compute_azusa_high_gap_lift(refs: &References, base: f64) -> f64 {
    let azusa = num_or_null0(refs.azusa);
    if !base.is_finite() || !azusa.is_finite() {
        return 0.0;
    }
    0.05 * gate(azusa - base, 0.35, 0.95)
}

fn compute_azusa_fusion(refs: &References, final_numeric: f64) -> f64 {
    let azusa = num_or_null0(refs.azusa);
    let base = final_numeric;
    if !azusa.is_finite() || !base.is_finite() {
        return final_numeric;
    }
    let fused = base + (azusa - base) * AZUSA_FUSION_WEIGHT;
    round_fixed(fused, 2)
}

fn result_numeric(result: &EstimatorResult) -> Option<f64> {
    if let Some(n) = result.numeric_difficulty {
        if n.is_finite() {
            return Some(n);
        }
    }
    rc_label_to_numeric(&result.est_diff)
}

fn failed_reference() -> EstimatorResult {
    EstimatorResult::basic(f64::NAN, f64::NAN, f64::NAN, "Invalid: Reference estimator failed".into(), None, None)
}

fn safe_reference(result: Result<EstimatorResult, String>) -> EstimatorResult {
    result.unwrap_or_else(|_| failed_reference())
}

fn stabilize_high_reference_predictions(p: References, structural: f64) -> References {
    let azusa = num_or_null0(p.azusa);
    if !azusa.is_finite() || azusa < 16.8 {
        return p;
    }
    let roxy = num_or_null0(p.roxy);
    let mut finite: Vec<f64> = [p.azusa, p.sunny, p.daniel].into_iter().flatten().filter(|v| v.is_finite()).collect();
    sort_asc(&mut finite);
    let median = if finite.is_empty() { azusa } else { finite[finite.len() / 2] };
    let support = jsmath::max(
        if roxy.is_finite() { roxy } else { f64::NEG_INFINITY },
        if structural.is_finite() { structural } else { f64::NEG_INFINITY },
    );
    let fallback = jsmath::max(
        jsmath::max(if support.is_finite() { support } else { azusa - 0.35 }, azusa - 0.35),
        median - 0.10,
    );
    let mut out = p;
    for slot in [&mut out.sunny, &mut out.daniel] {
        if !matches!(slot, Some(v) if v.is_finite()) {
            *slot = Some(fallback);
        }
    }
    out
}

fn build_reference_predictions<U: Upstream>(up: &U, text: &str, meta_options: &EstimatorOptions, structural: f64) -> References {
    let reference_options = meta_options.clone();
    let parsed = up.parse(text, None).ok();
    let sunny_result = match meta_options.precomputed_sunny_result {
        Some(s) => s.clone(),
        None => safe_reference(up.sunny(text, &reference_options, parsed.as_ref())),
    };
    let daniel_result = match meta_options.precomputed_daniel_result {
        Some(d) => d.clone(),
        None => safe_reference(up.daniel(text, &reference_options, parsed.as_ref())),
    };
    let azusa_options = EstimatorOptions {
        precomputed_sunny_result: Some(&sunny_result),
        precomputed_daniel_result: Some(&daniel_result),
        ..reference_options.clone()
    };
    let azusa_result = safe_reference(run_azusa(up, text, &azusa_options, parsed.as_ref()));
    let mut predictions = stabilize_high_reference_predictions(
        References {
            azusa: result_numeric(&azusa_result),
            sunny: result_numeric(&sunny_result),
            daniel: result_numeric(&daniel_result),
            roxy: structural.is_finite().then_some(structural),
        },
        structural,
    );
    predictions.sunny = None;
    predictions
}

const META_ALGOS: [&str; 4] = ["Azusa", "Sunny", "Daniel", "Roxy"];

fn build_roxy_meta_features(refs: &References, nd: &NumericDetails, curve: &Curve, structural: f64) -> [f64; FEATURE_COUNT] {
    let mut features = [f64::NAN; FEATURE_COUNT];
    let mut set = |name: &str, value: f64| {
        if let Some(i) = feature_index(name) {
            features[i] = to_feature_number(value);
        }
    };
    let by_algo = |algo: &str| -> Option<f64> {
        match algo {
            "Azusa" => refs.azusa,
            "Sunny" => refs.sunny,
            "Daniel" => refs.daniel,
            _ => refs.roxy,
        }
    };
    let mut fallback_candidates = Vec::with_capacity(4);
    for algo in META_ALGOS {
        if let Some(v) = by_algo(algo) {
            if v.is_finite() {
                fallback_candidates.push(quantize_feature(v, 1.0));
            }
        }
    }
    if fallback_candidates.is_empty() && structural.is_finite() {
        fallback_candidates.push(quantize_feature(structural, 1.0));
    }
    sort_asc(&mut fallback_candidates);
    let fallback = if fallback_candidates.is_empty() { 0.0 } else { fallback_candidates[fallback_candidates.len() / 2] };

    let mut normalized = [0.0f64; 4];
    let mut finite_predictions = Vec::with_capacity(4);
    for (k, algo) in META_ALGOS.iter().enumerate() {
        let value = by_algo(algo);
        let has = matches!(value, Some(v) if v.is_finite());
        let nv = if has { quantize_feature(value.unwrap(), 1.0) } else { fallback };
        normalized[k] = nv;
        set(&format!("pred_{algo}"), nv);
        set(&format!("has_{algo}"), if has { 1.0 } else { 0.0 });
        finite_predictions.push(nv);
    }
    sort_asc(&mut finite_predictions);
    let pred_min = finite_predictions[0];
    let pred_max = finite_predictions[finite_predictions.len() - 1];
    let mut sum = 0.0;
    for &v in &finite_predictions {
        sum += v;
    }
    let pred_mean = sum / finite_predictions.len() as f64;
    let pred_median = finite_predictions[finite_predictions.len() / 2];
    set("pred_min", pred_min);
    set("pred_max", pred_max);
    set("pred_mean", pred_mean);
    set("pred_median", pred_median);
    set("pred_range", pred_max - pred_min);

    let idx = |algo: &str| META_ALGOS.iter().position(|a| *a == algo).unwrap();
    for (left, right) in [("Azusa", "Daniel"), ("Azusa", "Sunny"), ("Azusa", "Roxy"), ("Daniel", "Sunny"), ("Daniel", "Roxy"), ("Sunny", "Roxy")] {
        let diff = to_feature_number(normalized[idx(left)]) - to_feature_number(normalized[idx(right)]);
        set(&format!("diff_{left}_{right}"), diff);
        set(&format!("absdiff_{left}_{right}"), diff.abs());
    }

    set("roxy_logRaw", rounded_feature(nd.log_raw));
    set("roxy_rawAgg", rounded_feature(nd.raw_agg));
    set("roxy_preNumeric", rounded_feature(nd.pre_numeric));
    set("roxy_rawNumeric", rounded_feature(nd.raw_numeric));
    set("roxy_finalNumeric", rounded_feature(structural));
    let c = &nd.corrections;
    for (name, value) in [
        ("lowCj", c.low_cj),
        ("highStream", c.high_stream),
        ("highCjDamp", c.high_cj_damp),
        ("courseBreakDamp", c.course_break_damp),
        ("courseSustainLift", c.course_sustain_lift),
        ("denseJsLift", c.dense_js_lift),
        ("denseJsDamp", c.dense_js_damp),
        ("anchorLift", c.anchor_lift),
        ("handBiasLift", c.hand_bias_lift),
        ("total", c.total),
    ] {
        set(&format!("corr_{name}"), rounded_feature(value));
    }
    for (s, stream) in STREAM_NAMES.iter().enumerate() {
        let sm = &curve.summaries[s];
        for (key, value) in [
            ("aggregate", sm.aggregate),
            ("q97", sm.q97),
            ("q90", sm.q90),
            ("q75", sm.q75),
            ("q50", sm.q50),
            ("tailMean", sm.tail_mean),
            ("powerMean", sm.power_mean),
        ] {
            set(&format!("{stream}_{key}"), rounded_feature(value));
        }
    }
    let st = &curve.stats;
    for (name, value) in [
        ("activeDurationSec", st.active_duration_sec),
        ("breakCount", st.break_count),
        ("breakDensity", st.break_density),
        ("avgNps", st.avg_nps),
        ("chordRate", st.chord_rate),
        ("threeRate", st.three_rate),
        ("overlapRate", st.overlap_rate),
        ("rotationRate", st.rotation_rate),
        ("sameHandQ10", st.same_hand_q10),
        ("fastJackRate", st.fast_jack_rate),
        ("anchorRate", st.anchor_rate),
        ("anchorImbalance", st.anchor_imbalance),
        ("handBias", st.hand_bias),
        ("peakToSustainGap", st.peak_to_sustain_gap),
        ("rows", st.rows),
        ("taps", st.taps),
    ] {
        set(&format!("stat_{name}"), rounded_feature(value));
    }
    let avg_nps = to_feature_number(st.avg_nps);
    let active = to_feature_number(st.active_duration_sec);
    let chord_rate = to_feature_number(st.chord_rate);
    let fast_jack = to_feature_number(st.fast_jack_rate);
    let overlap = to_feature_number(st.overlap_rate);
    let rotation = to_feature_number(st.rotation_rate);
    let q10 = to_feature_number(st.same_hand_q10);
    let break_density = to_feature_number(st.break_density);
    let peak_gap = to_feature_number(st.peak_to_sustain_gap);
    set("logAvgNps", jsmath::log1p(jsmath::max(0.0, avg_nps)));
    set("logDuration", jsmath::log1p(jsmath::max(0.0, active)));
    set("chordFast", chord_rate * fast_jack);
    set("chordOverlap", chord_rate * overlap);
    set("rotationInvQ10", rotation / (q10 + 1.0));
    set("breakPeak", break_density * peak_gap);
    for f in features.iter_mut() {
        if f.is_nan() {
            *f = 0.0;
        }
    }
    features
}

fn compute_high_reference_structural_floor(refs: &References, nd: &NumericDetails, curve: &Curve, od_correction: f64) -> Option<HighReferenceFloor> {
    let azusa = num_or_null0(refs.azusa);
    if !azusa.is_finite() || azusa < 17.0 {
        return None;
    }
    let has_sunny = matches!(refs.sunny, Some(v) if v.is_finite());
    let has_daniel = matches!(refs.daniel, Some(v) if v.is_finite());
    let st = &curve.stats;
    let avg_nps = to_feature_number(st.avg_nps);
    let chord_rate = to_feature_number(st.chord_rate);
    let same_hand_q10 = to_feature_number(st.same_hand_q10);
    if avg_nps < 25.0 || chord_rate < 0.70 || same_hand_q10 > 95.0 {
        return None;
    }
    let density_gate = gate(avg_nps, 27.0, 38.0);
    let chord_gate = gate(chord_rate, 0.78, 0.92);
    let three_gate = gate(to_feature_number(st.three_rate), 0.45, 0.72);
    let jack_gate = gate(to_feature_number(curve.summaries[2].aggregate), 17.5, 21.8);
    let chordjack_gate = gate(to_feature_number(curve.summaries[3].aggregate), 12.4, 15.6);
    let fast_hand_gate = inverse_gate(same_hand_q10, 70.0, 110.0);
    let duration_gate = gate(to_feature_number(st.active_duration_sec), 50.0, 100.0);
    let raw_gate = gate(to_feature_number(nd.raw_numeric), 6.0, 17.0);
    let pressure = clamp(
        (0.20 * density_gate)
            + (0.14 * chord_gate)
            + (0.10 * three_gate)
            + (0.20 * jack_gate)
            + (0.16 * chordjack_gate)
            + (0.14 * fast_hand_gate)
            + (0.06 * duration_gate),
        0.0,
        1.0,
    );
    let pressure_gate = gate(pressure, 0.22, 0.46);
    let azusa_gate = gate(azusa, 17.0, 18.0);
    let missing_ratio = ((if !has_sunny { 1.0 } else { 0.0 }) + (if !has_daniel { 1.0 } else { 0.0 })) / 2.0;
    let missing_boost = missing_ratio * gate(pressure, 0.25, 0.40) * gate(azusa, 17.5, 18.2);
    let activation = clamp((pressure_gate * azusa_gate) + missing_boost, 0.0, 1.0);
    if activation <= 0.0 {
        return None;
    }
    let confidence = pressure_gate * gate(azusa, 17.0, 20.0);
    let reference_floor = azusa - (0.45 - (0.25 * confidence));
    let structural_floor = 16.65 + (1.55 * confidence) + (0.35 * raw_gate) + (0.25 * gate(avg_nps, 35.0, 45.0));
    let od_adjustment = jsmath::min(0.0, or0(od_correction)) * 0.25;
    let structural_target = structural_floor + od_adjustment;
    let reference_target = jsmath::max(reference_floor, structural_floor) + od_adjustment;
    let floor = structural_target + ((reference_target - structural_target) * activation);
    Some(HighReferenceFloor {
        floor: clamp(floor, 16.8, jsmath::min(18.65, azusa + 0.30)),
        activation,
        missing_reference_boost: missing_boost,
        pressure,
        confidence,
        reference_floor,
        structural_floor,
        reference_target,
    })
}

fn scope_result(label: &str, code: &str, structural: f64, raw_numeric: f64, ln_ratio: f64, column_count: f64, notes: usize, rows: usize) -> EstimatorResult {
    EstimatorResult {
        star: round_fixed(3.4 + 0.38 * structural, 4),
        ln_ratio: if ln_ratio.is_finite() { ln_ratio } else { 0.0 },
        column_count: if column_count.is_finite() { column_count } else { 0.0 },
        est_diff: label.to_string(),
        numeric_difficulty: None,
        numeric_difficulty_hint: Some(code.to_string()),
        raw_numeric_difficulty: raw_numeric.is_finite().then(|| round_fixed(raw_numeric, 4)),
        debug: Some(EstimatorDebug::RoxyScope(Box::new(RoxyScopeDebug {
            code: code.to_string(),
            message: format!("Roxy RC scope {label} (structural {})", to_fixed(structural, 2)),
            structural_numeric: fmt4(Some(structural)),
            notes,
            rows,
        }))),
    }
}

fn numeric_to_roxy_rc_label(numeric: f64) -> String {
    if numeric.is_finite() && numeric > THETA_HIGH_NUMERIC {
        return THETA_HIGH_LABEL.into();
    }
    numeric_to_rc_label(numeric)
}

pub fn run_roxy<U: Upstream>(up: &U, osu_text: &str, options: &EstimatorOptions, parsed: Option<&U::Parsed>) -> EstimatorResult {
    match run_roxy_inner(up, osu_text, options, parsed) {
        Ok(r) => r,
        Err(message) => {
            let message = if message.is_empty() { "Roxy estimator failed".to_string() } else { message };
            error_result("RoxyError", message, 0.0, 0.0)
        }
    }
}

fn run_roxy_inner<U: Upstream>(up: &U, osu_text: &str, options: &EstimatorOptions, parsed: Option<&U::Parsed>) -> Result<EstimatorResult, String> {
    if osu_text.trim_matches(is_js_space).is_empty() {
        return Ok(error_result("EmptyInput", "Beatmap text is empty".into(), 0.0, 0.0));
    }
    let speed_rate = options.speed_rate.unwrap_or(1.0);
    if !speed_rate.is_finite() || speed_rate <= 0.0 {
        return Ok(error_result("InvalidSpeedRate", "Invalid speed rate".into(), 0.0, 0.0));
    }
    let od_flag = normalize_roxy_od_flag(options.od_flag.as_ref());
    let timing = canonicalize_osu_timing(osu_text, speed_rate);
    let analysis_text: &str = &timing.text;
    let analysis_speed_rate = timing.speed_rate;
    let effective_options = EstimatorOptions { od_flag: od_flag.clone(), speed_rate: Some(analysis_speed_rate), ..options.clone() };

    let cvt = normalize_cvt_flag(effective_options.cvt_flag.as_deref());
    let can_share = parsed.is_some() && speed_rate == 1.0 && cvt.is_none();
    let owned;
    let parser: &U::Parsed = if can_share {
        parsed.unwrap()
    } else {
        owned = up.parse(analysis_text, cvt)?;
        &owned
    };
    let od_details = compute_od_details(parser.od(), od_flag.as_ref());
    let ln_ratio = or0(parser.ln_ratio());
    let column_count = or0(parser.column_count());

    match parser.status() {
        ParseStatus::Fail => return Ok(error_result("ParseFailed", "Beatmap parse failed".into(), ln_ratio, column_count)),
        ParseStatus::NotMania => return Ok(error_result("NotMania", "Beatmap mode is not mania".into(), ln_ratio, column_count)),
        _ => {}
    }
    if column_count != 4.0 {
        return Ok(error_result("UnsupportedKeys", "Roxy only supports 4K".into(), ln_ratio, column_count));
    }
    if ln_ratio > RC_LN_RATIO_LIMIT {
        return Ok(error_result(
            "UnsupportedLN",
            format!("Roxy RC scope rejects LN ratio {}%", to_fixed(ln_ratio * 100.0, 1)),
            ln_ratio,
            column_count,
        ));
    }

    let (taps, mut rows) = build_tap_rows(parser, analysis_speed_rate, ROW_TOLERANCE_MS);
    if taps.len() < MIN_NOTES || rows.len() < 2 {
        return Ok(error_result("TooFewNotes", "Not enough RC tap notes".into(), ln_ratio, column_count));
    }
    let tap_times: Vec<f64> = taps.iter().map(|t| t.t).collect();
    compute_nps_rows(&mut rows, &tap_times);
    let activity = compute_activity_stats(&rows, taps.len());
    let curve = compute_roxy_curve(&mut rows, taps.len(), activity);
    let nd = compute_roxy_numeric(&curve);
    let structural = round_fixed(nd.numeric, 2);

    let meta_options = EstimatorOptions {
        od_flag: Some(OdFlag::Num(OD_NEUTRAL)),
        precomputed_sunny_result: None,
        ..effective_options.clone()
    };
    let refs = build_reference_predictions(up, analysis_text, &meta_options, structural);
    let features = build_roxy_meta_features(&refs, &nd, &curve, structural);
    let meta_numeric = evaluate_roxy_meta_model(&features);

    let mut base_unguarded = if meta_numeric.is_finite() { meta_numeric } else { structural };
    let backstop_strength = if structural.is_finite() { gate(structural, 12.25, 14.0) } else { 0.0 };
    let backstop = (backstop_strength > 0.0).then(|| structural - 0.15);
    let backstop_gap = backstop.map_or(0.0, |b| b - base_unguarded);
    let backstop_applied = backstop.is_some() && backstop_gap > 0.0 && backstop_gap <= 0.35;
    if backstop_applied {
        base_unguarded += (backstop.unwrap() - base_unguarded) * backstop_strength;
    }
    let od_correction = compute_od_correction(&od_details, base_unguarded);
    let mut unguarded = clamp(base_unguarded + od_correction, -2.0, NUMERIC_OUTPUT_MAX);
    let high_floor = compute_high_reference_structural_floor(&refs, &nd, &curve, od_correction);
    if let Some(f) = &high_floor {
        unguarded = jsmath::max(unguarded, f.floor);
    }
    let reference_gap = if od_details.flag.is_none() {
        compute_reference_gap_correction(&refs, structural, unguarded, &curve.stats)
    } else {
        0.0
    };
    unguarded = clamp(unguarded + reference_gap, -2.0, NUMERIC_OUTPUT_MAX);
    let high_gap_lift = if od_details.flag.is_none() { compute_azusa_high_gap_lift(&refs, unguarded) } else { 0.0 };
    unguarded = clamp(unguarded + high_gap_lift, -2.0, NUMERIC_OUTPUT_MAX);
    let mut final_numeric = compute_azusa_fusion(&refs, round_fixed(unguarded, 2));

    if let Some(mc) = &options.marathon_correction {
        if mc.duration_s.is_finite() {
            let corr = compute_marathon_correction(mc.duration_s, mc.ett_values.as_ref(), Some(final_numeric));
            if corr > 0.0 {
                final_numeric -= corr;
            }
        }
    }

    if final_numeric < SCOPE_MIN {
        return Ok(scope_result(SCOPE_MIN_LABEL, "BelowScope", final_numeric, nd.raw_numeric, ln_ratio, column_count, taps.len(), rows.len()));
    }
    if final_numeric >= SCOPE_MAX {
        return Ok(scope_result(SCOPE_MAX_LABEL, "AboveScope", final_numeric, nd.raw_numeric, ln_ratio, column_count, taps.len(), rows.len()));
    }

    let est_diff = numeric_to_roxy_rc_label(final_numeric);
    Ok(EstimatorResult {
        star: round_fixed(3.4 + 0.38 * final_numeric, 4),
        ln_ratio,
        column_count,
        est_diff,
        numeric_difficulty: Some(final_numeric),
        numeric_difficulty_hint: Some("roxy-meta-ridge-v3".into()),
        raw_numeric_difficulty: Some(round_fixed(nd.raw_numeric, 4)),
        debug: Some(EstimatorDebug::Roxy(Box::new(RoxyDebug {
            notes: taps.len(),
            rows: rows.len(),
            raw_agg: nd.raw_agg,
            log_raw: nd.log_raw,
            pre_numeric: nd.pre_numeric,
            raw_numeric: nd.raw_numeric,
            structural_numeric: structural,
            meta_numeric,
            base_unguarded_numeric: base_unguarded,
            structural_backstop_applied: backstop_applied,
            structural_backstop_floor: backstop,
            structural_backstop_strength: backstop_strength,
            unguarded_numeric: unguarded,
            final_numeric,
            high_reference_structural_floor: high_floor,
            od_flag: od_details.flag.clone(),
            od_base: od_details.base,
            od_neutral: OD_NEUTRAL,
            od_effective: od_details.effective,
            od_base_window: od_details.base_window,
            od_effective_window: od_details.effective_window,
            od_pressure_ratio: od_details.pressure_ratio,
            od_correction,
            reference_gap_correction: reference_gap,
            azusa_high_gap_lift: high_gap_lift,
            speed_rate,
            analysis_speed_rate,
            original_first_object_ms: timing.first_time,
            canonicalized: timing.applied,
            feature_count: FEATURE_COUNT,
            references: refs,
            stats: curve.stats.clone(),
            corrections: nd.corrections,
            streams: curve.summaries,
        }))),
    })
}
