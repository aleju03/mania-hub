import { authCookieOptions, serializeCookie, signJson, verifySignedJson } from "./auth-server";
import { getServerLiveBackendUrl } from "./live-backend";
import { bridgeAuthHeaders } from "./live-backend-tokens";
import { getCanonicalOrigin } from "./origin";

/*
 * Connecting a player's Patreon so their membership gives them supporter
 * time (backend features/patreon.ts). Not a login: the OAuth round trip ends
 * with the backend tying the Patreon user to the osu! account that started
 * it. The client secret lives only in the backend, which builds the
 * authorize URL and exchanges the code; this side keeps the state cookie,
 * bound to the osu! account, so a code cannot land in another session.
 */

export const PATREON_STATE_COOKIE_NAME = "mania-hub-patreon-state-v1";
const PATREON_STATE_MAX_AGE_SECONDS = 10 * 60;

export interface PatreonStatePayload {
  state: string;
  next: string;
  redirectUri: string;
  osuUserId: number;
  issuedAt: number;
}

export function getPatreonRedirectUri(request: Request): string {
  // Not request.url: behind the TLS proxy that is the internal http:// origin,
  // and Patreon only accepts a redirect it has registered.
  return `${getCanonicalOrigin(request)}/api/auth/patreon/callback`;
}

export async function createPatreonStateCookieHeader(payload: PatreonStatePayload, request: Request): Promise<string> {
  return serializeCookie(PATREON_STATE_COOKIE_NAME, await signJson(payload), authCookieOptions(request, PATREON_STATE_MAX_AGE_SECONDS));
}

export async function readPatreonStateCookie(raw: string | undefined): Promise<PatreonStatePayload | null> {
  const payload = await verifySignedJson<Partial<PatreonStatePayload>>(raw);
  if (
    !payload ||
    typeof payload.state !== "string" ||
    typeof payload.next !== "string" ||
    typeof payload.redirectUri !== "string" ||
    typeof payload.osuUserId !== "number" ||
    typeof payload.issuedAt !== "number"
  ) {
    return null;
  }
  if (Date.now() - payload.issuedAt > PATREON_STATE_MAX_AGE_SECONDS * 1000) return null;
  return payload as PatreonStatePayload;
}

export function clearPatreonStateCookieHeader(request: Request): string {
  return serializeCookie(PATREON_STATE_COOKIE_NAME, "", { ...authCookieOptions(request, 0), expires: new Date(0) });
}

/** Patreon's authorize URL from the backend, or null when Patreon is not set up there. */
export async function fetchPatreonAuthorizeUrl(redirectUri: string, state: string): Promise<string | null> {
  const base = getServerLiveBackendUrl();
  if (!base) return null;
  const query = new URLSearchParams({ redirectUri, state });
  const response = await fetch(`${base}/api/supporters/self/patreon/authorize?${query}`, { headers: bridgeAuthHeaders() });
  if (!response.ok) return null;
  const body = await response.json().catch(() => null) as { url?: unknown } | null;
  return typeof body?.url === "string" ? body.url : null;
}

export type PatreonConnectOutcome = "connected" | "linked_elsewhere" | "failed";

/** Hands the code to the backend, which ties the Patreon user to this osu! account. */
export async function finishPatreonConnect(userId: number, username: string, code: string, redirectUri: string): Promise<PatreonConnectOutcome> {
  const base = getServerLiveBackendUrl();
  if (!base) return "failed";
  const response = await fetch(`${base}/api/supporters/self/patreon`, {
    method: "POST",
    headers: bridgeAuthHeaders(true),
    body: JSON.stringify({ userId, username, code, redirectUri }),
  });
  const body = await response.json().catch(() => null) as { ok?: unknown; error?: unknown } | null;
  if (response.ok && body?.ok === true) return "connected";
  return body?.error === "linked_elsewhere" ? "linked_elsewhere" : "failed";
}
