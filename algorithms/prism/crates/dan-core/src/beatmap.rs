pub use chart_parser::{ManiaBeatmap, ManiaBreakPeriod, ManiaNote, ManiaScrollVelocity, ManiaTimingPoint, NAN_COLUMN};

pub fn clone_without_notes(map: &ManiaBeatmap) -> ManiaBeatmap {
    ManiaBeatmap {
        title: map.title.clone(),
        artist: map.artist.clone(),
        version: map.version.clone(),
        creator: map.creator.clone(),
        key_count: map.key_count,
        od: map.od,
        bpm: map.bpm,
        notes: Vec::new(),
        total_length: map.total_length,
        beatmapset_id: map.beatmapset_id,
        audio_filename: map.audio_filename.clone(),
        preview_time: map.preview_time,
        background_filename: map.background_filename.clone(),
        break_periods: map.break_periods.clone(),
        scroll_velocities: map.scroll_velocities.clone(),
        timing_points: map.timing_points.clone(),
    }
}
