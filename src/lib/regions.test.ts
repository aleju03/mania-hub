import { describe, expect, it } from "vitest";
import { getCountryName, isSupportedCountryScope, normalizeCountryScope } from "./country";
import { CONTINENT_OPTIONS, getRegionDef, getRegionShape, isRegionScope, REGION_OPTIONS } from "./regions";
import { REGION_DEFS } from "./regions.generated";

describe("region defs", () => {
  it("ships a name, members, and a map silhouette for every region", () => {
    expect(REGION_DEFS.length).toBeGreaterThan(0);
    for (const region of REGION_DEFS) {
      expect(region.code).toMatch(/^R-[A-Z]+$/);
      expect(region.name.length).toBeGreaterThan(0);
      expect(region.countries.length).toBeGreaterThan(0);
      const shape = getRegionShape(region.code);
      expect(shape, `missing shape for ${region.code}`).not.toBeNull();
      expect(shape?.path.length).toBeGreaterThan(0);
    }
  });

  it("sorts the picker options alphabetically", () => {
    for (const options of [CONTINENT_OPTIONS, REGION_OPTIONS]) {
      const names = options.map((region) => region.name);
      expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    }
  });

  it("splits continents from regions, with Oceania listed once as a continent", () => {
    expect(CONTINENT_OPTIONS.map((region) => region.name)).toEqual([
      "Africa",
      "Americas",
      "Asia",
      "Europe",
      "Oceania",
    ]);
    expect(REGION_OPTIONS.map((region) => region.name)).not.toContain("Oceania");
  });
});

describe("region scopes in country helpers", () => {
  it("preserves region codes through scope normalization", () => {
    expect(normalizeCountryScope("R-SEASIA")).toBe("R-SEASIA");
    expect(normalizeCountryScope("r-seasia")).toBe("R-SEASIA");
    // Unknown codes still collapse to the default country, not a region.
    expect(normalizeCountryScope("R-NOPE")).toBe("CR");
  });

  it("treats regions as supported scopes with names", () => {
    expect(isSupportedCountryScope("R-CAMERICA")).toBe(true);
    expect(isRegionScope("R-CAMERICA")).toBe(true);
    expect(isRegionScope("CR")).toBe(false);
    expect(isRegionScope("GLOBAL")).toBe(false);
    expect(getCountryName("R-CAMERICA")).toBe("Central America");
    expect(getRegionDef("R-CAMERICA")?.countries).toContain("CR");
  });

  it("treats continents as region scopes too", () => {
    expect(isSupportedCountryScope("R-EUROPE")).toBe(true);
    expect(isRegionScope("R-AMERICAS")).toBe(true);
    expect(normalizeCountryScope("r-asia")).toBe("R-ASIA");
    expect(getCountryName("R-AFRICA")).toBe("Africa");
    expect(getRegionDef("R-AMERICAS")?.countries).toEqual(expect.arrayContaining(["BR", "CR", "MX"]));
  });
});
