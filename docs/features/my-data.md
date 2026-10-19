# My Data

A signed-in player's personal dashboard at `/my-data`. The skill rating card on it is documented in [skill-ratings.md](skill-ratings.md).

## Summary and feeds

`backend/src/features/my-data.ts` adds no table of its own. Endpoints: `/api/my-data/{summary,dashboard,feed,top-plays,skills,insights}`.

- `getMyDataSummary`: stats an osu! profile does not show (personal records, a play-rhythm clock bucketed in the country's timezone, a mods fingerprint, key/card/goal counts), on a 30s per-user cache.
- `getUserTrackedFeed`: the player's tracker feed over `player_activity_score_refs` joined to `score_events`.
- `getUserTopPlaysFeed`: the player's durable `top_play_events`.

## Insights

`my-data-insights.ts`, on its own endpoint (`/api/my-data/insights`) and a 60s cache so the feed paints first. Four bounded per-user reads, no new table:

- **Play diet**: how many analyzed plays (the `plays_json` pool) carry each chart-analysis pattern tag, per keymode, using the same tag rule as the pattern ratings.
- **Session shape**: `player_activity_score_refs` folded on the 45-minute session gap `activity.ts` uses. A span runs from first play to last play, so it understates by the last map's length.
- **Grind record**: the most-played map by `player_activity_maps.play_count`.
- **Judgement fingerprint**: MAX:300 ratio, MAX share, misses per 1k notes and accuracy per keymode, from `player_activity_maps.best_statistics_json`. Accuracy is recomputed from judgement counts so stable and lazer compare. It reads the activity projection rather than `score_events`, because raw scores are pruned after `SCORE_EVENT_RETENTION_DAYS` (14). The cost is that a row is the best play per map per day, so the numbers read slightly cleaner than a true average. The card states its sample size and how far back it reaches.

## Removing tracked plays

A player who added themselves to the roster can remove their own tracked plays from the Tracked tab (one, or all) and stop tracking, keeping or removing what was recorded. The top 100 cannot: they are tracked regardless, and the endpoint refuses them. Each action needs a 1.2s hold (`RemovePlaysSheet.tsx`).

`own-score-removal.ts` deletes the play's `score_events` rows and its activity projection (`player_activity_score_refs`/`days`/`maps`) and writes a `user_removed_scores` row that ingest and the osu! recents load check, so the play is never recorded again. The row also matches on beatmap plus `ended_at`, covering an official copy of a play first stored without an id. Skill ratings are untouched: the compute keeps stored plays whose source rows are gone, so removing plays cannot lift a dan whose clear window is not yet full. Endpoint `/api/my-data/remove-scores` (bridge-gated, `{ all: true }` or up to 200 `scoreIdentities`).
