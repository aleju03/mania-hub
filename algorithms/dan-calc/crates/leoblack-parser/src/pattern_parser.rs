use crate::osu_file_parser::split_lines;
use crate::x_to_column;
use jsmath::{js_parse_float, js_parse_int, js_sort_by, js_trim, number_to_string, to_int32};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum NoteType {
    Nothing = 0,
    Normal = 1,
    HoldHead = 2,
    HoldBody = 3,
    HoldTail = 4,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TimeItem<T> {
    pub time: f64,
    pub data: T,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Bpm {
    pub meter: f64,
    pub ms_per_beat: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PatternChart {
    pub keys: f64,
    pub notes: Vec<TimeItem<Vec<NoteType>>>,
    pub bpm: Vec<TimeItem<Bpm>>,
    pub sv: Vec<TimeItem<f64>>,
}

impl PatternChart {
    pub fn first_note(&self) -> f64 {
        self.notes[0].time
    }
    pub fn last_note(&self) -> f64 {
        self.notes[self.notes.len() - 1].time
    }
}

#[derive(Clone, Copy, Debug)]
enum TimingPoint {
    Uninherited { time: f64, ms_per_beat: f64, meter: f64 },
    Inherited { time: f64, multiplier: f64 },
}

#[derive(Clone, Copy, Debug)]
enum HitObject {
    Circle { x: f64, time: f64 },
    Hold { x: f64, time: f64, end_time: f64 },
}

fn parse_sections(text: &str) -> Vec<(String, Vec<&str>)> {
    let mut out: Vec<(String, Vec<&str>)> = Vec::new();
    let mut sec: Option<usize> = None;
    for raw in split_lines(text) {
        let line = js_trim(raw);
        if line.is_empty() || line.starts_with("//") {
            continue;
        }
        if line.starts_with('[') && line.ends_with(']') {
            let name = if line.len() >= 2 { &line[1..line.len() - 1] } else { "" };
            sec = Some(match out.iter().position(|(n, _)| n == name) {
                Some(p) => p,
                None => {
                    out.push((name.to_string(), Vec::new()));
                    out.len() - 1
                }
            });
        } else if let Some(s) = sec {
            out[s].1.push(line);
        }
    }
    out
}

fn section<'a, 'b>(secs: &'b [(String, Vec<&'a str>)], name: &str) -> &'b [&'a str] {
    secs.iter().find(|(n, _)| n == name).map(|(_, v)| v.as_slice()).unwrap_or(&[])
}

fn parse_timing_points(lines: &[&str]) -> Vec<TimingPoint> {
    let mut out = Vec::new();
    for line in lines {
        let parts: Vec<&str> = line.split(',').map(js_trim).collect();
        if parts.len() < 2 {
            continue;
        }
        let t = js_parse_float(parts[0]);
        let beat_len = js_parse_float(parts[1]);
        let meter = if parts.len() > 2 && !parts[2].is_empty() { js_parse_int(parts[2], 10) } else { 4.0 };
        let uninherited = if parts.len() > 6 && !parts[6].is_empty() { js_parse_int(parts[6], 10) } else { 1.0 };
        if uninherited == 1.0 {
            out.push(TimingPoint::Uninherited { time: t, ms_per_beat: jsmath::max(0.0, beat_len), meter });
        } else if beat_len != 0.0 {
            out.push(TimingPoint::Inherited { time: t, multiplier: -100.0 / beat_len });
        }
    }
    out
}

fn parse_hit_objects(lines: &[&str]) -> Vec<HitObject> {
    let mut out = Vec::new();
    for line in lines {
        let parts: Vec<&str> = line.split(',').map(js_trim).collect();
        if parts.len() < 5 {
            continue;
        }
        let x = js_parse_float(parts[0]);
        let time = js_parse_float(parts[2]).trunc();
        let typ = js_parse_int(parts[3], 10);
        if (to_int32(typ) & 128) != 0 {
            let mut end_time = time;
            if parts.len() >= 6 && !parts[5].is_empty() {
                let end_part = parts[5].split(':').next().unwrap_or("");
                let parsed = js_parse_float(end_part);
                if !parsed.is_nan() {
                    end_time = parsed.trunc();
                }
            }
            out.push(HitObject::Hold { x, time, end_time });
        } else {
            out.push(HitObject::Circle { x, time });
        }
    }
    out
}

#[inline]
fn slot(len: usize, idx: f64) -> Option<usize> {
    if idx >= 0.0 && idx.fract() == 0.0 && idx < len as f64 {
        Some(idx as usize)
    } else {
        None
    }
}

fn note_type_str(t: Option<NoteType>) -> String {
    match t {
        Some(t) => (t as u8).to_string(),
        None => "undefined".into(),
    }
}

struct Converter {
    keys: usize,
    output: Vec<TimeItem<Vec<NoteType>>>,
    holding_until: Vec<Option<f64>>,
    last_row: Option<usize>,
    initial_row: TimeItem<Vec<NoteType>>,
}

impl Converter {
    fn last_time(&self) -> f64 {
        match self.last_row {
            Some(i) => self.output[i].time,
            None => self.initial_row.time,
        }
    }
    fn last_data(&mut self) -> &mut Vec<NoteType> {
        match self.last_row {
            Some(i) => &mut self.output[i].data,
            None => &mut self.initial_row.data,
        }
    }
    fn earliest(&self) -> f64 {
        let mut e = f64::INFINITY;
        for &h in &self.holding_until {
            if let Some(h) = h {
                if h < e {
                    e = h;
                }
            }
        }
        e
    }
    fn new_row(&mut self, time: f64) {
        let mut data = vec![NoteType::Nothing; self.keys];
        for k in 0..self.keys {
            if self.holding_until[k].is_some() {
                data[k] = NoteType::HoldBody;
            }
        }
        self.output.push(TimeItem { time, data });
        self.last_row = Some(self.output.len() - 1);
    }
    fn finish_holds(&mut self, time: f64) -> Result<(), String> {
        let mut earliest = self.earliest();
        while earliest < time {
            for k in 0..self.keys {
                if self.holding_until[k] == Some(earliest) {
                    if earliest > self.last_time() {
                        self.new_row(earliest);
                    }
                    let data = self.last_data();
                    let cur = data.get(k).copied();
                    if cur == Some(NoteType::Nothing) || cur == Some(NoteType::HoldBody) {
                        data[k] = NoteType::HoldTail;
                        self.holding_until[k] = None;
                    } else {
                        return Err("impossible (HOLDTAIL overwrite conflict)".into());
                    }
                }
            }
            earliest = self.earliest();
        }
        Ok(())
    }
    fn add_note(&mut self, column: f64, time: f64) -> Result<(), String> {
        self.finish_holds(time)?;
        if time > self.last_time() {
            self.new_row(time);
        }
        let data = self.last_data();
        let s = slot(data.len(), column);
        let cur = s.map(|i| data[i]);
        if cur == Some(NoteType::Nothing) {
            data[s.unwrap()] = NoteType::Normal;
        } else if cur == Some(NoteType::Normal) || cur == Some(NoteType::HoldHead) {
        } else {
            return Err(format!(
                "Stacked note at {}, column {}, coincides with {}",
                number_to_string(time),
                number_to_string(column + 1.0),
                note_type_str(cur)
            ));
        }
        Ok(())
    }
    fn start_hold(&mut self, column: f64, time: f64, end_time: f64) -> Result<(), String> {
        self.finish_holds(time)?;
        if time > self.last_time() {
            self.new_row(time);
        }
        let data = self.last_data();
        let s = slot(data.len(), column);
        let cur = s.map(|i| data[i]);
        if cur == Some(NoteType::Nothing) || cur == Some(NoteType::Normal) {
            data[s.unwrap()] = NoteType::HoldHead;
            if let Some(i) = slot(self.holding_until.len(), column) {
                self.holding_until[i] = Some(end_time);
            }
        } else {
            return Err(format!(
                "Stacked LN at {}, column {}, head coincides with {}",
                number_to_string(time),
                number_to_string(column + 1.0),
                note_type_str(cur)
            ));
        }
        Ok(())
    }
}

fn convert_hit_objects(objects: &[HitObject], keys: f64) -> Result<Vec<TimeItem<Vec<NoteType>>>, String> {
    let len = if keys.is_nan() || keys <= 0.0 { 0 } else { keys.trunc().min(1e9) as usize };
    let mut c = Converter {
        keys: len,
        output: Vec::new(),
        holding_until: vec![None; len],
        last_row: None,
        initial_row: TimeItem { time: f64::NEG_INFINITY, data: Vec::new() },
    };
    for obj in objects {
        match *obj {
            HitObject::Circle { x, time } => c.add_note(x_to_column(x, keys), time)?,
            HitObject::Hold { x, time, end_time } => {
                if end_time > time {
                    c.start_hold(x_to_column(x, keys), time, end_time)?;
                } else {
                    c.add_note(x_to_column(x, keys), time)?;
                }
            }
        }
    }
    c.finish_holds(f64::INFINITY)?;
    Ok(c.output)
}

fn find_bpm_durations(points: &[TimingPoint], end_time: f64) -> Result<Vec<(f64, f64)>, String> {
    let un: Vec<(f64, f64)> = points
        .iter()
        .filter_map(|p| match *p {
            TimingPoint::Uninherited { time, ms_per_beat, .. } => Some((time, ms_per_beat)),
            _ => None,
        })
        .collect();
    if un.is_empty() {
        return Err("Beatmap has no BPM points set".into());
    }
    let mut data: Vec<(f64, f64)> = Vec::new();
    fn add(data: &mut Vec<(f64, f64)>, key: f64, v: f64) {
        match data.iter_mut().find(|(k, _)| *k == key || (k.is_nan() && key.is_nan())) {
            Some(e) => e.1 += v,
            None => data.push((key, 0.0 + v)),
        }
    }
    let mut current = un[0].1;
    let mut time = un[0].0;
    for &(t, mspb) in &un[1..] {
        add(&mut data, current, t - time);
        time = t;
        current = mspb;
    }
    add(&mut data, current, jsmath::max(end_time - time, 0.0));
    Ok(data)
}

fn convert_timing_points(points: &[TimingPoint], end_time: f64) -> Result<(Vec<TimeItem<Bpm>>, Vec<TimeItem<f64>>), String> {
    let mut durations = find_bpm_durations(points, end_time)?;
    js_sort_by(&mut durations, |a, b| b.1 - a.1);
    let most_common_mspb = durations[0].0;
    let mut sv = Vec::new();
    let mut bpm = Vec::new();
    let mut current_bpm_mult = 1.0;
    for p in points {
        match *p {
            TimingPoint::Uninherited { time, ms_per_beat, meter } => {
                bpm.push(TimeItem { time, data: Bpm { meter, ms_per_beat } });
                current_bpm_mult = if ms_per_beat != 0.0 { most_common_mspb / ms_per_beat } else { 1.0 };
                sv.push(TimeItem { time, data: current_bpm_mult });
            }
            TimingPoint::Inherited { time, multiplier } => {
                sv.push(TimeItem { time, data: current_bpm_mult * multiplier });
            }
        }
    }
    Ok((bpm, sv))
}

fn cleaned_sv(sv: Vec<TimeItem<f64>>) -> Vec<TimeItem<f64>> {
    if sv.is_empty() {
        return Vec::new();
    }
    let mut seen: Vec<f64> = Vec::new();
    let mut dedup_rev: Vec<TimeItem<f64>> = Vec::new();
    for item in sv.into_iter().rev() {
        if seen.iter().any(|&t| t == item.time || (t.is_nan() && item.time.is_nan())) {
            continue;
        }
        seen.push(item.time);
        dedup_rev.push(item);
    }
    dedup_rev.reverse();
    let mut out = Vec::new();
    let mut previous = 1.0;
    for s in dedup_rev {
        if (s.data - previous).abs() > 0.005 {
            previous = s.data;
            out.push(s);
        }
    }
    out
}

pub fn parse_osu_mania_from_text(osu_text: &str) -> Result<PatternChart, String> {
    let secs = parse_sections(osu_text);

    let mut circle_size: Option<&str> = None;
    for line in section(&secs, "Difficulty") {
        if let Some(idx) = line.find(':') {
            if js_trim(&line[..idx]) == "CircleSize" {
                circle_size = Some(js_trim(&line[idx + 1..]));
            }
        }
    }
    let cs = match circle_size {
        Some(v) if !v.is_empty() => v,
        _ => "4",
    };
    let keys = js_parse_float(cs).trunc();

    let timing_points = parse_timing_points(section(&secs, "TimingPoints"));
    let hit_objects = parse_hit_objects(section(&secs, "HitObjects"));

    let snaps = convert_hit_objects(&hit_objects, keys)?;
    if snaps.is_empty() {
        return Err("Beatmap has no hitobjects after conversion".into());
    }
    let end_time = snaps[snaps.len() - 1].time;
    let (bpm, sv) = if !timing_points.is_empty() {
        let (bpm, sv) = convert_timing_points(&timing_points, end_time)?;
        (bpm, cleaned_sv(sv))
    } else {
        (vec![TimeItem { time: 0.0, data: Bpm { meter: 4.0, ms_per_beat: 500.0 } }], vec![TimeItem { time: 0.0, data: 1.0 }])
    };
    Ok(PatternChart { keys, notes: snaps, bpm, sv })
}
