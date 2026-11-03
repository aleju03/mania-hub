pub const RC_CORE_LN_SCALE: f64 = 0.3;
pub const RC_LN_CORE_SCALE: f64 = 0.0;
pub const RELEASE_WITH_DW_MULTIPLIER: f64 = 0.8;
pub const LN_MODE_LOW_THRESHOLD: f64 = 0.15;
pub const LN_MODE_HIGH_THRESHOLD: f64 = 0.9;
pub const HB_ROW_RATIO_THRESHOLD: f64 = 0.1;
pub const BPM_CLUSTER_THRESHOLD: f64 = 5.0;
pub const CLUSTER_TIMED_MIN_MSPB: f64 = 40.0;
pub const PATTERN_STABILITY_THRESHOLD: f64 = 5.0;
pub const IMPORTANT_CLUSTER_RATIO: f64 = 0.5;
pub const CATEGORY_JS_HS_SECONDARY_RATIO: f64 = 0.4;
pub const SV_AMOUNT_THRESHOLD: f64 = 2000.0;
pub const SV_SPEED_EPS: f64 = 0.05;
pub const SV_EXTREME_BPM_MIN: f64 = 20.0;
pub const SV_EXTREME_BPM_MAX: f64 = 450.0;
pub const SV_EXTREME_BPM_RATIO: f64 = 4.0;
pub const LONGJACK_VIBRO_RATIO_THRESHOLD: f64 = 0.6;
pub const LONGJACK_VIBRO_MIN_BPM: f64 = 180.0;
pub const CLUSTER_SPECIFIC_NAME_MIN_RATIO: f64 = 0.0;
pub const JACKY_MIN_BPM: f64 = 90.0;
pub const SHIELD_MAX_BEAT_RATIO: f64 = 0.25;
pub const INVERSE_GAP_TOLERANCE_MS: f64 = 5.0;
pub const INVERSE_MIN_FILLED_LANES: u32 = 3;
pub const RELEASE_SCAN_ROWS: usize = 4;
pub const RELEASE_MIN_TAIL_ROWS: usize = 4;
pub const RELEASE_ROLL_POINTS: usize = 2;
pub const RELEASE_FULL_MATCH_ROWS: usize = 5;
pub const JACKY_CONTEXT_WINDOW: usize = 6;
pub const JACKY_FALLBACK_MAX_MSPB: f64 = 185.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ModeTag {
    Rc,
    Ln,
    Hb,
    Mix,
}

impl ModeTag {
    pub fn as_str(self) -> &'static str {
        match self {
            ModeTag::Rc => "RC",
            ModeTag::Ln => "LN",
            ModeTag::Hb => "HB",
            ModeTag::Mix => "Mix",
        }
    }
}

pub fn mode_tag_from_ln_ratio(ln_ratio: f64) -> ModeTag {
    if !ln_ratio.is_finite() {
        return ModeTag::Mix;
    }
    if ln_ratio <= LN_MODE_LOW_THRESHOLD {
        return ModeTag::Rc;
    }
    if ln_ratio >= LN_MODE_HIGH_THRESHOLD {
        return ModeTag::Ln;
    }
    ModeTag::Mix
}
