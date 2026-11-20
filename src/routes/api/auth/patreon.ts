import { createFileRoute } from "@tanstack/react-router";

/* Starts connecting a player's Patreon (src/lib/patreon-auth-server.ts). Needs
   an osu! session first: the Patreon user is tied to that account. */

function redirectResponse(url: string | URL, cookies: string[] = []): Response {
  const response = new Response(null, { status: 302, headers: { Location: url.toString() } });
  for (const cookie of cookies) response.headers.append("Set-Cookie", cookie);
  return response;
}

function withFlag(next: string, flag: string): string {
  return `${next}${next.includes("?") ? "&" : "?"}patreon=${flag}`;
}

export const Route = createFileRoute("/api/auth/patreon")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { normalizeAuthNext, readViewerFromRequest } = await import("#/lib/auth-server");
        const { createPatreonStateCookieHeader, fetchPatreonAuthorizeUrl, getPatreonRedirectUri } = await import("#/lib/patreon-auth-server");

        const next = normalizeAuthNext(new URL(request.url).searchParams.get("next"), request);
        const viewer = await readViewerFromRequest(request);
        if (!viewer) return redirectResponse(new URL(withFlag(next, "signin"), request.url));

        const redirectUri = getPatreonRedirectUri(request);
        const state = crypto.randomUUID();
        const authorizeUrl = await fetchPatreonAuthorizeUrl(redirectUri, state);
        if (!authorizeUrl) return redirectResponse(new URL(withFlag(next, "failed"), request.url));

        const stateCookie = await createPatreonStateCookieHeader({ state, next, redirectUri, osuUserId: viewer.id, issuedAt: Date.now() }, request);
        return redirectResponse(authorizeUrl, [stateCookie]);
      },
    },
  },
});
