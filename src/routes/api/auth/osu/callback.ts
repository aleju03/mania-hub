import { createFileRoute } from "@tanstack/react-router";
import { AUTH_STATE_COOKIE_NAME } from "#/lib/auth-shared";

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

export const Route = createFileRoute("/api/auth/osu/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const {
          clearOAuthStateCookieHeader,
          createAuthCookieHeader,
          exchangeOsuCodeForViewer,
          normalizeAuthNext,
          readOAuthStateCookie,
        } = await import("#/lib/auth-server");
        const url = new URL(request.url);
        const clearState = clearOAuthStateCookieHeader(request);
        const fallbackNext = normalizeAuthNext(url.searchParams.get("next"), request);
        const stateCookie = await readOAuthStateCookie(
          getCookieFromHeader(request.headers.get("cookie"), AUTH_STATE_COOKIE_NAME),
        );
        const next = stateCookie?.next ?? fallbackNext;

        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        if (!code || !stateCookie || state !== stateCookie.state) {
          return redirectWithCookies(request, `${next}${next.includes("?") ? "&" : "?"}auth=failed`, [clearState]);
        }

        try {
          const viewer = await exchangeOsuCodeForViewer(code, stateCookie.redirectUri);
          const authCookie = await createAuthCookieHeader(viewer, request);
          return redirectWithCookies(request, next, [authCookie, clearState]);
        } catch (error) {
          console.warn("[auth] osu login failed", error);
          return redirectWithCookies(request, `${next}${next.includes("?") ? "&" : "?"}auth=failed`, [clearState]);
        }
      },
    },
  },
});
