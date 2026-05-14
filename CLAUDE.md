# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

See `AGENTS.md` for the full repository guide. This file highlights the points most important for day-to-day work.

## What This Is

Mania Hub (mania-tracker.com) is an osu!mania community site with two cooperating parts:

- **Frontend** (`src/`): TanStack Start + Vite + React 19, deployed via Vercel/Nitro. File-based routes in `src/routes/`, generated `src/routeTree.gen.ts` (do not hand-edit).
- **Live backend** (`live-backend/`): Always-on Node service that ingests osu! scores from Kayla's oSC Socket.IO feed, maintains durable SQLite projections, runs a DB-backed job queue, and streams updates to browsers via SSE.

Product is country-scoped (default `CR`). Core surfaces: rankings, live tracker, top plays, maps, snipes, replay viewer, player profiles, admin.

## Commands

Do not run dev servers, root tests, or builds during normal work unless the user asks; the user typically keeps servers running locally. If asked: frontend on port `3000`, live backend on port `7227`.

- Frontend dev: `npm run dev`
- Frontend tests: `npm run test` (Vitest)
- Frontend typecheck: `npx tsc --noEmit`
- Live backend dev: `cd live-backend && npm run dev`
- Live backend tests: `cd live-backend && npm test`
- Live backend typecheck: `cd live-backend && npx tsc --noEmit`
- Combined backend verify: `cd live-backend && npm run verify`
- oSC smoke test: `cd live-backend && npm run smoke:osc`
- Run a single test: `npx vitest run path/to/file.test.ts` (or `-t "name"` for a specific case)

For live backend changes, at minimum run `npm test` and `npx tsc --noEmit` inside `live-backend/`. For type-sensitive frontend changes, run `npx tsc --noEmit` at the root.

## Architecture: Live Data Flow

The live backend is the source of truth for Tracker, Top Plays, and Snipes when `VITE_LIVE_BACKEND_URL` is set.

1. Backend subscribes to Kayla's oSC Socket.IO, filters to mania + tracked countries.
2. Country detection uses `country_rosters` plus enriched user data (oSC payloads do not include country).
3. Raw scores land in `score_events`; durable projections update `country_beatmap_scores`, `top_play_events`, `snipe_events`, tracker rows.
4. Backend emits SSE events to browsers. Browsers fetch a snapshot on entry, then subscribe to SSE for deltas. SSE is one-way; browsers never talk to oSC.

Key files:
- `live-backend/src/server.ts` - boot, worker, retention, oSC backfill/socket
- `live-backend/src/http/snapshots.ts` - REST snapshots, admin, replay-video endpoints
- `live-backend/src/ingest/score-ingestor.ts` - oSC ingest and projection fanout
- `live-backend/src/jobs/queue.ts` + `workers.ts` - job queue and handlers
- `live-backend/src/features/{tracker,top-plays,snipes}/*`
- `live-backend/migrations/001_initial.sql` - schema

### Snipes model
Snipes do not require keeping every raw score forever. Each beatmap/lane has a stored board in `country_beatmap_scores`; a new score is compared to that board, and when it overtakes someone the backend writes `snipe_events` and emits an SSE `snipe`. If no board exists yet, the backend queues `seed_snipe_board`, fetches roster users' scores for that beatmap, and builds the initial board.

### Top plays model
Detected country top plays live in `top_play_events`. When an incoming score is near the player's known top-play threshold, the backend queues `refresh_user_top_scores`, confirms via osu! API whether it actually entered the player's top plays, then emits `top_play`. Old Turso `country_top_plays` may be imported for history; new detection happens in the backend queue.

### Replay video export
WebCodecs encodes MP4 in the browser, then frontend calls live backend `/api/replay-video-job` (`start` -> `upload-video` -> `finish`). Backend queues `replay_video_export`, optionally muxes audio via ffmpeg, uploads to R2, and the frontend polls `action=status`. `scripts/dev/replay-video-job.ts` is a local Vite middleware fallback when no live backend URL is configured.

### Retention
`live-backend/src/retention.ts` runs hourly. Defaults: `score_events` 14d, `live_event_log` 7d, completed `jobs` 2d, `api_call_log` 7d, completed/failed/cancelled `replay_video_exports` 2d. Durable projections (`country_beatmap_scores`, `snipe_events`, `top_play_events`, users, beatmaps, rosters) are not part of this cleanup. Older Turso cache uses `cache_entries` with TTLs; R2/replay asset metadata is in `src/lib/r2-cache.ts`.

## Frontend Data Rules

- Prefer `src/lib/live-backend.ts` for live calls from client routes. Tracker/Top Plays/Snipes should use live snapshots + SSE when configured, with old server-function/Turso behaviour only as fallback.
- Keep authenticated osu! API access on the server. Never put osu! credentials or direct authenticated osu! calls in client components.
- Client state lives in `src/store.ts` (Zustand), typically gated by `fetchedAt` + TTL checks from `src/lib/cache.ts`.
- Maps data uses persistent cache TTLs (farmed/favourites weekly). Rebuilds are visit-triggered/stale-while-revalidate, not a true cron.

## Coding Conventions

- TypeScript, React function components, two-space indent, semicolons, named exports where local style uses them.
- Frontend imports use `#/*` or `@/*` path aliases for `src/*`; match nearby style. Backend uses relative imports inside `live-backend/src`.
- Styling: Tailwind v4 via `@tailwindcss/vite`, globals in `src/styles.css`. Animations via `framer-motion`. Replay rendering uses canvas/Pixi modules. 3D card code under `src/components/player/maniacard3d/` uses Three.js.
- Replay logic is split across parser, validation, score input, skin, navigation, scroll speed, judgement, beatmap parsing, canvas rendering, and video export modules. Stable vs lazer scoring differs; reuse existing score utilities rather than re-normalising.
- **Dan and LN dan classification must stay algorithmic.** Do not add title/artist/creator/beatmap-id/beatmapset-id/filename or any chart-identity shortcuts to force results.

## Tests

Vitest. Tests live beside source as `*.test.ts` / `*.test.tsx`. The frontend `src/routes/` directory contains several top-level test files prefixed with `-` (e.g. `-replay-stable-scoring.test.ts`) that aren't routes; do not delete them assuming they're stale.

## Config and Secrets

Local secrets go in `.env` (root) and `live-backend/.env`. Important vars:

- Root/frontend: `VITE_LIVE_BACKEND_URL`, `LIVE_BACKEND_URL`, `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, R2 vars, PostHog vars.
- Live backend: `PORT`, `DATABASE_URL`, `OSU_CLIENT_ID`, `OSU_CLIENT_SECRET`, `OSC_BASE_URL`, `OSC_SOCKET_PATH`, `TRACKED_COUNTRIES`, `LIVE_PUBLIC_ORIGIN`, `ALLOWED_ORIGINS`, `LIVE_ADMIN_TOKEN`, osu/oSC rate settings, retention settings, roster settings, replay video R2 vars.

Live backend defaults to local SQLite at `live-backend/data/mania-hub-live.db`. Production needs durable storage plus `LIVE_ADMIN_TOKEN`. Admin endpoints sit under `/admin/live-backend` and backend `/api/admin/*`; reset-local-db and similar controls are destructive, treat with care.

osu! API is ~60 calls/minute. Browser readers of our backend are not subject to that limit, but app-level per-IP throttling for snapshots/SSE/replay uploads should be added before any wider public launch.
