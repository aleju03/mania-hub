use crate::x_to_column;
use jsmath::{js_parse_float, js_parse_int, js_sort_by, js_trim, number_to_string, to_int32, JsObject};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ParseStatus {
    Init,
    Ok,
    Fail,
    NotMania,
}

impl ParseStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            ParseStatus::Init => "init",
            ParseStatus::Ok => "OK",
            ParseStatus::Fail => "Fail",
            ParseStatus::NotMania => "NotMania",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct OsuFileParser {
    pub od: f64,
    pub column_count: f64,
    pub columns: Vec<f64>,
    pub note_starts: Vec<f64>,
    pub note_ends: Vec<f64>,
    pub note_types: Vec<f64>,
    pub game_mode: Option<String>,
    pub status: ParseStatus,
    pub ln_ratio: f64,
    pub note_times: JsObject<Vec<f64>>,
    pub meta_data: JsObject<String>,
    pub breaks: Vec<[f64; 2]>,
    pub object_intervals: Vec<[f64; 2]>,
    pub timing_points: Vec<[f64; 2]>,
}

impl Default for OsuFileParser {
    fn default() -> Self {
        OsuFileParser {
            od: -1.0,
            column_count: -1.0,
            columns: Vec::new(),
            note_starts: Vec::new(),
            note_ends: Vec::new(),
            note_types: Vec::new(),
            game_mode: None,
            status: ParseStatus::Init,
            ln_ratio: 0.0,
            note_times: JsObject::new(),
            meta_data: JsObject::new(),
            breaks: Vec::new(),
            object_intervals: Vec::new(),
            timing_points: Vec::new(),
        }
    }
}

#[inline]
fn string_to_int(v: &str) -> f64 {
    js_parse_float(v).trunc()
}

#[inline]
fn split_second<'a>(line: &'a str, sep: char) -> Option<&'a str> {
    line.split(sep).nth(1)
}

pub fn split_lines(text: &str) -> impl Iterator<Item = &str> {
    text.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l))
}

fn bisect_right(arr: &[f64], target: f64) -> usize {
    let mut lo = 0usize;
    let mut hi = arr.len();
    while lo < hi {
        let mid = (lo + hi) >> 1;
        if arr[mid] <= target {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    lo
}

impl OsuFileParser {
    pub fn parse(osu_text: &str) -> OsuFileParser {
        let mut p = OsuFileParser::default();
        p.process(osu_text);
        p
    }

    pub fn process(&mut self, osu_text: &str) {
        let lines: Vec<&str> = split_lines(osu_text).collect();
        let mut in_metadata = false;
        let mut in_events = false;
        let mut in_timing = false;

        let mut i = 0usize;
        while i < lines.len() {
            let line = js_trim(lines[i]);
            i += 1;
            if line.is_empty() {
                continue;
            }
            if line == "[Metadata]" {
                in_metadata = true;
                in_events = false;
                in_timing = false;
                continue;
            }
            if line == "[Events]" {
                in_metadata = false;
                in_events = true;
                in_timing = false;
                continue;
            }
            if line == "[TimingPoints]" {
                in_metadata = false;
                in_events = false;
                in_timing = true;
                continue;
            }
            if line.starts_with('[') && line.ends_with(']') {
                in_metadata = false;
                in_events = false;
                in_timing = false;
            }
            if in_metadata {
                if let Some(idx) = line.find(':') {
                    let key = js_trim(&line[..idx]);
                    let value = js_trim(&line[idx + 1..]);
                    self.meta_data.set(key, value.to_string());
                }
            }
            if in_events {
                self.parse_event_line(line);
            }
            if in_timing {
                self.parse_timing_point_line(line);
            }
            if line.contains("OverallDifficulty:") {
                if let Some(od_part) = split_second(line, ':') {
                    let parsed = js_parse_float(js_trim(od_part));
                    if !parsed.is_nan() {
                        self.od = parsed;
                    }
                }
            }
            if line.contains("CircleSize:") {
                if let Some(cs_part) = split_second(line, ':') {
                    let cs = js_trim(cs_part);
                    self.column_count = if cs == "0" { 10.0 } else { string_to_int(cs) };
                }
            }
            if line.contains("Mode:") {
                if let Some(mode_part) = split_second(line, ':') {
                    let mode = js_trim(mode_part);
                    self.game_mode = Some(mode.to_string());
                    if mode != "3" {
                        self.status = ParseStatus::NotMania;
                    }
                }
            }
            if line == "[HitObjects]" {
                for raw in &lines[i..] {
                    let obj = js_trim(raw);
                    if obj.is_empty() {
                        continue;
                    }
                    self.parse_hit_object(obj);
                }
                break;
            }
        }

        self.ln_ratio = self.get_ln_ratio();
        self.note_times = self.get_note_times();
        self.object_intervals = self.get_object_intervals();

        if self.timing_points.is_empty() {
            self.timing_points = vec![[0.0, 500.0]];
        }
        js_sort_by(&mut self.timing_points, |a, b| a[0] - b[0]);

        if self.status != ParseStatus::Fail && self.status != ParseStatus::NotMania {
            self.status = ParseStatus::Ok;
        }
    }

    fn parse_event_line(&mut self, line: &str) {
        if line.is_empty() || line.starts_with("//") {
            return;
        }
        let params: Vec<&str> = line.split(',').map(js_trim).collect();
        if params.len() < 3 {
            return;
        }
        if params[0] != "2" && params[0] != "Break" {
            return;
        }
        let start = js_parse_int(params[1], 10);
        let end = js_parse_int(params[2], 10);
        if start.is_nan() || end.is_nan() {
            return;
        }
        if end > start {
            self.breaks.push([start, end]);
        }
    }

    fn parse_hit_object(&mut self, line: &str) {
        let params: Vec<&str> = line.split(',').collect();
        if params.len() < 5 {
            return;
        }
        let x = string_to_int(params[0]);
        let mut column = 0.0;
        if self.column_count > 0.0 {
            column = x_to_column(x, self.column_count);
        }
        self.columns.push(column);
        let note_start = js_parse_int(params[2], 10);
        let note_type = js_parse_int(params[3], 10);
        self.note_starts.push(note_start);
        self.note_types.push(note_type);
        let mut note_end = note_start;
        if (to_int32(note_type) & 128) != 0 && params.len() >= 6 {
            let chunk = params[5].split(':').next().unwrap_or("");
            note_end = js_parse_int(chunk, 10);
        }
        self.note_ends.push(note_end);
    }

    fn parse_timing_point_line(&mut self, line: &str) {
        if line.is_empty() || line.starts_with("//") {
            return;
        }
        let parts: Vec<&str> = line.split(',').map(js_trim).collect();
        if parts.len() < 2 {
            return;
        }
        let t = js_parse_float(parts[0]).trunc();
        let beat_length = js_parse_float(parts[1]);
        let uninherited = if parts.len() > 6 && !parts[6].is_empty() { js_parse_int(parts[6], 10) } else { 1.0 };
        if !t.is_nan() && !beat_length.is_nan() && uninherited == 1.0 && beat_length > 0.0 {
            self.timing_points.push([t, beat_length]);
        }
    }

    pub fn get_beat_length_at(&self, time_ms: f64) -> f64 {
        if self.timing_points.is_empty() {
            return 500.0;
        }
        let times: Vec<f64> = self.timing_points.iter().map(|tp| tp[0]).collect();
        let idx = bisect_right(&times, time_ms.trunc()) as isize - 1;
        if idx < 0 {
            return self.timing_points[0][1];
        }
        self.timing_points[idx as usize][1]
    }

    pub fn get_ln_ratio(&self) -> f64 {
        let total = self.note_types.len();
        if total == 0 {
            return 0.0;
        }
        let ln = self.note_types.iter().filter(|&&t| (to_int32(t) & 128) != 0).count();
        ln as f64 / total as f64
    }

    pub fn get_column_count(&self) -> f64 {
        self.column_count
    }

    pub fn get_note_times(&self) -> JsObject<Vec<f64>> {
        let mut nt: JsObject<Vec<f64>> = JsObject::new();
        for i in 0..self.columns.len() {
            let key = number_to_string(self.columns[i]);
            let time = self.note_starts[i];
            match nt.get_mut(&key) {
                Some(v) => v.push(time),
                None => nt.set(key, vec![time]),
            }
        }
        let keys: Vec<String> = nt.keys().iter().map(|k| k.to_string()).collect();
        for k in keys {
            js_sort_by(nt.get_mut(&k).unwrap(), |a, b| a - b);
        }
        nt
    }

    pub fn get_object_intervals(&self) -> Vec<[f64; 2]> {
        if self.note_starts.is_empty() {
            return Vec::new();
        }
        let mut sorted = self.note_starts.clone();
        js_sort_by(&mut sorted, |a, b| a - b);
        let mut intervals: Vec<[f64; 2]> = Vec::with_capacity(sorted.len());
        let mut prev: Option<f64> = None;
        for &s in &sorted {
            let interval = match prev {
                None => 0.0,
                Some(p) => s - p,
            };
            intervals.push([s, interval]);
            prev = Some(s);
        }
        js_sort_by(&mut intervals, |a, b| if b[1] != a[1] { b[1] - a[1] } else { a[0] - b[0] });
        intervals
    }

    pub fn mod_in(&mut self) {
        let mut starts_by_col: JsObject<Vec<f64>> = JsObject::new();
        for i in 0..self.columns.len() {
            let key = number_to_string(self.columns[i]);
            let start = self.note_starts[i];
            match starts_by_col.get_mut(&key) {
                Some(v) => v.push(start),
                None => starts_by_col.set(key, vec![start]),
            }
        }
        let mut new_objects: Vec<[f64; 3]> = Vec::new();
        let keys: Vec<String> = starts_by_col.keys().iter().map(|k| k.to_string()).collect();
        for col_text in keys {
            let col = js_parse_int(&col_text, 10);
            let key = number_to_string(col);
            let mut locations = starts_by_col.get(&key).cloned().unwrap_or_default();
            js_sort_by(&mut locations, |a, b| a - b);
            if let Some(slot) = starts_by_col.get_mut(&key) {
                *slot = locations.clone();
            }
            let n = locations.len();
            for i in 0..n.saturating_sub(1) {
                let start_time = locations[i];
                let next_time = locations[i + 1];
                let mut duration = next_time - start_time;
                let beat_length = self.get_beat_length_at(next_time);
                duration = jsmath::max(duration / 2.0, duration - beat_length / 4.0);
                let end_time = start_time + duration;
                new_objects.push([jsmath::round(start_time), col, jsmath::round(end_time)]);
            }
        }
        js_sort_by(&mut new_objects, |a, b| if a[0] != b[0] { a[0] - b[0] } else { a[1] - b[1] });
        self.columns = new_objects.iter().map(|o| o[1]).collect();
        self.note_starts = new_objects.iter().map(|o| o[0]).collect();
        self.note_types = vec![128.0; new_objects.len()];
        self.note_ends = new_objects.iter().map(|o| o[2]).collect();
        self.breaks = Vec::new();
        self.ln_ratio = self.get_ln_ratio();
        self.note_times = self.get_note_times();
        self.object_intervals = self.get_object_intervals();
    }

    pub fn mod_ho(&mut self) {
        for i in 0..self.note_types.len() {
            if (to_int32(self.note_types[i]) & 128) != 0 {
                self.note_types[i] = 1.0;
                self.note_ends[i] = 0.0;
            }
        }
        self.ln_ratio = self.get_ln_ratio();
        self.note_times = self.get_note_times();
        self.object_intervals = self.get_object_intervals();
    }
}
