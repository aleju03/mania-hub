use std::collections::HashMap;

use dan_core::ManiaNote;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LnChartObject {
    pub id: usize,
    pub lane: i32,
    pub start_ms: f64,
    pub end_ms: f64,
    pub is_hold: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct LnEventRow4K {
    pub time_ms: f64,
    pub tap_mask: i32,
    pub hold_head_mask: i32,
    pub hold_tail_mask: i32,
    pub tap_ids: Vec<usize>,
    pub head_ids: Vec<usize>,
    pub tail_ids: Vec<usize>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LnDiagnosticCode {
    InvalidTime,
    InvalidLane,
    InvalidHoldLength,
    DuplicateObject,
    SameLaneOverlap,
    TapInsideHold,
}

impl LnDiagnosticCode {
    pub fn as_str(self) -> &'static str {
        match self {
            LnDiagnosticCode::InvalidTime => "invalid_time",
            LnDiagnosticCode::InvalidLane => "invalid_lane",
            LnDiagnosticCode::InvalidHoldLength => "invalid_hold_length",
            LnDiagnosticCode::DuplicateObject => "duplicate_object",
            LnDiagnosticCode::SameLaneOverlap => "same_lane_overlap",
            LnDiagnosticCode::TapInsideHold => "tap_inside_hold",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct LnTimelineDiagnostic {
    pub code: LnDiagnosticCode,
    pub object_ids: Vec<usize>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct LnTimeline4K {
    pub valid: bool,
    pub playback_rate: f64,
    pub objects: Vec<LnChartObject>,
    pub rows: Vec<LnEventRow4K>,
    pub diagnostics: Vec<LnTimelineDiagnostic>,
}

#[inline]
fn js_or(d: f64) -> Option<f64> {
    if d != 0.0 && !d.is_nan() {
        Some(d)
    } else {
        None
    }
}

pub fn build_ln_timeline_4k(notes: &[ManiaNote], rate: f64) -> LnTimeline4K {
    assert!(rate.is_finite() && rate > 0.0, "LN playback rate must be positive and finite");
    let mut diagnostics: Vec<LnTimelineDiagnostic> = Vec::new();
    let mut finite: Vec<(ManiaNote, usize)> = Vec::new();
    for (id, note) in notes.iter().enumerate() {
        let code = if note.column < 0 || note.column > 3 {
            Some(LnDiagnosticCode::InvalidLane)
        } else if !note.time.is_finite() || (note.is_hold && !note.end_time.is_finite()) {
            Some(LnDiagnosticCode::InvalidTime)
        } else if note.is_hold && note.end_time <= note.time {
            Some(LnDiagnosticCode::InvalidHoldLength)
        } else {
            None
        };
        match code {
            Some(code) => diagnostics.push(LnTimelineDiagnostic { code, object_ids: vec![id] }),
            None => finite.push((*note, id)),
        }
    }
    jsmath::js_sort_by(&mut finite, |(a, _), (b, _)| {
        js_or(a.time - b.time)
            .or_else(|| js_or((a.column - b.column) as f64))
            .unwrap_or(a.end_time - b.end_time)
    });

    let origin_ms = finite.first().map_or(0.0, |(n, _)| n.time);
    let mut objects: Vec<LnChartObject> = Vec::new();
    let mut same_start: [Option<(f64, Vec<LnChartObject>)>; 4] = [None, None, None, None];
    let mut last_hold: [Option<LnChartObject>; 4] = [None, None, None, None];
    for &(note, id) in &finite {
        let lane = note.column as usize;
        let start_ms = (note.time - origin_ms) / rate;
        let object = if note.is_hold {
            LnChartObject { id, lane: note.column, start_ms, end_ms: (note.end_time - origin_ms) / rate, is_hold: true }
        } else {
            LnChartObject { id, lane: note.column, start_ms, end_ms: start_ms, is_hold: false }
        };
        if same_start[lane].as_ref().map_or(true, |(s, _)| *s != start_ms) {
            same_start[lane] = Some((start_ms, Vec::new()));
        }
        let group = &mut same_start[lane].as_mut().unwrap().1;
        let duplicate = group
            .iter()
            .find(|other| other.is_hold == object.is_hold && (!other.is_hold || other.end_ms == object.end_ms))
            .copied();
        if let Some(duplicate) = duplicate {
            diagnostics.push(LnTimelineDiagnostic { code: LnDiagnosticCode::DuplicateObject, object_ids: vec![duplicate.id, id] });
            continue;
        }
        group.push(object);
        let occupied = last_hold[lane];
        let code = if group.len() > 1 {
            Some(LnDiagnosticCode::SameLaneOverlap)
        } else if occupied.map_or(false, |o| o.end_ms > start_ms) {
            Some(if object.is_hold { LnDiagnosticCode::SameLaneOverlap } else { LnDiagnosticCode::TapInsideHold })
        } else {
            None
        };
        if let Some(code) = code {
            let first = if group.len() > 1 { group[0].id } else { occupied.unwrap().id };
            diagnostics.push(LnTimelineDiagnostic { code, object_ids: vec![first, id] });
            continue;
        }
        if object.is_hold {
            last_hold[lane] = Some(object);
        }
        objects.push(object);
    }

    let mut rows: Vec<LnEventRow4K> = Vec::new();
    let mut row_at: HashMap<u64, usize> = HashMap::new();
    let mut at = |time_ms: f64, rows: &mut Vec<LnEventRow4K>| -> usize {
        let key = if time_ms == 0.0 { 0 } else { time_ms.to_bits() };
        *row_at.entry(key).or_insert_with(|| {
            rows.push(LnEventRow4K {
                time_ms,
                tap_mask: 0,
                hold_head_mask: 0,
                hold_tail_mask: 0,
                tap_ids: Vec::new(),
                head_ids: Vec::new(),
                tail_ids: Vec::new(),
            });
            rows.len() - 1
        })
    };
    for object in &objects {
        let r = at(object.start_ms, &mut rows);
        let bit = 1i32 << object.lane;
        if !object.is_hold {
            rows[r].tap_mask |= bit;
            rows[r].tap_ids.push(object.id);
            continue;
        }
        rows[r].hold_head_mask |= bit;
        rows[r].head_ids.push(object.id);
        let t = at(object.end_ms, &mut rows);
        rows[t].hold_tail_mask |= bit;
        rows[t].tail_ids.push(object.id);
    }
    let mut order: Vec<usize> = (0..rows.len()).collect();
    jsmath::js_sort_by(&mut order, |&a, &b| rows[a].time_ms - rows[b].time_ms);
    let mut slots: Vec<Option<LnEventRow4K>> = rows.into_iter().map(Some).collect();
    let rows: Vec<LnEventRow4K> = order.iter().map(|&i| slots[i].take().unwrap()).collect();
    LnTimeline4K { valid: diagnostics.is_empty(), playback_rate: rate, objects, rows, diagnostics }
}
