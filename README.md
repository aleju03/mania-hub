# osu!mania Hub

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

> Brainstormed ideas and planned work, not in strict priority order.

### Bug Fixes

| Issue | Status |
|---|:---:|
| Some plays missing the **+n PP** display on score cards | `todo` |
| Name color calculation wrong (Randy = blue, BabyIan = pink) | `todo` |
| Replay: accuracy not accurate at end of play | `todo` |
| Replay: changing BG dim resets the play | `todo` |

---

### Replay Viewer: Major Overhaul

The replay viewer is getting a big upgrade across UX, mobile, and customization.

| Feature | Status |
|---|:---:|
| UI/UX overhaul for the replay page | `planned` |
| Full responsive mobile support for watching replays | `planned` |
| Customizable overlay positions | `planned` |
| Persist BG dim preference locally (per play) | `planned` |
| Finish custom skin support | `planned` |
| Rename "Replay" button to "Watch" + show on mobile | `planned` |

**Post-overhaul stretch goal:**

| Feature | Status |
|---|:---:|
| Shareable replay videos - generate a URL that embeds as a playable video in Discord and other platforms | `idea` |

---

### Performance: Server-Driven Data

**Goal:** Read most/all data from the DB instead of hitting the osu! API on every request. The server keeps itself up to date in the background, so every user (even on first cold boot) gets fast load times.

| Step | Status |
|---|:---:|
| Design background sync strategy (server polls API, writes to Turso) | `planned` |
| Migrate endpoints to read from DB first | `planned` |
| Keep live-update loop so data stays fresh for everyone | `planned` |

---

### Player Profiles (`/player/`)

| Feature | Status |
|---|:---:|
| Show **best peak rank** instead of current global rank | `planned` |
| Rethink display of existing osu! stats (country rank, PP, accuracy, play count, play time, 90-day rank history) so the page feels unique vs. the official profile | `planned` |

---

### Home Page & Score Cards

| Feature | Status |
|---|:---:|
| Show **mod badges** on recent top plays | `planned` |

---

### New Pages

| Page | Description | Status |
|---|---|:---:|
| **Snipes** | Plan out and implement the snipes tracking page | `planned` |
| **Fun Facts** | New page with community stats and fun facts | `idea` |

---

### Dan Estimation on Tracker

Show estimated Dan level (e.g. Gamma mid, Delta low, Alpha high) per player on the `/tracker` page, with Dan logo assets for each tier.

- Requires fetching and analyzing the actual beatmap files to estimate Dan difficulty
- Display Dan badge/logo next to player scores or as a dedicated column
- Needs research into how to reliably classify Dan tiers from beatmap data

Status: `idea`, needs research

---

### Go Global: Multi-Country Support

Open the app up so it works for **any country**, not just Costa Rica.

- Country switcher in the UI (needs UX design)
- Navbar osu! logo SVG colors dynamically match the selected country's flag
- All data endpoints scoped to the chosen country

Status: `idea`, needs planning

---

### Infrastructure

| Item | Status |
|---|:---:|
| Buy **osumtracker.gg** domain | `todo` |
