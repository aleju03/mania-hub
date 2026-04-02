# AGENTS.md

This file gives coding agents the project-specific context they need to work effectively in this repository.

## Project Overview

mania-hub is an osu!mania web app focused on Costa Rican players. It surfaces country rankings, live score feeds, player profiles, popoff highlights, and a replay viewer.

Stack:
- TanStack Start on Vite
- React 19 + TypeScript
- TanStack Router with file-based routing
- Zustand for client state
- Tailwind CSS v4 for styling
- Turso/libSQL for optional persistent caching

## Common Commands

- `npm run dev` - start the dev server on port 3000
- `npm run build` - production build
- `npm run preview` - preview the production build
- `npm run test` - run Vitest once
- `npm run db:init` - initialize the Turso database from `db/schema.sql`
- `npm run db:inspect` - open the Turso shell

## Environment Variables

Expected in `.env`:
- `OSU_CLIENT_ID`
- `OSU_CLIENT_SECRET`
- `TURSO_DATABASE_URL`
- `TURSO_AUTH_TOKEN`
- `VITE_DEV_MODE`

The app should degrade gracefully when Turso is unavailable, but osu! API credentials are required for the full data flow.

## Architecture

### Server and Client Boundary

Keep osu! API access on the server. Server functions live in `src/lib/osu.ts` and should be the main entry point for authenticated osu! API work.

`src/lib/api.ts` handles:
- OAuth token management
- authenticated fetch wrappers
- retry logic for 429/5xx responses
- in-memory plus persistent cache reads/writes

Do not move osu! credentials or direct authenticated requests into client components.

### State and Caching

- `src/store.ts` contains the Zustand store with persisted client cache
- `src/lib/cache.ts` defines TTL and staleness helpers
- `src/lib/db.ts` and the `cache_entries` table support persistent server-side caching

When adding fetched data, prefer following the existing `fetchedAt` + TTL pattern instead of inventing a second cache strategy.

### Routing

Routes live in `src/routes/`:
- `index.tsx` - home
- `rankings.tsx` - Costa Rica country rankings
- `scores.tsx` - recent/live scores
- `popoffs.tsx` - high-PP highlights
- `player/$username.tsx` - player profile
- `replay.tsx` - replay viewer

`src/routes/__root.tsx` is the shared shell. `src/routeTree.gen.ts` is generated; do not hand-edit it.

### Important Modules

- `src/lib/score.ts` - score shaping, dedupe, and display helpers
- `src/lib/pp.ts` - mania PP approximation logic
- `src/lib/rankings.ts` - rank history and delta calculations
- `src/lib/format.ts` - number/time/accuracy formatting
- `src/lib/avatar.ts` and `src/lib/avatar-accent.ts` - avatar normalization and accents
- `src/lib/replay-parser.ts` and `src/components/replay/ReplayCanvas.ts` - replay parsing/rendering

## Conventions

- Use the `#/*` or `@/*` path aliases for `src/*` imports.
- Follow existing TanStack Router patterns rather than introducing a different routing structure.
- Keep server-only code in `src/lib/*` or server functions, not in client-only UI modules.
- Prefer extending existing utilities before creating duplicate helpers.
- Preserve the current visual style unless the task explicitly asks for a redesign.

## Testing and Verification

- Run `npm run test` for logic changes when feasible.
- Run `npm run build` for routing, SSR, or typing-sensitive changes when feasible.
- If you touch replay parsing, score shaping, rankings, or caching logic, verify behavior carefully because these paths are easy to regress silently.
