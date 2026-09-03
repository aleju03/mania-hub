import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import { AbuseGuard } from "../src/http/abuse-guard.js";
import { routeHttp } from "../src/http/snapshots.js";
import { JobQueue } from "../src/jobs/queue.js";
import { LiveEventLog } from "../src/live/event-log.js";
import {
  deleteUploadedReplayRow,
  getUploadedReplayRow,
  listUploadedReplays,
  recordUploadedReplay,
} from "../src/features/uploaded-replays.js";

let dir = "";
let db: Db;
let queue: JobQueue;
let events: LiveEventLog;

const ADMIN = { authorization: "Bearer secret" };
const OWNER = 101;
const OTHER = 202;
// Ids have to satisfy the route's own [A-Za-z0-9_-]{16,64} check.
const UPLOAD_A = "aaaaaaaaaaaaaaaa";
const UPLOAD_B = "bbbbbbbbbbbbbbbb";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mania-uploaded-replays-"));
  db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
  queue = new JobQueue(db);
  events = new LiveEventLog(db);
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

function bodyReq(method: string, url: string, body: string, headers: IncomingMessage["headers"] = {}): IncomingMessage {
  const req = Readable.from([Buffer.from(body)]) as unknown as IncomingMessage;
  req.method = method;
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
  return { res, writes, headers };
}

async function call(req: IncomingMessage) {
  const response = mockRes();
  await routeHttp(req, response.res, ctx());
  const raw = response.writes.join("");
  return { status: response.res.statusCode, body: raw ? JSON.parse(raw) : null, headers: response.headers };
}

async function seed(id: string, ownerUserId: number, uploadedAt: string, username = "uploader"): Promise<void> {
  await recordUploadedReplay(db, {
    id,
    ownerUserId,
    ownerUsername: username,
    originalFilename: `${id}.osr`,
    uploadedAt,
  });
}

describe("uploaded replay index feature module", () => {
  it("records, reads back, and keeps one row per id", async () => {
    await seed(UPLOAD_A, OWNER, "2026-08-01T00:00:00.000Z");
    await seed(UPLOAD_A, OWNER, "2026-08-05T00:00:00.000Z");
    const row = await getUploadedReplayRow(db, UPLOAD_A);
    expect(row).toMatchObject({ id: UPLOAD_A, ownerUserId: OWNER, ownerUsername: "uploader" });
    // The re-record keeps the original upload time rather than moving the row
    // to the top of its owner's shelf.
    expect(row?.uploadedAt).toBe("2026-08-01T00:00:00.000Z");
    expect(Number((await exec(db, "select count(*) as n from uploaded_replays")).rows[0]?.n)).toBe(1);
  });

  it("never blanks a stored username with the backfill's empty one", async () => {
    await seed(UPLOAD_A, OWNER, "2026-08-01T00:00:00.000Z", "realname");
    await seed(UPLOAD_A, OWNER, "2026-08-01T00:00:00.000Z", "");
    expect((await getUploadedReplayRow(db, UPLOAD_A))?.ownerUsername).toBe("realname");
  });

  it("lists one owner's uploads newest first, and everyone's only when asked", async () => {
    await seed(UPLOAD_A, OWNER, "2026-08-01T00:00:00.000Z");
    await seed(UPLOAD_B, OTHER, "2026-08-09T00:00:00.000Z");

    const mine = await listUploadedReplays(db, { ownerUserId: OWNER, allOwners: false, page: 0, pageSize: 12 });
    expect(mine.total).toBe(1);
    expect(mine.uploads.map((upload) => upload.id)).toEqual([UPLOAD_A]);

    const all = await listUploadedReplays(db, { ownerUserId: OWNER, allOwners: true, page: 0, pageSize: 12 });
    expect(all.total).toBe(2);
    expect(all.uploads.map((upload) => upload.id)).toEqual([UPLOAD_B, UPLOAD_A]);
  });

  it("pages, and refuses to treat a missing owner as everyone", async () => {
    await seed(UPLOAD_A, OWNER, "2026-08-01T00:00:00.000Z");
    await seed(UPLOAD_B, OWNER, "2026-08-09T00:00:00.000Z");

    const first = await listUploadedReplays(db, { ownerUserId: OWNER, allOwners: false, page: 0, pageSize: 1 });
    expect(first.uploads.map((upload) => upload.id)).toEqual([UPLOAD_B]);
    expect(first.hasMore).toBe(true);

    const second = await listUploadedReplays(db, { ownerUserId: OWNER, allOwners: false, page: 1, pageSize: 1 });
    expect(second.uploads.map((upload) => upload.id)).toEqual([UPLOAD_A]);
    expect(second.hasMore).toBe(false);

    const anonymous = await listUploadedReplays(db, { ownerUserId: null, allOwners: false, page: 0, pageSize: 12 });
    expect(anonymous).toMatchObject({ uploads: [], total: 0 });
  });

  it("fills the uploader's name from the users table when the row has none", async () => {
    await exec(
      db,
      "insert into users (user_id, username, avatar_url, updated_at) values (?, ?, ?, ?)",
      [OWNER, "namedplayer", "", "2026-08-01T00:00:00.000Z"],
    );
    await seed(UPLOAD_A, OWNER, "2026-08-01T00:00:00.000Z", "");
    const list = await listUploadedReplays(db, { ownerUserId: OWNER, allOwners: false, page: 0, pageSize: 12 });
    expect(list.uploads[0]?.ownerUsername).toBe("namedplayer");
  });

  it("delete returns the row it removed, and null for an unknown id", async () => {
    await seed(UPLOAD_A, OWNER, "2026-08-01T00:00:00.000Z");
    expect(await deleteUploadedReplayRow(db, UPLOAD_A)).toMatchObject({ id: UPLOAD_A });
    expect(await getUploadedReplayRow(db, UPLOAD_A)).toBeNull();
    expect(await deleteUploadedReplayRow(db, UPLOAD_A)).toBeNull();
  });
});

describe("/api/uploaded-replays routes", () => {
  it("rejects every route without the admin token", async () => {
    for (const req of [
      mockReq("GET", `/api/uploaded-replays/list?viewerUserId=${OWNER}`),
      mockReq("GET", `/api/uploaded-replays/get?id=${UPLOAD_A}`),
      bodyReq("POST", "/api/uploaded-replays/delete", JSON.stringify({ id: UPLOAD_A, userId: OWNER })),
    ]) {
      const res = await call(req);
      expect(res.status).toBe(401);
    }
  });

  it("records an upload and lists it back for its owner only", async () => {
    const recorded = await call(bodyReq(
      "POST",
      "/api/uploaded-replays/record",
      JSON.stringify({ id: UPLOAD_A, userId: OWNER, username: "uploader", originalFilename: "play.osr", uploadedAt: "2026-08-01T00:00:00.000Z" }),
      ADMIN,
    ));
    expect(recorded.status).toBe(200);

    const mine = await call(mockReq("GET", `/api/uploaded-replays/list?viewerUserId=${OWNER}`, ADMIN));
    expect(mine.status).toBe(200);
    expect(mine.body.uploads).toHaveLength(1);
    expect(mine.body.uploads[0]).toMatchObject({ id: UPLOAD_A, ownerUserId: OWNER, originalFilename: "play.osr" });
    expect(mine.headers["cache-control"]).toBe("private, no-store");

    const theirs = await call(mockReq("GET", `/api/uploaded-replays/list?viewerUserId=${OTHER}`, ADMIN));
    expect(theirs.body.uploads).toHaveLength(0);
  });

  it("only serves everyone's uploads to a request that asserted admin", async () => {
    await seed(UPLOAD_A, OWNER, "2026-08-01T00:00:00.000Z");
    await seed(UPLOAD_B, OTHER, "2026-08-09T00:00:00.000Z");

    const withoutAsAdmin = await call(mockReq("GET", `/api/uploaded-replays/list?viewerUserId=${OWNER}&all=1`, ADMIN));
    expect(withoutAsAdmin.body.uploads.map((upload: { id: string }) => upload.id)).toEqual([UPLOAD_A]);

    const asAdmin = await call(mockReq("GET", `/api/uploaded-replays/list?viewerUserId=${OWNER}&all=1&asAdmin=1`, ADMIN));
    expect(asAdmin.body.uploads.map((upload: { id: string }) => upload.id)).toEqual([UPLOAD_B, UPLOAD_A]);
  });

  it("rejects a malformed id on record and delete", async () => {
    for (const id of ["", "short", "not/a/valid/id/at/all/because/of/slashes"]) {
      const recorded = await call(bodyReq("POST", "/api/uploaded-replays/record", JSON.stringify({ id, userId: OWNER }), ADMIN));
      expect(recorded.status).toBe(400);
      const deleted = await call(bodyReq("POST", "/api/uploaded-replays/delete", JSON.stringify({ id, userId: OWNER }), ADMIN));
      expect(deleted.status).toBe(400);
    }
  });

  it("lets the owner delete their upload and nobody else", async () => {
    await seed(UPLOAD_A, OWNER, "2026-08-01T00:00:00.000Z");

    const stranger = await call(bodyReq("POST", "/api/uploaded-replays/delete", JSON.stringify({ id: UPLOAD_A, userId: OTHER }), ADMIN));
    expect(stranger.status).toBe(404);
    expect(await getUploadedReplayRow(db, UPLOAD_A)).not.toBeNull();

    const owner = await call(bodyReq("POST", "/api/uploaded-replays/delete", JSON.stringify({ id: UPLOAD_A, userId: OWNER }), ADMIN));
    expect(owner.status).toBe(200);
    expect(owner.body).toMatchObject({ ok: true, indexed: true });
    expect(await getUploadedReplayRow(db, UPLOAD_A)).toBeNull();
  });

  it("lets an admin delete anyone's upload, and clears an id that was never indexed", async () => {
    await seed(UPLOAD_A, OWNER, "2026-08-01T00:00:00.000Z");

    const admin = await call(bodyReq(
      "POST",
      "/api/uploaded-replays/delete",
      JSON.stringify({ id: UPLOAD_A, userId: OTHER, asAdmin: true }),
      ADMIN,
    ));
    expect(admin.status).toBe(200);
    expect(await getUploadedReplayRow(db, UPLOAD_A)).toBeNull();

    // No row, but the file may still be in R2 - the caller has to be told to go
    // delete the objects rather than being turned away.
    const unindexed = await call(bodyReq(
      "POST",
      "/api/uploaded-replays/delete",
      JSON.stringify({ id: UPLOAD_B, userId: OTHER, asAdmin: true }),
      ADMIN,
    ));
    expect(unindexed.status).toBe(200);
    expect(unindexed.body).toMatchObject({ ok: true, indexed: false });

    // The same id for its supposed owner stays a 404: nothing proves it is theirs.
    const notOwner = await call(bodyReq("POST", "/api/uploaded-replays/delete", JSON.stringify({ id: UPLOAD_B, userId: OWNER }), ADMIN));
    expect(notOwner.status).toBe(404);
  });

  it("answers get with the row, and 404 for an unknown id", async () => {
    await seed(UPLOAD_A, OWNER, "2026-08-01T00:00:00.000Z");
    const found = await call(mockReq("GET", `/api/uploaded-replays/get?id=${UPLOAD_A}`, ADMIN));
    expect(found.status).toBe(200);
    expect(found.body.upload).toMatchObject({ id: UPLOAD_A, ownerUserId: OWNER });

    const missing = await call(mockReq("GET", `/api/uploaded-replays/get?id=${UPLOAD_B}`, ADMIN));
    expect(missing.status).toBe(404);
  });

  it("answers a page's worth of owner rows at once for the gallery", async () => {
    await seed(UPLOAD_A, OWNER, "2026-08-01T00:00:00.000Z");
    await seed(UPLOAD_B, OTHER, "2026-08-09T00:00:00.000Z");

    const rows = await call(mockReq("GET", `/api/uploaded-replays/rows?ids=${UPLOAD_A},${UPLOAD_B},cccccccccccccccc,bad`, ADMIN));
    expect(rows.status).toBe(200);
    expect(rows.body.uploads.map((upload: { id: string; ownerUserId: number }) => [upload.id, upload.ownerUserId]).sort())
      .toEqual([[UPLOAD_A, OWNER], [UPLOAD_B, OTHER]]);
    expect((await call(mockReq("GET", "/api/uploaded-replays/rows?ids=", ADMIN))).body.uploads).toEqual([]);
    expect((await call(mockReq("GET", `/api/uploaded-replays/rows?ids=${UPLOAD_A}`))).status).toBe(401);
  });

  it("refuses the wrong method and an unknown sub-route", async () => {
    expect((await call(bodyReq("POST", "/api/uploaded-replays/list", "{}", ADMIN))).status).toBe(405);
    expect((await call(mockReq("GET", "/api/uploaded-replays/record", ADMIN))).status).toBe(405);
    expect((await call(mockReq("GET", "/api/uploaded-replays/nope", ADMIN))).status).toBe(404);
  });
});
