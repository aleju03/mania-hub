# Native MinaCalc

The `native` feature builds MinaCalc 0.72.3, 0.74.0 and 0.75.0 from this folder instead of running the wasm builds in `../minacalc`. It gives the same numbers as those builds, bit for bit (`cargo run --release -p leoblack-ett --features native --example native_parity -- <charts>` compares the two).

`0.72.3/`, `0.74.0/` and `0.75.0/` are Etterna's `src/Etterna/MinaCalc` at the `v0.72.3`, `v0.74.0` and `v0.75.0` tags, with `Models/NoteData/NoteDataStructures.h` from the same tags and the CMake files left out. Each `minacalc_*.cpp` compiles one of them inside its own namespace, so the three can be linked together, and `compute.h` gives it the C function `native.rs` calls.

The changes to Etterna's files are marked `dan-calc`, apart from the math calls. They make the native builds do what the wasm ones do:

- The skill cap is 100 instead of 40, as in the wasm builds, which were patched the same way.
- `fastsqrt` is an exact `x * (1 / sqrt(x))`. Emscripten turns `_mm_rsqrt_ss` into that, while the SSE instruction is an estimate that differs between CPUs.
- The parts that read and write Etterna's parameter files are left out, as `STANDALONE_CALC` intends but doesn't fully do at these tags.
- In 0.72.3, the pattern mod object is made for each run. Etterna keeps it in a `thread_local` that holds on to the first `Calc` it saw, which the wasm builds never notice because their memory is reset before every run.
- `pow`, `powf`, `log`, `log2`, `exp2`, `erf`, `erfc` and `abs` are called as `mcm::` (`mina_math.h`). That picks the overload emscripten's libc++ picks (libstdc++ turns `abs` of a float into the integer `abs`) and computes it with musl's code, as the wasm builds do, rather than with whatever libm the platform has.
- The most frequent value in a Chordjack interval comes out of `mcm::libcxx_int_map` (`libcxx_map.h`), which iterates in libc++'s `unordered_map` order. Ties go to whichever comes first, so the order changes the results.

`musl/` is the part of musl 1.2.5's `src/math` these need. It's compiled as C++ inside namespace `musl` so it can't clash with the platform's libm. `libm.h` and `features.h` stand in for musl's internal headers, and two data structs list their fields in the order their initializers use, which C++ needs. Those changes are marked `dan-calc` too.

Etterna is MIT licensed (`LICENSE-ETTERNA`), and so is musl (`musl/COPYRIGHT`).
