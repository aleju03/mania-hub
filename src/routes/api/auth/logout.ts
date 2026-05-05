import { createFileRoute } from "@tanstack/react-router";

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

export const Route = createFileRoute("/api/auth/logout")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const {
          clearAuthCookieHeader,
          clearOAuthStateCookieHeader,
          normalizeAuthNext,
        } = await import("#/lib/auth-server");
        const url = new URL(request.url);
        const next = normalizeAuthNext(url.searchParams.get("next"), request);
        return appendCookies(redirectResponse(new URL(next, request.url)), [
          clearAuthCookieHeader(request),
          clearOAuthStateCookieHeader(request),
        ]);
      },
    },
  },
});
