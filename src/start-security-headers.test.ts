import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("document device-access policy", () => {
  it("denies local and loopback network access before Chromium can prompt", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "start.ts"), "utf8");

    expect(source).toContain('"local-network=(), loopback-network=(), local-network-access=()"');
    expect(source).toContain('response.headers.set("Permissions-Policy", DEVICE_ACCESS_PERMISSIONS_POLICY)');
    expect(source).toContain("requestMiddleware: [deviceAccessPolicyMiddleware,");
  });
});
