import { createServerFn } from "@tanstack/react-start";

import { adminAuthHeaders } from "./live-backend-tokens";
import { getServerLiveBackendUrl } from "./live-backend";

/* Aggregate usage of the Companella app for /companella/usage: Companella's
   own client id only, never Mania Bridge, and no player is named. Open to the
   site admins and to Companella's developer, on any host, and to whoever holds
   the usage API key (handleCompanellaUsageApi). */

// osu! user ids outside the admin list who may read the usage page.
const COMPANELLA_USAGE_VIEWER_IDS = [13554099];

export const COMPANELLA_USAGE_WINDOWS = [7, 30, 90] as const;
export type CompanellaUsageWindow = (typeof COMPANELLA_USAGE_WINDOWS)[number];

export interface CompanellaUsageDay {
  date: string;
  received: number;
  accepted: number;
  players: number;
  newConnections: number;
}

export interface CompanellaUsage {
  days: CompanellaUsageWindow;
  since: string;
  generatedAt: string;
  allTime: { players: number; connections: number; activeConnections: number; acceptedPlays: number };
  window: {
    players: number;
    newPlayers: number;
    newConnections: number;
    revokedConnections: number;
    received: number;
    accepted: number;
    rejected: number;
    inProgress: number;
    held: number;
  };
  daily: CompanellaUsageDay[];
  versions: Array<{ version: string; received: number; accepted: number; players: number; lastSeenAt: string }>;
  gameClients: Array<{ gameClient: string; received: number; accepted: number }>;
  outcomes: Array<{ state: string; errorCode: string | null; count: number }>;
  processing: { count: number; p50Seconds: number | null; p95Seconds: number | null };
}

async function viewerMayReadUsage(): Promise<boolean> {
  const { isAdminOsuUserId, readCurrentAuth } = await import("./auth-server");
  const auth = await readCurrentAuth();
  if (auth.canUseAdminFeatures) return true;
  const id = auth.viewer?.id;
  return id != null && (isAdminOsuUserId(id) || COMPANELLA_USAGE_VIEWER_IDS.includes(id));
}

function parseWindow(value: unknown): CompanellaUsageWindow {
  const days = Number(value);
  return (COMPANELLA_USAGE_WINDOWS as readonly number[]).includes(days) ? days as CompanellaUsageWindow : 30;
}

async function readUsageFromBackend(days: CompanellaUsageWindow): Promise<CompanellaUsage> {
  const base = getServerLiveBackendUrl();
  if (!base) throw new Error("LIVE_BACKEND_URL is not configured.");
  const response = await fetch(`${base}/api/admin/companella/usage?days=${days}`, {
    headers: { ...adminAuthHeaders(false), connection: "close" },
  });
  if (!response.ok) throw new Error(`Server ${response.status} for /api/admin/companella/usage`);
  return response.json() as Promise<CompanellaUsage>;
}

/* null when the viewer may not read it, so the route can answer 404. */
export const fetchCompanellaUsage = createServerFn({ method: "GET" })
  .validator((data: { days?: number } | undefined) => ({ days: parseWindow(data?.days) }))
  .handler(async ({ data }): Promise<CompanellaUsage | null> => {
    if (!(await viewerMayReadUsage())) return null;
    return readUsageFromBackend(data.days);
  });

export interface CompanellaUsagePlayer {
  userId: number;
  username: string;
  avatarUrl: string | null;
  connectedAt: string;
  lastPlayAt: string | null;
  plays: number;
  connected: boolean;
}

export interface CompanellaUsagePlayers {
  players: CompanellaUsagePlayer[];
  /* UTC date -> ids of the players who sent plays that day, most plays first. */
  daily: Record<string, number[]>;
}

/* Who connected Companella, for the page only: the keyed JSON stays numbers. */
export const fetchCompanellaUsagePlayers = createServerFn({ method: "GET" })
  .validator((data: { days?: number } | undefined) => ({ days: parseWindow(data?.days) }))
  .handler(async ({ data }): Promise<CompanellaUsagePlayers | null> => {
    if (!(await viewerMayReadUsage())) return null;
    const base = getServerLiveBackendUrl();
    if (!base) throw new Error("LIVE_BACKEND_URL is not configured.");
    const response = await fetch(`${base}/api/admin/companella/usage/players?days=${data.days}`, {
      headers: { ...adminAuthHeaders(false), connection: "close" },
    });
    if (!response.ok) throw new Error(`Server ${response.status} for /api/admin/companella/usage/players`);
    return response.json() as Promise<CompanellaUsagePlayers>;
  });

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

/* Compares digests so the time taken says nothing about the key. */
async function keyMatches(given: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(given), sha256(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store" },
  });
}

// The keyed endpoint answers from a copy at most a minute old, and takes 30
// requests a minute per frontend instance; past that it answers 429.
const API_CACHE_MS = 60_000;
const API_LIMIT_PER_MINUTE = 30;
const apiCache = new Map<CompanellaUsageWindow, { at: number; body: CompanellaUsage }>();
let apiWindow = { start: 0, count: 0 };

function takeApiRequest(now: number): number | null {
  if (now - apiWindow.start >= 60_000) apiWindow = { start: now, count: 0 };
  apiWindow.count += 1;
  return apiWindow.count > API_LIMIT_PER_MINUTE ? Math.ceil((apiWindow.start + 60_000 - now) / 1000) : null;
}

/* GET /api/companella/usage?days=7|30|90 for Companella's developer, with
   `Authorization: Bearer <COMPANELLA_USAGE_API_KEY>`. The same JSON the page
   draws, without the players. Off (404) while the key is unset. */
export async function handleCompanellaUsageApi(request: Request): Promise<Response> {
  const expected = process.env.COMPANELLA_USAGE_API_KEY?.trim();
  if (!expected) return jsonResponse(404, { error: "not_found" });
  const given = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "")?.[1]?.trim() ?? "";
  if (!given || !(await keyMatches(given, expected))) return jsonResponse(401, { error: "unauthorized" });
  const now = Date.now();
  const retryAfter = takeApiRequest(now);
  if (retryAfter != null) {
    const limited = jsonResponse(429, { error: "rate_limited", retry_after_seconds: retryAfter });
    limited.headers.set("retry-after", String(retryAfter));
    return limited;
  }
  const days = parseWindow(new URL(request.url).searchParams.get("days"));
  const cached = apiCache.get(days);
  if (cached && now - cached.at < API_CACHE_MS) return jsonResponse(200, cached.body);
  try {
    const body = await readUsageFromBackend(days);
    apiCache.set(days, { at: now, body });
    return jsonResponse(200, body);
  } catch {
    return jsonResponse(502, { error: "usage_unavailable" });
  }
}
