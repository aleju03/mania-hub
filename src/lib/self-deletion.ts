import { createServerFn } from "@tanstack/react-start";

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

export const requestSelfDeletion = createServerFn({ method: "POST" })
  .validator((data: { scope?: unknown }) => {
    if (data?.scope !== "profile" && data?.scope !== "account") throw new Error("Invalid scope");
    return { scope: data.scope as SelfDeletionScope };
  })
  .handler(async ({ data }): Promise<SelfDeletionResult> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    const { callSelfDeletion } = await import("./self-deletion-server");
    return callSelfDeletion({ action: "request", scope: data.scope });
  });

export const cancelSelfDeletion = createServerFn({ method: "POST" }).handler(async (): Promise<SelfDeletionResult> => {
  const { setResponseHeader } = await import("@tanstack/react-start/server");
  setResponseHeader("Cache-Control", "private, no-store");
  const { callSelfDeletion } = await import("./self-deletion-server");
  return callSelfDeletion({ action: "cancel" });
});
