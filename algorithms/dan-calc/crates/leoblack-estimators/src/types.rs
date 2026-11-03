#[derive(Clone, Debug, PartialEq)]
pub enum OdFlag {
    Num(f64),
    Str(String),
}

pub type CvtFlag = String;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MsdValues {
    pub overall: f64,
    pub stream: f64,
    pub jumpstream: f64,
    pub handstream: f64,
    pub stamina: f64,
    pub jack_speed: f64,
    pub chordjack: f64,
    pub technical: f64,
}

impl Default for MsdValues {
    fn default() -> Self {
        MsdValues {
            overall: f64::NAN,
            stream: f64::NAN,
            jumpstream: f64::NAN,
            handstream: f64::NAN,
            stamina: f64::NAN,
            jack_speed: f64::NAN,
            chordjack: f64::NAN,
            technical: f64::NAN,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MarathonInput {
    pub duration_s: f64,
    pub ett_values: Option<MsdValues>,
}

#[derive(Clone, Debug, Default)]
pub struct EstimatorOptions<'a> {
    pub speed_rate: Option<f64>,
    pub polaris_rate: Option<f64>,
    pub od_flag: Option<OdFlag>,
    pub cvt_flag: Option<CvtFlag>,
    pub extended_estimation_range: bool,
    pub enable_always_show_ln_difficulty: bool,
    pub marathon_correction: Option<MarathonInput>,
    pub force_sunny_reference_ho: Option<bool>,
    pub precomputed_sunny_result: Option<&'a EstimatorResult>,
    pub precomputed_daniel_result: Option<&'a EstimatorResult>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ParseStatus {
    Init,
    Ok,
    Fail,
    NotMania,
}

pub trait ParsedView {
    fn status(&self) -> ParseStatus;
    fn column_count(&self) -> f64;
    fn ln_ratio(&self) -> f64;
    fn od(&self) -> f64;
    fn note_count(&self) -> usize;
    fn column(&self, i: usize) -> f64;
    fn note_start(&self, i: usize) -> f64;
    fn note_type(&self, i: usize) -> f64;
}

#[derive(Clone, Debug)]
pub struct ParsedChart {
    pub status: ParseStatus,
    pub column_count: f64,
    pub ln_ratio: f64,
    pub od: f64,
    pub columns: Vec<f64>,
    pub note_starts: Vec<f64>,
    pub note_types: Vec<f64>,
}

impl ParsedView for ParsedChart {
    fn status(&self) -> ParseStatus { self.status }
    fn column_count(&self) -> f64 { self.column_count }
    fn ln_ratio(&self) -> f64 { self.ln_ratio }
    fn od(&self) -> f64 { self.od }
    fn note_count(&self) -> usize { self.columns.len() }
    fn column(&self, i: usize) -> f64 { self.columns.get(i).copied().unwrap_or(f64::NAN) }
    fn note_start(&self, i: usize) -> f64 { self.note_starts.get(i).copied().unwrap_or(f64::NAN) }
    fn note_type(&self, i: usize) -> f64 { self.note_types.get(i).copied().unwrap_or(f64::NAN) }
}

impl<T: ParsedView + ?Sized> ParsedView for std::rc::Rc<T> {
    fn status(&self) -> ParseStatus { (**self).status() }
    fn column_count(&self) -> f64 { (**self).column_count() }
    fn ln_ratio(&self) -> f64 { (**self).ln_ratio() }
    fn od(&self) -> f64 { (**self).od() }
    fn note_count(&self) -> usize { (**self).note_count() }
    fn column(&self, i: usize) -> f64 { (**self).column(i) }
    fn note_start(&self, i: usize) -> f64 { (**self).note_start(i) }
    fn note_type(&self, i: usize) -> f64 { (**self).note_type(i) }
}

pub trait Upstream {
    type Parsed: ParsedView;

    fn parse(&self, text: &str, cvt: Option<&str>) -> Result<Self::Parsed, String>;

    fn sunny(&self, text: &str, options: &EstimatorOptions, parsed: Option<&Self::Parsed>) -> Result<EstimatorResult, String>;

    fn daniel(&self, text: &str, options: &EstimatorOptions, parsed: Option<&Self::Parsed>) -> Result<EstimatorResult, String>;
}

#[derive(Clone, Debug, PartialEq)]
pub struct EstimatorResult {
    pub star: f64,
    pub ln_ratio: f64,
    pub column_count: f64,
    pub est_diff: String,
    pub numeric_difficulty: Option<f64>,
    pub numeric_difficulty_hint: Option<String>,
    pub raw_numeric_difficulty: Option<f64>,
    pub debug: Option<EstimatorDebug>,
}

impl EstimatorResult {
    pub fn basic(star: f64, ln_ratio: f64, column_count: f64, est_diff: String, numeric: Option<f64>, hint: Option<String>) -> Self {
        EstimatorResult {
            star,
            ln_ratio,
            column_count,
            est_diff,
            numeric_difficulty: numeric,
            numeric_difficulty_hint: hint,
            raw_numeric_difficulty: None,
            debug: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum EstimatorDebug {
    Error { code: String, message: String },
    Azusa(Box<crate::azusa::AzusaDebug>),
    Roxy(Box<crate::roxy::RoxyDebug>),
    RoxyScope(Box<crate::roxy::RoxyScopeDebug>),
}

#[derive(Clone, Debug, PartialEq)]
pub struct CompanellaPlan {
    pub ln_ratio: f64,
    pub ln_difficulty: String,
    pub fusion: Option<CompanellaFusion>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct CompanellaFusion {
    pub on_disagree: OnDisagree,
    pub rc_est_diff: String,
    pub rc_numeric: Option<f64>,
    pub rc_numeric_hint: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OnDisagree {
    Azusa,
    Companella,
}

impl OnDisagree {
    pub fn as_str(self) -> &'static str {
        match self {
            OnDisagree::Azusa => "azusa",
            OnDisagree::Companella => "companella",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct MixedResult {
    pub result: EstimatorResult,
    pub mixed_companella_plan: Option<CompanellaPlan>,
    pub actual_estimator_algorithm: &'static str,
    pub companella_capsule: Option<&'static str>,
}
