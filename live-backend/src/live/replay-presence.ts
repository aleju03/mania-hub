import type { IncomingMessage, ServerResponse } from "node:http";
import { sendRateLimited, type HttpContext } from "../http/snapshots.js";

// Anonymous "who else is watching this replay" presence for the replay
// viewer's ingame-style spectator counter. Pure in-memory refcounts keyed by
// the replay's identity (like CountryClientTracker): one SSE connection per
// open viewer, count broadcasts on every join/leave, no names or ids ever
// stored or sent. Serving-process only, so a single process sees every
// watcher. `observe=1` connections (the site admin watching their own site)
// receive counts without ever being counted.

const REPLAY_PRESENCE_KEY_PATTERN = /^(score|upload):[A-Za-z0-9_-]{1,64}$/;
const MAX_TRACKED_KEYS = 2000;
const MAX_CONNECTIONS_PER_KEY = 256;
const HEARTBEAT_INTERVAL_MS = 25_000;

interface PresenceEntry {
  watchers: Set<ServerResponse>;
  observers: Set<ServerResponse>;
}

const entriesByKey = new Map<string, PresenceEntry>();

function countEventPayload(count: number): string {
  return `event: count\ndata: ${JSON.stringify({ count })}\n\n`;
}

function broadcastCount(key: string): void {
  const entry = entriesByKey.get(key);
  if (!entry) return;
  const payload = countEventPayload(entry.watchers.size);
  for (const connection of [...entry.watchers, ...entry.observers]) {
    try {
      connection.write(payload);
    } catch {
      // A torn-down socket drops out via its own close handler.
    }
  }
}

export function getReplayPresenceWatcherCount(key: string): number {
  return entriesByKey.get(key)?.watchers.size ?? 0;
}

export function resetReplayPresenceForTests(): void {
  entriesByKey.clear();
}

export function handleReplayPresence(req: IncomingMessage, res: ServerResponse, ctx: HttpContext): boolean {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (url.pathname !== "/api/replay/presence") return false;

  const origin = req.headers.origin;
  if (origin && !ctx.config.allowedOrigins.includes(origin)) {
    res.statusCode = 403;
    res.end("forbidden");
    return true;
  }
  if (origin) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("vary", "origin");
  }

  const key = url.searchParams.get("key") ?? "";
  if (!REPLAY_PRESENCE_KEY_PATTERN.test(key)) {
    res.statusCode = 400;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "invalid_key" }));
    return true;
  }
  const observeOnly = url.searchParams.get("observe") === "1";

  const opened = ctx.abuse?.openSse(req, ctx.config);
  if (opened && !opened.allowed) {
    sendRateLimited(req, res, ctx, opened);
    return true;
  }
  const releaseSse = opened?.allowed ? opened.release : null;

  let entry = entriesByKey.get(key);
  const atCapacity = entry
    ? entry.watchers.size + entry.observers.size >= MAX_CONNECTIONS_PER_KEY
    : entriesByKey.size >= MAX_TRACKED_KEYS;
  if (atCapacity) {
    releaseSse?.();
    res.statusCode = 503;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "presence_capacity" }));
    return true;
  }
  if (!entry) {
    entry = { watchers: new Set(), observers: new Set() };
    entriesByKey.set(key, entry);
  }

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  if (observeOnly) {
    entry.observers.add(res);
    // Joining changed nothing for anyone else; just seed this observer.
    try {
      res.write(countEventPayload(entry.watchers.size));
    } catch {
      // Close handler cleans up.
    }
  } else {
    entry.watchers.add(res);
    broadcastCount(key);
  }

  const heartbeat = setInterval(() => {
    try {
      res.write(`event: heartbeat\ndata: {"t":${Date.now()}}\n\n`);
    } catch {
      // Close handler cleans up.
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  req.on("close", () => {
    clearInterval(heartbeat);
    const current = entriesByKey.get(key);
    if (current) {
      const wasWatcher = current.watchers.delete(res);
      current.observers.delete(res);
      if (current.watchers.size === 0 && current.observers.size === 0) {
        entriesByKey.delete(key);
      } else if (wasWatcher) {
        broadcastCount(key);
      }
    }
    releaseSse?.();
  });
  return true;
}
