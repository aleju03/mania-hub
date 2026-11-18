//! With the `aot` feature, compiles MinaCalc's wasm builds for the target into
//! `OUT_DIR`, where `engine.rs` includes them. With `native`, builds MinaCalc's
//! C++ from `native/`.

fn main() {
    println!("cargo::rerun-if-changed=build.rs");
    #[cfg(feature = "native")]
    native::build();
    #[cfg(feature = "aot")]
    aot::precompile();
}

#[cfg(feature = "native")]
mod native {
    use std::{env, fs, path::Path};

    pub fn build() {
        println!("cargo::rerun-if-changed=native");
        let dir = Path::new(&env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR")).join("native");
        let out = Path::new(&env::var("OUT_DIR").expect("OUT_DIR")).to_path_buf();
        let mut build = cc::Build::new();
        build
            .cpp(true)
            .std("c++20")
            .define("STANDALONE_CALC", None)
            .define("NDEBUG", None)
            .warnings(false)
            // the same float math as the wasm builds, which have no fused multiply-add
            .flag_if_supported("-ffp-contract=off")
            .flag_if_supported("/fp:precise");
        for version in ["0723", "0740", "0750"] {
            build.file(dir.join(format!("minacalc_{version}.cpp")));
        }
        // musl's C, compiled as C++ in its own namespace so it can't clash with
        // the platform's libm: one file each, as they share static helper names
        for entry in fs::read_dir(dir.join("musl")).expect("native/musl") {
            let path = entry.expect("native/musl entry").path();
            if path.extension().is_none_or(|e| e != "c") {
                continue;
            }
            let stem = path.file_stem().unwrap().to_string_lossy();
            let unit = out.join(format!("musl_{stem}.cpp"));
            let source = path.to_string_lossy().replace('\\', "/");
            let text = format!(
                "#include <cstdint>\n#include <cstring>\n#include <cmath>\n#include <math.h>\n#include <stdint.h>\nnamespace musl {{\n#include \"{source}\"\n}}\n"
            );
            if fs::read_to_string(&unit).ok().as_deref() != Some(text.as_str()) {
                fs::write(&unit, text).expect("write musl unit");
            }
            build.file(unit);
        }
        build.compile("minacalc");
    }
}

#[cfg(feature = "aot")]
mod aot {
    use std::{env, fs, path::Path};

    use wasmtime_build::{Config, Engine, OptLevel};

    pub fn precompile() {
        println!("cargo::rerun-if-changed=minacalc");
        let target = env::var("TARGET").expect("TARGET");
        let out = env::var("OUT_DIR").expect("OUT_DIR");
        let mut config = Config::new();
        // For the target as such, not for the CPU of the machine building it:
        // otherwise it could use instructions a user's CPU doesn't have.
        config.target(&target).unwrap_or_else(|e| panic!("wasmtime can't compile for {target}: {e}"));
        config.cranelift_opt_level(OptLevel::Speed);
        let engine = Engine::new(&config).expect("wasmtime engine");

        for entry in fs::read_dir("minacalc").expect("minacalc folder") {
            let path = entry.expect("minacalc entry").path();
            if path.extension().is_none_or(|e| e != "wasm") {
                continue;
            }
            // Not included without their feature (see `engine.rs`).
            let legacy = ["minaclac-68.0-unofficial.wasm", "minaclac-70.0.wasm"];
            if !cfg!(feature = "legacy-builds") && path.file_name().is_some_and(|n| legacy.iter().any(|l| n == *l)) {
                continue;
            }
            let wasm = fs::read(&path).expect("read wasm");
            let compiled = engine.precompile_module(&wasm).unwrap_or_else(|e| panic!("compile {path:?}: {e}"));
            let name = path.with_extension("cwasm");
            fs::write(Path::new(&out).join(name.file_name().unwrap()), compiled).expect("write cwasm");
        }
    }
}
