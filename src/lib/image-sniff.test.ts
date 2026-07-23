import { describe, expect, it } from "vitest";
import { sniffImageMime } from "./image-sniff";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const GIF87 = Buffer.from("GIF87a\x01\x00\x01\x00", "latin1");
const GIF89 = Buffer.from("GIF89a\x01\x00\x01\x00", "latin1");
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x24, 0x00, 0x00, 0x00]), Buffer.from("WEBPVP8 ")]);
const BMP = Buffer.concat([Buffer.from("BM"), Buffer.alloc(12)]);
const AVIF = Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x1c]), Buffer.from("ftypavif"), Buffer.alloc(8)]);
const AVIS = Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x1c]), Buffer.from("ftypavis"), Buffer.alloc(8)]);

describe("sniffImageMime", () => {
  it("identifies every supported format from magic bytes", () => {
    expect(sniffImageMime(PNG)).toBe("image/png");
    expect(sniffImageMime(JPEG)).toBe("image/jpeg");
    expect(sniffImageMime(GIF87)).toBe("image/gif");
    expect(sniffImageMime(GIF89)).toBe("image/gif");
    expect(sniffImageMime(WEBP)).toBe("image/webp");
    expect(sniffImageMime(BMP)).toBe("image/bmp");
    expect(sniffImageMime(AVIF)).toBe("image/avif");
    expect(sniffImageMime(AVIS)).toBe("image/avif");
  });

  it("rejects non-image and truncated bytes", () => {
    expect(sniffImageMime(Buffer.from(""))).toBeNull();
    expect(sniffImageMime(Buffer.from("<html><body>nope</body></html>"))).toBeNull();
    expect(sniffImageMime(Buffer.from("GIF90a"))).toBeNull();
    expect(sniffImageMime(PNG.subarray(0, 4))).toBeNull();
    // RIFF container that is not WebP (e.g. WAV audio).
    expect(sniffImageMime(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE")]))).toBeNull();
    // ISO-BMFF that is not AVIF (e.g. MP4 video).
    expect(sniffImageMime(Buffer.concat([Buffer.from([0, 0, 0, 0x1c]), Buffer.from("ftypmp42"), Buffer.alloc(8)]))).toBeNull();
    // "BM" alone without a full BITMAPFILEHEADER.
    expect(sniffImageMime(Buffer.from("BMP"))).toBeNull();
  });
});
