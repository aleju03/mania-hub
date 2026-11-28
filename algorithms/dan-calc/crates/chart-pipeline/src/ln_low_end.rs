use dan_core::ManiaNote;
use ln_skill::{analyze_ln_skill, LnMap, LnSkillOptions};

pub const LN_LOW_END_RATING_AT_FIRST: f64 = 12.322;
pub const LN_LOW_END_RATING_PER_LEVEL: f64 = 1.71;
pub const LN_LOW_END_TABLE_TAKEOVER: f64 = 5.6;
pub const LN_LOW_END_BEND_FROM: f64 = 5.0;

pub fn ln_low_end_dan_for_rating(rating: f64) -> f64 {
    if !(rating > 0.0) {
        return 0.0;
    }
    if rating < LN_LOW_END_RATING_AT_FIRST {
        return rating / LN_LOW_END_RATING_AT_FIRST;
    }
    1.0 + (rating - LN_LOW_END_RATING_AT_FIRST) / LN_LOW_END_RATING_PER_LEVEL
}

pub fn ln_low_end_bounded(level: f64) -> f64 {
    if !(level > LN_LOW_END_BEND_FROM) {
        return jsmath::max(0.0, level);
    }
    let room = LN_LOW_END_TABLE_TAKEOVER - LN_LOW_END_BEND_FROM;
    LN_LOW_END_BEND_FROM + room * (1.0 - jsmath::exp(-(level - LN_LOW_END_BEND_FROM) / room))
}

pub fn ln_table_reads_low_end(raw_dan: f64, boundary: Option<&str>) -> bool {
    boundary == Some("below") || (boundary.is_none() && raw_dan < LN_LOW_END_TABLE_TAKEOVER)
}

const COURSE_GAP_MS: f64 = 4500.0;
const COURSE_SONG_MIN_MS: f64 = 60_000.0;
const COURSE_MIN_SONGS: usize = 3;
const FULL_LENGTH_MS: f64 = 60_000.0;

pub fn ln_course_songs(notes: &[ManiaNote]) -> Option<Vec<Vec<ManiaNote>>> {
    let mut sorted = notes.to_vec();
    jsmath::js_sort_by(&mut sorted, |left, right| left.time - right.time);
    let mut songs: Vec<Vec<ManiaNote>> = Vec::new();
    let mut current: Vec<ManiaNote> = Vec::new();
    let mut end = f64::NEG_INFINITY;
    for note in sorted {
        if !current.is_empty() && note.time - end >= COURSE_GAP_MS {
            songs.push(std::mem::take(&mut current));
        }
        end = jsmath::max(jsmath::max(end, note.time), note.end_time);
        current.push(note);
    }
    if !current.is_empty() {
        songs.push(current);
    }
    if songs.len() < COURSE_MIN_SONGS {
        return None;
    }
    for song in &songs {
        let mut last = song[0].time;
        for note in song {
            last = jsmath::max(jsmath::max(last, note.time), note.end_time);
        }
        if last - song[0].time < COURSE_SONG_MIN_MS {
            return None;
        }
    }
    Some(songs)
}

pub fn ln_low_end_length_factor(notes: &[ManiaNote]) -> f64 {
    let mut first = f64::INFINITY;
    let mut last = f64::NEG_INFINITY;
    for note in notes {
        first = jsmath::min(first, note.time);
        last = jsmath::max(jsmath::max(last, note.time), note.end_time);
    }
    if !(last > first) {
        return 0.0;
    }
    jsmath::sqrt(jsmath::min(1.0, (last - first) / FULL_LENGTH_MS))
}

pub fn ln_low_end_dan(map: &LnMap, rate: f64, od: f64) -> Option<f64> {
    let level = |notes: &[ManiaNote]| -> Option<f64> {
        let skill = analyze_ln_skill(
            &LnMap { notes, key_count: map.key_count, od: map.od },
            &LnSkillOptions { rate: Some(rate), od: Some(od), score_goal: None, include_skillsets: Some(false) },
        )?;
        skill.rating.map(ln_low_end_dan_for_rating)
    };
    let mut reading = level(map.notes)?;
    if let Some(songs) = ln_course_songs(map.notes) {
        let levels: Vec<Option<f64>> = songs.iter().map(|song| level(song)).collect();
        if levels.iter().all(|value| value.is_some()) {
            let mut sum = 0.0;
            for value in &levels {
                sum += value.unwrap();
            }
            reading = sum / levels.len() as f64;
        }
    }
    Some(jsmath::round(ln_low_end_bounded(reading * ln_low_end_length_factor(map.notes)) * 100.0) / 100.0)
}
