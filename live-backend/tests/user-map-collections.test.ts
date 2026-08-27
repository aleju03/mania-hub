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
import { USER_COLLECTION_MAX_PER_USER } from "../src/features/user-map-collections.js";

/* Player-built map collections end to end through the router: who may write,
   what the catalog lets into a list, the derived fields, and the likes. */

let dir = "";
let db: Db;
let queue: JobQueue;
let events: LiveEventLog;

const TOKEN = { authorization: "Bearer secret" };
const JSON_HEADERS = { ...TOKEN, "content-type": "application/json" };
const OWNER = 7095193;
const OTHER = 12490530;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mania-user-collections-"));
  db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
  queue = new JobQueue(db);
  events = new LiveEventLog(db);
  // Enough catalog charts to build a few collections out of, on both keymodes.
  for (const [beatmapId, keyCount] of [[101, 4], [102, 4], [103, 4], [701, 7], [702, 7], [703, 7]] as const) {
    await exec(
      db,
      `insert into map_search_index (beatmap_id, beatmapset_id, analysis_version, title, artist, creator, version, status,
         key_count, stars, bpm, length, play_count, ln_count, primary_pattern, search_text, covers_json, updated_at)
       values (?, ?, 1, ?, 'Artist', 'Creator', 'Normal', 'ranked', ?, 5, 180, 120, 10, 0, 'stream', ?, ?, ?)`,
      [
        beatmapId,
        beatmapId * 10,
        `Song ${beatmapId}`,
        keyCount,
        `song ${beatmapId}`,
        JSON.stringify({ card: `https://assets.ppy.sh/beatmaps/${beatmapId * 10}/covers/card.jpg?1` }),
        new Date().toISOString(),
      ],
    );
  }
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

function bodyReq(method: string, url: string, body: unknown, headers: IncomingMessage["headers"] = {}): IncomingMessage {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
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
  return { res, writes };
}

async function call(req: IncomingMessage) {
  const response = mockRes();
  await routeHttp(req, response.res, ctx());
  await new Promise((resolve) => setImmediate(resolve));
  const raw = response.writes.join("");
  let body: ReturnType<typeof JSON.parse> = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = raw;
  }
  return { status: response.res.statusCode, body };
}

function create(overrides: Record<string, unknown> = {}) {
  return call(bodyReq("POST", "/api/map-collections/create", {
    userId: OWNER,
    username: "aleju",
    country: "cr",
    title: "Warmup files",
    description: "What I play first.",
    tags: ["warmup", "stream"],
    beatmapIds: [101, 102, 103],
    ...overrides,
  }, JSON_HEADERS));
}

describe("user map collections", () => {
  it("posts a collection and shows it to everyone right away", async () => {
    const posted = await create();
    expect(posted.status).toBe(200);
    expect(posted.body.ok).toBe(true);
    expect(posted.body.collection.memberCount).toBe(3);
    // Both members are 4K, so the tab's keymode chip is 4K rather than mixed.
    expect(posted.body.collection.keyCount).toBe(4);
    expect(posted.body.collection.owner.username).toBe("aleju");

    const list = await call(mockReq("GET", "/api/map-collections/list", TOKEN));
    expect(list.status).toBe(200);
    expect(list.body.collections).toHaveLength(1);
    expect(list.body.facets.tags.map((facet: { value: string }) => facet.value).sort()).toEqual(["stream", "warmup"]);
  });

  it("gives every collection a short id and a shareable slug", async () => {
    const posted = await create({ title: "LN Coordination" });
    expect(posted.body.collection.id).toMatch(/^[0-9a-f]{10}$/);
    expect(posted.body.collection.slug).toBe("ln-coordination");

    // Two collections of the same name still get one link each.
    const second = await create({ title: "LN Coordination" });
    expect(second.body.collection.slug).toBe("ln-coordination-2");

    // The slug opens the page, and so does the id.
    const bySlug = await call(mockReq("GET", "/api/map-collections/get?id=ln-coordination", TOKEN));
    expect(bySlug.body.collection.id).toBe(posted.body.collection.id);
    const byId = await call(mockReq("GET", `/api/map-collections/get?id=${posted.body.collection.id}`, TOKEN));
    expect(byId.body.collection.slug).toBe("ln-coordination");
  });

  it("keeps the slug through a rename, so shared links do not break", async () => {
    const posted = await create({ title: "Warmup files" });
    const renamed = await call(bodyReq("POST", "/api/map-collections/update", {
      userId: OWNER, id: posted.body.collection.id, title: "Something else entirely",
    }, JSON_HEADERS));
    expect(renamed.body.collection.slug).toBe("warmup-files");
  });

  it("refuses every route without the bridge token", async () => {
    expect((await call(mockReq("GET", "/api/map-collections/list"))).status).toBe(401);
    expect((await call(bodyReq("POST", "/api/map-collections/create", { userId: OWNER, title: "x" }, { "content-type": "application/json" }))).status).toBe(401);
  });

  it("keeps out beatmaps the catalog does not know", async () => {
    const posted = await create({ beatmapIds: [101, 102, 103, 999999] });
    expect(posted.body.collection.memberCount).toBe(3);
    expect(posted.body.droppedBeatmapIds).toEqual([999999]);
  });

  it("refuses a list shorter than the minimum, counting only maps that exist", async () => {
    const short = await create({ beatmapIds: [101, 102] });
    expect(short.status).toBe(400);
    expect(short.body.error).toBe("too_few_maps");

    // Padding a short list with ids the catalog does not know does not get past
    // it: the minimum counts the members that survived validation.
    const padded = await create({ beatmapIds: [101, 102, 999999] });
    expect(padded.body.error).toBe("too_few_maps");

    // Nor can an edit empty a posted collection back down.
    const id = (await create()).body.collection.id;
    const emptied = await call(bodyReq("POST", "/api/map-collections/update", {
      userId: OWNER, id, beatmapIds: [101],
    }, JSON_HEADERS));
    expect(emptied.status).toBe(400);
    expect(emptied.body.error).toBe("too_few_maps");
  });

  it("calls a mixed-keymode list mixed", async () => {
    const posted = await create({ beatmapIds: [101, 102, 701] });
    expect(posted.body.collection.keyCount).toBeNull();
  });

  it("lets only the owner or an admin edit and delete", async () => {
    const id = (await create()).body.collection.id;

    const stranger = await call(bodyReq("POST", "/api/map-collections/update", {
      userId: OTHER, id, title: "Mine now",
    }, JSON_HEADERS));
    expect(stranger.status).toBe(403);

    const renamed = await call(bodyReq("POST", "/api/map-collections/update", {
      userId: OWNER, id, title: "Warmup files v2",
    }, JSON_HEADERS));
    expect(renamed.status).toBe(200);
    // A rename that never opened the map picker must not empty the list.
    expect(renamed.body.collection.title).toBe("Warmup files v2");
    expect(renamed.body.collection.memberCount).toBe(3);

    expect((await call(bodyReq("POST", "/api/map-collections/delete", { userId: OTHER, id }, JSON_HEADERS))).status).toBe(403);
    const admin = await call(bodyReq("POST", "/api/map-collections/delete", { userId: OTHER, id, asAdmin: true }, JSON_HEADERS));
    expect(admin.status).toBe(200);
    expect((await call(mockReq("GET", `/api/map-collections/get?id=${id}`, TOKEN))).status).toBe(404);
  });

  it("counts likes once per account and hands back the viewer's own", async () => {
    const id = (await create()).body.collection.id;
    const liked = await call(bodyReq("POST", "/api/map-collections/favourite", { userId: OTHER, id, favourited: true }, JSON_HEADERS));
    expect(liked.body).toMatchObject({ ok: true, favourited: true, favouriteCount: 1 });
    // A second like from the same account is the same one like.
    const again = await call(bodyReq("POST", "/api/map-collections/favourite", { userId: OTHER, id, favourited: true }, JSON_HEADERS));
    expect(again.body.favouriteCount).toBe(1);

    const asLiker = await call(mockReq("GET", `/api/map-collections/get?id=${id}&viewerUserId=${OTHER}`, TOKEN));
    expect(asLiker.body.collection.favourited).toBe(true);
    const asStranger = await call(mockReq("GET", `/api/map-collections/get?id=${id}`, TOKEN));
    expect(asStranger.body.collection.favourited).toBe(false);

    const unliked = await call(bodyReq("POST", "/api/map-collections/favourite", { userId: OTHER, id, favourited: false }, JSON_HEADERS));
    expect(unliked.body).toMatchObject({ favourited: false, favouriteCount: 0 });
  });

  it("filters by keymode, tag and owner", async () => {
    await create();
    await create({ title: "7K only", tags: ["jack"], beatmapIds: [701, 702, 703] });
    await create({ userId: OTHER, username: "someone", title: "Theirs", tags: [], beatmapIds: [101, 102, 103] });

    const sevenK = await call(mockReq("GET", "/api/map-collections/list?keys=7k", TOKEN));
    expect(sevenK.body.collections.map((entry: { title: string }) => entry.title)).toEqual(["7K only"]);

    const tagged = await call(mockReq("GET", "/api/map-collections/list?tag=warmup", TOKEN));
    expect(tagged.body.collections.map((entry: { title: string }) => entry.title)).toEqual(["Warmup files"]);

    const mine = await call(mockReq("GET", `/api/map-collections/mine?viewerUserId=${OTHER}`, TOKEN));
    expect(mine.body.collections.map((entry: { title: string }) => entry.title)).toEqual(["Theirs"]);
  });

  it("caps how many one account can post", async () => {
    for (let i = 0; i < USER_COLLECTION_MAX_PER_USER; i++) {
      expect((await create({ title: `Collection ${i}` })).status).toBe(200);
    }
    const overflow = await create({ title: "One too many" });
    expect(overflow.status).toBe(400);
    expect(overflow.body.error).toBe("limit_reached");
  });

  it("keeps the list in the order the author put it in", async () => {
    const id = (await create({ beatmapIds: [103, 101, 102] })).body.collection.id;
    const detail = await call(mockReq("GET", `/api/map-collections/get?id=${id}`, TOKEN));
    expect(detail.body.collection.items.map((item: { beatmapId: number }) => item.beatmapId)).toEqual([103, 101, 102]);
  });
});
