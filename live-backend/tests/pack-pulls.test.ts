import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import { seedCollectionCard as seedCard } from "./helpers/pack-cards.js";
import { AbuseGuard } from "../src/http/abuse-guard.js";
import { routeHttp } from "../src/http/snapshots.js";
import { JobQueue } from "../src/jobs/queue.js";
import { LiveEventLog } from "../src/live/event-log.js";
import {
  getPackCardCollectors,
  getPackCardStats,
  getPackPulledStats,
  getSharedPackCard,
  listPackPullsByIds,
  listRecentPackPulls,
  PACK_CARD_COLLECTORS_LISTED,
  PACK_PULL_OWNER_HOURLY_CAP,
  recordPackPullEvents,
} from "../src/features/pack-pulls.js";

let dir = "";
let db: Db;
let queue: JobQueue;
let events: LiveEventLog;

const OWNER_ID = 100;
const OTHER_OWNER_ID = 200;
const CARD_A = 1;
const CARD_B = 2;
/* A real entry from HONORARY_USER_IDS: the only players who can be pulled as
   GOAT. */
const GOAT_CARD = 259972;

const ADMIN = { authorization: "Bearer secret" };

/* Every card the pool can deal belongs to a player in `users` (the pool board
   is built by joining it), and the pull log now requires that row before it
   will publish a pull. Fixtures seed it so they describe a real draw. */
async function seedCardUser(userId: number, username = `player${userId}`, countryCode = "CR"): Promise<void> {
  await exec(
    db,
    "insert or replace into users (user_id, username, avatar_url, country_code, updated_at) values (?, ?, '', ?, '2026-01-01')",
    [userId, username, countryCode],
  );
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mania-pack-pulls-"));
  db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
  queue = new JobQueue(db);
  events = new LiveEventLog(db);
  await seedCardUser(CARD_A);
  await seedCardUser(CARD_B);
  await seedCardUser(GOAT_CARD);
});

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

function pullCard(userId: number, tier: string | null, overrides: Partial<{ username: string; countryCode: string; isNew: boolean }> = {}) {
  return {
    userId,
    username: overrides.username ?? `player${userId}`,
    countryCode: overrides.countryCode ?? "CR",
    tier,
    isNew: overrides.isNew ?? true,
  };
}

async function seedCollectionCard(
  ownerUserId: number,
  cardUserId: number,
  copies = 1,
  tier = "rare",
  firstPulledAt = 1000,
  lastPulledAt = 2000,
): Promise<void> {
  await seedCard(db, ownerUserId, cardUserId, { copies, tier, firstPulledAt, lastPulledAt });
}

describe("recordPackPullEvents", () => {
  it("records a batch and computes notable + first-global flags", async () => {
    const result = await recordPackPullEvents(db, OWNER_ID, "opener", "standard", [
      pullCard(CARD_A, "common"),
      pullCard(CARD_B, "mythic"),
    ], 10_000);
    expect(result.recorded).toBe(2);

    const rows = (await exec(db, "select * from pack_pull_events order by card_user_id asc")).rows;
    expect(rows).toHaveLength(2);
    // Both are first-global (empty world), but only the mythic is a notable
    // tier; the common is notable purely through first-global.
    expect(Number(rows[0].is_first_global)).toBe(1);
    expect(Number(rows[0].notable)).toBe(1);
    expect(rows[0].tier).toBe("common");
    expect(Number(rows[1].notable)).toBe(1);
    expect(rows[1].tier).toBe("mythic");
    expect(rows[0].owner_username).toBe("opener");
    expect(Number(rows[0].pulled_at)).toBe(10_000);
  });

  it("returns the inserted event ids, readable back as feed entries", async () => {
    const result = await recordPackPullEvents(db, OWNER_ID, "opener", "standard", [
      pullCard(CARD_A, "common"),
      pullCard(CARD_B, "mythic"),
    ], 10_000);
    expect(result.eventIds).toHaveLength(2);

    const entries = await listPackPullsByIds(db, result.eventIds);
    expect(entries.map((entry) => entry.id)).toEqual([...result.eventIds].sort((a, b) => a - b));
    expect(entries[0]).toMatchObject({
      ownerUserId: OWNER_ID,
      ownerUsername: "opener",
      cardUserId: CARD_A,
      tier: "common",
      packType: "standard",
      isFirstGlobal: true,
      pulledAt: 10_000,
    });
    // Unknown ids are simply absent, and garbage is ignored.
    expect(await listPackPullsByIds(db, [999_999, 0, -1, NaN])).toEqual([]);
  });

  it("only the first pull of a card is first-global; later commons are not notable", async () => {
    await recordPackPullEvents(db, OWNER_ID, "opener", "standard", [pullCard(CARD_A, "common")], 10_000);
    await recordPackPullEvents(db, OTHER_OWNER_ID, "second", "standard", [pullCard(CARD_A, "common")], 20_000);
    const rows = (await exec(db, "select * from pack_pull_events order by pulled_at asc")).rows;
    expect(Number(rows[0].is_first_global)).toBe(1);
    expect(Number(rows[1].is_first_global)).toBe(0);
    expect(Number(rows[1].notable)).toBe(0);
  });

  it("the same card twice in one pull is first-global once and shares one serial", async () => {
    const result = await recordPackPullEvents(db, OWNER_ID, "opener", "standard", [
      pullCard(CARD_A, "common"),
      pullCard(CARD_A, "common"),
    ], 10_000);
    expect(result.recorded).toBe(2);
    const rows = (await exec(db, "select is_first_global from pack_pull_events order by id asc")).rows;
    expect(rows.map((row) => Number(row.is_first_global))).toEqual([1, 0]);
    // The duplicate is a serial no-op: both mints name the serial the
    // (card, owner) pair holds, and the denominator does not inflate.
    expect(result.mints.map((mint) => mint.serial)).toEqual([1, 1]);
    expect(result.mints.map((mint) => mint.mintedTotal)).toEqual([1, 1]);
  });

  /* What happens when a circulating player joins the honorary roster: their
     GOAT card is a new card key, so pulling it is a first even though their
     ordinary card has prior events and owners everywhere. */
  it("a player's first GOAT pull is first-global despite their ordinary card circulating", async () => {
    await recordPackPullEvents(db, OTHER_OWNER_ID, "second", "standard", [pullCard(GOAT_CARD, "common")], 5_000);
    await seedCollectionCard(OTHER_OWNER_ID, GOAT_CARD);
    await recordPackPullEvents(db, OWNER_ID, "opener", "legend", [pullCard(GOAT_CARD, "goat")], 10_000);
    const rows = (await exec(db, "select tier, is_first_global from pack_pull_events order by pulled_at asc")).rows;
    expect(rows.map((row) => [row.tier, Number(row.is_first_global)])).toEqual([
      ["common", 1],
      ["goat", 1],
    ]);
    // And only the first GOAT pull: the key now has an event behind it.
    await recordPackPullEvents(db, OTHER_OWNER_ID, "second", "legend", [pullCard(GOAT_CARD, "goat")], 20_000);
    const later = (await exec(db, "select is_first_global from pack_pull_events where pulled_at = 20000")).rows[0];
    expect(Number(later.is_first_global)).toBe(0);
  });

  it("a GOAT card in another owner's collection defeats the GOAT first even without events", async () => {
    await seedCollectionCard(OTHER_OWNER_ID, GOAT_CARD, 1, "goat");
    await recordPackPullEvents(db, OWNER_ID, "opener", "legend", [pullCard(GOAT_CARD, "goat")], 10_000);
    const row = (await exec(db, "select is_first_global from pack_pull_events")).rows[0];
    expect(Number(row.is_first_global)).toBe(0);
  });

  it("a card already in another owner's collection is not first-global", async () => {
    await seedCollectionCard(OTHER_OWNER_ID, CARD_A);
    await recordPackPullEvents(db, OWNER_ID, "opener", "standard", [pullCard(CARD_A, "common")], 10_000);
    const row = (await exec(db, "select is_first_global from pack_pull_events")).rows[0];
    expect(Number(row.is_first_global)).toBe(0);
  });

  it("the recorder's own pre-synced collection row does not defeat first-global", async () => {
    // The wallet sync can land before the pull event does.
    await seedCollectionCard(OWNER_ID, CARD_A);
    await recordPackPullEvents(db, OWNER_ID, "opener", "standard", [pullCard(CARD_A, "common")], 10_000);
    const row = (await exec(db, "select is_first_global from pack_pull_events")).rows[0];
    expect(Number(row.is_first_global)).toBe(1);
  });

  it("rejects invalid pack types, owners and cards", async () => {
    expect((await recordPackPullEvents(db, OWNER_ID, "opener", "DROP TABLE", [pullCard(CARD_A, "rare")])).recorded).toBe(0);
    expect((await recordPackPullEvents(db, 0, "opener", "standard", [pullCard(CARD_A, "rare")])).recorded).toBe(0);
    expect((await recordPackPullEvents(db, OWNER_ID, "opener", "standard", [{ userId: -1, username: "x" }])).recorded).toBe(0);
    // Unknown tiers are stored as null rather than trusted.
    await recordPackPullEvents(db, OWNER_ID, "opener", "standard", [pullCard(CARD_A, "godlike")], 10_000);
    const row = (await exec(db, "select tier from pack_pull_events")).rows[0];
    expect(row.tier).toBeNull();
  });

  it("refuses GOAT for a player outside the honorary roster", async () => {
    // The wallet path has always checked this; the log did not, so a
    // hand-written pull could put "pulled GOAT <anyone>" on the public feed.
    const result = await recordPackPullEvents(db, OWNER_ID, "opener", "legend", [pullCard(CARD_A, "goat")], 10_000);
    expect(result.recorded).toBe(1);
    const row = (await exec(db, "select tier from pack_pull_events")).rows[0];
    expect(row.tier).toBeNull();

    // The honorary roster itself is unaffected.
    await recordPackPullEvents(db, OWNER_ID, "opener", "legend", [pullCard(GOAT_CARD, "goat")], 11_000);
    const goatRow = (await exec(db, "select tier from pack_pull_events where card_user_id = ?", [GOAT_CARD])).rows[0];
    expect(goatRow.tier).toBe("goat");
  });

  it("drops cards for players the backend has never seen", async () => {
    // Every pullable card comes off the pool board, which is built by joining
    // users - so an id with no row there was never dealt by this backend.
    const result = await recordPackPullEvents(db, OWNER_ID, "opener", "standard", [pullCard(987_654_321, "mythic")], 10_000);
    expect(result.recorded).toBe(0);
    expect((await exec(db, "select count(*) as n from pack_pull_events")).rows[0].n).toBe(0);
  });

  it("names the pulled card from the users row, not the client", async () => {
    await seedCardUser(CARD_A, "real-name", "JP");
    await recordPackPullEvents(
      db,
      OWNER_ID,
      "opener",
      "standard",
      [pullCard(CARD_A, "rare", { username: "Totally Someone Else", countryCode: "ZZ" })],
      10_000,
    );
    const row = (await exec(db, "select card_username, card_country_code from pack_pull_events")).rows[0];
    expect(row.card_username).toBe("real-name");
    expect(row.card_country_code).toBe("JP");
  });

  it("drops batches past the hourly per-owner cap", async () => {
    const now = 1_000_000_000;
    await exec(db, "begin");
    for (let i = 0; i < PACK_PULL_OWNER_HOURLY_CAP; i++) {
      await exec(
        db,
        `insert into pack_pull_events (owner_user_id, owner_username, card_user_id, card_username, card_country_code, tier, pack_type, is_new, is_first_global, notable, pulled_at)
         values (?, 'opener', ?, 'x', 'CR', 'common', 'standard', 0, 0, 0, ?)`,
        [OWNER_ID, 10_000 + i, now],
      );
    }
    await exec(db, "commit");
    const result = await recordPackPullEvents(db, OWNER_ID, "opener", "standard", [pullCard(CARD_A, "rare")], now + 1000);
    expect(result.recorded).toBe(0);
    // A different owner is unaffected.
    const other = await recordPackPullEvents(db, OTHER_OWNER_ID, "second", "standard", [pullCard(CARD_A, "rare")], now + 1000);
    expect(other.recorded).toBe(1);
  });
});

describe("getPackCardStats", () => {
  it("counts distinct owners and total copies from the collection", async () => {
    await seedCollectionCard(OWNER_ID, CARD_A, 2);
    await seedCollectionCard(OTHER_OWNER_ID, CARD_A, 1);
    await seedCollectionCard(OWNER_ID, CARD_B, 0); // fully recycled tombstone
    const stats = await getPackCardStats(db, [CARD_A, CARD_B, 999]);
    expect(stats).toEqual([
      { userId: CARD_A, owners: 2, copies: 3 },
      { userId: CARD_B, owners: 0, copies: 0 },
      { userId: 999, owners: 0, copies: 0 },
    ]);
  });
});

describe("getPackPulledStats", () => {
  it("combines durable collection counts with recent pull events", async () => {
    await seedCollectionCard(OWNER_ID, CARD_A, 2);
    await seedCollectionCard(OTHER_OWNER_ID, CARD_A, 1);
    const recent = Date.now() - 1000;
    const stale = Date.now() - 30 * 24 * 60 * 60 * 1000;
    await recordPackPullEvents(db, OWNER_ID, "opener", "standard", [pullCard(CARD_A, "rare")], recent);
    await recordPackPullEvents(db, OTHER_OWNER_ID, "second", "standard", [pullCard(CARD_A, "rare")], stale);
    const stats = await getPackPulledStats(db, CARD_A);
    expect(stats.owners).toBe(2);
    expect(stats.copies).toBe(3);
    expect(stats.pullEvents7d).toBe(1);
    expect(stats.lastPulledAt).toBe(recent);
  });

  it("returns zeros for a never-pulled player", async () => {
    const stats = await getPackPulledStats(db, 12345);
    expect(stats).toEqual({ userId: 12345, owners: 0, copies: 0, pullEvents7d: 0, lastPulledAt: null });
  });
});

describe("getPackCardCollectors", () => {
  it("lists holders oldest-first with their names, copies and serials", async () => {
    await seedCollectionCard(OWNER_ID, CARD_A, 2, "rare", 5_000, 9_000);
    await seedCollectionCard(OTHER_OWNER_ID, CARD_A, 1, "rare", 1_000, 1_000);
    await seedCollectionCard(OWNER_ID, CARD_B, 1, "rare", 500, 500); // another card, ignored
    // The early holder is a tracked player (live name); the later one is not,
    // so their name comes from the pull log.
    await exec(
      db,
      "insert into users (user_id, username, avatar_url, country_code, updated_at) values (?, 'tracked', '', 'CR', '2026-01-01')",
      [OTHER_OWNER_ID],
    );
    await recordPackPullEvents(db, OWNER_ID, "opener", "standard", [pullCard(CARD_A, "rare")], 9_000);

    const report = await getPackCardCollectors(db, CARD_A);
    expect(report.owners).toBe(2);
    expect(report.copies).toBe(3);
    expect(report.collectors).toHaveLength(2);
    expect(report.collectors[0]).toMatchObject({
      userId: OTHER_OWNER_ID,
      username: "tracked",
      copies: 1,
      tier: "rare",
      // Only the pull log hands out serials, and this holder never pulled
      // through it.
      serial: null,
      firstPulledAt: 1_000,
    });
    expect(report.collectors[1]).toMatchObject({
      userId: OWNER_ID,
      username: "opener",
      copies: 2,
      serial: 1,
      firstPulledAt: 5_000,
      lastPulledAt: 9_000,
    });
  });

  it("folds an owner's ordinary card and GOAT into one holder, keeping the better tier", async () => {
    await seedCollectionCard(OWNER_ID, GOAT_CARD, 1, "rare", 5_000, 5_000);
    await seedCollectionCard(OWNER_ID, GOAT_CARD, 2, "goat", 8_000, 8_000);
    await recordPackPullEvents(db, OWNER_ID, "opener", "legend", [pullCard(GOAT_CARD, "goat")], 8_000);

    const report = await getPackCardCollectors(db, GOAT_CARD);
    expect(report.owners).toBe(1);
    expect(report.collectors).toHaveLength(1);
    expect(report.collectors[0]).toMatchObject({
      userId: OWNER_ID,
      copies: 3,
      tier: "goat",
      serial: 1,
      firstPulledAt: 5_000,
      lastPulledAt: 8_000,
    });
  });

  it("truncates the list but keeps the totals exact", async () => {
    for (let i = 0; i < 5; i++) {
      await seedCollectionCard(1_000 + i, CARD_A, 1, "rare", 1_000 + i, 1_000 + i);
    }
    const report = await getPackCardCollectors(db, CARD_A, 2);
    expect(report.owners).toBe(5);
    expect(report.copies).toBe(5);
    expect(report.listed).toBe(2);
    // Oldest first, so a truncated list keeps whoever got there first.
    expect(report.collectors.map((collector) => collector.userId)).toEqual([1_000, 1_001]);
  });

  it("returns an empty report for a card nobody holds", async () => {
    await seedCollectionCard(OWNER_ID, CARD_A, 0); // fully recycled tombstone
    const report = await getPackCardCollectors(db, CARD_A);
    expect(report).toEqual({
      userId: CARD_A,
      owners: 0,
      copies: 0,
      collectors: [],
      listed: PACK_CARD_COLLECTORS_LISTED,
    });
  });
});

describe("listRecentPackPulls", () => {
  it("returns notable pulls newest-first with live username overlay", async () => {
    await recordPackPullEvents(db, OWNER_ID, "opener", "standard", [pullCard(CARD_A, "common")], 10_000);
    await recordPackPullEvents(db, OTHER_OWNER_ID, "second", "legend", [pullCard(CARD_B, "worldClass")], 20_000);
    // A non-notable pull that must not appear.
    await recordPackPullEvents(db, OTHER_OWNER_ID, "second", "standard", [pullCard(CARD_A, "common", { isNew: false })], 30_000);
    // The card player renamed since the pull.
    await exec(db, "insert or replace into users (user_id, username, avatar_url, country_code, updated_at) values (?, 'renamed', 'https://a.ppy.sh/x', 'CR', '2026-01-01')", [CARD_B]);

    const pulls = await listRecentPackPulls(db, 10);
    expect(pulls).toHaveLength(2);
    expect(pulls[0].cardUserId).toBe(CARD_B);
    expect(pulls[0].cardUsername).toBe("renamed");
    expect(pulls[0].cardAvatarUrl).toBe("https://a.ppy.sh/x");
    expect(pulls[0].tier).toBe("worldClass");
    expect(pulls[0].packType).toBe("legend");
    expect(pulls[0].ownerUsername).toBe("second");
    expect(pulls[1].cardUserId).toBe(CARD_A);
    expect(pulls[1].isFirstGlobal).toBe(true);
  });

  it("caps the limit", async () => {
    for (let i = 0; i < 60; i++) {
      await seedCardUser(1000 + i);
      await recordPackPullEvents(db, OWNER_ID, "opener", "standard", [pullCard(1000 + i, "mythic")], 10_000 + i);
    }
    const pulls = await listRecentPackPulls(db, 500);
    expect(pulls).toHaveLength(50);
  });

  it("includes ordinary pulls when notableOnly is off", async () => {
    await recordPackPullEvents(db, OWNER_ID, "opener", "standard", [pullCard(CARD_A, "common")], 10_000);
    // A repull of the same common: not first-global, not a notable tier.
    await recordPackPullEvents(db, OTHER_OWNER_ID, "second", "standard", [pullCard(CARD_A, "common", { isNew: false })], 20_000);
    expect(await listRecentPackPulls(db, 10)).toHaveLength(1);
    const all = await listRecentPackPulls(db, 10, false);
    expect(all).toHaveLength(2);
    expect(all[0].pulledAt).toBe(20_000);
  });
});

describe("getSharedPackCard", () => {
  it("returns the owned card with owner name from users or the pull log", async () => {
    await seedCollectionCard(OWNER_ID, CARD_A, 2);
    await seedCollectionCard(OTHER_OWNER_ID, CARD_A, 1);
    // Owner is untracked (no users row); their name comes from the pull log.
    await recordPackPullEvents(db, OWNER_ID, "opener", "standard", [pullCard(CARD_A, "rare")], 5_000);
    const shared = await getSharedPackCard(db, OWNER_ID, CARD_A);
    expect(shared).not.toBeNull();
    expect(shared?.owner).toEqual({ userId: OWNER_ID, username: "opener" });
    expect(shared?.card.userId).toBe(CARD_A);
    expect(shared?.card.tier).toBe("rare");
    expect(shared?.card.copies).toBe(2);
    expect(shared?.owners).toBe(2);
  });

  it("prefers the live users row for the owner name", async () => {
    await seedCollectionCard(OWNER_ID, CARD_A);
    await exec(db, "insert into users (user_id, username, avatar_url, country_code, updated_at) values (?, 'tracked-owner', '', 'CR', '2026-01-01')", [OWNER_ID]);
    const shared = await getSharedPackCard(db, OWNER_ID, CARD_A);
    expect(shared?.owner.username).toBe("tracked-owner");
  });

  it("returns null for missing or fully recycled cards", async () => {
    expect(await getSharedPackCard(db, OWNER_ID, CARD_A)).toBeNull();
    await seedCollectionCard(OWNER_ID, CARD_B, 0);
    expect(await getSharedPackCard(db, OWNER_ID, CARD_B)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// HTTP harness (the skins-http shape).

function httpCtx() {
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
  await routeHttp(req, response.res, httpCtx());
  const raw = response.writes.join("");
  let body: ReturnType<typeof JSON.parse> = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = raw;
  }
  return { status: response.res.statusCode, body };
}

describe("pack pull endpoints", () => {
  it("POST /api/packs/pulls requires the admin token", async () => {
    const denied = await call(bodyReq("POST", "/api/packs/pulls", { userId: OWNER_ID, username: "opener" }));
    expect(denied.status).toBe(401);
  });

  it("POST /api/packs/pulls records and feeds the other endpoints", async () => {
    const recorded = await call(bodyReq("POST", "/api/packs/pulls", {
      userId: OWNER_ID,
      username: "opener",
      packType: "standard",
      cards: [pullCard(CARD_A, "legendary")],
    }, ADMIN));
    expect(recorded.status).toBe(202);
    expect(recorded.body.recorded).toBe(1);

    const feed = await call(mockReq("GET", "/api/packs/recent-pulls?limit=5"));
    expect(feed.status).toBe(200);
    expect(feed.body.pulls).toHaveLength(1);
    expect(feed.body.pulls[0].cardUserId).toBe(CARD_A);

    const allFeed = await call(mockReq("GET", "/api/packs/recent-pulls?limit=5&all=1"));
    expect(allFeed.status).toBe(200);
    expect(allFeed.body.pulls).toHaveLength(1);

    const pulled = await call(mockReq("GET", `/api/packs/pulled-stats/${CARD_A}`));
    expect(pulled.status).toBe(200);
    expect(pulled.body.pullEvents7d).toBe(1);
  });

  it("POST /api/packs/pulls publishes each pull on the live event stream", async () => {
    const received: Array<{ type: string; country: string | null; payload: unknown }> = [];
    events.subscribe((event) => received.push({ type: event.type, country: event.country, payload: event.payload }));
    await call(bodyReq("POST", "/api/packs/pulls", {
      userId: OWNER_ID,
      username: "opener",
      packType: "standard",
      cards: [pullCard(CARD_A, "common"), pullCard(GOAT_CARD, "goat")],
    }, ADMIN));

    // Global events (null country) so every /api/live subscriber gets them,
    // carrying the same feed-entry shape the recent-pulls endpoint serves.
    expect(received).toHaveLength(2);
    expect(received[0].type).toBe("pack_pull");
    expect(received[0].country).toBeNull();
    expect(received[0].payload).toMatchObject({ cardUserId: CARD_A, tier: "common", ownerUsername: "opener" });
    expect(received[1].payload).toMatchObject({ cardUserId: GOAT_CARD, tier: "goat" });

    // And the rows are durable, so reconnect replay can serve them.
    const logged = (await exec(db, "select type, country from live_event_log where type = 'pack_pull'")).rows;
    expect(logged).toHaveLength(2);

    // A rejected batch (bad pack type) publishes nothing.
    received.length = 0;
    await call(bodyReq("POST", "/api/packs/pulls", {
      userId: OWNER_ID,
      username: "opener",
      packType: "DROP TABLE",
      cards: [pullCard(CARD_A, "common")],
    }, ADMIN));
    expect(received).toHaveLength(0);
  });

  it("POST /api/packs/pulls rejects a missing owner", async () => {
    const response = await call(bodyReq("POST", "/api/packs/pulls", { packType: "standard", cards: [] }, ADMIN));
    expect(response.status).toBe(400);
  });

  it("GET /api/packs/card-stats returns collection counts", async () => {
    await seedCollectionCard(OWNER_ID, CARD_A, 2);
    await seedCollectionCard(OTHER_OWNER_ID, CARD_A, 1);
    const response = await call(mockReq("GET", `/api/packs/card-stats?ids=${CARD_A},${CARD_B}`));
    expect(response.status).toBe(200);
    expect(response.body.cards).toEqual([
      { userId: CARD_A, owners: 2, copies: 3 },
      { userId: CARD_B, owners: 0, copies: 0 },
    ]);
  });

  it("GET /api/packs/card-stats without ids is a 400", async () => {
    const response = await call(mockReq("GET", "/api/packs/card-stats?ids=abc"));
    expect(response.status).toBe(400);
  });

  it("GET /api/packs/pulled-by/{id} needs the admin token and lists the holders", async () => {
    await seedCollectionCard(OWNER_ID, CARD_A, 2);
    const denied = await call(mockReq("GET", `/api/packs/pulled-by/${CARD_A}`));
    expect(denied.status).toBe(401);

    const allowed = await call(mockReq("GET", `/api/packs/pulled-by/${CARD_A}`, ADMIN));
    expect(allowed.status).toBe(200);
    expect(allowed.body.owners).toBe(1);
    expect(allowed.body.collectors[0].userId).toBe(OWNER_ID);

    const invalid = await call(mockReq("GET", "/api/packs/pulled-by/0", ADMIN));
    expect(invalid.status).toBe(400);
  });

  it("GET /api/packs/pulled-card/{owner}/{card} serves the share payload and 404s when absent", async () => {
    await seedCollectionCard(OWNER_ID, CARD_A);
    const found = await call(mockReq("GET", `/api/packs/pulled-card/${OWNER_ID}/${CARD_A}`));
    expect(found.status).toBe(200);
    expect(found.body.card.userId).toBe(CARD_A);
    expect(found.body.owners).toBe(1);
    const missing = await call(mockReq("GET", `/api/packs/pulled-card/${OWNER_ID}/${CARD_B}`));
    expect(missing.status).toBe(404);
  });
});
