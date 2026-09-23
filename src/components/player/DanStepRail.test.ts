import { describe, expect, it } from "vitest";
import { danStepWindow } from "./DanStepRail";

describe("danStepWindow", () => {
  it("shows two steps under the current one and one over, each labelled by the step it opens", () => {
    const { steps, current } = danStepWindow(13.23, "reform");
    expect(current).toBe(13.1);
    expect(steps).toEqual([
      { start: 12.7, label: "gamma-" },
      { start: 12.9, label: "gamma" },
      { start: 13.1, label: "gamma+" },
      { start: 13.3, label: "gamma++" },
      { start: 13.5, label: "delta--" },
    ]);
  });

  it("puts a number sitting on a step start inside that step", () => {
    expect(danStepWindow(13.1, "reform").current).toBe(13.1);
    expect(danStepWindow(12.7, "reform").current).toBe(12.7);
  });

  it("clips at the ladder ends", () => {
    expect(danStepWindow(0.8, "reform").steps.map((step) => step.label)).toEqual(["1--", "1-", "1", "1+"]);
  });
});
