import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  getReplayPresenceWatcherCount,
  handleReplayPresence,
  replaySpectatorSignature,
  resetReplayPresenceForTests,
} from "../src/live/replay-presence.js";

const ADMIN_TOKEN = "test-admin-token";

function ctx() {
  return {
    config: {
      allowedOrigins: ["http://localhost:3000"],
      liveAdminToken: ADMIN_TOKEN,
    },
    abuse: undefined,
  } as never;
}

/** The query a viewer who turned on "show my name under spectators" sends. */
function namedQuery(userId: number, username: string, options?: { expiresAt?: number; signature?: string }): string {
  const expiresAt = options?.expiresAt ?? Date.now() + 60_000;
  const signature = options?.signature ?? replaySpectatorSignature(userId, username, expiresAt, ADMIN_TOKEN);
  return `&uid=${userId}&name=${encodeURIComponent(username)}&exp=${expiresAt}&sig=${signature}`;
}

function lastCountPayload(res: { chunks: string[] }): unknown {
  const frames = res.chunks.join("").split("event: count\ndata: ").slice(1);
  return JSON.parse(frames[frames.length - 1]!.split("\n")[0]!);
}

function fakeReq(url: string, origin?: string): IncomingMessage & EventEmitter {
  const req = new EventEmitter() as IncomingMessage & EventEmitter;
  req.url = url;
  req.headers = origin ? { host: "localhost", origin } : { host: "localhost" };
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

afterEach(() => {
  resetReplayPresenceForTests();
});

describe("replay presence", () => {
  it("ignores other paths", () => {
    const res = fakeRes();
    expect(handleReplayPresence(fakeReq("/api/live?country=CR"), res, ctx())).toBe(false);
  });

  it("rejects malformed keys", () => {
    const res = fakeRes();
    expect(handleReplayPresence(fakeReq("/api/replay/presence?key=nope"), res, ctx())).toBe(true);
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("invalid_key");
    const traversal = fakeRes();
    expect(handleReplayPresence(fakeReq("/api/replay/presence?key=score:../etc"), traversal, ctx())).toBe(true);
    expect(traversal.statusCode).toBe(400);
  });

  it("rejects disallowed origins", () => {
    const res = fakeRes();
    expect(handleReplayPresence(fakeReq("/api/replay/presence?key=score:1", "https://evil.example"), res, ctx())).toBe(true);
    expect(res.statusCode).toBe(403);
  });

  it("counts watchers per key and broadcasts joins and leaves", () => {
    const reqA = fakeReq("/api/replay/presence?key=score:123");
    const resA = fakeRes();
    expect(handleReplayPresence(reqA, resA, ctx())).toBe(true);
    expect(getReplayPresenceWatcherCount("score:123")).toBe(1);
    expect(resA.chunks.join("")).toContain('"count":1');

    const reqB = fakeReq("/api/replay/presence?key=score:123");
    const resB = fakeRes();
    handleReplayPresence(reqB, resB, ctx());
    expect(getReplayPresenceWatcherCount("score:123")).toBe(2);
    // The join is broadcast to the already-connected watcher too.
    expect(resA.chunks.join("")).toContain('"count":2');

    // A different replay does not share the counter.
    const reqOther = fakeReq("/api/replay/presence?key=upload:abc");
    handleReplayPresence(reqOther, fakeRes(), ctx());
    expect(getReplayPresenceWatcherCount("upload:abc")).toBe(1);
    expect(getReplayPresenceWatcherCount("score:123")).toBe(2);

    reqA.emit("close");
    expect(getReplayPresenceWatcherCount("score:123")).toBe(1);
    expect(resB.chunks.join("")).toContain('"count":1');
    reqB.emit("close");
    expect(getReplayPresenceWatcherCount("score:123")).toBe(0);
  });

  it("lets observers receive counts without being counted", () => {
    const observerReq = fakeReq("/api/replay/presence?key=score:9&observe=1");
    const observerRes = fakeRes();
    expect(handleReplayPresence(observerReq, observerRes, ctx())).toBe(true);
    // The observer alone never creates a spectator.
    expect(getReplayPresenceWatcherCount("score:9")).toBe(0);
    expect(observerRes.chunks.join("")).toContain('"count":0');

    const watcherReq = fakeReq("/api/replay/presence?key=score:9");
    handleReplayPresence(watcherReq, fakeRes(), ctx());
    expect(getReplayPresenceWatcherCount("score:9")).toBe(1);
    // The join is pushed to the observer too.
    expect(observerRes.chunks.join("")).toContain('"count":1');

    // Observer leaving changes nothing for watchers; watcher leaving
    // broadcasts the drop.
    observerReq.emit("close");
    expect(getReplayPresenceWatcherCount("score:9")).toBe(1);
    watcherReq.emit("close");
    expect(getReplayPresenceWatcherCount("score:9")).toBe(0);
  });

  it("stays anonymous for watchers who did not opt in", () => {
    const req = fakeReq("/api/replay/presence?key=score:55");
    const res = fakeRes();
    handleReplayPresence(req, res, ctx());
    const stream = res.chunks.join("");
    expect(stream).toMatch(/event: count/);
    expect(JSON.parse(stream.split("data: ")[1]!.split("\n")[0]!)).toEqual({ count: 1 });
  });

  it("names watchers who sent a valid ticket, and only those", () => {
    const namedReq = fakeReq(`/api/replay/presence?key=score:70${namedQuery(42, "peppy")}`);
    const namedRes = fakeRes();
    handleReplayPresence(namedReq, namedRes, ctx());
    expect(lastCountPayload(namedRes)).toEqual({ count: 1, names: ["peppy"] });

    // An anonymous watcher joins the count without joining the list.
    const anonReq = fakeReq("/api/replay/presence?key=score:70");
    handleReplayPresence(anonReq, fakeRes(), ctx());
    expect(lastCountPayload(namedRes)).toEqual({ count: 2, names: ["peppy"] });

    // Leaving takes the name back off everyone's screen.
    const watcherRes = fakeRes();
    handleReplayPresence(fakeReq("/api/replay/presence?key=score:70"), watcherRes, ctx());
    namedReq.emit("close");
    expect(lastCountPayload(watcherRes)).toEqual({ count: 2 });
  });

  it("ignores forged, expired and unsigned names", () => {
    const forged = fakeRes();
    handleReplayPresence(
      fakeReq(`/api/replay/presence?key=score:71${namedQuery(42, "peppy", { signature: "00" })}`),
      forged,
      ctx(),
    );
    expect(lastCountPayload(forged)).toEqual({ count: 1 });

    const expired = fakeRes();
    handleReplayPresence(
      fakeReq(`/api/replay/presence?key=score:72${namedQuery(42, "peppy", { expiresAt: Date.now() - 1000 })}`),
      expired,
      ctx(),
    );
    expect(lastCountPayload(expired)).toEqual({ count: 1 });

    // A name someone typed into the URL without a signature at all.
    const bare = fakeRes();
    handleReplayPresence(fakeReq("/api/replay/presence?key=score:73&uid=42&name=peppy"), bare, ctx());
    expect(lastCountPayload(bare)).toEqual({ count: 1 });

    // A signature minted against a different name does not carry over.
    const swapped = fakeRes();
    const expiresAt = Date.now() + 60_000;
    const signature = replaySpectatorSignature(42, "peppy", expiresAt, ADMIN_TOKEN);
    handleReplayPresence(
      fakeReq(`/api/replay/presence?key=score:74&uid=42&name=someone-else&exp=${expiresAt}&sig=${signature}`),
      swapped,
      ctx(),
    );
    expect(lastCountPayload(swapped)).toEqual({ count: 1 });
  });

  it("names an account once no matter how many tabs it has open", () => {
    handleReplayPresence(fakeReq(`/api/replay/presence?key=score:80${namedQuery(7, "cookiezi")}`), fakeRes(), ctx());
    const secondTab = fakeRes();
    handleReplayPresence(fakeReq(`/api/replay/presence?key=score:80${namedQuery(7, "cookiezi")}`), secondTab, ctx());
    expect(lastCountPayload(secondTab)).toEqual({ count: 2, names: ["cookiezi"] });
  });

  it("gives observers the names too", () => {
    handleReplayPresence(fakeReq(`/api/replay/presence?key=score:90${namedQuery(3, "rafis")}`), fakeRes(), ctx());
    const observerRes = fakeRes();
    handleReplayPresence(fakeReq("/api/replay/presence?key=score:90&observe=1"), observerRes, ctx());
    expect(lastCountPayload(observerRes)).toEqual({ count: 1, names: ["rafis"] });
    // An observer of their own site is never named in the room.
    expect(getReplayPresenceWatcherCount("score:90")).toBe(1);
  });
});
