import type { IncomingMessage } from "node:http";
import type { Config } from "../config.js";
import type { Db } from "../db.js";
import type { AnalyticsStore } from "../features/analytics.js";
import type { FarmHelperTimings } from "../features/farm-helper-timing.js";
import type { JobQueue } from "../jobs/queue.js";
import type { CountryClientTracker } from "../live/country-clients.js";
import type { LiveEventLog } from "../live/event-log.js";
// Type-only: live/ghost.ts imports helpers from the http modules, so a value
// import here would close the cycle.
import type { GhostHub } from "../live/ghost.js";
import type { OscStatus } from "../osc/client.js";
import type { OsuApiClient } from "../osu/client.js";
import type { DiscordRuntime } from "../discord/index.js";
import type { AbuseGuard } from "./abuse-guard.js";

export interface HttpContext {
  db: Db;
  queue: JobQueue;
  // Dedicated write connection + queue for the page-serving path's best-effort
  // bookkeeping (country touch + refresh scheduling). Kept off `db` so those
  // writes never share the connection that serves a page-load read: a stuck
  // write on the serving connection would otherwise queue behind it and freeze
  // every read (the whole-site freeze this fixes). Absent in tests / worker role,
  // in which case the serving path stays read-only and skips the bookkeeping.
  serveWriteDb?: Db;
  serveWriteQueue?: JobQueue;
  events: LiveEventLog;
  config: Config;
  abuse?: AbuseGuard;
  countryClients?: CountryClientTracker;
  osu: OsuApiClient;
  // Separate osu! client (and limiter) the scores fallback poller runs on, so
  // its own rate bucket can be surfaced. Optional: not every context wires it.
  scoresFallbackOsu?: OsuApiClient;
  oscStatus: () => OscStatus;
  workerStatus?: () => {
    paused: boolean;
    stopped: boolean;
    workerId: string;
    lanes?: Array<{
      name: string;
      claimLimit: number;
      intervalMs: number;
      jobTypes: string[] | null;
      activeJobs: Array<{
        id: number;
        type: string;
        dedupeKey: string;
        attempts: number;
        startedAt: string;
        payload: unknown;
      }>;
    }>;
  };
  pauseWorkers?: () => void;
  resumeWorkers?: () => void;
  discord?: DiscordRuntime;
  analytics?: AnalyticsStore;
  // Admin ghost overlay sessions and viewer streams (serving process only).
  ghost?: GhostHub;
}

export const REQUEST_STARTED_AT = Symbol("maniaHubRequestStartedAt");
// Stage-level Farm Helper timings, stashed on the request so both the response
// header and the slow-request log in routeHttp's finally can read them without
// threading a collector through every send helper.
export const REQUEST_FARM_HELPER_TIMINGS = Symbol("maniaHubFarmHelperTimings");
export type TimedRequest = IncomingMessage & {
  [REQUEST_STARTED_AT]?: number;
  [REQUEST_FARM_HELPER_TIMINGS]?: FarmHelperTimings;
};
