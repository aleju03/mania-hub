<div align="center">
  <img src="docs/assets/favicon-cr.png" alt="Mania Tracker Costa Rica icon" width="96" height="96" />

  <h1>Mania Tracker</h1>

  <p>
    Country-aware osu!mania rankings, score tracking, player profiles, map tools, snipes, and replay viewing.
  </p>

  <p>
    <img alt="React" src="https://img.shields.io/badge/React-19-61DAFB?style=for-the-badge&logo=react&logoColor=111111" />
    <img alt="TanStack Start" src="https://img.shields.io/badge/TanStack_Start-SSR-FF4154?style=for-the-badge&logo=reactrouter&logoColor=white" />
    <img alt="Vite" src="https://img.shields.io/badge/Vite-7-646CFF?style=for-the-badge&logo=vite&logoColor=white" />
    <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5-3178C6?style=for-the-badge&logo=typescript&logoColor=white" />
    <img alt="osu!mania" src="https://img.shields.io/badge/osu!mania-CR-FF66AA?style=for-the-badge" />
  </p>
</div>

![Mania Tracker home dashboard](docs/assets/home-dashboard.png)

Mania Tracker is a TanStack Start + Vite React app for exploring osu!mania activity. It defaults to Costa Rica, but most data views are country-scoped: rankings, recent scores, top plays, player pages, maps, snipes, and replay tooling all work through the same country-aware shell.

## Highlights

| Feature | What it does |
| --- | --- |
| Country rankings | Browse osu!mania players by selected country, with cached profile and pp data. |
| Live tracker | Follow recent score activity with score, accuracy, mods, beatmap, and player context. |
| Player profiles | View player summaries, recent plays, top plays, grades, and mania-specific stats. |
| Top plays | Surface high-value plays and compare activity across time windows. |
| Maps tools | Search and inspect beatmaps, including dan and LN dan classification workflows. |
| Snipes | Track local leaderboard snipes and country-level score battles. |
| Replay viewer | Parse, validate, and render mania replays with custom skin/navigation controls. |
| Admin utilities | Development dashboards for cache, API usage, maniacard rendering, and classifier calibration. |

## Tech Stack

- [TanStack Start](https://tanstack.com/start) for SSR React and file-based routing
- [Vite](https://vite.dev/) for local development and production builds
- [React 19](https://react.dev/) with TypeScript
- [Tailwind CSS v4](https://tailwindcss.com/) for styling
- [Zustand](https://zustand-demo.pmnd.rs/) for client state and TTL-aware persisted data
- [Turso/libSQL](https://turso.tech/) for persistent cache tables
- [PixiJS](https://pixijs.com/) and canvas modules for replay rendering
- [Three.js](https://threejs.org/) helpers for 3D maniacard visuals

## Quick Start

```bash
npm install
npm run dev
```

The development server runs on `http://localhost:3000`.

## Environment

Create a `.env` file in the repository root.

| Variable | Required | Purpose |
| --- | --- | --- |
| `OSU_CLIENT_ID` | Yes | osu! API v2 OAuth client id. |
| `OSU_CLIENT_SECRET` | Yes | osu! API v2 OAuth client secret. |
| `TURSO_DATABASE_URL` | Optional | Turso/libSQL database URL for persistent caching. |
| `TURSO_AUTH_TOKEN` | Optional | Turso auth token. |
| `R2_ENDPOINT` | Optional | Cloudflare R2 endpoint for replay/asset cache storage. |
| `R2_ACCESS_KEY_ID` | Optional | R2 access key id. |
| `R2_SECRET_ACCESS_KEY` | Optional | R2 secret access key. |
| `R2_BUCKET` | Optional | R2 bucket name. |
| `R2_REPLAY_CACHE_MAX_BYTES` | Optional | Replay cache size limit. |
| `VITE_DEV_MODE` | Optional | Enables dev-only routes and tools when set. |

The app should still degrade gracefully when optional services such as Turso or R2 are not configured.

## Commands

| Command | Description |
| --- | --- |
| `npm run dev` | Start the Vite dev server on port `3000`. |
| `npm run build` | Create a production build. |
| `npm run preview` | Serve the production build locally. |
| `npm run test` | Run the Vitest suite once. |
| `npm run dan:analyze -- <path\|beatmapsetId\|osuUrl>` | Diagnose dan/LN classifier output for local files or downloaded beatmapsets. |
| `npm run replay:validate` | Validate replay parsing with `.env` loaded when present. |
| `npm run db:init` | Initialize the Turso database from `db/schema.sql`. |
| `npm run db:inspect` | Open an interactive Turso shell. |
| `npm run snipes:reset` | Reset snipes data using `scripts/reset-snipes.mjs`. |

## Project Layout

```text
src/
  routes/          File-based TanStack routes and API endpoints
  components/      Shared UI, layout, home, player, replay, and utility components
  lib/             Server/data utilities, osu! API access, cache, auth, replay helpers
  store.ts         Zustand client state and persisted country-scoped cache
db/
  schema.sql       Turso cache and app tables
docs/
  assets/          README screenshots and diagrams
public/
  images/          Icons, mod badges, dan assets, notes, and app imagery
  fonts/           Local Torus/Venera font assets
scripts/           Data, replay, snipes, and dan-analysis utilities
```
