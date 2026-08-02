# LeoBlack analyzer port

Vendored calculation layer from LeoBlackMT/osumania_map_analyser (the tosu overlay
"ManiaMapAnalyser by Leo_Black"), upstream commit `0b27cc8a3d1661cdb5a4e5bae314a1e15bb0c51a`
(2026-06-21). MIT, see LICENSE in this directory.

Upstream reviewed through `c96cb8d` (2026-07-31). Everything since the pin that
touches the calc layer is accounted for: PR #38's 4K LN interval fix was taken in
`a8fcb95`, and the three Companella/onnxruntime commits (`40017b5`, `36edb44`,
`c96cb8d`) are covered under "Companella" below. Upstream's other post-pin commits
are `app/` UI, which we do not vendor.

Only the UI-free calc layer is vendored (upstream `js/` minus `app/`, `debug/`,
`parser/settingsParser.js`); files are copied verbatim so upstream diffs stay easy.
`vibro.js` is the one exception: it comes from upstream `js/app/vibro.js` but has no
UI dependencies. The `.d.ts` files, this file, the `ett/` harness (`calc.js`,
`versions/index.js`), and the TS facades (`src/lib/leoblack-estimator.ts`,
`src/lib/chart-classifier.ts`) are ours.

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
- `ett/` - Etterna MinaCalc as Emscripten WASM (5 versions). The glue is
  browser-targeted, but `calc.js` is isomorphic: in Node it reads the wasm bytes
  itself (`wasmBinary` override) and defines the CommonJS globals the glue's
  environment sniffing dereferences at factory time.
- `vibro.js` - vibro detection (MSD JackSpeed ratio, or Longjacks pattern clusters).

## Known quirks

- Mixed output units differ by source: Roxy/Azusa `numericDifficulty` is continuous on
  the -2..20.4 scale (Intro=-2..0, Reform 1-10, alpha=11..kappa=20, tier offset +-0.4);
  Daniel-sourced results use 11+i+t (t in [0,1)) and a "Gamma Mid" label style. The
  facade normalizes both.
- `ett/versions/minaclac-*.js` still dereference `__dirname`; upstream `40017b5` rewrote
  those glue files to `import.meta.url` instead. We solve the same problem one layer up in
  `ett/calc.js` (which defines the CommonJS globals and hands over `wasmBinary`), so the
  glue stays byte-identical to the pin. Re-copying the glue from upstream is safe and just
  makes our shim redundant.
- `estimator/intervals/4k-ln.js` used to carry an inverted interval row ("LN 6 mid/low",
  5.160 > 5.143); upstream fixed it in PR #38 and we took it in `a8fcb95`.
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

## Companella (wired 2026-08-02)

`estimator/companellaEstimator.js` is LeoBlack's ONNX dan model: a 10-feature MLP over
the eight MinaCalc skillsets plus Interlude SR and Sunny SR, weights in
`companella/dan_model.onnx` (300KB, vendored). Mixed asks for it on the RC half of 4K
LN-hybrid charts under 9 Sunny stars and returns `mixedCompanellaPlan` unapplied when it
is missing. Entry points are `src/lib/companella.ts` and `live-backend/src/dan/companella.ts`.

- **Runtime is `onnxruntime-web` from npm, not upstream's vendored `estimator/companella/ort/`.**
  Upstream slimmed that dir from 78MB to 11.9MB in `36edb44`/`c96cb8d`; we still don't want
  binaries in git. `getOrtNamespace()` is the only divergence from the verbatim copy: it
  picks the package's Node entry under Node (the browser bundles reach for fetch/blob/location)
  and `onnxruntime-web/wasm` in browsers, which is the same wasm-only build upstream settled
  on. Node also gets the model as bytes rather than a `file://` URL. Threads are pinned to 1
  because the site sends no COOP/COEP.
- **Async by nature.** `classifyChart` stays synchronous; `classifyChartWithCompanella`
  wraps it and re-classifies with `input.companella` when `companellaPending` is set. That
  second classify only runs on the affected slice. Callers with MSD already in hand should
  pass `msdValues` to skip a redundant MinaCalc pass.
- **Feed it raw MSD, never the LN-tail blend.** The model was trained on stock MinaCalc
  output, so `LN_TAIL_BLEND_BY_KEYMODE` values would push every hold-heavy chart off the
  distribution it learned.
- **Upstream's pre-`40017b5` Companella numbers were fiction.** Their own fix commit says
  it "previously always fell back to Sunny (746/746 rows identical); now runs real ONNX
  inference (743/746 rows differ)", which confirms the note that used to live here about
  their published CSV being a copy of the Sunny one. Their current CSV is the first real one.
- **Blast radius, measured on the local cached corpus (2026-08-02, 499 4K charts under 9
  stars):** 18.8% ask for Companella. On those, the RC half moves on every single chart,
  mean +0.39 dans, mean absolute 0.98, range -1.54 to +4.93. It mostly pushes the low end
  up (charts sitting at "1--" land around "2++"). Cost is ~79ms per refined chart (MinaCalc
  + Interlude SR + inference + the second classify).
- The browser build emits the 13.5MB ort wasm as its own lazy asset, reachable only through
  `companellaEstimator`; it never enters the entry graph. In practice only `/admin/dan-classifier`
  loads it.
- **`scripts/prune-onnxruntime-web.mjs` runs on postinstall in both packages** and deletes the
  three wasm backends we never load (asyncify, jsep, jspi) plus the source maps: 133MB -> 49MB
  on disk, 83MB reclaimed per install. Only binaries go, never the `.mjs` loaders. If Companella
  is ever switched to WebGPU/JSEP, JSPI, or asyncify, drop the matching entry from `UNUSED_WASM`
  first or inference will fail at runtime with a missing-file error. The script is idempotent and
  always exits 0, so it cannot break an install.
- **Stored analyses are corrected by a targeted sweep, not a version bump.**
  `COMPANELLA_RECOMPUTE_JOB` in `live-backend/src/features/chart-analysis.ts` is boot-seeded like
  its five siblings and re-analyzes the 4K charts whose stored RC verdict predates the wiring
  (17,976 of 109,188 ready rows at time of writing). Its SQL predicate is exact: Mixed plans
  Companella iff `lnRatio > 0.15` (i.e. `modeTagFromLnRatio` is not "RC"), `sunnySr < 9`, and
  4K, all of which live in `classification_json`. Verified against `companellaPending` over 500
  stored rows with zero false negatives. Bumping `CHART_ANALYSIS_VERSION` instead would hide all
  ~122k rows at once, blanking analysis-derived columns in `/maps` and opening farm-helper's DT
  feasibility gate (`readDtRateMsd` finds no row and the chart passes the gate) for as long as the
  backfill took. The dan-estimate cache versions did move, because those recompute lazily per
  request with no gate behind them.
- Runtime cost on the backend, measured 2026-08-02: the dynamic import alone is +2MB, and the
  first chart that actually reaches Companella instantiates the wasm runtime for +70MB RSS
  (~148ms cold, 0.04ms warm afterwards). Over 7500 inferences RSS settles around +100MB with
  the growth rate decaying, i.e. a working-set ceiling rather than a leak.

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

### Companella's effect on these labels (2026-08-02)

`npm run dan:benchmark -- --family {normal,ln} [--no-companella] --json`, rate 1.0. Wiring
Companella barely registers: normal moves base 65.18% -> 65.45% with exact unchanged at
18.06%, and ln is bit-identical. Only 2 of 381 normal rows change at all (1 wrong -> base,
1 base -> base) and 0 of 85 ln rows do.

That is a property of the corpus, not evidence Companella is inert. These labels are dan
courses, which are near-pure RC or near-pure LN, so they almost never hit the sub-9-star
4K LN-hybrid slice Companella owns; and the ln family reports the LN half as its primary
verdict, which Companella never touches. The 18.8%-of-charts / ~1-dan-average effect above
is measured on the general cached map corpus, where we have no labels. So: keep this
benchmark as the RC/LN regression guard it already is, and do not read it as a verdict on
Companella either way. Judging that properly needs labels on ordinary hybrid maps.

## Backend copy

`live-backend/vendor/leoblack` is a verbatim copy of this tree (plus this file), used by
the backend chart-analysis job and dan estimates via the ported facades in
`live-backend/src/dan/{chart-classifier,leoblack-estimator,msd}.ts`. When this tree or the
frontend facades change, re-copy the vendor dir and re-port the facades. `ett/calc.js` is
isomorphic: in Node it feeds the emscripten glue the wasm bytes directly and defines the
CommonJS globals the glue reads, so the same files serve the browser and the backend.

## Updating

Re-copy the same directories from upstream `js/`, keep the `.d.ts` files and this file,
and re-check the facade against upstream changes to `estDiff` label formats and the
Mixed result shape.
