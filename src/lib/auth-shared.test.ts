import { describe, expect, it } from "vitest";
import { ANONYMOUS_AUTH_STATE, canUseAdminFeatures, isAdmin } from "./auth-shared";
import type { AuthState } from "./auth-shared";

const viewer = {
  id: 7095193,
  username: "admin",
  avatarUrl: "https://example.com/avatar.png",
  countryCode: "CR",
};

describe("auth shared helpers", () => {
  it("does not treat broad local admin feature access as true admin access", () => {
    const auth: AuthState = {
      ...ANONYMOUS_AUTH_STATE,
      canUseAdminFeatures: true,
    };

    expect(canUseAdminFeatures(auth)).toBe(true);
    expect(isAdmin(auth)).toBe(false);
  });

  it("recognizes true admin sessions separately from feature access", () => {
    const auth: AuthState = {
      ...ANONYMOUS_AUTH_STATE,
      viewer,
      isAdmin: true,
      canUseDevFeatures: true,
      canUseAdminFeatures: true,
      loginAvailable: true,
      loginSuggested: true,
    };

    expect(isAdmin(auth)).toBe(true);
    expect(canUseAdminFeatures(auth)).toBe(true);
  });
});
