import { createFileRoute } from "@tanstack/react-router";

/* Starts the Discord connection used by /communities to prove someone runs the
   server they are listing. Mirrors the osu! entry route, with one extra rule:
   there has to be an osu! session already, because the proof is bound to that
   account and a Discord connection on its own has nothing to attach to. */

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

export const Route = createFileRoute("/api/auth/discord")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { normalizeAuthNext, readViewerFromRequest } = await import("#/lib/auth-server");
        const {
          buildDiscordAuthorizeUrl,
          createDiscordStateCookieHeader,
          getDiscordRedirectUri,
          isDiscordOAuthConfigured,
        } = await import("#/lib/discord-auth-server");

        const requestUrl = new URL(request.url);
        const next = normalizeAuthNext(requestUrl.searchParams.get("next"), request);

        if (!isDiscordOAuthConfigured()) {
          return new Response("Discord OAuth is not configured.", { status: 500 });
        }
        const viewer = await readViewerFromRequest(request);
        if (!viewer) {
          return redirectResponse(new URL(`${next}${next.includes("?") ? "&" : "?"}discord=signin`, request.url));
        }
        // The directory is gated, and so is the way into it. Without this a
        // signed-in stranger who found this URL would be shown a real "authorise
        // Mania Hub" screen for a feature they cannot reach, which is a
        // confusing thing to put someone's Discord account in front of.
        const { communityAccessAllowsUserId } = await import("#/lib/communities-shared");
        if (!communityAccessAllowsUserId(viewer.id)) {
          return new Response(null, { status: 404 });
        }

        const clientId = (process.env.DISCORD_CLIENT_ID || process.env.DISCORD_APPLICATION_ID) as string;
        const redirectUri = getDiscordRedirectUri(request);
        const state = crypto.randomUUID();
        const stateCookie = await createDiscordStateCookieHeader({
          state,
          next,
          redirectUri,
          // Pinned here so the callback can refuse a code that comes back to a
          // different osu! session than the one that started the connection.
          osuUserId: viewer.id,
          issuedAt: Date.now(),
        }, request);

        return appendCookies(redirectResponse(buildDiscordAuthorizeUrl(clientId, redirectUri, state)), [stateCookie]);
      },
    },
  },
});
