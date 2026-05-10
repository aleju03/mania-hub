# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

osu!mania hub - a TanStack Start (SSR React) + Vite app for osu!mania data. Defaults to Costa Rica but supports any country: country rankings, live score tracking, player profiles, top plays, maps data, snipes, and a replay viewer.

## Commands

- `npm run dev` - dev server on port 3000
- `npm run preview` - serve a production build locally
- `npm run dan:analyze -- <path|beatmapsetId|osuUrl>` - diagnose dan/LN classifier output for local `.osu`/`.osz` files or downloaded sets. Useful flags: `--rate 1,1.5`, `--segments`, `--explain`, `--json`, `--neighbors N`, `--sr N`. Use `--explain` for calibration/debugging (shows confidence, LN distribution, segmentation, top skill families, nearest-reference deltas); default table is best for bulk comparisons.
- `npm run dan:benchmark` - run the dan classifier against the curated benchmark beatmapsets and compare predicted dan vs the expected labels from Turso (same dataset as the admin /admin/dan-classifier benchmark tab). Flags: `--family normal|ln`, `--classifier aleju|daniel`, `--rate N`, `--json`, `--include-unlabeled`. Requires `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN`. For machine-readable output use `npm run --silent dan:benchmark -- --json` so npm's header lines don't pollute stdout.
- `npm run replay:validate` - runs `scripts/replay-validate.ts` with `.env` if present
- `npm run db:init` - initialize Turso DB from `db/schema.sql`
- `npm run db:inspect` - open interactive Turso shell
- `npm run snipes:reset` - runs `scripts/reset-snipes.mjs` with `.env`

**Do not run `npm run test` or `npm run build` unless the user explicitly asks.** Both are slow and not needed for normal iteration.

Tests are Vitest (jsdom), config inherited from `vite.config.ts`. Tests live beside source as `*.test.ts(x)`.

## Environment Variables

Required for live data:
- `OSU_CLIENT_ID` / `OSU_CLIENT_SECRET` - osu! API v2 OAuth (client_credentials flow)

Persistent caching (app degrades gracefully when missing):
- `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` - Turso (libSQL) database

Optional:
- `VITE_POSTHOG_KEY` (client capture), `POSTHOG_PERSONAL_API_KEY` / `POSTHOG_PROJECT_ID` (for dev-only `/admin/monitor` dashboard)
- `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_REPLAY_CACHE_MAX_BYTES` - R2-backed replay/beatmap asset cache
- `VITE_DEV_MODE` - enables dev-only features

## Debugging the osu! API

Make live calls to osu! API v2 directly using `.env` credentials when debugging data shapes - don't guess at responses. Token flow: `POST https://osu.ppy.sh/oauth/token` with `client_id`, `client_secret`, `grant_type=client_credentials`, `scope=public`, then bearer-auth to `https://osu.ppy.sh/api/v2/...`. See `osu-api-reference.md` for endpoints.

## Architecture

### Server / Client Boundary

All authenticated osu! API access goes through **server functions** (`createServerFn` from TanStack Start) defined in `src/lib/osu.ts`. These run server-side only - they own the OAuth token. The client never talks to osu! directly. Do not move osu! credentials or authenticated requests into client components.

`src/lib/api.ts` is the server-only API layer: OAuth token management, `osuFetch`/`osuFetchBinary` with retry/timeout (429/5xx exponential backoff), two-tier cache (in-memory Map + Turso persistent cache with TTL), and `fetchWithCacheLock` - a distributed lock pattern using `cache_locks` to prevent thundering herd across serverless instances.

`src/lib/db.ts` creates the Turso client; `db` is `null` when env vars are missing, and all cache functions guard with `hasDb()`.

R2-backed replay/beatmap-asset caching lives in `src/lib/r2-cache.ts`.

### State & Caching

Client state uses **Zustand** (`src/store.ts`) with `persist` middleware (key `mania-hub-cache-v5`). Most slices are keyed by country code (`rankingsByCountry`, `feedScoresByCountry`, etc.). Staleness uses `fetchedAt` + TTLs from `src/lib/cache.ts`.

Theme hue/sat persist in their own tiny localStorage keys (`mania-hub-theme-v1`, `mania-hub-theme-sat-v1`) so they survive a QuotaExceededError on the main blob; an inline bootstrap in `src/routes/__root.tsx` applies them pre-hydration. Keep these keys in sync if renaming.

Server-side persistent cache uses `getPersistentCached` / `setPersistentCache` in `api.ts` - in-memory first, then `cache_entries` in Turso. Server functions in `osu.ts` define their own TTLs.

When adding fetched data, follow the existing `fetchedAt` + TTL pattern.

### Routing

File-based via TanStack Router. **Do not hand-edit `src/routeTree.gen.ts`** - it's generated.

Routes in `src/routes/`:
- `index.tsx` - home: top players, recent scores, popoffs
- `rankings.tsx` - country rankings (sortable, 7-day rank changes)
- `tracker.tsx` - live score feed polling across tracked players
- `top-plays.tsx` - top PP plays (popoffs / scores tabs)
- `maps.tsx` - country maps data (farmed / most played / favourites)
- `snipes.tsx` - snipe feed
- `player/$username.tsx` - profile with best/recent scores and insights
- `replay.tsx` - replay viewer (parses `.osr` server-side, renders on canvas)
- `admin/*` - dev-only tools (dan-classifier, maniacard, monitor, og-preview)
- `api/*` - API routes: audio, avatar, background, favicon, og, sitemap, sync

### Key Modules

- `src/lib/osu.ts` - all data-fetching server functions; uses `mapWithConcurrency` for batched ops and promise caches to dedup in-flight requests
- `src/lib/types.ts` - osu! API v2 TS interfaces; `OsuScore` covers both legacy and lazer fields
- `src/lib/score.ts` - identity dedup, accuracy/grade/total normalization across lazer/stable, pp gain
- `src/lib/pp.ts` - approximate osu!mania PP calculator
- `src/lib/rankings.ts` - rank change from 90-day history arrays
- `src/lib/beatmap-parser.ts` - parses `.osu` mania notes
- `src/lib/replay-parser.ts` - binary `.osr` parser
- `src/lib/replay-*` - validation, score input, skin, navigation, scroll speed, judgement (each its own module)
- `src/lib/dan-estimator*`, `src/lib/daniel-estimator*` - dan / LN dan classifiers
- `src/components/replay/ReplayCanvas.ts` - canvas/Pixi-based mania replay renderer
- `src/components/player/maniacard3d/` - Three.js 3D card

### Lazer/Stable Score Duality

osu! API returns scores differently from stable vs lazer clients. `src/lib/score.ts` normalizes: accuracy from hit counts, grade derivation, total score field selection. Always use existing score utilities; do not duplicate normalization logic. A `MIXED_SCORE_USER_IDS` set in `osu.ts` tracks users mixing both clients (they can't use the `legacy_only=1` param).

### Database Schema

Turso tables (`db/schema.sql`):
- `cache_entries` - generic key/value with TTL
- `cache_locks` - distributed locks (thundering-herd prevention)
- `country_top_plays` - precomputed country top-play index, keyed by `(country, score_id)`
- `beatmap_asset_cache` - beatmap-asset metadata (R2 stores the bytes)

## Conventions

- TypeScript, React function components; two-space indent, semicolons, named exports.
- Path aliases `#/*` and `@/*` both resolve to `./src/*` (tsconfig + package.json `imports`). Use whichever alias is already used near the code you're editing.
- Follow existing TanStack Router patterns for new routes and server functions.
- Server-only code stays in `src/lib/*`, route server functions, or API routes - never in reusable client UI modules.
- Prefer extending existing utilities over creating parallel helpers.
- Tailwind CSS v4 via `@tailwindcss/vite`; global styles in `src/styles.css`. Animations via `framer-motion`.

## Algorithmic Classifier Rule

Dan and LN-dan classification must stay **algorithmic**. Do not add title, artist, creator, beatmap ID, beatmapset ID, filename, or narrowly chart-specific metadata shortcuts to force a dan result. Calibration changes must generalize through extracted chart-pressure features, broad reference distributions, or documented formulas. Tests must verify behavior without relying on identity lookup.

## What to Verify Carefully

Replay parsing, score shaping, rankings, server data shaping, cache behavior, and route helper logic all regress silently. Add focused tests when you touch them.