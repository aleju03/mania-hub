import { createServerFn } from "@tanstack/react-start";
import { liveBridgeToken } from "./live-backend-tokens";

/* The wishlist: up to five players a collector is still missing, and the
   growing chance that the next pack reaches for one of them.

   Server functions like the wallet's, for the same reason: the viewer always
   comes from the osu! login cookie and never from client input, so a signed-in
   collector only ever edits their own list. The backend routes are
   bridge-token gated and that token only exists server-side. */

export interface PackWishlistPlayer {
  userId: number;
  username: string;
  avatarUrl: string;
  countryCode: string;
  pp: number;
  globalRank: number | null;
  /* False for a player who has since fallen off the rankings: they stay on
     the list, but no pack can deal them. */
  inPool: boolean;
}

export interface PackWishlistState {
  /* Packs that could have dealt a wished player and did not. */
  misses: number;
  hits: number;
  /* What the next pack's chance is, 0-1, already including the misses. */
  chance: number;
}

export interface PackWishlist {
  players: PackWishlistPlayer[];
  state: PackWishlistState;
}

export type PackWishlistRefusal = "wishlist_full" | "not_pullable" | "already_owned";

export type PackWishlistMutation =
  | { status: "ok"; wishlist: PackWishlist }
  | { status: "refused"; reason: PackWishlistRefusal };

async function getWishlistTarget(): Promise<{ url: string; headers: HeadersInit } | null> {
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
  return { url: `${base}/api/pack-collection/${auth.viewer.id}/wishlist`, headers };
}

function parseWishlist(value: unknown): PackWishlist {
  const body = (value ?? {}) as { players?: unknown; state?: unknown };
  const state = (body.state ?? {}) as { misses?: unknown; hits?: unknown; chance?: unknown };
  const players = (Array.isArray(body.players) ? body.players : [])
    .map((raw) => raw as Partial<PackWishlistPlayer>)
    .filter((raw): raw is PackWishlistPlayer => Math.floor(Number(raw?.userId) || 0) > 0);
  return {
    players,
    state: {
      misses: Math.max(0, Math.floor(Number(state.misses) || 0)),
      hits: Math.max(0, Math.floor(Number(state.hits) || 0)),
      chance: Math.min(1, Math.max(0, Number(state.chance) || 0)),
    },
  };
}

/* Null when the list cannot be read as this viewer (logged out server-side or
   no backend configured); the line simply does not render. */
export const fetchOwnPackWishlist = createServerFn({ method: "GET" }).handler(
  async (): Promise<PackWishlist | null> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    const target = await getWishlistTarget();
    if (!target) return null;
    const response = await fetch(target.url, { headers: target.headers });
    if (!response.ok) throw new Error(`Wishlist fetch failed (${response.status}).`);
    return parseWishlist(await response.json());
  },
);

export const mutateOwnPackWishlist = createServerFn({ method: "POST" })
  .validator((input: { action?: unknown; userId?: unknown }) => {
    const action = input?.action === "remove" ? "remove" : input?.action === "add" ? "add" : null;
    const userId = Math.floor(Number(input?.userId) || 0);
    if (!action || userId <= 0) throw new Error("Invalid wishlist change.");
    return { action, userId };
  })
  .handler(async ({ data }): Promise<PackWishlistMutation | null> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    const target = await getWishlistTarget();
    if (!target) return null;
    const response = await fetch(target.url, {
      method: "POST",
      headers: target.headers,
      body: JSON.stringify({ action: data.action, userId: data.userId }),
    });
    if (response.status === 409) {
      const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
      const reason =
        body?.error === "wishlist_full" || body?.error === "already_owned" ? body.error : "not_pullable";
      return { status: "refused", reason };
    }
    if (!response.ok) throw new Error(`Wishlist change failed (${response.status}).`);
    return { status: "ok", wishlist: parseWishlist(await response.json()) };
  });
