pub mod engine;
pub mod versions;

pub use leoblack_parser::{OsuFileParser, ParseStatus};
pub use engine::{precompile_all, ImportCalls};
pub use versions::{EttVersion, DEFAULT_ETTERNA_VERSION, NON_4K_ETTERNA_FALLBACK_VERSION};

pub const DEFAULT_SCORE_GOAL: f64 = 0.93;

pub const OFFICIAL_OUTPUT_ORDER: [&str; 8] =
    ["Overall", "Stream", "Jumpstream", "Handstream", "Stamina", "JackSpeed", "Chordjack", "Technical"];

pub const DISPLAY_SKILLSET_ORDER: [&str; 8] =
    ["Stream", "Jumpstream", "Handstream", "Stamina", "JackSpeed", "Chordjack", "Technical", "Overall"];

pub const MIN_TAIL_GAP_MS: f64 = 50.0;

#[derive(Debug, Clone)]
pub struct EttOptions {
    pub music_rate: f64,
    pub score_goal: f64,
    pub key_override: Option<f64>,
    pub cvt_flag: Option<String>,
    pub etterna_version: Option<String>,
    pub ln_tail_taps: bool,
}

impl Default for EttOptions {
    fn default() -> Self {
        EttOptions {
            music_rate: 1.0,
            score_goal: DEFAULT_SCORE_GOAL,
            key_override: None,
            cvt_flag: None,
            etterna_version: None,
            ln_tail_taps: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct EttResult {
    pub keycount: i32,
    pub ln_ratio: f64,
    pub metadata: Vec<(String, String)>,
    pub requested_etterna_version: Option<EttVersion>,
    pub etterna_version: Option<EttVersion>,
    pub etterna_version_fallback_reason: Option<String>,
    pub values: [f64; 8],
    pub engine: &'static str,
}

impl EttResult {
    pub fn value(&self, name: &str) -> Option<f64> {
        DISPLAY_SKILLSET_ORDER.iter().position(|&n| n == name).map(|i| self.values[i])
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EttError {
    pub message: String,
}

impl std::fmt::Display for EttError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for EttError {}

pub fn build_rows(chart: &OsuFileParser, ln_tail_taps: bool) -> (Vec<u32>, Vec<f32>) {
    let len = chart.columns.len().min(chart.note_starts.len());
    let mut events: Vec<(f64, u32)> = Vec::with_capacity(len * if ln_tail_taps { 2 } else { 1 });
    for i in 0..len {
        let col = chart.columns[i];
        let start = chart.note_starts[i].trunc();
        if !col.is_finite() || !start.is_finite() || col < 0.0 || col > 31.0 {
            continue;
        }
        let bit = 1u32 << (jsmath::to_int32(col) as u32 & 31);
        events.push((start + 0.0, bit));
        if ln_tail_taps {
            let end = chart.note_ends.get(i).copied().unwrap_or(f64::NAN).trunc();
            if end.is_finite() && end - start >= MIN_TAIL_GAP_MS {
                events.push((end + 0.0, bit));
            }
        }
    }
    events.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
    let mut times: Vec<f64> = Vec::new();
    let mut masks: Vec<u32> = Vec::new();
    for (t, bit) in events {
        if times.last() == Some(&t) {
            *masks.last_mut().unwrap() |= bit;
        } else {
            times.push(t);
            masks.push(bit);
        }
    }
    let offset = if !times.is_empty() && times[0] < 0.0 { -times[0] } else { 0.0 };
    let seconds = times.iter().map(|&t| ((t + offset) / 1000.0) as f32).collect();
    (masks, seconds)
}

fn resolve_keycount(parsed: f64, key_override: Option<f64>) -> Result<f64, EttError> {
    if let Some(k) = key_override {
        if k.is_finite() && versions::is_supported_key(k) {
            return Ok(k);
        }
    }
    if versions::is_supported_key(parsed) {
        return Ok(parsed);
    }
    Err(EttError { message: format!("Unsupported keycount: {}", jsmath::number_to_string(parsed)) })
}

fn is_floor_output(official: &[f64; 8]) -> bool {
    let stream = official[1];
    stream > 0.0
        && stream == official[7]
        && stream == official[6]
        && stream == official[2]
        && stream == official[3]
        && stream == official[5]
}

fn map_output_values(raw: &[f32; 8]) -> [f64; 8] {
    let mut out = [0.0; 8];
    for i in 0..8 {
        let v = raw[i] as f64;
        out[i] = if v.is_nan() || v == 0.0 { 0.0 } else { v };
    }
    out
}

fn sanitize_to_display(official: &[f64; 8]) -> [f64; 8] {
    let mut out = [0.0; 8];
    for (d, name) in DISPLAY_SKILLSET_ORDER.iter().enumerate() {
        let i = OFFICIAL_OUTPUT_ORDER.iter().position(|n| n == name).unwrap();
        let v = official[i];
        out[d] = if v.is_finite() { v } else { 0.0 };
    }
    out
}

fn normalize_options(o: &EttOptions) -> EttOptions {
    EttOptions {
        music_rate: if o.music_rate.is_finite() { o.music_rate } else { 1.0 },
        score_goal: if o.score_goal.is_finite() { o.score_goal } else { DEFAULT_SCORE_GOAL },
        key_override: o.key_override.filter(|&k| k.is_finite() && versions::is_supported_key(k)),
        cvt_flag: o.cvt_flag.clone(),
        etterna_version: o.etterna_version.clone(),
        ln_tail_taps: o.ln_tail_taps,
    }
}

fn apply_mod(chart: &mut OsuFileParser, cvt_flag: Option<&str>) {
    let normalized = cvt_flag.unwrap_or("").to_uppercase();
    if normalized.is_empty() {
        return;
    }
    if normalized.contains("IN") {
        chart.mod_in();
    }
    if normalized.contains("HO") {
        chart.mod_ho();
    }
}

pub fn analyze_etterna_from_text(osu_text: &str, options: &EttOptions) -> Result<EttResult, EttError> {
    analyze_etterna_from_parsed(OsuFileParser::parse(osu_text), options)
}

pub fn analyze_etterna_from_parsed(mut chart: OsuFileParser, options: &EttOptions) -> Result<EttResult, EttError> {
    let options = normalize_options(options);
    if chart.status != ParseStatus::Ok {
        return Err(EttError { message: format!("Beatmap parse status: {}", chart.status.as_str()) });
    }
    let keycount = resolve_keycount(chart.column_count, options.key_override)?;
    apply_mod(&mut chart, options.cvt_flag.as_deref());

    let (masks, seconds) = build_rows(&chart, options.ln_tail_taps);
    let metadata: Vec<(String, String)> = chart.meta_data.iter().map(|(k, v)| (k.to_string(), v.clone())).collect();
    if masks.len() <= 1 {
        return Ok(EttResult {
            keycount: keycount as i32,
            ln_ratio: chart.ln_ratio,
            metadata,
            requested_etterna_version: None,
            etterna_version: None,
            etterna_version_fallback_reason: None,
            values: [0.0; 8],
            engine: "wasm",
        });
    }

    let compute_once = || -> Result<(versions::ResolvedVersion, [f64; 8]), EttError> {
        let resolved = versions::resolve_for_keycount(options.etterna_version.as_deref(), keycount);
        let raw = engine::with_instance(resolved.version, |inst| {
            inst.run(jsmath::to_int32(keycount), options.music_rate, options.score_goal, &masks, &seconds)
        })
        .map_err(|e| EttError { message: e.message })?;
        Ok((resolved, map_output_values(&raw)))
    };

    let (mut resolved, mut official) = compute_once()?;
    if is_floor_output(&official) {
        engine::evict(resolved.version);
        (resolved, official) = compute_once()?;
    }

    Ok(EttResult {
        keycount: keycount as i32,
        ln_ratio: chart.ln_ratio,
        metadata,
        requested_etterna_version: Some(resolved.requested_version),
        etterna_version: Some(resolved.version),
        etterna_version_fallback_reason: resolved.fallback_reason,
        values: sanitize_to_display(&official),
        engine: "wasm",
    })
}
