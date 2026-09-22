import { createServerFn } from "@tanstack/react-start";

import { adminAuthHeaders } from "./live-backend-tokens";
import { getServerLiveBackendUrl } from "./live-backend";

/* The admin list of Companella rate flags (/admin/companella-flags): imported
   plays whose replay frames did not confirm the speed their mods claim. A flag
   holds nothing back and the player never sees it; holding a play is the
   admin's call from the list, through the ordinary review route. */

export type RateFlagFilter = "all" | "mismatch" | "unreadable";

export interface RateFlag {
  scoreId: string;
  userId: number;
  username: string;
  mods: string[];
  reviewState: "clear" | "flagged" | "quarantined";
  rateCheck: {
    verdict: string;
    claimedRate: number;
    measuredRate: number | null;
    windows: number;
  };
  chart: { title: string | null; artist: string | null; version: string | null; keyCount: number | null };
  playedAt: string | null;
  receivedAt: string;
}

export interface RateFlagsPage {
  total: number;
  entries: RateFlag[];
}

async function adminFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const base = getServerLiveBackendUrl();
  if (!base) throw new Error("LIVE_BACKEND_URL is not configured.");
  return fetch(`${base}${path}`, {
    ...init,
    headers: { ...adminAuthHeaders(init.method === "POST"), connection: "close", ...(init.headers ?? {}) },
  });
}

export const listRateFlags = createServerFn({ method: "GET" })
  .validator((data: { filter?: RateFlagFilter; limit?: number; offset?: number } | undefined) => ({
    filter: data?.filter === "mismatch" || data?.filter === "unreadable" ? data.filter : "all",
    limit: Math.min(200, Math.max(1, Math.floor(Number(data?.limit) || 50))),
    offset: Math.max(0, Math.floor(Number(data?.offset) || 0)),
  }))
  .handler(async ({ data }): Promise<RateFlagsPage> => {
    const { requireAdminAccess } = await import("./auth");
    await requireAdminAccess("List Companella rate flags");
    const query = new URLSearchParams({ filter: data.filter, limit: String(data.limit), offset: String(data.offset) });
    const response = await adminFetch(`/api/admin/companella/rate-flags?${query.toString()}`);
    if (!response.ok) throw new Error(`Server ${response.status} for /api/admin/companella/rate-flags`);
    return await response.json() as RateFlagsPage;
  });

/** Holds a play out of its owner's preview, or lets it count again. */
export const setRateFlagHeld = createServerFn({ method: "POST" })
  .validator((data: { scoreId?: unknown; held?: unknown }) => {
    const scoreId = String(data?.scoreId ?? "");
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(scoreId)) throw new Error("Invalid score id.");
    return { scoreId, held: data?.held === true };
  })
  .handler(async ({ data }): Promise<void> => {
    const { requireAdminAccess } = await import("./auth");
    await requireAdminAccess("Hold a Companella play");
    const response = await adminFetch("/api/admin/companella/review", {
      method: "POST",
      body: JSON.stringify({ score_id: data.scoreId, review_state: data.held ? "quarantined" : "clear" }),
    });
    if (!response.ok) throw new Error(`Server ${response.status} for /api/admin/companella/review`);
  });
