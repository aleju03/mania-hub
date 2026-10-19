import { describe, expect, it } from "vitest";

import { ResolutionGovernor } from "./profile-theme-gl";

function run(governor: ResolutionGovernor, gapMs: number, frames: number) {
  for (let i = 0; i < frames; i++) governor.frame(gapMs);
}

describe("ResolutionGovernor", () => {
  it("keeps full resolution while frames keep up", () => {
    const governor = new ResolutionGovernor();
    run(governor, 16.7, 600);
    expect(governor.scale).toBe(1);
  });

  it("drops the pixel budget while frames run slow, down to a floor", () => {
    const governor = new ResolutionGovernor();
    run(governor, 40, 30);
    expect(governor.scale).toBeCloseTo(0.55);
    run(governor, 40, 600);
    expect(governor.scale).toBeCloseTo(0.12);
  });

  it("climbs back once fast, but not to the level that was too slow", () => {
    const governor = new ResolutionGovernor();
    run(governor, 40, 30);
    run(governor, 16.7, 6000);
    expect(governor.scale).toBeCloseTo(0.8);
  });

  it("ignores hidden-tab gaps and lone hitches", () => {
    const governor = new ResolutionGovernor();
    for (let i = 0; i < 300; i++) governor.frame(i % 10 === 0 ? 1000 : i % 7 === 0 ? 60 : 16.7);
    expect(governor.scale).toBe(1);
  });
});
