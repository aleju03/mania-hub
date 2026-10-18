pub const LN_AXIS_KEY_COUNTS: &[i32] = if prism::PRISM_ENABLED { &[4, 6, 7, 8] } else { &[4] };

pub fn has_ln_axis(key_count: Option<i32>) -> bool {
    key_count.map_or(false, |k| LN_AXIS_KEY_COUNTS.contains(&k))
}
