import { createServerFn } from "@tanstack/react-start";

/* The signed half of "show my name under spectators".

   The presence stream is an EventSource, so it cannot carry a header and the
   backend cannot ask who is on the other end. Without a signature a username
   drawn on a stranger's screen would be whatever the query string said, so the
   name travels as a short-lived ticket minted here from the osu!-verified
   session and signed with the token only the two servers hold (the same scheme
   the ghost overlay uses for viewer identity). */

const SPECTATOR_TICKET_TTL_MS = 12 * 60 * 60_000;

export interface ReplaySpectatorTicket {
  userId: number;
  username: string;
  expiresAt: number;
  signature: string;
}

async function signReplaySpectator(
  userId: number,
  username: string,
  expiresAt: number,
  secret: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`spectator:${userId}:${username}:${expiresAt}`),
  );
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/* Signed-out visitors get null and simply watch anonymously, which is also
   what every viewer who left the setting off does. */
export const getReplaySpectatorTicket = createServerFn({ method: "GET" }).handler(
  async (): Promise<ReplaySpectatorTicket | null> => {
    const { readCurrentAuth } = await import("./auth-server");
    const auth = await readCurrentAuth();
    const secret = process.env.LIVE_ADMIN_TOKEN;
    if (!auth.viewer || !secret) return null;
    const expiresAt = Date.now() + SPECTATOR_TICKET_TTL_MS;
    return {
      userId: auth.viewer.id,
      username: auth.viewer.username,
      expiresAt,
      signature: await signReplaySpectator(auth.viewer.id, auth.viewer.username, expiresAt, secret),
    };
  },
);
