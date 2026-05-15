import { createServer } from "node:http";
import { readConfig } from "./config.js";
import { ensurePinnedCountries, getActiveCountryCodes } from "./countries.js";
import { createDb, exec, migrate } from "./db.js";
import { routeHttp, sendNotFound } from "./http/snapshots.js";
import { ScoreIngestor } from "./ingest/score-ingestor.js";
import { JobQueue } from "./jobs/queue.js";
import { LiveEventLog } from "./live/event-log.js";
import { enqueueMapsRefreshIfDue } from "./features/maps.js";
import { AbuseGuard } from "./http/abuse-guard.js";
import { handleSse } from "./live/sse.js";
import { enqueueOscBackfill } from "./osc/backfill.js";
import { OscSocketClient } from "./osc/client.js";
import { OsuApiClient } from "./osu/client.js";
import { enqueueRosterRefreshes } from "./rosters/country-rosters.js";
import { startRetentionScheduler } from "./retention.js";
import { WorkerRunner } from "./workers.js";

export async function createApp() {
  const config = readConfig();
  const db = await createDb(config);
  await migrate(db);
  const queue = new JobQueue(db);
  const events = new LiveEventLog(db);
  await ensurePinnedCountries(db, config);
  const osu = new OsuApiClient(config, fetch, (entry) => {
    void exec(db, "insert into api_call_log (provider, caller, path, started_at) values ('osu', ?, ?, ?)", [
      entry.caller,
      entry.path,
      new Date(entry.startedAt).toISOString(),
    ]).catch(() => {});
  });
  const ingestor = new ScoreIngestor(db, queue, events, config);
  const abuse = new AbuseGuard();
  const osc = new OscSocketClient(config, ingestor);
  if (config.enableStartupRosterRefresh && osu.hasCredentials()) {
    await enqueueRosterRefreshes(queue, config.trackedCountries);
  }
  const worker = new WorkerRunner(db, queue, events, osu, ingestor);
  const ctx = {
    db,
    queue,
    events,
    config,
    abuse,
    osu,
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
  return { server, db, queue, events, osu, osc, worker, ingestor, config };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = await createApp();
  if (app.config.enableWorkers) app.worker.start();
  if (app.config.enableScheduledRefreshes) {
    startRosterScheduler(app.db, app.queue, app.config);
    startMapsScheduler(app.db, app.queue, app.config);
  }
  startRetentionScheduler(app.db, app.config);
  if (app.config.enableOscBackfill) {
    enqueueOscBackfill(app.queue, app.db, app.config).catch((error) => console.warn("[osc] backfill enqueue failed", error));
  }
  if (app.config.enableOscSocket) {
    app.osc.start().catch((error) => console.warn("[osc] socket failed", error));
  }
  app.server.listen(app.config.port, () => {
    console.log(`[live-backend] listening on ${app.config.livePublicOrigin} (port ${app.config.port})`);
  });
}

function startRosterScheduler(db: Awaited<ReturnType<typeof createDb>>, queue: JobQueue, config: ReturnType<typeof readConfig>): void {
  const tick = async () => {
    const countries = await getActiveCountryCodes(db, config);
    await enqueueRosterRefreshes(queue, countries).catch((error) => {
      console.warn("[roster] scheduled refresh failed", error);
    });
    setTimeout(tick, config.rosterRefreshIntervalMs).unref();
  };
  setTimeout(tick, config.rosterRefreshIntervalMs).unref();
}

function startMapsScheduler(db: Awaited<ReturnType<typeof createDb>>, queue: JobQueue, config: ReturnType<typeof readConfig>): void {
  const tick = async () => {
    const countries = await getActiveCountryCodes(db, config);
    await Promise.all(countries.map((country) => enqueueMapsRefreshIfDue(db, queue, country, config.mapsRefreshIntervalMs))).catch((error) => {
      console.warn("[maps] scheduled refresh failed", error);
    });
    setTimeout(tick, config.mapsRefreshIntervalMs).unref();
  };
  setTimeout(tick, 10_000).unref();
}
