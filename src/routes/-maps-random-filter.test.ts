import { describe, expect, it } from "vitest";

import { cycleTriStateCsv, reverseCycleTriStateCsv } from "./maps";

describe("maps random filter cycling", () => {
  it("cycles forward from neutral to include to exclude and back to neutral", () => {
    expect(cycleTriStateCsv("", "jack")).toBe("jack");
    expect(cycleTriStateCsv("jack", "jack")).toBe("-jack");
    expect(cycleTriStateCsv("-jack", "jack")).toBe("");
  });

  it("cycles backward from neutral to exclude to include and back to neutral", () => {
    expect(reverseCycleTriStateCsv("", "jack")).toBe("-jack");
    expect(reverseCycleTriStateCsv("-jack", "jack")).toBe("jack");
    expect(reverseCycleTriStateCsv("jack", "jack")).toBe("");
  });

  it("preserves unrelated filters while cycling one value", () => {
    expect(reverseCycleTriStateCsv("ranked,-loved", "ranked")).toBe("-loved");
    expect(reverseCycleTriStateCsv("ranked,-loved", "loved")).toBe("ranked,loved");
    expect(cycleTriStateCsv("ranked,-loved", "other")).toBe("ranked,-loved,other");
  });
});
