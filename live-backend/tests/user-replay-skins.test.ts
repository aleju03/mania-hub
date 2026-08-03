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
  clearUserReplaySkin,
  getUserReplaySkin,
  setUserReplaySkin,
  USER_REPLAY_SKIN_PAYLOAD_MAX_CHARS,
} from "../src/features/user-replay-skins.js";

let dir = "";
let db: Db;
let queue: JobQueue;
let events: LiveEventLog;

const ADMIN = { authorization: "Bearer secret" };
const USER = 101;
const PUBLISHED = "skin-published";
const HIDDEN = "skin-hidden";
const PENDING = "skin-pending";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mania-replay-skins-"));
  db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
  queue = new JobQueue(db);
  events = new LiveEventLog(db);
  // The routes only ever read skins by id and check status, so a minimal row
  // per status is enough; the upload pipeline is exercised by skins-http tests.
  for (const [id, status] of [[PUBLISHED, "published"], [HIDDEN, "hidden"], [PENDING, "pending"]] as const) {
    await insertSkin(id, status);
  }
});

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function insertSkin(id: string, status: string): Promise<void> {
  const now = new Date().toISOString();
  await exec(
    db,
    `insert into skins (id, owner_user_id, owner_username, name, status, created_at, updated_at, published_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, 900, "uploader", `Skin ${id}`, status, now, now, status === "published" ? now : null],
  );
}

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

function setReq(payload: object, headers: Record<string, string> = ADMIN): IncomingMessage {
  return bodyReq("POST", "/api/replay-skin/set", JSON.stringify(payload), headers);
}

describe("user replay skin feature module", () => {
  it("set then get round-trips, and setting again overwrites", async () => {
    await setUserReplaySkin(db, USER, PUBLISHED, '{"note":"circle.png"}');
    const first = await getUserReplaySkin(db, USER);
    expect(first).toMatchObject({ userId: USER, skinId: PUBLISHED, payloadJson: '{"note":"circle.png"}' });
    expect(first?.updatedAt).toBeTruthy();

    await setUserReplaySkin(db, USER, HIDDEN, '{"note":"bar.png"}');
    const second = await getUserReplaySkin(db, USER);
    expect(second).toMatchObject({ userId: USER, skinId: HIDDEN, payloadJson: '{"note":"bar.png"}' });
    const count = (await exec(db, "select count(*) as n from user_replay_skins")).rows[0]?.n;
    expect(Number(count)).toBe(1);
  });

  it("clear removes the row and tolerates a user with no row", async () => {
    await setUserReplaySkin(db, USER, PUBLISHED, "{}");
    await clearUserReplaySkin(db, USER);
    expect(await getUserReplaySkin(db, USER)).toBeNull();
    await clearUserReplaySkin(db, USER); // no row left; still fine
  });
});

describe("GET /api/replay-skin", () => {
  it("rejects a missing or non-positive userId", async () => {
    for (const query of ["", "?userId=0", "?userId=-3", "?userId=abc", "?userId=1.5"]) {
      const res = await call(mockReq("GET", `/api/replay-skin${query}`));
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: "invalid_user" });
    }
  });

  it("returns replaySkin null for a user with no choice", async () => {
    const res = await call(mockReq("GET", `/api/replay-skin?userId=${USER}`));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ replaySkin: null });
    expect(res.headers["cache-control"]).toBe("public, no-cache");
  });

  it("returns the published skin summary plus settings, without download counts", async () => {
    await setUserReplaySkin(db, USER, PUBLISHED, '{"noteImage":"mania/note1.png","volume":0.4}');
    const res = await call(mockReq("GET", `/api/replay-skin?userId=${USER}`));
    expect(res.status).toBe(200);
    expect(res.body.replaySkin.skin).toMatchObject({ id: PUBLISHED, name: `Skin ${PUBLISHED}`, status: "published" });
    // The count is private even here: this is a public read of someone's skin.
    expect(res.body.replaySkin.skin.downloadCount).toBeNull();
    expect(res.body.replaySkin.settings).toEqual({ noteImage: "mania/note1.png", volume: 0.4 });
    expect(res.body.replaySkin.updatedAt).toBeTruthy();
    expect(res.headers["cache-control"]).toBe("public, no-cache");
  });

  it("reads back as null when the linked skin is hidden or deleted", async () => {
    await setUserReplaySkin(db, USER, HIDDEN, "{}");
    expect((await call(mockReq("GET", `/api/replay-skin?userId=${USER}`))).body).toEqual({ replaySkin: null });

    await setUserReplaySkin(db, USER, PUBLISHED, "{}");
    await exec(db, "delete from skins where id = ?", [PUBLISHED]);
    expect((await call(mockReq("GET", `/api/replay-skin?userId=${USER}`))).body).toEqual({ replaySkin: null });
  });

  it("rejects non-GET methods", async () => {
    const res = await call(bodyReq("POST", `/api/replay-skin?userId=${USER}`, "{}"));
    expect(res.status).toBe(405);
    expect(res.body).toMatchObject({ error: "method_not_allowed" });
  });
});

describe("POST /api/replay-skin/set", () => {
  it("requires the admin token", async () => {
    const res = await call(setReq({ userId: USER, skinId: PUBLISHED, settings: {} }, {}));
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: "unauthorized" });
  });

  it("rejects an invalid userId", async () => {
    const res = await call(setReq({ userId: 0, skinId: PUBLISHED, settings: {} }));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "invalid_user" });
  });

  it("404s on unknown, unpublished, and over-long skin ids", async () => {
    for (const skinId of ["missing", PENDING, HIDDEN, "", "x".repeat(65)]) {
      const res = await call(setReq({ userId: USER, skinId, settings: {} }));
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ error: "skin_not_found" });
    }
  });

  it("413s a settings payload above the cap", async () => {
    // Over the payload cap but under the body read limit, so the explicit
    // check answers rather than the transport-level 413.
    const settings = { blob: "x".repeat(USER_REPLAY_SKIN_PAYLOAD_MAX_CHARS + 100) };
    const res = await call(setReq({ userId: USER, skinId: PUBLISHED, settings }));
    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({ error: "payload_too_large" });
    expect(await getUserReplaySkin(db, USER)).toBeNull();
  });

  it("rejects payloads that embed data URLs instead of asset paths", async () => {
    for (const value of ["data:image/png;base64,AAAA", "data:audio/wav;base64,AAAA"]) {
      const res = await call(setReq({ userId: USER, skinId: PUBLISHED, settings: { asset: value } }));
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: "embedded_data_url" });
    }
    expect(await getUserReplaySkin(db, USER)).toBeNull();
  });

  it("upserts the choice and serves it back through the public read", async () => {
    const first = await call(setReq({ userId: USER, skinId: PUBLISHED, settings: { noteImage: "mania/note1.png" } }));
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ ok: true });

    const read = await call(mockReq("GET", `/api/replay-skin?userId=${USER}`));
    expect(read.body.replaySkin.skin.id).toBe(PUBLISHED);
    expect(read.body.replaySkin.settings).toEqual({ noteImage: "mania/note1.png" });

    // Saving again replaces the settings in place.
    await call(setReq({ userId: USER, skinId: PUBLISHED, settings: { noteImage: "mania/note2.png" } }));
    const reread = await call(mockReq("GET", `/api/replay-skin?userId=${USER}`));
    expect(reread.body.replaySkin.settings).toEqual({ noteImage: "mania/note2.png" });
  });
});

describe("POST /api/replay-skin/clear", () => {
  it("requires the admin token", async () => {
    const res = await call(bodyReq("POST", "/api/replay-skin/clear", JSON.stringify({ userId: USER })));
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: "unauthorized" });
  });

  it("clears the stored choice", async () => {
    await setUserReplaySkin(db, USER, PUBLISHED, "{}");
    const res = await call(bodyReq("POST", "/api/replay-skin/clear", JSON.stringify({ userId: USER }), ADMIN));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(await getUserReplaySkin(db, USER)).toBeNull();
    expect((await call(mockReq("GET", `/api/replay-skin?userId=${USER}`))).body).toEqual({ replaySkin: null });
  });
});
