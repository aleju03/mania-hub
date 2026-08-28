import { describe, expect, it } from "vitest";
import {
  DAN_CREDIT_BELOW_BAR_WINDOW,
  creditedDanFor,
  danCreditNearBarCapFor,
  danCreditOffset,
} from "../src/dan/dan-credit.js";
import { danLabelForTest } from "../src/features/player-skills.js";

describe("danCreditOffset", () => {
  it("hits the above-bar anchors on a 96% bar", () => {
    expect(danCreditOffset(0.96, 0.96)).toBeCloseTo(0, 9);
    expect(danCreditOffset(0.98, 0.96)).toBeCloseTo(0.35, 6);
    expect(danCreditOffset(0.99, 0.96)).toBeCloseTo(0.7, 6);
    expect(danCreditOffset(0.995, 0.96)).toBeCloseTo(1.1, 6);
    expect(danCreditOffset(1, 0.96)).toBeCloseTo(1.5, 9);
  });

  it("normalizes the bonus to headroom, but never a span narrower than the window", () => {
    // Half the headroom earns the same +0.35 on the 95% and 96% bars, whose
    // headroom is at least the 4-point window, and 100% earns the full top
    // credit there.
    expect(danCreditOffset(0.975, 0.95)).toBeCloseTo(0.35, 6);
    expect(danCreditOffset(1, 0.95)).toBeCloseTo(1.5, 9);
    // A 97% bar has only 3 points of raw headroom, and accuracy comes cheap
    // on the ladder that uses it (4K LN), so the bonus scores against the
    // window instead: 98.5% is t = 0.375, and 100% tops out at +0.7.
    expect(danCreditOffset(0.985, 0.97)).toBeCloseTo(0.2625, 6);
    expect(danCreditOffset(1, 0.97)).toBeCloseTo(0.7, 6);
  });

  it("decays below the bar and stops at the credit window", () => {
    expect(danCreditOffset(0.955, 0.96)).toBeCloseTo(-0.3525, 6);
    expect(danCreditOffset(0.94, 0.96)).toBeCloseTo(-0.63, 6);
    expect(danCreditOffset(0.92, 0.96)).toBeCloseTo(-1, 9);
    expect(danCreditOffset(0.9199, 0.96)).toBeNull();
    expect(danCreditOffset(Number.NaN, 0.96)).toBeNull();
  });

  it("is monotone non-decreasing across the whole credited range", () => {
    let previous: number | null = null;
    for (let step = 0; step <= 200; step += 1) {
      const accuracy = 0.9 + step * 0.0005;
      const offset = danCreditOffset(accuracy, 0.96);
      if (offset == null) {
        expect(previous).toBeNull();
        continue;
      }
      if (previous != null) expect(offset).toBeGreaterThanOrEqual(previous);
      previous = offset;
    }
  });

  it("supports the course registry's absolute-delta anchors unchanged", () => {
    const courseAnchors = [
      [0, 0],
      [0.015, 0.11],
      [0.02, 0.28],
      [0.035, 0.45],
    ] as const;
    expect(danCreditOffset(0.98, 0.96, { aboveBar: courseAnchors, aboveBarScale: "delta" })).toBeCloseTo(0.28, 6);
    expect(danCreditOffset(1, 0.96, { aboveBar: courseAnchors, aboveBarScale: "delta" })).toBeCloseTo(0.45, 9);
    expect(danCreditOffset(0.9599, 0.96, { allowBelowBar: false })).toBeNull();
  });
});

describe("near-bar cap", () => {
  it("keeps a near-miss from printing as a bare clear of the chart's level", () => {
    const offset = danCreditOffset(0.9599, 0.96, { nearBarCap: danCreditNearBarCapFor("rc", 4) });
    expect(danLabelForTest(15 + offset!, "rc", 4)).toBe("epsilon-");
    const tableOffset = danCreditOffset(0.9599, 0.96, { nearBarCap: danCreditNearBarCapFor("rc", 7) });
    expect(danLabelForTest(8 + tableOffset!, "rc", 7)).toBe("8-");
  });

  it("prices a 4K LN near-miss at least three quarters of a level down", () => {
    // parseLnDan has no reachable minus tier, so any cap under 0.52 would
    // print a bare "7" for a non-clear; the cap sits at 0.75 on top of that
    // because stable accuracy is cheap to hold on long notes.
    const offset = danCreditOffset(0.9699, 0.97, { nearBarCap: danCreditNearBarCapFor("ln", 4) });
    expect(offset).toBeCloseTo(-0.75, 9);
    expect(danLabelForTest(7 + offset!, "ln", 4)).toBe("6");
  });
});

describe("creditedDanFor", () => {
  it("applies the offset and window end to end", () => {
    expect(creditedDanFor(15.15, 0.92, 0.96, "rc", 4)).toBeCloseTo(14.15, 6);
    expect(creditedDanFor(15.15, 0.96 - DAN_CREDIT_BELOW_BAR_WINDOW - 0.001, 0.96, "rc", 4)).toBeNull();
  });

  it("clamps to the ladder ceiling where one exists", () => {
    expect(creditedDanFor(17, 1, 0.97, "ln", 4)).toBeCloseTo(17.5, 9);
    // 4K rice keeps going into the greek levels, so no ceiling applies.
    expect(creditedDanFor(16, 1, 0.96, "rc", 4)).toBeCloseTo(17.5, 9);
  });

  it("never credits below the ladder floor", () => {
    // Kyu-band scrape on the 7K table (bar 0.95): the raw credit would be
    // negative, which skill surfaces read as unrated.
    const kyu = creditedDanFor(0.5, 0.92, 0.95, "rc", 7);
    expect(kyu).not.toBeNull();
    expect(kyu!).toBeGreaterThanOrEqual(0);
    expect(creditedDanFor(1, 0.92, 0.96, "rc", 4)).toBeCloseTo(0.5, 9);
  });
});
