import { describe, expect, it } from "vitest";

import { insightCellWidths } from "./-renderers";

describe("insightCellWidths", () => {
  it("keeps ordinary key splits on four equal columns", () => {
    expect(insightCellWidths(824, 4)).toEqual([206, 206, 206, 206]);
  });

  it("makes room for a full 4K through 10K split", () => {
    const widths = insightCellWidths(824, 7);

    expect(widths).toEqual([365, 153, 153, 153]);
    expect(widths.reduce((total, width) => total + width, 0)).toBe(824);
  });

  it("caps the key split so the other readings remain visible", () => {
    const widths = insightCellWidths(824, 20);

    expect(widths[0]).toBeLessThanOrEqual(Math.floor(824 * 0.45));
    expect(widths.slice(1).every((width) => width > 0)).toBe(true);
    expect(widths.reduce((total, width) => total + width, 0)).toBe(824);
  });
});
