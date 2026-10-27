import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { sniffImageMime } from "./image-sniff";
import { convertThemeAsset, readThemeAssetKind } from "./supporter-theme-asset-upload-server";

describe("convertThemeAsset", () => {
  it("fits a texture inside 2048px without enlarging a small one", async () => {
    const big = await sharp({ create: { width: 4000, height: 1000, channels: 3, background: "#203040" } }).png().toBuffer();
    expect(await sharp(await convertThemeAsset(big, "texture")).metadata()).toMatchObject({ width: 2048, height: 512 });
    const small = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#203040" } }).png().toBuffer();
    expect(await sharp(await convertThemeAsset(small, "texture")).metadata()).toMatchObject({ width: 64, height: 64 });
  });

  it("makes the still and the row their exact sizes, the row keeping its fade", async () => {
    const frame = await sharp({ create: { width: 1280, height: 800, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 0.4 } } }).png().toBuffer();
    const still = await convertThemeAsset(frame, "still");
    expect(sniffImageMime(still)).toBe("image/webp");
    expect(await sharp(still).metadata()).toMatchObject({ width: 1200, height: 630 });
    const row = await sharp(await convertThemeAsset(frame, "row")).metadata();
    expect(row).toMatchObject({ width: 320, height: 200, hasAlpha: true });
  });

  it("knows only its three kinds", () => {
    expect(readThemeAssetKind("row")).toBe("row");
    expect(readThemeAssetKind("motif")).toBeNull();
  });
});
