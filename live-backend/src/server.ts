import { createServer } from "node:http";
import { readConfig } from "./config.js";
import { createDb, exec, migrate } from "./db.js";
import { routeHttp, sendNotFound } from "./http/snapshots.js";
import { ScoreIngestor } from "./ingest/score-ingestor.js";
import { JobQueue } from "./jobs/queue.js";
import { LiveEventLog } from "./live/event-log.js";
import { handleSse } from "./live/sse.js";
import { OscBackfill } from "./osc/backfill.js";
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
  const osu = new OsuApiClient(config, fetch, (entry) => {
    void exec(db, "insert into api_call_log (provider, caller, path, started_at) values ('osu', ?, ?, ?)", [
      entry.caller,
      entry.path,
      new Date(entry.startedAt).toISOString(),
    ]).catch(() => {});
  });
  const ingestor = new ScoreIngestor(db, queue, events, config);
  const osc = new OscSocketClient(config, ingestor);
  if (osu.hasCredentials()) {
    await enqueueRosterRefreshes(queue, config.trackedCountries);
  }
  const worker = new WorkerRunner(db, queue, events, osu);
  const ctx = {
    db,
    queue,
    events,
    config,
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
  app.worker.start();
  startRosterScheduler(app.queue, app.config);
  startRetentionScheduler(app.db, app.config);
  new OscBackfill(app.config).run(app.db, app.ingestor).catch((error) => console.warn("[osc] backfill failed", error));
  app.osc.start().catch((error) => console.warn("[osc] socket failed", error));
  app.server.listen(app.config.port, () => {
    console.log(`[live-backend] listening on ${app.config.livePublicOrigin} (port ${app.config.port})`);
  });
}

function startRosterScheduler(queue: JobQueue, config: ReturnType<typeof readConfig>): void {
  const tick = async () => {
    await enqueueRosterRefreshes(queue, config.trackedCountries).catch((error) => {
      console.warn("[roster] scheduled refresh failed", error);
    });
    setTimeout(tick, config.rosterRefreshIntervalMs).unref();
  };
  setTimeout(tick, config.rosterRefreshIntervalMs).unref();
}
