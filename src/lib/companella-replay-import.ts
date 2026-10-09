import { createServerFn } from "@tanstack/react-start";

import { adminAuthHeaders } from "./live-backend-tokens";
import { getServerLiveBackendUrl } from "./live-backend";

/* Admin replay imports (/admin/bridgers?tab=import): a player's .osr files go
   through the ordinary import pipeline under their account, a few at a time
   on the backend's import lane. */

export interface ReplayImportAccount {
  userId: number;
  username: string;
  avatarUrl: string | null;
}

export interface ReplayImportProgress {
  waiting: number;
  processing: number;
  imported: number;
  rejected: number;
  expired: number;
  rejections: Array<{ code: string; count: number }>;
}

export type ReplayImportFileResult =
  | { name: string; status: "staged" | "already_imported"; submissionId: string }
  | { name: string; status: "skipped"; reason: string; detail?: string };

async function adminFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const base = getServerLiveBackendUrl();
  if (!base) throw new Error("LIVE_BACKEND_URL is not configured.");
  return fetch(`${base}${path}`, {
    ...init,
    headers: { ...adminAuthHeaders(init.method === "POST"), connection: "close", ...(init.headers ?? {}) },
  });
}

/** The account by username or id, with where its replay imports stand; null when the site does not know it. */
export const lookupReplayImport = createServerFn({ method: "GET" })
  .validator((data: { user?: unknown }) => ({ user: String(data?.user ?? "").trim().slice(0, 40) }))
  .handler(async ({ data }): Promise<{ account: ReplayImportAccount; progress: ReplayImportProgress } | null> => {
    const { requireAdminAccess } = await import("./auth");
    await requireAdminAccess("Look up a replay import");
    const response = await adminFetch(`/api/admin/companella/replay-imports?user=${encodeURIComponent(data.user)}`);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Server ${response.status} for /api/admin/companella/replay-imports`);
    return await response.json() as { account: ReplayImportAccount; progress: ReplayImportProgress };
  });

/** Stages one batch of base64 .osr files for the account. */
export const uploadReplayImportBatch = createServerFn({ method: "POST" })
  .validator((data: { userId?: unknown; files?: unknown }) => {
    const userId = Number(data?.userId);
    if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error("Invalid user id.");
    if (!Array.isArray(data?.files) || data.files.length === 0 || data.files.length > 100) throw new Error("Invalid batch.");
    const files = data.files.map((file: { name?: unknown; data?: unknown }) => ({
      name: String(file?.name ?? "").slice(0, 200),
      data: String(file?.data ?? ""),
    }));
    return { userId, files };
  })
  .handler(async ({ data }): Promise<ReplayImportFileResult[]> => {
    const { requireAdminAccess } = await import("./auth");
    await requireAdminAccess("Upload a replay import");
    const response = await adminFetch(`/api/admin/companella/replay-imports/${data.userId}`, {
      method: "POST",
      body: JSON.stringify({ files: data.files }),
    });
    if (!response.ok) throw new Error(`Server ${response.status} for /api/admin/companella/replay-imports`);
    return (await response.json() as { results: ReplayImportFileResult[] }).results;
  });
