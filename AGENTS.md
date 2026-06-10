# Repository Guidelines

## What This Is

Mania Hub (mania-tracker.com) is an osu!mania community site with two cooperating parts:

- A TanStack Start + Vite React 19 app in `src/`, SSR via Nitro (Vercel target).
- An always-on live backend in `live-backend/` that listens to Kayla's oSC score feed, keeps durable SQLite projections warm, runs a DB-backed job queue, and streams updates to the frontend over SSE.

Surfaces: rankings (country + global), live tracker, top plays, maps, snipes, farm helper, replay viewer with video export, player profiles (about, recent, activity, maniacard), settings, and admin dashboards.

Countries are dynamic. The backend keeps a `country_registry` with per-country status (cold -> warm -> active, pausable) and a feature tier (`indexed`, `maps_warm`, `live`, `snipes`) that gates which projections run. Visiting a cold country can activate it (rate-limited). A synthetic `GLOBAL` scope aggregates all tracked countries. Default/home country is `CR`.

## Project Structure

Frontend source lives in `src/`:

- `src/routes/`: file-based routes. Shared shell, auth, country context, theme bootstrap, and live-backend bootstrap live in `src/routes/__root.tsx`. API routes in `src/routes/api/` (OG images, sitemap, audio/avatar/background proxies, replay upload, osu! OAuth, sync polling fallback). Admin pages in `src/routes/admin/`. Files prefixed with `-` are tests, not routes. Do not hand-edit generated `src/routeTree.gen.ts`.
- `src/components/`: shared UI in feature folders (`layout/`, `home/`, `player/`, `replay/`, `maps/`, `settings/`, `ui/`).
- `src/store.ts`: the Zustand client store.
- `src/lib/`: server/data utilities, the osu! API layer, replay modules, dan estimator.

The live backend lives in `live-backend/`:

- `live-backend/src/server.ts`: boot. Connects the DB, applies migrations, then conditionally starts workers, schedulers, the oSC socket (with watchdog), oSC backfill, the osu! recent-scores fallback poller, retention, and the HTTP server on port 7227.
- `live-backend/src/ingest/score-ingestor.ts`: score ingestion and projection fanout.
- `live-backend/src/osc/`: oSC Socket.IO client, JSON backfill, and the osu! API scores fallback poller.
- `live-backend/src/jobs/queue.ts` and `live-backend/src/workers.ts`: job queue and worker lanes.
- `live-backend/src/features/`: one module per surface (tracker, top-plays, snipes, maps, farm-helper, farm-helper-key-stats, activity, dan-estimates, global-rankings, rank-snapshots, player-profiles).
- `live-backend/src/http/snapshots.ts`: REST snapshots, profile endpoints, admin controls, replay video job endpoints. `live-backend/src/http/abuse-guard.ts`: per-IP rate limiting.
- `live-backend/src/live/`: SSE handler, event log with replay buffer, per-country client tracking.
- `live-backend/src/replay-video/`: server-side rendering (headless Chrome), finalization, R2 upload.
- `live-backend/src/dan/`: backend copy of the dan estimator. `live-backend/src/audio/`: beatmap archive download and audio streaming.
- `live-backend/src/maintenance/`: storage compaction scripts.
- `live-backend/migrations/001_initial.sql`: schema, applied at boot.

Legacy/shared Turso schema is in `db/schema.sql`. Utility scripts live in `scripts/` (dan benchmark/analyze, replay capture/validate, cache migrations, plus `scripts/dev/replay-video-job.ts`, the Vite dev middleware fallback for replay video). Static assets live in `public/`.

## Development Commands

The user often keeps local servers running; do not start dev servers or builds unprompted. If asked: frontend is `3000`, live backend is `7227`.

- Frontend dev: `npm run dev`. Build: `npm run build`. Tests: `npm run test`. Typecheck: `npx tsc --noEmit`.
- Single test: `npx vitest run path/to/file.test.ts` (add `-t "name"` for one case).
- Live backend dev: `cd live-backend && npm run dev`. Tests: `npm test`. Typecheck: `npx tsc --noEmit`. Tests + build: `npm run verify`.
- oSC smoke: `cd live-backend && npm run smoke:osc`.
- Backend DB compaction: `cd live-backend && npm run compact:storage` (full VACUUM/GC) or `npm run compact:maps-farmed` (rebuild maps-farmed overlay).
- Dan tooling: `npm run dan:benchmark`, `npm run dan:analyze`.
- Old Turso schema init/shell: `npm run db:init`, `npm run db:inspect`.

## Live Backend Architecture

The live backend is the source of truth for live surfaces when `VITE_LIVE_BACKEND_URL` is configured. Browsers fetch a snapshot on page entry, then subscribe to SSE for deltas. SSE is one-way backend-to-browser; users never connect to oSC directly.

Ingest flow:

1. Scores arrive from three sources: the oSC Socket.IO feed (real-time), oSC JSON backfill (catch-up after downtime), and an osu! API recent-scores fallback poller (safety net, own rate bucket).
2. Scores are filtered to mania. Country detection uses `country_rosters` plus enriched user data, because oSC payloads do not include country.
3. Raw rows land in `score_events`; user/beatmap/beatmapset metadata is upserted; projections and follow-up jobs fan out according to the country's feature tier.
4. The backend emits SSE events (`tracker_score`, `top_play`, `snipe`, `maps_farmed_update`, `job_status`, `status`, heartbeats). Reconnecting clients replay missed events via `Last-Event-ID` against `live_event_log`.

Rosters are warmed from osu! mania performance rankings on a schedule; roster refreshes also capture `country_rank_snapshots` used for 7-day rank deltas.

## Queue and Jobs

The queue lives in the `jobs` table with priority, dedupe keys, and per-type backoff. Under load it sheds pressure: low-priority job types are auto-deferred (`deferred_pressure`) when queue depth is high and wake when it drains. Workers run in dedicated lanes (fast enrichment, osc-backfill, osc-country-catchup, maps-refresh, dan-estimates, activity-analysis, snipe-seed, replay-video render and finalize).

Job types:

- `enrich_user`, `enrich_beatmap`: fetch full metadata from the osu! API.
- `refresh_country_roster`: refresh a country's roster and rank snapshots from osu! rankings.
- `refresh_user_top_scores`: confirm a candidate top play and compute PP gain.
- `reconcile_user_recent_scores`: sync a user's recent scores from the osu! API to fill ingest gaps.
- `refresh_user_maps_farmed_scores`, `refresh_country_maps`, `refresh_global_maps`: maps-farmed aggregation per user, per country, and globally.
- `seed_snipe_board`: build the initial board for a beatmap/lane.
- `analyze_activity_beatmap`: compute skill vectors for player activity.
- `compute_dan_estimate`: dan rating for a beatmap at a rate.
- `osc_backfill`, `osc_country_catchup`: oSC JSON catch-up, global and country-scoped.
- `replay_video_server_render`, `replay_video_export`: server-side render and finalization/upload.

Admin controls are exposed through the frontend at `/admin/live-backend` and backend `/api/admin/*` routes (status, ingest fixtures, roster refresh, pause/resume country, set status/tier, delete country). Be careful with destructive controls.

## Feature Models

### Snipes
Snipes do not require keeping every raw score forever. Each beatmap/lane has a stored board in `country_beatmap_scores` (keyed by country + beatmap + lane + user). A new score is compared to that board; when it overtakes someone the backend writes `snipe_events` and emits an SSE `snipe`. If no board exists yet, `seed_snipe_board` fetches roster users' scores for that beatmap and builds it.

### Top plays
Detected country top plays live in `top_play_events`. When an incoming score is near the player's known top-play threshold, the backend queues `refresh_user_top_scores`, confirms via the osu! API whether it actually entered the player's top plays (confirmation window ~30min), records the PP gain, then emits `top_play`. Old Turso `country_top_plays` may be imported for history; new detection happens in the backend queue.

### Maps
`refresh_user_maps_farmed_scores` pulls a roster user's top 200 and extracts scores that entered their top plays; `refresh_country_maps` aggregates these into `country_maps_snapshots`, and `refresh_global_maps` rolls countries up into a global snapshot. Refresh progress is tracked in `live_meta` and surfaced via `/api/snapshots/maps-progress`.

### Farm helper
Recommends maps by comparing the subject player's top 200 against a global peer pool at similar PP, using candidates from `country_maps_farmed_scores` across all countries. Per-keymode (4k/7k) weighted PP lives in `farm_helper_user_key_stats`, seeded on first access.

### Activity
Per-day player skill vectors (stream, jack, bracket, LN variants and friends) in `player_activity_*` tables, computed by `analyze_activity_beatmap` jobs. The analysis is versioned (`ACTIVITY_SKILL_ANALYSIS_VERSION`) for cache invalidation.

### Dan estimates
`dan_estimates` caches ratings keyed by a cache version from `live-backend/src/dan/`. Small batches are computed inline at request time; larger requests queue `compute_dan_estimate`.

### Profiles and rankings
`player-profiles.ts` caches a best-100 snapshot for 24h (projected forward by top-play events) and profile sections (about, recent) for ~2 minutes. `global-rankings.ts` serves a global snapshot from the `users` table with 7-day deltas from `rank-snapshots.ts`.

## HTTP Surface

`/healthz` and `/readyz` are open. Public endpoints: `/api/status`, `/api/countries/features`, `/api/countries/activate`, `/api/snapshots/*` (tracker, top-plays, snipes, maps, maps-page, maps-progress, maps-set, maps-players, global-rankings, farm-helper, farm-helper-farmers, rank-deltas), `/api/profile/*` (snapshot, cached, about, recent, activity), `/api/dan-estimates`, `/api/audio`, `/api/osu/beatmap-file`, `/api/replay-video-job`, and the SSE stream at `/api/live?country=XX`.

All public endpoints are rate-limited per IP by `abuse-guard.ts` with separate buckets (general, costly, dan estimates, country activation, SSE connections with per-IP and total caps, replay video jobs). CORS allows origins from `ALLOWED_ORIGINS`. `/api/admin/*` requires `LIVE_ADMIN_TOKEN`.

## Replay Video Export

Two paths, both finishing in the backend queue:

1. Browser render: WebCodecs encodes the MP4 client-side, then the frontend calls `/api/replay-video-job` (`start` -> `upload-video` -> `finish`).
2. Server render: the backend queues `replay_video_server_render`, which drives headless Chrome (playwright-core) against the frontend to render the video.

Either way, `replay_video_export` finalizes: optional ffmpeg audio mux and optimization, upload to R2 (or local path), status in `replay_video_exports`, polled by the frontend via `action=status`. `scripts/dev/replay-video-job.ts` is a local Vite middleware fallback when no live backend URL is configured.

## Retention and Storage

The backend uses LibSQL/SQLite (default `live-backend/data/mania-hub-live.db`, WAL mode); `DATABASE_URL` may point to a file or remote. `live-backend/src/retention.ts` runs hourly. Defaults (configurable): `score_events` 14d, `live_event_log` 7d, done `jobs` 2d, `api_call_log` 7d, finished `replay_video_exports` 2d plus temp dir cleanup, rank snapshots 14d, player activity 2y. The DB size is capped (~10GB max; over the cap triggers compaction toward ~8GB).

Durable projections (`country_beatmap_scores`, `snipe_events`, `top_play_events`, `user_top_scores`, maps snapshots, users, beatmaps, beatmapsets, rosters) are not part of the short raw-event cleanup.

The older Turso cache uses `cache_entries` with TTLs and cache locks. R2/replay/beatmap asset metadata is handled by `src/lib/r2-cache.ts`.

## Frontend Data Rules

Prefer `src/lib/live-backend.ts` for live backend calls from client routes: typed snapshot fetchers, `openLiveEventSource()` for SSE, and the country feature-tier bootstrap. Tracker, Top Plays, Snipes, Maps, and rankings should use live snapshots + SSE when configured, with old server-function/Turso behavior only as fallback. A polling endpoint (`/api/sync`) backs up SSE when it is unavailable.

Keep authenticated osu! API access on the server. Do not put osu! credentials or direct authenticated osu! calls in client components. `src/lib/osu.ts` is a facade over domain modules in `src/lib/osu/`.

Client state uses Zustand in `src/store.ts`, persisted to localStorage under `mania-hub-cache-v5`; bump the version on breaking shape changes. Data is country-keyed with `fetchedAt` plus TTL checks from `src/lib/cache.ts`. Persistence is debounced with quota-eviction handling; critical preferences (theme, hidden users, avatar accents) live in separate storage keys so they survive quota errors. Check `useHasHydrated()` before trusting persisted state during SSR hydration.

Maps data uses persistent cache TTLs (farmed and favourites weekly). Rebuilds are visit-triggered/stale-while-revalidate, not a true cron.

OG images are rendered by `src/routes/api/og.ts` (@vercel/og) and cached in R2 behind the `OG_IMAGE_VERSION` constant; bump it when changing OG layouts. Meta and OG URL builders live in `src/lib/seo.ts`; the sitemap is `src/routes/api/sitemap.ts`.

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

- Root/frontend: `VITE_LIVE_BACKEND_URL`, `LIVE_BACKEND_URL`, `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, R2 vars, PostHog vars.
- Live backend (`live-backend/src/config.ts` holds the full ~70-var list with defaults): `PORT`, `DATABASE_URL`, `OSU_CLIENT_ID`, `OSU_CLIENT_SECRET`, `OSC_BASE_URL`, `OSC_SOCKET_PATH`, `TRACKED_COUNTRIES`, `LIVE_PUBLIC_ORIGIN`, `ALLOWED_ORIGINS`, `LIVE_ADMIN_TOKEN`, feature flags (`ENABLE_WORKERS`, `ENABLE_OSC_SOCKET`, `ENABLE_OSC_BACKFILL`, `ENABLE_OSU_SCORES_FALLBACK`, `ENABLE_SCHEDULED_REFRESHES`), osu/oSC rate settings, retention settings, roster settings, replay video settings (R2, ffmpeg, Chrome path).

The live backend defaults to local SQLite at `live-backend/data/mania-hub-live.db`. For production/VPS, configure durable storage and `LIVE_ADMIN_TOKEN`.

The osu! API budget is enforced by a token-bucket client in `live-backend/src/osu/client.ts` (~45/min target, 60/min hard limit), with calls logged to `api_call_log`. Route new osu! API calls through this client. Public backend endpoints are already rate-limited per IP via the abuse guard.
