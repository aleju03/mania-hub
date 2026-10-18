pub const PRISM_CALC_VERSION: u32 = 25;

pub const PRISM_ENABLED: bool = true;

pub const PRISM_KEY_COUNTS: [i32; 3] = [6, 7, 8];

#[inline]
pub fn is_prism_key_count(key_count: i32) -> bool {
    (6..=8).contains(&key_count)
}

#[inline]
pub fn uses_prism(key_count: Option<i32>) -> bool {
    PRISM_ENABLED && key_count.map_or(false, is_prism_key_count)
}

pub const PRISM_BASE_GOAL: f64 = 0.965;
pub const PRISM_MAX_GOAL: f64 = 0.98;
pub const PRISM_GOAL_FLOOR: f64 = 0.9;
pub const PRISM_EXTRAPOLATION_MAX_SLOPE: f64 = 1.2;
pub const PRISM_UNDER_BASE_STRETCH: f64 = 1.5;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PrismModel {
    pub chord_units: f64,
    pub jack_units: f64,
    pub jack_window_ms: f64,
    pub grace_ms: f64,
    pub grace_discount: f64,
    pub speed_full_ms: f64,
    pub speed_none_ms: f64,
    pub hand_repeat: f64,
    pub independence_held_power: f64,
    pub held_body_full_ms: f64,
    pub release_long_units: f64,
    pub release_long_full_ms: f64,
    pub release_repress_ms: f64,
    pub release_repress_discount: f64,
    pub jack_after_hold_units: Option<f64>,
    pub od_power: f64,
    pub flam_units: f64,
    pub jack_chord_share: f64,
    pub roll_discount: f64,
    pub speed_power: f64,
    pub shape_units: f64,
    pub bracket_units: f64,
    pub centre_units: f64,
    pub independence_units: f64,
    pub release_units: f64,
    pub half_life_ms: f64,
    pub sustain_ratio: f64,
    pub sustain_weight: f64,
    pub stamina_half_life_ms: f64,
    pub stamina_weight: f64,
    pub hand_share: f64,
    pub goal_exponent: f64,
}

pub const PRESS: PrismModel = PrismModel {
    chord_units: 0.0097,
    jack_units: 2.857,
    jack_window_ms: 180.0,
    jack_chord_share: 0.078,
    grace_ms: 22.54,
    grace_discount: 0.1933,
    roll_discount: 0.4458,
    speed_power: 0.098,
    shape_units: 0.3483,
    bracket_units: 0.5,
    centre_units: 0.3794,
    independence_units: 0.495,
    independence_held_power: 1.24,
    held_body_full_ms: 518.0,
    release_units: 0.1592,
    release_long_units: 1.452,
    release_long_full_ms: 1000.0,
    release_repress_ms: 0.0,
    release_repress_discount: 0.0,
    od_power: 0.2,
    flam_units: 1.0,
    half_life_ms: 248.0,
    sustain_ratio: 12.1,
    sustain_weight: 0.3788,
    stamina_half_life_ms: 93510.0,
    stamina_weight: 0.14,
    hand_share: 0.2083,
    goal_exponent: 4.114,
    speed_full_ms: 60.0,
    speed_none_ms: 140.0,
    hand_repeat: 1.0,
    jack_after_hold_units: None,
};

pub const LN: PrismModel = PrismModel {
    jack_units: 6.533,
    jack_chord_share: 0.0,
    release_units: 0.0564,
    independence_units: 0.5454,
    independence_held_power: 1.25,
    held_body_full_ms: 435.0,
    release_long_units: 3.293,
    release_long_full_ms: 714.0,
    release_repress_ms: 168.0,
    release_repress_discount: 0.4,
    od_power: 0.4,
    flam_units: 1.167,
    sustain_weight: 0.19,
    ..PRESS
};

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PrismScale {
    pub strain: [f64; 15],
    pub rating: [f64; 15],
}

pub const SCALE_7K: PrismScale = PrismScale {
    strain: [0.9903, 1.688, 2.928, 3.814, 4.424, 4.907, 5.357, 5.792, 6.338, 6.81, 7.558, 8.248, 9.136, 10.73, 12.61],
    rating: [2.151, 5.006, 10.21, 14.3, 17.02, 19.09, 20.82, 22.81, 24.59, 26.53, 28.51, 30.41, 33.0, 36.68, 40.62],
};
pub const SCALE_6K: PrismScale = PrismScale {
    strain: [0.8068, 1.47, 2.464, 3.282, 3.843, 4.141, 4.511, 4.971, 5.313, 5.629, 5.991, 6.381, 7.191, 8.341, 9.911],
    rating: [2.716, 5.316, 10.49, 13.68, 16.02, 17.91, 19.82, 21.29, 22.65, 24.23, 25.46, 27.09, 29.16, 33.98, 37.35],
};
pub const LN_SCALE_7K: PrismScale = PrismScale {
    strain: [2.079, 3.783, 5.305, 6.591, 7.534, 8.225, 8.881, 9.563, 10.18, 10.96, 11.56, 12.89, 14.13, 16.74, 20.07],
    rating: [3.994, 9.566, 15.8, 21.12, 24.54, 26.71, 28.21, 29.45, 30.59, 32.27, 33.45, 35.17, 36.72, 39.58, 43.01],
};
pub const LN_SCALE_6K: PrismScale = PrismScale {
    strain: [1.859, 2.604, 4.697, 5.59, 6.051, 6.663, 6.881, 7.164, 7.523, 7.713, 8.027, 8.748, 9.888, 12.88, 15.73],
    rating: [4.237, 6.534, 14.97, 19.43, 20.77, 22.63, 22.85, 24.14, 25.06, 26.74, 27.52, 28.23, 31.15, 35.44, 38.8],
};

pub fn scale_8k() -> PrismScale {
    PrismScale { strain: SCALE_7K.strain, rating: SCALE_7K.rating.map(|rating| rating * 0.892) }
}
pub fn ln_scale_8k() -> PrismScale {
    let press = scale_8k();
    PrismScale { strain: press.strain.map(|strain| strain * 1.599), rating: press.rating }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PrismKeymodeModel {
    pub press: PrismModel,
    pub scale: PrismScale,
    pub ln: PrismModel,
    pub ln_scale: PrismScale,
}

pub fn prism_models(key_count: i32) -> Option<PrismKeymodeModel> {
    match key_count {
        6 => Some(PrismKeymodeModel { press: PRESS, scale: SCALE_6K, ln: LN, ln_scale: LN_SCALE_6K }),
        7 => Some(PrismKeymodeModel { press: PRESS, scale: SCALE_7K, ln: LN, ln_scale: LN_SCALE_7K }),
        8 => Some(PrismKeymodeModel { press: PRESS, scale: scale_8k(), ln: LN, ln_scale: ln_scale_8k() }),
        _ => None,
    }
}

pub const PRISM_SKILLSET_FLOOR: f64 = 0.6;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SkillsetShape {
    pub reference: f64,
    pub exponent: f64,
}

pub const PRISM_SKILLSET_SHAPE: [SkillsetShape; 8] = [
    SkillsetShape { reference: 0.9765, exponent: 0.625 },
    SkillsetShape { reference: 0.625, exponent: 0.5 },
    SkillsetShape { reference: 1.0, exponent: 0.625 },
    SkillsetShape { reference: 0.18, exponent: 0.96 },
    SkillsetShape { reference: 0.45, exponent: 0.5 },
    SkillsetShape { reference: 0.5, exponent: 1.0 },
    SkillsetShape { reference: 0.0922, exponent: 0.45 },
    SkillsetShape { reference: 0.5, exponent: 1.2 },
];
