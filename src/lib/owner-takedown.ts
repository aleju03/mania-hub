import { createServerFn } from "@tanstack/react-start";

import { adminAuthHeaders } from "./live-backend-tokens";
import { getServerLiveBackendUrl } from "./live-backend";

/* A takedown a player asked for (/admin/players, Takedowns tab). The backend
   purges what tracking recorded and hides the account everywhere, and keeps it
   able to sign in and use what it owns (backend features/owner-takedown.ts).
   This side then deletes what lives in our half of the R2 bucket: their
   uploaded .osr files and the cached copies of their osu! replays. Every step
   is idempotent, so a partial failure is fixed by running it again. */

export interface OwnerTakedownPreview {
  userId: number;
  username: string;
  avatarUrl: string;
  countryCode: string | null;
  active: boolean;
  takenDown: boolean;
  wiped: boolean;
  impact: {
    trackerScores: number;
    activityPlays: number;
    topScores: number;
    packHoldings: number;
    packOwners: number;
    companellaImports: number;
    uploadedReplays: number;
  };
}

export interface OwnerTakedownSummary {
  userId: number;
  username: string;
  deleted: Record<string, number>;
  companellaImportsDeleted: number;
  uploadsDeleted: number;
  uploadsFailed: number;
  replayObjectsDeleted: number;
  replayScoresFailed: number;
}

export interface TakenDownUser {
  userId: number;
  username: string;
  takenDownAt: string;
  companellaBlocked: boolean;
}

const UPLOAD_PAGE_SIZE = 50;

async function adminFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const base = getServerLiveBackendUrl();
  if (!base) throw new Error("LIVE_BACKEND_URL is not configured.");
  return fetch(`${base}${path}`, {
    ...init,
    headers: { ...adminAuthHeaders(init.method === "POST"), connection: "close", ...(init.headers ?? {}) },
  });
}

async function readError(response: Response, path: string): Promise<string> {
  const body = await response.json().catch(() => null) as { error?: unknown } | null;
  return typeof body?.error === "string" ? body.error : `Server ${response.status} for ${path}`;
}

function validUserId(value: unknown): number {
  const userId = Number(value);
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error("Invalid user id.");
  return userId;
}

export const previewOwnerTakedown = createServerFn({ method: "POST" })
  .validator((data: { query?: unknown }) => {
    const query = typeof data?.query === "string" ? data.query.trim().slice(0, 120) : "";
    if (!query) throw new Error("Enter a username, #user-id, or id:user-id.");
    return { query };
  })
  .handler(async ({ data }): Promise<OwnerTakedownPreview> => {
    const { requireAdminAccess } = await import("./auth");
    await requireAdminAccess("Preview a takedown");
    const response = await adminFetch("/api/admin/takedown-preview", { method: "POST", body: JSON.stringify(data) });
    if (!response.ok) {
      const code = await readError(response, "/api/admin/takedown-preview");
      if (code === "user_not_found") throw new Error("No stored account matches that username or ID.");
      if (code === "ambiguous_username") throw new Error("More than one stored account has that username; use # followed by the osu! user ID.");
      throw new Error(code);
    }
    return await response.json() as OwnerTakedownPreview;
  });

export const listOwnerTakedowns = createServerFn({ method: "GET" }).handler(async (): Promise<TakenDownUser[]> => {
  const { requireAdminAccess } = await import("./auth");
  await requireAdminAccess("List takedowns");
  const response = await adminFetch("/api/admin/takedowns");
  if (!response.ok) throw new Error(await readError(response, "/api/admin/takedowns"));
  return ((await response.json()) as { users?: TakenDownUser[] }).users ?? [];
});

export const runOwnerTakedown = createServerFn({ method: "POST" })
  .validator((data: { userId?: unknown; expectedUsername?: unknown; confirmation?: unknown }) => {
    const userId = validUserId(data?.userId);
    const expectedUsername = typeof data?.expectedUsername === "string" ? data.expectedUsername.slice(0, 120) : "";
    if (!expectedUsername || data?.confirmation !== `TAKEDOWN ${userId}`) {
      throw new Error("Preview the account again before taking it down.");
    }
    return { userId, expectedUsername, confirmation: `TAKEDOWN ${userId}` };
  })
  .handler(async ({ data }): Promise<OwnerTakedownSummary> => {
    const { requireTrueAdminAccess } = await import("./auth");
    await requireTrueAdminAccess("Take an account down");

    // The backend first: from here on the account is hidden and untracked, so
    // nothing re-creates what the steps below delete.
    const response = await adminFetch("/api/admin/takedown", { method: "POST", body: JSON.stringify(data) });
    if (!response.ok) {
      const code = await readError(response, "/api/admin/takedown");
      if (code === "user_changed_since_preview") throw new Error("The stored username changed after preview; preview the account again.");
      if (code === "user_wiped") throw new Error("This account was already purged by the banned-account wipe.");
      if (code === "user_not_found") throw new Error("That previewed user no longer exists.");
      throw new Error(code);
    }
    const result = await response.json() as {
      username: string;
      deleted: Record<string, number>;
      companellaImportsDeleted: number;
      scoreIds: number[];
    };

    const uploads = await deleteOwnedUploads(data.userId);

    const { deleteCachedScoreReplays } = await import("./r2-cache");
    const { REPLAY_PARSED_CACHE_VERSION, forgetParsedReplays } = await import("./osu/replay");
    const replays = await deleteCachedScoreReplays(result.scoreIds, REPLAY_PARSED_CACHE_VERSION);
    await forgetParsedReplays(result.scoreIds);
    await forgetUser(data.userId, result.username);

    return {
      userId: data.userId,
      username: result.username,
      deleted: result.deleted,
      companellaImportsDeleted: result.companellaImportsDeleted,
      uploadsDeleted: uploads.deleted,
      uploadsFailed: uploads.failed,
      replayObjectsDeleted: replays.deleted,
      replayScoresFailed: replays.failed,
    };
  });

export const restoreOwnerTakedown = createServerFn({ method: "POST" })
  .validator((data: { userId?: unknown; confirmation?: unknown }) => {
    const userId = validUserId(data?.userId);
    if (data?.confirmation !== `RESTORE ${userId}`) throw new Error("Confirm the restore first.");
    return { userId, confirmation: `RESTORE ${userId}` };
  })
  .handler(async ({ data }): Promise<{ username: string; retrackedRosters: number }> => {
    const { requireTrueAdminAccess } = await import("./auth");
    await requireTrueAdminAccess("Restore a taken-down account");
    const response = await adminFetch("/api/admin/takedown-restore", { method: "POST", body: JSON.stringify(data) });
    if (!response.ok) {
      const code = await readError(response, "/api/admin/takedown-restore");
      if (code === "not_taken_down") throw new Error("That account is not taken down.");
      throw new Error(code);
    }
    const body = await response.json() as { username: string; retrackedRosters: number };
    await forgetUser(data.userId, body.username);
    return body;
  });

/* Every upload in the owner index under this account, deleted the way the
   owner's own delete button does it. The first page (0-based) is re-read each
   round because each delete shifts the rest up. */
async function deleteOwnedUploads(userId: number): Promise<{ deleted: number; failed: number }> {
  const { fetchUploadedReplayIndexPage } = await import("./uploaded-replay-index");
  const { removeUploadedReplay } = await import("./uploaded-replay-delete-server");
  let deleted = 0;
  let failed = 0;
  const tried = new Set<string>();
  for (;;) {
    const page = await fetchUploadedReplayIndexPage({
      viewerUserId: userId,
      asAdmin: false,
      allOwners: false,
      page: 0,
      pageSize: UPLOAD_PAGE_SIZE,
    });
    const pending = page.uploads.filter((upload) => upload.ownerUserId === userId && !tried.has(upload.id));
    if (pending.length === 0) break;
    for (const upload of pending) {
      tried.add(upload.id);
      const result = await removeUploadedReplay(upload.id, { userId: null, asAdmin: true });
      if (result.ok) deleted += 1;
      else failed += 1;
    }
  }
  return { deleted, failed };
}

/* This instance's memory copy of the osu! profile; the other instance's
   expires on its own within minutes (USER_CACHE_TTL). */
async function forgetUser(userId: number, username: string): Promise<void> {
  const { invalidatePersistentCache } = await import("./api");
  const { getUserCacheKey } = await import("./osu/users");
  const { USER_CACHE_VERSION } = await import("./osu/constants");
  for (const key of [String(userId), username]) {
    if (key) await invalidatePersistentCache(getUserCacheKey(key));
  }
  await invalidatePersistentCache(`user-id:v${USER_CACHE_VERSION}:${userId}`);
}
