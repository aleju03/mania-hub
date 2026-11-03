use std::collections::HashMap;

use dan_core::ln::LN_PRIMARY_MIN_RATIO;
use leoblack_parser::OsuFileParser;

use crate::classifier::{classify_chart_ln_table_half, ChartContext, Unported};

pub const HYBRID_LN_SECTIONS_VERSION: f64 = 1.0;
const WINDOW_MS: f64 = 10_000.0;
const WINDOW_MIN_NOTES: f64 = 8.0;
const MIN_SECTION_NOTES: usize = 100;

#[derive(Clone, Debug, PartialEq)]
pub struct HybridLnSectionsReading {
    pub raw_dan: f64,
    pub label: String,
    pub note_share: f64,
}

fn split_lines(text: &str) -> Vec<&str> {
    text.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).collect()
}

pub fn cut_hybrid_ln_sections(osu_text: &str) -> Option<(String, usize, usize)> {
    let lines = split_lines(osu_text);
    let start = lines.iter().position(|l| jsmath::js_trim(l) == "[HitObjects]")?;
    struct Object<'a> {
        line: &'a str,
        time: f64,
        hold: bool,
    }
    let objects: Vec<Object> = lines[start + 1..]
        .iter()
        .filter(|l| !jsmath::js_trim(l).is_empty())
        .map(|&line| {
            let mut parts = line.split(',');
            let p2 = parts.nth(2);
            let p3 = parts.next();
            let time = p2.map_or(f64::NAN, jsmath::js_number_from_str);
            let kind = p3.map_or(f64::NAN, jsmath::js_number_from_str);
            Object { line, time, hold: (jsmath::to_int32(kind) & 128) != 0 }
        })
        .filter(|o| o.time.is_finite())
        .collect();
    if objects.is_empty() {
        return None;
    }
    let first = objects.iter().fold(f64::INFINITY, |min, o| jsmath::min(min, o.time));
    let window_of = |time: f64| ((time - first) / WINDOW_MS).floor();
    let mut windows: HashMap<u64, (f64, f64)> = HashMap::new();
    let key = |w: f64| (if w == 0.0 { 0.0 } else { w }).to_bits();
    for o in &objects {
        let entry = windows.entry(key(window_of(o.time))).or_insert((0.0, 0.0));
        entry.0 += 1.0;
        if o.hold {
            entry.1 += 1.0;
        }
    }
    let kept: Vec<&Object> = objects
        .iter()
        .filter(|o| {
            let (notes, holds) = windows[&key(window_of(o.time))];
            notes >= WINDOW_MIN_NOTES && holds / notes >= LN_PRIMARY_MIN_RATIO
        })
        .collect();
    let mut text = lines[..start + 1].join("\n");
    for o in &kept {
        text.push('\n');
        text.push_str(o.line);
    }
    Some((text, kept.len(), objects.len()))
}

pub fn rate_hybrid_ln_sections(osu_text: &str) -> Result<Option<HybridLnSectionsReading>, Unported> {
    let Some((text, kept, total)) = cut_hybrid_ln_sections(osu_text) else { return Ok(None) };
    if kept < MIN_SECTION_NOTES {
        return Ok(None);
    }
    let map = dan_core::parse_mania_beatmap(&text);
    let parsed = OsuFileParser::parse(&text);
    let ctx = ChartContext::new(&text, &map, &parsed);
    let Some((_label, display_name, raw_dan)) = classify_chart_ln_table_half(&ctx)? else { return Ok(None) };
    Ok(Some(HybridLnSectionsReading {
        raw_dan,
        label: display_name,
        note_share: jsmath::round((kept as f64 / total as f64) * 10_000.0) / 10_000.0,
    }))
}
