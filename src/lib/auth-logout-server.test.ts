import { beforeAll, describe, expect, it } from "vitest";
import { handleAuthLogoutGet, handleAuthLogoutPost } from "./auth-logout-server";

const ORIGIN = "https://mania-tracker.com";

function logoutRequest(next?: string, fetchSite: string | null = "same-origin"): Request {
  const url = new URL(`${ORIGIN}/api/auth/logout`);
  if (next != null) url.searchParams.set("next", next);
  return new Request(url, {
    method: "POST",
    headers: fetchSite ? { "sec-fetch-site": fetchSite } : {},
  });
}

function setCookies(response: Response): string[] {
  return response.headers.getSetCookie();
}

beforeAll(() => {
  process.env.AUTH_SESSION_SECRET = "vitest-logout-secret-vitest-logout-secret";
});

describe("logout GET", () => {
  it("405s a bookmarked GET and advertises POST", () => {
    const response = handleAuthLogoutGet();
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(setCookies(response)).toEqual([]);
  });
});

describe("logout POST", () => {
  it("rejects cross-site and same-site submits without clearing anything", () => {
    for (const fetchSite of ["cross-site", "same-site", "none"]) {
      const response = handleAuthLogoutPost(logoutRequest("/rankings", fetchSite));
      expect(response.status, fetchSite).toBe(403);
      // The forged submit must not be able to log the visitor out.
      expect(setCookies(response), fetchSite).toEqual([]);
      expect(response.headers.get("location"), fetchSite).toBeNull();
    }
  });

  it("rejects a submit with no origin signal at all", () => {
    const response = handleAuthLogoutPost(logoutRequest("/rankings", null));
    expect(response.status).toBe(403);
    expect(setCookies(response)).toEqual([]);
  });

  it("clears both auth cookies and redirects with 303", () => {
    const response = handleAuthLogoutPost(logoutRequest("/rankings?country=CR"));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/rankings?country=CR`);

    const cookies = setCookies(response);
    expect(cookies).toHaveLength(2);
    expect(cookies.map((cookie) => cookie.split("=")[0])).toEqual([
      "mania-hub-auth-v1",
      "mania-hub-oauth-state-v1",
    ]);
    for (const cookie of cookies) {
      expect(cookie).toContain("Max-Age=0");
      expect(cookie).toContain("Expires=Thu, 01 Jan 1970");
      expect(cookie).toContain("Path=/");
      expect(cookie).toContain("HttpOnly");
    }
  });

  it("clamps an off-origin next back to the site root", () => {
    // Off-host, protocol-relative, and same-host-wrong-scheme all resolve to a
    // foreign origin, so normalizeAuthNext drops them.
    // The fourth form keeps the site's own origin, so only the leading `//`
    // left on the pathname gives it away; resolved against request.url it is
    // protocol-relative and would land on evil.example.
    for (const next of [
      "https://evil.example/steal",
      "//evil.example/steal",
      "http://mania-tracker.com/steal",
      "https://mania-tracker.com//evil.example/steal",
    ]) {
      const response = handleAuthLogoutPost(logoutRequest(next));
      expect(response.status, next).toBe(303);
      expect(response.headers.get("location"), next).toBe(`${ORIGIN}/`);
      expect(setCookies(response), next).toHaveLength(2);
    }
  });

  it("defaults to the site root when next is missing", () => {
    const response = handleAuthLogoutPost(logoutRequest());
    expect(response.headers.get("location")).toBe(`${ORIGIN}/`);
  });
});
