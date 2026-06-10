<div align="center">
  <img src="docs/assets/favicon-cr.png" alt="Mania Tracker icon" width="96" height="96" />

  <h1>Mania Tracker</h1>

  <p>
    osu!mania country rankings, live score tracking, top plays, maps, snipes, farm picks, player profiles, and a replay viewer.
  </p>

  <p>
    <a href="https://mania-tracker.com"><strong>mania-tracker.com</strong></a>
  </p>

  <p>
    <img alt="React" src="https://img.shields.io/badge/React-19-61DAFB?style=for-the-badge&logo=react&logoColor=111111" />
    <img alt="TanStack Start" src="https://img.shields.io/badge/TanStack_Start-SSR-FF4154?style=for-the-badge&logo=reactrouter&logoColor=white" />
    <img alt="Vite" src="https://img.shields.io/badge/Vite-7-646CFF?style=for-the-badge&logo=vite&logoColor=white" />
    <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5-3178C6?style=for-the-badge&logo=typescript&logoColor=white" />
  </p>
</div>

![Mania Tracker home dashboard](docs/assets/home-dashboard.png)

Pick a country (or the global scope) and see what's going on in its osu!mania scene: who's climbing the rankings, who just popped off, what maps everyone's farming, who got sniped. Countries aren't hardcoded; visiting one starts tracking it, and a synthetic global scope aggregates everything.

## Features

| Feature | What it does |
| --- | --- |
| Rankings | Country and global osu!mania rankings with 7-day rank movement. |
| Live tracker | Real-time score feed across tracked players, streamed to the browser over SSE. |
| Top plays | Scores confirmed to have entered a player's top plays, with the PP they gained. |
| Maps | Most farmed maps per country, plus a global rollup. |
| Snipes | First-place takeovers on per-map country leaderboards. |
| Farm helper | PP-gain recommendations built by comparing a player's top 200 against peers at similar PP. |
| Player profiles | Stats, recent plays, per-skill activity history, dan estimate, and a 3D mania card. |
| Replay viewer | Parse and render `.osr` replays with custom skins, overlays, and MP4 video export. |
| Dan estimates | Algorithmic dan and LN dan classification for charts, no curated lists. |

![Replay viewer](docs/assets/replay-viewer.png)

## How it works

Two cooperating parts:

- **Frontend** (`src/`): TanStack Start + React 19, SSR via Nitro, deployed on Vercel. File-based routes, one Zustand store persisted to localStorage, Tailwind CSS v4.
- **Live backend** (`live-backend/`): always-on Node service that ingests osu! scores from [Kayla's oSC feed](https://osc.kaysting.dev) with an osu! API fallback, keeps durable SQLite projections, runs a DB-backed job queue (enrichment, rosters, snipe boards, dan estimates, activity analysis, replay video rendering), and pushes deltas to browsers over SSE.

Browsers fetch a snapshot on page entry and subscribe to `/api/live` for updates; reconnects replay missed events via `Last-Event-ID`. All authenticated osu! API calls stay server-side behind a token-bucket rate limiter.

`AGENTS.md` has the fuller repository guide.
