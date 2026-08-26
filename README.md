<div align="center">
  <img src="docs/assets/logo.png" alt="Mania Tracker" width="88" height="88" />

  <h1>Mania Tracker</h1>

  <p>An osu!mania community site built around a live score feed, scoped to any country or globally.</p>

  <p><a href="https://mania-tracker.com"><strong>mania-tracker.com</strong></a></p>

  <p>
    <img alt="React" src="https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=111111" />
    <img alt="TanStack Start" src="https://img.shields.io/badge/TanStack_Start-SSR-FF4154?style=flat-square&logo=reactrouter&logoColor=white" />
    <img alt="Vite" src="https://img.shields.io/badge/Vite-7-646CFF?style=flat-square&logo=vite&logoColor=white" />
    <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5-3178C6?style=flat-square&logo=typescript&logoColor=white" />
  </p>
</div>

![Mania Tracker home dashboard](docs/assets/home-dashboard.png)

The country list is not fixed in code. Visiting an untracked country queues it for ingest, and a synthetic global scope aggregates every country being tracked.

## Features

| | |
| --- | --- |
| **Rankings** | Country and global, with 7-day rank movement. |
| **Live tracker** | Real-time score feed, streamed over SSE. |
| **Top plays** | Scores confirmed into a player's top plays, with pp gained. |
| **Maps** | Map browser with pattern/skill filters, farm stats, qualified watch. |
| **Snipes** | First-place takeovers on country leaderboards. |
| **Farm helper** | pp-gain picks from a player's top 200 against peers. |
| **Profiles** | Stats, per-skill history, dan estimate, BBCode pages, 3D mania card. |
| **Goals** | pp/acc/grade/rank targets that complete on the qualifying play. |
| **My Stats** | Records, play-rhythm clock, mods fingerprint, per-keymode skill ratings. |
| **Card packs** | Collectible maniacards: open packs, collect players, recycle dupes. |
| **Replays** | Render `.osr` files with custom skins, plus a community skin gallery. |
| **Dan estimates** | Algorithmic 4K/6K/7K dan and LN dan, no curated lists. |

![Replay viewer](docs/assets/replay-viewer.png)

## How it works

- **Frontend** (`src/`): TanStack Start + React 19, SSR via Nitro, self-hosted behind Cloudflare. File-based routes, one Zustand store, Tailwind v4.
- **Backend** (`live-backend/`): always-on Node service that ingests osu!mania scores, keeps SQLite projections, runs a job queue (enrichment, rosters, snipe boards, chart analysis, dan estimates, skill ratings), and pushes deltas over SSE.

Browsers load a snapshot on entry then subscribe to `/api/live`; reconnects replay missed events via `Last-Event-ID`. Authenticated osu! API calls stay server-side behind a rate limiter, heavy artifacts cache in R2.

Endpoints, job types, and per-feature models are in `docs/`. `AGENTS.md` is the condensed guide for coding agents.
