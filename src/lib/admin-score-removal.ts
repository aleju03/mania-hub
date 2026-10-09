import { createServerFn } from "@tanstack/react-start";

import { adminAuthHeaders } from "./live-backend-tokens";
import { getServerLiveBackendUrl } from "./live-backend";

/* Removing a player's official plays from every surface (/admin/scores),
   backed by backend features/admin-score-removal.ts. */

export interface AdminScoreRow {
  scoreId: number;
  legacyScoreId: number | null;
  beatmapId: number | null;
  artist: string | null;
  title: string | null;
  version: string | null;
  mods: string[];
  pp: number | null;
  accuracy: number | null;
  rank: string | null;
  endedAt: string | null;
}

export interface AdminRemovedScoreRow {
  scoreId: number;
  legacyScoreId: number | null;
  beatmapId: number | null;
  artist: string | null;
  title: string | null;
  version: string | null;
  endedAt: string | null;
  removedAt: string;
}

export interface AdminScoreRemovalView {
  user: { userId: number; username: string; avatarUrl: string | null; countryCode: string | null };
  topPlays: AdminScoreRow[];
  recentPlays: AdminScoreRow[];
  removed: AdminRemovedScoreRow[];
}

async function adminPost(path: string, body: unknown): Promise<Response> {
  const base = getServerLiveBackendUrl();
  if (!base) throw new Error("LIVE_BACKEND_URL is not configured.");
  return fetch(`${base}${path}`, { method: "POST", headers: adminAuthHeaders(true), body: JSON.stringify(body) });
}

export const lookupAdminScoreRemoval = createServerFn({ method: "POST" })
  .validator((data: { query?: unknown }) => {
    const query = typeof data?.query === "string" ? data.query.trim().slice(0, 120) : "";
    if (!query) throw new Error("Enter a username, #user-id, or id:user-id.");
    return { query };
  })
  .handler(async ({ data }): Promise<AdminScoreRemovalView> => {
    const { requireAdminAccess } = await import("./auth");
    await requireAdminAccess("Look up a player's plays");
    const response = await adminPost("/api/admin/score-removal/lookup", data);
    const body = await response.json().catch(() => null) as (AdminScoreRemovalView & { error?: unknown }) | null;
    if (!response.ok || !body) {
      const code = String(body?.error ?? `Server ${response.status}`);
      if (code === "user_not_found") throw new Error("No stored user matches that username or ID.");
      if (code === "ambiguous_username") throw new Error("More than one stored account has that username; use # followed by the osu! user ID.");
      throw new Error(code);
    }
    return body;
  });

function validateScoreIds(data: { userId?: unknown; scoreIds?: unknown }) {
  const userId = Number(data?.userId);
  const scoreIds = Array.isArray(data?.scoreIds)
    ? [...new Set(data.scoreIds.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))].slice(0, 50)
    : [];
  if (!Number.isSafeInteger(userId) || userId <= 0 || scoreIds.length === 0) throw new Error("Pick at least one play.");
  return { userId, scoreIds };
}

export const removeAdminScores = createServerFn({ method: "POST" })
  .validator(validateScoreIds)
  .handler(async ({ data }): Promise<{ removed: number }> => {
    const { requireAdminAccess } = await import("./auth");
    await requireAdminAccess("Remove a player's plays");
    const response = await adminPost("/api/admin/score-removal/remove", data);
    if (!response.ok) throw new Error(`Server ${response.status} for /api/admin/score-removal/remove`);
    return await response.json() as { removed: number };
  });

export const restoreAdminScores = createServerFn({ method: "POST" })
  .validator(validateScoreIds)
  .handler(async ({ data }): Promise<{ restored: number }> => {
    const { requireAdminAccess } = await import("./auth");
    await requireAdminAccess("Restore a player's removed plays");
    const response = await adminPost("/api/admin/score-removal/restore", data);
    if (!response.ok) throw new Error(`Server ${response.status} for /api/admin/score-removal/restore`);
    return await response.json() as { restored: number };
  });
