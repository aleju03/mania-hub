import { describe, expect, it } from "vitest";

import { ResolutionGovernor } from "./profile-theme-gl";

/* Past the warm-up, where it judges nothing. */
function warmed(): ResolutionGovernor {
  const governor = new ResolutionGovernor();
  run(governor, 16.7, 90);
  return governor;
}

function run(governor: ResolutionGovernor, gapMs: number, frames: number) {
  for (let i = 0; i < frames; i++) governor.frame(gapMs);
}

describe("ResolutionGovernor", () => {
  it("keeps full resolution while frames keep up", () => {
    const governor = warmed();
    run(governor, 16.7, 600);
    expect(governor.scale).toBe(1);
  });

  it("catches up quickly from a start-up guess that frames show was too low", () => {
    const governor = new ResolutionGovernor();
    governor.start(0.12);
    run(governor, 16.7, 90 + 30 * 5);
    expect(governor.scale).toBe(1);
  });

  it("climbs slowly again once a guessed start has run slow", () => {
    const governor = new ResolutionGovernor();
    governor.start(0.5);
    run(governor, 16.7, 90);
    run(governor, 40, 30);
    const dropped = governor.scale;
    run(governor, 16.7, 30 * 5);
    expect(governor.scale).toBe(dropped);
  });

  it("judges nothing while the page is still loading", () => {
    const governor = new ResolutionGovernor();
    run(governor, 40, 90);
    expect(governor.scale).toBe(1);
  });

  it("drops the pixel budget while frames run slow, down to a floor", () => {
    const governor = warmed();
    run(governor, 40, 30);
    expect(governor.scale).toBeCloseTo(0.55);
    run(governor, 40, 600);
    expect(governor.scale).toBeCloseTo(0.12);
    expect(governor.starved).toBe(true);
  });

  it("climbs all the way back once a slow patch has passed", () => {
    const governor = warmed();
    run(governor, 40, 600);
    expect(governor.scale).toBeCloseTo(0.12);
    run(governor, 16.7, 60_000);
    expect(governor.scale).toBe(1);
    expect(governor.starved).toBe(false);
  });

  it("holds under a level the device really cannot carry, trying it less and less often", () => {
    const governor = warmed();
    let changes = 0;
    let slowFrames = 0;
    for (let i = 0; i < 60_000; i++) {
      const gap = governor.scale > 0.6 ? 40 : 16.7;
      if (gap === 40) slowFrames += 1;
      if (governor.frame(gap)) changes += 1;
    }
    expect(governor.scale).toBeLessThanOrEqual(0.6);
    // ~17 minutes of frames: a half-second try about once a minute, not a steady flicker
    expect(changes).toBeLessThan(50);
    expect(slowFrames / 60_000).toBeLessThan(0.02);
  });

  it("ignores hidden-tab gaps and lone hitches", () => {
    const governor = warmed();
    for (let i = 0; i < 300; i++) governor.frame(i % 10 === 0 ? 1000 : i % 7 === 0 ? 60 : 16.7);
    expect(governor.scale).toBe(1);
  });
});
