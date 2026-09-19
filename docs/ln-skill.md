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

`ln-skill.ts` version 8 supplies the single independent LN rating and consumes
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

Identity reads that window at no less than OD 5 (`LN_IDENTITY_MIN_OD`,
effective model v6, 2026-09-18). At OD 0 the release window is 96 ms, so on
a low-OD file most 1/8 holds at any tempo count as free and a hold-heavy
chart files as rice for the OD its mapper left rather than for its notes: of
the 923 cached 4K charts at OD 0 past the hold line, 580 read rice at 1.0x,
and 441 of those are LN once the window is read at OD 5. Over the 1,481
charts under the floor, 496 join LN at 1.0x, 210 at 1.5x and 124 at 0.75x,
and none cross the other way (a floor of 5.5 would send one chart to rice).
Only the LN-or-rice question reads the floor: `effectiveHoldMask`, the
effective-hold counts, the LN rating and the tail pass keep the played OD,
and the 4K LN dan credit floor stays at OD 7. An LN vibro chart
(`detectLnVibro`: 50%+ holds with a p75 row gap of 40 ms or less at the
played rate) forms no chains at all, because a vibro pack's 43 ms holds
became 58 ms bodies at 0.75x, within 20 ms of the OD 5 window with 58 ms of
recovery, and chained into an inverse reading; its long holds still count.
`identityWorkShare` (holds carrying long or chained work at the identity OD,
over all holds) is stored as `lnWorkShare` and separates a hybrid from a
chart whose holds are notation; the LN number is published (`rated`) only
when it reaches `LN_MIN_WORK_SHARE` (0.1), the same line the hybrid badge
uses.
Identity (effective model v5) reads each 10s section two ways and takes the
higher: the **long-tail** share against the 40% line, or the release-work
share (long plus chained holds) against a 60% line, scaled onto the same
0.40 number so one stored share (`effectiveLnRatio`) answers both. A window
made almost entirely of chained holds is inverse: an inverse handstream at
264 bpm writes 57ms bodies under a 63ms window and never has a long hold,
yet every note is a release and a repress. V3 let chains establish identity
on the 40% line, which promoted high-hold DT charts (FREEDOM DiVE [FULL
DiMENSiONS] and Le Porteur d'Ombre [Lightless] at 1.5x); v4 removed chains
from identity entirely, which filed 95%-hold inverse charts as rice. The 60%
line sits between the owner's labels: the 264 bpm inverse handstream (0.80
release-work share) and a pack chart at the same tempo (0.66) are LN, while
at 1.5x a 1/4-held jumpstream chart (0.53), FREEDOM DiVE (0.48) and Le
Porteur (0.27) stay rice, as DT on such charts plays as jumpstream.
This is a rearticulation workload heuristic, not a proof that an early
release cannot score. Cached top-course gaps are commonly 40–60 ms, not
literal same-lane tail/head contact.

After structure, the rating tiebreak (`dan/ln-identity.ts`, 2026-09-18): a
4K chart past the 45% hold line whose section share still falls short is LN
when its LN rating at that rate is at least `LN_RATING_IDENTITY_MARGIN` (1)
above native Overall at the same rate. The case that needed it is a 160 bpm
chart of 1/4 and 1/2 holds with 1/4 same-lane gaps, half inverse and half
minijacks under a held note, that plays as LN at 1.5x (LN 29.5 against
Overall 26.5) while a 1/4-held jumpstream chart (28.9 / 29.1), FREEDOM DiVE
[FULL DiMENSiONS] (32.4 / 37.4) and Le Porteur d'Ombre [Lightless]
(26.9 / 31.4) play as jumpstream at the same rate. No structural reading
(long share, chain share, notes under an active hold, occupancy) orders
those four the way players do; the ratings do. Corpus cost on charts
structure leaves rice: 10 at 1.5x, 5 at 0.75x, 154 at 1.0x (LN packs and
full-LN diffs). The stored `lnEffectiveRatio` is lifted to the 0.40 line so
every consumer keeps reading one share; `lnStructuralRatio` keeps the
measured number and `lnRatingIdentity` marks the lift, on the nomod
classification and the DT/HT verdicts alike. The classifier applies it
whenever its caller supplied MSD at that rate; the async adapter
(`classifyChartWithCompanella`) fetches MSD itself for the undecided band,
and the effective-LN sweep reads the stored MSD artifacts. Plays inherit
the chart's verdict at their rate through `ChartSkillInfo`, on top of their
own structural reading at the played OD.

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

The strain a chart hands to the scale is, since v9 (2026-09-18), the
geometric mean of two numbers (`LN_SKILL_PEAK_WEIGHT` 0.5): the skill at
which the whole chart's LN sections reach the 93% goal, and the single
hardest half-second's demand. The goal skill alone averages the 93% over
everything, so a 5:38 chart whose drop peaks at demand 36 solved to 21.3
while a 1:30 chart peaking at 31 solved to 20.3; the blend lets a long chart
with one brutal section read as its section. Rating only the hardest 30-90
seconds instead put course 16 under course 15, so it stays a blend.

The scale is `3.9707727589870347 * strain^0.548325895663114` (refit for the
blended strain on the nine odd courses; the pre-v9 fit was
`4.818919597751967 * strain^0.5277221146076253`),
multiplied by `rate^(0.77 - 0.5483)` (`LN_SKILL_RATE_RESPONSE`, v8). Strain
grows linearly with rate on a chart whose holds keep their work, so the fit
alone answers as `rate^0.53`: HT LN plays priced at about 90% of their NM
chart and DT plays at 88-105%, against native Overall's `rate^0.75` at 1.5x
and `rate^0.80` at 0.75x on the 150 local 4K LN charts with cached DT/HT
artifacts (2026-09-17). LN sits on the native scale, so it follows the same
curve; 1.0x ratings and the course fit below are untouched. Holds that rate
makes free are still stripped first, so a DT rating can stay under Overall
when the chart's short holds become taps.
Its historical fit used nine odd-level 4K LN courses against native MSD, with
eight even-level courses as diagnostics. This only aligns a numerical range.
The 17-course evaluation gives Spearman 0.9902 under the v9 blend, the same
as before it, with levels 16 and 17 above level 15 and all 17 still
LN-eligible. The shipped scale/exponent are the refit itself, so the
rating-space stability check (every course within **1.0 MSD** of the
refitted curve at the same strain) passes at zero difference. The eight
diagnostic courses' mean absolute error against cached native Overall is
1.3499059647053777 with the v9 constants, against 1.4064630384488246 for the
pre-v9 curve on the pre-v9 strain. The course ratings themselves rose by
1.9 to 3.8 (level 1 11.56 to 13.41, level 17 32.73 to 36.57), since a course
is a marathon of sections at its level and the peak half now counts; across
the 9,665 cached 1.0x LN charts the median rating moved down 0.7 after the
refit, and long charts with one hard section gained up to 3.6. These are
numerical-scale diagnostics, not human difficulty errors; the scalar emits
no provisional calibration marker or tooltip label.
The eight even courses remain diagnostics, and using this ladder to inspect
the fix makes these course-order results an in-sample check, not independent
player-outcome validation. No scale transfers to other keycounts.

To earn the independent 4K LN axis a play must pass both 45% hold share and
the 40% identity share at its own rate/OD (`lnSkill.eligible`). The LN
number itself is published (`values.LN`, `lnSkill.rated`) on every chart
past the 45% hold line that has any effective hold, identity or not: a
55%-hold technical chart whose LN sections fail identity still shows its LN
difficulty beside the native values, and the map headline stays with
identity (`msd-headline.ts`). Player LN credit follows `eligible` only.
Other modes
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

Player skills version 45 (LN v8, effective v5, effective sweep v12, rate
cache v28, player Dan/pattern sweeps v45/v13) seeds from 44 down: only the LN
sidecar moves, and `playLnSkillCurrent` refreshes it per play on its own
version. Player skills version 40 seeded from versions 39 through 16 and migrates
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
