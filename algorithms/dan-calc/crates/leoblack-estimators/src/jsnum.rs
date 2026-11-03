#[inline]
pub fn to_fixed(x: f64, digits: u32) -> String {
    jsmath::to_fixed(x, digits)
}

#[inline]
pub fn round_fixed(x: f64, digits: u32) -> f64 {
    jsmath::js_number_from_str(&jsmath::to_fixed(x, digits))
}

#[inline]
pub fn number_to_string(x: f64) -> String {
    jsmath::number_to_string(x)
}

#[inline]
pub fn is_js_space(c: char) -> bool {
    jsmath::is_js_whitespace(c)
}

#[inline]
pub fn js_trim(s: &str) -> &str {
    jsmath::js_trim(s)
}

#[inline]
pub fn string_to_number(s: &str) -> f64 {
    jsmath::js_number_from_str(s)
}

#[inline]
pub fn parse_float(s: &str) -> f64 {
    jsmath::js_parse_float(s)
}

#[inline]
pub fn to_int32(x: f64) -> i32 {
    jsmath::to_int32(x)
}

pub fn split_lines(text: &str) -> impl Iterator<Item = &str> {
    text.split('\n').map(|line| line.strip_suffix('\r').unwrap_or(line))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn to_fixed_matches_js() {
        assert_eq!(to_fixed(0.125, 2), "0.13");
        assert_eq!(to_fixed(1.005, 2), "1.00");
        assert_eq!(to_fixed(-0.001, 2), "-0.00");
        assert_eq!(to_fixed(-0.0, 2), "0.00");
        assert_eq!(to_fixed(2.5, 0), "3");
        assert_eq!(to_fixed(-2.5, 0), "-3");
        assert_eq!(to_fixed(123.456, 4), "123.4560");
        assert_eq!(to_fixed(1e21, 2), "1e+21");
        assert_eq!(to_fixed(5e-324, 4), "0.0000");
        assert_eq!(to_fixed(0.5, 0), "1");
        assert!(round_fixed(-0.001, 2).is_sign_negative());
        assert_eq!(to_fixed(333.3333333333333, 12), "333.333333333333");
    }

    #[test]
    fn number_to_string_matches_js() {
        assert_eq!(number_to_string(300.0), "300");
        assert_eq!(number_to_string(0.1), "0.1");
        assert_eq!(number_to_string(1e21), "1e+21");
        assert_eq!(number_to_string(1.5e-7), "1.5e-7");
        assert_eq!(number_to_string(0.000001), "0.000001");
        assert_eq!(number_to_string(-1234.5), "-1234.5");
        assert_eq!(number_to_string(123456789012345680000.0), "123456789012345680000");
    }

    #[test]
    fn string_to_number_matches_js() {
        assert_eq!(string_to_number(""), 0.0);
        assert_eq!(string_to_number(" 5 "), 5.0);
        assert!(string_to_number("12abc").is_nan());
        assert_eq!(string_to_number("0x1A"), 26.0);
        assert_eq!(string_to_number(".5"), 0.5);
        assert_eq!(string_to_number("5."), 5.0);
        assert!(string_to_number(".").is_nan());
        assert!(string_to_number("inf").is_nan());
        assert_eq!(string_to_number("-Infinity"), f64::NEG_INFINITY);
        assert_eq!(parse_float("8.5abc"), 8.5);
        assert_eq!(parse_float("  -1e3x"), -1000.0);
        assert!(parse_float("abc").is_nan());
        assert_eq!(to_int32(4294967297.0), 1);
        assert_eq!(to_int32(-1.5), -1);
    }
}
