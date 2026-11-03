use std::collections::HashMap;

pub mod note_type {
    pub const NOTHING: u8 = 0;
    pub const NORMAL: u8 = 1;
    pub const HOLDHEAD: u8 = 2;
    pub const HOLDBODY: u8 = 3;
    pub const HOLDTAIL: u8 = 4;
}
use note_type as nt;

#[derive(Clone, Copy, Debug)]
pub struct ParsedNotes<'a> {
    pub column_count: f64,
    pub columns: &'a [f64],
    pub note_starts: &'a [f64],
    pub note_ends: &'a [f64],
    pub note_types: &'a [f64],
}

impl<'a> ParsedNotes<'a> {
    pub fn from_parser(p: &'a leoblack_parser::OsuFileParser) -> Self {
        ParsedNotes {
            column_count: p.column_count,
            columns: &p.columns,
            note_starts: &p.note_starts,
            note_ends: &p.note_ends,
            note_types: &p.note_types,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct InterludeRow {
    pub time: f64,
    pub data: Vec<u8>,
}

#[inline]
pub fn is_playable_note_type(note_type: u8) -> bool {
    note_type == nt::NORMAL || note_type == nt::HOLDHEAD
}

pub fn is_row_empty(row: &[u8]) -> bool {
    row.iter().all(|&n| n == nt::NOTHING || n == nt::HOLDBODY)
}

#[inline]
fn or_zero(x: f64) -> f64 {
    if x.is_nan() || x == 0.0 {
        0.0
    } else {
        x
    }
}

#[inline]
fn time_key(t: f64) -> u64 {
    (t + 0.0).to_bits()
}

fn set_note_type(row: &mut [u8], key: usize, note_type: u8) {
    if row[key] == nt::NOTHING {
        row[key] = note_type;
    }
}

pub fn build_rows_from_parsed(parsed: &ParsedNotes<'_>) -> Vec<InterludeRow> {
    let key_count = or_zero(parsed.column_count);
    if key_count < 3.0 || key_count > 10.0 {
        return Vec::new();
    }
    let keys = key_count as usize;

    let mut rows: Vec<InterludeRow> = Vec::new();
    let mut row_index: HashMap<u64, usize> = HashMap::new();
    let mut get_or_create = |rows: &mut Vec<InterludeRow>, time: f64| -> usize {
        *row_index.entry(time_key(time)).or_insert_with(|| {
            rows.push(InterludeRow { time: time + 0.0, data: vec![nt::NOTHING; keys] });
            rows.len() - 1
        })
    };
    let mut hold_spans: Vec<(usize, f64, f64)> = Vec::new();

    let n = parsed.columns.len();
    let at = |v: &[f64], i: usize| -> f64 { v.get(i).copied().unwrap_or(f64::NAN) };
    for i in 0..n {
        let key = parsed.columns[i];
        let start_time = at(parsed.note_starts, i);
        let end_time = at(parsed.note_ends, i);
        let raw_type = or_zero(at(parsed.note_types, i));
        let is_long_note = (jsmath::to_int32(raw_type) & 128) != 0;

        if !key.is_finite() || key < 0.0 || key >= key_count || !start_time.is_finite() {
            continue;
        }
        if key.fract() != 0.0 {
            continue;
        }
        let key = key as usize;

        let start_row = get_or_create(&mut rows, start_time);
        if is_long_note {
            set_note_type(&mut rows[start_row].data, key, nt::HOLDHEAD);
            if end_time.is_finite() && end_time > start_time {
                let end_row = get_or_create(&mut rows, end_time);
                set_note_type(&mut rows[end_row].data, key, nt::HOLDTAIL);
                hold_spans.push((key, start_time, end_time));
            }
        } else {
            set_note_type(&mut rows[start_row].data, key, nt::NORMAL);
        }
    }

    rows.sort_unstable_by(|a, b| a.time.partial_cmp(&b.time).unwrap());

    for &(key, start_time, end_time) in &hold_spans {
        let mut t = rows.partition_point(|r| r.time <= start_time);
        while t < rows.len() && rows[t].time < end_time {
            if rows[t].data[key] == nt::NOTHING {
                rows[t].data[key] = nt::HOLDBODY;
            }
            t += 1;
        }
    }

    rows.retain(|r| !is_row_empty(&r.data));
    rows
}
