import { describe, expect, it } from "vitest";

import { decodeUncompressedTiff } from "./replay-skin-import";

// Builds a minimal little-endian uncompressed TIFF the way Photoshop lays it
// out: header, pixel strip, then one IFD. Enough to cover the renamed-TIFF
// skin assets (Percy LN bodies) that the importer transcodes to PNG.
function buildTiff(options: {
  width: number;
  height: number;
  samples: 3 | 4;
  pixels: number[];
  compression?: number;
  extraSamples?: number;
}): Uint8Array {
  const { width, height, samples, pixels } = options;
  const strip = Uint8Array.from(pixels);
  const stripOffset = 8;
  const ifdOffset = stripOffset + strip.length;
  const entries: Array<[number, number, number, number]> = [
    [256, 4, 1, width],
    [257, 4, 1, height],
    [259, 3, 1, options.compression ?? 1],
    [262, 3, 1, 2],
    [273, 4, 1, stripOffset],
    [277, 3, 1, samples],
    [278, 4, 1, height],
    [279, 4, 1, strip.length],
    [284, 3, 1, 1],
  ];
  if (options.extraSamples != null) entries.push([338, 3, 1, options.extraSamples]);
  // BitsPerSample: values inline for count<=2, otherwise stored after the IFD.
  const bitsInline = samples <= 2;
  const bitsOffset = ifdOffset + 2 + (entries.length + 1) * 12 + 4;
  entries.push([258, 3, samples, bitsInline ? 8 : bitsOffset]);
  entries.sort((a, b) => a[0] - b[0]);

  const size = bitsOffset + samples * 2;
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  bytes[0] = 0x49;
  bytes[1] = 0x49;
  view.setUint16(2, 42, true);
  view.setUint32(4, ifdOffset, true);
  bytes.set(strip, stripOffset);
  view.setUint16(ifdOffset, entries.length, true);
  entries.forEach(([tag, type, count, value], index) => {
    const at = ifdOffset + 2 + index * 12;
    view.setUint16(at, tag, true);
    view.setUint16(at + 2, type, true);
    view.setUint32(at + 4, count, true);
    if (type === 3 && count === 1) view.setUint16(at + 8, value, true);
    else view.setUint32(at + 8, value, true);
  });
  for (let i = 0; i < samples; i += 1) view.setUint16(bitsOffset + i * 2, 8, true);
  return bytes;
}

describe("decodeUncompressedTiff", () => {
  it("decodes an uncompressed RGBA strip", () => {
    const tiff = buildTiff({
      width: 2,
      height: 1,
      samples: 4,
      pixels: [255, 0, 0, 255, 0, 128, 0, 128],
    });
    const decoded = decodeUncompressedTiff(tiff);
    expect(decoded).not.toBeNull();
    expect(decoded?.width).toBe(2);
    expect(decoded?.height).toBe(1);
    expect([...decoded!.rgba]).toEqual([255, 0, 0, 255, 0, 128, 0, 128]);
  });

  it("un-premultiplies associated alpha (ExtraSamples 1, the Photoshop default)", () => {
    const tiff = buildTiff({
      width: 1,
      height: 1,
      samples: 4,
      pixels: [64, 32, 16, 128],
      extraSamples: 1,
    });
    const decoded = decodeUncompressedTiff(tiff);
    expect(decoded).not.toBeNull();
    expect([...decoded!.rgba]).toEqual([128, 64, 32, 128]);
  });

  it("expands RGB to opaque RGBA", () => {
    const tiff = buildTiff({
      width: 1,
      height: 2,
      samples: 3,
      pixels: [10, 20, 30, 40, 50, 60],
    });
    const decoded = decodeUncompressedTiff(tiff);
    expect(decoded).not.toBeNull();
    expect([...decoded!.rgba]).toEqual([10, 20, 30, 255, 40, 50, 60, 255]);
  });

  it("rejects compressed TIFFs and non-TIFF bytes", () => {
    const compressed = buildTiff({
      width: 1,
      height: 1,
      samples: 4,
      pixels: [1, 2, 3, 4],
      compression: 5,
    });
    expect(decodeUncompressedTiff(compressed)).toBeNull();
    expect(decodeUncompressedTiff(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]))).toBeNull();
  });
});
