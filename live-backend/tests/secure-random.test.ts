import { describe, expect, it } from "vitest";
import { secureRandom, secureRandomId, secureRandomInt } from "../src/shared/secure-random.js";

describe("secureRandom", () => {
  it("stays inside [0, 1)", () => {
    for (let i = 0; i < 10_000; i += 1) {
      const value = secureRandom();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it("spreads across the range rather than clustering", () => {
    // A dead or badly shifted generator shows up here as an empty decile.
    const deciles = new Array(10).fill(0);
    for (let i = 0; i < 20_000; i += 1) deciles[Math.floor(secureRandom() * 10)] += 1;
    for (const count of deciles) expect(count).toBeGreaterThan(1_000);
  });
});

describe("secureRandomInt", () => {
  it("covers every value below the bound", () => {
    const seen = new Set<number>();
    for (let i = 0; i < 2_000; i += 1) {
      const value = secureRandomInt(6);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(6);
      seen.add(value);
    }
    expect(seen.size).toBe(6);
  });

  it("refuses a bound that is not a positive integer", () => {
    expect(() => secureRandomInt(0)).toThrow();
    expect(() => secureRandomInt(-1)).toThrow();
    expect(() => secureRandomInt(2.5)).toThrow();
  });
});

describe("secureRandomId", () => {
  it("draws the requested length from the alphabet alone", () => {
    const id = secureRandomId("abc", 24);
    expect(id).toHaveLength(24);
    expect(/^[abc]{24}$/.test(id)).toBe(true);
  });

  it("does not repeat itself", () => {
    const ids = new Set(Array.from({ length: 500 }, () => secureRandomId("abcdefghjkmnpqrstuvwxyz23456789", 12)));
    expect(ids.size).toBe(500);
  });
});
