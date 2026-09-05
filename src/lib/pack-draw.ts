import { createServerFn } from "@tanstack/react-start";
import type { CardMotif } from "./card-motif";
import { liveBridgeToken } from "./live-backend-tokens";
import type { OsuScore } from "./types";

/* The server-side pack deal. The opener always comes from the osu! login
   cookie, never from client input, and the backend rolls the dice AND takes
   the payment: pool slice, uniform odds, duplicate protection against the
   synced collection, the honorary chance, the charge or shard cost, and the
   dealt copies landing in the collection all happen where the pool and the
   wallet live. The response carries the whole open - the dealt players,
   their card snapshots, and the spent wallet - so revealing a pack no longer
   starts from ids the browser picked or a balance the browser vouched for.
   Anonymous wallets (browser-local, never synced, never logged) keep the
   client-side draw and economy in packs.ts / pack-collection.ts. */

/* One dealt slot. Honorary hits arrive as a bare id + flag: the roster's
   identity (name, avatar, peak numbers) lives in src/lib/honorary-players.ts
   and is hydrated client-side, so the card face has one source of truth.
   isNew is the server's word against the synced collection at deal time,
   which is what the reveal's NEW badge shows. */
export interface ServerPackDrawSlot {
  userId: number;
  honorary?: boolean;
  /* An Eternal card, appended by the backend as a bonus slot at the tail of
     the hand: either the opener's own, the one-time 100%-completion reward,
     or somebody else's, on the 0.0025% slot any pack rolls. Both are decided
     entirely server-side (a unique durable claim for the reward, the roster
     of existing Eternals for the pull), so neither can be provoked from the
     client. */
  eternal?: boolean;
  /* The milestone's golden card (live-backend pack-milestone.ts): the
     opener's own face at Eternal for the open that made the number. It sits
     on a variant key the tier cannot derive, which is why the slot carries
     it, along with the badge text and motif the reveal draws. */
  milestone?: boolean;
  cardKey?: string;
  customLabel?: string | null;
  motif?: CardMotif | null;
  /* Dealt by the wishlist's pity roll rather than by the ordinary draw
     (live-backend pack-wishlist.ts), so the reveal can name it. Display-only
     on this side: the slot is an ordinary card either way. */
  wished?: boolean;
  isNew?: boolean;
  username?: string;
  avatarUrl?: string;
  countryCode?: string;
  globalRank?: number | null;
  poolRank?: number;
  pp?: number;
}

/* One card snapshot from the draw response, typed to the fields the mapper
   reads; at runtime each row is the full LivePackCardSnapshot and passes
   through untouched. */
export interface ServerPackDrawCard {
  user?: {
    id?: number | null;
    username?: string;
    avatar_url?: string;
    country_code?: string;
    statistics?: { pp?: number | null; global_rank?: number | null } | null;
  } | null;
  bestScores?: OsuScore[];
}

export interface ServerWalletState {
  payload: string;
  rev: number;
}

export interface ServerPackDrawResult {
  poolTotal: number;
  players: ServerPackDrawSlot[];
  /* Card snapshots for the dealt hand. Players the backend has nothing
     stored for are simply absent; the reveal's cold path owns them. */
  cards: ServerPackDrawCard[];
  /* The wallet after the spend: the draw is the purchase, so this is the
     authoritative balance the page should adopt. */
  wallet: ServerWalletState | null;
}

/* Null when the draw cannot run as this viewer (logged out server-side or no
   backend configured); the caller falls back to the browser-local draw. A
   wallet that cannot pay comes back as a refusal carrying the true balance;
   backpressure is retried briefly before returning a busy refusal. Other
   failures throw, surfacing as the page's "couldn't deal" retry. */
export type ServerPackDrawOutcome =
  | { status: "dealt"; result: ServerPackDrawResult }
  | { status: "insufficient"; reason: "charges" | "shards"; wallet: ServerWalletState | null }
  | { status: "busy"; reason: "write_pressure" | "rate_limited" }
  | null;

function walletFrom(value: unknown): ServerWalletState | null {
  const wallet = value as { payload?: unknown; rev?: unknown } | null;
  if (!wallet || typeof wallet.payload !== "string" || !wallet.payload) return null;
  return { payload: wallet.payload, rev: Math.max(0, Math.floor(Number(wallet.rev) || 0)) };
}

export const drawServerPack = createServerFn({ method: "POST" })
  .validator((input: { packType?: unknown }) => {
    const packType =
      typeof input?.packType === "string" && /^[a-z0-9_]{1,24}$/.test(input.packType) ? input.packType : null;
    if (!packType) throw new Error("Invalid pack type.");
    return { packType };
  })
  .handler(async ({ data }): Promise<ServerPackDrawOutcome> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
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
    const { fetchPackDrawWithRetry } = await import("./pack-draw-request");
    const response = await fetchPackDrawWithRetry(`${base}/api/packs/draw`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        userId: auth.viewer.id,
        packType: data.packType,
        // This body is produced after verifying the signed osu! cookie, not
        // from browser input. It is the identity fallback for a completionist
        // the live backend has never tracked; profile snapshots still win for
        // PP/rank and fresh identity when available.
        viewerUsername: auth.viewer.username,
        viewerAvatarUrl: auth.viewer.avatarUrl,
        viewerCountryCode: auth.viewer.countryCode,
      }),
    });
    if (response.status === 429) {
      const body = await response.json().catch(() => null) as { bucket?: unknown } | null;
      return { status: "busy", reason: body?.bucket === "write_pressure" ? "write_pressure" : "rate_limited" };
    }
    if (response.status === 409) {
      const body = (await response.json().catch(() => null)) as
        | { error?: unknown; reason?: unknown; wallet?: unknown }
        | null;
      if (body?.error === "insufficient_funds") {
        return {
          status: "insufficient",
          reason: body.reason === "shards" ? "shards" : "charges",
          wallet: walletFrom(body.wallet),
        };
      }
      throw new Error("Pack draw failed (409).");
    }
    if (!response.ok) throw new Error(`Pack draw failed (${response.status}).`);
    const body = (await response.json()) as Partial<ServerPackDrawResult>;
    const players = (Array.isArray(body.players) ? body.players : [])
      .filter((slot): slot is ServerPackDrawSlot => Math.floor(Number(slot?.userId) || 0) > 0);
    if (players.length === 0) throw new Error("Pack draw dealt no players.");
    return {
      status: "dealt",
      result: {
        poolTotal: Math.max(0, Math.floor(Number(body.poolTotal) || 0)),
        players,
        cards: Array.isArray(body.cards) ? (body.cards as ServerPackDrawCard[]) : [],
        wallet: walletFrom(body.wallet),
      },
    };
  });
