import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDb, exec, migrate, type Db } from "../src/db.js";
import { AbuseGuard } from "../src/http/abuse-guard.js";
import { routeHttp } from "../src/http/snapshots.js";

const BRIDGE_TOKEN = "bridge-secret";
const ADMIN_TOKEN = "admin-secret";

let dir = "";
let db: Db;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mania-bug-report-http-"));
  db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
});

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

function request(method: string, url: string, body?: unknown, authorization?: string): IncomingMessage {
  const req = body === undefined
    ? new EventEmitter() as IncomingMessage
    : Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  req.method = method;
  req.url = url;
  req.headers = { host: "localhost", ...(authorization ? { authorization } : {}) };
  return req;
}

function response() {
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

function context(configOverrides: Record<string, unknown> = {}) {
  return {
    db,
    abuse: new AbuseGuard(),
    config: {
      nodeEnv: "test",
      liveAdminToken: ADMIN_TOKEN,
      liveBridgeToken: BRIDGE_TOKEN,
      allowedOrigins: ["*"],
      trackedCountries: ["CR"],
      trustProxyHeaders: false,
      publicApiRatePerMinute: 100,
      publicCostlyRatePerMinute: 100,
      bridgeRatePerMinute: 100,
      bugReportRatePerHour: 5,
      ...configOverrides,
    },
  } as never;
}

async function call(req: IncomingMessage, ctx = context()) {
  const output = response();
  await routeHttp(req, output.res, ctx);
  const raw = output.writes.join("");
  return {
    status: output.res.statusCode,
    body: raw ? JSON.parse(raw) as Record<string, unknown> : null,
  };
}

describe("bug report HTTP routes", () => {
  it("keeps submit and mine behind the bridge while allowing a signed-out payload", async () => {
    const payload = {
      body: "The page stops updating after I switch countries twice.",
      pagePath: "/tracker",
      reporterKey: "ip:opaque",
    };
    expect((await call(request("POST", "/api/bug-reports/submit", payload))).status).toBe(401);

    const submitted = await call(request(
      "POST",
      "/api/bug-reports/submit",
      payload,
      `Bearer ${BRIDGE_TOKEN}`,
    ));
    expect(submitted.status).toBe(200);
    expect(submitted.body?.ok).toBe(true);

    expect((await call(request("GET", "/api/bug-reports/mine?userId=7"))).status).toBe(401);
    const mine = await call(request(
      "GET",
      "/api/bug-reports/mine?userId=7",
      undefined,
      `Bearer ${BRIDGE_TOKEN}`,
    ));
    expect(mine.status).toBe(200);
    expect(mine.body?.reports).toEqual([]);
  });

  it("promotes through the admin route once and writes the linked todo", async () => {
    const submitted = await call(request(
      "POST",
      "/api/bug-reports/submit",
      { body: "Tracker freezes\nIt happens after a country switch.", reporterKey: "user:7", userId: 7 },
      `Bearer ${BRIDGE_TOKEN}`,
    ));
    const id = String(submitted.body?.id);
    const path = "/api/admin/bug-reports/promote-to-todo";
    expect((await call(request("POST", path, { id }, `Bearer ${BRIDGE_TOKEN}`))).status).toBe(401);

    const promoted = await call(request("POST", path, { id }, `Bearer ${ADMIN_TOKEN}`));
    expect(promoted.status).toBe(200);
    expect((promoted.body?.todo as { title?: string; seq?: number }).title).toBe("Tracker freezes");
    expect((promoted.body?.todo as { seq?: number }).seq).toBeGreaterThan(0);
    expect(Number((await exec(db, "select count(*) as n from admin_todos")).rows[0]?.n)).toBe(1);

    const repeated = await call(request("POST", path, { id }, `Bearer ${ADMIN_TOKEN}`));
    expect(repeated.status).toBe(409);
    expect(repeated.body?.todoId).toBe((promoted.body?.todo as { id?: string }).id);
    expect(Number((await exec(db, "select count(*) as n from admin_todos")).rows[0]?.n)).toBe(1);
  });

  it("pre-authorizes attachments and exposes screenshot keys only to the stored reporter", async () => {
    const submitted = await call(request(
      "POST",
      "/api/bug-reports/submit",
      {
        body: "The replay canvas disappears when I open settings.",
        reporterKey: "user:7",
        userId: 7,
        screenshotCount: 1,
      },
      `Bearer ${BRIDGE_TOKEN}`,
    ));
    const id = String(submitted.body?.id);
    const token = String(submitted.body?.uploadToken);
    const key = `bug-reports/${id}/0.png`;

    const authorized = await call(request(
      "POST",
      "/api/bug-reports/authorize-screenshot",
      { id, token, key },
      `Bearer ${BRIDGE_TOKEN}`,
    ));
    expect(authorized.status).toBe(200);
    expect(authorized.body?.alreadyAttached).toBe(false);
    expect((await call(request(
      "POST",
      "/api/bug-reports/attach",
      { id, token, key },
      `Bearer ${BRIDGE_TOKEN}`,
    ))).status).toBe(200);

    expect((await call(request(
      "GET",
      `/api/bug-reports/screenshots?id=${id}&userId=8`,
      undefined,
      `Bearer ${BRIDGE_TOKEN}`,
    ))).status).toBe(404);
    const mine = await call(request(
      "GET",
      `/api/bug-reports/screenshots?id=${id}&userId=7`,
      undefined,
      `Bearer ${BRIDGE_TOKEN}`,
    ));
    expect(mine.status).toBe(200);
    expect(mine.body?.screenshotKeys).toEqual([key]);
  });

  it("uses the dedicated hourly report bucket instead of the shared bridge ceiling", async () => {
    const ctx = context({ bugReportRatePerHour: 2 });
    const statuses: number[] = [];
    for (let index = 0; index < 3; index += 1) {
      statuses.push((await call(request(
        "POST",
        "/api/bug-reports/submit",
        { body: `Rate-limit report ${index} has enough useful detail.`, reporterKey: "ip:opaque" },
        `Bearer ${BRIDGE_TOKEN}`,
      ), ctx)).status);
    }
    expect(statuses).toEqual([200, 200, 429]);
  });
});
