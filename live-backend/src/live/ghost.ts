import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { clientIp } from "../http/abuse-guard.js";
import { sendRateLimited, type HttpContext } from "../http/snapshots.js";

// The admin ghost: a sprite the site owner can drive around a visitor's screen,
// speak through, and act with. Pure in-memory and serving-process only, like
// replay presence — nothing here is durable, and a restart simply ends the
// session.
//
// Shape of it: every page open holds one SSE connection on /api/ghost/stream
// carrying its route. The owner drives a session from /admin/ghost through
// /api/ghost/control (short-lived ticket, so the browser never holds the admin
// token), and the hub fans each state tick out to the connections whose route
// matches and whose viewer is in the session's audience.
//
// Viewer identity is signed by the frontend with the shared admin token
// (mintGhostViewerSignature below is the verification side): targeting one
// person must not be spoofable by editing a query string.

const STREAM_PATH = "/api/ghost/stream";
const CONTROL_PATH = "/api/ghost/control";
const PRESENCE_PATH = "/api/ghost/presence";
const TICKET_PATH = "/api/ghost/ticket";
const SAY_PATH = "/api/ghost/say";
const INBOX_PATH = "/api/ghost/inbox";

const HEARTBEAT_INTERVAL_MS = 25_000;
const TICKET_TTL_MS = 60 * 60_000;
// A session with no control traffic is a closed tab: stop haunting the page.
const SESSION_IDLE_MS = 10 * 60_000;
const MAX_SESSIONS = 8;
const PRESENCE_MAX_ROUTES = 40;
const PRESENCE_MAX_NAMED = 120;
const MAX_REPLY_LENGTH = 200;
/* Replies live in memory only, and only until they scroll out of this buffer or
   the process restarts: talking back to the ghost is not a message anyone is
   promised delivery or a record of. */
const REPLY_BUFFER = 40;
const REPLY_WINDOW_MS = 30_000;
const REPLIES_PER_WINDOW = 6;
const MAX_ROUTE_LENGTH = 200;
const MAX_SPEECH_LENGTH = 240;
const MAX_NAME_LENGTH = 32;
const ROUTE_PATTERN = /^\/[\w\-./%]*$/;

export type GhostFacing = "down" | "up" | "left" | "right";

export interface GhostAudience {
  mode: "everyone" | "user" | "none";
  /** Only for mode "user": the osu! id allowed to see the ghost. */
  userId?: number;
}

export interface GhostVisual {
  /** Viewport-normalized so one position reads the same on every screen. */
  x: number;
  y: number;
  clip: string;
  facing: GhostFacing;
  moving: boolean;
  scale: number;
  speech: { id: number; text: string } | null;
  action: { id: number; kind: string } | null;
}

export interface GhostSessionState {
  route: string;
  audience: GhostAudience;
  visual: GhostVisual;
  seq: number;
  updatedAt: number;
  /** Always sees the ghost regardless of audience, so the owner can watch. */
  ownerUserId: number | null;
}

interface GhostClient {
  id: string;
  res: ServerResponse;
  route: string;
  userId: number | null;
  username: string | null;
  viewport: { w: number; h: number } | null;
  ip: string;
  connectedAt: number;
  /** Whether this connection is currently being shown a ghost. */
  showing: boolean;
  /** Send times inside the reply window, for the per-connection limit. */
  repliedAt: number[];
}

/** A viewer talking back to the ghost. Never stored: it goes to whoever is
    listening on the owner's inbox stream and into a small ring buffer. */
export interface GhostReply {
  id: number;
  at: number;
  route: string;
  userId: number | null;
  username: string | null;
  text: string;
}

export interface GhostPresenceViewer {
  id: string;
  route: string;
  userId: number | null;
  username: string | null;
  viewport: { w: number; h: number } | null;
  connectedAt: number;
  showing: boolean;
}

export interface GhostPresenceRoute {
  route: string;
  viewers: number;
  named: number;
  showing: number;
  /** Newest connection's screen size, which is what the panel stages against. */
  viewport: { w: number; h: number } | null;
}

/** Counts for everyone, identities only for the people who can actually be
    aimed at. On a busy day the roster would otherwise be hundreds of entries
    the panel has no use for, three seconds apart. */
export interface GhostPresence {
  routes: GhostPresenceRoute[];
  viewers: GhostPresenceViewer[];
  totals: { viewers: number; named: number; routes: number; showing: number };
  /** True when either list was cut short by the caps below. */
  truncated: boolean;
}

const DEFAULT_VISUAL: GhostVisual = {
  x: 0.5,
  y: 0.7,
  clip: "idle",
  facing: "down",
  moving: false,
  scale: 3,
  speech: null,
  action: null,
};

export class GhostHub {
  private readonly clients = new Map<string, GhostClient>();
  /* Movement ticks fan out ~15 times a second, so a broadcast must never walk
     every open page on the site to find the handful on one route. */
  private readonly clientsByRoute = new Map<string, Set<GhostClient>>();
  private readonly clientsByIp = new Map<string, number>();
  private readonly sessions = new Map<string, GhostSessionState>();
  private readonly tickets = new Map<string, number>();
  /* Open inbox streams (the owner's panel) and the short reply backlog. */
  private readonly inbox = new Set<ServerResponse>();
  private readonly replies: GhostReply[] = [];
  private replySeq = 0;

  constructor(private readonly limits: { maxClients: number; maxClientsPerIp: number }) {}

  issueTicket(now = Date.now()): { ticket: string; expiresAt: number } {
    for (const [ticket, expiresAt] of this.tickets) {
      if (expiresAt <= now) this.tickets.delete(ticket);
    }
    const ticket = randomUUID();
    const expiresAt = now + TICKET_TTL_MS;
    this.tickets.set(ticket, expiresAt);
    return { ticket, expiresAt };
  }

  consumeTicket(ticket: string | null | undefined, now = Date.now()): boolean {
    if (!ticket) return false;
    const expiresAt = this.tickets.get(ticket);
    if (expiresAt == null) return false;
    if (expiresAt <= now) {
      this.tickets.delete(ticket);
      return false;
    }
    return true;
  }

  /** False when this connection would exceed the ghost's own budget, which is
      deliberately separate from the live feed's so it can never crowd it out. */
  addClient(client: Omit<GhostClient, "showing" | "repliedAt">): boolean {
    if (this.clients.size >= this.limits.maxClients) return false;
    const perIp = this.clientsByIp.get(client.ip) ?? 0;
    if (perIp >= this.limits.maxClientsPerIp) return false;
    const tracked = { ...client, showing: false, repliedAt: [] };
    this.clients.set(client.id, tracked);
    this.clientsByIp.set(client.ip, perIp + 1);
    const onRoute = this.clientsByRoute.get(client.route) ?? new Set<GhostClient>();
    onRoute.add(tracked);
    this.clientsByRoute.set(client.route, onRoute);
    return true;
  }

  /** Seeds a client from whichever session covers its route. Called once the
      stream's headers are out, so a joining viewer never misses a live ghost. */
  syncClient(id: string): void {
    const client = this.clients.get(id);
    if (client) this.resync(client);
  }

  removeClient(id: string): void {
    const client = this.clients.get(id);
    if (!client) return;
    this.clients.delete(id);
    const onRoute = this.clientsByRoute.get(client.route);
    if (onRoute) {
      onRoute.delete(client);
      if (onRoute.size === 0) this.clientsByRoute.delete(client.route);
    }
    const remaining = (this.clientsByIp.get(client.ip) ?? 1) - 1;
    if (remaining <= 0) this.clientsByIp.delete(client.ip);
    else this.clientsByIp.set(client.ip, remaining);
  }

  /** Applies a control patch and pushes the result to everyone it applies to. */
  applyControl(patch: GhostControlPatch, now = Date.now()): GhostSessionState | null {
    this.expireSessions(now);
    const route = normalizeGhostRoute(patch.route);
    if (!route) return null;
    const existing = this.sessions.get(route);
    if (!existing && this.sessions.size >= MAX_SESSIONS) return null;

    const previous = existing ?? {
      route,
      audience: { mode: "none" } as GhostAudience,
      visual: { ...DEFAULT_VISUAL },
      seq: 0,
      updatedAt: now,
      ownerUserId: null,
    };
    const session: GhostSessionState = {
      route,
      audience: normalizeAudience(patch.audience, previous.audience),
      ownerUserId: normalizeUserId(patch.ownerUserId) ?? previous.ownerUserId,
      visual: mergeVisual(previous.visual, patch.visual),
      seq: previous.seq + 1,
      updatedAt: now,
    };
    this.sessions.set(route, session);
    this.broadcast(session);
    return session;
  }

  endSession(route: string): boolean {
    const normalized = normalizeGhostRoute(route);
    if (!normalized || !this.sessions.delete(normalized)) return false;
    this.resyncRoute(normalized);
    return true;
  }

  listSessions(now = Date.now()): GhostSessionState[] {
    this.expireSessions(now);
    return [...this.sessions.values()];
  }

  /** A viewer answering the ghost. The connection id is the capability: it is a
      random per-stream value only that browser was told, and it only counts
      while that stream is actually being shown a ghost, so nobody can talk to
      the owner from a page he never appeared on. */
  say(connectionId: unknown, rawText: unknown, now = Date.now()): { ok: true } | { ok: false; error: string } {
    const client = typeof connectionId === "string" ? this.clients.get(connectionId) : undefined;
    if (!client || !client.showing) return { ok: false, error: "not_listening" };
    const text = typeof rawText === "string"
      // Control characters would break the SSE framing this rides on.
      ? rawText.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_REPLY_LENGTH)
      : "";
    if (!text) return { ok: false, error: "empty" };

    client.repliedAt = client.repliedAt.filter((at) => now - at < REPLY_WINDOW_MS);
    if (client.repliedAt.length >= REPLIES_PER_WINDOW) return { ok: false, error: "too_many" };
    client.repliedAt.push(now);

    this.replySeq += 1;
    const reply: GhostReply = {
      id: this.replySeq,
      at: now,
      route: client.route,
      userId: client.userId,
      username: client.username,
      text,
    };
    this.replies.push(reply);
    if (this.replies.length > REPLY_BUFFER) this.replies.splice(0, this.replies.length - REPLY_BUFFER);
    for (const listener of this.inbox) write(listener, "reply", reply);
    return { ok: true };
  }

  /** Opens the owner's inbox stream, seeded with whatever is still in the
      buffer so a panel that reconnects mid-conversation is not blind. */
  openInbox(res: ServerResponse): () => void {
    this.inbox.add(res);
    for (const reply of this.replies.slice(-10)) write(res, "reply", reply);
    return () => {
      this.inbox.delete(res);
    };
  }

  listPresence(): GhostPresence {
    const routes = new Map<string, GhostPresenceRoute & { newestAt: number }>();
    const named: GhostPresenceViewer[] = [];
    let showing = 0;
    for (const client of this.clients.values()) {
      let entry = routes.get(client.route);
      if (!entry) {
        entry = { route: client.route, viewers: 0, named: 0, showing: 0, viewport: null, newestAt: -1 };
        routes.set(client.route, entry);
      }
      entry.viewers += 1;
      if (client.showing) {
        entry.showing += 1;
        showing += 1;
      }
      if (client.viewport && client.connectedAt >= entry.newestAt) {
        entry.viewport = client.viewport;
        entry.newestAt = client.connectedAt;
      }
      if (client.userId == null) continue;
      entry.named += 1;
      named.push({
        id: client.id,
        route: client.route,
        userId: client.userId,
        username: client.username,
        viewport: client.viewport,
        connectedAt: client.connectedAt,
        showing: client.showing,
      });
    }
    // Busiest pages and newest arrivals first: those are the ones worth showing
    // when the list has to stop somewhere.
    const rankedRoutes = [...routes.values()].sort((a, b) => b.viewers - a.viewers || a.route.localeCompare(b.route));
    const rankedNamed = named.sort((a, b) => b.connectedAt - a.connectedAt);
    return {
      routes: rankedRoutes.slice(0, PRESENCE_MAX_ROUTES).map(({ newestAt: _newestAt, ...route }) => route),
      viewers: rankedNamed.slice(0, PRESENCE_MAX_NAMED),
      totals: { viewers: this.clients.size, named: named.length, routes: routes.size, showing },
      truncated: rankedRoutes.length > PRESENCE_MAX_ROUTES || rankedNamed.length > PRESENCE_MAX_NAMED,
    };
  }

  private expireSessions(now: number): void {
    for (const [route, session] of this.sessions) {
      if (now - session.updatedAt <= SESSION_IDLE_MS) continue;
      this.sessions.delete(route);
      this.resyncRoute(route);
    }
  }

  /** Re-evaluates every client a just-removed session used to cover: a wildcard
      session underneath it takes over instead of the ghost simply vanishing. */
  private resyncRoute(pattern: string): void {
    for (const client of this.clientsCovering(pattern)) this.resync(client);
  }

  /** The clients a pattern can reach. An exact route is one index lookup; only
      a wildcard has to consider every open page. */
  private *clientsCovering(pattern: string): Generator<GhostClient> {
    if (!pattern.endsWith("/*")) {
      yield* this.clientsByRoute.get(pattern) ?? [];
      return;
    }
    for (const [route, clients] of this.clientsByRoute) {
      if (matchesGhostRoute(pattern, route)) yield* clients;
    }
  }

  private resync(client: GhostClient): void {
    const session = this.sessionForRoute(client.route);
    if (session && this.canSee(session, client)) this.show(client, session);
    else if (client.showing) this.hide(client);
  }

  private sessionForRoute(route: string): GhostSessionState | null {
    // An exact route wins over a wildcard covering the same page.
    const exact = this.sessions.get(route);
    if (exact) return exact;
    for (const session of this.sessions.values()) {
      if (matchesGhostRoute(session.route, route)) return session;
    }
    return null;
  }

  private canSee(session: GhostSessionState, client: GhostClient): boolean {
    if (session.ownerUserId != null && client.userId === session.ownerUserId) return true;
    if (session.audience.mode === "everyone") return true;
    if (session.audience.mode === "user") return client.userId != null && client.userId === session.audience.userId;
    return false;
  }

  private broadcast(session: GhostSessionState): void {
    for (const client of this.clientsCovering(session.route)) {
      // A more specific session on the same page wins, so a wildcard tick must
      // not overwrite what an exact one is showing.
      if (this.sessionForRoute(client.route) !== session) continue;
      this.resync(client);
    }
  }

  private show(client: GhostClient, session: GhostSessionState): void {
    client.showing = true;
    write(client.res, "ghost", { present: true, seq: session.seq, visual: session.visual });
  }

  private hide(client: GhostClient): void {
    client.showing = false;
    write(client.res, "ghost", { present: false });
  }
}

export interface GhostControlPatch {
  route: string;
  audience?: GhostAudience;
  ownerUserId?: number | null;
  visual?: Partial<GhostVisual>;
}

function mergeVisual(base: GhostVisual, patch: Partial<GhostVisual> | undefined): GhostVisual {
  if (!patch) return base;
  return {
    x: clamp01(patch.x ?? base.x),
    y: clamp01(patch.y ?? base.y),
    clip: typeof patch.clip === "string" && patch.clip ? patch.clip.slice(0, 32) : base.clip,
    facing: isFacing(patch.facing) ? patch.facing : base.facing,
    moving: typeof patch.moving === "boolean" ? patch.moving : base.moving,
    scale: Number.isFinite(patch.scale) ? Math.max(1, Math.min(8, Number(patch.scale))) : base.scale,
    speech: patch.speech === undefined ? base.speech : normalizeSpeech(patch.speech),
    action: patch.action === undefined ? base.action : normalizeAction(patch.action),
  };
}

function normalizeSpeech(value: GhostVisual["speech"]): GhostVisual["speech"] {
  if (!value || typeof value.text !== "string") return null;
  const text = value.text.replace(/\s+/g, " ").trim().slice(0, MAX_SPEECH_LENGTH);
  if (!text) return null;
  return { id: Math.floor(Number(value.id)) || 0, text };
}

function normalizeAction(value: GhostVisual["action"]): GhostVisual["action"] {
  if (!value || typeof value.kind !== "string") return null;
  const kind = value.kind.slice(0, 32);
  if (!kind) return null;
  return { id: Math.floor(Number(value.id)) || 0, kind };
}

function normalizeAudience(value: unknown, fallback: GhostAudience): GhostAudience {
  if (!value || typeof value !== "object") return fallback;
  const mode = (value as GhostAudience).mode;
  if (mode === "everyone" || mode === "none") return { mode };
  if (mode === "user") {
    const userId = normalizeUserId((value as GhostAudience).userId);
    // A "user" audience without a valid id would silently mean "everyone".
    return userId == null ? { mode: "none" } : { mode: "user", userId };
  }
  return fallback;
}

function normalizeUserId(value: unknown): number | null {
  const id = Math.floor(Number(value));
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function isFacing(value: unknown): value is GhostFacing {
  return value === "down" || value === "up" || value === "left" || value === "right";
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}

/** Lowercased pathname, no query/hash, no trailing slash. `*` suffixes are kept
    so a session can cover a whole section (`/player/*`) or the site (`/*`). */
export function normalizeGhostRoute(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  let value = raw.trim();
  if (!value) return null;
  if (value.startsWith("http://") || value.startsWith("https://")) {
    try {
      value = new URL(value).pathname;
    } catch {
      return null;
    }
  }
  value = value.split("#")[0].split("?")[0];
  if (!value.startsWith("/")) value = `/${value}`;
  value = value.toLowerCase().replace(/\/{2,}/g, "/");
  const wildcard = value.endsWith("/*");
  if (wildcard) value = value.slice(0, -2) || "/";
  if (value.length > 1 && value.endsWith("/")) value = value.slice(0, -1);
  if (value.length > MAX_ROUTE_LENGTH || !ROUTE_PATTERN.test(value)) return null;
  return wildcard ? `${value === "/" ? "" : value}/*` : value;
}

export function matchesGhostRoute(pattern: string, route: string): boolean {
  if (pattern === route) return true;
  if (!pattern.endsWith("/*")) return false;
  const prefix = pattern.slice(0, -2);
  if (prefix === "") return true;
  return route === prefix || route.startsWith(`${prefix}/`);
}

/** Frontend-minted proof that this connection really is that osu! account. The
    payload is signed with the shared admin token, which only the two servers
    hold. */
export function verifyGhostViewerSignature(
  params: { userId: number; username: string; expiresAt: number; signature: string },
  secret: string,
  now = Date.now(),
): boolean {
  if (!secret || !params.signature) return false;
  if (!Number.isFinite(params.expiresAt) || params.expiresAt <= now) return false;
  const expected = ghostViewerSignature(params.userId, params.username, params.expiresAt, secret);
  const provided = Buffer.from(params.signature);
  const wanted = Buffer.from(expected);
  return provided.length === wanted.length && timingSafeEqual(provided, wanted);
}

export function ghostViewerSignature(userId: number, username: string, expiresAt: number, secret: string): string {
  return createHmac("sha256", secret).update(`ghost:${userId}:${username}:${expiresAt}`).digest("hex");
}

function write(res: ServerResponse, event: string, payload: unknown): void {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  } catch {
    // A dead socket is cleaned up by its own close handler.
  }
}

function isGhostAdmin(req: IncomingMessage, ctx: HttpContext): boolean {
  const token = ctx.config.liveAdminToken;
  if (!token) return false;
  const header = req.headers.authorization;
  if (typeof header !== "string") return false;
  const expected = Buffer.from(`Bearer ${token}`);
  const provided = Buffer.from(header);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function applyCors(req: IncomingMessage, res: ServerResponse, ctx: HttpContext): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (!ctx.config.allowedOrigins.includes("*") && !ctx.config.allowedOrigins.includes(origin)) return false;
  res.setHeader("access-control-allow-origin", origin);
  res.setHeader("vary", "origin");
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type,authorization");
  res.setHeader("access-control-max-age", "600");
  return true;
}

function sendGhostJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
}

async function readGhostBody(req: IncomingMessage, limitBytes = 8 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > limitBytes) throw new Error("ghost_body_too_large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Routed ahead of routeHttp (like replay presence): the stream must not spend
    the page's public API budget, and control ticks run far above it. */
export async function handleGhost(req: IncomingMessage, res: ServerResponse, ctx: HttpContext): Promise<boolean> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (url.pathname !== STREAM_PATH
    && url.pathname !== CONTROL_PATH
    && url.pathname !== PRESENCE_PATH
    && url.pathname !== TICKET_PATH
    && url.pathname !== SAY_PATH
    && url.pathname !== INBOX_PATH) {
    return false;
  }
  if (!ctx.ghost || !ctx.config.enableGhost) {
    sendGhostJson(res, 404, { error: "ghost_disabled" });
    return true;
  }
  if (!applyCors(req, res, ctx)) {
    sendGhostJson(res, 403, { error: "forbidden_origin" });
    return true;
  }
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return true;
  }
  if (url.pathname === STREAM_PATH) return handleGhostStream(req, res, ctx, url);

  // A viewer answering the ghost. No auth beyond the connection id they were
  // handed on their own stream, which is unguessable and only works while they
  // are actually being shown him.
  if (url.pathname === SAY_PATH) {
    if (req.method !== "POST") {
      sendGhostJson(res, 405, { error: "method_not_allowed" });
      return true;
    }
    let body: { id?: unknown; text?: unknown };
    try {
      body = JSON.parse((await readGhostBody(req, 2 * 1024)) || "{}") as { id?: unknown; text?: unknown };
    } catch {
      sendGhostJson(res, 400, { error: "invalid_body" });
      return true;
    }
    const said = ctx.ghost.say(body.id, body.text);
    sendGhostJson(res, said.ok ? 202 : 400, said.ok ? { ok: true } : { error: said.error });
    return true;
  }

  // Minting a control ticket is the one step that needs the real token: the
  // admin page trades its server-side session for one so the browser can drive
  // the ghost directly, without the token and without a hop through Vercel.
  if (url.pathname === TICKET_PATH) {
    if (!isGhostAdmin(req, ctx)) {
      sendGhostJson(res, 401, { error: "unauthorized" });
      return true;
    }
    if (req.method !== "POST") {
      sendGhostJson(res, 405, { error: "method_not_allowed" });
      return true;
    }
    sendGhostJson(res, 200, ctx.ghost.issueTicket());
    return true;
  }

  // Control and presence accept either the admin token (server-to-server) or a
  // ticket the admin page traded its session for.
  const ticket = url.searchParams.get("ticket");
  if (!isGhostAdmin(req, ctx) && !ctx.ghost.consumeTicket(ticket)) {
    sendGhostJson(res, 401, { error: "unauthorized" });
    return true;
  }
  if (url.pathname === PRESENCE_PATH) {
    sendGhostJson(res, 200, { ...ctx.ghost.listPresence(), sessions: ctx.ghost.listSessions() });
    return true;
  }
  // What viewers say back, pushed to the panel as it arrives. EventSource
  // cannot send headers, which is why this takes the ticket in the query like
  // the analytics live feed does.
  if (url.pathname === INBOX_PATH) {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    write(res, "hello", { status: "connected" });
    const close = ctx.ghost.openInbox(res);
    const heartbeat = setInterval(() => write(res, "heartbeat", { t: Date.now() }), HEARTBEAT_INTERVAL_MS);
    heartbeat.unref();
    req.on("close", () => {
      clearInterval(heartbeat);
      close();
    });
    return true;
  }
  if (req.method !== "POST") {
    sendGhostJson(res, 405, { error: "method_not_allowed" });
    return true;
  }
  let body: Record<string, unknown>;
  try {
    body = JSON.parse((await readGhostBody(req)) || "{}") as Record<string, unknown>;
  } catch {
    sendGhostJson(res, 400, { error: "invalid_body" });
    return true;
  }
  if (body.op === "end") {
    const ended = ctx.ghost.endSession(String(body.route ?? ""));
    sendGhostJson(res, 200, { ok: ended, sessions: ctx.ghost.listSessions() });
    return true;
  }
  const session = ctx.ghost.applyControl(body as unknown as GhostControlPatch);
  if (!session) {
    sendGhostJson(res, 400, { error: "invalid_route" });
    return true;
  }
  sendGhostJson(res, 200, {
    ok: true,
    session,
    // Connecting asks for the roster in the same round trip; movement ticks do
    // not, which is why this is opt-in rather than always attached.
    presence: body.withViewers === true ? ctx.ghost.listPresence() : undefined,
  });
  return true;
}

function handleGhostStream(req: IncomingMessage, res: ServerResponse, ctx: HttpContext, url: URL): boolean {
  const hub = ctx.ghost;
  if (!hub) return false;
  const route = normalizeGhostRoute(url.searchParams.get("route"));
  if (!route || route.endsWith("/*")) {
    sendGhostJson(res, 400, { error: "invalid_route" });
    return true;
  }
  const opened = ctx.abuse?.check(req, ctx.config, "sseConnect", "ghost");
  if (opened && !opened.allowed) {
    sendRateLimited(req, res, ctx, opened);
    return true;
  }

  const userId = Number(url.searchParams.get("uid") ?? 0);
  const username = (url.searchParams.get("name") ?? "").slice(0, MAX_NAME_LENGTH);
  const expiresAt = Number(url.searchParams.get("exp") ?? 0);
  const signature = url.searchParams.get("sig") ?? "";
  const verified = Number.isSafeInteger(userId)
    && userId > 0
    && verifyGhostViewerSignature(
      { userId, username, expiresAt, signature },
      ctx.config.liveAdminToken ?? "",
    );

  const id = randomUUID();
  const added = hub.addClient({
    id,
    res,
    route,
    userId: verified ? userId : null,
    username: verified ? username : null,
    viewport: parseViewport(url.searchParams.get("vw"), url.searchParams.get("vh")),
    ip: clientIp(req, ctx.config),
    connectedAt: Date.now(),
  });
  if (!added) {
    sendGhostJson(res, 503, { error: "ghost_capacity" });
    return true;
  }

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  write(res, "hello", { id, route, verified });
  hub.syncClient(id);
  const heartbeat = setInterval(() => write(res, "heartbeat", { t: Date.now() }), HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();
  req.on("close", () => {
    clearInterval(heartbeat);
    hub.removeClient(id);
  });
  return true;
}

function parseViewport(rawW: string | null, rawH: string | null): { w: number; h: number } | null {
  const w = Math.floor(Number(rawW));
  const h = Math.floor(Number(rawH));
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0 || w > 10_000 || h > 10_000) return null;
  return { w, h };
}
