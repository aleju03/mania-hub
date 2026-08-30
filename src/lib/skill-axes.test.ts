import { describe, expect, it } from "vitest";

import { topSharePercent } from "./skill-axes";

describe("topSharePercent", () => {
  it("keeps whole percents for ordinary standings", () => {
    expect(topSharePercent({ value: 75, population: 12371 })).toBe("25");
    expect(topSharePercent({ value: 98.2, population: 12371 })).toBe("2");
  });

  it("shows the tail of the population instead of clamping it to 1%", () => {
    expect(topSharePercent({ value: 99.5, population: 12371 })).toBe("0.5");
    expect(topSharePercent({ value: 99.94, population: 12371 })).toBe("0.06");
    // The best player: rank 1 of 12,371 is eight thousandths of a percent.
    expect(topSharePercent({ value: 99.9919, population: 12371 })).toBe("0.008");
  });

  it("never claims a finer share than one player out of the population", () => {
    // Curves that pin their top to a flat 100 still get the population floor.
    expect(topSharePercent({ value: 100, population: 25 })).toBe("4");
    expect(topSharePercent({ value: 100, population: 12371 })).toBe("0.008");
    // No population to divide by: nothing finer can be claimed.
    expect(topSharePercent({ value: 100, population: 0 })).toBe("1");
  });
});
