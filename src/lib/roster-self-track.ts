import { createServerFn } from "@tanstack/react-start";
import { liveBridgeToken } from "./live-backend-tokens";

// Server functions letting a logged-in user opt their own osu! account into their country's
// roster so their plays get tracked (activity, recent timeline) even when they are not in the
// top 100. The viewer always comes from the osu! login cookie, never from client input, so a
// user can only ever add or remove themselves. The backend route is bridge-token gated; that
// token only exists server-side. Mirrors the pack-wallet-sync bridge.

export type RosterSelfTrackStatus =
  | "added"
  | "already_member"
  | "already_ranked"
  | "removed"
  | "not_member"
  | "country_not_tracked"
  | "country_full"
  | "unavailable";

export interface RosterSelfTrackResult {
  ok: boolean;
  status: RosterSelfTrackStatus;
  country: string | null;
}

async function callRosterAction(action: "self-add" | "self-remove"): Promise<RosterSelfTrackResult> {
  const { readCurrentAuth } = await import("./auth-server");
  const auth = await readCurrentAuth();
  if (!auth.viewer) return { ok: false, status: "unavailable", country: null };
  const country = auth.viewer.countryCode?.trim().toUpperCase() ?? "";
  const base = (process.env.LIVE_BACKEND_URL || process.env.VITE_LIVE_BACKEND_URL)?.trim().replace(/\/$/, "");
  if (!base || !/^[A-Z]{2}$/.test(country)) {
    return { ok: false, status: "unavailable", country: country || null };
  }
  const headers: HeadersInit = { "content-type": "application/json" };
  const bridgeToken = liveBridgeToken();
  if (bridgeToken) {
    headers.authorization = `Bearer ${bridgeToken}`;
  }
  let response: Response;
  try {
    response = await fetch(`${base}/api/roster/${action}`, {
      method: "POST",
      headers,
      // userId comes from the verified cookie, not from anything the browser sent.
      body: JSON.stringify({ userId: auth.viewer.id, country }),
    });
  } catch {
    return { ok: false, status: "unavailable", country };
  }
  const body = (await response.json().catch(() => ({}))) as { ok?: unknown; status?: unknown; country?: unknown };
  return {
    ok: response.ok && body.ok === true,
    status: (typeof body.status === "string" ? body.status : "unavailable") as RosterSelfTrackStatus,
    country: typeof body.country === "string" ? body.country : country,
  };
}

export const addSelfToRoster = createServerFn({ method: "POST" }).handler(
  async (): Promise<RosterSelfTrackResult> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    return callRosterAction("self-add");
  },
);

export const removeSelfFromRoster = createServerFn({ method: "POST" }).handler(
  async (): Promise<RosterSelfTrackResult> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    return callRosterAction("self-remove");
  },
);
