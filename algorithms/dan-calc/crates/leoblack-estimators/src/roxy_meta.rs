#[path = "generated/roxy_meta.rs"]
mod generated;
pub use generated::*;

use crate::common::clamp;

pub const FEATURE_COUNT: usize = ROXY_META_FEATURE_NAMES.len();

fn degenerate_index() -> usize {
    ROXY_META_FEATURE_NAMES.iter().position(|n| *n == "corr_lowCj").unwrap()
}

pub fn evaluate_roxy_meta_model(features: &[f64]) -> f64 {
    if features.len() != FEATURE_COUNT {
        return f64::NAN;
    }
    let degenerate = degenerate_index();
    let mut value = ROXY_META_BETA[0];
    for i in 0..FEATURE_COUNT {
        let s = ROXY_META_SCALE[i];
        let scale = if s == 0.0 || s.is_nan() { 1.0 } else { s };
        let mut z = (features[i] - ROXY_META_MEAN[i]) / scale;
        if i == degenerate {
            let off_z = (ROXY_META_MEAN[i] / scale).abs();
            z = clamp(z, -off_z, off_z);
        }
        value += ROXY_META_BETA[i + 1] * z;
    }
    clamp(value, -2.0, 30.0)
}

pub fn feature_index(name: &str) -> Option<usize> {
    ROXY_META_FEATURE_NAMES.iter().position(|n| *n == name)
}
