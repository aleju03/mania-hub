# Farm Helper load-performance implementation plan

## Objective

Reduce the time from selecting/opening a player to seeing usable Farm Helper recommendations, without changing recommendation eligibility, ordering, feedback behavior, or the frontend's full-list filters.

The primary target is a stored player whose Farm Helper snapshot is not already cached. A never-seen player is a separate cold-mint case because it must fetch the osu! user and best-200 scores.

## Measured baseline

Measurements were taken against the local production-sized database (`mania-hub-live.db`, approximately 6.5 GB) and the running backend.

| Case | Observed time |
| --- | ---: |
| First/cold `any + gain + limit=200` HTTP request | 6.33 s |
| Immediate repeat of the same request | 121 ms |
| Uncached recommendation build with peer-pool caches warm | 515 ms |
| Stored-profile resolution with filesystem cache warm | 115 ms |
| `attachNoteBpms` within that profile resolution | 104 ms |
| Brotli response for 125 recommendations | 27 KB |

The measured recommendation build read approximately 78,471 4K and 8,952 7K peer farm rows. Those reads accounted for roughly 360 ms of SQL/result materialization once the database and peer pools were warm.

The 6.33-second request was only timed end-to-end, so it must not be attributed to one stage without new instrumentation. The current cold path contains several operations capable of stalling independently: full profile decoration, awaited queue/database writes, peer-pool initialization, the peer farm-row scan, and (for an unknown player) osu! API work.

## Success criteria

For stored players on production-sized data:

- Cache-hit backend time: p95 below 50 ms.
- Uncached request with warm process-level pools: p50 below 750 ms and p95 below 1.5 s.
- First Farm Helper request after a backend restart: p95 below 2 s, excluding a never-seen player's osu! cold mint.
- No optional queue or observability write is awaited by the page-serving path.
- Recommendation IDs, speed buckets, reasons, ordering, benchmark pp, estimated gain, and feedback filtering remain unchanged for a fixed database snapshot.

For never-seen players:

- Record profile mint, osu! limiter wait, and recommendation-build time separately.
- Do not hold the stored-player target responsible for external osu! latency.
- If cold-mint p95 remains above 4 s, design a pending/warming response as a follow-up rather than weakening recommendation correctness.

## Non-goals

- Do not reduce `SNAPSHOT_LIMIT` from 200 as the primary optimization. The frontend uses the full returned list for reason counts, searching, sorting, and pagination, while only rendering 20 rows at a time.
- Do not reduce the peer cohort, remove a keymode run, or loosen model gates for speed.
- Do not make the full recommendation build an SSR-blocking route loader; a slow backend must not delay delivery of the entire HTML document.
- Do not introduce a large permanent in-memory farm index until measurements show that the lower-risk work is insufficient.

## Phase 1: add stage-level evidence

### Backend timings

Add an optional request timing collector to the Farm Helper serving path. It must have near-zero overhead when unused and must not alter the snapshot payload.

Instrument these stages:

1. Raw-key/user identity resolution.
2. Stored profile read and hydration.
3. Farm Helper snapshot cache lookup (`hit`, `miss`, or `expired`).
4. Feedback read/reconcile.
5. Player-skill read and enqueue scheduling.
6. Per-keymode peer-pool selection.
7. Per-keymode subject/peer shape reads.
8. Per-keymode farm-row read and aggregation, including peer count and returned row count.
9. Per-keymode metadata/feasibility reads and candidate scoring.
10. Merge/rank/top-peer hydration.
11. Avatar-accent enrichment and response serialization/compression where practical.

Implementation notes:

- Add an optional timing callback/collector to `getFarmHelperSnapshot` options and thread it through `buildSnapshot`/mode runs only where needed.
- In `live-backend/src/http/snapshots.ts`, append stage values to `Server-Timing` instead of replacing the existing `app;dur=...` value.
- Include the stage breakdown in `slow_http_request` logging for `/api/snapshots/farm-helper` when total duration exceeds two seconds.
- Log numeric user ID, keymode, view, limit, cache state, peer counts, and row counts. Do not log profile payloads or score data.
- Distinguish stored-profile resolution from osu! cold mint in both logs and timing headers.

### Reproducible benchmark

Add a read-only Farm Helper benchmark command or script that accepts a list of user IDs and reports:

- profile resolution time;
- total and per-mode build time;
- SQL query count and row count;
- recommendation count;
- serialized and compressed response sizes;
- cold-process, uncached-subject, and immediate-repeat results.

Use at least these subject shapes in the benchmark set:

- a typical 4K main around 10k pp;
- a 7K main;
- a mixed 4K/7K player;
- a sparse/top-ranked player that triggers the nearest-peer fallback;
- a player with missing/stale skill ratings;
- a stored player with active Farm Helper feedback;
- a never-seen player, measured in a separate external-I/O section.

The benchmark must be read-only by default. Any optional cache warming or server HTTP mode must be explicit.

### Phase 1 exit condition

Deploy the timing-only change and collect enough slow requests to identify p50/p95 stage costs. Keep the local 6.33-second reproduction as a regression case, but use production stage data to choose later database work.

## Phase 2: remove avoidable cold-path stalls

### 2.1 Skip note-BPM decoration for Farm Helper

Farm Helper does not consume `beatmap.note_bpm`, but `getPlayerProfileSnapshot` currently calls `attachNoteBpms` for every served snapshot.

Implement the smallest safe specialization first:

- Add a profile-snapshot option such as `includeNoteBpms?: boolean`, defaulting to `true` so profile pages keep their current response.
- Have Farm Helper resolve the profile with `includeNoteBpms: false`.
- Keep score projection, recent tracked-score overlay, key count, difficulty rating, mods, judgements, and timestamps unchanged.
- Add a test proving Farm Helper resolution does not query note BPM while the normal profile path still attaches it.

Only introduce a broader `farm-helper` hydration projection if timing shows meaningful cost remains after skipping note BPM. A broader projection may skip presence, score-user hydration, beatmapset metadata, and unrelated beatmap fields, but it must reuse the existing top-play/recent-score projection rules rather than fork them.

### 2.2 Make skill recomputation enqueue non-blocking for Farm Helper

`getPlayerSkillBreakdown` currently awaits `enqueuePlayerSkills` when a row is missing, stale, failed, or superseded. Farm Helper only needs the stored breakdown for the current response; it does not need to wait for a queue write or immediately render queue position.

Implement an explicit enqueue mode while preserving other callers:

- Add an option equivalent to `enqueueMode: "await" | "detached" | "none"`.
- Preserve the current default (`"await"`) until each caller is audited.
- Use `"detached"` from Farm Helper.
- Detached enqueue failures must be logged and must not reject the snapshot.
- A subsequent request must retry naturally if the detached enqueue was lost.
- Keep a ready-but-stale skill row usable for current scoring; keep the existing missing-model fallback behavior.

Test with a queue whose promise is deliberately unresolved: Farm Helper must still return a snapshot, while the normal awaited mode must preserve its contract.

### 2.3 Remove calibration persistence from the serving critical path

Proxy calibration is needed for recommendation correctness, but persisting its already-computed value to `live_meta` is observability-only. The current call awaits that write during the first pool initialization.

Change the flow so it:

1. computes calibration;
2. populates the in-memory calibration cache;
3. returns calibration to the request;
4. schedules persistence separately on the dedicated serving write connection/queue with a short best-effort budget.

Never run this optional write on the page-serving read connection. If no dedicated write path is available, skip persistence; the in-memory value remains authoritative for serving.

Add tests showing a blocked/failing persistence operation cannot delay or fail peer selection.

### Phase 2 exit condition

- No optional write appears in the request's critical-path timing.
- Stored-profile resolution no longer includes note-BPM timing.
- Recommendation snapshot shape tests and existing profile tests pass unchanged.
- Re-run the cold-process benchmark before changing cache or peer aggregation behavior.

## Phase 3: make cache hits genuinely cheap and coalesce misses

### 3.1 Check the Farm Helper cache before full profile hydration

The current cache key is canonical user ID plus keymode, view, and limit, but the user ID is only known after full profile resolution. Add a bounded per-DB identity-alias cache:

- Key: normalized raw user key (numeric ID or lowercase username).
- Value: canonical user ID and expiry.
- Populate aliases for the original raw key, canonical numeric ID, and current username after a successful resolution.
- Keep the canonical snapshot cache keyed by user ID so username and numeric requests share entries.
- On an alias hit, check the canonical snapshot cache before reading/decompressing the profile snapshot.
- An expired/missing snapshot may still reuse the identity alias and then perform normal profile resolution/build work.

Invalidation requirements:

- Feedback set/clear and ingest auto-resolution must continue evicting every snapshot variant for the user.
- Alias entries may survive snapshot invalidation because the osu! user ID is stable.
- Admin user-data wipe must clear both snapshot and alias caches.
- Username changes must add the new alias; old aliases may age out naturally.
- Bound aliases by entry count and TTL so arbitrary failed searches cannot grow memory.

### 3.2 Coalesce identical in-flight work

Add a per-DB in-flight promise map for snapshot builds.

- Coalesce by canonical user ID, keymode, view, and limit after identity resolution.
- Optionally use a short raw-key in-flight map around first-time identity resolution so simultaneous username requests do not duplicate an osu! cold mint.
- Always remove promises in `finally`.
- One disconnected/aborted HTTP client must not cancel a build still needed by another waiter.
- Errors must fan out to all waiters but must never be cached as successful snapshots.

Add concurrency tests proving ten simultaneous identical requests execute one build and that a failed build is retried by the next request.

### 3.3 Reconsider cache cardinality only with memory measurements

The current cache is capped at 64 snapshot variants. Before increasing it:

- measure average and p95 retained heap per 200-row snapshot;
- report eviction rate and hit rate;
- account for one player occupying multiple keymode/view entries;
- prefer a byte-bounded LRU over a much larger entry-only limit.

Do not add prepared/compressed-response caching unless timing proves serialization material. It measured at only a few milliseconds for the sampled 180 KB JSON response.

### Phase 3 exit condition

- A true cache hit does not execute profile hydration, skill reads, peer selection, or recommendation scoring.
- Cache-hit backend p95 is below 50 ms.
- Concurrent miss tests demonstrate single-flight behavior.
- Feedback and wipe invalidation tests pass for all aliases and variants.

## Phase 4: reduce uncached recommendation work without changing results

### 4.1 Remove repeated per-candidate sorting

Preserve the exact weighted-quantile formula while sorting each candidate's benchmark distribution once.

- Build one validated, pp-sorted weighted distribution per candidate.
- Query median, p75, and missing-map quantile from that prepared distribution.
- Compute peer recency once and reuse it for scoring and response fields.
- Reuse pp ordering for top-peer selection, or maintain the top four incrementally during aggregation.
- Avoid sorting `playedAtMs` twice; maintain the newest three timestamps incrementally if that is simpler and measurably faster.

Before merging, run golden comparisons against representative snapshots. Floating-point results and tie ordering must remain stable.

### 4.2 Benchmark database alternatives for the peer farm-row scan

Do not commit a large index based on query-plan intuition alone. On a copy/staging database, compare:

1. Current `country_maps_farmed_scores` user-index scan.
2. A covering variant of the current user index.
3. `global_maps_farmed_scores` with a user-first index and `source_updated_at` used as the current `updated_at` fallback.
4. A two-stage query that identifies qualifying candidate lanes in SQLite, then materializes detailed rows only for those candidates.

For every alternative, record:

- wall time and CPU time;
- rows materialized into JavaScript;
- database/index size increase;
- warm and cold filesystem-cache behavior;
- exact snapshot equivalence.

The global projection is attractive because it is already one row per beatmap/player and carries pp, mods, played time, and accuracy, but it currently lacks a user-first index. Confirm inactive-user and revision semantics before switching sources.

### 4.3 Escalation option: a compact user-major Farm Helper board

If SQL alternatives cannot meet the uncached p95 target, design a dedicated packed index rather than caching object-heavy rows.

Suggested layout:

- user IDs with start/count offsets;
- flat beatmap ID, pp, mods dictionary index, played time, source-updated time, and accuracy arrays;
- data sourced from the deduplicated global farmed projection;
- disk snapshot and revision validation modeled after the existing global map-major farmed board;
- explicit memory budget and cache statistics.

The existing global board is map-major and lives with the maps serving path, so it cannot simply be imported as-is for user-neighborhood queries. Account for process/thread ownership, revision patching, and the additional resident memory before implementation.

### Phase 4 exit condition

- Uncached stored-player requests meet the p50/p95 targets.
- A fixed-input golden suite shows no recommendation changes.
- New indexes or packed structures have documented disk/RSS cost and invalidation behavior.

## Phase 5: improve perceived frontend loading

Do this after the backend critical path is bounded.

- Keep a module-level, TTL-bound client snapshot/promise cache so returning from a Farm Helper map detail does not repaint the full initial skeleton.
- Start a shared prefetch on hover/focus/pointer-down for the signed-in player and recent-player buttons.
- When selection metadata is already known, render the subject header immediately and show a board skeleton beneath it instead of blocking the entire player surface on recommendations.
- Preserve the current post-feedback cache-busting epoch and abort behavior.
- Do not issue a prefetch for every search result or every anonymous picker visit.
- Do not SSR-block on the full snapshot. If direct URL first paint still needs improvement, use a strictly budgeted/deferred fetch that falls back to the existing client request.

Frontend acceptance checks:

- One network request per request key, including React development Strict Mode.
- No stale subject/keymode/view snapshot is presented as current.
- Back navigation from map detail restores the board without a full-page loading state.
- Feedback mutation still forces a fresh subject snapshot and clears incompatible cached views.

## Correctness and regression test matrix

Run existing Farm Helper, profile, queue, and HTTP tests, then add focused coverage for:

- cache hit before profile hydration;
- numeric-ID and username aliases sharing one canonical cache entry;
- username change and alias expiry;
- feedback and wipe invalidation;
- in-flight success, failure, and retry;
- detached skill enqueue behavior;
- calibration persistence failure/contention;
- note BPM skipped only for Farm Helper;
- exact snapshot equality before/after sorting or SQL changes;
- 4K, 7K, mixed, sparse fallback, popular view, feedback marks, and missing skill models;
- browser request deduplication and back-navigation cache restoration.

Verification commands:

```sh
cd live-backend
npx vitest run tests/farm-helper.test.ts tests/farm-helper-shape.test.ts tests/farm-helper-kernel.test.ts tests/farm-helper-feedback.test.ts tests/player-profiles.test.ts tests/queue-debounce.test.ts
npx tsc --noEmit

cd ..
npx vitest run src/routes/-farm-helper.test.ts
npx tsc --noEmit
```

Adjust the frontend test path to the actual Farm Helper route test file if one is introduced under a different name. Before release, run the full backend `npm run verify` and root `npm run test` suites.

## Rollout order

1. Deploy instrumentation only and capture production stage timings.
2. Deploy note-BPM skipping plus detached optional writes.
3. Deploy identity aliasing and single-flight cache behavior.
4. Re-measure before touching peer aggregation.
5. Deploy repeated-sort cleanup.
6. Benchmark and choose a SQL/index alternative, guarded by exact-output tests.
7. Build the packed user-major index only if targets are still missed.
8. Add frontend prefetch/shell improvements after backend latency is predictable.

Each phase should be independently revertible. Keep slow-request timing through at least one full release after the final optimization so regressions remain attributable.

## Completion checklist

Measured results in `farm-helper-load-performance-results.md`.

- [x] Stage-level `Server-Timing` and slow-log breakdown deployed.
- [x] Read-only benchmark covers representative player shapes (`npm run bench:farm-helper`).
- [x] Farm Helper skips note-BPM decoration.
- [x] Skill recompute enqueue cannot block Farm Helper responses.
- [x] Calibration observability persistence is off the serving critical path.
- [x] Snapshot cache is checked before full profile hydration.
- [x] Identical misses are single-flight.
- [x] Cache invalidation covers feedback, ingest resolution, and admin wipe.
- [x] Repeated candidate sorts are removed with exact-output tests.
- [x] Peer-row strategy meets uncached p95 target with documented storage cost.
      No index was added: the alternatives were benchmarked, the targets are
      already met, and the only faster option costs 110-150 MB on a database
      near its cap. See the Phase 4.2 table in the results doc.
- [x] Frontend restores/prefetches without duplicate or stale requests.
- [x] Full test/typecheck suites pass (1201 backend, 2514 root).
- [ ] Production p50/p95 targets are verified after rollout.
