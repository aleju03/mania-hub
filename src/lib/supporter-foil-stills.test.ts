import { describe, expect, it } from "vitest";

import { SUPPORTER_FOILS } from "./supporter-foils";
import { hasSupporterFoilStill, supporterFoilStillPixels } from "./supporter-foil-stills";

describe("supporter foil stills", () => {
  it("draws caustics as light with holes in it, never past the overlay's alpha ceiling", () => {
    const pixels = supporterFoilStillPixels("caustics", 90, 126)!;
    expect(pixels).toHaveLength(90 * 126 * 4);
    let brightest = 0;
    let faintest = 255;
    for (let at = 3; at < pixels.length; at += 4) {
      brightest = Math.max(brightest, pixels[at]!);
      faintest = Math.min(faintest, pixels[at]!);
    }
    expect(brightest).toBeGreaterThan(60);
    expect(brightest).toBeLessThanOrEqual(Math.round(0.6 * 255));
    expect(faintest).toBeLessThan(20);
  });

  it("has a still for every foil but the lattice, each with light on it", () => {
    for (const foil of SUPPORTER_FOILS) {
      if (foil === "holo") continue;
      const pixels = supporterFoilStillPixels(foil, 60, 84);
      expect(pixels, foil).not.toBeNull();
      let brightest = 0;
      for (let at = 3; at < pixels!.length; at += 4) brightest = Math.max(brightest, pixels![at]!);
      expect(brightest, foil).toBeGreaterThan(40);
      expect(brightest, foil).toBeLessThanOrEqual(Math.round(0.6 * 255));
    }
  });

  it("is the same picture every time", () => {
    expect(supporterFoilStillPixels("caustics", 30, 42)).toEqual(supporterFoilStillPixels("caustics", 30, 42));
  });

  it("has none for the lattice, which keeps its vector still", () => {
    expect(hasSupporterFoilStill("holo")).toBe(false);
    expect(supporterFoilStillPixels("holo", 30, 42)).toBeNull();
  });
});
