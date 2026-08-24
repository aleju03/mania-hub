# LN axis freeze file — 2026-08-21

Frozen before any label was joined. This file defines the eligibility filter,
the metric, the ordered candidate family, the controls, the test statistics,
the success criteria, the sensitivity set and the exclusion rules. Nothing in
here may change after labels are seen; any change marks the run exploratory.

SHA-256 of this file is recorded in the session transcript and reported to the
user before the join script runs.

## Provenance caveat (declared up front)

The earlier design briefs describing "LN Lean" and "Release Load" are not in
the repository; their exact formulas cannot be recovered. The candidates below
are reconstructions from the constraints quoted in `ln-axis-plan-2026-08-18.md`,
chosen so that their measured population fingerprints match the plan's quoted
fingerprints as closely as possible. All fingerprints below are measured on the
local 2026-08-21 snapshot (stale prod backup + local writes) and are shape
evidence only. §0 diagnostics reproduce exactly on this snapshot (Ref(k)
9,093 / 1,223 / 43; rho(R_ln, share_ln) 0.851 / 0.519; ceiling mass 41.5% /
20.6%; share_ln percentiles identical to the plan's table), which validates the
fold pipeline itself.

## Unit and eligibility

The unit is a **(player, keymode) cell**. Data: one frozen snapshot of
`player_skill_ratings.plays_json` at `PLAYER_SKILLS_VERSION = 16`, produced by
`scripts/ln-axis/fold-cells.ts` read-only. Plays carrying the value-agnostic
MinaCalc poison signature are dropped (post-heal this removes ~0 plays; the
Phase 0A sweep ran locally 2026-08-21 and on prod 2026-08-18).

A cell is eligible (**Ref(k)** member and labelable) iff:

1. `N >= 20` clean plays at that keymode;
2. `n_ln >= 20` plays on charts tagged `ln` at `PATTERN_TAG_MIN_SCORE = 0.5`
   (tech veto does not apply to `ln`);
3. newest `endedAt` within 365 days of the snapshot date;
4. keymode equals the label's stated keymode (question 2);
5. one cell per player: if a labelled player has eligible cells in several
   keymodes, the stated keymode picks the cell (pre-declared choice 2).

Measured Ref(k) on the local snapshot: 4K = 9,093; 7K = 1,223; 6K = 43.
**6K is excluded entirely** (43 eligible cells site-wide; no design can be
validated there). **7K is the primary stratum; 4K is secondary and admissible**
because the Phase 0A heal has run on prod (done key 2026-08-18T08:50Z) and
locally (2026-08-21T19:17Z).

## Metric

For cell `(p, k)` with `O(p)` the `aggregateSsrs` of its clean Overall SSRs
(repo implementation, verbatim import):

- axis partition `x`: plays whose chart carries tag `x`; `n_x`, `A_x`
  (`aggregateSsrs` over those plays' Overall SSRs), `share_x = n_x / N`,
  `R_x = A_x / O`.
- Primary discriminant per candidate value `v`: the skill-matched band
  percentile

  ```
  D_v(p) = 100 * |{q in Ref(k) : |O(q) - O(p)| <= 1.0 MSD, v(q) < v(p)}| / (|band| - 1)
  ```

  Band half-width **1.0 MSD, declared a priori, never varied.** Cells whose
  band has fewer than 2 members get no D; cells whose candidate value is
  undefined (below that candidate's own minimum-evidence floor, listed below)
  are excluded from that candidate's test and counted in its exclusion log.
- Test statistic: `AUC = U / (n1 * n2)` with mid-ranks for ties, computed per
  keymode stratum; the combined statistic is `sum(U_k) / sum(n1_k * n2_k)`
  with permutation performed **within** strata. AUC is reported with a
  bootstrap CI, not just a p-value.

## Frozen candidate family (ordered)

| # | Name | Exact per-cell value | Min evidence |
|---|---|---|---|
| 0 | Incumbent `R_ln` | `parts.ln.A / O` | `n_ln >= 20` |
| 1 | Baseline exposure `share_ln` | `parts.ln.n / N` | — |
| 2 | **Candidate 1: LN Lean (band)** | Within the cell's band, OLS `A_ln ~ A_rest` over Ref(k) band members (2 parameters, refit per band); value = residual of the cell. Declared alternative forms rejected: population-level residual-on-rest (rho 0.989 with incumbent at 4K — adds nothing), size-model `A_ln - O*f(n_ln)`, ratio-residual, 4-parameter count-corrected variant. | band size >= 8 |
| 3 | Candidate 2: Release Load | Mean tail delta over the cell's `ln`-tagged plays, delta per play = `blendLnTailValues(msd, msdLn, keyCount).Overall - msd.Overall` for ready chart rows with `lnRatio >= LN_TAIL_MIN_RATIO` and clean MSD columns. Sensitivity variants declared now: mean over all plays; LN-vs-rest contrast. | `>= 5` contributing plays |
| 4a | Candidate 3: tag threshold 0.7 | `R` over plays with ln tag score `>= 0.7` | `n >= 20` |
| 4b | Candidate 3: tag threshold 0.8 | `R` over plays with ln tag score `>= 0.8` | `n >= 20` |
| 4c | Candidate 3b: tag ∧ lnRatio>=0.3 | `R` over plays with tag `>= 0.5` and chart `lnRatio >= 0.3` | `n >= 20` |
| 4d | Candidate 3b: tag ∧ lnRatio>=0.5 | same with `lnRatio >= 0.5` | `n >= 20` |
| 4e | Candidate 3b: pure dan verdict | `R` over plays with chart `classification.lnRatio >= 0.5`, no tag requirement (this is the analyzer's own LN side split) | `n >= 20` |

Candidate 3b variants are declared here, before labels, because the shipped
0.5 tag demonstrably over-admits: 76.3% of 4K charts tagged `ln` sit below the
analyzer's own LN verdict (`lnRatio < 0.5`) — the gamma-chart complaint that
motivated the product fix in `player-skills.ts`. **Structural note, verified
against the corpus: the 7K ln score is damped by 0.62 (`patterns.ts`), so no
7K chart can exceed tag 0.62 and candidates 4a/4b are 4K-only; at 7K the
threshold family reduces to 4c/4d/4e.**

Fingerprints measured on the local snapshot (4K / 7K): leanBand rho vs
incumbent 0.698 / 0.769, pearson r vs Overall 0.046 / 0.085 (skill-neutral by
construction), rho vs share 0.531 / 0.336 rising inside the top band;
Release Load rho vs share 0.787 / 0.716 (the most exposure-bound member, as
the plan predicts), rho vs incumbent 0.755 / 0.499; pseudo-labels built from
exposure alone score AUC 1.000 on leanRest and 0.996 on Release Load — the
exact failure mode the plan warns about, and the reason criterion 3 exists.

## Controls and placebos

- Negative controls (incumbent machinery): `D` of `R_tech`, `R_chordjack`,
  `R_jumpstream` (4K), `R_chordstream` (7K).
- Placebo partitions, each under **its candidate's own machinery**: leanBand
  residual on `chordjack` / `tech` / `offrate` / `oldmaps` / `parity`;
  Release Load mean-delta on the same partitions; incumbent-style `R_p` on the
  same partitions. Split-half Spearman-Brown reliability is reported for every
  partition under both machineries (measured: LN 0.856 R-style / 0.913
  lean-style at 4K against chordjack 0.870 / 0.886, offrate 0.921 / 0.899,
  parity negative — LN's stability is indistinguishable from arbitrary stable
  partitions, which is exactly what criterion 4 tests at the label level).
- Positive control: the second (jack/chordjack-specialist) label set, if
  supplied, run through `D_chordjack`. Without it, "nothing separates" is
  uninterpretable.

## Test and success criteria

Primary test: one-sided stratified permutation Mann-Whitney on `D`, alpha
**0.05**, alternative "LN-labelled cells rank higher", exact enumeration when
the balanced split allows it, otherwise 200,000 seeded (xorshift128) draws.
Holm correction across the candidate family {0, 2, 3, 4a..4e} (baseline is not
a candidate; it is criterion 3's competitor).

**PASS requires all four**, per candidate:

1. `AUC >= 0.80`;
2. Holm-adjusted permutation `p <= 0.05`;
3. beats exposure share-matched: regress `share_ln` out of the candidate
   within the band (population band fit), rerun the test on residuals; the
   candidate must clear `AUC >= 0.80` at `p <= 0.05` there too. Caliper
   matching (positive↔negative within 0.10 share and 1.0 Overall) is reported
   alongside as sensitivity;
4. no negative control and no placebo partition reaches
   `AUC >= AUC(candidate) - 0.05` on the same labels.

Pre-decided saturation gate: a candidate whose ratio-family value sits at its
ceiling (`R >= 0.995`) for >10% of Ref(k) inside the labels' skill band cannot
pass; measured already — the **incumbent structurally fails criterion 1 at 4K**
(41.5% of Overall>=28 cells at ceiling, attainable-AUC cap 0.792) and is
cap-limited at 7K (20.6%, cap 0.897). An incumbent score near 0.79 at 4K is a
demonstration of saturation, not a near miss.

Bar asymmetry: a zero-cost ship needs only the four criteria; anything needing
a `PLAYER_SKILLS_VERSION` bump additionally needs dAUC >= 0.10 over the
incumbent with paired bootstrap 90% CI excluding 0.

Pre-declared strata commitments (amended 2026-08-21 after the Phase 2
eligibility funnel ran, before any label was joined, per the plan's
funnel-before-freeze order): the original "no 7K conclusion above Overall 31"
rule was derived from local band sizes; on the prod snapshot the same bands are
healthier (median band 49 at Overall >= 31, 31 at >= 32, 4 at >= 33) and the
labelled names sit at Overall 31.8–35.8, so an absolute Overall ceiling would
exclude every label by construction. Replaced with a uniform **band-size
floor: `D` is defined for a cell only when its band contains at least 10 Ref(k)
cells** (this generalises the lean_band min-band rule to every candidate and is
enforced in `score-labels.ts`). 6K is never a conclusion stratum.

The label join runs against the **prod cells snapshot**
(`cells-prod.json`, generated 2026-08-21 from the prod DB read-only), not the
local one: all population fits (band residuals, share-adjusted regressions)
are computed from that file at join time. Local numbers remain shape evidence.

## Exclusion rules (logged per name, before group reveal)

- no `player_skill_ratings` row or wrong keymode requested;
- `N < 20` or `n_ln < 20` (with measured numbers in the log);
- recency: newest play older than 365 days;
- duplicate player after keymode resolution;
- per-candidate minimum-evidence floor (listed above);
- disputed names (user-declared) go into neither group.

## Label handling

Labels arrive as `{ osuUserId, keymode, group: "positive"|"negative",
confidence: "high"|"medium"|"low" }`. Primary test runs on high+medium; high-
only is a pre-registered sensitivity. The join script
(`scripts/ln-axis/score-labels.ts`) prints aggregate statistics and the
exclusion log only. Group membership never enters the population fold.

Sample-size gates (from the plan, unchanged): fewer than 5 eligible per side
per keymode → do not run; 5–9 per side → run once, exploratory; 10+ per side →
holdout permitted only if the rater consented to a seeded 40% holdout.

## Sensitivity set (each a deterministic refold flag, declared now)

1. rate-1.0 plays only;
2. top-sourced plays only;
3. truncate each cell to its best 40 LN plays and best 100 plays overall;
4. high-confidence labels only;
5. Release Load variant definitions (all-plays mean; LN-vs-rest contrast);
6. share-caliper matching instead of residualisation for criterion 3.
