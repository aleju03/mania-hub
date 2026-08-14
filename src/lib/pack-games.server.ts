import { setResponseHeader } from "@tanstack/react-start/server";
import { readCurrentAuth } from "./auth-server";
import type { PackGameAllowance } from "./pack-games";
import { liveBridgeToken } from "./live-backend-tokens";

// The server half of the arcade's till. Only ever reached from inside a
// createServerFn handler body (those are compiled out of the client bundle),
// which is what keeps @tanstack/react-start/server off the client graph.

async function gameTarget(): Promise<
  { base: string; headers: HeadersInit; userId: number; username: string } | null
> {
  const auth = await readCurrentAuth();
  if (!auth.viewer) return null;
  const base = process.env.LIVE_BACKEND_URL?.trim().replace(/\/$/, "");
  if (!base) return null;
  const headers: HeadersInit = { "content-type": "application/json" };
  const bridgeToken = liveBridgeToken();
  if (bridgeToken) headers.authorization = `Bearer ${bridgeToken}`;
  return { base, headers, userId: auth.viewer.id, username: auth.viewer.username };
}

/* One place that knows the arcade's server-to-server convention: the admin
   token plus the viewer the osu! cookie proved, never an id off the request
   body. Everything the arcade posts goes through here. */
export async function postPackGame<T>(path: string, body: Record<string, unknown>): Promise<T | null> {
  setResponseHeader("Cache-Control", "private, no-store");
  const target = await gameTarget();
  if (!target) return null;
  const response = await fetch(`${target.base}${path}`, {
    method: "POST",
    headers: target.headers,
    body: JSON.stringify({ ...body, userId: target.userId, username: target.username }),
  });
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as T | null;
}

export async function postGame(path: string, body: Record<string, unknown>): Promise<PackGameAllowance | null> {
  const payload = await postPackGame<Record<string, unknown>>(path, body);
  if (!payload) return null;
  return {
    granted: Math.max(0, Number(payload.granted) || 0),
    remainingToday: Math.max(0, Number(payload.remainingToday) || 0),
    cap: Math.max(0, Number(payload.cap) || 0),
  };
}
