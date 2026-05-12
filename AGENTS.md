# Repository Guidelines

## What This Is

Mania Hub is an osu!mania site with two cooperating parts:

- A TanStack Start + Vite React app in `src/`.
- An always-on live backend in `live-backend/` that listens to oSC, keeps local projections warm, runs queued work, and streams updates to the frontend.

The product defaults to Costa Rica but is country-scoped. Core surfaces include rankings, live tracker, top plays, maps, snipes, replay viewer, player profiles, and admin dashboards.

## Project Structure

Frontend source lives in `src/`. File routes are in `src/routes/`, with the shared shell in `src/routes/__root.tsx`. Do not hand-edit generated `src/routeTree.gen.ts`; let TanStack tooling regenerate it.

Shared UI lives in `src/components/`, with feature folders like `layout/`, `player/`, `replay/`, and `ui/`. Client state is in `src/store.ts`. Server/data utilities are in `src/lib/`.

The live backend lives in `live-backend/`. Important areas:

- `live-backend/src/server.ts`: HTTP server boot, worker, retention, oSC backfill/socket.
- `live-backend/src/http/snapshots.ts`: REST snapshots, admin controls, replay video job endpoints.
- `live-backend/src/ingest/score-ingestor.ts`: oSC score ingestion and projection fanout.
- `live-backend/src/jobs/queue.ts` and `live-backend/src/workers.ts`: DB-backed job queue and worker handlers.
- `live-backend/src/features/*`: tracker, top plays, snipes.
- `live-backend/src/replay-video/*`: queued replay video finalization and R2 upload.
- `live-backend/migrations/001_initial.sql`: live backend schema.

Legacy/shared Turso schema is in `db/schema.sql`. Utility scripts live in `scripts/`. Static assets live in `public/`.

## Development Commands

- Frontend: `npm run dev` starts Vite on port `3000`.
- Live backend: `cd live-backend && npm run dev` starts the backend on port `7227` by default.
- Root tests: `npm run test`.
- Root build: `npm run build`.
- Backend tests: `cd live-backend && npm test`.
- Backend typecheck/build: `cd live-backend && npx tsc --noEmit` or `npm run build`.
- oSC smoke: `cd live-backend && npm run smoke:osc`.
- DB init for old Turso schema: `npm run db:init`.
- Turso shell: `npm run db:inspect`.
- Snipes cache reset/migration for old cache paths: `npm run snipes:reset`, `npm run snipes:migrate-cache`.

Do not run dev servers, root tests, or builds during normal work unless the user asks. The user often keeps local servers running. If the user explicitly asks you to run the app locally, frontend is `3000` and live backend is `7227`.

## Live Backend Architecture

The live backend is the source of truth for live Tracker, Top Plays, and Snipes when `VITE_LIVE_BACKEND_URL` is configured.

Flow:

1. Backend connects to Kayla's oSC Socket.IO service and receives recent score batches.
2. It filters to mania and tracked countries.
3. Because oSC scores normally include `user_id` but not user country metadata, country detection relies on `country_rosters` plus any enriched user data.
4. It stores raw recent rows in `score_events`.
5. It updates durable projections such as tracker rows, `country_beatmap_scores`, `top_play_events`, and `snipe_events`.
6. It emits SSE events for browser clients.

The browser still fetches a snapshot on page entry, then subscribes to SSE for changes. SSE is one-way backend-to-browser. Users do not connect to oSC directly.

Default tracked country is `CR`. The backend warms country rosters from osu! mania performance rankings, defaulting to 2 pages / 100 users. Frontend rankings pages do not automatically populate the live backend roster.

## Queue And Jobs

The live backend queue is stored in the `jobs` table. Workers claim queued/failed jobs and mark them done/failed.

Current job types include:

- `refresh_country_roster`
- `enrich_user`
- `enrich_beatmap`
- `refresh_user_top_scores`
- `seed_snipe_board`
- `replay_video_export`

Backoff differs by job type. Top-play confirmation retries sooner; metadata and snipe seeding can wait longer.

Admin controls for local/VPS debugging are exposed through `/admin/live-backend` and backend `/api/admin/*` routes. Be careful with destructive controls such as reset-local-db.

## Snipes Model

The live backend does not need every raw score forever to detect snipes.

- `score_events`: recent raw incoming score audit trail.
- `country_beatmap_scores`: durable current best known score per `country + beatmap + lane + user`.
- `snipe_events`: durable visible snipe history.

When a new score arrives, the backend compares it to the stored board for that beatmap/lane. If the player moves above someone else, it writes a `snipe_events` row and emits an SSE `snipe` event.

If a beatmap/lane has no stored board yet, the backend queues `seed_snipe_board`, fetches scores for tracked roster users on that beatmap, and builds the initial board.

## Top Plays Model

The live backend stores detected country top plays in `top_play_events`. When a score is near a player's known top-play threshold, the backend queues `refresh_user_top_scores`, fetches that user's best scores from osu!, confirms whether the incoming score is actually in their top plays, then emits a `top_play` event.

Old Turso `country_top_plays` rows may be imported into `top_play_events` for historical display, but new live detection should happen in the backend queue.

## Replay Video Export

Replay video export now uses the live backend when `VITE_LIVE_BACKEND_URL` is set.

Current flow:

1. Browser renders/encodes the MP4 with WebCodecs.
2. Frontend calls live backend `/api/replay-video-job?action=start`.
3. Browser uploads the MP4 with `action=upload-video`.
4. Frontend calls `action=finish`.
5. Backend queues `replay_video_export`.
6. Worker optionally muxes audio with ffmpeg, uploads to R2, stores the final URL in `replay_video_exports`, and the frontend polls `action=status`.

The old Vite dev middleware in `scripts/dev/replay-video-job.ts` remains a local fallback when no live backend URL is configured.

## Retention And Storage

Live backend cleanup is scheduled by `live-backend/src/retention.ts`, hourly by default.

Default retention:

- `score_events`: 14 days.
- `live_event_log`: 7 days.
- completed `jobs`: 2 days.
- `api_call_log`: 7 days.
- completed/failed/cancelled `replay_video_exports`: 2 days, plus temp work dir cleanup.

Durable projections like `country_beatmap_scores`, `snipe_events`, `top_play_events`, users, beatmaps, beatmapsets, and country rosters are not part of the short raw-event cleanup.

The older Turso cache uses `cache_entries` with TTLs and cache locks. R2/replay/beatmap asset metadata is handled by `src/lib/r2-cache.ts`.

## Frontend Data Rules

Prefer `src/lib/live-backend.ts` for live backend calls from client routes. Tracker, Top Plays, and Snipes should use live snapshots + SSE when configured, with old server-function/Turso behavior only as fallback.

Keep authenticated osu! API access on the server. Do not put osu! credentials or direct authenticated osu! calls in client components.

Client state uses Zustand in `src/store.ts`, usually with `fetchedAt` plus TTL checks from `src/lib/cache.ts`.

Maps data currently uses persistent cache TTLs: farmed and favourites are weekly. Rebuild is visit-triggered/stale-while-revalidate, not a true cron.

## Coding Style

Use TypeScript, React function components, two-space indentation, semicolons, and named exports where local style uses them. Prefer existing helpers and patterns over parallel abstractions.

Use `#/*` or `@/*` path aliases for imports from `src/*`; match the nearby style. Backend uses relative imports inside `live-backend/src`.

Styling uses Tailwind CSS v4 through `@tailwindcss/vite`, with global styles in `src/styles.css`. Animations use `framer-motion`. Replay rendering uses canvas/Pixi-related modules. 3D card code uses Three.js helpers under `src/components/player/maniacard3d/`.

Replay-related logic is split across parser, validation, score input, skin, navigation, scroll speed, judgement, beatmap parsing, canvas rendering, and video export modules. Stable/lazer score differences matter; use existing score utilities rather than duplicating normalization.

Dan and LN dan classification must stay algorithmic. Do not add title, artist, creator, beatmap ID, beatmapset ID, filename, or chart-specific identity shortcuts to force results.

## Testing Guidance

Vitest is the test runner. Tests live beside source files as `*.test.ts` or `*.test.tsx`.

For live backend changes, run at least:

- `cd live-backend && npm test`
- `cd live-backend && npx tsc --noEmit`

For frontend type-sensitive changes, run:

- `npx tsc --noEmit`

Do not run `npm run build` or root `npm run test` unless the user explicitly asks.

## Security And Config

Local secrets belong in `.env` and `live-backend/.env`; do not commit secrets.

Important env vars:

- Root/frontend: `VITE_LIVE_BACKEND_URL`, `LIVE_BACKEND_URL`, `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, R2 vars, PostHog vars.
- Live backend: `PORT`, `DATABASE_URL`, `OSU_CLIENT_ID`, `OSU_CLIENT_SECRET`, `OSC_BASE_URL`, `OSC_SOCKET_PATH`, `TRACKED_COUNTRIES`, `LIVE_PUBLIC_ORIGIN`, `ALLOWED_ORIGINS`, `LIVE_ADMIN_TOKEN`, osu/oSC rate settings, retention settings, roster settings, replay video R2 vars.

The live backend defaults to local SQLite at `live-backend/data/mania-hub-live.db`. For production/VPS, configure durable storage and `LIVE_ADMIN_TOKEN`.

osu! API is rate-limited around 60 calls/minute; users reading from our backend are not subject to that osu! limit. Add app-level per-IP limits before public launch for snapshots, SSE abuse, and replay video uploads.
