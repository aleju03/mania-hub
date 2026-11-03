use crate::jsnum::{is_js_space, js_trim, string_to_number};

pub const GREEK_BY_INDEX: [&str; 10] = [
    "Alpha",
    "Beta",
    "Gamma",
    "Delta",
    "Epsilon",
    "Emik Zeta",
    "Thaumiel Eta",
    "CloverWisp Theta",
    "Iota",
    "Kappa",
];

pub const RC_TIER_CANDIDATES: [(&str, f64); 5] = [("low", -0.4), ("mid/low", -0.2), ("mid", 0.0), ("mid/high", 0.2), ("high", 0.4)];

const GREEK_BASE_MAP: [(&str, f64); 10] = [
    ("alpha", 11.0),
    ("beta", 12.0),
    ("gamma", 13.0),
    ("delta", 14.0),
    ("epsilon", 15.0),
    ("zeta", 16.0),
    ("eta", 17.0),
    ("theta", 18.0),
    ("iota", 19.0),
    ("kappa", 20.0),
];

fn clamp(v: f64, lo: f64, hi: f64) -> f64 {
    jsmath::max(lo, jsmath::min(hi, v))
}

pub fn format_rc_base_label(base: i32) -> String {
    if base <= 0 {
        let intro = (base + 3).clamp(1, 3);
        return format!("Intro {intro}");
    }
    if base <= 10 {
        return format!("Reform {base}");
    }
    let idx = (base - 11).clamp(0, GREEK_BY_INDEX.len() as i32 - 1);
    GREEK_BY_INDEX[idx as usize].to_string()
}

pub fn numeric_to_rc_label(numeric: f64) -> String {
    if !numeric.is_finite() {
        return "Invalid".into();
    }
    let clamped = clamp(numeric, -2.4, 20.4);
    let mut best: Option<(i32, &str, f64)> = None;
    for base in -2..=20 {
        for &(suffix, offset) in RC_TIER_CANDIDATES.iter() {
            let center = base as f64 + offset;
            let distance = (clamped - center).abs();
            if best.map_or(true, |b| distance < b.2) {
                best = Some((base, suffix, distance));
            }
        }
    }
    let (base, suffix, _) = best.unwrap();
    format!("{} {}", format_rc_base_label(base), suffix)
}

fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

fn boundary(chars: &[char], i: usize) -> bool {
    let before = i > 0 && is_word(chars[i - 1]);
    let after = i < chars.len() && is_word(chars[i]);
    before != after
}

fn starts_with_at(chars: &[char], i: usize, word: &str) -> bool {
    let mut j = i;
    for w in word.chars() {
        if j >= chars.len() || chars[j] != w {
            return false;
        }
        j += 1;
    }
    true
}

fn has_word(chars: &[char], word: &str) -> bool {
    let n = word.chars().count();
    (0..chars.len()).any(|i| boundary(chars, i) && starts_with_at(chars, i, word) && boundary(chars, i + n))
}

fn skip_space(chars: &[char], mut i: usize) -> usize {
    while i < chars.len() && is_js_space(chars[i]) {
        i += 1;
    }
    i
}

fn digit_run(chars: &[char], mut i: usize) -> usize {
    while i < chars.len() && chars[i].is_ascii_digit() {
        i += 1;
    }
    i
}

fn match_number(chars: &[char], i: usize, end_ok: &dyn Fn(usize) -> bool) -> Option<String> {
    let try_from = |start: usize| -> Option<usize> {
        let d1 = digit_run(chars, start);
        if d1 == start {
            return None;
        }
        if d1 < chars.len() && chars[d1] == '.' {
            let d2 = digit_run(chars, d1 + 1);
            if d2 > d1 + 1 && end_ok(d2) {
                return Some(d2);
            }
        }
        if end_ok(d1) {
            return Some(d1);
        }
        None
    };
    if i < chars.len() && chars[i] == '-' {
        if let Some(end) = try_from(i + 1) {
            return Some(chars[i..end].iter().collect());
        }
    }
    try_from(i).map(|end| chars[i..end].iter().collect())
}

fn match_intro(chars: &[char]) -> Option<f64> {
    for i in 0..chars.len() {
        if !(boundary(chars, i) && starts_with_at(chars, i, "intro")) {
            continue;
        }
        let j = skip_space(chars, i + 5);
        if j < chars.len() && matches!(chars[j], '1' | '2' | '3') && boundary(chars, j + 1) {
            return Some(chars[j].to_digit(10).unwrap() as f64);
        }
    }
    None
}

fn match_numbered(chars: &[char]) -> Option<String> {
    for i in 0..chars.len() {
        if !boundary(chars, i) {
            continue;
        }
        for kw in ["reform", "rework", "regular"] {
            if !starts_with_at(chars, i, kw) {
                continue;
            }
            let j = skip_space(chars, i + kw.len());
            if let Some(m) = match_number(chars, j, &|end| boundary(chars, end)) {
                return Some(m);
            }
        }
    }
    None
}

fn match_plain(chars: &[char]) -> Option<String> {
    let end_ok = |end: usize| end == chars.len() || is_js_space(chars[end]);
    for i in 0..=chars.len() {
        if i == 0 {
            if let Some(m) = match_number(chars, 0, &end_ok) {
                return Some(m);
            }
        }
        if i < chars.len() && is_js_space(chars[i]) {
            if let Some(m) = match_number(chars, i + 1, &end_ok) {
                return Some(m);
            }
        }
    }
    None
}

fn has_mid_slash(chars: &[char], x: &str) -> bool {
    for i in 0..chars.len() {
        if !(boundary(chars, i) && starts_with_at(chars, i, "mid")) {
            continue;
        }
        let j = skip_space(chars, i + 3);
        if j < chars.len() && (chars[j] == '/' || chars[j] == '-') {
            let k = skip_space(chars, j + 1);
            if starts_with_at(chars, k, x) && boundary(chars, k + x.len()) {
                return true;
            }
        }
    }
    false
}

fn parse_tier_adjustment(chars: &[char]) -> f64 {
    if has_mid_slash(chars, "high") || has_word(chars, "midhigh") {
        return 0.2;
    }
    if has_mid_slash(chars, "low") || has_word(chars, "midlow") {
        return -0.2;
    }
    if has_word(chars, "low") {
        return -0.4;
    }
    if has_word(chars, "high") {
        return 0.4;
    }
    0.0
}

pub fn rc_label_to_numeric(label: &str) -> Option<f64> {
    let first = label.split("||").next().unwrap_or("");
    let mut collapsed = String::with_capacity(first.len());
    let mut in_space = false;
    for c in first.chars() {
        if is_js_space(c) {
            if !in_space {
                collapsed.push(' ');
            }
            in_space = true;
        } else {
            collapsed.push(c);
            in_space = false;
        }
    }
    let primary = js_trim(&collapsed);
    if primary.is_empty() || primary.contains('<') || primary.contains('>') {
        return None;
    }
    let lower: Vec<char> = primary.to_lowercase().chars().collect();
    let mut base: Option<f64> = None;
    if let Some(d) = match_intro(&lower) {
        base = Some(d - 3.0);
    }
    if base.is_none() {
        if let Some(m) = match_numbered(&lower) {
            base = Some(string_to_number(&m));
        }
    }
    if base.is_none() && (has_word(&lower, "finish") || has_word(&lower, "stellium")) {
        base = Some(10.0);
    }
    if base.is_none() {
        for (word, value) in GREEK_BASE_MAP {
            if has_word(&lower, word) {
                base = Some(value);
                break;
            }
        }
    }
    if base.is_none() {
        if let Some(m) = match_plain(&lower) {
            base = Some(string_to_number(&m));
        }
    }
    let base = base?;
    if !base.is_finite() {
        return None;
    }
    Some(base + parse_tier_adjustment(&lower))
}
