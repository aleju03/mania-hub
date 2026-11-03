use dan_core::vibro_sections::{analyze_vibro_sections, prepare_vibro_chart, uses_section_vibro, VibroAnalysis, VIBRO_SECTION_VERSION};
use dan_core::{parse_mania_beatmap, ManiaBeatmap};
use leoblack_ett::{analyze_etterna_from_parsed, EttOptions, OsuFileParser, DISPLAY_SKILLSET_ORDER};
use ln_skill::{analyze_any_ln_skill, is_ln_skill_supported, ln_skill_display_values, LnMap, LnSkillOptions, LnSkillResult};
use prism::{analyze_prism, prism_engine_version, uses_prism, PrismOptions};

use crate::json::{num, str, Js, Obj};

#[derive(Clone, Debug, PartialEq)]
pub struct MsdResult {
    pub etterna_version: String,
    pub values: Vec<(String, f64)>,
    pub ln_skill: Option<LnSkillResult>,
    pub vibro_analysis: Option<VibroAnalysis>,
    pub vibro_adjusted: bool,
}

impl MsdResult {
    pub fn value(&self, name: &str) -> Option<f64> {
        self.values.iter().find(|(k, _)| k == name).map(|(_, v)| *v)
    }

    pub fn msd_values(&self) -> leoblack_estimators::MsdValues {
        msd_values_of(&self.values)
    }

    pub fn to_js(&self) -> Js {
        let mut o = Obj::new()
            .with("etternaVersion", str(&self.etterna_version))
            .with("values", values_js(&self.values))
            .with("vibroVersion", num(VIBRO_SECTION_VERSION))
            .with("vibroAdjusted", Js::Bool(self.vibro_adjusted));
        if let Some(skill) = &self.ln_skill {
            o.set("lnSkill", ln_skill_js(skill));
        }
        if let Some(analysis) = &self.vibro_analysis {
            o.set("vibroAnalysis", vibro_analysis_js(analysis));
        }
        o.into()
    }
}

pub fn msd_values_of(values: &[(String, f64)]) -> leoblack_estimators::MsdValues {
    let get = |name: &str| values.iter().find(|(k, _)| k == name).map_or(f64::NAN, |(_, v)| *v);
    leoblack_estimators::MsdValues {
        overall: get("Overall"),
        stream: get("Stream"),
        jumpstream: get("Jumpstream"),
        handstream: get("Handstream"),
        stamina: get("Stamina"),
        jack_speed: get("JackSpeed"),
        chordjack: get("Chordjack"),
        technical: get("Technical"),
    }
}

pub fn values_js(values: &[(String, f64)]) -> Js {
    let mut o = Obj::new();
    for (k, v) in values {
        o.set(k, num(*v));
    }
    o.into()
}

pub fn ln_skill_js(skill: &LnSkillResult) -> Js {
    let mut o = Obj::new()
        .with("version", num(skill.version as f64))
        .with("keyCount", num(skill.key_count as f64))
        .with("rating", skill.rating.map_or(Js::Null, num))
        .with("strain", num(skill.strain))
        .with("eligible", Js::Bool(skill.eligible))
        .with("rated", Js::Bool(skill.rated))
        .with("holdRatio", num(skill.hold_ratio))
        .with("effectiveRatio", num(skill.effective_ratio))
        .with("effectiveHolds", num(skill.effective_holds))
        .with("rate", num(skill.rate))
        .with("od", num(skill.od))
        .with("scoreGoal", num(skill.score_goal));
    if let Some(vector) = &skill.skillsets {
        let mut s = Obj::new();
        for (id, v) in ln_skill::LN_SKILLSET_IDS.iter().zip(vector.iter()) {
            s.set(id, num(*v));
        }
        o.set("skillsets", s.into());
    }
    o.into()
}

pub fn vibro_analysis_js(a: &VibroAnalysis) -> Js {
    let sections = a
        .sections
        .iter()
        .map(|s| {
            Obj::new()
                .with("startTime", num(s.start_time))
                .with("endTime", num(s.end_time))
                .with("reasons", Js::Arr(s.reasons.iter().map(|r| str(r.as_str())).collect()))
                .into()
        })
        .collect();
    let mut shares = Obj::new();
    for (reason, share) in &a.reason_shares {
        shares.set(reason.as_str(), num(*share));
    }
    Obj::new()
        .with("version", num(a.version))
        .with("status", str(a.status.as_str()))
        .with("sections", Js::Arr(sections))
        .with("excludedDurationMs", num(a.excluded_duration_ms))
        .with("activeDurationMs", num(a.active_duration_ms))
        .with("timeShare", num(a.time_share))
        .with("noteShare", num(a.note_share))
        .with("judgementShare", num(a.judgement_share))
        .with("remainingNotes", num(a.remaining_notes))
        .with("repeatShare", num(a.repeat_share))
        .with("reasonShares", shares.into())
        .into()
}

#[derive(Clone, Copy, Debug, Default)]
pub struct MsdOptions<'a> {
    pub etterna_version: Option<&'a str>,
    pub rate: Option<f64>,
    pub key_count: Option<i32>,
    pub score_goal: Option<f64>,
    pub adjust_vibro: bool,
    pub ln_tail_taps: bool,
    pub include_ln_skill: bool,
    pub values_only: bool,
}

pub fn is_msd_supported_key_count(key_count: i32) -> bool {
    (4..=18).contains(&key_count)
}

#[derive(Clone, Copy)]
pub struct MsdChart<'a> {
    pub text: &'a str,
    pub map: &'a ManiaBeatmap,
    pub parsed: Option<&'a OsuFileParser>,
}

#[derive(Clone, Copy)]
pub struct PreparedVibro<'a> {
    pub analysis: &'a VibroAnalysis,
    pub chart: Option<MsdChart<'a>>,
}

pub fn compute_msd(osu_text: &str, options: &MsdOptions, map: &ManiaBeatmap, parsed: Option<&OsuFileParser>) -> Option<MsdResult> {
    let chart = MsdChart { text: osu_text, map, parsed };
    if !options.adjust_vibro || options.key_count.map_or(false, |kc| !is_msd_supported_key_count(kc)) {
        return compute_msd_prepared(chart, options, None);
    }
    let (analysis, text) = prepare_vibro_chart(osu_text, options.rate.unwrap_or(1.0), map);
    let removed_map = text.as_deref().map(parse_mania_beatmap);
    let removed = match (&text, &removed_map) {
        (Some(text), Some(map)) => Some(MsdChart { text, map, parsed: None }),
        _ => None,
    };
    compute_msd_prepared(chart, options, Some(PreparedVibro { analysis: &analysis, chart: removed }))
}

pub fn compute_msd_prepared(chart: MsdChart, options: &MsdOptions, prepared: Option<PreparedVibro>) -> Option<MsdResult> {
    if let Some(kc) = options.key_count {
        if !is_msd_supported_key_count(kc) {
            return None;
        }
    }
    let map = chart.map;
    let rate = options.rate.unwrap_or(1.0);
    let owned;
    let owned_map;
    let prepared = if options.adjust_vibro {
        match prepared {
            Some(p) => Some(p),
            None => {
                owned = prepare_vibro_chart(chart.text, rate, map);
                owned_map = owned.1.as_deref().map(parse_mania_beatmap);
                let removed = match (&owned.1, &owned_map) {
                    (Some(text), Some(map)) => Some(MsdChart { text, map, parsed: None }),
                    _ => None,
                };
                Some(PreparedVibro { analysis: &owned.0, chart: removed })
            }
        }
    } else {
        None
    };
    let analysis = if !options.values_only && uses_section_vibro(map) {
        Some(match &prepared {
            Some(p) => p.analysis.clone(),
            None => analyze_vibro_sections(map, rate),
        })
    } else {
        None
    };
    let rated = prepared.and_then(|p| p.chart).unwrap_or(chart);
    let (etterna_version, values): (String, Vec<(String, f64)>) = if uses_prism(Some(map.key_count)) {
        if options.ln_tail_taps {
            return None;
        }
        let prism = analyze_prism(
            &rated.map.notes,
            rated.map.key_count,
            rated.map.od,
            &PrismOptions { rate: options.rate, od: None, goal: options.score_goal, overall_only: false },
        )?;
        (prism_engine_version(), prism.values.iter().map(|(k, v)| (k.to_string(), *v)).collect())
    } else {
        let ett_options = EttOptions {
            music_rate: rate,
            score_goal: options.score_goal.unwrap_or(f64::NAN),
            key_override: options.key_count.map(|k| k as f64),
            etterna_version: options.etterna_version.map(str::to_string),
            ln_tail_taps: if map.key_count == 4 { false } else { options.ln_tail_taps },
            ..EttOptions::default()
        };
        let parsed = match rated.parsed {
            Some(p) => p.clone(),
            None => OsuFileParser::parse(rated.text),
        };
        let ett = analyze_etterna_from_parsed(parsed, &ett_options).ok()?;
        (
            ett.etterna_version.map_or_else(|| "unknown".to_string(), |v| v.key().to_string()),
            DISPLAY_SKILLSET_ORDER.iter().zip(ett.values.iter()).map(|(k, v)| (k.to_string(), *v)).collect(),
        )
    };
    let wants_ln = options.key_count.map_or(true, is_ln_skill_supported) && !options.ln_tail_taps && options.include_ln_skill;
    let ln_skill = if wants_ln {
        analyze_any_ln_skill(
            &LnMap { notes: &map.notes, key_count: map.key_count, od: map.od },
            &LnSkillOptions { rate: options.rate, score_goal: options.score_goal, ..Default::default() },
        )
    } else {
        None
    };
    let values = match &ln_skill {
        Some(skill) => ln_skill_display_values(skill, &values),
        None => values,
    };
    Some(MsdResult { etterna_version, values, ln_skill, vibro_analysis: analysis, vibro_adjusted: options.adjust_vibro })
}
