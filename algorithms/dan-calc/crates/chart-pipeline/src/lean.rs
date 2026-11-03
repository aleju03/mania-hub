use dan_core::ln_effective::{LN_EFFECTIVE_MODEL_VERSION, LN_MIN_WORK_SHARE};
use dan_core::motion_features::MotionFeatures;
use dan_core::rice_shape::RiceShape;
use dan_core::types::{DanFeatureMetrics, ManiaPatternHit};

use crate::classifier::{ChartClassification, DanVerdictHalf, Unported};
use crate::hybrid::{rate_hybrid_ln_sections, HybridLnSectionsReading, HYBRID_LN_SECTIONS_VERSION};
use crate::json::{num, opt_num, opt_str, str, Js, Obj};
use crate::msd::vibro_analysis_js;

const HYBRID_HOLD_SHARE_MIN: f64 = 0.25;
const HYBRID_HOLD_SHARE_MAX: f64 = 0.75;
const HYBRID_LN_CREDIT_MIN_HOLD_SHARE: f64 = 0.35;

#[derive(Clone, Debug, PartialEq)]
pub struct LeanCluster {
    pub label: String,
    pub pattern: &'static str,
    pub bpm: f64,
    pub mixed: bool,
    pub amount: f64,
    pub importance: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct JackDemand {
    pub detected: bool,
    pub reasons: Vec<&'static str>,
}

pub struct Lean {
    pub note_bpm: Option<f64>,
    pub motion: Option<MotionFeatures>,
    pub rice_shape: Option<RiceShape>,
    pub classification: ChartClassification,
    pub jack_demand: JackDemand,
    pub clusters: Vec<LeanCluster>,
    pub ln_sections: Option<HybridLnSectionsReading>,
}

pub fn lean_classification(classification: ChartClassification, note_bpm: Option<f64>, motion: Option<MotionFeatures>, rice_shape: Option<RiceShape>) -> Lean {
    let clusters: Vec<LeanCluster> = classification
        .analysis
        .clusters
        .as_ref()
        .map(|report| {
            report
                .top_five_clusters()
                .iter()
                .map(|c| LeanCluster {
                    label: c.format(1.0),
                    pattern: c.pattern.as_str(),
                    bpm: c.bpm,
                    mixed: c.mixed,
                    amount: c.amount,
                    importance: c.importance(),
                })
                .collect()
        })
        .unwrap_or_default();
    let patterns = &classification.analysis.patterns;
    let jack_demand = classify_four_key_jack_demand(classification.key_count, &patterns.metrics, &patterns.all_patterns, &clusters);
    Lean { note_bpm, motion, rice_shape, classification, jack_demand, clusters, ln_sections: None }
}

fn half_js(half: &Option<DanVerdictHalf>) -> Js {
    match half {
        None => Js::Null,
        Some(h) => Obj::new()
            .with("kind", str(h.kind))
            .with("source", str(h.source))
            .with("label", str(&h.label))
            .with("variant", opt_str(h.variant))
            .with("displayName", str(&h.display_name))
            .with("rawDan", num(h.raw_dan))
            .with("estimatedSr", num(h.estimated_sr))
            .with("confidence", num(h.confidence))
            .into(),
    }
}

fn motion_js(m: &MotionFeatures) -> Js {
    Obj::new()
        .with("sameHand", num(m.same_hand))
        .with("miniJack", num(m.mini_jack))
        .with("anchor", num(m.anchor))
        .with("oneHandTrill", num(m.one_hand_trill))
        .with("crossHandTrill", num(m.cross_hand_trill))
        .with("roll4", num(m.roll4))
        .with("rhythmBreak", num(m.rhythm_break))
        .with("chordSwing", num(m.chord_swing))
        .with("densitySwing", num(m.density_swing))
        .into()
}

impl Lean {
    pub fn primary(&self) -> Option<&DanVerdictHalf> {
        self.classification.primary.as_ref()
    }

    pub fn to_js(&self) -> Js {
        let c = &self.classification;
        let a = &c.analysis;
        let mut o = Obj::new().with("noteBpm", opt_num(self.note_bpm));
        if let Some(m) = &self.motion {
            o.set("motion", motion_js(m));
        }
        if let Some(s) = &self.rice_shape {
            o.set("riceShape", Obj::new().with("twoBack", num(s.two_back)).with("techSections", num(s.tech_sections)).with("motifRepeat", num(s.motif_repeat)).with("speedPeak", num(s.speed_peak)).with("rollSections", num(s.roll_sections)).into());
        }
        o.set("keyCount", num(c.key_count as f64));
        o.set("supported", Js::Bool(c.supported));
        o.set("lnRatio", num(c.ln_ratio));
        if c.key_count == 4 {
            o.set("lnSkillsetVersion", num(ln_skill::LN_SKILL_VERSION as f64));
        }
        if let Some(e) = c.ln_effective_ratio {
            o.set("lnEffectiveRatio", num(e));
            o.set("lnEffectiveVersion", num(LN_EFFECTIVE_MODEL_VERSION));
        }
        if let Some(w) = c.ln_work_share {
            o.set("lnWorkShare", num(w));
        }
        if let Some(r) = c.ln_rice_share {
            o.set("lnRiceShare", num(r));
        }
        if c.ln_rating_identity {
            o.set("lnRatingIdentity", Js::Bool(true));
            o.set("lnStructuralRatio", c.ln_structural_ratio.map_or(Js::Undefined, num));
        }
        o.set("sunnySr", opt_num(c.sunny_sr));
        o.set("vibro", Js::Bool(a.vibro));
        if let Some(v) = &a.vibro_analysis {
            o.set("vibroAnalysis", vibro_analysis_js(v));
        }
        let e = &a.dan_eligibility;
        o.set(
            "danEligibility",
            Obj::new()
                .with("eligible", Js::Bool(e.eligible))
                .with("reason", opt_str(e.reason))
                .with("maxSameColumnHeadStack", num(e.max_same_column_head_stack))
                .with("redundantSameColumnHeads", num(e.redundant_same_column_heads))
                .into(),
        );
        o.set("verdictText", opt_str(c.verdict_text.as_deref()));
        o.set("rc", half_js(&c.rc));
        o.set("ln", half_js(&c.ln));
        o.set("primary", half_js(&c.primary));
        o.set("category", opt_str(a.patterns.primary.as_ref().map(|p| p.label)));
        o.set(
            "jackDemand",
            Obj::new()
                .with("version", num(1.0))
                .with("detected", Js::Bool(self.jack_demand.detected))
                .with("reasons", Js::Arr(self.jack_demand.reasons.iter().map(|r| str(r)).collect()))
                .into(),
        );
        o.set(
            "patterns",
            Js::Arr(
                a.patterns
                    .patterns
                    .iter()
                    .map(|h| {
                        Obj::new()
                            .with("id", str(h.id.as_str()))
                            .with("label", str(h.label))
                            .with("score", num(h.score))
                            .with("confidence", num(h.confidence))
                            .into()
                    })
                    .collect(),
            ),
        );
        o.set(
            "clusters",
            Js::Arr(
                self.clusters
                    .iter()
                    .map(|c| {
                        Obj::new()
                            .with("label", str(&c.label))
                            .with("pattern", str(c.pattern))
                            .with("bpm", num(c.bpm))
                            .with("mixed", Js::Bool(c.mixed))
                            .with("amount", num(c.amount))
                            .with("importance", num(c.importance))
                            .into()
                    })
                    .collect(),
            ),
        );
        o.set("clusterCategory", opt_str(a.clusters.as_ref().map(|r| r.category.as_str())));
        o.set("modeTag", opt_str(a.clusters.as_ref().map(|r| r.mode_tag.as_str())));
        o.set("warnings", Js::Arr(c.warnings.iter().map(|w| str(w)).collect()));
        if let Some(s) = &self.ln_sections {
            o.set(
                "lnSections",
                Obj::new()
                    .with("version", num(HYBRID_LN_SECTIONS_VERSION))
                    .with("rawDan", num(s.raw_dan))
                    .with("label", str(&s.label))
                    .with("noteShare", num(s.note_share))
                    .into(),
            );
        }
        o.into()
    }

    pub fn is_hybrid(&self) -> bool {
        let c = &self.classification;
        is_hybrid_chart(c.key_count, Some(c.ln_ratio), c.ln_rice_share, c.ln_work_share)
    }

    pub fn secondary(&self) -> Option<(String, &'static str, f64)> {
        let c = &self.classification;
        let primary = c.primary.as_ref()?;
        if !self.is_hybrid() {
            return None;
        }
        let other = if primary.kind == "ln" { c.rc.as_ref() } else { c.ln.as_ref() }?;
        if !other.raw_dan.is_finite() || other.display_name.is_empty() {
            return None;
        }
        Some((other.display_name.clone(), if other.kind == "ln" { "ln" } else { "dan" }, other.raw_dan))
    }

    pub fn rate_verdict_js(&self) -> Obj {
        let c = &self.classification;
        let primary = c.primary.as_ref();
        let mut o = Obj::new()
            .with("primaryLabel", opt_str(primary.map(|p| p.display_name.as_str())))
            .with("primaryFamily", opt_str(primary.map(|p| if p.kind == "ln" { "ln" } else { "dan" })))
            .with("rawDan", opt_num(primary.map(|p| p.raw_dan)))
            .with("lnEffectiveRatio", c.ln_effective_ratio.map_or(Js::Undefined, num))
            .with("lnEffectiveVersion", if c.ln_effective_ratio.is_some() { num(LN_EFFECTIVE_MODEL_VERSION) } else { Js::Undefined });
        if let Some(w) = c.ln_work_share {
            o.set("lnWorkShare", num(w));
        }
        if let Some(r) = c.ln_rice_share {
            o.set("lnRiceShare", num(r));
        }
        if c.ln_rating_identity {
            o.set("lnRatingIdentity", Js::Bool(true));
            o.set("lnStructuralRatio", c.ln_structural_ratio.map_or(Js::Undefined, num));
        }
        if let Some((label, family, raw_dan)) = self.secondary() {
            o.set("secondary", Obj::new().with("label", str(&label)).with("family", str(family)).with("rawDan", num(raw_dan)).into());
        }
        o
    }
}

pub fn is_hybrid_chart(key_count: i32, ln_ratio: Option<f64>, ln_rice_share: Option<f64>, ln_work_share: Option<f64>) -> bool {
    if key_count != 4 {
        return false;
    }
    let ln_ratio = ln_ratio.unwrap_or(f64::NAN);
    if !ln_ratio.is_finite() || ln_ratio < HYBRID_HOLD_SHARE_MIN || ln_ratio > HYBRID_HOLD_SHARE_MAX {
        return false;
    }
    let rice = ln_rice_share.unwrap_or(f64::NAN);
    if !rice.is_finite() || rice < HYBRID_HOLD_SHARE_MIN {
        return false;
    }
    if let Some(w) = ln_work_share {
        if w.is_finite() && w < LN_MIN_WORK_SHARE {
            return false;
        }
    }
    true
}

pub fn hybrid_ln_sections_for(lean: &Lean, osu_text: &str) -> Result<Option<HybridLnSectionsReading>, Unported> {
    if lean.primary().map(|p| p.kind) != Some("rc") || !lean.is_hybrid() || !(lean.classification.ln_ratio >= HYBRID_LN_CREDIT_MIN_HOLD_SHARE) {
        return Ok(None);
    }
    rate_hybrid_ln_sections(osu_text)
}

const DENSE_CHORD_RATIO_MIN: f64 = 0.70;
const DENSE_CHORD_OVERLAP_MIN: f64 = 0.58;
const TWO_BACK_REHIT_EXCESS_MIN: f64 = 0.30;
const JACKABLE_MAX_CLUSTER_BPM: f64 = 230.0;
const JACK_CLUSTER_SHARE_MIN: f64 = 0.60;
const JACK_CLUSTER_CORROBORATED_SHARE_MIN: f64 = 0.25;
const JACK_CLUSTER_CORROBORATED_CHORDJACK_MIN: f64 = 0.5;
const JACK_CLUSTER_CORROBORATED_PRESSURE_MIN: f64 = 150.0;
const JACK_CLUSTER_PATTERN: &str = "Jacks";
const MARATHON_DURATION_MIN_MS: f64 = 240_000.0;
const MARATHON_JACK_SCORE_MIN: f64 = 0.75;
const MARATHON_JACK_PRESSURE_MIN: f64 = 175.0;
const MARATHON_CHORD_RATIO_MIN: f64 = 0.45;
const MARATHON_CHORD_OVERLAP_MIN: f64 = 0.55;

fn pattern_score(patterns: &[ManiaPatternHit], id: &str) -> f64 {
    let mut score = 0.0;
    for p in patterns {
        if p.id.as_str() != id {
            continue;
        }
        if p.score.is_finite() {
            score = jsmath::max(score, p.score);
        }
    }
    score
}

fn jack_cluster_importance_share(clusters: &[LeanCluster]) -> f64 {
    let mut total = 0.0;
    let mut jack = 0.0;
    for c in clusters {
        let importance = c.importance;
        if !importance.is_finite() || importance <= 0.0 {
            continue;
        }
        total += importance;
        let bpm = c.bpm;
        if !bpm.is_finite() || bpm <= 0.0 || bpm > JACKABLE_MAX_CLUSTER_BPM {
            continue;
        }
        if c.pattern == JACK_CLUSTER_PATTERN {
            jack += importance;
        }
    }
    if total > 0.0 {
        jack / total
    } else {
        0.0
    }
}

fn weighted_mean_cluster_bpm(clusters: &[LeanCluster]) -> Option<f64> {
    let mut weight = 0.0;
    let mut weighted = 0.0;
    for c in clusters {
        let (importance, bpm) = (c.importance, c.bpm);
        if !importance.is_finite() || importance <= 0.0 {
            continue;
        }
        if !bpm.is_finite() || bpm <= 0.0 {
            continue;
        }
        weight += importance;
        weighted += importance * bpm;
    }
    if weight > 0.0 {
        Some(weighted / weight)
    } else {
        None
    }
}

pub fn classify_four_key_jack_demand(
    key_count: i32,
    metrics: &DanFeatureMetrics,
    patterns: &[ManiaPatternHit],
    clusters: &[LeanCluster],
) -> JackDemand {
    if key_count != 4 {
        return JackDemand { detected: false, reasons: Vec::new() };
    }
    let m = metrics;
    let mut reasons = Vec::new();
    if m.chord_ratio >= DENSE_CHORD_RATIO_MIN
        && m.chord_column_overlap_ratio >= DENSE_CHORD_OVERLAP_MIN
        && m.two_back_column_rehit_excess >= TWO_BACK_REHIT_EXCESS_MIN
    {
        reasons.push("dense_alternating_chords");
    }
    let mean_bpm = weighted_mean_cluster_bpm(clusters);
    let jackable = mean_bpm.map_or(true, |b| b <= JACKABLE_MAX_CLUSTER_BPM);
    let share = jack_cluster_importance_share(clusters);
    let dominant = jackable && mean_bpm.is_some() && share >= JACK_CLUSTER_SHARE_MIN;
    if dominant {
        reasons.push("jack_cluster_dominant");
    }
    let corroborated = !dominant
        && jackable
        && mean_bpm.is_some()
        && share >= JACK_CLUSTER_CORROBORATED_SHARE_MIN
        && pattern_score(patterns, "chordjack") >= JACK_CLUSTER_CORROBORATED_CHORDJACK_MIN
        && m.jack_pressure >= JACK_CLUSTER_CORROBORATED_PRESSURE_MIN;
    if corroborated {
        reasons.push("jack_cluster_corroborated");
    }
    let marathon = jackable
        && m.duration_ms >= MARATHON_DURATION_MIN_MS
        && pattern_score(patterns, "jack") >= MARATHON_JACK_SCORE_MIN
        && m.jack_pressure >= MARATHON_JACK_PRESSURE_MIN
        && m.chord_ratio >= MARATHON_CHORD_RATIO_MIN
        && m.chord_column_overlap_ratio >= MARATHON_CHORD_OVERLAP_MIN;
    if marathon {
        reasons.push("jack_marathon");
    }
    JackDemand { detected: !reasons.is_empty(), reasons }
}
