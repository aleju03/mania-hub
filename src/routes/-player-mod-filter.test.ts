import { describe, expect, it } from "vitest";

import { cycleModFilterMode, reverseCycleModFilterMode } from "./player/$username";

describe("player mod filter cycling", () => {
  it("cycles forward from neutral to include to exclude and back to neutral", () => {
    expect(cycleModFilterMode(undefined)).toBe("include");
    expect(cycleModFilterMode("include")).toBe("exclude");
    expect(cycleModFilterMode("exclude")).toBeUndefined();
  });

  it("cycles backward from neutral to exclude to include and back to neutral", () => {
    expect(reverseCycleModFilterMode(undefined)).toBe("exclude");
    expect(reverseCycleModFilterMode("exclude")).toBe("include");
    expect(reverseCycleModFilterMode("include")).toBeUndefined();
  });
});
