#[derive(Clone, Debug, PartialEq)]
pub enum Js {
    Undefined,
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<Js>),
    Obj(Obj),
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Obj(pub Vec<(String, Js)>);

impl Obj {
    pub fn new() -> Obj {
        Obj(Vec::new())
    }

    pub fn set(&mut self, key: &str, value: Js) {
        match self.0.iter_mut().find(|(k, _)| k == key) {
            Some(entry) => entry.1 = value,
            None => self.0.push((key.to_string(), value)),
        }
    }

    pub fn with(mut self, key: &str, value: Js) -> Obj {
        self.set(key, value);
        self
    }

    pub fn spread(&mut self, other: Obj) {
        for (k, v) in other.0 {
            self.set(&k, v);
        }
    }

    pub fn get(&self, key: &str) -> Option<&Js> {
        self.0.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }
}

impl From<Obj> for Js {
    fn from(o: Obj) -> Js {
        Js::Obj(o)
    }
}

pub fn num(x: f64) -> Js {
    Js::Num(x)
}

pub fn str(s: &str) -> Js {
    Js::Str(s.to_string())
}

pub fn opt_num(x: Option<f64>) -> Js {
    x.map_or(Js::Null, Js::Num)
}

pub fn opt_str(s: Option<&str>) -> Js {
    s.map_or(Js::Null, |s| Js::Str(s.to_string()))
}

pub fn stringify(value: &Js) -> Option<String> {
    if matches!(value, Js::Undefined) {
        return None;
    }
    let mut out = String::with_capacity(256);
    write(&mut out, value);
    Some(out)
}

fn write(out: &mut String, value: &Js) {
    match value {
        Js::Undefined | Js::Null => out.push_str("null"),
        Js::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Js::Num(x) => {
            if x.is_finite() {
                out.push_str(&jsmath::number_to_string(*x));
            } else {
                out.push_str("null");
            }
        }
        Js::Str(s) => quote(out, s),
        Js::Arr(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write(out, item);
            }
            out.push(']');
        }
        Js::Obj(obj) => {
            out.push('{');
            let mut first = true;
            for (k, v) in &obj.0 {
                if matches!(v, Js::Undefined) {
                    continue;
                }
                if !first {
                    out.push(',');
                }
                first = false;
                quote(out, k);
                out.push(':');
                write(out, v);
            }
            out.push('}');
        }
    }
}

fn quote(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stringify_matches_js() {
        let o = Obj::new()
            .with("a", num(-0.0))
            .with("b", num(f64::NAN))
            .with("c", Js::Undefined)
            .with("d", Js::Arr(vec![Js::Undefined, num(1.5e-7), num(1e21)]))
            .with("e", str("x\"\\\n\u{1}\u{2028}"));
        assert_eq!(
            stringify(&o.into()).unwrap(),
            "{\"a\":0,\"b\":null,\"d\":[null,1.5e-7,1e+21],\"e\":\"x\\\"\\\\\\n\\u0001\u{2028}\"}"
        );
    }
}
