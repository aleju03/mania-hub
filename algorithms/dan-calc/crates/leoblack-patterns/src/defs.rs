use crate::config::*;
use crate::primitives::{count, detect_direction, has, lowest, Direction, Mask, Prim};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum CorePattern {
    Stream,
    Chordstream,
    Jacks,
    Coordination,
    Density,
    Wildcard,
}

pub const CORE_PATTERN_LIST: [CorePattern; 6] = [
    CorePattern::Stream,
    CorePattern::Chordstream,
    CorePattern::Jacks,
    CorePattern::Coordination,
    CorePattern::Density,
    CorePattern::Wildcard,
];

impl CorePattern {
    pub fn as_str(self) -> &'static str {
        match self {
            CorePattern::Stream => "Stream",
            CorePattern::Chordstream => "Chordstream",
            CorePattern::Jacks => "Jacks",
            CorePattern::Coordination => "Coordination",
            CorePattern::Density => "Density",
            CorePattern::Wildcard => "Wildcard",
        }
    }

    pub fn rating_multiplier(self) -> f64 {
        match self {
            CorePattern::Stream => 1.0 / 3.0,
            CorePattern::Chordstream => 0.65,
            CorePattern::Jacks => 0.9,
            CorePattern::Coordination => 0.75,
            CorePattern::Density => 0.9,
            CorePattern::Wildcard => 1.0,
        }
    }

    fn is_ln_core(self) -> bool {
        matches!(self, CorePattern::Coordination | CorePattern::Density | CorePattern::Wildcard)
    }

    fn is_rc_core(self) -> bool {
        matches!(self, CorePattern::Stream | CorePattern::Chordstream | CorePattern::Jacks)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Specific {
    Rolls,
    Trills,
    Minitrills,
    Handstream,
    SplitTrill,
    Jumptrill,
    Jumpstream,
    Brackets,
    DoubleStream,
    DenseChordstream,
    LightChordstream,
    ChordRolls,
    Longjacks,
    Quadstream,
    Gluts,
    Chordjacks,
    Minijacks,
    ColumnLock,
    Release,
    Shield,
    JsDensity,
    HsDensity,
    DsDensity,
    LcsDensity,
    DcsDensity,
    Inverse,
    JackyWc,
    SpeedyWc,
}

impl Specific {
    pub fn as_str(self) -> &'static str {
        match self {
            Specific::Rolls => "Rolls",
            Specific::Trills => "Trills",
            Specific::Minitrills => "Minitrills",
            Specific::Handstream => "Handstream",
            Specific::SplitTrill => "Split Trill",
            Specific::Jumptrill => "Jumptrill",
            Specific::Jumpstream => "Jumpstream",
            Specific::Brackets => "Brackets",
            Specific::DoubleStream => "Double Stream",
            Specific::DenseChordstream => "Dense Chordstream",
            Specific::LightChordstream => "Light Chordstream",
            Specific::ChordRolls => "Chord Rolls",
            Specific::Longjacks => "Longjacks",
            Specific::Quadstream => "Quadstream",
            Specific::Gluts => "Gluts",
            Specific::Chordjacks => "Chordjacks",
            Specific::Minijacks => "Minijacks",
            Specific::ColumnLock => "Column Lock",
            Specific::Release => "Release",
            Specific::Shield => "Shield",
            Specific::JsDensity => "JS Density",
            Specific::HsDensity => "HS Density",
            Specific::DsDensity => "DS Density",
            Specific::LcsDensity => "LCS Density",
            Specific::DcsDensity => "DCS Density",
            Specific::Inverse => "Inverse",
            Specific::JackyWc => "Jacky WC",
            Specific::SpeedyWc => "Speedy WC",
        }
    }

    pub fn eval(self, xs: &[Prim]) -> u32 {
        match self {
            Specific::Rolls => stream_4k_roll(xs),
            Specific::Trills => stream_4k_trill(xs),
            Specific::Minitrills => stream_4k_minitrill(xs),
            Specific::Handstream => chordstream_4k_handstream(xs),
            Specific::SplitTrill => chordstream_4k_splittrill(xs),
            Specific::Jumptrill => chordstream_4k_jumptrill(xs),
            Specific::Jumpstream => chordstream_4k_jumpstream(xs),
            Specific::Brackets => chordstream_7k_brackets(xs),
            Specific::DoubleStream => chordstream_7k_double_streams(xs),
            Specific::DenseChordstream => chordstream_7k_dense_chordstream(xs),
            Specific::LightChordstream => chordstream_7k_light_chordstream(xs),
            Specific::ChordRolls => chordstream_7k_chord_roll(xs),
            Specific::Longjacks => jacks_longjacks(xs),
            Specific::Quadstream => jacks_4k_quadstream(xs),
            Specific::Gluts => jacks_4k_gluts(xs),
            Specific::Chordjacks => jacks_chordjacks(xs),
            Specific::Minijacks => jacks_minijacks(xs),
            Specific::ColumnLock => coordination_column_lock(xs),
            Specific::Release => coordination_release(xs),
            Specific::Shield => coordination_shield(xs),
            Specific::JsDensity => density_4k_jumpstream(xs),
            Specific::HsDensity => density_4k_handstream(xs),
            Specific::DsDensity => density_7k_double_streams(xs),
            Specific::DcsDensity => density_7k_dense_chordstream(xs),
            Specific::LcsDensity => density_7k_light_chordstream(xs),
            Specific::Inverse => density_inverse(xs),
            Specific::JackyWc => wildcard_jack(xs),
            Specific::SpeedyWc => wildcard_speed(xs),
        }
    }
}

pub fn subtype_multiplier(mode: ModeTag, specific: Specific) -> f64 {
    use Specific::*;
    let rc_base = match specific {
        Rolls | Trills | Minitrills => Some(1.0 / 3.0),
        Handstream | SplitTrill | Jumptrill | Jumpstream | Brackets | DoubleStream
        | DenseChordstream | LightChordstream | ChordRolls => Some(0.65),
        Longjacks | Quadstream | Gluts | Chordjacks | Minijacks => Some(0.9),
        _ => None,
    };
    if let Some(v) = rc_base {
        return v;
    }
    match mode {
        ModeTag::Rc => match specific {
            ColumnLock => 1.5,
            Release => 0.73,
            Shield => 0.8,
            JsDensity | HsDensity | DsDensity | LcsDensity | DcsDensity => 1.0,
            Inverse => 1.5,
            JackyWc => 0.55,
            SpeedyWc => 0.8,
            _ => unreachable!(),
        },
        ModeTag::Ln => match specific {
            ColumnLock => 1.5,
            Release => 1.0,
            Shield => 0.8,
            JsDensity | HsDensity | DsDensity | LcsDensity | DcsDensity => 0.9,
            Inverse => 1.5,
            JackyWc => 0.55,
            SpeedyWc => 0.8,
            _ => unreachable!(),
        },
        ModeTag::Hb => match specific {
            ColumnLock => 1.5,
            Release => 0.3,
            Shield => 0.8,
            JsDensity | HsDensity | DsDensity | LcsDensity | DcsDensity => 0.9,
            Inverse => 0.0,
            JackyWc => 0.65,
            SpeedyWc => 0.45,
            _ => unreachable!(),
        },
        ModeTag::Mix => match specific {
            ColumnLock => 1.5,
            Release => 0.3,
            Shield => 0.8,
            JsDensity | HsDensity | DsDensity | LcsDensity | DcsDensity => 0.9,
            Inverse => 0.0,
            JackyWc => 0.45,
            SpeedyWc => 0.45,
            _ => unreachable!(),
        },
    }
}

pub fn resolve_rating_multiplier(pattern: CorePattern, specific: Option<Specific>, mode: ModeTag) -> f64 {
    let default_multiplier = pattern.rating_multiplier();
    let mut value = match specific {
        None => default_multiplier,
        Some(s) => subtype_multiplier(mode, s),
    };
    if mode == ModeTag::Rc && pattern.is_ln_core() {
        let base = match specific {
            None => default_multiplier,
            Some(s) => subtype_multiplier(ModeTag::Mix, s),
        };
        value = base * RC_LN_CORE_SCALE;
    }
    if mode == ModeTag::Ln && pattern.is_rc_core() {
        value *= RC_CORE_LN_SCALE;
    }
    value
}

#[derive(Clone, Copy)]
pub struct Rows<const N: usize> {
    rows: [Prim; N],
    len: usize,
}

impl<const N: usize> Rows<N> {
    fn new(fill: Prim) -> Self {
        Self { rows: [fill; N], len: 0 }
    }
    fn push(&mut self, p: Prim) {
        self.rows[self.len] = p;
        self.len += 1;
    }
    pub fn as_slice(&self) -> &[Prim] {
        &self.rows[..self.len]
    }
}

fn as_head_point_row(row: &Prim, previous_head_cols: Mask) -> Prim {
    let head_cols = row.ln_heads;
    let jacks = if head_cols != 0 { count(head_cols & previous_head_cols) } else { 0 };
    let mut direction = Direction::None;
    let mut roll = false;
    if previous_head_cols != 0 && head_cols != 0 {
        (direction, roll) = detect_direction(previous_head_cols, head_cols);
    }
    Prim {
        index: row.index,
        time: row.time,
        ms_per_beat: row.ms_per_beat,
        beat_length: row.beat_length,
        notes: count(head_cols),
        jacks,
        direction,
        roll,
        keys: row.keys,
        left_hand_keys: row.left_hand_keys,
        ln_heads: row.ln_heads,
        ln_bodies: row.ln_bodies,
        ln_tails: row.ln_tails,
        normal_notes: 0,
        raw_notes: head_cols,
    }
}

fn head_rows(xs: &[Prim], n: usize) -> Rows<4> {
    let mut rows = Rows::<4>::new(xs[0]);
    let mut prev: Mask = 0;
    for row in &xs[..n.min(xs.len())] {
        let hr = as_head_point_row(row, prev);
        rows.push(hr);
        if hr.raw_notes != 0 {
            prev = hr.raw_notes;
        }
    }
    rows
}

fn is_same_hand_adjacent(col_a: i64, col_b: i64, split: i64) -> bool {
    if (col_a - col_b).abs() != 1 {
        return false;
    }
    (col_a < split) == (col_b < split)
}

pub fn jack_bpm(delta_ms: f64) -> f64 {
    if delta_ms <= 0.0 {
        return 230.0;
    }
    jsmath::min(15000.0 / delta_ms, 230.0)
}

#[inline]
fn is_ln_head_context(xs: &[Prim]) -> bool {
    !xs.is_empty() && xs[0].ln_heads != 0
}

fn has_ln_context(xs: &[Prim], window: usize) -> bool {
    xs[..window.min(xs.len())]
        .iter()
        .any(|r| r.ln_heads != 0 || r.ln_bodies != 0 || r.ln_tails != 0)
}

fn inverse_ready(xs: &[Prim]) -> bool {
    if xs.len() < 5 {
        return false;
    }
    let win = &xs[..5];
    if win.iter().any(|r| r.normal_notes != 0) {
        return false;
    }
    let max_bodies = win.iter().map(|r| count(r.ln_bodies)).max().unwrap();
    if max_bodies < INVERSE_MIN_FILLED_LANES {
        return false;
    }

    let mut gaps = [0.0f64; 4];
    let mut n = 0;
    for i in 0..win.len() - 1 {
        if win[i].ln_tails != 0 && win[i + 1].ln_heads != 0 {
            gaps[n] = win[i + 1].time - win[i].time;
            n += 1;
        }
    }
    if n < 2 {
        return false;
    }
    let gaps = &gaps[..n];
    let max = gaps.iter().copied().fold(f64::NEG_INFINITY, jsmath::max);
    let min = gaps.iter().copied().fold(f64::INFINITY, jsmath::min);
    (max - min) <= INVERSE_GAP_TOLERANCE_MS
}

pub fn core_stream(xs: &[Prim]) -> u32 {
    if xs.len() < 5 {
        return 0;
    }
    if xs[..5].iter().all(|x| x.notes == 1 && x.jacks == 0) && lowest(xs[0].raw_notes) != lowest(xs[4].raw_notes) {
        return 5;
    }
    0
}

pub fn core_jacks(xs: &[Prim]) -> u32 {
    if xs.is_empty() {
        return 0;
    }
    let x0 = &xs[0];
    if x0.jacks > 1 && x0.ms_per_beat < 2000.0 {
        1
    } else {
        0
    }
}

pub fn core_chordstream(xs: &[Prim]) -> u32 {
    if xs.len() < 4 {
        return 0;
    }
    let (a, b, c, d) = (&xs[0], &xs[1], &xs[2], &xs[3]);
    if a.notes > 1 && a.jacks == 0 && b.jacks == 0 && c.jacks == 0 && d.jacks == 0 && (b.notes > 1 || c.notes > 1 || d.notes > 1) {
        return 4;
    }
    0
}

pub fn core_coordination(xs: &[Prim]) -> u32 {
    if xs.is_empty() {
        return 0;
    }
    let a = &xs[0];
    if a.ln_heads != 0 || a.ln_bodies != 0 || a.ln_tails != 0 {
        1
    } else {
        0
    }
}

pub fn core_density(xs: &[Prim]) -> u32 {
    if is_ln_head_context(xs) {
        1
    } else {
        0
    }
}

pub fn core_wildcard(xs: &[Prim]) -> u32 {
    core_density(xs)
}

pub fn jacks_chordjacks(xs: &[Prim]) -> u32 {
    if xs.len() < 2 {
        return 0;
    }
    let (a, b) = (&xs[0], &xs[1]);
    if a.notes > 2 && b.notes > 1 && b.jacks >= 1 && ((b.notes < a.notes) || (b.jacks < b.notes)) {
        return 2;
    }
    0
}

pub fn jacks_minijacks(xs: &[Prim]) -> u32 {
    if xs.len() < 2 {
        return 0;
    }
    if xs[0].jacks > 0 && xs[1].jacks == 0 {
        2
    } else {
        0
    }
}

pub fn jacks_longjacks(xs: &[Prim]) -> u32 {
    if xs.len() < 5 {
        return 0;
    }
    let w = &xs[..5];
    if w.iter().all(|x| x.jacks > 0) {
        let common = w.iter().fold(Mask::MAX, |acc, x| acc & x.raw_notes);
        if common != 0 {
            return 5;
        }
    }
    0
}

pub fn jacks_4k_quadstream(xs: &[Prim]) -> u32 {
    if xs.len() < 4 {
        return 0;
    }
    if xs[0].notes == 4 && xs[2].jacks == 0 && xs[3].jacks == 0 {
        4
    } else {
        0
    }
}

pub fn jacks_4k_gluts(xs: &[Prim]) -> u32 {
    if xs.len() < 3 {
        return 0;
    }
    let (a, b, c) = (&xs[0], &xs[1], &xs[2]);
    if b.jacks == 1 && c.jacks == 1 {
        if a.raw_notes & b.raw_notes & c.raw_notes != 0 {
            return 0;
        }
        return 3;
    }
    0
}

pub fn chordstream_4k_handstream(xs: &[Prim]) -> u32 {
    if xs.len() < 4 {
        return 0;
    }
    let (a, b, c, d) = (&xs[0], &xs[1], &xs[2], &xs[3]);
    if a.notes == 3 && a.jacks == 0 && b.jacks == 0 && c.jacks == 0 && d.jacks == 0 {
        4
    } else {
        0
    }
}

pub fn chordstream_4k_jumpstream(xs: &[Prim]) -> u32 {
    if xs.len() < 4 {
        return 0;
    }
    let (a, b, c, d) = (&xs[0], &xs[1], &xs[2], &xs[3]);
    if a.notes == 2 && a.jacks == 0 && b.notes == 1 && b.jacks == 0 && c.jacks == 0 && d.jacks == 0 && c.notes < 3 && d.notes < 3 {
        return 4;
    }
    0
}

pub fn chordstream_4k_jumptrill(xs: &[Prim]) -> u32 {
    if xs.len() < 4 {
        return 0;
    }
    let (a, b, c, d) = (&xs[0], &xs[1], &xs[2], &xs[3]);
    if a.notes == 2 && b.notes == 2 && c.notes == 2 && d.notes == 2 && b.roll && c.roll && d.roll {
        4
    } else {
        0
    }
}

pub fn chordstream_4k_splittrill(xs: &[Prim]) -> u32 {
    if xs.len() < 3 {
        return 0;
    }
    let (a, b, c) = (&xs[0], &xs[1], &xs[2]);
    if a.notes == 2 && b.notes == 2 && c.notes == 2 && b.jacks == 0 && c.jacks == 0 && !b.roll && !c.roll {
        3
    } else {
        0
    }
}

pub fn stream_4k_roll(xs: &[Prim]) -> u32 {
    if xs.len() < 3 {
        return 0;
    }
    let (a, b, c) = (&xs[0], &xs[1], &xs[2]);
    if a.notes == 1 && b.notes == 1 && c.notes == 1 {
        let left = a.direction == Direction::Left && b.direction == Direction::Left && c.direction == Direction::Left;
        let right = a.direction == Direction::Right && b.direction == Direction::Right && c.direction == Direction::Right;
        if left || right {
            return 3;
        }
    }
    0
}

pub fn stream_4k_trill(xs: &[Prim]) -> u32 {
    if xs.len() < 4 {
        return 0;
    }
    let (a, b, c, d) = (&xs[0], &xs[1], &xs[2], &xs[3]);
    if b.jacks == 0 && c.jacks == 0 && d.jacks == 0 && a.raw_notes == c.raw_notes && b.raw_notes == d.raw_notes {
        return 4;
    }
    0
}

pub fn stream_4k_minitrill(xs: &[Prim]) -> u32 {
    if xs.len() < 4 {
        return 0;
    }
    let (a, b, c, d) = (&xs[0], &xs[1], &xs[2], &xs[3]);
    if b.jacks == 0 && c.jacks == 0 && a.raw_notes == c.raw_notes && b.raw_notes != d.raw_notes {
        return 4;
    }
    0
}

pub fn chordstream_7k_double_streams(xs: &[Prim]) -> u32 {
    if xs.len() < 2 {
        return 0;
    }
    let (a, b) = (&xs[0], &xs[1]);
    if a.notes == 2 && b.notes == 2 && b.jacks == 0 && !b.roll {
        2
    } else {
        0
    }
}

pub fn chordstream_7k_dense_chordstream(xs: &[Prim]) -> u32 {
    if xs.len() < 2 {
        return 0;
    }
    let (a, b) = (&xs[0], &xs[1]);
    if a.notes > 1 && b.notes > 1 && b.jacks == 0 {
        2
    } else {
        0
    }
}

pub fn chordstream_7k_light_chordstream(xs: &[Prim]) -> u32 {
    if xs.len() < 2 {
        return 0;
    }
    let (a, b) = (&xs[0], &xs[1]);
    if a.notes > 1 && b.notes == 1 && b.jacks == 0 {
        2
    } else {
        0
    }
}

pub fn chordstream_7k_chord_roll(xs: &[Prim]) -> u32 {
    if xs.len() < 3 {
        return 0;
    }
    let (a, b, c) = (&xs[0], &xs[1], &xs[2]);
    if a.notes > 1 && b.notes > 1 && c.notes > 1 && b.roll && c.roll {
        if (b.direction == Direction::Left && c.direction == Direction::Left)
            || (b.direction == Direction::Right && c.direction == Direction::Right)
        {
            return 3;
        }
    }
    0
}

pub fn chordstream_7k_brackets(xs: &[Prim]) -> u32 {
    if xs.len() < 3 {
        return 0;
    }
    let (a, b, c) = (&xs[0], &xs[1], &xs[2]);
    if a.notes > 2 && b.notes > 2 && c.notes > 2 && !b.roll && !c.roll && b.jacks == 0 && c.jacks == 0 && (a.notes + b.notes + c.notes) > 9 {
        return 3;
    }
    0
}

pub fn coordination_column_lock(xs: &[Prim]) -> u32 {
    if xs.len() < 3 {
        return 0;
    }
    let split = xs[0].left_hand_keys as i64;
    if xs[0].ln_heads == 0 {
        return 0;
    }
    let ln_col = lowest(xs[0].ln_heads);
    let keys = xs[0].keys as i64;

    for adj in [ln_col - 1, ln_col + 1] {
        if !(adj >= 0 && adj < keys && is_same_hand_adjacent(ln_col, adj, split)) {
            continue;
        }
        let mut hits = [0.0f64; 8];
        let mut n = 0;
        for row in &xs[..8.min(xs.len())] {
            if has(row.ln_bodies, ln_col) && has(row.normal_notes, adj) {
                hits[n] = row.time;
                n += 1;
            }
        }
        if n < 3 {
            continue;
        }
        let mut max = f64::NEG_INFINITY;
        for i in 0..n - 1 {
            max = jsmath::max(max, jack_bpm(hits[i + 1] - hits[i]));
        }
        if max >= JACKY_MIN_BPM {
            return 3;
        }
    }
    0
}

pub fn coordination_shield(xs: &[Prim]) -> u32 {
    if xs.len() < 2 {
        return 0;
    }
    let (a, b) = (&xs[0], &xs[1]);
    let dt = b.time - a.time;
    let beat_limit = b.beat_length * SHIELD_MAX_BEAT_RATIO;
    if dt < 0.0 || dt > beat_limit {
        return 0;
    }
    if a.normal_notes & b.ln_heads != 0 {
        return 2;
    }
    if a.ln_tails & b.normal_notes != 0 {
        return 2;
    }
    0
}

pub fn coordination_release(xs: &[Prim]) -> u32 {
    if xs.len() < RELEASE_MIN_TAIL_ROWS {
        return 0;
    }
    if coordination_shield(xs) != 0 {
        return 0;
    }
    if inverse_ready(xs) {
        return 0;
    }
    if wildcard_jack(xs) != 0 {
        return 0;
    }

    let mut picked: [&Prim; RELEASE_SCAN_ROWS] = [&xs[0]; RELEASE_SCAN_ROWS];
    let mut n_picked = 0;
    for r in &xs[..RELEASE_SCAN_ROWS.min(xs.len())] {
        if count(r.ln_tails) == 1 {
            picked[n_picked] = r;
            n_picked += 1;
        }
    }
    if n_picked < RELEASE_MIN_TAIL_ROWS {
        return 0;
    }

    let use_rows = RELEASE_FULL_MATCH_ROWS.min(n_picked);
    let effective = if use_rows > 1 { use_rows - 1 } else { 0 };
    if effective < RELEASE_ROLL_POINTS {
        return 0;
    }
    let tail = |i: usize| lowest(picked[i].ln_tails);
    let a = tail(1);
    let (b, dt) = if effective > 1 { (tail(2), picked[2].time - picked[1].time) } else { (a, 0.0) };
    let matched = a != b && dt > 0.0;

    if matched {
        if use_rows >= RELEASE_FULL_MATCH_ROWS {
            5
        } else {
            4
        }
    } else {
        0
    }
}

pub fn density_4k_jumpstream(xs: &[Prim]) -> u32 {
    if xs.len() < 4 || !is_ln_head_context(xs) {
        return 0;
    }
    if chordstream_4k_jumpstream(head_rows(xs, 4).as_slice()) != 0 {
        4
    } else {
        0
    }
}

pub fn density_4k_handstream(xs: &[Prim]) -> u32 {
    if xs.len() < 4 || !is_ln_head_context(xs) {
        return 0;
    }
    if chordstream_4k_handstream(head_rows(xs, 4).as_slice()) != 0 {
        4
    } else {
        0
    }
}

pub fn density_inverse(xs: &[Prim]) -> u32 {
    if inverse_ready(xs) {
        5
    } else {
        0
    }
}

pub fn density_7k_double_streams(xs: &[Prim]) -> u32 {
    if xs.len() < 2 || !is_ln_head_context(xs) {
        return 0;
    }
    if chordstream_7k_double_streams(head_rows(xs, 2).as_slice()) != 0 {
        2
    } else {
        0
    }
}

pub fn density_7k_dense_chordstream(xs: &[Prim]) -> u32 {
    if xs.len() < 2 || !is_ln_head_context(xs) {
        return 0;
    }
    if chordstream_7k_dense_chordstream(head_rows(xs, 2).as_slice()) != 0 {
        2
    } else {
        0
    }
}

pub fn density_7k_light_chordstream(xs: &[Prim]) -> u32 {
    if xs.len() < 2 || !is_ln_head_context(xs) {
        return 0;
    }
    if chordstream_7k_light_chordstream(head_rows(xs, 2).as_slice()) != 0 {
        2
    } else {
        0
    }
}

pub fn wildcard_jack(xs: &[Prim]) -> u32 {
    if xs.len() < 2 || !has_ln_context(xs, JACKY_CONTEXT_WINDOW) {
        return 0;
    }

    let window = std::cmp::max(4, JACKY_CONTEXT_WINDOW);
    let mut rows = Rows::<6>::new(xs[0]);
    for r in &xs[..window.min(xs.len())] {
        if r.notes > 0 {
            rows.push(*r);
        }
    }
    let rows = rows.as_slice();
    if rows.len() < 2 {
        return 0;
    }

    if jacks_chordjacks(rows) != 0 || jacks_minijacks(rows) != 0 {
        return 4;
    }

    let check_rows = &rows[..4.min(rows.len())];
    let jack_rows = check_rows.iter().filter(|r| r.jacks > 0).count();
    if jack_rows >= 2 && check_rows.iter().any(|r| r.notes >= 2) {
        return 3;
    }

    let fastest_mspb = check_rows.iter().fold(f64::INFINITY, |acc, r| jsmath::min(acc, r.ms_per_beat));
    if jack_rows >= 2 && fastest_mspb <= JACKY_FALLBACK_MAX_MSPB {
        return 3;
    }
    0
}

pub fn wildcard_speed(xs: &[Prim]) -> u32 {
    if xs.len() < 2 || !has_ln_context(xs, 4) {
        return 0;
    }

    let rows = head_rows(xs, 4.min(xs.len()));
    let rows = rows.as_slice();
    if xs[0].keys == 4 {
        if rows.len() >= 3 && stream_4k_roll(&rows[..3]) != 0 {
            return 3;
        }
        if rows.len() >= 2 {
            let same_dir = rows[0].direction.is_left_or_right() && rows[0].direction == rows[1].direction;
            if same_dir || rows[0].ms_per_beat <= 180.0 {
                return 3;
            }
        }
    } else {
        if rows.len() >= 3 && chordstream_7k_chord_roll(&rows[..3]) != 0 {
            return 3;
        }
        if rows.len() >= 2 {
            let cond = rows[0].notes >= 2
                && rows[1].notes >= 2
                && rows[0].direction == rows[1].direction
                && rows[0].direction.is_left_or_right();
            if cond || rows[0].ms_per_beat <= 170.0 {
                return 3;
            }
        }
    }
    0
}

pub struct SpecificPatterns {
    pub stream: &'static [Specific],
    pub chordstream: &'static [Specific],
    pub jack: &'static [Specific],
    pub coordination: &'static [Specific],
    pub density: &'static [Specific],
    pub wildcard: &'static [Specific],
}

use Specific as S;
const COORDINATION: &[Specific] = &[S::ColumnLock, S::Shield, S::Release];
const WILDCARD: &[Specific] = &[S::SpeedyWc, S::JackyWc];

pub const SPECIFIC_4K: SpecificPatterns = SpecificPatterns {
    stream: &[S::Rolls, S::Trills, S::Minitrills],
    chordstream: &[S::Handstream, S::SplitTrill, S::Jumptrill, S::Jumpstream],
    jack: &[S::Longjacks, S::Quadstream, S::Gluts, S::Chordjacks, S::Minijacks],
    coordination: COORDINATION,
    density: &[S::Inverse, S::JsDensity, S::HsDensity],
    wildcard: WILDCARD,
};

pub const SPECIFIC_7K: SpecificPatterns = SpecificPatterns {
    stream: &[],
    chordstream: &[S::Brackets, S::DoubleStream, S::DenseChordstream, S::LightChordstream],
    jack: &[S::Longjacks, S::Chordjacks, S::Minijacks],
    coordination: COORDINATION,
    density: &[S::Inverse, S::DsDensity, S::DcsDensity, S::LcsDensity],
    wildcard: WILDCARD,
};

pub const SPECIFIC_OTHER: SpecificPatterns = SpecificPatterns {
    stream: &[],
    chordstream: &[S::ChordRolls, S::DoubleStream, S::DenseChordstream, S::LightChordstream],
    jack: &[S::Longjacks, S::Chordjacks, S::Minijacks],
    coordination: COORDINATION,
    density: &[S::Inverse, S::DsDensity, S::DcsDensity, S::LcsDensity],
    wildcard: WILDCARD,
};
