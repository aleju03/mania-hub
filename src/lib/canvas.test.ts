import { describe, expect, it } from "vitest";
import { filterPixels, parseCanvasFilter } from "./canvas";

const image = (pixels: number[][], width = pixels.length) =>
  ({ data: new Uint8ClampedArray(pixels.flat()), width, height: pixels.length / width, colorSpace: "srgb" }) as ImageData;

describe("canvas filter fallback", () => {
  it("turns any colour white for brightness(0) invert(1), alpha kept", () => {
    const pixels = image([[200, 30, 90, 255], [10, 250, 120, 100]]);
    filterPixels(pixels, parseCanvasFilter("brightness(0) invert(1)"));
    expect([...pixels.data]).toEqual([255, 255, 255, 255, 255, 255, 255, 100]);
  });

  it("runs the spec's sepia matrix and chains functions in order", () => {
    const pixels = image([[100, 150, 200, 255]]);
    filterPixels(pixels, parseCanvasFilter("sepia(1)"));
    // 0.393r + 0.769g + 0.189b, 0.349r + 0.686g + 0.168b, 0.272r + 0.534g + 0.131b
    expect([...pixels.data]).toEqual([192, 171, 134, 255]);
    const chained = image([[100, 150, 200, 255]]);
    filterPixels(chained, parseCanvasFilter("brightness(2) contrast(0)"));
    expect([...chained.data]).toEqual([128, 128, 128, 255]);
  });

  it("spreads a blur without moving its weight or darkening the colour", () => {
    const square = Array.from({ length: 41 * 41 }, (_, i) => (i === 20 * 41 + 20 ? [255, 0, 0, 255] : [0, 0, 0, 0]));
    const pixels = image(square, 41);
    filterPixels(pixels, parseCanvasFilter("blur(3px)"));
    let alpha = 0;
    for (let i = 0; i < pixels.data.length; i += 4) {
      alpha += pixels.data[i + 3];
      if (pixels.data[i + 3] > 0) expect(pixels.data[i]).toBeGreaterThan(250);
    }
    expect(pixels.data[(20 * 41 + 20) * 4 + 3]).toBeLessThan(255);
    expect(Math.abs(alpha - 255)).toBeLessThan(25);
  });
});
