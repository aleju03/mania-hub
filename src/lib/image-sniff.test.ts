import { describe, expect, it } from "vitest";
import { readImageSize, sniffImageMime } from "./image-sniff";

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

/* Real headers, hand-built, because the OG card lays a granted motif out from
   these numbers alone: an image measured wrong is scattered stretched. */
function pngOf(width: number, height: number): Buffer {
  const header = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write("IHDR", 12);
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header;
}

function jpegOf(width: number, height: number): Buffer {
  // SOI, one APP0 to be skipped over, then the SOF0 that carries the size.
  const app0 = Buffer.concat([Buffer.from([0xff, 0xe0, 0x00, 0x10]), Buffer.from("JFIF\0"), Buffer.alloc(9)]);
  const sof = Buffer.alloc(11);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(9, 2);
  sof.writeUInt8(8, 4);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof]);
}

function gifOf(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(10);
  bytes.write("GIF89a", 0, "latin1");
  bytes.writeUInt16LE(width, 6);
  bytes.writeUInt16LE(height, 8);
  return bytes;
}

function webpVp8xOf(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(30);
  bytes.write("RIFF", 0);
  bytes.write("WEBP", 8);
  bytes.write("VP8X", 12);
  bytes.writeUIntLE(width - 1, 24, 3);
  bytes.writeUIntLE(height - 1, 27, 3);
  return bytes;
}

describe("readImageSize", () => {
  it("reads dimensions out of each format's header", () => {
    expect(readImageSize(pngOf(512, 288))).toEqual({ width: 512, height: 288 });
    expect(readImageSize(jpegOf(1920, 1080))).toEqual({ width: 1920, height: 1080 });
    expect(readImageSize(gifOf(64, 96))).toEqual({ width: 64, height: 96 });
    expect(readImageSize(webpVp8xOf(300, 200))).toEqual({ width: 300, height: 200 });
  });

  it("reads a BMP's height as a magnitude, since top-down rows store it negative", () => {
    const bytes = Buffer.alloc(26);
    bytes.write("BM", 0);
    bytes.writeUInt32LE(120, 18);
    bytes.writeInt32LE(-80, 22);
    expect(readImageSize(bytes)).toEqual({ width: 120, height: 80 });
  });

  it("gives up rather than guessing on truncated, unknown or unparsed formats", () => {
    expect(readImageSize(pngOf(10, 10).subarray(0, 20))).toBeNull();
    expect(readImageSize(Buffer.from("not an image"))).toBeNull();
    // AVIF sniffs fine but its size is not read; callers fall back to square.
    expect(readImageSize(AVIF)).toBeNull();
    // A JPEG that never reaches a start-of-frame.
    expect(readImageSize(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0x00, 0x00]))).toBeNull();
  });
});
