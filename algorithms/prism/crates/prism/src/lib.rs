pub mod ln_lead;
pub mod ln_sections;
pub mod params;
pub mod workload;

use dan_core::ManiaNote;
use jsmath::{exp, log, max, max_of, min, pow};

pub use params::{
    is_prism_key_count, prism_models, uses_prism, PrismKeymodeModel, PrismModel, PrismScale, PRISM_BASE_GOAL,
    PRISM_CALC_VERSION, PRISM_ENABLED, PRISM_EXTRAPOLATION_MAX_SLOPE, PRISM_GOAL_FLOOR, PRISM_KEY_COUNTS, PRISM_MAX_GOAL,
    PRISM_UNDER_BASE_STRETCH,
};
pub use ln_lead::{
    prism_ln_lead_target, prism_ln_lead_values, prism_ln_lead_weight, prism_skillsets_at, PRISM_LN_LEAD_FROM_HOLDS, PRISM_LN_LEAD_FULL_HOLDS,
    PRISM_LN_LEAD_SHARE,
};
pub use ln_sections::{prism_ln_section_line, prism_ln_spans};
pub use workload::{build_prism_chart, prism_hands, prism_sections, PrismChart, PrismSection, PATTERNS};

use params::{PRISM_SKILLSET_FLOOR, PRISM_SKILLSET_SHAPE};

const SKILLSET_SOURCES: [(&str, Option<usize>); 8] = [
    ("Stream", Some(0)),
    ("JumpstreamOnly", Some(1)),
    ("Handstream", Some(2)),
    ("Stamina", None),
    ("JackSpeed", Some(3)),
    ("ChordjackOnly", Some(4)),
    ("Technical", Some(6)),
    ("Speed", Some(7)),
];

const MERGED: [(&str, &str, &str); 2] = [("Jumpstream", "Stream", "JumpstreamOnly"), ("Chordjack", "JackSpeed", "ChordjackOnly")];

pub const PRISM_VALUE_NAMES: [&str; 11] = [
    "Overall",
    "Stream",
    "JumpstreamOnly",
    "Handstream",
    "Stamina",
    "JackSpeed",
    "ChordjackOnly",
    "Technical",
    "Speed",
    "Jumpstream",
    "Chordjack",
];

const SKILLSET_SHARE_CAP: f64 = 2.0;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct PrismOptions {
    pub rate: Option<f64>,
    pub od: Option<f64>,
    pub goal: Option<f64>,
    pub overall_only: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PrismResult {
    pub version: u32,
    pub key_count: i32,
    pub rate: f64,
    pub goal: f64,
    pub values: Vec<(&'static str, f64)>,
    pub centre_hand: u8,
}

impl PrismResult {
    pub fn value(&self, name: &str) -> Option<f64> {
        self.values.iter().find(|(k, _)| *k == name).map(|(_, v)| *v)
    }
    pub fn overall(&self) -> f64 {
        self.values[0].1
    }
}

pub fn prism_strain_at_goal(demand: &[f64], weight: &[f64], goal: f64, goal_exponent: f64) -> f64 {
    let mut total = 0.0;
    let mut peak = 0.0;
    for i in 0..demand.len() {
        total += weight[i];
        if demand[i] > peak {
            peak = demand[i];
        }
    }
    if !(goal > 0.0) || !(total > 0.0) || !(peak > 0.0) {
        return 0.0;
    }
    let log_base = log(PRISM_BASE_GOAL);
    let mut lo = 0.0;
    let mut hi = peak * 8.0;
    let mut skill = peak;
    for _ in 0..60 {
        let mut score = 0.0;
        let mut slope = 0.0;
        for j in 0..demand.len() {
            if !(demand[j] > 0.0) {
                score += weight[j];
                continue;
            }
            let t = pow(demand[j] / skill, goal_exponent);
            let f = weight[j] * exp(log_base * t);
            score += f;
            slope -= f * log_base * goal_exponent * t / skill;
        }
        let miss = score / total - goal;
        if miss < 0.0 {
            lo = skill;
        } else {
            hi = skill;
        }
        if miss.abs() < 1e-12 || hi - lo < 1e-10 * hi {
            break;
        }
        let next = if slope > 0.0 { skill - miss * total / slope } else { f64::NAN };
        skill = if next > lo && next < hi { next } else { (lo + hi) / 2.0 };
    }
    skill
}

pub fn prism_rating_of_strain(strain: f64, scale: &PrismScale) -> f64 {
    if !(strain > 0.0) {
        return 0.0;
    }
    let xs = &scale.strain;
    let ys = &scale.rating;
    let x = log(strain);
    let mut i = 1;
    while i < xs.len() - 1 && x > log(xs[i]) {
        i += 1;
    }
    let x0 = log(xs[i - 1]);
    let y0 = log(ys[i - 1]);
    let x1 = log(xs[i]);
    let y1 = log(ys[i]);
    exp(y0 + ((y1 - y0) / (x1 - x0)) * (x - x0))
}

fn demands_of(sections: &[PrismSection]) -> Vec<f64> {
    sections.iter().map(|s| s.demand).collect()
}
fn weights_of(sections: &[PrismSection]) -> Vec<f64> {
    sections.iter().map(|s| s.work).collect()
}

pub fn pick_prism_hands(chart: &PrismChart, model: &PrismModel) -> (u8, Vec<PrismSection>) {
    let left = prism_sections(chart, 0, model);
    if chart.key_count % 2 == 0 {
        return (0, left);
    }
    let right = prism_sections(chart, 1, model);
    let strain =
        |s: &[PrismSection]| prism_strain_at_goal(&demands_of(s), &weights_of(s), PRISM_BASE_GOAL, model.goal_exponent);
    if strain(&left) <= strain(&right) {
        (0, left)
    } else {
        (1, right)
    }
}

fn skillset_demand(sections: &[PrismSection], source: usize) -> Vec<f64> {
    let shape = PRISM_SKILLSET_SHAPE[source];
    sections
        .iter()
        .map(|section| {
            let share = if section.work > 0.0 {
                section.mix[source] / section.work
            } else {
                0.0
            };
            section.demand
                * (PRISM_SKILLSET_FLOOR
                    + (1.0 - PRISM_SKILLSET_FLOOR) * pow(min(SKILLSET_SHARE_CAP, share / shape.reference), shape.exponent))
        })
        .collect()
}

#[derive(Clone, Debug, PartialEq)]
pub struct PrismPrepared {
    pub key_count: i32,
    pub rate: f64,
    pub od: f64,
    pub centre_hand: u8,
    pub time: Vec<f64>,
    pub weight: Vec<f64>,
    pub overall: Vec<f64>,
    pub skillsets: Option<Vec<Option<Vec<f64>>>>,
    model: PrismModel,
    scale: PrismScale,
}

pub fn prism_rate(rate: Option<f64>) -> f64 {
    match rate {
        Some(r) if r.is_finite() && r > 0.0 => r,
        _ => 1.0,
    }
}

pub fn prism_od(od: Option<f64>, map_od: f64) -> f64 {
    let raw = od.unwrap_or(map_od);
    if raw.is_finite() {
        max(0.0, min(10.0, raw))
    } else {
        8.0
    }
}

impl PrismPrepared {
    pub fn new(
        notes: &[ManiaNote],
        key_count: i32,
        rate: f64,
        od: f64,
        model: &PrismModel,
        scale: &PrismScale,
        with_skillsets: bool,
    ) -> PrismPrepared {
        let chart = build_prism_chart(notes, key_count, rate, Some(od));
        let (centre_hand, sections) = pick_prism_hands(&chart, model);
        PrismPrepared {
            key_count,
            rate,
            od,
            centre_hand,
            time: sections.iter().map(|s| s.time_ms).collect(),
            weight: weights_of(&sections),
            overall: demands_of(&sections),
            skillsets: if with_skillsets {
                Some(SKILLSET_SOURCES.iter().map(|&(_, source)| source.map(|k| skillset_demand(&sections, k))).collect())
            } else {
                None
            },
            model: *model,
            scale: *scale,
        }
    }

    pub fn within(&self, spans: &[(f64, f64)]) -> PrismPrepared {
        let mut keep: Vec<usize> = Vec::new();
        let mut j = 0usize;
        for (i, &t) in self.time.iter().enumerate() {
            let at = t * self.rate;
            while j < spans.len() && spans[j].1 <= at {
                j += 1;
            }
            if j < spans.len() && spans[j].0 <= at {
                keep.push(i);
            }
        }
        PrismPrepared {
            key_count: self.key_count,
            rate: self.rate,
            od: self.od,
            centre_hand: self.centre_hand,
            time: keep.iter().map(|&i| self.time[i]).collect(),
            weight: keep.iter().map(|&i| self.weight[i]).collect(),
            overall: keep.iter().map(|&i| self.overall[i]).collect(),
            skillsets: None,
            model: self.model,
            scale: self.scale,
        }
    }

    fn values_at(&self, goal: f64) -> Vec<(&'static str, f64)> {
        let ge = self.model.goal_exponent;
        let overall = prism_rating_of_strain(prism_strain_at_goal(&self.overall, &self.weight, goal, ge), &self.scale);
        let mut values = vec![("Overall", overall)];
        if let Some(skillsets) = &self.skillsets {
            let raw: Vec<f64> = skillsets
                .iter()
                .map(|demand| demand.as_ref().map_or(0.0, |d| prism_strain_at_goal(d, &self.weight, goal, ge)))
                .collect();
            let top = max_of(&raw);
            for (i, &(slot, _)) in SKILLSET_SOURCES.iter().enumerate() {
                values.push((slot, if top > 0.0 { overall * (raw[i] / top) } else { 0.0 }));
            }
            for &(slot, single, chord) in MERGED.iter() {
                let a = values.iter().find(|(k, _)| *k == single).unwrap().1;
                let b = values.iter().find(|(k, _)| *k == chord).unwrap().1;
                values.push((slot, max(a, b)));
            }
        }
        values
    }

    pub fn rate(&self, goal: Option<f64>) -> PrismResult {
        let goal = min(
            0.9999,
            max(
                0.1,
                match goal {
                    Some(g) if g.is_finite() => g,
                    _ => PRISM_BASE_GOAL,
                },
            ),
        );
        let solved = if goal < PRISM_BASE_GOAL {
            max(0.1, PRISM_BASE_GOAL - (PRISM_BASE_GOAL - goal) * PRISM_UNDER_BASE_STRETCH)
        } else {
            goal
        };
        let mut values = self.values_at(min(solved, PRISM_MAX_GOAL));
        if goal > PRISM_MAX_GOAL {
            let base = self.values_at(PRISM_BASE_GOAL);
            let exponent = (goal - PRISM_MAX_GOAL) / (PRISM_MAX_GOAL - PRISM_BASE_GOAL);
            for (i, entry) in values.iter_mut().enumerate() {
                let at_cap = entry.1;
                let at_base = base[i].1;
                entry.1 = if at_cap > 0.0 && at_base > 0.0 && at_cap > at_base {
                    at_cap * pow(min(at_cap / at_base, PRISM_EXTRAPOLATION_MAX_SLOPE), exponent)
                } else {
                    at_cap
                };
            }
        }
        PrismResult {
            version: PRISM_CALC_VERSION,
            key_count: self.key_count,
            rate: self.rate,
            goal,
            values,
            centre_hand: self.centre_hand,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ModelSlot {
    Press = 0,
    Ln = 1,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct PrepKey {
    key_count: i32,
    rate: u64,
    od: u64,
    len: usize,
    a: u32,
    b: u32,
}

fn number_key(x: f64) -> u64 {
    if x == 0.0 {
        0
    } else {
        x.to_bits()
    }
}

fn notes_key(notes: &[ManiaNote], key_count: i32, rate: f64, od: f64) -> PrepKey {
    use jsmath::{round, to_int32};
    let mut a: u32 = 0x811c9dc5;
    let mut b: i64 = (0x01000193i32 ^ to_int32(notes.len() as f64)) as i64;
    let mut mix = |value: f64| {
        a = (to_int32(a as f64) ^ to_int32(value)).wrapping_mul(0x01000193) as u32;
        let x = to_int32(b as f64) ^ to_int32(value + 2654435769.0);
        b = x.wrapping_mul(0x85ebca6bu32 as i32) as u32 as i64;
    };
    for note in notes {
        mix(round(note.time * 8.0));
        mix(note.column as f64);
        mix(if note.is_hold { round(note.end_time * 8.0) } else { -1.0 });
    }
    PrepKey { key_count, rate: number_key(rate), od: number_key(od), len: notes.len(), a, b: b as u32 }
}

const PREPARED_KEPT: usize = 32;

thread_local! {
    static PREPARED: std::cell::RefCell<[Vec<(PrepKey, std::rc::Rc<PrismPrepared>)>; 2]> =
        std::cell::RefCell::new([Vec::new(), Vec::new()]);
}

pub fn clear_prism_cache() {
    PREPARED.with(|p| {
        let mut p = p.borrow_mut();
        p[0].clear();
        p[1].clear();
    });
}

fn prepare_cached(
    notes: &[ManiaNote],
    key_count: i32,
    rate: f64,
    od: f64,
    slot: ModelSlot,
    model: &PrismModel,
    scale: &PrismScale,
    with_skillsets: bool,
) -> std::rc::Rc<PrismPrepared> {
    let key = notes_key(notes, key_count, rate, od);
    let hit = PREPARED.with(|p| {
        let mut p = p.borrow_mut();
        let kept = &mut p[slot as usize];
        let i = kept.iter().position(|(k, _)| *k == key)?;
        if kept[i].1.skillsets.is_some() || !with_skillsets {
            let entry = kept.remove(i);
            let ready = entry.1.clone();
            kept.push(entry);
            Some(ready)
        } else {
            None
        }
    });
    if let Some(ready) = hit {
        return ready;
    }
    let ready = std::rc::Rc::new(PrismPrepared::new(notes, key_count, rate, od, model, scale, with_skillsets));
    PREPARED.with(|p| {
        let mut p = p.borrow_mut();
        let kept = &mut p[slot as usize];
        match kept.iter_mut().find(|(k, _)| *k == key) {
            Some(entry) => entry.1 = ready.clone(),
            None => kept.push((key, ready.clone())),
        }
        if kept.len() > PREPARED_KEPT {
            kept.remove(0);
        }
    });
    ready
}

fn rate_with(
    notes: &[ManiaNote],
    key_count: i32,
    map_od: f64,
    options: &PrismOptions,
    slot: ModelSlot,
    model: &PrismModel,
    scale: &PrismScale,
    spans: Option<&[(f64, f64)]>,
) -> Option<PrismResult> {
    if !is_prism_key_count(key_count) {
        return None;
    }
    let rate = prism_rate(options.rate);
    let od = prism_od(options.od, map_od);
    match spans {
        Some(spans) => Some(prepare_cached(notes, key_count, rate, od, slot, model, scale, false).within(spans).rate(options.goal)),
        None => Some(prepare_cached(notes, key_count, rate, od, slot, model, scale, !options.overall_only).rate(options.goal)),
    }
}

pub fn analyze_prism(notes: &[ManiaNote], key_count: i32, od: f64, options: &PrismOptions) -> Option<PrismResult> {
    let model = prism_models(key_count)?;
    rate_with(notes, key_count, od, options, ModelSlot::Press, &model.press, &model.scale, None)
}

pub fn analyze_prism_ln(notes: &[ManiaNote], key_count: i32, od: f64, options: &PrismOptions) -> Option<f64> {
    analyze_prism_ln_within(notes, key_count, od, options, None)
}

pub fn analyze_prism_ln_within(notes: &[ManiaNote], key_count: i32, od: f64, options: &PrismOptions, spans: Option<&[(f64, f64)]>) -> Option<f64> {
    let model = prism_models(key_count)?;
    let options = PrismOptions { overall_only: true, ..*options };
    rate_with(notes, key_count, od, &options, ModelSlot::Ln, &model.ln, &model.ln_scale, spans).map(|r| r.overall())
}

pub fn prepare_prism(
    notes: &[ManiaNote],
    key_count: i32,
    rate: Option<f64>,
    od: Option<f64>,
    map_od: f64,
    ln: bool,
    with_skillsets: bool,
) -> Option<PrismPrepared> {
    let model = prism_models(key_count)?;
    let (m, s) = if ln { (model.ln, model.ln_scale) } else { (model.press, model.scale) };
    Some(PrismPrepared::new(notes, key_count, prism_rate(rate), prism_od(od, map_od), &m, &s, with_skillsets && !ln))
}

pub fn prism_engine_version() -> String {
    format!("prism-v{PRISM_CALC_VERSION}")
}

pub fn chart_notes(map: &chart_parser::ManiaBeatmap) -> Vec<ManiaNote> {
    map.notes
        .iter()
        .map(|n| ManiaNote { column: n.column, time: n.time, end_time: n.end_time, is_hold: n.is_hold })
        .collect()
}

pub fn analyze_prism_from_text(osu_text: &str, options: &PrismOptions) -> Option<PrismResult> {
    let map = chart_parser::parse_mania_beatmap(osu_text);
    analyze_prism(&chart_notes(&map), map.key_count, map.od, options)
}
