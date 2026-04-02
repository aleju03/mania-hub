# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

osu!mania hub — a web app for Costa Rican osu!mania players. Shows country rankings, live score feeds, player profiles, "popoff" highlights, and a replay viewer. Built with TanStack Start (SSR React framework) on Vite.

## Commands

- `npm run dev` — dev server on port 3000
- `npm run build` — production build
- `npm run test` — run tests (vitest)
- `npm run db:init` — initialize Turso database from `db/schema.sql`
- `npm run db:inspect` — open interactive Turso shell

## Environment Variables

Required in `.env`:
- `OSU_CLIENT_ID` / `OSU_CLIENT_SECRET` — osu! API v2 OAuth credentials (client_credentials flow)
- `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` — Turso (libSQL) database for persistent server-side caching
- `VITE_DEV_MODE` — enables dev-only features when set

## Architecture

### Server/Client Boundary

All osu! API calls go through **server functions** (`createServerFn` from TanStack Start) defined in `src/lib/osu.ts`. These run server-side only — they hold the OAuth token and make authenticated requests to `osu.ppy.sh/api/v2`. The client never talks to osu! directly.

`src/lib/api.ts` is the server-only layer: OAuth token management, `osuFetch`/`osuFetchBinary` wrappers with retry logic (429/5xx), and a two-tier cache (in-memory Map + Turso persistent cache with TTL).

### State & Caching

Client state uses **Zustand** (`src/store.ts`) with `persist` middleware (localStorage). The store caches rankings, scores, rank histories, avatar accents, and popoffs with `fetchedAt` timestamps. Staleness is checked via `isCacheStale()` from `src/lib/cache.ts` using TTLs defined there.

Server-side caching uses `getPersistentCached`/`setPersistentCache` in `api.ts` — checks in-memory first, then falls back to the `cache_entries` table in Turso. The DB is optional; the app degrades gracefully without it.

### Routing

File-based routing via TanStack Router. Routes in `src/routes/`:
- `index.tsx` — home: top players, recent scores, popoffs
- `rankings.tsx` — CR country rankings (2 pages, sortable, 7-day rank changes)
- `scores.tsx` — live score feed polling across tracked CR players
- `popoffs.tsx` — top PP plays
- `player/$username.tsx` — individual player profile with best/recent scores
- `replay.tsx` — replay viewer (parses `.osr` via `osu-parsers` server-side, renders on canvas)

### Key Modules

- `src/lib/osu.ts` — all server functions (data fetching endpoints). Batched operations use `mapWithConcurrency` for controlled parallelism.
- `src/lib/score.ts` — score utilities: identity dedup, pp gain calculation, display helpers
- `src/lib/pp.ts` — approximate osu!mania PP calculator (strain + accuracy model)
- `src/lib/rankings.ts` — rank change computation from history arrays
- `src/lib/format.ts` — number/time/accuracy formatting
- `src/lib/avatar-accent.ts` / `avatar.ts` — avatar color extraction and URL normalization

### Path Aliases

`#/*` and `@/*` both resolve to `./src/*` (configured in tsconfig and package.json imports).

### Styling

Tailwind CSS v4 via `@tailwindcss/vite` plugin. Styles in `src/styles.css`. Animations use `framer-motion`.
