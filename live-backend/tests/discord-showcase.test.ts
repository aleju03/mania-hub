import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import { getDiscordShowcase } from "../src/discord/showcase.js";
import { AbuseGuard } from "../src/http/abuse-guard.js";
import { routeHttp } from "../src/http/snapshots.js";
import { JobQueue } from "../src/jobs/queue.js";
import { LiveEventLog } from "../src/live/event-log.js";

const mapsFeatureCalls = vi.hoisted(() => ({
  pages: [] as unknown[][],
  snapshots: [] as unknown[][],
}));

vi.mock("../src/features/maps.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/features/maps.js")>();
  return {
    ...actual,
    getMapsPageSnapshot: (...args: Parameters<typeof actual.getMapsPageSnapshot>) => {
      mapsFeatureCalls.pages.push(args);
      return actual.getMapsPageSnapshot(...args);
    },
    getMapsSnapshot: (...args: Parameters<typeof actual.getMapsSnapshot>) => {
      mapsFeatureCalls.snapshots.push(args);
      return actual.getMapsSnapshot(...args);
    },
  };
});

let dir = "";
let db: Db;
let queue: JobQueue;
let events: LiveEventLog;

beforeEach(async () => {
  mapsFeatureCalls.pages.length = 0;
  mapsFeatureCalls.snapshots.length = 0;
  dir = await mkdtemp(join(tmpdir(), "mania-discord-showcase-"));
  db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
  queue = new JobQueue(db);
  events = new LiveEventLog(db);
});

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

const config = {
  nodeEnv: "development",
  allowedOrigins: ["http://localhost:3000"],
  trackedCountries: ["CR"],
  trustProxyHeaders: true,
  publicApiRatePerMinute: 240,
  publicCostlyRatePerMinute: 60,
  mapsRefreshIntervalMs: 7 * 24 * 60 * 60 * 1000,
};

function deps() {
  return { db, osu: {}, queue, config } as never as Parameters<typeof getDiscordShowcase>[0];
}

function mockReq(url: string): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage;
  req.method = "GET";
  req.url = url;
  req.headers = { host: "localhost" };
  return req;
}

function mockRes() {
  const writes: string[] = [];
  const headers: Record<string, string> = {};
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200,
    setHeader: (key: string, value: number | string | readonly string[]) => {
      headers[key.toLowerCase()] = Array.isArray(value) ? value.join(",") : String(value);
    },
    getHeader: (key: string) => headers[key.toLowerCase()],
    writeHead: (status: number) => {
      res.statusCode = status;
      return res;
    },
    write: (chunk: string | Buffer) => {
      writes.push(String(chunk));
      return true;
    },
    destroy: () => {},
    end: (chunk?: string | Buffer) => {
      if (chunk != null) writes.push(String(chunk));
    },
  }) as unknown as ServerResponse & { statusCode: number };
  return { res, writes };
}

describe("getDiscordShowcase build stampede protection", () => {
  it("single-flights concurrent fresh builds and floors fresh rebuilds to the minimum interval", async () => {
    const first = getDiscordShowcase(deps(), "CR", true);
    // A second fresh request while the build is in flight joins it instead of
    // starting another build (referential equality: same promise).
    expect(getDiscordShowcase(deps(), "CR", true)).toBe(first);
    await first;
    // A fresh request right after completion is inside the rebuild-interval
    // floor, so it still serves the cached build.
    expect(getDiscordShowcase(deps(), "CR", true)).toBe(first);
    expect(getDiscordShowcase(deps(), "CR", false)).toBe(first);
  });

  it("does not evict a pending or cooldown-protected GLOBAL build when the country cache exceeds its cap", async () => {
    const first = getDiscordShowcase(deps(), "GLOBAL", true);
    const builds = [first];
    // GLOBAL plus 24 distinct country keys takes the cache one entry over its
    // settled-entry cap. All calls are made synchronously, so every promise is
    // still pending when GLOBAL is requested again.
    for (let index = 0; index < 24; index++) {
      builds.push(getDiscordShowcase(deps(), `X${String.fromCharCode(65 + index)}`, true));
    }

    expect(getDiscordShowcase(deps(), "GLOBAL", true)).toBe(first);
    await Promise.all(builds);
    // Capacity pressure must not become a way around the fresh-rebuild floor
    // immediately after those promises settle.
    expect(getDiscordShowcase(deps(), "GLOBAL", true)).toBe(first);
  });
});

describe("/api/discord/showcase", () => {
  it("serves GLOBAL fresh requests without the full core maps hydrate", async () => {
    // A stale GLOBAL maps row with an unparseable payload: the bounded
    // farmed-page read degrades to an empty maps section instead of failing
    // the showcase. Feature-call instrumentation below is the regression
    // guard that proves this route never invokes the core snapshot path.
    const staleRefreshedAt = "2020-01-01T00:00:00.000Z";
    await exec(
      db,
      `insert into country_maps_snapshots (country, payload_json, generated_at, refreshed_at)
       values ('GLOBAL', ?, ?, ?)`,
      ["{not json", staleRefreshedAt, staleRefreshedAt],
    );
    const ctx = {
      db,
      queue,
      events,
      abuse: new AbuseGuard(),
      config,
      osu: {},
      oscStatus: () => ({ connected: false, lastBatchAt: null, lastError: null }),
    } as never;

    const { res, writes } = mockRes();
    await routeHttp(mockReq("/api/discord/showcase?country=GLOBAL&fresh=1"), res, ctx);

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(writes.join("")) as { mapsFarmed: unknown[]; randomFav: unknown };
    expect(body.mapsFarmed).toEqual([]);
    expect(body.randomFav).toBeNull();
    expect(mapsFeatureCalls.pages.some((args) =>
      args[2] === "GLOBAL"
      && (args[4] as { tab?: string; pageSize?: number } | undefined)?.tab === "farmed"
      && (args[4] as { pageSize?: number } | undefined)?.pageSize === 48
    )).toBe(true);
    expect(mapsFeatureCalls.snapshots.some((args) =>
      args[2] === "GLOBAL" && (args[4] ?? "core") === "core"
    )).toBe(false);
  });
});
