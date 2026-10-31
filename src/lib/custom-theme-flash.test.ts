import { describe, expect, it } from "vitest";
import { FLASH_FPS, FLASH_LIMIT, flashReport } from "./custom-theme-editor-gl";

const W = 16, H = 10;
/* A frame painted one grey, or one grey on the left half only. */
function frame(grey: number, half = false): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const at = (y * W + x) * 4;
    const value = half && x >= W / 2 ? 10 : grey;
    pixels[at] = pixels[at + 1] = pixels[at + 2] = value;
    pixels[at + 3] = 255;
  }
  return pixels;
}
const seconds = (n: number, at: (t: number) => Uint8ClampedArray) => Array.from({ length: n * FLASH_FPS }, (_, i) => at(i / FLASH_FPS));

describe("flashReport", () => {
  it("catches a full-screen black and white strobe", () => {
    const strobe = seconds(3, (t) => frame(Math.floor(t * 16) % 2 ? 255 : 0));
    expect(flashReport(strobe, W, H).flashes).toBeGreaterThan(FLASH_LIMIT);
  });

  it("catches a strobe on a quarter of the screen", () => {
    const strobe = seconds(3, (t) => {
      const pixels = frame(10);
      if (Math.floor(t * 12) % 2) for (let y = 0; y < H / 2; y++) for (let x = 0; x < W / 2; x++) pixels.fill(255, (y * W + x) * 4, (y * W + x) * 4 + 3);
      return pixels;
    });
    expect(flashReport(strobe, W, H).flashes).toBeGreaterThan(FLASH_LIMIT);
  });

  it("lets a slow pulse, a gentle shimmer and a still frame through", () => {
    // twice a second, full swing
    expect(flashReport(seconds(3, (t) => frame(Math.floor(t * 4) % 2 ? 200 : 20)), W, H).flashes).toBeLessThanOrEqual(FLASH_LIMIT);
    // fast but faint: a few greys up and down in the dark
    expect(flashReport(seconds(3, (t) => frame(30 + (Math.floor(t * 20) % 2) * 8)), W, H).flashes).toBe(0);
    expect(flashReport(seconds(3, () => frame(40)), W, H).flashes).toBe(0);
  });

  it("says when the worst second is", () => {
    const late = seconds(4, (t) => frame(t >= 2 && Math.floor(t * 16) % 2 ? 255 : 0));
    const report = flashReport(late, W, H);
    expect(report.flashes).toBeGreaterThan(FLASH_LIMIT);
    expect(report.at).toBeGreaterThanOrEqual(1.9);
  });
});
