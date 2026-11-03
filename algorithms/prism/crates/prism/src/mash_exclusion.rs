use dan_core::vibro_sections::{VibroAnalysis, VibroReason, VibroSection, VibroStatus, VIBRO_SECTION_VERSION};
use dan_core::ManiaBeatmap;

use std::collections::HashMap;

use crate::mash::{prism_mash_routes, MASH_MAX_OD, MASH_ROUTE_EASIER};
use crate::params::{prism_models, PrismModel};
use crate::workload::{build_prism_chart, prism_sections, PrismChart, PrismSection, PRISM_SECTION_MS};
use crate::{mash_taken_by, prepare_cached, prism_mash_taken, prism_od, ModelSlot};

pub const MASH_EXCLUSION_SHARE: f64 = 0.5;
pub const MASH_CARRY_ACCURACY: f64 = 0.9;
pub const MASH_CARRY_COVERAGE: f64 = 0.9;
pub const FULL_CHORD_RUN: usize = 4;
pub const FULL_CHORD_RUN_SHARE: f64 = 0.5;

pub fn analyze_prism_mash(map: &ManiaBeatmap, rate: f64) -> Option<VibroAnalysis> {
    let model = prism_models(map.key_count)?;
    if map.notes.is_empty() || !rate.is_finite() || rate <= 0.0 {
        return None;
    }
    let od = prism_od(None, map.od);
    let chart = build_prism_chart(&map.notes, map.key_count, rate, Some(od));
    let ready = prepare_cached(&map.notes, map.key_count, rate, od, ModelSlot::Press, &model.press, &model.scale, false);
    let centre_hand = ready.centre_hand;
    let sections: Vec<PrismSection> = (0..ready.time.len())
        .map(|i| PrismSection { time_ms: ready.time[i], demand: ready.overall[i], work: ready.weight[i], mix: [0.0; 8] })
        .collect();
    if sections.is_empty() {
        return None;
    }
    let struck = prism_mash_taken(&chart, centre_hand, &sections, &model.press, true);
    let low_od = od < MASH_MAX_OD;
    let taken = if low_od { mash_taken_by(&sections, &model.press, &ready.routes) } else { vec![false; sections.len()] };
    let carried = if low_od { mash_carried(&chart, centre_hand, &sections, &model.press) } else { vec![false; sections.len()] };
    let mut hardest: Vec<(f64, usize)> = sections.iter().enumerate().map(|(i, s)| (s.demand, i)).collect();
    hardest.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal).then(a.1.cmp(&b.1)));
    hardest.truncate((sections.len() + 1) / 2);
    let mashed = hardest.iter().filter(|(_, i)| struck[*i] || taken[*i] || carried[*i]).count();
    if (mashed as f64) < MASH_EXCLUSION_SHARE * hardest.len() as f64 {
        return None;
    }
    let mut first = f64::INFINITY;
    let mut last = f64::NEG_INFINITY;
    for note in &map.notes {
        if note.time < first {
            first = note.time;
        }
        if note.time > last {
            last = note.time;
        }
    }
    let active_duration_ms = jsmath::max(0.0, last - first) / rate;
    Some(VibroAnalysis {
        version: VIBRO_SECTION_VERSION,
        status: VibroStatus::Excluded,
        sections: vec![VibroSection { start_time: first, end_time: last, reasons: vec![VibroReason::Mash] }],
        excluded_duration_ms: active_duration_ms,
        active_duration_ms,
        time_share: 1.0,
        note_share: 1.0,
        judgement_share: 1.0,
        remaining_notes: 0.0,
        repeat_share: 0.0,
        reason_shares: vec![(VibroReason::Mash, 1.0)],
    })
}

fn slot(t: f64) -> i64 {
    (t / PRISM_SECTION_MS).floor() as i64
}

fn keys_per_section(time: &[f64], press: &[u8]) -> HashMap<i64, f64> {
    let mut out = HashMap::new();
    for i in 0..time.len() {
        let keys = press[i].count_ones();
        if keys == 0 {
            continue;
        }
        *out.entry(slot(time[i])).or_insert(0.0) += keys as f64;
    }
    out
}

pub fn mash_carried(chart: &PrismChart, centre_hand: u8, sections: &[PrismSection], model: &PrismModel) -> Vec<bool> {
    let mut out = vec![false; sections.len()];
    let loss: Vec<(f64, f64)> = sections.iter().map(|s| (s.time_ms, 1.0)).collect();
    let notes = keys_per_section(&chart.time, &chart.press);
    for route in prism_mash_routes(chart, centre_hand, &loss, true) {
        let mut demand: HashMap<i64, f64> = HashMap::new();
        for s in prism_sections(&route.chart, centre_hand, model) {
            demand.insert(slot(s.time_ms), s.demand);
        }
        let struck = keys_per_section(&route.chart.time, &route.chart.press);
        for (i, s) in sections.iter().enumerate() {
            if out[i] {
                continue;
            }
            let at = slot(s.time_ms);
            let accuracy = if at >= 0 { route.accuracy.get(at as usize).copied().unwrap_or(0.0) } else { 0.0 };
            let mashed = demand.get(&at).copied().unwrap_or(f64::INFINITY);
            let keys = struck.get(&at).copied().unwrap_or(0.0);
            out[i] = accuracy >= MASH_CARRY_ACCURACY
                && mashed <= MASH_ROUTE_EASIER * s.demand
                && keys > 0.0
                && notes.get(&at).copied().unwrap_or(0.0) / keys >= MASH_CARRY_COVERAGE;
        }
    }
    let all: i32 = ((1i64 << chart.key_count) - 1) as i32;
    let mut row_time: Vec<f64> = Vec::new();
    let mut full: Vec<bool> = Vec::new();
    for i in 0..chart.time.len() {
        if chart.press[i] != 0 {
            row_time.push(chart.time[i]);
            full.push((chart.press[i] as i32 & all) == all);
        }
    }
    let mut in_run = vec![0u8; row_time.len()];
    let mut i = 0usize;
    while i < row_time.len() {
        let mut j = i;
        while j < row_time.len() && full[j] {
            j += 1;
        }
        if j - i >= FULL_CHORD_RUN {
            in_run[i..j].iter_mut().for_each(|x| *x = 1);
        }
        i = if j > i { j } else { i + 1 };
    }
    let mut run_rows: HashMap<i64, (f64, f64)> = HashMap::new();
    for (k, &t) in row_time.iter().enumerate() {
        let tally = run_rows.entry(slot(t)).or_insert((0.0, 0.0));
        tally.0 += in_run[k] as f64;
        tally.1 += 1.0;
    }
    for (i, s) in sections.iter().enumerate() {
        if let Some(tally) = run_rows.get(&slot(s.time_ms)) {
            if !out[i] && tally.0 >= FULL_CHORD_RUN_SHARE * tally.1 {
                out[i] = true;
            }
        }
    }
    out
}
