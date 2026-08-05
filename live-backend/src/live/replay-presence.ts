import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { sendRateLimited, type HttpContext } from "../http/snapshots.js";

// "Who else is watching this replay" presence for the replay viewer's
// ingame-style spectator counter. Pure in-memory refcounts keyed by the
// replay's identity (like CountryClientTracker): one SSE connection per open
// viewer, a broadcast on every join/leave, nothing durable. Serving-process
// only, so a single process sees every watcher. `observe=1` connections (the
// site admin watching their own site) receive the broadcast without ever
// being counted.
//
// The count is anonymous by default and stays that way: a name only rides
// along when that viewer turned on "show my name under spectators", and only
// as a frontend-signed ticket (same scheme as the ghost overlay), so a name on
// someone else's screen cannot be a query string anyone typed.

const REPLAY_PRESENCE_KEY_PATTERN = /^(score|upload):[A-Za-z0-9_-]{1,64}$/;
const MAX_TRACKED_KEYS = 2000;
const MAX_CONNECTIONS_PER_KEY = 256;
const HEARTBEAT_INTERVAL_MS = 25_000;
const MAX_NAME_LENGTH = 32;
// The viewer draws a handful of these; the rest of the room stays a number.
const MAX_NAMES_SENT = 20;

interface PresenceWatcher {
  userId: number;
  username: string;
}

interface PresenceEntry {
  // Insertion-ordered, so the named list reads as arrival order.
  watchers: Map<ServerResponse, PresenceWatcher | null>;
  observers: Set<ServerResponse>;
}

const entriesByKey = new Map<string, PresenceEntry>();

/** Frontend-minted proof that this connection really is that osu! account,
    signed with the shared admin token which only the two servers hold. */
export function replaySpectatorSignature(
  userId: number,
  username: string,
  expiresAt: number,
  secret: string,
): string {
  return createHmac("sha256", secret).update(`spectator:${userId}:${username}:${expiresAt}`).digest("hex");
}

function verifySpectatorTicket(
  params: { userId: number; username: string; expiresAt: number; signature: string },
  secret: string | undefined,
  now = Date.now(),
): boolean {
  if (!secret || !params.signature || !params.username) return false;
  if (!Number.isSafeInteger(params.userId) || params.userId <= 0) return false;
  if (!Number.isFinite(params.expiresAt) || params.expiresAt <= now) return false;
  const provided = Buffer.from(params.signature);
  const wanted = Buffer.from(replaySpectatorSignature(params.userId, params.username, params.expiresAt, secret));
  return provided.length === wanted.length && timingSafeEqual(provided, wanted);
}

// One line per account, in arrival order: two tabs of the same person count
// twice in the room but are named once.
function namedWatchers(entry: PresenceEntry): string[] {
  const names: string[] = [];
  const seen = new Set<number>();
  for (const watcher of entry.watchers.values()) {
    if (!watcher || seen.has(watcher.userId)) continue;
    seen.add(watcher.userId);
    names.push(watcher.username);
    if (names.length >= MAX_NAMES_SENT) break;
  }
  return names;
}

// Names are left off the payload entirely when nobody opted in, so the
// anonymous room stays byte-for-byte the count it always was.
function countEventPayload(entry: PresenceEntry): string {
  const names = namedWatchers(entry);
  const payload = names.length > 0 ? { count: entry.watchers.size, names } : { count: entry.watchers.size };
  return `event: count\ndata: ${JSON.stringify(payload)}\n\n`;
}

function broadcastCount(key: string): void {
  const entry = entriesByKey.get(key);
  if (!entry) return;
  const payload = countEventPayload(entry);
  for (const connection of [...entry.watchers.keys(), ...entry.observers]) {
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
    entry = { watchers: new Map(), observers: new Set() };
    entriesByKey.set(key, entry);
  }

  // An unsigned or expired ticket is not an error: that viewer simply joins
  // anonymously, exactly like everyone who never turned the setting on.
  const userId = Number(url.searchParams.get("uid") ?? 0);
  const username = (url.searchParams.get("name") ?? "").slice(0, MAX_NAME_LENGTH);
  const expiresAt = Number(url.searchParams.get("exp") ?? 0);
  const signature = url.searchParams.get("sig") ?? "";
  const watcher: PresenceWatcher | null =
    verifySpectatorTicket({ userId, username, expiresAt, signature }, ctx.config.liveAdminToken)
      ? { userId, username }
      : null;

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  if (observeOnly) {
    entry.observers.add(res);
    // Joining changed nothing for anyone else; just seed this observer.
    try {
      res.write(countEventPayload(entry));
    } catch {
      // Close handler cleans up.
    }
  } else {
    entry.watchers.set(res, watcher);
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
