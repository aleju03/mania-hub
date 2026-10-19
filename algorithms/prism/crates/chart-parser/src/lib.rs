use jsmath::{js_number_from_str, js_parse_float, js_parse_int, js_sort_by, js_trim, to_int32};

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ManiaNote {
    pub column: i32,
    pub time: f64,
    pub end_time: f64,
    pub is_hold: bool,
}

pub const NAN_COLUMN: i32 = i32::MIN;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ManiaScrollVelocity {
    pub time: f64,
    pub multiplier: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ManiaBreakPeriod {
    pub start_time: f64,
    pub end_time: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ManiaTimingPoint {
    pub time: f64,
    pub beat_length: f64,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ManiaBeatmap {
    pub title: String,
    pub artist: String,
    pub version: String,
    pub creator: String,
    pub key_count: i32,
    pub od: f64,
    pub bpm: f64,
    pub notes: Vec<ManiaNote>,
    pub total_length: f64,
    pub beatmapset_id: Option<f64>,
    pub audio_filename: String,
    pub preview_time: f64,
    pub background_filename: String,
    pub break_periods: Vec<ManiaBreakPeriod>,
    pub scroll_velocities: Vec<ManiaScrollVelocity>,
    pub timing_points: Option<Vec<ManiaTimingPoint>>,
}

#[derive(Clone, Copy, Debug)]
enum ControlPoint {
    Timing { order: f64, time: f64, beat_length: f64 },
    Effect { order: f64, time: f64, scroll_speed: f64 },
}
impl ControlPoint {
    fn time(&self) -> f64 {
        match *self {
            ControlPoint::Timing { time, .. } | ControlPoint::Effect { time, .. } => time,
        }
    }
    fn order(&self) -> f64 {
        match *self {
            ControlPoint::Timing { order, .. } | ControlPoint::Effect { order, .. } => order,
        }
    }
}

const DEFAULT_BEAT_LENGTH: f64 = 1000.0;
const SCROLL_MULTIPLIER_EPSILON: f64 = 1e-4;

pub fn normalize_key_count(value: f64) -> i32 {
    if !value.is_finite() || value <= 0.0 {
        return 4;
    }
    jsmath::max(1.0, jsmath::min(18.0, round_half_even(value))) as i32
}

fn round_half_even(value: f64) -> f64 {
    let floor = value.floor();
    let diff = value - floor;
    if diff > 0.5 { return floor + 1.0; }
    if diff < 0.5 { return floor; }
    if floor % 2.0 == 0.0 { floor } else { floor + 1.0 }
}

#[derive(Default)]
struct NumMap(Vec<(f64, f64)>);
impl NumMap {
    fn find(&mut self, k: f64) -> Option<&mut (f64, f64)> {
        self.0.iter_mut().find(|(x, _)| *x == k || (x.is_nan() && k.is_nan()))
    }
    fn get(&mut self, k: f64) -> Option<f64> {
        self.find(k).map(|e| e.1)
    }
    fn set(&mut self, k: f64, v: f64) {
        match self.find(k) {
            Some(e) => e.1 = v,
            None => self.0.push((if k == 0.0 { 0.0 } else { k }, v)),
        }
    }
}

pub fn get_most_common_beat_length(timing_points: &[ManiaTimingPoint], last_object_time: f64) -> f64 {
    if timing_points.is_empty() {
        return DEFAULT_BEAT_LENGTH;
    }
    let last_time = if last_object_time > 0.0 { last_object_time } else { timing_points[timing_points.len() - 1].time };
    let mut durations = NumMap::default();
    for (i, point) in timing_points.iter().enumerate() {
        if point.time > last_time {
            let v = durations.get(point.beat_length).unwrap_or(0.0);
            durations.set(point.beat_length, v);
            continue;
        }
        let current_time = if i == 0 { 0.0 } else { point.time };
        let next_time = if i == timing_points.len() - 1 { last_time } else { timing_points[i + 1].time };
        let duration = jsmath::max(0.0, next_time - current_time);
        let rounded = jsmath::round(point.beat_length * 1000.0) / 1000.0;
        let v = durations.get(rounded).unwrap_or(0.0) + duration;
        durations.set(rounded, v);
    }
    let mut most_common = 0.0;
    let mut longest = -1.0;
    for &(bl, d) in &durations.0 {
        if d > longest {
            most_common = bl;
            longest = d;
        }
    }
    if most_common <= 0.0 {
        return DEFAULT_BEAT_LENGTH;
    }
    let mut min_bl = f64::INFINITY;
    let mut max_bl = f64::NEG_INFINITY;
    for p in timing_points {
        if p.beat_length < min_bl {
            min_bl = p.beat_length;
        }
        if p.beat_length > max_bl {
            max_bl = p.beat_length;
        }
    }
    jsmath::max(min_bl, jsmath::min(max_bl, most_common))
}

fn build_mania_scroll_velocities(
    timing_points: &[ManiaTimingPoint],
    control_points: &[ControlPoint],
    last_object_time: f64,
) -> Vec<ManiaScrollVelocity> {
    if control_points.is_empty() || timing_points.is_empty() {
        return Vec::new();
    }
    let base = get_most_common_beat_length(timing_points, last_object_time);
    let mut collapsed: Vec<ManiaScrollVelocity> = Vec::new();
    let mut current_beat_length = DEFAULT_BEAT_LENGTH;
    let mut current_scroll_speed = 1.0;

    let mut sorted = control_points.to_vec();
    js_sort_by(&mut sorted, |a, b| {
        let d = a.time() - b.time();
        if d != 0.0 && !d.is_nan() {
            d
        } else {
            a.order() - b.order()
        }
    });
    for point in &sorted {
        if point.time() > last_object_time {
            break;
        }
        match *point {
            ControlPoint::Timing { beat_length, .. } => current_beat_length = beat_length,
            ControlPoint::Effect { scroll_speed, .. } => current_scroll_speed = scroll_speed,
        }
        let raw = jsmath::max(0.01, jsmath::min(20.0, current_scroll_speed * base / current_beat_length));
        let multiplier = if (raw - 1.0).abs() <= SCROLL_MULTIPLIER_EPSILON { 1.0 } else { raw };
        match collapsed.last_mut() {
            Some(prev) if prev.time == point.time() => prev.multiplier = multiplier,
            _ => collapsed.push(ManiaScrollVelocity { time: point.time(), multiplier }),
        }
    }
    let mut output = Vec::new();
    let mut previous = 1.0;
    for p in collapsed {
        if (p.multiplier - previous).abs() <= SCROLL_MULTIPLIER_EPSILON {
            continue;
        }
        previous = p.multiplier;
        output.push(p);
    }
    output
}

fn colon_field(line: &str) -> &str {
    line.split(':').nth(1).unwrap_or("")
}

fn match_background(line: &str) -> Option<&str> {
    let rest = line.strip_prefix("0,0,\"")?;
    let end = rest.find('"')?;
    if end == 0 {
        return None;
    }
    Some(&rest[..end])
}

fn match_break(line: &str) -> Option<(&str, &str)> {
    let rest = line.strip_prefix("2,")?;
    let a = rest.bytes().take_while(|b| b.is_ascii_digit()).count();
    if a == 0 || rest.as_bytes().get(a) != Some(&b',') {
        return None;
    }
    let rest2 = &rest[a + 1..];
    let b = rest2.bytes().take_while(|b| b.is_ascii_digit()).count();
    if b == 0 {
        return None;
    }
    Some((&rest[..a], &rest2[..b]))
}

fn column_i32(v: f64) -> i32 {
    if v.is_nan() {
        NAN_COLUMN
    } else {
        v as i32
    }
}

pub fn parse_mania_beatmap(content: &str) -> ManiaBeatmap {
    let mut title = "";
    let mut artist = "";
    let mut version = "";
    let mut creator = "";
    let mut circle_size = 4.0;
    let mut overall_difficulty = 8.0;
    let mut beatmapset_id: Option<f64> = None;
    let mut audio_filename = "";
    let mut preview_time = 0.0;
    let mut background_filename = "";
    let mut section = "";
    let mut notes: Vec<ManiaNote> = Vec::new();
    let mut break_periods = Vec::new();
    let mut timing_points: Vec<ManiaTimingPoint> = Vec::new();
    let mut control_points: Vec<ControlPoint> = Vec::new();
    let mut order = 0.0;

    for raw in content.split('\n') {
        let line = js_trim(raw);
        if line.starts_with('[') && line.ends_with(']') {
            section = &line[1..line.len() - 1];
            continue;
        }
        match section {
            "General" => {
                if let Some(v) = line.strip_prefix("AudioFilename:") {
                    audio_filename = js_trim(v);
                }
                if line.starts_with("PreviewTime:") {
                    let v = js_parse_int(js_trim(colon_field(line)), 10);
                    preview_time = if v.is_nan() || v == 0.0 { 0.0 } else { v };
                }
            }
            "Metadata" => {
                if let Some(v) = line.strip_prefix("Title:") {
                    title = js_trim(v);
                }
                if let Some(v) = line.strip_prefix("Artist:") {
                    artist = js_trim(v);
                }
                if let Some(v) = line.strip_prefix("Version:") {
                    version = js_trim(v);
                }
                if let Some(v) = line.strip_prefix("Creator:") {
                    creator = js_trim(v);
                }
                if let Some(v) = line.strip_prefix("BeatmapSetID:") {
                    let parsed = js_number_from_str(js_trim(v));
                    let safe = parsed.is_finite() && parsed.fract() == 0.0 && parsed.abs() <= 9007199254740991.0;
                    beatmapset_id = if safe && parsed > 0.0 { Some(parsed) } else { None };
                }
            }
            "Events" => {
                if background_filename.is_empty() {
                    if let Some(bg) = match_background(line) {
                        background_filename = bg;
                    }
                }
                if let Some((a, b)) = match_break(line) {
                    let start_time = js_number_from_str(a);
                    let end_time = js_number_from_str(b);
                    if end_time > start_time {
                        break_periods.push(ManiaBreakPeriod { start_time, end_time });
                    }
                }
            }
            "Difficulty" => {
                if line.starts_with("CircleSize:") {
                    circle_size = js_parse_float(js_trim(colon_field(line)));
                }
                if line.starts_with("OverallDifficulty:") {
                    overall_difficulty = js_parse_float(js_trim(colon_field(line)));
                }
            }
            "TimingPoints" if line.contains(',') => {
                let parts: Vec<&str> = line.split(',').collect();
                let time = js_parse_float(parts[0]);
                let beat_length = js_parse_float(parts[1]);
                let uninherited = parts.len() < 7 || js_trim(parts[6]) != "0";
                if beat_length > 0.0 && uninherited {
                    timing_points.push(ManiaTimingPoint { time, beat_length });
                    control_points.push(ControlPoint::Timing { order, time, beat_length });
                    order += 1.0;
                    control_points.push(ControlPoint::Effect { order, time, scroll_speed: 1.0 });
                    order += 1.0;
                } else if beat_length < 0.0 && !uninherited {
                    control_points.push(ControlPoint::Effect {
                        order,
                        time,
                        scroll_speed: jsmath::max(0.01, jsmath::min(20.0, -100.0 / beat_length)),
                    });
                    order += 1.0;
                }
            }
            "HitObjects" if line.contains(',') => {
                let parts: Vec<&str> = line.split(',').collect();
                if parts.len() >= 5 {
                    let x = js_parse_int(parts[0], 10);
                    let time = js_parse_int(parts[2], 10);
                    if !time.is_finite() {
                        continue;
                    }
                    let typ = js_parse_int(parts[3], 10);
                    let key_count = normalize_key_count(circle_size) as f64;
                    let column = ((x * key_count) / 512.0).floor();
                    let is_hold = (to_int32(typ) & 128) != 0;
                    let mut end_time = time;
                    if is_hold && parts.len() >= 6 {
                        let extras = parts[5].split(':').next().unwrap_or("");
                        let v = js_parse_int(extras, 10);
                        end_time = if v.is_nan() || v == 0.0 { time } else { v };
                    }
                    notes.push(ManiaNote {
                        column: column_i32(jsmath::min(column, key_count - 1.0)),
                        time,
                        end_time,
                        is_hold,
                    });
                }
            }
            _ => {}
        }
    }

    let bpm = if !timing_points.is_empty() { jsmath::round(60000.0 / timing_points[0].beat_length) } else { 0.0 };
    let mut total_length = 0.0;
    for n in &notes {
        if n.end_time > total_length {
            total_length = n.end_time;
        }
    }
    js_sort_by(&mut notes, |a, b| a.time - b.time);
    let scroll_velocities = build_mania_scroll_velocities(&timing_points, &control_points, total_length);

    ManiaBeatmap {
        title: title.to_string(),
        artist: artist.to_string(),
        version: version.to_string(),
        creator: creator.to_string(),
        key_count: normalize_key_count(circle_size),
        od: overall_difficulty,
        bpm,
        notes,
        total_length,
        beatmapset_id,
        audio_filename: audio_filename.to_string(),
        preview_time,
        background_filename: background_filename.to_string(),
        break_periods,
        scroll_velocities,
        timing_points: Some(timing_points),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skips_notes_without_a_real_time() {
        let map = parse_mania_beatmap(
            "osu file format v14\n\n[Difficulty]\nCircleSize:4\n\n[HitObjects]\n64,192,1000,1,0,0:0:0:0:\n64,192,NaN,128,0,95623:0:0:0:0:\n192,192,1500,128,0,2000:0:0:0:0:\n",
        );
        let times: Vec<(f64, f64)> = map.notes.iter().map(|n| (n.time, n.end_time)).collect();
        assert_eq!(times, vec![(1000.0, 1000.0), (1500.0, 2000.0)]);
        assert_eq!(map.total_length, 2000.0);
    }
}
