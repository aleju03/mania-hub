# Fix list — worker memory + stuck jobs (observed on VPS, 2026-07-05 ~19:00 CST)

Context: this box (prod VPS, 3.8GB RAM, **no swap**) runs the live backend as two
systemd services: `mania-hub-live-server` (~230MB, fine) and `mania-hub-live-worker`
(job queue). After the 18:49 deploy of `ffc52e6`, the worker peaked at **3.06GB**
(`systemctl show mania-hub-live-worker -p MemoryPeak`) during the boot-time
`refresh_global_maps` job and settled at ~1.9GB RSS. `NODE_OPTIONS=--max-old-space-size=2600`
allows this, but a 3GB spike on a 3.8GB swapless box is one growth spurt away from
the OOM killer taking the worker down. Items ordered by priority.

## 1. Make the GLOBAL maps aggregation memory-bounded (the OOM risk)

**Evidence:** `refresh_global_maps` ran at worker boot (18:50:25 → 18:52:05, ~100s)
and coincided with the 3.06GB memory peak. The GLOBAL row in `country_maps_snapshots`
is **57MB of JSON** (`payload_json`) vs ~2.8MB per country — it only grows as more
countries activate. Building it apparently materializes many country snapshots
(parsed) plus the full aggregate plus its `JSON.stringify`, all at once. This is the
same hot spot as the earlier event-loop-freeze incident (huge GLOBAL snapshot).

**Where:** `live-backend/src/features/maps.ts` — the global rollup path behind the
`refresh_global_maps` job (see `enqueueGlobalMapsRefresh` callers in
`live-backend/src/workers.ts`).

**Fix direction:**

- Aggregate incrementally: load/parse one country snapshot at a time, fold it into a
  compact accumulator (plain maps of primitives, not retained parsed JSON trees),
  release each country before the next.
- Cap the global snapshot's contents (top-N per bucket) if the payload doesn't need
  everything — 57MB serialized means multi-hundred-MB as live objects.
- If stringify of the final object is itself a spike, serialize in chunks.
- Add a `logInfo` with `process.memoryUsage().heapUsed` before/after the job so
  regressions are visible in journald.

**Verify:** `cd live-backend && npm test && npx tsc --noEmit`; then run the job
locally against a synced DB (`npm run live-db:update`) and watch RSS — target well
under 1.5GB peak. Consider lowering `--max-old-space-size` afterwards so a future
regression fails loudly in dev instead of OOMing prod.

## 2. `seed_snipe_board` hangs on EVERY attempt and hits the 10-min watchdog

**Evidence (journald, worker unit):** watchdog kills at 18:42:11 (job 1858716),
19:00:31 (job 1851739, attempt 2), across a process restart — different jobs, same
outcome: `job watchdog: seed_snipe_board still running after 600000ms`. Job 1851840
was running as of 19:00:33. Dedupe keys look like `snipe-seed:CR:<beatmapId>:normal:lazer`.
There are ~207 more `seed_snipe_board` jobs sitting in `deferred_pressure`. Since
retries are infinite with no max-attempts, a job that can never finish inside 10
minutes loops forever and each abandoned invocation keeps running detached (see #3),
burning osu! API budget and memory.

**Where:** the snipe seeding handler — `live-backend/src/features/snipes.ts` (job
type `seed_snipe_board`, lane `snipe-seed` in `live-backend/src/workers.ts`).

**Fix direction:**

- First diagnose *why* it takes >10 min now: most likely osu! API token-bucket
  starvation (~45/min shared across all lanes; check `api_call_log` around those
  windows) or a board with far more lanes/pages than the job was designed for.
- Then make it incremental like other long jobs: seed in small batches and
  self-chain (re-enqueue with a cursor in the payload) so each invocation finishes
  in well under 10 minutes. Add progress logging (pages fetched / rows written).
- Sanity-check whether one beatmap's seed legitimately needs this much API work; if
  a recent change (e.g. lazer boards) multiplied the fetch count, cap it.

**Verify:** backend tests + tsc; then watch journald for `seed_snipe_board`
`job_done` lines actually appearing.

## 3. Watchdog abandons stuck jobs but they keep running (zombies)

**Evidence:** by design (`live-backend/src/workers.ts:42-49`), the watchdog only
rejects the lane's await; the stuck promise keeps running detached and its retry can
run concurrently with it. Correct (idempotent upserts) but each zombie holds memory
and osu! API budget — with #2 firing every ~10 minutes, zombies accumulate until
they finish or the process restarts.

**Fix direction:** thread an `AbortSignal` into job handlers (at minimum the long
ones: `seed_snipe_board`, `refresh_user_maps_farmed_scores`, `refresh_global_maps`,
`osc_backfill`), abort it when the watchdog fires, and check `signal.aborted` at
batch/page boundaries so abandoned invocations actually stop. Keep the existing
fail-with-backoff path unchanged.

## 4. `refresh_user_maps_farmed_scores` also hit the watchdog

**Evidence:** 18:49:39, job 1865137, same 600000ms watchdog message, on the
pre-restart process. Plus **1305** jobs of this type in `deferred_pressure` (of 2394
total deferred). Likely the same root cause as #2 (API starvation / oversized units
of work). Fix alongside #2: measure duration, shrink the per-invocation batch,
self-chain.

## 5. Queue pressure backlog — check it drains

**Evidence:** `jobs` table: 2394 `deferred_pressure` (1305 maps-farmed, 851
reconcile-recent, 207 snipe-seed), 95 queued, 25 failed. Pressure shedding is
by design (`live-backend/src/jobs/queue.ts`), but with #2/#4 clogging their lanes
the deferred set may never drain. After fixing the above, confirm
`deferred_pressure` count trends down (re-run the group-by-status query); if types
starve indefinitely, revisit the pressure thresholds.

## Useful commands for whoever picks this up (run on the VPS)

```bash
systemctl show mania-hub-live-worker -p MemoryCurrent,MemoryPeak
journalctl -u mania-hub-live-worker --since "-1 hour" -q | grep -E "watchdog|job_failed"
sqlite3 live-backend/data/mania-hub-live.db "select status,count(*) from jobs group by status;"
sqlite3 live-backend/data/mania-hub-live.db "select country, round(length(payload_json)/1048576.0,1) mb from country_maps_snapshots order by 2 desc limit 5;"
```

Minimum verification for backend changes: `cd live-backend && npm test && npx tsc --noEmit`.
