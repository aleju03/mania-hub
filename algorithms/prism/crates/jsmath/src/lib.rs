mod fdlibm;
mod js;
mod sort;

pub use js::*;
pub use sort::*;

pub use fdlibm::{acos, acosh, asin, asinh, atanh, cosh, sinh};

#[inline]
pub fn exp(x: f64) -> f64 {
    fdlibm::exp(x)
}
#[inline]
pub fn expm1(x: f64) -> f64 {
    fdlibm::expm1(x)
}
#[inline]
pub fn log(x: f64) -> f64 {
    fdlibm::log(x)
}
#[inline]
pub fn log1p(x: f64) -> f64 {
    fdlibm::log1p(x)
}
#[inline]
pub fn log2(x: f64) -> f64 {
    fdlibm::log2(x)
}
#[inline]
pub fn log10(x: f64) -> f64 {
    fdlibm::log10(x)
}
#[inline]
pub fn sin(x: f64) -> f64 {
    fdlibm::sin(x)
}
#[inline]
pub fn cos(x: f64) -> f64 {
    fdlibm::cos(x)
}
#[inline]
pub fn tan(x: f64) -> f64 {
    fdlibm::tan(x)
}
#[inline]
pub fn atan(x: f64) -> f64 {
    fdlibm::atan(x)
}
#[inline]
pub fn atan2(y: f64, x: f64) -> f64 {
    fdlibm::atan2(y, x)
}
#[inline]
pub fn tanh(x: f64) -> f64 {
    fdlibm::tanh(x)
}
#[inline]
pub fn cbrt(x: f64) -> f64 {
    fdlibm::cbrt(x)
}

extern "C" {
    #[link_name = "pow"]
    fn libm_pow(x: f64, y: f64) -> f64;
}

pub fn pow(x: f64, y: f64) -> f64 {
    if y.is_nan() {
        return f64::NAN;
    }
    if y.is_infinite() && (x == 1.0 || x == -1.0) {
        return f64::NAN;
    }
    if y == 2.0 {
        return x * x;
    }
    if y == 0.5 {
        if x.is_infinite() {
            return f64::INFINITY;
        }
        return (x + 0.0).sqrt();
    }
    let f: unsafe extern "C" fn(f64, f64) -> f64 = std::hint::black_box(libm_pow);
    unsafe { f(x, y) }
}

pub fn hypot(x: f64, y: f64) -> f64 {
    let a = x.abs();
    let b = y.abs();
    if a == f64::INFINITY || b == f64::INFINITY {
        return f64::INFINITY;
    }
    let max = max(a, b);
    if max.is_nan() {
        return f64::NAN;
    }
    if max == 0.0 {
        return 0.0;
    }
    ((a / max) * (a / max) + (b / max) * (b / max)).sqrt() * max
}

pub fn hypot3(x: f64, y: f64, z: f64) -> f64 {
    let a = x.abs();
    let b = y.abs();
    let c = z.abs();
    if a == f64::INFINITY || b == f64::INFINITY || c == f64::INFINITY {
        return f64::INFINITY;
    }
    let max = max(max(a, b), c);
    if max.is_nan() {
        return f64::NAN;
    }
    if max == 0.0 {
        return 0.0;
    }
    let pa = (a / max) * (a / max);
    let pb = (b / max) * (b / max);
    let comp = (pa + pb) - pa - pb;
    let pc = (c / max) * (c / max) - comp;
    (pa + pb + pc).sqrt() * max
}

pub fn hypot_n(v: &[f64]) -> f64 {
    match v.len() {
        0 => 0.0,
        1 => v[0].abs(),
        2 => hypot(v[0], v[1]),
        3 => hypot3(v[0], v[1], v[2]),
        _ => {
            let mut one_nan = false;
            let mut mx = 0.0f64;
            let abs: Vec<f64> = v
                .iter()
                .map(|&x| {
                    if x.is_nan() {
                        one_nan = true;
                        0.0
                    } else {
                        let a = x.abs();
                        if a > mx {
                            mx = a;
                        }
                        a
                    }
                })
                .collect();
            if mx == f64::INFINITY {
                return f64::INFINITY;
            }
            if one_nan {
                return f64::NAN;
            }
            if mx == 0.0 {
                return 0.0;
            }
            let mut sum = 0.0;
            let mut comp = 0.0;
            for a in abs {
                let n = a / mx;
                let summand = n * n - comp;
                let prelim = sum + summand;
                comp = (prelim - sum) - summand;
                sum = prelim;
            }
            sum.sqrt() * mx
        }
    }
}

#[inline]
pub fn sqrt(x: f64) -> f64 {
    x.sqrt()
}

pub fn round(x: f64) -> f64 {
    let r = x.ceil();
    if r - 0.5 <= x {
        r
    } else {
        r - 1.0
    }
}

pub fn sign(x: f64) -> f64 {
    if x.is_nan() || x == 0.0 {
        x
    } else if x > 0.0 {
        1.0
    } else {
        -1.0
    }
}

pub fn fround(x: f64) -> f64 {
    (x as f32) as f64
}

pub fn clz32(x: f64) -> f64 {
    to_uint32(x).leading_zeros() as f64
}

pub fn imul(a: f64, b: f64) -> f64 {
    to_int32(a).wrapping_mul(to_int32(b)) as f64
}

#[inline]
pub fn max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        return f64::NAN;
    }
    if a == 0.0 && b == 0.0 {
        return if a.is_sign_positive() || b.is_sign_positive() { 0.0 } else { -0.0 };
    }
    if a > b {
        a
    } else {
        b
    }
}
#[inline]
pub fn min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        return f64::NAN;
    }
    if a == 0.0 && b == 0.0 {
        return if a.is_sign_negative() || b.is_sign_negative() { -0.0 } else { 0.0 };
    }
    if a < b {
        a
    } else {
        b
    }
}

pub fn max_of(v: &[f64]) -> f64 {
    v.iter().fold(f64::NEG_INFINITY, |acc, &x| max(acc, x))
}
pub fn min_of(v: &[f64]) -> f64 {
    v.iter().fold(f64::INFINITY, |acc, &x| min(acc, x))
}

#[inline]
pub fn rem(a: f64, b: f64) -> f64 {
    a % b
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn round_cases() {
        assert_eq!(round(2.5), 3.0);
        assert_eq!(round(-2.5), -2.0);
        assert!(round(-0.4).is_sign_negative());
        assert_eq!(round(0.49999999999999994), 0.0);
    }
    #[test]
    fn formatting() {
        assert_eq!(number_to_string(1e21), "1e+21");
        assert_eq!(number_to_string(123.456), "123.456");
        assert_eq!(number_to_string(1e-7), "1e-7");
        assert_eq!(number_to_string(0.000001), "0.000001");
        assert_eq!(to_fixed(2.5, 0), "3");
        assert_eq!(to_fixed(0.125, 2), "0.13");
        assert_eq!(to_fixed(1.005, 2), "1.00");
        assert_eq!(to_fixed(-0.0001, 2), "-0.00");
        assert_eq!(to_fixed(9.995, 2), "9.99");
        assert_eq!(to_fixed(99.5, 0), "100");
    }
    #[test]
    fn parsing() {
        assert_eq!(js_number_from_str(""), 0.0);
        assert_eq!(js_number_from_str(" 5 "), 5.0);
        assert!(js_number_from_str("12abc").is_nan());
        assert_eq!(js_parse_int("12abc", 10), 12.0);
        assert_eq!(js_parse_float("1.5e3x"), 1500.0);
        assert_eq!(js_parse_float("1.e3"), 1000.0);
        assert_eq!(js_parse_float(".5"), 0.5);
        assert_eq!(js_number_from_str("0x1F"), 31.0);
        assert_eq!(js_parse_int("-0x1F", 0), -31.0);
    }
}
