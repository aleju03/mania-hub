import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDb, migrate } from "../src/db.js";
import type { HttpContext } from "../src/http/context.js";
import { handleSnapshotRoutes } from "../src/http/routes/snapshots.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  dirs.length = 0;
});

function mockReq(path: string): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage;
  req.method = "GET";
  req.url = path;
  req.headers = { host: "localhost" };
  return req;
}

function mockRes(): ServerResponse & { body: string } {
  const headers = new Map<string, string>();
  const res = {
    statusCode: 200,
    body: "",
    setHeader(name: string, value: number | string | readonly string[]) {
      headers.set(name.toLowerCase(), Array.isArray(value) ? value.join(",") : String(value));
      return this;
    },
    getHeader(name: string) {
      return headers.get(name.toLowerCase());
    },
    end(chunk?: string | Buffer) {
      if (chunk != null) this.body += String(chunk);
      return this;
    },
  };
  return res as unknown as ServerResponse & { body: string };
}

describe("farm helper HTTP subject gate", () => {
  it("rejects unknown subjects on every public profile-hydrating route without touching osu!", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mania-fh-http-gate-"));
    dirs.push(dir);
    const db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
    await migrate(db);
    let osuCalls = 0;
    const osu = new Proxy({}, {
      get: () => () => {
        osuCalls += 1;
        throw new Error("unexpected osu! call");
      },
    });
    const ctx = {
      db,
      osu,
      config: { allowedOrigins: [], liveAdminToken: "", liveBridgeToken: "" },
    } as unknown as HttpContext;

    for (const path of [
      "/api/snapshots/farm-helper?user=arbitrary-player",
      "/api/snapshots/farm-helper-farmers?user=arbitrary-player&beatmap=1",
      "/api/snapshots/farm-helper-neighbors?user=arbitrary-player",
    ]) {
      const req = mockReq(path);
      const res = mockRes();
      expect(await handleSnapshotRoutes(req, res, ctx, new URL(path, "http://localhost"), "CR")).toBe(true);
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body)).toEqual({ error: "user_not_found" });
    }
    expect(osuCalls).toBe(0);
  });
});
