import { createServerFn } from "@tanstack/react-start";
import { requireTrueAdminAccess } from "./auth";
import { getServerLiveBackendUrl } from "./live-backend";
import { adminAuthHeaders } from "./live-backend-tokens";
import type { ManiaCardTier, ManiaSkills } from "./maniacard";

/* Server fns for /admin/collections, the grant desk for the pack economy: hand
   a collector shards, mint them a card with every field chosen by hand, or take
   one back. All of it lives in the live backend (pack_wallets,
   pack_collection_cards, pack_cards, pack_card_serials) behind
   /api/admin/packs/collection*, and these proxy through with the admin token.

   Gated with requireTrueAdminAccess rather than the requireAdminAccess every
   other admin page takes. The wider flag is also true for anyone running the
   site on localhost, which is right for reading a dashboard and wrong for a
   route whose whole purpose is writing shards into somebody else's account. */

export interface AdminCollectionUser {
  userId: number;
  username: string | null;
  countryCode: string | null;
  /* False when the backend has no users row for this id: an untracked or
     deleted account can still hold cards, its card just has no live identity
     to overlay. */
  tracked: boolean;
}

export interface AdminCollectionEconomy {
  shards: number;
  shardsSpent: number;
  charges: number;
  lastRefillAt: number;
  openedPacks: number;
  poolTotal: number | null;
}

export interface AdminCollectionCard {
  userId: number;
  cardKey?: string;
  username: string;
  avatarUrl: string;
  countryCode: string;
  tier: ManiaCardTier | null;
  tierLabel: string | null;
  /* Set only when this holding was given its own badge text, which is what the
     card art then prints in place of the tier's name. */
  customLabel?: string | null;
  skills: ManiaSkills | null;
  pp: number;
  globalRank: number;
  copies: number;
  recycledCopies: number;
  firstPulledAt: number;
  lastPulledAt: number;
  serial?: number | null;
  mintedTotal?: number;
}

export interface AdminCollectionOverview {
  user: AdminCollectionUser;
  economy: AdminCollectionEconomy;
  walletRev: number;
  walletUpdatedAt: number | null;
  hasWallet: boolean;
  distinctCards: number;
  totalCopies: number;
  collection: {
    cards: AdminCollectionCard[];
    total: number;
    tierCounts: Record<string, number>;
    duplicateShardTotal: number;
    filteredShardTotal: number;
  };
}

/* Every field of one holding. Anything left out keeps what the row already had,
   which is what makes this form usable as an edit as well as a grant. */
export interface AdminCardGrantInput {
  cardUserId: number;
  tier: ManiaCardTier | null;
  tierLabel?: string | null;
  copies?: number;
  copiesMode?: "add" | "set";
  recycledCopies?: number;
  pp?: number;
  globalRank?: number;
  skills?: ManiaSkills | null;
  clearSkills?: boolean;
  firstPulledAt?: number;
  lastPulledAt?: number;
  serialMode?: "keep" | "mint" | "set";
  serial?: number;
  username?: string;
  avatarUrl?: string;
  countryCode?: string;
  overwriteIdentity?: boolean;
}

export interface AdminCardGrantResult {
  ok: boolean;
  cardKey: string;
  created: boolean;
  card: AdminCollectionCard | null;
}

/* The two ways the form names a player: the picker hands over an id, the raw
   box takes either. A deleted account has no username to look up, so an id is
   the only handle that reaches one. */
export interface AdminCollectionTarget {
  userId?: number;
  username?: string;
}

function requireLiveBackendBase(): string {
  const base = getServerLiveBackendUrl();
  if (!base) throw new Error("LIVE_BACKEND_URL is not configured.");
  return base;
}

/* connection: close for the same reason admin-todos.ts sets it: keep-alive
   socket reuse between the frontend server and the live backend intermittently
   dies mid-response, and the hop is localhost anyway. */
function headers(json = false): Record<string, string> {
  return { ...adminAuthHeaders(json), connection: "close" };
}

function normalizeTarget(data: { userId?: unknown; username?: unknown }): AdminCollectionTarget {
  const userId = Math.floor(Number(data?.userId));
  const username = typeof data?.username === "string" ? data.username.trim() : "";
  return {
    ...(Number.isInteger(userId) && userId > 0 ? { userId } : {}),
    ...(username ? { username } : {}),
  };
}

async function failure(response: Response, action: string): Promise<Error> {
  if (response.status === 404) {
    const body = await response.text().catch(() => "");
    if (body.includes("user_not_found")) return new Error("No player with that id or username.");
  }
  if (response.status === 400) {
    const body = await response.text().catch(() => "");
    if (body.includes("bad_tier")) return new Error("That is not one of the card tiers.");
    if (body.includes("bad_card_user")) return new Error("Pick the player whose card this is.");
    if (body.includes("bad_skills")) return new Error("Those skill numbers are too large to store.");
  }
  return new Error(`${action} failed (${response.status}).`);
}

export const fetchAdminCollection = createServerFn({ method: "GET" })
  .validator((data: {
    userId?: unknown;
    username?: unknown;
    page?: unknown;
    tier?: unknown;
    query?: unknown;
    sort?: unknown;
  }) => ({
    ...normalizeTarget(data),
    page: Math.max(0, Math.floor(Number(data?.page) || 0)),
    tier: typeof data?.tier === "string" ? data.tier : "all",
    query: typeof data?.query === "string" ? data.query.trim() : "",
    sort: data?.sort === "newest" ? "newest" : "",
  }))
  .handler(async ({ data }): Promise<AdminCollectionOverview> => {
    await requireTrueAdminAccess("Collections admin");
    const params = new URLSearchParams({ page: String(data.page), pageSize: "24" });
    if (data.userId) params.set("userId", String(data.userId));
    if (data.username) params.set("username", data.username);
    if (data.tier && data.tier !== "all") params.set("tier", data.tier);
    if (data.query) params.set("q", data.query);
    if (data.sort) params.set("sort", data.sort);
    const response = await fetch(`${requireLiveBackendBase()}/api/admin/packs/collection?${params.toString()}`, {
      headers: headers(),
    });
    if (!response.ok) throw await failure(response, "Collection read");
    return await response.json() as AdminCollectionOverview;
  });

export const setAdminCollectionWallet = createServerFn({ method: "POST" })
  .validator((data: {
    userId?: unknown;
    username?: unknown;
    shards?: unknown;
    shardsDelta?: unknown;
    shardsSpent?: unknown;
    charges?: unknown;
    openedPacks?: unknown;
  }) => {
    // Only the keys that were actually filled in travel, so a shard grant never
    // also rewrites the charge bar back to whatever the form last rendered.
    const patch: Record<string, unknown> = { ...normalizeTarget(data) };
    for (const key of ["shards", "shardsDelta", "shardsSpent", "charges", "openedPacks"] as const) {
      const value = Number(data?.[key]);
      if (data?.[key] !== undefined && data?.[key] !== null && data?.[key] !== "" && Number.isFinite(value)) {
        patch[key] = value;
      }
    }
    return patch;
  })
  .handler(async ({ data }): Promise<{ ok: boolean; economy: AdminCollectionEconomy }> => {
    await requireTrueAdminAccess("Collections wallet grant");
    const response = await fetch(`${requireLiveBackendBase()}/api/admin/packs/collection/wallet`, {
      method: "POST",
      headers: headers(true),
      body: JSON.stringify(data),
    });
    if (!response.ok) throw await failure(response, "Wallet grant");
    return await response.json() as { ok: boolean; economy: AdminCollectionEconomy };
  });

export const grantAdminCollectionCard = createServerFn({ method: "POST" })
  .validator((data: { userId?: unknown; username?: unknown; card?: unknown }) => ({
    ...normalizeTarget(data),
    card: (data?.card ?? {}) as AdminCardGrantInput,
  }))
  .handler(async ({ data }): Promise<AdminCardGrantResult> => {
    await requireTrueAdminAccess("Collections card grant");
    const response = await fetch(`${requireLiveBackendBase()}/api/admin/packs/collection/grant`, {
      method: "POST",
      headers: headers(true),
      body: JSON.stringify(data),
    });
    if (!response.ok) throw await failure(response, "Card grant");
    return await response.json() as AdminCardGrantResult;
  });

export const removeAdminCollectionCard = createServerFn({ method: "POST" })
  .validator((data: { userId?: unknown; username?: unknown; cardKey?: unknown; dropSerial?: unknown }) => ({
    ...normalizeTarget(data),
    cardKey: typeof data?.cardKey === "string" ? data.cardKey : "",
    dropSerial: data?.dropSerial === true,
  }))
  .handler(async ({ data }): Promise<{ ok: boolean; removed: boolean; serialRemoved: boolean }> => {
    await requireTrueAdminAccess("Collections card removal");
    const response = await fetch(`${requireLiveBackendBase()}/api/admin/packs/collection/remove`, {
      method: "POST",
      headers: headers(true),
      body: JSON.stringify(data),
    });
    if (response.status === 404) return { ok: false, removed: false, serialRemoved: false };
    if (!response.ok) throw await failure(response, "Card removal");
    return await response.json() as { ok: boolean; removed: boolean; serialRemoved: boolean };
  });
