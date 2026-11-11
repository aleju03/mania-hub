import { createServerFn } from "@tanstack/react-start";

import { liveBridgeToken } from "./live-backend-tokens";

/* A player deleting their own profile from My Stats (backend
   features/self-deletion.ts). The viewer always comes from the osu! login
   cookie, never from client input, so a player can only ever delete or
   restore their own. */

/** 'profile': what tracking recorded. 'account': that and everything the account owns. */
export type SelfDeletionScope = "profile" | "account";

export interface SelfDeletionStatus {
  scope: SelfDeletionScope;
  requestedAt: string;
  /** When whatever is still pending runs. */
  finalizeAfter: string;
  /** The profile half ran. */
  profileDeleted: boolean;
  /** Everything the scope covers is gone. */
  finalized: boolean;
  /** Still before the deadline and on hold, so Keep my profile works. */
  cancellable: boolean;
}

export type SelfDeletionError = "admin_takedown" | "already_finalized" | "deadline_passed" | "user_wiped" | "not_requested" | "unavailable";

export type SelfDeletionResult =
  | { ok: true; status: SelfDeletionStatus | null }
  | { ok: false; error: SelfDeletionError };

async function callSelfDeletion(payload: { action: "request"; scope: SelfDeletionScope } | { action: "cancel" }): Promise<SelfDeletionResult> {
  const { readCurrentAuth } = await import("./auth-server");
  const auth = await readCurrentAuth();
  if (!auth.viewer) return { ok: false, error: "unavailable" };
  const base = (process.env.LIVE_BACKEND_URL || process.env.VITE_LIVE_BACKEND_URL)?.trim().replace(/\/$/, "");
  if (!base) return { ok: false, error: "unavailable" };
  const headers: HeadersInit = { "content-type": "application/json" };
  const bridgeToken = liveBridgeToken();
  if (bridgeToken) headers.authorization = `Bearer ${bridgeToken}`;
  let response: Response;
  try {
    response = await fetch(`${base}/api/my-data/self-deletion`, {
      method: "POST",
      headers,
      body: JSON.stringify({ userId: auth.viewer.id, username: auth.viewer.username, avatarUrl: auth.viewer.avatarUrl, ...payload }),
    });
  } catch {
    return { ok: false, error: "unavailable" };
  }
  const body = (await response.json().catch(() => ({}))) as { ok?: unknown; error?: unknown; status?: SelfDeletionStatus | null; scoreIds?: unknown };
  if (!response.ok || body.ok !== true) {
    const error = typeof body.error === "string" ? body.error : "unavailable";
    return { ok: false, error: (["admin_takedown", "already_finalized", "deadline_passed", "user_wiped", "not_requested"].includes(error) ? error : "unavailable") as SelfDeletionError };
  }
  const { forgetUser } = await import("./owner-takedown");
  await forgetUser(auth.viewer.id, auth.viewer.username).catch(() => undefined);
  if (payload.action === "request") {
    // Copies of osu! replays, so dropping them now loses nothing a cancel
    // needs. Not awaited: a long play history is thousands of R2 calls, and
    // the hold that hides the profile has already landed.
    const scoreIds = Array.isArray(body.scoreIds) ? body.scoreIds.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0) : [];
    void (async () => {
      const { deleteCachedScoreReplays } = await import("./r2-cache");
      const { REPLAY_PARSED_CACHE_VERSION, forgetParsedReplays } = await import("./osu/replay");
      await deleteCachedScoreReplays(scoreIds, REPLAY_PARSED_CACHE_VERSION);
      await forgetParsedReplays(scoreIds);
    })().catch(() => undefined);
  }
  return { ok: true, status: body.status ?? null };
}

export const requestSelfDeletion = createServerFn({ method: "POST" })
  .validator((data: { scope?: unknown }) => {
    if (data?.scope !== "profile" && data?.scope !== "account") throw new Error("Invalid scope");
    return { scope: data.scope as SelfDeletionScope };
  })
  .handler(async ({ data }): Promise<SelfDeletionResult> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    return callSelfDeletion({ action: "request", scope: data.scope });
  });

export const cancelSelfDeletion = createServerFn({ method: "POST" }).handler(async (): Promise<SelfDeletionResult> => {
  const { setResponseHeader } = await import("@tanstack/react-start/server");
  setResponseHeader("Cache-Control", "private, no-store");
  return callSelfDeletion({ action: "cancel" });
});
