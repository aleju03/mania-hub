import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { convertCompanionImage } from "./supporter-companion-upload-server";

function frame(r: number, g: number, b: number) {
  return sharp({ create: { width: 800, height: 600, channels: 4, background: { r, g, b, alpha: 1 } } }).png().toBuffer();
}

describe("convertCompanionImage", () => {
  it("keeps every frame of an animated GIF, fitted inside 512px", async () => {
    const frames = await Promise.all([frame(255, 0, 0), frame(0, 255, 0), frame(0, 0, 255)]);
    const gif = await sharp(frames, { join: { animated: true } }).gif({ delay: [100, 100, 100], loop: 0 }).toBuffer();
    const out = await sharp(await convertCompanionImage(gif), { animated: true }).metadata();
    expect(out.format).toBe("webp");
    expect(out.pages).toBe(3);
    expect(out.width).toBe(512);
    expect(out.pageHeight).toBe(384);
  });

  it("turns a still image into a single-frame WebP", async () => {
    const out = await sharp(await convertCompanionImage(await frame(10, 20, 30))).metadata();
    expect(out.format).toBe("webp");
    expect(out.pages ?? 1).toBe(1);
    expect(out.width).toBe(512);
  });
});
