import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, exec, migrate, type Db } from "../src/db.js";
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
      // Mirrors the real skinObjectUrl: a private skin's objects never get a
      // public bucket URL, they are addressed through the streaming endpoint.
      url: original.isPrivateSkinKey(key)
        ? `https://live.test/api/skins/file/${key.split("/")[1]}/${key.split("/").pop()}`
        : `https://cdn.test/${key}`,
    })),
    deleteSkinObjects: vi.fn(async () => {}),
    copySkinObject: vi.fn(async (_config: unknown, _from: string, to: string) => ({
      storageKey: to,
      sizeBytes: 0,
      url: `https://live.test/api/skins/file/${to.split("/")[1]}/${to.split("/").pop()}`,
    })),
    // Reads the stored .osk back for the private replay bundle. Internal to
    // r2.ts otherwise, so tests that need real bytes override it per case.
    readSkinObject: vi.fn(async () => null),
    getSkinObject: vi.fn(async (_config: unknown, key: string) => ({
      body: Readable.from([Buffer.from(`object:${key}`)]),
      contentType: key.endsWith(".osk") ? "application/octet-stream" : "image/webp",
      contentLength: 8,
      contentDisposition: key.endsWith(".osk") ? 'attachment; filename="skin.osk"' : null,
    })),
  };
});

import { copySkinObject, deleteSkinObjects, getSkinObject, readSkinObject, uploadSkinObject } from "../src/skins/r2.js";
import { clearSkinImageCache } from "../src/skins/image-cache.js";
import { resetPreviewPatternCaches } from "../src/skins/preview-patterns.js";
import { storeCachedBeatmapFile } from "../src/osu/beatmap-file-cache.js";
import { clearSimilarSkinsCache, clearSkinDownloadDedup } from "../src/features/skins.js";

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
  vi.mocked(copySkinObject).mockClear();
  clearSkinImageCache();
  // Process-level, so a fresh database per test has to drop them too.
  clearSimilarSkinsCache();
  clearSkinDownloadDedup();
  resetPreviewPatternCaches();
});

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

function ctx(configOverrides: Record<string, unknown> = {}) {
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
      ...configOverrides,
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

// The zip the private replay bundle answers with does not survive the string
// coercion the JSON helper below does, so binary responses get their own res
// that keeps the chunks as buffers.
async function callBinary(req: IncomingMessage) {
  const chunks: Buffer[] = [];
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
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      return true;
    },
    destroy: () => {},
    end: (chunk?: string | Buffer) => {
      if (chunk != null) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    },
  }) as unknown as ServerResponse & { statusCode: number };
  await routeHttp(req, res, ctx());
  await new Promise((resolve) => setImmediate(resolve));
  return { status: res.statusCode, body: Buffer.concat(chunks), headers };
}

async function call(req: IncomingMessage, configOverrides?: Record<string, unknown>) {
  const response = mockRes();
  await routeHttp(req, response.res, ctx(configOverrides));
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

async function buildOskBuffer(keymodes: number[] = [4, 7]): Promise<Buffer> {
  const zip = new JSZip();
  const mania = keymodes.map((keys) => `\n[Mania]\nKeys: ${keys}\nColourLight1: 255,102,170\n`).join("");
  zip.file("skin.ini", `[General]\nName: Cloudy Skies\nAuthor: sona\n${mania}`);
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

// A catalog entry plus the cached .osu behind it, which is all the preview
// pattern pool draws from.
async function seedCachedChart(keys: number): Promise<void> {
  await exec(
    db,
    `insert into maps_beatmapsets (beatmapset_id, title, artist, status, updated_at)
     values (55500, 'Song', 'Artist', 'ranked', '2026-01-01T00:00:00.000Z')`,
  );
  await exec(
    db,
    `insert into maps_beatmaps (beatmap_id, beatmapset_id, mode, status, cs, difficulty_rating, version, updated_at)
     values (55501, 55500, 'mania', 'ranked', ?, 6.4, ?, '2026-01-01T00:00:00.000Z')`,
    [keys, `[${keys}K] Extra`],
  );
  const notes = Array.from({ length: 64 }, (_, index) => {
    const column = index % keys;
    const time = 1000 + index * 140;
    return `${Math.floor(((column + 0.5) * 512) / keys)},192,${time},1,0,0:0:0:0:`;
  }).join("\n");
  await storeCachedBeatmapFile(
    db,
    55501,
    `osu file format v14\n\n[General]\nAudioFilename: a.mp3\nMode: 3\n\n[Metadata]\nTitle: Song\nArtist: Artist\nVersion: ${keys}K\n\n[Difficulty]\nCircleSize:${keys}\nOverallDifficulty:8\n\n[TimingPoints]\n0,500,4,2,0,100,1,0\n\n[HitObjects]\n${notes}\n`,
    { beatmapsetId: 55500, source: "test" },
  );
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
    expect((await call(mockReq("GET", `/api/skins/get?id=${id}`))).body.skin.downloadCount).toBe(1);
    expect((await call(mockReq("GET", "/api/skins/download?id=missing"))).status).toBe(404);
  });

  it("hands download counts to every reader", async () => {
    // startUpload publishes as userId 101.
    const { id, token } = await startUpload();
    await call(bodyReq("POST", `/api/skins/upload?id=${id}&token=${token}&part=osk`, await buildOskBuffer()));
    await call(bodyReq("POST", `/api/skins/upload?id=${id}&token=${token}&part=preview`, PNG_BYTES));
    // A freshly published skin starts at zero rather than at nothing.
    const finished = await call(mockReq("POST", `/api/skins/finish?id=${id}&token=${token}`));
    expect(finished.body.skin.downloadCount).toBe(0);
    // Two visitors count; the first one clicking again does not. The repeat
    // still redirects to the file, it just leaves the counter alone.
    await call(mockReq("GET", `/api/skins/download?id=${id}`, { "cf-connecting-ip": "203.0.113.1" }));
    await call(mockReq("GET", `/api/skins/download?id=${id}`, { "cf-connecting-ip": "203.0.113.2" }));
    const repeat = await call(mockReq("GET", `/api/skins/download?id=${id}`, { "cf-connecting-ip": "203.0.113.1" }));
    expect(repeat.status).toBe(302);

    // A signed-out visitor reads the same count the uploader does, off the
    // shared cacheable responses.
    const publicList = await call(mockReq("GET", "/api/skins/list"));
    expect(publicList.body.skins[0].downloadCount).toBe(2);
    expect(publicList.headers["cache-control"]).toContain("max-age=60");
    expect((await call(mockReq("GET", `/api/skins/get?id=${id}`))).body.skin.downloadCount).toBe(2);

    // Tokened reads (the uploader forwarded by the server fn, an admin server
    // to server) see the count too, and stay out of shared caches because they
    // can carry hidden skins.
    const ownList = await call(mockReq("GET", "/api/skins/list?viewerUserId=101", ADMIN));
    expect(ownList.body.skins[0].downloadCount).toBe(2);
    expect(ownList.headers["cache-control"]).toBe("private, no-store");
    expect((await call(mockReq("GET", `/api/skins/get?id=${id}&viewerUserId=101`, ADMIN))).body.skin.downloadCount).toBe(2);
    expect((await call(mockReq("GET", "/api/skins/list", ADMIN))).body.skins[0].downloadCount).toBe(2);
  });

  it("counts a skin page open per visitor and refuses anything else", async () => {
    const { id, token } = await startUpload();
    await call(bodyReq("POST", `/api/skins/upload?id=${id}&token=${token}&part=osk`, await buildOskBuffer()));
    await call(bodyReq("POST", `/api/skins/upload?id=${id}&token=${token}&part=preview`, PNG_BYTES));
    const finished = await call(mockReq("POST", `/api/skins/finish?id=${id}&token=${token}`));
    expect(finished.body.skin.viewCount).toBe(0);

    const viewed = await call(mockReq("POST", `/api/skins/view?id=${id}`, { "cf-connecting-ip": "203.0.113.7" }));
    expect(viewed.status).toBe(204);
    expect(viewed.headers["cache-control"]).toBe("no-store");
    // Same visitor again is a no-op; a second visitor counts.
    expect((await call(mockReq("POST", `/api/skins/view?id=${id}`, { "cf-connecting-ip": "203.0.113.7" }))).status).toBe(204);
    expect((await call(mockReq("POST", `/api/skins/view?id=${id}`, { "cf-connecting-ip": "203.0.113.8" }))).status).toBe(204);
    expect((await call(mockReq("GET", `/api/skins/get?id=${id}`))).body.skin.viewCount).toBe(2);
    // The number rides the public list the same way downloads do.
    expect((await call(mockReq("GET", "/api/skins/list"))).body.skins[0].viewCount).toBe(2);

    // A GET would let a prefetch or a crawler move the counter.
    expect((await call(mockReq("GET", `/api/skins/view?id=${id}`))).status).toBe(405);
    expect((await call(mockReq("POST", "/api/skins/view?id=missing"))).status).toBe(404);
    expect((await call(mockReq("POST", "/api/skins/view"))).status).toBe(404);
  });

  it("counts a scrolled grid as one batch, skipping what has no public number", async () => {
    const { id, token } = await startUpload();
    await call(bodyReq("POST", `/api/skins/upload?id=${id}&token=${token}&part=osk`, await buildOskBuffer()));
    await call(bodyReq("POST", `/api/skins/upload?id=${id}&token=${token}&part=preview`, PNG_BYTES));
    await call(mockReq("POST", `/api/skins/finish?id=${id}&token=${token}`));
    // A second skin still mid-upload: listed nowhere, so a ref to it is skipped.
    const pending = await startUpload();

    const seen = await call(bodyReq("POST", "/api/skins/views", JSON.stringify({ ids: [id, pending.id, "missing", id] }), { "cf-connecting-ip": "203.0.113.7" }));
    expect(seen.status).toBe(204);
    expect(seen.headers["cache-control"]).toBe("no-store");
    expect((await call(mockReq("GET", `/api/skins/get?id=${id}`))).body.skin.viewCount).toBe(1);

    // The batch shares the single view's dedup: the same visitor hovering
    // after scrolling is still one view, another visitor's scroll is a second.
    expect((await call(mockReq("POST", `/api/skins/view?id=${id}`, { "cf-connecting-ip": "203.0.113.7" }))).status).toBe(204);
    await call(bodyReq("POST", "/api/skins/views", JSON.stringify({ ids: [id] }), { "cf-connecting-ip": "203.0.113.8" }));
    expect((await call(mockReq("GET", `/api/skins/get?id=${id}`))).body.skin.viewCount).toBe(2);

    // Garbage bodies are a no-op, never an error the browser would retry.
    expect((await call(bodyReq("POST", "/api/skins/views", "not json"))).status).toBe(204);
    expect((await call(bodyReq("POST", "/api/skins/views", JSON.stringify({ ids: "nope" })))).status).toBe(204);
    expect((await call(mockReq("GET", "/api/skins/views"))).status).toBe(405);
  });

  it("recommends lookalikes only for skins with a public page", async () => {
    // Two catalog skins by the same skin.ini author in the same colourway;
    // different keymode blocks keep the archives byte-distinct past the
    // duplicate guard.
    const publish = async (osk: Buffer, visibility?: string) => {
      const started = await call(bodyReq(
        "POST",
        "/api/skins/start",
        JSON.stringify({ userId: 101, username: "delta", name: "Cloudy Skies", visibility }),
        ADMIN,
      ));
      const { id, token } = started.body as { id: string; token: string };
      await call(bodyReq("POST", `/api/skins/upload?id=${id}&token=${token}&part=osk`, osk));
      await call(bodyReq("POST", `/api/skins/upload?id=${id}&token=${token}&part=preview`, PNG_BYTES));
      const finished = await call(mockReq("POST", `/api/skins/finish?id=${id}&token=${token}`));
      expect(finished.status).toBe(200);
      return finished.body.skin as { id: string; slug: string };
    };
    const first = await publish(await buildOskBuffer([4]));
    const second = await publish(await buildOskBuffer([4, 7]));

    const similar = await call(mockReq("GET", `/api/skins/similar?id=${first.id}`));
    expect(similar.status).toBe(200);
    expect(similar.body.skins.map((skin: { id: string }) => skin.id)).toEqual([second.id]);
    // Shareable and longer-lived than the list: every page view asks for it.
    expect(similar.headers["cache-control"]).toContain("public");
    expect(similar.headers["cache-control"]).toContain("max-age=300");
    // The pretty slug resolves the same way the raw id does.
    expect((await call(mockReq("GET", `/api/skins/similar?id=${first.slug}`))).status).toBe(200);

    // A private ref answers exactly like a missing one: the endpoint is
    // tokenless, so it must not even confirm the skin exists.
    const hoarded = await publish(await buildOskBuffer([7]), "private");
    expect((await call(mockReq("GET", `/api/skins/similar?id=${hoarded.id}`))).status).toBe(404);
    expect((await call(mockReq("GET", "/api/skins/similar?id=missing"))).status).toBe(404);
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

  it("ships a newer .osk against a published skin through a replace ticket", async () => {
    const { id, token } = await startUpload();
    await call(bodyReq("POST", `/api/skins/upload?id=${id}&token=${token}&part=osk`, await buildOskBuffer()));
    for (const keys of [4, 7]) {
      await call(bodyReq("POST", `/api/skins/upload?id=${id}&token=${token}&part=preview&keys=${keys}${keys === 4 ? "&cover=1" : ""}`, PNG_BYTES));
    }
    await call(mockReq("POST", `/api/skins/finish?id=${id}&token=${token}`));
    const publishedOskKey = `skins/${id}/Cloudy Skies.osk`;

    // A previews ticket is not a licence to swap the file.
    const previewsTicket = await call(bodyReq("POST", "/api/skins/edit-start", JSON.stringify({ userId: 101, id }), ADMIN));
    const refused = await call(bodyReq(
      "POST",
      `/api/skins/upload?id=${id}&token=${previewsTicket.body.token}&part=osk`,
      await buildOskBuffer([4]),
    ));
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ error: "invalid_part" });

    const ticket = await call(bodyReq("POST", "/api/skins/edit-start", JSON.stringify({ userId: 101, id, scope: "replace" }), ADMIN));
    expect(ticket.body.scope).toBe("replace");
    vi.mocked(uploadSkinObject).mockClear();
    vi.mocked(deleteSkinObjects).mockClear();

    // The new build drops 7K.
    const replaced = await call(bodyReq("POST", `/api/skins/upload?id=${id}&token=${ticket.body.token}&part=osk`, await buildOskBuffer([4])));
    expect(replaced.status).toBe(200);
    expect(replaced.body).toMatchObject({ keymodes: [4] });
    // Stored objects are cached immutably, so it lands on a fresh key while the
    // download keeps the skin's own filename; the old build goes.
    const [, writtenKey, , , , downloadFilename] = vi.mocked(uploadSkinObject).mock.calls[0];
    expect(writtenKey).toBe(`skins/${id}/Cloudy Skies-r1.osk`);
    expect(downloadFilename).toBe("Cloudy Skies.osk");
    expect(vi.mocked(deleteSkinObjects).mock.calls[0][1]).toEqual([publishedOskKey]);

    await call(bodyReq("POST", `/api/skins/upload?id=${id}&token=${ticket.body.token}&part=preview&keys=4&cover=1`, PNG_BYTES));
    const finished = await call(mockReq("POST", `/api/skins/edit-finish?id=${id}&token=${ticket.body.token}`));
    expect(finished.status).toBe(200);

    const after = (await call(mockReq("GET", `/api/skins/get?id=${id}`))).body.skin;
    expect(after.keymodes).toEqual([4]);
    // The 7K preview belongs to a build nobody can download any more.
    expect(after.previews.map((preview: { keys: number }) => preview.keys)).toEqual([4]);
    expect(vi.mocked(deleteSkinObjects).mock.calls.at(-1)?.[1]).toEqual([`skins/${id}/preview-7k.png`]);
    // The mock builds its url straight off the key, hence no escaping here.
    expect(after.oskUrl).toContain("Cloudy Skies-r1.osk");
    expect(after.oskUpdatedAt).not.toBeNull();
    // The page it was published at is untouched.
    expect(after.slug).toBe("cloudy-skies");
    expect(after.publishedAt).not.toBeNull();
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
    // Hidden is a moderation state: a signed-in uploader reading their own
    // skin back through the viewer path does not get to see it either.
    expect((await call(mockReq("GET", `/api/skins/get?id=${id}&viewerUserId=101`, ADMIN))).status).toBe(404);
    expect((await call(mockReq("GET", "/api/skins/list?includeHidden=1&viewerUserId=101", ADMIN))).body.total).toBe(0);

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

  it("serves images from memory after the first read but always re-checks the row", async () => {
    const { id, token } = await startUpload();
    await call(bodyReq("POST", `/api/skins/upload?id=${id}&token=${token}&part=osk`, await buildOskBuffer()));
    await call(bodyReq("POST", `/api/skins/upload?id=${id}&token=${token}&part=preview`, PNG_BYTES));
    await call(mockReq("POST", `/api/skins/finish?id=${id}&token=${token}`));
    vi.mocked(getSkinObject).mockClear();

    const first = await call(mockReq("GET", `/api/skins/file/${id}/preview.png`));
    expect(first.status).toBe(200);
    expect(first.headers["content-length"]).toBe(String(Buffer.byteLength(first.body)));
    expect(vi.mocked(getSkinObject)).toHaveBeenCalledTimes(1);

    const second = await call(mockReq("GET", `/api/skins/file/${id}/preview.png`));
    expect(second.status).toBe(200);
    expect(second.body).toBe(first.body);
    expect(vi.mocked(getSkinObject)).toHaveBeenCalledTimes(1);

    // The cached buffer never bypasses authorization: hiding the skin 404s
    // the very next read even though the bytes are still in memory.
    await call(bodyReq("POST", "/api/admin/skins/moderate", JSON.stringify({ id, action: "hide" }), ADMIN));
    expect((await call(mockReq("GET", `/api/skins/file/${id}/preview.png`))).status).toBe(404);

    // The .osk keeps streaming straight from storage, uncached.
    vi.mocked(getSkinObject).mockClear();
    await call(mockReq("GET", `/api/skins/file/${id}/${encodeURIComponent("Cloudy Skies.osk")}`, ADMIN));
    await call(mockReq("GET", `/api/skins/file/${id}/${encodeURIComponent("Cloudy Skies.osk")}`, ADMIN));
    expect(vi.mocked(getSkinObject)).toHaveBeenCalledTimes(2);
  });

  it("re-renders previews and moves the card cover after publishing", async () => {
    const { id, token } = await startUpload();
    const pattern = {
      beatmapId: 55501,
      keys: 4,
      label: "Artist - Song [Extra]",
      stars: 6.25,
      notes: [{ column: 0, time: 0, endTime: 0 }, { column: 2, time: 120, endTime: 480 }],
    };
    await call(bodyReq("POST", `/api/skins/upload?id=${id}&token=${token}&part=osk`, await buildOskBuffer()));
    await call(bodyReq("POST", `/api/skins/upload?id=${id}&token=${token}&part=preview&keys=4&cover=1&w=1280&h=720`, PNG_BYTES));
    await call(bodyReq("POST", `/api/skins/upload?id=${id}&token=${token}&part=preview&keys=7&w=1280&h=720`, PNG_BYTES));
    await call(bodyReq("POST", `/api/skins/finish?id=${id}&token=${token}`, JSON.stringify({
      recipes: [
        { keys: 4, recipe: { backdrop: 2556057, pattern } },
        { keys: 7, recipe: { backdrop: "flat", pattern: null } },
      ],
    }), { "content-type": "application/json" }));
    expect((await call(mockReq("GET", `/api/skins/get?id=${id}`))).body.skin.previewUrl).toContain("preview-4k");
    // Recipes are edit data: absent from public reads, present for the owner.
    expect((await call(mockReq("GET", `/api/skins/get?id=${id}`))).body.skin.previews[0].recipe).toBeUndefined();
    const ownerRead = await call(mockReq("GET", `/api/skins/get?id=${id}&viewerUserId=101`, ADMIN));
    expect(ownerRead.body.skin.previews[0].recipe).toEqual({ backdrop: 2556057, pattern });

    // Cover only: no image work, and only the owner (or an admin) may ask.
    expect((await call(bodyReq("POST", "/api/skins/cover", JSON.stringify({ userId: 101, id, keys: 7 })))).status).toBe(401);
    expect((await call(bodyReq("POST", "/api/skins/cover", JSON.stringify({ userId: 202, id, keys: 7 }), ADMIN))).status).toBe(403);
    const cover = await call(bodyReq("POST", "/api/skins/cover", JSON.stringify({ userId: 101, id, keys: 7 }), ADMIN));
    expect(cover.status).toBe(200);
    expect(cover.body.skin.previewUrl).toContain("preview-7k");
    expect((await call(bodyReq("POST", "/api/skins/cover", JSON.stringify({ userId: 202, id, keys: 4, asAdmin: true }), ADMIN))).status).toBe(200);

    // Backdrop change: an edit ticket, then a re-uploaded render per keymode.
    expect((await call(bodyReq("POST", "/api/skins/edit-start", JSON.stringify({ userId: 202, id }), ADMIN))).status).toBe(403);
    const edit = await call(bodyReq("POST", "/api/skins/edit-start", JSON.stringify({ userId: 101, id }), ADMIN));
    expect(edit.status).toBe(200);
    const editId = edit.body.id as string;
    const editToken = edit.body.token as string;
    // The skin stays published and downloadable while it is being edited.
    expect((await call(mockReq("GET", `/api/skins/get?id=${id}`))).body.skin.status).toBe("published");

    // An edit ticket only unlocks previews: the published .osk stays as it is.
    const swapOsk = await call(bodyReq("POST", `/api/skins/upload?id=${editId}&token=${editToken}&part=osk`, await buildOskBuffer()));
    expect(swapOsk.status).toBe(400);
    expect(swapOsk.body).toMatchObject({ error: "invalid_part" });

    vi.mocked(deleteSkinObjects).mockClear();
    const rerender = await call(bodyReq("POST", `/api/skins/upload?id=${editId}&token=${editToken}&part=preview&keys=4&w=1280&h=720`, PNG_BYTES));
    expect(rerender.status).toBe(200);
    // The new render lands on a fresh key (the old one is cached immutably),
    // the displaced object is deleted, and the cover follows the keymode.
    const uploadedKey = vi.mocked(uploadSkinObject).mock.calls.at(-1)?.[1] as string;
    expect(uploadedKey).toBe(`skins/${id}/preview-4k-r1.png`);
    expect(vi.mocked(deleteSkinObjects).mock.calls.at(-1)?.[1]).toEqual([`skins/${id}/preview-4k.png`]);

    const finished = await call(bodyReq("POST", `/api/skins/edit-finish?id=${editId}&token=${editToken}`, JSON.stringify({
      recipes: [{ keys: 4, recipe: { backdrop: 2297326, pattern } }],
    }), { "content-type": "application/json" }));
    expect(finished.status).toBe(200);
    expect(finished.body.skin.previewUrl).toBe(`https://cdn.test/skins/${id}/preview-4k-r1.png`);
    expect(finished.body.skin.previews.map((preview: { keys: number }) => preview.keys)).toEqual([4, 7]);
    expect(finished.body.skin.previews[0].recipe).toEqual({ backdrop: 2297326, pattern });
    expect(finished.body.skin.previews[1].recipe).toEqual({ backdrop: "flat", pattern: null });
    expect(finished.body.skin.status).toBe("published");

    // The ticket dies with the edit.
    expect((await call(mockReq("POST", `/api/skins/edit-finish?id=${editId}&token=${editToken}`))).status).toBe(403);
    expect((await call(bodyReq("POST", `/api/skins/upload?id=${editId}&token=${editToken}&part=preview&keys=4`, PNG_BYTES))).status).toBe(403);
  });

  it("merges keymode previews that finish uploading concurrently", async () => {
    const { id, token } = await startUpload();
    await call(bodyReq("POST", `/api/skins/upload?id=${id}&token=${token}&part=osk`, await buildOskBuffer([3, 4, 7])));

    const uploads = await Promise.all([3, 4, 7].map((keys) => call(bodyReq(
      "POST",
      `/api/skins/upload?id=${id}&token=${token}&part=preview&keys=${keys}${keys === 4 ? "&cover=1" : ""}`,
      PNG_BYTES,
    ))));
    expect(uploads.map((response) => response.status)).toEqual([200, 200, 200]);

    const finished = await call(mockReq("POST", `/api/skins/finish?id=${id}&token=${token}`));
    expect(finished.status).toBe(200);
    expect(finished.body.skin.previews.map((preview: { keys: number }) => preview.keys)).toEqual([3, 4, 7]);
  });

  it("fronts the card with an uploaded screenshot, named by its uploader", async () => {
    const { id, token } = await startUpload();
    await call(bodyReq("POST", `/api/skins/upload?id=${id}&token=${token}&part=osk`, await buildOskBuffer()));
    await call(bodyReq("POST", `/api/skins/upload?id=${id}&token=${token}&part=preview&keys=4&cover=1&w=1280&h=720`, PNG_BYTES));
    // A screenshot uploaded with cover=1 takes the card, and carries the name
    // the uploader typed in the form.
    const shot = await call(bodyReq(
      "POST",
      `/api/skins/upload?id=${id}&token=${token}&part=screenshot&cover=1&w=1920&h=1080&label=${encodeURIComponent("Score screen")}`,
      PNG_BYTES,
    ));
    expect(shot.status).toBe(200);
    await call(bodyReq("POST", `/api/skins/upload?id=${id}&token=${token}&part=screenshot&w=1920&h=1080`, PNG_BYTES));
    await call(mockReq("POST", `/api/skins/finish?id=${id}&token=${token}`));

    const published = (await call(mockReq("GET", `/api/skins/get?id=${id}`))).body.skin;
    expect(published.previewUrl).toContain("shot-0");
    expect(published.previewWidth).toBe(1920);
    expect(published.screenshots.map((entry: { label: string | null }) => entry.label)).toEqual(["Score screen", null]);
    // Taking the card is not taking it out of the gallery, and the keymode
    // render it displaced stays in storage.
    expect(vi.mocked(deleteSkinObjects)).not.toHaveBeenCalled();

    // Post-publish the cover moves by position, the same way keymodes move.
    expect((await call(bodyReq("POST", "/api/skins/cover", JSON.stringify({ userId: 101, id, screenshot: 1 })))).status).toBe(401);
    expect((await call(bodyReq("POST", "/api/skins/cover", JSON.stringify({ userId: 202, id, screenshot: 1 }), ADMIN))).status).toBe(403);
    expect((await call(bodyReq("POST", "/api/skins/cover", JSON.stringify({ userId: 101, id, screenshot: 9 }), ADMIN))).status).toBe(400);
    expect((await call(bodyReq("POST", "/api/skins/cover", JSON.stringify({ userId: 101, id, screenshot: 3 }), ADMIN))).status).toBe(404);
    const moved = await call(bodyReq("POST", "/api/skins/cover", JSON.stringify({ userId: 101, id, screenshot: 1 }), ADMIN));
    expect(moved.status).toBe(200);
    expect(moved.body.skin.previewUrl).toContain("shot-1");

    // Renaming is a plain edit: no ticket, no upload, owner or admin only.
    const rename = (payload: object, headers?: Record<string, string>) =>
      call(bodyReq("POST", "/api/skins/screenshot-labels", JSON.stringify(payload), headers));
    expect((await rename({ userId: 101, id, labels: ["Gameplay"] })).status).toBe(401);
    expect((await rename({ userId: 202, id, labels: ["Gameplay"] }, ADMIN)).status).toBe(403);
    expect((await rename({ userId: 101, id, labels: ["a", "b", "c", "d", "e"] }, ADMIN)).status).toBe(400);
    const renamed = await rename({ userId: 101, id, labels: ["Gameplay", ""] }, ADMIN);
    expect(renamed.status).toBe(200);
    expect(renamed.body.skin.screenshots.map((entry: { label: string | null }) => entry.label)).toEqual(["Gameplay", null]);

    // Moving the cover back onto a keymode leaves both screenshots alone.
    const back = await call(bodyReq("POST", "/api/skins/cover", JSON.stringify({ userId: 101, id, keys: 4 }), ADMIN));
    expect(back.body.skin.previewUrl).toContain("preview-4k");
    expect(back.body.skin.screenshots).toHaveLength(2);
    expect(vi.mocked(deleteSkinObjects)).not.toHaveBeenCalled();
  });

  it("edits the name and description of a published skin for its owner only", async () => {
    const { id, token } = await startUpload();
    await call(bodyReq("POST", `/api/skins/upload?id=${id}&token=${token}&part=osk`, await buildOskBuffer()));
    await call(bodyReq("POST", `/api/skins/upload?id=${id}&token=${token}&part=preview&keys=4&cover=1&w=1280&h=720`, PNG_BYTES));
    await call(mockReq("POST", `/api/skins/finish?id=${id}&token=${token}`));
    const slug = (await call(mockReq("GET", `/api/skins/get?id=${id}`))).body.skin.slug as string;

    const edit = (payload: object, headers?: Record<string, string>) =>
      call(bodyReq("POST", "/api/skins/details", JSON.stringify(payload), headers));

    expect((await edit({ userId: 101, id, name: "Renamed" })).status).toBe(401);
    expect((await edit({ userId: 202, id, name: "Renamed" }, ADMIN)).status).toBe(403);
    expect((await edit({ userId: 101, id, name: "  " }, ADMIN)).status).toBe(400);

    const renamed = await edit({ userId: 101, id, name: "Renamed Skin", description: "Now with a blurb." }, ADMIN);
    expect(renamed.status).toBe(200);
    expect(renamed.body.skin.name).toBe("Renamed Skin");
    expect(renamed.body.skin.description).toBe("Now with a blurb.");
    // The slug is untouched, so links shared under the old title still resolve.
    expect(renamed.body.skin.slug).toBe(slug);
    expect((await call(mockReq("GET", `/api/skins/get?id=${slug}`))).body.skin.name).toBe("Renamed Skin");

    // A retitle that carries no description keeps the one already stored.
    const retitled = await edit({ userId: 101, id, name: "Renamed Twice" }, ADMIN);
    expect(retitled.body.skin.description).toBe("Now with a blurb.");

    // A true admin may retitle someone else's skin.
    expect((await edit({ userId: 202, id, name: "Moderated", asAdmin: true }, ADMIN)).status).toBe(200);
  });

  it("deals chart snippets for the preview picker, per keymode", async () => {
    await seedCachedChart(4);

    const drawn = await call(mockReq("GET", "/api/skins/preview-patterns?keys=4&count=4"));
    expect(drawn.status).toBe(200);
    expect(drawn.headers["cache-control"]).toBe("no-store");
    expect(drawn.body.patterns).toHaveLength(1);
    expect(drawn.body.patterns[0]).toMatchObject({ beatmapId: 55501, keys: 4, label: "Artist - Song [[4K] Extra]" });
    expect(drawn.body.patterns[0].notes.length).toBeGreaterThan(6);

    // A keymode with no cached charts is an empty pool, not an error: the
    // uploader keeps the synthetic pattern.
    expect((await call(mockReq("GET", "/api/skins/preview-patterns?keys=7"))).body).toEqual({ patterns: [] });
    expect((await call(mockReq("GET", "/api/skins/preview-patterns?keys=0"))).status).toBe(400);
    expect((await call(mockReq("POST", "/api/skins/preview-patterns?keys=4"))).status).toBe(405);
  });

  it("rejects oversized osk uploads before buffering", async () => {
    const { id, token } = await startUpload();
    const oversized = await call(mockReq("POST", `/api/skins/upload?id=${id}&token=${token}&part=osk`, {
      "content-length": String(66 * 1024 * 1024),
    }));
    expect(oversized.status).toBe(413);
    expect(oversized.body).toMatchObject({ error: "payload_too_large" });
  });

describe("private skins", () => {
  // A .osk with real art in it, so the replay bundle has something to filter.
  async function buildArtOskBuffer(): Promise<Buffer> {
    const zip = new JSZip();
    zip.file("skin.ini", "[General]\nName: Hoarded\nAuthor: sona\n\n[Mania]\nKeys: 4\nColourLight1: 255,102,170\n");
    zip.file("mania/note1.png", PNG_BYTES);
    zip.file("mania/note2.png", PNG_BYTES);
    zip.file("menu-background.jpg", PNG_BYTES);
    zip.file("normal-hitnormal.wav", Buffer.from("RIFF"));
    return zip.generateAsync({ type: "nodebuffer" });
  }

  async function publishPrivateSkin(osk?: Buffer): Promise<{ id: string; skin: Record<string, string> }> {
    const started = await call(bodyReq(
      "POST",
      "/api/skins/start",
      JSON.stringify({ userId: 101, username: "delta", name: "Hoarded", visibility: "private" }),
      ADMIN,
    ));
    expect(started.status).toBe(200);
    const { id, token } = started.body as { id: string; token: string };
    await call(bodyReq("POST", `/api/skins/upload?id=${id}&token=${token}&part=osk`, osk ?? await buildOskBuffer([4])));
    await call(bodyReq("POST", `/api/skins/upload?id=${id}&token=${token}&part=preview`, PNG_BYTES));
    const finished = await call(mockReq("POST", `/api/skins/finish?id=${id}&token=${token}`));
    expect(finished.status).toBe(200);
    return { id, skin: finished.body.skin };
  }

  it("keeps a private skin off the catalog and its bytes behind the owner's capability", async () => {
    const { id, skin } = await publishPrivateSkin();

    // Every object lands under a folder named by the skin's secret, so the
    // bucket's public base URL cannot be derived from the id.
    const keys = vi.mocked(uploadSkinObject).mock.calls.map((args) => String(args[1]));
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) expect(key).toMatch(new RegExp(`^skins/${id}/p-[A-Za-z0-9_-]+/`));

    // The uploader's own copy carries the capability on the file URL.
    expect(skin.visibility).toBe("private");
    expect(String(skin.oskUrl)).toContain("?t=");
    const token = new URL(String(skin.oskUrl)).searchParams.get("t") ?? "";
    expect(token.length).toBeGreaterThan(10);

    // Not on the public list, not on an admin's hidden-skins list either.
    expect((await call(mockReq("GET", "/api/skins/list"))).body.total).toBe(0);
    expect((await call(mockReq("GET", "/api/skins/list?includeHidden=1", ADMIN))).body.total).toBe(0);
    // Its uploader gets it back on their own shelf, and only theirs.
    expect((await call(mockReq("GET", "/api/skins/list?visibility=private&viewerUserId=101", ADMIN))).body.total).toBe(1);
    expect((await call(mockReq("GET", "/api/skins/list?visibility=private&viewerUserId=202", ADMIN))).body.total).toBe(0);
    // A browser cannot ask for someone else's shelf: without the admin token
    // the viewer id is ignored entirely.
    expect((await call(mockReq("GET", "/api/skins/list?visibility=private&viewerUserId=101"))).body.total).toBe(0);

    // The page is the uploader's alone.
    expect((await call(mockReq("GET", `/api/skins/get?id=${id}`))).status).toBe(404);
    expect((await call(mockReq("GET", `/api/skins/get?id=${id}&viewerUserId=202`, ADMIN))).status).toBe(404);
    const owned = await call(mockReq("GET", `/api/skins/get?id=${id}&viewerUserId=101`, ADMIN));
    expect(owned.status).toBe(200);
    expect(String(owned.body.skin.oskUrl)).toContain("?t=");

    // No counted download at all.
    expect((await call(mockReq("GET", `/api/skins/download?id=${id}`))).status).toBe(404);

    // The bytes answer only to the capability.
    const filename = String(skin.oskUrl).split("?")[0].split("/").pop();
    expect((await call(mockReq("GET", `/api/skins/file/${id}/${filename}`))).status).toBe(404);
    expect((await call(mockReq("GET", `/api/skins/file/${id}/${filename}?t=wrong`))).status).toBe(404);
    const streamed = await call(mockReq("GET", `/api/skins/file/${id}/${filename}?t=${encodeURIComponent(token)}`));
    expect(streamed.status).toBe(200);
    expect(streamed.headers["cache-control"]).toBe("private, max-age=86400");
  });

  it("lets only the owner point their replays at a private skin", async () => {
    const { id } = await publishPrivateSkin();
    const set = (userId: number) => call(bodyReq(
      "POST",
      "/api/replay-skin/set",
      JSON.stringify({ userId, skinId: id, settings: { v: 1, settings: {} } }),
      ADMIN,
    ));
    expect((await set(202)).status).toBe(404);
    expect((await set(101)).status).toBe(200);
  });

  it("drops a skin off other players' replays the moment it turns private", async () => {
    // Published public, picked by two players, then hidden away by its owner.
    const { id } = await publishPrivateSkin(await buildOskBuffer([4]));
    expect((await call(bodyReq(
      "POST",
      "/api/skins/visibility",
      JSON.stringify({ userId: 101, id, visibility: "public" }),
      ADMIN,
    ))).status).toBe(200);
    for (const userId of [101, 202]) {
      expect((await call(bodyReq(
        "POST",
        "/api/replay-skin/set",
        JSON.stringify({ userId, skinId: id, settings: { v: 1, settings: {} } }),
        ADMIN,
      ))).status).toBe(200);
    }
    expect((await call(mockReq("GET", "/api/replay-skin?userId=202"))).body.replaySkin).not.toBeNull();

    const madePrivate = await call(bodyReq(
      "POST",
      "/api/skins/visibility",
      JSON.stringify({ userId: 101, id, visibility: "private" }),
      ADMIN,
    ));
    expect(madePrivate.status).toBe(200);
    expect(madePrivate.body.skin.visibility).toBe("private");
    // The .osk moved off the key the public download link pointed at.
    expect(String(madePrivate.body.skin.oskUrl)).toContain("/api/skins/file/");
    expect(String(madePrivate.body.skin.oskUrl)).toContain("?t=");

    // Its owner keeps it; the other player's replays fall back to the default
    // skin, and there is no bundle for them to pull the art out of either.
    expect((await call(mockReq("GET", "/api/replay-skin?userId=101"))).body.replaySkin).toMatchObject({ private: true });
    expect((await call(mockReq("GET", "/api/replay-skin?userId=202"))).body.replaySkin).toBeNull();
    expect((await call(mockReq("GET", "/api/replay-skin/bundle?userId=202"))).status).toBe(404);

    // Only the uploader (or a true admin) may flip it back.
    expect((await call(bodyReq(
      "POST",
      "/api/skins/visibility",
      JSON.stringify({ userId: 202, id, visibility: "public" }),
      ADMIN,
    ))).status).toBe(403);
  });

  it("moves the .osk back out of the secret folder when a skin goes public again", async () => {
    const { id } = await publishPrivateSkin();
    const privateKey = String(vi.mocked(uploadSkinObject).mock.calls
      .map((args) => String(args[1]))
      .find((key) => key.endsWith(".osk")));
    expect(privateKey).toMatch(/\/p-[A-Za-z0-9_-]+\//);

    const flip = (visibility: string) => call(bodyReq(
      "POST",
      "/api/skins/visibility",
      JSON.stringify({ userId: 101, id, visibility }),
      ADMIN,
    ));

    // Public again: the file leaves the secret folder so downloads take the
    // CDN rather than streaming through this process forever, and it lands on
    // a fresh revision instead of a key an edge cache may hold a 404 for.
    const madePublic = await flip("public");
    expect(madePublic.status).toBe(200);
    const publicKey = `skins/${id}/Hoarded-r1.osk`;
    expect(vi.mocked(copySkinObject)).toHaveBeenCalledWith(
      expect.anything(),
      privateKey,
      publicKey,
      "application/octet-stream",
      "Hoarded.osk",
    );
    expect(vi.mocked(deleteSkinObjects)).toHaveBeenCalledWith(expect.anything(), [privateKey]);
    expect(String(madePublic.body.skin.oskUrl)).not.toContain("?t=");
    // And it downloads without a capability, through the counter again.
    expect((await call(mockReq("GET", `/api/skins/download?id=${id}`))).status).toBe(302);

    // Private a third time: a fresh secret, and the folder is replaced rather
    // than nested inside the old one.
    const madePrivateAgain = await flip("private");
    expect(madePrivateAgain.status).toBe(200);
    const finalKey = String(vi.mocked(copySkinObject).mock.calls.at(-1)?.[2]);
    expect(finalKey).toMatch(new RegExp(`^skins/${id}/p-[A-Za-z0-9_-]+/Hoarded-r1\\.osk$`));
    expect(finalKey).not.toBe(privateKey);
    expect((await call(mockReq("GET", `/api/skins/download?id=${id}`))).status).toBe(404);
  });

  it("never moves a stored object when the process is not production", async () => {
    // Local development runs against the same bucket as production, usually
    // with a snapshot of the live DB, so a toggle here must not copy and
    // delete a real skin's file out from under the production row.
    const { id } = await publishPrivateSkin();
    vi.mocked(copySkinObject).mockClear();
    vi.mocked(deleteSkinObjects).mockClear();

    const flipped = await call(bodyReq(
      "POST",
      "/api/skins/visibility",
      JSON.stringify({ userId: 101, id, visibility: "public" }),
      ADMIN,
    ), { nodeEnv: "development" });

    expect(flipped.status).toBe(200);
    expect(flipped.body.skin.visibility).toBe("public");
    expect(copySkinObject).not.toHaveBeenCalled();
    expect(deleteSkinObjects).not.toHaveBeenCalled();
  });

  it("serves a replay viewer the redacted skin and a bundle of only what it draws", async () => {
    const osk = await buildArtOskBuffer();
    const { id } = await publishPrivateSkin(osk);
    const settings = {
      v: 1,
      settings: { keymodeProfiles: { 4: { assets: { columns: [{ tap: { name: "note1.png", src: "", path: "mania/note1.png" } }] } } } },
    };
    expect((await call(bodyReq(
      "POST",
      "/api/replay-skin/set",
      JSON.stringify({ userId: 101, skinId: id, settings }),
      ADMIN,
    ))).status).toBe(200);

    // What a stranger watching the replay reads: enough to credit the skin,
    // nothing that addresses the file or a page.
    const replaySkin = await call(mockReq("GET", "/api/replay-skin?userId=101"));
    expect(replaySkin.status).toBe(200);
    expect(replaySkin.body.replaySkin).toMatchObject({ private: true });
    expect(replaySkin.body.replaySkin.skin).toMatchObject({
      id,
      name: "Hoarded",
      visibility: "private",
      oskUrl: null,
      oskSha256: null,
      slug: null,
      previewUrl: null,
    });
    expect(replaySkin.body.replaySkin.skin.previews).toEqual([]);
    expect(replaySkin.body.replaySkin.skin.screenshots).toEqual([]);
    expect(String(replaySkin.body.replaySkin.bundleVersion)).toHaveLength(16);

    vi.mocked(readSkinObject).mockResolvedValueOnce(osk);
    const bundle = await callBinary(mockReq("GET", `/api/replay-skin/bundle?userId=101&v=${replaySkin.body.replaySkin.bundleVersion}`));
    expect(bundle.status).toBe(200);
    expect(bundle.headers["content-type"]).toBe("application/zip");
    const loadedBundle = await JSZip.loadAsync(bundle.body);
    const entries = Object.values(loadedBundle.files).filter((file) => !file.dir).map((file) => file.name);
    // The art this player's settings draw, the mania hitsounds and skin.ini -
    // and not one file more.
    expect(entries.sort()).toEqual(["mania/note1.png", "normal-hitnormal.wav", "skin.ini"]);

    // A public skin has nothing to filter: it keeps serving its whole .osk.
    expect((await call(mockReq("GET", "/api/replay-skin/bundle?userId=999"))).status).toBe(404);
  });
});

});
