import { afterEach, describe, expect, it, vi } from "vitest";

import { getAssetOrigin, getCanonicalOrigin } from "./origin";

function request(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { headers });
}

/** What a request looks like once Caddy has terminated TLS: the connection to
    the node server is plain http, and only the forwarded headers say otherwise. */
function proxied(host: string): Request {
  return request(`http://127.0.0.1:3000/`, {
    "x-forwarded-host": host,
    "x-forwarded-proto": "https",
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getCanonicalOrigin", () => {
  it("prefers an explicitly configured SITE_URL over anything the request says", () => {
    vi.stubEnv("SITE_URL", "https://example.test");
    expect(getCanonicalOrigin(proxied("mania-tracker.com"))).toBe("https://example.test");
  });

  it("collapses the primary hosts onto the canonical production origin", () => {
    vi.stubEnv("SITE_URL", "");
    expect(getCanonicalOrigin(proxied("mania-tracker.com"))).toBe("https://mania-tracker.com");
    expect(getCanonicalOrigin(proxied("www.mania-tracker.com"))).toBe("https://mania-tracker.com");
  });

  // The regression that prompted these tests: ninja is where dev/admin features
  // live and it registers its own osu! redirect uri, so rewriting it to the
  // production alias breaks login there.
  it("keeps ninja on its own origin even when the Vercel production alias is set", () => {
    vi.stubEnv("SITE_URL", "");
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "mania-tracker.com");
    expect(getCanonicalOrigin(proxied("ninja.mania-tracker.com"))).toBe(
      "https://ninja.mania-tracker.com",
    );
  });

  it("still routes throwaway preview hosts to the production alias", () => {
    vi.stubEnv("SITE_URL", "");
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "mania-tracker.com");
    expect(getCanonicalOrigin(proxied("some-preview-abc123.vercel.app"))).toBe(
      "https://mania-tracker.com",
    );
  });

  it("derives https from the forwarded proto rather than the internal http hop", () => {
    vi.stubEnv("SITE_URL", "");
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "");
    expect(getCanonicalOrigin(proxied("ninja.mania-tracker.com"))).toMatch(/^https:/);
  });

  it("ignores a host it does not recognise", () => {
    vi.stubEnv("SITE_URL", "");
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "mania-tracker.com");
    expect(getCanonicalOrigin(proxied("attacker.example"))).toBe("https://mania-tracker.com");
  });
});

/* Every font and sprite the OG renderer pulls comes from this origin, and the
   card it produces is stored in R2 under a key that says nothing about which
   origin produced it. So a host accepted here writes the shared entry that
   every later unfurl of that page is served. */
describe("getAssetOrigin", () => {
  it("prefers the configured origin over the forwarded host", () => {
    vi.stubEnv("SITE_URL", "https://mania-tracker.com");
    expect(getAssetOrigin(proxied("evil.loca.lt"))).toBe("https://mania-tracker.com");
  });

  it("refuses wildcard tunnel and preview hosts in production", () => {
    vi.stubEnv("SITE_URL", "");
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "");
    vi.stubEnv("NODE_ENV", "production");
    // No allowed host, so it falls back to the request's own origin rather than
    // to anything the caller named.
    expect(getAssetOrigin(proxied("evil.loca.lt"))).toBe("http://127.0.0.1:3000");
    expect(getAssetOrigin(proxied("some-preview-abc123.vercel.app"))).toBe("http://127.0.0.1:3000");
    // Loopback is a development host too: accepting it would point the renderer
    // at a port on the box.
    expect(getAssetOrigin(proxied("127.0.0.1:7227"))).toBe("http://127.0.0.1:3000");
  });

  it("still honours the site's own hosts", () => {
    vi.stubEnv("SITE_URL", "");
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "");
    vi.stubEnv("NODE_ENV", "production");
    expect(getAssetOrigin(proxied("mania-tracker.com"))).toBe("https://mania-tracker.com");
    expect(getAssetOrigin(proxied("ninja.mania-tracker.com"))).toBe("https://ninja.mania-tracker.com");
  });

  it("keeps tunnels working outside production, and on an explicit allowlist", () => {
    vi.stubEnv("SITE_URL", "");
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "");
    vi.stubEnv("NODE_ENV", "development");
    expect(getAssetOrigin(proxied("mine.loca.lt"))).toBe("https://mine.loca.lt");

    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("MANIA_HUB_ALLOWED_HOST_SUFFIXES", ".loca.lt");
    expect(getAssetOrigin(proxied("mine.loca.lt"))).toBe("https://mine.loca.lt");
  });
});
