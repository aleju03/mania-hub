# Shared osu!mania score-to-Wife calibration

`features/wife-calibration.ts` supplies the accuracy goals for player skills
versions 36 and later. Calibration version 2 (player skills v39) refines the
lazer hold-share contexts using native 7K LN replay rescores. It replaces
uniform judgment-band averaging and the old lazer LN blend toward raw osu
accuracy. There is no universal
percentage-point bonus and no tap-only, 4K-only or 1× gate.

## Scope and meaning

All otherwise eligible native 4K–18K scores use this model, including holds,
DT/NC, HT/DC and constant custom rates. Existing eligibility rules still
reject unsupported chart rewrites, variable-rate mods and unverified inputs;
this calibration does not make those scores reconstructible. 7K Invert uses
the existing transformed-chart path. DA OD and EZ/HR windows are resolved by
the existing mod policy; calibration does not bypass eligibility gates.

| Output | Replay target | Consumer |
| --- | --- | --- |
| Press/hold | Wife3 points on taps and LN heads, minus 2.25 per failed hold, divided by original objects | Native MinaCalc SSR in every supported keymode |
| LN quality | Mean Wife3 points on press/release actions, treating a broken hold's tail as failed | Independent 4K LN SSR |

Both retain osu!mania note assignment and hold-failure semantics. Neither is
an independently played Etterna score. The LN action target is a Mania Hub
extension, not native Etterna Wife3 and not permission to feed tail taps to
MinaCalc. Etterna's normalized Wife3 curve and separate hold-drop penalty
are the reference for the press/hold target ([Wife3 function](https://github.com/etternagame/etterna/blob/master/src/RageUtil/Utils/RageUtil.h),
[replay rescoring](https://github.com/etternagame/etterna/blob/master/src/Etterna/Models/HighScore/Replay.cpp)).

## Model and invariants

Inputs are the six judgment counts, verified original hold-object fraction,
OD, real playback rate, window scale, and stable/lazer/ScoreV2 provenance.
Classic affects hit windows without pretending lazer LN ownership is stable.
Unknown archived provenance uses the lower calibrated client prediction.
Missing counts use a separately fitted, lower-information accuracy adapter,
not raw-accuracy passthrough. That path is marked `basis: "accuracy-only"`.

Real-time judgment boundaries include client rounding:
`(floor(rawWindow * rate * windowScale) + 0.5) / rate`.
Wife3 uses real milliseconds, so DT must normalize both chart/replay time and
windows consistently, not divide offsets twice. Window definitions follow
the client model ([mania windows](https://github.com/ppy/osu/blob/master/osu.Game.Rulesets.Mania/Scoring/ManiaHitWindows.cs),
[rate handling](https://github.com/ppy/osu/blob/master/osu.Game/Rulesets/Scoring/HitWindows.cs)).

For each cumulative bad-judgment fraction, the model combines powers 0.5, 1
and 2 with nonnegative coefficients, scaled by the Wife3 cost of crossing
that timing threshold. Context coefficients interpolate linearly at hold
fractions 0, 0.15, 0.5 and 1; count-based client models share a tap anchor.
Improving any judgment cannot reduce either prediction. Tap predictions also
obey the exact range permitted by their judgment bands. Hold share conditions
the score observation model; it never multiplies chart difficulty.

Coefficients are static TypeScript arrays in `wife-calibration-*-model.ts`.
There are no runtime fits, player IDs or chart identity overrides. The offline
fit uses nonnegative least squares, ridge 0.00001, weights 1 for strict exact
reconstructions and 0.35 for the secondary quantized group, each divided by
the square root of that player's sample count.

Native goals must exceed 0.8 after conversion. Judgment-backed goals cap at
0.9975, with the existing MinaCalc extrapolation above 0.965. Accuracy-only
goals cap at 0.965. The independent LN solver receives its own release-aware
goal without manufacturing an 80% floor.

## Evidence and limits

The exploratory 2026-09 corpus audited 12,629 cached parsed objects, not a
random sample of osu! players. Native chart files were checksum verified and
the simulator was not reconciled to header counts. The version 1 fit used 5,715 plays:
3,324 strict exact/reconstruction-stable plays and 2,391 secondary lazer plays
whose total judgment-count difference was at most 0.5% of header judgments.
Strict samples agree under both legacy-frame handling modes, including
press/hold and action-quality targets within 0.05 percentage points. The
secondary group is reported separately, not relabeled exact ground truth.
Training press targets were between 50% and 100%; more extreme scores remain
extrapolation, even though bounds and monotonicity are tested.

Five-fold validation holds out players and, in a separate evaluation, chart
families. Family grouping combines shared beatmapsets with verified
uniform-rate, padded and mirrored copies, including hold endpoints (3,521
parsed charts, 760 verified matches, 2,409 groups). These are separate tests,
not simultaneously player-and-chart-disjoint evaluation. Model selection
was exploratory, not independently blinded.

Count-based press/hold mean absolute error, in percentage points. The first
eleven rows retain the original exact/reconstruction-stable audit groups;
the final row uses native-engine replay rescores. Version 1 and version 2
are evaluated with the same five-fold player and chart-family partitions.

| Group | Plays | Held-out player v1 → v2 | Held-out chart family v1 → v2 |
| --- | ---: | ---: | ---: |
| Stable 4K taps | 445 | 0.093 → 0.093 | 0.092 → 0.092 |
| Stable 4K hybrid | 1,132 | 0.091 → 0.091 | 0.092 → 0.092 |
| Stable 4K LN | 322 | 0.126 → 0.126 | 0.127 → 0.127 |
| Stable 7K taps | 128 | 0.151 → 0.151 | 0.145 → 0.145 |
| Stable 7K hybrid | 96 | 0.165 → 0.165 | 0.156 → 0.156 |
| Stable 7K LN | 24 | 0.237 → 0.237 | 0.308 → 0.308 |
| Lazer 4K taps | 336 | 0.238 → 0.238 | 0.237 → 0.237 |
| Lazer 4K hybrid | 592 | 0.339 → 0.338 | 0.332 → 0.332 |
| Lazer 4K LN | 5 | 1.477 → 1.487 | 1.566 → 1.605 |
| Lazer 7K taps | 89 | 0.222 → 0.222 | 0.223 → 0.223 |
| Lazer 7K hybrid | 61 | 0.451 → 0.451 | 0.429 → 0.430 |
| Lazer 7K LN native rescores | 79 | 0.955 → 0.915 | 1.006 → 0.971 |

Here LN means hold fraction >=40% for audit grouping, not the application's
LN identity verdict. The native 7K LN audit processed original cached `.osr`
files through `lazer-judgement-dump` (official lazer 2026.730.0 gameplay),
without the site's frame simulator or fabricated replay inputs. Of 85 raw
replays attempted, 84 completed; five Tachyon-fork recordings were excluded,
leaving **79 plays, 53 charts, 42 players and 46 chart families**, with hold
share **40.61%–99.76%**. Checks verify raw replay metadata,
chart MD5, native keycount, playback rate and complete object/action coverage.
Wife3 is calculated from native `JudgementResult` offsets in real milliseconds;
hold heads, tails and body breaks are associated with their original holds.

Each native sample pairs the engine's own six-count histogram with its own
press/hold and action-quality targets. These are exact native replay rescores,
not exact reconstructions of historical live score headers: **none of these
79 histograms exactly matches its saved header**. The `.osr` encoder rounds
frame times to integer milliseconds ([lazer encoder](https://github.com/ppy/osu/blob/2026.730.0/osu.Game/Scoring/Legacy/LegacyScoreEncoder.cs));
engine-version and playback-clock differences can also affect judgements.
A short replay checked in real-time and fast-forward modes had identical
target-relevant offsets and judgements; this is a spot check, not a bound
for every replay.

Using the saved headers instead, press/hold MAE is
**0.951 → 0.912 pp** under player holdout and
**1.000 → 0.966 pp** under family holdout. The v2
prediction changes by 0.037 pp on average (0.292 pp maximum) under player
holdout when exchanging native counts for saved headers; family holdout is
0.037 pp average / 0.282 pp maximum. Header sensitivity is not
an error bound on the original live offsets.

Only the three lazer press/hold context rows were refitted. The common tap
anchor, stable contexts, both accuracy-only adapters and independent 4K LN
action model remain fixed. The fit replaces 63 older secondary versions of
these plays with 78 native samples, giving 5,730 training rows. One
native press target below 50% remains in validation but is excluded from
fitting, preserving the original training range. Native samples have weight
1; existing secondary samples retain weight 0.35. No full-corpus coefficient
is used for a held-out player's or family's native validation prediction.

The largest existing-row MAE regression is **0.03872 pp** (lazer 4K LN,
family holdout), below the 0.05 pp limit. Native 7K LN signed press residual
(prediction minus target) is -0.082/-0.021 pp after fitting, player/family
holdout respectively. Errors occur in both directions. **MAE remains above
0.5 pp after the refit**; the data do not support a uniform upward correction
for lazer 7K LN goals. The original v1 secondary 7K LN result (248 plays,
0.77/0.79 pp) is not the new audit's ground truth.

LN action-quality MAE on the same native set, in percentage points; the
independent 4K LN model is unchanged:

| Input / target | Plays | Held-out player | Held-out chart family |
| --- | ---: | ---: | ---: |
| Native counts / LN action quality | 79 | 0.871 | 0.867 |
| Saved header counts / LN action quality | 79 | 0.881 | 0.875 |

For the separate LN action-quality target, exact 4K stable MAE is 0.50 pp
under both holdouts; exact 4K lazer is 1.07 pp with only five samples.
Secondary 4K lazer LN is 0.69 pp. These validate a quality estimate, not the
independent LN difficulty scale or specialist rankings. Accuracy-only input
is substantially less informative: exact all-keymode tap MAE is 0.43 pp for
stable and 1.01 pp for lazer under player holdout. Prefer retained judgments.

## Integration and retention

The production caller verifies native mode, keycount, OD and original hold
share from cached `.osu` files before goal/slot selection. `wifeCalibration`
stores version, facts and file version. A changed file, corrected counts,
provenance or goal prevents stale SSR reuse. Retained score details and rate
settings allow old scores to migrate after raw-event retention.

Missing facts/calculation preserve sole-source history as
`calibrationPending` evidence with empty SSR values, exposed as
`pending_calibration`; they do not credit old ratings or disappear. Bounded
fact/calculator passes enqueue continuation when more budgeted work remains.
Missing files alone do not cause an endless continuation loop. Completed
sub-floor plays remain Dan-only evidence under existing Dan rules.

`estimateWifeAccuracy` and the earlier generalized-normal tap estimator remain
historical audit helpers only. New production paths should use
`calibrateScoreForMsd`. Regression tests cover DT/HT/custom rates, every
supported keycount, LN, retained evidence, upgrades, migration budgets and
corrected/missing chart facts. Raw data and reproducible audit scripts remain
in ignored `local-notes/wife3-all-scope/` and
`local-notes/wife3-lazer-7k-ln/`; do not commit cached player replays.
