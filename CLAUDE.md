# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Mania Hub (mania-tracker.com) is an osu!mania community site with two cooperating parts:

- **Frontend** (`src/`): TanStack Start + Vite + React 19, SSR via Nitro (Vercel target). File-based routes in `src/routes/`; `src/routeTree.gen.ts` is generated, do not hand-edit.
- **Live backend** (`live-backend/`): always-on Node service that ingests osu! scores from Kayla's oSC Socket.IO feed, keeps durable SQLite projections, runs a DB-backed job queue, and streams updates to browsers over SSE.

Surfaces: rankings (country + global), live tracker, top plays, maps, snipes, farm helper, replay viewer (with video export), player profiles (about/recent/activity/maniacard), personal goals, a My Data dashboard, card packs (collectible maniacards), a BBCode profile editor, settings, admin dashboards. An optional Discord bot (maniabot) has its own dev-gated `/discord` showcase.

Countries are dynamic, not hardcoded: the backend keeps a `country_registry` with per-country status (cold -> warm -> active, can pause) and feature tier (`indexed` / `maps_warm` / `live` / `snipes`). Visiting a cold country can activate it (rate-limited). A synthetic `GLOBAL` scope aggregates all tracked countries. Default/home country is `CR`.

See `AGENTS.md` for the fuller repository guide (endpoint lists, per-feature models, job details); this file is the condensed version.

## Commands

Do not start dev servers or run builds unprompted; the user usually has servers running locally (frontend `3000`, live backend `7227`).

| Task | Command |
| --- | --- |
| Frontend dev | `npm run dev` |
| Frontend tests | `npm run test` |
| Frontend typecheck | `npx tsc --noEmit` |
| Single test file | `npx vitest run path/to/file.test.ts` (add `-t "name"` for one case) |
| Backend dev | `cd live-backend && npm run dev` |
| Backend tests | `cd live-backend && npm test` |
| Backend typecheck | `cd live-backend && npx tsc --noEmit` |
| Backend tests + build | `cd live-backend && npm run verify` |
| oSC smoke test | `cd live-backend && npm run smoke:osc` |
| Backend DB compaction | `cd live-backend && npm run compact:storage` (also `compact:maps-farmed`) |
| Sync prod DB to local | `npm run live-db:update` (fresh VPS snapshot); `npm run live-db:sync-from-vps` reuses the newest existing backup (`--dry-run` supported) |
| Dan benchmark/analyze | `npm run dan:benchmark`, `npm run dan:analyze` |

Minimum verification: for live backend changes run `npm test` and `npx tsc --noEmit` inside `live-backend/`; for type-sensitive frontend changes run `npx tsc --noEmit` at the root.

## Live Backend Architecture

The always-on `live-backend/` service (osu! score ingest from Kayla's oSC feed, durable SQLite projections, a DB-backed job queue, and SSE streaming to browsers) is the source of truth for live surfaces when `VITE_LIVE_BACKEND_URL` is set. Its architecture guide lives in `live-backend/CLAUDE.md` (loads when you work under that directory); `AGENTS.md` has the fuller per-feature detail.

## Frontend Architecture

Routing: `src/routes/` file routes with `createFileRoute`; shared shell, auth, country context, theme bootstrap, and live-backend bootstrap live in `src/routes/__root.tsx`. Search params are validated per route and drive country scope, pagination, and filters. API/proxy routes live in `src/routes/api/` (note `/api/sync` is the analytics capture proxy, not a live-data fallback: it writes to the live backend's in-house analytics store); admin pages in `src/routes/admin/`. Files in `src/routes/` prefixed with `-` are tests, not routes; do not delete them as stale.

Data flow, in order of preference for live surfaces:
1. `src/lib/live-backend.ts`: typed snapshot fetchers + `openLiveEventSource()` SSE client + country feature-tier bootstrap. Use this for tracker/top-plays/snipes/maps/rankings/profile data from client routes.
2. Server functions (`createServerFn`) wrapping the osu! API layer for data the backend does not project: user profiles/scores, rank histories, per-beatmap scoreboards (replay browse), beatmap search/files, dan estimates, OG cards. The live surfaces (home, tracker, top plays, snipes, maps) hard-require the live backend; without `VITE_LIVE_BACKEND_URL` they render a "live backend required" notice (the osu!-API fallback scans were removed).
3. Server-side caching lives where each resource lives: osu! API responses are cached inside the backend's `/api/osu/v2` proxy (opt-in per call via `cacheTtlMs`/`staleMs` on `osuFetch`; `staleMs` serves expired data through osu! outages), heavy computed artifacts (parsed replays, uploaded-replay descriptions, community `.osu` files) are gzipped JSON/text objects in R2 (`src/lib/r2-cache.ts`; growth bounded by Cloudflare lifecycle rules per prefix, not code). The persistent-cache helpers in `src/lib/api.ts` are a per-instance memory tier only.

Client state: one Zustand store in `src/store.ts`, persisted to localStorage (`mania-hub-cache-v5`; bump the version on breaking shape changes). Data is country-keyed with `fetchedAt` + TTL constants from `src/lib/cache.ts`. Persistence is debounced, has quota-eviction handling, and keeps critical prefs (theme, hidden users, avatar accents) in separate storage keys. Check `useHasHydrated()` before trusting persisted state during SSR hydration.

osu! API layer: `src/lib/osu.ts` is a facade over `src/lib/osu/` domain modules (rankings, maps, replay, snipes, tracker, top-plays, pattern-analysis, dan, users, beatmaps; plus shared support modules). All authenticated osu! calls stay server-side; never put osu! credentials or direct authenticated calls in client components.

Replay viewer: parsing (`replay-parser.ts`, `replay-frames.ts`), judgement (`mania-replay-judgement.ts`, stable vs lazer timing differs - reuse existing score utilities in `src/lib/score.ts` rather than re-normalising), skins, scroll speed, visibility mods, overlays, storyboards (`src/lib/storyboard/` parser + timelines, `replay-storyboard.ts` loader against the backend's `/api/storyboard` bundle), Pixi/canvas rendering, and WebCodecs video export (`replay-video-encoder.ts`) are separate modules; keep changes scoped to the right one.

Dan estimator: `src/lib/dan-estimator/` (features, scoring, family choice, LN subsystem, courses, labels) with `src/lib/dan-estimator.ts` as entry; `daniel-estimator.ts` is an alternative algorithm. The backend has its own copy under `live-backend/src/dan/`. Benchmarks via `scripts/dan-benchmark.ts` against curated labels. **Dan and LN dan classification must stay algorithmic: never add title/artist/creator/beatmap-id/beatmapset-id/filename or any chart-identity shortcuts to force results.**

SEO/OG: `src/lib/seo.ts` builds meta + OG URLs and defines the `OG_IMAGE_VERSION` constant; `src/routes/api/og.ts` renders images with @vercel/og and caches them in R2 keyed by that version - bump `OG_IMAGE_VERSION` in `seo.ts` when changing OG layouts. Sitemap in `src/routes/api/sitemap.ts`.

## Conventions

- TypeScript, React function components, two-space indent, semicolons. Frontend imports use `#/*` or `@/*` aliases for `src/*` (match nearby style); the backend uses relative imports within `live-backend/src/`.
- Tailwind CSS v4 via `@tailwindcss/vite`; globals and theme CSS variables in `src/styles.css`. The theme is hue/saturation CSS custom properties applied before hydration. A custom `hover` variant avoids stuck hover states on touch devices.
- Animations use framer-motion; 3D card code under `src/components/player/maniacard3d/` uses Three.js.
- Tests are Vitest, colocated as `*.test.ts(x)` next to source (plus the `-`-prefixed files in `src/routes/`).
- Backend logs are structured JSON via `src/logger.ts` (`logInfo`/`logWarn`); follow that instead of `console.log`.

## Config and Secrets

Local secrets live in `.env` (root) and `live-backend/.env`. Key vars:

- Root/frontend: `VITE_LIVE_BACKEND_URL`, `LIVE_BACKEND_URL`, `LIVE_ADMIN_TOKEN`, R2 vars.
- Live backend (`live-backend/src/config.ts` has the full ~90-var list with defaults): osu!/oSC credentials and endpoints, `TRACKED_COUNTRIES`, `ALLOWED_ORIGINS`, `LIVE_ADMIN_TOKEN`, `LIVE_BACKEND_ROLE` (`all`/`server`/`worker`, opt-in two-process split), and feature flags (`ENABLE_WORKERS`, `ENABLE_OSC_SOCKET`, `ENABLE_OSC_BACKFILL`, `ENABLE_OSU_SCORES_FALLBACK`, `ENABLE_SCHEDULED_REFRESHES`, `ENABLE_DISCORD_BOT`/`ENABLE_DISCORD_FEEDS`).

Admin UI is at `/admin/live-backend` (frontend) talking to backend `/api/admin/*`. Some admin controls (reset-local-db, delete-country) are destructive; treat with care.

Skins carry a `visibility` (`public`/`private`) alongside `status`. A private skin is off `/skins`, off the duplicate guard, has no counted download, and 404s for anyone but its uploader (a true admin can still read it for moderation). Its R2 objects live under a `p-<secret>` key segment, never get a public bucket URL, and only answer to `?t=<secret>`, which `toSkinSummary(row, { asOwner })` attaches for owner-scoped reads only - so any new endpoint that serves a skin must go through that serializer rather than the row. Replay viewers never receive a private `.osk`: `/api/replay-skin/bundle` builds a zip of just the assets that player's stored settings draw (`live-backend/src/skins/replay-bundle.ts`, in-memory cache, no derived artifact in R2) and the client opens it exactly like an archive. What that protects is the file and the page, not the pixels a replay puts on screen.

`/admin/ghost` drives the owner-only Ralsei overlay: pick a route, pick an audience (everyone there / one signed-in viewer / nobody), then walk him around a visitor's screen with WASD, talk through a speech bubble, and fire Deltarune-style actions. Backend sessions live in `live-backend/src/live/ghost.ts` (in-memory, `ENABLE_GHOST`), the sprite atlas and clip manifest in `public/images/ghost/ralsei.png` + `src/lib/ghost-shared.ts`, the visitor overlay in `src/components/ghost/` (mounted from `__root.tsx`; every page open holds one ghost SSE connection on its own budget). See `AGENTS.md` for the endpoint and identity-signing detail.
