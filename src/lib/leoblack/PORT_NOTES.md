# LeoBlack analyzer port

Vendored calculation layer from LeoBlackMT/osumania_map_analyser (the tosu overlay
"ManiaMapAnalyser by Leo_Black"), upstream commit `0b27cc8a3d1661cdb5a4e5bae314a1e15bb0c51a`
(2026-06-21). MIT, see LICENSE in this directory.

Only the UI-free calc layer is vendored (upstream `js/` minus `app/`, `debug/`,
`parser/settingsParser.js`); files are copied verbatim so upstream diffs stay easy.
`vibro.js` is the one exception: it comes from upstream `js/app/vibro.js` but has no
UI dependencies. The `.d.ts` files, this file, and the TS facades
(`src/lib/leoblack-estimator.ts`, `src/lib/leoblack-msd.ts`) are ours.

## What's here

- `parser/` - .osu text parsers (osuFileParser for estimators, patternOsuParser for patterns).
- `rework/` - JS ports of sunnyxxy's Star Rating Rebirth (`sunnyAlgorithm.js`) and
  thebagelofman's Daniel (`danielAlgorithm.js`).
- `estimator/` - dan estimators: Sunny (SR -> interval tables), Daniel, Azusa, Roxy
  (structural features + frozen linear meta-model in `roxyMetaModel.generated.js`),
  Mixed (per-chart blend of the four, the recommended default). `intervals/` maps
  Sunny SR to dan names for 4K RC (Reform), 4K LN, 6K RC/LN, 7K RC/LN.
- `patterns/` - Interlude-derived pattern analysis with LN additions; outputs
  BPM-localized clusters plus a chart category.
- `interlude/` - Interlude star rating.
- `ett/` - Etterna MinaCalc as Emscripten WASM (5 versions). Browser-targeted glue;
  in Node it needs the shims in `src/lib/leoblack-msd.ts` (createRequire/__dirname
  globals + file:// fetch with an application/wasm content type).
- `vibro.js` - vibro detection (MSD JackSpeed ratio, or Longjacks pattern clusters).

## Known quirks

- Mixed output units differ by source: Roxy/Azusa `numericDifficulty` is continuous on
  the -2..20.4 scale (Intro=-2..0, Reform 1-10, alpha=11..kappa=20, tier offset +-0.4);
  Daniel-sourced results use 11+i+t (t in [0,1)) and a "Gamma Mid" label style. The
  facade normalizes both.
- `estimator/companellaEstimator.js` (ONNX neural net, `companella/dan_model.onnx`) is
  vendored but NOT wired: it expects an onnxruntime bundle at `estimator/companella/ort/`
  which we deliberately don't vendor (79MB browser build). Wire onnxruntime-node if ever
  needed. Without it, Mixed leaves the RC half of LN-hybrid charts below 9 stars on the
  Sunny fallback (`mixedCompanellaPlan` is returned unapplied); RC and LN benchmarks are
  unaffected. Upstream's published Companella benchmark CSV is a copy of the Sunny one,
  so its real accuracy is unverified anyway.
- `estimator/intervals/4k-ln.js` has an inverted interval row ("LN 6 mid/low",
  5.160 > 5.143) upstream; harmless because interval lookup takes the first match.
- Upstream Star-Rating-Rebirth has no license file; the port here is via LeoBlack's MIT
  repo, and the algorithm itself ships in ppy/osu under MIT.
- `cvtFlag` is upstream's IN/HO note-conversion toggle (invert-to-LN / holds-off), not
  an osu!std convert flag.
- Don't try to speed up the Mixed chain by precomputing Daniel/Sunny in the facade and
  passing `precomputedDanielResult`/`precomputedSunnyResult` from outside. Mixed already
  computes Sunny once and shares it, and Roxy shares its Daniel/Azusa references
  internally - but Roxy runs everything on *canonicalized* beatmap timing
  (`canonicalizeOsuTiming`), so an externally computed Daniel sees different input and
  shifts the meta numerics on charts with unusual timing (caught as a 1-in-186 corpus
  drift, 2026-07-04). The chain has no redundant engine runs to remove; per-classify cost
  (~70ms median, ~570ms on 16k-note dan courses) is genuine algorithm work.

## Benchmark vs our labels (2026-07-03, `dan_benchmark_labels` in Turso)

`npm run dan:benchmark -- --classifier leoblack [--family ln]`, rate 1.0:

| Family | Classifier | Labeled | Exact | Base | MAE (dans) | Off by >1 dan |
|---|---|---|---|---|---|---|
| normal | leoblack | 378 | 18.3% | 64.8% | 0.41 | 6% |
| normal | aleju | 378 | 18.3% | 50.8% | 0.70 | 21% |
| ln | leoblack | 85 | 21.2% | 55.3% | 0.74 | 24% |
| ln | aleju | 85 | 63.5% | 67.1% | 1.64 (few huge misses) | 28% |

The production entry point is `src/lib/chart-classifier.ts` (`classifyChart`), which routes
4K RC to LeoBlack Mixed, 4K LN to the in-house kNN, and 6K/7K to the Sunny tables. On the
same labels it scores normal 18.3%/64.8% and ln 63.5%/67.1% (the best of both engines).

Takeaway: LeoBlack Mixed is clearly stronger on RC/normal (fewer and smaller misses);
the in-house LN kNN is clearly stronger on LN exactness (it is calibrated on these very
courses) but has rare catastrophic misses that LeoBlack avoids. LeoBlack LN error is
partly structural: its 4K LN table starts at "LN 5 mid", so LN dans 1-4 clamp to "5--".
A global re-anchor of the LN table was simulated and does not help (bias is not uniform).
Best production split: LeoBlack for RC dans, in-house LN subsystem for LN dans.

## Updating

Re-copy the same directories from upstream `js/`, keep the `.d.ts` files and this file,
and re-check the facade against upstream changes to `estDiff` label formats and the
Mixed result shape.
