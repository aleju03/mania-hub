import { createServer } from "node:http";
import { readConfig } from "./config.js";
import { ensurePinnedCountries, getIndexedCountryCodes, getMapsWarmCountryCodes } from "./countries.js";
import { createDb, logApiCall, migrate } from "./db.js";
import { routeHttp, sendNotFound } from "./http/snapshots.js";
import { ScoreIngestor } from "./ingest/score-ingestor.js";
import { JobQueue } from "./jobs/queue.js";
import { LiveEventLog } from "./live/event-log.js";
import { deferMapsRefreshesWaitingForRoster, enqueueGlobalMapsRefreshIfDue, enqueueMapsRefreshIfDue } from "./features/maps.js";
import { AbuseGuard } from "./http/abuse-guard.js";
import { CountryClientTracker } from "./live/country-clients.js";
import { handleSse } from "./live/sse.js";
import { enqueueOscBackfill } from "./osc/backfill.js";
import { OscSocketClient } from "./osc/client.js";
import { startScoresFallbackScheduler } from "./osc/scores-fallback.js";
import { OsuApiClient } from "./osu/client.js";
import { enqueueRosterRefreshes } from "./rosters/country-rosters.js";
import { startRetentionScheduler } from "./retention.js";
import { WorkerRunner } from "./workers.js";

export async function createApp() {
  const config = readConfig();
  const db = await createDb(config);
  await migrate(db);
  const queue = new JobQueue(db);
  await queue.shedPressure();
  const events = new LiveEventLog(db);
  await deferMapsRefreshesWaitingForRoster(db);
  await ensurePinnedCountries(db, config);
  const logOsuCall = (entry: { caller: string; path: string; startedAt: number }) => {
    void logApiCall(db, {
      provider: "osu",
      caller: entry.caller,
      path: entry.path,
      startedAt: new Date(entry.startedAt).toISOString(),
    }).catch(() => {});
  };
  const osu = new OsuApiClient(config, fetch, logOsuCall);
  const scoresFallbackOsu = new OsuApiClient(getScoresFallbackOsuConfig(config), fetch, logOsuCall);
  const ingestor = new ScoreIngestor(db, queue, events, config);
  const abuse = new AbuseGuard();
  const countryClients = new CountryClientTracker();
  const osc = new OscSocketClient(
    config,
    ingestor,
    config.enableOscBackfill ? () => enqueueOscBackfill(queue, db, config) : undefined,
  );
  if (config.enableStartupRosterRefresh && osu.hasCredentials()) {
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
  return { server, db, queue, events, osu, scoresFallbackOsu, osc, worker, ingestor, config, countryClients };
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
  if (app.config.enableWorkers && app.config.enableOsuScoresFallback && app.osu.hasCredentials()) {
    startScoresFallbackScheduler(app.db, app.config, app.scoresFallbackOsu, app.ingestor, () => app.osc.status());
  }
  app.server.listen(app.config.port, () => {
    console.log(`[live-backend] listening on ${app.config.livePublicOrigin} (port ${app.config.port})`);
  });
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
