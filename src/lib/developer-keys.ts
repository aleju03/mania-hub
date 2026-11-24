import { createServerFn } from "@tanstack/react-start";
import { liveBridgeToken } from "./live-backend-tokens";

/* Mania Tracker API keys for the signed-in player (/developers).

   Server functions like the wishlist's: the viewer always comes from the osu!
   login cookie, never from client input, so a player only ever lists, makes or
   revokes their own keys. The backend route is bridge-token gated and that
   token only exists server-side. The full key comes back from create and from
   reveal, which the page calls when the owner asks to see or copy a key. */

export interface DeveloperKey {
  id: number;
  label: string;
  prefix: string;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

export interface DeveloperKeys {
  keys: DeveloperKey[];
  maxActiveKeys: number;
  ratePerMinute: number;
}

export type DeveloperKeyMutation =
  | { status: "ok"; state: DeveloperKeys; key?: string }
  | { status: "refused"; reason: "key_limit" | "not_found" };

export type DeveloperKeyReveal =
  | { status: "ok"; key: string }
  | { status: "refused"; reason: "not_found" | "not_revealable" };

async function getTarget(): Promise<{ url: string; headers: HeadersInit } | null> {
  const { readCurrentAuth } = await import("./auth-server");
  const auth = await readCurrentAuth();
  if (!auth.viewer) return null;
  const base = process.env.LIVE_BACKEND_URL?.trim().replace(/\/$/, "");
  if (!base) return null;
  const headers: HeadersInit = { "content-type": "application/json" };
  const bridgeToken = liveBridgeToken();
  if (bridgeToken) headers.authorization = `Bearer ${bridgeToken}`;
  return { url: `${base}/api/developer-keys/${auth.viewer.id}`, headers };
}

function parseState(value: unknown): DeveloperKeys {
  const body = (value ?? {}) as { keys?: unknown; maxActiveKeys?: unknown; ratePerMinute?: unknown };
  const keys = (Array.isArray(body.keys) ? body.keys : [])
    .map((raw) => raw as Partial<DeveloperKey>)
    .filter((raw): raw is DeveloperKey => Math.floor(Number(raw?.id) || 0) > 0 && typeof raw.prefix === "string");
  return {
    keys,
    maxActiveKeys: Math.max(1, Math.floor(Number(body.maxActiveKeys) || 2)),
    ratePerMinute: Math.max(1, Math.floor(Number(body.ratePerMinute) || 60)),
  };
}

async function noStore() {
  const { setResponseHeader } = await import("@tanstack/react-start/server");
  setResponseHeader("Cache-Control", "private, no-store");
}

/* Null when signed out server-side or with no backend configured. */
export const fetchOwnDeveloperKeys = createServerFn({ method: "GET" }).handler(
  async (): Promise<DeveloperKeys | null> => {
    await noStore();
    const target = await getTarget();
    if (!target) return null;
    const response = await fetch(target.url, { headers: target.headers });
    if (!response.ok) throw new Error(`Key list failed (${response.status}).`);
    return parseState(await response.json());
  },
);

export const mutateOwnDeveloperKeys = createServerFn({ method: "POST" })
  .validator((input: { action?: unknown; label?: unknown; id?: unknown }) => {
    if (input?.action === "create") {
      return { action: "create" as const, label: typeof input.label === "string" ? input.label.slice(0, 40) : "" };
    }
    const id = Math.floor(Number(input?.id) || 0);
    if (input?.action !== "revoke" || id <= 0) throw new Error("Invalid key change.");
    return { action: "revoke" as const, id };
  })
  .handler(async ({ data }): Promise<DeveloperKeyMutation | null> => {
    await noStore();
    const target = await getTarget();
    if (!target) return null;
    const response = await fetch(target.url, { method: "POST", headers: target.headers, body: JSON.stringify(data) });
    if (response.status === 409) return { status: "refused", reason: "key_limit" };
    if (response.status === 404) return { status: "refused", reason: "not_found" };
    if (!response.ok) throw new Error(`Key change failed (${response.status}).`);
    const body = (await response.json()) as { key?: unknown };
    return {
      status: "ok",
      state: parseState(body),
      ...(typeof body.key === "string" ? { key: body.key } : {}),
    };
  });

export const revealOwnDeveloperKey = createServerFn({ method: "POST" })
  .validator((input: { id?: unknown }) => {
    const id = Math.floor(Number(input?.id) || 0);
    if (id <= 0) throw new Error("Invalid key.");
    return { id };
  })
  .handler(async ({ data }): Promise<DeveloperKeyReveal | null> => {
    await noStore();
    const target = await getTarget();
    if (!target) return null;
    const response = await fetch(target.url, {
      method: "POST",
      headers: target.headers,
      body: JSON.stringify({ action: "reveal", id: data.id }),
    });
    if (response.status === 404) return { status: "refused", reason: "not_found" };
    if (response.status === 409) return { status: "refused", reason: "not_revealable" };
    if (!response.ok) throw new Error(`Key reveal failed (${response.status}).`);
    const body = (await response.json()) as { key?: unknown };
    if (typeof body.key !== "string") throw new Error("Key reveal failed.");
    return { status: "ok", key: body.key };
  });
