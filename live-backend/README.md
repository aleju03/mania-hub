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

## Production (VPS)

Production is **not** the `Dockerfile` (that is an Alpine/musl dev artifact). It is node 22 on
glibc under two systemd units on a 4 GB / 2 vCPU host:

| unit | `LIVE_BACKEND_ROLE` | what it does |
| --- | --- | --- |
| `mania-hub-live-server.service` | `server` | HTTP + SSE + the maps snapshot worker thread |
| `mania-hub-live-worker.service` | `worker` | the job queue, oSC ingest, retention, schema migrations |

Keep the split. libSQL work is synchronous on the calling thread and there are only 2 vCPUs, so
merging the roles would stall HTTP and SSE behind jobs.

### Measured memory (Phase 0 baseline, 4 h window at `f397afa`)

| | steady | observed peak | lifetime high-water |
| --- | --- | --- | --- |
| server | 400-484 MB, flat over 4 h | 923 MB | **1381 MB** — the boot-time GLOBAL farmed-board build (618 MB heap, ~32 s, once per restart) |
| worker | ~300 MB floor | 1625 MB during `refresh_global_maps` (~30 s, ~6/h) | **1822 MB** |
| host | 3.7 GiB, **no swap**; worst coincident ~2503 MB | | |

Both peaks are legitimate work, so a cap below them guarantees an OOM kill at every boot / every
global maps refresh. Note the plan's original arithmetic (per-unit `MemoryMax` = peak + 30-50%,
*and* 750 MiB-1 GiB left outside the services) is unsatisfiable here — it sums to 4.2-4.8 GiB on a
3.8 GiB host. Enforce the aggregate on a shared slice instead, and keep the per-unit ceilings as
runaway protection:

- swapfile **first** (1-2 GiB, `vm.swappiness=10`): with no swap, `MemoryHigh` throttling reclaims
  the 256 MB read-only DB mmaps instead of anonymous heap, which is a latency cliff. Swap here is
  OOM insurance, not capacity.
- then `MemoryHigh` only (server 1500M, worker 1700M) and watch `memory.events` for a week.
- then a `mania-hub.slice` with `MemoryHigh=2700M` / `MemoryMax=3000M`, plus per-unit
  `MemoryMax` (server 1900M, worker 2300M) and `MemorySwapMax`.
- CPU: `CPUWeight` 300 (server) / 60 (worker) so HTTP stays responsive during chart analysis and
  global refreshes. Do not raise job-lane or compression concurrency.
- Do not set `--max-old-space-size` in this pass: the worker legitimately reaches ~1.3 GB heap, so
  any pin below ~1600 MB would crash `refresh_global_maps`. Do not add jemalloc/allocator tuning
  until the glibc `smaps` evidence justifies it.

Restart the **worker first** — it owns schema DDL, and the server role blocks on `waitForSchema`
for up to 60 s. Keep `Restart=on-failure`.

### SQLite tuning

`SQLITE_CACHE_MB` / `SQLITE_MMAP_MB` govern exactly one connection per process (the main `db`).
Everything else is pinned lean in code: the shared rate limiter and the maps snapshot thread carry
their own small settings, and the write, analytics, checkpoint and storage-scan connections were
already lean. Suggested starting point: server `32`/`64`, worker `32`/`0`. Back off toward 48-64 MiB
if latency, CPU or WAL behaviour regresses; both values are ceilings, not committed allocations,
and mmap RSS is file-backed and reclaimable.

### Storage

40 GB disk, ~51% used. The backend warns hourly (`disk_usage_high`) above 70% and treats 85% as
critical; add a host-level `df` check too so alerting survives the app being down. Bound journald
(`SystemMaxUse`, `MaxRetentionSec`) — there is no application log file, journald is the sink.
Keep the SQLite/libSQL file under a backed-up directory, keep WAL on, and take snapshots with
`VACUUM INTO` (what `db:sync-from-vps` does) rather than copying the file. `compact:storage
--vacuum` needs ~2x the DB free and must run with the backend stopped.

### Rollback

Redeploy the previous build and keep the database — migrations are `if not exists` and idempotent,
and no migration drops or rewrites data.

Expose the service behind a reverse proxy with TLS. Forward `/api/*`, `/healthz`, and `/readyz`; keep CORS limited to `ALLOWED_ORIGINS`. Set `LIVE_ADMIN_TOKEN` in production before enabling admin fixture or diagnostic endpoints. Rollback is replacing the service build and keeping the DB; migrations are idempotent for the current schema.
