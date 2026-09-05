import { createServerFn } from "@tanstack/react-start";
import { liveBridgeToken } from "./live-backend-tokens";
import type { LivePackBinder } from "./live-backend";

/* Owner-scoped binder reads and writes. The viewer always comes from the osu!
   login cookie, never from client input, so a signed-in user only ever edits
   their own binders. Reading someone else's shelf goes through the public
   fetchLivePackShowcasedBinders instead. */

export const BINDER_MAX_PER_COLLECTOR = 12;
export const BINDER_MAX_CARDS = 10;
export const BINDER_NAME_MAX_CHARS = 24;

async function getSyncTarget(): Promise<{ url: string; headers: HeadersInit } | null> {
  const { readCurrentAuth } = await import("./auth-server");
  const auth = await readCurrentAuth();
  if (!auth.viewer) return null;
  const base = process.env.LIVE_BACKEND_URL?.trim().replace(/\/$/, "");
  if (!base) return null;
  const headers: HeadersInit = { "content-type": "application/json" };
  const bridgeToken = liveBridgeToken();
  if (bridgeToken) {
    headers.authorization = `Bearer ${bridgeToken}`;
  }
  return { url: `${base}/api/pack-collection/${auth.viewer.id}/binders`, headers };
}

/* Normalizes a wallet card key, rejecting anything that is not a player id
   with an optional ":goat", ":eternal" or ":v<n>" suffix. */
function sanitizeCardKey(value: string): string | null {
  const match = /^(\d+)(:goat|:eternal|:v\d{1,6})?$/.exec(value.trim());
  if (!match) return null;
  const userId = Math.floor(Number(match[1]));
  if (!Number.isInteger(userId) || userId <= 0) return null;
  if (!match[2]) return String(userId);
  if (match[2] === ":goat") return `${userId}:goat`;
  if (match[2] === ":eternal") return `${userId}:eternal`;
  const variant = Math.floor(Number(match[2].slice(2)));
  return variant > 0 ? `${userId}:v${variant}` : null;
}

function readBinders(body: unknown): LivePackBinder[] {
  const binders = (body as { binders?: unknown })?.binders;
  return Array.isArray(binders) ? (binders as LivePackBinder[]) : [];
}

/* Null when binders are unavailable (logged out, local wallet, or no backend
   configured), which is what the view shows its one plain sentence for. */
export const fetchOwnPackBinders = createServerFn({ method: "GET" }).handler(
  async (): Promise<LivePackBinder[] | null> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    const target = await getSyncTarget();
    if (!target) return null;
    const response = await fetch(target.url, { headers: target.headers });
    if (!response.ok) throw new Error(`Pack binders fetch failed (${response.status}).`);
    return readBinders(await response.json());
  },
);

export type PackBinderAction = "create" | "rename" | "delete" | "set_cards" | "add_card" | "add_cards" | "showcase" | "reorder";

/* Every action answers with the owner's binders as they now stand, so the
   view never has to guess what a write did. */
export const mutateOwnPackBinders = createServerFn({ method: "POST" })
  .validator((input: {
    action?: unknown;
    binderId?: unknown;
    name?: unknown;
    cardKeys?: unknown;
    cardKey?: unknown;
    showcased?: unknown;
    binderIds?: unknown;
  }) => {
    const action = String(input?.action ?? "") as PackBinderAction;
    if (!["create", "rename", "delete", "set_cards", "add_card", "add_cards", "showcase", "reorder"].includes(action)) {
      throw new Error("Invalid binder action.");
    }
    return {
      action,
      binderId: Math.max(0, Math.floor(Number(input?.binderId) || 0)),
      name: typeof input?.name === "string" ? input.name.slice(0, BINDER_NAME_MAX_CHARS * 4) : "",
      cardKey: typeof input?.cardKey === "string" ? sanitizeCardKey(input.cardKey) : null,
      cardKeys: Array.isArray(input?.cardKeys)
        ? input.cardKeys
            .slice(0, BINDER_MAX_CARDS * 4)
            .map((key) => (typeof key === "string" ? sanitizeCardKey(key) : null))
            .filter((key): key is string => key !== null)
        : [],
      showcased: input?.showcased === true,
      binderIds: Array.isArray(input?.binderIds)
        ? input.binderIds
            .slice(0, BINDER_MAX_PER_COLLECTOR * 4)
            .map((id) => Math.floor(Number(id) || 0))
            .filter((id) => id > 0)
        : [],
    };
  })
  .handler(async ({ data }): Promise<LivePackBinder[] | null> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    const target = await getSyncTarget();
    if (!target) return null;
    const response = await fetch(target.url, {
      method: "POST",
      headers: target.headers,
      body: JSON.stringify(data),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: unknown };
      throw new Error(typeof body.error === "string" ? body.error : `Pack binder write failed (${response.status}).`);
    }
    return readBinders(await response.json());
  });
