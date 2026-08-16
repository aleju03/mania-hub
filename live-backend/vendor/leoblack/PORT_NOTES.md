# LeoBlack analyzer port

Vendored calculation layer from LeoBlackMT/osumania_map_analyser (the tosu overlay
"ManiaMapAnalyser by Leo_Black"), upstream commit `261e76feb16479e412b166d6a74cd4ffbda8a24f`
(2026-08-10, the PR #48 merge, which also contains PR #47). MIT, see LICENSE in this
directory.

Upstream reviewed through `1865b3bf` (2026-08-13). The post-pin commits are the
ReworkPP feature (a live-PP overlay: `rework/reworkPerformance.js` plus
`classicMod`/`withPpMetrics` options threaded into `sunnyAlgorithm.calculate`, both
gated on `=== true` so the default star path we call is untouched) and `app/` UI.
Nothing post-pin changes the vendored files' default behavior.

Only the UI-free calc layer is vendored (upstream `js/` minus `app/`, `debug/`,
`parser/settingsParser.js`); files are copied verbatim so upstream diffs stay easy.
`vibro.js` is the one exception to the path rule: it comes from upstream
`js/app/vibro.js` but has no UI dependencies. Files that are ours, or ours-modified,
and must NOT be overwritten on a re-copy:

- The `.d.ts` files, this file, and the TS facades (`src/lib/leoblack-estimator.ts`,
  `src/lib/chart-classifier.ts`).
- The `ett/` harness: `calc.js` and `versions/index.js` are our isomorphic
  implementations, and `ett/index.js` is upstream's file plus a `lnTailTaps`
  option threaded through `analyzeEtternaFromText` into the calc (the backend's
  tail-aware SSR pass depends on it; dropping it silently zeroes the LN-tail
  blend, caught by `live-backend/tests/player-skills.test.ts`). `calc.js` also
  guards against instance poisoning two ways: a compute throw (emscripten
  surfaces C++ exceptions as bare numbers) evicts the cached wasm instance,
  since the throw leaves MinaCalc's internal state corrupted and every later
  compute on it returns the all-skillsets-equal floor; and a compute that
  *returns* that floor gets one retry on a fresh instance, so corruption with
  no observable throw self-heals too (a legitimate floor reproduces and is
  accepted). This is the 2026-08-14 prod poisoning; the recovery sweep in
  `live-backend/src/features/chart-analysis.ts` keys on the same signature.
  `calc.js`'s `buildRows` also shifts a chart whose first row is negative to
  start at zero (2026-08-16): osu! allows notes before the audio leads in,
  and a negative row time walks MinaCalc's interval index out of bounds and
  throws (prod chart 4038663, notes at -1050ms). Covered by
  `live-backend/tests/negative-time-msd.test.ts`. Note MinaCalc's own "junk
  file" guard is separate and intentional: absurd-density meme charts get
  all-zero skillsets from the calc itself, which we store verbatim.
- `estimator/companellaEstimator.js` (`getOrtNamespace` divergence, see Companella).
- `patterns/clustering.js`: the mixed-BPM cluster pool no longer averages in the
  MsPerBeat 0 sentinel that Density/Inverse windows carry (`resolvedMspb` in
  `findPatterns.js`); only timed windows vote, and an all-sentinel pool stays
  BPM 0. Upstream averages the zeros in, which read as four-digit BPMs
  ("~4497BPM Mixed Inverse") with matching inflated importance on inverse-heavy
  charts; still unfixed upstream as of 2026-08-16 (their `js/patterns` last
  changed 2026-08-09). Covered by `live-backend/tests/leoblack-clustering.test.ts`;
  the one-shot `recompute_inverse_cluster_bpm_sweep` re-analyzed stored rows.
- The `ett/versions/minaclac-*.js` glue stays at the old pin `0b27cc8` bytes: our
  calc.js hands over `wasmBinary` and defines the CommonJS globals, so upstream's
  newer locateFile-based glue offers nothing and re-copying it would re-open the
  Vite asset-copying quirks the two "stop Vite from copying raw ett glue" commits
  fixed.

## What's here

- `parser/` - .osu text parsers (osuFileParser for estimators, patternOsuParser for
  patterns, shared lane mapping in `noteColumn.js`).
- `rework/` - JS ports of sunnyxxy's Star Rating Rebirth (`sunnyAlgorithm.js`),
  thebagelofman's Daniel (`danielAlgorithm.js`), their shared math in
  `reworkMathCore.js`, and the SunnyWindow LN rework (`sunnyWindowAlgorithm.js`).
- `estimator/` - dan estimators: Sunny (SR -> interval tables), Daniel, Azusa, Roxy
  (structural features + frozen linear meta-model in `roxyMetaModel.generated.js`),
  Mixed (per-chart blend of the four, the recommended default), and SunnyWindow
  (`sunnyWindowEstimator.js`, vendored but unwired: our LN path is the in-house
  kNN). `intervals/` maps Sunny SR to dan names for 4K RC/LN, 6K RC/LN, 7K RC/LN,
  10K RC, plus `-ext` extended tables and `7k-wild` (upstream renamed
  `4k-rc-reform.js` to `4k-rc.js` with the export now `rc4K`; note `DAN_INDEX[10]`
  has no `LN` key, the .d.ts marks it optional). `estDiff` grew optional
  `useExtended`/`enableAlwaysShowLNDifficulty` params that default to the old
  behavior.
- `patterns/` - Interlude-derived pattern analysis with LN additions; outputs
  BPM-localized clusters plus a chart category. `config.js` now also owns
  `modeTagFromLnRatio` (moved out of mixedEstimator, same thresholds).
- `interlude/` - Interlude star rating.
- `pipeline/` - upstream's `runAnalysisPipeline.js`, a pure full-analysis
  orchestrator (parse once, run everything). Vendored for diff hygiene; our
  facades run their own orchestration and do not call it.
- `ett/` - Etterna MinaCalc as Emscripten WASM (5 versions). The glue is
  browser-targeted, but `calc.js` is isomorphic: in Node it reads the wasm bytes
  itself (`wasmBinary` override) and defines the CommonJS globals the glue's
  environment sniffing dereferences at factory time. `constants.js` is upstream's
  version registry (their `index.js` imports it).
- `vibro.js` - vibro detection (MSD JackSpeed ratio, or Longjacks pattern clusters).

## Known quirks

- Mixed output units differ by source: Roxy/Azusa `numericDifficulty` is continuous on
  the -2..20.4 scale (Intro=-2..0, Reform 1-10, alpha=11..kappa=20, tier offset +-0.4);
  Daniel-sourced results use 11+i+t (t in [0,1)) and a "Gamma Mid" label style. The
  facade normalizes both.
- `ett/versions/minaclac-*.js` still dereference `__dirname`; upstream has since moved
  the glue to `import.meta.url` and a locateFile-based loader. We solve the same problem
  one layer up in `ett/calc.js` (which defines the CommonJS globals and hands over
  `wasmBinary`), so the glue stays byte-identical to the old `0b27cc8` pin on purpose
  (see the ours-modified list above).
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

## Re-pin at 261e76f (2026-08-13)

Two upstream merges motivated it. PR #47 (`042ccee4`) aligned the JS Sunny port with
the authoritative C# osu-author-port on three divergences: exact-match step
interpolation takes the previous sample (D1), the percentile/weighted-mean weights
count LN tails as well as heads (D2), and the earliest note is dropped before
difficulty (D3). PR #48 was an output-identical perf series, most notably turning
`findPatterns`' O(n^2) slice-copy loop into an index cursor with a bounded head
window, which matters at backend chart-analysis scale.

The SR change shifts every Sunny star slightly (LN-weighted charts the most). Our
benchmark moved within noise, gated before shipping:

- normal/unified: exact 69 -> 70, base% 65.45 -> 64.92 (7 changed rows of 382).
- normal/leoblack: exact 69 -> 69, base% 65.18 -> 64.92.
- ln/unified: bit-identical (the in-house kNN owns 4K LN).
- ln/leoblack (non-production baseline): exact 19 -> 21, base% 55.29 -> 52.94.

Ops wiring that shipped with the re-pin: `DAN_ESTIMATE_CACHE_VERSION` bumped
(frontend v12, backend v13) for lazy dan-estimate recompute, and a boot-seeded
full-corpus in-place sweep (`SUNNY_REPIN_RECOMPUTE_JOB` in
`live-backend/src/features/chart-analysis.ts`) re-analyzes every ready row rather
than bumping `CHART_ANALYSIS_VERSION`, for the reasons documented on the sweep.
A companion sweep (`SUNNY_REPIN_DT_RECOMPUTE_JOB`) re-derives `dan_dt_json` (the
1.5x lean dan verdict, also Sunny-derived) from the stored DT MSD, because the
main sweep's re-analysis preserves the DT columns and the DT-rate sweep never
revisits a row that already carries MSD.

Player skill ratings are untouched by design: the skills pipeline rates plays
with MinaCalc, whose engines, harness, and parser inputs are unchanged here (the
`ett/index.js` `lnTailTaps` note above is what keeps that true). Only the dan
positioning readout can move, via the re-minted chart verdicts.

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

Re-copy the same directories from upstream `js/`, skip every file in the ours or
ours-modified list at the top (overwriting `ett/index.js` in particular breaks the
backend LN-tail SSR blend), and re-check the facade against upstream changes to
`estDiff` label formats and the Mixed result shape. A cheap wholeness check: diff the
tree against upstream and confirm the only differing files are the listed ones.
