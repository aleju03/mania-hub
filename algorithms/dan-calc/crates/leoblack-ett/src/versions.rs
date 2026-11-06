#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum EttVersion {
    V0680Unofficial,
    V0700,
    V0720,
    V0723,
    V0740,
    V0750,
}

pub const ALL_VERSIONS: [EttVersion; 6] = [
    EttVersion::V0680Unofficial,
    EttVersion::V0700,
    EttVersion::V0720,
    EttVersion::V0723,
    EttVersion::V0740,
    EttVersion::V0750,
];

pub const DEFAULT_ETTERNA_VERSION: EttVersion = EttVersion::V0723;
pub const NON_4K_ETTERNA_FALLBACK_VERSION: EttVersion = EttVersion::V0750;

impl EttVersion {
    pub fn key(self) -> &'static str {
        match self {
            EttVersion::V0680Unofficial => "0.68.0-Unofficial",
            EttVersion::V0700 => "0.70.0",
            EttVersion::V0720 => "0.72.0",
            EttVersion::V0723 => "0.72.3",
            EttVersion::V0740 => "0.74.0",
            EttVersion::V0750 => "0.75.0",
        }
    }

    pub fn index(self) -> usize {
        self as usize
    }

    pub fn from_key(key: &str) -> Option<EttVersion> {
        ALL_VERSIONS.iter().copied().find(|v| v.key() == key)
    }

    pub fn wasm_file_name(self) -> &'static str {
        match self {
            EttVersion::V0680Unofficial => "minaclac-68.0-unofficial.wasm",
            EttVersion::V0700 => "minaclac-70.0.wasm",
            // The same build as 0.72.3, byte for byte: only that one is kept.
            EttVersion::V0720 => "minaclac-72.3.wasm",
            EttVersion::V0723 => "minaclac-72.3.wasm",
            EttVersion::V0740 => "minaclac-74.0.wasm",
            EttVersion::V0750 => "minaclac-75.0.wasm",
        }
    }
}

pub fn is_supported_key(k: f64) -> bool {
    k.fract() == 0.0 && (4.0..=18.0).contains(&k)
}

pub fn pinned_version_for_keycount(keycount: f64) -> Option<EttVersion> {
    if keycount == 4.0 {
        None
    } else {
        Some(NON_4K_ETTERNA_FALLBACK_VERSION)
    }
}

pub fn normalize_version(value: Option<&str>) -> EttVersion {
    let trimmed = value.map(jsmath::js_trim).unwrap_or("");
    let normalized = if trimmed == "0.68.0" { "0.68.0-Unofficial" } else { trimmed };
    EttVersion::from_key(normalized).unwrap_or(DEFAULT_ETTERNA_VERSION)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedVersion {
    pub requested_version: EttVersion,
    pub version: EttVersion,
    pub fallback_reason: Option<String>,
}

pub fn resolve_for_keycount(value: Option<&str>, keycount: f64) -> ResolvedVersion {
    let requested = normalize_version(value);
    if let Some(pinned) = pinned_version_for_keycount(keycount) {
        if requested != pinned && is_supported_key(keycount) {
            return ResolvedVersion {
                requested_version: requested,
                version: pinned,
                fallback_reason: Some(format!(
                    "Using {} for {}K",
                    pinned.key(),
                    jsmath::number_to_string(keycount)
                )),
            };
        }
    }
    ResolvedVersion { requested_version: requested, version: requested, fallback_reason: None }
}
