// Server handlers for /api/auth/logout, kept out of the route file so they can
// be tested with plain Request objects (no TanStack server context).
//
// Logout is POST-only and same-origin only. The auth cookie is SameSite=Lax,
// which still travels on a top-level GET navigation, so a bare <a href> on an
// attacker's page used to be enough to force-log-out a visitor. POST stops the
// cookie from being sent cross-site, but a cross-site form submit is still a
// top-level navigation whose Set-Cookie would apply — hence the origin check
// as well.

import {
  clearAuthCookieHeader,
  clearOAuthStateCookieHeader,
  normalizeAuthNext,
} from "./auth-server";
import { isSameOriginRequest } from "./origin";

export function handleAuthLogoutPost(request: Request): Response {
  if (!isSameOriginRequest(request)) {
    return new Response(null, { status: 403 });
  }
  const url = new URL(request.url);
  const next = normalizeAuthNext(url.searchParams.get("next"), request);
  // 303, not 302: it mandates that the browser follow up with a GET instead of
  // replaying the POST against the redirect target.
  const response = new Response(null, {
    status: 303,
    headers: { Location: new URL(next, request.url).toString() },
  });
  for (const cookie of [clearAuthCookieHeader(request), clearOAuthStateCookieHeader(request)]) {
    response.headers.append("Set-Cookie", cookie);
  }
  return response;
}

// Explicit, so a bookmarked GET gets a clean 405 instead of falling through to
// the SPA router and rendering a 404 page.
export function handleAuthLogoutGet(): Response {
  return new Response(null, { status: 405, headers: { Allow: "POST" } });
}
