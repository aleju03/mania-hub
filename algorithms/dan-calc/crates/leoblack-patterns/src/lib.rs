pub mod chart;
pub mod clustering;
pub mod config;
pub mod defs;
pub mod find;
pub mod primitives;
pub mod summary;
pub mod vibro;

pub use chart::{Bpm, Chart, NoteType, TimeItem};
pub use clustering::{calculate_clustered_patterns, Cluster};
pub use config::{mode_tag_from_ln_ratio, ModeTag};
pub use defs::{jack_bpm, CorePattern, Specific};
pub use find::{find, FoundPattern};
pub use summary::{from_chart, PatternReport};
pub use vibro::{detect_longjack_vibro_at_rate, detect_vibro, detect_vibro_from_longjack_pattern};

pub fn analyze_pattern_from_text(osu_text: &str) -> Result<PatternReport, String> {
    let chart = leoblack_parser::parse_osu_mania_from_text(osu_text)?;
    from_chart(&chart)
}

pub fn analyze_pattern_from_chart(chart: &Chart) -> Result<PatternReport, String> {
    from_chart(chart)
}
