#[path = "generated/intervals.rs"]
mod generated;
pub use generated::*;

#[derive(Clone, Copy, Debug)]
pub struct DanTables {
    pub rc_default: &'static [IntervalRow],
    pub rc_extended: Option<&'static [IntervalRow]>,
    pub ln_default: Option<&'static [IntervalRow]>,
    pub ln_extended: Option<&'static [IntervalRow]>,
}

pub fn dan_index(column_count: f64) -> Option<DanTables> {
    if column_count == 4.0 {
        Some(DanTables { rc_default: RC_4K, rc_extended: Some(RC_EXT_4K), ln_default: Some(LN_4K), ln_extended: Some(LN_EXT_4K) })
    } else if column_count == 6.0 {
        Some(DanTables { rc_default: RC_6K, rc_extended: None, ln_default: Some(LN_6K), ln_extended: None })
    } else if column_count == 7.0 {
        Some(DanTables { rc_default: RC_7K, rc_extended: Some(RC_EXT_7K), ln_default: Some(LN_7K), ln_extended: None })
    } else if column_count == 10.0 {
        Some(DanTables { rc_default: RC_10K, rc_extended: None, ln_default: None, ln_extended: None })
    } else {
        None
    }
}
