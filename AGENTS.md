# Repository Guidelines

Mania Tracker (mania-tracker.com), an osu!mania community site in two parts:

- **Frontend** (`src/`): TanStack Start + Vite + React 19, SSR via Nitro (node-server preset on the VPS; the Vercel preset, built only when `process.env.VERCEL` is set, is a rollback target). File-based routes in `src/routes/`; `src/routeTree.gen.ts` is generated, never hand-edit it.
- **Live backend** (`backend/`): a separate repo, gitignored here, with its own commits, branches and pushes. Always-on Node service: ingests osu! scores, keeps SQLite projections, runs a job queue, streams updates over SSE (port 7227). Source of truth for live surfaces when `VITE_LIVE_BACKEND_URL` is set. Read `backend/AGENTS.md` before working there.

Countries are dynamic: `country_registry` holds each one's status (cold -> warm -> active, can pause) and tier (`indexed` / `maps_warm` / `live` / `snipes`); visiting a cold country can activate it (rate-limited). `GLOBAL` aggregates all tracked countries; the default is `CR`.

## Docs

`docs/` is the reference; read only the file for your area: `backend.md` (modules, ingest, jobs, HTTP and rate buckets, replay video, retention, caching), `features/` (per-feature models, one file per area; index in its `README.md`), `packs.md` (pack economy, streak/blitz, GOAT poll), `discord.md` (maniabot, `/communities`), `admin.md` (admin surfaces, analytics, `bugs:pull` setup), `frontend.md` (routes, live data flow, client state, replay video export, OG images, BBCode editor), `companella-integration.md` (the off-by-default Companella import beta, with its `companella-*` spec, client guide and runbook).

One-off audits and investigation notes go in `local-notes/` (gitignored), never `docs/`, and are never committed.

## Structure

- `src/routes/`: `__root.tsx` holds the shell, auth, country context and theme/live-backend bootstrap. Search params are validated per route and drive country scope, pagination and filters. `api/` holds API and proxy routes (`/api/sync` proxies analytics capture; it is not a live-data fallback), `admin/` the admin pages. Files prefixed `-` are tests, not routes; don't delete them as stale.
- `src/components/` (feature folders), `src/store.ts` (Zustand), `src/lib/` (server/data utilities; `osu.ts` is a facade over `osu/`).
- `backend/src/`: `server.ts`, `ingest/`, `osc/`, `jobs/` + `workers.ts`, `features/`, `http/`, `live/` (SSE), `discord/`, `dan/`, `replay-video/`. Schema in `migrations/001_initial.sql`, later tables in `db.ts`.
- `scripts/`: replay capture/validation, bug-report export, i18n generators, `dev/` helpers. Static assets in `public/`.

## Commands

The user usually has dev servers running (frontend 3000, backend 7227). Don't start dev servers or run builds unprompted.

- Frontend: `npm run dev` / `build` / `test`, `npx tsc --noEmit`; one test: `npx vitest run <file>` (`-t "name"`).
- Backend (in `backend/`): `npm run dev` / `npm test` / `npx tsc --noEmit` / `npm run verify` (tests + build).
- Prod DB to local (dev PC only, overwrites the local DB, never on the VPS): `npm run live-db:update` (fresh snapshot) or `npm run live-db:sync-from-vps` (newest backup, `--dry-run`); add `--with-analytics` or `--analytics-only` for the analytics DB.
- `npm run bugs:pull` exports open production bug reports (with reporters, threads, images) to a new `local-notes/bug-reports/` folder; `-- --status all`, `-- --id <id>`, `-- --search "text"`. Read-only.

Verify backend changes with `npm test` and `npx tsc --noEmit` in `backend/`, type-sensitive frontend changes with the root `npx tsc --noEmit`. Tests are Vitest, colocated as `*.test.ts(x)`.

## Frontend data flow

Live surfaces, in order of preference:

1. `src/lib/live-backend.ts`: snapshot fetchers, the `openLiveEventSource()` SSE client, the country tier bootstrap. One SSE connection per browser, shared across tabs (`src/lib/cross-tab-event-source.ts`). Use it for tracker, top plays, snipes, maps, rankings and profile data.
2. Server functions (`createServerFn`) over the osu! API, only for what the backend doesn't project: profiles and scores, rank histories, per-beatmap scoreboards, beatmap search/files, dan estimates, OG cards. Home, tracker, top plays, snipes and maps require the backend and show a notice without `VITE_LIVE_BACKEND_URL`.
3. Caching: osu! API responses in the backend's `/api/osu/v2` proxy (opt-in via `cacheTtlMs`/`staleMs` on `osuFetch`; `staleMs` rides out osu! outages); heavy artifacts (parsed replays, uploaded-replay descriptions, community `.osu` files) as gzipped R2 objects (`src/lib/r2-cache.ts`, bounded by R2 lifecycle rules). `src/lib/api.ts` is only a per-instance memory tier.

Client state: one Zustand store persisted to localStorage as `mania-hub-cache-v5`; bump the version on breaking shape changes. Data is country-keyed with `fetchedAt` + TTLs from `src/lib/cache.ts`. Check `useHasHydrated()` before trusting persisted state during hydration.

## Shared code under backend/

The dan estimator (`backend/src/dan/`, including the chart classifier), the vendored LeoBlack engine (`backend/vendor/leoblack`) and the replay judge (`backend/src/replay-judge/`) exist once, under `backend/` (it compiles with `rootDir: "src"` to the flat `dist/` prod runs). The frontend imports them as `#dan/*`, `#leoblack/*` and `#replay-judge/*`.

- Each alias lives in `tsconfig.json` `paths`, `package.json` `imports` and `vitest.config.ts` (which deliberately skips `vite.config.ts`); change all three together.
- Their tests are in `backend/tests/` (`dan-*`, `replay-judge`): run the backend suite and the root `npx tsc --noEmit`.
- Keep the replay judge's imports type-only: the root `replay:*` scripts load it under plain node, which doesn't map `.js` to `.ts`.
- `companella.ts` is the one hand-synced pair (the backend routes MSD through `msd.ts` to serialize MinaCalc against the job lanes).

## Hard rules

- Dan and LN dan classification stay algorithmic: no title, artist, creator, beatmap(set) id, filename or other chart-identity shortcut. The only identity list is the real-course registry `backend/src/features/dan-courses.ts`, which rates no chart and only credits players with courses they passed.
- Authenticated osu! API access stays server-side. New backend osu! calls go through `backend/src/osu/client.ts` (~45/min target, 60/min hard).
- New SSE event types go in `LIVE_EVENT_NAMES` (`src/lib/live-backend.ts`), or follower tabs never see them.
- Backend logs: structured JSON via `backend/src/logger.ts` (`logInfo`/`logWarn`), never `console.log`.
- Replay video export is on-device only: never upload the video, queue a render job or call `/api/replay-video-job`. The backend's `ENABLE_REPLAY_VIDEO` stays off and is not a fallback.
- Uploaded replays are unlisted, not private: the R2 `.osr` names no uploader, so listing or deleting one goes through the `uploaded_replays` owner index (`src/lib/uploaded-replays.ts`), never the R2 key.
- Private skins stay private: serve skins only through `toSkinSummary(row, { asOwner })`, never the raw row; replay viewers never get a private `.osk`.
- Companella imports are never official data: they write only `companella_*` tables (plus merged-rating rows in `player_skill_history` and `unrated_plays`) and never feed the ingestor, `score_events`, `player_skill_ratings`, `users.pp`, rankings, goals, packs or snipes. Their replays stay out of the upload flow (public only for a listed import on an official file). The sanctioned exceptions are listed in `docs/companella-integration.md`; read it before touching any.
- Admin reset-local-db and delete-country are destructive.
- Several agent sessions share this working tree; uncommitted changes may be someone else's. Never `git stash`, `git restore`, `git clean` or `git checkout -- <path>` files you didn't author; use `git show HEAD:<path>` to compare.
- Pushing `main` (including `git ship`) is a production release: only when explicitly asked, every time.
- Prod DB over SSH: only `sqlite3 'file:<path>?immutable=1'` (`-readonly` blocks WAL checkpoints and once stalled the backend). Locally, use `pragma query_only=1` (`immutable=1` reads torn pages while processes write). The local DB is an old snapshot plus dev activity, not prod truth.
- Secrets live in `.env` and `backend/.env`; never commit them.

## Config and admin

- Frontend vars: `VITE_LIVE_BACKEND_URL`, `LIVE_BACKEND_URL`, `LIVE_ADMIN_TOKEN`, `LIVE_BRIDGE_TOKEN`, R2 vars. Backend vars (~90, with defaults): `backend/src/config.ts`.
- `/admin/live-backend` drives backend `/api/admin/*`. `/admin/r2` browses both R2 buckets (private `mania-hub-replay-cache`, public `mania-hub-public`), declared in `ADMIN_BUCKETS` (`src/lib/r2-cache.ts`).

## Style

- TypeScript, React function components, two-space indent, semicolons, named exports where local style uses them; reuse existing helpers over parallel abstractions.
- Frontend imports use `#/*` or `@/*` for `src/*` (match nearby code); the backend uses relative imports.
- Tailwind v4; globals and theme variables in `src/styles.css`, including a `hover` variant that avoids stuck hover on touch. framer-motion for animation; Three.js for 3D cards (`src/components/player/maniacard3d/`).
- New pages use the site shell: `PageHeader` with an osu! line icon from `public/images/icons/`, body `bg-osu-b5`, panels as in `src/components/companella/primitives.tsx`. The dark legal chrome is only for `/privacy` and `/terms`.
- New or edited Lingui strings: `npm run i18n:extract` then `npm run i18n:compile`, and commit the compiled `src/locales/*/messages.ts` with the `.po` files (the build doesn't compile them).
- `public/sw.js` serves `/fonts/`, `/images/` and `/favicon` cache-first and survives hard reloads: a changed file there needs a `CACHE_NAME` bump or, better, a new URL.
- Always pass a locale (`"en-US"`, as `src/lib/format.ts` does) to `toLocaleString`/`toLocaleDateString`/`Intl.*`; a bare call mismatches SSR and hydration (#418). Enforced by `src/locale-formatting.test.ts`; opt out with `// locale-ok: <why it never renders during SSR>`.
