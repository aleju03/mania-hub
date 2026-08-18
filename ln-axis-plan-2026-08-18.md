# LN axis: sequenced plan

**What we are testing:** whether the player-facing LN number can be made to say something about LN skill rather than about LN exposure, and whether it says anything at all today.
**What we do first:** nothing that ships. We repair the 4K per-play data (13.47% of stored 4K SSRs are frozen MinaCalc floor values), then publish a label-free population report that is already computed and may answer the product question on its own.
**The one number that frames everything:** the incumbent LN retention ratio rank-correlates 0.851 with "what fraction of your plays are on LN charts" at 4K. The axis is, in rank terms, five sixths a play-count fraction.
**What would make us stop:** if exposure share separates the labelled players as well as any candidate axis, or if the incumbent already separates them, we ship nothing and write that down.
**What we will not do:** no `PLAYER_SKILLS_VERSION` bump and no 126k-chart backfill until a phase has already earned it with evidence. At roughly 20 labels neither can be earned.

---

## 0. State of the world, verified 2026-08-18 against the local snapshot

Read-only via `node:sqlite {readOnly:true}` against `live-backend/data/mania-hub-live.db` (10.9 GB). The local backend holds the DB on :7227; `@libsql/client` cannot open read-only, so every script in this plan uses `node:sqlite`. The local DB is an old prod backup plus local writes: good for shape and distributions, not evidence about prod.

**Three premises repeated across the earlier briefs are stale and must not enter the freeze file:**

| Claim in the briefs | Actual state (verified) |
|---|---|
| `skill_exact_curves:v1` does not exist locally, so the approximate fallback serves | It exists: 46,231 bytes, `updated_at` 2026-08-17T00:09:37. The **exact** branch of `decoratePlayerSkillBreakdown` is what runs. |
| The msd poison sweep never ran; 55% of ready 4K chart rows are poisoned | `msd_poison_recovery_done:v1` finished 2026-08-15T23:17:13. The chart corpus is clean. |
| The frontend and backend `patterns.ts` / `ln.ts` copies disagree | `src/lib/dan-estimator/` is **deleted** in the working tree (staged, by another session). There is one copy now, at `live-backend/src/dan/dan-estimator/`. Do not touch git state. |

**And one premise nobody had, which changes the sequencing:**

The chart corpus healed. The **player** corpus did not.

| Keymode | Stored per-play SSRs (v16 ready) | Carrying the flat MinaCalc floor signature |
|---|---|---|
| 4K | 1,307,433 | **176,156 (13.47%)** |
| 7K | 175,193 | 0 (0.00%) |
| 6K | 10,107 | 0 (0.00%) |

It is bimodal, not diffuse. Of 11,255 4K (player, keymode) cells with at least 20 plays: 2,461 contain poison, 2,145 lose more than 20% of their plays to a poison filter, 1,528 lose more than half. The mechanism is the SSR reuse key at `live-backend/src/features/player-skills.ts:895`, which is `(identity, beatmapId, rate, goal)` with no chart-health or calc-version term, plus the retention loop at `:943-967` that copies previous plays verbatim. A repaired chart never re-rates a cached play. 2,607 of 13,679 ready v16 rows contain at least one poisoned play, holding 379,297 plays between them.

**Population diagnostics, already computed** (eligibility: at least 20 clean plays and at least 20 clean `ln`-tagged plays per cell):

| | 4K | 7K | 6K |
|---|---|---|---|
| Eligible cells `Ref(k)` | 9,093 | 1,223 | **43** |
| rho(R_ln, share_ln) | **0.851** | 0.513 | 0.500 |
| rho(R_ln, Overall) | 0.632 | 0.363 | -0.127 |
| share_ln p05 / p50 / p95 | 0.280 / 0.521 / 0.947 | 0.338 / 0.694 / 0.932 | 0.419 / 0.656 / 0.897 |
| Cells at Overall >= 28 | 3,170 | 211 | 12 |
| ... of those, R_ln >= 0.995 | **1,313 (41.4%)** | 43 (20.4%) | 1 |
| ... implied AUC ceiling `1 - t/2` | **0.793** | 0.898 | 0.958 |

Two consequences are decidable **today, with no labels**:

1. At 4K the incumbent axis is saturated in exactly the skill band world-class LN players occupy. If the labelled positives all sit at the ceiling and 41.4% of the controls do too, the maximum attainable AUC is 0.793, which is **below** any sensible 0.80 pass bar. The incumbent can fail for a structural reason that has nothing to do with whether it measures LN skill.
2. 6K has 43 eligible cells. No design can be validated there. 6K is excluded from this plan entirely, and any design's 6K coefficients are noise.

Other verified facts used below: 13,679 ready v16 rows; 8,535 of them (62%) last computed 2026-08-09 to 2026-08-11 and untouched since, because the drip at `server.ts:791-816` only selects users with **no** row at the version and never refreshes an existing one. 132,445 ready chart analyses, with cached `.osu` coverage at 100% (no `beatmap_osu_files` prune exists in `retention.ts`, contrary to `docs/backend.md`), so any corpus sweep needs zero osu! API calls.

---

## PHASE 0: data integrity. Blocking. No labels are spent until this closes.

> **STATUS UPDATE 2026-08-18, after this plan was written.** Phase 0A is built and merged into the working tree,
> but has **not run yet**: it fires on the next backend boot.
>
> The sweep is `recompute_player_skill_poison_sweep` (`player-skills.ts`, done-key
> `player_skill_poison_recovery_done:v1`, `chart-analysis` worker lane, seeded from `server.ts`). It differs from
> what 0A above proposes in one way that matters: it does **not** delete the affected rows. Deleting would discard
> the durable per-play SSR cache for plays whose score payload has aged out of `score_events` retention, losing the
> good plays along with the bad. Instead it strips only the floor-signature plays out of `plays_json` and backdates
> `computed_at` past `READY_RECOMPUTE_TTL_MS`, so the existing staleness path re-rates exactly the dropped plays on
> the row's next read. That reduces the cost from the ~810k MinaCalc runs estimated above to roughly 176k, and no
> player loses history.
>
> It targets the value-agnostic signature as 0A insists (`Stream > 0 && Stream === Technical && Stream === Chordjack`),
> not a literal. Verified read-only against the local snapshot: 2,620 rows match, 13.44% of stored 4K per-play SSRs
> (176,776 of 1,315,417); 7K and 6K are 0.00%. Covered by `tests/player-skill-poison-sweep.test.ts`.
>
> **Still open from 0A:** the reuse-key calc-health token. The reuse branch in `player-skills.ts` still keys on
> beatmapId + rate + goal with no health term, so a future poisoning would propagate identically and need another
> sweep. Deliberately not folded in, since it changes the hot path rather than cleaning up after it.
>
> **Still open:** 0B, the prod read-only verification. Nothing in this plan has been checked against prod.
>
> Consequence for the gate below: once the sweep has run on prod, 4K becomes admissible as a secondary stratum.
> Until then, read the "heal does not run" branch. 7K is the primary stratum either way.


### 0A. Decide the 4K poison heal

**Cost:** delete the 2,607 ready v16 rows that contain a floor-signature play and let them re-rate. 379,297 plays, roughly 462k MinaCalc runs at the goal-extrapolation factor alone and roughly 810k with the tails factor, at the measured 3.6 to 4.1 ms per run locally: **45 to 80 minutes of serialized wasm** locally, roughly 2.2 hours at a 10 ms/run VPS rate. Spread over 2,600+ job passes on the `dan-estimates` lane (`workers.ts:143`, claimLimit 2), because `MAX_CALC_RUNS_PER_COMPUTE = 150`. Every call serializes through the single `msdChain` at `dan/msd.ts:67`, so lane concurrency buys nothing. This is roughly a quarter of a full version bump, and precedent exists: `ensureMsdPoisonRecoverySeeded` (`chart-analysis.ts:2416-2450`) already deletes skill rows by incident window, but its window targeting missed episodes, which is why value-keyed deletion is the right selector now.

**Also in scope, and cheap:** refuse to cache a play whose values match the floor signature (treat as `pendingPlays`), and add a calc-health token to the SSR reuse key so a future incident heals itself instead of freezing forever. Note the floor is **goal-dependent**, not one constant: the modal poisoned vector is 9.626/10.157 but 7.062/7.381 and a tail of others occur, so filter with the repo's value-agnostic signature (`chart-analysis.ts:2293-2300`, `Stream > 0 && Stream === Technical && Stream === Chordjack`), never a literal.

**Produces:** a 4K play corpus that is comparable to the 7K one.

**Gate:**
- If the heal runs: 4K is admissible as a **secondary** stratum once complete.
- If the heal does not run (it is a real cost and a legitimate deferral): **4K is excluded from the primary analysis**, is reported only as a sensitivity run with the poison filter applied, and every 4K number in the report carries the caveat that the filter is non-random censoring which mutilates pool depth by up to 63% for one cell in five, which is precisely the artifact two of the candidate designs exist to correct.
- Either way, **7K is the primary stratum**. It is 0.00% poisoned, its ceiling mass is 20.4% rather than 41.4%, and its exposure confound is 0.513 rather than 0.851.

### 0B. Prod read-only verification

**Cost:** one SSH session, one script. Roughly an hour, no writes.

**Produces:** confirmation (or refutation) that prod matches the local snapshot on the four things this plan is built on:
1. Per-play floor share inside `plays_json` per keymode, and the count of ready rows containing one.
2. `select key, updated_at from live_meta where key in ('skill_exact_curves:v1','msd_poison_recovery_done:v1')`.
3. Ready chart-analysis poison count: `select sum(case when json_extract(msd_json,'$.values.Stream') > 0 and json_extract(msd_json,'$.values.Stream') = json_extract(msd_json,'$.values.Technical') and json_extract(msd_json,'$.values.Stream') = json_extract(msd_json,'$.values.Chordjack') then 1 else 0 end), count(*) from beatmap_chart_analysis where status='ready' and msd_json is not null`.
4. `Ref(k)` sizes and the ceiling mass at Overall >= 28, recomputed on prod.

**Gate:** if prod's poison share differs materially from local, every coefficient in every candidate must be refit on prod before the labelled run. Local coefficients are shape evidence, not values to ship.

---

## PHASE 1: the label-free population report. Cheap, and it may end the project.

**Cost:** already paid. The numbers in section 0 are the report. Add three tables, each a single offline pass:

1. **The placebo-partition table.** For each candidate's own machinery, run it on non-LN chart partitions (`chordjack` tag, `tech` tag, "played at a non-1.0 rate", "beatmapId < 2,000,000", and `beatmapId` parity as the pure-noise control) and report split-half reliability for each. The adversarial measurement to beat: under LN Lean's own construction, 4K split-half Spearman-Brown is 0.689 for the LN partition, **0.769 for chordjack**, 0.627 for off-rate, 0.495 for old-vs-new maps, and -0.017 for random parity. If a candidate's reliability on LN is not distinguishable from its reliability on arbitrary stable partitions, the reliable component is "your relative performance on any stable chart subset is stable", which is chart selection, not LN skill.
2. **The exposure table.** rho(R_x, share_x) for every LN-family axis and every negative control, whole population and inside the Overall >= 26 / >= 29 bands separately. The band matters: LN Lean's exposure correlation at 4K rises from 0.342 (all cells) to 0.474 (Overall >= 26) to 0.512 (Overall >= 29), and the labels will be drawn from the top band.
3. **The pp-selection table.** Median share_ln among `source='top'` plays is 0.601 against 0.396 among the same players' `source='tracked'` plays (median within-player difference +0.176), and 85% of rated plays are top-sourced. The "exposure" variable that drives everything is substantially a property of osu!mania pp weighting and of tracking tenure, neither of which appears in anyone's confounder list.

**Produces:** a short document that answers "is the LN bar telling anyone anything" for zero labels, plus the ceiling arithmetic that predicts the incumbent's maximum achievable score.

**Gate:** this phase cannot fail, but it can make the rest unnecessary. If the report shows the incumbent is a monotone re-ranking of exposure inside the band the labels come from **and** is ceiling-limited below the pass bar, the honest product move may be to relabel the LN bar as what it is ("your level on LN charts") and surface LN play share explicitly, with no new axis at all. Present that option to the user before collecting labels.

---

## PHASE 2: collect labels, and pre-check them before committing to a design

**Cost:** the user's time, plus one prod eligibility query per name.

**Order matters and the current draft protocol gets it wrong.** Resolve names to cells and report the eligibility funnel **before** the freeze file is written, so the user can supply replacements. The funnel is brutal: at 4K, 10,009 cells clear the 20-clean-plays bar, 9,093 clear the LN-plays bar, roughly 7,349 survive a 365-day recency filter, and only 388 of the 1,181 cells with share_ln >= 0.85 survive all of it. At share_ln >= 0.90 the top-ranked candidate design is applicable to 82 of 794 cells at 4K and 4 of 108 at 7K. **The most extreme LN players, the archetype the labels are for, are 90 to 96% inapplicable.** If that is where the labels land, we find out now rather than after the run has silently become 6v6.

**Produces:** a label file (user IDs, not usernames), an eligibility log with a reason per exclusion recorded before group membership is revealed, and a decision on whether the sample supports a holdout.

**Gate:**
- Fewer than 5 per side per keymode after eligibility: **do not run the test.** The smallest attainable one-sided permutation p at 4v4 is 0.0143 and at 3v3 is 0.050, so 3v3 cannot be significant by construction. Report the population diagnostics and stop.
- 5 to 9 per side: run once, no holdout, **report as exploratory**. A 60/40 wave split at n=20 gives wave A 6v6 and wave B 4v4, and simulation puts P(pass A **and** confirm on B) at 0.17 for a true AUC of 0.80 and 0.31 at 0.85. Spending 40% of a non-renewable label set on a confirmatory test that confirms a genuinely good axis less than a third of the time is worse than not splitting.
- 10 or more per side per keymode: hold out 40%, run wave A, confirm on wave B. This is the only configuration in which the holdout discipline pays for itself.

### The exact questions to ask the user

Ready to answer as a list. Items 1 to 4 are mandatory; a label missing any of them is unusable.

1. **osu! user IDs, not usernames** (profile links are fine). Usernames change and we will silently mis-join.
2. **Which keymode is each claim about?** 4K, 7K, or both. We cannot pool keymodes: on the 461 cells eligible in both, the LN retention metric agrees with itself at only rho 0.375 across keymodes. A name without a keymode is unusable. **6K labels cannot be used at all** (43 eligible cells site-wide).
3. **Anti-labels, explicitly.** Please also name players who are strong overall but **not** LN specialists, ideally at a similar general level. Positives alone give us nothing to test against. How many can you give?
4. **Which claim is it, per name?** "World-class at LN in absolute terms" (between-player) or "LN is their strongest skill relative to their own other skills" (within-player)? This plan tests the second. If most labels are the first kind, the metric has to change before anything runs.
5. **Have you looked at this site's Skills tab or LN percentile for any of these players in the last year, and did it influence the label?** This is the single most important question and the earlier draft omitted it. The percentile we display for `pattern:ln` correlates rho 0.973 with the displayed Overall percentile at 4K, and 62.7% of players sit within 5 percentile points of their own Overall. If a label was formed partly by reading our own page, it encodes the incumbent axis, which is essentially Overall, and it will systematically **penalise** exactly the candidates that succeed at removing Overall.
6. **Name any player you would call LN-strong whose LN bar on this site you expect to look unimpressive.** This is the cheapest instrument we have for distinguishing labels formed from the world from labels formed from our own display. Even two or three such names materially change how the result is read.
7. **Volume or quality?** For each LN-positive: do you mean their releases are accurate and clean, or that they clear very hard LN charts, or that they mostly play LN? Three different claims, and only the first two are the thing we hope to measure.
8. **Basis for each label:** tournament results, specific scores you have seen, community reputation, or your own play against them?
9. **Confidence tier per name:** high ("I would bet on this"), medium, low. Primary test runs on high plus medium; high-only is a pre-registered sensitivity check.
10. **Inverse or release specifically?** Are any LN-positives known for inverse charts, or for release-heavy short-hold content, as opposed to general hold walls? We already store `pattern:lninverse`, `lngeneral`, `lntech` and (7K only) `lnrelease` invisibly, and these sublabels are the only way to test the archetype predictions.
11. **Recency.** Current reputations or historical? Flag anyone who has not played seriously in the last year; the pipeline may be rating them on a play pool years old.
12. **Client.** Who plays lazer and who plays stable? The SSR goal rule differs on LN charts by client, and the split is per player.
13. **Rate play.** Anyone who plays mostly at non-1.0 rates? A rate-1.0-only sensitivity run will empty their cell and we want to know in advance.
14. **A second, non-LN label set** (jack or chordjack specialists and non-specialists, same format). This is the positive control: it tells us whether a failure is specific to LN or a failure of the whole approach. Without it, "nothing separates" is uninterpretable.
15. **Known counterexamples and disputed cases.** Anyone whose reputation you think is wrong, or who the community disagrees about? They go into neither group and are the most informative names in the set.
16. **Holdout consent.** Willing to give all names now and let a seeded script hide 40% until after we pick a design?
17. **Can you reach 40 names total rather than 20?** It is the difference between "can only detect a very strong effect" and "can detect a moderate one", and it is the only thing that makes the holdout worth doing.
18. **Is there a second person who could label independently?** There is currently one rater, no inter-rater reliability, and it is the same person who hand-labelled the 127-chart corpus in `ln.ts` that this plan treats as the cautionary tale. Without a second source, "labels" and "one person's priors" are the same object.

---

## PHASE 3: freeze, then one offline scoring run

**Cost:** roughly an hour of compute and one afternoon of discipline. Zero repo changes. All three candidates plus the incumbent plus the exposure baseline plus the controls are computable read-only from already-stored `plays_json` and `beatmap_chart_analysis`. A whole-population pass over 13,679 rows and 1.49 million plays is minutes (not the 40 seconds quoted in the design briefs, which measured the chart-map path only); the chart map itself is 128,913 entries, 20 seconds, 295 MB process RSS.

**Produces:** one number per discriminant per stratum, plus the sensitivity set, plus the exclusion log.

### The frozen discriminant family

The cross-candidate rank matrix collapses the field to two hypotheses plus a null. At 4K the incumbent ratio, its OLS residual and LN Lean sit at Spearman 0.74 to 0.86 with each other while Release Load sits at 0.44 to 0.58 against all of them; at 7K the first cluster tightens to 0.84 to 0.94 and Release Load stays out at 0.66 to 0.75. So:

| Slot | Discriminant | Hypothesis | Cost if it wins |
|---|---|---|---|
| Incumbent | `pattern:ln` retention ratio, as shipped today | H1 | nothing ships |
| Baseline | `share_ln`, pure pool composition, no skill model | H0 | nothing ships |
| Candidate 1 (primary) | **LN Lean**: count-normalised residual of the LN pool against the same player's non-LN pool | H1 | `modes_json` only, no version bump |
| Candidate 2 | **Release Load**: per-play release-layer MSD from the stored `msd_ln / msd` ratio | H2 | per-play field on the pattern-refresh loop, no version bump |
| Candidate 3 | `pattern:ln` recomputed at `PATTERN_TAG_MIN_SCORE` 0.7 and 0.8 off stored classification scores | H1, one constant | one constant, no code beyond it |
| Controls | incumbent machinery on `tech` / `chordjack` / `jumpstream` (4K) and `chordstream` (7K); **plus each candidate's own machinery on the placebo partitions from Phase 1** | | |

**Candidate 3 is free and nobody proposed it.** The `ln` tag saturates: above lnRatio 0.30, 100% of 4K charts are tagged at average score 0.999 and every 7K chart sits pinned at the 0.62 damping ceiling. If the tag's zero discrimination over the whole range where LN charts live is the entire problem, a threshold change beats all four designs on cost and must be tested before any of them.

**Not in the family, and why.** The **LN vector** (size-matched subtype contrasts) is excluded as a candidate because its axes are not reliable enough for a null to mean anything: measured split-half Spearman-Brown is 0.292 (4K lngeneral), 0.374 (4K lntech), 0.521 (7K lngeneral), 0.146 (7K lntech). Only 4K lninverse (0.776, n=1,535) is testable, and it needs per-player sublabels the user may not supply. Its real contribution is a **prohibition**, which we adopt unconditionally in Phase 5. **LN Window** is excluded because it cannot be evaluated at all before a 126k-chart sweep, and its own author's ablation disarms its distinguishing claim.

**Do not surface the four already-stored LN sub-axes as the "free win".** They have percentile curves and would cost two whitelist edits, but `aggregateSsrs` is size-dependent (at MSD-scale inputs it returns 0.878 of the full-pool value at n=3 and 0.966 at n=10) and the 4K median play count on `lngeneral` / `lninverse` is about 4. Shipping them publishes a ranking of play counts wearing the costume of a skill number. This is the `ln.ts` mistake in a cheaper costume.

### The freeze file

Written to disk, hashed, **and sent to the user as a message before any label is joined**, so the timestamp is outside the analyst's control. A self-written, self-hashed, self-run file costs nothing and buys nothing. It contains: eligibility filter, metric definition, the ordered candidate list above, the control list, the test, alpha, the sensitivity set, the exclusion rules, and the two pre-declared choices below.

**Pre-declared choice 1: LN Lean's 2-parameter versus 4-parameter fork.** The design says outright that the labels should decide this. That is forbidden. The two variants are materially different axes (rho 0.835 at 4K, 0.872 at 7K; r with exposure 0.342 versus 0.019) and choosing between two axes correlated at 0.85 on 20 points is choosing by noise. **We declare the 2-parameter model** and note the 4-parameter model as a separate, later, exploratory question.

**Pre-declared choice 2: one cell per player.** 4.9% of eligible users have two or more eligible cells, and a "stratified" test that assumes independence would silently inflate the effective n. The label's stated keymode (question 2) picks the cell.

---

## The validation protocol, in full

### Metric

The unit is a **(player, keymode) cell**, never a player. All quantities come from one frozen snapshot of `player_skill_ratings.plays_json` at the current `PLAYER_SKILLS_VERSION`, poison-filtered per play with the value-agnostic signature.

For cell `(p, k)`, using the repo's own `aggregateSsrs` verbatim:

- `N` = clean plays at keymode `k`
- `O` = `aggregateSsrs({play.values.Overall})` over all `N` plays
- for axis `x`: `n_x` = plays whose chart carries tag `x`; `A_x` = `aggregateSsrs` over just those; `share_x = n_x / N`
- `R_x = A_x / O`, the **retention ratio**. Structurally `R_x <= 1` always, because `aggregateSsrs` is monotone in the input set and `A_x` aggregates a subset of the same numbers (verified: max ratio exactly 1.000000 over 86,658 stored (mode, pattern) rows).

**Primary discriminant, the skill-matched band percentile:**

```
D_x(p,k) = 100 * |{q in Ref(k) : |O(q) - O(p)| <= 1.0 MSD, R_x(q) < R_x(p)}| / (|band| - 1)
```

`Ref(k)` = every cell with `N >= 20` and `n_ln >= 20` (4K 9,093, 7K 1,223). Band half-width 1.0 MSD is declared a priori and never varied. Measured `r(D_ln, O) = -0.023` (4K) and `+0.009` (7K): the discriminant is skill-neutral by construction, whereas the raw ratio is not (`r(R_ln, O) = +0.410` whole-population but `-0.183` inside the Overall >= 28 band, so the raw ratio's skill bias changes sign with the population you draw from). That sign flip is why the primary must be a within-band rank.

**Band quantisation is a real limit at the top of 7K and must be pre-registered, not discovered.** Measured 7K band sizes: at Overall >= 31, 40 cells with median band 34; at >= 32, 20 cells with median band 24; at >= 33, **6 cells with median band 4**, so `D` takes three distinct values and one step is 33 percentile points. World-class 7K LN players sit precisely there, and the band contains the other labelled players, so positives and negatives are partly ranked against each other. **Freeze-file commitment: no 7K conclusion will be drawn for cells above Overall 31.**

**Secondary, for interpretability only:** the population OLS residual `A_ln - (alpha + beta*O)` fit on `Ref(k)` (4K `A = -1.362 + 1.0242*O`, residual sd 0.845; 7K `A = -1.164 + 1.0167*O`, sd 0.853). It ranks almost identically (rho 0.916 / 0.960) but reports in MSD points, which is the unit anyone arguing about the result will want.

**Test statistic:** `AUC = P(D of an LN-labelled cell > D of a non-LN-labelled cell) + 0.5*P(tie)`, i.e. `U / (n1*n2)`. Keymodes are separate strata; combined statistic is `sum(U_k) / sum(n1_k * n2_k)` with the permutation done **within** strata. Report AUC with its CI, not just a p-value.

Every candidate, the incumbent, the exposure baseline and every control go through this identical function. Because `D` is a within-band rank, the metric is invariant to any monotone rescaling: a candidate cannot win by changing units, only by changing who ranks above whom.

### Pre-registered success criterion

Committed before any label is joined. Primary test: one-sided stratified exact permutation Mann-Whitney on `D`, alpha 0.05, alternative "LN-labelled rank higher". Holm across candidates.

**PASS requires all four:**

1. `AUC >= 0.80`
2. permutation `p <= 0.05`
3. **the candidate beats exposure on a share-matched comparison** (see below), not on a difference of AUCs
4. no negative control and no placebo partition reaches `AUC >= AUC(candidate) - 0.05` on the same labels

**Criterion 3 is deliberately not a delta-AUC threshold, and this is a correction to the earlier draft.** Simulating two discriminants with population rank correlation 0.85 (the measured rho(R_ln, share_ln) at 4K is 0.851) that are **exactly equally good** gives sd(dAUC) = 0.090 at 10v10 and 0.120 at 6v6, so `P(observed dAUC >= 0.05 | true dAUC = 0)` is **29.7% at 10v10 and 34.6% at 6v6**. A ship decision resting on that is a coin flip. Instead:

> **Criterion 3 (share-matched form):** match each labelled positive to a labelled negative on `share_ln` (caliper 0.10) as well as on Overall, or equivalently rank the labelled cells on the candidate after regressing `share_ln` out within the band, and require the candidate to clear `AUC >= 0.80` at `p <= 0.05` on the share-adjusted statistic. This converts an underpowered difference of AUCs into a single test with the confounder removed by design, and it is the only way n = 20 can say anything about skill versus volume.

**Saturation gate, decidable today and already decided:** a usable discriminant must have under 10% of `Ref(k)` inside the labels' skill band tied at its ceiling. **The incumbent fails this at 4K:** 41.4% of 4K cells at Overall >= 28 sit at `R_ln >= 0.995`, capping attainable AUC at 0.793, below the pass bar. At 7K it is 20.4%, cap 0.898. Record this now: an incumbent score around 0.78 at 4K is **not** "close to passing", it is the structural maximum, and it will be reported as a demonstration of saturation rather than as a near miss.

**Incumbent-is-fine outcome:** if `pattern:ln` clears all four, nothing ships, the result is written down, and the LN redesign is closed as unnecessary. This is a live possibility and gets the same one-shot evaluation as any candidate.

**Bar for a replacement, asymmetric to cost:**

- A **zero-cost change** (`modes_json`-only, or a whitelist edit plus `SIGNATURE_RENDER_VERSION`) needs only the four criteria, plus the rollout guards in Phase 4.
- A change requiring a `PLAYER_SKILLS_VERSION` bump additionally needs `dAUC >= 0.10` over the incumbent with a paired bootstrap 90% CI excluding 0. **At 10v10 this bar is nearly unreachable and that is intentional.** A marginal win does not justify 3.1 million serialized MinaCalc runs.

### Confounders, and what we do about each

1. **Keymode mix.** Never pool. Stratify the permutation, report per-keymode AUC and n. 7K primary, 4K secondary and only after the heal.
2. **Pool depth.** `aggregateSsrs` is monotone in pool size and the numerator is the small subset, so depth leaks into `R_ln` even at fixed exposure (measured 4K median `R_ln` across LN-play-count quartiles inside a fixed share band: 0.918 / 0.935 / 0.943 / 0.947). Mitigations: the `n_ln >= 20` floor, per-group reporting of median `N` and `n_ln`, and a pre-registered sensitivity run truncating every cell to its best 40 LN plays and best 100 plays overall.
3. **Exposure.** rho(share_ln, R_ln) = 0.851 at 4K, 0.513 at 7K; median share_ln at Overall >= 28 on 4K is 0.756. Handled by criterion 3 in its share-matched form. Exposure is a **competitor**, not a covariate.
4. **Poison censoring.** The mandated filter is a depth intervention applied to one stratum and not the other, varying up to 63% between players inside 4K. Handled by Phase 0A.
5. **Rate.** rho(off-rate share, R_ln) = 0.468 at 4K and 0.018 at 7K, so the confound has a different structure per stratum and the pooled test averages two regimes. Pre-registered rate-1.0-only sensitivity run.
6. **Lazer versus stable.** `ssrGoalForScore` fades the Wife goal toward plain accuracy in proportion to `lnRatio` for lazer plays only, so the goal rule differs on exactly the charts under test. Median lazer share is 0.000 in both keymodes, so the earlier draft's "median difference > 20pp" rule can never fire. **Replace it:** compare group **means**, and additionally flag the within-player mechanism (LN-vs-non-LN lazer share differing by more than 0.2 for 5.4% of 4K and 7.2% of 7K cells).
7. **The denominator is tail-blended too.** `blendLnTailValues` lifts hold-bearing charts by a mean +0.14 MSD at 4K and +2.04 at 7K, upward-only per skillset. Both `A_ln` and `O` are computed from blended values over overlapping sets, so the blend does not cancel; for an LN main it pushes `R_ln` toward the ceiling. Any candidate that removes the blend from one side only has changed the scale and must be re-anchored. Any candidate routed through the MinaCalc-free approximate path must have `msd_ln` threaded into `BaselineChartEntry` first, or it carries a -0.069 median bias in `R_ln` at 7K, a third to a half of the entire signal band, in the LN-adverse direction.
8. **pp selection and tracking tenure, new.** share_ln is 0.601 in top plays against 0.396 in the same players' tracked plays. The exposure variable is partly an artifact of pp weighting. Report tracked share per labelled cell; pre-registered top-only sensitivity run. Note that `decoratePlayerSkillBreakdown`'s tracked-play filter lives in the **approximate** branch only (`skill-baseline.ts:934-935`); with `skill_exact_curves:v1` present the exact branch serves and does not filter by source, so the numbers a labeller would have seen include tracked plays.
9. **Recency.** Median newest play is 44 days old, p95 is 1,259 days. Record newest `endedAt` and `computed_at` per labelled cell; exclude cells whose newest play is older than 365 days.
10. **Label provenance and label contamination.** Handled by questions 5, 6 and 8. Not correctable, only measurable.

### Power, stated plainly

Simulated one-sided permutation rank-sum, alpha 0.05:

| n1/n2 | true AUC 0.70 | 0.75 | 0.80 | 0.85 | 0.90 | 0.95 |
|---|---|---|---|---|---|---|
| 5/5 | 0.21 | 0.34 | 0.45 | 0.58 | 0.77 | 0.91 |
| 8/8 | 0.36 | 0.52 | 0.69 | 0.84 | 0.93 | 0.99 |
| 10/10 | 0.44 | 0.60 | 0.78 | 0.91 | 0.98 | 1.00 |
| 15/15 | 0.59 | 0.81 | 0.93 | 0.98 | 1.00 | 1.00 |
| 20/20 | 0.71 | 0.90 | 0.97 | 1.00 | 1.00 | 1.00 |

Smallest attainable one-sided permutation p: 3v3 = 0.050 (cannot be significant), 4v4 = 0.0143, 5v5 = 0.0040, 10v10 = 5.4e-6.

What n = 20 **can** do: kill a candidate that is at chance, and confirm a strong effect (AUC >= 0.85 at 91% power). What it **cannot** do: estimate an effect size (SE(AUC) about 0.10 at 10v10, so "AUC 0.83" and "AUC 0.68" are the same observation); rank candidates against each other; detect a real but modest improvement (AUC 0.70 has 44% power, so a genuinely better axis fails more often than not); support separate 4K and 7K conclusions from one 20-name set; or absorb multiplicity beyond three candidates.

---

## The overfitting guard, and the in-repo cautionary tale

`live-backend/src/dan/dan-estimator/ln.ts` is 943 lines. It contains **127 hand-labelled reference charts** (`:34-168`), a 10-dimensional L1 nearest-neighbour distance over them (`pressureDistance`, `:174-186`), and **14 patch functions** layered on top of the kNN output: twelve floors (`highSrLnPressureFloor` `:278`, `lowRateDenseLnWallFloor` `:304`, `beginnerLongHoldCourseFloor` `:325`, `slowCourseLnWallFloor` `:342`, `shortHighEndReleaseWallFloor` `:363`, `compactTwelfthLnWallFloor` `:379`, `thirteenthLnWallFloor` `:411`, `eleventhLnWallFloor` `:454`, `fifteenthLnWallFloor` `:472`, `repetitiveFullLnWallFloor` `:508`, `chordHeavySlowLnWallFloor` `:525`, `compactRepetitiveLnWallFloor` `:541`) and two compressions (`beginnerLongHoldCourseCompression` `:560`, `overweightedLnWallCompression` `:577`). Several have windows narrow enough to name individual charts (`lowRateDenseLnWallFloor` demands noteCount 900 to 1100 **and** lnReleasePressure 13 to 15 **and** chordRatio 0.58 to 0.65 **and** peakNps5s 12.5 to 14, then returns the constant 8). Candidacy is gated partly on a **title and version regex** (`:870`). Every one of the 14 is module-private, so none can be unit tested, and none is.

That file is what fitting a model to a small hand-labelled set produces. This plan risks reproducing it at n = 20 instead of n = 127, which is worse. The guards:

1. **Zero free parameters fit on labelled players.** Every constant is either already in the repo or fit on the reference population (9,093 cells at 4K, 1,223 at 7K). The band half-width, the eligibility floors and both pre-declared choices are in the freeze file and never varied. **If any threshold changes after seeing a label result, the run is exploratory and cannot ship.** This includes LN Lean's 2-vs-4-parameter fork, which its own design document proposes to decide from the labels.
2. **Frozen, ordered candidate list.** Three candidates plus incumbent plus baseline. Adding a candidate after seeing labels invalidates the family.
3. **One evaluation per candidate.** All iteration happens against the population, before the join. The harness is cheap enough that this discipline costs nothing.
4. **Exclusions decided before the join,** each logged with its reason, group membership revealed only afterwards.
5. **Placebo partitions under the candidate's own machinery**, not just control tags under the incumbent's machinery. This is the guard the earlier draft was missing, and it is the one that catches the actual failure mode: a construction that manufactures a stable, level-orthogonal number from **any** stable chart partition. A candidate whose placebo AUC is within noise of its LN AUC on the same labels is rejected regardless of its LN AUC.
6. **Positive control** (question 14). If jack labels separate on `D_chordjack` but LN labels fail on `D_ln`, the failure is specific to LN. If neither separates, the protocol or the label process is at fault and no conclusion about LN is licensed. Note the proposed control is partly contaminated: rho(R_ln, R_jack) = +0.498 at 4K.
7. **Declared reliability ceiling, per evidence band, not population-average.** Split-half reliability of `D_ln` by LN-play count: 4K 20-39 plays gives Spearman-Brown 0.612, 40-79 gives 0.828, 80+ gives 0.902; 7K 20-39 gives 0.649, 80+ gives 0.833. The eligibility floor is 20, so a labelled cell can legitimately enter at SB 0.61 while the whole-population figure is 0.944. Validity is capped at the square root of reliability. Any candidate reporting near-perfect separation should be suspected of encoding the label.
8. **Blinded join.** The user submits a file; a script emits only aggregate statistics and the exclusion log.
9. **Freeze-file hash sent to the user before the run**, so pre-registration has an external timestamp.

---

## PHASE 4: ship, conditionally. Zero-cost changes only.

Branch on the Phase 3 outcome. These are mutually exclusive.

**4A. Exposure wins or ties.** Ship no axis. Surface LN play share honestly next to the LN bar, relabel the bar as "your level on LN charts", close the work. Given rho = 0.851 at 4K this is the single likeliest outcome.

**4B. Incumbent passes.** Ship nothing. Write down that the r = 0.99 correlation with Overall is a display artefact rather than a validity problem.

**4C. Candidate 3 (tag threshold) passes.** Change one constant, re-sweep the pattern tags (`LN_SUBTYPE_RECOMPUTE_JOB` precedent, `chart-analysis.ts:1023-1150`, chunk 50), done. Cheapest possible outcome and it must be checked first.

**4D. LN Lean passes.** `modes_json` only. Two extra `aggregateSsrsAt` folds per (player, keymode) inside a compute that already spends a population mean of 253.6 MinaCalc runs. About 60 bytes per mode on a 9.3 MB blob; `plays_json` (848 MB) untouched. No new axis, so no `PATTERN_RATING_META` edit, no `PLAYER_SKILL_PATTERN_AXES` edit, no `/skill-plays` 400 surface, no radar vertex change, no signature truncation, no `SIGNATURE_RENDER_VERSION` bump, no farm-helper interaction. Reverting is one commit plus one compute cycle.

**4E. Release Load passes.** Per-play field threaded through the pattern-refresh loop at `player-skills.ts:970-978` (which iterates `analyzed`, the union of fresh, reused and retained plays, so it reaches every play with no recompute). Roughly 19 MB on the 848 MB `plays_json`. **Three mandatory corrections to the design as written:**
- Apply the percentile anchor in **both** branches of `decoratePlayerSkillBreakdown` (`skill-baseline.ts:892` exact and `:918` approximate) or the same axis serves two different scales. Raw `rel/Overall` is p50 about 0.62 with rice mains near zero, so the unanchored value either reads wrong or falls under the renderer's silent `entry.value >= 1` drop.
- Refit `g_k` on the healed corpus. It was fit on 25,511 clean 4K rows when the clean corpus is now roughly twice that.
- Accept explicitly that a ninth axis truncates signature designs 1 (top 4) and 2 (top 6) and changes every player's radar vertex count. Prefer swapping it in place of the LN spoke over appending.

### Rollout guards that apply to 4D and 4E equally, and that no design accounted for

The "free" trick of shipping an axis without a version bump routes around the only staged-rollout guard the repo has. `buildExactSkillCurves` (`skill-baseline.ts:515-580`) folds whatever is in each roster member's `modes_json` **right now**; a new field exists only on rows that have recomputed since the deploy. The comment at `:709-716` names this hazard exactly ("curves rebuilt from its early arrivals would skew every percentile low") but its guard counts `analysis_version = current`, which is a no-op when the version does not change. And coverage does not converge on its own: the drip selects only users with **no** row at the version, so refresh happens only on a profile view (12h TTL) or a new top play. Locally, 8,535 of 13,679 ready rows (62%) were last computed 2026-08-09 to 2026-08-11 and have not moved since.

Therefore, mandatory:
1. **Force a baseline and exact-curve rebuild as part of the deploy.** `enqueueSkillBaselineIfDue` returns false while the approximate blob is fresh, which locally means up to 7 days of no curve at all for a brand-new axis.
2. **Gate the new axis's curve on coverage**, mirroring the version-bump majority gate at `skill-baseline.ts:711-720`. Publish no percentile for the axis until current-shape rows are a majority.
3. Note that `shrinkRating` (`skill-baseline.ts:837-845`) is a **no-op when `curveMedian` is undefined**, which is exactly the brand-new-axis case, so the only defence against thin-evidence inflation is absent in the same window where the axis is most fragile.
4. The rollout is **not** "12 to 24 hours". It is a function of profile traffic, and the tail never closes for off-roster players.

---

## PHASE 5: expensive work. Gated on Phase 3 evidence, and probably never.

Nothing here may start before a phase above has justified it.

**5A. `PLAYER_SKILLS_VERSION` bump.** Requires the `dAUC >= 0.10` bar with a CI excluding zero, which at 10v10 is essentially unreachable. Cost: 3.08 to 3.27 million serialized MinaCalc runs across roughly 13,000 rated players, 25,900 to 28,800 job passes because of `MAX_CALC_RUNS_PER_COMPUTE = 150`, a **3.0 to 3.6 hour wasm floor** locally and 8.6 to 11 hours at VPS rates, and **more than 70 hours of real elapsed time** behind the drip's 16 users per 5 minutes. Plus roughly +0.9 GB transient disk while old and new rows coexist (the local file is already 10.9 GB against a default `MAX_LOCAL_DB_BYTES` of 10 GB; over-cap pruning deletes `score_events` oldest-first, which is the source of 17% of rated plays). Plus a percentile blackout for the whole migration. Plus job orphaning: the dedupe key embeds the version, so queued jobs survive the bump, still run, and can double-compute a user on a claimLimit-2 lane.

**5B. LN Window (SunnyWindow-derived axis).** Requires Phase 3 to have shown that the `pattern <= Overall` ceiling, not the tag and not the aggregation, is the binding constraint, **and** a throwaway 7K-only prototype (27,198 charts, roughly 4 CPU-minutes) beating everything by a margin the label set can resolve. Cost if built: a new column, a 126k-chart by 3-rate sweep (roughly 378k `calculateLN` runs, about 31 CPU-minutes of calc plus about 126k single-row `last_used_at` UPDATEs contending for the single SQLite write lock), a **frozen** 200-knot scale map that pins the axis definition forever, and a second divergent 1,461-line copy of Sunny in production that is behind three upstream correctness fixes. Its own author measured that zeroing the entire release term leaves chart ranking at Spearman 0.992 and that the resulting residual correlates -0.094 with release-tagged play share. Treat 5B as a live option only in the world where Release Load wins and its implementation, not its hypothesis, is the bottleneck.

**5C. The LN vector's prohibition, adopted unconditionally and for free.** If anyone ever wants to surface `lntech` / `lngeneral` / `lninverse` / `lnrelease`, the size-matched reference (or the count-normalised fold) is the price of admission. Do not ship the three sub-rows as a feature: their true between-player spread is 0.42 to 0.75 MSD, under 2% of a bar drawn as `value/max`.

---

## What we do if the result is null

A null must be allowed to close the work, and this section is what makes that honest rather than convenient.

- **Exposure wins or ties.** The labels encode what people play. The product answer is to surface exposure explicitly. No version bump is justified. This is the likeliest outcome and it is a real finding.
- **Incumbent passes.** The current axis is fine. Ship nothing.
- **Everything separates,** including `D_tech` / `D_chordjack` / `D_jumpstream`. The labels track general prominence or activity. Rebuild the label set with matched controls before any axis claim is possible.
- **A candidate's placebo partition separates as well as its LN partition.** The construction manufactures a stable number from any chart partition. Reject that candidate specifically; the finding is about the construction, not about LN.
- **Nothing separates and the positive control also fails.** The protocol or the label process is broken. No conclusion about LN.
- **Nothing separates but the jack control works.** The strongest honest outcome available: LN specialisation as this pipeline sees it is not recoverable from `aggregateSsrs` over an `ln`-tagged subset, at any tag threshold, because a pattern rating is bounded above by Overall and 41.4% of the relevant 4K population is already pinned at that bound.
- **Ceiling-limited.** The incumbent scores around 0.79 at 4K with 40%+ ties. Report it as a demonstration of saturation, not a near miss. The arithmetic was published in Phase 1 before the labels arrived, which is what makes that reading credible.

**The follow-up in every null branch is the same, and it is not another chart-side amount metric.** Every persisted LN signal in the repo (lnRatio, lnDensity, holdRatio, `ln_count`, `pat_ln`, the `ln` tag, the tail delta, SunnyWindow's `lnStar`) correlates 0.5 to 0.99 with "how much of this chart is holds". The only release ground truth in the tree is per-play `tailOffsetMs`, computed by `src/lib/mania-replay-judgement.ts:132-134` and consumed by nothing. Even 200 (player, chart, mean absolute tailOffset) triples would be a real criterion instead of 20 opinions. **Price it honestly before proposing it:** replays exist only for uploaded replays and the replay-browse path, the sample is self-selected, and it mostly does not exist for the labelled players. It is presented in the earlier draft as the cheap fallback; it is the most expensive item in this document.

---

## Known weaknesses of this plan

Stated up front, because a plan that can only succeed is not a plan.

1. **The label set is one person's priors, and that person reads the numbers under test.** There is one rater, no inter-rater reliability, and it is the same person whose hand-labelling produced `ln.ts`. The site displays an LN percentile that correlates rho 0.973 with the displayed Overall percentile, so any label formed partly by browsing our own pages encodes the incumbent axis and **systematically penalises the candidates that succeed at removing Overall**. Questions 5, 6 and 18 measure this. They cannot fix it.
2. **At n = 20 this experiment cannot rank candidates.** SE(AUC) is about 0.10 at 10v10, and sd(dAUC) between two correlated discriminants is about 0.090. Any statement of the form "candidate A is better than candidate B" from this run is noise. The run can kill a candidate at chance and confirm a strong effect. That is all.
3. **The primary candidate's own headline claims do not fully survive scrutiny.** LN Lean's `r(lean, Overall) = 0.000` holds only against `R_N`, the regressor, which is a definitional property of any OLS residual; the measured value against mode Overall is 0.230 at 7K. Its exposure correlation rises from 0.342 whole-population to 0.512 in the Overall >= 29 band the labels come from, and pseudo-labels built from **nothing but exposure** score AUC median 1.000 on it at 4K. Its reliability argument is matched or beaten by placebo partitions (chordjack 0.769 against LN's 0.689), and its "disjoint cross-signal" argument (r = 0.822) is beaten by a random split of the same pool (r = 0.804 at 4K; at 7K the chart-type version is **worse** than random). We keep it as primary because its coefficients replicate across corpus states, which is the only operational definition of "not fitted to the labels" that survives contact with this codebase, but its case is weaker than its design document claims.
4. **Release Load's input is 80 to 90% an amount signal.** Its own author's correction: `corr(tail delta, lnRatio)` is 0.892 on the clean 4K corpus, not the 0.525 the reading phase reported. Its output is the most exposure-correlated of the candidates (+0.458 with LN play share at 4K), which its design presents as evidence that it works. Under a validity lens that reading is backwards. It also systematically anti-favours the archetype it is named for (lnrelease-tagged charts sit at delta residual -1.686), and the archetype prediction that would make it genuinely self-falsifying **cannot be run** because `lnrelease` has zero 4K charts and 530 on 7K.
5. **No candidate measures release skill, and each one's own strongest measurement says so.** Release Load anti-favours release charts. LN Window's residual correlates -0.094 with release content and its Rbar ablation leaves chart ranking at Spearman 0.992. The LN vector refuses to rate `lnrelease` at all. LN Lean does not claim release. If the user's labels mean "clean releases" specifically, this entire experiment answers a neighbouring question.
6. **The 4K arena is compromised until the heal runs,** and the mandated poison filter is censoring rather than repair. It removes 1,195 of 10,288 raw-eligible 4K cells and mutilates pool depth for the survivors by up to 63%, which is exactly the artifact two candidates were built to correct.
7. **Every number in this document comes from a stale prod backup mixed with local writes.** Shapes and relative comparisons are solid. Absolute coefficients must be refit on prod before anything ships.
8. **The 20-play eligibility floor admits cells at split-half reliability 0.61** while the guard is reasoned about with a population-average figure of 0.944. A labelled set sitting near the floor is being judged with a blunter tool than the plan's language implies.
9. **What this experiment cannot establish, ever:** whether a player's releases are accurate; whether an LN specialist could outrank their own general level (the current construction makes it mathematically impossible, verified across 86,658 stored rows); whether a modest improvement exists (44% power at true AUC 0.70); whether 4K and 7K behave differently (a 20-name set split by keymode is two 5v5 tests at 45% power); or an effect size for anything.

---

## Cost summary

| Item | Cost | Phase |
|---|---|---|
| Population report and all offline candidate scoring | minutes per pass, zero writes, `node:sqlite` read-only | 1, 3 |
| Chart map build (128,913 entries, with `msd_ln`) | 20 s, 295 MB process RSS | 3 |
| Whole-population `plays_json` fold (13,679 rows, 1.49M plays) | minutes, 848 MB read | 1, 3 |
| Prod read-only verification | one SSH session, second population table | 0B |
| **4K poison heal** (delete 2,607 rows, re-rate 379,297 plays) | ~810k MinaCalc runs, 45-80 min wasm locally, ~2.2 h at VPS rates, 2,600+ job passes | 0A |
| LN Lean ship | ~60 bytes per mode on a 9.3 MB blob, two extra folds per compute, no version bump | 4D |
| Release Load ship | ~19 MB on an 848 MB blob, no version bump, ninth axis truncates two signature designs | 4E |
| Forced curve rebuild plus coverage gate | one job enqueue, one gate | 4 |
| `PLAYER_SKILLS_VERSION` bump | 3.08-3.27M runs, 3.0-3.6 h wasm floor locally, 8.6-11 h at VPS rates, >70 h elapsed, +0.9 GB transient, percentile blackout | 5A |
| LN Window sweep | ~378k `calculateLN` runs, ~31 CPU-min calc, ~126k row UPDATEs, frozen scale map, second Sunny fork in prod | 5B |

---

## Independent cleanups (not part of the axis work, ship any time)

These need no validation, no labels, and no gate. They are listed here only because the map phase surfaced them.

1. **Duplicate corpus row in the LN kNN.** `live-backend/src/dan/dan-estimator/ln.ts:155` and `:160` are byte-identical:
   `{ level: 14, n: 2408, s: 148.3, h: 0.794, d: 0.52, o: 3.48, r: 25.859, c: 0.517, p: 27.2, u: 25.9, q: 0.471 }`
   It is the only duplicate among the 127 rows. Because `getLnReferenceNeighbors` (`:200`) takes the nearest 8 by L1 distance, that chart votes twice in every neighbourhood it enters, silently doubling its weight. Delete one. Re-run the dan benchmark afterwards (`scripts/dan-benchmark.ts`); the change is small but it does move estimates.
2. **No unit coverage for the LN estimator.** `ln.ts` exports four symbols; the 14 patch functions and the kNN are all module-private, so none can be tested directly. The only test touching `estimateLnDan` is `live-backend/tests/ln-source-sweep.test.ts`, which is a sweep-job test over a synthetic fixture and asserts nothing about estimator output. Minimum useful addition: export the patch functions (or a `debugLnDanBreakdown`) and pin at least one chart per floor window, so that the next person to change a constant learns which of the 14 fired.
3. **The metadata regex conflicts with a stated rule.** `ln.ts:870` gates LN candidacy partly on `/\bln\b|long note|full ln|ln edit|ln hybrid|ln wall|ln jack|ln speed|ln jumpstream/` matched against `title + version + input.title + input.version`. `CLAUDE.md` says: "Dan and LN dan classification must stay algorithmic: never add title/artist/creator/beatmap-id/beatmapset-id/filename or any chart-identity shortcuts to force results." The regex is OR'd with weak numeric floors (`:871-876`), so removing it changes which charts become LN candidates and needs a benchmark re-run, but the rule is unambiguous and the code contradicts it today. Either delete the metadata leg or amend `CLAUDE.md` to carve out an explicit, documented exception.
4. **Missing Etterna attribution.** `live-backend/vendor/leoblack/LICENSE` is an MIT notice for Leo_Black only, but `live-backend/vendor/leoblack/ett/versions/` ships five compiled MinaCalc builds (`minaclac-68.0-unofficial`, `70.0`, `72.0`, `72.3`, `74.0`, each `.js` + `.wasm`). Those are Etterna's work and MIT requires the upstream copyright notice to travel with redistribution. Add `ett/versions/LICENSE.etterna` (or an attribution block in `PORT_NOTES.md` and the vendor LICENSE) naming the Etterna project and its MIT terms. Zero code impact.
5. **Stale documentation line.** `docs/backend.md` states `beatmap_osu_files` is pruned at 90 days. There is no such prune in `live-backend/src/retention.ts`, and `live-backend/src/features/skill-vector-backfill.ts:23` states the cache never expires; measured coverage is 132,445 of 132,445 ready analyses. This matters beyond tidiness: anyone who trusts the docs line and adds an LRU prune turns any future corpus sweep from a zero-API job into a 126k-call osu! API job against a roughly 45-per-minute budget (about 47 hours at full budget).
