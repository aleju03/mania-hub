import { createServer } from "node:http";
import { readConfig } from "./config.js";
import { ensurePinnedCountries, getIndexedCountryCodes, getMapsWarmCountryCodes, getRosterRefreshCountryCodes } from "./countries.js";
import { createDb, exec, getSqliteBusyRetryStats, logApiCall, migrate } from "./db.js";
import { AnalyticsStore } from "./features/analytics.js";
import { routeHttp, sendNotFound, warmGlobalMapsFarmedBoard, warmStatusBodyCache } from "./http/snapshots.js";
import { ScoreIngestor } from "./ingest/score-ingestor.js";
import { JobQueue } from "./jobs/queue.js";
import { LiveEventLog } from "./live/event-log.js";
import { startRuntimeStatusMirror } from "./live/runtime-status.js";
import { deferMapsRefreshesWaitingForRoster, enqueueGlobalMapsRefreshIfDue, enqueueMapsRefreshIfDue } from "./features/maps.js";
import { ensureMapSearchIndexSeeded, pruneMapSearchPlaceholderRows, reconcileMapSearchIndexStatuses } from "./features/map-search.js";
import { enqueueQualifiedMapsWatchIfDue } from "./features/qualified-maps-watch.js";
import { ensureDanFloorPinRecomputeSeeded, ensureDtRateAnalysisSeeded, ensureLnSourceRecomputeSeeded, ensureLnSubtypeRecomputeSeeded, ensureNoteBpmRecomputeSeeded, ensureVibroRecomputeSeeded } from "./features/chart-analysis.js";
import { enqueueMapCollectionsRebuildIfDue } from "./features/map-collections.js";
import { startGoalUserIndexRefresh } from "./features/goals.js";
import { enqueueProfilePoolWarmIfIdle } from "./features/profile-pool-warm.js";
import { enqueuePlayerSkills, PLAYER_SKILLS_JOB, PLAYER_SKILLS_VERSION } from "./features/player-skills.js";
import { enqueueSkillBaselineIfDue } from "./features/skill-baseline.js";
import { backfillSkinSlugs } from "./features/skins.js";
import { AbuseGuard } from "./http/abuse-guard.js";
import { CountryClientTracker } from "./live/country-clients.js";
import { handleSse } from "./live/sse.js";
import { enqueueOscBackfill } from "./osc/backfill.js";
import { OscSocketClient } from "./osc/client.js";
import { startScoresFallbackScheduler } from "./osc/scores-fallback.js";
import { OsuApiClient } from "./osu/client.js";
import { SqliteSharedRateLimiter } from "./osu/shared-rate-limiter.js";
import { enqueueRosterRefreshes } from "./rosters/country-rosters.js";
import { startRetentionScheduler } from "./retention.js";
import { packGlobalBoard } from "./features/global-rankings.js";
import { startWalCheckpointer } from "./wal-checkpointer.js";
import { WorkerRunner } from "./workers.js";
import { createDiscordRuntime } from "./discord/index.js";

// Serving routes touch these tables; a server-role process must not start until
// the worker/all process has migrated all of them, or it would 500 on a
// partially-migrated DB (e.g. country_registry exists but live_event_log does
// not). Add any new table a hot route depends on so split boots stay safe.
// Declared above the entrypoint block so it is initialized before createApp()
// runs during module evaluation (avoids a temporal-dead-zone reference).
const REQUIRED_SCHEMA_TABLES = [
  "country_registry",
  "live_event_log",
  "live_meta",
  "jobs",
  "users",
  "beatmaps",
  "beatmapsets",
  "country_beatmap_scores",
  "country_beatmap_score_pbs",
  "country_beatmap_score_pb_state",
  "country_maps_snapshots",
  "top_play_events",
  "profile_snapshots",
  "profile_section_cache",
  "player_activity_days",
  "pack_collection_cards",
  "api_rate_limit_reservations",
  "user_goals",
  "beatmap_osu_files",
  "map_search_index",
  "map_collections",
  "map_collection_members",
  "skins",
];

const IDLE_COUNTRY_ROSTER_REFRESH_INTERVAL_MS = 3 * 24 * 60 * 60 * 1000;

export async function createApp() {
  const config = readConfig();
  const db = await createDb(config);
  // Exactly one process owns schema DDL. A "server"-role process attaches to a
  // DB the worker process migrates, so it waits for readiness instead of racing
  // the worker on concurrent ALTER/CREATE (which would throw duplicate-column).
  const isServerRole = config.role === "server";
  if (isServerRole) {
    await waitForSchema(db);
  } else {
    await migrate(db);
    // Data backfill rides with schema ownership: assign slugs to skins
    // published before the slug column existed.
    await backfillSkinSlugs(db);
  }
  const rateLimitDb = await createDb(config);
  // A tiny dedicated write connection (+ its own queue) for the page-serving
  // path's best-effort bookkeeping (country touch, refresh scheduling). Keeping
  // those writes off the `db` connection that serves page-load reads is the
  // invariant that stops a busy single WAL writer from freezing the whole site:
  // a stuck write here can never queue in front of a read. Small cache/mmap — it
  // only runs a handful of one-row writes. The pure worker role never serves
  // HTTP, so it does not need one.
  const serveWriteDb = config.role === "worker" ? null : await createDb({ ...config, sqliteCacheMb: 2, sqliteMmapMb: 0 });
  const serveWriteQueue = serveWriteDb ? new JobQueue(serveWriteDb) : null;
  // In-house analytics lives in its own SQLite file on its own connection,
  // owned by the HTTP-serving process (capture posts, admin queries, live
  // SSE); a pure worker process never opens it.
  const analytics = config.role === "worker" ? null : new AnalyticsStore(
    await createDb({
      databaseUrl: config.analyticsDatabaseUrl,
      sqliteBusyTimeoutMs: config.sqliteBusyTimeoutMs,
      sqliteSynchronous: config.sqliteSynchronous,
      sqliteCacheMb: 8,
      sqliteMmapMb: 0,
    }),
    {
      retentionDays: config.analyticsRetentionDays,
      // Outside production there is no live-site host to allowlist; show
      // local traffic in the feed instead of filtering everything out.
      feedHosts: config.nodeEnv === "production" ? undefined : null,
      feedExcludedViewer: config.nodeEnv === "production" ? undefined : null,
    },
  );
  if (analytics) {
    await analytics.ensureSchema();
    analytics.start();
  }
  const queue = new JobQueue(db);
  const events = new LiveEventLog(db);
  // Startup writes belong to the ingest/worker side; a serving process stays
  // read-mostly so it never contends with the worker on these at boot.
  if (!isServerRole) {
    await queue.shedPressure();
    await deferMapsRefreshesWaitingForRoster(db);
    await ensurePinnedCountries(db, config);
    // Keep the in-memory "who has open goals" filter warm in the process that ingests scores, so
    // the ingest hot path skips a DB lookup for players with no goals (and learns of goals created
    // by a separate server-role process within a refresh interval).
    startGoalUserIndexRefresh(db);
  } else if (serveWriteDb) {
    // A server-role process must not write on its serving connection, but the
    // registry read path (/api/countries/features, /api/status) needs the pinned
    // countries to exist. Seed them once on the dedicated write connection at
    // boot so getCountryRegistry can read them with { ensure: false } and never
    // issue ensurePinnedCountries upserts on ctx.db.
    await ensurePinnedCountries(serveWriteDb, config).catch(() => undefined);
  }
  const logOsuCall = (entry: { caller: string; path: string; startedAt: number; durationMs?: number | null; status?: number | null }) => {
    void logApiCall(db, {
      provider: "osu",
      caller: entry.caller,
      path: entry.path,
      startedAt: new Date(entry.startedAt).toISOString(),
      durationMs: entry.durationMs,
      status: entry.status,
    }).catch(() => {});
  };
  const sharedOsuLimiter = new SqliteSharedRateLimiter(rateLimitDb, {
    provider: "osu",
    targetPerMinute: config.osuApiTargetPerMinute,
    hardPerMinute: config.osuApiHardPerMinute,
  });
  const osu = new OsuApiClient(config, fetch, logOsuCall, { sharedLimiter: sharedOsuLimiter });
  const scoresFallbackOsu = new OsuApiClient(getScoresFallbackOsuConfig(config), fetch, logOsuCall, { sharedLimiter: sharedOsuLimiter });
  const ingestor = new ScoreIngestor(db, queue, events, config, osu.hasCredentials() ? osu : undefined);
  const abuse = new AbuseGuard();
  const countryClients = new CountryClientTracker();
  const osc = new OscSocketClient(
    config,
    ingestor,
    config.enableOscBackfill ? () => enqueueOscBackfill(queue, db, config) : undefined,
  );
  if (!isServerRole && config.enableOsuApiJobs && config.enableStartupRosterRefresh && osu.hasCredentials()) {
    const startupRosterCountries = new Set(await getIndexedCountryCodes(db, config));
    for (const country of await getRosterRefreshCountryCodes(db, config, {
      warmIntervalMs: config.rosterRefreshIntervalMs,
      idleIntervalMs: IDLE_COUNTRY_ROSTER_REFRESH_INTERVAL_MS,
    })) {
      startupRosterCountries.add(country);
    }
    await enqueueRosterRefreshes(queue, [...startupRosterCountries]);
  }
  const worker = new WorkerRunner(db, queue, events, osu, ingestor);
  const discord = createDiscordRuntime({ db, osu, queue, config });
  const ctx = {
    db,
    // HTTP handlers enqueue follow-up jobs (maps/roster refresh, rankings stat
    // repair, player-skill recompute, replay-video, ...) via ctx.queue. Bind it
    // to the dedicated write connection so NONE of those enqueue writes land on
    // the connection that serves page-load reads — otherwise a stuck enqueue on
    // ctx.db (while a worker holds the WAL writer) blocks every read queued
    // behind it and freezes the site. The worker/schedulers keep using the
    // db-bound `queue` variable directly (they run in the worker process).
    queue: serveWriteQueue ?? queue,
    serveWriteDb: serveWriteDb ?? undefined,
    serveWriteQueue: serveWriteQueue ?? undefined,
    events,
    config,
    abuse,
    countryClients,
    osu,
    scoresFallbackOsu,
    oscStatus: () => osc.status(),
    workerStatus: () => worker.status(),
    pauseWorkers: () => worker.pause(),
    resumeWorkers: () => worker.resume(),
    discord: discord ?? undefined,
    analytics: analytics ?? undefined,
  };
  const server = createServer(async (req, res) => {
    try {
      if (await handleSse(req, res, ctx)) return;
      if (await routeHttp(req, res, ctx)) return;
      sendNotFound(res);
    } catch (error) {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });
  // Caddy fronts this server and reuses upstream connections. Node's default
  // 5s idle timeout closes sockets the proxy still considers live, which
  // surfaces as instant ECONNRESET on the next proxied request (seen as
  // sporadic SSR loader failures). Keep ours above the proxy's idle window.
  server.keepAliveTimeout = 75_000;
  server.headersTimeout = 80_000;
  if (config.role !== "worker") {
    warmStatusBodyCache(ctx);
    warmGlobalMapsFarmedBoard(ctx);
  }
  return { server, db, rateLimitDb, serveWriteDb, serveWriteQueue, queue, events, osu, scoresFallbackOsu, osc, worker, ingestor, config, countryClients, discord, analytics };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = await createApp();
  const role = app.config.role;
  // "server" serves HTTP only; "worker" runs ingest/jobs only; "all" does both.
  const runWorkers = role !== "server";
  const runServing = role !== "worker";

  if (runWorkers) {
    if (app.config.enableWorkers) {
      app.worker.start();
      // Pure background work (no osu! API): kick off / resume the global map
      // search index build so Search and Collections have data to serve, and
      // the one-shot vibro recompute sweep over stored chart analyses.
      void ensureMapSearchIndexSeeded(app.db, app.queue).catch((error) => console.warn("[map-search] seed failed", error));
      void ensureVibroRecomputeSeeded(app.db, app.queue).catch((error) => console.warn("[vibro-recompute] seed failed", error));
      void ensureDanFloorPinRecomputeSeeded(app.db, app.queue).catch((error) => console.warn("[dan-floor-pin] seed failed", error));
      void ensureLnSubtypeRecomputeSeeded(app.db, app.queue).catch((error) => console.warn("[ln-subtype] seed failed", error));
      void ensureLnSourceRecomputeSeeded(app.db, app.queue).catch((error) => console.warn("[ln-source] seed failed", error));
      void ensureDtRateAnalysisSeeded(app.db, app.queue).catch((error) => console.warn("[dt-rate-analysis] seed failed", error));
      void ensureNoteBpmRecomputeSeeded(app.db, app.queue).catch((error) => console.warn("[note-bpm-recompute] seed failed", error));
    }
    if (app.config.enableScheduledRefreshes && app.config.enableOsuApiJobs) {
      startRosterScheduler(app.db, app.queue, app.config);
      startMapsScheduler(app.db, app.queue, app.config);
      startMapCollectionsScheduler(app.db, app.queue, app.config);
      startQualifiedMapsWatchScheduler(app.db, app.queue, app.config);
      startProfilePoolWarmScheduler(app.db, app.queue);
      startVariantPpDripScheduler(app.db, app.queue);
      startPlayerSkillsDripScheduler(app.db, app.queue);
    }
    startRetentionScheduler(app.db, app.config);
    // Skill percentile baseline: pure DB/CPU (approximate SSRs over stored top
    // plays), so it runs whenever workers do, like retention.
    if (app.config.enableWorkers) {
      startSkillBaselineScheduler(app.db, app.queue);
    }
    // Global rankings board: built here (yielding batches) and packed into
    // live_meta so the serving process answers pages from one small read and
    // never scans the roster on its own event loop.
    startGlobalBoardPackScheduler(app.db);
    // Active WAL brake: keeps the -wal file bounded so it can never grow into the
    // read-pin death-spiral. Worker/all role only (never the serving process).
    startWalCheckpointer(app.config);
    startMapSearchStatusReconciler(app.db);
    startQueuePressureScheduler(app.queue);
    if (app.config.enableOscBackfill) {
      enqueueOscBackfill(app.queue, app.db, app.config).catch((error) => console.warn("[osc] backfill enqueue failed", error));
    }
    if (app.config.enableOscSocket) {
      app.osc.start().catch((error) => console.warn("[osc] socket failed", error));
    }
    if (app.config.enableWorkers && app.config.enableOsuScoresFallback && app.osu.hasCredentials()) {
      startScoresFallbackScheduler(app.db, app.config, app.scoresFallbackOsu, app.ingestor, () => app.osc.status());
    }
  }

  // When workers run in a separate process, mirror their live status to the DB
  // so the serving process's admin dashboard can read it.
  if (role === "worker") {
    startRuntimeStatusMirror(
      app.db,
      () => ({
        worker: app.worker.status(),
        osc: app.osc.status(),
        osuRate: app.osu.limiter.state(),
        scoresFallbackRate: app.scoresFallbackOsu.limiter.state(),
        sqliteBusy: getSqliteBusyRetryStats(),
      }),
      5_000,
    );
  }

  // A serving process that does not ingest learns about new live events by
  // tailing live_event_log (written by the worker process).
  if (app.config.enableEventLogTail) {
    app.events.startTail(app.config.eventLogTailIntervalMs);
  }

  // Post Discord live feeds from the serving process only, so a given event is
  // never posted twice, whether it arrives via append-dispatch (all role) or the
  // event-log tail (server role); the headless worker never posts. Delivery is
  // at-most-once: the tail starts at the current head, so events appended while
  // the serving process is down are not back-filled to Discord (by design, so a
  // restart never floods channels with stale plays).
  if (runServing && app.discord) {
    app.events.subscribe(app.discord.feedSink);
  }

  if (runServing) {
    app.server.listen(app.config.port, () => {
      console.log(`[live-backend] listening on ${app.config.livePublicOrigin} (port ${app.config.port}, role ${role})`);
    });
  } else if (app.config.workerHttpPort != null) {
    // Optional internal-only listener so the worker process can be health-checked.
    app.server.listen(app.config.workerHttpPort, "127.0.0.1", () => {
      console.log(`[live-backend] worker internal http on 127.0.0.1:${app.config.workerHttpPort} (role ${role})`);
    });
  } else {
    // Headless worker: no HTTP listener, and every worker/scheduler/mirror timer
    // is unref()'d (so tests tear down cleanly). Without a ref'd handle the event
    // loop would drain and the process would exit the moment it went idle (e.g.
    // OSC disabled). Hold it open explicitly; SIGTERM still stops it normally.
    setInterval(() => {}, 1 << 30);
    console.log(`[live-backend] worker process started (role ${role}, no http listener)`);
  }
}

// A "server"-role process does not migrate; it waits for the worker/all process
// to create the schema. Polls sqlite_master so a fresh deploy where both
// processes restart together does not fail the window before migration.
async function waitForSchema(db: Awaited<ReturnType<typeof createDb>>, timeoutMs = 60_000): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    let missing: string[] = REQUIRED_SCHEMA_TABLES;
    try {
      const present = new Set(
        (await db.execute("select name from sqlite_master where type = 'table'")).rows.map((row) => String(row.name)),
      );
      missing = REQUIRED_SCHEMA_TABLES.filter((table) => !present.has(table));
      if (missing.length === 0) return;
    } catch {
      // sqlite_master should always be readable; treat a failure as not-ready.
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`schema not ready after ${timeoutMs}ms (is a worker/all-role process running to migrate it?); missing: ${missing.join(", ")}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

function getScoresFallbackOsuConfig(config: ReturnType<typeof readConfig>): Pick<ReturnType<typeof readConfig>, "osuClientId" | "osuClientSecret" | "osuApiTargetPerMinute" | "osuApiHardPerMinute"> {
  const intervalMs = Math.max(10_000, config.osuScoresFallbackIntervalMs);
  const targetPerMinute = Math.max(1, Math.ceil(60_000 / intervalMs));
  return {
    osuClientId: config.osuClientId,
    osuClientSecret: config.osuClientSecret,
    osuApiTargetPerMinute: targetPerMinute,
    osuApiHardPerMinute: Math.max(targetPerMinute + 2, targetPerMinute * 2),
  };
}

// Enqueues also trigger shedPressure, but during quiet hours nothing is
// enqueued, so this tick is what lets parked jobs flow back into the queue.
function startQueuePressureScheduler(queue: JobQueue): void {
  const tick = async () => {
    await queue.shedPressure().catch((error) => console.warn("[queue] pressure rebalance failed", error));
    setTimeout(tick, 60_000).unref();
  };
  setTimeout(tick, 60_000).unref();
}

const GLOBAL_BOARD_PACK_INTERVAL_MS = 60_000;

function startGlobalBoardPackScheduler(db: Awaited<ReturnType<typeof createDb>>): void {
  const tick = async () => {
    try {
      await packGlobalBoard(db);
    } catch (error) {
      console.warn("[global-board] pack failed", error);
    }
    setTimeout(tick, GLOBAL_BOARD_PACK_INTERVAL_MS).unref();
  };
  setTimeout(tick, 5_000).unref();
}

function startRosterScheduler(db: Awaited<ReturnType<typeof createDb>>, queue: JobQueue, config: ReturnType<typeof readConfig>): void {
  const tick = async () => {
    const countries = await getRosterRefreshCountryCodes(db, config, {
      warmIntervalMs: config.rosterRefreshIntervalMs,
      idleIntervalMs: IDLE_COUNTRY_ROSTER_REFRESH_INTERVAL_MS,
    });
    await enqueueRosterRefreshes(queue, countries).catch((error) => {
      console.warn("[roster] scheduled refresh failed", error);
    });
    setTimeout(tick, config.rosterRefreshIntervalMs).unref();
  };
  setTimeout(tick, config.rosterRefreshIntervalMs).unref();
}

// Slow trickle that fills the real users.pp_4k / pp_7k columns for roster
// members whose stored profile never carried statistics.variants (older
// enrichments, rankings-only rows). Reuses enrich_user (which fetches
// /users/{id}/mania and, via the Stage 1 write rule, now fills the columns), so
// no new job type. Enqueued at low priority behind organic enrichment: enrich_user
// is never pressure-deferred or shed, and the fast lane claims it in priority
// order, so a small batch drains without crowding out user-facing work. Dedupe
// key user:{id} coalesces with organic enrichment (priority max wins). ~roster
// size / 8 per 15 min to full coverage; Stage 2's calibration covers the interim.
const VARIANT_PP_DRIP_BATCH = 8;
const VARIANT_PP_DRIP_INTERVAL_MS = 15 * 60_000;
const VARIANT_PP_DRIP_PRIORITY = 10;

function startVariantPpDripScheduler(db: Awaited<ReturnType<typeof createDb>>, queue: JobQueue): void {
  const tick = async () => {
    try {
      const rows = (await exec(
        db,
        `select user_id from users
         where is_active = 1 and pp is not null and pp > 0
           and pp_4k is null and pp_7k is null
           and (profile_json is null or profile_json not like '%"variants"%')
         order by pp desc
         limit ?`,
        [VARIANT_PP_DRIP_BATCH],
      )).rows;
      for (const row of rows) {
        const userId = Number(row.user_id);
        if (!Number.isSafeInteger(userId) || userId <= 0) continue;
        await queue.enqueue("enrich_user", `user:${userId}`, { userId }, { priority: VARIANT_PP_DRIP_PRIORITY });
      }
    } catch (error) {
      console.warn("[variant-pp-drip] scheduled enqueue failed", error);
    }
    setTimeout(tick, VARIANT_PP_DRIP_INTERVAL_MS).unref();
  };
  setTimeout(tick, 90_000).unref();
}

// Version-stale player-skills drip: after a PLAYER_SKILLS_VERSION bump every
// stored rating is stale, and outside the drip recomputes only happen for
// players someone views or who set a new top play, so the inactive rest of
// the roster would never converge on its own. The drip
// tops up the MinaCalc lane only while its waiting pool is nearly empty and
// enqueues at bottom priority, so view-triggered computes (priority 50) and
// dan estimates always jump ahead and the drip drains at whatever pace the
// lane has spare. Strongest players first: their profiles get viewed most.
const SKILLS_DRIP_BATCH = 16;
const SKILLS_DRIP_INTERVAL_MS = 5 * 60_000;
const SKILLS_DRIP_PRIORITY = 5;

function startPlayerSkillsDripScheduler(db: Awaited<ReturnType<typeof createDb>>, queue: JobQueue): void {
  const tick = async () => {
    try {
      const waiting = Number((await exec(
        db,
        "select count(*) as cnt from jobs where type = ? and status in ('queued', 'failed')",
        [PLAYER_SKILLS_JOB],
      )).rows[0]?.cnt ?? 0);
      if (waiting < 2) {
        const rows = (await exec(
          db,
          `select cr.user_id from (select distinct user_id from country_rosters) cr
           left join users u on u.user_id = cr.user_id
           where not exists (
             select 1 from player_skill_ratings psr
             where psr.user_id = cr.user_id and psr.analysis_version = ?
           )
           order by coalesce(u.pp, 0) desc
           limit ?`,
          [PLAYER_SKILLS_VERSION, SKILLS_DRIP_BATCH],
        )).rows;
        for (const row of rows) {
          const userId = Number(row.user_id);
          if (!Number.isSafeInteger(userId) || userId <= 0) continue;
          await enqueuePlayerSkills(queue, userId, { priority: SKILLS_DRIP_PRIORITY });
        }
      }
    } catch (error) {
      console.warn("[player-skills-drip] scheduled enqueue failed", error);
    }
    setTimeout(tick, SKILLS_DRIP_INTERVAL_MS).unref();
  };
  setTimeout(tick, 3 * 60_000).unref();
}

// Weekly skill-baseline refresh: the due-check owns the cadence (stale or
// missing curves enqueue a fresh chunked run), so this tick only has to fire
// often enough to notice staleness and restart a chain that died.
function startSkillBaselineScheduler(db: Awaited<ReturnType<typeof createDb>>, queue: JobQueue): void {
  const tick = async () => {
    await enqueueSkillBaselineIfDue(db, queue).catch((error) => {
      console.warn("[skill-baseline] scheduled refresh failed", error);
    });
    setTimeout(tick, 6 * 60 * 60_000).unref();
  };
  setTimeout(tick, 2 * 60_000).unref();
}

// Seeds and watchdogs the pack-pool snapshot warm chain: the job re-enqueues
// itself while cold pool players remain, so this tick only has to (re)start a
// chain that has never run, finished (new roster entrants went cold), or died.
function startProfilePoolWarmScheduler(db: Awaited<ReturnType<typeof createDb>>, queue: JobQueue): void {
  const tick = async () => {
    await enqueueProfilePoolWarmIfIdle(db, queue).catch((error) => {
      console.warn("[profile-pool-warm] scheduled seed failed", error);
    });
    setTimeout(tick, 30 * 60_000).unref();
  };
  setTimeout(tick, 60_000).unref();
}

function startMapsScheduler(db: Awaited<ReturnType<typeof createDb>>, queue: JobQueue, config: ReturnType<typeof readConfig>): void {
  const tick = async () => {
    const countries = await getMapsWarmCountryCodes(db, config);
    await Promise.all(countries.map((country) => enqueueMapsRefreshIfDue(db, queue, country, config.mapsRefreshIntervalMs))).catch((error) => {
      console.warn("[maps] scheduled refresh failed", error);
    });
    // Rebuild the Global aggregate after the per-country snapshots so it merges
    // their freshest data. It depends only on stored snapshots, no osu! calls.
    await enqueueGlobalMapsRefreshIfDue(db, queue, config.mapsRefreshIntervalMs).catch((error) => {
      console.warn("[maps] scheduled global refresh failed", error);
    });
    // Watchdog the global search index (resumes a build that died mid-chain).
    // No osu! API involved; it reads from the search index.
    await ensureMapSearchIndexSeeded(db, queue).catch((error) => {
      console.warn("[map-search] watchdog seed failed", error);
    });
    setTimeout(tick, config.mapsRefreshIntervalMs).unref();
  };
  setTimeout(tick, 10_000).unref();
}

// Heals /maps status labels for maps that ranked after they were indexed. The
// search index materializes status from beatmap metadata (refreshed only by the
// API-backed enrich job), but a tracked player's score on a newly-ranked map
// updates the beatmaps.status column for free; this copies that fresher status
// into the index. Pure DB work, no osu! API, so it runs regardless of the
// osu!-API scheduler gating (like retention).
function startMapSearchStatusReconciler(db: Awaited<ReturnType<typeof createDb>>): void {
  const tick = async () => {
    const healed = await reconcileMapSearchIndexStatuses(db).catch((error) => {
      console.warn("[map-search] status reconcile failed", error);
      return 0;
    });
    if (healed > 0) console.log(`[map-search] reconciled ${healed} stale map status label(s)`);
    const pruned = await pruneMapSearchPlaceholderRows(db).catch((error) => {
      console.warn("[map-search] placeholder prune failed", error);
      return 0;
    });
    if (pruned > 0) console.log(`[map-search] pruned ${pruned} placeholder diff row(s)`);
    setTimeout(tick, 60 * 60_000).unref();
  };
  setTimeout(tick, 30_000).unref();
}

// The collections rotation runs on its own (shorter) cadence than the weekly
// maps tick, so the staleness check polls hourly and enqueues once a rotation
// ages past the configured interval. Pure DB work off the search index.
function startMapCollectionsScheduler(db: Awaited<ReturnType<typeof createDb>>, queue: JobQueue, config: ReturnType<typeof readConfig>): void {
  const tick = async () => {
    await enqueueMapCollectionsRebuildIfDue(db, queue, config.mapCollectionsRefreshIntervalMs).catch((error) => {
      console.warn("[map-collections] scheduled rebuild failed", error);
    });
    setTimeout(tick, 60 * 60_000).unref();
  };
  setTimeout(tick, 20_000).unref();
}

// Pulls osu!'s current qualified mania list hourly to reconcile /maps status:
// promotes pending -> qualified, indexes brand-new sets, and (the gap the
// zero-API heals can't cover) moves ranked/dequalified sets off the qualified
// label. One API call per tick in steady state.
function startQualifiedMapsWatchScheduler(db: Awaited<ReturnType<typeof createDb>>, queue: JobQueue, config: ReturnType<typeof readConfig>): void {
  const tick = async () => {
    await enqueueQualifiedMapsWatchIfDue(db, queue, config.qualifiedMapsWatchIntervalMs).catch((error) => {
      console.warn("[qualified-maps] scheduled watch failed", error);
    });
    setTimeout(tick, config.qualifiedMapsWatchIntervalMs).unref();
  };
  setTimeout(tick, 45_000).unref();
}
