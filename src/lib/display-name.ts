import { createServerFn } from "@tanstack/react-start";

import { bridgeAuthHeaders } from "./live-backend-tokens";

/* A restricted player's own name for their profile (live-backend
   features/display-names.ts). The viewer comes from the login cookie, never
   from the browser, so a player can only ever name themselves. */

export type DisplayNameError = "not_eligible" | "invalid_name" | "name_taken" | "too_soon" | "unavailable";

export type DisplayNameResult =
  | { ok: true; displayName: string | null; nextChangeAt: string }
  | { ok: false; error: DisplayNameError; nextChangeAt?: string };

export const setMyDisplayName = createServerFn({ method: "POST" })
  .validator((data: { displayName?: unknown }) => ({
    displayName: typeof data?.displayName === "string" ? data.displayName.slice(0, 40) : "",
  }))
  .handler(async ({ data }): Promise<DisplayNameResult> => {
    const { readCurrentAuth } = await import("./auth-server");
    const auth = await readCurrentAuth();
    if (!auth.viewer) return { ok: false, error: "not_eligible" };
    const base = (process.env.LIVE_BACKEND_URL || process.env.VITE_LIVE_BACKEND_URL)?.trim().replace(/\/$/, "");
    if (!base) return { ok: false, error: "unavailable" };
    try {
      const response = await fetch(`${base}/api/session/display-name`, {
        method: "POST",
        headers: bridgeAuthHeaders(true),
        body: JSON.stringify({ userId: auth.viewer.id, displayName: data.displayName }),
      });
      const body = await response.json().catch(() => null) as DisplayNameResult | null;
      return body && typeof body.ok === "boolean" ? body : { ok: false, error: "unavailable" };
    } catch {
      return { ok: false, error: "unavailable" };
    }
  });
