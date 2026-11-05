# dan-calc

The dan calculator from [mania-tracker.com](https://mania-tracker.com) in Rust. It gives a 4K, 6K or 7K osu!mania chart's dan at any rate, the same estimate the site shows.

## Install

Add it to your `Cargo.toml`:

```toml
[dependencies]
dan-calc = { git = "https://github.com/aleju03/mania-hub", branch = "main" }
```

You only depend on `dan-calc`. The other crates in `crates/` and `../prism/crates` are the pieces it is built from, and Cargo fetches them for you. The first build takes about a minute because of wasmtime.

### Features

MinaCalc runs as wasm under wasmtime, and its builds have to be compiled to machine code before they run. The features pick when:

| Feature | When | Trade-off |
| --- | --- | --- |
| `jit` (default) | The first time each build is used | The compiler (cranelift) is in your binary, and the first estimate waits for it (~0.5 s) |
| `aot` | When the crate is built, for the target being built | No compiler in your binary (about 10 MB smaller) and no wait on first use |

```toml
[dependencies]
dan-calc = { git = "https://github.com/aleju03/mania-hub", branch = "main", default-features = false, features = ["aot"] }
```

Both give the same results. With `aot` the build script compiles for the target as such, not for the CPU of the machine building it, so a binary built in CI runs on any CPU of that target.

## Use

```rust
use dan_calc::{estimate, Options, PlayedOd};

let osu = std::fs::read_to_string("chart.osu")?;

let result = estimate(&osu, &Options::default())?;

let dt = estimate(&osu, &Options { rate: 1.5, ..Default::default() })?;

let hr = estimate(&osu, &Options { od: Some(PlayedOd::Hr), ..Default::default() })?;

if let Some(dan) = result.primary {
    println!("{} {:.2}", dan.display_name, dan.raw_dan);
}
```

`estimate` takes the text of a `.osu` file, not a path.

### Options

| Field | Default | Meaning |
| --- | --- | --- |
| `rate` | `1.0` | Playback rate: `1.5` for DT, `0.75` for HT, or any rate in between |
| `od` | `None` | The OD the chart was played at: `PlayedOd::Hr`, `PlayedOd::Ez` or `PlayedOd::Value(8.0)`. `None` uses the file's OD |
| `vibro_adjusted` | `false` | Rate the chart without the sections that can be played by vibro |
| `star_rating` | `None` | The chart's osu! star rating. `None` computes it from the file |

### Result

| Field | Meaning |
| --- | --- |
| `primary` | The headline dan, the one the site shows first. `None` when the chart can't be rated |
| `rice` | The rice dan, when there is one |
| `ln` | The LN dan, when there is one. Hybrid charts can have both |
| `supported` | `false` for keymodes other than 4K, 6K and 7K |
| `key_count` | The chart's keymode |
| `msd` | The chart's MSD per skillset at that rate, as `(name, value)` pairs |
| `vibro` | Which sections can be played by vibro, when any |
| `ln_ratio` | The share of notes that are long notes |

Each dan (`Dan`) has:

| Field | Example | Meaning |
| --- | --- | --- |
| `display_name` | `"zeta-"` | The dan as the site writes it |
| `label` | `"zeta"` | The dan without the `+`/`-` |
| `variant` | `Some("-")` | The `+`, `++`, `-` or `--`, if any |
| `raw_dan` | `15.75` | The dan as a number, for sorting and comparing |
| `family` | `Family::Rice` | `Rice` or `Ln` |
| `confidence` | `0.72` | How sure the estimator is, from 0 to 1 |
| `source` | `"leoblack-mixed"` | Which estimator produced it |

A file that isn't a mania chart comes back with `supported: false` and no dan, not an `Err`. `Err` means an internal error.

## Try it

```sh
git clone https://github.com/aleju03/mania-hub
cd mania-hub/algorithms/dan-calc
cargo run --release --example estimate -- path/to/chart.osu 1.2
cargo run --release --example estimate -- path/to/chart.osu 1.0 HR
```

## Crates

| Crate | What it does |
| --- | --- |
| `dan-calc` | The `estimate` function above |
| `chart-pipeline` | Picks the estimator per keymode, applies vibro detection, LN identity and the rate floor, and builds the verdict |
| `leoblack-*` | LeoBlack's estimators ported to Rust, one crate per folder of his repo: `parser` reads the `.osu` file, `rework` is his Sunny and Daniel star ratings, `estimators` has Azusa, Roxy, Mixed, Polaris and the Companella model, `patterns` is the pattern clustering, `interlude` is Interlude's star rating, and `ett` runs MinaCalc's wasm builds under wasmtime |
| `../prism/crates/*` | Shared with Prism: JavaScript-exact float math, the chart parser, chart features and vibro detection, the LN model and Prism itself |

## License

MIT. The `leoblack-*` crates are ported from [LeoBlackMT/osumania_map_analyser](https://github.com/LeoBlackMT/osumania_map_analyser) (MIT, see `LICENSE-LEOBLACK`). MinaCalc is from [Etterna](https://github.com/etternagame/etterna).
