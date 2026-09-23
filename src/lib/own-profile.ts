import { createServerFn } from "@tanstack/react-start";

import { bridgeAuthHeaders } from "./live-backend-tokens";

/* What a player writes on their own profile: a restricted player's About page
   (live-backend features/own-about.ts), and anyone's links to their private
   server profiles (features/server-links.ts). The viewer comes from the login cookie,
   never from the browser, so a player can only ever edit their own. */

export interface ServerLink {
  server: string;
  url: string;
}

export type OwnAboutResult =
  | { ok: true; raw: string | null; updatedAt: string }
  | { ok: false; error: "not_eligible" | "too_long" | "unavailable" };

export type ServerLinkResult =
  | { ok: true; links: ServerLink[] }
  | { ok: false; error: "not_eligible" | "unknown_server" | "invalid_url" | "unavailable" };

async function postAsViewer<T extends { ok: boolean }>(path: string, body: Record<string, unknown>): Promise<T | { ok: false; error: "not_eligible" | "unavailable" }> {
  const { readCurrentAuth } = await import("./auth-server");
  const auth = await readCurrentAuth();
  if (!auth.viewer) return { ok: false, error: "not_eligible" };
  const base = (process.env.LIVE_BACKEND_URL || process.env.VITE_LIVE_BACKEND_URL)?.trim().replace(/\/$/, "");
  if (!base) return { ok: false, error: "unavailable" };
  try {
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: bridgeAuthHeaders(true),
      body: JSON.stringify({ userId: auth.viewer.id, ...body }),
    });
    const result = await response.json().catch(() => null) as T | null;
    return result && typeof result.ok === "boolean" ? result : { ok: false, error: "unavailable" };
  } catch {
    return { ok: false, error: "unavailable" };
  }
}

export const setMyOwnAbout = createServerFn({ method: "POST" })
  .validator((data: { raw?: unknown }) => ({
    raw: typeof data?.raw === "string" ? data.raw.slice(0, 60_001) : "",
  }))
  .handler(async ({ data }) => postAsViewer<OwnAboutResult>("/api/session/about", { raw: data.raw }) as Promise<OwnAboutResult>);

export const setMyServerLink = createServerFn({ method: "POST" })
  .validator((data: { server?: unknown; url?: unknown }) => ({
    server: typeof data?.server === "string" ? data.server.slice(0, 40) : "",
    url: typeof data?.url === "string" ? data.url.slice(0, 300) : "",
  }))
  .handler(async ({ data }) => postAsViewer<ServerLinkResult>("/api/session/server-link", data) as Promise<ServerLinkResult>);
