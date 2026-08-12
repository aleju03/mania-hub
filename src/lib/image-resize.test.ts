import { describe, expect, it } from "vitest";
import { OSU_PROFILE_COLUMN_WIDTH } from "./bbcode-layout";
import { findPictureColumns, MAX_ENCODED_FILE_WIDTH, planImageEncode } from "./image-resize";

/** RGBA rows with an opaque band from `left` for `width` px, empty either side. */
function pixels(fileWidth: number, height: number, left: number, width: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(fileWidth * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = left; x < left + width; x += 1) data[(y * fileWidth + x) * 4 + 3] = 255;
  }
  return data;
}

/** What osu! will lay the picture out at: the file fit to the column. */
function displayedContentWidth(plan: { fileWidth: number; contentWidth: number }): number {
  const scale = Math.min(1, OSU_PROFILE_COLUMN_WIDTH / plan.fileWidth);
  return plan.contentWidth * scale;
}

describe("planImageEncode", () => {
  it("pads a wide screenshot instead of dropping its pixels", () => {
    const plan = planImageEncode({ width: 1590, height: 1105 }, 732, { align: "left" });
    expect(plan.padded).toBe(true);
    expect(plan.contentWidth).toBe(1590); // every source pixel kept
    expect(plan.fileWidth).toBeGreaterThan(OSU_PROFILE_COLUMN_WIDTH);
    expect(displayedContentWidth(plan)).toBeCloseTo(732, 0);
  });

  it("keeps the file as it is when the picture already fills the column", () => {
    const plan = planImageEncode({ width: 1590, height: 1105 }, OSU_PROFILE_COLUMN_WIDTH);
    expect(plan.padded).toBe(false);
    expect(plan.fileWidth).toBe(1590);
    expect(plan.contentWidth).toBe(1590);
  });

  it("caps the file width, resampling only for what is past the cap", () => {
    const plan = planImageEncode({ width: 4000, height: 1000 }, 200);
    expect(plan.fileWidth).toBeLessThanOrEqual(MAX_ENCODED_FILE_WIDTH);
    expect(plan.contentWidth).toBeLessThan(4000);
    expect(plan.contentWidth / plan.displayWidth).toBeGreaterThan(2); // still supersampled
    expect(displayedContentWidth(plan)).toBeCloseTo(200, 0);
  });

  it("caps the canvas area for a very tall source", () => {
    const plan = planImageEncode({ width: 2000, height: 20000 }, 800);
    expect(plan.fileWidth * plan.fileHeight).toBeLessThanOrEqual(40_000_000);
    expect(displayedContentWidth(plan)).toBeCloseTo(800, 0);
  });

  it("puts the margin where the alignment leaves the picture", () => {
    const source = { width: 1590, height: 1105 };
    const left = planImageEncode(source, 600, { align: "left" });
    const centre = planImageEncode(source, 600, { align: "center" });
    const right = planImageEncode(source, 600, { align: "right" });
    const margin = left.fileWidth - left.contentWidth;
    expect(left.contentLeft).toBe(0);
    expect(centre.contentLeft).toBe(Math.round(margin / 2));
    expect(right.contentLeft).toBe(margin);
  });

  it("writes the picture at its own size when padding is off", () => {
    const plan = planImageEncode({ width: 1590, height: 1105 }, 732, { pad: false });
    expect(plan.padded).toBe(false);
    expect(plan.fileWidth).toBe(732);
    expect(plan.contentWidth).toBe(732);
  });

  it("never upscales to make room for margins", () => {
    const plan = planImageEncode({ width: 400, height: 300 }, 600);
    expect(plan.padded).toBe(false);
    expect(plan.fileWidth).toBe(600);
  });

  it("lands within a pixel of the requested width across sizes", () => {
    for (const width of [40, 120, 333, 500, 732, 889, 890]) {
      const plan = planImageEncode({ width: 1590, height: 1105 }, width);
      expect(Math.abs(displayedContentWidth(plan) - width)).toBeLessThan(1);
    }
  });

  it("clamps a request past the column to the column", () => {
    const plan = planImageEncode({ width: 3000, height: 1000 }, 4000);
    expect(plan.displayWidth).toBe(OSU_PROFILE_COLUMN_WIDTH);
  });
});

describe("findPictureColumns", () => {
  it("finds the picture inside a file this module padded", () => {
    const plan = planImageEncode({ width: 200, height: 50 }, 120, { align: "center" });
    const data = pixels(plan.fileWidth, plan.fileHeight, plan.contentLeft, plan.contentWidth);
    expect(findPictureColumns(data, plan.fileWidth, plan.fileHeight)).toEqual({
      left: plan.contentLeft,
      width: plan.contentWidth,
    });
  });

  it("leaves an image with no margins alone", () => {
    expect(findPictureColumns(pixels(100, 10, 0, 100), 100, 10)).toEqual({ left: 0, width: 100 });
  });

  it("leaves a thin transparent border alone", () => {
    expect(findPictureColumns(pixels(100, 10, 0, 99), 100, 10)).toEqual({ left: 0, width: 100 });
  });

  it("reads a fully transparent file as itself", () => {
    expect(findPictureColumns(new Uint8ClampedArray(40 * 10 * 4), 40, 10)).toEqual({ left: 0, width: 40 });
  });
});
