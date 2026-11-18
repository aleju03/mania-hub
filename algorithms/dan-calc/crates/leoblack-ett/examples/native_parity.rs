//! Runs MinaCalc's wasm builds and the native ones on the same charts and
//! reports every value that isn't bit for bit the same.
//!
//! cargo run --release -p leoblack-ett --features native --example native_parity -- <.osu files or folders>

use std::path::{Path, PathBuf};

use leoblack_ett::{build_rows, engine, native, EttVersion, OsuFileParser, ParseStatus, OFFICIAL_OUTPUT_ORDER};

const RATES: [f64; 6] = [0.7, 0.85, 1.0, 1.2, 1.5, 2.0];

fn charts(path: &Path, out: &mut Vec<PathBuf>) {
    if path.is_dir() {
        for entry in std::fs::read_dir(path).into_iter().flatten().flatten() {
            charts(&entry.path(), out);
        }
    } else if path.extension().is_some_and(|e| e == "osu") {
        out.push(path.to_path_buf());
    }
}

fn main() {
    let mut files = vec![];
    for arg in std::env::args().skip(1) {
        charts(Path::new(&arg), &mut files);
    }
    let (mut runs, mut differ, mut worst) = (0usize, 0usize, 0f32);
    let mut keys = std::collections::BTreeMap::new();
    for file in &files {
        let Ok(text) = std::fs::read_to_string(file) else { continue };
        let chart = OsuFileParser::parse(&text);
        if chart.status != ParseStatus::Ok || !(4.0..=18.0).contains(&chart.column_count) {
            continue;
        }
        let keycount = chart.column_count as i32;
        *keys.entry(keycount).or_insert(0) += 1;
        let versions: &[EttVersion] =
            if keycount == 4 { &[EttVersion::V0723, EttVersion::V0740, EttVersion::V0750] } else { &[EttVersion::V0740, EttVersion::V0750] };
        for tails in [false, true] {
            let (masks, times) = build_rows(&chart, tails);
            if masks.len() <= 1 {
                continue;
            }
            for &version in versions {
                for rate in RATES {
                    let wasm = engine::with_instance(version, |i| i.run(keycount, rate, 0.93, &masks, &times)).map_err(|e| e.message);
                    let native = native::run(version, keycount, rate, 0.93, &masks, &times);
                    runs += 1;
                    match (wasm, native) {
                        (Ok(w), Ok(n)) if w.iter().zip(&n).all(|(a, b)| a.to_bits() == b.to_bits()) => {}
                        (Ok(w), Ok(n)) => {
                            differ += 1;
                            let (i, d) = w.iter().zip(&n).map(|(a, b)| (a - b).abs()).enumerate().fold((0, 0f32), |m, (i, d)| if d > m.1 { (i, d) } else { m });
                            worst = worst.max(d);
                            println!("{} {} {rate}x tails={tails}: {} wasm {} native {}", file.display(), version.key(), OFFICIAL_OUTPUT_ORDER[i], w[i], n[i]);
                        }
                        (w, n) => {
                            differ += 1;
                            println!("{} {} {rate}x tails={tails}: wasm {:?} native {:?}", file.display(), version.key(), w.err(), n.err());
                        }
                    }
                }
            }
        }
    }
    println!("{} charts {keys:?}, {runs} runs, {differ} differ, largest difference {worst}", files.len());
}
