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
- `VITE_POSTHOG_KEY` - PostHog project API key (client-side capture)
- `POSTHOG_PERSONAL_API_KEY` / `POSTHOG_PROJECT_ID` - required for the dev-only `/admin/monitor` dashboard
- `VITE_DEV_MODE` - enables dev-only features when set

### Commands

| Command | Description |
|---|---|
| `npm run dev` | Dev server on port 3000 |
| `npm run build` | Production build |
| `npm run test` | Run tests (Vitest) |
| `npm run db:init` | Initialize Turso DB from schema |
| `npm run db:inspect` | Open interactive Turso shell |