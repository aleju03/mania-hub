import { describe, expect, it } from "vitest";
import {
  DAN_CREDIT_4K_LN_BELOW_BAR_WINDOW,
  DAN_CREDIT_BELOW_BAR_WINDOW,
  DAN_CREDIT_LN_BELOW_BAR_WINDOW,
  creditedDanFor,
  danCreditBelowBarWindowFor,
  danCreditNearBarCapFor,
  danCreditOffset,
  danCreditOptionsFor,
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
    // A 97% bar has only 3 points of raw headroom, so the shared table scores
    // it against the window instead. The ladder that uses that bar (4K LN)
    // does not read this table at all any more (danCreditOptionsFor), but the
    // clamp itself still holds for anyone who passes no anchors.
    expect(danCreditOffset(0.985, 0.97)).toBeCloseTo(0.058824, 6);
    expect(danCreditOffset(1, 0.97)).toBeCloseTo(0.7, 6);
  });

  it("decays below the bar and stops at the credit window", () => {
    expect(danCreditOffset(0.955, 0.96)).toBeCloseTo(-0.38375, 6);
    expect(danCreditOffset(0.94, 0.96)).toBeCloseTo(-0.755, 6);
    expect(danCreditOffset(0.92, 0.96)).toBeCloseTo(-1.25, 9);
    expect(danCreditOffset(0.91, 0.96)).toBeCloseTo(-1.5, 9);
    expect(danCreditOffset(0.9099, 0.96)).toBeNull();
    expect(danCreditOffset(Number.NaN, 0.96)).toBeNull();
  });

  it("extends the rice decay to 91% without re-pricing what already credited", () => {
    // The window went from four points to five (2026-08-31). The knee sits at
    // the old edge, so every accuracy the four-point window credited credits
    // exactly the same today and only the 91-92% band is new.
    // The table as it stood before the widening: a straight line to -1.25 over
    // four points.
    const fourPointWindow = (accuracy: number) => danCreditOffset(accuracy, 0.96, {
      belowBar: [[0, -0.26], [1, -1.25]],
      belowBarWindow: 0.04,
    });
    for (const accuracy of [0.9599, 0.958, 0.955, 0.95, 0.94, 0.93, 0.92]) {
      expect(danCreditOffset(accuracy, 0.96)).toBeCloseTo(fourPointWindow(accuracy)!, 9);
    }
    expect(fourPointWindow(0.91)).toBeNull();
    expect(danCreditOffset(0.91, 0.96)).toBeCloseTo(-1.5, 9);
  });

  it("keeps the bonus on its own span when the decay window is wider than the headroom", () => {
    // A 96% bar has four points of headroom and a five point window. The bonus
    // scores against the four, so a 100% is still the full +1.5 rather than
    // two thirds of the way up the table.
    expect(danCreditOffset(1, 0.96)).toBeCloseTo(1.5, 9);
    expect(danCreditOffset(0.98, 0.96)).toBeCloseTo(0.117647, 6);
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

  it("keeps the 4K LN step at the bar small", () => {
    // The cap used to be 0.75, which cost a full level between 97% and
    // 96.99%. The decay anchors carry that pricing half a point lower now.
    const offset = danCreditOffset(0.9699, 0.97, danCreditOptionsFor("ln", 4));
    expect(offset).toBeCloseTo(-0.312, 6);
    expect(danCreditOffset(0.965, 0.97, danCreditOptionsFor("ln", 4))).toBeCloseTo(-0.9, 9);
  });
});

describe("LN decay windows", () => {
  it("is three points on the stable LN ladders, 2.5 on 4K LN, five on rice", () => {
    expect(danCreditBelowBarWindowFor("ln", 4)).toBe(DAN_CREDIT_4K_LN_BELOW_BAR_WINDOW);
    expect(danCreditBelowBarWindowFor("ln", 6)).toBe(DAN_CREDIT_LN_BELOW_BAR_WINDOW);
    expect(danCreditBelowBarWindowFor("ln", 7)).toBe(DAN_CREDIT_LN_BELOW_BAR_WINDOW);
    expect(danCreditBelowBarWindowFor("rc", 4)).toBe(DAN_CREDIT_BELOW_BAR_WINDOW);
    expect(danCreditBelowBarWindowFor("rc", 7)).toBe(DAN_CREDIT_BELOW_BAR_WINDOW);
  });

  it("stops 6K/7K LN credit three points under the 95% bar", () => {
    // 92.1% still credits; 91.9% is past the window, where the shared table
    // would have kept crediting down to 90%.
    expect(creditedDanFor(10, 0.921, 0.95, "ln", 7)).toBeCloseTo(10 - 1.725, 4);
    expect(creditedDanFor(10, 0.919, 0.95, "ln", 7)).toBeNull();
    expect(creditedDanFor(10, 0.919, 0.95, "ln", 6)).toBeNull();
    // The bonus half still scores against the standard span: 100% is +1.5.
    expect(creditedDanFor(10, 1, 0.95, "ln", 7)).toBeCloseTo(11.5, 9);
  });

  it("extends the 6K/7K LN decay to 92% without re-pricing what already credited", () => {
    // The window tripled (2026-08-31), but the knee at a third of it keeps the
    // first point under the bar on the exact line the one-point window drew,
    // so every accuracy that already credited credits the same today. Only the
    // 92-94% band is new, and it extends a quarter level per point.
    const at = (accuracy: number) => danCreditOffset(accuracy, 0.95, danCreditOptionsFor("ln", 7));
    const onePointWindow = (accuracy: number) => danCreditOffset(accuracy, 0.95, {
      nearBarCap: 0.26,
      belowBar: [[0, -0.26], [1, -1.25]],
      belowBarWindow: 0.01,
    });
    for (const accuracy of [0.9499, 0.949, 0.947, 0.945, 0.942, 0.94]) {
      expect(at(accuracy)).toBeCloseTo(onePointWindow(accuracy)!, 9);
    }
    expect(at(0.949)).toBeCloseTo(-0.359, 6);
    expect(at(0.945)).toBeCloseTo(-0.755, 6);
    expect(at(0.94)).toBeCloseTo(-1.25, 6);
    expect(at(0.935)).toBeCloseTo(-1.375, 6);
    expect(at(0.93)).toBeCloseTo(-1.5, 6);
    expect(at(0.92)).toBeCloseTo(-1.75, 6);
    expect(at(0.9199)).toBeNull();
    // 6K reads the same table, and 4K LN keeps its own.
    expect(at(0.94)).toBeCloseTo(danCreditOffset(0.94, 0.95, danCreditOptionsFor("ln", 6))!, 9);
  });

  it("credits 2.5 points under the 97% ScoreV2 bar, in a straight line", () => {
    // The window ends at 94.5%: a ScoreV2 point on 4K LN is not the cheap
    // point the stable ladders price. The decay runs from the ladder's own 0.3
    // cap at the bar to -1.55 at the cutoff, deeper than the -1.25 the
    // narrower windows bottom out at.
    expect(creditedDanFor(15.15, 0.965, 0.97, "ln", 4)).toBeCloseTo(15.15 - 0.9, 6);
    expect(creditedDanFor(15.15, 0.96, 0.97, "ln", 4)).toBeCloseTo(15.15 - 1.0625, 6);
    expect(creditedDanFor(15.15, 0.95, 0.97, "ln", 4)).toBeCloseTo(15.15 - 1.3875, 6);
    expect(creditedDanFor(15.15, 0.945, 0.97, "ln", 4)).toBeCloseTo(15.15 - 1.55, 6);
    expect(creditedDanFor(15.15, 0.9449, 0.97, "ln", 4)).toBeNull();
    expect(creditedDanFor(14.35, 0.9699, 0.97, "ln", 4)).toBeCloseTo(14.35 - 0.312, 6);
  });

  it("prices a 94.74% on a 14 dan chart at 13--", () => {
    // The bottom is -1.55 rather than -1.5 so this run lands in that band
    // (12.5 to just under 12.55) instead of one above it.
    const credited = creditedDanFor(14, 0.9474, 0.97, "ln", 4)!;
    expect(credited).toBeCloseTo(12.528, 3);
    expect(danLabelForTest(credited, "ln", 4)).toBe("13--");
  });

  it("tops the bonus out at 99.7% and holds it to 100%", () => {
    // ScoreV2 hands out no 100% on a chart with long notes, so the top anchor
    // sits on an accuracy people reach. The +0.7 top itself is unchanged.
    expect(creditedDanFor(10, 0.997, 0.97, "ln", 4)).toBeCloseTo(10.7, 6);
    expect(creditedDanFor(10, 0.999, 0.97, "ln", 4)).toBeCloseTo(10.7, 6);
    expect(creditedDanFor(10, 1, 0.97, "ln", 4)).toBeCloseTo(10.7, 6);
    // The band under the top is a real bonus now, not the +0.001 the shared
    // headroom table paid at 98.01%.
    expect(creditedDanFor(10, 0.98, 0.97, "ln", 4)).toBeCloseTo(10, 9);
    expect(creditedDanFor(10, 0.985, 0.97, "ln", 4)).toBeCloseTo(10.15, 6);
    expect(creditedDanFor(10, 0.99, 0.97, "ln", 4)).toBeCloseTo(10.3, 6);
    expect(creditedDanFor(10, 0.995, 0.97, "ln", 4)).toBeCloseTo(10.5, 6);
  });

  it("is monotone across 4K LN's whole credited range", () => {
    let previous: number | null = null;
    for (let step = 0; step <= 120; step += 1) {
      const accuracy = 0.94 + step * 0.0005;
      const offset = danCreditOffset(accuracy, 0.97, danCreditOptionsFor("ln", 4));
      if (offset == null) {
        expect(previous).toBeNull();
        continue;
      }
      if (previous != null) expect(offset).toBeGreaterThanOrEqual(previous);
      previous = offset;
    }
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
