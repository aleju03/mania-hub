# Live boards

Teams, the tracker, snipes, top plays and activity. The live data flow (snapshots plus SSE) is in `docs/frontend.md`; ingest and jobs in `docs/backend.md`.

## Teams

`/teams` lists team totals over tracked members; `/team/<id>` combines a cached osu! team roster with stored member profiles, top plays, skills and activity.

- **Roster fetches**: one osu! call on a team's first visit, reused for 10 minutes, then refreshed by a job at player-profile priority while the stored roster serves. Only visits that would reach osu! are admitted (`TEAM_FETCH_RATE_PER_MINUTE` per IP, `TEAM_FETCH_GLOBAL_RATE_PER_MINUTE` site-wide), and every team osu! call in either process also takes a slot from the shared `team_osu_calls` budget just before the request. A refused first visit gets a 429; a refused refresh job defers. Outstanding roster and card jobs are capped at 50 each, in-flight roster fetches at ten per writer, and simultaneous first visits to a team share one admission. Team ids osu! 404s are remembered for an hour.
- **Team pp**: the roster call carries osu!'s team pp and stores the tracked members' total at that moment (`statistics_json.tracked_pp`). The board shows the current tracked total plus that stored gap (never below the tracked total). Opened teams count only players on the stored roster; never-opened teams show the tracked total alone. The "X of Y members counted" denominator is the cached roster size.
- **No fan-out**: team visits never enqueue member profiles or skills; missing members appear once their own profiles populate. SSR is stored-only and schedules no work.
- **Reads** run on one lazy bounded serving read worker (snapshots, cards, recent plays, skill labels, rankings, activity); overload returns a retryable 503, never a serving-thread fallback. Best-play windows use the same stored-score overlay as player profiles (confirmed top-play events plus eligible tracked scores, per-player top 200). No osu! calls or queue writes.
- **Live**: an open team page listens for `tracker_score`/`top_play` on the pooled GLOBAL SSE stream without activating countries, and refreshes `/api/teams/<id>/top-play-dates` on member events (coalesced, three-second minimum gap). Hidden pages do not poll.
- **Board**: rebuilt on a visit when its one-hour cache is due. There is no scheduler, ranking crawl or idle refresh. Playtime sums stored `statistics.play_time`. The board, local rank peaks (`team_member_rank_peaks`, never mixed with osu! ranks) and build stamp publish atomically. The legacy ranking tables are unused.

## Tracker

Reads, hydration and filtering run on a dedicated serving read worker with five-second caches shared per scope, filter and page; GLOBAL windows align to five-second boundaries. Filtered or star-sorted requests scan at most 5,000 rows, so their totals describe only the scanned matches. SSE supplies new scores between refreshes.

Checked Companella imports from any account are merged into tracker snapshots at read time and arrive live as `companella_score` (`integrations/companella/public-feed.ts`): lean rows with a negative id and a `companella` mark, never written to `score_events` or any projection. Watch rules are under "Privacy" in `docs/companella-integration.md`.

## Snipes

Each beatmap/lane has a stored board in `country_beatmap_scores` (country + beatmap + lane + user), so raw scores need not be kept. A score that overtakes someone writes `snipe_events` and emits SSE `snipe`.

- **Comparable scores only** (`scoreCountsForSnipes` in `backend/src/shared/score.ts`): no note-changing mods (HO, IN, NR, DS), no DA, CS or WU/WD/AS, no key mod that changes the key count (on a convert every key mod does), and DT/NC or HT/DC only at the default 1.5x/0.75x, since every lazer custom rate would share one board. osu! ranks most of these, so its leaderboard check alone does not catch them.
- A late score (manual submission, backfill) removes any snipe on its player that it predates and matches or beats.

Two board modes (`getSnipeBoardMode` in `countries.ts`); only the first spends osu! calls:

- **Seeded** (the `snipes` tier, CR only): a missing board is built by `seed_snipe_board` from roster users' scores, unless the map's leaderboard opened after `SNIPES_INGEST_SINCE`, in which case stored scores suffice (see `docs/backend.md`). An overtake by a sniper with no verified local history also checks the sniper's own osu! scores, so an older higher personal best cancels the snipe.
- **Tracked** (every other `live` country and `GLOBAL`): the board holds only scores ingest has seen, so a first tracked play can count as a snipe over an older untracked best; the snipes page says so. The `GLOBAL` board (country code `GLOBAL`) takes the top 100 of the global rankings who also hold an official global rank of 100 or better. The GLOBAL SSE stream and `/api/events` carry only GLOBAL-board snipes (`isSnipeFromAnotherBoard`).

Board read: `/api/snapshots/snipe-board?country=XX&beatmap=<id>&mods=DT,HD&lazer=1` (lane derived server-side; ordered by total score; `limit` up to 100, `total` always full). The frontend loads it when a `/snipes` row is expanded.

## Top plays

Detected country top plays live in `top_play_events`. When a score lands near the player's known top-play threshold, `refresh_user_top_scores` confirms through osu! whether it entered their top plays (window ~30 min), records the pp gain, and emits `top_play`.

- Snapshot reads select the page's rowids before loading payloads; shallow GLOBAL pp/gain pages try a bounded prefix of the sort index first. Responses share a five-second cache that new events invalidate.
- **All time** (`window=all`) ranks tracked ranked members' stored osu! bests (`user_top_scores`) by pp, capped at 1,000, cached 10 minutes per scope and filter. Stored bests have no pp gain, so the gain sort falls back to pp.
- `rates=nm,dt,ht` filters on the promoted `rate_mod` column (1 DT/NC, -1 HT/DC, 0 neither; `backfillTopPlayRateMods` filled older rows).

## Activity

Per-day player skill vectors in the `player_activity_*` tables, computed by `analyze_activity_beatmap` and versioned by `ACTIVITY_SKILL_ANALYSIS_VERSION`.

- The rice half is the dan estimator's family mix (`chooseSkillFamily` over `estimateFamilyScores`); the LN half (the `ln` axis and subtypes) comes from the shared pattern analyzer (`dan-estimator/patterns.ts`), the same scores behind `/maps` pattern tags. An LN headline is a pattern claim, not `chartIsLn` (the dan-routing identity gate a hybrid can miss). 4K activity keeps one LN category; 7K keeps its four subtypes.
- Reads take the newest ready vector at or below the current version, so a bump degrades to the previous analysis while the backfill runs.
- Calendar, day-detail and availability reads run on a bounded serving read worker with a five-second cache (128 entries, 8 MiB). Missing backfill and analysis work is returned as intents for the caller's write queue; the query-only reader never writes. Failures return a retryable 503.
- Reads queue `backfill_player_activity` for retained legacy gaps (at most 2,000 ids per batch, durable cursor). Repair writes require the source score and an unsuppressed user in the same statement, so a concurrent wipe cannot recreate activity. Opting out keeps history; wiping a player removes it.
