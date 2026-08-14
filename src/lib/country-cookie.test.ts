import { describe, expect, it } from "vitest";
import { readEdgeCountry, resolveInitialCountry } from "./country-cookie";
import { GLOBAL_SCOPE_CODE } from "./country";

const available = new Set(["CR", "US"]);

describe("readEdgeCountry", () => {
  it("reads Cloudflare's header, which is what fronts the site now", () => {
    expect(readEdgeCountry(new Headers({ "cf-ipcountry": "DE" }))).toBe("DE");
  });

  it("reads the Vercel header on the rollback target, and nowhere else", () => {
    const vercel = process.env.VERCEL;
    try {
      process.env.VERCEL = "1";
      expect(readEdgeCountry(new Headers({ "x-vercel-ip-country": "CR" }))).toBe("CR");
      delete process.env.VERCEL;
      expect(readEdgeCountry(new Headers({ "x-vercel-ip-country": "CR" }))).toBeNull();
    } finally {
      if (vercel === undefined) delete process.env.VERCEL;
      else process.env.VERCEL = vercel;
    }
  });

  // Nothing but the real edge gets a say: these are plain request headers that
  // any caller can send, and trusting one is enough to activate a country the
  // backend has never tracked or to forge the geo on an analytics row.
  it("ignores geo headers no edge in front of this deployment sets", () => {
    expect(readEdgeCountry(new Headers({ "cloudfront-viewer-country": "JP" }))).toBeNull();
    expect(readEdgeCountry(new Headers({ "x-geo-country": "br" }))).toBeNull();
    expect(readEdgeCountry(new Headers({ "x-country-code": "KP" }))).toBeNull();
    // The genuine header still wins when a forged one rides alongside it.
    expect(readEdgeCountry(new Headers({ "x-vercel-ip-country": "KP", "cf-ipcountry": "DE" }))).toBe("DE");
  });

  it("keeps countries the site does not track, since analytics wants every flag", () => {
    expect(readEdgeCountry(new Headers({ "cf-ipcountry": "JP" }))).toBe("JP");
  });

  it("treats Cloudflare's XX placeholder as no country rather than a bogus flag", () => {
    expect(readEdgeCountry(new Headers({ "cf-ipcountry": "XX" }))).toBeNull();
  });

  it("returns null off the edge entirely, and ignores malformed codes", () => {
    expect(readEdgeCountry(new Headers())).toBeNull();
    expect(readEdgeCountry(new Headers({ "cf-ipcountry": "T1" }))).toBeNull();
    expect(readEdgeCountry(new Headers({ "cf-ipcountry": "GERMANY" }))).toBeNull();
  });
});

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

  it("keeps an auto Global cookie when there is no usable geo signal", () => {
    expect(
      resolveInitialCountry(GLOBAL_SCOPE_CODE, null, { available, cookieIsAuto: true }),
    ).toBe(GLOBAL_SCOPE_CODE);
    expect(
      resolveInitialCountry(GLOBAL_SCOPE_CODE, "JP", { available, cookieIsAuto: true }),
    ).toBe(GLOBAL_SCOPE_CODE);
  });

  it("lets a geo hit that became available win over an auto Global cookie", () => {
    expect(
      resolveInitialCountry(GLOBAL_SCOPE_CODE, "US", { available, cookieIsAuto: true }),
    ).toBe("US");
  });

  it("still honours a manual Global pick over a geo hit", () => {
    expect(
      resolveInitialCountry(GLOBAL_SCOPE_CODE, "US", { available, cookieIsAuto: false }),
    ).toBe(GLOBAL_SCOPE_CODE);
  });
});
