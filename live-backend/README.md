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
glibc under two systemd units on an 8 GB / 4 vCPU / 75 GB host (Hetzner CX33, rescaled from the
original 4 GB / 2 vCPU box on 2026-08-05):

| unit | `LIVE_BACKEND_ROLE` | what it does |
| --- | --- | --- |
| `mania-hub-live-server.service` | `server` | HTTP + SSE + the maps snapshot worker thread |
| `mania-hub-live-worker.service` | `worker` | the job queue, oSC ingest, retention, schema migrations |

Keep the split. libSQL work is synchronous on the calling thread, so merging the roles would
stall HTTP and SSE behind jobs.

### Memory caps (current)

`MemoryHigh=3000M` on both units (set 2026-08-05 with the 8 GB rescale; runtime drop-ins via
`systemctl set-property`). No `MemoryMax` — `MemoryHigh` throttles instead of killing, and both
units' legitimate peaks (server boot board build, worker `refresh_global_maps`) sit well under
3000M. The frontend `mania-hub-web@` pair keeps `MemoryHigh=500M` each. When retuning, watch
`memory.events` (`high` counter) and remember the server's cgroup usage is mostly *file page
cache* from the SQLite reads — plan against `VmHWM` for anon but expect the cgroup to sit at
whatever cap you give it, because cache expands to fill it. The 4 GB-era plan (slice caps,
per-unit `MemoryMax`, the unsatisfiable peak+30% arithmetic) is retired; see git history if a
downsize ever brings it back.

### Measured memory (Phase 0 baseline, 4 h window at `f397afa`, on the old 4 GB / 2 vCPU host)

| | steady | observed peak | lifetime high-water |
| --- | --- | --- | --- |
| server | 400-484 MB, flat over 4 h | 923 MB | **1381 MB** — the boot-time GLOBAL farmed-board build (618 MB heap, ~32 s, once per restart) |
| worker | ~300 MB floor | 1625 MB during `refresh_global_maps` (~30 s, ~6/h) | **1822 MB** |
| host | 3.7 GiB, **no swap**; worst coincident ~2503 MB | | |

**Those numbers are from `f397afa` — the code before Phases 8-13.** A fresh capture on `d0ef381`
(10 min after the deploy restart) puts the server's VmHWM at **1403 MB** (essentially unchanged, and
still the boot board build) but the worker's at **1984 MB** — above the `MemoryHigh` proposed below
and close to the proposed `MemoryMax`. That boot also ran the Phase 8-13 migrations, so it may be a
one-off rather than the new normal for `refresh_global_maps`. **Re-read both VmHWM values before
applying any cap**, and raise the worker's numbers if 1984 MB persists. Note that cgroup
`memory.peak` (2.3-2.4 G for both) additionally counts file page cache charged to the cgroup and is
inflated by database reads — do not plan heap ceilings against it.

Both peaks are legitimate work; any cap must clear them. Still true on the 8 GB host:

- CPU: `CPUWeight` 300 (server) / 60 (worker) so HTTP stays responsive during chart analysis and
  global refreshes. Do not raise job-lane or compression concurrency without re-measuring.
- Do not set `--max-old-space-size`: the worker legitimately reaches ~1.3 GB heap, so any pin
  below ~1600 MB would crash `refresh_global_maps`. Do not add jemalloc/allocator tuning until
  glibc `smaps` evidence justifies it.

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
