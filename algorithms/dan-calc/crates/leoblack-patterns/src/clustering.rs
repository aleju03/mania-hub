use std::collections::HashMap;

use crate::config::*;
use crate::defs::{resolve_rating_multiplier, CorePattern, Specific};
use crate::find::FoundPattern;

#[derive(Clone, Debug, PartialEq)]
pub struct Cluster {
    pub pattern: CorePattern,
    pub specific_types: Vec<(Specific, f64)>,
    pub rating_multiplier: f64,
    pub bpm: f64,
    pub mixed: bool,
    pub amount: f64,
}

impl Cluster {
    #[inline]
    pub fn importance(&self) -> f64 {
        self.amount * self.rating_multiplier * self.bpm
    }

    pub fn name(&self) -> &'static str {
        match self.specific_types.first() {
            Some(&(s, ratio)) if ratio >= CLUSTER_SPECIFIC_NAME_MIN_RATIO => s.as_str(),
            _ => self.pattern.as_str(),
        }
    }

    pub fn format(&self, rate: f64) -> String {
        let bpm = jsmath::number_to_string(jsmath::round(self.bpm * rate));
        if self.mixed {
            format!("~{}BPM Mixed {}", bpm, self.name())
        } else {
            format!("{}BPM {}", bpm, self.name())
        }
    }
}

fn patterns_amount(sorted_starts_ends: &[(f64, f64)]) -> f64 {
    let mut total_time = 0.0;
    let (mut current_start, mut current_end) = sorted_starts_ends[0];
    for &(start, end) in sorted_starts_ends {
        if current_end < end {
            total_time += current_end - current_start;
            current_start = start;
            current_end = end;
        } else {
            current_end = jsmath::max(current_end, end);
        }
    }
    total_time += current_end - current_start;
    total_time
}

#[inline]
fn is_timed_mspb(value: f64) -> bool {
    value >= CLUSTER_TIMED_MIN_MSPB
}

struct ClusterBuilder {
    sum_ms: f64,
    timed_count: u32,
    original_ms_per_beat: f64,
    bpm: f64,
}

impl ClusterBuilder {
    fn new(value: f64) -> Self {
        let timed = is_timed_mspb(value);
        Self { sum_ms: if timed { value } else { 0.0 }, timed_count: timed as u32, original_ms_per_beat: value, bpm: f64::NAN }
    }

    fn add(&mut self, v: f64) {
        if is_timed_mspb(v) {
            self.sum_ms += v;
            self.timed_count += 1;
        }
    }

    fn calculate(&mut self) {
        self.bpm = if self.timed_count == 0 {
            0.0
        } else {
            jsmath::round(60000.0 / (self.sum_ms / self.timed_count as f64))
        };
    }
}

fn assign_clusters(patterns: &[FoundPattern]) -> (Vec<usize>, Vec<ClusterBuilder>) {
    let mut builders: Vec<ClusterBuilder> = Vec::new();
    let mut non_mixed: Vec<usize> = Vec::new();
    let mut mixed: [Option<usize>; 6] = [None; 6];
    let mut assignment = Vec::with_capacity(patterns.len());

    for p in patterns {
        let idx = if p.mixed {
            let slot = &mut mixed[p.pattern as usize];
            match *slot {
                Some(i) => {
                    builders[i].add(p.ms_per_beat);
                    i
                }
                None => {
                    builders.push(ClusterBuilder::new(p.ms_per_beat));
                    *slot = Some(builders.len() - 1);
                    builders.len() - 1
                }
            }
        } else {
            let mut found = None;
            for &i in &non_mixed {
                if (builders[i].original_ms_per_beat - p.ms_per_beat).abs() < BPM_CLUSTER_THRESHOLD {
                    found = Some(i);
                    break;
                }
            }
            match found {
                Some(i) => {
                    builders[i].add(p.ms_per_beat);
                    i
                }
                None => {
                    builders.push(ClusterBuilder::new(p.ms_per_beat));
                    non_mixed.push(builders.len() - 1);
                    builders.len() - 1
                }
            }
        };
        assignment.push(idx);
    }

    for b in &mut builders {
        b.calculate();
    }
    (assignment, builders)
}

struct Group {
    pattern: CorePattern,
    mixed: bool,
    bpm: f64,
    members: Vec<usize>,
}

pub fn calculate_clustered_patterns(patterns: &[FoundPattern], mode_tag: ModeTag) -> Vec<Cluster> {
    let (assignment, builders) = assign_clusters(patterns);

    let mut groups: Vec<Group> = Vec::new();
    let mut index: HashMap<(CorePattern, bool, u64), usize> = HashMap::new();
    for (i, p) in patterns.iter().enumerate() {
        let bpm = builders[assignment[i]].bpm;
        let key = (p.pattern, p.mixed, (bpm + 0.0).to_bits());
        let g = *index.entry(key).or_insert_with(|| {
            groups.push(Group { pattern: p.pattern, mixed: p.mixed, bpm, members: Vec::new() });
            groups.len() - 1
        });
        groups[g].members.push(i);
    }

    let mut out = Vec::with_capacity(groups.len());
    for group in &groups {
        let mut starts_ends: Vec<(f64, f64)> = group.members.iter().map(|&i| (patterns[i].start, patterns[i].end)).collect();
        starts_ends.sort_by(|a, b| js_cmp(a.0 - b.0));

        let data_count = group.members.len() as f64;
        let mut counter: Vec<(Specific, u32)> = Vec::new();
        for &i in &group.members {
            if let Some(s) = patterns[i].specific_type {
                match counter.iter_mut().find(|(name, _)| *name == s) {
                    Some(entry) => entry.1 += 1,
                    None => counter.push((s, 1)),
                }
            }
        }
        let mut specific_types: Vec<(Specific, f64)> =
            counter.into_iter().map(|(name, count)| (name, count as f64 / data_count)).collect();
        specific_types.sort_by(|a, b| js_cmp(b.1 - a.1));

        let dominant = specific_types.first().map(|&(s, _)| s);
        let amount = if starts_ends.is_empty() { 0.0 } else { patterns_amount(&starts_ends) };

        out.push(Cluster {
            pattern: group.pattern,
            specific_types,
            rating_multiplier: resolve_rating_multiplier(group.pattern, dominant, mode_tag),
            bpm: group.bpm,
            mixed: group.mixed,
            amount,
        });
    }

    let has_dw = out.iter().any(|c| c.pattern == CorePattern::Density || c.pattern == CorePattern::Wildcard);
    if has_dw && RELEASE_WITH_DW_MULTIPLIER != 1.0 {
        for c in &mut out {
            if c.specific_types.iter().any(|&(name, ratio)| name == Specific::Release && ratio > 0.0) {
                c.rating_multiplier *= RELEASE_WITH_DW_MULTIPLIER;
            }
        }
    }

    out
}

#[inline]
pub(crate) fn js_cmp(diff: f64) -> std::cmp::Ordering {
    if diff < 0.0 {
        std::cmp::Ordering::Less
    } else if diff > 0.0 {
        std::cmp::Ordering::Greater
    } else {
        std::cmp::Ordering::Equal
    }
}
