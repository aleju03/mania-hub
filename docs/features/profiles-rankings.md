# Profiles and rankings

Player profiles, the `/rankings` boards, unrated plays and goals. The rating and dan models behind the Skills, Dan and Clears boards are in [skill-ratings.md](skill-ratings.md) and [dan-estimates.md](dan-estimates.md).

## Profiles

`player-profiles.ts` caches a best-200 snapshot for 24h (projected forward by top-play events) and profile sections for ~2 minutes (recent) or 10 (about).

- **No osu! calls on the request path**: opening a profile serves the stored snapshot and queues `refresh_profile_user` / `refresh_profile_snapshot`. The one exception is creating a player never stored at all, which is what searching for an untracked player does. Profile fetches and refresh jobs seed the About cache from the user payload.
- **Load osu! recents** is display-only for an untracked player; for a tracked one it also fills gaps. **Track my plays** is the explicit opt-in.
- **Signature demand**: a valid dynamic-signature resolve for a tracked rank-null owner queues the full-snapshot job (Insights/Maniacard) or the one-call user job (open PP/rank goal) at the roster refresh cadence. Ranked members are skipped; their roster paths already do this.
- **Presence**: the green dot means a tracked play inside the 10-minute session window, nothing else (osu!'s `is_online` counts idling, so it is ignored here; the rankings list still shows it on purpose). Last seen is the newer of the last tracked play and the payload's `last_visit` while that payload is fresh.
- **Restricted players** rank by simulated pp from their Companella imports and get Skills/Activity built from those imports alone (`integrations/companella/restricted-profile.ts`, no osu! call). Every account's checked imports also show on the Recent tab. See `docs/companella-integration.md`.

### Per-keymode pp and tracked plays

osu! only publishes cumulative 4K and 7K pp, both from the top-200 window, so a side keymode reads far under the truth. `keymode-pp.ts` (`GET /api/profiles/{userId}/keymode-pp`) adds the pp plays this site tracked that the window cannot show:

- `player_activity_maps` reduced to one row per map (ordered by `activityMapBestRowOrder`: best pp, then latest day, then rowid; the prune and both backfill sweeps use the same order), keymode from `maps_beatmaps.cs` with `map_search_index.key_count` as fallback, capped at 200 per keymode. Converts have no row in either table and drop out, as on osu!. Unknown maps count in `unknownKeyCount`, so totals are floors.
- The frontend merges it into the window in `calculateUserProfileInsights` (window wins a map in both). The `+` bound stays measured from the window alone. The playcount bonus is deliberately omitted.
- The Best Performance tab lists tracked plays inline once a keymode filter is picked, ranked and cut at 200 before the mod filter so the list and the total describe the same plays. Both wait for the whole window (SSR seeds only 50).

**Tracked rows never call osu! when drawn.** Ingest stores `best_max_combo`, `best_total_score`, `best_has_replay`, `best_solo_score_id` (the id `/replay` resolves) and `best_played_at`. The first four are kept only on a map's best row (`clearSupersededPlayDetails`); mods and judgement counts stay on every row because the dan pipeline reads each archived day-best. Missing fields read as unknown (a dash, no replay button). Clicking a row builds the details card locally (`lib/tracked-play-score.ts`). Top-play detection never reads `player_activity_maps`.

Filling older rows:

- `features/activity-play-details-backfill.ts`: once at boot, from local payloads only, matched by score id in the row's own id space (matching on pp to two decimals is not an identity and was replaced).
- `features/activity-combo-backfill.ts`: combo needs osu!. A boot-seeded self-chaining job (20 rows per 150s) over rows a profile can actually draw, capped by `ACTIVITY_COMBO_BACKFILL_PLAYERS`, `..._ROWS_PER_PLAYER` and `..._PIN_USERS`, checkpointed in `live_meta`.
- `features/activity-detail-on-demand.ts`: when someone opens a profile's per-keymode lists, missing rows are queued for one osu! call each, after the response. Profiles nobody opens cost nothing. It has its own worker lane (sharing one with the sweep starved the sweep), and each chain link takes its own dedupe key (`:<userId>:<link>`) because the queue's conflict clause only updates queued, failed or deferred rows, so a continuation enqueued under the running job's key would write nothing.
- Scores osu! cannot serve go to `activity_play_detail_misses` and are never asked about again.

### Signatures

Dynamic signatures read `getCachedSignatureProfileSnapshot` (projected best-200, identity, artwork). Image versions hash those inputs rather than timestamps, so unchanged refreshes and below-window plays reuse the finished image.

## Rankings

- **pp board** (`global-rankings.ts`): the union of every tracked country's ranked roster members, by mania pp, with 7-day deltas from `rank-snapshots.ts`. `pool=packs` also merges tracked rank-null members (`source in ('manual', 'score')`) so they are pullable maniacards while staying off every leaderboard. `keys=4|7` narrows the pack pool by main keymode (`users.pp_4k`/`pp_7k`, falling back to `farm_helper_user_key_stats`); a failed keymode build fails the request rather than serving the unfiltered pool.
- **Skill and dan boards** (`skill-leaderboards.ts`, `/api/snapshots/{skill-leaderboard,dan-leaderboard}`): one pass over every roster member's `player_skill_ratings.modes_json` builds an in-memory board cached per `Db` for 5 minutes; scope, keymode and axis are read-time views. No table, no job.
  - Skill boards rank the **display-shrunk** rating (`shrinkMode`, imported from `skill-baseline.ts`), so the board shows the same number as the profile.
  - `skill-baseline.ts` has two population floors on purpose: a shrink median from `BASELINE_MIN_USERS_PER_MEDIAN`, a quantile curve (percentile) only from `BASELINE_MIN_USERS_PER_CURVE`. Withholding the median would leave one thin axis ranked raw beside shrunk neighbours. `EXACT_SKILL_CURVES_FORMAT` versions the curve blob.
  - The payload lists only axes, keymodes and dan skillset columns that have a population, plus `shrunk` (per axis), `provisional` keymodes (fewer than `BASELINE_MIN_PLAYS`) and `coverage` (rows at the current `PLAYER_SKILLS_VERSION`, so a half-migrated board is visible).
  - Dan boards cover the 4K, 6K and 7K ladders, rank `rawDan` per keymode and side unshrunk, and carry a `skillset=` column from the stored per-bucket verdicts.
  - A failed rebuild keeps serving the previous board and retries after a minute.
- **Clears board** (`clear-leaderboards.ts`, `/api/snapshots/clears-leaderboard`): verified passes, not estimates. A Courses column and one column per practice skillset; each player once at their highest cleared level, then by accuracy, then by who got there first. `loadAllDanClears` keeps only runs at or above the bar. Official plays and active roster members only. Built on the maps snapshot thread at most every five minutes while read.

## Unrated plays

The board for plays the skill ratings leave out (`/rankings?tab=unrated`) and the Unrated plays view on the Skills tab. `unrated-plays.ts` owns both.

- **Pool**: plays in `plays_json.vibroExcluded` (vibro and unrateable charts, [vibro.md](vibro.md)), plus older rows still filed `chart_ineligible`. Sub-floor plays (no honest number on any axis) and trimmed plays (rated, listed under MSD plays) are not included.
- **Three numbers**, none read by the ordinary pipeline:
  - **pp**, computed locally: star rating at the played rate from the lazer port (`dan/mania-star-rating.ts`, Invert-aware) and `dan/mania-pp.ts`, shared with the replay viewer through `#dan`. Without judgement counts, or when the file's keymode differs from the play's, it uses osu!'s pp if positive, else nothing.
  - **MSD**: Overall SSR with every note counted (`adjustVibro: false`), from `chart_raw_ssr`, which is keyed by chart, rate, Invert and goal so one row serves every player with the same play.
  - **Dan**: the chart's verdict at the played rate via `danClearTargetFor`, the same target the dan list shows.
- **Storage**: `unrated_plays`, one row per player/chart/rate/Invert, rewritten by `refreshUnratedPlaysForUser` after each `compute_player_skills` (12-run calc budget) and by the boot-seeded `unrated_plays_sweep`. A play the budget could not rate is stored without MSD. No osu! calls. `wipeUserProjections` clears it.
- **Board**: one row per player and chart family (`chartKeyOf`), and each sort picks its own play for the row (`selectBoardRows`), since the best-pp and best-MSD plays are often different. The profile list keeps every rate. Endpoints `/api/snapshots/unrated-plays` (`keys`/`sort`/`range`/`page`) and `/api/profiles/:id/unrated-plays` (`keys`/`sort`, plus `recent`).
- **Serving**: a dedicated bounded reader; the raw board refreshes every five minutes, an expired board serves its previous generation during one background rebuild, and sorted projections are capped (64 per generation, 2 MiB). An unavailable reader returns 503 with no serving-thread fallback.

## Goals

Logged-in players set targets in `user_goals` (`reach_pp`, `play_pp`, `play_pp_count`, `accuracy`, `pass`, `grade`, `fc`, `reach_rank`), always owned by the osu!-verified viewer id.

- Play-shaped goals complete when ingest sees a matching play (`evaluateScoreGoals`, guarded so a goals bug cannot drop a score). Total-pp goals settle on top-play confirmation (`evaluatePpGoals`) and reconcile on read; profile refresh jobs also reconcile PP/rank goals.
- A `live_meta` marker (`user_goals_changed_at`) plus a negative cache keep the ingest hot path cheap.
- Completion emits SSE `goal_completed`. Endpoints `/api/goals`, `/api/goals/create`, `/api/goals/delete`; route `/goals`.
