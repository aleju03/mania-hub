import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GhostHub,
  ghostViewerSignature,
  handleGhost,
  matchesGhostRoute,
  normalizeGhostRoute,
  verifyGhostViewerSignature,
} from "../src/live/ghost.js";

const ADMIN_TOKEN = "test-admin-token";

function ctx(overrides: { hub?: GhostHub | null; enableGhost?: boolean } = {}) {
  const hub = overrides.hub === undefined
    ? new GhostHub({ maxClients: 20, maxClientsPerIp: 20 })
    : overrides.hub;
  return {
    hub,
    ctx: {
      config: {
        allowedOrigins: ["http://localhost:3000"],
        liveAdminToken: ADMIN_TOKEN,
        enableGhost: overrides.enableGhost ?? true,
        trustProxyHeaders: false,
      },
      ghost: hub ?? undefined,
      abuse: undefined,
    } as never,
  };
}

function fakeReq(url: string, options: { origin?: string; ip?: string } = {}): IncomingMessage & EventEmitter {
  const req = new EventEmitter() as IncomingMessage & EventEmitter;
  req.url = url;
  req.method = "GET";
  req.headers = { host: "localhost", ...(options.origin ? { origin: options.origin } : {}) };
  (req as unknown as { socket: { remoteAddress: string } }).socket = { remoteAddress: options.ip ?? "10.0.0.1" };
  return req;
}

function postReq(url: string, body: unknown, options: { token?: string } = {}): IncomingMessage {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  req.url = url;
  req.method = "POST";
  req.headers = {
    host: "localhost",
    "content-type": "application/json",
    ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
  };
  (req as unknown as { socket: { remoteAddress: string } }).socket = { remoteAddress: "10.0.0.1" };
  return req;
}

function fakeRes() {
  const chunks: string[] = [];
  const res = {
    statusCode: 200,
    headers: {} as Record<string, unknown>,
    body: "",
    chunks,
    setHeader(name: string, value: unknown) {
      this.headers[name] = value;
    },
    writeHead(statusCode: number, headers?: Record<string, unknown>) {
      this.statusCode = statusCode;
      Object.assign(this.headers, headers ?? {});
    },
    write(chunk: string) {
      chunks.push(String(chunk));
      return true;
    },
    end(chunk?: string) {
      if (chunk != null) this.body = String(chunk);
    },
  };
  return res as typeof res & ServerResponse;
}

function events(res: ReturnType<typeof fakeRes>, name: string): unknown[] {
  return res.chunks
    .join("")
    .split("\n\n")
    .filter((block) => block.startsWith(`event: ${name}`))
    // Only the first "data: " starts the payload; a later one is text inside it.
    .map((block) => JSON.parse(block.slice(block.indexOf("data: ") + 6)));
}

function connect(hubCtx: ReturnType<typeof ctx>, route: string, viewer?: { id: number; username: string }) {
  const query = new URLSearchParams({ route, vw: "1920", vh: "1080" });
  if (viewer) {
    const expiresAt = Date.now() + 60_000;
    query.set("uid", String(viewer.id));
    query.set("name", viewer.username);
    query.set("exp", String(expiresAt));
    query.set("sig", ghostViewerSignature(viewer.id, viewer.username, expiresAt, ADMIN_TOKEN));
  }
  const req = fakeReq(`/api/updates/stream?${query.toString()}`);
  const res = fakeRes();
  return { req, res, handled: handleGhost(req, res, hubCtx.ctx) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ghost route normalization", () => {
  it("lowercases, strips query and trailing slash", () => {
    expect(normalizeGhostRoute("/player/Jakads?tab=recent#top")).toBe("/player/jakads");
    expect(normalizeGhostRoute("/rankings/")).toBe("/rankings");
    expect(normalizeGhostRoute("https://mania-tracker.com/maps")).toBe("/maps");
    expect(normalizeGhostRoute("tracker")).toBe("/tracker");
    expect(normalizeGhostRoute("/")).toBe("/");
  });

  it("keeps wildcard patterns and rejects junk", () => {
    expect(normalizeGhostRoute("/player/*")).toBe("/player/*");
    expect(normalizeGhostRoute("/*")).toBe("/*");
    expect(normalizeGhostRoute("")).toBeNull();
    expect(normalizeGhostRoute("/player/<script>")).toBeNull();
    expect(normalizeGhostRoute(`/${"a".repeat(400)}`)).toBeNull();
  });

  it("matches exact routes and wildcard prefixes", () => {
    expect(matchesGhostRoute("/player/jakads", "/player/jakads")).toBe(true);
    expect(matchesGhostRoute("/player/jakads", "/player/other")).toBe(false);
    expect(matchesGhostRoute("/player/*", "/player/jakads")).toBe(true);
    expect(matchesGhostRoute("/player/*", "/player")).toBe(true);
    expect(matchesGhostRoute("/player/*", "/maps")).toBe(false);
    expect(matchesGhostRoute("/*", "/anything/deep")).toBe(true);
  });
});

describe("ghost viewer signatures", () => {
  it("accepts a fresh signature and rejects tampering", () => {
    const expiresAt = Date.now() + 60_000;
    const signature = ghostViewerSignature(7095193, "aleju03", expiresAt, ADMIN_TOKEN);
    expect(verifyGhostViewerSignature({ userId: 7095193, username: "aleju03", expiresAt, signature }, ADMIN_TOKEN)).toBe(true);
    // Claiming to be someone else with a valid signature of your own id.
    expect(verifyGhostViewerSignature({ userId: 2, username: "aleju03", expiresAt, signature }, ADMIN_TOKEN)).toBe(false);
    expect(verifyGhostViewerSignature({ userId: 7095193, username: "someone", expiresAt, signature }, ADMIN_TOKEN)).toBe(false);
    expect(verifyGhostViewerSignature({ userId: 7095193, username: "aleju03", expiresAt, signature }, "other-secret")).toBe(false);
  });

  it("rejects an expired signature and a missing secret", () => {
    const expiresAt = Date.now() - 1;
    const signature = ghostViewerSignature(1, "a", expiresAt, ADMIN_TOKEN);
    expect(verifyGhostViewerSignature({ userId: 1, username: "a", expiresAt, signature }, ADMIN_TOKEN)).toBe(false);
    expect(verifyGhostViewerSignature({ userId: 1, username: "a", expiresAt: Date.now() + 1000, signature: "x" }, "")).toBe(false);
  });
});

describe("ghost hub targeting", () => {
  it("shows the ghost only to viewers on the session route", async () => {
    const hub = ctx();
    const onRoute = connect(hub, "/player/jakads");
    const elsewhere = connect(hub, "/maps");
    await onRoute.handled;
    await elsewhere.handled;

    hub.hub!.applyControl({
      route: "/player/Jakads",
      audience: { mode: "everyone" },
      visual: { x: 0.25, y: 0.5 },
    });

    const shown = events(onRoute.res, "update");
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({ present: true, visual: { x: 0.25, y: 0.5 } });
    expect(events(elsewhere.res, "update")).toHaveLength(0);
  });

  it("targets a single signed-in viewer and hides from everyone else", async () => {
    const hub = ctx();
    const target = connect(hub, "/tracker", { id: 42, username: "target" });
    const other = connect(hub, "/tracker", { id: 43, username: "other" });
    const anon = connect(hub, "/tracker");
    await Promise.all([target.handled, other.handled, anon.handled]);

    hub.hub!.applyControl({ route: "/tracker", audience: { mode: "user", userId: 42 }, visual: { clip: "idle" } });
    expect(events(target.res, "update")).toHaveLength(1);
    expect(events(other.res, "update")).toHaveLength(0);
    expect(events(anon.res, "update")).toHaveLength(0);

    // Switching to everyone reaches the rest without a reconnect.
    hub.hub!.applyControl({ route: "/tracker", audience: { mode: "everyone" } });
    expect(events(other.res, "update")).toHaveLength(1);
    expect(events(anon.res, "update")).toHaveLength(1);

    // "none" pulls him back off every screen that was showing him.
    hub.hub!.applyControl({ route: "/tracker", audience: { mode: "none" } });
    expect(events(target.res, "update").at(-1)).toEqual({ present: false });
    expect(events(other.res, "update").at(-1)).toEqual({ present: false });
  });

  it("keeps the owner watching regardless of audience", async () => {
    const hub = ctx();
    const owner = connect(hub, "/goals", { id: 7095193, username: "aleju03" });
    await owner.handled;
    hub.hub!.applyControl({ route: "/goals", audience: { mode: "none" }, ownerUserId: 7095193 });
    expect(events(owner.res, "update")).toMatchObject([{ present: true }]);
  });

  it("cannot be seen by a viewer whose identity is unsigned", async () => {
    const hub = ctx();
    const spoofed = fakeReq("/api/updates/stream?route=/tracker&uid=42&name=target&exp=99999999999999&sig=deadbeef");
    const res = fakeRes();
    await handleGhost(spoofed, res, hub.ctx);
    hub.hub!.applyControl({ route: "/tracker", audience: { mode: "user", userId: 42 } });
    expect(events(res, "update")).toHaveLength(0);
    expect(events(res, "hello")).toMatchObject([{ verified: false }]);
  });

  it("seeds a viewer who arrives after the session started", async () => {
    const hub = ctx();
    hub.hub!.applyControl({ route: "/maps", audience: { mode: "everyone" }, visual: { x: 0.1, y: 0.2 } });
    const late = connect(hub, "/maps");
    await late.handled;
    expect(events(late.res, "update")).toMatchObject([{ present: true, visual: { x: 0.1, y: 0.2 } }]);
  });

  it("prefers an exact session over a wildcard and falls back when it ends", async () => {
    const hub = ctx();
    const viewer = connect(hub, "/player/jakads");
    await viewer.handled;
    hub.hub!.applyControl({ route: "/*", audience: { mode: "everyone" }, visual: { clip: "sleep" } });
    hub.hub!.applyControl({ route: "/player/jakads", audience: { mode: "everyone" }, visual: { clip: "heal" } });
    expect((events(viewer.res, "update").at(-1) as { visual: { clip: string } }).visual.clip).toBe("heal");

    hub.hub!.endSession("/player/jakads");
    expect((events(viewer.res, "update").at(-1) as { visual: { clip: string } }).visual.clip).toBe("sleep");
  });

  it("ends every session at once and pulls him off every screen", async () => {
    const hub = ctx();
    const onMaps = connect(hub, "/maps");
    const onTracker = connect(hub, "/tracker");
    await Promise.all([onMaps.handled, onTracker.handled]);
    hub.hub!.applyControl({ route: "/maps", audience: { mode: "everyone" } });
    hub.hub!.applyControl({ route: "/tracker", audience: { mode: "everyone" } });
    expect(events(onMaps.res, "update")).toHaveLength(1);
    expect(events(onTracker.res, "update")).toHaveLength(1);

    expect(hub.hub!.endAllSessions()).toBe(2);
    expect(events(onMaps.res, "update").at(-1)).toEqual({ present: false });
    expect(events(onTracker.res, "update").at(-1)).toEqual({ present: false });
    expect(hub.hub!.listSessions()).toEqual([]);
    expect(hub.hub!.endAllSessions()).toBe(0);
  });

  it("expires an idle session on its own, with no further traffic", async () => {
    vi.useFakeTimers();
    const hub = ctx();
    const viewer = connect(hub, "/maps");
    await viewer.handled;
    hub.hub!.applyControl({ route: "/maps", audience: { mode: "everyone" } });
    expect(events(viewer.res, "update")).toHaveLength(1);

    /* The panel is gone: no more control ticks, no presence polls. The hub's
       own sweep is the only thing left to notice the session went idle. */
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    expect(events(viewer.res, "update").at(-1)).toEqual({ present: false });
    expect(hub.hub!.listSessions()).toEqual([]);
  });

  it("drops a session that stopped receiving control traffic", async () => {
    const hub = ctx();
    const viewer = connect(hub, "/snipes");
    await viewer.handled;
    hub.hub!.applyControl({ route: "/snipes", audience: { mode: "everyone" } });
    expect(events(viewer.res, "update")).toHaveLength(1);

    // A later tick on another route runs the sweep; the stale one is gone.
    hub.hub!.applyControl({ route: "/maps", audience: { mode: "none" } }, Date.now() + 20 * 60_000);
    expect(events(viewer.res, "update").at(-1)).toEqual({ present: false });
    expect(hub.hub!.listSessions(Date.now() + 20 * 60_000).map((s) => s.route)).toEqual(["/maps"]);
  });

  it("clamps and sanitizes what a control tick can set", () => {
    const hub = ctx();
    const session = hub.hub!.applyControl({
      route: "/tracker",
      visual: {
        x: 9,
        y: -3,
        scale: 99,
        character: "x".repeat(80),
        speech: { id: 1, text: `  hey   there  ${"!".repeat(400)}` },
        facing: "sideways" as never,
      },
    });
    expect(session!.visual.x).toBe(1);
    expect(session!.visual.y).toBe(0);
    // The ceiling covers the smallest character on the roster: the scale is in
    // raw sprite pixels, so a 19px dog needs a bigger number than Ralsei to
    // stand the same height. src/lib/ghost-shared.ts holds the per-character
    // ranges and a test there keeps them under this.
    expect(session!.visual.scale).toBe(12);
    expect(session!.visual.facing).toBe("down");
    // Which character is opaque here, but it is still a bounded string: the
    // overlay resolves an id it does not know to its default.
    expect(session!.visual.character).toHaveLength(32);
    expect(session!.visual.speech!.text.length).toBeLessThanOrEqual(240);
    expect(session!.visual.speech!.text.startsWith("hey there !")).toBe(true);
  });

  it("carries the character through to whoever is watching", async () => {
    const hub = ctx();
    const viewer = connect(hub, "/tracker");
    await viewer.handled;
    // Unset on the first tick: a session starts on the default rather than on
    // nothing, so an old panel that never sends one still draws somebody.
    hub.hub!.applyControl({ route: "/tracker", audience: { mode: "everyone" } });
    expect(events(viewer.res, "update").at(-1)).toMatchObject({ visual: { character: "ralsei" } });

    hub.hub!.applyControl({ route: "/tracker", visual: { character: "dog" } });
    expect(events(viewer.res, "update").at(-1)).toMatchObject({ visual: { character: "dog" } });
    // A tick that says nothing about the character leaves it alone.
    hub.hub!.applyControl({ route: "/tracker", visual: { x: 0.2 } });
    expect(events(viewer.res, "update").at(-1)).toMatchObject({ visual: { character: "dog", x: 0.2 } });
  });

  it("treats a user audience with no id as nobody", () => {
    const hub = ctx();
    const session = hub.hub!.applyControl({ route: "/maps", audience: { mode: "user" } });
    expect(session!.audience).toEqual({ mode: "none" });
  });
});

describe("ghost replies", () => {
  it("only accepts a reply from a connection that is being shown the ghost", async () => {
    const hub = ctx();
    const viewer = connect(hub, "/maps", { id: 5, username: "chatty" });
    await viewer.handled;
    const id = (events(viewer.res, "hello")[0] as { id: string }).id;

    // He has not appeared yet, so there is nobody to talk to.
    expect(hub.hub!.say(id, "hello?")).toEqual({ ok: false, error: "not_listening" });

    hub.hub!.applyControl({ route: "/maps", audience: { mode: "everyone" } });
    expect(hub.hub!.say(id, "  hi   there  ")).toEqual({ ok: true });
    // A stranger guessing at ids gets nothing.
    expect(hub.hub!.say("not-a-connection", "hi")).toEqual({ ok: false, error: "not_listening" });
    expect(hub.hub!.say(id, "   ")).toEqual({ ok: false, error: "empty" });
  });

  it("pushes replies to the owner's inbox with the sender's verified name", async () => {
    const hub = ctx();
    const viewer = connect(hub, "/tracker", { id: 7, username: "target" });
    await viewer.handled;
    const id = (events(viewer.res, "hello")[0] as { id: string }).id;
    hub.hub!.applyControl({ route: "/tracker", audience: { mode: "everyone" } });

    const inbox = fakeRes();
    hub.hub!.openInbox(inbox);
    hub.hub!.say(id, "hey ralsei");
    expect(events(inbox, "reply")).toMatchObject([
      { route: "/tracker", userId: 7, username: "target", text: "hey ralsei" },
    ]);
  });

  it("strips control characters and caps the length", async () => {
    const hub = ctx();
    const viewer = connect(hub, "/maps");
    await viewer.handled;
    const id = (events(viewer.res, "hello")[0] as { id: string }).id;
    hub.hub!.applyControl({ route: "/maps", audience: { mode: "everyone" } });

    const inbox = fakeRes();
    hub.hub!.openInbox(inbox);
    // Newlines would end the SSE frame early and leak into the next event.
    hub.hub!.say(id, `line one\ndata: injected\n\n${"x".repeat(400)}`);
    const [reply] = events(inbox, "reply") as Array<{ text: string; username: string | null }>;
    expect(reply.text).not.toContain("\n");
    expect(reply.text.length).toBeLessThanOrEqual(200);
    // Unsigned connections stay anonymous rather than claiming a name.
    expect(reply.username).toBeNull();
  });

  it("rate limits one connection without touching the others", async () => {
    const hub = ctx();
    const loud = connect(hub, "/maps");
    const quiet = connect(hub, "/maps");
    await loud.handled;
    await quiet.handled;
    const loudId = (events(loud.res, "hello")[0] as { id: string }).id;
    const quietId = (events(quiet.res, "hello")[0] as { id: string }).id;
    hub.hub!.applyControl({ route: "/maps", audience: { mode: "everyone" } });

    for (let i = 0; i < 6; i += 1) expect(hub.hub!.say(loudId, `spam ${i}`)).toEqual({ ok: true });
    expect(hub.hub!.say(loudId, "one more")).toEqual({ ok: false, error: "too_many" });
    expect(hub.hub!.say(quietId, "hello")).toEqual({ ok: true });
    // The window rolls: a minute later they can talk again.
    expect(hub.hub!.say(loudId, "later", Date.now() + 60_000)).toEqual({ ok: true });
  });

  it("seeds a reconnecting inbox from the buffer and stops writing once closed", async () => {
    const hub = ctx();
    const viewer = connect(hub, "/maps");
    await viewer.handled;
    const id = (events(viewer.res, "hello")[0] as { id: string }).id;
    hub.hub!.applyControl({ route: "/maps", audience: { mode: "everyone" } });
    hub.hub!.say(id, "said before the panel opened");

    const first = fakeRes();
    const close = hub.hub!.openInbox(first);
    expect(events(first, "reply")).toHaveLength(1);
    close();
    hub.hub!.say(id, "after the panel closed");
    expect(events(first, "reply")).toHaveLength(1);

    const second = fakeRes();
    hub.hub!.openInbox(second);
    expect(events(second, "reply")).toHaveLength(2);
  });

  it("refuses a reply over http without a live connection id", async () => {
    const hub = ctx();
    const res = fakeRes();
    await handleGhost(postReq("/api/updates/say", { id: "made-up", text: "hi" }), res, hub.ctx);
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("not_listening");
  });
});

describe("ghost http surface", () => {
  it("rejects a wildcard or malformed route on the viewer stream", async () => {
    const hub = ctx();
    const res = fakeRes();
    await handleGhost(fakeReq("/api/updates/stream?route=/player/*"), res, hub.ctx);
    expect(res.statusCode).toBe(400);

    const missing = fakeRes();
    await handleGhost(fakeReq("/api/updates/stream"), missing, hub.ctx);
    expect(missing.statusCode).toBe(400);
  });

  it("rejects disallowed origins and unknown paths", async () => {
    const hub = ctx();
    const res = fakeRes();
    await handleGhost(fakeReq("/api/updates/stream?route=/maps", { origin: "https://evil.example" }), res, hub.ctx);
    expect(res.statusCode).toBe(403);
    expect(await handleGhost(fakeReq("/api/live?country=CR"), fakeRes(), hub.ctx)).toBe(false);
  });

  it("caps connections per ip", async () => {
    const hub = ctx({ hub: new GhostHub({ maxClients: 10, maxClientsPerIp: 2 }) });
    for (let i = 0; i < 2; i += 1) {
      const res = fakeRes();
      await handleGhost(fakeReq("/api/updates/stream?route=/maps", { ip: "10.0.0.9" }), res, hub.ctx);
      expect(res.statusCode).toBe(200);
    }
    const rejected = fakeRes();
    await handleGhost(fakeReq("/api/updates/stream?route=/maps", { ip: "10.0.0.9" }), rejected, hub.ctx);
    expect(rejected.statusCode).toBe(503);
    // A different address still gets in.
    const other = fakeRes();
    await handleGhost(fakeReq("/api/updates/stream?route=/maps", { ip: "10.0.0.8" }), other, hub.ctx);
    expect(other.statusCode).toBe(200);
  });

  it("requires the admin token or a live ticket to control", async () => {
    const hub = ctx();
    const denied = fakeRes();
    await handleGhost(postReq("/api/updates/control", { route: "/maps" }), denied, hub.ctx);
    expect(denied.statusCode).toBe(401);

    const withToken = fakeRes();
    await handleGhost(postReq("/api/updates/control", { route: "/maps" }, { token: ADMIN_TOKEN }), withToken, hub.ctx);
    expect(withToken.statusCode).toBe(200);

    const { ticket } = hub.hub!.issueTicket();
    const withTicket = fakeRes();
    await handleGhost(postReq(`/api/updates/control?ticket=${ticket}`, { route: "/maps" }), withTicket, hub.ctx);
    expect(withTicket.statusCode).toBe(200);

    const staleTicket = fakeRes();
    await handleGhost(postReq("/api/updates/control?ticket=not-a-ticket", { route: "/maps" }), staleTicket, hub.ctx);
    expect(staleTicket.statusCode).toBe(401);
  });

  it("ends one route with a route and everything without one", async () => {
    const hub = ctx();
    hub.hub!.applyControl({ route: "/maps", audience: { mode: "everyone" } });
    hub.hub!.applyControl({ route: "/tracker", audience: { mode: "everyone" } });

    const one = fakeRes();
    await handleGhost(postReq("/api/updates/control", { op: "end", route: "/maps" }, { token: ADMIN_TOKEN }), one, hub.ctx);
    expect(JSON.parse(one.body)).toMatchObject({ ok: true, sessions: [{ route: "/tracker" }] });

    // The disconnect button: no route, so whatever is left ends too.
    const all = fakeRes();
    await handleGhost(postReq("/api/updates/control", { op: "end" }, { token: ADMIN_TOKEN }), all, hub.ctx);
    expect(JSON.parse(all.body)).toMatchObject({ ok: true, sessions: [] });
  });

  it("expires tickets", () => {
    const hub = ctx();
    const { ticket, expiresAt } = hub.hub!.issueTicket();
    expect(hub.hub!.consumeTicket(ticket)).toBe(true);
    expect(hub.hub!.consumeTicket(ticket, expiresAt + 1)).toBe(false);
    expect(hub.hub!.consumeTicket(null)).toBe(false);
  });

  it("404s every path when the feature is switched off", async () => {
    const hub = ctx({ hub: null, enableGhost: false });
    const res = fakeRes();
    expect(await handleGhost(fakeReq("/api/updates/stream?route=/maps"), res, hub.ctx)).toBe(true);
    expect(res.statusCode).toBe(404);
    expect(res.body).toContain("updates_disabled");
  });

  it("reports presence for the admin panel", async () => {
    const hub = ctx();
    const viewer = connect(hub, "/player/jakads", { id: 42, username: "target" });
    await viewer.handled;
    // No ticket, no roster.
    const res = fakeRes();
    await handleGhost(fakeReq("/api/updates/presence"), res, hub.ctx);
    expect(res.statusCode).toBe(401);

    const { ticket } = hub.hub!.issueTicket();
    const ok = fakeRes();
    await handleGhost(fakeReq(`/api/updates/presence?ticket=${ticket}`), ok, hub.ctx);
    expect(ok.statusCode).toBe(200);
    const body = JSON.parse(ok.body) as { viewers: Array<{ username: string | null; route: string }> };
    expect(body.viewers).toMatchObject([{ username: "target", route: "/player/jakads" }]);
  });

  it("counts every viewer but only names the ones that can be aimed at", async () => {
    const hub = ctx();
    await connect(hub, "/maps", { id: 1, username: "signed" }).handled;
    await connect(hub, "/maps").handled;
    await connect(hub, "/maps").handled;
    await connect(hub, "/tracker").handled;

    const presence = hub.hub!.listPresence();
    expect(presence.totals).toMatchObject({ viewers: 4, named: 1, routes: 2 });
    // Anonymous connections are a number, not a row: a busy page would
    // otherwise ship hundreds of entries nothing can target.
    expect(presence.viewers).toHaveLength(1);
    expect(presence.viewers[0]).toMatchObject({ username: "signed", route: "/maps" });
    // Busiest page first, with the screen size the panel stages against.
    expect(presence.routes[0]).toMatchObject({ route: "/maps", viewers: 3, named: 1, showing: 0 });
    expect(presence.routes[0].viewport).toEqual({ w: 1920, h: 1080 });
    expect(presence.routes[1]).toMatchObject({ route: "/tracker", viewers: 1, named: 0 });
    expect(presence.truncated).toBe(false);
  });

  it("counts who is currently being shown the ghost per page", async () => {
    const hub = ctx();
    await connect(hub, "/maps", { id: 1, username: "a" }).handled;
    await connect(hub, "/maps").handled;
    hub.hub!.applyControl({ route: "/maps", audience: { mode: "user", userId: 1 } });
    expect(hub.hub!.listPresence().routes[0]).toMatchObject({ viewers: 2, showing: 1 });

    hub.hub!.applyControl({ route: "/maps", audience: { mode: "everyone" } });
    expect(hub.hub!.listPresence().totals.showing).toBe(2);
  });
});
