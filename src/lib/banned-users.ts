import { createServerFn } from "@tanstack/react-start";

import { adminAuthHeaders } from "./live-backend-tokens";
import { getServerLiveBackendUrl, type RestrictedPpPlay } from "./live-backend";

/* The admin banned-users page (/admin/banned-users): every account osu! stopped
   serving. Nothing reaches this list by being deleted; the backend only ever
   deactivates, and removing someone's content is the admin's call from here,
   through the ordinary wipe preview and confirmation. */

export type BannedUserStatus = "restricted" | "missing";
export type BannedUsersFilter = "all" | "new" | "restricted";

export interface BannedUser {
  userId: number;
  username: string;
  avatarUrl: string;
  countryCode: string | null;
  pp: number | null;
  /* restricted: osu! said so when they signed in. missing: osu! 404s the id,
     which a deleted account does too. */
  status: BannedUserStatus;
  reason: string | null;
  deactivatedAt: string | null;
  restrictedAt: string | null;
  lastLoginAt: string | null;
  reviewedAt: string | null;
  hasProfile: boolean;
  companellaPlays: number;
  displayName: string | null;
  /* The pp their counted Companella imports price to while osu! has them
     gone (restricted-pp.ts); null when nothing counts. */
  simulatedPp: number | null;
  simulatedPlays: number;
  /* Their latest signed-in visit to this site, from analytics; null when
     they never signed in here. */
  siteLastSeenAt: string | null;
  siteEvents: number;
}

export interface BannedUsersPage {
  total: number;
  unreviewed: number;
  entries: BannedUser[];
}

export interface RestrictedPpAdminPlay extends RestrictedPpPlay {
  /* The replay frames did not confirm the speed its DT/HT mods claim. */
  rateSuspicious: boolean;
  /* "clear" counts; anything else is a review hold, from here or the review route. */
  reviewState: string;
}

export interface RestrictedPpAdminView {
  userId: number;
  pp: number;
  rankedPlays: number;
  /* Every priced play in the current window, held ones included, best first. */
  plays: RestrictedPpAdminPlay[];
}

export type RestrictedPpRemovalScope = "plays" | "flagged" | "all";

async function adminFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const base = getServerLiveBackendUrl();
  if (!base) throw new Error("LIVE_BACKEND_URL is not configured.");
  return fetch(`${base}${path}`, {
    ...init,
    headers: { ...adminAuthHeaders(init.method === "POST"), connection: "close", ...(init.headers ?? {}) },
  });
}

function validUserId(value: unknown): number {
  const userId = Number(value);
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error("Invalid user id.");
  return userId;
}

export const listBannedUsers = createServerFn({ method: "GET" })
  .validator((data: { filter?: BannedUsersFilter; limit?: number; offset?: number } | undefined) => ({
    filter: data?.filter === "new" || data?.filter === "restricted" ? data.filter : "all",
    limit: Math.min(200, Math.max(1, Math.floor(Number(data?.limit) || 50))),
    offset: Math.max(0, Math.floor(Number(data?.offset) || 0)),
  }))
  .handler(async ({ data }): Promise<BannedUsersPage> => {
    const { requireAdminAccess } = await import("./auth");
    await requireAdminAccess("List banned users");
    const query = new URLSearchParams({ filter: data.filter, limit: String(data.limit), offset: String(data.offset) });
    const response = await adminFetch(`/api/admin/inactive-users?${query.toString()}`);
    if (!response.ok) throw new Error(`Server ${response.status} for /api/admin/inactive-users`);
    return await response.json() as BannedUsersPage;
  });

/** Clears the admin badge for these accounts, or for all of them. Returns what is still unseen. */
export const markBannedUsersReviewed = createServerFn({ method: "POST" })
  .validator((data: { userIds?: number[]; all?: boolean } | undefined) => ({
    userIds: Array.isArray(data?.userIds) ? data.userIds.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0).slice(0, 500) : [],
    all: data?.all === true,
  }))
  .handler(async ({ data }): Promise<number> => {
    const { requireAdminAccess } = await import("./auth");
    await requireAdminAccess("Mark banned users seen");
    const response = await adminFetch("/api/admin/inactive-users/reviewed", {
      method: "POST",
      body: JSON.stringify(data),
    });
    if (!response.ok) throw new Error(`Server ${response.status} for /api/admin/inactive-users/reviewed`);
    return Number(((await response.json()) as { unreviewed?: unknown }).unreviewed ?? 0);
  });

/** The badge on the admin menu. Zero for anyone who is not an admin. */
export const getBannedUsersAlert = createServerFn({ method: "GET" }).handler(async (): Promise<number> => {
  const { setResponseHeader } = await import("@tanstack/react-start/server");
  setResponseHeader("Cache-Control", "private, no-store");
  const { readCurrentAuth } = await import("./auth-server");
  if (!(await readCurrentAuth()).canUseAdminFeatures) return 0;
  try {
    const response = await adminFetch("/api/admin/inactive-users/count");
    if (!response.ok) return 0;
    return Number(((await response.json()) as { unreviewed?: unknown }).unreviewed ?? 0);
  } catch {
    return 0;
  }
});

/** Drops a player's display name (moderation). Their weekly clock keeps running. */
export const clearBannedUserDisplayName = createServerFn({ method: "POST" })
  .validator((data: { userId?: unknown }) => ({ userId: validUserId(data?.userId) }))
  .handler(async ({ data }): Promise<void> => {
    const { requireAdminAccess } = await import("./auth");
    await requireAdminAccess("Clear banned user display name");
    const response = await adminFetch("/api/admin/inactive-users/clear-name", {
      method: "POST",
      body: JSON.stringify(data),
    });
    if (!response.ok) throw new Error(`Server ${response.status} for /api/admin/inactive-users/clear-name`);
  });

/** A gone account's priced Companella plays, held ones included. Null when they have none. */
export const getRestrictedPpPlays = createServerFn({ method: "GET" })
  .validator((data: { userId?: unknown }) => ({ userId: validUserId(data?.userId) }))
  .handler(async ({ data }): Promise<RestrictedPpAdminView | null> => {
    const { requireAdminAccess } = await import("./auth");
    await requireAdminAccess("Read simulated pp plays");
    const response = await adminFetch(`/api/admin/companella/restricted-pp/${data.userId}`);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Server ${response.status} for /api/admin/companella/restricted-pp`);
    return await response.json() as RestrictedPpAdminView;
  });

/** Takes plays out of a gone account's simulated pp (a review hold), or puts them back. Returns how many changed. */
export const setRestrictedPpPlaysRemoved = createServerFn({ method: "POST" })
  .validator((data: { userId?: unknown; scope?: unknown; scoreIds?: unknown; restore?: unknown }) => {
    const scope = data?.scope;
    if (scope !== "plays" && scope !== "flagged" && scope !== "all") throw new Error("Invalid scope.");
    const scoreIds = Array.isArray(data?.scoreIds)
      ? data.scoreIds.map(String).filter((id) => /^[A-Za-z0-9_-]{8,64}$/.test(id)).slice(0, 1000)
      : [];
    if (scope === "plays" && scoreIds.length === 0) throw new Error("No plays given.");
    return { userId: validUserId(data?.userId), scope: scope as RestrictedPpRemovalScope, scoreIds, restore: data?.restore === true };
  })
  .handler(async ({ data }): Promise<number> => {
    const { requireAdminAccess } = await import("./auth");
    await requireAdminAccess(data.restore ? "Restore simulated pp plays" : "Remove simulated pp plays");
    const response = await adminFetch(`/api/admin/companella/restricted-pp/${data.userId}`, {
      method: "POST",
      body: JSON.stringify({ scope: data.scope, score_ids: data.scope === "plays" ? data.scoreIds : undefined, restore: data.restore }),
    });
    if (!response.ok) throw new Error(`Server ${response.status} for /api/admin/companella/restricted-pp`);
    return Number(((await response.json()) as { changed?: unknown }).changed ?? 0);
  });
