import { createServerFn } from "@tanstack/react-start";

import { adminAuthHeaders } from "./live-backend-tokens";
import { getServerLiveBackendUrl } from "./live-backend";

/* The admin list of every account that has used Companella
   (the Players tab on /admin/companella), restricted on osu! or not: their plays, which
   of those are held, and who is blocked. Holding a play goes through the
   review route (setRateFlagHeld), blocking through setCompanellaAccountBlocked. */

export type CompanellaAccountFilter = "recent" | "blocked";

export interface CompanellaAccount {
  userId: number;
  username: string;
  avatarUrl: string | null;
  countryCode: string | null;
  plays: number;
  heldPlays: number;
  /* Plays whose replay frames did not confirm the speed their mods claim. */
  flaggedPlays: number;
  activeConnections: number;
  lastPlayAt: string | null;
  blockedAt: string | null;
}

export interface CompanellaAccountPlay {
  scoreId: string;
  mods: string[];
  accuracy: number | null;
  totalScore: number;
  /* "clear" counts; anything else is a review hold. */
  reviewState: string;
  rateSuspicious: boolean;
  chart: { title: string | null; artist: string | null; version: string | null; keyCount: number | null };
  playedAt: string | null;
  receivedAt: string;
}

export interface Paged<T> {
  total: number;
  entries: T[];
}

async function adminFetch(path: string): Promise<Response> {
  const base = getServerLiveBackendUrl();
  if (!base) throw new Error("LIVE_BACKEND_URL is not configured.");
  return fetch(`${base}${path}`, { headers: { ...adminAuthHeaders(false), connection: "close" } });
}

export const listCompanellaAccounts = createServerFn({ method: "GET" })
  .validator((data: { filter?: CompanellaAccountFilter; query?: string; limit?: number; offset?: number } | undefined) => ({
    filter: data?.filter === "blocked" ? "blocked" as const : "recent" as const,
    query: String(data?.query ?? "").slice(0, 40),
    limit: Math.min(200, Math.max(1, Math.floor(Number(data?.limit) || 50))),
    offset: Math.max(0, Math.floor(Number(data?.offset) || 0)),
  }))
  .handler(async ({ data }): Promise<Paged<CompanellaAccount>> => {
    const { requireAdminAccess } = await import("./auth");
    await requireAdminAccess("List Companella players");
    const query = new URLSearchParams({ filter: data.filter, q: data.query, limit: String(data.limit), offset: String(data.offset) });
    const response = await adminFetch(`/api/admin/companella/accounts?${query.toString()}`);
    if (!response.ok) throw new Error(`Server ${response.status} for /api/admin/companella/accounts`);
    return await response.json() as Paged<CompanellaAccount>;
  });

export const listCompanellaAccountPlays = createServerFn({ method: "GET" })
  .validator((data: { userId?: unknown; limit?: number; offset?: number }) => {
    const userId = Number(data?.userId);
    if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error("Invalid user id.");
    return {
      userId,
      limit: Math.min(200, Math.max(1, Math.floor(Number(data?.limit) || 20))),
      offset: Math.max(0, Math.floor(Number(data?.offset) || 0)),
    };
  })
  .handler(async ({ data }): Promise<Paged<CompanellaAccountPlay>> => {
    const { requireAdminAccess } = await import("./auth");
    await requireAdminAccess("List a Companella player's plays");
    const query = new URLSearchParams({ limit: String(data.limit), offset: String(data.offset) });
    const response = await adminFetch(`/api/admin/companella/accounts/${data.userId}/plays?${query.toString()}`);
    if (!response.ok) throw new Error(`Server ${response.status} for /api/admin/companella/accounts/plays`);
    return await response.json() as Paged<CompanellaAccountPlay>;
  });
