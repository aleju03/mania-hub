# osu!cr - osu!mania Hub

## Project
A Costa Rica-focused osu!mania web app. Not a clone of osu.ppy.sh - it's a custom dashboard for tracking CR mania players, scores, pop-offs, and viewing replays in the browser.

## Tech Stack
- TanStack Start (React 19, Vite 7, file-based routing)
- Tailwind CSS 4 with custom osu! theme (Torus/Venera fonts, HSL color system)
- Framer Motion for animations
- Zustand for client state and persisted client cache
- osu! API v2 via server functions (Client Credentials OAuth)
- osu-parsers for server-side .osr replay parsing

## App Structure
Code lives in `mania-hub/`. Key paths:
- `src/lib/api.ts` - OAuth token cache + osuFetch wrapper (server-only)
- `src/lib/cache.ts` - Client cache TTLs and staleness helpers
- `src/lib/osu.ts` - All createServerFn definitions
- `src/lib/rankings.ts` - Ranking-specific calculations (7d global/CR deltas)
- `src/lib/types.ts` - TypeScript types for osu! API v2
- `src/lib/replay-parser.ts` - Custom .osr parser (unused now, kept as reference)
- `src/lib/beatmap-parser.ts` - Parses .osu files for mania note data
- `src/store.ts` - Shared persisted client cache + live feed state
- `src/components/layout/PageHeader.tsx` - Reusable route header chrome
- `src/components/layout/PageTabs.tsx` - Reusable route tab/filter bar
- `src/components/home/ManiaRain.tsx` - Home page background canvas effect
- `src/components/replay/ReplayCanvas.ts` - Canvas renderer for mania replays
- `src/routes/` - All pages

## Routes
- `/` - Dashboard with previews of CR Top 50, Recent Scores, Pop-offs
- `/rankings` - CR mania top 50 (hardcoded country=CR, no pagination)
- `/scores` - Live score feed polling CR players, filters: All/Ranked/Passed/Failed
- `/popoffs` - Recent PP plays from top 30 CR players, time range filters, pagination
- `/player/$username` - Player profile with stats, rank chart, best/recent scores
- `/replay` - Search player -> browse replays -> watch in-browser with notes + key presses

## API Auth
OAuth credentials in `.env` (gitignored). Client Credentials grant, server-side only.
- Rankings responses are cached server-side for 5 minutes
- User rank histories are cached per-user server-side for 5 minutes
- Replay download uses legacy endpoint: `GET /scores/mania/{id}/download`
- Beatmap files fetched from CDN: `https://osu.ppy.sh/osu/{beatmap_id}`

## Front-End Data Flow
- Shared CR data should flow through `src/store.ts`, not route-local duplicated state.
- `crRankings` is the canonical client-side source for CR player lists used by `/`, `/rankings`, `/scores`, and `/popoffs`.
- Route components should prefer "show cached data immediately, refresh in background" over clearing UI back to skeletons.
- TTL decisions live in `src/lib/cache.ts` so freshness policy stays centralized.
- Ranking math helpers belong in `src/lib/rankings.ts`, not inline in route files.
- Reusable page chrome belongs in `src/components/layout/` so routes mostly describe behavior, not shell markup.

## Style Rules
- Mania-only app. All API calls use mode=mania. No mode selector anywhere.
- No em dashes. Use hyphens (-) instead.
- No emojis in UI. Use osu! icon SVGs from `/images/icons/`.
- osu! logo in nav has Costa Rica flag colors (CSS masked into logo shape).
- Heavy data fetching should happen client-side (not in route loaders) to avoid blocking navigation. Loaders should be fast (cached rankings call at most).

## Maintenance Notes
- Prefer extracting helpers/components once a route starts mixing page shell, data loading, and several local subcomponents.
- Avoid duplicating `getRankings({ country: "CR" })` fetch logic in new places. Reuse the shared cache/store pattern.
- If a new feature needs cache persistence across navigations, add it to `src/store.ts` with a matching TTL entry in `src/lib/cache.ts`.

## Running
```
cd mania-hub
npm run dev
```
Runs on http://localhost:3000. Requires `.env` with `OSU_CLIENT_ID` and `OSU_CLIENT_SECRET`.
