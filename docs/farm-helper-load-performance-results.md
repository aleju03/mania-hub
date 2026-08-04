# Farm Helper load-performance results

Measured outcome of `farm-helper-load-performance-plan.md`. All numbers come
from the local production-sized database (`mania-hub-live.db`, ~6.9 GB) on
2026-08-03, via `npm run bench:farm-helper` (in-process, read-only) and `curl`
against the local backend for end-to-end figures.

Reproduce with:

```sh
cd live-backend
npm run bench:farm-helper -- --label before
# ...change...
npm run bench:farm-helper -- --label after
```

## Headline

| Case | Before | After |
| --- | ---: | ---: |
| Cache hit (backend app time) | 113 ms | **< 1 ms** |
| Cache hit (end-to-end HTTP) | 112-123 ms | **1.4-2.3 ms** |
| Uncached, warm pools (median of 5 subject shapes) | 701 ms | **595 ms** |
| Uncached, warm pools (slowest shape) | 801 ms | **644 ms** |
| Cold process, first build | 808 ms | **666 ms** |
| Optional writes on the serving read connection | 2 | **0** |

Against the plan's success criteria for stored players:

- Cache-hit p95 below 50 ms: **met** (sub-millisecond).
- Uncached p50 below 750 ms / p95 below 1.5 s: **met** (279-644 ms).
- First request after a restart below 2 s: **met** (666 ms).
- No optional queue or observability write awaited by the serving path: **met**.
- Recommendations unchanged: **verified**, see [Output equivalence](#output-equivalence).

Note the plan's original 6.33 s cold-request baseline was not reproducible in
this session; a warm OS filesystem cache put the same request at 808 ms before
any change. The 6.33 s figure is best read as a cold-disk case, so the relative
improvements below are the load-bearing numbers, not the absolutes.

## Per-stage breakdown

Uncached build, median run, milliseconds. `farm_rows` is the peer farmed-score
read and aggregation; `profile` is stored-profile resolution and hydration.

| Subject shape | profile (before → after) | peer_pool | farm_rows | score | total (before → after) |
| --- | ---: | ---: | ---: | ---: | ---: |
| 4K main ~10k pp | 116 → 6 | 3 → 2 | 441 → 466 | 48 → 40 | 617 → 532 |
| 7K main | 113 → 5 | 2 → 2 | 572 → 596 | 36 → 25 | 733 → 644 |
| Mixed 4K/7K | 115 → 7 | 2 → 1 | 241 → 233 | 53 → 37 | 418 → 279 |
| Top-ranked (nearest-peer fallback) | 115 → 7 | 4 → 3 | 547 → 552 | 30 → 24 | 701 → 595 |
| No skill model | 115 → 5 | 5 → 1 | 614 → 579 | 58 → 41 | 801 → 636 |

The `farm_rows` column is unchanged by design (see Phase 4.2 below); its
run-to-run spread is roughly ±5%.

On a cache hit the entire request used to be the `profile` stage. It is now
nothing at all: the identity alias resolves the canonical user id before any
hydration, so a hit does zero SQL.

## What produced each win

| Change | Effect |
| --- | --- |
| Skip note-BPM decoration for Farm Helper (2.1) | `profile` stage 115 ms → 6 ms on every request |
| Identity alias cache before hydration (3.1) | Cache hits 113 ms → < 1 ms |
| Single-flight builds (3.2) | N simultaneous identical requests do one build |
| Detached skill enqueue (2.2) | Queue write no longer in front of the response |
| Calibration persistence off the read connection (2.3) | The 2 cold-path writes are gone |
| Prepare each candidate's distribution once (4.1) | `score` stage down 20-30% |

## Phase 4.2: peer farm-row read strategies

Measured on the same database with a realistic 451-peer 4K cohort (89,498
rows). Recorded here so the next person does not have to re-derive it.

| Strategy | Warm wall time | Rows |
| --- | ---: | ---: |
| Current: `country_maps_farmed_scores` user index + `is_active` guard | 345 ms | 89,298 |
| Same, without the `is_active` guard | 331 ms | 89,498 |
| **Index-only columns (`beatmap_id`, `user_id`, `pp`)** | **151 ms** | 89,498 |
| `global_maps_farmed_scores` user-first (no such index exists) | 484 ms | 89,536 |
| Current, driven by `json_each` instead of an IN list | 333 ms | 89,498 |

Findings:

- The cost is the table lookup, not the index scan. Selecting only the three
  columns the existing `idx_country_maps_farmed_scores_user` already covers is
  **2.2x faster**; the remaining columns (`mods_json`, `played_at`,
  `updated_at`, `accuracy`) cost ~185 ms in row lookups.
- **The global projection is not a shortcut.** It was attractive because it is
  one row per (beatmap, player), but the per-country table barely duplicates
  for real cohorts (89,498 rows vs 89,298 distinct pairs), so switching source
  saves ~0.2% of rows while losing the user-first index and `updated_at`.
- JavaScript parsing is not the bottleneck: 179k `Date.parse` calls cost 26 ms
  and mods `JSON.parse` 8 ms. Asking SQLite for integer epochs via
  `unixepoch()` changes nothing (345 ms) and would lose millisecond precision.
- Column payload is small: across 89,498 rows, `mods_json` is 327 KB with only
  52 distinct values, `played_at` 1.8 MB, `updated_at` 2.1 MB.

**Decision: no covering index was added.** The only strategy that would help is
a covering index over all seven columns on a 1.57M-row table, costing an
estimated 110-150 MB on a database already at 6.9 GB against a ~10 GB cap and
an 8 GB compaction target, and slowing every farmed-score write. The plan's
Phase 4 targets are already met without it (p50 595 ms against a 750 ms
target), and both the plan's non-goals and 4.2 itself say not to buy a large
index until the cheaper work proves insufficient. If the uncached p95 ever
regresses past target, this is the next lever and the numbers above are the
justification.

Phase 4.3 (packed user-major board) was not implemented, for the same reason.

## Output equivalence

The recommendation output is byte-identical. Verified with
`npm run golden:farm-helper`, which dumps full snapshots for 12 stored subjects
across 3 keymodes and 2 views:

```
72 snapshots, 8503 recommendations, 12 subjects
identical to before.json across 72 snapshots
```

Run the two dumps close together: the live database ingests continuously, and
a dump taken an hour apart drifts by a cent on a handful of peer quantiles.

Backed in tests by `live-backend/tests/farm-helper-load.test.ts`, which checks
the prepared-once weighted distribution against a verbatim copy of the
per-call implementation it replaced, and the incremental top-peer selection
against a stable descending sort.

## Review outcome

An adversarial review (four reviewers by dimension, every finding independently
verified by a skeptic) raised seven findings; five survived verification and
were fixed. All five were introduced by this work.

| Finding | Fix |
| --- | --- |
| The identity-alias map put user ids and usernames in one namespace. osu! usernames may be entirely numeric and the resolver tries a raw key as a username *before* as an id, so aliasing `String(userId)` could answer a request for the account *named* "5092" with the board of account *id* 5092. The verifier found two live collision pairs in the local database. | Only alias keys that provably resolve to the account: the key that just resolved, and the current username. Never `String(userId)`. |
| The alias TTL (30 min) outlived every snapshot it could match. | Set to the snapshot TTL. An alias only pays off by enabling a cache hit, so a longer life bought nothing and only widened the window in which a username freed by a rename still pointed at the old account. |
| The single-flight `finally` deleted whatever promise sat under the key, so a build settling after an invalidation could unregister a *newer* build. | Unregister only this build (`flights.get(key) === build`), matching what the frontend cache already did. |
| A cold subject's flight stayed keyed by its raw key, so requests naming the same player differently could not coalesce onto it and invalidation could not reach it. | The build re-registers under its canonical key as soon as identity resolves. |
| The picker prefetch hardcoded `any`/`gain` while clicking preserves the current `key`/`view`, and fired on raw `pointerenter`, so one mouse sweep across the recent-players row could start a build per chip. | Prefetch uses the current keymode/view, and hover waits out a 140 ms dwell (cancelled on leave); pointer-down still fires immediately. |

Two further findings were refuted as pre-existing behaviour this change neither
introduced nor worsened.

The numeric-username collision has a regression test that was confirmed to fail
when the bug is reintroduced. The two flight-map refinements do not: both only
manifest under a precise async interleaving, and every candidate test still
passed with the bug deliberately reintroduced, so they were removed rather than
kept as false confidence. The reasoning lives at the call sites instead.

## Instrumentation left in place

- `Server-Timing` on `/api/snapshots/farm-helper` carries the full stage
  breakdown next to the existing `app;dur` total.
- `slow_http_request` logs the same stages plus peer/row/candidate counts and
  the cache state when a request exceeds 2 s.
- `npm run bench:farm-helper` — read-only load benchmark across representative
  subject shapes (writes are intercepted and counted, not executed).
- `npm run golden:farm-helper` — exact-output diff for future changes.

Per the plan's rollout note, keep the slow-request timing through at least one
full release so a regression stays attributable.
