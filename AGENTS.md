# Repository Guidelines

## What This Is

Mania Hub (mania-tracker.com) is an osu!mania community site with two cooperating parts:

- A TanStack Start + Vite React 19 app in `src/`, SSR via Nitro (Vercel target).
- An always-on live backend in `live-backend/` that listens to Kayla's oSC score feed, keeps durable SQLite projections warm, runs a DB-backed job queue, and streams updates to the frontend over SSE.

Surfaces: rankings (country + global), live tracker, top plays, maps, snipes, farm helper, replay viewer with video export, player profiles (about, recent, activity, maniacard), personal goals, a My Data dashboard, card packs (collectible maniacards), a BBCode profile editor, settings, and admin dashboards. An optional Discord bot (maniabot) adds a dev-gated `/discord` showcase and `/admin/discord` controls.

Countries are dynamic. The backend keeps a `country_registry` with per-country status (cold -> warm -> active, pausable) and a feature tier (`indexed`, `maps_warm`, `live`, `snipes`) that gates which projections run. Visiting a cold country can activate it (rate-limited). A synthetic `GLOBAL` scope aggregates all tracked countries. Default/home country is `CR`.

## Project Structure

Frontend source lives in `src/`:

- `src/routes/`: file-based routes. Shared shell, auth, country context, theme bootstrap, and live-backend bootstrap live in `src/routes/__root.tsx`. API routes in `src/routes/api/` (OG images, sitemap, audio/avatar/background proxies, replay upload, osu! OAuth, and `/api/sync`, the analytics capture proxy — dual-writes to the live backend's in-house analytics store, `live-backend/src/features/analytics.ts`, and to PostHog). A non-api server route `src/routes/videos/$id/$filename.ts` 302-redirects to a signed R2 URL for exported replay videos. Admin pages in `src/routes/admin/` (`live-backend`, `discord`, `dan-classifier`, `og-preview`, `r2`, `todos`). Files prefixed with `-` are tests, not routes. Do not hand-edit generated `src/routeTree.gen.ts`.
- `src/components/`: shared UI in feature folders (`layout/`, `home/`, `player/` incl. `maniacard3d/` and `bbcode/`, `replay/`, `maps/`, `farm-helper/`, `packs/`, `me/` (goals + My Data panels), `discord/`, `legal/`, `settings/`, `ui/`), plus a few loose top-level state-screen components (`BackendOfflineScreen.tsx`, `CountryWarming.tsx`, `LiveDataEmptyState.tsx`, `SnipesNotTracked.tsx`).
- `src/store.ts`: the Zustand client store.
- `src/lib/`: server/data utilities, the osu! API layer, replay modules, dan estimator.

The live backend lives in `live-backend/`:

- `live-backend/src/server.ts`: boot. Connects the DB, applies migrations, then conditionally starts workers, schedulers, the oSC socket (with watchdog), oSC backfill, the osu! recent-scores fallback poller, retention, and the HTTP server on port 7227.
- `live-backend/src/ingest/score-ingestor.ts`: score ingestion and projection fanout.
- `live-backend/src/osc/`: oSC Socket.IO client, JSON backfill, and the osu! API scores fallback poller.
- `live-backend/src/jobs/queue.ts` and `live-backend/src/workers.ts`: job queue and worker lanes.
- `live-backend/src/features/`: one module per surface (tracker, top-plays, snipes, maps, farm-helper, farm-helper-key-stats, activity, dan-estimates, global-rankings, rank-snapshots, player-profiles, goals, my-data, pack-wallets, admin-todos).
- `live-backend/src/http/snapshots.ts`: REST snapshots, profile endpoints, per-user (goals / my-data / roster / pack) endpoints, Discord interaction/admin routes, admin controls, replay video job endpoints. `live-backend/src/http/abuse-guard.ts`: per-IP rate limiting.
- `live-backend/src/live/`: SSE handler, event log with replay buffer, per-country client tracking.
- `live-backend/src/discord/`: the maniabot Discord subsystem (HTTP signed-interaction handler in `index.ts`/`verify.ts`, slash commands, message components, embeds, REST client, osu! account linking, and new-map/farm feeds). Gated by `enableDiscordBot`/`enableDiscordFeeds`; started from `server.ts` and routed through `http/snapshots.ts`.
- `live-backend/src/rosters/country-rosters.ts`: country roster build/refresh from osu! rankings, plus manual roster member add/remove.
- `live-backend/src/shared/`: cross-cutting helpers, including score normalization (`score.ts`, `score-storage.ts`), country timezone bucketing (`country-timezones.ts`), and shared `types.ts`.
- `live-backend/src/replay-video/`: server-side rendering (headless Chrome), finalization, R2 upload.
- `live-backend/src/dan/`: backend copy of the dan estimator. `live-backend/src/audio/`: beatmap archive download and audio streaming.
- `live-backend/src/maintenance/`: storage compaction and DB sync-from-VPS scripts.
- `live-backend/migrations/001_initial.sql`: schema, applied at boot.

Utility scripts live in `scripts/` (dan benchmark/analyze, replay capture/validate, plus `scripts/dev/replay-video-job.ts`, the Vite dev middleware fallback for replay video). Static assets live in `public/`.

## Development Commands

The user often keeps local servers running; do not start dev servers or builds unprompted. If asked: frontend is `3000`, live backend is `7227`.

- Frontend dev: `npm run dev`. Build: `npm run build`. Tests: `npm run test`. Typecheck: `npx tsc --noEmit`.
- Single test: `npx vitest run path/to/file.test.ts` (add `-t "name"` for one case).
- Live backend dev: `cd live-backend && npm run dev`. Tests: `npm test`. Typecheck: `npx tsc --noEmit`. Tests + build: `npm run verify`.
- oSC smoke: `cd live-backend && npm run smoke:osc`.
- Backend DB compaction: `cd live-backend && npm run compact:storage` (full VACUUM/GC) or `npm run compact:maps-farmed` (rebuild maps-farmed overlay).
- Sync prod DB to local: `npm run live-db:update` (root wrapper for `db:sync-from-vps --fresh`) creates a fresh snapshot on the VPS via sqlite3 `VACUUM INTO` + zstd, downloads it, replaces the local SQLite DB, and prunes old remote `online-*` snapshots (keeps 2, `--keep-remote N`; pruning runs before the new snapshot so a failed run cannot leave them accumulating, and the remote side refuses when it lacks the free space). `npm run live-db:sync-from-vps` reuses the newest pre-existing backup instead; supports `--dry-run`/`--force`. `--backup-local` keeps `--keep-local N` copies (default 2) of the replaced local DB. Run these from a dev PC, never on the VPS (they overwrite the local DB).
- Dan tooling: `npm run dan:benchmark`, `npm run dan:analyze`.

## Live Backend Architecture

The live backend is the source of truth for live surfaces when `VITE_LIVE_BACKEND_URL` is configured. Browsers fetch a snapshot on page entry, then subscribe to SSE for deltas. SSE is one-way backend-to-browser; users never connect to oSC directly.

Ingest flow:

1. Scores arrive from three sources: the oSC Socket.IO feed (real-time), oSC JSON backfill (catch-up after downtime), and an osu! API recent-scores fallback poller (safety net, own rate bucket).
2. Scores are filtered to mania. Country detection uses `country_rosters` plus enriched user data, because oSC payloads do not include country.
3. Raw rows land in `score_events`; user/beatmap/beatmapset metadata is upserted; projections and follow-up jobs fan out according to the country's feature tier.
4. The backend emits SSE events (`tracker_score`, `top_play`, `snipe`, `maps_farmed_update`, `goal_completed`, `job_status`, `status`, `replay_video_export`), plus a `hello` event on connect and `heartbeat` keepalives. Reconnecting clients replay missed events via `Last-Event-ID` against `live_event_log`.

Rosters are warmed from osu! mania performance rankings on a schedule; roster refreshes also capture `country_rank_snapshots` used for 7-day rank deltas.

## Queue and Jobs

The queue lives in the `jobs` table with priority, dedupe keys, and per-type backoff. Under load it sheds pressure: low-priority job types are auto-deferred (`deferred_pressure`) when queue depth is high and wake when it drains. Workers run in dedicated lanes (fast enrichment, osc-backfill, osc-country-catchup, maps-refresh, dan-estimates, activity-analysis, snipe-seed, replay-video render and finalize).

Job types:

- `enrich_user`, `enrich_beatmap`: fetch full metadata from the osu! API.
- `refresh_country_roster`: refresh a country's roster and rank snapshots from osu! rankings.
- `refresh_user_top_scores`: confirm a candidate top play and compute PP gain.
- `reconcile_user_recent_scores`: sync a user's recent scores from the osu! API to fill ingest gaps.
- `refresh_user_maps_farmed_scores`, `refresh_country_maps`, `refresh_global_maps`: maps-farmed aggregation per user, per country, and globally.
- `refresh_qualified_maps`: hourly qualified-maps watch; pulls osu!'s current qualified mania list in one search call and reconciles `/maps` status (promote pending->qualified, index new sets, resolve ranks/dequalifies).
- `seed_snipe_board`: build the initial board for a beatmap/lane.
- `analyze_activity_beatmap`: compute skill vectors for player activity.
- `analyze_beatmap_chart`: unified chart analysis per beatmap at 1.0x (classifier dan verdict, pattern clusters, MinaCalc MSD skillsets) into `beatmap_chart_analysis`.
- `recompute_vibro_sweep`, `recompute_dan_floor_pin_sweep`, `recompute_ln_subtype_sweep`: one-shot boot-seeded sweeps over stored chart analyses (gated by `live_meta` done-keys), patching detector/classifier changes into the corpus without a full `CHART_ANALYSIS_VERSION` re-run (vibro flags in place; floor-pinned dan verdicts and stale 7K LN pattern tags via re-enqueued `analyze_beatmap_chart`).
- `compute_dan_estimate`: dan rating for a beatmap at a rate.
- `compute_player_skills`: Etterna-style skillset ratings from a player's top plays (per-play MinaCalc SSRs at the played rate) into `player_skill_ratings`.
- `osc_backfill`, `osc_country_catchup`: oSC JSON catch-up, global and country-scoped.
- `replay_video_server_render`, `replay_video_export`: server-side render and finalization/upload.

Admin controls are exposed through the frontend at `/admin/live-backend` and backend `/api/admin/*` routes (status, ingest fixtures, roster refresh, pause/resume country, set status/tier, delete country). Be careful with destructive controls.

`/admin/todos` is the owner's private todo list (reminders, bugs found, things left to do), backed by `features/admin-todos.ts` (durable `admin_todos` table, single user, no per-user scoping) over `GET /api/admin/todos` + `POST /api/admin/todos/{create,update,delete,clear-done}`. Frontend server fns in `src/lib/admin-todos.ts` proxy with the shared admin token; the nav entry and page are `canUseAdminFeatures`-gated.

In-house web analytics (`live-backend/src/features/analytics.ts`) replaces PostHog as the primary store: the Vercel `/api/sync` proxy writes every tracked event to `POST /api/analytics/capture` (bearer-token gated, stamped with the Vercel GeoIP country + a bot verdict), plus to PostHog while `VITE_POSTHOG_KEY` is set (kept as a cold archive during the soak; unset the key to end the dual-write). Events land in a separate SQLite file (`ANALYTICS_DATABASE_URL`, default `data/mania-hub-analytics.db`, own WAL) through a 1s-batched writer; retention is self-pruned hourly (`ANALYTICS_RETENTION_DAYS`, default 90). Read side: `GET /api/admin/analytics/monitor` (the `/admin/live-backend` analytics tab, polled at 5s when live), `GET /api/admin/analytics/valley` (the `/valley` villager layer), and a realtime SSE feed `GET /api/admin/analytics/live` authenticated by short-lived tickets from `POST /api/admin/analytics/live-ticket`. The admin server fns fall back to the old PostHog HogQL queries when `LIVE_BACKEND_URL`/`LIVE_ADMIN_TOKEN` are absent.

## Feature Models

### Snipes
Snipes do not require keeping every raw score forever. Each beatmap/lane has a stored board in `country_beatmap_scores` (keyed by country + beatmap + lane + user). A new score is compared to that board; when it overtakes someone the backend writes `snipe_events` and emits an SSE `snipe`. If no board exists yet, `seed_snipe_board` fetches roster users' scores for that beatmap and builds it.

### Top plays
Detected country top plays live in `top_play_events`. When an incoming score is near the player's known top-play threshold, the backend queues `refresh_user_top_scores`, confirms via the osu! API whether it actually entered the player's top plays (confirmation window ~30min), records the PP gain, then emits `top_play`.

### Maps
`refresh_user_maps_farmed_scores` pulls a roster user's top 200 and extracts scores that entered their top plays; `refresh_country_maps` aggregates these into `country_maps_snapshots`, and `refresh_global_maps` rolls countries up into a global snapshot. Refresh progress is tracked in `live_meta` and surfaced via `/api/snapshots/maps-progress`.

The `/maps` browser reads from `map_search_index` (materialized from `beatmap_skill_vectors` + beatmap/set metadata). Status stays fresh via three layers, cheapest first: the event-driven + hourly zero-API reconciler in `map-search.ts` (`buildMapStatusPropagationStatement` / `reconcileMapSearchIndexStatuses`), which only upgrades in-flux -> settled to shield against stale score payloads; and the hourly `refresh_qualified_maps` watch (`features/qualified-maps-watch.ts`), which is the one writer allowed to move a row backwards (qualified -> pending on a dequalify) because the osu! API read is current truth. The watch writes status into `metadata_json.$.status` + the status column (via `persistScoresDisplayMetadata`) and the index, filters to native mania diffs (skips converts), and enqueues `analyze_beatmap_chart` for newly-qualified diffs so they become searchable. `SOURCE_SELECT` excludes sub-0.2* in-flux placeholder diffs (empty "delete upon download"/"~"/"asd" stubs that ride along in pack and loved sets), and `pruneMapSearchPlaceholderRows` clears any already indexed.

### Farm helper
Recommends maps by comparing the subject player's top 200 against a global peer pool at similar PP, using candidates from `country_maps_farmed_scores` across all countries. Per-keymode (4k/7k) weighted PP lives in `farm_helper_user_key_stats`, seeded on first access.

### Activity
Per-day player skill vectors (stream, jack, bracket, LN variants and friends) in `player_activity_*` tables, computed by `analyze_activity_beatmap` jobs. The analysis is versioned (`ACTIVITY_SKILL_ANALYSIS_VERSION`) for cache invalidation.

### Dan estimates
`dan_estimates` caches ratings keyed by a cache version from `live-backend/src/dan/`. Small batches are computed inline at request time; larger requests queue `compute_dan_estimate`. Since cache version 7 the estimates come from the unified chart classifier (`live-backend/src/dan/chart-classifier.ts`, routing 4K RC to LeoBlack Mixed, 4K LN to the in-house kNN, 6K/7K through Sunny interval tables), so 6K and 7K charts are supported.

### Chart analysis
`beatmap_chart_analysis` stores, per beatmap at 1.0x and keyed by `CHART_ANALYSIS_VERSION`, the lean classifier verdict + pattern clusters (`classification_json`) and MinaCalc MSD skillsets (`msd_json`), plus extracted columns (`key_count`, `primary_label`, `primary_family`, `raw_dan`, `msd_overall`) for SQL consumers. Jobs enqueue alongside activity skill analysis for every newly seen beatmap; `POST /api/admin/chart-analysis/backfill?limit=N` sweeps already-cached `.osu` files with no row at the current version (no osu! API cost). The admin page's one-click run (`/api/admin/chart-analysis/{start,cancel}`) drives a self-chaining runner that keeps the analysis queue topped up until the whole cache is covered; pace is set by the chart-analysis worker lane (`CHART_ANALYSIS_LANE_INTERVAL_MS`, default 500ms per chart). Chart analysis runs even when `ENABLE_OSU_API_JOBS` is off (it only skips the `.osu` network fallback then). A backfill computed on one machine can seed another DB: `npm run export:chart-analysis` -> gzip/scp -> `npm run import:chart-analysis:dist -- <file>` (idempotent, existing rows win, schedules a full map search index rebuild afterwards). The LeoBlack engines and MinaCalc wasm live in `live-backend/vendor/leoblack` (a copy of `src/lib/leoblack`; keep the two trees plus the facade ports in `live-backend/src/dan/` in sync when the frontend classifier changes).

### Profiles and rankings
`player-profiles.ts` caches a best-200 snapshot for 24h (projected forward by top-play events) and profile sections (about, recent) for ~2 minutes. `global-rankings.ts` serves a snapshot built from the union of every tracked country's roster (`country_rosters` joined with `users`, limited to tracked, ranked members with non-null pp), ordered by mania pp, with 7-day deltas from `rank-snapshots.ts`.

### Goals
Logged-in players set targets stored in `user_goals` (kinds `reach_pp`, `play_pp`, `play_pp_count`, `accuracy`, `pass`, `grade`, `fc`, `reach_rank`), always owned by the osu!-verified viewer id. Play-shaped goals auto-complete the moment ingest sees a matching play (`evaluateScoreGoals`, guarded so a goals bug cannot drop a score); total-pp goals settle on top-play confirmation (`evaluatePpGoals`) and reconcile lazily on read. A `live_meta` marker (`user_goals_changed_at`) plus a negative cache keep the ingest hot path cheap. Completion emits SSE `goal_completed`. Served by `/api/goals`, `/api/goals/create`, `/api/goals/delete` (admin-token-bridged); frontend route `/goals`.

### My Data
`my-data.ts` powers a signed-in player's personal dashboard (frontend route `/my-data`). `getMyDataSummary` aggregates cross-cutting stats that are not on an osu! profile (personal records, a country-timezone-bucketed play-rhythm clock, a mods fingerprint, key/card/goal counts) behind a 30s per-user cache; `getUserTrackedFeed` is a user-scoped tracker feed over `player_activity_score_refs` joined to `score_events`; `getUserTopPlaysFeed` reads the player's durable `top_play_events`. It adds no table of its own. Endpoints `/api/my-data/{summary,dashboard,feed,top-plays,skills}` (admin-token-bridged).

`player-skills.ts` backs the dashboard's "Skill rating" card: per-play MinaCalc SSRs over the player's cached top plays (profile snapshot plus top-play-event projection), computed at the play's music rate (DT/NC 1.5x, HT/DC 0.75x, custom `speed_change` skipped) with the play's accuracy as the score goal, aggregated per keymode with Etterna's erfc rating aggregation into `player_skill_ratings` (keyed by `PLAYER_SKILLS_VERSION`; per-play SSRs cached in `plays_json` so recomputes only run the calc for new plays). Each mode also carries per-pattern ratings (Overall SSRs aggregated over the charts' chart-analysis pattern tags, min 3 plays per tag) - the 4K card shows the native MSD skillsets plus the LN pattern axis (Etterna's taxonomy has no LN skillset), 6K/7K show these pattern axes since MinaCalc's skillset names are 4K vocabulary. Converts (non-Mode-3 `.osu`) and non-4/6/7K charts are skipped. The read path (`getPlayerSkillBreakdown`) enqueues `compute_player_skills` when the row is missing, older than 12h, has pending plays after 30min, or a newer `top_play_events` row landed; like chart analysis it runs with `ENABLE_OSU_API_JOBS` off, only skipping the `.osu`/profile network fallbacks then.

### Pack wallets
`pack-wallets.ts` persists the synced maniacard "pack" economy backing `/packs`. `pack_wallets` holds per-user economy state (shards, charges, opened packs) behind a `rev` optimistic-concurrency guard (`savePackWallet`); `pack_collection_cards` holds owned player cards. Legacy card blobs are imported into rows then stripped from the stored payload; recycling duplicate or whole cards mints shards by tier value. Endpoints: `/api/packs/warm` (public, prefetches drawn cards' profile snapshots), `/api/pack-wallet/{id}` (GET/POST wallet sync, 4MB body limit), `/api/pack-collection/{id}` (GET list, POST recycle).

### Discord bot
`live-backend/src/discord/` is an HTTP-interactions bot (maniabot): slash commands with autocomplete, message components, per-channel subscription feeds (top plays, snipes, new farm maps), and osu! account linking. Feeds post only from the serving process via `app.events.subscribe(app.discord.feedSink)` (`server.ts`). Gated by `ENABLE_DISCORD_BOT` (default off) and `ENABLE_DISCORD_FEEDS` (default on), with `DISCORD_*` config in `config.ts`. HTTP: `/api/discord/interactions` (Ed25519 signature-verified, ahead of the public rate gate), `/api/discord/info` (public, cached 60s), and `/api/admin/discord/{status,register-commands,register-emojis,guilds,remove-subscription}`. Frontend: `/discord` (command showcase) and `/admin/discord`.

Replies are Components V2 (`components.ts` converts the embed shape into containers/sections/galleries at the REST layer) and lean on **custom application emojis** for the osu! grade pills and mod icons (`emojis.ts`). The emoji PNGs are built from the in-app SVGs by `scripts/build-discord-emojis.mjs` into `public/images/discord/emojis/`, uploaded once via the admin "Register emojis" action (which fetches them from the frontend origin and stores the name->id map in `discord_emojis`), and referenced inline as `<:name:id>`. Every render helper falls back to plain text (`` `X` ``, `+HDDT`) when an emoji is not registered, so the bot reads exactly as before until the assets are uploaded. Single-score surfaces (`/pb`, `/recent`'s latest play, the top-play and snipe feeds) render a detailed card: grade + mods, stars/keys, accuracy/combo/score, judgement breakdown and pp. Keep embeds free of decorative unicode emoji (enforced by `discord-embeds.test.ts`); the custom-emoji references are ASCII and exempt.

## HTTP Surface

`/healthz` and `/readyz` are open. Public endpoints: `/api/status`, `/api/countries/features`, `/api/countries/activate`, `/api/snapshots/*` (tracker, top-plays, snipes, maps, maps-page, maps-progress, maps-set, maps-players, rankings, global-rankings, farm-helper, farm-helper-farmers, rank-deltas), `/api/profiles/{user}/{section}` (section is one of snapshot, cached-snapshot, about, recent, activity, activity-day, activity-availability), `/api/dan-estimates`, `/api/audio`, `/api/packs/warm`, `/api/events` (country-activating event-log replay since `?since=`), `/api/discord/info`, `/api/replay-video-job`, and the SSE stream at `/api/live?country=XX`. `/api/discord/interactions` is public but Ed25519 signature-verified (it sits ahead of the public rate gate).

A class of per-user endpoints is gated by `LIVE_ADMIN_TOKEN` but lives outside `/api/admin/*`: the frontend server fn injects the shared token plus the osu!-verified viewer id (so a user only ever touches their own data). These are goals (`/api/goals`, `/api/goals/create`, `/api/goals/delete`), my-data (`/api/my-data/{summary,dashboard,feed,top-plays}`), roster self opt-in/out (`/api/roster/self-add`, `/api/roster/self-remove`), and pack wallet/collection (`/api/pack-wallet/{id}`, `/api/pack-collection/{id}`). The osu! API proxies `/api/osu/v2` and `/api/osu/beatmap-file` are also `LIVE_ADMIN_TOKEN`-gated and called server-to-server (not from browsers). Admin Discord controls live under `/api/admin/discord/*`.

All public endpoints are rate-limited per IP by `abuse-guard.ts` with separate buckets (general, costly, dan estimates, country activation with per-IP/global/new-country sub-limits, SSE connections with per-IP and total caps, replay video jobs). CORS allows origins from `ALLOWED_ORIGINS`. `/api/admin/*` requires `LIVE_ADMIN_TOKEN`.

## Replay Video Export

The whole feature is gated by `ENABLE_REPLAY_VIDEO` (default `false`; on only in the owner's local env). When off, `/api/replay-video-job` returns 404, the replay-video worker lanes are not registered, and playwright-core is never imported (it is a dynamic import inside the render function).

Two paths, both finishing in the backend queue:

1. Browser render: WebCodecs encodes the MP4 client-side, then the frontend calls `/api/replay-video-job` (`start` -> `upload-video` -> `finish`).
2. Server render: the backend queues `replay_video_server_render`, which drives headless Chrome (playwright-core) against the frontend to render the video.

Either way, `replay_video_export` finalizes: optional ffmpeg audio mux and optimization, upload to R2 (or local path), status in `replay_video_exports`, polled by the frontend via `action=status`. `scripts/dev/replay-video-job.ts` is a local Vite middleware fallback when no live backend URL is configured.

## Retention and Storage

The backend uses LibSQL/SQLite (default `live-backend/data/mania-hub-live.db`, WAL mode); `DATABASE_URL` may point to a file or remote. `live-backend/src/retention.ts` runs hourly. Defaults (configurable): `score_events` 14d, `live_event_log` 7d, done `jobs` 2d, `api_call_log` 7d, finished `replay_video_exports` 2d plus temp dir cleanup, rank snapshots 14d, player activity 2y. Two further tables are pruned on fixed (non-configurable) cutoffs every tick: `beatmap_osu_files` 90d (cached .osu files) and `discord_channel_map_context` 30d (Discord recent-map memory). The DB size is capped (~10GB max; over the cap triggers compaction toward ~8GB).

Durable projections (`country_beatmap_scores`, `snipe_events`, `top_play_events`, `user_top_scores`, maps snapshots, users, beatmaps, beatmapsets, rosters) are not part of the short raw-event cleanup.

Caching lives where each resource lives. osu! API responses: cached in the backend's `/api/osu/v2` proxy (`osu_proxy_cache` table, `features/osu-proxy-cache.ts`), opt-in per call via `cacheTtlMs`/`staleMs` on `osuFetch`; the proxy also collapses concurrent identical fetches in-process and serves expired rows through upstream failures within `staleMs` (the old 6h stale-profile behavior). Computed artifacts (parsed replays, uploaded-replay descriptions): gzipped JSON objects in R2 via `getJsonArtifact`/`putJsonArtifact`. The `getPersistentCache*`/`fetchWithCacheLock` helpers in `src/lib/api.ts` kept their signatures but are a per-instance memory tier + in-flight dedup only; there is no shared frontend KV. R2 objects are managed by `src/lib/r2-cache.ts` (replay endpoint kind rides on S3 object metadata; size is bounded by per-prefix Cloudflare lifecycle rules, never by code).

## Frontend Data Rules

Prefer `src/lib/live-backend.ts` for live backend calls from client routes: typed snapshot fetchers, `openLiveEventSource()` for SSE, and the country feature-tier bootstrap. Home, Tracker, Top Plays, Snipes, and Maps hard-require the live backend (no `VITE_LIVE_BACKEND_URL` renders a `LiveBackendRequired` notice; the osu!-API fallback scans were deleted). Server functions remain only for data the backend does not project: user profiles/scores, rank histories, per-beatmap country scoreboards (replay browse), beatmap search/files, dan estimates, OG cards. When an SSE connection drops, the browser's `EventSource` reconnects and replays missed events via `Last-Event-ID` against `live_event_log`; there is no polling fallback (`/api/sync` is unrelated, it is the analytics capture proxy).

Keep authenticated osu! API access on the server. Do not put osu! credentials or direct authenticated osu! calls in client components. `src/lib/osu.ts` is a facade over domain modules in `src/lib/osu/`.

Client state uses Zustand in `src/store.ts`, persisted to localStorage under `mania-hub-cache-v5`; bump the version on breaking shape changes. Data is country-keyed with `fetchedAt` plus TTL checks from `src/lib/cache.ts`. Persistence is debounced with quota-eviction handling; critical preferences (theme, hidden users, avatar accents) live in separate storage keys so they survive quota errors. Check `useHasHydrated()` before trusting persisted state during SSR hydration.

OG images are rendered by `src/routes/api/og.ts` (@vercel/og) and cached in R2 keyed by the `OG_IMAGE_VERSION` constant defined in `src/lib/seo.ts`; bump it there when changing OG layouts. Meta and OG URL builders also live in `src/lib/seo.ts`; the sitemap is `src/routes/api/sitemap.ts`.

## Coding Style

Use TypeScript, React function components, two-space indentation, semicolons, and named exports where local style uses them. Prefer existing helpers and patterns over parallel abstractions.

Use `#/*` or `@/*` path aliases for imports from `src/*`; match the nearby style. The backend uses relative imports inside `live-backend/src`.

Styling uses Tailwind CSS v4 through `@tailwindcss/vite`, with global styles and theme CSS variables in `src/styles.css`. The theme is hue/saturation custom properties applied before hydration; a custom `hover` variant avoids stuck hover states on touch devices. Animations use `framer-motion`. Replay rendering uses canvas/Pixi modules. 3D card code uses Three.js helpers under `src/components/player/maniacard3d/`.

Replay-related logic is split across parser, validation, score input, skin, navigation, scroll speed, judgement, beatmap parsing, canvas rendering, and video export modules; keep changes scoped to the right module. Stable/lazer score differences matter; use existing score utilities rather than duplicating normalization.

Dan and LN dan classification must stay algorithmic. Do not add title, artist, creator, beatmap ID, beatmapset ID, filename, or chart-specific identity shortcuts to force results.

Backend logs are structured JSON via `live-backend/src/logger.ts` (`logInfo`/`logWarn`); use it instead of `console.log`.

## Testing Guidance

Vitest is the test runner. Tests live beside source files as `*.test.ts` or `*.test.tsx`, plus the `-`-prefixed files at the top of `src/routes/`.

For live backend changes, run at least `cd live-backend && npm test` and `npx tsc --noEmit` (or `npm run verify`). For frontend type-sensitive changes, run `npx tsc --noEmit` at the root.

## Security and Config

Local secrets belong in `.env` and `live-backend/.env`; do not commit secrets.

Important env vars:

- Root/frontend: `VITE_LIVE_BACKEND_URL`, `LIVE_BACKEND_URL`, `LIVE_ADMIN_TOKEN`, R2 vars, PostHog vars.
- Live backend (`live-backend/src/config.ts` holds the full ~90-var list with defaults): `PORT`, `DATABASE_URL`, `OSU_CLIENT_ID`, `OSU_CLIENT_SECRET`, `OSC_BASE_URL`, `OSC_SOCKET_PATH`, `TRACKED_COUNTRIES`, `LIVE_PUBLIC_ORIGIN`, `ALLOWED_ORIGINS`, `LIVE_ADMIN_TOKEN`, `LIVE_BACKEND_ROLE` (`all`/`server`/`worker`, alias `BACKEND_ROLE`) for the opt-in two-process split (with `ENABLE_EVENT_LOG_TAIL`, `WORKER_HTTP_PORT`, and `SQLITE_*` connection-pragma tuning), feature flags (`ENABLE_WORKERS`, `ENABLE_OSC_SOCKET`, `ENABLE_OSC_BACKFILL`, `ENABLE_OSU_SCORES_FALLBACK`, `ENABLE_SCHEDULED_REFRESHES`), Discord (`ENABLE_DISCORD_BOT`, `ENABLE_DISCORD_FEEDS`, `DISCORD_APPLICATION_ID`, `DISCORD_PUBLIC_KEY`, `DISCORD_BOT_TOKEN`, plus new-farm-map alert thresholds), osu/oSC rate settings, retention settings, roster settings, replay video settings (R2, ffmpeg, Chrome path).

The live backend defaults to local SQLite at `live-backend/data/mania-hub-live.db`. For production/VPS, configure durable storage and `LIVE_ADMIN_TOKEN`.

The osu! API budget is enforced by a token-bucket client in `live-backend/src/osu/client.ts` (~45/min target, 60/min hard limit), with calls logged to `api_call_log`. Route new osu! API calls through this client. Public backend endpoints are already rate-limited per IP via the abuse guard.
