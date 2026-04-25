# Repository Guidelines

## Project Structure & Module Organization

This is a TanStack Start + Vite React app for osu!mania data. Source code lives in `src/`. File-based routes are in `src/routes/`, with the shared shell in `src/routes/__root.tsx`; do not hand-edit `src/routeTree.gen.ts`. Shared UI is in `src/components/`, client state is in `src/store.ts`, and server/data utilities are in `src/lib/`.

Static assets live in `public/`, including fonts, icons, headers, and note images. Database schema and cache tables are defined in `db/schema.sql`. Utility scripts live in `scripts/`.

## Build, Test, and Development Commands

- `npm run dev` starts the Vite dev server on port `3000`.
- `npm run build` creates a production build and checks routing/SSR-sensitive code.
- `npm run preview` serves the production build locally.
- `npm run test` runs Vitest once.
- `npm run db:init` initializes the Turso database from `db/schema.sql`.
- `npm run db:inspect` opens the Turso shell.
- `npm run snipes:reset` runs `scripts/reset-snipes.mjs` with `.env`.

## Coding Style & Naming Conventions

Use TypeScript and React function components. Follow the existing style: two-space indentation, semicolons, named exports where already established, and concise utility functions. Use the `#/*` path alias for imports from `src/*`.

Keep authenticated osu! API access on the server through `src/lib/osu.ts` and supporting server utilities in `src/lib/api.ts`. Do not move osu! credentials or direct authenticated requests into client components. For fetched client data, follow the existing `fetchedAt` plus TTL pattern in `src/store.ts` and `src/lib/cache.ts`.

## Testing Guidelines

Vitest is the test runner. Tests currently live beside library code as `*.test.ts`, especially for score normalization, replay judgement, profile shaping, and beatmap search. Add focused tests for changes to parsing, score shaping, rankings, cache behavior, or server data shaping. Run `npm run test` before submitting logic changes; run `npm run build` when touching routes, SSR code, or TypeScript-heavy boundaries.

## Commit & Pull Request Guidelines

Recent commits use short imperative subjects, usually title case, such as `Persist maps random picker settings` or `Improve snipes background refresh`. Keep commits narrowly scoped and describe the user-visible or behavioral change.

Pull requests should include a brief summary, tests run, linked issues when applicable, and screenshots or screen recordings for UI changes. Mention any required environment variables or database migrations.

## Security & Configuration Tips

Required local secrets belong in `.env`: `OSU_CLIENT_ID`, `OSU_CLIENT_SECRET`, `TURSO_DATABASE_URL`, and `TURSO_AUTH_TOKEN`. The app can degrade without Turso, but osu! API credentials are required for live data. Never commit secrets, tokens, generated caches, or local database dumps.
