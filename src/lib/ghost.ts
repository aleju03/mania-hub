import { createServerFn } from "@tanstack/react-start";
import { requireAdminAccess } from "./auth";
import { getServerLiveBackendUrl } from "./live-backend";

/* Server fns behind the admin ghost.

   Two tickets, both minted here so no browser ever holds LIVE_ADMIN_TOKEN:

   - the control ticket lets the /admin/ghost page POST movement straight to
     the live backend (a hop through here at 15 Hz would be pure latency);
   - the viewer ticket is a signed statement of "this connection really is osu!
     user N", without which targeting one person would just be a query string
     anyone could edit. */

const VIEWER_TICKET_TTL_MS = 12 * 60 * 60_000;

export interface GhostViewerTicket {
  userId: number;
  username: string;
  expiresAt: number;
  signature: string;
}

async function signGhostViewer(userId: number, username: string, expiresAt: number, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`ghost:${userId}:${username}:${expiresAt}`));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/* Anonymous visitors get null and simply connect unidentified: they can still
   see a ghost aimed at everyone, just never one aimed at a person. */
export const getGhostViewerTicket = createServerFn({ method: "GET" }).handler(async (): Promise<GhostViewerTicket | null> => {
  const { readCurrentAuth } = await import("./auth-server");
  const auth = await readCurrentAuth();
  const secret = process.env.LIVE_ADMIN_TOKEN;
  if (!auth.viewer || !secret) return null;
  const expiresAt = Date.now() + VIEWER_TICKET_TTL_MS;
  return {
    userId: auth.viewer.id,
    username: auth.viewer.username,
    expiresAt,
    signature: await signGhostViewer(auth.viewer.id, auth.viewer.username, expiresAt, secret),
  };
});

export const getGhostControlTicket = createServerFn({ method: "POST" })
  .handler(async (): Promise<{ ticket: string; expiresAt: number } | null> => {
    await requireAdminAccess("Ghost control");
    const base = getServerLiveBackendUrl();
    const token = process.env.LIVE_ADMIN_TOKEN;
    if (!base || !token) return null;
    const response = await fetch(`${base}/api/updates/ticket`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, connection: "close" },
    });
    if (!response.ok) return null;
    return await response.json() as { ticket: string; expiresAt: number };
  });
