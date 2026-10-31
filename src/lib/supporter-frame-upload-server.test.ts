import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { sniffImageMime } from "./image-sniff";
import { convertFrameStill } from "./supporter-frame-upload-server";

/* A transparent square at `size` with an opaque ring of `band` px drawn
   `out` px outside the template's avatar (scaled to `size`), plus `extra`. */
async function frame(size: number, { out = 10, band = 8, top = 0, fill = false }: { out?: number; band?: number; top?: number; fill?: boolean } = {}) {
  const k = size / 384;
  const a = Math.round((68 - out) * k), b = Math.round((68 + 248 + out) * k), w = Math.max(1, Math.round(band * k));
  const rects = [
    `<rect x="${a}" y="${a - Math.round(top * k)}" width="${b - a}" height="${w}"/>`,
    `<rect x="${a}" y="${b - w}" width="${b - a}" height="${w}"/>`,
    `<rect x="${a}" y="${a}" width="${w}" height="${b - a}"/>`,
    `<rect x="${b - w}" y="${a}" width="${w}" height="${b - a}"/>`,
    fill ? `<rect x="${a}" y="${a}" width="${b - a}" height="${b - a}"/>` : "",
  ].join("");
  return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><g fill="#b5e854">${rects}</g></svg>`)).png().toBuffer();
}

describe("convertFrameStill", () => {
  it("fits the art to the template as a PNG and measures how far it reaches past the avatar", async () => {
    const result = await convertFrameStill(await frame(768, { out: 31, top: 20 }));
    if (!result.ok) throw new Error(result.error);
    expect(sniffImageMime(result.png)).toBe("image/png");
    const meta = await sharp(result.png).metadata();
    expect([meta.width, meta.height, meta.hasAlpha]).toEqual([384, 384, true]);
    // 31px of 248 out on every side, 20px more on top
    expect(result.overhang[0]).toBeCloseTo(31 / 248, 2);
    expect(result.overhang[1]).toBeCloseTo(51 / 248, 2);
    expect(result.overhang[2]).toBeCloseTo(31 / 248, 2);
    expect(result.overhang[3]).toBeCloseTo(31 / 248, 2);
  });

  it("reads art kept inside the avatar's edge as reaching nowhere", async () => {
    const result = await convertFrameStill(await frame(384, { out: -4 }));
    expect(result.ok && result.overhang).toEqual([0, 0, 0, 0]);
  });

  it("keeps a round version's circle clear rather than the square", async () => {
    // a ring hugging the square's corners covers little of the circle inside it
    const corners = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="384" height="384"><g fill="#b5e854">${[[68, 68], [256, 68], [68, 256], [256, 256]].map(([x, y]) => `<rect x="${x}" y="${y}" width="60" height="60"/>`).join("")}</g></svg>`);
    const png = await sharp(corners).png().toBuffer();
    expect((await convertFrameStill(png, { round: true })).ok).toBe(true);
    // a disc over the middle hides the round avatar
    const disc = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="384" height="384"><circle cx="192" cy="192" r="110" fill="#000"/></svg>`)).png().toBuffer();
    expect((await convertFrameStill(disc, { round: true })).ok).toBe(false);
  });

  it("refuses art that is not square, too small, opaque, empty, or covers the avatar", async () => {
    const wide = await sharp({ create: { width: 400, height: 300, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    expect((await convertFrameStill(wide)).ok).toBe(false);
    expect((await convertFrameStill(await frame(120))).ok).toBe(false);
    const opaque = await sharp({ create: { width: 384, height: 384, channels: 3, background: "#ffffff" } }).png().toBuffer();
    expect(await convertFrameStill(opaque)).toMatchObject({ ok: false, error: expect.stringContaining("transparent") });
    const empty = await sharp({ create: { width: 384, height: 384, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    expect(await convertFrameStill(empty)).toMatchObject({ ok: false, error: expect.stringContaining("empty") });
    expect(await convertFrameStill(await frame(384, { fill: true }))).toMatchObject({ ok: false, error: expect.stringContaining("covers") });
  });
});
