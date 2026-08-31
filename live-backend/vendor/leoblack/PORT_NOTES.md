# LeoBlack analyzer port

Vendored calculation layer from LeoBlackMT/osumania_map_analyser (the tosu overlay
"ManiaMapAnalyser by Leo_Black"), upstream commit `5a6144c` (2026-08-30 HEAD at
re-copy time; see "Re-pin at 5a6144c" below for what moved). MIT, see LICENSE in
this directory.

Post-pin-adjacent files that ride along without changing default behavior: the
ReworkPP feature (`classicMod`/`withPpMetrics` options threaded into
`sunnyAlgorithm.calculate` and `runAnalysisPipeline`, all gated on `=== true` so
the default star path we call is untouched; its `rework/reworkPerformance.js` is
NOT vendored because only `app/` imports it) and `ett/constants.js`'s
`WASM_ASSET_VERSION` (upstream's browser cache-bust; our browser path gets the
same effect from Vite's content-hashed asset names, and Node reads bytes).

Only the UI-free calc layer is vendored (upstream `js/` minus `app/`, `debug/`,
`parser/settingsParser.js`); files are copied verbatim so upstream diffs stay easy.
`vibro.js` is the one exception to the path rule: it comes from upstream
`js/app/vibro.js` but has no UI dependencies. Files that are ours, or ours-modified,
and must NOT be overwritten on a re-copy:

- The `.d.ts` files, this file, and the TS facades (`live-backend/src/dan/leoblack-estimator.ts`,
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
  charts; still unfixed upstream as of 2026-08-24 (their `js/patterns` last
  changed 2026-08-09). Covered by `live-backend/tests/leoblack-clustering.test.ts`;
  the one-shot `recompute_inverse_cluster_bpm_sweep` re-analyzed stored rows.
  Extended 2026-08-21: "timed" now means MsPerBeat at or above
  `CLUSTER_TIMED_MIN_MSPB` (40, a 10ms row gap), not merely nonzero. A window
  under it is the sentinel's physical cause measured instead of zeroed (an LN
  tail milliseconds before the next head, a grace note), and letting those
  vote left the non-mixed pool seeded at the sentinel reading "15000BPM
  Inverse" (prod chart 5609748) - and the same artifact without any sentinel
  ("20000BPM Coordination", "15000BPM Jacks"). The floor caps any computable
  cluster BPM at 60000/40 = 1500; the sweep's v2 pass re-analyzes stored rows
  at or above that ceiling.
- `estimator/intervals/6k-rc.js`: extended past upstream's "Regular 9 high" end
  with 10th-14th (Terra, Celestial, Mystery, Nihility, Finish - the 6K
  community ladder the LN table already speaks). Terra/Celestial are anchored
  on Arkman's official course files (Sunny stars 8.0101 / 8.3777 at the
  2026-08-28 calibration) using upstream's own construction, reverse-engineered
  from the shipped rows against the official Start-9th courses: each level
  boundary is the midpoint of adjacent course SRs and each half-interval around
  a course splits uniformly into 2.5 bands, so every course lands in its "mid"
  band. Mystery/Nihility/Finish have no course files yet and extrapolate the
  Terra->Celestial level width; recalibrate when those courses exist. Covered by
  `live-backend/tests/dan-6k-rc-extension.test.ts`.
- The `ett/versions/minaclac-{68,70,72}*.js` glue stays at the old pin `0b27cc8`
  bytes: our calc.js hands over `wasmBinary` and defines the CommonJS globals, so
  upstream's newer locateFile-based glue offers nothing for those and re-copying
  it would re-open the Vite asset-copying quirks the two "stop Vite from copying
  raw ett glue" commits fixed. `minaclac-74.0.js` and `minaclac-75.0.js` are the
  exception and DO carry upstream's 2026-08-30 emscripten output, because the
  n-key wasm they load only exists in that build; both are top-level-await ESM
  factories that do their own Node environment sniffing, and they bundle and run
  under our loader unchanged (verified by `npm run build`'s asset check).
- The 74.0/75.0 wasm binaries carry OUR cap patch, not upstream's. Upstream's
  n-key rebuild silently dropped the 40 -> 100 SSR clamp lift their own
  `tools/patch-minaclac-msd-cap.mjs` applies, so a straight re-copy re-clamps
  every top-end skillset at 40 (caught on eight local 6K/7K charts stored above
  it, e.g. beatmap 3278106 at 56.87 coming back 40.00). Both binaries were
  re-patched with that same tool's edit - `f32.const 40.0` (43 00 00 20 42) ->
  `100.0` (43 00 00 c8 42), four occurrences each - after which those eight
  charts return their stored values exactly. Re-run it on any future re-copy and
  re-check a known above-40 chart; the count is not stable across their builds.

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
- `ett/` - Etterna MinaCalc as Emscripten WASM (6 versions; 0.74.0 and 0.75.0
  carry the n-key pipeline, and every non-4K keycount is pinned to 0.74.0). The glue is
  browser-targeted, but `calc.js` is isomorphic: in Node it reads the wasm bytes
  itself (`wasmBinary` override) and defines the CommonJS globals the glue's
  environment sniffing dereferences at factory time. `constants.js` is upstream's
  version registry (their `index.js` imports it). The 70.0/72.0/72.3 wasm
  binaries are upstream's cap-patched blobs (74.0/75.0 are patched by us, see
  above) (`8e42f49d`: the f32 40.0 per-skillset
  SSR clamp byte-patched to 100.0, reproducible via their
  `tools/patch-minaclac-msd-cap.mjs`); 68.0-Unofficial is deliberately unpatched
  upstream and unchanged here.
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

## Re-pin at 214aedd (2026-08-24)

Two upstream calculation changes motivated it; everything else in the re-copy is
default-gated or UI.

1. **MinaCalc skill cap 40 -> 100** (`8e42f49d`): the shipped wasm binaries are
   byte-patched (see the `ett/` bullet above). Below the old clamp the engines
   are bit-identical; only charts/plays that had a skillset pinned at exactly 40
   move (local snapshot: 459 of 128,913 analyzed charts at 1.0x, 21 of 11,375 DT
   rows). Top-end MSD now tracks the patch, not official Etterna.
2. **Roxy re-scope + Azusa fusion** (`4b4342b`, `405d482`, `95e5e87`,
   `b199705`, `82ecb0a`): Roxy is high-difficulty-only (final numeric < 11
   returns "< Alpha Low", >= 17 returns "> Emik Zeta high", both with
   `numericDifficulty: null`, which Mixed treats as unusable and routes to
   Azusa); surviving Roxy output is blended 0.4 toward `pred_Azusa`; the meta
   model was fully retrained (ordinal target); Mixed's Azusa-preference rules
   read the unquantized `debug.finalNumeric` and gained a crossing rule; Mixed
   and the pipeline now report `actualEstimatorAlgorithm`.

Guard fallout: the trivial-chart population the Roxy floor-pin guard was built
for now reaches its verdict through Azusa, which repeats the overestimation
(the guard's own synthetic 2 nps ranked-Easy shape came back "Reform 3 low").
`chart-classifier.ts` grew `isAzusaLowEndSuspect` beside `isRoxyFloorPinned`:
an Azusa verdict claiming Reform 2+ whose own `debug.sunnyNumeric` reference
sits below the 3.0-star equivalent (6.84 on its 2.85 + 1.33 * star scale) is a
reroute candidate, with the independent Sunny run still the final authority.
Covered by `tests/dan-floor-pin.test.ts`.

Benchmark gate (`npm run dan:benchmark`, rate 1.0, run 2026-08-24):

- normal/unified and normal/leoblack: exact 70 -> 91 of 382 (18.3% -> 23.8%),
  base-or-better 64.92% -> 64.7% (flat). The exact jump is upstream's claimed
  fusion gain showing up on our labels too.
- ln/unified: untouched (in-house kNN owns 4K LN).
- ln/leoblack (non-production baseline): bit-identical (21 exact, 52.9%).

Ops wiring that shipped with the re-pin: `DAN_ESTIMATE_CACHE_VERSION` bumped to
14 (shared `cache-version.ts`), and three boot-seeded one-shot sweeps:

- `recompute_leoblack_repin_sweep` (chart-analysis.ts): full-corpus in-place
  re-analysis, the sunny re-pin pattern - refreshes 1.0x MSD and every verdict,
  rebuilds dan collections at the end.
- `recompute_leoblack_repin_dt_sweep`: DT companion. Unlike the sunny pair the
  cap lift can move `msd_dt_json` itself, so rows whose stored DT vector
  carries a skillset at exactly 40 redo the 1.5x MinaCalc pass; every DT row
  then re-derives `dan_dt_json` from stored-or-refreshed MSD.
- `recompute_player_skill_msd_cap_sweep` (player-skills.ts): the poison-sweep
  shape - stored plays with any SSR skillset at exactly 40 are dropped and the
  row backdated stale, so the next profile view re-rates just those plays on
  the lifted engine. A targeted purge, not a PLAYER_SKILLS_VERSION bump,
  because sub-cap SSRs are bit-identical.

## Re-pin at 5a6144c (2026-08-31)

Two upstream calculation changes; the rest of the range (`7721a8b`..`87fb529`)
is their telemetry backend and dashboard, plus card/pause UI, none of it
vendored.

1. **Marathon duration correction** (PR #61, `4c00d32`..`649ae28`): a new
   `estimator/marathonCorrection.js`, applied inside Azusa and Roxy rather than
   as a pipeline post-step. Downward-only on `numericDifficulty`, with `estDiff`
   re-derived from the corrected value:
   `corr = min(0.50, 0.40 * ln(1 + (durationS - 300) / 60))`, tapered linearly
   to zero between numeric 10 and 16, and gated on 4K + drain over 300s + MSD
   present + a skill balance of `max/total < 0.45`. `reworkEstimatorUtils.js`
   also gained a null-guard for keymodes with no LN interval table (10K), and
   `pipeline/` picked up the on-demand pre-Ett reuse. All copied verbatim.

   **Vendored but deliberately not enabled.** The estimators only correct when
   a caller passes `options.marathonCorrection`, and `chart-classifier.ts`
   never does; the gate helpers (`isMarathonCorrectionCandidate`,
   `chartNoteSpanSeconds`, `MARATHON_CORRECTION_MIN_DURATION_S`) stay so the
   decision is testable, pinned by `tests/dan-marathon-correction.test.ts`.

   Why: a dan course is long and skill-balanced by construction, so the
   correction lands almost entirely on courses. Every one of the 20 labelled
   rows it moved on the benchmark is a course chart, and the moves split 5
   better against 3 worse - but all three losses are courses the estimator had
   exactly right, pushed off their variant:

   | chart | off | scale 0.20 / cap 0.25 | upstream 0.40 / 0.50 | expected |
   | --- | --- | --- | --- | --- |
   | EXTRA-DELTA | `delta+` | `delta` | `delta-` | `delta+` |
   | EXTRA-GAMMA | `gamma+` | `gamma` | `gamma-` | `gamma+` |
   | INTRO-1st | `1` | `1-` | `1--` | `1` |
   | EXTRA-BETA | `gamma--` | `beta++` | `beta` | `beta+` |

   Summary line, `npm run dan:benchmark` normal/unified rate 1.0, 2026-08-31:
   off exact 91 / wrong 135 / base 64.66%; 0.20-0.25 exact 91 / wrong 133 /
   base 65.18%; 0.40-0.50 exact 90 / wrong 131 / base 65.71%. The headline
   improves, but softening the constants only softens the damage - the same
   three anchors regress at every non-zero setting, because a uniform downward
   push on that chart shape cannot tell an over-rated course from a correct
   one. The one clear win (EXTRA-BETA, `gamma--` -> `beta`) is the estimator
   over-rating a course, which is what `sunnyLowEndReroute` and
   `isAzusaLowEndSuspect` already exist to catch at the other end of the scale.
   Gating it on "is this a dan course" is not available to us: chart rating
   must stay algorithmic, and `dan-courses.ts` is a player-layer registry.

   Revisit if upstream recalibrates against absolute course placement rather
   than the relative ordering of adjacent courses, which is what their
   acceptance notes describe.

2. **MinaCalc n-key support** (PR #62, `d2d7561`..`34b96f2`): a rebuilt 0.74.0
   whose FFI gates 4..18K instead of 4/6/7, plus a new 0.75.0 on the same
   structure. `SUPPORTED_KEYS` widens to 4..18 in `ett/constants.js`, our
   `ett/calc.js` and `ett/versions/index.js` (the latter two are ours, so this
   was a merge), and the non-4K pin broadens from "6 or 7" to "anything but 4".
   `DEFAULT_ETTERNA_VERSION` stays 0.72.3: 0.75.0 is registered and selectable
   but nothing routes to it, since adopting it would move 4/6/7K numbers too.
   `MSD_SUPPORTED_KEYS` in `src/dan/msd.ts` is the backend gate and widens to
   match; every `computeMsd` caller inherits it.

   Measured before shipping: 4/6/7K are bit-identical on the rebuilt 0.74.0
   (120 charts, one 7K skillset off by 0.008 with Overall unchanged), so no
   re-sweep is owed there. The whole local non-4/6/7K corpus rates: 4022 charts
   across 5K and 8K-18K, 4021 with a positive Overall, one hard failure (18K
   beatmap 1548754 aborts inside the wasm, deterministically; calc.js evicts the
   instance and later charts are unaffected). The n-key engine does not rate
   Technical - it returns the ~0.18 floor - which the MSD readout already drops
   with its `>= 1` filter, the same way it does for 6K/7K.

   `LN_TAIL_BLEND_BY_KEYMODE` still only has weights for 4/6/7. The new
   keymodes get no LN-tail blend rather than a guessed one; fit them the way
   the 4K/7K weights were fit before adding entries.

Ops wiring: one boot-seeded sweep, `recompute_nkey_msd_sweep`
(chart-analysis.ts), re-analyzing 5K and 8K-18K rows whose `msd_json` is null.
No `CHART_ANALYSIS_VERSION` or `DAN_ESTIMATE_CACHE_VERSION` bump: with the
marathon correction off, no existing rating moves at all.

Unrelated gap noticed while measuring the above: `parseLeoBlackRcHalf`
collapses upstream's whole Intro ladder onto dan 1 (`Intro 3 mid` -> `1`,
everything above or below it -> `1++`, with a negative rawDan, so `1++` reads
as harder than `1` while being easier). About a thousand 4K rows already sit
there. Fixing it means deciding how Intro should read below Reform 1, which is
a labelling call rather than a port one.

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
