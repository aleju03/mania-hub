import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getAppRateLimitClientIp } from "./lib/app-client-ip";

describe("document device-access policy", () => {
  it("denies local and loopback network access before Chromium can prompt", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "start.ts"), "utf8");

    expect(source).toContain('"local-network=(), loopback-network=(), local-network-access=()"');
    expect(source).toContain('response.headers.set("Permissions-Policy", DEVICE_ACCESS_PERMISSIONS_POLICY)');
    expect(source).toContain("requestMiddleware: [deviceAccessPolicyMiddleware,");
  });

  // Same middleware, same text/html responses: a foreign page must not be able
  // to frame the site, while /admin/ghost's same-origin preview keeps working.
  it("refuses cross-site framing of every document", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "start.ts"), "utf8");

    expect(source).toContain('response.headers.set("X-Frame-Options", "SAMEORIGIN")');
    expect(source).toContain('response.headers.set("Content-Security-Policy", FRAME_ANCESTORS_POLICY)');
    expect(source).toContain("frame-ancestors 'self'");
  });
});

describe("frontend rate-limit client identity", () => {
  const request = new Request("https://mania-tracker.com/api/og", {
    headers: {
      "cf-connecting-ip": "::ffff:203.0.113.7",
      "x-real-ip": "198.51.100.1",
      "x-forwarded-for": "198.51.100.2, 198.51.100.3",
    },
  });

  it("ignores every forwarded header unless proxy trust is explicitly enabled", () => {
    expect(getAppRateLimitClientIp(request, {})).toBe("unknown");
    expect(getAppRateLimitClientIp(request, { TRUST_PROXY_HEADERS: "false" })).toBe("unknown");
  });

  it("uses only Cloudflare's overwritten header when proxy trust is enabled", () => {
    expect(getAppRateLimitClientIp(request, { TRUST_PROXY_HEADERS: "true" })).toBe("203.0.113.7");
    const forgedFallbacks = new Request("https://mania-tracker.com/api/og", {
      headers: { "x-real-ip": "198.51.100.1", "x-forwarded-for": "198.51.100.2" },
    });
    expect(getAppRateLimitClientIp(forgedFallbacks, { TRUST_PROXY_HEADERS: "1" })).toBe("unknown");
  });
});
