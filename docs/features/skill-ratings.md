# Skill ratings

Per-player MSD/SSR ratings, pattern axes and the Skills tab (`backend/src/features/player-skills.ts`). Dan credit built on the same stored plays is in [dan-estimates.md](dan-estimates.md); what gets left out as vibro is in [vibro.md](vibro.md).

## Computing a rating

- **Per play**: MinaCalc SSRs at the play's music rate (DT/NC 1.5x, HT/DC 0.75x, or the exact lazer `speed_change`; wind up/down and adaptive speed are skipped), with the play's calibrated accuracy as the score goal. The full mod acronym list is stored so rows show MR/DA etc.; the explicit rate mod keeps NC/DC apart from DT/HT.
- **Aggregation**: per keymode with Etterna's erfc aggregation into `player_skill_ratings`, keyed by `PLAYER_SKILLS_VERSION`. Per-play SSRs are cached in `plays_json`, so recomputes only run the calc for new or changed plays and version bumps reuse unaffected SSRs.
- **Rating pool** (Etterna's top-two rule): best play per beatmap/rate, then the two highest Overall SSRs per note-verified chart family (keymodes and Invert separate). This also caps rate edits uploaded as separate maps, without using names. The same pool feeds every MSD/pattern rating and the MSD plays explorer. All per-rate plays stay stored for SSR reuse and dan selection.
- **Floor**: a play whose goal lands on the calc's 0.8 floor is not rated. It is kept as dan-only evidence in `plays_json.danOnly` (judgement-based dan evidence, no SSR values). The floor applies after calibration, so clamping cannot manufacture credit.
- **Wife calibration**: every eligible native 4K-18K score (taps, holds, DT/HT, constant custom rates) uses the same versioned, monotone calibration, conditioned on client windows, OD, rate and hold share. There is no uniform fallback or bonus. Missing judgements use a separately calibrated accuracy-only adapter capped at 0.965. Unknown stable/lazer provenance takes the lower estimate. See [Wife calibration](../wife-calibration.md).
- **Verified inputs**: native mode, key count, hold count and OD come from the `.osu` before a goal is picked; facts are invalidated when the cached file's `fetched_at` changes. Stable/lazer provenance is kept in `player_activity_maps.best_is_lazer`. A missing file leaves the play pending (`calibrationPending`, empty SSRs) rather than publishing a raw-accuracy fallback.
- **Chart revisions**: editable charts are checked before a play is selected or its SSR reused. A score's observed checksum is recorded only when the score began after the metadata's update time; latest map metadata is not proof of an older score's revision. A mismatch leaves the play pending and queues the repair. A play that no verify can settle (`isUnverifiableRevision`: the chart was edited after the play, or the play names a checksum the chart no longer has) is filed `unverifiable_revision` everywhere instead of "in queue".
- Converts and charts outside 4K-18K are skipped.

## Axes per keymode

- **4K, 5K, 9K-18K**: the native MinaCalc skillsets plus the LN pattern axis.
- **6K, 7K, 8K**: pattern axes only, rated by each play's Overall SSR on charts tagged with the pattern (min 3 plays per tag). Prism replaces MinaCalc there when `PRISM_ENABLED` (see [chart-analysis.md](chart-analysis.md)). `PATTERN_AXIS_KEY_COUNTS` is mirrored by `usesPatternSkillAxes` in `src/lib/skill-axes.ts`.
- **Etterna Overall** (4K, 5K, 9K-18K): the mean of the best 6 of the 7 MinaCalc display skillsets plus the LN rating (best 5 where Technical is not rated), so LN can lift it but never lower it. Derived on read (`etternaOverall`), never stored, and ranked on the skill board as `EtternaOverall`. `ratings.Overall` stays the stored SSR aggregate that farm helper, the accuracy model and teams read. The Etterna | Classic toggle next to every Overall is one localStorage preference (`src/lib/overall-method.ts`). 6K-8K keep Classic.
- **4K LN** has its own independent model and scalar (release/coordination SSRs, LN identity at the played rate and OD). Other keymodes keep Overall-on-LN ratings with tail blending. See [LN analysis](../ln-skill.md).

## When it recomputes

`getPlayerSkillBreakdown` enqueues `compute_player_skills` when the row is missing, older than 12h, has pending plays after 30min, or a newer `top_play_events` row landed. After a version bump a player with no new plays queues at upgrade priority 5 rather than view priority 50, while the superseded row keeps serving. It runs with `ENABLE_OSU_API_JOBS` off.

**Pending plays**: a ready row with `pendingPlays > 0` carries `queue`. The compute stores why plays were left behind in `modes_json.pending` (revision verify, calc budget, rate vibro check), and the read reports the chart re-check line and the player's next compute (`running`, `queued` with lane position, or `scheduled` with `run_after`). Unreached plays stay in `plays_json` as unrated placeholders with a `pendingReason` (`revision`, `calc_budget`, `file`, `facts`, `rate_vibro`, `calc`). Placeholders never rated before carry `neverRated` and are neither clears nor refusals for dan. The Skills tab, dan evidence modal and recent lists show them as "in queue" rows.

## Skills tab and endpoints

- Views: Ratings, MSD plays, Dan plays, Unrated plays ([profiles-rankings.md](profiles-rankings.md#unrated-plays)).
- `/api/profiles/:id/skills` carries `tracked`. Untracked players only have their osu! top plays rated, and the tab says so; the owner gets the **Track my plays** action (login alone does not track).
- `/api/profiles/:id/skill-plays`: Best and Recent each form a max-200 cohort fetched once and filtered client-side. MSD axes rank by their SSR, pattern axes by Overall SSR on tagged charts. `rejected=1` adds sub-floor plays as "not rated" rows. `scoreId` resolves one exact play for share links (`/player/:username/skills?score=&keys=&map=&rating=`).
- Score dialogs use compact score details stored in `plays_json` (`player-skill-score-details.ts` fills older caches from local scores). Opening a dialog never calls osu!.
- Vibro exclusions show as "Vibro detected at 1.50x" / "in this chart" only when rejected plays are requested; structural stacks keep `chart_ineligible`.

## Companella and Hashi imports

Checked imports count toward regular players' MSD, pattern and dan ratings through a merge step (`companella_skill_merges`) read by every skill surface, keeping one play per chart/effective rate; when an import and an osu! play are the same run, the import's replay-measured rating counts. `player_skill_ratings` and pp stay official. Details and gates: `docs/companella-integration.md`, "Skill credit for regular players".

## History

- **Skill history** (`player_skill_history`, `/api/profiles/:id/skill-history?keys=&before=`): a durable per-keymode change log, public and uncached. Computes and dan/pattern sweeps write display-adjusted snapshots atomically with the rating; unchanged two-decimal values and labels add nothing. History freezes the display baseline at write time, survives retention, and is removed by the user-projection wipe. The dialog groups changes by the viewer's local day and never splits a day across pages.
- **Maniacard history** (`features/maniacard-history.ts`, `player_maniacard_history`, `/api/profiles/:id/maniacard-history`): written atomically with session-end, full-profile and pp snapshot updates. Each row freezes rating, tier, traits and model version. Per-map contributions are order-dependent estimates (new top plays replayed against the previous best-200); the UI shows their sum and the recorded delta without claiming why they differ.

## Seeding from a local corpus

`npm run export:player-skills` -> gzip/scp -> `npm run import:player-skills:dist -- <file>`, after deploying the matching `PLAYER_SKILLS_VERSION`. Existing ready target rows win; imported rows are backdated past the ready TTL so their SSRs act as reusable cache while the next profile read folds in newer plays.
