# Independent 4K LN analysis and skill

`live-backend/src/dan/ln-analysis/` implements the structural contract in the
[4K LN handoff](osu_mania_4k_ln_minacalc_agent_handoff.md).
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

`ln-skill.ts` version 6 supplies the single independent LN rating and consumes
the same exact timeline. It uses
`effectiveHoldMask` at the played rate/OD to remove free holds, then combines
release impulses, same-hand held-finger coordination, hold starts and
release-to-repress recovery in two hand strains (700 ms half-life). Section
peaks are weighted by LN work. A separate hard rice section cannot supply LN
strain or endurance. Mirroring and a global time offset preserve the result.

Effective-hold model v3 normally requires played duration to exceed the
OD-dependent release window, `1.5 * (64 - 3 * OD)` ms. It additionally prices
near-window same-lane hold chains: at least two consecutive hold-to-hold
links (three heads), each contributing body's duration at least the window
minus the existing 20 ms shared-motion tolerance, and a nonnegative
tail-to-next-head gap no greater than that window. A chain's final hold needs
its own qualifying outgoing link or a genuinely long body to count.
`chainedShortHolds` reports these additions separately from `longTails`.
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
40% effective share at its own rate/OD. Mixed charts can retain a diagnostic
scalar while publishing `values.LN = 0` if they fail identity. Other modes
keep their existing hold-share gates and Overall-on-LN player axes (7K:
37.5%; others: 45%). This is distinct from calibrating their score quality.

## Caching, API and migration

Timeline version 1 / structural analysis version 2 fingerprints hold **endpoints**, rate, scoring
profile, hands and model versions. The fingerprint is a cache identity, not
a security hash. Full analysis retains lossless rows and complete evidence.
Chart artifacts expose bounded previews: at most 128 representative
detections, 64 object IDs per detection and 128 diagnostics, alongside full
counts and truncation flags. Per-play caches store only `structureKey` and
compact LN results, not repeated chart interval previews.

The four coverage profiles and the interval preview stay in the stored
artifact for the sweeps and the search evidence, but the map panel does not
show them and the analysis responses no longer carry `lnStructure`.
The index tags two structural facets, Shields and Reverse Shields, with
stable `lnshield`/`lnreverseshield` IDs from `ln-analysis/search-patterns.ts`
(4K nomod only). The LN dropdown does not offer them as of 2026-09-14; they
require current LN eligibility and do not change player axes or ratings.
Search evidence v2 reads the whole chart: a hold is shielded when the
previous object in its column is a tap at most 0.3 beats earlier (a quarter
beat with room for 1/6 and drift), reverse-shielded when a tap follows its
release within the same gap, with the beat length taken from the chart's
uninherited timing points at that time (nominal BPM, then 180 BPM, as
fallbacks). Shields need at least 3% of the chart's holds, reverse shields
12% (median 7% across LN charts: a tap after a release is ordinary LN
texture), and at least 20 holds either way. On the 300 most played 4K LN charts the half-beat pairs are the
ordinary tap/hold alternation of any LN chart (one 5-minute chart had 147
of them and 17 quarter-beat pairs, and no shield section), while a chart
known for its shields had 5.4% and a shield-heavy one 14.5%.

Search index revision 17 reads this aggregate from the **full** analysis,
never the bounded preview, and also stores `ln_share`, the hold share of the
chart's objects from osu!'s counts, behind the LN share slider. Missing/old
evidence stays untagged until the effective-LN cached-file sweep fills it.
Invalid, non-1× or non-4K structures do not invent hits. Index rebuilds
remove obsolete tags; chart refreshes fill the new ones. Queries perform no
parsing/API work. DT/custom-rate views never relabel 1× evidence as
accelerated evidence. A stale LN artifact can refresh without discarding
the cached native vector if the chart file is unavailable.

Player skills version 38 seeds from versions 37 through 16 and migrates
compatible retained evidence in bounded
passes. It recomputes changed calibrated goals, removes stale 4K tail blending
(tail pass version 4), and refreshes LN version 6 metadata. Historical scores
whose facts/calculation are pending remain durable with no credited stale
SSR. Budget-deferred work queues continuation; missing files alone do not
create a retry loop. Vibro, chart-family and Dan evidence policies remain in
force. Chart sweeps refresh eligible base/DT/HT LN artifacts and clear obsolete
4K tail artifacts. Effective-LN sweep v10 also fills full search evidence;
rate-estimate cache v23 and player Dan/pattern sweeps v35/v11 propagate it.
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

One-off corpus data/scripts/results stay in ignored `local-notes/`, not this
reference directory. Structural correctness and replay quality calibration
do not establish LN specialist ranking accuracy. Before claiming broader
scalar validation, collect independent player
outcomes and expert structural labels, hold out players and related chart
families/rates, and control for Overall skill and LN exposure.
