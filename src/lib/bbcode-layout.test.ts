import { describe, expect, it } from "vitest";
import { EDITOR_COLUMN_GUTTER, OSU_PROFILE_COLUMN_WIDTH, columnFitScale } from "./bbcode-layout";

const FULL = OSU_PROFILE_COLUMN_WIDTH + 2 * EDITOR_COLUMN_GUTTER;

describe("columnFitScale", () => {
  it("shows the column at 1:1 once the pane can hold it", () => {
    expect(columnFitScale(FULL)).toBe(1);
    expect(columnFitScale(FULL + 400)).toBe(1);
  });

  it("never scales the column up past osu!'s own width", () => {
    // A wider pane must not make images look bigger than they will be, which is
    // the same mistake as making them look smaller.
    expect(columnFitScale(4000)).toBe(1);
  });

  it("shrinks the whole column to fit a narrow pane", () => {
    expect(columnFitScale(FULL / 2)).toBeCloseTo(0.5, 5);
  });

  it("survives a pane that has not been measured yet", () => {
    // ResizeObserver fires with 0 for a hidden pane (the mobile write/preview
    // switch); a 0 or NaN scale would collapse the surface to nothing.
    expect(columnFitScale(0)).toBe(1);
    expect(columnFitScale(Number.NaN)).toBe(1);
    expect(columnFitScale(-50)).toBe(1);
  });
});
