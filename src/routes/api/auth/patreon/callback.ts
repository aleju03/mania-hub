import { createFileRoute } from "@tanstack/react-router";
import { PATREON_STATE_COOKIE_NAME } from "#/lib/patreon-auth-server";

/* Comes back from Patreon and hands the code to the backend, which ties the
   Patreon user to the osu! account that started the connection. */

function getCookieFromHeader(cookieHeader: string | null, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (rawKey === name) return decodeURIComponent(rawValue.join("="));
  }
  return undefined;
}

function redirectWithCookies(request: Request, path: string, cookies: string[]): Response {
  const response = new Response(null, { status: 302, headers: { Location: new URL(path, request.url).toString() } });
  for (const cookie of cookies) response.headers.append("Set-Cookie", cookie);
  return response;
}

function withFlag(next: string, flag: string): string {
  return `${next}${next.includes("?") ? "&" : "?"}patreon=${flag}`;
}

export const Route = createFileRoute("/api/auth/patreon/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { normalizeAuthNext, readViewerFromRequest } = await import("#/lib/auth-server");
        const { clearPatreonStateCookieHeader, finishPatreonConnect, readPatreonStateCookie } = await import("#/lib/patreon-auth-server");

        const url = new URL(request.url);
        const clearState = clearPatreonStateCookieHeader(request);
        const stateCookie = await readPatreonStateCookie(getCookieFromHeader(request.headers.get("cookie"), PATREON_STATE_COOKIE_NAME));
        const next = stateCookie?.next ?? normalizeAuthNext("/support", request);

        const code = url.searchParams.get("code");
        if (!code || !stateCookie || url.searchParams.get("state") !== stateCookie.state) {
          return redirectWithCookies(request, withFlag(next, "failed"), [clearState]);
        }
        // Still the osu! session that started this, or the Patreon user could
        // be tied to somebody else's account.
        const viewer = await readViewerFromRequest(request);
        if (!viewer || viewer.id !== stateCookie.osuUserId) {
          return redirectWithCookies(request, withFlag(next, "failed"), [clearState]);
        }

        try {
          const outcome = await finishPatreonConnect(viewer.id, viewer.username, code, stateCookie.redirectUri);
          return redirectWithCookies(request, withFlag(next, outcome), [clearState]);
        } catch (error) {
          console.warn("[auth] patreon connect failed", error);
          return redirectWithCookies(request, withFlag(next, "failed"), [clearState]);
        }
      },
    },
  },
});
