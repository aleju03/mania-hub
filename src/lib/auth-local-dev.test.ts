import { describe, expect, it } from "vitest";
import { isLocalDevAccessGranted, isLoopbackHostname } from "./auth-local-dev";

describe("isLoopbackHostname", () => {
  it("accepts loopback forms", () => {
    for (const hostname of ["localhost", "LOCALHOST", "127.0.0.1", "::1", "[::1]", "app.localhost"]) {
      expect(isLoopbackHostname(hostname), hostname).toBe(true);
    }
  });

  it("rejects non-loopback hosts", () => {
    for (const hostname of ["mania-tracker.com", "ninja.mania-tracker.com", "192.168.1.10", "10.0.0.1", "localhost.evil.com", ""]) {
      expect(isLoopbackHostname(hostname), hostname).toBe(false);
    }
  });
});

describe("isLocalDevAccessGranted", () => {
  const granted = { nodeEnv: "development", localDevSwitch: "1", hostname: "localhost" };

  it("grants access only with the explicit switch on a loopback host outside production", () => {
    expect(isLocalDevAccessGranted(granted)).toBe(true);
    expect(isLocalDevAccessGranted({ ...granted, localDevSwitch: "true" })).toBe(true);
    expect(isLocalDevAccessGranted({ ...granted, nodeEnv: undefined })).toBe(true);
  });

  it("never grants access in production, even with the switch set", () => {
    expect(isLocalDevAccessGranted({ ...granted, nodeEnv: "production" })).toBe(false);
  });

  it("requires the explicit switch; NODE_ENV alone is not enough", () => {
    expect(isLocalDevAccessGranted({ ...granted, localDevSwitch: undefined })).toBe(false);
    expect(isLocalDevAccessGranted({ ...granted, localDevSwitch: "" })).toBe(false);
    expect(isLocalDevAccessGranted({ ...granted, localDevSwitch: "0" })).toBe(false);
    expect(isLocalDevAccessGranted({ ...granted, localDevSwitch: "false" })).toBe(false);
  });

  it("requires a loopback hostname", () => {
    expect(isLocalDevAccessGranted({ ...granted, hostname: "mania-tracker.com" })).toBe(false);
    expect(isLocalDevAccessGranted({ ...granted, hostname: "192.168.1.10" })).toBe(false);
  });
});
