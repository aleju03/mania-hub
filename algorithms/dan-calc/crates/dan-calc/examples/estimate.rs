use dan_calc::{estimate, Options, PlayedOd};

fn main() {
    let mut args = std::env::args().skip(1);
    let Some(path) = args.next() else {
        eprintln!("usage: estimate <chart.osu> [rate] [HR|EZ|<od>]");
        std::process::exit(2);
    };
    let rate = args.next().map_or(1.0, |r| r.parse().expect("rate"));
    let od = args.next().map(|o| match o.as_str() {
        "HR" => PlayedOd::Hr,
        "EZ" => PlayedOd::Ez,
        v => PlayedOd::Value(v.parse().expect("od")),
    });
    let osu = std::fs::read_to_string(&path).expect("read chart");
    let result = estimate(&osu, &Options { rate, od, ..Options::default() }).expect("estimate");
    println!("{}K, supported: {}", result.key_count, result.supported);
    for (name, dan) in [("primary", &result.primary), ("rice", &result.rice), ("ln", &result.ln)] {
        if let Some(d) = dan {
            println!("{name}: {} ({:.2}, confidence {:.2}, {})", d.display_name, d.raw_dan, d.confidence, d.source);
        }
    }
    if let Some(msd) = &result.msd {
        let line: Vec<String> = msd.iter().map(|(k, v)| format!("{k} {v:.2}")).collect();
        println!("msd: {}", line.join(", "));
    }
}
