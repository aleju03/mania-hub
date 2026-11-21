import { createServerFn } from "@tanstack/react-start";
import { liveBridgeToken } from "./live-backend-tokens";
import type { LivePrivateServer } from "./live-backend";

/* The signed-in player's link to their account on a private server
   (Mamestagram, Torii, ppy.sb), which lets "Add a missing score" take that account's
   plays. The account is the one the player's profile link for that server
   (ServerLinks) points at. Server functions like the wishlist's: the viewer
   comes from the osu! login cookie, never from client input, and the backend
   route only answers the bridge token. */

export interface ServerAccountLink {
  /* What the player puts on their userpage on that server to prove the account. */
  code: string;
  accountName: string | null;
  verifiedAt: string | null;
}

export type ServerAccountLinkError =
  | "no_profile_link"
  | "code_missing"
  | "player_not_found"
  | "taken"
  | "unavailable"
  | "rate_limited"
  | "failed";

export type ServerAccountLinkResult = { ok: true; link: ServerAccountLink } | { ok: false; error: ServerAccountLinkError };

/* The backend's codes carry the server's prefix (mames_taken, torii_taken). */
function readError(value: unknown): ServerAccountLinkError | null {
  if (typeof value !== "string") return null;
  if (value === "no_profile_link" || value === "code_missing" || value === "rate_limited") return value;
  const bare = value.replace(/^(mames|torii|ppysb)_/, "");
  return bare === "player_not_found" || bare === "taken" || bare === "unavailable" ? bare : null;
}

function readServer(value: unknown): LivePrivateServer {
  if (value === "mamestagram" || value === "torii" || value === "ppysb") return value;
  throw new Error("Unknown private server.");
}

async function getLinkTarget(server: LivePrivateServer): Promise<{ url: string; headers: HeadersInit } | null> {
  const { readCurrentAuth } = await import("./auth-server");
  const auth = await readCurrentAuth();
  if (!auth.viewer) return null;
  const base = process.env.LIVE_BACKEND_URL?.trim().replace(/\/$/, "");
  if (!base) return null;
  const headers: HeadersInit = { "content-type": "application/json" };
  const bridgeToken = liveBridgeToken();
  if (bridgeToken) headers.authorization = `Bearer ${bridgeToken}`;
  return { url: `${base}/api/${server}/link/${auth.viewer.id}`, headers };
}

function parseLink(value: unknown): ServerAccountLink | null {
  const link = (value as { link?: Record<string, unknown> } | null)?.link;
  if (!link || typeof link.code !== "string") return null;
  const name = link.mamesName ?? link.toriiName ?? link.accountName;
  return {
    code: link.code,
    accountName: typeof name === "string" ? name : null,
    verifiedAt: typeof link.verifiedAt === "string" ? link.verifiedAt : null,
  };
}

/* Null when signed out or without a backend. */
export const fetchOwnServerLink = createServerFn({ method: "GET" })
  .validator((input: { server?: unknown }) => ({ server: readServer(input?.server) }))
  .handler(async ({ data }): Promise<ServerAccountLink | null> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    const target = await getLinkTarget(data.server);
    if (!target) return null;
    const response = await fetch(target.url, { headers: target.headers });
    if (!response.ok) throw new Error(`Private server link fetch failed (${response.status}).`);
    return parseLink(await response.json());
  });

export const changeOwnServerLink = createServerFn({ method: "POST" })
  .validator((input: { server?: unknown; action?: unknown }) => {
    const action = input?.action === "unlink" ? "unlink" : input?.action === "verify" ? "verify" : null;
    if (!action) throw new Error("Invalid private server link change.");
    return { server: readServer(input?.server), action };
  })
  .handler(async ({ data }): Promise<ServerAccountLinkResult> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    const target = await getLinkTarget(data.server);
    if (!target) return { ok: false, error: "failed" };
    const response = await fetch(target.url, { method: "POST", headers: target.headers, body: JSON.stringify({ action: data.action }) });
    const body = await response.json().catch(() => null) as { error?: unknown } | null;
    if (!response.ok) {
      return { ok: false, error: readError(body?.error) ?? (response.status === 429 ? "rate_limited" : "failed") };
    }
    const link = parseLink(body);
    return link ? { ok: true, link } : { ok: false, error: "failed" };
  });
