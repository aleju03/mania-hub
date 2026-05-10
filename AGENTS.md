# Repository Guidelines

## What This Is

This is a TanStack Start + Vite React app for osu!mania data. It defaults to Costa Rica but supports country-scoped rankings, live score tracking, player profiles, top plays, maps data, snipes, and a replay viewer.

## Project Structure & Module Organization

Source code lives in `src/`. File-based routes are in `src/routes/`, with the shared shell in `src/routes/__root.tsx`; do not hand-edit generated `src/routeTree.gen.ts`. Shared UI is in `src/components/`, with feature folders such as `home/`, `layout/`, `player/`, `replay/`, and `ui/`. Client state is in `src/store.ts`, and server/data utilities are in `src/lib/`.

Important routes include `index.tsx`, `rankings.tsx`, `tracker.tsx`, `top-plays.tsx`, `maps.tsx`, `snipes.tsx`, `replay.tsx`, `player/$username.tsx`, `admin/*`, and `api/*`. Static assets live in `public/`, including fonts, icons, headers, and note images. Database schema and cache tables are defined in `db/schema.sql`. Utility scripts live in `scripts/`.

## Build, Test, and Development Commands

- `npm run dev` starts the Vite dev server on port `3000`.
- Do not run `npm run dev` or otherwise start a dev server during normal work; the user keeps it running already.
- Do not run `npm run test` or `npm run build` unless the user explicitly asks for either command.
- `npm run build` creates a production build and checks routing/SSR-sensitive code.
- `npm run preview` serves the production build locally.
- `npm run test` runs Vitest once.
- `npm run dan:analyze -- <path|beatmapsetId|osuUrl>` diagnoses dan/LN classifier output for local `.osu`/`.osz` files or downloaded beatmapsets; useful flags include `--rate 1,1.5`, `--segments`, `--explain`, `--json`, `--neighbors N`, and `--sr N`. Use `--explain` for calibration/debugging work because it shows confidence, LN distributions, segmentation, top skill families, and nearest-reference deltas; use the default table for bulk comparisons and `--json` for machine-readable details.
- `npm run dan:benchmark` runs the dan classifier against curated benchmark beatmapsets and compares predicted dan against expected labels from Turso, using the same dataset as the admin `/admin/dan-classifier` benchmark tab. Useful flags include `--family normal|ln`, `--classifier aleju|daniel`, `--rate N`, `--json`, and `--include-unlabeled`. Requires `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`; for machine-readable output use `npm run --silent dan:benchmark -- --json` so npm header lines do not pollute stdout.
- `npm run replay:validate` runs `scripts/replay-validate.ts` with `.env` if present.
- `npm run db:init` initializes the Turso database from `db/schema.sql`.
- `npm run db:inspect` opens the Turso shell.
- `npm run snipes:reset` runs `scripts/reset-snipes.mjs` with `.env`.

## Architecture Notes

Keep authenticated osu! API access on the server through server functions in `src/lib/osu.ts` and supporting utilities in `src/lib/api.ts`. The API layer owns OAuth token handling, retry/timeout behavior, in-memory caching, Turso-backed persistent caching, and cache-lock behavior. Do not move osu! credentials or direct authenticated requests into client components.

Client state uses Zustand in `src/store.ts`, usually with `fetchedAt` plus TTL checks from `src/lib/cache.ts`. Server-side persistent cache tables are in Turso: `cache_entries`, `cache_locks`, `country_top_plays`, and `beatmap_asset_cache`. R2-backed replay or beatmap asset caching is handled in `src/lib/r2-cache.ts`.

Replay-related logic is split across parser, validation, score input, skin, navigation, scroll speed, judgement, beatmap parsing, and canvas rendering modules. Score handling must account for stable/lazer API differences; use existing score utilities rather than duplicating normalization logic.

Dan and LN dan classification must be algorithmic. Do not add title, artist, creator, beatmap ID, beatmapset ID, filename, or narrowly chart-specific metadata shortcuts to force a dan result. Calibration changes should generalize through extracted chart-pressure features, broad reference distributions, or documented formulas, and tests should verify behavior without relying on identity lookup.

## Coding Style & Naming Conventions

Use TypeScript, React function components, and the existing style: two-space indentation, semicolons, named exports where already established, and concise utility functions. Use `#/*` or `@/*` path aliases for imports from `src/*`; prefer the alias already used near the code being edited.

Follow existing TanStack Router patterns for new routes and server functions. Keep server-only code in `src/lib/*`, route server functions, or API routes, not in reusable client UI modules. Prefer extending existing utilities before creating parallel helpers.

Styling uses Tailwind CSS v4 via `@tailwindcss/vite`, with global styles in `src/styles.css`. Animations use `framer-motion`; replay rendering uses canvas/Pixi-related code; 3D cards use Three.js helpers under `src/components/player/maniacard3d/`.

## Testing Guidelines

Vitest is the test runner and uses the Vite config. Tests live beside source files as `*.test.ts` or `*.test.tsx`, including route helper tests, replay parsing/rendering tests, score normalization, profile shaping, beatmap search, cache behavior, and maniacard layout/rendering tests.

Add focused tests for changes to parsing, replay behavior, score shaping, rankings, cache behavior, server data shaping, or route helper logic. Do not run `npm run test` or `npm run build` unless the user explicitly asks for either command.

## Security & Configuration Tips

Local secrets belong in `.env`. Core live data needs `OSU_CLIENT_ID` and `OSU_CLIENT_SECRET`. Turso uses `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`; the app should degrade when Turso is missing. Optional integrations include `VITE_POSTHOG_KEY`, `POSTHOG_PERSONAL_API_KEY`, `POSTHOG_PROJECT_ID`, `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_REPLAY_CACHE_MAX_BYTES`, and `VITE_DEV_MODE`.
