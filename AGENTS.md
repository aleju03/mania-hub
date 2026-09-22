# Repository Guidelines

Mania Hub (mania-tracker.com) is an osu!mania community site with two cooperating parts:

- **Frontend** (`src/`): TanStack Start + Vite + React 19, SSR via Nitro (node-server preset, self-hosted on the VPS; the Vercel preset only builds when `process.env.VERCEL` is set, kept as a rollback target). File-based routes in `src/routes/`; `src/routeTree.gen.ts` is generated, do not hand-edit.
- **Live backend** (`live-backend/`, maintained separately and gitignored here, so it has its own commits/branches/pushes): always-on Node service that ingests osu! scores from the score feed (an osu! API recent-scores poller, with a legacy oSC Socket.IO source behind it), keeps durable SQLite projections, runs a DB-backed job queue, and streams updates to browsers over SSE (port 7227). It is the source of truth for live surfaces when `VITE_LIVE_BACKEND_URL` is set. Its own guide is `live-backend/AGENTS.md`; read it before working under that directory.

Countries are dynamic, not hardcoded: the backend keeps a `country_registry` with per-country status (cold -> warm -> active, can pause) and feature tier (`indexed` / `maps_warm` / `live` / `snipes`). Visiting a cold country can activate it (rate-limited). A synthetic `GLOBAL` scope aggregates all tracked countries. Default/home country is `CR`.

## Deep-dive docs

This file is the condensed guide. `docs/` holds the maintained reference; read the file matching the task before working on that area, do not read them all up front.

- `docs/backend.md`: live backend module map, ingest flow, job queue + job types, HTTP surface + rate buckets, replay video export, retention/storage/caching.
- `docs/features.md`: per-feature models - snipes, top plays, maps, farm helper, activity, dan estimates, chart analysis, profiles/rankings, goals, my data, uploaded replays, skins privacy.
- `docs/packs.md`: card pack economy, streak/blitz arcade games, GOAT poll.
- `docs/discord.md`: maniabot Discord bot, `/communities` server directory.
- `docs/admin.md`: admin surfaces - ghost overlay, todos, analytics, BBCode image audit, `bugs:pull` setup.
- `docs/frontend.md`: route/component map, live data flow (SSE client, cross-tab sharing), client state, on-device replay video export, OG images, BBCode editor.
- `docs/companella-integration.md`: the Companella score-import beta (`/companella`), off by default. `docs/companella-api.openapi.yaml`, `docs/companella-client-guide.md` and `docs/companella-operations.md` are its API spec, client contract and runbook.

Keep one-off audits, investigation notes, and capture reports in `local-notes/` (gitignored), not in `docs/`. Do not commit them.

## Structure

- `src/routes/`: file-based routes (`createFileRoute`); shared shell, auth, country context, theme bootstrap, and live-backend bootstrap in `src/routes/__root.tsx`. Search params are validated per route and drive country scope, pagination, and filters. API/proxy routes in `src/routes/api/` (`/api/sync` is the analytics capture proxy into the backend's in-house analytics store, not a live-data fallback); admin pages in `src/routes/admin/`. Files prefixed with `-` are tests, not routes; do not delete them as stale.
- `src/components/` (feature folders), `src/store.ts` (Zustand store), `src/lib/` (server/data utilities). `src/lib/osu.ts` is a facade over `src/lib/osu/` domain modules (rankings, maps, replay, snipes, tracker, top-plays, pattern-analysis, dan, users, beatmaps, plus shared support modules).
- `live-backend/src/`: `server.ts` (boot), `ingest/`, `osc/`, `jobs/` + `workers.ts`, `features/` (one module per surface), `http/`, `live/` (SSE), `discord/`, `dan/`, `replay-video/`; schema in `migrations/001_initial.sql`, later tables migrated in `db.ts`.
- `scripts/`: dan benchmark, replay capture, ghost atlas, dev helpers. Static assets in `public/`.

## Commands

The user usually has dev servers running locally (frontend `3000`, live backend `7227`); do not start dev servers or run builds unprompted.

- Frontend: `npm run dev` / `npm run build` / `npm run test` / `npx tsc --noEmit`. Single test: `npx vitest run path/to/file.test.ts` (`-t "name"` for one case).
- Backend (inside `live-backend/`): `npm run dev` / `npm test` / `npx tsc --noEmit` / `npm run verify` (tests + build).
- Sync prod DB to local (dev PC only, overwrites the local DB, never run on the VPS): `npm run live-db:update` (fresh VPS snapshot) or `npm run live-db:sync-from-vps` (reuses the newest existing backup, `--dry-run` supported). `--with-analytics` also pulls the separate analytics DB; `--analytics-only` pulls just that one.
- Dan tooling: `npm run dan:benchmark` (via `scripts/dan-benchmark.ts`, against curated labels), `npm run dan:analyze`.
- Production bug reports: `npm run bugs:pull` exports open reports, reporter identities, threads, and images to a new gitignored `local-notes/bug-reports/` folder. Use `-- --status all`, `-- --id <id>`, or `-- --search "text"` to narrow/expand; read the printed `README.md` and report files, and inspect local image paths as needed. Read-only; does not mark reports seen. Setup in `docs/admin.md`.

Minimum verification: for live backend changes run `npm test` and `npx tsc --noEmit` inside `live-backend/`; for type-sensitive frontend changes run `npx tsc --noEmit` at the root. Tests are Vitest, colocated as `*.test.ts(x)` next to source (plus the `-`-prefixed files in `src/routes/`).

## Frontend data flow

In order of preference for live surfaces:

1. `src/lib/live-backend.ts`: typed snapshot fetchers, `openLiveEventSource()` SSE client, and the country feature-tier bootstrap. One SSE connection per browser, shared across tabs via Web Locks leader election in `src/lib/cross-tab-event-source.ts`. Use this for tracker/top-plays/snipes/maps/rankings/profile data from client routes.
2. Server functions (`createServerFn`) wrapping the osu! API layer, only for data the backend does not project: user profiles/scores, rank histories, per-beatmap scoreboards (replay browse), beatmap search/files, dan estimates, OG cards. The live surfaces (home, tracker, top plays, snipes, maps) hard-require the live backend and render a "live backend required" notice without `VITE_LIVE_BACKEND_URL`; the osu!-API fallback scans were removed.
3. Server-side caching lives where each resource lives: osu! API responses are cached inside the backend's `/api/osu/v2` proxy (opt-in per call via `cacheTtlMs`/`staleMs` on `osuFetch`; `staleMs` serves expired data through osu! outages). Heavy computed artifacts (parsed replays, uploaded-replay descriptions, community `.osu` files) are gzipped JSON/text objects in R2 (`src/lib/r2-cache.ts`; growth bounded by Cloudflare lifecycle rules per prefix, not code). The persistent-cache helpers in `src/lib/api.ts` are a per-instance memory tier only.

Client state: one Zustand store in `src/store.ts`, persisted to localStorage as `mania-hub-cache-v5` (bump the version on breaking shape changes). Data is country-keyed with `fetchedAt` + TTL constants from `src/lib/cache.ts`. Persistence is debounced, has quota-eviction handling, and keeps critical prefs (theme, hidden users, avatar accents) in separate storage keys. Check `useHasHydrated()` before trusting persisted state during SSR hydration.

## Shared dan estimator and replay judge

There is one copy of the dan estimator, at `live-backend/src/dan/dan-estimator/` (features, scoring, family choice, LN subsystem, courses, labels) with `live-backend/src/dan/dan-estimator.ts` as entry, and one copy of the vendored LeoBlack engine at `live-backend/vendor/leoblack`. The frontend reaches them through the `#dan/*` and `#leoblack/*` aliases. Both live under `live-backend/` because the backend compiles with `rootDir: "src"` and prod runs the flat `dist/` layout (`node dist/server.js` plus `dist/maintenance/*.js`), so shared sources cannot sit outside it.

- Each alias is declared in three places that must move together: `paths` in `tsconfig.json`, `imports` in `package.json`, and `vitest.config.ts` (which deliberately does not load `vite.config.ts`).
- Tests for the shared estimator live in `live-backend/tests/dan-*.test.ts`, so edits there need the backend suite, and the root `npx tsc --noEmit` covers both sides. The chart classifier (`#dan/chart-classifier`) is shared on the same terms.
- The mania replay judge is shared on the same terms: `live-backend/src/replay-judge/` (`mania-replay-judgement.ts`, and `stable-frames.ts` for decoding .osr rows), reached as `#replay-judge/*`. The replay viewer draws with it and the backend rates Companella imports from the offsets it finds. Its tests are `live-backend/tests/replay-judge.test.ts`. Keep its imports type-only: the root `replay:*` scripts load it under plain node, which does not map `.js` specifiers onto `.ts`.
- `src/lib/daniel-estimator.ts` is an alternative algorithm, not a copy. `companella.ts` is the one deliberately divergent pair: the backend routes MSD through `msd.ts` so MinaCalc stays serialized against the job lanes, so it stays hand-synced.

## Hard rules

- Chart dan and LN dan classification must stay algorithmic: never add title/artist/creator/beatmap-id/beatmapset-id/filename or any chart-identity shortcut to force what a chart is rated. The one sanctioned identity list is `live-backend/src/features/dan-courses.ts`, the registry of real dan courses, which lives at the player layer on purpose: it rates no chart, it only credits a player with a course they actually passed (see `docs/features.md`).
- Authenticated osu! API access stays server-side; never put osu! credentials or direct authenticated calls in client components. New backend osu! calls go through the token-bucket client in `live-backend/src/osu/client.ts` (~45/min target, 60/min hard limit).
- New SSE event types must be added to `LIVE_EVENT_NAMES` in `src/lib/live-backend.ts` or follower tabs never see them.
- Backend logs are structured JSON via `live-backend/src/logger.ts` (`logInfo`/`logWarn`), never `console.log`.
- Replay video export is on-device only. The ordinary export path must not upload the video, queue a render job, or call `/api/replay-video-job`; the backend's `ENABLE_REPLAY_VIDEO` half stays off and is not a fallback for an unsupported browser. Details in `docs/frontend.md`.
- Uploaded replays (`/replay` Upload tab) are unlisted, not private: the `.osr` sits in R2 and its share link is public by design. What is owned is the row in the backend's `uploaded_replays` index, consulted for both the `/replay/uploads` page and every delete; the file names no uploader, so any surface that lists or deletes one goes through `src/lib/uploaded-replays.ts`, never the R2 key. Deletes drop the index row before the objects; admins get the same page over every uploader's files.
- Skins carry a `visibility` (`public`/`private`) alongside `status`. A private skin is off `/skins`, off the duplicate guard, has no counted download or view, and 404s for anyone but its uploader (a true admin can still read it, and their private shelf on `/skins` lists every uploader's via `allPrivate=1` on `/api/skins/list`). Its R2 objects live under a `p-<secret>` key segment, never get a public bucket URL, and only answer to `?t=<secret>`, which `toSkinSummary(row, { asOwner })` attaches for owner-scoped reads only; any endpoint that serves a skin goes through that serializer, not the row. Replay viewers never receive a private `.osk`: `/api/replay-skin/bundle` zips only the assets the player's stored settings draw (`live-backend/src/skins/replay-bundle.ts`). This protects the file and the page, not the pixels a replay puts on screen.
- Companella-imported replays are owner-only and separate again: they are read through `/api/companella/replay` and never through the public upload flow. The one exception is a play that counts toward simulated pp for an account osu! turned away (below): its replay is public at `/api/integrations/companella/public/replays/<id>` and opens at `/replay?importId=`, still never through the upload flow.
- The Companella integration never writes to an official projection. It reads `beatmap_chart_families` and `player_skill_ratings`; it writes only its own `companella_*` tables. Do not route local score evidence into the official score ingestor, `writePlayerSkillRatingWithHistory`, ranking invalidation, pp, goals, packs or snipes. Simulated pp for accounts osu! turned away (`live-backend/src/integrations/companella/restricted-pp.ts`) is the sanctioned exception to "no public pp": each import is priced into `companella_local_score_pp`, and the totals are merged into leaderboard and profile responses at read time. It never writes `users.pp`, rosters, the cached global board or the pack pool.
- Some admin controls (reset-local-db, delete-country) are destructive; treat with care.
- Secrets live in `.env` (root) and `live-backend/.env`; never commit them.

## Config and admin

- Frontend vars: `VITE_LIVE_BACKEND_URL`, `LIVE_BACKEND_URL`, `LIVE_ADMIN_TOKEN`, `LIVE_BRIDGE_TOKEN`, R2 vars.
- Backend (`live-backend/src/config.ts` has the full ~90-var list with defaults): osu!/oSC credentials and endpoints, `TRACKED_COUNTRIES`, `ALLOWED_ORIGINS`, `LIVE_ADMIN_TOKEN`, `LIVE_BRIDGE_TOKEN`, `LIVE_BACKEND_ROLE` (`all`/`server`/`worker`, opt-in two-process split), and feature flags (`ENABLE_WORKERS`, `ENABLE_OSC_SOCKET`, `ENABLE_OSC_BACKFILL`, `ENABLE_OSU_SCORES_FALLBACK`, `ENABLE_SCHEDULED_REFRESHES`, `ENABLE_DISCORD_BOT`/`ENABLE_DISCORD_FEEDS`).
- Admin UI is at `/admin/live-backend` (frontend) talking to backend `/api/admin/*`. `/admin/r2` browses both R2 buckets (private `mania-hub-replay-cache`, public `mania-hub-public`); their browsable roots and delete warnings are declared once in the `ADMIN_BUCKETS` registry in `src/lib/r2-cache.ts`.

## Style

- TypeScript, React function components, two-space indent, semicolons, named exports where local style uses them; prefer existing helpers and patterns over parallel abstractions.
- Frontend imports use `#/*` or `@/*` aliases for `src/*` (match nearby style); the backend uses relative imports within `live-backend/src/`.
- Tailwind CSS v4 via `@tailwindcss/vite`; globals and theme CSS variables (hue/saturation, applied before hydration) in `src/styles.css`; a custom `hover` variant avoids stuck hover states on touch devices. Animations use framer-motion; 3D card code uses Three.js under `src/components/player/maniacard3d/`.
- Always pass a locale to `toLocaleString`/`toLocaleDateString`/`Intl.*` (`"en-US"`, as `src/lib/format.ts` does). A bare call takes Node's locale under SSR and the visitor's on hydration, which is a recoverable-#418 mismatch outside en-US. Enforced by `src/locale-formatting.test.ts`; opt out with `// locale-ok: <why it never renders during SSR>`.
