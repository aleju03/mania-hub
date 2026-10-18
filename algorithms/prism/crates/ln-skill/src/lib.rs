pub mod axis;
pub mod classifier;
mod classifier_data;
pub mod identity;
pub mod prism_ln;
pub mod skill;
pub mod skillsets;
pub mod ssr;
pub mod timeline;
pub mod workload;

use dan_core::ManiaNote;

#[derive(Clone, Copy, Debug)]
pub struct LnMap<'a> {
    pub notes: &'a [ManiaNote],
    pub key_count: i32,
    pub od: f64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct LnSkillOptions {
    pub rate: Option<f64>,
    pub od: Option<f64>,
    pub score_goal: Option<f64>,
    pub include_skillsets: Option<bool>,
}

pub use axis::{has_ln_axis, LN_AXIS_KEY_COUNTS};
pub use classifier::{classify_ln_skillsets, ln_skillset_features, LnSkillsetFeatures};
pub use identity::{
    ln_held_through_share, ln_rating_identity_undecided, resolve_chart_ln_identity, resolve_ln_identity_share,
    LnIdentityOptions, LnIdentityResolution, LnIdentityShares,
};
pub use prism_ln::{analyze_any_ln_skill, analyze_any_ln_skill_from_text, prism_ln_skill, prism_play_ln_skill};
pub use skill::{
    analyze_ln_skill, is_ln_skill_supported, ln_rating_at_goal, ln_skill_display_values, ln_skill_of_workload,
    ln_skill_rate_factor, published_ln_rating, LnSkillResult, LN_SKILL_SCORE_GOAL, LN_SKILL_VERSION,
};
pub use skillsets::{analyze_ln_skillsets, ln_skillsets_for_patterns, LnSkillsets};
pub use ssr::{analyze_ln_ssr, analyze_ln_ssr_from_text, ln_ssr_solver_goal, ssr_goal_anchors};
pub use timeline::{build_ln_timeline_4k, LnTimeline4K};
pub use workload::{build_ln_workload, combine_ln_demand, LnPricing, LnWorkload, LnWorkloadOptions, LN_SKILLSET_IDS};
