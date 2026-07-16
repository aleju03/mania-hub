# Live Backend

Architecture guide for the always-on `live-backend/` service. Paths below are relative to `live-backend/`. See `../AGENTS.md` for the fuller per-feature detail.

The live backend is the source of truth for live surfaces when `VITE_LIVE_BACKEND_URL` is set. Browsers fetch a snapshot on page entry, then subscribe to SSE (`/api/live?country=XX`) for deltas; SSE is one-way and browsers never talk to oSC. Reconnects replay missed events via `Last-Event-ID` against `live_event_log`.

Ingest flow (`src/ingest/score-ingestor.ts`):
1. Scores arrive from three sources: oSC Socket.IO (`src/osc/client.ts`, real-time), oSC JSON backfill (`src/osc/backfill.ts`, catch-up), and an osu! API recent-scores fallback poller (`src/osc/scores-fallback.ts`).
2. Filter to mania; detect country via `country_rosters` (oSC payloads lack country).
3. Raw rows land in `score_events`; metadata upserts into `users` / `beatmaps` / `beatmapsets`; projections and follow-up jobs fan out per enabled feature tier.

Job queue (`src/jobs/queue.ts` + `src/workers.ts`): jobs table with priority, dedupe keys, per-type backoff, and pressure shedding (low-priority types defer when queue depth is high). Workers run in dedicated lanes (fast enrichment, osc-backfill, osc-country-catchup, maps-refresh, dan-estimates, activity-analysis incl. chart analysis, snipe-seed, replay-video render, replay-video finalize, and more). Job types (user/beatmap enrichment, roster + top-score + maps refreshes, snipe seeding, activity and dan analysis, oSC catch-up, replay-video render/export) are enumerated in AGENTS.md.

Feature modules (`src/features/`), one per surface (full per-feature models in AGENTS.md):
- `tracker.ts`: live score timeline with filters.
- `top-plays.ts`: confirms a candidate score entered the player's top plays via osu! API; records PP gain in `top_play_events`.
- `snipes.ts`: per-beatmap/lane boards in `country_beatmap_scores`; an overtake writes `snipe_events`.
- `maps.ts`: aggregates roster users' farmed scores into `country_maps_snapshots` (plus a global rollup).
- `farm-helper.ts` + `farm-helper-key-stats.ts`: PP-gain recommendations from a player's top 200 vs a global peer pool at similar PP; per-keymode weighted PP in `farm_helper_user_key_stats`.
- `activity.ts`: per-day player skill vectors (stream/jack/LN/etc.) in `player_activity_*`, bucketed in the player's country timezone at read time.
- `dan-estimates.ts`: cached dan ratings (`dan_estimates`), small batches inline, larger ones queued.
- `global-rankings.ts`, `rank-snapshots.ts`, `player-profiles.ts`: global ranking snapshot (union of tracked rosters by pp), 7-day rank deltas, and cached profile snapshots.
- `goals.ts`: per-user goals (`user_goals`) that auto-complete off the score pipeline; backs `/goals`.
- `my-data.ts`: the signed-in player's dashboard projections (reads existing projections, owns no table); backs `/my-data`.
- `player-skills.ts`: Etterna-style per-keymode skillset ratings from the player's top plays (per-play MinaCalc SSRs at the played rate, `player_skill_ratings`); backs the my-stats "Skill rating" card.
- `pack-wallets.ts`: synced maniacard pack economy (`pack_wallets`, `pack_collection_cards`); backs `/packs`.
- `analytics.ts`: in-house web analytics (PostHog replacement). Events arrive from the Vercel `/api/sync` proxy at `POST /api/analytics/capture` (bearer-token gated) and land in a **separate SQLite file** (`ANALYTICS_DATABASE_URL`, own WAL) via a 1s-batched writer; admin queries at `/api/admin/analytics/{monitor,valley}` power the `/admin/live-backend` analytics tab and `/valley`; `/api/admin/analytics/live` streams accepted events over SSE (short-lived tickets from `/live-ticket`, since EventSource can't send auth headers). Hourly self-pruning (`ANALYTICS_RETENTION_DAYS`, default 90). Owned by the HTTP-serving process; the pure worker role never opens it.

Discord bot (`src/discord/`): optional HTTP-interactions bot (maniabot), gated by `ENABLE_DISCORD_BOT` / `ENABLE_DISCORD_FEEDS`; slash commands plus per-channel subscription feeds, frontend `/discord` and `/admin/discord`. Replies are Components V2 and use custom application emojis for grade pills / mod icons (`discord/emojis.ts`, built by `scripts/build-discord-emojis.mjs`, uploaded via the admin "Register emojis" action, with plain-text fallbacks). Keep embeds free of decorative unicode emoji (enforced by `discord-embeds.test.ts`). Details in AGENTS.md.

HTTP (`src/http/snapshots.ts`): snapshot, profile, dan-estimate, audio, replay-video, and country endpoints, plus admin endpoints under `/api/admin/*` gated by `LIVE_ADMIN_TOKEN` (full list in AGENTS.md). Note: some per-user endpoints (goals, my-data, roster self opt-in/out, pack wallet/collection) and the osu! proxies are also `LIVE_ADMIN_TOKEN`-gated and called server-to-server, with the frontend injecting the token plus the osu!-verified viewer id so a user only touches their own data. Per-IP rate limiting via `src/http/abuse-guard.ts`; CORS from `ALLOWED_ORIGINS`.

Replay video: the browser renders/encodes MP4 with WebCodecs and uploads it, or the backend renders server-side in headless Chrome (`src/replay-video/server-render.ts`, playwright-core). Finalization muxes audio with ffmpeg and uploads to R2. `scripts/dev/replay-video-job.ts` is a Vite dev middleware fallback when no live backend is configured.

Storage and retention: LibSQL/SQLite (default `live-backend/data/mania-hub-live.db`, WAL), schema in `migrations/001_initial.sql`, applied at boot. `src/retention.ts` runs hourly to prune raw/transient rows (score events, event log, done jobs, api logs, snapshots; per-table cutoffs in AGENTS.md); durable projections (boards, events, users, beatmaps, rosters) are never cleaned up. DB size is capped (~10GB max, compaction targets ~8GB).

osu! API budget: token-bucket limited in `src/osu/client.ts` (~45/min target, 60/min hard); calls are logged to `api_call_log`. Don't add new osu! API call paths without going through this client.

