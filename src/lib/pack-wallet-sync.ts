import { createServerFn } from "@tanstack/react-start";
import type { ManiaCardTier, ManiaSkills } from "./maniacard";

// Server functions bridging the browser's pack wallet to the server's
// pack_wallets store. The viewer always comes from the osu! login cookie,
// never from client input, so a logged-in user can only ever read and write
// their own wallet. The backend route is admin-token gated; that token only
// exists server-side.

export interface ServerPackWallet {
  payload: string | null;
  rev: number;
}

export interface ServerPackCollectionCard {
  userId: number;
  /* Wallet key ("<id>" or "<id>:goat"), so a player's GOAT and their ordinary
     card stay distinct. Server rows always carry it. */
  cardKey?: string;
  username: string;
  avatarUrl: string;
  countryCode: string;
  tier: ManiaCardTier | null;
  tierLabel: string | null;
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
}

/* Progress against the current draw pool: owned players still pullable over
   the pool size, plus how many owned players have since fallen off the
   rankings. Honorary GOATs outside the pool sit in neither bucket (the GOAT
   chip tracks them). Null when the backend could not read the pool for this
   response. */
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
}

export type PushPackWalletResult =
  | { ok: true; rev: number }
  | { ok: false; conflict: { payload: string; rev: number } };

export type PackWalletCardsMode = "snapshot" | "delta";

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
  if (process.env.LIVE_ADMIN_TOKEN) {
    headers.authorization = `Bearer ${process.env.LIVE_ADMIN_TOKEN}`;
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

export const pushServerPackWallet = createServerFn({ method: "POST" })
  .validator((input: { payload?: unknown; baseRev?: unknown; cardsMode?: unknown }) => {
    const payload = typeof input?.payload === "string" ? input.payload : "";
    const baseRev = Number(input?.baseRev);
    const cardsMode = input?.cardsMode === "delta" ? "delta" : "snapshot";
    if (!payload || payload.length > PAYLOAD_MAX_CHARS || !Number.isFinite(baseRev) || baseRev < 0) {
      throw new Error("Invalid pack wallet payload.");
    }
    return { payload, baseRev: Math.floor(baseRev), cardsMode };
  })
  .handler(async ({ data }): Promise<PushPackWalletResult | null> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    const target = await getSyncTarget();
    if (!target) return null;
    // Normalize through the shared sanitizer so a tampered client can only
    // ever store a structurally valid wallet under its own account.
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
      body: JSON.stringify({ payload: JSON.stringify(sanitized), baseRev: data.baseRev, cardsMode: data.cardsMode }),
    });
    if (response.status === 409) {
      const body = (await response.json()) as { payload?: unknown; rev?: unknown };
      return {
        ok: false,
        conflict: {
          payload: typeof body.payload === "string" ? body.payload : "",
          rev: Number(body.rev) || 0,
        },
      };
    }
    if (!response.ok) throw new Error(`Pack wallet push failed (${response.status}).`);
    const body = (await response.json()) as { rev?: unknown };
    return { ok: true, rev: Number(body.rev) || 0 };
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

/* The signed-in viewer's showcase shelf: the card keys they've pinned to
   their profile, in shelf order. Owner-scoped like the wallet; reading
   *someone else's* shelf goes through fetchPackShowcaseCards below. */
export const PACK_SHOWCASE_MAX_CARDS = 5;

/* Any player's shelf, for rendering on their profile. Admin-gated on both
   sides while the showcase design is still being judged, so this runs
   server-side (the backend route needs the admin token) and answers empty for
   everyone else rather than erroring. */
export const fetchPackShowcaseCards = createServerFn({ method: "GET" })
  .validator((input: { userId?: unknown }) => ({ userId: Math.max(0, Math.floor(Number(input?.userId) || 0)) }))
  .handler(async ({ data }): Promise<ServerPackCollectionCard[]> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    if (data.userId <= 0) return [];
    const { readCurrentAuth } = await import("./auth-server");
    const auth = await readCurrentAuth();
    if (!auth.canUseAdminFeatures) return [];
    const base = process.env.LIVE_BACKEND_URL?.trim().replace(/\/$/, "");
    if (!base) return [];
    const headers: HeadersInit = {};
    if (process.env.LIVE_ADMIN_TOKEN) headers.authorization = `Bearer ${process.env.LIVE_ADMIN_TOKEN}`;
    const response = await fetch(`${base}/api/packs/showcase/${data.userId}`, { headers });
    if (!response.ok) throw new Error(`Pack showcase fetch failed (${response.status}).`);
    const body = (await response.json()) as { cards?: unknown };
    return Array.isArray(body.cards) ? (body.cards as ServerPackCollectionCard[]) : [];
  });

export const fetchOwnPackShowcase = createServerFn({ method: "GET" }).handler(
  async (): Promise<string[] | null> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    const target = await getSyncTarget();
    if (!target) return null;
    const url = target.url.replace(/\/api\/pack-wallet\/(\d+)$/, "/api/pack-collection/$1/showcase");
    const response = await fetch(url, { headers: target.headers });
    if (!response.ok) throw new Error(`Pack showcase fetch failed (${response.status}).`);
    const body = (await response.json()) as { cardKeys?: unknown };
    return Array.isArray(body.cardKeys)
      ? body.cardKeys.map((key) => (typeof key === "string" ? sanitizeCardKey(key) : null)).filter((key): key is string => key !== null)
      : [];
  },
);

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
  const match = /^(\d+)(:goat)?$/.exec(value.trim());
  if (!match) return null;
  const userId = Math.floor(Number(match[1]));
  if (!Number.isInteger(userId) || userId <= 0) return null;
  return match[2] ? `${userId}:goat` : String(userId);
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
      .slice(0, 10)
      .map((raw: unknown) => {
        const card = raw as Partial<PackPullRecordCard> | null;
        const userId = Math.floor(Number(card?.userId) || 0);
        if (userId <= 0 || typeof card?.username !== "string" || !card.username) return null;
        return {
          userId,
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
    if (process.env.LIVE_ADMIN_TOKEN) {
      headers.authorization = `Bearer ${process.env.LIVE_ADMIN_TOKEN}`;
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

   Admin-gated while it is being tried out, the same way pack duels are: the
   trigger on /packs is behind canUseAdminFeatures and this refuses anyone
   else regardless. */
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
    if (process.env.LIVE_ADMIN_TOKEN) {
      headers.authorization = `Bearer ${process.env.LIVE_ADMIN_TOKEN}`;
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

export type ServerPackRecycleMode = "duplicates" | "whole" | "all_duplicates" | "whole_matching";

export const recycleServerPackCollection = createServerFn({ method: "POST" })
  .validator((input: { mode?: unknown; cardKey?: unknown; cardKeys?: unknown; tier?: unknown; query?: unknown }) => {
    const mode =
      input?.mode === "duplicates" ||
      input?.mode === "whole" ||
      input?.mode === "all_duplicates" ||
      input?.mode === "whole_matching"
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
    if (!mode || (mode !== "all_duplicates" && mode !== "whole_matching" && !hasBulkKeys && !cardKey)) {
      throw new Error("Invalid recycle request.");
    }
    const tier = typeof input?.tier === "string" ? input.tier : "all";
    const query = typeof input?.query === "string" ? input.query.slice(0, 120) : "";
    return {
      mode,
      cardKey: cardKey ?? undefined,
      cardKeys: hasBulkKeys ? cardKeys : undefined,
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
