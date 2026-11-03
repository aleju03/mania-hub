use crate::chart::{Chart, NoteType};
use crate::clustering::{calculate_clustered_patterns, js_cmp, Cluster};
use crate::config::*;
use crate::defs::{CorePattern, Specific, CORE_PATTERN_LIST};
use crate::find::find;
use crate::primitives::{ln_percent, sv_time};

#[derive(Clone, Debug, PartialEq)]
pub struct PatternReport {
    pub clusters: Vec<Cluster>,
    pub category: String,
    pub ln_percent: f64,
    pub hb_row_ratio: f64,
    pub mode_tag: ModeTag,
    pub sv_amount: f64,
    pub duration: f64,
}

impl PatternReport {
    pub fn important_clusters(&self) -> &[Cluster] {
        if self.clusters.is_empty() {
            return &[];
        }
        let importance = self.clusters[0].importance();
        let n = self
            .clusters
            .iter()
            .take_while(|c| c.importance() / importance > IMPORTANT_CLUSTER_RATIO)
            .count();
        &self.clusters[..n]
    }

    pub fn top_five_clusters(&self) -> &[Cluster] {
        &self.clusters[..self.clusters.len().min(5)]
    }
}

fn hb_row_ratio(chart: &Chart) -> f64 {
    let rows = &chart.notes;
    if rows.is_empty() {
        return 0.0;
    }
    let mut hb_rows = 0u64;
    for row in rows {
        let has_head = row.data.iter().any(|&n| n == NoteType::HoldHead);
        let has_normal = row.data.iter().any(|&n| n == NoteType::Normal);
        if has_head && has_normal {
            hb_rows += 1;
        }
    }
    hb_rows as f64 / rows.len() as f64
}

fn resolve_mode_tag(ln_ratio: f64, hb_ratio: f64) -> ModeTag {
    let tag = mode_tag_from_ln_ratio(ln_ratio);
    if tag != ModeTag::Mix {
        return tag;
    }
    if hb_ratio >= HB_ROW_RATIO_THRESHOLD {
        return ModeTag::Hb;
    }
    ModeTag::Mix
}

pub const CATEGORISE_UNDEFINED_ERROR: &str = "Cannot read properties of undefined (reading 'Mixed')";

pub fn categorise_chart(ordered_clusters: &[Cluster]) -> Result<String, String> {
    if ordered_clusters.is_empty() {
        return Ok("Uncategorised".to_string());
    }
    let first_importance = ordered_clusters[0].importance();
    let n_important = ordered_clusters
        .iter()
        .take_while(|c| c.importance() / first_importance > IMPORTANT_CLUSTER_RATIO)
        .count();
    if n_important == 0 {
        return Err(CATEGORISE_UNDEFINED_ERROR.to_string());
    }
    let cluster1 = &ordered_clusters[0];
    let tech = cluster1.mixed;

    let st = &cluster1.specific_types;
    let name: &str = if !st.is_empty() && st[0].1 > 0.05 {
        st[0].0.as_str()
    } else if st.len() >= 2 && st[0].0 == Specific::Jumpstream && st[1].0 == Specific::Handstream {
        let a1 = st[0].1;
        let a2 = st[1].1;
        if (a2 / a1) > CATEGORY_JS_HS_SECONDARY_RATIO {
            "Jumpstream/Handstream"
        } else {
            cluster1.pattern.as_str()
        }
    } else {
        cluster1.pattern.as_str()
    };

    Ok(format!("{}{}", name, if tech { " Tech" } else { "" }))
}

pub fn from_chart(chart: &Chart) -> Result<PatternReport, String> {
    let ln_ratio = ln_percent(chart);
    let hb_ratio = hb_row_ratio(chart);
    let mode_tag = resolve_mode_tag(ln_ratio, hb_ratio);

    let mut patterns = find(chart)?;
    if mode_tag == ModeTag::Rc {
        patterns.retain(|p| {
            !matches!(p.pattern, CorePattern::Coordination | CorePattern::Density | CorePattern::Wildcard)
        });
    }

    let mut clusters: Vec<Cluster> = calculate_clustered_patterns(&patterns, mode_tag)
        .into_iter()
        .filter(|c| c.bpm > 25.0 || c.bpm == 0.0)
        .collect();
    clusters.sort_by(|a, b| js_cmp(b.amount - a.amount));

    let can_be_pruned = |cluster: &Cluster| {
        clusters
            .iter()
            .any(|other| other.pattern == cluster.pattern && other.amount * 0.5 > cluster.amount && other.bpm > cluster.bpm)
    };
    let keep: Vec<bool> = clusters.iter().map(|c| !can_be_pruned(c)).collect();
    let filtered: Vec<&Cluster> = clusters.iter().zip(&keep).filter(|(_, &k)| k).map(|(c, _)| c).collect();

    let mut pruned: Vec<Cluster> = Vec::new();
    for pattern in CORE_PATTERN_LIST {
        pruned.extend(filtered.iter().filter(|c| c.pattern == pattern).take(3).map(|c| (*c).clone()));
    }
    pruned.sort_by(|a, b| js_cmp(b.importance() - a.importance()));

    let sv_amount = sv_time(chart);
    let category = categorise_chart(&pruned)?;

    Ok(PatternReport {
        clusters: pruned,
        category,
        ln_percent: ln_ratio,
        hb_row_ratio: hb_ratio,
        mode_tag,
        sv_amount,
        duration: chart.last_note() - chart.first_note(),
    })
}
