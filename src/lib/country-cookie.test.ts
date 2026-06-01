import { describe, expect, it } from "vitest";
import { resolveInitialCountry } from "./country-cookie";
import { GLOBAL_SCOPE_CODE } from "./country";

const available = new Set(["CR", "US"]);

describe("resolveInitialCountry", () => {
  it("honours a manual cookie pick even when that country isn't available", () => {
    expect(
      resolveInitialCountry("JP", null, { available, cookieIsAuto: false }),
    ).toBe("JP");
  });

  it("keeps an auto cookie when its country is available", () => {
    expect(
      resolveInitialCountry("US", null, { available, cookieIsAuto: true }),
    ).toBe("US");
  });

  it("drops an auto cookie to Global when its country is no longer available", () => {
    expect(
      resolveInitialCountry("JP", null, { available, cookieIsAuto: true }),
    ).toBe(GLOBAL_SCOPE_CODE);
  });

  it("uses a detected country when it is available", () => {
    expect(
      resolveInitialCountry(null, "CR", { available, cookieIsAuto: false }),
    ).toBe("CR");
  });

  it("falls back to Global when the detected country isn't available", () => {
    expect(
      resolveInitialCountry(null, "JP", { available, cookieIsAuto: false }),
    ).toBe(GLOBAL_SCOPE_CODE);
  });

  it("falls back to Global when there's no signal at all", () => {
    expect(
      resolveInitialCountry(null, null, { available, cookieIsAuto: false }),
    ).toBe(GLOBAL_SCOPE_CODE);
  });

  it("routes auto/detected scopes to Global when availability is unknown (backend offline)", () => {
    expect(
      resolveInitialCountry(null, "CR", { available: null, cookieIsAuto: false }),
    ).toBe(GLOBAL_SCOPE_CODE);
    expect(
      resolveInitialCountry("CR", null, { available: null, cookieIsAuto: true }),
    ).toBe(GLOBAL_SCOPE_CODE);
  });

  it("still honours a manual pick when availability is unknown", () => {
    expect(
      resolveInitialCountry("CR", null, { available: null, cookieIsAuto: false }),
    ).toBe("CR");
  });

  it("treats Global as available so an existing Global cookie sticks", () => {
    expect(
      resolveInitialCountry(GLOBAL_SCOPE_CODE, null, { available, cookieIsAuto: true }),
    ).toBe(GLOBAL_SCOPE_CODE);
  });
});
