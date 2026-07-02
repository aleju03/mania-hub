import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, migrate, type Db } from "../src/db.js";
import { AbuseGuard } from "../src/http/abuse-guard.js";
import { routeHttp } from "../src/http/snapshots.js";
import { JobQueue } from "../src/jobs/queue.js";
import { LiveEventLog } from "../src/live/event-log.js";

// Stub only the network-touching R2 calls; key builders stay real so the
// endpoint flow exercises genuine storage keys.
vi.mock("../src/skins/r2.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/skins/r2.js")>();
  return {
    ...original,
    isSkinStorageConfigured: vi.fn(() => true),
    uploadSkinObject: vi.fn(async (_config: unknown, key: string, buffer: Buffer) => ({
      storageKey: key,
      sizeBytes: buffer.length,
      url: `https://cdn.test/${key}`,
    })),
    deleteSkinObjects: vi.fn(async () => {}),
  };
});

import { deleteSkinObjects, uploadSkinObject } from "../src/skins/r2.js";

let dir = "";
let db: Db;
let queue: JobQueue;
let events: LiveEventLog;

const ADMIN = { authorization: "Bearer secret" };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mania-skins-http-"));
  db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
  queue = new JobQueue(db);
  events = new LiveEventLog(db);
  vi.mocked(uploadSkinObject).mockClear();
  vi.mocked(deleteSkinObjects).mockClear();
});

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

function ctx() {
  return {
    db,
    queue,
    events,
    abuse: new AbuseGuard(),
    config: {
      nodeEnv: "production",
      liveAdminToken: "secret",
      allowedOrigins: ["http://localhost:3000"],
      trackedCountries: ["CR"],
      trustProxyHeaders: true,
      publicApiRatePerMinute: 240,
      publicCostlyRatePerMinute: 60,
      skinUploadRatePerMinute: 60,
      skinOskMaxBytes: 65 * 1024 * 1024,
      skinImageMaxBytes: 4 * 1024 * 1024,
    },
    osu: { limiter: { state: () => ({ hardPerMinute: 60, usedLastMinute: 0 }) } },
    oscStatus: () => ({ connected: false, lastBatchAt: null, lastError: null }),
  } as never;
}

function mockReq(method: string, url: string, headers: IncomingMessage["headers"] = {}): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage;
  req.method = method;
  req.url = url;
  req.headers = { host: "localhost", ...headers };
  return req;
}

function bodyReq(method: string, url: string, body: Buffer | string, headers: IncomingMessage["headers"] = {}): IncomingMessage {
  const req = Readable.from([Buffer.isBuffer(body) ? body : Buffer.from(body)]) as unknown as IncomingMessage;
  req.method = method;
  req.url = url;
  req.headers = { host: "localhost", ...headers };
  return req;
}

function mockRes() {
  const writes: string[] = [];
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 200,
    setHeader: (key: string, value: number | string | readonly string[]) => {
      headers[key.toLowerCase()] = Array.isArray(value) ? value.join(",") : String(value);
    },
    getHeader: (key: string) => headers[key.toLowerCase()],
    writeHead: (status: number) => {
      res.statusCode = status;
      return res;
    },
    write: (chunk: string) => {
      writes.push(String(chunk));
      return true;
    },
    end: (chunk?: string | Buffer) => {
      if (chunk != null) writes.push(String(chunk));
    },
  } as unknown as ServerResponse & { statusCode: number };
  return { res, writes, headers };
}

async function call(req: IncomingMessage) {
  const response = mockRes();
  await routeHttp(req, response.res, ctx());
  const raw = response.writes.join("");
  return { status: response.res.statusCode, body: raw ? JSON.parse(raw) : null, headers: response.headers };
}

async function buildOskBuffer(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("skin.ini", "[General]\nName: Cloudy Skies\nAuthor: sona\n\n[Mania]\nKeys: 4\nColourLight1: 255,102,170\n\n[Mania]\nKeys: 7\n");
  return zip.generateAsync({ type: "nodebuffer" });
}

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

async function startUpload(): Promise<{ id: string; token: string }> {
  const started = await call(bodyReq(
    "POST",
    "/api/skins/start",
    JSON.stringify({ userId: 101, username: "delta", name: "Cloudy Skies" }),
    ADMIN,
  ));
  expect(started.status).toBe(200);
  return { id: started.body.id as string, token: started.body.token as string };
}

describe("skins HTTP endpoints", () => {
  it("publishes a skin end to end: start, upload parts, finish, list, get", async () => {
    expect((await call(mockReq("POST", "/api/skins/start"))).status).toBe(401);

    const { id, token } = await startUpload();

    const badToken = await call(bodyReq("POST", `/api/skins/upload?id=${id}&token=nope&part=osk`, await buildOskBuffer()));
    expect(badToken.status).toBe(403);
    expect(badToken.body).toMatchObject({ error: "invalid_ticket" });

    const notZip = await call(bodyReq("POST", `/api/skins/upload?id=${id}&token=${token}&part=osk`, "not a zip"));
    expect(notZip.status).toBe(400);
    expect(notZip.body).toMatchObject({ error: "invalid_osk", reason: "not_a_zip" });

    const osk = await call(bodyReq("POST", `/api/skins/upload?id=${id}&token=${token}&part=osk`, await buildOskBuffer()));
    expect(osk.status).toBe(200);
    expect(osk.body).toMatchObject({ ok: true, keymodes: [4, 7] });

    const notImage = await call(bodyReq("POST", `/api/skins/upload?id=${id}&token=${token}&part=preview`, "<svg/>"));
    expect(notImage.status).toBe(400);
    expect(notImage.body).toMatchObject({ error: "invalid_image" });

    const preview = await call(bodyReq("POST", `/api/skins/upload?id=${id}&token=${token}&part=preview&w=1280&h=720`, PNG_BYTES));
    expect(preview.status).toBe(200);

    const finished = await call(mockReq("POST", `/api/skins/finish?id=${id}&token=${token}`));
    expect(finished.status).toBe(200);
    expect(finished.body.skin).toMatchObject({
      id,
      name: "Cloudy Skies",
      ownerUserId: 101,
      ownerUsername: "delta",
      keymodes: [4, 7],
      accentColor: "#ff66aa",
      status: "published",
      downloadCount: 0,
      previewWidth: 1280,
      previewHeight: 720,
    });
    expect(finished.body.skin.uploadToken).toBeUndefined();
    expect(finished.body.skin.oskUrl).toContain("https://cdn.test/skins/");

    // the ticket is dead after publishing
    expect((await call(mockReq("POST", `/api/skins/finish?id=${id}&token=${token}`))).status).toBe(403);

    const list = await call(mockReq("GET", "/api/skins/list"));
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(1);
    expect(list.headers["cache-control"]).toContain("max-age=60");

    const got = await call(mockReq("GET", `/api/skins/get?id=${id}`));
    expect(got.status).toBe(200);
    expect(got.body.skin.id).toBe(id);

    // download redirects through the counter to the R2 URL
    const download = await call(mockReq("GET", `/api/skins/download?id=${id}`));
    expect(download.status).toBe(302);
    expect(download.headers.location).toContain("https://cdn.test/skins/");
    expect((await call(mockReq("GET", `/api/skins/get?id=${id}`))).body.skin.downloadCount).toBe(1);
    expect((await call(mockReq("GET", "/api/skins/download?id=missing"))).status).toBe(404);
  });

  it("requires both osk and preview before finish", async () => {
    const { id, token } = await startUpload();
    expect((await call(mockReq("POST", `/api/skins/finish?id=${id}&token=${token}`))).body).toMatchObject({ error: "missing_osk" });
    await call(bodyReq("POST", `/api/skins/upload?id=${id}&token=${token}&part=osk`, await buildOskBuffer()));
    expect((await call(mockReq("POST", `/api/skins/finish?id=${id}&token=${token}`))).body).toMatchObject({ error: "missing_preview" });
  });

  it("hides, unhides, and deletes through moderation, and enforces owner-only deletes", async () => {
    const { id, token } = await startUpload();
    await call(bodyReq("POST", `/api/skins/upload?id=${id}&token=${token}&part=osk`, await buildOskBuffer()));
    await call(bodyReq("POST", `/api/skins/upload?id=${id}&token=${token}&part=preview`, PNG_BYTES));
    await call(mockReq("POST", `/api/skins/finish?id=${id}&token=${token}`));

    const hide = await call(bodyReq("POST", "/api/admin/skins/moderate", JSON.stringify({ id, action: "hide" }), ADMIN));
    expect(hide.status).toBe(200);
    expect((await call(mockReq("GET", `/api/skins/get?id=${id}`))).status).toBe(404);
    expect((await call(mockReq("GET", "/api/skins/list"))).body.total).toBe(0);
    expect((await call(mockReq("GET", `/api/skins/get?id=${id}`, ADMIN))).status).toBe(200);
    expect((await call(mockReq("GET", "/api/skins/list?includeHidden=1", ADMIN))).body.total).toBe(1);
    // includeHidden is admin-only
    expect((await call(mockReq("GET", "/api/skins/list?includeHidden=1"))).body.total).toBe(0);

    const unhide = await call(bodyReq("POST", "/api/admin/skins/moderate", JSON.stringify({ id, action: "unhide" }), ADMIN));
    expect(unhide.status).toBe(200);
    expect((await call(mockReq("GET", `/api/skins/get?id=${id}`))).status).toBe(200);

    const wrongOwner = await call(bodyReq("POST", "/api/skins/delete", JSON.stringify({ userId: 202, id }), ADMIN));
    expect(wrongOwner.status).toBe(404);

    const ownerDelete = await call(bodyReq("POST", "/api/skins/delete", JSON.stringify({ userId: 101, id }), ADMIN));
    expect(ownerDelete.status).toBe(200);
    expect((await call(mockReq("GET", `/api/skins/get?id=${id}`, ADMIN))).status).toBe(404);
    expect(vi.mocked(deleteSkinObjects)).toHaveBeenCalled();
    const deletedKeys = vi.mocked(deleteSkinObjects).mock.calls.at(-1)?.[1] as string[];
    expect(deletedKeys.some((key) => key.endsWith(".osk"))).toBe(true);
  });

  it("rejects oversized osk uploads before buffering", async () => {
    const { id, token } = await startUpload();
    const oversized = await call(mockReq("POST", `/api/skins/upload?id=${id}&token=${token}&part=osk`, {
      "content-length": String(66 * 1024 * 1024),
    }));
    expect(oversized.status).toBe(413);
    expect(oversized.body).toMatchObject({ error: "payload_too_large" });
  });
});
