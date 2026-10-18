use std::collections::HashMap;
use std::hash::{BuildHasherDefault, Hasher};

#[derive(Default, Clone, Copy)]
pub struct FxHasher {
    hash: u64,
}

impl Hasher for FxHasher {
    #[inline]
    fn finish(&self) -> u64 {
        let mut z = self.hash;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d049bb133111eb);
        z ^ (z >> 31)
    }
    #[inline]
    fn write(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.write_u64(b as u64);
        }
    }
    #[inline]
    fn write_u64(&mut self, i: u64) {
        self.hash = (self.hash.rotate_left(5) ^ i).wrapping_mul(0x51_7c_c1_b7_27_22_0a_95);
    }
    #[inline]
    fn write_i32(&mut self, i: i32) {
        self.write_u64(i as u32 as u64);
    }
    #[inline]
    fn write_usize(&mut self, i: usize) {
        self.write_u64(i as u64);
    }
}

pub type FxBuild = BuildHasherDefault<FxHasher>;
pub type FxHashMap<K, V> = HashMap<K, V, FxBuild>;
pub type FxHashSet<K> = std::collections::HashSet<K, FxBuild>;

#[inline]
pub fn key(x: f64) -> u64 {
    if x == 0.0 {
        0
    } else if x.is_nan() {
        0x7ff8_0000_0000_0000
    } else {
        x.to_bits()
    }
}

#[derive(Clone, Debug)]
pub struct NumMap<V> {
    index: FxHashMap<u64, usize>,
    pub entries: Vec<(f64, V)>,
}

impl<V> Default for NumMap<V> {
    fn default() -> Self {
        Self { index: FxHashMap::default(), entries: Vec::new() }
    }
}

impl<V> NumMap<V> {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn with_capacity(n: usize) -> Self {
        let mut index = FxHashMap::default();
        index.reserve(n);
        Self { index, entries: Vec::with_capacity(n) }
    }
    #[inline]
    pub fn len(&self) -> usize {
        self.entries.len()
    }
    #[inline]
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
    #[inline]
    pub fn get(&self, k: f64) -> Option<&V> {
        self.index.get(&key(k)).map(|&i| &self.entries[i].1)
    }
    #[inline]
    pub fn get_mut(&mut self, k: f64) -> Option<&mut V> {
        match self.index.get(&key(k)) {
            Some(&i) => Some(&mut self.entries[i].1),
            None => None,
        }
    }
    #[inline]
    pub fn contains(&self, k: f64) -> bool {
        self.index.contains_key(&key(k))
    }
    #[inline]
    pub fn set(&mut self, k: f64, v: V) {
        match self.index.get(&key(k)) {
            Some(&i) => self.entries[i].1 = v,
            None => {
                self.index.insert(key(k), self.entries.len());
                self.entries.push((k, v));
            }
        }
    }
    #[inline]
    pub fn entry_or_insert_with(&mut self, k: f64, f: impl FnOnce() -> V) -> &mut V {
        let i = match self.index.get(&key(k)) {
            Some(&i) => i,
            None => {
                let i = self.entries.len();
                self.index.insert(key(k), i);
                self.entries.push((k, f()));
                i
            }
        };
        &mut self.entries[i].1
    }
    pub fn keys(&self) -> impl Iterator<Item = f64> + '_ {
        self.entries.iter().map(|e| e.0)
    }
    pub fn values(&self) -> impl Iterator<Item = &V> + '_ {
        self.entries.iter().map(|e| &e.1)
    }
}

#[derive(Clone, Debug, Default)]
pub struct NumSet {
    index: FxHashSet<u64>,
    pub items: Vec<f64>,
}

impl NumSet {
    pub fn new() -> Self {
        Self::default()
    }
    #[inline]
    pub fn add(&mut self, v: f64) {
        if self.index.insert(key(v)) {
            self.items.push(v);
        }
    }
    #[inline]
    pub fn has(&self, v: f64) -> bool {
        self.index.contains(&key(v))
    }
    #[inline]
    pub fn len(&self) -> usize {
        self.items.len()
    }
    #[inline]
    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }
}

#[inline]
pub fn cmp_num(a: f64, b: f64) -> std::cmp::Ordering {
    let d = a - b;
    if d < 0.0 {
        std::cmp::Ordering::Less
    } else if d > 0.0 {
        std::cmp::Ordering::Greater
    } else {
        std::cmp::Ordering::Equal
    }
}

#[inline]
pub fn sort_nums(v: &mut [f64]) {
    v.sort_by(|a, b| cmp_num(*a, *b));
}

#[inline]
pub fn truthy(x: f64) -> bool {
    !(x == 0.0 || x.is_nan())
}

#[inline]
pub fn to_int32(x: f64) -> i32 {
    jsmath::to_int32(x)
}

#[inline]
pub fn bit(column: i32) -> i32 {
    1i32.wrapping_shl((column & 31) as u32)
}

#[inline]
pub fn is_js_space(c: char) -> bool {
    jsmath::is_js_whitespace(c)
}

#[inline]
pub fn trim(s: &str) -> &str {
    jsmath::js_trim(s)
}

#[inline]
pub fn trim_start(s: &str) -> &str {
    jsmath::js_trim_start(s)
}

#[inline]
pub fn number(s: &str) -> f64 {
    jsmath::js_number_from_str(s)
}

#[inline]
pub fn number_opt(s: Option<&str>) -> f64 {
    s.map(number).unwrap_or(f64::NAN)
}

#[inline]
pub fn parse_float(s: &str) -> f64 {
    jsmath::js_parse_float(s)
}

#[inline]
pub fn parse_int10(s: &str) -> f64 {
    jsmath::js_parse_int(s, 10)
}

#[inline]
pub fn num_to_string(x: f64) -> String {
    jsmath::number_to_string(x)
}

#[inline]
pub fn to_fixed(x: f64, digits: usize) -> String {
    jsmath::to_fixed(x, digits as u32)
}

pub fn locale_compare(a: &str, b: &str) -> std::cmp::Ordering {
    fn primary(c: u8) -> (u8, u8) {
        let lower = c.to_ascii_lowercase();
        let class = if c.is_ascii_whitespace() {
            0
        } else if c.is_ascii_punctuation() {
            1
        } else if c.is_ascii_digit() {
            2
        } else {
            3
        };
        (class, lower)
    }
    let pa: Vec<(u8, u8)> = a.bytes().map(primary).collect();
    let pb: Vec<(u8, u8)> = b.bytes().map(primary).collect();
    match pa.cmp(&pb) {
        std::cmp::Ordering::Equal => {}
        o => return o,
    }
    for (x, y) in a.bytes().zip(b.bytes()) {
        if x != y {
            let xl = x.is_ascii_lowercase();
            let yl = y.is_ascii_lowercase();
            if xl && !yl {
                return std::cmp::Ordering::Less;
            }
            if !xl && yl {
                return std::cmp::Ordering::Greater;
            }
        }
    }
    std::cmp::Ordering::Equal
}

pub fn text_hash(s: &str) -> String {
    let mut h1: u32 = 0x811c9dc5;
    let mut h2: u32 = 0x01000193 ^ 0x9e3779b9;
    for u in s.encode_utf16() {
        h1 ^= u as u32;
        h1 = h1.wrapping_mul(0x01000193);
        h2 ^= u as u32;
        h2 = h2.wrapping_mul(0x5bd1e995);
        h2 ^= h2 >> 15;
    }
    format!("{:08x}{:08x}:{}", h1, h2, s.encode_utf16().count())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn number_strings() {
        assert_eq!(num_to_string(1.0), "1");
        assert_eq!(num_to_string(0.1), "0.1");
        assert_eq!(num_to_string(1e21), "1e+21");
        assert_eq!(num_to_string(1.5e-7), "1.5e-7");
        assert_eq!(num_to_string(123456789012345680000.0), "123456789012345680000");
        assert_eq!(num_to_string(0.000001), "0.000001");
        assert_eq!(num_to_string(-2.5), "-2.5");
        assert_eq!(to_fixed(0.25, 1), "0.3");
        assert_eq!(to_fixed(2.5, 0), "3");
        assert_eq!(to_fixed(1.005, 2), "1.00");
        assert_eq!(to_fixed(-0.04, 1), "-0.0");
        assert_eq!(to_fixed(-0.0, 1), "0.0");
        assert_eq!(to_fixed(12.345, 1), "12.3");
        assert_eq!(to_fixed(99.96, 1), "100.0");
        assert_eq!(number(" 12 "), 12.0);
        assert_eq!(number(""), 0.0);
        assert!(number("12abc").is_nan());
        assert!(number("inf").is_nan());
        assert_eq!(number("0x10"), 16.0);
        assert_eq!(number("5."), 5.0);
        assert_eq!(number(".5"), 0.5);
        assert!(number(".").is_nan());
        assert_eq!(parse_int10("12abc"), 12.0);
        assert!(parse_int10("abc").is_nan());
        assert_eq!(parse_float("1.5e3x"), 1500.0);
        assert_eq!(parse_float("1e"), 1.0);
        assert_eq!(to_int32(4294967297.0), 1);
        assert_eq!(to_int32(-1.5), -1);
        assert_eq!(bit(-1), i32::MIN);
    }
}
