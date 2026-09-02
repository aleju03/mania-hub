import { createServerFn } from "@tanstack/react-start";
import type { CardMotif } from "./card-motif";
import type { ManiaCardTier, ManiaSkills } from "./maniacard";
import { liveBridgeToken } from "./live-backend-tokens";
import { PACK_SHOWCASE_MAX_CARDS } from "./pack-showcase";

// Server functions bridging the browser to the server's pack_wallets store.
// The viewer always comes from the osu! login cookie, never from client
// input, so a logged-in user only ever touches their own wallet. The backend
// routes are bridge-token gated; that token only exists server-side.
//
// The wallet's numbers are server-owned: the draw spends, recycling and the
// arcade grant, and this module only ever *reads* them back - there is no
// push. The one write a local wallet still gets is mergeServerPackWallet,
// which folds pre-login browser history into an account that has never
// played, once ever.

export interface ServerPackWallet {
  payload: string | null;
  rev: number;
}

export interface ServerPackCollectionCard {
  userId: number;
  /* Wallet key ("<id>", "<id>:goat", or "<id>:v<n>" for a card the grant desk
     handed out), so every card of one player a collector holds stays distinct.
     Server rows always carry it. */
  cardKey?: string;
  username: string;
  avatarUrl: string;
  countryCode: string;
  tier: ManiaCardTier | null;
  tierLabel: string | null;
  /* This holding's own badge text and background art, when an admin gave it
     either. Both are server-side only: a browser-local wallet has neither. */
  customLabel?: string | null;
  motif?: CardMotif | null;
  skills: ManiaSkills | null;
  pp: number;
  globalRank: number;
  copies: number;
  recycledCopies: number;
  firstPulledAt: number;
  lastPulledAt: number;
  /* Mint order for this collector, and the serials the card has handed out in
     total. Server-side only: a browser-local wallet has no serials. */
  serial?: number | null;
  mintedTotal?: number;
  /* When the grant desk handed this holding out, null for a pulled one. */
  grantedAt?: number | null;
}

/* Progress against the ordinary-drawable pool: owned players still pullable
   over the pool size, plus how many owned players have since fallen off the
   rankings. Every honorary roster member sits outside both buckets because
   their GOAT variants are counted separately. Null when the backend could not
   read the pool for this response. */
export interface ServerPackCollectionPoolProgress {
  poolTotal: number;
  poolOwnedCount: number;
  retiredOwnedCount: number;
}

export interface ServerPackCollectionPage {
  cards: ServerPackCollectionCard[];
  total: number;
  tierCounts: Record<string, number>;
  duplicateShardTotal: number;
  filteredShardTotal: number;
  poolProgress: ServerPackCollectionPoolProgress | null;
  /** Honorary GOAT variants the collection still lacks. They are separate
      collectible slots from the ordinary player pool. */
  goatMissing: number;
}

/* One pullable player the viewer does not hold yet. Not a card: it has no
   tier and no skills, because nothing has been minted for this collector -
   the rarity only exists once the pack deals them. */
export interface ServerPackCollectionMissingPlayer {
  userId: number;
  username: string;
  avatarUrl: string;
  countryCode: string;
  pp: number;
  globalRank: number | null;
  poolRank: number;
}

export interface ServerPackCollectionMissingPage {
  players: ServerPackCollectionMissingPlayer[];
  total: number;
  /** GOAT variants this collection lacks, both as a count and as player ids so
      the client can hydrate their checked-in honorary faces. */
  goatMissing: number;
  goatMissingUserIds: number[];
}

const PAYLOAD_MAX_CHARS = 3_500_000;

// Mirrors PACK_COLLECTION_MAX_PAGE_SIZE in the live backend's pack-wallets
// feature; the album pages the whole collection, so a wide page keeps that
// walk to a few round trips instead of a dozen.
export const PACK_COLLECTION_MAX_PAGE_SIZE = 250;

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
  return { url: `${base}/api/pack-wallet/${auth.viewer.id}`, headers };
}

/* Null when sync is unavailable (logged out or no server configured);
   the wallet then stays browser-local. */
export const fetchServerPackWallet = createServerFn({ method: "GET" }).handler(
  async (): Promise<ServerPackWallet | null> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    const target = await getSyncTarget();
    if (!target) return null;
    const response = await fetch(target.url, { headers: target.headers });
    if (!response.ok) throw new Error(`Pack wallet fetch failed (${response.status}).`);
    const body = (await response.json()) as { payload?: unknown; rev?: unknown };
    return {
      payload: typeof body.payload === "string" ? body.payload : null,
      rev: Number(body.rev) || 0,
    };
  },
);

export interface MergePackWalletResult {
  merged: boolean;
  payload: string;
  rev: number;
}

/* Folds the browser-local wallet (pre-login pulls, shards and opened packs)
   into the account's server wallet. The server only accepts this once ever,
   and only for an account that has never played server-side; every other
   call is answered with the authoritative wallet and merged: false, so
   calling it doubles as the wallet fetch on first contact. Null when signed
   out or with no backend configured. */
export const mergeServerPackWallet = createServerFn({ method: "POST" })
  .validator((input: { payload?: unknown }) => {
    const payload = typeof input?.payload === "string" ? input.payload : "";
    if (!payload || payload.length > PAYLOAD_MAX_CHARS) throw new Error("Invalid pack wallet payload.");
    return { payload };
  })
  .handler(async ({ data }): Promise<MergePackWalletResult | null> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    const target = await getSyncTarget();
    if (!target) return null;
    // Normalize through the shared sanitizer so a tampered client can only
    // ever offer a structurally valid wallet under its own account; what of
    // it is believed (and how much) is the backend's decision.
    const { sanitizeWallet } = await import("./pack-collection");
    let wallet: unknown;
    try {
      wallet = JSON.parse(data.payload);
    } catch {
      throw new Error("Pack wallet payload is not valid JSON.");
    }
    const sanitized = sanitizeWallet(wallet, Date.now());
    if (!sanitized) throw new Error("Pack wallet payload has an invalid shape.");
    const response = await fetch(target.url, {
      method: "POST",
      headers: target.headers,
      body: JSON.stringify({ mode: "merge", payload: JSON.stringify(sanitized) }),
    });
    if (!response.ok) throw new Error(`Pack wallet merge failed (${response.status}).`);
    const body = (await response.json()) as { merged?: unknown; payload?: unknown; rev?: unknown };
    return {
      merged: body.merged === true,
      payload: typeof body.payload === "string" ? body.payload : "",
      rev: Number(body.rev) || 0,
    };
  });

export const fetchServerPackCollectionPage = createServerFn({ method: "GET" })
  .validator((input: { page?: unknown; pageSize?: unknown; tier?: unknown; query?: unknown; sort?: unknown }) => {
    const page = Math.max(0, Math.floor(Number(input?.page) || 0));
    const pageSize = Math.min(PACK_COLLECTION_MAX_PAGE_SIZE, Math.max(1, Math.floor(Number(input?.pageSize) || 15)));
    const tier = typeof input?.tier === "string" ? input.tier : "all";
    const query = typeof input?.query === "string" ? input.query : "";
    const sort = input?.sort === "newest" ? ("newest" as const) : ("rarity" as const);
    return { page, pageSize, tier, query, sort };
  })
  .handler(async ({ data }): Promise<ServerPackCollectionPage | null> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    const target = await getSyncTarget();
    if (!target) return null;
    const url = new URL(target.url.replace("/api/pack-wallet/", "/api/pack-collection/"));
    url.searchParams.set("page", String(data.page));
    url.searchParams.set("pageSize", String(data.pageSize));
    url.searchParams.set("tier", data.tier);
    if (data.query) url.searchParams.set("q", data.query);
    if (data.sort === "newest") url.searchParams.set("sort", "newest");
    const response = await fetch(url, { headers: target.headers });
    if (!response.ok) throw new Error(`Pack collection fetch failed (${response.status}).`);
    const body = (await response.json()) as ServerPackCollectionPage;
    const poolProgress =
      body.poolProgress && typeof body.poolProgress === "object" && Number(body.poolProgress.poolTotal) > 0
        ? {
            poolTotal: Math.floor(Number(body.poolProgress.poolTotal)),
            poolOwnedCount: Math.max(0, Math.floor(Number(body.poolProgress.poolOwnedCount) || 0)),
            retiredOwnedCount: Math.max(0, Math.floor(Number(body.poolProgress.retiredOwnedCount) || 0)),
          }
        : null;
    return {
      cards: Array.isArray(body.cards) ? body.cards : [],
      total: Number(body.total) || 0,
      tierCounts: body.tierCounts && typeof body.tierCounts === "object" ? body.tierCounts : {},
      duplicateShardTotal: Number(body.duplicateShardTotal) || 0,
      filteredShardTotal: Number(body.filteredShardTotal) || 0,
      poolProgress,
      goatMissing: Math.max(0, Math.floor(Number(body.goatMissing) || 0)),
    };
  });

/* The players still missing from the collection: the draw pool minus what the
   viewer holds, in pool order. Synced collections only, since the server is
   the one that knows both halves. */
export const fetchServerPackCollectionMissing = createServerFn({ method: "GET" })
  .validator((input: { page?: unknown; pageSize?: unknown; query?: unknown }) => {
    const page = Math.max(0, Math.floor(Number(input?.page) || 0));
    const pageSize = Math.min(PACK_COLLECTION_MAX_PAGE_SIZE, Math.max(1, Math.floor(Number(input?.pageSize) || 15)));
    const query = typeof input?.query === "string" ? input.query : "";
    return { page, pageSize, query };
  })
  .handler(async ({ data }): Promise<ServerPackCollectionMissingPage | null> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    const target = await getSyncTarget();
    if (!target) return null;
    const url = new URL(target.url.replace("/api/pack-wallet/", "/api/pack-collection/"));
    url.searchParams.set("missing", "1");
    url.searchParams.set("page", String(data.page));
    url.searchParams.set("pageSize", String(data.pageSize));
    if (data.query) url.searchParams.set("q", data.query);
    const response = await fetch(url, { headers: target.headers });
    if (!response.ok) throw new Error(`Pack collection missing fetch failed (${response.status}).`);
    const body = (await response.json()) as {
      players?: unknown;
      total?: unknown;
      goatMissing?: unknown;
      goatMissingUserIds?: unknown;
    };
    return {
      players: Array.isArray(body.players) ? (body.players as ServerPackCollectionMissingPlayer[]) : [],
      total: Number(body.total) || 0,
      goatMissing: Number(body.goatMissing) || 0,
      goatMissingUserIds: Array.isArray(body.goatMissingUserIds)
        ? body.goatMissingUserIds
            .map((value) => Math.floor(Number(value)))
            .filter((value) => Number.isInteger(value) && value > 0)
        : [],
    };
  });

/* The wallet keys the synced collection already holds, for duplicate
   protection. Keys rather than player ids: holding an ordinary card of a
   roster member does not mean holding their GOAT. */
export const fetchServerPackCollectionOwnedKeys = createServerFn({ method: "GET" }).handler(
  async (): Promise<string[] | null> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    const target = await getSyncTarget();
    if (!target) return null;
    const url = new URL(target.url.replace("/api/pack-wallet/", "/api/pack-collection/"));
    url.searchParams.set("ownedIds", "1");
    const response = await fetch(url, { headers: target.headers });
    if (!response.ok) throw new Error(`Pack collection owned ids fetch failed (${response.status}).`);
    const body = (await response.json()) as { cardKeys?: unknown };
    return Array.isArray(body.cardKeys)
      ? body.cardKeys.map((key) => (typeof key === "string" ? sanitizeCardKey(key) : null)).filter((key): key is string => key !== null)
      : [];
  },
);

/* Reading a showcase (yours or anyone else's) is a public browser-direct call
   on the collections page; only this write is owner-scoped. */
export const saveOwnPackShowcase = createServerFn({ method: "POST" })
  .validator((input: { cardKeys?: unknown }) => ({
    cardKeys: Array.isArray(input?.cardKeys)
      ? input.cardKeys
          .slice(0, PACK_SHOWCASE_MAX_CARDS * 10)
          .map((key) => (typeof key === "string" ? sanitizeCardKey(key) : null))
          .filter((key): key is string => key !== null)
      : [],
  }))
  .handler(async ({ data }): Promise<string[] | null> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    const target = await getSyncTarget();
    if (!target) return null;
    const url = target.url.replace(/\/api\/pack-wallet\/(\d+)$/, "/api/pack-collection/$1/showcase");
    const response = await fetch(url, {
      method: "POST",
      headers: target.headers,
      body: JSON.stringify({ cardKeys: data.cardKeys }),
    });
    if (!response.ok) throw new Error(`Pack showcase save failed (${response.status}).`);
    const body = (await response.json()) as { cardKeys?: unknown };
    return Array.isArray(body.cardKeys)
      ? body.cardKeys.map((key) => (typeof key === "string" ? sanitizeCardKey(key) : null)).filter((key): key is string => key !== null)
      : [];
  });

/* Normalizes a wallet card key, rejecting anything that is not a player id
   with an optional ":goat" suffix. */
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

/* What the pull log minted: the serial this account now holds each card at,
   and how many serials that card has ever handed out. */
export interface PackPullMint {
  userId: number;
  cardKey: string;
  serial: number;
  mintedTotal: number;
  isFirstGlobal: boolean;
}

export interface PackPullRecordCard {
  userId: number;
  /* The holding's key when the tier cannot derive it (a milestone card);
     the backend believes it only for a variant the reporter holds. */
  cardKey?: string;
  username: string;
  countryCode: string;
  tier: ManiaCardTier | null;
  isNew: boolean;
}

/* Logs a just-opened pack into the backend's community pull feed. The owner
   identity always comes from the login cookie; a tampered client can only
   ever log pulls as itself, and the data is social flavor, never economy. */
export const recordServerPackPulls = createServerFn({ method: "POST" })
  .validator((input: { packType?: unknown; cards?: unknown }) => {
    const packType =
      typeof input?.packType === "string" && /^[a-z0-9_]{1,24}$/.test(input.packType) ? input.packType : null;
    const cards: PackPullRecordCard[] = (Array.isArray(input?.cards) ? input.cards : [])
      .slice(0, 13) // The largest pack (Wild) plus the three bonus slots.
      .map((raw: unknown) => {
        const card = raw as Partial<PackPullRecordCard> | null;
        const userId = Math.floor(Number(card?.userId) || 0);
        if (userId <= 0 || typeof card?.username !== "string" || !card.username) return null;
        const cardKey = typeof card.cardKey === "string" ? sanitizeCardKey(card.cardKey) : null;
        return {
          userId,
          ...(cardKey ? { cardKey } : {}),
          username: card.username.slice(0, 40),
          countryCode: typeof card.countryCode === "string" ? card.countryCode.slice(0, 2) : "",
          tier: typeof card.tier === "string" ? (card.tier as ManiaCardTier) : null,
          isNew: card.isNew === true,
        };
      })
      .filter((card): card is PackPullRecordCard => card !== null);
    if (!packType || cards.length === 0) throw new Error("Invalid pack pull record.");
    return { packType, cards };
  })
  .handler(async ({ data }): Promise<{ recorded: number; mints: PackPullMint[] } | null> => {
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
    const response = await fetch(`${base}/api/packs/pulls`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        userId: auth.viewer.id,
        username: auth.viewer.username,
        packType: data.packType,
        cards: data.cards,
      }),
    });
    if (!response.ok) throw new Error(`Pack pull record failed (${response.status}).`);
    const body = (await response.json()) as { recorded?: unknown; mints?: unknown };
    const mints: PackPullMint[] = (Array.isArray(body.mints) ? body.mints : [])
      .map((raw: unknown) => {
        const mint = raw as Partial<PackPullMint> | null;
        const userId = Math.floor(Number(mint?.userId) || 0);
        const serial = Math.floor(Number(mint?.serial) || 0);
        if (userId <= 0 || serial <= 0 || typeof mint?.cardKey !== "string") return null;
        return {
          userId,
          cardKey: mint.cardKey,
          serial,
          mintedTotal: Math.max(serial, Math.floor(Number(mint.mintedTotal) || 0)),
          isFirstGlobal: mint.isFirstGlobal === true,
        };
      })
      .filter((mint): mint is PackPullMint => mint !== null);
    return { recorded: Number(body.recorded) || 0, mints };
  });

/* One collector holding the viewer's own card. */
export interface ServerPackCardCollector {
  userId: number;
  username: string;
  copies: number;
  tier: ManiaCardTier | null;
  serial: number | null;
  firstPulledAt: number;
  lastPulledAt: number;
}

export interface ServerPackCardCollectors {
  userId: number;
  owners: number;
  copies: number;
  collectors: ServerPackCardCollector[];
  listed: number;
}

/* Who has pulled your maniacard, by name. The card owner is the login cookie's
   viewer and nothing else, so this only ever lists the collectors of your own
   card; the public endpoint beside it stays a count. Null when signed out or
   with no backend configured.

   Admin-gated while it is being tried out: the trigger on /packs is behind
   canUseAdminFeatures and this refuses anyone else regardless. */
export const fetchServerPackCardCollectors = createServerFn({ method: "GET" }).handler(
  async (): Promise<ServerPackCardCollectors | null> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    const { requireAdminAccess } = await import("./auth");
    await requireAdminAccess("Card collectors");
    const { readCurrentAuth } = await import("./auth-server");
    const auth = await readCurrentAuth();
    if (!auth.viewer) return null;
    const base = process.env.LIVE_BACKEND_URL?.trim().replace(/\/$/, "");
    if (!base) return null;
    const headers: HeadersInit = {};
    const bridgeToken = liveBridgeToken();
    if (bridgeToken) {
      headers.authorization = `Bearer ${bridgeToken}`;
    }
    const response = await fetch(`${base}/api/packs/pulled-by/${auth.viewer.id}`, { headers });
    if (!response.ok) throw new Error(`Card collectors fetch failed (${response.status}).`);
    const body = (await response.json()) as Partial<ServerPackCardCollectors>;
    const collectors: ServerPackCardCollector[] = (Array.isArray(body.collectors) ? body.collectors : [])
      .map((raw: unknown) => {
        const entry = raw as Partial<ServerPackCardCollector> | null;
        const userId = Math.floor(Number(entry?.userId) || 0);
        if (userId <= 0) return null;
        const serial = Math.floor(Number(entry?.serial) || 0);
        return {
          userId,
          username: typeof entry?.username === "string" && entry.username ? entry.username : `user ${userId}`,
          copies: Math.max(0, Math.floor(Number(entry?.copies) || 0)),
          tier: typeof entry?.tier === "string" ? (entry.tier as ManiaCardTier) : null,
          serial: serial > 0 ? serial : null,
          firstPulledAt: Math.floor(Number(entry?.firstPulledAt) || 0),
          lastPulledAt: Math.floor(Number(entry?.lastPulledAt) || 0),
        };
      })
      .filter((entry): entry is ServerPackCardCollector => entry !== null);
    return {
      userId: auth.viewer.id,
      owners: Math.max(0, Math.floor(Number(body.owners) || 0)),
      copies: Math.max(0, Math.floor(Number(body.copies) || 0)),
      collectors,
      listed: Math.max(0, Math.floor(Number(body.listed) || 0)),
    };
  },
);

export type ServerPackRecycleMode = "duplicates" | "whole" | "all_duplicates" | "whole_matching" | "copies";

export const recycleServerPackCollection = createServerFn({ method: "POST" })
  .validator((input: {
    mode?: unknown;
    cardKey?: unknown;
    cardKeys?: unknown;
    cardCopies?: unknown;
    tier?: unknown;
    query?: unknown;
  }) => {
    const mode =
      input?.mode === "duplicates" ||
      input?.mode === "whole" ||
      input?.mode === "all_duplicates" ||
      input?.mode === "whole_matching" ||
      input?.mode === "copies"
      ? input.mode
      : null;
    // Cards are addressed by wallet key ("<id>" or "<id>:goat"), so a GOAT and
    // an ordinary card of the same player recycle independently.
    const cardKey = typeof input?.cardKey === "string" ? sanitizeCardKey(input.cardKey) : null;
    const cardKeys = mode === "whole" && Array.isArray(input?.cardKeys)
      ? input.cardKeys
          .slice(0, 500)
          .map((key) => (typeof key === "string" ? sanitizeCardKey(key) : null))
          .filter((key): key is string => key !== null)
      : null;
    const hasBulkKeys = cardKeys !== null && cardKeys.length > 0;
    /* Per-card copy counts, capped at a hand's worth: this mode hands back a
       pack that was just opened, so a duplicate gives up only the copy that
       pack added. */
    const cardCopies = mode === "copies" && Array.isArray(input?.cardCopies)
      ? input.cardCopies
          .slice(0, 50)
          .map((entry) => {
            const key = typeof (entry as { cardKey?: unknown })?.cardKey === "string"
              ? sanitizeCardKey((entry as { cardKey: string }).cardKey)
              : null;
            const copies = Math.floor(Number((entry as { copies?: unknown })?.copies) || 0);
            return key && copies > 0 ? { cardKey: key, copies: Math.min(copies, 100) } : null;
          })
          .filter((entry): entry is { cardKey: string; copies: number } => entry !== null)
      : null;
    const hasCopyEntries = cardCopies !== null && cardCopies.length > 0;
    if (
      !mode ||
      (mode === "copies" && !hasCopyEntries) ||
      (mode !== "all_duplicates" && mode !== "whole_matching" && mode !== "copies" && !hasBulkKeys && !cardKey)
    ) {
      throw new Error("Invalid recycle request.");
    }
    const tier = typeof input?.tier === "string" ? input.tier : "all";
    const query = typeof input?.query === "string" ? input.query.slice(0, 120) : "";
    return {
      mode,
      cardKey: cardKey ?? undefined,
      cardKeys: hasBulkKeys ? cardKeys : undefined,
      cardCopies: hasCopyEntries ? cardCopies : undefined,
      tier,
      query,
    };
  })
  .handler(async ({ data }): Promise<{ gained: number; payload: string; rev: number } | null> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    const target = await getSyncTarget();
    if (!target) return null;
    const url = target.url.replace("/api/pack-wallet/", "/api/pack-collection/");
    const response = await fetch(url, {
      method: "POST",
      headers: target.headers,
      body: JSON.stringify(data),
    });
    if (!response.ok) throw new Error(`Pack collection recycle failed (${response.status}).`);
    const body = (await response.json()) as { gained?: unknown; payload?: unknown; rev?: unknown };
    return {
      gained: Number(body.gained) || 0,
      payload: typeof body.payload === "string" ? body.payload : "",
      rev: Number(body.rev) || 0,
    };
  });

/* Persists a re-minted card's skills snapshot for a synced wallet. A synced
   wallet's cards live in server rows, not in the pushed blob, so the client
   cannot repair a legacy card by mutating its own wallet: without this call
   the backfill's work is thrown away and refetched next session. */
export const mintServerPackCollectionCard = createServerFn({ method: "POST" })
  .validator((input: { cardKey?: unknown; tier?: unknown; tierLabel?: unknown; skills?: unknown }) => {
    const cardKey = typeof input?.cardKey === "string" ? sanitizeCardKey(input.cardKey) : null;
    if (!cardKey) throw new Error("Invalid card key.");
    const skills = input?.skills && typeof input.skills === "object" && !Array.isArray(input.skills)
      ? input.skills as Record<string, unknown>
      : null;
    if (!skills) throw new Error("Invalid card mint.");
    return {
      mode: "mint" as const,
      cardKey,
      tier: typeof input?.tier === "string" ? input.tier : null,
      tierLabel: typeof input?.tierLabel === "string" ? input.tierLabel : null,
      skills,
    };
  })
  .handler(async ({ data }): Promise<boolean> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    const target = await getSyncTarget();
    if (!target) return false;
    const url = target.url.replace("/api/pack-wallet/", "/api/pack-collection/");
    const response = await fetch(url, {
      method: "POST",
      headers: target.headers,
      body: JSON.stringify(data),
    });
    // A failed repair is not worth an error surface: the card keeps its sketch
    // tile and a later session tries again.
    if (!response.ok) return false;
    const body = (await response.json()) as { applied?: unknown };
    return body.applied === true;
  });

export interface PackPullMintCard {
  cardKey: string;
  tier: ManiaCardTier | null;
  tierLabel: string | null;
  skills: ManiaSkills | null;
  /* Face numbers for cards the server dealt without any (GOAT slots, whose
     peak figures live in the frontend roster). Display-only; the backend
     only fills them onto a row that has none. */
  pp?: number;
  globalRank?: number;
}

/* The labelling pass that follows a server-dealt open: the tier, tier label
   and skills the reveal's maniacard computation produced for each card. The
   backend wrote the rows (and their copies) at draw time; this can only ever
   describe them, so a lost call costs a card its stat bar until the
   collection's repair path re-mints it, never a card. */
export const mintServerPackCollectionCards = createServerFn({ method: "POST" })
  .validator((input: { cards?: unknown }) => {
    const cards: PackPullMintCard[] = (Array.isArray(input?.cards) ? input.cards : [])
      .slice(0, 13) // The largest pack (Wild) plus the three bonus slots.
      .map((raw: unknown): PackPullMintCard | null => {
        const card = raw as Partial<PackPullMintCard> | null;
        const cardKey = typeof card?.cardKey === "string" ? sanitizeCardKey(card.cardKey) : null;
        const skills = card?.skills && typeof card.skills === "object" && !Array.isArray(card.skills)
          ? card.skills
          : null;
        if (!cardKey || !skills) return null;
        const pp = Number(card?.pp);
        const globalRank = Number(card?.globalRank);
        return {
          cardKey,
          tier: typeof card?.tier === "string" ? (card.tier as ManiaCardTier) : null,
          tierLabel: typeof card?.tierLabel === "string" ? card.tierLabel : null,
          skills,
          ...(Number.isFinite(pp) && pp > 0 ? { pp } : {}),
          ...(Number.isFinite(globalRank) && globalRank > 0 ? { globalRank } : {}),
        };
      })
      .filter((card): card is PackPullMintCard => card !== null);
    if (cards.length === 0) throw new Error("Nothing to mint.");
    return { cards };
  })
  .handler(async ({ data }): Promise<number> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    const target = await getSyncTarget();
    if (!target) return 0;
    const url = target.url.replace("/api/pack-wallet/", "/api/pack-collection/");
    const response = await fetch(url, {
      method: "POST",
      headers: target.headers,
      body: JSON.stringify({ mode: "mint", cards: data.cards }),
    });
    if (!response.ok) return 0;
    const body = (await response.json()) as { applied?: unknown };
    return Math.max(0, Math.floor(Number(body.applied) || 0));
  });
