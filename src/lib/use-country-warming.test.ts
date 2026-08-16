import { describe, expect, it } from "vitest";
import { DEFAULT_COUNTRY_CODE } from "./country";
import { getCachedCountryTier, getRegionEffectiveTier, seedCountryTierCache } from "./use-country-warming";

describe("seedCountryTierCache", () => {
  it("keeps each country's own tier when the backend tracks a code the country list doesn't carry", () => {
    // The backend registry activates any country a visitor arrives from, so it
    // can outrun the frontend's country list. Keying the cache through
    // normalizeCountryScope() used to fold those unknown codes onto
    // DEFAULT_COUNTRY_CODE, overwriting the default country's tier: the Snipes
    // tab vanished and "snipes aren't tracked" rendered for a snipes-tier
    // country until the activation response repaired it.
    seedCountryTierCache([
      { country: DEFAULT_COUNTRY_CODE, featureTier: "snipes" },
      { country: "ZZ", featureTier: "live" },
    ]);

    expect(getCachedCountryTier(DEFAULT_COUNTRY_CODE)).toBe("snipes");
    expect(getCachedCountryTier("ZZ")).toBe("live");
  });

  it("reads tiers case-insensitively", () => {
    seedCountryTierCache([{ country: "de", featureTier: "live" }]);

    expect(getCachedCountryTier("DE")).toBe("live");
    expect(getCachedCountryTier(" de ")).toBe("live");
  });
});

describe("getRegionEffectiveTier", () => {
  it("caps a region's tier at live even when a member country is snipes-tier", () => {
    // Snipes is per-country; CR being snipes-tier must not put the Snipes tab
    // on the Central America scope.
    seedCountryTierCache([
      { country: "CR", featureTier: "snipes" },
      { country: "PA", featureTier: "indexed" },
    ]);

    expect(getRegionEffectiveTier("R-CAMERICA")).toBe("live");
  });
});
