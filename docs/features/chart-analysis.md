# Chart analysis

What the site computes for each chart: the classifier verdict, MSD, LN identity, hybrids and pattern tags. Player-side use is in [skill-ratings.md](skill-ratings.md) and [dan-estimates.md](dan-estimates.md); vibro is in [vibro.md](vibro.md).

## Engines

- **MinaCalc** rates 4K, 5K and 9K-18K. **Prism** replaces it entirely on 6K, 7K and 8K (LN included) behind `PRISM_ENABLED`; reference `backend/docs/prism.md`, public copy in `algorithms/prism/`.
- **LeoBlack** and the MinaCalc wasm live once in `backend/vendor/leoblack`; the frontend imports them as `#leoblack/*`, the estimator and classifier as `#dan/*`. `companella.ts` is the one hand-synced pair (the backend routes MSD through `msd.ts` to serialize MinaCalc against the job lanes). Local divergences from upstream are listed in the vendor `PORT_NOTES.md`.

## Storage and jobs

- `beatmap_chart_analysis` stores per beatmap at 1.0x, keyed by `CHART_ANALYSIS_VERSION`: the classifier verdict and pattern clusters (`classification_json`), MinaCalc skillsets (`msd_json`), and extracted columns for SQL (`key_count`, `primary_label`, `primary_family`, `raw_dan`, `msd_overall`).
- Analysis is queued for every newly seen beatmap and runs even with `ENABLE_OSU_API_JOBS` off (it then only skips the `.osu` network fallback).
- **Backfill**: `POST /api/admin/chart-analysis/backfill?limit=N` sweeps cached files with no current row; the admin one-click run (`/api/admin/chart-analysis/{start,cancel}`) self-chains until the cache is covered, paced by `CHART_ANALYSIS_JOB_INTERVAL_MS`. A full recompute is faster on a dev PC: `npm run analyze:charts` (`--all`) in `backend/`, then `export:chart-analysis` -> gzip/scp -> `import:chart-analysis:dist -- <file>` (idempotent; schedules a map search index rebuild).
- **Rates**: the DT sweep fills `msd_dt_json`/`dan_dt_json` (1.5x) for DT-farmed 4K/7K charts. `GET /api/chart-analysis/rate?beatmapId&rate` answers any rate in 0.5-2.0x and caches the result in `dan_estimates`. The map modal uses it for rate-mod plays.
- **Repair sweeps** that fix verdicts without a full reanalysis keep `CHART_ANALYSIS_VERSION` unchanged, so ready maps stay visible while they run. Each has a `live_meta` done key, appears in the admin sweep status, and triggers the collections rebuild and a player-dan fold when finished. Full-corpus LeoBlack re-pins run as a cooperative chain (ten maps per link, yielding to interactive chart work) rather than one job per chart.

## 4K LN identity

A 4K chart files LN only when it passes **both** gates (`chartIsLn` is the single reader and keeps them paired):

1. Chart-wide hold share at least `LN_PRIMARY_MIN_RATIO` (0.45).
2. Effective LN share (`classification_json.lnEffectiveRatio`, `dan/dan-estimator/ln-effective.ts`) at least `LN_EFFECTIVE_MIN_RATIO` (0.40). A hold is effective when its tail outlasts the release window at the played rate and OD, or when it sits in a recurring same-lane release/repress chain near that window. The chart value is a note-weighted median over 10s windows of the long-hold share and the release-work share, on one scale.

The second gate can demote a nominal LN chart but never promote one under 45% holds.

- **Identity OD floor**: identity reads the release window at no less than `LN_IDENTITY_MIN_OD` (5), since at OD 0 most short holds would count as free. Effective-hold counts, the LN rating and the tail pass keep the played OD.
- **Rating tiebreak** (`dan/ln-identity.ts`): a chart past the hold line but short on effective share is still LN when its LN rating at that rate beats native Overall by a point (`lnRatingIdentity`, `lnStructuralRatio`). It does not apply when the heaviest sections pin no finger, or when only same-lane chains lift the chart and it has almost no holds kept down through other presses (`LN_HELD_THROUGH_MIN_SHARE`).
- **LN vibro** (`detectLnVibro`): staggered hold spam forms no same-lane chains at any rate.
- Two shapes are deliberately not discounted because the LN courses are built from them: a release landing on another head, and a tail just past the window.
- `lnWorkShare` stores the share of holds carrying identity work.
- Other keymodes keep plain hold-share identity (0.375 on 7K, 0.45 elsewhere).
- `recompute_ln_effective_sweep` stores `lnEffectiveVersion` beside each nomod/DT/HT share and triggers the player pattern/dan refolds when done.

Calibration, acceptance results and validation limits: [LN analysis](../ln-skill.md).

## LN rating and MSD headline

- **Tail-aware MSD** (4K, past the 45% line only): the calc rates the chart with its free holds demoted to taps (`lnTailPassText`, stored as `msd_ln_json`), so the SSR blend pays nothing for releases a tap covers. Charts under the line use base MinaCalc.
- **LN tile**: an independent 4K hold/release strain model (`dan/ln-skill.ts`), published on any 4K chart past the hold line with effective holds and at least `LN_MIN_WORK_SHARE` of its holds doing work, LN identity or not. It scales with rate like native Overall (`LN_SKILL_RATE_RESPONSE`).
- **MSD headline** (`dan/msd-headline.ts`, `/maps` modal and farm helper map page): on a 4K chart with LN identity, the higher of Overall and LN, since native Overall never sees a tail. Display only: `msd_overall` and every player rating keep native Overall.

## Hybrids

A 4K chart is a hybrid (`isHybridChart`, `secondaryDanFor`, `secondaryDan` on `/api/chart-analysis`) when it has at least 25% rice-phrase evidence, a hold share in the `HYBRID_HOLD_SHARE_MIN/MAX` band (25-75%), and at least `HYBRID_MIN_WORK_SHARE` of its holds doing work (which keeps LN vibro packs out). LeoBlack produces a verdict per side; identity names the primary, and the other side is shown top-right of the badge as "hybrid". At 1.5x the stored DT verdict's other half shows when it is also a hybrid there (`secondary` in `dan_dt_json`). 7K is not covered yet.

`lnSections` (written by analysis, backfilled by `recompute_hybrid_ln_sections_sweep`, `dan/hybrid-ln-sections.ts`) rates a chart's LN sections on their own for the hybrid LN credit; see [dan-estimates.md](dan-estimates.md#hybrid-charts).

## Pattern tags for the 6K/7K/8K axes

`loadChartSkillInfo` in `player-skills.ts` reads its own tags, stricter than the `/maps` discovery tags (the analyzer's raw scores at 0.5):

- **tech** follows LeoBlack's headline label (`chartIsTech`, the same read as the dan Tech bucket), falling back to the score-and-jack-veto read when there is no label.
- **chordstream** also needs Chordstream clusters to carry `CLUSTER_SHARE_MIN` (40%) of the difficulty (`chartIsChordstream`).
- **jack** comes from the single-note jack score or the jack cluster share (`chartIsJack`).

A play's rating on a pattern axis is its Overall SSR, never Overall scaled by the analyzer's score: those scores are tag confidences, not difficulty fractions. 4K keeps the analyzer's tags. A rule change bumps `player_skill_pattern_sweep_done:v*`.

## LeoBlack local adaptations

- **Low-band Azusa/Companella fusion** (`features/leoblack-fusion.ts`), with Azusa's 18% LN scope enforced and the easy-chart guard ahead of fusion.
- **Roxy meta clamp** (`features/roxy-meta-clamp.ts`): stops a degenerate meta feature from dragging 4K chordjack down.
- **Companella rate floor** (`classifyChartWithCompanella`, `COMPANELLA_RATE_FLOOR_STEPS`, `features/companella-rate-floor.ts`): a Companella-refined rice verdict never drops as the rate rises; it is floored at the verdicts 0.05x and 0.1x slower. Upstream parity checks pass `rateFloor: false`.
- **Companella inputs** (`features/companella-inputs.ts`): Companella gets actual Sunny SR and its own raw MinaCalc 0.74.0 features, as upstream does. Ordinary 4K MSD/SSR and marathon correction stay on 0.72.3.
- **Marathon correction** (`features/marathon-correction.ts`): only 4K charts whose first-to-last note span exceeds 300s (breaks included, not rate-scaled). Correction happens inside Azusa/Roxy before routing. `recomputeMarathonCorrectionChunk(..., { dryRun: true })` previews candidates.

Repairs over cached 4K verdicts and their rate variants share `features/cached-4k-verdict-repair.ts`.

## Note BPM

`dan/note-bpm.ts` stores a note-weighted song tempo (`classification_json.$.noteBpm`, copied to `map_search_index.note_bpm`): the median timing-point BPM under the notes, with inflated timing folded back to the song (always above 500, above 300 when the row gaps are coarse). The fold depth is chosen by how well each candidate grid explains the gaps on binary and triplet snaps. The map modal shows it beside osu!'s BPM when they differ by 3% or more; profiles use it for BPM stats. Fold-rule changes bump `note_bpm_recompute_done:vN`.
