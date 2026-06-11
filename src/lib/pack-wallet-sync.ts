import { createServerFn } from "@tanstack/react-start";
import type { ManiaCardTier, ManiaSkills } from "./maniacard";

// Server functions bridging the browser's pack wallet to the live backend's
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
}

export interface ServerPackCollectionPage {
  cards: ServerPackCollectionCard[];
  total: number;
  tierCounts: Record<string, number>;
  duplicateShardTotal: number;
}

export type PushPackWalletResult =
  | { ok: true; rev: number }
  | { ok: false; conflict: { payload: string; rev: number } };

export type PackWalletCardsMode = "snapshot" | "delta";

const PAYLOAD_MAX_CHARS = 3_500_000;

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

/* Null when sync is unavailable (logged out or no live backend configured);
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
  .inputValidator((input: { payload?: unknown; baseRev?: unknown; cardsMode?: unknown }) => {
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
  .inputValidator((input: { page?: unknown; pageSize?: unknown; tier?: unknown; query?: unknown }) => {
    const page = Math.max(0, Math.floor(Number(input?.page) || 0));
    const pageSize = Math.min(60, Math.max(1, Math.floor(Number(input?.pageSize) || 15)));
    const tier = typeof input?.tier === "string" ? input.tier : "all";
    const query = typeof input?.query === "string" ? input.query : "";
    return { page, pageSize, tier, query };
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
    const response = await fetch(url, { headers: target.headers });
    if (!response.ok) throw new Error(`Pack collection fetch failed (${response.status}).`);
    const body = (await response.json()) as ServerPackCollectionPage;
    return {
      cards: Array.isArray(body.cards) ? body.cards : [],
      total: Number(body.total) || 0,
      tierCounts: body.tierCounts && typeof body.tierCounts === "object" ? body.tierCounts : {},
      duplicateShardTotal: Number(body.duplicateShardTotal) || 0,
    };
  });

export type ServerPackRecycleMode = "duplicates" | "whole" | "all_duplicates";

export const recycleServerPackCollection = createServerFn({ method: "POST" })
  .inputValidator((input: { mode?: unknown; cardUserId?: unknown }) => {
    const mode = input?.mode === "duplicates" || input?.mode === "whole" || input?.mode === "all_duplicates"
      ? input.mode
      : null;
    const cardUserId = Number(input?.cardUserId);
    if (!mode || (mode !== "all_duplicates" && (!Number.isFinite(cardUserId) || cardUserId <= 0))) {
      throw new Error("Invalid recycle request.");
    }
    return { mode, cardUserId: Number.isFinite(cardUserId) ? Math.floor(cardUserId) : undefined };
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
