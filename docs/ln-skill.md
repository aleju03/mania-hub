# 4K LN workload and skillsets

The independent LN model is shared by the backend and frontend through the
`#dan/*` alias. It supports native **4K** only. Other keymodes keep their
existing difficulty policy; 7K keeps General, Tech, Inverse and Release.

Version **13** replaces the withdrawn v10 draft. The workload is specified
from required actions and their interactions, and synthetic tests check that
mechanical contract. Three things are fitted: the strain-to-rating conversion
and the rate-mod response (below), and the skillset classifier.

## Input and ownership

`ln-analysis/timeline.ts` preserves paired heads/tails, taps, lanes and exact
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
`dan-estimator/ln-effective.ts`. A hold whose body a tap can cover supplies no
tail, held-finger constraint, or LN recovery work. Eligible near-window
release/repress chains retain their existing treatment. LN vibro cannot create
chains merely from short written holds.

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
| Simultaneous or close same-direction finger commands | Square-root chord work; each added finger adds the incremental chord cost |
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

A normal tap contributes LN work when it interacts with an effective hold on
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

The strain-to-rating conversion `3.40659 * strain^0.53908` is a log-log fit
of strain to native Overall on the odd 4K LN courses (1st to 17th), the method
behind the v9 constants. v13 first kept the v9 pair, which was fitted to v9's
smaller strain, and read 4.7 above v9 and 4.2 above native Overall at the median
of 2,674 cached LN charts. After the refit the even courses are off by 1.54 MSD
on average and the corpus median sits 0.06 below native Overall. It does not
make LN and native difficulty equal.

At 1.5x a third to a half of the holds become tap-covered and drop their LN
work, so on strain alone the rating moved as rate^0.29 at 1.5x, against native
Overall's rate^0.75 on the same charts. The rating therefore multiplies by
`rate^0.436`, a least-squares fit over 157 cached LN charts' DT and HT native
values, which lands at rate^0.72 at 1.5x and rate^0.91 at 0.75x.

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

- **Hybrid:** LN chords count toward it.
- **Technical:** fast LN jacks and tails between rows count only toward it.
- **Walls:** presses made while other columns are held count toward it, and
  so do chords.
- **Speed:** rolls count toward it; chords, jacks, held columns and split
  releases count against it.

The reference is quantiles of 10.7k cached 4K charts with at least 30% holds.
The weights are a logistic fit to the 64 course stages (1st to 16th), plus
textbook patterns: flowing rolls, one-column and chord LN jacks, held walls,
inverse, and LN chords. The fit places every stage and every textbook pattern.
Tested one course at a time against a fit to the other 15, the top family
matches the stage on 37 of 64, and no feature set tried did better than 40.
The earlier per-action family split in `ln-workload.ts` matched 15 of 60 and
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

Current versions: LN skill **13**, player skills **51** (seeding 50 and earlier),
rate cache **34**, effective-LN sweep **17**, subtype sweep **10**, player Dan
sweep **53**, and player pattern sweep **19**. Chart detail responses provide the fresh base MSD, identity and primary Dan
so the modal can override an older cached map entry. The newer stamps invalidate the
withdrawn v10 and intermediate v11/v12 local artifacts as well as older cached models. Retained score
evidence and native calculations remain reusable.

Persist only scalars, the four-value family record, eligibility, version
and calculation metadata. Full event rows, object ids, structural detections
and interval previews stay out of production artifacts. Detailed structure
remains an opt-in offline diagnostic. `compact:ln-artifacts` keeps removing
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
