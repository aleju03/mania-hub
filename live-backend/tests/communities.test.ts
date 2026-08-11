import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, migrate, type Db } from "../src/db.js";
import { AbuseGuard } from "../src/http/abuse-guard.js";
import { routeHttp } from "../src/http/snapshots.js";
import { JobQueue } from "../src/jobs/queue.js";
import { LiveEventLog } from "../src/live/event-log.js";
import { COMMUNITY_MAX_OPEN_REPORTS_PER_USER, COMMUNITY_MAX_PER_USER } from "../src/features/communities.js";

/* The /communities directory end to end through the router: who may write, the
   caps, the review states, and what a stranger is allowed to read back. */

let dir = "";
let db: Db;
let queue: JobQueue;
let events: LiveEventLog;

const ADMIN = { authorization: "Bearer secret" };
const JSON_HEADERS = { ...ADMIN, "content-type": "application/json" };
const OWNER = 7095193;
const OTHER = 12490530;

// Every submit resolves its invite against Discord; the stub answers as whatever
// guild the test asked about, so the guild-match check always passes and the
// tests are about this codebase rather than about Discord.
function stubDiscord(): void {
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    // The widget endpoint a server with its widget on publishes; 403 is the
    // ordinary answer for every other server, which is what Discord returns.
    const widgetGuild = String(input).match(/\/guilds\/([^/]+)\/widget\.json/)?.[1];
    if (widgetGuild) {
      const instant = widgetInvites[widgetGuild];
      return {
        ok: Boolean(instant),
        status: instant ? 200 : 403,
        json: async () => ({ instant_invite: instant ?? null }),
        clone: () => ({ json: async () => ({}) }),
        headers: new Headers(),
      };
    }
    const code = String(input).split("/invites/")[1]?.split("?")[0] ?? "code";
    return {
      ok: true,
      status: 200,
      json: async () => ({
        code,
        expires_at: inviteExpiries[code] ?? null,
        approximate_member_count: guildMembers[code] ?? 100,
        approximate_presence_count: 10,
        guild: {
          id: guildForCode[code] ?? "guild-1",
          name: `Server ${code}`,
          icon: guildArt[code] ?? null,
          banner: guildArt[code] ?? null,
        },
      }),
      clone: () => ({ json: async () => ({}) }),
      headers: new Headers(),
    };
  }));
}

let guildForCode: Record<string, string> = {};
// The icon and banner hashes Discord reports, for the tests about the CDN URLs
// built out of them.
let guildArt: Record<string, string> = {};
let guildMembers: Record<string, number> = {};
let widgetInvites: Record<string, string> = {};
let inviteExpiries: Record<string, string> = {};

beforeEach(async () => {
  guildForCode = {};
  guildArt = {};
  guildMembers = {};
  widgetInvites = {};
  inviteExpiries = {};
  stubDiscord();
  dir = await mkdtemp(join(tmpdir(), "mania-communities-"));
  db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
  queue = new JobQueue(db);
  events = new LiveEventLog(db);
});

afterEach(async () => {
  vi.unstubAllGlobals();
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
      communityRefreshIntervalMs: 60_000,
      communityInviteFailLimit: 3,
      communityRefreshBatchSize: 50,
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

function submit(overrides: Record<string, unknown> = {}) {
  return call(bodyReq("POST", "/api/communities/submit", {
    userId: OWNER,
    username: "aleju",
    guildId: "guild-1",
    invite: "https://discord.gg/code1",
    discordUserId: "discord-1",
    discordUsername: "aleju",
    isGuildOwner: true,
    pitch: "A place for mania players.",
    countryCode: "cr",
    language: "es",
    ...overrides,
  }, JSON_HEADERS));
}

async function approve(id: string) {
  return call(bodyReq("POST", "/api/communities/review", { id, action: "approve" }, JSON_HEADERS));
}

function list(query = "") {
  return call(mockReq("GET", `/api/communities/list?viewerUserId=${OWNER}${query}`, ADMIN));
}

describe("submitting a server", () => {
  it("writes a pending listing that is not on the directory yet", async () => {
    const created = await submit();
    expect(created.status).toBe(200);
    expect(created.body.ok).toBe(true);
    expect(created.body.community.status).toBe("pending");
    // Identity comes from Discord's invite response, not from the form.
    expect(created.body.community.name).toBe("Server code1");

    const browsing = await list();
    expect(browsing.body.total).toBe(0);
  });

  it("normalizes the details it was handed", async () => {
    const created = await submit();
    expect(created.body.community.countryCode).toBe("CR");
    expect(created.body.community.language).toBe("es");
    // A language outside the list is dropped rather than stored.
    guildForCode.code2 = "guild-2";
    const other = await submit({ guildId: "guild-2", invite: "code2", language: "klingon", countryCode: "nope" });
    expect(other.body.community.language).toBeNull();
    expect(other.body.community.countryCode).toBeNull();
  });

  it("refuses a listing with no description", async () => {
    const created = await submit({ pitch: "   " });
    expect(created.body).toEqual({ ok: false, error: "empty_pitch" });
  });

  it("refuses an invite for a different server than the one claimed", async () => {
    guildForCode.code9 = "some-other-guild";
    const created = await submit({ invite: "code9" });
    expect(created.status).toBe(400);
    expect(created.body.error).toBe("guild_mismatch");
  });

  it("keeps one Discord server to one listing", async () => {
    await submit();
    const again = await submit({ userId: OTHER, username: "someone", discordUserId: "discord-2" });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("already_listed");
  });

  it("caps how many servers one account can list", async () => {
    for (let index = 0; index < COMMUNITY_MAX_PER_USER; index += 1) {
      guildForCode[`code${index}`] = `guild-${index}`;
      const created = await submit({ guildId: `guild-${index}`, invite: `code${index}` });
      expect(created.body.ok).toBe(true);
    }
    guildForCode.codeN = "guild-N";
    const over = await submit({ guildId: "guild-N", invite: "codeN" });
    expect(over.status).toBe(429);
    expect(over.body.error).toBe("limit_reached");
  });

  it("refuses a write with no admin token", async () => {
    const created = await call(bodyReq("POST", "/api/communities/submit", { userId: OWNER }, { "content-type": "application/json" }));
    expect(created.status).toBe(401);
  });
});

describe("review", () => {
  it("puts an approved listing on the directory", async () => {
    const created = await submit();
    await approve(created.body.community.id);
    const browsing = await list();
    expect(browsing.body.total).toBe(1);
    expect(browsing.body.communities[0].name).toBe("Server code1");
  });

  it("keeps a rejected listing off the directory and tells its owner why", async () => {
    const created = await submit();
    const id = created.body.community.id;
    await call(bodyReq("POST", "/api/communities/review", { id, action: "reject", reason: "Not a mania server." }, JSON_HEADERS));

    const browsing = await list();
    expect(browsing.body.total).toBe(0);

    const mine = await call(mockReq("GET", `/api/communities/mine?viewerUserId=${OWNER}`, ADMIN));
    expect(mine.body.communities[0].status).toBe("rejected");
    expect(mine.body.communities[0].rejectReason).toBe("Not a mania server.");
  });

  it("hides an approved listing again", async () => {
    const created = await submit();
    const id = created.body.community.id;
    await approve(id);
    await call(bodyReq("POST", "/api/communities/review", { id, action: "hide" }, JSON_HEADERS));
    expect((await list()).body.total).toBe(0);
    await call(bodyReq("POST", "/api/communities/review", { id, action: "unhide" }, JSON_HEADERS));
    expect((await list()).body.total).toBe(1);
  });

  it("queues pending listings and, separately, ones edited since approval", async () => {
    const pending = await submit();
    guildForCode.code2 = "guild-2";
    const approved = await submit({ guildId: "guild-2", invite: "code2" });
    await approve(approved.body.community.id);

    let queueBody = (await call(mockReq("GET", "/api/communities/queue", ADMIN))).body;
    expect(queueBody.pending.map((row: { id: string }) => row.id)).toEqual([pending.body.community.id]);
    expect(queueBody.edited).toHaveLength(0);

    await call(bodyReq("POST", "/api/communities/update", {
      userId: OWNER,
      id: approved.body.community.id,
      pitch: "Rewritten after approval.",
    }, JSON_HEADERS));

    queueBody = (await call(mockReq("GET", "/api/communities/queue", ADMIN))).body;
    expect(queueBody.edited.map((row: { id: string }) => row.id)).toEqual([approved.body.community.id]);
    // An edited listing stays live while it waits to be looked at again.
    expect((await list()).body.total).toBe(1);
  });
});

describe("owner edits", () => {
  it("sends a rejected listing back for review", async () => {
    const created = await submit();
    const id = created.body.community.id;
    await call(bodyReq("POST", "/api/communities/review", { id, action: "reject", reason: "No" }, JSON_HEADERS));

    const edited = await call(bodyReq("POST", "/api/communities/update", {
      userId: OWNER,
      id,
      pitch: "Rewritten to answer the reason.",
    }, JSON_HEADERS));
    expect(edited.body.community.status).toBe("pending");
    expect(edited.body.community.rejectReason).toBeNull();
  });

  it("will not let one person edit or delete another person's listing", async () => {
    const created = await submit();
    const id = created.body.community.id;

    const edited = await call(bodyReq("POST", "/api/communities/update", {
      userId: OTHER,
      id,
      pitch: "Hijacked.",
    }, JSON_HEADERS));
    expect(edited.status).toBe(404);

    const deleted = await call(bodyReq("POST", "/api/communities/delete", { userId: OTHER, id }, JSON_HEADERS));
    expect(deleted.status).toBe(404);

    const mine = await call(mockReq("GET", `/api/communities/mine?viewerUserId=${OWNER}`, ADMIN));
    expect(mine.body.communities[0].pitch).toBe("A place for mania players.");
  });

  it("lets an owner delete their own listing", async () => {
    const created = await submit();
    const deleted = await call(bodyReq("POST", "/api/communities/delete", {
      userId: OWNER,
      id: created.body.community.id,
    }, JSON_HEADERS));
    expect(deleted.body.ok).toBe(true);
    const mine = await call(mockReq("GET", `/api/communities/mine?viewerUserId=${OWNER}`, ADMIN));
    expect(mine.body.communities).toHaveLength(0);
  });
});

describe("browsing", () => {
  async function seed() {
    guildForCode.big = "guild-big";
    guildForCode.small = "guild-small";
    guildMembers.big = 5000;
    guildMembers.small = 50;
    const big = await submit({ guildId: "guild-big", invite: "big", countryCode: "CL", language: "es" });
    const small = await submit({ guildId: "guild-small", invite: "small", countryCode: "CR", language: "en" });
    await approve(big.body.community.id);
    await approve(small.body.community.id);
  }

  it("sorts biggest first by default", async () => {
    await seed();
    const browsing = await list();
    expect(browsing.body.communities.map((row: { memberCount: number }) => row.memberCount)).toEqual([5000, 50]);
  });

  it("filters by country and by language", async () => {
    await seed();
    expect((await list("&country=CR")).body.total).toBe(1);
    expect((await list("&country=CL")).body.communities[0].memberCount).toBe(5000);
    expect((await list("&lang=en")).body.total).toBe(1);
    expect((await list("&lang=pl")).body.total).toBe(0);
  });

  it("offers only the countries and languages that have servers behind them", async () => {
    await seed();
    const facets = (await list()).body.facets;
    expect(facets.countries.map((row: { value: string }) => row.value).sort()).toEqual(["CL", "CR"]);
    expect(facets.languages.map((row: { value: string }) => row.value).sort()).toEqual(["en", "es"]);
    expect(facets.countries.every((row: { count: number }) => row.count === 1)).toBe(true);
  });

  it("keeps the other choices offered while one filter is applied", async () => {
    await seed();
    // Filtering to Chile must not shrink the country row to just Chile, or
    // there would be no way back to Costa Rica without clearing the filter.
    const facets = (await list("&country=CL")).body.facets;
    expect(facets.countries.map((row: { value: string }) => row.value).sort()).toEqual(["CL", "CR"]);
  });

  it("keeps the review fields out of a listing someone else is browsing", async () => {
    await seed();
    const browsing = await list();
    const row = browsing.body.communities[0];
    expect(row.status).toBeUndefined();
    expect(row.rejectReason).toBeUndefined();
    // The Discord account behind a listing is never on the public card.
    expect(row.discordUsername).toBeUndefined();
  });
});

/*
 * A listing may name the places it is for. What that buys is that the invite is
 * never in the response for anyone else - not withheld by the page, absent -
 * and, if its owner asked, that the listing is not in their directory either.
 */
describe("who a server is for", () => {
  function browse(viewerCountry: string, viewerUserId = OTHER) {
    return call(mockReq(
      "GET",
      `/api/communities/list?viewerUserId=${viewerUserId}&viewerCountry=${viewerCountry}`,
      ADMIN,
    ));
  }

  async function listFor(scopes: string[], accessHidden = false) {
    const created = await submit({ accessScopes: scopes, accessHidden });
    await approve(created.body.community.id);
    return created.body.community.id as string;
  }

  it("gives the invite to a country the server named, and to nobody else", async () => {
    await listFor(["FR"]);
    expect((await browse("FR")).body.communities[0].inviteUrl).toBe("https://discord.gg/code1");
    const outside = (await browse("CR")).body.communities[0];
    expect(outside.inviteUrl).toBeNull();
    // The card still says who it is for, which is the whole point of showing it.
    expect(outside.accessScopes).toEqual(["FR"]);
  });

  it("counts a region as every country in it", async () => {
    await listFor(["R-CAMERICA"]);
    // Costa Rica is in Central America; France is not.
    expect((await browse("CR")).body.communities[0].inviteUrl).toBe("https://discord.gg/code1");
    expect((await browse("FR")).body.communities[0].inviteUrl).toBeNull();
  });

  it("locks a viewer whose country is unknown", async () => {
    await listFor(["R-EUROPE"]);
    const anonymous = await call(mockReq(`GET`, `/api/communities/list?viewerUserId=${OTHER}`, ADMIN));
    expect(anonymous.body.communities[0].inviteUrl).toBeNull();
  });

  it("still hands the owner their way in, wherever they are", async () => {
    const id = await listFor(["FR"]);
    const own = await call(mockReq("GET", `/api/communities/get?id=${id}&viewerUserId=${OWNER}&viewerCountry=CR`, ADMIN));
    expect(own.body.community.inviteUrl).toBe("https://discord.gg/code1");
  });

  it("gives a moderator the invite while it is theirs to decide, and not after", async () => {
    // Joining a server is part of deciding whether to approve it, so a listing
    // waiting on review hands its invite over.
    const pending = await submit({ accessScopes: ["FR"] });
    const asModerator = (id: string) =>
      call(mockReq("GET", `/api/communities/get?id=${id}&viewerUserId=${OTHER}&viewerCountry=CR&asAdmin=1`, ADMIN));
    expect((await asModerator(pending.body.community.id)).body.community.inviteUrl).toBe("https://discord.gg/code1");

    // Approved and settled, a moderator browsing is just someone browsing. This
    // is the mismatch that made a locked card open onto a working Join button.
    await approve(pending.body.community.id);
    expect((await asModerator(pending.body.community.id)).body.community.inviteUrl).toBeNull();

    // Rewritten since that review, so it is back in front of them.
    await call(bodyReq("POST", "/api/communities/update", {
      userId: OWNER,
      id: pending.body.community.id,
      pitch: "Rewritten after approval.",
    }, JSON_HEADERS));
    expect((await asModerator(pending.body.community.id)).body.community.inviteUrl).toBe("https://discord.gg/code1");
  });

  it("keeps a hidden listing out of the directory, its totals and its facets", async () => {
    await listFor(["FR"], true);
    const inside = await browse("FR");
    expect(inside.body.total).toBe(1);
    const outside = await browse("CR");
    expect(outside.body.total).toBe(0);
    expect(outside.body.communities).toEqual([]);
    // Offering a France filter that leads to an empty grid would be worse than
    // not offering it, so the facets are counted over the same set.
    expect(outside.body.facets.countries).toEqual([]);
  });

  it("404s a hidden listing's page rather than leaving it as the way in", async () => {
    const id = await listFor(["FR"], true);
    const outside = await call(mockReq("GET", `/api/communities/get?id=${id}&viewerUserId=${OTHER}&viewerCountry=CR`, ADMIN));
    expect(outside.status).toBe(404);
    const inside = await call(mockReq("GET", `/api/communities/get?id=${id}&viewerUserId=${OTHER}&viewerCountry=FR`, ADMIN));
    expect(inside.status).toBe(200);
  });

  it("shows a locked listing to everyone when its owner did not hide it", async () => {
    await listFor(["FR"]);
    expect((await browse("CR")).body.total).toBe(1);
  });

  it("drops junk scopes and cannot be hidden without them", async () => {
    const created = await submit({ accessScopes: ["fr", "FR", "R-NOWHERE", "FRANCE", 7], accessHidden: true });
    // Uppercased, deduped, and only codes that name something real survive.
    expect(created.body.community.accessScopes).toEqual(["FR"]);
    expect(created.body.community.accessHidden).toBe(true);

    // Opening it back up to everyone drops the hiding with it, so nobody ends up
    // with a public server half the directory cannot see.
    const opened = await call(bodyReq("POST", "/api/communities/update", {
      userId: OWNER,
      id: created.body.community.id,
      pitch: "A place for mania players.",
      accessScopes: [],
    }, JSON_HEADERS));
    expect(opened.body.community.accessScopes).toEqual([]);
    expect(opened.body.community.accessHidden).toBe(false);
  });

  /*
   * Discord answers /guilds/<id>/widget.json to anyone, and for a server with
   * its widget on that response carries an invite. So the id is a way past the
   * lock for some servers, and it is in the icon and banner URLs as well as the
   * field - which is why a locked card keeps its art but stops hotlinking it.
   */
  it("keeps the guild id off a locked card, and the CDN links that carry it", async () => {
    guildForCode.art = "839021274176618506";
    guildArt.art = "abc123";
    const created = await submit({ guildId: "839021274176618506", invite: "art", accessScopes: ["FR"] });
    const id = created.body.community.id as string;
    await approve(id);

    const outside = (await browse("CR")).body.communities[0];
    expect(outside.guildId).toBeUndefined();
    expect(outside.iconUrl).toBe(`/api/community-image?id=${id}&kind=icon`);
    expect(outside.bannerUrl).toBe(`/api/community-image?id=${id}&kind=banner`);
    // The one thing the page wanted the id for survives as its own field.
    expect(outside.guildCreatedAt).toBe("2021-05-04T06:11:00.025Z");

    const inside = (await browse("FR")).body.communities[0];
    expect(inside.guildId).toBe("839021274176618506");
    expect(inside.iconUrl).toContain("839021274176618506");
    expect(inside.bannerUrl).toContain("839021274176618506");
  });

  it("draws no picture for a server that has none, locked or not", async () => {
    const id = await listFor(["FR"]);
    for (const country of ["FR", "CR"]) {
      const card = (await browse(country)).body.communities[0];
      expect(card.id).toBe(id);
      expect(card.iconUrl).toBeNull();
      expect(card.bannerUrl).toBeNull();
    }
  });

  /*
   * The picture behind a locked card, which the frontend route fetches with the
   * admin token and pipes to the browser. It resolves the guild id here rather
   * than sending it out, so the check in front of it is the whole point.
   */
  describe("resolving one card's picture", () => {
    function imageUrl(id: string, kind: string, viewerUserId = OTHER, viewerCountry = "CR") {
      return call(mockReq(
        "GET",
        `/api/communities/image-url?id=${id}&kind=${kind}&viewerUserId=${viewerUserId}&viewerCountry=${viewerCountry}`,
        ADMIN,
      ));
    }

    async function listWithArt(overrides: Record<string, unknown> = {}) {
      guildForCode.art = "839021274176618506";
      guildArt.art = "abc123";
      const created = await submit({ guildId: "839021274176618506", invite: "art", ...overrides });
      return created.body.community.id as string;
    }

    it("hands back the CDN link for a listing the viewer may see", async () => {
      const id = await listWithArt({ accessScopes: ["FR"] });
      await approve(id);
      const icon = await imageUrl(id, "icon");
      expect(icon.status).toBe(200);
      expect(icon.body.url).toBe("https://cdn.discordapp.com/icons/839021274176618506/abc123.png?size=128");
      const banner = await imageUrl(id, "banner");
      expect(banner.body.url).toBe("https://cdn.discordapp.com/banners/839021274176618506/abc123.png?size=512");
    });

    it("refuses a listing the viewer could not see the page of", async () => {
      // Hidden outside its places: not on the directory, no page, no picture.
      const hidden = await listWithArt({ accessScopes: ["FR"], accessHidden: true });
      await approve(hidden);
      expect((await imageUrl(hidden, "icon")).status).toBe(404);
      expect((await imageUrl(hidden, "icon", OTHER, "FR")).status).toBe(200);
      // Its owner sees their own from anywhere, as they do the listing.
      expect((await imageUrl(hidden, "icon", OWNER)).status).toBe(200);
    });

    it("refuses a pending listing, and a stranger, and an id that is nothing", async () => {
      const pending = await listWithArt({ accessScopes: ["FR"] });
      expect((await imageUrl(pending, "icon")).status).toBe(404);
      expect((await imageUrl(pending, "icon", OWNER)).status).toBe(200);
      expect((await imageUrl("not-a-listing", "icon", OWNER)).status).toBe(404);
    });

    it("refuses a listing with no art of that kind", async () => {
      const id = await listFor(["FR"]);
      expect((await imageUrl(id, "icon", OWNER)).status).toBe(404);
    });

    it("takes nobody's word for it without the token", async () => {
      const id = await listWithArt();
      await approve(id);
      const open = await call(mockReq("GET", `/api/communities/image-url?id=${id}&kind=icon&viewerUserId=${OTHER}`));
      expect(open.status).toBe(401);
    });
  });

  it("keeps the hidden flag off a card that is not the owner's", async () => {
    await listFor(["FR"]);
    expect((await browse("FR")).body.communities[0].accessHidden).toBeUndefined();
    expect((await browse("FR", OWNER)).body.communities[0].accessHidden).toBeUndefined();
  });
});

describe("one listing's own page", () => {
  function get(id: string, viewerUserId: number = OWNER, extra = "") {
    return call(mockReq("GET", `/api/communities/get?id=${id}&viewerUserId=${viewerUserId}${extra}`, ADMIN));
  }

  it("hands an approved listing to anyone with the review fields off", async () => {
    const created = await submit();
    await approve(created.body.community.id);
    const page = await get(created.body.community.id, OTHER);
    expect(page.status).toBe(200);
    expect(page.body.community.name).toBe("Server code1");
    expect(page.body.community.status).toBeUndefined();
    expect(page.body.community.discordUsername).toBeUndefined();
  });

  it("gives the owner their own listing before it is approved, and nobody else", async () => {
    const created = await submit();
    const mine = await get(created.body.community.id);
    expect(mine.status).toBe(200);
    expect(mine.body.community.status).toBe("pending");

    // 404 rather than 403: whether a pending listing exists at all is not
    // something to confirm to someone who cannot see it.
    const stranger = await get(created.body.community.id, OTHER);
    expect(stranger.status).toBe(404);

    // A moderator reads anyone's, which is what the review page links open.
    const moderator = await get(created.body.community.id, OTHER, "&asAdmin=1");
    expect(moderator.status).toBe(200);
    expect(moderator.body.community.status).toBe("pending");
  });

  it("404s an id that is not a listing", async () => {
    expect((await get("nope")).status).toBe(404);
  });
});

describe("flagging a listing", () => {
  function report(id: string, overrides: Record<string, unknown> = {}) {
    return call(bodyReq("POST", "/api/communities/report", {
      userId: OTHER,
      username: "someone",
      id,
      reason: "misleading",
      details: "It is a trading server, not a mania one.",
      ...overrides,
    }, JSON_HEADERS));
  }

  function queue() {
    return call(mockReq("GET", "/api/communities/queue", ADMIN));
  }

  async function listed() {
    const created = await submit();
    await approve(created.body.community.id);
    return created.body.community.id as string;
  }

  it("puts a live listing back in front of a moderator, with what was said", async () => {
    const id = await listed();
    // Nothing waiting: the listing was already approved.
    expect((await queue()).body.reported).toEqual([]);

    expect((await report(id)).body).toEqual({ ok: true });

    const after = await queue();
    expect(after.body.reported).toHaveLength(1);
    expect(after.body.reported[0].id).toBe(id);
    expect(after.body.reports[id]).toHaveLength(1);
    expect(after.body.reports[id][0].reason).toBe("misleading");
    expect(after.body.reports[id][0].details).toBe("It is a trading server, not a mania one.");
    expect(after.body.reports[id][0].reporterUsername).toBe("someone");
  });

  it("keeps one person to one report on a listing, however many they send", async () => {
    const id = await listed();
    await report(id);
    await report(id, { reason: "spam", details: "changed my mind" });
    await report(id);

    const after = await queue();
    expect(after.body.reports[id]).toHaveLength(1);
    // The last one is what stands, rather than the first.
    expect(after.body.reports[id][0].reason).toBe("misleading");
  });

  it("refuses your own listing", async () => {
    const id = await listed();
    const mine = await report(id, { userId: OWNER });
    expect(mine.status).toBe(200);
    expect(mine.body).toEqual({ ok: false, error: "own_listing" });
    expect((await queue()).body.reported).toEqual([]);
  });

  it("404s an id that is not a listing", async () => {
    const missing = await report("nope");
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe("not_found");
  });

  it("says on the page whether you already flagged it, and only to you", async () => {
    const id = await listed();
    await report(id);
    const mine = await call(mockReq("GET", `/api/communities/get?id=${id}&viewerUserId=${OTHER}`, ADMIN));
    expect(mine.body.community.viewerReported).toBe(true);
    // Nobody else learns that anyone reported it.
    const stranger = await call(mockReq("GET", `/api/communities/get?id=${id}&viewerUserId=999999`, ADMIN));
    expect(stranger.body.community.viewerReported).toBeUndefined();
  });

  it("clears the reports when a moderator decides anything, including approving", async () => {
    const id = await listed();
    await report(id);
    expect((await queue()).body.reported).toHaveLength(1);

    await approve(id);
    const after = await queue();
    expect(after.body.reported).toEqual([]);
    expect(after.body.reports).toEqual({});

    // Cleared, not spent: the listing can be flagged again afterwards.
    expect((await report(id)).body).toEqual({ ok: true });
    expect((await queue()).body.reported).toHaveLength(1);
  });

  it("shows the reports on a listing that is already waiting, without listing it twice", async () => {
    const created = await submit();
    const id = created.body.community.id as string;
    await report(id);
    const after = await queue();
    expect(after.body.pending).toHaveLength(1);
    expect(after.body.reported).toEqual([]);
    expect(after.body.reports[id]).toHaveLength(1);
  });

  it("hands a moderator the way in while a report on it is unanswered", async () => {
    // France-only, and the moderator is not in France: locked for them until
    // somebody flags it, because answering a report means going and looking.
    const created = await submit({ accessScopes: ["FR"] });
    const id = created.body.community.id as string;
    await approve(id);
    const locked = await call(mockReq("GET", `/api/communities/get?id=${id}&viewerUserId=${OTHER}&viewerCountry=CR&asAdmin=1`, ADMIN));
    expect(locked.body.community.inviteUrl).toBeNull();

    await report(id);
    const open = await call(mockReq("GET", `/api/communities/get?id=${id}&viewerUserId=${OTHER}&viewerCountry=CR&asAdmin=1`, ADMIN));
    expect(open.body.community.inviteUrl).toBe("https://discord.gg/code1");
    expect((await queue()).body.reported[0].inviteUrl).toBe("https://discord.gg/code1");

    // And not to somebody who is only browsing.
    const browsing = await call(mockReq("GET", `/api/communities/get?id=${id}&viewerUserId=${OTHER}&viewerCountry=CR`, ADMIN));
    expect(browsing.body.community.inviteUrl).toBeNull();

    // Answered, and it locks again.
    await approve(id);
    const after = await call(mockReq("GET", `/api/communities/get?id=${id}&viewerUserId=${OTHER}&viewerCountry=CR&asAdmin=1`, ADMIN));
    expect(after.body.community.inviteUrl).toBeNull();
  });

  it("takes the reports with the listing when it is deleted", async () => {
    const id = await listed();
    await report(id);
    await call(bodyReq("POST", "/api/communities/review", { id, action: "delete" }, JSON_HEADERS));
    const after = await queue();
    expect(after.body.reported).toEqual([]);
    expect(after.body.reports).toEqual({});
  });

  it("caps how many listings one account can have flagged and unread", async () => {
    const ids: string[] = [];
    for (let index = 0; index < COMMUNITY_MAX_OPEN_REPORTS_PER_USER; index += 1) {
      guildForCode[`rcode${index}`] = `rguild-${index}`;
      const created = await submit({
        userId: OWNER + index,
        guildId: `rguild-${index}`,
        invite: `rcode${index}`,
        discordUserId: `discord-r${index}`,
      });
      await approve(created.body.community.id);
      ids.push(created.body.community.id);
    }
    for (const id of ids) {
      expect((await report(id)).body).toEqual({ ok: true });
    }

    guildForCode.rcodeN = "rguild-N";
    const extra = await submit({ userId: OWNER + 99, guildId: "rguild-N", invite: "rcodeN", discordUserId: "discord-rN" });
    await approve(extra.body.community.id);
    expect((await report(extra.body.community.id)).body).toEqual({ ok: false, error: "too_many_reports" });

    // A moderator reading one frees the slot back up.
    await approve(ids[0]);
    expect((await report(extra.body.community.id)).body).toEqual({ ok: true });
  });

  it("is closed to anyone without the token", async () => {
    const id = await listed();
    const anonymous = await call(bodyReq("POST", "/api/communities/report", { userId: OTHER, id }, { "content-type": "application/json" }));
    expect(anonymous.status).toBe(401);
  });
});

describe("tags", () => {
  it("cleans what was typed before storing it", async () => {
    const created = await submit({
      tags: ["  Tournaments ", "TOURNAMENTS", "mapping!!", "", "x".repeat(60), "a", "b", "c"],
    });
    // Lowercased, deduped, punctuation dropped, length and count capped.
    expect(created.body.community.tags).toEqual([
      "tournaments",
      "mapping",
      "x".repeat(24),
      "a",
      "b",
    ]);
  });

  it("takes a comma-separated string as well as an array", async () => {
    const created = await submit({ tags: "ln, 7k, dan" });
    expect(created.body.community.tags).toEqual(["ln", "7k", "dan"]);
  });

  it("filters the directory by one tag without half-matching a longer one", async () => {
    guildForCode.taga = "guild-a";
    guildForCode.tagb = "guild-b";
    const first = await submit({ guildId: "guild-a", invite: "taga", tags: ["ln"] });
    const second = await submit({ guildId: "guild-b", invite: "tagb", tags: ["ln maps", "dan"] });
    await approve(first.body.community.id);
    await approve(second.body.community.id);

    expect((await list("&tag=ln")).body.total).toBe(1);
    expect((await list("&tag=ln%20maps")).body.total).toBe(1);
    expect((await list("&tag=dan")).body.communities[0].guildId).toBe("guild-b");
    expect((await list("&tag=nothing")).body.total).toBe(0);
  });

  it("offers every tag that is actually on a listing, counted", async () => {
    guildForCode.taga = "guild-a";
    guildForCode.tagb = "guild-b";
    const first = await submit({ guildId: "guild-a", invite: "taga", tags: ["ln", "dan"] });
    const second = await submit({ guildId: "guild-b", invite: "tagb", tags: ["ln"] });
    await approve(first.body.community.id);
    await approve(second.body.community.id);

    const facets = (await list()).body.facets;
    expect(facets.tags).toEqual([
      { value: "ln", count: 2 },
      { value: "dan", count: 1 },
    ]);
    // And filtering by one tag must not shrink the row to only that tag.
    expect((await list("&tag=dan")).body.facets.tags).toHaveLength(2);
  });

  it("lets an owner clear the tags off their own listing", async () => {
    const created = await submit({ tags: ["ln"] });
    const updated = await call(bodyReq("POST", "/api/communities/update", {
      userId: OWNER,
      id: created.body.community.id,
      pitch: "Still a place for mania players.",
      tags: [],
    }, JSON_HEADERS));
    expect(updated.body.community.tags).toEqual([]);
  });
});

describe("invite preview", () => {
  function preview(body: Record<string, unknown>) {
    return call(bodyReq("POST", "/api/communities/preview", body, JSON_HEADERS));
  }

  it("reports the server an invite points at without writing anything", async () => {
    guildMembers.code1 = 1234;
    const result = await preview({ invite: "https://discord.gg/code1", guildId: "guild-1" });
    expect(result.body.ok).toBe(true);
    expect(result.body.invite.name).toBe("Server code1");
    expect(result.body.invite.memberCount).toBe(1234);
    expect(result.body.invite.inviteUrl).toBe("https://discord.gg/code1");
    // Nothing was stored by looking.
    expect((await call(mockReq("GET", `/api/communities/mine?viewerUserId=${OWNER}`, ADMIN))).body.communities)
      .toHaveLength(0);
  });

  it("says why a link cannot be used, before anything is filled in", async () => {
    guildForCode.other = "guild-other";
    const mismatch = await preview({ invite: "other", guildId: "guild-1" });
    expect(mismatch.body).toEqual({ ok: false, error: "guild_mismatch" });

    await submit();
    const taken = await preview({ invite: "code1", guildId: "guild-1" });
    expect(taken.body).toEqual({ ok: false, error: "already_listed" });
  });

  it("lets the listing being edited match itself", async () => {
    const created = await submit();
    const result = await preview({ invite: "code1", guildId: "guild-1", id: created.body.community.id });
    expect(result.body.ok).toBe(true);
  });

  it("finds the invite a server publishes through its own widget", async () => {
    // Discord gives an OAuth app no way to create an invite, so a widget that
    // is already publishing one is the only case the form can fill in itself.
    guildForCode.widgetcode = "guild-1";
    widgetInvites["guild-1"] = "https://discord.gg/widgetcode";
    const result = await preview({ invite: "", guildId: "guild-1" });
    expect(result.body.ok).toBe(true);
    expect(result.body.invite.inviteUrl).toBe("https://discord.gg/widgetcode");
  });

  it("says so plainly when there is no invite to find", async () => {
    const result = await preview({ invite: "", guildId: "guild-1" });
    expect(result.body).toEqual({ ok: false, error: "no_auto_invite" });
  });

  it("still checks a widget invite like any other", async () => {
    // A widget invite for the wrong guild is refused the same way a pasted one
    // would be; nothing found this way skips the checks.
    guildForCode.wrongcode = "guild-elsewhere";
    widgetInvites["guild-1"] = "https://discord.gg/wrongcode";
    const result = await preview({ invite: "", guildId: "guild-1" });
    expect(result.body).toEqual({ ok: false, error: "guild_mismatch" });
  });

  it("lets an expiring invite through, saying when it lapses", async () => {
    inviteExpiries.code1 = "2030-01-01T00:00:00.000Z";
    const result = await preview({ invite: "code1", guildId: "guild-1" });
    expect(result.body.ok).toBe(true);
    expect(result.body.invite.expiresAt).toBe("2030-01-01T00:00:00.000Z");

    // And it is remembered on the listing, so the owner and the review page can
    // see it coming instead of only learning when the sweep hides it.
    const created = await submit();
    expect(created.body.community.inviteExpiresAt).toBe("2030-01-01T00:00:00.000Z");
  });

  it("is closed to anyone without the token", async () => {
    const result = await call(bodyReq("POST", "/api/communities/preview", { invite: "code1" }, {
      "content-type": "application/json",
    }));
    expect(result.status).toBe(401);
  });
});

describe("invite health", () => {
  it("drops a listing off the directory once its invite has failed enough times", async () => {
    const { refreshCommunityInvites } = await import("../src/communities/refresh.js");
    const created = await submit();
    await approve(created.body.community.id);
    expect((await list()).body.total).toBe(1);

    // Discord now says the invite is gone.
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      status: 404,
      json: async () => ({ message: "Unknown Invite" }),
      clone: () => ({ json: async () => ({}) }),
      headers: new Headers(),
    })));

    const config = { communityRefreshIntervalMs: 60_000, communityInviteFailLimit: 3, communityRefreshBatchSize: 50 };
    await refreshCommunityInvites(db, config, { force: true });
    expect((await list()).body.total).toBe(1);
    await refreshCommunityInvites(db, config, { force: true });
    expect((await list()).body.total).toBe(1);
    await refreshCommunityInvites(db, config, { force: true });
    // Third strike: off the directory, but still the owner's to fix.
    expect((await list()).body.total).toBe(0);

    const mine = await call(mockReq("GET", `/api/communities/mine?viewerUserId=${OWNER}`, ADMIN));
    expect(mine.body.communities[0].inviteOk).toBe(false);
  });

  it("does not count our own side failing against the listing", async () => {
    const { refreshCommunityInvites } = await import("../src/communities/refresh.js");
    const created = await submit();
    await approve(created.body.community.id);

    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
      clone: () => ({ json: async () => ({}) }),
      headers: new Headers(),
    })));

    const config = { communityRefreshIntervalMs: 60_000, communityInviteFailLimit: 1, communityRefreshBatchSize: 50 };
    await refreshCommunityInvites(db, config, { force: true });
    // A failLimit of 1 would have hidden it immediately if a 500 counted.
    expect((await list()).body.total).toBe(1);
  });

  it("refreshes the member count from Discord", async () => {
    const { refreshCommunityInvites } = await import("../src/communities/refresh.js");
    guildMembers.code1 = 100;
    const created = await submit();
    await approve(created.body.community.id);
    expect((await list()).body.communities[0].memberCount).toBe(100);

    guildMembers.code1 = 4321;
    stubDiscord();
    await refreshCommunityInvites(db, {
      communityRefreshIntervalMs: 60_000,
      communityInviteFailLimit: 3,
      communityRefreshBatchSize: 50,
    }, { force: true });
    expect((await list()).body.communities[0].memberCount).toBe(4321);
  });
});
