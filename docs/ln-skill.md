# 4K LN workload and skillsets

The independent LN model is shared by the backend and frontend through the
`#dan/*` alias. It supports native **4K** only. Other keymodes keep their
existing difficulty policy; 7K keeps General, Tech, Inverse and Release.

Version **13** replaced the withdrawn v10 draft; **14** prices every written
hold and every chord finger (below). The workload is specified
from required actions and their interactions, and synthetic tests check that
mechanical contract. Three things are fitted: the strain-to-rating conversion
and the rate-mod response (below), and the skillset classifier.

## Input and ownership

`ln-timeline.ts` preserves paired heads/tails, taps, lanes and exact
times. Equal timestamps form rows. Near timestamps stay distinct. A same-lane
tail/head at contact remains a release and a new press. Times divide by rate
once; applying a rate and baking that rate into the note times give the same
strain. The rating adds the rate-mod response on top, so a pre-rated upload
reads below the same chart under the mod. Mirroring, input order and a global offset preserve the result.

Invalid lanes, non-finite times, nonpositive holds, duplicate objects, overlaps
and taps inside a same-lane hold make difficulty unavailable. The model does
not repair them. The analysis input contains notes, keycount and OD; titles,
chart/player ids, filenames, Dan verdicts, pp and native MSD are not inputs.

`ln-workload.ts` owns the required-action pass. `ln-skill.ts` solves overall
and component difficulty. `ln-skillset-classifier.ts` decides which of the four
course skillsets a chart reads as; `ln-skillsets.ts` and `ln-skill.ts` publish
its result.

## Effective holds and chart identity

The existing effective-hold and identity policy remains in
`dan-estimator/ln-effective.ts`. It decides whether a chart is LN and whether
it publishes an LN number; since v14 it no longer discounts the work of the
holds a tap would release (see the pricing note below). Eligible near-window
release/repress chains retain their existing treatment. LN vibro cannot create
chains merely from short written holds.

A body past the release window is not enough on its own: an ordinary tap
stays down for a while before it lets go. In 1,230 lazer 4K LN replays (2.46M
taps) that time is log-normal, its median rising from 48ms when the same
column comes back 55ms later to 80ms from 210ms on, with a log spread of 0.29.
Each hold counts by the chance a tap is too short to release it inside the
window, and a chart whose windows fall under 10% of notes on that count (the
note-weighted median) reads rice unless its same-lane release/repress chains
alone carry identity. The LN rating cannot lift it, and it publishes no LN
number. The line sits between the owner's rice labels (up to 0.084, a
1/4-held full-LN chart at 1.0x that plays as jumpstream) and LN labels (from
0.112). At 1.0x it moves 391 of 9,858 LN charts to rice, 58 of 2,590 with an
LN-named difficulty, and no inverse-named chart or course; at 1.5x it moves
1,441 of 6,324, mostly full-LN streams whose bodies a tap covers at that
rate, and six LN courses.

Physical work reads the actual played OD. Identity retains its OD-5 minimum
and its section-based long-tail/chain reading. Raw 4K hold share must reach 45%,
and effective identity share must reach 40%, to earn the LN player axis.
At least a tenth of written holds must carry identity work to publish an LN
number. The existing structural/rating identity resolver remains shared by
chart, rate and player consumers.

Native 4K MinaCalc receives its original press/head projection. Even legacy
`lnTailTaps: true` callers cannot inject 4K tails. The LN calculation does not
alter native Overall or multiply native values by hold share.

## Mechanical work

The model treats one press as one command. A required release has the
reciprocal timing work of the ScoreV2 tail/head window ratio: `1 / 1.5`.
These are explicit model conventions, not measured human difficulty units.

| Interaction | Treatment |
| --- | --- |
| Simultaneous or close same-direction finger commands | One command per finger |
| Repeating the same finger | A new command, even inside chord-group tolerance |
| Moving a finger while its same-hand neighbour stays held | One independence task |
| Pressing one finger while releasing its partner | One opposing-direction control task |
| Same-lane release/repress | Recovery demand from the unfilled part of the release window, including contact |
| A tap immediately preceding/following a same-lane hold | Shield/reverse-shield motion and recovery, counted once |
| Release between nearby head commands | Window-overlap timing conflict outside shared-motion tolerance |
| A chord started together but released separately across hands | A shared timing task, half assigned to the releasing hand |
| Passive held body, SV, scroll speed or sustain ticks | No physical work |

The shared-motion tolerance is the existing 20 ms convention. Grouping changes
command cost, never note timestamps or topology. A constrained finger is
counted once even if several descriptions apply (lock, anchor, nested hold,
crossing hold). Duration variation alone does not invent additional commands.

A normal tap contributes LN work when it interacts with a hold on
that hand or a same-lane shield/recovery. An unrelated rice passage and free-hand
rice do not supply LN strain.

## Strain, aggregation and numeric units

Each hand has fast strain with the existing 700 ms half-life and sustained
strain with four times that memory. Sustained impulses are divided by four,
so both memories have the same steady-state units. Their root-mean-square combination distinguishes a burst from ongoing work
without counting the same load twice. Each hand keeps the original strain
units, then the existing `max(hand) + 0.3 * min(hand)` convention combines the
hands. It adds no passive-duration bonus. The v12 four-channel quadratic sum
incorrectly treated two time views of each hand as independent workloads; v13
corrects that unit mismatch before applying the existing numeric conversion.

The pass records 500 ms section peaks and actual action work. Sections sort by
demand and receive fixed `0.95^rank` weighting, following the ranked-section
aggregation approach in the LN1 reference. The inherited response model is
`exp(log(0.93) * (demand / skill)^4)`. A bounded binary search finds the skill
that reaches the requested goal. Chart difficulty uses 0.93.

The strain-to-rating conversion `3.6427 * strain^0.57` is fitted on scores:
a player at LN Dan N should read on LN what a player at regular Dan N reads
on Overall from rice plays alone, both aggregated over up to 20 top plays.
The v14 refit (2026-09-30) matches the median of each Dan from 2 to 16 over
3.7k players with an LN Dan and 20k with a regular one (five plays or more on
the side); Dans 3 to 15 agree within 1.8, root mean square 1.1. LN Dans 1 and
2 still read above, and few players sit there. The v13 conversion was
`6.6805 * strain^0.4316`; a fit to native Overall on the odd LN courses before
it read those players 3.75 lower, because MinaCalc does not see releases.

Every written hold is priced as a hold, including one whose body a tap would
release in time, and a chord costs each of its fingers. v13 priced each
hold's release work by the chance an ordinary tap is too short to release it
and made chords concave, which read dense short-hold charts as easy and, at
1.5x, most of a chart's holds as free. On same-player scores (7,550 players,
218k pairs of 1.0x plays on charts of 75%+ holds, 19.7k pairs at 1.5x, OD as a
covariate) the harder chart of a pair reads harder 86.0% of the time at 1.0x
and 85.2% at 1.5x, against 82.7% and 66.5% for v13, 82.8% and 75.5% for the
v9 production model, and 85.3% and 80.8% for native Overall. Charts split by
mapset agree on the unseen half (86.7% and 84.9% against native Overall's
85.2% and 79.0%). v13 still ranks the easiest band (both charts under native
Overall 22) better, 75.4% against 72.5%. Keeping a floor on short bodies
(45ms), pricing them as presses only, or at half weight all read worse.

A rate mod multiplies the rating by `rate^0.06` when speeding up and
`rate^-0.05` when slowing down. With every hold priced, the strain already
grows with the rate. Both are fitted on how the same player's accuracies
order a chart played at the rate against another at 1.0x (109k DT and 42k HT
pairs, charts split by mapset): 0.06 orders 88.6% of the unseen half against
native Overall's 85.5% and 86.5% for the v13 curve at `rate^0.649`, which on
the v14 strain orders 73%. On the same player's plays of one chart at both
rates (900 DT pairs) the LN SSR then moves 1.08x where native Overall moves
1.22x, so a chart's LN number sits a little closer to its native Overall at
DT than at 1.0x (median +3.9 against +5.4 at goal 0.93). Slowing down, the
same-chart pairs (679) and the ordering agree on -0.05.

LN is one strain and score-goal solution over all the work. `ln-ssr.ts`
retains the 0.965 solver cap and extrapolates the cap/base slope above it. Native and LN use their existing separate calibrated
performance goals; this change does not retune the Wife calibration.

## Four skillsets

The families follow the stages of _underjoy's 4K LN Dan Courses v2: Stage 1
all-round/hybrid, Stage 2 jack/technical, Stage 3 jumpstream/wall, Stage 4
speed. Nineteen texture measures (chords, jacks, rolls, presses under held
columns, inverse spacing, column locks, hold length, and where tails land
against the presses around them) are each read against ordinary 4K LN charts
of the same row rate, since most rise with density on their own. The weights
must keep physical signs:

- **All-round** (wire id `lnhybrid`): LN chords count toward it.
- **Technical:** fast LN jacks and tails between rows count only toward it.
- **Walls:** presses made while other columns are held count toward it, and
  so do chords.
- **Speed:** rolls count toward it; chords, jacks, held columns and split
  releases count against it.

The reference is quantiles of 10.7k cached 4K charts with at least 30% holds.
The weights are a logistic fit to 1,639 labeled 4K LN charts: the 64 course
stages (1st to 16th), charts whose pack title, difficulty name or mapper tags
name one skillset (release and LN jack packs, wall and inverse packs, LN
stream and speed tags), and textbook patterns (flowing rolls, one-column and
chord LN jacks, held walls, inverse, LN chords). Classes are balanced, tags
count at 0.3 and course stages at 5. Holding out a tenth of the packs at a
time, it names the labeled skillset on 52% of Technical, Walls and Speed charts
(balanced) against 39% for the earlier course-only fit, and on 41 of 64 course
stages. Fitted on everything it places 48 of 64 stages and every textbook
pattern; forcing all 64 cost 13 points on the other packs. Full-LN stream packs
are left out, because every press lands under held columns and they measure as
walls. The earlier per-action family split in `ln-workload.ts` matched 15 of 60 and
was removed, along with its per-family ratings, which never moved the LN number
(0 of 2,137 charts).

`lnSkill.skillsets` names at most two families. The leading family is 1, the
runner-up is its probability over the leader's, and the rest are 0. The wire ids `lnhybrid`, `lntechnical`, `lnwalls`, and
`lnspeed` select Dan evidence and its four course-stage buckets. They are not
MSD/SSR axes. Maps, player ratings, radars and skill leaderboards publish just
one **LN** value alongside native skill ratings. Family rating fields in
previously cached rows are ignored by the rating surfaces.

## The separate rice/LN hybrid badge

The badge is a composition claim, distinct from the Hybrid LN skillset.
`lnRiceShare` measures objects in consecutive rice phrases with no active LN
work. Four consecutive head rows establish a phrase, and long rests separate
phrases. Individual taps threaded through LN commands do not qualify.

The badge requires at least one quarter rice-phrase evidence, the existing
25–75% raw hold band, and the minimum effective-hold work share. Missing
measurement withholds the badge until the bounded refresh reaches the chart.

## Persistence and rollout

Current versions: LN skill **14**, player skills **51** (seeding 50 and earlier),
rate cache **34**, effective-LN model **11** and sweep **22**, subtype sweep **10**, player Dan
sweep **53**, and player pattern sweep **19**. Chart detail responses provide the fresh base MSD, identity and primary Dan
so the modal can override an older cached map entry. The newer stamps invalidate the
withdrawn v10 and intermediate v11/v12 local artifacts as well as older cached models. Retained score
evidence and native calculations remain reusable.

Persist only scalars, the four-value family record, eligibility, version
and calculation metadata. Full event rows, object ids, structural detections
and interval previews stay out of production artifacts; the structure
analysis that produced them is retired. `compact:ln-artifacts` keeps removing
legacy previews without discarding the scalar or family fields.

## Verification and manual inspection

Tests cover exact pairing, invalid topology, free holds, chord grouping,
release/repress boundaries, independence, opposing actions, passive holds,
recovery, rice isolation, mirrors, input order, offsets, baked rates, family
classification, goal monotonicity, SSR extrapolation, migrations and native
baseline preservation. They establish software/mechanical correctness, not
human rating accuracy.

The historical benchmark command is now a read-only inspector for files
chosen by the reviewer:

```sh
node --import tsx scripts/dev/ln-skill-benchmark.ts path/to/chart.osu
```

It emits fingerprints and 0.75×/1×/1.5× results. It performs no fit, uses no
hardcoded map/player targets, and has no pass condition requiring a particular
rating, family or ranking.

## References

The reference projects informed the interaction vocabulary and design:
[LN1 Analyzer](https://github.com/LumiereLP/osu-mania-4k-LN1-Analyzer),
[Akuta Zehy's analyzer](https://github.com/AkutaZehy/osumania_estimator),
[Dan-Overlay](https://github.com/acarranzao1a-png/Dan-Overlay),
[ManiaDanOverlay](https://github.com/Luis-Tanese/ManiaDanOverlay), and
[SkillMania6](https://github.com/yumu-bot/yumu-bot).
Their fitted models and claimed accuracies are not adopted. LN1 is scoped to
coordination and warns about LN-jack inflation; the implementation therefore
keeps physical work and interaction ownership explicit.
