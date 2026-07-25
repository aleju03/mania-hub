import { createHash } from "node:crypto";
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
    getSkinObject: vi.fn(async (_config: unknown, key: string) => ({
      body: Readable.from([Buffer.from(`object:${key}`)]),
      contentType: key.endsWith(".osk") ? "application/octet-stream" : "image/webp",
      contentLength: 8,
      contentDisposition: key.endsWith(".osk") ? 'attachment; filename="skin.osk"' : null,
    })),
  };
});

import { deleteSkinObjects, getSkinObject, uploadSkinObject } from "../src/skins/r2.js";

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
  // An EventEmitter base so Readable.pipe() (the /api/skins/file stream) works.
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
  return { res, writes, headers };
}

async function call(req: IncomingMessage) {
  const response = mockRes();
  await routeHttp(req, response.res, ctx());
  // Let a piped stream (the file endpoint) flush before reading writes.
  await new Promise((resolve) => setImmediate(resolve));
  const raw = response.writes.join("");
  // Same loose typing JSON.parse gave the original helper; binary responses
  // (the file endpoint) fall back to the raw string.
  let body: ReturnType<typeof JSON.parse> = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = raw;
  }
  return { status: response.res.statusCode, body, headers: response.headers };
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
    // The counter still ticks; it just only comes back with the admin token.
    expect((await call(mockReq("GET", `/api/skins/get?id=${id}`, ADMIN))).body.skin.downloadCount).toBe(1);
    expect((await call(mockReq("GET", "/api/skins/download?id=missing"))).status).toBe(404);
  });

  it("keeps download counts to admin responses", async () => {
    const { id, token } = await startUpload();
    await call(bodyReq("POST", `/api/skins/upload?id=${id}&token=${token}&part=osk`, await buildOskBuffer()));
    await call(bodyReq("POST", `/api/skins/upload?id=${id}&token=${token}&part=preview`, PNG_BYTES));
    // Publishing hands the uploader their own skin back, counts included in
    // neither that response nor any public read.
    const finished = await call(mockReq("POST", `/api/skins/finish?id=${id}&token=${token}`));
    expect(finished.body.skin.downloadCount).toBeNull();
    await call(mockReq("GET", `/api/skins/download?id=${id}`));
    await call(mockReq("GET", `/api/skins/download?id=${id}`));

    expect((await call(mockReq("GET", `/api/skins/get?id=${id}`))).body.skin.downloadCount).toBeNull();
    expect((await call(mockReq("GET", "/api/skins/list"))).body.skins[0].downloadCount).toBeNull();

    expect((await call(mockReq("GET", `/api/skins/get?id=${id}`, ADMIN))).body.skin.downloadCount).toBe(2);
    expect((await call(mockReq("GET", "/api/skins/list", ADMIN))).body.skins[0].downloadCount).toBe(2);
    // An admin read must not land in a shared cache.
    expect((await call(mockReq("GET", "/api/skins/list", ADMIN))).headers["cache-control"]).toBeUndefined();
  });

  it("requires both osk and preview before finish", async () => {
    const { id, token } = await startUpload();
    expect((await call(mockReq("POST", `/api/skins/finish?id=${id}&token=${token}`))).body).toMatchObject({ error: "missing_osk" });
    await call(bodyReq("POST", `/api/skins/upload?id=${id}&token=${token}&part=osk`, await buildOskBuffer()));
    expect((await call(mockReq("POST", `/api/skins/finish?id=${id}&token=${token}`))).body).toMatchObject({ error: "missing_preview" });
  });

  it("refuses a re-upload of an already published .osk, at the ticket and at the archive", async () => {
    const osk = await buildOskBuffer();
    const sha256 = createHash("sha256").update(osk).digest("hex");
    const first = await startUpload();
    await call(bodyReq("POST", `/api/skins/upload?id=${first.id}&token=${first.token}&part=osk`, osk));
    await call(bodyReq("POST", `/api/skins/upload?id=${first.id}&token=${first.token}&part=preview`, PNG_BYTES));
    await call(mockReq("POST", `/api/skins/finish?id=${first.id}&token=${first.token}`));

    // The client sends the hash up front, so no ticket is minted at all.
    const started = await call(bodyReq(
      "POST",
      "/api/skins/start",
      JSON.stringify({ userId: 202, username: "echo", name: "Cloudy Skies Again", oskSha256: sha256 }),
      ADMIN,
    ));
    expect(started.status).toBe(409);
    expect(started.body).toMatchObject({
      error: "duplicate",
      duplicate: { id: first.id, name: "Cloudy Skies", slug: "cloudy-skies", ownerUsername: "delta" },
    });

    // No hash sent (or a lying client): the archive is hashed server-side and
    // rejected before anything reaches storage.
    const second = await startUpload();
    vi.mocked(uploadSkinObject).mockClear();
    const retried = await call(bodyReq("POST", `/api/skins/upload?id=${second.id}&token=${second.token}&part=osk`, osk));
    expect(retried.status).toBe(409);
    expect(retried.body).toMatchObject({ error: "duplicate", duplicate: { id: first.id } });
    expect(uploadSkinObject).not.toHaveBeenCalled();
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

  it("streams stored objects through /api/skins/file with key allow-listing", async () => {
    const { id, token } = await startUpload();
    await call(bodyReq("POST", `/api/skins/upload?id=${id}&token=${token}&part=osk`, await buildOskBuffer()));
    await call(bodyReq("POST", `/api/skins/upload?id=${id}&token=${token}&part=preview`, PNG_BYTES));
    await call(mockReq("POST", `/api/skins/finish?id=${id}&token=${token}`));

    const osk = await call(mockReq("GET", `/api/skins/file/${id}/${encodeURIComponent("Cloudy Skies.osk")}`));
    expect(osk.status).toBe(200);
    expect(osk.headers["content-type"]).toBe("application/octet-stream");
    expect(String(osk.body)).toContain(`object:skins/${id}/`);

    const preview = await call(mockReq("GET", `/api/skins/file/${id}/preview.png`));
    expect(preview.status).toBe(200);
    expect(preview.headers["cache-control"]).toContain("immutable");

    // only keys recorded on the row are reachable
    expect((await call(mockReq("GET", `/api/skins/file/${id}/other.osk`))).status).toBe(404);
    expect(vi.mocked(getSkinObject)).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining("other"));

    // hidden skins stream for admins only
    await call(bodyReq("POST", "/api/admin/skins/moderate", JSON.stringify({ id, action: "hide" }), ADMIN));
    expect((await call(mockReq("GET", `/api/skins/file/${id}/preview.png`))).status).toBe(404);
    expect((await call(mockReq("GET", `/api/skins/file/${id}/preview.png`, ADMIN))).status).toBe(200);
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
