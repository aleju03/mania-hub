import { createServer } from "node:http";
import { readConfig } from "./config.js";
import { ensurePinnedCountries, getIndexedCountryCodes, getMapsWarmCountryCodes } from "./countries.js";
import { createDb, logApiCall, migrate } from "./db.js";
import { routeHttp, sendNotFound } from "./http/snapshots.js";
import { ScoreIngestor } from "./ingest/score-ingestor.js";
import { JobQueue } from "./jobs/queue.js";
import { LiveEventLog } from "./live/event-log.js";
import { startRuntimeStatusMirror } from "./live/runtime-status.js";
import { deferMapsRefreshesWaitingForRoster, enqueueGlobalMapsRefreshIfDue, enqueueMapsRefreshIfDue } from "./features/maps.js";
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
import { WorkerRunner } from "./workers.js";

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
  "country_maps_snapshots",
  "top_play_events",
  "profile_snapshots",
  "profile_section_cache",
  "player_activity_days",
  "pack_collection_cards",
  "api_rate_limit_reservations",
];

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
  }
  const queue = new JobQueue(db);
  const events = new LiveEventLog(db);
  // Startup writes belong to the ingest/worker side; a serving process stays
  // read-mostly so it never contends with the worker on these at boot.
  if (!isServerRole) {
    await queue.shedPressure();
    await deferMapsRefreshesWaitingForRoster(db);
    await ensurePinnedCountries(db, config);
  }
  const logOsuCall = (entry: { caller: string; path: string; startedAt: number }) => {
    void logApiCall(db, {
      provider: "osu",
      caller: entry.caller,
      path: entry.path,
      startedAt: new Date(entry.startedAt).toISOString(),
    }).catch(() => {});
  };
  const sharedOsuLimiter = new SqliteSharedRateLimiter(db, {
    provider: "osu",
    targetPerMinute: config.osuApiTargetPerMinute,
    hardPerMinute: config.osuApiHardPerMinute,
  });
  const osu = new OsuApiClient(config, fetch, logOsuCall, { sharedLimiter: sharedOsuLimiter });
  const scoresFallbackOsu = new OsuApiClient(getScoresFallbackOsuConfig(config), fetch, logOsuCall, { sharedLimiter: sharedOsuLimiter });
  const ingestor = new ScoreIngestor(db, queue, events, config);
  const abuse = new AbuseGuard();
  const countryClients = new CountryClientTracker();
  const osc = new OscSocketClient(
    config,
    ingestor,
    config.enableOscBackfill ? () => enqueueOscBackfill(queue, db, config) : undefined,
  );
  if (!isServerRole && config.enableOsuApiJobs && config.enableStartupRosterRefresh && osu.hasCredentials()) {
    await enqueueRosterRefreshes(queue, await getIndexedCountryCodes(db, config));
  }
  const worker = new WorkerRunner(db, queue, events, osu, ingestor);
  const ctx = {
    db,
    queue,
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
  return { server, db, queue, events, osu, scoresFallbackOsu, osc, worker, ingestor, config, countryClients };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = await createApp();
  const role = app.config.role;
  // "server" serves HTTP only; "worker" runs ingest/jobs only; "all" does both.
  const runWorkers = role !== "server";
  const runServing = role !== "worker";

  if (runWorkers) {
    if (app.config.enableWorkers) app.worker.start();
    if (app.config.enableScheduledRefreshes && app.config.enableOsuApiJobs) {
      startRosterScheduler(app.db, app.queue, app.config);
      startMapsScheduler(app.db, app.queue, app.config);
    }
    startRetentionScheduler(app.db, app.config);
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
      }),
      5_000,
    );
  }

  // A serving process that does not ingest learns about new live events by
  // tailing live_event_log (written by the worker process).
  if (app.config.enableEventLogTail) {
    app.events.startTail(app.config.eventLogTailIntervalMs);
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

function startRosterScheduler(db: Awaited<ReturnType<typeof createDb>>, queue: JobQueue, config: ReturnType<typeof readConfig>): void {
  const tick = async () => {
    const countries = await getIndexedCountryCodes(db, config);
    await enqueueRosterRefreshes(queue, countries).catch((error) => {
      console.warn("[roster] scheduled refresh failed", error);
    });
    setTimeout(tick, config.rosterRefreshIntervalMs).unref();
  };
  setTimeout(tick, config.rosterRefreshIntervalMs).unref();
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
    setTimeout(tick, config.mapsRefreshIntervalMs).unref();
  };
  setTimeout(tick, 10_000).unref();
}
