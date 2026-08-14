# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Mania Hub (mania-tracker.com) is an osu!mania community site with two cooperating parts:

- **Frontend** (`src/`): TanStack Start + Vite + React 19, SSR via Nitro (node-server preset, self-hosted on the VPS; the Vercel preset only builds when `process.env.VERCEL` is set, kept as a rollback target). File-based routes in `src/routes/`; `src/routeTree.gen.ts` is generated, do not hand-edit.
- **Live backend** (`live-backend/`): always-on Node service that ingests osu! scores from Kayla's oSC Socket.IO feed, keeps durable SQLite projections, runs a DB-backed job queue, and streams updates to browsers over SSE.

Countries are dynamic, not hardcoded: the backend keeps a `country_registry` with per-country status (cold -> warm -> active, can pause) and feature tier (`indexed` / `maps_warm` / `live` / `snipes`). Visiting a cold country can activate it (rate-limited). A synthetic `GLOBAL` scope aggregates all tracked countries. Default/home country is `CR`.

This file is the condensed guide. The deep reference lives in `docs/` - read the file matching the task on demand: `docs/backend.md` (ingest, jobs, HTTP surface, retention), `docs/features.md` (per-feature models incl. skins/uploaded-replay privacy), `docs/packs.md` (pack economy, streak/blitz, GOAT poll), `docs/discord.md` (bot + `/communities`), `docs/admin.md` (ghost, todos, analytics), `docs/frontend.md` (routes, live data flow, BBCode editor). `AGENTS.md` is the equivalent condensed guide for other coding agents; keep the two aligned when conventions change.

## Commands

Do not start dev servers or run builds unprompted; the user usually has servers running locally (frontend `3000`, live backend `7227`).

Scripts live in `package.json` and `live-backend/package.json`. Non-obvious: `npm run live-db:update` pulls a fresh VPS snapshot of the prod DB to local, while `npm run live-db:sync-from-vps` reuses the newest existing backup (`--dry-run` supported). Either takes `--with-analytics` to pull the separate analytics DB in the same run (`--analytics-only` for just that one).

Minimum verification: for live backend changes run `npm test` and `npx tsc --noEmit` inside `live-backend/`; for type-sensitive frontend changes run `npx tsc --noEmit` at the root.

## Live Backend Architecture

The always-on `live-backend/` service (osu! score ingest from Kayla's oSC feed, durable SQLite projections, a DB-backed job queue, and SSE streaming to browsers) is the source of truth for live surfaces when `VITE_LIVE_BACKEND_URL` is set. Its architecture guide lives in `live-backend/CLAUDE.md` (loads when you work under that directory); `docs/backend.md` and `docs/features.md` have the fuller per-feature detail.

## Frontend Architecture

Routing: `src/routes/` file routes with `createFileRoute`; shared shell, auth, country context, theme bootstrap, and live-backend bootstrap live in `src/routes/__root.tsx`. Search params are validated per route and drive country scope, pagination, and filters. API/proxy routes live in `src/routes/api/` (note `/api/sync` is the analytics capture proxy, not a live-data fallback: it writes to the live backend's in-house analytics store); admin pages in `src/routes/admin/`. Files in `src/routes/` prefixed with `-` are tests, not routes; do not delete them as stale.

Data flow, in order of preference for live surfaces:
1. `src/lib/live-backend.ts`: typed snapshot fetchers + `openLiveEventSource()` SSE client (one connection per browser, shared across tabs via Web Locks leader election in `src/lib/cross-tab-event-source.ts`; new SSE event types must be added to `LIVE_EVENT_NAMES` or follower tabs won't see them) + country feature-tier bootstrap. Use this for tracker/top-plays/snipes/maps/rankings/profile data from client routes.
2. Server functions (`createServerFn`) wrapping the osu! API layer for data the backend does not project: user profiles/scores, rank histories, per-beatmap scoreboards (replay browse), beatmap search/files, dan estimates, OG cards. The live surfaces (home, tracker, top plays, snipes, maps) hard-require the live backend; without `VITE_LIVE_BACKEND_URL` they render a "live backend required" notice (the osu!-API fallback scans were removed).
3. Server-side caching lives where each resource lives: osu! API responses are cached inside the backend's `/api/osu/v2` proxy (opt-in per call via `cacheTtlMs`/`staleMs` on `osuFetch`; `staleMs` serves expired data through osu! outages), heavy computed artifacts (parsed replays, uploaded-replay descriptions, community `.osu` files) are gzipped JSON/text objects in R2 (`src/lib/r2-cache.ts`; growth bounded by Cloudflare lifecycle rules per prefix, not code). The persistent-cache helpers in `src/lib/api.ts` are a per-instance memory tier only.

Client state: one Zustand store in `src/store.ts`, persisted to localStorage (`mania-hub-cache-v5`; bump the version on breaking shape changes). Data is country-keyed with `fetchedAt` + TTL constants from `src/lib/cache.ts`. Persistence is debounced, has quota-eviction handling, and keeps critical prefs (theme, hidden users, avatar accents) in separate storage keys. Check `useHasHydrated()` before trusting persisted state during SSR hydration.

osu! API layer: `src/lib/osu.ts` is a facade over `src/lib/osu/` domain modules (rankings, maps, replay, snipes, tracker, top-plays, pattern-analysis, dan, users, beatmaps; plus shared support modules). All authenticated osu! calls stay server-side; never put osu! credentials or direct authenticated calls in client components.

Dan estimator: `src/lib/dan-estimator/` (features, scoring, family choice, LN subsystem, courses, labels) with `src/lib/dan-estimator.ts` as entry; `daniel-estimator.ts` is an alternative algorithm. The backend has its own copy under `live-backend/src/dan/`. Benchmarks via `scripts/dan-benchmark.ts` against curated labels. **Dan and LN dan classification must stay algorithmic: never add title/artist/creator/beatmap-id/beatmapset-id/filename or any chart-identity shortcuts to force results.**

## Conventions

- TypeScript, React function components, two-space indent, semicolons. Frontend imports use `#/*` or `@/*` aliases for `src/*` (match nearby style); the backend uses relative imports within `live-backend/src/`.
- Tailwind CSS v4 via `@tailwindcss/vite`; globals and theme CSS variables in `src/styles.css`. The theme is hue/saturation CSS custom properties applied before hydration. A custom `hover` variant avoids stuck hover states on touch devices.
- Animations use framer-motion; 3D card code under `src/components/player/maniacard3d/` uses Three.js.
- Tests are Vitest, colocated as `*.test.ts(x)` next to source (plus the `-`-prefixed files in `src/routes/`).
- Backend logs are structured JSON via `src/logger.ts` (`logInfo`/`logWarn`); follow that instead of `console.log`.

## Config and Secrets

Local secrets live in `.env` (root) and `live-backend/.env`. Key vars:

- Root/frontend: `VITE_LIVE_BACKEND_URL`, `LIVE_BACKEND_URL`, `LIVE_ADMIN_TOKEN`, `LIVE_BRIDGE_TOKEN`, R2 vars.
- Live backend (`live-backend/src/config.ts` has the full ~90-var list with defaults): osu!/oSC credentials and endpoints, `TRACKED_COUNTRIES`, `ALLOWED_ORIGINS`, `LIVE_ADMIN_TOKEN`, `LIVE_BRIDGE_TOKEN`, `LIVE_BACKEND_ROLE` (`all`/`server`/`worker`, opt-in two-process split), and feature flags (`ENABLE_WORKERS`, `ENABLE_OSC_SOCKET`, `ENABLE_OSC_BACKFILL`, `ENABLE_OSU_SCORES_FALLBACK`, `ENABLE_SCHEDULED_REFRESHES`, `ENABLE_DISCORD_BOT`/`ENABLE_DISCORD_FEEDS`).

Admin UI is at `/admin/live-backend` (frontend) talking to backend `/api/admin/*`. Some admin controls (reset-local-db, delete-country) are destructive; treat with care. `/admin/r2` browses both R2 buckets (private `mania-hub-replay-cache`, public `mania-hub-public`); their browsable roots and delete warnings are declared once in the `ADMIN_BUCKETS` registry in `src/lib/r2-cache.ts`.

Uploaded replays (`/replay` Upload tab) are unlisted, not private: the `.osr` sits in R2 and its share link is public by design. What is owned is the row in the backend's `uploaded_replays` index, written after the upload and consulted for both the `/replay/uploads` page ("Your uploads") and every delete - the file itself names no uploader, so any new surface that offers to delete or list one has to go through `src/lib/uploaded-replays.ts` rather than the R2 key. Deletes drop the index row before the objects, and admins get the same page over every uploader's files, with the uploader named on each row.

Skins carry a `visibility` (`public`/`private`) alongside `status`. A private skin is off `/skins`, off the duplicate guard, has no counted download or view, and 404s for anyone but its uploader (a true admin can still read it for moderation, and their private-skins shelf on `/skins` lists every uploader's, via `allPrivate=1` on `/api/skins/list`). Its R2 objects live under a `p-<secret>` key segment, never get a public bucket URL, and only answer to `?t=<secret>`, which `toSkinSummary(row, { asOwner })` attaches for owner-scoped reads only - so any new endpoint that serves a skin must go through that serializer rather than the row. Replay viewers never receive a private `.osk`: `/api/replay-skin/bundle` builds a zip of just the assets that player's stored settings draw (`live-backend/src/skins/replay-bundle.ts`, in-memory cache, no derived artifact in R2) and the client opens it exactly like an archive. What that protects is the file and the page, not the pixels a replay puts on screen.
