import { createServerFn } from "@tanstack/react-start";
import { liveBridgeToken } from "./live-backend-tokens";

/* The signed-in player's Mamestagram link, which lets "Add a missing score"
   take that account's Mamestagram plays. The account is the one the player's
   Mamestagram profile link (ServerLinks) points at. Server functions like the
   wishlist's: the viewer comes from the osu! login cookie, never from client
   input, and the backend route only answers the bridge token. */

export interface MamesLink {
  /* What the player puts on their Mamestagram userpage to prove the account. */
  code: string;
  mamesUserId: number | null;
  mamesName: string | null;
  verifiedAt: string | null;
}

export type MamesLinkError =
  | "no_profile_link"
  | "code_missing"
  | "mames_player_not_found"
  | "mames_taken"
  | "mames_unavailable"
  | "rate_limited"
  | "failed";

export type MamesLinkResult = { ok: true; link: MamesLink } | { ok: false; error: MamesLinkError };

const LINK_ERRORS = new Set<MamesLinkError>(["no_profile_link", "code_missing", "mames_player_not_found", "mames_taken", "mames_unavailable", "rate_limited"]);

async function getLinkTarget(): Promise<{ url: string; headers: HeadersInit } | null> {
  const { readCurrentAuth } = await import("./auth-server");
  const auth = await readCurrentAuth();
  if (!auth.viewer) return null;
  const base = process.env.LIVE_BACKEND_URL?.trim().replace(/\/$/, "");
  if (!base) return null;
  const headers: HeadersInit = { "content-type": "application/json" };
  const bridgeToken = liveBridgeToken();
  if (bridgeToken) headers.authorization = `Bearer ${bridgeToken}`;
  return { url: `${base}/api/mamestagram/link/${auth.viewer.id}`, headers };
}

function parseLink(value: unknown): MamesLink | null {
  const link = (value as { link?: Partial<MamesLink> } | null)?.link;
  if (!link || typeof link.code !== "string") return null;
  return {
    code: link.code,
    mamesUserId: typeof link.mamesUserId === "number" ? link.mamesUserId : null,
    mamesName: typeof link.mamesName === "string" ? link.mamesName : null,
    verifiedAt: typeof link.verifiedAt === "string" ? link.verifiedAt : null,
  };
}

/* Null when signed out or without a backend. */
export const fetchOwnMamesLink = createServerFn({ method: "GET" }).handler(async (): Promise<MamesLink | null> => {
  const { setResponseHeader } = await import("@tanstack/react-start/server");
  setResponseHeader("Cache-Control", "private, no-store");
  const target = await getLinkTarget();
  if (!target) return null;
  const response = await fetch(target.url, { headers: target.headers });
  if (!response.ok) throw new Error(`Mamestagram link fetch failed (${response.status}).`);
  return parseLink(await response.json());
});

export const changeOwnMamesLink = createServerFn({ method: "POST" })
  .validator((input: { action?: unknown }) => {
    const action = input?.action === "unlink" ? "unlink" : input?.action === "verify" ? "verify" : null;
    if (!action) throw new Error("Invalid Mamestagram link change.");
    return { action };
  })
  .handler(async ({ data }): Promise<MamesLinkResult> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    const target = await getLinkTarget();
    if (!target) return { ok: false, error: "failed" };
    const response = await fetch(target.url, { method: "POST", headers: target.headers, body: JSON.stringify(data) });
    const body = await response.json().catch(() => null) as { error?: unknown } | null;
    if (!response.ok) {
      const error = typeof body?.error === "string" && LINK_ERRORS.has(body.error as MamesLinkError) ? body.error as MamesLinkError
        : response.status === 429 ? "rate_limited" : "failed";
      return { ok: false, error };
    }
    const link = parseLink(body);
    return link ? { ok: true, link } : { ok: false, error: "failed" };
  });
