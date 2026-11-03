use std::sync::OnceLock;

use crate::jsnum::round_fixed;
use crate::types::MsdValues;

static MODEL_BYTES: &[u8] = include_bytes!("../companella/dan_model.onnx");

const DAN_LABELS: [&str; 20] = [
    "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "alpha", "beta", "gamma", "delta", "epsilon", "Emik Zeta", "Thaumiel Eta",
    "CloverWisp Theta", "iota", "kappa",
];
const FEATURE_COUNT: usize = 10;
const MIN_DAN: f64 = 1.0;
const MAX_DAN: f64 = 20.0;

struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn new(buf: &'a [u8]) -> Self {
        Reader { buf, pos: 0 }
    }
    fn done(&self) -> bool {
        self.pos >= self.buf.len()
    }
    fn varint(&mut self) -> Result<u64, String> {
        let mut out = 0u64;
        let mut shift = 0;
        loop {
            let b = *self.buf.get(self.pos).ok_or("truncated varint")?;
            self.pos += 1;
            out |= ((b & 0x7f) as u64) << shift;
            if b & 0x80 == 0 {
                return Ok(out);
            }
            shift += 7;
            if shift >= 64 {
                return Err("varint overflow".into());
            }
        }
    }
    fn bytes(&mut self) -> Result<&'a [u8], String> {
        let len = self.varint()? as usize;
        let end = self.pos.checked_add(len).filter(|e| *e <= self.buf.len()).ok_or("truncated bytes")?;
        let out = &self.buf[self.pos..end];
        self.pos = end;
        Ok(out)
    }
    fn fixed32(&mut self) -> Result<u32, String> {
        let s = self.buf.get(self.pos..self.pos + 4).ok_or("truncated fixed32")?;
        self.pos += 4;
        Ok(u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
    }
    fn key(&mut self) -> Result<(u32, u8), String> {
        let k = self.varint()?;
        Ok(((k >> 3) as u32, (k & 7) as u8))
    }
    fn skip(&mut self, wire: u8) -> Result<(), String> {
        match wire {
            0 => {
                self.varint()?;
            }
            1 => self.pos += 8,
            2 => {
                self.bytes()?;
            }
            5 => self.pos += 4,
            _ => return Err(format!("unsupported wire type {wire}")),
        }
        Ok(())
    }
}

#[derive(Default, Debug)]
struct Attribute {
    name: String,
    f: Option<f32>,
    i: Option<i64>,
    s: Option<Vec<u8>>,
    floats: Vec<f32>,
    ints: Vec<i64>,
    strings: Vec<Vec<u8>>,
}

fn parse_attribute(buf: &[u8]) -> Result<Attribute, String> {
    let mut r = Reader::new(buf);
    let mut a = Attribute::default();
    while !r.done() {
        let (field, wire) = r.key()?;
        match (field, wire) {
            (1, 2) => a.name = String::from_utf8_lossy(r.bytes()?).into_owned(),
            (2, 5) => a.f = Some(f32::from_bits(r.fixed32()?)),
            (3, 0) => a.i = Some(r.varint()? as i64),
            (4, 2) => a.s = Some(r.bytes()?.to_vec()),
            (7, 5) => a.floats.push(f32::from_bits(r.fixed32()?)),
            (7, 2) => {
                let mut p = Reader::new(r.bytes()?);
                while !p.done() {
                    a.floats.push(f32::from_bits(p.fixed32()?));
                }
            }
            (8, 0) => a.ints.push(r.varint()? as i64),
            (8, 2) => {
                let mut p = Reader::new(r.bytes()?);
                while !p.done() {
                    a.ints.push(p.varint()? as i64);
                }
            }
            (9, 2) => a.strings.push(r.bytes()?.to_vec()),
            (_, w) => r.skip(w)?,
        }
    }
    Ok(a)
}

struct Node {
    op_type: String,
    domain: String,
    attributes: Vec<Attribute>,
}

fn parse_node(buf: &[u8]) -> Result<Node, String> {
    let mut r = Reader::new(buf);
    let mut n = Node { op_type: String::new(), domain: String::new(), attributes: Vec::new() };
    while !r.done() {
        let (field, wire) = r.key()?;
        match (field, wire) {
            (4, 2) => n.op_type = String::from_utf8_lossy(r.bytes()?).into_owned(),
            (7, 2) => n.domain = String::from_utf8_lossy(r.bytes()?).into_owned(),
            (5, 2) => n.attributes.push(parse_attribute(r.bytes()?)?),
            (_, w) => r.skip(w)?,
        }
    }
    Ok(n)
}

fn model_nodes(model: &[u8]) -> Result<Vec<Node>, String> {
    let mut r = Reader::new(model);
    let mut nodes = Vec::new();
    while !r.done() {
        let (field, wire) = r.key()?;
        if (field, wire) == (7, 2) {
            let mut g = Reader::new(r.bytes()?);
            while !g.done() {
                let (gf, gw) = g.key()?;
                if (gf, gw) == (1, 2) {
                    nodes.push(parse_node(g.bytes()?)?);
                } else {
                    g.skip(gw)?;
                }
            }
        } else {
            r.skip(wire)?;
        }
    }
    Ok(nodes)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Mode {
    Leq,
    Lt,
    Gte,
    Gt,
    Eq,
    Neq,
    Leaf,
}

#[derive(Clone, Copy, Debug)]
struct TreeNode {
    feature: usize,
    threshold: f32,
    mode: Mode,
    true_child: usize,
    false_child: usize,
    missing_tracks_true: bool,
    leaf_value: f32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Aggregate {
    Sum,
    Average,
    Min,
    Max,
}

pub struct TreeEnsemble {
    nodes: Vec<TreeNode>,
    roots: Vec<usize>,
    base_value: f32,
    aggregate: Aggregate,
}

impl TreeEnsemble {
    pub fn from_onnx(model: &[u8]) -> Result<TreeEnsemble, String> {
        let nodes = model_nodes(model)?;
        let node = nodes.iter().find(|n| n.op_type == "TreeEnsembleRegressor").ok_or("no TreeEnsembleRegressor node")?;
        if nodes.len() != 1 {
            return Err(format!("expected a single-node graph, found {} nodes", nodes.len()));
        }
        let _ = &node.domain;
        let attr = |name: &str| node.attributes.iter().find(|a| a.name == name);
        let ints = |name: &str| attr(name).map(|a| a.ints.clone()).unwrap_or_default();
        let floats = |name: &str| attr(name).map(|a| a.floats.clone()).unwrap_or_default();
        let tree_ids = ints("nodes_treeids");
        let node_ids = ints("nodes_nodeids");
        let feature_ids = ints("nodes_featureids");
        let values = floats("nodes_values");
        let true_ids = ints("nodes_truenodeids");
        let false_ids = ints("nodes_falsenodeids");
        let missing = ints("nodes_missing_value_tracks_true");
        let modes: Vec<Mode> = attr("nodes_modes")
            .ok_or("nodes_modes missing")?
            .strings
            .iter()
            .map(|s| match s.as_slice() {
                b"BRANCH_LEQ" => Ok(Mode::Leq),
                b"BRANCH_LT" => Ok(Mode::Lt),
                b"BRANCH_GTE" => Ok(Mode::Gte),
                b"BRANCH_GT" => Ok(Mode::Gt),
                b"BRANCH_EQ" => Ok(Mode::Eq),
                b"BRANCH_NEQ" => Ok(Mode::Neq),
                b"LEAF" => Ok(Mode::Leaf),
                other => Err(format!("unsupported node mode {}", String::from_utf8_lossy(other))),
            })
            .collect::<Result<_, _>>()?;
        let n = tree_ids.len();
        if [node_ids.len(), feature_ids.len(), values.len(), true_ids.len(), false_ids.len(), modes.len()].iter().any(|l| *l != n) {
            return Err("inconsistent node attribute lengths".into());
        }
        if let Some(t) = attr("n_targets").and_then(|a| a.i) {
            if t != 1 {
                return Err(format!("expected one target, found {t}"));
            }
        }
        if let Some(pt) = attr("post_transform").and_then(|a| a.s.clone()) {
            if pt != b"NONE" {
                return Err("unsupported post_transform".into());
            }
        }
        let aggregate = match attr("aggregate_function").and_then(|a| a.s.clone()).as_deref() {
            None | Some(b"SUM") => Aggregate::Sum,
            Some(b"AVERAGE") => Aggregate::Average,
            Some(b"MIN") => Aggregate::Min,
            Some(b"MAX") => Aggregate::Max,
            Some(other) => return Err(format!("unsupported aggregate {}", String::from_utf8_lossy(other))),
        };
        let base_values = floats("base_values");
        let base_value = match base_values.len() {
            0 => 0.0,
            1 => base_values[0],
            _ => return Err("multiple base values".into()),
        };

        let mut positions = std::collections::HashMap::with_capacity(n);
        for i in 0..n {
            positions.entry((tree_ids[i], node_ids[i])).or_insert(i);
        }
        let index_of = |tree: i64, id: i64| -> Result<usize, String> {
            positions.get(&(tree, id)).copied().ok_or_else(|| format!("missing node {tree}/{id}"))
        };
        let mut out = Vec::with_capacity(n);
        for i in 0..n {
            let leaf = modes[i] == Mode::Leaf;
            out.push(TreeNode {
                feature: feature_ids[i] as usize,
                threshold: values[i],
                mode: modes[i],
                true_child: if leaf { usize::MAX } else { index_of(tree_ids[i], true_ids[i])? },
                false_child: if leaf { usize::MAX } else { index_of(tree_ids[i], false_ids[i])? },
                missing_tracks_true: missing.get(i).copied().unwrap_or(0) != 0,
                leaf_value: 0.0,
            });
            if !leaf && out[i].feature >= FEATURE_COUNT {
                return Err("feature index out of range".into());
            }
        }
        let t_tree = ints("target_treeids");
        let t_node = ints("target_nodeids");
        let t_id = ints("target_ids");
        let t_w = floats("target_weights");
        for k in 0..t_tree.len() {
            if t_id.get(k).copied().unwrap_or(0) != 0 {
                return Err("unexpected target id".into());
            }
            let i = index_of(t_tree[k], t_node[k])?;
            out[i].leaf_value += t_w[k];
        }
        let mut roots = Vec::new();
        let mut previous: Option<i64> = None;
        for i in 0..n {
            if previous != Some(tree_ids[i]) {
                roots.push(i);
                previous = Some(tree_ids[i]);
            }
        }
        Ok(TreeEnsemble { nodes: out, roots, base_value, aggregate })
    }

    pub fn tree_count(&self) -> usize {
        self.roots.len()
    }

    fn leaf(&self, root: usize, x: &[f32; FEATURE_COUNT]) -> f32 {
        let mut i = root;
        loop {
            let node = &self.nodes[i];
            if node.mode == Mode::Leaf {
                return node.leaf_value;
            }
            let v = x[node.feature];
            let go_true = if v.is_nan() {
                node.missing_tracks_true
            } else {
                match node.mode {
                    Mode::Leq => v <= node.threshold,
                    Mode::Lt => v < node.threshold,
                    Mode::Gte => v >= node.threshold,
                    Mode::Gt => v > node.threshold,
                    Mode::Eq => v == node.threshold,
                    Mode::Neq => v != node.threshold,
                    Mode::Leaf => unreachable!(),
                }
            };
            i = if go_true { node.true_child } else { node.false_child };
        }
    }

    pub fn predict(&self, x: &[f32; FEATURE_COUNT]) -> f32 {
        let mut score = 0.0f32;
        let mut has = false;
        for &root in &self.roots {
            let v = self.leaf(root, x);
            match self.aggregate {
                Aggregate::Sum | Aggregate::Average => score += v,
                Aggregate::Min => score = if !has || v < score { v } else { score },
                Aggregate::Max => score = if !has || v > score { v } else { score },
            }
            has = true;
        }
        match self.aggregate {
            Aggregate::Average => score / self.roots.len() as f32 + self.base_value,
            _ => score + self.base_value,
        }
    }
}

pub fn companella_model() -> &'static TreeEnsemble {
    static MODEL: OnceLock<TreeEnsemble> = OnceLock::new();
    MODEL.get_or_init(|| TreeEnsemble::from_onnx(MODEL_BYTES).expect("vendored dan_model.onnx decodes"))
}

pub fn companella_raw(features: &[f64; FEATURE_COUNT]) -> f32 {
    let mut x = [0f32; FEATURE_COUNT];
    for i in 0..FEATURE_COUNT {
        x[i] = features[i] as f32;
    }
    companella_model().predict(&x)
}

#[derive(Clone, Debug, PartialEq)]
pub struct CompanellaEstimate {
    pub est_diff: String,
    pub numeric_difficulty: f64,
    pub dan_label: &'static str,
    pub variant: &'static str,
    pub confidence: f64,
    pub raw_model_output: f64,
}

impl CompanellaEstimate {
    pub fn verdict(&self) -> crate::mixed::CompanellaVerdict {
        crate::mixed::CompanellaVerdict {
            est_diff: self.est_diff.clone(),
            numeric_difficulty: Some(self.numeric_difficulty),
            numeric_difficulty_hint: None,
        }
    }
}

fn clamp(v: f64, lo: f64, hi: f64) -> f64 {
    jsmath::max(lo, jsmath::min(hi, v))
}

fn parse_prediction(raw: f64) -> (usize, &'static str) {
    if raw < MIN_DAN {
        return (0, "--");
    }
    if raw >= MAX_DAN {
        return (19, "++");
    }
    let level = clamp(jsmath::round(raw), 1.0, 20.0);
    let index = (level - 1.0) as usize;
    let offset = raw - level;
    let variant = if offset <= -0.3 {
        "--"
    } else if offset <= -0.1 {
        "-"
    } else if offset < 0.1 {
        ""
    } else if offset < 0.3 {
        "+"
    } else {
        "++"
    };
    (index, variant)
}

fn capitalize_label(label: &str) -> String {
    if label.chars().all(|c| c.is_ascii_digit()) {
        return label.to_string();
    }
    label
        .split_whitespace()
        .map(|part| {
            let mut chars = part.chars();
            let first = chars.next().map(|c| c.to_uppercase().collect::<String>()).unwrap_or_default();
            first + &chars.as_str().to_lowercase()
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn display_difficulty(label: &str, variant: &str) -> String {
    let variant_text = match variant {
        "--" => "low",
        "-" => "mid/low",
        "+" => "mid/high",
        "++" => "high",
        _ => "mid",
    };
    let capped = capitalize_label(label);
    if capped.chars().all(|c| c.is_ascii_digit()) {
        format!("Reform {capped} {variant_text}")
    } else {
        format!("{capped} {variant_text}")
    }
}

pub fn companella_features(msd: &MsdValues, interlude_star: f64, sunny_star: f64) -> [f64; FEATURE_COUNT] {
    [
        msd.overall,
        msd.stream,
        msd.jumpstream,
        msd.handstream,
        msd.stamina,
        msd.jack_speed,
        msd.chordjack,
        msd.technical,
        interlude_star,
        sunny_star,
    ]
}

pub fn companella_estimate_from_raw(raw_model_value: f64) -> Result<CompanellaEstimate, String> {
    if !raw_model_value.is_finite() {
        return Err("Companella model output is invalid".into());
    }
    let shifted = clamp(raw_model_value, MIN_DAN, MAX_DAN) + 1.0;
    let (index, variant) = parse_prediction(shifted);
    let label = DAN_LABELS[index];
    let rounded = round_fixed(shifted, 2);
    let center = jsmath::round(shifted);
    let confidence = jsmath::max(0.0, 1.0 - (shifted - center).abs() * 2.0);
    Ok(CompanellaEstimate {
        est_diff: display_difficulty(label, variant),
        numeric_difficulty: rounded,
        dan_label: label,
        variant,
        confidence,
        raw_model_output: rounded,
    })
}

pub fn classify_companella_difficulty(msd: Option<&MsdValues>, interlude_star: f64, sunny_star: f64) -> Result<CompanellaEstimate, String> {
    let msd = msd.copied().unwrap_or_default();
    let features = companella_features(&msd, interlude_star, sunny_star);
    if features.iter().any(|v| !v.is_finite()) {
        return Err("Companella requires valid MSD, InterludeSR, and Sunny SR values".into());
    }
    let raw = companella_raw(&features) as f64;
    companella_estimate_from_raw(raw)
}
