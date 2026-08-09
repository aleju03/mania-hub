import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import { GOAT_POLL, normalizeArchiveProof } from "../src/features/goat-poll.js";
import { AbuseGuard } from "../src/http/abuse-guard.js";
import { routeHttp } from "../src/http/snapshots.js";
import { JobQueue } from "../src/jobs/queue.js";
import { LiveEventLog } from "../src/live/event-log.js";

let dir = "";
let db: Db;
let queue: JobQueue;
let events: LiveEventLog;

const ADMIN = { authorization: "Bearer secret" };
const JSON_HEADERS = { ...ADMIN, "content-type": "application/json" };
// A Wayback snapshot of a real deleted account (KaneMining, already on the
// honorary roster) — the exact shape a banned nomination has to carry.
const PROOF = "https://web.archive.org/web/20200101000000/https://osu.ppy.sh/users/12253636";

// The poll's switch is a module constant rather than config (so a poll ships
// with a deploy instead of a VPS env edit), which makes "what poll is running"
// process state a test has to set explicitly. Every test starts from an open
// window and mutates it through setPoll.
function setPoll(overrides: Partial<typeof GOAT_POLL>): void {
  Object.assign(GOAT_POLL, overrides);
}

beforeEach(async () => {
  setPoll({
    enabled: true,
    // Released, unless a test says otherwise: the ship-time value of adminOnly
    // is whatever the current poll needs, and every test below would otherwise
    // inherit it.
    adminOnly: false,
    id: "test-poll",
    opensAt: new Date(Date.now() - 60_000).toISOString(),
    closesAt: new Date(Date.now() + 60_000).toISOString(),
  });
  dir = await mkdtemp(join(tmpdir(), "mania-goat-poll-"));
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

function nominate(payload: Record<string, unknown>) {
  return call(bodyReq("POST", "/api/goat-poll/nominate", payload, JSON_HEADERS));
}

function vote(payload: Record<string, unknown>) {
  return call(bodyReq("POST", "/api/goat-poll/vote", payload, JSON_HEADERS));
}

async function firstNomineeId(): Promise<string> {
  const board = await call(mockReq("GET", "/api/goat-poll"));
  return board.body.nominees[0].id;
}

describe("goat poll nominations", () => {
  it("creates a nominee and dedupes the second attempt", async () => {
    const created = await nominate({ userId: 1, osuUserId: 999, username: "Jakads", countryCode: "KR" });
    expect(created.status).toBe(200);
    expect(created.body.status).toBe("created");

    const again = await nominate({ userId: 2, osuUserId: 999, username: "Jakads" });
    expect(again.body.status).toBe("already_nominated");
    // Reported with the existing row's id so the client can point at it, and
    // with a 200 because trying to nominate someone already up is reasonable.
    expect(again.status).toBe(200);
    expect(again.body.nomineeId).toBe(created.body.nomineeId);

    const board = await call(mockReq("GET", "/api/goat-poll"));
    expect(board.body.nominees).toHaveLength(1);
  });

  it("collapses the same player nominated by id and by a differently-cased name", async () => {
    await nominate({ userId: 1, osuUserId: 555, username: "WindyS" });
    const byName = await nominate({ userId: 2, username: "windys" });
    expect(byName.body.status).toBe("already_nominated");
    expect(byName.body.nominees).toHaveLength(1);
  });

  it("collapses a second row opened by punctuating the same name differently", async () => {
    // The duplicate that matters: two rows for one human are two things to
    // upvote, so a single account could back that player twice.
    await nominate({ userId: 1, username: "Jakads" });
    expect((await nominate({ userId: 2, username: "Jakads." })).body.status).toBe("already_nominated");
    // osu! reads a username's spaces and underscores as the same character.
    expect((await nominate({ userId: 3, username: "jak_ads" })).body.status).toBe("already_nominated");
    expect((await call(mockReq("GET", "/api/goat-poll"))).body.nominees).toHaveLength(1);
  });

  it("adopts the id-less row when the same player turns up with an id", async () => {
    const first = await nominate({ userId: 1, username: "WindyS" });
    const withId = await nominate({ userId: 2, osuUserId: 1190879, username: "windy s" });
    expect(withId.body.status).toBe("already_nominated");
    expect(withId.body.nomineeId).toBe(first.body.nomineeId);
  });

  it("keeps two accounts apart when their ids differ, however alike the names read", async () => {
    // The cost of a punctuation-blind name key, paid back by the id: "-Ame-"
    // and "Ame" can be two real players, and here they are two rows.
    await nominate({ userId: 1, osuUserId: 111, username: "Ame" });
    expect((await nominate({ userId: 2, osuUserId: 222, username: "-Ame-" })).body.status).toBe("created");
    expect((await call(mockReq("GET", "/api/goat-poll"))).body.nominees).toHaveLength(2);
  });

  it("refuses a banned nominee without a valid archive proof", async () => {
    const noProof = await nominate({ userId: 1, username: "Ghost", banned: true });
    expect(noProof.status).toBe(409);
    expect(noProof.body.status).toBe("invalid_proof");

    const wrongHost = await nominate({
      userId: 1,
      username: "Ghost",
      banned: true,
      proofUrl: "https://osu.ppy.sh/users/12253636",
    });
    expect(wrongHost.body.status).toBe("invalid_proof");

    const notAProfile = await nominate({
      userId: 1,
      username: "Ghost",
      banned: true,
      proofUrl: "https://web.archive.org/web/20200101000000/https://osu.ppy.sh/beatmapsets/1",
    });
    expect(notAProfile.body.status).toBe("invalid_proof");

    const good = await nominate({ userId: 1, username: "Ghost", banned: true, proofUrl: PROOF });
    expect(good.body.status).toBe("created");
  });

  it("pins a banned nominee to the id inside the archive URL", async () => {
    await nominate({ userId: 1, username: "silicosis et", banned: true, proofUrl: PROOF });
    const board = await call(mockReq("GET", "/api/goat-poll"));
    // The typed name never carried the id; the proof did, and that is what
    // stops a second spelling opening a second row and splitting the vote.
    expect(board.body.nominees[0].osuUserId).toBe(12253636);
    expect(board.body.nominees[0].banned).toBe(true);

    const otherSpelling = await nominate({ userId: 2, osuUserId: 12253636, username: "KaneMining" });
    expect(otherSpelling.body.status).toBe("already_nominated");
  });

  it("does not cap how many names one account may put up", async () => {
    // Uncapped on purpose: a first poll told people they were out of
    // nominations within the hour, and a board that grows too long is an
    // admin's delete key rather than a number in the feature module.
    for (let n = 0; n < 12; n += 1) {
      expect((await nominate({ userId: 7, username: `Nominee ${n}` })).body.status).toBe("created");
    }
    expect((await call(mockReq("GET", "/api/goat-poll"))).body.nominees).toHaveLength(12);
    // One player is still one row, whoever puts them up.
    expect((await nominate({ userId: 8, username: "Nominee 3" })).body.status).toBe("already_nominated");
  });
});

describe("goat poll votes", () => {
  it("opens a new row on the nominator's own upvote", async () => {
    const created = await nominate({ userId: 1, username: "Jakads" });
    expect(created.body.nominees[0].net).toBe(1);
    expect(created.body.nominees[0].up).toBe(1);
    // And it is a real vote, in the nominator's ballot, so their arrow is lit
    // and clicking it again clears it like any other.
    expect(created.body.votes[created.body.nomineeId]).toBe(1);

    // Nominating someone already up does NOT touch the caller's vote: theirs
    // may be a considered downvote.
    await vote({ userId: 2, nomineeId: created.body.nomineeId, value: -1 });
    const again = await nominate({ userId: 2, username: "Jakads" });
    expect(again.body.status).toBe("already_nominated");
    expect(again.body.votes[created.body.nomineeId]).toBe(-1);
    expect(again.body.nominees[0].net).toBe(0);
  });

  it("moves net from +1 to -1 to 0 as one voter changes their mind", async () => {
    // userId 1's nomination carries their upvote, so every net below is one
    // higher than voter 2's own arrow.
    await nominate({ userId: 1, osuUserId: 999, username: "Jakads" });
    const nomineeId = await firstNomineeId();

    const up = await vote({ userId: 2, nomineeId, value: 1 });
    expect(up.body.nominees[0].net).toBe(2);
    expect(up.body.nominees[0].up).toBe(2);
    expect(up.body.votes[nomineeId]).toBe(1);

    const down = await vote({ userId: 2, nomineeId, value: -1 });
    expect(down.body.nominees[0].net).toBe(0);
    // The flip rewrites the row rather than stacking: one voice per account.
    expect(down.body.nominees[0].up).toBe(1);
    expect(down.body.nominees[0].down).toBe(1);

    const cleared = await vote({ userId: 2, nomineeId, value: 0 });
    expect(cleared.body.status).toBe("cleared");
    expect(cleared.body.nominees[0].net).toBe(1);
    expect(cleared.body.votes[nomineeId]).toBeUndefined();
  });

  it("subtracts downvotes across voters and sorts the board by net", async () => {
    await nominate({ userId: 1, username: "loved" });
    await nominate({ userId: 1, username: "hated" });
    const board = await call(mockReq("GET", "/api/goat-poll"));
    const loved = board.body.nominees.find((n: { username: string }) => n.username === "loved").id;
    const hated = board.body.nominees.find((n: { username: string }) => n.username === "hated").id;

    await vote({ userId: 10, nomineeId: loved, value: 1 });
    await vote({ userId: 11, nomineeId: loved, value: 1 });
    await vote({ userId: 12, nomineeId: loved, value: -1 });
    await vote({ userId: 10, nomineeId: hated, value: -1 });

    const final = await call(mockReq("GET", "/api/goat-poll"));
    // Both rows opened at 1 on userId 1's nominating upvote.
    expect(final.body.nominees.map((n: { username: string; net: number }) => [n.username, n.net])).toEqual([
      ["loved", 2],
      ["hated", 0],
    ]);
  });

  it("lets one account back every nominee on the board", async () => {
    // Voting is uncapped on purpose — the widget promises "as many players as
    // you want". One voice per nominee is still structural (the primary key).
    for (let n = 0; n < 60; n += 1) {
      await nominate({ userId: 100 + n, username: `Nominee ${n}` });
    }
    const board = await call(mockReq("GET", "/api/goat-poll"));
    for (const nominee of board.body.nominees) {
      expect((await vote({ userId: 42, nomineeId: nominee.id, value: 1 })).body.status).toBe("recorded");
    }
    const ballot = await call(mockReq("GET", "/api/goat-poll/mine?userId=42", ADMIN));
    expect(Object.keys(ballot.body.votes)).toHaveLength(60);
    // Every row: its nominator's upvote plus voter 42's.
    const final = await call(mockReq("GET", "/api/goat-poll"));
    expect(final.body.nominees.every((n: { net: number }) => n.net === 2)).toBe(true);
  });

  it("rejects a vote on an unknown nominee", async () => {
    const missing = await vote({ userId: 2, nomineeId: "nope", value: 1 });
    expect(missing.status).toBe(409);
    expect(missing.body.status).toBe("unknown_nominee");
  });

  it("rejects a value that is not up, down or clear", async () => {
    await nominate({ userId: 1, username: "Jakads" });
    const nomineeId = await firstNomineeId();
    const bad = await vote({ userId: 2, nomineeId, value: 5 });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("invalid_value");
  });
});

describe("goat poll live events", () => {
  /* Every write puts its changed row on the shared stream so a board open in
     someone else's browser moves on the vote rather than on its 20s poll. */
  async function pollEvents(): Promise<Array<{ type: string; country: string | null; payload: Record<string, unknown> }>> {
    const rows = (await exec(db, "select type, country, payload_json from live_event_log where type = 'goat_poll' order by sequence")).rows;
    return rows.map((row) => ({
      type: String(row.type),
      country: row.country == null ? null : String(row.country),
      payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>,
    }));
  }

  it("emits the changed row on a nomination and on a vote", async () => {
    const created = await nominate({ userId: 1, username: "Jakads" });
    const afterNominate = await pollEvents();
    expect(afterNominate).toHaveLength(1);
    // Country-less: the poll is one board for the whole site.
    expect(afterNominate[0].country).toBeNull();
    expect(afterNominate[0].payload.pollId).toBe("test-poll");
    // The row, not the board — a board is up to 150 KiB at 500 nominees.
    expect((afterNominate[0].payload.nominee as { username: string }).username).toBe("Jakads");
    expect((afterNominate[0].payload.nominee as { net: number }).net).toBe(1);

    await vote({ userId: 2, nomineeId: created.body.nomineeId, value: 1 });
    const afterVote = await pollEvents();
    expect(afterVote).toHaveLength(2);
    expect((afterVote[1].payload.nominee as { id: string; net: number }).id).toBe(created.body.nomineeId);
    expect((afterVote[1].payload.nominee as { net: number }).net).toBe(2);
  });

  it("emits a tombstone when an admin removes a nominee", async () => {
    const created = await nominate({ userId: 1, username: "Joke Nomination" });
    await call(bodyReq("POST", "/api/admin/goat-poll/remove", { nomineeId: created.body.nomineeId }, JSON_HEADERS));
    const events = await pollEvents();
    expect(events[events.length - 1].payload).toEqual({ pollId: "test-poll", removedId: created.body.nomineeId });
  });

  it("says nothing when a write changes nothing", async () => {
    const created = await nominate({ userId: 1, username: "Jakads" });
    await pollEvents();
    // A duplicate nomination and a rejected vote both leave the board as it was.
    await nominate({ userId: 2, username: "jakads" });
    await vote({ userId: 2, nomineeId: "nope", value: 1 });
    expect(await pollEvents()).toHaveLength(1);
    expect((await pollEvents())[0].payload.nominee).toMatchObject({ id: created.body.nomineeId });
  });
});

describe("goat poll moderation", () => {
  function remove(payload: Record<string, unknown>, headers: IncomingMessage["headers"] = JSON_HEADERS) {
    return call(bodyReq("POST", "/api/admin/goat-poll/remove", payload, headers));
  }

  it("takes one nominee off the board with their votes", async () => {
    const keep = await nominate({ userId: 1, username: "Jakads" });
    const drop = await nominate({ userId: 2, username: "Joke Nomination" });
    await vote({ userId: 3, nomineeId: drop.body.nomineeId, value: 1 });

    const removed = await remove({ nomineeId: drop.body.nomineeId });
    expect(removed.status).toBe(200);
    expect(removed.body.username).toBe("Joke Nomination");
    // The nominating upvote plus voter 3's.
    expect(removed.body.votesDeleted).toBe(2);
    expect(removed.body.nominees).toHaveLength(1);
    expect(removed.body.nominees[0].id).toBe(keep.body.nomineeId);

    // Everyone else's ballot is untouched, and the removed row is gone from it.
    const ballot = await call(mockReq("GET", "/api/goat-poll/mine?userId=3", ADMIN));
    expect(ballot.body.votes).toEqual({});
    // A delete key, not a ban: the same player can go back up.
    expect((await nominate({ userId: 4, username: "Joke Nomination" })).body.status).toBe("created");
  });

  it("refuses without the admin token and 404s an unknown nominee", async () => {
    const created = await nominate({ userId: 1, username: "Jakads" });
    expect((await remove({ nomineeId: created.body.nomineeId }, { "content-type": "application/json" })).status).toBe(401);
    expect((await remove({ nomineeId: "nope" })).status).toBe(404);
    expect((await remove({})).status).toBe(400);
    // Nothing left the board.
    expect((await call(mockReq("GET", "/api/goat-poll"))).body.nominees).toHaveLength(1);
  });
});

describe("goat poll window", () => {
  it("refuses writes once the deadline has passed", async () => {
    await nominate({ userId: 1, username: "Jakads" });
    const nomineeId = await firstNomineeId();
    setPoll({ closesAt: new Date(Date.now() - 1000).toISOString() });

    expect((await vote({ userId: 2, nomineeId, value: 1 })).body.status).toBe("poll_closed");
    expect((await nominate({ userId: 2, username: "TooLate" })).body.status).toBe("poll_closed");
    // The board itself stays readable after close: the result is the point.
    const board = await call(mockReq("GET", "/api/goat-poll"));
    expect(board.status).toBe(200);
    expect(board.body.nominees).toHaveLength(1);
  });

  it("404s every route once the poll is retired", async () => {
    setPoll({ enabled: false });
    expect((await call(mockReq("GET", "/api/goat-poll"))).status).toBe(404);
    expect((await nominate({ userId: 1, username: "Jakads" })).status).toBe(404);
  });

  it("404s rather than opening an endless poll when a date is a typo", async () => {
    // A NaN deadline would compare false against every clock check and leave
    // voting open forever, so an unparseable date has to switch the poll off.
    setPoll({ closesAt: "not a date" });
    expect((await call(mockReq("GET", "/api/goat-poll"))).status).toBe(404);
    setPoll({ closesAt: new Date(Date.now() + 60_000).toISOString(), opensAt: new Date(Date.now() + 120_000).toISOString() });
    expect((await call(mockReq("GET", "/api/goat-poll"))).status).toBe(404);
  });

  it("refuses a date that is not an explicit UTC instant", async () => {
    // Date.parse takes both of these, and reads both as local time on whatever
    // machine is running — so the committed config would mean one moment on the
    // VPS and another on a laptop, and a viewer's countdown would disagree with
    // the deadline their vote is checked against. Off is the safe reading.
    setPoll({ closesAt: "2099-01-01T00:00:00" });
    expect((await call(mockReq("GET", "/api/goat-poll"))).status).toBe(404);
    setPoll({ closesAt: "2099-01-01 00:00:00" });
    expect((await call(mockReq("GET", "/api/goat-poll"))).status).toBe(404);
    // Right shape, impossible day.
    setPoll({ closesAt: "2099-02-31T00:00:00Z" });
    expect((await call(mockReq("GET", "/api/goat-poll"))).status).toBe(404);
  });

  it("reports the window the pie fills against, plus the clock to fill it by", async () => {
    const opensAt = new Date(Date.now() - 3_600_000).toISOString();
    setPoll({ opensAt });
    const before = Date.now();
    const board = await call(mockReq("GET", "/api/goat-poll"));
    expect(board.body.opensAt).toBe(Date.parse(opensAt));
    expect(board.body.closesAt).toBe(Date.parse(GOAT_POLL.closesAt));
    // The browser counts down against this rather than its own clock, so a
    // viewer whose machine is set to the wrong day still sees the real deadline.
    expect(board.body.serverNow).toBeGreaterThanOrEqual(before);
    expect(board.body.serverNow).toBeLessThanOrEqual(Date.now());
  });

  it("keeps a rerun's rows separate from the previous poll's", async () => {
    await nominate({ userId: 1, username: "Jakads" });
    setPoll({ id: "test-poll-2" });
    expect((await call(mockReq("GET", "/api/goat-poll"))).body.nominees).toHaveLength(0);
    // And the original board is still there to look back at.
    setPoll({ id: "test-poll" });
    expect((await call(mockReq("GET", "/api/goat-poll"))).body.nominees).toHaveLength(1);
  });
});

describe("goat poll auth", () => {
  it("lets anyone read the board but requires the bridge token to write", async () => {
    await nominate({ userId: 1, username: "Jakads" });
    const nomineeId = await firstNomineeId();

    const publicRead = await call(mockReq("GET", "/api/goat-poll"));
    expect(publicRead.status).toBe(200);

    const anonVote = await call(bodyReq("POST", "/api/goat-poll/vote", { userId: 2, nomineeId, value: 1 }, { "content-type": "application/json" }));
    expect(anonVote.status).toBe(401);
    const anonBallot = await call(mockReq("GET", "/api/goat-poll/mine?userId=2"));
    expect(anonBallot.status).toBe(401);

    // The vote never landed: the row still sits on the nominator's alone.
    expect((await call(mockReq("GET", "/api/goat-poll"))).body.nominees[0].net).toBe(1);
  });

  it("returns one voter's own ballot", async () => {
    await nominate({ userId: 1, username: "Jakads" });
    const nomineeId = await firstNomineeId();
    await vote({ userId: 42, nomineeId, value: -1 });

    const mine = await call(mockReq("GET", "/api/goat-poll/mine?userId=42", ADMIN));
    expect(mine.body.votes).toEqual({ [nomineeId]: -1 });
    const someoneElse = await call(mockReq("GET", "/api/goat-poll/mine?userId=43", ADMIN));
    expect(someoneElse.body.votes).toEqual({});
  });
});

describe("goat poll while unreleased", () => {
  it("hides the board from the public read", async () => {
    await nominate({ userId: 1, username: "Jakads" });
    setPoll({ adminOnly: true });

    // The same 404 a retired poll gives, so a browser cannot tell an unreleased
    // poll from one that was never built.
    const publicRead = await call(mockReq("GET", "/api/goat-poll"));
    expect(publicRead.status).toBe(404);
    expect(publicRead.body.error).toBe("poll_not_configured");

    // The admin path (frontend server fn, bridge token) still sees it.
    const adminRead = await call(mockReq("GET", "/api/goat-poll", ADMIN));
    expect(adminRead.status).toBe(200);
    expect(adminRead.body.adminOnly).toBe(true);
    expect(adminRead.body.nominees).toHaveLength(1);
  });

  it("refuses a write the frontend does not vouch for as an admin's", async () => {
    await nominate({ userId: 1, username: "Jakads" });
    const nomineeId = await firstNomineeId();
    setPoll({ adminOnly: true });

    // The bridge token is on every signed-in user's calls, so it alone must not
    // be enough to reach an unreleased poll.
    expect((await vote({ userId: 2, nomineeId, value: 1 })).status).toBe(404);
    expect((await nominate({ userId: 2, username: "Rocma" })).status).toBe(404);
    expect((await call(mockReq("GET", "/api/goat-poll/mine?userId=2", ADMIN))).status).toBe(404);

    expect((await call(mockReq("GET", "/api/goat-poll", ADMIN))).body.nominees).toHaveLength(1);
    // Still on its nominating upvote alone — none of the refused votes landed.
    expect((await call(mockReq("GET", "/api/goat-poll", ADMIN))).body.nominees[0].net).toBe(1);
  });

  it("lets an admin vote and nominate through the same routes", async () => {
    setPoll({ adminOnly: true });
    expect((await nominate({ userId: 7, username: "Jakads", viewerIsAdmin: true })).status).toBe(200);
    const board = await call(mockReq("GET", "/api/goat-poll", ADMIN));
    const nomineeId = board.body.nominees[0].id;
    expect((await vote({ userId: 7, nomineeId, value: 1, viewerIsAdmin: true })).status).toBe(200);
    expect((await call(mockReq("GET", "/api/goat-poll", ADMIN))).body.nominees[0].net).toBe(1);
    expect((await call(mockReq("GET", "/api/goat-poll/mine?userId=7&admin=1", ADMIN))).body.votes).toEqual({
      [nomineeId]: 1,
    });
  });

  it("goes back to public the moment the flag comes off", async () => {
    setPoll({ adminOnly: true });
    await nominate({ userId: 7, username: "Jakads", viewerIsAdmin: true });
    setPoll({ adminOnly: false });

    const publicRead = await call(mockReq("GET", "/api/goat-poll"));
    expect(publicRead.status).toBe(200);
    expect(publicRead.body.adminOnly).toBe(false);
    // And an ordinary signed-in user can vote again without vouching for anything.
    const nomineeId = publicRead.body.nominees[0].id;
    expect((await vote({ userId: 2, nomineeId, value: 1 })).status).toBe(200);
  });
});

describe("normalizeArchiveProof", () => {
  it("accepts a Wayback osu! profile snapshot and extracts a numeric id", () => {
    expect(normalizeArchiveProof(PROOF)).toEqual({ url: PROOF, osuUserId: 12253636 });
    // The /u/ short form and Wayback's flag suffixes (id_, im_) are real URLs
    // people paste out of the archive UI.
    expect(normalizeArchiveProof("https://web.archive.org/web/20180101id_/http://osu.ppy.sh/u/86188")?.osuUserId).toBe(86188);
  });

  it("accepts a username-form profile but leaves the id null", () => {
    const result = normalizeArchiveProof("https://web.archive.org/web/20200101000000/https://osu.ppy.sh/users/Jakads");
    expect(result).not.toBeNull();
    expect(result?.osuUserId).toBeNull();
  });

  it("rejects anything that is not an archived osu! profile", () => {
    expect(normalizeArchiveProof("https://osu.ppy.sh/users/123")).toBeNull();
    expect(normalizeArchiveProof("https://web.archive.org/web/2020/https://example.com/users/123")).toBeNull();
    expect(normalizeArchiveProof("https://web.archive.org/https://osu.ppy.sh/users/123")).toBeNull();
    expect(normalizeArchiveProof("not a url")).toBeNull();
    expect(normalizeArchiveProof(null)).toBeNull();
  });
});
