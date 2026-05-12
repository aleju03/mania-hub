# Mania Hub Live Backend

Persistent Node/TypeScript backend for Mania Hub live osu!mania data.

## Local Run

```sh
cd live-backend
npm install
cp .env.example .env
npm run dev
```

The backend listens on `PORT` (`7227` by default), runs migrations on boot, starts a DB-backed job queue, catches up from oSC JSON, and subscribes to the oSC Socket.IO `scores` room at `https://osc.kaysting.dev` with path `/ws`.

Point the frontend at it with:

```sh
LIVE_BACKEND_URL=http://localhost:7227
VITE_LIVE_BACKEND_URL=http://localhost:7227
```

Do not put osu! credentials in frontend env. `OSU_CLIENT_ID` and `OSU_CLIENT_SECRET` are backend-only.

## Verification

```sh
npm run verify
```

Covered flows: fresh migrations, idempotent mocked oSC ingestion, enrichment job creation for unknown users/maps, tracker snapshot, event replay, top-play confirmation, snipe detection, and hard osu! API rate cap.

## Real oSC Smoke

```sh
cd live-backend
npm run smoke:osc
```

For a longer local run, start `npm run dev` for 10 to 20 minutes with `TRACKED_COUNTRIES=CR` and watch `/api/status`. The process should keep oSC JSON below `OSC_JSON_TARGET_PER_MINUTE` and all osu! calls behind the global limiter.

## VPS Trial Notes

Use the included `Dockerfile` or a systemd unit that runs `npm run start` after `npm run build`. Put the SQLite/libSQL file under a backed-up directory such as `/var/lib/mania-hub-live/mania-hub-live.db`, enable WAL, and back up the DB file regularly while the service is stopped or through SQLite-safe snapshots.

Expose the service behind a reverse proxy with TLS. Forward `/api/*`, `/healthz`, and `/readyz`; keep CORS limited to `ALLOWED_ORIGINS`. Set `LIVE_ADMIN_TOKEN` in production before enabling admin fixture or diagnostic endpoints. Rollback is replacing the service build and keeping the DB; migrations are idempotent for the current schema.
