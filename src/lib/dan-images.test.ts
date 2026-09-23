import { describe, expect, it } from "vitest";
import { danTierName } from "./dan-images";

describe("danTierName", () => {
  it("names each suffix with LeoBlack's tier words", () => {
    expect(danTierName("azimuth--")).toBe("azimuth low");
    expect(danTierName("gamma-")).toBe("gamma mid/low");
    expect(danTierName("gamma")).toBe("gamma mid");
    expect(danTierName("gamma+")).toBe("gamma mid/high");
    expect(danTierName("gamma++")).toBe("gamma high");
  });

  it("formats the level before the tier word", () => {
    expect(danTierName("10-", (level) => `${level} dan`)).toBe("10 dan mid/low");
  });
});
