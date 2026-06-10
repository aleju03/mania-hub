# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Mania Hub (mania-tracker.com) is an osu!mania community site with two cooperating parts:

- **Frontend** (`src/`): TanStack Start + Vite + React 19, SSR via Nitro (Vercel target). File-based routes in `src/routes/`; `src/routeTree.gen.ts` is generated, do not hand-edit.
- **Live backend** (`live-backend/`): always-on Node service that ingests osu! scores from Kayla's oSC Socket.IO feed, keeps durable SQLite projections, runs a DB-backed job queue, and streams updates to browsers over SSE.

Surfaces: rankings (country + global), live tracker, top plays, maps, snipes, farm helper, replay viewer (with video export), player profiles (about/recent/activity/maniacard), settings, admin dashboards.

Countries are dynamic, not hardcoded: the backend keeps a `country_registry` with per-country status (cold -> warm -> active, can pause) and feature tier (`indexed` / `maps_warm` / `live` / `snipes`). Visiting a cold country can activate it (rate-limited). A synthetic `GLOBAL` scope aggregates all tracked countries. Default/home country is `CR`.

See `AGENTS.md` for the fuller repository guide (endpoint lists, per-feature models, job details); this file is the condensed version.

## Commands

Do not start dev servers or run builds unprompted; the user usually has servers running locally (frontend `3000`, live backend `7227`).

| Task | Command |
| --- | --- |
| Frontend dev | `npm run dev` |
| Frontend tests | `npm run test` |
| Frontend typecheck | `npx tsc --noEmit` |
| Single test file | `npx vitest run path/to/file.test.ts` (add `-t "name"` for one case) |
| Backend dev | `cd live-backend && npm run dev` |
| Backend tests | `cd live-backend && npm test` |
| Backend typecheck | `cd live-backend && npx tsc --noEmit` |
| Backend tests + build | `cd live-backend && npm run verify` |
| oSC smoke test | `cd live-backend && npm run smoke:osc` |
| Backend DB compaction | `cd live-backend && npm run compact:storage` (also `compact:maps-farmed`) |
| Dan benchmark/analyze | `npm run dan:benchmark`, `npm run dan:analyze` |

Minimum verification: for live backend changes run `npm test` and `npx tsc --noEmit` inside `live-backend/`; for type-sensitive frontend changes run `npx tsc --noEmit` at the root.

## Live Backend Architecture

The live backend is the source of truth for live surfaces when `VITE_LIVE_BACKEND_URL` is set. Browsers fetch a snapshot on page entry, then subscribe to SSE (`/api/live?country=XX`) for deltas; SSE is one-way and browsers never talk to oSC. Reconnects replay missed events via `Last-Event-ID` against `live_event_log`.

Ingest flow (`src/ingest/score-ingestor.ts`):
1. Scores arrive from three sources: oSC Socket.IO (`src/osc/client.ts`, real-time), oSC JSON backfill (`src/osc/backfill.ts`, catch-up), and an osu! API recent-scores fallback poller (`src/osc/scores-fallback.ts`).
2. Filter to mania; detect country via `country_rosters` (oSC payloads lack country).
3. Raw rows land in `score_events`; metadata upserts into `users` / `beatmaps` / `beatmapsets`; projections and follow-up jobs fan out per enabled feature tier.

Job queue (`src/jobs/queue.ts` + `src/workers.ts`): jobs table with priority, dedupe keys, per-type backoff, and pressure shedding (low-priority types defer when queue depth is high). Workers run in ~10 dedicated lanes (fast enrichment, osc-backfill, maps-refresh, dan-estimates, activity-analysis, snipe-seed, replay-video render/finalize, ...). Job types include `enrich_user`, `enrich_beatmap`, `refresh_country_roster`, `refresh_user_top_scores`, `reconcile_user_recent_scores`, `refresh_user_maps_farmed_scores`, `refresh_country_maps`, `refresh_global_maps`, `seed_snipe_board`, `analyze_activity_beatmap`, `compute_dan_estimate`, `osc_backfill`, `osc_country_catchup`, `replay_video_server_render`, `replay_video_export`.

Feature modules (`src/features/`), one per surface:
- `tracker.ts`: live score timeline with filters.
- `top-plays.ts`: confirms a candidate score actually entered the player's top plays via osu! API (`refresh_user_top_scores`), records PP gain in `top_play_events`, emits SSE `top_play`.
- `snipes.ts`: per-beatmap/lane boards in `country_beatmap_scores`; an overtake writes `snipe_events` and emits SSE `snipe`; missing boards are seeded by `seed_snipe_board`.
- `maps.ts`: aggregates roster users' farmed scores into `country_maps_snapshots` (plus a global rollup); progress tracked in `live_meta`.
- `farm-helper.ts` + `farm-helper-key-stats.ts`: PP-gain recommendations by comparing a player's top 200 against a global peer pool at similar PP; per-keymode weighted PP in `farm_helper_user_key_stats`.
- `activity.ts`: per-day player skill vectors (stream/jack/LN/etc.) in `player_activity_*` tables, computed by `analyze_activity_beatmap` jobs. Days/sessions are bucketed in the player country's local timezone (`shared/country-timezones.ts`) at read time from `player_activity_score_refs`; stored rows stay keyed by UTC day.
- `dan-estimates.ts`: cached dan ratings (`dan_estimates`), small batches computed inline, larger ones queued. Versioned by `cache-version.ts` under `src/dan/`.
- `global-rankings.ts`, `rank-snapshots.ts`, `player-profiles.ts`: global ranking snapshot, 7-day rank deltas from `country_rank_snapshots`, and cached profile snapshots (best-100 cached 24h, profile sections ~2min).

HTTP (`src/http/snapshots.ts`): snapshot endpoints under `/api/snapshots/*`, profile endpoints under `/api/profile/*`, `/api/dan-estimates`, `/api/audio` (beatmap audio with playback rate), `/api/replay-video-job`, `/api/countries/*`, and admin endpoints under `/api/admin/*` gated by `LIVE_ADMIN_TOKEN`. Per-IP rate limiting is in place via `src/http/abuse-guard.ts` (public, costly, SSE, country-activation, replay-video buckets). CORS from `ALLOWED_ORIGINS`.

Replay video: the browser renders/encodes MP4 with WebCodecs and uploads it, or the backend renders server-side in headless Chrome (`src/replay-video/server-render.ts`, playwright-core). Finalization muxes audio with ffmpeg and uploads to R2. `scripts/dev/replay-video-job.ts` is a Vite dev middleware fallback when no live backend is configured.

Storage and retention: LibSQL/SQLite (default `live-backend/data/mania-hub-live.db`, WAL), schema in `migrations/001_initial.sql`, applied at boot. `src/retention.ts` runs hourly: `score_events` 14d, `live_event_log` 7d, done `jobs` 2d, `api_call_log` 7d, replay video jobs 2d, rank snapshots 14d, activity 2y; DB size is capped (~10GB max, compaction targets ~8GB). Durable projections (boards, events, users, beatmaps, rosters) are not part of this cleanup.

osu! API budget: token-bucket limited in `src/osu/client.ts` (~45/min target, 60/min hard); calls are logged to `api_call_log`. Don't add new osu! API call paths without going through this client.

## Frontend Architecture

Routing: `src/routes/` file routes with `createFileRoute`; shared shell, auth, country context, theme bootstrap, and live-backend bootstrap live in `src/routes/__root.tsx`. Search params are validated per route and drive country scope, pagination, and filters. API routes in `src/routes/api/` (OG images, sitemap, audio/avatar/background proxies, replay upload, osu! OAuth, sync polling fallback). Admin pages in `src/routes/admin/`. Files in `src/routes/` prefixed with `-` are tests, not routes; do not delete them as stale.

Data flow, in order of preference for live surfaces:
1. `src/lib/live-backend.ts`: typed snapshot fetchers + `openLiveEventSource()` SSE client + country feature-tier bootstrap. Use this for tracker/top-plays/snipes/maps/rankings/profile data from client routes.
2. Server functions (`createServerFn`) wrapping the osu! API layer as fallback when no live backend is configured.
3. Turso (`src/lib/db.ts`, `cache_entries` TTL cache) and R2 (`src/lib/r2-cache.ts`) as server-side caches; legacy paths still read Turso.

Client state: one Zustand store in `src/store.ts`, persisted to localStorage (`mania-hub-cache-v5`; bump the version on breaking shape changes). Data is country-keyed with `fetchedAt` + TTL constants from `src/lib/cache.ts`. Persistence is debounced, has quota-eviction handling, and keeps critical prefs (theme, hidden users, avatar accents) in separate storage keys. Check `useHasHydrated()` before trusting persisted state during SSR hydration.

osu! API layer: `src/lib/osu.ts` is a facade over `src/lib/osu/` domain modules (shared, rankings, maps, replay, snipes, tracker, dan, users, beatmaps). All authenticated osu! calls stay server-side; never put osu! credentials or direct authenticated calls in client components.

Replay viewer: parsing (`replay-parser.ts`, `replay-frames.ts`), judgement (`mania-replay-judgement.ts`, stable vs lazer timing differs - reuse existing score utilities in `src/lib/score.ts` rather than re-normalising), skins, scroll speed, visibility mods, overlays, Pixi/canvas rendering, and WebCodecs video export (`replay-video-encoder.ts`) are separate modules; keep changes scoped to the right one.

Dan estimator: `src/lib/dan-estimator/` (features, scoring, family choice, LN subsystem, courses, labels) with `src/lib/dan-estimator.ts` as entry; `daniel-estimator.ts` is an alternative algorithm. The backend has its own copy under `live-backend/src/dan/`. Benchmarks via `scripts/dan-benchmark.ts` against curated labels. **Dan and LN dan classification must stay algorithmic: never add title/artist/creator/beatmap-id/beatmapset-id/filename or any chart-identity shortcuts to force results.**

SEO/OG: `src/lib/seo.ts` builds meta + OG URLs; `src/routes/api/og.ts` renders images with @vercel/og and caches in R2 behind an `OG_IMAGE_VERSION` constant - bump it when changing OG layouts. Sitemap in `src/routes/api/sitemap.ts`.

## Conventions

- TypeScript, React function components, two-space indent, semicolons. Frontend imports use `#/*` or `@/*` aliases for `src/*` (match nearby style); the backend uses relative imports within `live-backend/src/`.
- Tailwind CSS v4 via `@tailwindcss/vite`; globals and theme CSS variables in `src/styles.css`. The theme is hue/saturation CSS custom properties applied before hydration. A custom `hover` variant avoids stuck hover states on touch devices.
- Animations use framer-motion; 3D card code under `src/components/player/maniacard3d/` uses Three.js.
- Tests are Vitest, colocated as `*.test.ts(x)` next to source (plus the `-`-prefixed files in `src/routes/`).
- Backend logs are structured JSON via `src/logger.ts` (`logInfo`/`logWarn`); follow that instead of `console.log`.

## Config and Secrets

Local secrets live in `.env` (root) and `live-backend/.env`. Key vars:

- Root/frontend: `VITE_LIVE_BACKEND_URL`, `LIVE_BACKEND_URL`, `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, R2 vars, PostHog vars.
- Live backend (`src/config.ts` has the full ~70-var list with defaults): `PORT`, `DATABASE_URL`, `OSU_CLIENT_ID`/`OSU_CLIENT_SECRET`, `OSC_BASE_URL`, `TRACKED_COUNTRIES`, `ALLOWED_ORIGINS`, `LIVE_ADMIN_TOKEN`, feature flags (`ENABLE_WORKERS`, `ENABLE_OSC_SOCKET`, `ENABLE_OSC_BACKFILL`, `ENABLE_OSU_SCORES_FALLBACK`, `ENABLE_SCHEDULED_REFRESHES`), rate/retention/replay-video settings.

Admin UI is at `/admin/live-backend` (frontend) talking to backend `/api/admin/*`. Some admin controls (reset-local-db, delete-country) are destructive; treat with care.
