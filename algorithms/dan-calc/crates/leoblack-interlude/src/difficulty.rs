use std::collections::HashMap;

use crate::chart_builder::{is_playable_note_type, InterludeRow};

#[inline]
pub fn f32r(x: f64) -> f64 {
    jsmath::fround(x)
}

pub fn keys_on_left_hand(keymode: usize) -> Result<usize, String> {
    match keymode {
        3 | 4 => Ok(2),
        5 | 6 => Ok(3),
        7 | 8 => Ok(4),
        9 | 10 => Ok(5),
        _ => Err(format!("Invalid keymode {}", keymode)),
    }
}

pub fn round_to_even(value: f64) -> f64 {
    if !value.is_finite() {
        return value;
    }
    let sign = if value < 0.0 { -1.0 } else { 1.0 };
    let abs_value = value.abs();
    let floor = abs_value.floor();
    let frac = abs_value - floor;
    if frac < 0.5 {
        return sign * floor;
    }
    if frac > 0.5 {
        return sign * (floor + 1.0);
    }
    sign * (if floor % 2.0 == 0.0 { floor } else { floor + 1.0 })
}

#[inline]
fn rate_or_one(rate: f64) -> f64 {
    if rate.is_finite() && rate > 0.0 {
        rate
    } else {
        1.0
    }
}

#[inline]
fn or_zero(x: f64) -> f64 {
    if x.is_nan() || x == 0.0 {
        0.0
    } else {
        x
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct NoteDifficulty {
    pub j: f64,
    pub sl: f64,
    pub sr: f64,
    pub total: f64,
}

fn jack_curve_cutoff() -> f64 {
    f32r(230.0)
}

fn ms_to_jack_bpm(delta: f64) -> f64 {
    let raw = if delta <= 0.0 { 230.0 } else { jsmath::min(15000.0 / delta, 230.0) };
    let value = f32r(raw);
    let cutoff = jack_curve_cutoff();
    if value < cutoff {
        value
    } else {
        cutoff
    }
}

fn ms_to_stream_bpm(delta: f64) -> f64 {
    const STREAM_CURVE_CUTOFF: f64 = 10.0;
    const STREAM_CURVE_CUTOFF_2: f64 = 10.0;
    let x = f32r(0.02 * delta);
    if !x.is_finite() || x <= 0.0 {
        return 0.0;
    }
    let value = f32r((300.0 / x) - (300.0 / jsmath::pow(x, STREAM_CURVE_CUTOFF) / STREAM_CURVE_CUTOFF_2));
    if value > 0.0 {
        value
    } else {
        0.0
    }
}

fn jack_compensation(jack_delta: f64, stream_delta: f64) -> f64 {
    let ratio = jack_delta / stream_delta;
    if !ratio.is_finite() || ratio <= 0.0 {
        return 0.0;
    }
    let compensated = jsmath::sqrt(jsmath::max(0.0, jsmath::log2(ratio)));
    jsmath::min(1.0, compensated)
}

pub fn note_difficulty_total(sl: f64, sr: f64, j: f64) -> f64 {
    const OHTNERF: f64 = 3.0;
    const STREAM_SCALE: f64 = 6.0;
    const STREAM_POW: f64 = 0.5;
    f32r(jsmath::pow(
        jsmath::pow(STREAM_SCALE * jsmath::pow(sl, STREAM_POW), OHTNERF)
            + jsmath::pow(STREAM_SCALE * jsmath::pow(sr, STREAM_POW), OHTNERF)
            + jsmath::pow(j, OHTNERF),
        1.0 / OHTNERF,
    ))
}

pub fn calculate_note_ratings(rate: f64, note_rows: &[InterludeRow]) -> Result<Vec<Vec<NoteDifficulty>>, String> {
    if note_rows.is_empty() {
        return Ok(Vec::new());
    }
    let rate_value = rate_or_one(rate);
    let keys = note_rows[0].data.len();
    let hand_split = keys_on_left_hand(keys)?;

    let mut data = vec![vec![NoteDifficulty::default(); keys]; note_rows.len()];
    let first_time = or_zero(note_rows[0].time);
    let mut last_note_in_column = vec![first_time - 1000000.0; keys];

    for (i, row) in note_rows.iter().enumerate() {
        let time = row.time;
        for k in 0..keys {
            if !is_playable_note_type(row.data[k]) {
                continue;
            }
            let jack_delta = (time - last_note_in_column[k]) / rate_value;
            let j = ms_to_jack_bpm(jack_delta);

            let (hand_lo, hand_hi) = if k < hand_split { (0, hand_split - 1) } else { (hand_split, keys - 1) };
            let mut sl = 0.0;
            let mut sr = 0.0;
            for hand_k in hand_lo..=hand_hi {
                if hand_k == k {
                    continue;
                }
                let trill_delta = (time - last_note_in_column[hand_k]) / rate_value;
                let trill_value = ms_to_stream_bpm(trill_delta) * jack_compensation(jack_delta, trill_delta);
                if hand_k < k {
                    sl = jsmath::max(sl, trill_value);
                } else {
                    sr = jsmath::max(sr, trill_value);
                }
            }

            let item = &mut data[i][k];
            item.j = j;
            item.sl = f32r(sl);
            item.sr = f32r(sr);
            item.total = note_difficulty_total(item.sl, item.sr, item.j);
        }
        for k in 0..keys {
            if is_playable_note_type(row.data[k]) {
                last_note_in_column[k] = time;
            }
        }
    }
    Ok(data)
}

#[derive(Clone, Copy)]
struct StrainFn {
    decay_rate: f64,
}

impl StrainFn {
    fn new(half_life: f64) -> Self {
        Self { decay_rate: f32r(jsmath::log(0.5) / half_life) }
    }

    #[inline]
    fn apply(self, value: f64, input: f64, delta: f64) -> f64 {
        let strain_time_cap = f32r(200.0);
        let strain_scale = f32r(0.01626);
        let clamped_delta = jsmath::min(strain_time_cap, delta);
        let decay = f32r(jsmath::exp(self.decay_rate * clamped_delta));
        let time_cap_decay = if delta > strain_time_cap {
            f32r(jsmath::exp(self.decay_rate * (delta - strain_time_cap)))
        } else {
            1.0
        };
        let a = f32r(value * time_cap_decay);
        let b = f32r(input * input * strain_scale);
        f32r(b - (b - a) * decay)
    }
}

fn strain_burst() -> StrainFn {
    StrainFn::new(1575.0)
}

fn strain_stamina() -> StrainFn {
    StrainFn::new(60000.0)
}

#[derive(Clone, Debug, PartialEq)]
pub struct FingerStrainRow {
    pub notes_v1: Vec<f64>,
    pub strain_v1_notes: Vec<f64>,
}

pub fn calculate_finger_strains(rate: f64, note_rows: &[InterludeRow], note_difficulty: &[Vec<NoteDifficulty>]) -> Vec<FingerStrainRow> {
    if note_rows.is_empty() {
        return Vec::new();
    }
    let rate_value = rate_or_one(rate);
    let keys = note_rows[0].data.len();
    let burst = strain_burst();
    let mut last_note_in_column = vec![0.0f64; keys];
    let mut strain_v1 = vec![0.0f64; keys];
    let mut output = Vec::with_capacity(note_rows.len());

    for (i, row) in note_rows.iter().enumerate() {
        let offset = row.time;
        let mut notes_v1 = vec![0.0f64; keys];
        let mut row_strain_v1 = vec![0.0f64; keys];
        for k in 0..keys {
            if !is_playable_note_type(row.data[k]) {
                continue;
            }
            notes_v1[k] = or_zero(note_difficulty[i][k].total);
            strain_v1[k] = burst.apply(strain_v1[k], notes_v1[k], (offset - last_note_in_column[k]) / rate_value);
            row_strain_v1[k] = strain_v1[k];
            last_note_in_column[k] = offset;
        }
        output.push(FingerStrainRow { notes_v1, strain_v1_notes: row_strain_v1 });
    }
    output
}

#[derive(Clone, Debug, PartialEq)]
pub struct HandStrainRow {
    pub strains: Vec<f64>,
    pub left: [f64; 2],
    pub right: [f64; 2],
}

pub fn calculate_hand_strains(
    rate: f64,
    note_rows: &[InterludeRow],
    note_difficulty: &[Vec<NoteDifficulty>],
) -> Result<Vec<HandStrainRow>, String> {
    if note_rows.is_empty() {
        return Ok(Vec::new());
    }
    let rate_value = rate_or_one(rate);
    let keys = note_rows[0].data.len();
    let hand_split = keys_on_left_hand(keys)?;
    let burst = strain_burst();
    let stamina = strain_stamina();

    let mut last_note_in_column = vec![[0.0f64; 3]; keys];
    let mut output = Vec::with_capacity(note_rows.len());

    for (i, row) in note_rows.iter().enumerate() {
        let offset = row.time;
        let mut left_burst = 0.0;
        let mut left_stamina = 0.0;
        let mut right_burst = 0.0;
        let mut right_stamina = 0.0;
        let mut strains = vec![0.0f64; keys];

        for k in 0..keys {
            if !is_playable_note_type(row.data[k]) {
                continue;
            }
            let d = or_zero(note_difficulty[i][k].total);
            if k < hand_split {
                for hand_k in 0..hand_split {
                    let [prev_burst, prev_stamina, prev_time] = last_note_in_column[hand_k];
                    left_burst = jsmath::max(left_burst, burst.apply(prev_burst, d, (offset - prev_time) / rate_value));
                    left_stamina = jsmath::max(left_stamina, stamina.apply(prev_stamina, d, (offset - prev_time) / rate_value));
                }
            } else {
                for hand_k in hand_split..keys {
                    let [prev_burst, prev_stamina, prev_time] = last_note_in_column[hand_k];
                    right_burst = jsmath::max(right_burst, burst.apply(prev_burst, d, (offset - prev_time) / rate_value));
                    right_stamina = jsmath::max(right_stamina, stamina.apply(prev_stamina, d, (offset - prev_time) / rate_value));
                }
            }
        }

        for k in 0..keys {
            if !is_playable_note_type(row.data[k]) {
                continue;
            }
            if k < hand_split {
                last_note_in_column[k] = [left_burst, left_stamina, offset];
                strains[k] = f32r(left_burst * 0.875 + left_stamina * 0.125);
            } else {
                last_note_in_column[k] = [right_burst, right_stamina, offset];
                strains[k] = f32r(right_burst * 0.875 + right_stamina * 0.125);
            }
        }

        output.push(HandStrainRow { strains, left: [left_burst, left_stamina], right: [right_burst, right_stamina] });
    }
    Ok(output)
}

#[inline]
fn bucket_key(x: f64) -> u64 {
    if x.is_nan() {
        f64::NAN.to_bits()
    } else {
        (x + 0.0).to_bits()
    }
}

pub fn calculate_variety(rate: f64, note_rows: &[InterludeRow], note_difficulties: &[Vec<NoteDifficulty>]) -> Vec<usize> {
    const VARIETY_WINDOW: f64 = 750.0;
    if note_rows.is_empty() {
        return Vec::new();
    }
    let rate_value = rate_or_one(rate);
    let keys = note_rows[0].data.len();
    let mut buckets: HashMap<u64, i64> = HashMap::new();
    let mut front = 0;
    let mut back = 0;
    let mut output = Vec::with_capacity(note_rows.len());

    for i in 0..note_rows.len() {
        let now = note_rows[i].time;
        while front < note_rows.len() && note_rows[front].time < now + VARIETY_WINDOW * rate_value {
            let front_row = &note_rows[front].data;
            for k in 0..keys {
                if !is_playable_note_type(front_row[k]) {
                    continue;
                }
                let b = round_to_even(or_zero(note_difficulties[front][k].total) / 5.0);
                *buckets.entry(bucket_key(b)).or_insert(0) += 1;
            }
            front += 1;
        }
        while back < i && note_rows[back].time < now - VARIETY_WINDOW * rate_value {
            let back_row = &note_rows[back].data;
            for k in 0..keys {
                if !is_playable_note_type(back_row[k]) {
                    continue;
                }
                let key = bucket_key(round_to_even(or_zero(note_difficulties[back][k].total) / 5.0));
                let next = buckets.get(&key).copied().unwrap_or(0) - 1;
                if next <= 0 {
                    buckets.remove(&key);
                } else {
                    buckets.insert(key, next);
                }
            }
            back += 1;
        }
        output.push(buckets.len());
    }
    output
}

fn sort_ascending(values: &mut [f64]) {
    if values.iter().all(|v| v.is_finite() && *v > 0.0) {
        values.sort_unstable_by(|a, b| a.partial_cmp(b).unwrap());
    } else {
        values.sort_by(|a, b| {
            let d = a - b;
            if d < 0.0 {
                std::cmp::Ordering::Less
            } else if d > 0.0 {
                std::cmp::Ordering::Greater
            } else {
                std::cmp::Ordering::Equal
            }
        });
    }
}

pub fn weighted_overall_difficulty(data: &[f64]) -> f64 {
    let curve_power = f32r(0.6);
    let curve_scale = f32r(0.4056);
    let most_important_notes = f32r(2500.0);

    let mut values = data.to_vec();
    sort_ascending(&mut values);
    if values.is_empty() {
        return 0.0;
    }

    let length = f32r(values.len() as f64);
    let mut weight = 0.0;
    let mut total = 0.0;
    for (i, &v) in values.iter().enumerate() {
        let x = jsmath::max(0.0, (f32r(i as f64) + most_important_notes - length) / most_important_notes);
        let w = f32r(0.002 + jsmath::pow(x, 4.0));
        weight += w;
        total += or_zero(v) * w;
    }

    if !weight.is_finite() || weight <= 0.0 {
        return 0.0;
    }
    let transformed = jsmath::pow(total / weight, curve_power) * curve_scale;
    if transformed.is_finite() {
        f32r(transformed)
    } else {
        0.0
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct InterludeDifficulty {
    pub note_difficulty: Vec<Vec<NoteDifficulty>>,
    pub strains: Vec<FingerStrainRow>,
    pub variety: Vec<usize>,
    pub hands: Vec<HandStrainRow>,
    pub overall: f64,
}

fn strain_values(strains: &[FingerStrainRow]) -> Vec<f64> {
    let mut out = Vec::new();
    for s in strains {
        for &v in &s.strain_v1_notes {
            let v = or_zero(v);
            if v > 0.0 {
                out.push(v);
            }
        }
    }
    out
}

pub fn calculate_interlude_difficulty(rate: f64, note_rows: &[InterludeRow]) -> Result<InterludeDifficulty, String> {
    if note_rows.is_empty() {
        return Ok(InterludeDifficulty { note_difficulty: Vec::new(), strains: Vec::new(), variety: Vec::new(), hands: Vec::new(), overall: 0.0 });
    }
    let note_difficulty = calculate_note_ratings(rate, note_rows)?;
    let variety = calculate_variety(rate, note_rows, &note_difficulty);
    let strains = calculate_finger_strains(rate, note_rows, &note_difficulty);
    let hands = calculate_hand_strains(rate, note_rows, &note_difficulty)?;
    let overall = weighted_overall_difficulty(&strain_values(&strains));
    Ok(InterludeDifficulty { note_difficulty, strains, variety, hands, overall: if overall.is_finite() { overall } else { 0.0 } })
}

pub fn interlude_overall(rate: f64, note_rows: &[InterludeRow]) -> Result<f64, String> {
    if note_rows.is_empty() {
        return Ok(0.0);
    }
    let rate_value = rate_or_one(rate);
    let keys = note_rows[0].data.len();
    let hand_split = keys_on_left_hand(keys)?;
    let burst = strain_burst();

    let first_time = or_zero(note_rows[0].time);
    let mut last_note_in_column = vec![first_time - 1000000.0; keys];
    let mut totals = vec![0.0f64; keys];
    let mut strain_last = vec![0.0f64; keys];
    let mut strain_v1 = vec![0.0f64; keys];
    let mut strain_values: Vec<f64> = Vec::with_capacity(note_rows.len() * 2);

    for row in note_rows {
        let time = row.time;
        for k in 0..keys {
            if !is_playable_note_type(row.data[k]) {
                continue;
            }
            let jack_delta = (time - last_note_in_column[k]) / rate_value;
            let j = ms_to_jack_bpm(jack_delta);
            let (hand_lo, hand_hi) = if k < hand_split { (0, hand_split - 1) } else { (hand_split, keys - 1) };
            let mut sl = 0.0;
            let mut sr = 0.0;
            for hand_k in hand_lo..=hand_hi {
                if hand_k == k {
                    continue;
                }
                let trill_delta = (time - last_note_in_column[hand_k]) / rate_value;
                let trill_value = ms_to_stream_bpm(trill_delta) * jack_compensation(jack_delta, trill_delta);
                if hand_k < k {
                    sl = jsmath::max(sl, trill_value);
                } else {
                    sr = jsmath::max(sr, trill_value);
                }
            }
            totals[k] = note_difficulty_total(f32r(sl), f32r(sr), j);
        }
        for k in 0..keys {
            if !is_playable_note_type(row.data[k]) {
                continue;
            }
            last_note_in_column[k] = time;
            let note = or_zero(totals[k]);
            strain_v1[k] = burst.apply(strain_v1[k], note, (time - strain_last[k]) / rate_value);
            strain_last[k] = time;
            let v = or_zero(strain_v1[k]);
            if v > 0.0 {
                strain_values.push(v);
            }
        }
    }

    let overall = weighted_overall_difficulty(&strain_values);
    Ok(if overall.is_finite() { overall } else { 0.0 })
}
