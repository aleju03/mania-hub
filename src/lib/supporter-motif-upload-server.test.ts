import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { sniffImageMime } from "./image-sniff";
import { convertSupporterMotif } from "./supporter-motif-upload-server";

describe("convertSupporterMotif", () => {
  it("fits an upload inside 256px as a WebP that keeps its transparency", async () => {
    const source = await sharp({ create: { width: 1200, height: 600, channels: 4, background: { r: 255, g: 102, b: 171, alpha: 0.5 } } }).png().toBuffer();
    const out = await convertSupporterMotif(source);
    expect(sniffImageMime(out)).toBe("image/webp");
    const meta = await sharp(out).metadata();
    expect([meta.width, meta.height]).toEqual([256, 128]);
    expect(meta.hasAlpha).toBe(true);
  });

  it("never enlarges a small image", async () => {
    const source = await sharp({ create: { width: 40, height: 40, channels: 3, background: "#ffffff" } }).jpeg().toBuffer();
    const meta = await sharp(await convertSupporterMotif(source)).metadata();
    expect([meta.width, meta.height]).toEqual([40, 40]);
  });

  it("refuses bytes that are not an image", async () => {
    await expect(convertSupporterMotif(Buffer.from("not an image"))).rejects.toThrow();
  });
});
