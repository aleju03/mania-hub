import { createServerFn } from "@tanstack/react-start";

import { adminAuthHeaders } from "./live-backend-tokens";
import { getServerLiveBackendUrl } from "./live-backend";

/* Leaderboard import, the admin-only sibling of "Add a missing score": one
   chart's global leaderboard (osu! publishes the top 50 and nothing past it)
   sent through the ordinary ingest. The session is checked here, then the
   backend's admin route is opened with the admin token; the browser never
   holds that token. What each stored play earns is decided downstream. */

export type LeaderboardImportFailure = "rate_limited" | "failed";

export type LeaderboardImportJobStatus = "queued" | "running" | "done" | "failed" | "none";

export interface LeaderboardImportStatus {
  beatmapId: number;
  status: LeaderboardImportJobStatus;
  error: string | null;
  /* Rows retained from imports, or the latest durable receipt's count. */
  stored: number;
  lastImportedAt: string | null;
  retryAt: string | null;
  recent: boolean;
}

export type LeaderboardImportQueued = {
  ok: true;
  queuedBeatmapIds: number[];
  recentBeatmapIds: number[];
  statuses: LeaderboardImportStatus[];
} | { ok: false; reason: LeaderboardImportFailure };

async function adminFetch(path: string, init: RequestInit = {}): Promise<Response | null> {
  const base = getServerLiveBackendUrl();
  if (!base) return null;
  try {
    return await fetch(`${base}${path}`, {
      ...init,
      headers: { ...adminAuthHeaders(init.method === "POST"), connection: "close", ...(init.headers ?? {}) },
    });
  } catch {
    return null;
  }
}

/* Enqueues every chart in one request and answers as soon as the job rows
   exist; the backend's leaderboard-import lane does the fetching and the
   ingest. One call per set rather than per chart, so "Add all" costs one
   server-function request against the per-visitor bucket. */
export const importBeatmapLeaderboards = createServerFn({ method: "POST" })
  .validator((data: { beatmapIds: number[] }) => {
    const beatmapIds = [...new Set((data?.beatmapIds ?? []).map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))].slice(0, 200);
    if (beatmapIds.length === 0) throw new Error("Invalid beatmap id.");
    return { beatmapIds };
  })
  .handler(async ({ data }): Promise<LeaderboardImportQueued> => {
    const { requireAdminAccess } = await import("./auth");
    await requireAdminAccess("Leaderboard import");
    const response = await adminFetch("/api/admin/leaderboard-imports", {
      method: "POST",
      body: JSON.stringify({ beatmapIds: data.beatmapIds }),
    });
    if (!response) return { ok: false, reason: "failed" };
    if (response.status === 429) return { ok: false, reason: "rate_limited" };
    let payload: Record<string, unknown> | null = null;
    try {
      payload = await response.json() as Record<string, unknown>;
    } catch {
      payload = null;
    }
    if (!response.ok || payload?.ok !== true) return { ok: false, reason: "failed" };
    return {
      ok: true,
      queuedBeatmapIds: Array.isArray(payload.queuedBeatmapIds) ? payload.queuedBeatmapIds.map(Number) : data.beatmapIds,
      recentBeatmapIds: Array.isArray(payload.recentBeatmapIds) ? payload.recentBeatmapIds.map(Number) : [],
      statuses: Array.isArray(payload.statuses) ? payload.statuses as LeaderboardImportStatus[] : [],
    };
  });

export const getLeaderboardImportStatuses = createServerFn({ method: "GET" })
  .validator((data: { beatmapIds: number[] }) => ({
    beatmapIds: [...new Set((data?.beatmapIds ?? []).map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))].slice(0, 200),
  }))
  .handler(async ({ data }): Promise<LeaderboardImportStatus[]> => {
    const { requireAdminAccess } = await import("./auth");
    await requireAdminAccess("Leaderboard import status");
    if (data.beatmapIds.length === 0) return [];
    const response = await adminFetch(`/api/admin/leaderboard-imports?ids=${data.beatmapIds.join(",")}`);
    if (!response || !response.ok) return [];
    try {
      const payload = await response.json() as { statuses?: LeaderboardImportStatus[] };
      return payload.statuses ?? [];
    } catch {
      return [];
    }
  });
