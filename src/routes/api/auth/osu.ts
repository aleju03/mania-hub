import { createFileRoute } from "@tanstack/react-router";
import {
  createOAuthStateCookieHeader,
  getAuthRedirectUri,
  normalizeAuthNext,
} from "#/lib/auth";

function appendCookies(response: Response, cookies: string[]): Response {
  for (const cookie of cookies) response.headers.append("Set-Cookie", cookie);
  return response;
}

function redirectResponse(url: string | URL): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: url.toString() },
  });
}

export const Route = createFileRoute("/api/auth/osu")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const clientId = process.env.OSU_CLIENT_ID;
        const clientSecret = process.env.OSU_CLIENT_SECRET;
        if (!clientId || !clientSecret) {
          return new Response("osu! OAuth is not configured.", { status: 500 });
        }

        const requestUrl = new URL(request.url);
        const redirectUri = getAuthRedirectUri(request);
        const state = crypto.randomUUID();
        const next = normalizeAuthNext(requestUrl.searchParams.get("next"), request);
        const stateCookie = await createOAuthStateCookieHeader({
          state,
          next,
          redirectUri,
          issuedAt: Date.now(),
        }, request);

        const authorizeUrl = new URL("https://osu.ppy.sh/oauth/authorize");
        authorizeUrl.searchParams.set("client_id", clientId);
        authorizeUrl.searchParams.set("redirect_uri", redirectUri);
        authorizeUrl.searchParams.set("response_type", "code");
        authorizeUrl.searchParams.set("scope", "identify public");
        authorizeUrl.searchParams.set("state", state);

        return appendCookies(redirectResponse(authorizeUrl), [stateCookie]);
      },
    },
  },
});
