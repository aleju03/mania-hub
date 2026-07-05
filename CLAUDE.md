# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Mania Hub (mania-tracker.com) is an osu!mania community site with two cooperating parts:

- **Frontend** (`src/`): TanStack Start + Vite + React 19, SSR via Nitro (Vercel target). File-based routes in `src/routes/`; `src/routeTree.gen.ts` is generated, do not hand-edit.
- **Live backend** (`live-backend/`): always-on Node service that ingests osu! scores from Kayla's oSC Socket.IO feed, keeps durable SQLite projections, runs a DB-backed job queue, and streams updates to browsers over SSE.

Surfaces: rankings (country + global), live tracker, top plays, maps, snipes, farm helper, replay viewer (with video export), player profiles (about/recent/activity/maniacard), personal goals, a My Data dashboard, card packs (collectible maniacards), a BBCode profile editor, settings, admin dashboards. An optional Discord bot (maniabot) has its own dev-gated `/discord` showcase.

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
| Sync prod DB to local | `npm run live-db:update` (fresh VPS snapshot); `npm run live-db:sync-from-vps` reuses the newest existing backup (`--dry-run` supported) |
| Dan benchmark/analyze | `npm run dan:benchmark`, `npm run dan:analyze` |

Minimum verification: for live backend changes run `npm test` and `npx tsc --noEmit` inside `live-backend/`; for type-sensitive frontend changes run `npx tsc --noEmit` at the root.

## Live Backend Architecture

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

Discord bot (`src/discord/`): optional HTTP-interactions bot (maniabot), gated by `ENABLE_DISCORD_BOT` / `ENABLE_DISCORD_FEEDS`; slash commands plus per-channel subscription feeds, frontend `/discord` and `/admin/discord`. Replies are Components V2 and use custom application emojis for grade pills / mod icons (`discord/emojis.ts`, built by `scripts/build-discord-emojis.mjs`, uploaded via the admin "Register emojis" action, with plain-text fallbacks). Keep embeds free of decorative unicode emoji (enforced by `discord-embeds.test.ts`). Details in AGENTS.md.

HTTP (`src/http/snapshots.ts`): snapshot, profile, dan-estimate, audio, replay-video, and country endpoints, plus admin endpoints under `/api/admin/*` gated by `LIVE_ADMIN_TOKEN` (full list in AGENTS.md). Note: some per-user endpoints (goals, my-data, roster self opt-in/out, pack wallet/collection) and the osu! proxies are also `LIVE_ADMIN_TOKEN`-gated and called server-to-server, with the frontend injecting the token plus the osu!-verified viewer id so a user only touches their own data. Per-IP rate limiting via `src/http/abuse-guard.ts`; CORS from `ALLOWED_ORIGINS`.

Replay video: the browser renders/encodes MP4 with WebCodecs and uploads it, or the backend renders server-side in headless Chrome (`src/replay-video/server-render.ts`, playwright-core). Finalization muxes audio with ffmpeg and uploads to R2. `scripts/dev/replay-video-job.ts` is a Vite dev middleware fallback when no live backend is configured.

Storage and retention: LibSQL/SQLite (default `live-backend/data/mania-hub-live.db`, WAL), schema in `migrations/001_initial.sql`, applied at boot. `src/retention.ts` runs hourly to prune raw/transient rows (score events, event log, done jobs, api logs, snapshots; per-table cutoffs in AGENTS.md); durable projections (boards, events, users, beatmaps, rosters) are never cleaned up. DB size is capped (~10GB max, compaction targets ~8GB).

osu! API budget: token-bucket limited in `src/osu/client.ts` (~45/min target, 60/min hard); calls are logged to `api_call_log`. Don't add new osu! API call paths without going through this client.

## Frontend Architecture

Routing: `src/routes/` file routes with `createFileRoute`; shared shell, auth, country context, theme bootstrap, and live-backend bootstrap live in `src/routes/__root.tsx`. Search params are validated per route and drive country scope, pagination, and filters. API/proxy routes live in `src/routes/api/` (note `/api/sync` is the PostHog analytics capture proxy, not a live-data fallback); admin pages in `src/routes/admin/`. Files in `src/routes/` prefixed with `-` are tests, not routes; do not delete them as stale.

Data flow, in order of preference for live surfaces:
1. `src/lib/live-backend.ts`: typed snapshot fetchers + `openLiveEventSource()` SSE client + country feature-tier bootstrap. Use this for tracker/top-plays/snipes/maps/rankings/profile data from client routes.
2. Server functions (`createServerFn`) wrapping the osu! API layer as fallback when no live backend is configured.
3. Turso (`src/lib/db.ts`, `cache_entries` TTL cache) and R2 (`src/lib/r2-cache.ts`) as server-side caches; legacy paths still read Turso.

Client state: one Zustand store in `src/store.ts`, persisted to localStorage (`mania-hub-cache-v5`; bump the version on breaking shape changes). Data is country-keyed with `fetchedAt` + TTL constants from `src/lib/cache.ts`. Persistence is debounced, has quota-eviction handling, and keeps critical prefs (theme, hidden users, avatar accents) in separate storage keys. Check `useHasHydrated()` before trusting persisted state during SSR hydration.

osu! API layer: `src/lib/osu.ts` is a facade over `src/lib/osu/` domain modules (rankings, maps, replay, snipes, tracker, top-plays, pattern-analysis, dan, users, beatmaps; plus shared support modules). All authenticated osu! calls stay server-side; never put osu! credentials or direct authenticated calls in client components.

Replay viewer: parsing (`replay-parser.ts`, `replay-frames.ts`), judgement (`mania-replay-judgement.ts`, stable vs lazer timing differs - reuse existing score utilities in `src/lib/score.ts` rather than re-normalising), skins, scroll speed, visibility mods, overlays, Pixi/canvas rendering, and WebCodecs video export (`replay-video-encoder.ts`) are separate modules; keep changes scoped to the right one.

Dan estimator: `src/lib/dan-estimator/` (features, scoring, family choice, LN subsystem, courses, labels) with `src/lib/dan-estimator.ts` as entry; `daniel-estimator.ts` is an alternative algorithm. The backend has its own copy under `live-backend/src/dan/`. Benchmarks via `scripts/dan-benchmark.ts` against curated labels. **Dan and LN dan classification must stay algorithmic: never add title/artist/creator/beatmap-id/beatmapset-id/filename or any chart-identity shortcuts to force results.**

SEO/OG: `src/lib/seo.ts` builds meta + OG URLs and defines the `OG_IMAGE_VERSION` constant; `src/routes/api/og.ts` renders images with @vercel/og and caches them in R2 keyed by that version - bump `OG_IMAGE_VERSION` in `seo.ts` when changing OG layouts. Sitemap in `src/routes/api/sitemap.ts`.

## Conventions

- TypeScript, React function components, two-space indent, semicolons. Frontend imports use `#/*` or `@/*` aliases for `src/*` (match nearby style); the backend uses relative imports within `live-backend/src/`.
- Tailwind CSS v4 via `@tailwindcss/vite`; globals and theme CSS variables in `src/styles.css`. The theme is hue/saturation CSS custom properties applied before hydration. A custom `hover` variant avoids stuck hover states on touch devices.
- Animations use framer-motion; 3D card code under `src/components/player/maniacard3d/` uses Three.js.
- Tests are Vitest, colocated as `*.test.ts(x)` next to source (plus the `-`-prefixed files in `src/routes/`).
- Backend logs are structured JSON via `src/logger.ts` (`logInfo`/`logWarn`); follow that instead of `console.log`.

## Config and Secrets

Local secrets live in `.env` (root) and `live-backend/.env`. Key vars:

- Root/frontend: `VITE_LIVE_BACKEND_URL`, `LIVE_BACKEND_URL`, `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, R2 vars, PostHog vars.
- Live backend (`live-backend/src/config.ts` has the full ~90-var list with defaults): osu!/oSC credentials and endpoints, `TRACKED_COUNTRIES`, `ALLOWED_ORIGINS`, `LIVE_ADMIN_TOKEN`, `LIVE_BACKEND_ROLE` (`all`/`server`/`worker`, opt-in two-process split), and feature flags (`ENABLE_WORKERS`, `ENABLE_OSC_SOCKET`, `ENABLE_OSC_BACKFILL`, `ENABLE_OSU_SCORES_FALLBACK`, `ENABLE_SCHEDULED_REFRESHES`, `ENABLE_DISCORD_BOT`/`ENABLE_DISCORD_FEEDS`).

Admin UI is at `/admin/live-backend` (frontend) talking to backend `/api/admin/*`. Some admin controls (reset-local-db, delete-country) are destructive; treat with care.
