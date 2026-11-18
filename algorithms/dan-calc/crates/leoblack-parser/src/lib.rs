pub mod osu_file_parser;
pub mod pattern_parser;

pub use osu_file_parser::{OsuFileParser, ParseStatus};
pub use pattern_parser::{parse_osu_mania_from_text, Bpm, NoteType, PatternChart, TimeItem};

pub fn key_count_from_circle_size(value: &str) -> f64 {
    let cs = jsmath::js_parse_float(value);
    let floor = cs.floor();
    let diff = cs - floor;
    if diff > 0.5 {
        return floor + 1.0;
    }
    if diff < 0.5 {
        return floor;
    }
    if floor % 2.0 == 0.0 { floor } else { floor + 1.0 }
}

#[inline]
pub fn x_to_column(x: f64, keys: f64) -> f64 {
    let mut col = ((x / 512.0) * keys).trunc();
    if col < 0.0 {
        col = 0.0;
    }
    if col > keys - 1.0 {
        col = keys - 1.0;
    }
    col
}
