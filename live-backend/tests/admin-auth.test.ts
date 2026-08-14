import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readConfig } from "../src/config.js";
import { createDb, migrate, type Db } from "../src/db.js";
import { AbuseGuard } from "../src/http/abuse-guard.js";
import { routeHttp } from "../src/http/snapshots.js";
import { JobQueue } from "../src/jobs/queue.js";
import { LiveEventLog } from "../src/live/event-log.js";

let dir = "";
let db: Db;
let queue: JobQueue;
let events: LiveEventLog;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mania-admin-auth-"));
  db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
  queue = new JobQueue(db);
  events = new LiveEventLog(db);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  if (dir) await rm(dir, { recursive: true, force: true });
});

function ctx(configOverrides: Record<string, unknown> = {}) {
  return {
    db,
    queue,
    events,
    abuse: new AbuseGuard(),
    config: {
      nodeEnv: "development",
      liveAdminToken: undefined,
      allowedOrigins: ["http://localhost:3000"],
      trackedCountries: ["CR"],
      trustProxyHeaders: true,
      publicApiRatePerMinute: 240,
      publicCostlyRatePerMinute: 60,
      ...configOverrides,
    },
    osu: { limiter: { state: () => ({ hardPerMinute: 60, usedLastMinute: 0 }) } },
    oscStatus: () => ({ connected: false, lastBatchAt: null, lastError: null }),
  } as never;
}

function mockReq(url: string, headers: IncomingMessage["headers"] = {}): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage;
  req.method = "GET";
  req.url = url;
  req.headers = { host: "localhost", ...headers };
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

async function call(url: string, headers: IncomingMessage["headers"] = {}, configOverrides: Record<string, unknown> = {}) {
  const response = mockRes();
  await routeHttp(mockReq(url, headers), response.res, ctx(configOverrides));
  const raw = response.writes.join("");
  let body: ReturnType<typeof JSON.parse> = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = raw;
  }
  return { status: response.res.statusCode, body };
}

const PROTECTED = "/api/admin/todos";
const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("admin authorization fails closed", () => {
  it("denies protected endpoints when no token is configured in development", async () => {
    const result = await call(PROTECTED, {}, { nodeEnv: "development", liveAdminToken: undefined });
    expect(result.status).toBe(401);
    expect(result.body).toEqual({ error: "unauthorized" });
  });

  it("denies protected endpoints when no token is configured in production", async () => {
    const result = await call(PROTECTED, {}, { nodeEnv: "production", liveAdminToken: undefined });
    expect(result.status).toBe(401);
  });

  it("denies bearer requests when no token is configured (nothing to match)", async () => {
    const result = await call(PROTECTED, { authorization: `Bearer ${TOKEN}` }, { liveAdminToken: undefined });
    expect(result.status).toBe(401);
  });

  it("denies requests without an authorization header", async () => {
    const result = await call(PROTECTED, {}, { liveAdminToken: TOKEN });
    expect(result.status).toBe(401);
  });

  it("denies malformed authorization headers", async () => {
    for (const authorization of [`Token ${TOKEN}`, `bearer ${TOKEN}`, TOKEN, "Bearer", "Bearer "]) {
      const result = await call(PROTECTED, { authorization }, { liveAdminToken: TOKEN });
      expect(result.status, `header: ${authorization}`).toBe(401);
    }
  });

  it("denies an incorrect token of the same length", async () => {
    const wrong = `${TOKEN.slice(0, -1)}0`;
    const result = await call(PROTECTED, { authorization: `Bearer ${wrong}` }, { liveAdminToken: TOKEN });
    expect(result.status).toBe(401);
  });

  it("allows the correct token in development and production", async () => {
    for (const nodeEnv of ["development", "production"]) {
      const result = await call(PROTECTED, { authorization: `Bearer ${TOKEN}` }, { nodeEnv, liveAdminToken: TOKEN });
      expect(result.status, `nodeEnv: ${nodeEnv}`).toBe(200);
      expect(result.body).toEqual({ todos: [] });
    }
  });

  it("keeps public endpoints working without a token", async () => {
    const result = await call("/healthz", {}, { liveAdminToken: undefined });
    expect(result.status).toBe(200);
    expect(result.body?.ok).toBe(true);
  });
});

/* Two credentials, two capabilities. The admin token reaches the admin panel
   and the destructive actions; the bridge token is what the frontend's server
   functions carry when they act for a signed-in player. Handing one credential
   both jobs meant a leak of it could write as anyone on the site. */
const BRIDGE = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
const BRIDGED = "/api/goals?userId=1";

describe("admin/bridge token split", () => {
  it("keeps the admin token working everywhere while no bridge token is configured", async () => {
    const config = { liveAdminToken: TOKEN, liveBridgeToken: undefined };
    expect((await call(PROTECTED, { authorization: `Bearer ${TOKEN}` }, config)).status).toBe(200);
    expect((await call(BRIDGED, { authorization: `Bearer ${TOKEN}` }, config)).status).toBe(200);
  });

  it("takes the per-user routes off the admin token once the bridge token exists", async () => {
    const config = { liveAdminToken: TOKEN, liveBridgeToken: BRIDGE };
    expect((await call(BRIDGED, { authorization: `Bearer ${BRIDGE}` }, config)).status).toBe(200);
    expect((await call(BRIDGED, { authorization: `Bearer ${TOKEN}` }, config)).status).toBe(401);
  });

  it("keeps the admin panel off the bridge token", async () => {
    const config = { liveAdminToken: TOKEN, liveBridgeToken: BRIDGE };
    expect((await call(PROTECTED, { authorization: `Bearer ${BRIDGE}` }, config)).status).toBe(401);
    expect((await call(PROTECTED, { authorization: `Bearer ${TOKEN}` }, config)).status).toBe(200);
  });

  it("still fails closed for an anonymous caller either way", async () => {
    for (const config of [{ liveAdminToken: TOKEN }, { liveAdminToken: TOKEN, liveBridgeToken: BRIDGE }]) {
      expect((await call(BRIDGED, {}, config)).status).toBe(401);
      expect((await call(PROTECTED, {}, config)).status).toBe(401);
    }
  });
});

describe("readConfig LIVE_BRIDGE_TOKEN validation", () => {
  it("refuses a bridge token identical to the admin token", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("LIVE_ADMIN_TOKEN", TOKEN);
    vi.stubEnv("LIVE_BRIDGE_TOKEN", TOKEN);
    expect(() => readConfig()).toThrow(/must differ/);
  });

  it("rejects a short bridge token in production and accepts a long one", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("LIVE_ADMIN_TOKEN", TOKEN);
    vi.stubEnv("LIVE_BRIDGE_TOKEN", "short-token");
    expect(() => readConfig()).toThrow(/at least 32 characters/);
    vi.stubEnv("LIVE_BRIDGE_TOKEN", BRIDGE);
    expect(readConfig().liveBridgeToken).toBe(BRIDGE);
  });

  it("leaves the bridge unset (and so equal to the admin token) by default", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("LIVE_ADMIN_TOKEN", TOKEN);
    expect(readConfig().liveBridgeToken).toBeUndefined();
  });
});

describe("readConfig LIVE_ADMIN_TOKEN validation", () => {
  it("rejects a short token in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("LIVE_ADMIN_TOKEN", "short-token");
    expect(() => readConfig()).toThrow(/at least 32 characters/);
  });

  it("accepts a long token in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("LIVE_ADMIN_TOKEN", TOKEN);
    expect(readConfig().liveAdminToken).toBe(TOKEN);
  });

  it("keeps a short token in development for local convenience", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("LIVE_ADMIN_TOKEN", "short-token");
    expect(readConfig().liveAdminToken).toBe("short-token");
  });

  it("treats a blank token as unset", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("LIVE_ADMIN_TOKEN", "   ");
    expect(readConfig().liveAdminToken).toBeUndefined();
  });
});
