# Vibro and unrateable charts

Which charts and plays player ratings leave out, and why. Thresholds and the corpus measurements behind them live in code comments next to each constant; this page names the rules.

## Policy

- Chart ratings rate every note. Ordinary chart MSD, LeoBlack and Companella estimates never remove vibro. Removal is opt-in (`adjustVibro`) and only player SSRs and player dan credit use it. `/maps` dan and pattern filters do not hide flagged charts.
- Detection reads note data only, at the played rate. Titles, mappers, ids, stars and dan estimates never decide it. Reported charts become anonymous note-data regression fixtures, never identity exceptions.
- Four outcomes (`VibroAnalysis.status` plus the unrateable reasons):
  - **clean**: rated as is.
  - **adjusted**: the proven sections are cut from the calculator input (no timestamp stitching) and the rest is rated with a conservative retained-note goal (all original accuracy loss goes to the remaining notes; dan clear accuracy uses the same adjustment). The original accuracy stays beside `vibroAdjustment`.
  - **excluded** (vibro): kept out of player ratings and stored in `plays_json.vibroExcluded` (`chart_vibro` for the base chart, `rate_vibro` for the played rate).
  - **unrateable** (`jumptrill`, `stacked_heads`, `flam_chords`, read by `isUnrateableExclusion`; `map_search_index.vibro = 2`): nothing in the chart is past a human hand, the rating just cannot follow it. Players see "unrateable", not vibro.
- A flagged chart keeps its MSD; only player ratings skip it.

## Code

- `dan/vibro-detection.ts`: public entry points and the legacy rules (other keymodes, hold-heavy charts).
- `dan/vibro-sections.ts`: the 4K rice section scan (`analyzeVibroSections`), coverage policy, unrateable rules, removal (`prepareVibroChart`, `removeVibroSections`, `conservativeVibroAccuracy`).
- `dan/vibro-motion.ts`: played-rate finger, hand, four-key-cycle and split-double arms.
- `scripts/dev/audit-vibro.ts`: read-only corpus audit, no API or calculator work.

## 4K rice charts (at most 10% holds)

`analyzeVibroSections` runs at the played rate (normal speed, baked rate edits, DT/NC, custom rates). It first checks the unrateable rules, then collects sections from these scans. Several scans share reason names (`repeated_wall`, `repeated_chord`, `isolated_jack`, ...), so a reason says what the section looks like, not which scan found it:

- **Motion arms** (`vibro-motion.ts`): one finger past its hit-rate ceiling (`finger_rate_ceiling`, with extra room for a chordjack anchor that hits every row in charts whose fast rows are mostly quads); distinct hand-hit instants past the hand ceiling (`hand_action_ceiling`, simultaneous chords count once); sustained fast split-hand actions (`split_hand_double`); and a fixed-period cycle that every column feeds, consuming nearly every note in its span (`four_key_cycle`). The cycle sits under both ceilings, so it reads rotating chords, scattered rolls and jumptrills that collapse onto one repeated four-finger motion. It only counts when cycles cover a meaningful share of the chart.
- **Repeated rows and walls** (`scanRepeatedRows`, `scanIdleQuadWalls`): fast repeated rows; slower quad walls only when long, or when short walls repeat outside active chordjack.
- **Quad body** (`scanQuadBody`): charts whose notes sit largely in quad runs lose all of them.
- **Locked hands** (`locked_hands`): rows of one-hand jumps and quads where each row shares a hand with the one before, so each hand jacks as a unit. A jumptrill alternates hands every row and never qualifies.
- **Fast trill** (`fast_trill`): long two-finger trills past human speed, removed on their own.
- **Jumptrill** (`jumptrill`, unrateable): charts built from jumptrills.
- **Hammered chords** and **one-finger body** (`scanHammeredChords`, `scanOneFingerBody`): charts made of short pieces (repeated chords, one-finger runs handed between columns).
- **Jack streams and fixed fingers** (`scanRepeatedJackStreams`, `scanRepeatedPairs`, `scanFixedFingerWindows`, `scanIsolatedJacks`): sustained streams of short fixed-shape jacks, long single-finger runs under sparse accompaniment, and fixed-finger windows tracked through chord accents. A busy finger under dense changing chords is not isolated-jack evidence, and doubles, triples or slower short jacks do not qualify.
- **Fast rolls**, **extreme density**, and **sustained density** (`sustained_density`): ten seconds of four-finger density past the line excludes the chart whatever its coverage.
- **Recurring repetitions** (`scanRecurringRepetitions`): several short jack/chord/wall bursts covering most of a local phrase. Pure roll phrases do not qualify.

Fast chordjack whose fingers release between hits is not vibro: the finger and hand ceilings already catch what is past a human.

**Coverage decides adjusted vs excluded** (`measureSectionCoverage`): adjusting needs limited time and note shares removed, at least 300 notes and 20 seconds of active time left. Gaps count at most one second toward active time, so long breaks cannot dilute coverage. The note cap tightens when the chart's own jack content (`measureRepeatShare`, read at the chart's speed, never faster) shows the proven sections are samples of the chart rather than accents. Sustained density or a hammered-chord body always excludes. Charts under 200 notes get the same checks.

## Other charts

- **5K and wider**: the jumptrill rule (`analyzeWideJumptrill`), each hand being its half of the keys (an odd keymode's middle key joins the hand it is pressed with). Past the share is unrateable. Other keymodes otherwise keep the legacy policy.
- **4K past 10% holds**: the section scan does not run. The motion arms read note heads only (`analyzeHoldVibro`), and a chart they exclude is flagged vibro, never trimmed. The 4K jumptrill rule also applies.
- **Stacked heads** (any keymode, `analyzeStackedHeads`): a stack of `DAN_INELIGIBLE_STACKED_HEAD_MIN` objects is unrateable.
- **Flam chords** (4K, `analyzeCollapsedNotes`): chords written as rows a few ms apart that a player strikes together. Only chord-only presses count, holding a large share of the notes. A single note flammed onto a chord is ordinary writing. The finger-free guard keeps fast rolls from pairing into jumps.
- **LN vibro** (`detectLnVibro`): staggered hold spam, judged by the LN rules (see [LN analysis](../ln-skill.md)).

## Storage and refresh

- `classification_json.vibroAnalysis` and rate-analysis responses carry the sections and status. The map popup shows them as `m:ss.ss` ranges, merging gaps up to 250ms for display only.
- Adjusted verdicts use the `vibro-adjusted` variant in `dan_mod_estimates`, separate from ordinary `dan_estimates`. Adjusted plays need a freshly versioned rate verdict even at 1.0x.
- Rule changes ship as bumps of the chart sweep (`vibro_recompute_done:v*`), the rate check (`RATE_VIBRO_CHECK_VERSION` for 4K, `WIDE_RATE_VIBRO_CHECK_VERSION` for 5K+, via `rateVibroCheckVersionFor`), the player vibro sweep, and, when credit changes, the player skills version and dan cache. Pick the narrowest set: a 5K+ bump must not recheck 4K plays.
