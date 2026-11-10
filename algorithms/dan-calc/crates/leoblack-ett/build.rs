//! With the `aot` feature, compiles MinaCalc's wasm builds for the target into
//! `OUT_DIR`, where `engine.rs` includes them.

fn main() {
    println!("cargo::rerun-if-changed=build.rs");
    println!("cargo::rerun-if-changed=minacalc");
    #[cfg(feature = "aot")]
    aot::precompile();
}

#[cfg(feature = "aot")]
mod aot {
    use std::{env, fs, path::Path};

    use wasmtime::{Config, Engine, OptLevel};

    pub fn precompile() {
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
