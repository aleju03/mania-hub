import { createServerFn } from "@tanstack/react-start";

import { adminAuthHeaders } from "./live-backend-tokens";
import { getServerLiveBackendUrl } from "./live-backend";

/* Proof videos on official plays (/admin/players?tab=video), backed by
   backend features/score-videos.ts. */

export interface AdminScoreVideo {
  scoreId: number;
  legacyScoreId: number | null;
  beatmapId: number | null;
  artist: string | null;
  title: string | null;
  version: string | null;
  videoUrl: string;
  addedAt: string;
}

async function adminFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const base = getServerLiveBackendUrl();
  if (!base) throw new Error("LIVE_BACKEND_URL is not configured.");
  return fetch(`${base}${path}`, { ...init, headers: { ...adminAuthHeaders(init.method === "POST"), ...(init.headers ?? {}) } });
}

function positiveId(value: unknown, message: string): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error(message);
  return id;
}

export const listAdminScoreVideos = createServerFn({ method: "GET" })
  .validator((data: { userId?: unknown }) => ({ userId: positiveId(data?.userId, "Invalid user id.") }))
  .handler(async ({ data }): Promise<AdminScoreVideo[]> => {
    const { requireAdminAccess } = await import("./auth");
    await requireAdminAccess("List a player's play videos");
    const response = await adminFetch(`/api/admin/score-videos?userId=${data.userId}`);
    if (!response.ok) throw new Error(`Server ${response.status} for /api/admin/score-videos`);
    return (await response.json() as { entries: AdminScoreVideo[] }).entries;
  });

export const setAdminScoreVideo = createServerFn({ method: "POST" })
  .validator((data: { userId?: unknown; scoreId?: unknown; videoUrl?: unknown }) => ({
    userId: positiveId(data?.userId, "Invalid user id."),
    scoreId: positiveId(data?.scoreId, "Pick a play or paste its score link."),
    videoUrl: String(data?.videoUrl ?? "").trim().slice(0, 300),
  }))
  .handler(async ({ data }): Promise<void> => {
    const { requireAdminAccess } = await import("./auth");
    await requireAdminAccess("Add a video to a play");
    const response = await adminFetch("/api/admin/score-videos", { method: "POST", body: JSON.stringify(data) });
    if (response.ok) return;
    const body = await response.json().catch(() => null) as { error?: string } | null;
    if (body?.error === "invalid_video_url") throw new Error("The video link has to be an http or https link.");
    throw new Error(`Server ${response.status} for /api/admin/score-videos`);
  });

export const deleteAdminScoreVideo = createServerFn({ method: "POST" })
  .validator((data: { scoreId?: unknown }) => ({ scoreId: positiveId(data?.scoreId, "Invalid score id.") }))
  .handler(async ({ data }): Promise<void> => {
    const { requireAdminAccess } = await import("./auth");
    await requireAdminAccess("Remove a play's video");
    const response = await adminFetch("/api/admin/score-videos/delete", { method: "POST", body: JSON.stringify(data) });
    if (!response.ok) throw new Error(`Server ${response.status} for /api/admin/score-videos/delete`);
  });
