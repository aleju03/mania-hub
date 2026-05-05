import { createFileRoute } from "@tanstack/react-router";
import {
  clearAuthCookieHeader,
  clearOAuthStateCookieHeader,
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

export const Route = createFileRoute("/api/auth/logout")({
  server: {
    handlers: {
      GET: async ({ request }) => {
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
