use crate::beatmap::ManiaNote;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum DanSkillFamily {
    Jack,
    Stream,
    Jumpstream,
    Handstream,
    Stamina,
    Chordjack,
    Tech,
    Ln,
    Dan,
}

impl DanSkillFamily {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Jack => "jack",
            Self::Stream => "stream",
            Self::Jumpstream => "jumpstream",
            Self::Handstream => "handstream",
            Self::Stamina => "stamina",
            Self::Chordjack => "chordjack",
            Self::Tech => "tech",
            Self::Ln => "ln",
            Self::Dan => "dan",
        }
    }
}

pub type DanPrimaryFamily = DanSkillFamily;

pub const DAN_PRIMARY_FAMILIES: [DanSkillFamily; 7] = [
    DanSkillFamily::Jack,
    DanSkillFamily::Stream,
    DanSkillFamily::Jumpstream,
    DanSkillFamily::Handstream,
    DanSkillFamily::Stamina,
    DanSkillFamily::Chordjack,
    DanSkillFamily::Tech,
];

#[derive(Clone, Debug, Default, PartialEq)]
pub struct DanEstimateInput {
    pub star_rating: Option<f64>,
    pub total_length: Option<f64>,
    pub title: Option<String>,
    pub version: Option<String>,
    pub rate: Option<f64>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct DanFeatureMetrics {
    pub key_count: f64,
    pub note_count: f64,
    pub duration_ms: f64,
    pub hold_ratio: f64,
    pub chord_ratio: f64,
    pub two_note_chord_ratio: f64,
    pub peak_nps1s: f64,
    pub peak_nps5s: f64,
    pub nps5s_p50: f64,
    pub nps5s_p90: f64,
    pub nps5s_p95: f64,
    pub sustained_nps10s: f64,
    pub sustained_nps30s: f64,
    pub sustained_nps60s: f64,
    pub active_nps: f64,
    pub long_gap_ratio: f64,
    pub long_gap_count: f64,
    pub jack_pressure: f64,
    pub stream_pressure: f64,
    pub jumpstream_pressure: f64,
    pub chordjack_pressure: f64,
    pub chord_column_overlap_ratio: f64,
    pub adjacent_column_rehit_share: f64,
    pub two_back_column_rehit_share: f64,
    pub two_back_column_rehit_excess: f64,
    pub tech_pressure: f64,
    pub row_burst_pressure: f64,
    pub fast_row_ratio: f64,
    pub row_interval_entropy: f64,
    pub off_grid_row_share: f64,
    pub pattern_variety: f64,
    pub row_pattern_entropy: f64,
    pub row_pattern_variety: f64,
    pub repeated_row_pattern_ratio: f64,
    pub alternating_row_pattern_ratio: f64,
    pub row_pattern_change_rate: f64,
    pub row_motif_repeat_ratio: f64,
    pub rhythm_motif_repeat_ratio: f64,
    pub adjacent_motif_repeat_ratio: f64,
    pub strain_spikiness: f64,
    pub sustained_pressure_ratio: f64,
    pub anchor_pressure: f64,
    pub ln_release_pressure: f64,
    pub ln_density: f64,
    pub ln_overlap_pressure: f64,
    pub ln_chord_pressure: f64,
    pub ln_hold_duration_avg: f64,
    pub ln_hold_duration_p90: f64,
    pub chord_size_change_rate: f64,
    pub direction_change_rate: f64,
    pub stamina_pressure: f64,
}

impl DanFeatureMetrics {
    pub fn fields(&self) -> [(&'static str, f64); 51] {
        [
            ("keyCount", self.key_count),
            ("noteCount", self.note_count),
            ("durationMs", self.duration_ms),
            ("holdRatio", self.hold_ratio),
            ("chordRatio", self.chord_ratio),
            ("twoNoteChordRatio", self.two_note_chord_ratio),
            ("peakNps1s", self.peak_nps1s),
            ("peakNps5s", self.peak_nps5s),
            ("nps5sP50", self.nps5s_p50),
            ("nps5sP90", self.nps5s_p90),
            ("nps5sP95", self.nps5s_p95),
            ("sustainedNps10s", self.sustained_nps10s),
            ("sustainedNps30s", self.sustained_nps30s),
            ("sustainedNps60s", self.sustained_nps60s),
            ("activeNps", self.active_nps),
            ("longGapRatio", self.long_gap_ratio),
            ("longGapCount", self.long_gap_count),
            ("jackPressure", self.jack_pressure),
            ("streamPressure", self.stream_pressure),
            ("jumpstreamPressure", self.jumpstream_pressure),
            ("chordjackPressure", self.chordjack_pressure),
            ("chordColumnOverlapRatio", self.chord_column_overlap_ratio),
            ("adjacentColumnRehitShare", self.adjacent_column_rehit_share),
            ("twoBackColumnRehitShare", self.two_back_column_rehit_share),
            ("twoBackColumnRehitExcess", self.two_back_column_rehit_excess),
            ("techPressure", self.tech_pressure),
            ("rowBurstPressure", self.row_burst_pressure),
            ("fastRowRatio", self.fast_row_ratio),
            ("rowIntervalEntropy", self.row_interval_entropy),
            ("offGridRowShare", self.off_grid_row_share),
            ("patternVariety", self.pattern_variety),
            ("rowPatternEntropy", self.row_pattern_entropy),
            ("rowPatternVariety", self.row_pattern_variety),
            ("repeatedRowPatternRatio", self.repeated_row_pattern_ratio),
            ("alternatingRowPatternRatio", self.alternating_row_pattern_ratio),
            ("rowPatternChangeRate", self.row_pattern_change_rate),
            ("rowMotifRepeatRatio", self.row_motif_repeat_ratio),
            ("rhythmMotifRepeatRatio", self.rhythm_motif_repeat_ratio),
            ("adjacentMotifRepeatRatio", self.adjacent_motif_repeat_ratio),
            ("strainSpikiness", self.strain_spikiness),
            ("sustainedPressureRatio", self.sustained_pressure_ratio),
            ("anchorPressure", self.anchor_pressure),
            ("lnReleasePressure", self.ln_release_pressure),
            ("lnDensity", self.ln_density),
            ("lnOverlapPressure", self.ln_overlap_pressure),
            ("lnChordPressure", self.ln_chord_pressure),
            ("lnHoldDurationAvg", self.ln_hold_duration_avg),
            ("lnHoldDurationP90", self.ln_hold_duration_p90),
            ("chordSizeChangeRate", self.chord_size_change_rate),
            ("directionChangeRate", self.direction_change_rate),
            ("staminaPressure", self.stamina_pressure),
        ]
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct DanFeatureExtractionResult {
    pub notes: Vec<ManiaNote>,
    pub note_times: Vec<f64>,
    pub duration_ms: f64,
    pub ordered_rows: Vec<(f64, Vec<ManiaNote>)>,
    pub metrics: DanFeatureMetrics,
    pub warnings: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ManiaPatternId {
    Jack,
    Chordjack,
    Speedjack,
    Handjack,
    Tech,
    Stream,
    Dumpstream,
    Jumpstream,
    Handstream,
    Quadstream,
    Delay,
    Bracket,
    Chordstream,
    Ln,
    Lnhybrid,
    Lntechnical,
    Lnwalls,
    Lnspeed,
    Lngeneral,
    Lnrelease,
    Lninverse,
    Lntech,
}

impl ManiaPatternId {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Jack => "jack",
            Self::Chordjack => "chordjack",
            Self::Speedjack => "speedjack",
            Self::Handjack => "handjack",
            Self::Tech => "tech",
            Self::Stream => "stream",
            Self::Dumpstream => "dumpstream",
            Self::Jumpstream => "jumpstream",
            Self::Handstream => "handstream",
            Self::Quadstream => "quadstream",
            Self::Delay => "delay",
            Self::Bracket => "bracket",
            Self::Chordstream => "chordstream",
            Self::Ln => "ln",
            Self::Lnhybrid => "lnhybrid",
            Self::Lntechnical => "lntechnical",
            Self::Lnwalls => "lnwalls",
            Self::Lnspeed => "lnspeed",
            Self::Lngeneral => "lngeneral",
            Self::Lnrelease => "lnrelease",
            Self::Lninverse => "lninverse",
            Self::Lntech => "lntech",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Jack => "Jack",
            Self::Chordjack => "Chordjack",
            Self::Speedjack => "Speedjack",
            Self::Handjack => "Handjack",
            Self::Tech => "Tech",
            Self::Stream => "Stream",
            Self::Dumpstream => "Dumpstream",
            Self::Jumpstream => "Jumpstream",
            Self::Handstream => "Handstream",
            Self::Quadstream => "Quadstream",
            Self::Delay => "Delay",
            Self::Bracket => "Bracket",
            Self::Chordstream => "Chordstream",
            Self::Ln => "LN",
            Self::Lnhybrid => "LN All-round",
            Self::Lntechnical => "LN Technical",
            Self::Lnwalls => "LN Walls",
            Self::Lnspeed => "LN Speed",
            Self::Lngeneral => "LN General",
            Self::Lnrelease => "LN Release",
            Self::Lninverse => "LN Inverse",
            Self::Lntech => "LN Tech",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        ALL_PATTERN_IDS.iter().copied().find(|id| id.as_str() == s)
    }
}

const ALL_PATTERN_IDS: [ManiaPatternId; 22] = [
    ManiaPatternId::Jack,
    ManiaPatternId::Chordjack,
    ManiaPatternId::Speedjack,
    ManiaPatternId::Handjack,
    ManiaPatternId::Tech,
    ManiaPatternId::Stream,
    ManiaPatternId::Dumpstream,
    ManiaPatternId::Jumpstream,
    ManiaPatternId::Handstream,
    ManiaPatternId::Quadstream,
    ManiaPatternId::Delay,
    ManiaPatternId::Bracket,
    ManiaPatternId::Chordstream,
    ManiaPatternId::Ln,
    ManiaPatternId::Lnhybrid,
    ManiaPatternId::Lntechnical,
    ManiaPatternId::Lnwalls,
    ManiaPatternId::Lnspeed,
    ManiaPatternId::Lngeneral,
    ManiaPatternId::Lnrelease,
    ManiaPatternId::Lninverse,
    ManiaPatternId::Lntech,
];

#[derive(Clone, Debug, PartialEq)]
pub struct ManiaPatternHit {
    pub id: ManiaPatternId,
    pub label: &'static str,
    pub score: f64,
    pub confidence: f64,
    pub evidence: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ManiaPatternAnalysis {
    pub key_count: f64,
    pub primary: Option<ManiaPatternHit>,
    pub patterns: Vec<ManiaPatternHit>,
    pub all_patterns: Vec<ManiaPatternHit>,
    pub metrics: DanFeatureMetrics,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct DanFamilyChoiceDebug {
    pub top_family: DanSkillFamily,
    pub top_score: f64,
    pub selected_family: DanSkillFamily,
    pub reason: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct DanEstimateDebug {
    pub family_choice: DanFamilyChoiceDebug,
}

#[derive(Clone, Debug, PartialEq)]
pub struct DanEstimate {
    pub label: String,
    pub variant: Option<String>,
    pub display_name: String,
    pub raw_dan: f64,
    pub estimated_sr: f64,
    pub family: DanSkillFamily,
    pub confidence: f64,
    pub metrics: DanFeatureMetrics,
    pub skill_scores: Vec<(DanSkillFamily, f64)>,
    pub warnings: Vec<String>,
    pub debug: Option<DanEstimateDebug>,
}
