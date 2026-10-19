use std::cmp::Ordering;

pub fn to_int32(x: f64) -> i32 {
    to_uint32(x) as i32
}

pub fn to_uint32(x: f64) -> u32 {
    if !x.is_finite() {
        return 0;
    }
    let t = x.trunc();
    if t.abs() < 9007199254740992.0 {
        return (t as i64) as u32;
    }
    let bits = t.to_bits();
    let exp = ((bits >> 52) & 0x7ff) as i32 - 1075;
    let mant = (bits & ((1u64 << 52) - 1)) | (1u64 << 52);
    let v: u32 = if exp >= 32 { 0 } else { (mant << exp) as u32 };
    if t < 0.0 {
        v.wrapping_neg()
    } else {
        v
    }
}

pub fn shr(x: f64, n: f64) -> i32 {
    to_int32(x) >> (to_uint32(n) & 31)
}

fn shortest_digits(x: f64) -> (Vec<u8>, i32) {
    let s = format!("{:e}", x);
    let (mant, exp) = s.split_once('e').expect("exp format");
    let e: i32 = exp.parse().expect("exp");
    let digits: Vec<u8> = mant.bytes().filter(|b| b.is_ascii_digit()).collect();
    let mut d = digits;
    while d.len() > 1 && *d.last().unwrap() == b'0' {
        d.pop();
    }
    let n = e + 1;
    if d.last().map_or(false, |c| (c - b'0') % 2 == 1) {
        if let Some(even) = tie_even_alternative(x, &d, n) {
            return (even, n);
        }
    }
    (d, n)
}

fn tie_even_alternative(x: f64, d: &[u8], n: i32) -> Option<Vec<u8>> {
    let k = d.len() as i32;
    let bits = x.to_bits();
    let biased = ((bits >> 52) & 0x7ff) as i32;
    let frac = bits & ((1u64 << 52) - 1);
    let (m, e) = if biased == 0 { (frac, -1074) } else { (frac | (1u64 << 52), biased - 1075) };
    let tz = m.trailing_zeros() as i32;
    let e = e + tz;
    let exact = if e < 0 { format!("{:.*}", (-e) as usize, x) } else { format!("{:.0}", x) };
    let sig: Vec<u8> = exact.bytes().filter(|b| b.is_ascii_digit()).skip_while(|&b| b == b'0').collect();
    let mut sig = sig;
    while sig.len() > 1 && *sig.last().unwrap() == b'0' {
        sig.pop();
    }
    if sig.len() as i32 != k + 1 || sig[k as usize] != b'5' {
        return None;
    }
    let down: Vec<u8> = sig[..k as usize].to_vec();
    let alt = if down.as_slice() == d { return None } else { down };
    if (alt[alt.len() - 1] - b'0') % 2 != 0 {
        return None;
    }
    let s = format!("0.{}e{}", std::str::from_utf8(&alt).unwrap(), n);
    if s.parse::<f64>().ok()? != x {
        return None;
    }
    let mut alt = alt;
    while alt.len() > 1 && *alt.last().unwrap() == b'0' {
        alt.pop();
    }
    if alt.len() != d.len() {
        return None;
    }
    Some(alt)
}

pub fn number_to_string(x: f64) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x == 0.0 {
        return "0".into();
    }
    if x.is_infinite() {
        return if x > 0.0 { "Infinity".into() } else { "-Infinity".into() };
    }
    if x.fract() == 0.0 && x.abs() < 1e15 {
        return (x as i64).to_string();
    }
    let mut out = String::new();
    let a = if x < 0.0 {
        out.push('-');
        -x
    } else {
        x
    };
    let (d, n) = shortest_digits(a);
    let k = d.len() as i32;
    let ds = std::str::from_utf8(&d).unwrap();
    if k <= n && n <= 21 {
        out.push_str(ds);
        for _ in 0..(n - k) {
            out.push('0');
        }
    } else if 0 < n && n <= 21 {
        out.push_str(&ds[..n as usize]);
        out.push('.');
        out.push_str(&ds[n as usize..]);
    } else if -6 < n && n <= 0 {
        out.push_str("0.");
        for _ in 0..(-n) {
            out.push('0');
        }
        out.push_str(ds);
    } else {
        let e = n - 1;
        out.push_str(&ds[..1]);
        if k > 1 {
            out.push('.');
            out.push_str(&ds[1..]);
        }
        out.push('e');
        out.push(if e < 0 { '-' } else { '+' });
        out.push_str(&e.abs().to_string());
    }
    out
}

fn is_exact_tie(a: f64, digits: usize) -> bool {
    let bits = a.to_bits();
    let biased = ((bits >> 52) & 0x7ff) as i32;
    let frac = bits & ((1u64 << 52) - 1);
    let (m, e) = if biased == 0 { (frac, -1074) } else { (frac | (1u64 << 52), biased - 1075) };
    if m == 0 {
        return false;
    }
    let tz = m.trailing_zeros() as i32;
    e + tz + digits as i32 + 1 == 0
}

pub fn to_fixed(x: f64, digits: u32) -> String {
    assert!(digits <= 100, "toFixed() digits argument must be between 0 and 100");
    let digits = digits as usize;
    if x.is_nan() {
        return "NaN".into();
    }
    let (neg, a) = if x < 0.0 { (true, -x) } else { (false, x.abs()) };
    if a >= 1e21 {
        return number_to_string(x);
    }
    let mut s = if is_exact_tie(a, digits) {
        let t = format!("{:.*}", digits + 1, a);
        let mut b: Vec<u8> = t.into_bytes();
        b.pop();
        if digits == 0 {
            b.pop();
        }
        let mut i = b.len();
        loop {
            if i == 0 {
                b.insert(0, b'1');
                break;
            }
            i -= 1;
            match b[i] {
                b'.' => continue,
                b'9' => b[i] = b'0',
                c => {
                    b[i] = c + 1;
                    break;
                }
            }
        }
        String::from_utf8(b).unwrap()
    } else {
        format!("{:.*}", digits, a)
    };
    if neg {
        s.insert(0, '-');
    }
    s
}

pub fn default_sort_cmp_f64(a: f64, b: f64) -> Ordering {
    number_to_string(a).cmp(&number_to_string(b))
}

pub fn cmp_utf16(a: &str, b: &str) -> Ordering {
    if a.is_ascii() && b.is_ascii() {
        return a.cmp(b);
    }
    a.encode_utf16().cmp(b.encode_utf16())
}

pub fn default_sort_f64(v: &mut [f64]) {
    let mut keyed: Vec<(String, f64)> = v.iter().map(|&x| (number_to_string(x), x)).collect();
    keyed.sort_by(|a, b| a.0.cmp(&b.0));
    for (dst, (_, x)) in v.iter_mut().zip(keyed) {
        *dst = x;
    }
}

pub fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\u{9}'
            | '\u{a}'
            | '\u{b}'
            | '\u{c}'
            | '\u{d}'
            | ' '
            | '\u{a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

pub fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_whitespace)
}
pub fn js_trim_start(s: &str) -> &str {
    s.trim_start_matches(is_js_whitespace)
}

fn decimal_prefix_len(b: &[u8]) -> usize {
    let mut i = 0;
    if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
        i += 1;
    }
    let int_start = i;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    let int_digits = i - int_start;
    let mut frac_digits = 0;
    if i < b.len() && b[i] == b'.' {
        let mut j = i + 1;
        while j < b.len() && b[j].is_ascii_digit() {
            j += 1;
        }
        frac_digits = j - i - 1;
        if int_digits > 0 || frac_digits > 0 {
            i = j;
        }
    }
    if int_digits == 0 && frac_digits == 0 {
        return 0;
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        let mut j = i + 1;
        if j < b.len() && (b[j] == b'+' || b[j] == b'-') {
            j += 1;
        }
        let ds = j;
        while j < b.len() && b[j].is_ascii_digit() {
            j += 1;
        }
        if j > ds {
            i = j;
        }
    }
    i
}

#[inline]
fn fast_decimal(b: &[u8]) -> Option<f64> {
    let mut i = 0;
    let neg = match b.first() {
        Some(b'-') => {
            i = 1;
            true
        }
        Some(b'+') => {
            i = 1;
            false
        }
        _ => false,
    };
    let mut mant: u64 = 0;
    let mut ndig = 0;
    let mut frac = 0i32;
    let mut seen_dot = false;
    let mut any = false;
    while i < b.len() {
        let c = b[i];
        if c.is_ascii_digit() {
            any = true;
            if mant != 0 || c != b'0' {
                ndig += 1;
            }
            if ndig > 15 {
                return None;
            }
            mant = mant * 10 + (c - b'0') as u64;
            if seen_dot {
                frac += 1;
            }
        } else if c == b'.' && !seen_dot {
            seen_dot = true;
        } else {
            return None;
        }
        i += 1;
    }
    if !any || frac > 22 {
        return None;
    }
    const P10: [f64; 23] = [
        1e0, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11, 1e12, 1e13, 1e14, 1e15, 1e16, 1e17, 1e18,
        1e19, 1e20, 1e21, 1e22,
    ];
    let v = mant as f64 / P10[frac as usize];
    Some(if neg { -v } else { v })
}

fn parse_decimal(s: &str) -> f64 {
    if let Some(v) = fast_decimal(s.as_bytes()) {
        return v;
    }
    s.parse::<f64>().unwrap_or(f64::NAN)
}

fn digit_val(c: u8, radix: u32) -> Option<u32> {
    let d = match c {
        b'0'..=b'9' => (c - b'0') as u32,
        b'a'..=b'z' => (c - b'a') as u32 + 10,
        b'A'..=b'Z' => (c - b'A') as u32 + 10,
        _ => return None,
    };
    if d < radix {
        Some(d)
    } else {
        None
    }
}

fn pow2_radix_to_double(b: &[u8], radix_log2: u32, negative: bool, allow_trailing_junk: bool) -> Option<f64> {
    let radix = 1u32 << radix_log2;
    let mut i = 0;
    while i < b.len() && b[i] == b'0' {
        i += 1;
        if i == b.len() {
            return Some(if negative { -0.0 } else { 0.0 });
        }
    }
    let start = i;
    let mut number: i64 = 0;
    let mut exponent: i32 = 0;
    loop {
        let d = match digit_val(b[i], radix) {
            Some(d) => d,
            None => {
                if i == start {
                    return None;
                }
                if allow_trailing_junk || js_trim_start(std::str::from_utf8(&b[i..]).unwrap_or("x")).is_empty() {
                    break;
                }
                return None;
            }
        };
        number = number * radix as i64 + d as i64;
        let mut overflow = (number >> 53) as i32;
        if overflow != 0 {
            let mut overflow_bits_count = 1;
            while overflow > 1 {
                overflow_bits_count += 1;
                overflow >>= 1;
            }
            let dropped_bits_mask = (1i32 << overflow_bits_count) - 1;
            let dropped_bits = (number as i32) & dropped_bits_mask;
            number >>= overflow_bits_count;
            exponent = overflow_bits_count;
            let mut zero_tail = true;
            loop {
                i += 1;
                if i == b.len() || digit_val(b[i], radix).is_none() {
                    break;
                }
                zero_tail = zero_tail && b[i] == b'0';
                exponent += radix_log2 as i32;
            }
            if !allow_trailing_junk && !js_trim_start(std::str::from_utf8(&b[i..]).unwrap_or("x")).is_empty() {
                return None;
            }
            let middle_value = 1i32 << (overflow_bits_count - 1);
            if dropped_bits > middle_value || (dropped_bits == middle_value && ((number & 1) != 0 || !zero_tail)) {
                number += 1;
            }
            if (number & (1i64 << 53)) != 0 {
                exponent += 1;
                number >>= 1;
            }
            break;
        }
        i += 1;
        if i == b.len() {
            break;
        }
    }
    if exponent == 0 {
        if negative {
            if number == 0 {
                return Some(-0.0);
            }
            return Some(-(number as f64));
        }
        return Some(number as f64);
    }
    let v = number as f64;
    let v = if negative { -v } else { v };
    Some(crate::fdlibm::scalbn(v, exponent))
}

pub fn js_number_from_str(s: &str) -> f64 {
    let t = js_trim(s);
    if t.is_empty() {
        return 0.0;
    }
    let b = t.as_bytes();
    if b[0] == b'0' && b.len() >= 2 {
        let lg = match b[1] {
            b'x' | b'X' => Some(4),
            b'o' | b'O' => Some(3),
            b'b' | b'B' => Some(1),
            _ => None,
        };
        if let Some(lg) = lg {
            if b.len() == 2 {
                return f64::NAN;
            }
            return pow2_radix_to_double(&b[2..], lg, false, false).unwrap_or(f64::NAN);
        }
    }
    let n = decimal_prefix_len(b);
    if n == b.len() {
        return parse_decimal(t);
    }
    if n > 0 {
        return f64::NAN;
    }
    match t {
        "Infinity" | "+Infinity" => f64::INFINITY,
        "-Infinity" => f64::NEG_INFINITY,
        _ => f64::NAN,
    }
}

pub fn js_parse_float(s: &str) -> f64 {
    let t = js_trim_start(s);
    let b = t.as_bytes();
    let n = decimal_prefix_len(b);
    if n > 0 {
        return parse_decimal(&t[..n]);
    }
    let rest = if t.starts_with('+') || t.starts_with('-') { &t[1..] } else { t };
    if rest.starts_with("Infinity") {
        return if t.starts_with('-') { f64::NEG_INFINITY } else { f64::INFINITY };
    }
    f64::NAN
}

pub fn js_parse_int(s: &str, radix: i32) -> f64 {
    if radix == 10 || radix == 0 {
        let b = s.as_bytes();
        let (neg, d) = match b.first() {
            Some(b'-') => (true, &b[1..]),
            _ => (false, b),
        };
        if !d.is_empty() && d.len() <= 15 && d.iter().all(u8::is_ascii_digit) && (d[0] != b'0' || d.len() == 1) {
            let mut v: u64 = 0;
            for &c in d {
                v = v * 10 + (c - b'0') as u64;
            }
            let f = v as f64;
            return if neg { -f } else { f };
        }
    }
    let b = js_trim_start(s).as_bytes();
    if b.is_empty() {
        return f64::NAN;
    }
    let mut i = 0;
    let mut negative = false;
    if b[0] == b'+' || b[0] == b'-' {
        negative = b[0] == b'-';
        i += 1;
        if i == b.len() {
            return f64::NAN;
        }
    }
    let signed_zero = if negative { -0.0 } else { 0.0 };
    let mut radix = radix;
    if radix != 0 && !(2..=36).contains(&radix) {
        return f64::NAN;
    }
    let mut leading_zero = false;
    if radix == 0 {
        radix = 10;
        if b[i] == b'0' {
            i += 1;
            if i == b.len() {
                return signed_zero;
            }
            if b[i] == b'x' || b[i] == b'X' {
                radix = 16;
                i += 1;
                if i == b.len() {
                    return f64::NAN;
                }
            } else {
                leading_zero = true;
            }
        }
    } else if radix == 16 && b[i] == b'0' {
        i += 1;
        if i == b.len() {
            return signed_zero;
        }
        if b[i] == b'x' || b[i] == b'X' {
            i += 1;
            if i == b.len() {
                return f64::NAN;
            }
        } else {
            leading_zero = true;
        }
    }
    while b[i] == b'0' {
        leading_zero = true;
        i += 1;
        if i == b.len() {
            return signed_zero;
        }
    }
    let r = radix as u32;
    if digit_val(b[i], r).is_none() {
        return if leading_zero { signed_zero } else { f64::NAN };
    }
    let rest = &b[i..];
    let result = if radix == 10 {
        let mut n = 0;
        while n < rest.len() && rest[n].is_ascii_digit() {
            n += 1;
        }
        let take = n.min(310);
        parse_decimal(std::str::from_utf8(&rest[..take]).unwrap())
    } else if r.is_power_of_two() {
        pow2_radix_to_double(rest, r.trailing_zeros(), false, true).unwrap_or(f64::NAN)
    } else {
        let mut result = 0.0f64;
        let mut j = 0;
        let mut done = false;
        while !done {
            let mut part: u32 = 0;
            let mut multiplier: u32 = 1;
            loop {
                let d = match digit_val(rest[j], r) {
                    Some(d) => d,
                    None => {
                        done = true;
                        break;
                    }
                };
                const K_MAX: u32 = 0xFFFFFFFF / 36;
                let m = multiplier.wrapping_mul(r);
                if m > K_MAX {
                    break;
                }
                part = part * r + d;
                multiplier = m;
                j += 1;
                if j == rest.len() {
                    done = true;
                    break;
                }
            }
            result = result * multiplier as f64 + part as f64;
        }
        result
    };
    if negative {
        -result
    } else {
        result
    }
}

pub fn is_array_index_key(key: &str) -> bool {
    if key.is_empty() || key.len() > 10 || (key.len() > 1 && key.starts_with('0')) {
        return false;
    }
    key.bytes().all(|b| b.is_ascii_digit()) && key.parse::<u64>().map_or(false, |v| v < 4294967295)
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct JsObject<V> {
    entries: Vec<(String, V)>,
}

impl<V> JsObject<V> {
    pub fn new() -> Self {
        JsObject { entries: Vec::new() }
    }
    pub fn len(&self) -> usize {
        self.entries.len()
    }
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
    pub fn get(&self, key: &str) -> Option<&V> {
        self.entries.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }
    pub fn get_mut(&mut self, key: &str) -> Option<&mut V> {
        self.entries.iter_mut().find(|(k, _)| k == key).map(|(_, v)| v)
    }
    pub fn set(&mut self, key: impl Into<String>, value: V) {
        let key = key.into();
        match self.entries.iter_mut().find(|(k, _)| *k == key) {
            Some(slot) => slot.1 = value,
            None => self.entries.push((key, value)),
        }
    }
    pub fn iter(&self) -> impl Iterator<Item = (&str, &V)> {
        let mut idx: Vec<(u64, usize)> = Vec::new();
        let mut rest: Vec<usize> = Vec::new();
        for (i, (k, _)) in self.entries.iter().enumerate() {
            if is_array_index_key(k) {
                idx.push((k.parse().unwrap(), i));
            } else {
                rest.push(i);
            }
        }
        idx.sort();
        idx.into_iter().map(|(_, i)| i).chain(rest).map(move |i| (self.entries[i].0.as_str(), &self.entries[i].1))
    }
    pub fn keys(&self) -> Vec<&str> {
        self.iter().map(|(k, _)| k).collect()
    }
}

pub fn thread_cpu_seconds() -> f64 {
    #[repr(C)]
    struct Timespec {
        tv_sec: i64,
        tv_nsec: i64,
    }
    extern "C" {
        fn clock_gettime(clk: i32, ts: *mut Timespec) -> i32;
    }
    const CLOCK_THREAD_CPUTIME_ID: i32 = 3;
    let mut ts = Timespec { tv_sec: 0, tv_nsec: 0 };
    unsafe { clock_gettime(CLOCK_THREAD_CPUTIME_ID, &mut ts) };
    ts.tv_sec as f64 + ts.tv_nsec as f64 * 1e-9
}
