import { createFileRoute } from "@tanstack/react-router";
import { DISCORD_STATE_COOKIE_NAME } from "#/lib/discord-auth-server";

/* Comes back from Discord, turns the code into a proof, and hands control to
   wherever the connection started. The proof is a short-lived signed cookie
   holding the access token and the osu! account it belongs to; the guild list
   is never stored, only fetched on demand. */

function getCookieFromHeader(cookieHeader: string | null, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (rawKey === name) return decodeURIComponent(rawValue.join("="));
  }
  return undefined;
}

function appendCookies(response: Response, cookies: string[]): Response {
  for (const cookie of cookies) response.headers.append("Set-Cookie", cookie);
  return response;
}

function redirectWithCookies(request: Request, path: string, cookies: string[]): Response {
  return appendCookies(new Response(null, {
    status: 302,
    headers: { Location: new URL(path, request.url).toString() },
  }), cookies);
}

function withFlag(next: string, flag: string): string {
  return `${next}${next.includes("?") ? "&" : "?"}discord=${flag}`;
}

export const Route = createFileRoute("/api/auth/discord/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { normalizeAuthNext, readViewerFromRequest } = await import("#/lib/auth-server");
        const {
          clearDiscordStateCookieHeader,
          createDiscordLinkCookieHeader,
          exchangeDiscordCode,
          readDiscordStateCookie,
        } = await import("#/lib/discord-auth-server");

        const url = new URL(request.url);
        const clearState = clearDiscordStateCookieHeader(request);
        const fallbackNext = normalizeAuthNext(url.searchParams.get("next"), request);
        const stateCookie = await readDiscordStateCookie(
          getCookieFromHeader(request.headers.get("cookie"), DISCORD_STATE_COOKIE_NAME),
        );
        const next = stateCookie?.next ?? fallbackNext;

        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        if (!code || !stateCookie || state !== stateCookie.state) {
          return redirectWithCookies(request, withFlag(next, "failed"), [clearState]);
        }

        // The osu! session must still be the one that started this. Otherwise a
        // connection could be finished into somebody else's session.
        const viewer = await readViewerFromRequest(request);
        if (!viewer || viewer.id !== stateCookie.osuUserId) {
          return redirectWithCookies(request, withFlag(next, "failed"), [clearState]);
        }

        try {
          const identity = await exchangeDiscordCode(code, stateCookie.redirectUri);
          const linkCookie = await createDiscordLinkCookieHeader({
            discordUserId: identity.discordUserId,
            discordUsername: identity.discordUsername,
            discordAvatarUrl: identity.discordAvatarUrl,
            osuUserId: viewer.id,
            accessToken: identity.accessToken,
            issuedAt: Date.now(),
          }, request);
          return redirectWithCookies(request, withFlag(next, "connected"), [linkCookie, clearState]);
        } catch (error) {
          console.warn("[auth] discord connect failed", error);
          return redirectWithCookies(request, withFlag(next, "failed"), [clearState]);
        }
      },
    },
  },
});
