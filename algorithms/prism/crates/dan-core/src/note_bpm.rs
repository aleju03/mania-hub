use crate::js::{cmp_num, parse_float, parse_int10, sort_nums, trim, NumMap};

const FOLD_TRIGGER_BPM: f64 = 300.0;
const FOLD_MANDATORY_BPM: f64 = 500.0;
const FOLD_MAX_CANDIDATES: f64 = 16.0;
const FOLD_MAX_RAW_BPM: f64 = 60000.0;
const FOLD_TARGET_MAX_BPM: f64 = 350.0;
const FOLD_MIN_BPM: f64 = 100.0;
const COARSE_GAP_BEATS: f64 = 0.45;
const BINARY_ROW_GAPS: [f64; 12] =
    [1.0 / 16.0, 1.0 / 8.0, 3.0 / 16.0, 1.0 / 4.0, 3.0 / 8.0, 1.0 / 2.0, 3.0 / 4.0, 1.0, 1.5, 2.0, 3.0, 4.0];
const TRIPLET_ROW_GAPS: [f64; 4] = [1.0 / 12.0, 1.0 / 6.0, 1.0 / 3.0, 2.0 / 3.0];
const MAX_EVIDENCE_GAP_BEATS: f64 = 4.0;
const MIN_FOLD_EVIDENCE_GAPS: usize = 8;
const SNAP_TOLERANCE: f64 = 0.03;
const SNAP_TOLERANCE_MIN_MS: f64 = 1.0;
const TRIPLET_SNAP_WEIGHT: f64 = 0.5;
const FOLD_DEEPER_MARGIN: f64 = 0.1;
const MIN_BPM: f64 = 10.0;
const MAX_BPM: f64 = 1200.0;

pub fn compute_note_bpm(osu_text: &str) -> Option<f64> {
    let mut timing_points: Vec<(f64, f64)> = Vec::new();
    let mut note_times: Vec<f64> = Vec::new();
    let mut section = "";
    for raw_line in osu_text.split('\n') {
        let line = trim(raw_line);
        if line.is_empty() || line.starts_with("//") {
            continue;
        }
        if line.starts_with('[') && line.ends_with(']') {
            section = if line.len() >= 2 { &line[1..line.len() - 1] } else { "" };
            continue;
        }
        if section == "TimingPoints" && line.contains(',') {
            let parts: Vec<&str> = line.split(',').collect();
            if parts.len() >= 2 {
                let time = parse_float(parts[0]);
                let beat_length = parse_float(parts[1]);
                let uninherited = parts.len() < 7 || trim(parts[6]) != "0";
                if time.is_finite() && beat_length > 0.0 && uninherited {
                    timing_points.push((time, beat_length));
                }
            }
        }
        if section == "HitObjects" && line.contains(',') {
            let parts: Vec<&str> = line.split(',').collect();
            if parts.len() >= 5 {
                let time = parse_int10(parts[2]);
                if time.is_finite() {
                    note_times.push(time);
                }
            }
        }
    }
    if timing_points.is_empty() || note_times.is_empty() {
        return None;
    }
    timing_points.sort_by(|a, b| cmp_num(a.0, b.0));
    sort_nums(&mut note_times);

    let mut section_index_per_note: Vec<usize> = Vec::with_capacity(note_times.len());
    let mut point_index = 0usize;
    for &time in &note_times {
        while point_index + 1 < timing_points.len() && timing_points[point_index + 1].0 <= time {
            point_index += 1;
        }
        section_index_per_note.push(point_index);
    }
    let section_bpms: Vec<f64> = (0..timing_points.len())
        .map(|index| {
            resolve_section_bpm(timing_points[index].1, &collect_section_row_gaps(&note_times, &section_index_per_note, index))
        })
        .collect();
    let mut bpms: Vec<f64> = section_index_per_note.iter().map(|&i| section_bpms[i]).collect();
    sort_nums(&mut bpms);
    let mid = bpms.len() / 2;
    let median = if bpms.len() % 2 == 1 { bpms[mid] } else { (bpms[mid - 1] + bpms[mid]) / 2.0 };
    Some(jsmath::round(median * 100.0) / 100.0)
}

fn collect_section_row_gaps(note_times: &[f64], section_index_per_note: &[usize], section_index: usize) -> Vec<f64> {
    let mut gaps = Vec::new();
    let mut previous: Option<f64> = None;
    for i in 0..note_times.len() {
        if section_index_per_note[i] != section_index {
            previous = None;
            continue;
        }
        if let Some(p) = previous {
            if note_times[i] > p {
                gaps.push(note_times[i] - p);
            }
        }
        previous = Some(note_times[i]);
    }
    gaps
}

fn resolve_section_bpm(beat_length: f64, row_gaps: &[f64]) -> f64 {
    let raw_bpm = 60000.0 / beat_length;
    let mut bpm = raw_bpm;
    if raw_bpm > FOLD_TRIGGER_BPM && raw_bpm <= FOLD_MAX_RAW_BPM && row_gaps.len() >= MIN_FOLD_EVIDENCE_GAPS {
        if raw_bpm > FOLD_MANDATORY_BPM || dominant_gap_is_coarse(beat_length, row_gaps) {
            bpm = fold_inflated_tempo(raw_bpm, beat_length, row_gaps);
        }
    }
    jsmath::min(MAX_BPM, jsmath::max(MIN_BPM, bpm))
}

fn dominant_gap_is_coarse(beat_length: f64, row_gaps: &[f64]) -> bool {
    let mut gap_counts: NumMap<f64> = NumMap::new();
    for &gap in row_gaps {
        let beats = jsmath::round((gap / beat_length) * 12.0) / 12.0;
        if beats <= 0.0 || beats > MAX_EVIDENCE_GAP_BEATS {
            continue;
        }
        *gap_counts.entry_or_insert_with(beats, || 0.0) += 1.0;
    }
    let mut entries = gap_counts.entries;
    entries.sort_by(|a, b| {
        let d = b.1 - a.1;
        if d != 0.0 && !d.is_nan() {
            return cmp_num(b.1, a.1);
        }
        cmp_num(a.0, b.0)
    });
    match entries.first() {
        Some(d) => d.0 >= COARSE_GAP_BEATS,
        None => false,
    }
}

fn fold_inflated_tempo(raw_bpm: f64, beat_length: f64, row_gaps: &[f64]) -> f64 {
    let first_divisor = jsmath::max(2.0, (raw_bpm / FOLD_TARGET_MAX_BPM).ceil());
    let mut best_divisor = first_divisor;
    let mut best_score = snap_grid_score(beat_length * first_divisor, row_gaps);
    let last_divisor = first_divisor + FOLD_MAX_CANDIDATES;
    let mut divisor = first_divisor + 1.0;
    while divisor <= last_divisor && raw_bpm / divisor >= FOLD_MIN_BPM {
        let score = snap_grid_score(beat_length * divisor, row_gaps);
        if score >= best_score + FOLD_DEEPER_MARGIN {
            best_divisor = divisor;
            best_score = score;
        }
        divisor += 1.0;
    }
    raw_bpm / best_divisor
}

fn snap_grid_score(beat_length: f64, row_gaps: &[f64]) -> f64 {
    let mut weight = 0f64;
    let mut evidence = 0f64;
    for &gap in row_gaps {
        if gap > beat_length * MAX_EVIDENCE_GAP_BEATS {
            continue;
        }
        evidence += 1.0;
        if sits_on_snap(gap, beat_length, &BINARY_ROW_GAPS) {
            weight += 1.0;
        } else if sits_on_snap(gap, beat_length, &TRIPLET_ROW_GAPS) {
            weight += TRIPLET_SNAP_WEIGHT;
        }
    }
    if evidence == 0.0 {
        0.0
    } else {
        weight / evidence
    }
}

fn sits_on_snap(gap: f64, beat_length: f64, snaps: &[f64]) -> bool {
    for &snap in snaps {
        let snap_ms = snap * beat_length;
        if (gap - snap_ms).abs() <= jsmath::max(SNAP_TOLERANCE_MIN_MS, snap_ms * SNAP_TOLERANCE) {
            return true;
        }
    }
    false
}
