use crate::params::is_prism_key_count;

pub const PRISM_LN_LEAD_SHARE: f64 = 0.85;
pub const PRISM_LN_LEAD_FROM_HOLDS: f64 = 0.375;
pub const PRISM_LN_LEAD_FULL_HOLDS: f64 = 0.9;

pub fn prism_ln_lead_weight(hold_ratio: f64) -> f64 {
    let weight = (hold_ratio - PRISM_LN_LEAD_FROM_HOLDS) / (PRISM_LN_LEAD_FULL_HOLDS - PRISM_LN_LEAD_FROM_HOLDS);
    if weight > 0.0 {
        weight.min(1.0)
    } else {
        0.0
    }
}

pub fn prism_ln_lead_target(key_count: i32, overall: f64, ln: f64, hold_ratio: f64) -> Option<f64> {
    if !is_prism_key_count(key_count) || !(ln > 0.0) {
        return None;
    }
    let weight = prism_ln_lead_weight(hold_ratio);
    if weight <= 0.0 {
        return None;
    }
    let lead = ln * PRISM_LN_LEAD_SHARE;
    Some(if weight >= 1.0 { lead } else { (1.0 - weight) * overall + weight * lead })
}

pub fn prism_skillsets_at(values: &mut [(String, f64)], target: f64) {
    let mut top = 0.0;
    for (name, value) in values.iter() {
        if name != "Overall" && name != "LN" && *value > top {
            top = *value;
        }
    }
    if !(top > 0.0) || !(target > 0.0) {
        return;
    }
    let scale = target / top;
    for (name, value) in values.iter_mut() {
        if name != "Overall" && name != "LN" {
            *value *= scale;
        }
    }
}

pub fn prism_ln_lead_values(key_count: i32, values: &mut [(String, f64)], ln: f64, hold_ratio: f64) {
    let overall = values.iter().find(|(k, _)| k == "Overall").map_or(f64::NAN, |(_, v)| *v);
    if let Some(target) = prism_ln_lead_target(key_count, overall, ln, hold_ratio) {
        prism_skillsets_at(values, target);
    }
}
