mod core;
mod daniel;
mod estimator;
mod sunny;

pub use daniel::calculate_daniel;
pub use estimator::{
    estimate_daniel_dan, run_daniel_estimator, run_sunny_estimator, DanielDan, DifficultyTable,
    EstimatorError, EstimatorOptions, ReworkEstimate,
};
pub use sunny::{calculate_sunny, calculate_sunny_with_spread_limit};

pub use leoblack_parser::{OsuFileParser, ParseStatus};

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum OdFlag {
    Chart,
    Hr,
    Ez,
    Value(f64),
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ReworkStar {
    pub star: f64,
    pub ln_ratio: f64,
    pub column_count: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub enum ReworkError {
    ParseFailed,
    NotMania,
    UnsupportedKeys,
    Throw(&'static str),
}

impl ReworkError {
    pub fn code(&self) -> Option<i32> {
        match self {
            ReworkError::ParseFailed => Some(-1),
            ReworkError::NotMania => Some(-2),
            ReworkError::UnsupportedKeys => Some(-3),
            ReworkError::Throw(_) => None,
        }
    }
}

pub const SPREAD_LIMIT_WORKER_THREAD: usize = 496_000;
pub const SPREAD_LIMIT_MAIN_THREAD: usize = 125_000;
