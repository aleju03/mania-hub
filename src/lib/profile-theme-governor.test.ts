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

  it("is back at full within a second of a guess that was too low", () => {
    const governor = new ResolutionGovernor();
    governor.start(0.12);
    run(governor, 16.7, 50);
    expect(governor.scale).toBe(1);
  });

  it("holds a guessed start while the first frames are not fast, and never lowers it that early", () => {
    const governor = new ResolutionGovernor();
    governor.start(0.3);
    run(governor, 20, 90);
    expect(governor.scale).toBeCloseTo(0.3);
    const slow = new ResolutionGovernor();
    slow.start(0.3);
    run(slow, 40, 90);
    expect(slow.scale).toBeCloseTo(0.3);
  });

  it("stops climbing early at the size where frames stop being fast", () => {
    const governor = new ResolutionGovernor();
    governor.start(0.12);
    run(governor, 16.7, 20);
    const reached = governor.scale;
    expect(reached).toBeCloseTo(0.12 * 1.6 * 1.6);
    run(governor, 20, 70);
    expect(governor.scale).toBeCloseTo(reached);
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

  // starved, the loop draws only every ~31ms, so ~33ms is what its gaps look like
  const HALF_RATE = 33.3;

  it("tries full rate again once a theme starved by one slow start-up frame holds half rate easily", () => {
    const governor = new ResolutionGovernor();
    // what the start-up probe does when one of its frames ran past 24ms
    governor.start(0.12);
    governor.starved = true;
    let frames = 0;
    while (governor.starved && frames < 60 * 60) {
      governor.frame(HALF_RATE);
      frames += 1;
    }
    expect(governor.starved).toBe(false);
    // within ~6s at half rate (the warm-up, then three windows)
    expect(frames).toBeLessThanOrEqual(30 * 6);
    // and from there, at full rate, it climbs all the way back
    run(governor, 16.7, 60 * 30);
    expect(governor.scale).toBe(1);
  });

  it("goes back to half rate when full rate is still too slow, and tries less and less often", () => {
    const governor = warmed();
    run(governor, 40, 600);
    expect(governor.starved).toBe(true);
    let tries = 0;
    for (let i = 0; i < 30 * 60 * 10; i++) {
      const was = governor.starved;
      governor.frame(governor.starved ? HALF_RATE : 40);
      if (was && !governor.starved) tries += 1;
    }
    expect(governor.scale).toBeCloseTo(0.12);
    // ten minutes: a try that doubles its wait each time, not one every few seconds
    expect(tries).toBeLessThan(12);
  });

  it("ignores hidden-tab gaps and lone hitches", () => {
    const governor = warmed();
    for (let i = 0; i < 300; i++) governor.frame(i % 10 === 0 ? 1000 : i % 7 === 0 ? 60 : 16.7);
    expect(governor.scale).toBe(1);
  });
});
