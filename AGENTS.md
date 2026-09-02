# Repository Guidelines

Mania Hub (mania-tracker.com) is an osu!mania community site with two cooperating parts:

- **Frontend** (`src/`): TanStack Start + Vite + React 19, SSR via Nitro (node-server preset, self-hosted on the VPS; the Vercel preset only builds when `process.env.VERCEL` is set, kept as a rollback target).
- **Live backend** (`live-backend/`): always-on Node service that ingests osu! scores from the score feed (an osu! API recent-scores poller, with a legacy oSC Socket.IO source behind it), keeps durable SQLite projections, runs a DB-backed job queue, and streams updates to browsers over SSE (port 7227).

Countries are dynamic, not hardcoded: the backend's `country_registry` tracks per-country status (cold -> warm -> active, pausable) and feature tier (`indexed` / `maps_warm` / `live` / `snipes`). A synthetic `GLOBAL` scope aggregates all tracked countries. Default/home country is `CR`.

## Deep-dive docs

Read the file matching the task before working on that area; do not read them all up front.

- `docs/backend.md`: live backend module map, ingest flow, job queue + job types, HTTP surface + rate buckets, replay video export, retention/storage/caching.
- `docs/features.md`: per-feature models - snipes, top plays, maps, farm helper, activity, dan estimates, chart analysis, profiles/rankings, goals, my data, uploaded replays, skins privacy.
- `docs/packs.md`: card pack economy, streak/blitz arcade games, GOAT poll.
- `docs/discord.md`: maniabot Discord bot, `/communities` server directory.
- `docs/admin.md`: admin surfaces - ghost overlay, todos, analytics, BBCode image audit.
- `docs/frontend.md`: route/component map, live data flow (SSE client, cross-tab sharing), client state, OG images, BBCode editor.

## Structure

- `src/routes/`: file-based routes (`createFileRoute`); shared shell/auth/country/theme/live bootstrap in `src/routes/__root.tsx`; API proxy routes in `src/routes/api/`; admin pages in `src/routes/admin/`. Files prefixed with `-` are tests, not routes; never hand-edit generated `src/routeTree.gen.ts`.
- `src/components/` (feature folders), `src/store.ts` (Zustand store), `src/lib/` (server/data utilities, osu! API layer: `src/lib/osu.ts` facade over `src/lib/osu/`). The dan estimator and the vendored LeoBlack engine are single copies owned by the backend, imported here through the `#dan/*` and `#leoblack/*` aliases; see CLAUDE.md before moving either.
- `live-backend/src/`: `server.ts` (boot), `ingest/`, `osc/`, `jobs/` + `workers.ts`, `features/` (one module per surface), `http/`, `live/` (SSE), `discord/`, `dan/`, `replay-video/`; schema in `migrations/001_initial.sql`, later tables migrated in `db.ts`.
- `scripts/`: dan benchmark, replay capture, ghost atlas, dev helpers. Static assets in `public/`.

## Commands

The user usually has dev servers running locally (frontend `3000`, live backend `7227`); do not start dev servers or run builds unprompted.

- Frontend: `npm run dev` / `npm run build` / `npm run test` / `npx tsc --noEmit`. Single test: `npx vitest run path/to/file.test.ts` (`-t "name"` for one case).
- Backend (inside `live-backend/`): `npm run dev` / `npm test` / `npx tsc --noEmit` / `npm run verify` (tests + build).
- Sync prod DB to local (dev PC only, overwrites the local DB, never run on the VPS): `npm run live-db:update` (fresh VPS snapshot) or `npm run live-db:sync-from-vps` (reuses the newest existing backup, `--dry-run` supported). `--with-analytics` also pulls the separate analytics DB; `--analytics-only` pulls just that one.
- Dan tooling: `npm run dan:benchmark`, `npm run dan:analyze`.

Minimum verification: for live backend changes run `npm test` and `npx tsc --noEmit` inside `live-backend/`; for type-sensitive frontend changes run `npx tsc --noEmit` at the root. Tests are Vitest, colocated as `*.test.ts(x)` next to source (plus the `-`-prefixed files in `src/routes/`).

## Hard rules

- Chart dan and LN dan classification must stay algorithmic: never add title/artist/creator/beatmap-id/beatmapset-id/filename or any chart-identity shortcut to force what a chart is rated. The one sanctioned identity list is `live-backend/src/features/dan-courses.ts` (the real dan courses), which lives at the player layer and rates no chart.
- Authenticated osu! API access stays server-side; never put osu! credentials or direct authenticated calls in client components. New backend osu! calls go through the token-bucket client in `live-backend/src/osu/client.ts` (~45/min target, 60/min hard limit).
- New SSE event types must be added to `LIVE_EVENT_NAMES` in `src/lib/live-backend.ts` or follower tabs never see them.
- Live surfaces (home, tracker, top plays, snipes, maps) hard-require the live backend; use the typed fetchers + `openLiveEventSource()` in `src/lib/live-backend.ts` from client routes. Server functions are only for data the backend does not project.
- Backend logs are structured JSON via `live-backend/src/logger.ts` (`logInfo`/`logWarn`), never `console.log`.
- Privacy invariants: any endpoint that serves a skin must go through `toSkinSummary(row, { asOwner })`; any surface that lists or deletes uploaded replays must go through `src/lib/uploaded-replays.ts` (details in `docs/features.md`).
- Some admin controls (reset-local-db, delete-country) are destructive; treat with care.
- Secrets live in `.env` (root) and `live-backend/.env`; never commit them. `live-backend/src/config.ts` holds the full ~90-var list with defaults; key frontend vars are `VITE_LIVE_BACKEND_URL`, `LIVE_BACKEND_URL`, `LIVE_ADMIN_TOKEN`, `LIVE_BRIDGE_TOKEN`, R2 vars.

## Style

- TypeScript, React function components, two-space indent, semicolons, named exports where local style uses them; prefer existing helpers and patterns over parallel abstractions.
- Frontend imports use `#/*` or `@/*` aliases for `src/*` (match nearby style); the backend uses relative imports within `live-backend/src/`.
- Tailwind CSS v4 via `@tailwindcss/vite`; globals and theme CSS variables (hue/saturation, applied before hydration) in `src/styles.css`; a custom `hover` variant avoids stuck hover states on touch devices. Animations use framer-motion; 3D card code uses Three.js under `src/components/player/maniacard3d/`.
- Client state: one Zustand store (`src/store.ts`) persisted as `mania-hub-cache-v5`; bump the version on breaking shape changes; check `useHasHydrated()` before trusting persisted state during SSR hydration.
- Always pass a locale to `toLocaleString`/`toLocaleDateString`/`Intl.*` (`"en-US"`, as `src/lib/format.ts` does). A bare call takes Node's locale under SSR and the visitor's on hydration, which is a recoverable-#418 mismatch outside en-US. Enforced by `src/locale-formatting.test.ts`; opt out with `// locale-ok: <why it never renders during SSR>`.
