# Live Backend Reference

Deep reference for `live-backend/`: module map, ingest flow, job queue, HTTP surface, replay video export, retention and storage. The condensed guides are `AGENTS.md` / `CLAUDE.md` at the repo root and `live-backend/CLAUDE.md`. Per-feature models live in `docs/features.md`, `docs/packs.md`, `docs/discord.md`.

## Module map

- `live-backend/src/server.ts`: boot. Connects the DB, applies migrations, then conditionally starts workers, schedulers, the oSC socket (with watchdog), oSC backfill, the osu! recent-scores fallback poller, retention, and the HTTP server on port 7227.
- `live-backend/src/ingest/score-ingestor.ts`: score ingestion and projection fanout.
- `live-backend/src/osc/`: oSC Socket.IO client, JSON backfill, and the osu! API scores fallback poller.
- `live-backend/src/jobs/queue.ts` and `live-backend/src/workers.ts`: job queue and worker lanes.
- `live-backend/src/features/`: one module per surface (tracker, top-plays, snipes, maps, farm-helper, farm-helper-key-stats, activity, dan-estimates, global-rankings, rank-snapshots, player-profiles, goals, my-data, analytics, pack-wallets, pack-pulls, pack-games, pack-admin, admin-todos, translation-reports).
- `live-backend/src/http/snapshots.ts`: the HTTP router (gates + dispatch, plus a compat re-export façade); endpoint handlers live in `live-backend/src/http/routes/` by domain - REST snapshots, profile endpoints, per-user (goals / my-data / roster / pack) endpoints, Discord admin routes, admin controls (including the pack grant desk in `routes/pack-admin.ts`), replay video job endpoints - with shared plumbing in `context.ts` / `request.ts` / `respond.ts` / `country-activation.ts` / `status-report.ts` / `maps-response-cache.ts` / `snapshot-queries.ts`. `live-backend/src/http/abuse-guard.ts`: per-IP rate limiting.
- `live-backend/src/live/`: SSE handler, event log with replay buffer, per-country client tracking, replay presence, and the admin ghost hub.
- `live-backend/src/discord/`: the maniabot Discord subsystem.
- `live-backend/src/rosters/country-rosters.ts`: country roster build/refresh from osu! rankings, plus manual roster member add/remove.
- `live-backend/src/shared/`: cross-cutting helpers, including score normalization (`score.ts`, `score-storage.ts`), country timezone bucketing (`country-timezones.ts`), and shared `types.ts`.
- `live-backend/src/replay-video/`: server-side rendering (headless Chrome), finalization, R2 upload.
- `live-backend/src/dan/`: backend copy of the dan estimator. `live-backend/src/audio/`: beatmap archive download and audio streaming.
- `live-backend/src/maintenance/`: storage compaction and DB sync-from-VPS scripts.
- `live-backend/migrations/001_initial.sql`: schema, applied at boot.

## Architecture

The live backend is the source of truth for live surfaces when `VITE_LIVE_BACKEND_URL` is configured. Browsers fetch a snapshot on page entry, then subscribe to SSE for deltas. SSE is one-way backend-to-browser; users never connect to oSC directly.

Ingest flow:

1. Scores arrive from three sources: the oSC Socket.IO feed (real-time), oSC JSON backfill (catch-up after downtime), and an osu! API recent-scores fallback poller (safety net, own rate bucket).
2. Scores are filtered to mania. Country detection uses `country_rosters` plus enriched user data, because oSC payloads do not include country.
3. Raw rows land in `score_events`; user/beatmap/beatmapset metadata is upserted; projections and follow-up jobs fan out according to the country's feature tier.
4. The backend emits SSE events (`tracker_score`, `top_play`, `snipe`, `maps_farmed_update`, `goal_completed`, `job_status`, `status`, `replay_video_export`), plus a `hello` event on connect and `heartbeat` keepalives. Reconnecting clients replay missed events via `Last-Event-ID` against `live_event_log`. Two high-volume types are stored as a reference rather than a payload (`compactLiveEventPayload` in `live/event-log.ts`): a `tracker_score` keeps its score identity and a `pack_pull` its event id, and both rehydrate from their durable table on replay, so the log does not carry a second copy of data it can look up.

Rosters are warmed from osu! mania performance rankings on a schedule; roster refreshes also capture `country_rank_snapshots` used for 7-day rank deltas.

## Queue and jobs

The queue lives in the `jobs` table with priority, dedupe keys, and per-type backoff. Under load it sheds pressure: low-priority job types are auto-deferred (`deferred_pressure`) when queue depth is high and wake when it drains. Workers run in dedicated lanes (fast enrichment, osc-backfill, osc-country-catchup, maps-refresh, dan-estimates, activity-analysis, chart-analysis, snipe-seed, replay-video render and finalize).

Job types:

- `enrich_user`, `enrich_beatmap`: fetch full metadata from the osu! API.
- `refresh_country_roster`: refresh a country's roster and rank snapshots from osu! rankings.
- `refresh_user_top_scores`: confirm a candidate top play and compute PP gain.
- `refresh_profile_user`, `refresh_profile_snapshot`: catch a viewed profile up off the request path (osu! user payload; full user + best-200 re-mint). Both are queued by the profile endpoints, never awaited by them.
- `reconcile_user_recent_scores`: sync a user's recent scores from the osu! API to fill ingest gaps.
- `refresh_user_maps_farmed_scores`, `refresh_country_maps`, `refresh_global_maps`: maps-farmed aggregation per user, per country, and globally.
- `refresh_qualified_maps`: hourly qualified-maps watch; pulls osu!'s current qualified mania list in one search call and reconciles `/maps` status (promote pending->qualified, index new sets, resolve ranks/dequalifies).
- `seed_snipe_board`: build the initial board for a beatmap/lane.
- `analyze_activity_beatmap`: compute skill vectors for player activity.
- `analyze_beatmap_chart`: unified chart analysis per beatmap at 1.0x (classifier dan verdict, pattern clusters, MinaCalc MSD skillsets) into `beatmap_chart_analysis`.
- `recompute_vibro_sweep`, `recompute_dan_floor_pin_sweep`, `recompute_ln_subtype_sweep`: one-shot boot-seeded sweeps over stored chart analyses (gated by `live_meta` done-keys), patching detector/classifier changes into the corpus without a full `CHART_ANALYSIS_VERSION` re-run.
- `compute_dan_estimate`: dan rating for a beatmap at a rate.
- `compute_player_skills`: Etterna-style skillset ratings from a player's top plays into `player_skill_ratings`.
- `recompute_player_skill_poison_sweep`: one-shot boot-seeded sweep (done-key `player_skill_poison_recovery_done:v1`) that drops per-play SSRs carrying the MinaCalc floor signature (`Stream == Technical == Chordjack`, positive) from `plays_json` and backdates `computed_at` so the row recomputes on its next read. The chart-side repair (`recompute_msd_poison_sweep`) healed the charts but not the per-play copies stored against them, and the SSR reuse key (beatmap + rate + goal) carries no chart-health term, so those values propagate across recomputes. Targets the stored signature rather than an incident time window, which is what the original window-based cleanup missed.
- `osc_backfill`, `osc_country_catchup`: oSC JSON catch-up, global and country-scoped.
- `replay_video_server_render`, `replay_video_export`: server-side render and finalization/upload.

## HTTP surface

`/healthz` and `/readyz` are open, and are what a liveness or uptime probe should use. `/api/status` is **not** public: it needs `LIVE_ADMIN_TOKEN` like `/api/admin/status` (it is the same body without the worker-activity extras), because queue pressure, DB headroom, the osu! API budget and the abuse counters together describe exactly when the backend is least able to absorb load. Public endpoints: `/api/countries/features`, `/api/countries/activate`, `/api/snapshots/*` (tracker, top-plays, snipes, snipe-board, maps, maps-page, maps-progress, maps-set, maps-players, rankings, global-rankings, farm-helper, farm-helper-farmers, rank-deltas), `/api/profiles/{user}/{section}` (snapshot, cached-snapshot, about, recent, replay-scores, activity, activity-day, activity-availability), `/api/dan-estimates`, `/api/audio`, `/api/hitsounds`, `/api/storyboard` (zip of the set's root .osb plus referenced images for the replay viewer; empty zip means no storyboard, cached in R2 including negatives), `/api/packs/{warm,cards,card-stats,pulled-stats/{id},recent-pulls}`, `/api/goat-poll`, `/api/events` (country-activating event-log replay since `?since=`), `/api/discord/info`, `/api/replay-video-job`, the SSE stream at `/api/live?country=XX`, the ghost stream at `/api/updates/stream?route=` (public because every page open holds one; identity optional and signed), and the replay-viewer presence stream at `/api/replay/presence?key=score:<id>|upload:<id>`. The paginated `replay-scores` section serves deduplicated replay-ready `score_events` for the side-by-side picker; its history is therefore bounded by score-event retention. `/api/discord/interactions` is public but Ed25519 signature-verified, ahead of the public rate gate.

Replay presence emits SSE `count` events for the viewer's "Spectators (N)" counter: in-memory refcounts, anonymous by default, `observe=1` receives counts without being counted (admin viewers). A watcher who enabled "show my name under spectators" adds `uid`/`name`/`exp`/`sig`, an HMAC of `spectator:<id>:<username>:<expiry>` keyed with `LIVE_ADMIN_TOKEN` and minted by `getReplaySpectatorTicket` in `src/lib/replay-spectator.ts`; their username joins a `names` array, deduped per account and capped.

A class of per-user endpoints is gated by the server-to-server bridge (`isBridge` in `http/request.ts`) but lives outside `/api/admin/*`: the frontend server fn injects the bridge token plus the osu!-verified viewer id, so a user only ever touches their own data. The bridge credential is `LIVE_BRIDGE_TOKEN`; unset, it falls back to `LIVE_ADMIN_TOKEN` (the historical behaviour), and set, it takes these routes off the admin token entirely so a leak of either is not a leak of both. These are goals (`/api/goals`, `/api/goals/create`, `/api/goals/delete`), my-data (`/api/my-data/{summary,dashboard,feed,top-plays,skills}`), roster self opt-in/out (`/api/roster/self-add`, `/api/roster/self-remove`), pack wallet/collection/pull-log (`/api/pack-wallet/{id}`, `/api/pack-collection/{id}`, `/api/packs/pulls`, `/api/packs/pulled-by/{id}`), arcade payouts (`/api/packs/games/{streak,allowance}`) and the GOAT poll's write side (`/api/goat-poll/{mine,vote,nominate}`). `/api/translation-reports/submit` is on the same bridge but is the one route there that needs no viewer: a translation report is open to signed-out readers, so the frontend forwards a viewer id only when the login cookie has one, plus the visitor's address so the per-IP `translationReport` bucket (`TRANSLATION_REPORT_RATE_PER_HOUR`, default 10/hour) keys on the reporter rather than on the frontend server. It deliberately bypasses `checkRate`, which would re-bucket it into the site-wide `bridge` budget. The osu! API proxies `/api/osu/v2` and `/api/osu/beatmap-file`, the analytics ingress `/api/analytics/capture`, the skins ownership routes, the uploaded-replay index and every `/api/communities/*` route are on the same bridge, called server-to-server, not from browsers.

All public endpoints are rate-limited per IP by `abuse-guard.ts` with separate buckets (general, costly, pack hands, dan estimates, country activation with per-IP/global/new-country sub-limits, SSE connections with per-IP and total caps, replay video jobs). Note the general bucket applies to every `/api/` path, so a route with its own bucket spends both. CORS allows origins from `ALLOWED_ORIGINS`. `/api/admin/*` requires `LIVE_ADMIN_TOKEN`.

## Replay video export

The whole feature is gated by `ENABLE_REPLAY_VIDEO` (default `false`; on only in the owner's local env). When off, `/api/replay-video-job` returns 404, the replay-video worker lanes are not registered, and playwright-core is never imported (it is a dynamic import inside the render function).

Two paths, both finishing in the backend queue:

1. Browser render: WebCodecs encodes the MP4 client-side, then the frontend calls `/api/replay-video-job` (`start` -> `upload-video` -> `finish`).
2. Server render: the backend queues `replay_video_server_render`, which drives headless Chrome (playwright-core) against the frontend to render the video.

Either way, `replay_video_export` finalizes: optional ffmpeg audio mux and optimization, upload to R2 (or local path), status in `replay_video_exports`, polled by the frontend via `action=status`. `scripts/dev/replay-video-job.ts` is a local Vite middleware fallback when no live backend URL is configured.

## Retention and storage

The backend uses LibSQL/SQLite (default `live-backend/data/mania-hub-live.db`, WAL mode); `DATABASE_URL` may point to a file or remote. `live-backend/src/retention.ts` runs hourly. Defaults (configurable): `score_events` 14d, `live_event_log` 7d, done `jobs` 2d, `api_call_log` 7d, finished `replay_video_exports` 2d plus temp dir cleanup, rank snapshots 14d, player activity 2y. Two further tables are pruned on fixed (non-configurable) cutoffs every tick: `beatmap_osu_files` 90d and `discord_channel_map_context` 30d. The DB size is capped (~10GB max; over the cap triggers compaction toward ~8GB).

Durable projections (`country_beatmap_scores`, `snipe_events`, `top_play_events`, `user_top_scores`, maps snapshots, users, beatmaps, beatmapsets, rosters) are not part of the short raw-event cleanup. Neither are the `pack_community_*` roll-up tables, which are a maintained cache rather than a projection: every column is derivable from `pack_collection_cards`, and they are kept level by triggers plus a reconciler instead of being pruned (`docs/packs.md`).

Caching lives where each resource lives. osu! API responses: cached in the backend's `/api/osu/v2` proxy (`osu_proxy_cache` table, `features/osu-proxy-cache.ts`), opt-in per call via `cacheTtlMs`/`staleMs` on `osuFetch`; the proxy also collapses concurrent identical fetches in-process and serves expired rows through upstream failures within `staleMs`. Computed artifacts (parsed replays, uploaded-replay descriptions): gzipped JSON objects in R2 via `getJsonArtifact`/`putJsonArtifact`. The `getPersistentCache*`/`fetchWithCacheLock` helpers in `src/lib/api.ts` kept their signatures but are a per-instance memory tier plus in-flight dedup only; there is no shared frontend KV. R2 objects are managed by `src/lib/r2-cache.ts`; size is bounded by per-prefix Cloudflare lifecycle rules, never by code. Two buckets exist: the private `mania-hub-replay-cache` (roots `replay-cache/` and `skins/`) and the public CDN bucket `mania-hub-public` behind cdn.mania-tracker.com (roots `bbcode/` and `maniacards/`, written by `public-image-store.ts` / `pack-thumbnail-store.ts`). `/admin/r2` browses both through the `ADMIN_BUCKETS` registry in `r2-cache.ts`, which is the only place a browsable root or its delete warning is declared; a new top-level prefix stays invisible to the admin browser until it is listed there.

The osu! API budget is enforced by a token-bucket client in `live-backend/src/osu/client.ts` (~45/min target, 60/min hard limit), with calls logged to `api_call_log`. Interactive work normally has priority, but an aged background call is promoted locally and the cross-process limiter reserves 20% of the hard window for non-interactive lanes, so public traffic cannot starve ingest/roster jobs. Route new osu! API calls through this client. Public backend endpoints are already rate-limited per IP via the abuse guard.
