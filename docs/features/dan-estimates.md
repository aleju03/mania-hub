# Dan estimates

Chart dan verdicts, and how player clears turn them into a player dan. Classification stays algorithmic: no title, mapper, id or other chart-identity shortcut (see the hard rules in `AGENTS.md`). The only identity lists are the course and practice registries below, which credit players and never rate a chart.

## Chart verdicts

- `dan_estimates` caches verdicts keyed by `(beatmap, rate_percent)` and a cache version from `backend/src/dan/`. Small batches compute inline at request time; larger ones queue `compute_dan_estimate`.
- The unified classifier (`dan/chart-classifier.ts`) routes 4K rice to LeoBlack Mixed, 4K LN to LeoBlack's LN interval table (the in-house kNN covers only what sits under its LN 5 floor), and 6K/7K through Sunny interval tables. Chart-analysis details and the LeoBlack local adaptations are in [chart-analysis.md](chart-analysis.md).
- Version bumps keep serving the newest previous ready verdict while the replacement is queued. Workers require the current version. A completed current-version negative result supersedes old credit; malformed or star-mismatched rows never become fallbacks.
- **Rates**: any play in 0.5x-2.0x credits the stored verdict at its own `rate_percent`. The skill compute fills a bounded batch of missing verdicts inline (`MAX_RATE_VERDICT_COMPUTES`), and the dan-evidence read queues the rest.
- **Played OD**: DA OD and HR/EZ are passed to LeoBlack for player verdicts (DA wins). The 4K effective-LN gate reads its release window at the played OD (`resolvePlayedOd`), so a low-OD file played at DA OD8 files LN exactly where the same chart uploaded at OD8 would. Ordinary chart ratings keep the file OD, and the public chart endpoint ignores played-OD inputs. Explicit OD gets its own cache key even when equal to the file's, because upstream Mixed routes 4K differently when OD is explicit.
- **Invert** (4K and 7K): the play is rated against the inverted chart (`dan/invert-mod.ts` rebuilds it the way `ManiaModInvert` does). It is its own slot (`StoredPlaySsr.inverse`), carries the `ln`/`lninverse` tags, and is never read as the chart's own verdict. Hold Off and No Release refuse a rating (`scoreRewritesChart`), as does Invert on other keymodes.
- `dan_mod_estimates.mod_variant` holds the variant: `OD:<value|HR|EZ>`, optionally prefixed by `IN:` or `vibro-adjusted:`.
- **Structural eligibility**: `classification_json.danEligibility` comes from note structure only. A same-column stack of eight or more objects makes the chart ineligible for player dan at every rate (it is also unrateable, see [vibro.md](vibro.md)); `/maps` may still show the calculator's verdict.

## What a clear credits

`backend/src/dan/dan-credit.ts`; the per-ladder anchors are in `danCreditOptionsFor`.

- The ladder's bar is the zero point: a bare pass credits the chart's full rawDan. Above the bar, accuracy earns a bonus on normalized headroom (+0.35 at half, +1.5 at 100%; the span is never narrower than `DAN_CREDIT_BONUS_MIN_SPAN`). Below it, a pass within the decay window credits a reduced level, continuous from the bar with no step (rice: 5 points, -1.25 at four under, -1.5 at five).
- **6K/7K LN**: same bonus, a 3-point decay with a knee at a third of the window.
- **4K LN**: its bar is in ScoreV2, where 100% is out of reach on most LN charts, so its bonus is keyed in absolute points over the bar and tops out at +0.7 at 99.7%. Its decay follows the rice line one point further (six points under).
- **4K rice jack tile**: half the above-bar bonus (`DAN_CREDIT_JACK_BONUS_SCALE`), because 99%+ is what an ordinary jack pass looks like.
- The minimum played OD for 4K LN credit is 7; DA uses the play's override. A ranked or approved chart is never held above its own OD (a ranked OD 6 4K LN chart credits at OD 6), but a DA play that lowers it still is. EZ, the OD floors and the other credit exclusions apply as usual.
- Credits clamp to the ladder's floor/ceiling (`danTableFloorFor`/`danTableCeilingFor`). Reduced credit may keep the chart's display tier but never counts as a full clear.

## From clears to a player dan

- **Repeat cap** (`selectDanRatingClears`): best attempt per chart/rate, then the two highest credits per note-verified chart family and ladder, across rate variants and verified reuploads. This runs before skillset grouping, quorums and averaging, so a third rate can earn nothing anywhere. Extra plays appear as rejected `chart_repeat_limit`. Invert is separate. A play whose revision can never be verified is rejected `unverifiable_revision`.
- **Aggregation**: per skillset, the best-first mean of up to 20 credited clears, with a four-clear quorum. The headline is the mean of the skillset dans, except:
  - **4K LN** averages the side's best clears directly (`headlineFromSkillsets`): its four course skillsets have too few top charts to fill their windows.
  - **7K LN** follows its General tile (`anchoredSkillsetDans`), pulled by half the other tiles' mean distance, each distance capped at two levels. Release charts barely exist near the top, so a plain mean would sink strong players. A capped tile is flagged `headlineCapped`, and the evidence names `anchorSkillset`.
- **Window fill**: each verdict stores `clearWindow` (`have` of `need`, plus `skills: { full, total }`). `DanLevelBadge` draws a ring in the corner for an incomplete estimate, filling at most 85% of the circle (`RING_MAX_SWEEP`) so it never looks complete. A headline set by a course clear has no window.
- **Sub-floor passes** (`plays_json.danOnly`) count for dan but never for MSD ratings or accuracy fitting. Dan rules decide credit independently of the Wife/MSD goal floor.
- **Vibro**: excluded plays never enter dan; adjusted plays credit through the `vibro-adjusted` verdict ([vibro.md](vibro.md)).

## Which tile a clear files under

The skillset buckets are derived when the skills compute runs and stored in `modes_json` by `computeModeDan` (the dan board reads them there), from the same bucket walk as the dan-evidence window.

- **4K rice**: tiles are jack/tech/speed/stamina; a clear normally files under the play's strongest MinaCalc skillset.
  - A confident chart-analysis `speedjack` or `chordjack` tag overrides into Jack (MinaCalc reads speedjack as Jumpstream).
  - `dan/jack-demand.ts` (`classification_json.jackDemand`) also files a clear under Jack when the note structure shows jack demand that MinaCalc's anchored-row suppression hides: dense alternating chords reloading the same fingers, a chart LeoBlack reads as mostly jack clusters, or a long jack marathon. Only clusters slow enough to be jacked count. It moves the clear; it never rates the chart.
  - Primarily jack charts file under Jack only; jack endurance is not stamina evidence.
  - **Speed vs tech** comes from the notes: `dan/motion-features.ts` measures trill, minijack, anchor and same-hand shares (`classification_json.motion`, read only from sections at the chart's own pace), and a clipped logistic model (`SPEED_TECH_MODEL`) combines them with the MSD lead and the analyzer's tech score. Between its two bars the chart files under both tiles. The model only speaks while Stream is within `SPEED_TECH_MODEL_MAX_STREAM_GAP` of the best skillset. A feature change is a `motion_features_recompute_done:v*` bump, a refit with `scripts/dev/speed-tech-model.ts`, and a dan sweep bump.
  - Stamina wins over the Speed near-tie when Stamina is the top MSD skill and Handstream second. A stamina marathon whose base skillset is Stream or Technical files under stamina and tech when Technical clearly leads.
- **6K/7K rice**: jack/tech/speed/stream. **7K LN**: General/Tech/Inverse/Release. **4K LN**: Hybrid/Technical/Walls/Speed ([LN analysis](../ln-skill.md)).
- A clear on two tiles raises both tiles' dans but counts toward only the stronger tile's quorum, so it cannot open a skill on its own.

## Hybrid charts

The hybrid badge is defined in [chart-analysis.md](chart-analysis.md#hybrids). For credit:

- A clear on a hybrid filed LN also credits rice at the chart's rice half, on the rice bar and the rice OD floor (`hybridRiceCreditFor`). At 1.0x, and at 1.5x/0.75x when the stored rate verdict is also a hybrid. That rice clear drops a shared Speed tile.
- The reverse is narrow: a 1.0x clear on a hybrid filed rice credits LN only when the chart has at least 35% holds, its LN sections carry 30% of the notes, and those sections rated alone read half a dan above the rice half (`hybridLnSectionsCredit`, `hybridLnCreditFor`, stored as `lnSections`). It credits at the sections' dan on the LN bar and LN OD floor. Crediting the whole LN half moved most LN players and lifted rice mains, which is why it is gated.

## Chart families

`features/chart-families.ts` groups verified reuploads in `beatmap_chart_families`: rate edits and copies with a few notes padded in. Head/tail note hashes find candidates; `sameChart` then requires every head and hold end to agree under one time scale and offset, with at most `paddingAllowance` extra notes. A changed, moved or removed note makes a different chart. Titles, ids, difficulty names and declared rates never establish a match. Unverified charts fall back to beatmap-id grouping.

When a cached `.osu` is overwritten by an edit that left the notes alone (`sameChartRevision`), the old md5 is appended to `beatmap_osu_files.same_chart_md5s`, so older plays still match.

Fresh analyses register families; `recompute_chart_family_sweep` backfills from cached files only. The skillset registry charts are fingerprinted at boot (`ensureDanSkillsetRegistrySeeded`).

## Course clears

`backend/src/features/dan-courses.ts` registers the real dan courses (canonical uploads only): Thaumiel's 4K Dan ~ REFORM ~, _underjoy's 4K LN v2 with its extra levels, Jinjin's 7K regular and LN, Arkman's 6K regular and [Crz]sunnyxxy's 6K LN.

- Other uploads count when they are the same exam: `dan-course-fingerprints.ts` holds each listed upload's note fingerprint (the practice-chart fingerprint: every note and hold end, timing offset aside, plus OD), and a copy with the same fingerprint and HP is indexed in `dan_skillset_chart_matches` (on cache, by the registry seed for already-cached files) and credits as that course under its own beatmap id, with `referenceBeatmapId` naming the listed upload. Cuts, edits and rate shifts fingerprint differently and stay ordinary charts. There are no OD variants: Difficulty Adjust still disqualifies a course run. A course added to the registry needs its fingerprint line (the registry test fails without one).

- A verified pass **floors** that keymode and side: `danSideFromClears` takes `max(average, best course credit)`, and on a side without quorum the course is the whole verdict. It never lowers a headline or touches skillset dans. `courseClear` records when it set the number.
- Each course names its level by community label, resolved through the ladder `danLabelFor` prints (a registry test asserts the round trip).
- Accuracy sets the offset within the level, on the dan suffix bands every dan uses (`danVariantForOffset`). Course credit is capped under half a level, so an overclear never reads as the next course: it is a single-run floor with no quorum behind it. Under the bar it stops short of a bare level. 4K LN credits from the bar up only. 7K LN has a deeper sub-bar curve, down to 93%.
- Clears are read from `score_events` and the activity archive, never `plays_json` (that pool is deduped and capped). EZ/NF/HT/DC/RD, key mods, automation mods and sub-1.0 `speed_change` disqualify; a row with unrecorded mods credits nothing.

## Skillset practice clears

`features/dan-skillset-registry.ts` holds the practice-pack charts from `dan_skillset_list.txt` (4K regular, 7K regular and LN, 4K LN stage packs; none for 6K). One qualifying clear grants a baseline on that skillset, independent of the quorum.

- Identity is a note fingerprint (`dan-skillset-identity.ts`: key count, exact OD, every note's column/head/tail). Metadata and global offset are ignored; any upload with the same fingerprint qualifies. App imports are matched on the fingerprint of the file they were played on, so an upload the site never cached counts too (`docs/companella-integration.md`).
- An upload with identical notes but a different OD is an **OD variant**: it counts only on a Difficulty Adjust run that sets the reference OD and changes nothing else that matters (HP not below the file's).
- At the full bar the baseline is exactly the named tier, with no overclear bonus. Within one point under the bar it takes the "-" credit, and only lifts a tile the player's clears already opened. A tile already at or over that credit but still under the level keeps its number and shows the near clear. Below that, or on 4K LN, nothing.
- The credit applies only inside the registered skillset (a Release/General chart credits Release; General keeps the ordinary credit). Sides with only practice credit carry `skillsetsOnly` and show no overall dan until ordinary evidence or a course supports one.

## Adding missing evidence

- **Add a missing score** (Skills tab, anyone): an osu! score link is verified as a passed mania score owned by that player and goes through the ordinary `ScoreIngestor` and dan gates. It is historical ingest: projections and skills update, but no tracker, snipe, top-play, session or goal event is created. Links queue in the browser one at a time. Mamestagram plays take another path: on a profile that linked its Mamestagram account the dialog lists that account's plays to add, and they are stored as imports, never ingested (`docs/companella-integration.md`, "Mamestagram plays").
- **Import a leaderboard** (admin only, same dialog; `features/leaderboard-import.ts`, `POST /api/admin/leaderboard-imports`): searches the map index with `/maps` token syntax and queues one `import_beatmap_leaderboard` job per chart for its global top 50. A seven-day per-chart cooldown comes from `leaderboard_import_history`. Scores take the manual-submission path (source `leaderboard_import`); players from untracked countries are counted, not stored.

## Refreshing stored verdicts

A change to a dan derivation rule bumps `player_skill_dan_sweep_done:v*`, which refolds every player's stored evidence from `plays_json` without rerunning MinaCalc. Rule changes that need new chart verdicts bump the dan cache version instead (stale verdicts keep serving until replaced).
