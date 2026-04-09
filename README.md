# osu!mania tracker

A web app for Costa Rican osu!mania players. Shows country rankings, live score feeds, player profiles, top play highlights, and a replay viewer.

Built with [TanStack Start](https://tanstack.com/start) (SSR React) on Vite.

## Getting Started

```bash
npm install
npm run dev
```

### Environment Variables

Create a `.env` file with:

- `OSU_CLIENT_ID` / `OSU_CLIENT_SECRET` - osu! API v2 OAuth credentials
- `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` - Turso (libSQL) database
- `VITE_DEV_MODE` - enables dev-only features when set

### Commands

| Command | Description |
|---|---|
| `npm run dev` | Dev server on port 3000 |
| `npm run build` | Production build |
| `npm run test` | Run tests (Vitest) |
| `npm run db:init` | Initialize Turso DB from schema |
| `npm run db:inspect` | Open interactive Turso shell |

## Roadmap

> Ordered by recommended priority. Fix what's broken, lay the foundation, then build new things.

---

### Phase 1: Bug Fixes

*Fix what's broken before building new. Quick wins that improve the current experience.*

| # | Issue | Status |
|:---:|---|:---:|
| 1 | Some plays missing the **+n PP** display on score cards | ![done](https://img.shields.io/badge/done-brightgreen?style=flat-square) |
| 2 | Name color calculation wrong (Randy = blue, BabyIan = pink) | ![done](https://img.shields.io/badge/done-brightgreen?style=flat-square) |
| 3 | Replay: accuracy not accurate at end of play | ![todo](https://img.shields.io/badge/todo-red?style=flat-square) |
| 4 | Replay: changing BG dim resets the play | ![done](https://img.shields.io/badge/done-brightgreen?style=flat-square) |
| 5 | Fix LN position on falling notes in home page background | ![todo](https://img.shields.io/badge/todo-red?style=flat-square) |
| 6 | Rankings page: name colors stay white on client-side navigation unless already cached; only load after full page reload | ![done](https://img.shields.io/badge/done-brightgreen?style=flat-square) |
| 7 | Replay: background disappears and becomes blurred after reloading replay | ![done](https://img.shields.io/badge/done-brightgreen?style=flat-square) |
| 8 | Replay: fix scroll speed to be accurate | ![todo](https://img.shields.io/badge/todo-red?style=flat-square) |

---

### Phase 2: Server-Driven Data

*Foundational. Every feature built after this benefits from fast loads, even on cold boots. Do it early so new pages don't need to be rewritten later.*

| # | Step | Status |
|:---:|---|:---:|
| 5 | ~~Design background sync strategy~~ Implemented as lazy sync with distributed cache lock (only one serverless instance fetches per cache key, others wait and read cached result) | ![done](https://img.shields.io/badge/done-brightgreen?style=flat-square) |
| 6 | Migrate endpoints to read from DB first | ![done](https://img.shields.io/badge/done-brightgreen?style=flat-square) |
| 7 | Keep live-update loop so data stays fresh for everyone | ![done](https://img.shields.io/badge/done-brightgreen?style=flat-square) |

---

### Phase 3: Quick UI Wins

*Small improvements to ship between bigger efforts.*

| # | Feature | Status |
|:---:|---|:---:|
| 8 | Show **mod badges** on recent top plays (home page) | ![planned](https://img.shields.io/badge/planned-blue?style=flat-square) |
| 9 | Rename "Replay" button to "Watch" + show on mobile | ![planned](https://img.shields.io/badge/planned-blue?style=flat-square) |

---

### Phase 4: Replay Viewer Overhaul

*Big chunk of work, but self-contained. Replay bugs are already fixed in Phase 1, so this is a clean rewrite. Mobile support is high value since a lot of osu! browsing happens on phones and Discord.*

| # | Feature | Status |
|:---:|---|:---:|
| 10 | UI/UX overhaul for the replay page | ![planned](https://img.shields.io/badge/planned-blue?style=flat-square) |
| 11 | Full responsive mobile support for watching replays | ![planned](https://img.shields.io/badge/planned-blue?style=flat-square) |
| 12 | Customizable overlay positions | ![planned](https://img.shields.io/badge/planned-blue?style=flat-square) |
| 13 | Persist BG dim preference locally (per play) | ![planned](https://img.shields.io/badge/planned-blue?style=flat-square) |
| 14 | Finish custom skin support | ![planned](https://img.shields.io/badge/planned-blue?style=flat-square) |

---

### Phase 5: Player Profiles

*Moderate effort, high visibility. Make profiles feel like a destination, not just an osu! mirror.*

| # | Feature | Status |
|:---:|---|:---:|
| 15 | Show **best peak rank** instead of current global rank | ![planned](https://img.shields.io/badge/planned-blue?style=flat-square) |
| 16 | Rethink display of existing osu! stats (country rank, PP, accuracy, play count, play time, 90-day rank history) so the page feels unique | ![planned](https://img.shields.io/badge/planned-blue?style=flat-square) |

---

### Phase 6: Snipes Page

*New feature that builds on the DB infrastructure from Phase 2. Fast from day one.*

| # | Feature | Status |
|:---:|---|:---:|
| 17 | Plan out and implement the snipes tracking page | ![planned](https://img.shields.io/badge/planned-blue?style=flat-square) |

---

### Phase 7: Dan Estimation on Tracker

*Needs the most research. By this point the tracker page is mature and there's experience with beatmap file handling from the replay work.*

| # | Feature | Status |
|:---:|---|:---:|
| 18 | Fetch and analyze beatmap files to estimate Dan difficulty | ![idea](https://img.shields.io/badge/idea-lightgrey?style=flat-square) |
| 19 | Display estimated Dan level (Gamma mid, Delta low, Alpha high) with logo assets | ![idea](https://img.shields.io/badge/idea-lightgrey?style=flat-square) |

---

### Phase 8: Fun Facts Page

*Better with more data flowing through the DB to pull interesting stats from.*

| # | Feature | Status |
|:---:|---|:---:|
| 20 | New page with community stats and fun facts | ![idea](https://img.shields.io/badge/idea-lightgrey?style=flat-square) |

---

### Phase 9: Shareable Replay Videos

*Depends on the replay overhaul being polished. Technically the hardest item (server-side rendering or canvas recording + hosting). Generate a URL that embeds as a playable video in Discord.*

| # | Feature | Status |
|:---:|---|:---:|
| 21 | Shareable replay video links with Discord embed support | ![idea](https://img.shields.io/badge/idea-lightgrey?style=flat-square) |

---

### Phase 10: Go Global (Multi-Country Support)

*Last because it touches everything. All features should be working and stable for Costa Rica first, then generalize. Doing it earlier would slow down every other feature.*

| # | Feature | Status |
|:---:|---|:---:|
| 22 | Country selector in the nav with per-country data caching | ![done](https://img.shields.io/badge/done-brightgreen?style=flat-square) |
| 23 | All data endpoints and pages scoped to chosen country | ![done](https://img.shields.io/badge/done-brightgreen?style=flat-square) |
| 24 | Navbar osu! logo SVG colors dynamically match the selected country's flag | ![done](https://img.shields.io/badge/done-brightgreen?style=flat-square) |

---

### Anytime: Infrastructure

| Item | Status |
|---|:---:|
| Buy **osumtracker.gg** domain (doesn't block anything, but nice to have before sharing widely) | ![todo](https://img.shields.io/badge/todo-red?style=flat-square) |
