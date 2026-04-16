# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

osu!mania hub - a web app for osu!mania players (defaults to Costa Rica, supports any country). Shows country rankings, live score feeds, player profiles, top play highlights, a maps page, and a replay viewer. Built with TanStack Start (SSR React framework) on Vite.

## Commands

- `npm run dev` - dev server on port 3000
- `npm run build` - production build
- `npm run preview` - preview production build
- `npm run test` - run tests (vitest, single run)
- `npm run db:init` - initialize Turso database from `db/schema.sql`
- `npm run db:inspect` - open interactive Turso shell

Tests use vitest with jsdom. One test file exists: `src/lib/score.test.ts`. No separate vitest config; it picks up from `vite.config.ts`.

## Environment Variables

Required in `.env`:
- `OSU_CLIENT_ID` / `OSU_CLIENT_SECRET` - osu! API v2 OAuth credentials (client_credentials flow)
- `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` - Turso (libSQL) database for persistent server-side caching
- `VITE_DEV_MODE` - enables dev-only features when set

The app degrades gracefully without Turso, but osu! API credentials are required.

## Debugging

You can make live calls to the osu! API v2 directly using the credentials in `.env`. Use this proactively when debugging data-related issues - don't guess at API response shapes, just call the endpoint and check. Token flow: `POST https://osu.ppy.sh/oauth/token` with `client_id`, `client_secret`, `grant_type=client_credentials`, `scope=public`, then use the bearer token on `https://osu.ppy.sh/api/v2/...`. See `osu-api-reference.md` for endpoints.

## Architecture

### Server/Client Boundary

All osu! API calls go through **server functions** (`createServerFn` from TanStack Start) defined in `src/lib/osu.ts`. These run server-side only - they hold the OAuth token and make authenticated requests to `osu.ppy.sh/api/v2`. The client never talks to osu! directly.

`src/lib/api.ts` is the server-only layer: OAuth token management, `osuFetch`/`osuFetchBinary` wrappers with retry logic (429/5xx with exponential backoff), and a two-tier cache (in-memory Map + Turso persistent cache with TTL). Also implements `fetchWithCacheLock` - a distributed lock pattern using the `cache_locks` table to prevent thundering herd across serverless instances.

`src/lib/db.ts` creates the Turso client; `db` is `null` when env vars are missing, and all cache functions guard with `hasDb()`.

### State & Caching

Client state uses **Zustand** (`src/store.ts`) with `persist` middleware (localStorage key `"mania-hub-cache-v5"`). Most store slices are keyed by country code (e.g., `rankingsByCountry`, `feedScoresByCountry`). Staleness is checked via `isCacheStale()` from `src/lib/cache.ts` using TTLs defined there.

Server-side caching uses `getPersistentCached`/`setPersistentCache` in `api.ts` - checks in-memory first, then falls back to the `cache_entries` table in Turso. Server functions in `osu.ts` define their own cache TTLs (rankings 5 min, rank history 24h, user 2 min, home page 60s, maps data 24h, insights 6h).

When adding fetched data, follow the existing `fetchedAt` + TTL pattern.

### Routing

File-based routing via TanStack Router. `src/routeTree.gen.ts` is generated - do not hand-edit it.

Routes in `src/routes/`:
- `index.tsx` - home: top players, recent scores, popoffs
- `rankings.tsx` - country rankings (2 pages, sortable, 7-day rank changes)
- `tracker.tsx` - live score feed polling across tracked players (batch cycling)
- `top-plays.tsx` - top PP plays ("popoffs" and "scores" tabs)
- `maps.tsx` - country maps data (farmed, most played, favourites tabs)
- `player/$username.tsx` - player profile with best/recent scores and insights
- `replay.tsx` - replay viewer (parses `.osr` server-side, renders on canvas)
- `snipes.tsx` - stub page (not yet implemented)
- `api/audio.ts` - API route serving beatmap audio from in-memory cached zips

### Key Modules

- `src/lib/osu.ts` - all server functions (data fetching endpoints). Uses `mapWithConcurrency` for batched operations and promise caches to dedup in-flight requests.
- `src/lib/types.ts` - osu! API v2 TypeScript interfaces. Note: `OsuScore` handles both legacy and lazer fields.
- `src/lib/score.ts` - score utilities: identity dedup, accuracy/grade/total score normalization across lazer/stable, pp gain calculation
- `src/lib/pp.ts` - approximate osu!mania PP calculator (strain + accuracy model)
- `src/lib/rankings.ts` - rank change computation from 90-day history arrays
- `src/lib/format.ts` - number/time/accuracy formatting
- `src/lib/country.ts` - country list, selection, flag URLs and gradients
- `src/lib/avatar.ts` / `avatar-accent.ts` - avatar color extraction via sharp, URL normalization
- `src/lib/beatmap-parser.ts` - parses `.osu` file format for mania notes
- `src/lib/replay-parser.ts` - binary `.osr` replay parser
- `src/lib/skin-parser.ts` - parses osu! skin zips (`.osk`) for mania config
- `src/components/replay/ReplayCanvas.ts` - canvas renderer for mania replays

### Lazer/Stable Score Duality

The osu! API returns scores differently depending on whether they were submitted from stable or lazer. `src/lib/score.ts` normalizes this: accuracy recalculation from hit counts, grade derivation, total score field selection. A hardcoded `MIXED_SCORE_USER_IDS` set in `osu.ts` tracks users who mix both clients (they can't use the `legacy_only=1` param).

### Path Aliases

`#/*` and `@/*` both resolve to `./src/*` (configured in tsconfig paths and package.json imports).

### Styling

Tailwind CSS v4 via `@tailwindcss/vite` plugin. Styles in `src/styles.css`. Animations use `framer-motion`. Custom fonts: `Torus-Regular.otf` and `Torus-Heavy.otf`.

### Database Schema

Two tables in Turso (`db/schema.sql`):
- `cache_entries` - key/value cache with TTL (`cache_key`, `cache_value`, `expires_at`, `updated_at`)
- `cache_locks` - distributed locks for thundering herd prevention (`lock_key`, `expires_at`)

## Conventions

- Follow existing TanStack Router patterns for new routes.
- Keep server-only code in `src/lib/*` or server functions, not in client UI modules.
- Prefer extending existing utilities before creating duplicate helpers.
- If you touch replay parsing, score shaping, rankings, or caching logic, verify carefully as these paths regress silently.
