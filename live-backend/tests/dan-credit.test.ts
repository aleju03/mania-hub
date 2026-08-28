import { describe, expect, it } from "vitest";
import {
  DAN_CREDIT_BELOW_BAR_WINDOW,
  DAN_CREDIT_LN_BELOW_BAR_WINDOW,
  creditedDanFor,
  danCreditBelowBarWindowFor,
  danCreditNearBarCapFor,
  danCreditOffset,
} from "../src/dan/dan-credit.js";
import { danLabelForTest } from "../src/features/player-skills.js";

describe("danCreditOffset", () => {
  it("hits the above-bar anchors on a 96% bar", () => {
    expect(danCreditOffset(0.96, 0.96)).toBeCloseTo(0, 9);
    // The first point above the bar is a flat zone: a 96.x% pass is a bare
    // clear of the chart's level, not a bonus.
    expect(danCreditOffset(0.965, 0.96)).toBeCloseTo(0, 9);
    expect(danCreditOffset(0.969, 0.96)).toBeCloseTo(0, 9);
    expect(danCreditOffset(0.97, 0.96)).toBeCloseTo(0, 9);
    // The real bonus opens at 99%: the 98s only crawl toward +0.2.
    expect(danCreditOffset(0.98, 0.96)).toBeCloseTo(0.117647, 6);
    expect(danCreditOffset(0.987, 0.96)).toBeCloseTo(0.2, 6);
    expect(danCreditOffset(0.99, 0.96)).toBeCloseTo(0.7, 6);
    expect(danCreditOffset(0.995, 0.96)).toBeCloseTo(1.1, 6);
    expect(danCreditOffset(1, 0.96)).toBeCloseTo(1.5, 9);
  });

  it("normalizes the bonus to headroom, but never a span narrower than the window", () => {
    // Half the headroom earns the same +0.12 on the 95% and 96% bars, whose
    // headroom is at least the 4-point window, and 100% earns the full top
    // credit there.
    expect(danCreditOffset(0.975, 0.95)).toBeCloseTo(0.117647, 6);
    expect(danCreditOffset(1, 0.95)).toBeCloseTo(1.5, 9);
    // A 97% bar has only 3 points of raw headroom, and accuracy comes cheap
    // on the ladder that uses it (4K LN), so the bonus scores against the
    // window instead: 98.5% is t = 0.375 (halfway out of the flat zone), and
    // 100% tops out at +0.7.
    expect(danCreditOffset(0.985, 0.97)).toBeCloseTo(0.058824, 6);
    expect(danCreditOffset(1, 0.97)).toBeCloseTo(0.7, 6);
  });

  it("decays below the bar and stops at the credit window", () => {
    expect(danCreditOffset(0.955, 0.96)).toBeCloseTo(-0.38375, 6);
    expect(danCreditOffset(0.94, 0.96)).toBeCloseTo(-0.755, 6);
    expect(danCreditOffset(0.92, 0.96)).toBeCloseTo(-1.25, 9);
    expect(danCreditOffset(0.9199, 0.96)).toBeNull();
    expect(danCreditOffset(Number.NaN, 0.96)).toBeNull();
  });

  it("prices a bottom-of-window scrape a bare level down: 92.09% on epsilon+ is delta", () => {
    // The old -1 bottom left 92.09% on an epsilon+ chart inside delta's "+"
    // band; the deepened -1.25 bottom lands the whole epsilon+ band (15.1 to
    // just under 15.26) on plain delta.
    expect(danLabelForTest(creditedDanFor(15.1, 0.9209, 0.96, "rc", 4)!, "rc", 4)).toBe("delta");
    expect(danLabelForTest(creditedDanFor(15.25, 0.9209, 0.96, "rc", 4)!, "rc", 4)).toBe("delta");
  });

  it("prices a 98.3% on a beta++ chart at gamma--, not bare gamma", () => {
    // The second bonus cool-off (2026-08-28): under 99% the curve crawls to
    // +0.2, so the 98s stop buying the next bare level. A 99% still does.
    expect(danLabelForTest(creditedDanFor(12.375, 0.983, 0.96, "rc", 4)!, "rc", 4)).toBe("gamma--");
    expect(danLabelForTest(creditedDanFor(12.375, 0.99, 0.96, "rc", 4)!, "rc", 4)).toBe("gamma");
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
    // Accuracy is cheap to hold on long notes, so the cap is deeper than the
    // 0.26 the other ladders use.
    const offset = danCreditOffset(0.9699, 0.97, { nearBarCap: danCreditNearBarCapFor("ln", 4) });
    expect(offset).toBeCloseTo(-0.75, 9);
    expect(danLabelForTest(7 + offset!, "ln", 4)).toBe("6+");
  });
});

describe("LN decay windows", () => {
  it("is one point on every LN ladder, four on rice", () => {
    expect(danCreditBelowBarWindowFor("ln", 4)).toBe(DAN_CREDIT_LN_BELOW_BAR_WINDOW);
    expect(danCreditBelowBarWindowFor("ln", 6)).toBe(DAN_CREDIT_LN_BELOW_BAR_WINDOW);
    expect(danCreditBelowBarWindowFor("ln", 7)).toBe(DAN_CREDIT_LN_BELOW_BAR_WINDOW);
    expect(danCreditBelowBarWindowFor("rc", 4)).toBe(DAN_CREDIT_BELOW_BAR_WINDOW);
    expect(danCreditBelowBarWindowFor("rc", 7)).toBe(DAN_CREDIT_BELOW_BAR_WINDOW);
  });

  it("stops 6K/7K LN credit one point under the 95% bar", () => {
    // 94.1% still credits; 93.9% is past the window, where the shared four
    // points used to keep crediting down to 91%.
    expect(creditedDanFor(10, 0.941, 0.95, "ln", 7)).toBeCloseTo(10 - 1.151, 3);
    expect(creditedDanFor(10, 0.939, 0.95, "ln", 7)).toBeNull();
    expect(creditedDanFor(10, 0.939, 0.95, "ln", 6)).toBeNull();
    // The bonus half still scores against the standard span: 100% is +1.5.
    expect(creditedDanFor(10, 1, 0.95, "ln", 7)).toBeCloseTo(11.5, 9);
  });

  it("stops crediting one point under the 97% bar", () => {
    // 96.1% is a near-miss and still credits (at least the 0.75 cap down);
    // 95.9% is past the window and credits nothing, where the shared 4-point
    // window used to credit it a level down.
    expect(creditedDanFor(15.15, 0.961, 0.97, "ln", 4)).toBeCloseTo(15.15 - 1.151, 3);
    expect(creditedDanFor(15.15, 0.959, 0.97, "ln", 4)).toBeNull();
    expect(creditedDanFor(14.35, 0.9661, 0.97, "ln", 4)).toBeCloseTo(14.35 - 0.75, 6);
  });

  it("does not re-heat the bonus half: 100% still tops out at +0.7", () => {
    expect(creditedDanFor(10, 1, 0.97, "ln", 4)).toBeCloseTo(10.7, 6);
    expect(creditedDanFor(10, 0.985, 0.97, "ln", 4)).toBeCloseTo(10.058824, 6);
  });
});

describe("creditedDanFor", () => {
  it("applies the offset and window end to end", () => {
    expect(creditedDanFor(15.15, 0.92, 0.96, "rc", 4)).toBeCloseTo(13.9, 6);
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
