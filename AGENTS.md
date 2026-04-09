# AGENTS.md

This file gives coding agents the project-specific context they need to work effectively in this repository.

## Project Overview

mania-hub is an osu!mania web app (defaults to Costa Rica, supports any country). It surfaces country rankings, live score feeds, player profiles, top play highlights, a maps page, and a replay viewer.

Stack:
- TanStack Start on Vite (SSR React framework)
- React 19 + TypeScript
- TanStack Router with file-based routing
- Zustand for client state (persisted to localStorage, keyed by country)
- Tailwind CSS v4 for styling
- Turso/libSQL for optional persistent server-side caching
- Framer Motion for animations

## Common Commands

- `npm run dev` - start the dev server on port 3000
- `npm run build` - production build
- `npm run preview` - preview the production build
- `npm run test` - run Vitest once (picks up config from `vite.config.ts`)
- `npm run db:init` - initialize the Turso database from `db/schema.sql`
- `npm run db:inspect` - open the Turso shell

## Environment Variables

Expected in `.env`:
- `OSU_CLIENT_ID` / `OSU_CLIENT_SECRET` - osu! API v2 OAuth credentials (client_credentials flow)
- `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` - Turso (libSQL) database
- `VITE_DEV_MODE` - enables dev-only features when set

The app degrades gracefully when Turso is unavailable, but osu! API credentials are required.

## Architecture

### Server and Client Boundary

Keep osu! API access on the server. Server functions live in `src/lib/osu.ts` (created with `createServerFn`) and are the only entry point for authenticated osu! API work. The client never talks to osu! directly.

`src/lib/api.ts` handles:
- OAuth token management (client_credentials flow, cached until near expiry)
- `osuFetch`/`osuFetchBinary` wrappers with retry logic (429/5xx, exponential backoff)
- Two-tier cache: in-memory Map + Turso persistent cache with TTL
- `fetchWithCacheLock` - distributed lock pattern using `cache_locks` table to prevent thundering herd

`src/lib/db.ts` creates the Turso client; `db` is `null` when env vars are missing, and all cache functions guard with `hasDb()`.

Do not move osu! credentials or direct authenticated requests into client components.

### State and Caching

- `src/store.ts` contains the Zustand store with `persist` middleware (localStorage key `"mania-hub-cache-v4"`). Most slices are keyed by country code (e.g., `rankingsByCountry`, `feedScoresByCountry`).
- `src/lib/cache.ts` defines client-side TTL constants and `isCacheStale()` helper.
- Server functions in `osu.ts` define their own cache TTLs (rankings 5 min, rank history 24h, user 2 min, home page 60s, maps data 24h, insights 6h).

When adding fetched data, follow the existing `fetchedAt` + TTL pattern instead of inventing a second cache strategy.

### Routing

Routes live in `src/routes/`:
- `index.tsx` - home: top players, recent scores, popoffs
- `rankings.tsx` - country rankings (2 pages, sortable, 7-day rank changes)
- `tracker.tsx` - live score feed polling across tracked players (batch cycling)
- `top-plays.tsx` - top PP plays ("popoffs" and "scores" tabs)
- `maps.tsx` - country maps data (farmed, most played, favourites tabs)
- `player/$username.tsx` - player profile with best/recent scores and insights
- `replay.tsx` - replay viewer (parses `.osr` server-side, renders on canvas)
- `snipes.tsx` - stub page (not yet implemented)
- `api/audio.ts` - API route serving beatmap audio from in-memory cached zips

`src/routes/__root.tsx` is the shared shell. `src/routeTree.gen.ts` is generated; do not hand-edit it.

### Important Modules

- `src/lib/osu.ts` - all server functions. Uses `mapWithConcurrency` for batched operations and promise caches to dedup in-flight requests.
- `src/lib/types.ts` - osu! API v2 TypeScript interfaces. `OsuScore` handles both legacy and lazer fields.
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

The osu! API returns scores differently depending on stable vs lazer submission. `src/lib/score.ts` normalizes this: accuracy recalculation from hit counts, grade derivation, total score field selection. A hardcoded `MIXED_SCORE_USER_IDS` set in `osu.ts` tracks users who mix both clients.

### Database Schema

Two tables in Turso (`db/schema.sql`):
- `cache_entries` - key/value cache with TTL (`cache_key`, `cache_value`, `expires_at`, `updated_at`)
- `cache_locks` - distributed locks for thundering herd prevention (`lock_key`, `expires_at`)

## Conventions

- Use the `#/*` or `@/*` path aliases for `src/*` imports.
- Follow existing TanStack Router patterns rather than introducing a different routing structure.
- Keep server-only code in `src/lib/*` or server functions, not in client-only UI modules.
- Prefer extending existing utilities before creating duplicate helpers.
- Preserve the current visual style unless the task explicitly asks for a redesign.
- Custom fonts: `Torus-Regular.otf` and `Torus-Heavy.otf`.

## Testing and Verification

- Run `npm run test` for logic changes when feasible.
- Run `npm run build` for routing, SSR, or typing-sensitive changes when feasible.
- If you touch replay parsing, score shaping, rankings, or caching logic, verify behavior carefully because these paths regress silently.

## Debugging

You can make live calls to the osu! API v2 directly using the credentials in `.env`. Token flow: `POST https://osu.ppy.sh/oauth/token` with `client_id`, `client_secret`, `grant_type=client_credentials`, `scope=public`, then use the bearer token on `https://osu.ppy.sh/api/v2/...`. See `osu-api-reference.md` for endpoint details.
