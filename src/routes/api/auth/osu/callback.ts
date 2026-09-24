import { createFileRoute } from "@tanstack/react-router";
import { waitUntil } from "@vercel/functions";
import { AUTH_STATE_COOKIE_NAME, type AuthViewer } from "#/lib/auth-shared";
import { bridgeAuthHeaders, liveBridgeToken } from "#/lib/live-backend-tokens";

const SIGN_IN_RECORD_TIMEOUT_MS = 5_000;

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

/* Adds the account to the backend's list of osu! accounts that have signed in
   (id, name, osu! country, first and last sign-in). Best effort: a backend
   that is down must never cost anyone their login. */
function recordSignIn(viewer: AuthViewer): void {
  const base = (process.env.LIVE_BACKEND_URL ?? process.env.VITE_LIVE_BACKEND_URL)?.replace(/\/+$/, "");
  if (!base || !liveBridgeToken()) return;
  waitUntil(
    fetch(`${base}/api/analytics/sign-in`, {
      method: "POST",
      headers: bridgeAuthHeaders(true),
      body: JSON.stringify({ id: viewer.id, username: viewer.username, country: viewer.countryCode }),
      signal: AbortSignal.timeout(SIGN_IN_RECORD_TIMEOUT_MS),
    }).then(() => undefined, () => undefined),
  );
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
          recordSignIn(viewer);
          return redirectWithCookies(request, next, [authCookie, clearState]);
        } catch (error) {
          console.warn("[auth] osu login failed", error);
          return redirectWithCookies(request, `${next}${next.includes("?") ? "&" : "?"}auth=failed`, [clearState]);
        }
      },
    },
  },
});
