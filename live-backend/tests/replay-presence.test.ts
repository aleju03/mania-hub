import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  getReplayPresenceWatcherCount,
  handleReplayPresence,
  resetReplayPresenceForTests,
} from "../src/live/replay-presence.js";

function ctx() {
  return {
    config: {
      allowedOrigins: ["http://localhost:3000"],
    },
    abuse: undefined,
  } as never;
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

  it("never sends names, only counts", () => {
    const req = fakeReq("/api/replay/presence?key=score:55");
    const res = fakeRes();
    handleReplayPresence(req, res, ctx());
    const stream = res.chunks.join("");
    expect(stream).toMatch(/event: count/);
    expect(JSON.parse(stream.split("data: ")[1]!.split("\n")[0]!)).toEqual({ count: 1 });
  });
});
