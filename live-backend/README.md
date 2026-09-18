# Mania Hub Live Backend

Node/TypeScript service that ingests osu!mania scores, keeps SQLite projections, runs a DB-backed job queue, and streams updates to browsers over SSE.

## Local run

```sh
cd live-backend
npm install
cp .env.example .env
npm run dev
```

The backend listens on `PORT` (`7227` by default), runs migrations on boot, starts the job queue, and polls the osu! API for recent scores of the tracked countries.

Point the frontend at it with:

```sh
LIVE_BACKEND_URL=http://localhost:7227
VITE_LIVE_BACKEND_URL=http://localhost:7227
```

`OSU_CLIENT_ID` and `OSU_CLIENT_SECRET` are backend-only; never put them in the frontend env.

## Verification

```sh
npm run verify
```

Runs the Vitest suite and a type check. Covered flows include fresh migrations, idempotent ingestion, enrichment job creation, tracker snapshots, event replay, top-play confirmation, snipe detection, and the osu! API rate cap.

## Production

Production runs `dist/` under two systemd units, split by `LIVE_BACKEND_ROLE`:

| unit | role | what it does |
| --- | --- | --- |
| `mania-hub-live-server.service` | `server` | HTTP, SSE, the maps snapshot thread |
| `mania-hub-live-worker.service` | `worker` | job queue, ingest, retention, schema migrations |

Keep the split: libSQL work is synchronous on the calling thread, so a single process would stall HTTP and SSE behind jobs. Restart the worker first; it owns schema DDL and the server waits for the schema on boot. `deploy/systemd/` holds the socket-activation drop-in that keeps the port bound across restarts.

Operational notes:

- Do not pin `--max-old-space-size`; the worker legitimately uses over 1 GB of heap during global map refreshes.
- `SQLITE_CACHE_MB` and `SQLITE_MMAP_MB` govern one connection per process; other connections carry their own small settings in code.
- The backend warns above 70% disk usage and treats 85% as critical. There is no application log file; logs go to stdout as JSON.
- Take database snapshots with `VACUUM INTO` rather than copying the file. `compact:storage --vacuum` needs roughly twice the DB size free and runs with the backend stopped.
- Rollback is redeploying the previous build and keeping the database. Migrations are idempotent and never drop or rewrite data.

Put the service behind a reverse proxy with TLS, forward `/api/*`, `/healthz`, and `/readyz`, and keep CORS limited to `ALLOWED_ORIGINS`. Set `LIVE_ADMIN_TOKEN` before enabling admin endpoints.

The `Dockerfile` is a local trial image, not the production deployment.
