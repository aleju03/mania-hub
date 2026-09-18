# Independent 4K LN analysis and skill

`live-backend/src/dan/ln-analysis/` implements the structural 4K LN model.
`ln-skill.ts` supplies the independent LN scalar alongside native MinaCalc,
validated against the 17-course checks described below.
Neither reads chart/player identity, title, dan verdict, pp or MinaCalc output
to decide a chart's difficulty. The structural model is **4K only**; the
[score-to-Wife calibration](wife-calibration.md) applies to all supported
native keymodes, including 7K LN, DT, HT and constant custom rates.

## Lossless input and native baseline

The timeline preserves paired hold heads and tails, taps, source object IDs,
and lane ownership. Only exactly equal timestamps form a row. Each row has
tap/head/tail masks and held-before/held-after state. Same-lane release and
repress at one timestamp remain distinct actions; near-simultaneous events
are not snapped together. Effective time is `(sourceTime - origin) / rate`,
applied once. Hands are explicitly columns 1–2 and 3–4.

Invalid lanes, non-finite times, nonpositive holds, duplicates, overlaps and
taps inside a same-lane hold produce diagnostics. Invalid topology makes the
LN difficulty unavailable (`rating: null`); it is not repaired by inventing
endpoints or silently collapsing stacked notes.

Native 4K MinaCalc always receives its original press/head projection. Even
legacy `lnTailTaps: true` callers cannot insert 4K tails. The WASM ABI and
native skillsets are unchanged. The LN sidecar does not multiply Overall by
hold share. Existing 6K/7K tail blending is a separate legacy difficulty
policy, not part of this 4K model or the new score calibration.

## Structural output

| Profile | Measured evidence |
| --- | --- |
| Density | Head/chord rates, stream/jack geometry, local-relative short holds, continuous duration statistics |
| Coordination | Same-hand hold-plus-tap/jack, held chords, anchors, nested/crossing holds, shields, press/release opposition |
| Release | Exposed releases, release chords versus staggered groups, release rhythm/geometry, release-to-repress actions |
| Inverse | Recurring short release/repress gaps under high occupancy, variable gaps and partial-lane inverse runs |

Static held walls are not automatically inverse. Long recovery splits inverse
runs. Technical evidence is derived from named interactions, not a generic
bonus. Stamina tracks active demand and recovery in 500 ms sections; section
work counts primitive actions, not the number of overlapping pattern tags.
SV/scroll speed and hold-body tick counts do not enter physical difficulty.

Tags, coverage and difficulty are separate. Profiles are measured structure,
not pending difficulty axes: they have no `rating`, `calibration`, or
`unsupported` fields. The technical tag summary also carries no rating.
Object share and union annotation duration describe
coverage, not additive difficulty or active work duration. Each detection
carries its interval, lanes, object IDs and measurements. The glossary keeps
structural IDs separate from aliases, including ambiguous walls, lifts,
half-inverse variants and mapper-coined labels; names never award bonuses.

## Scalar rating and performance target

`ln-skill.ts` version 7 supplies the single independent LN rating and consumes
the same exact timeline. It uses
`effectiveHoldMask` at the played rate/OD to remove free holds, then combines
release impulses, same-hand held-finger coordination, hold starts and
release-to-repress recovery in two hand strains (700 ms half-life). Section
peaks are weighted by LN work. A separate hard rice section cannot supply LN
strain or endurance. Mirroring and a global time offset preserve the result.

Effective-hold model v4 requires identity-bearing holds to exceed the
OD-dependent release window, `1.5 * (64 - 3 * OD)` ms. It additionally prices
near-window same-lane hold chains: at least two consecutive hold-to-hold
links (three heads), each contributing body's duration at least the window
minus the existing 20 ms shared-motion tolerance, and a nonnegative
tail-to-next-head gap no greater than that window. A chain's final hold needs
its own qualifying outgoing link or a genuinely long body to count.
`chainedShortHolds` reports these additions separately from `longTails`.
These chain additions contribute difficulty only: the 40% identity gate uses
the note-weighted median of per-section **long-tail** share, excluding every
tap-covered chain addition. In v3 the same additions also established
identity, incorrectly promoting high-hold DT charts. V4 restores the
long-tail identity gate while retaining the course difficulty improvement.
This is a rearticulation workload heuristic, not a proof that an early
release cannot score. Cached top-course gaps are commonly 40–60 ms, not
literal same-lane tail/head contact.

Other-column overlap alone remains insufficient; `shortSpanning` is only a
diagnostic. Isolated pairs, tiny bodies, and long recovery gaps do not gain
release work. Times divide by rate once, including HT, DT and custom rates.
Free holds contribute ordinary presses, not release/recovery strain.

The solver uses `exp(log(0.93) * (demand / skill)^4)` as its section response.
Chart difficulty targets 0.93. Player LN SSR uses the calibration's separate
**release-aware action-quality** output, not raw osu accuracy and not the
native press-only target. It allows goals below 0.8 (zero quality gives zero
LN rating); native MSD eligibility still follows its own >0.8 floor.
Like the press SSR, the LN solver runs at most at the 0.965 cap and a
higher goal extrapolates the cap-to-0.93 slope (`analyzeLnSsr`); solved
directly, a perfect play priced a 24.8 chart at 38.7.
This is an empirical response model, not measured per-player release error.

The inherited scale is `4.818919597751967 * strain^0.5277221146076253`.
Its historical fit used nine odd-level 4K LN courses against native MSD, with
eight even-level courses as diagnostics. This only aligns a numerical range.
The 17-course evaluation now gives Spearman 0.9902 (previously 0.9510), with
levels 16 and 17 above level 15 and all 17 still LN-eligible. The shipped
scale/exponent are unchanged. An unconstrained refit on the same nine odd
courses yields scale 5.004177787074106 and exponent 0.5104758442838657.
Scale and exponent covary in this log fit, so stability is checked in rating
space: every course must differ by **less than 1.0 MSD** between shipped and
refitted constants at the same measured strain. All 17 pass. The maximum
difference is **0.8043503803792191 MSD**, at level 17 (shipped 32.728934347429984,
refitted 31.924583967050765). The eight diagnostic courses' mean absolute
error against cached native Overall is 1.4064630384488246 with shipped
constants versus 1.4220278052486786 with the refit. These are numerical-scale
diagnostics, not human difficulty errors. The shipped constants are retained;
the scalar no longer emits a provisional calibration marker or tooltip label.
The eight even courses remain diagnostics, and using this ladder to inspect
the fix makes these course-order results an in-sample check, not independent
player-outcome validation. No scale transfers to other keycounts.

To earn the independent 4K LN axis a play must pass both 45% hold share and
40% long-tail section share at its own rate/OD. The difficulty mask and
`effectiveHolds` still include near-window chains; `effectiveLnRatio` is the
separate identity statistic and excludes them. Mixed charts can retain a diagnostic
scalar while publishing `values.LN = 0` if they fail identity. Other modes
keep their existing hold-share gates and Overall-on-LN player axes (7K:
37.5%; others: 45%). This is distinct from calibrating their score quality.

## Caching, API and migration

Production chart/rate and player caches retain only the LN scalar, eligibility,
model version and small calculation metadata. Structural profiles, interval
previews, object IDs and diagnostics are generated only when offline callers
explicitly pass `includeStructure: true`; they do not affect the scalar and
are not returned by the rating API. The map search projection also strips
previews from legacy artifacts when copying them.

The experimental shield/reverse-shield search tags have been removed from
both the backend and frontend query vocabularies. The LN share slider remains:
it filters `ln_share`, the share of the chart's objects that are holds, using
osu!'s counts. The bounded cleanup drops the existing experimental tags
without a full index rebuild.
The effective-LN sweep checks rating/identity versions only, so removing a
preview does not enqueue a recomputation or regenerate it.

`npm run compact:ln-artifacts` in `live-backend/` removes existing
`lnSkill.structure` fields from chart analyses (base, DT, HT and legacy tail
artifacts), rate/mod estimates and map search, and removes the retired search
tags. It pages row IDs, transforms the current JSON in SQLite in small writes,
preserves scalar/native/vibro fields and timestamps, and is safe to interrupt
and rerun while the backend serves. It does not delete rows or invalidate
ratings. The general `compact:storage` command includes the same pass. Pages
become reusable inside the database; the offline `VACUUM INTO` procedure in
[backend storage](backend.md#retention-and-storage) returns space to disk.

Player skills version 40 seeds from versions 39 through 16 and migrates
compatible retained evidence in bounded
passes. It recomputes changed calibrated goals, removes stale 4K tail blending
(tail pass version 4), and refreshes LN version 7 metadata. Historical scores
whose facts/calculation are pending remain durable with no credited stale
SSR. Budget-deferred work queues continuation; missing files alone do not
create a retry loop. Vibro, chart-family and Dan evidence policies remain in
force. Chart sweeps refresh eligible base/DT/HT LN artifacts and clear obsolete
4K tail artifacts. Effective-LN sweep v11 refreshes model/identity metadata;
rate-estimate cache v24 and player Dan/pattern sweeps v37/v12 propagate it.
The chart-table namespace remains version 1: the targeted chart sweep
invalidates effective/model artifacts without hiding the entire cached map
corpus. The native tail-pass version remains 4 because native MSD did not
change. Percentile metadata follows the independent LN version automatically.
No migration runs merely by importing the model.

## Verification and remaining validation

`tests/ln-analysis.test.ts` covers taps, held walls, free short holds,
coordination, exposed releases, inverse, simultaneous versus staggered
actions, release/repress boundaries, invalid input, alias ambiguity,
mirroring, offsets, rates, cache identity and recovery. `ln-skill.test.ts`
covers scalar isolation, identity, response and invalid topology. Native
baseline equivalence is checked separately, including real cached charts.

For the read-only course benchmark, run from `live-backend/`:

```sh
node --import tsx scripts/dev/ln-skill-benchmark.ts [path/to/database.db]
```

Use `--baseline=path/to/before.json --check` to verify matching chart hashes,
emit the per-course before/after LN and cached Overall table, and exit nonzero
when any acceptance criterion fails. All current checks pass (exit 0).
The output includes all 17 shipped/refitted rating comparisons and their
maximum absolute difference; this replaces the separate coefficient bounds.
The read-only benchmark also checks 1,000 cached sub-45%-hold charts nearest
the eligibility boundary plus two regression controls at 0.75×, 1× and 1.5×:
3,006 chart/rate evaluations, no LN identities gained. Synthetic tests cover
the effective-share gate even when raw hold share exceeds 45%, and chain
boundaries, rates, mirrors, offsets, isolated pairs and short overlapping rolls.
Native Overall references are cached values, not newly fitted LN targets or
a claim of cross-skill difficulty equivalence.

V4 also checks the cached high-hold DT negatives FREEDOM DiVE
[FULL DiMENSiONS] and Le Porteur d'Ombre [Lightless], which the sub-45%
controls cannot cover. Their identity shares are 20.7% and 24.3%; both stay
rice. Synthetic repeated half-duty holds exercise chain difficulty at 100%
raw holds, short-chart fallback, rate baking, mirroring and time offsets.
All 17 courses remain LN-eligible with exactly unchanged scalar ratings
versus v3; the identity fix does not undo the course-order improvement.

One-off corpus data/scripts/results stay in ignored `local-notes/`, not this
reference directory. Structural correctness and replay quality calibration
do not establish LN specialist ranking accuracy. Before claiming broader
scalar validation, collect independent player
outcomes and expert structural labels, hold out players and related chart
families/rates, and control for Overall skill and LN exposure.
