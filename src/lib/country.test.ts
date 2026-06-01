import { describe, expect, it } from "vitest";
import {
  COUNTRY_OPTIONS,
  GLOBAL_SCOPE_CODE,
  GLOBAL_SCOPE_ICON_URL,
  getCountryFlagGradient,
  getCountryFlagUrl,
  getCountryName,
  isGlobalScope,
  isSupportedCountryCode,
  isSupportedCountryScope,
  normalizeCountryCode,
  normalizeCountryScope,
} from "./country";

describe("country scope helpers", () => {
  it("recognises the Global scope case-insensitively", () => {
    expect(isGlobalScope("GLOBAL")).toBe(true);
    expect(isGlobalScope(" global ")).toBe(true);
    expect(isGlobalScope("CR")).toBe(false);
    expect(isGlobalScope(null)).toBe(false);
  });

  it("treats Global as a supported scope, not a country", () => {
    expect(isSupportedCountryCode("GLOBAL")).toBe(false);
    expect(isSupportedCountryScope("GLOBAL")).toBe(true);
    expect(normalizeCountryCode("global")).toBe("CR");
    expect(normalizeCountryScope("global")).toBe(GLOBAL_SCOPE_CODE);
    expect(getCountryName("GLOBAL")).toBe("Global");
  });

  it("keeps real country normalisation untouched", () => {
    expect(normalizeCountryCode("cr")).toBe("CR");
    expect(normalizeCountryCode("zz")).toBe("CR"); // unknown falls back to default
    expect(getCountryName("CR")).toBe("Costa Rica");
  });

  it("sorts country options alphabetically without pinning the default country", () => {
    const names = COUNTRY_OPTIONS.map((country) => country.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    expect(COUNTRY_OPTIONS[0].code).not.toBe("CR");
  });

  it("uses the globe motif as the Global flag and has no stripe gradient", () => {
    expect(getCountryFlagUrl("GLOBAL")).toBe(GLOBAL_SCOPE_ICON_URL);
    expect(getCountryFlagUrl("CR")).toContain("/flags/CR.png");
    expect(getCountryFlagGradient("GLOBAL")).toBeNull();
  });
});
