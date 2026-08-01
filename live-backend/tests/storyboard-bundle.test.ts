import { describe, expect, it } from "vitest";
import { inflateRawSync } from "node:zlib";
import { buildStoredZip } from "../src/audio/hitsound-bundle.js";
import {
  __extractStoryboardFromArchiveBufferForTest,
  __pickRootOsbEntryForTest,
  type ZipDirectoryEntry,
} from "../src/audio/beatmap-archive.js";
import {
  EMPTY_STORYBOARD_BUNDLE_SIZE_BYTES,
  collectStoryboardImagePaths,
  normalizeStoryboardPath,
  osuTextHasStoryboardElements,
  storyboardBundleHasContent,
} from "../src/audio/storyboard-bundle.js";

function entry(overrides: Partial<ZipDirectoryEntry> & { path: string }): ZipDirectoryEntry {
  const size = overrides.uncompressedSize ?? 1000;
  return {
    compressedSize: size,
    uncompressedSize: size,
    compressionMethod: 0,
    flags: 0,
    localHeaderOffset: 0,
    ...overrides,
  };
}

// Reads store or deflate entries back out of a bundle zip.
function readZip(buffer: Buffer): Array<{ path: string; method: number; data: Buffer }> {
  const eocdOffset = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(eocdOffset).toBeGreaterThanOrEqual(0);
  const count = buffer.readUInt16LE(eocdOffset + 10);
  const centralOffset = buffer.readUInt32LE(eocdOffset + 16);

  const files: Array<{ path: string; method: number; data: Buffer }> = [];
  let offset = centralOffset;
  for (let i = 0; i < count; i++) {
    expect(buffer.readUInt32LE(offset)).toBe(0x02014b50);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const path = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");

    expect(buffer.readUInt32LE(localOffset)).toBe(0x04034b50);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    const data = method === 0 ? Buffer.from(raw) : inflateRawSync(raw);
    expect(data.length).toBe(uncompressedSize);
    files.push({ path, method, data });

    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

// Minimal in-memory zip builder so archive-buffer extraction can be tested
// without fixtures. Deflate keeps the local header sizes honest.
function buildTestArchive(files: Array<{ path: string; data: Buffer }>): ArrayBuffer {
  const zip = buildStoredZip(files.map((file) => ({ ...file, deflate: true })));
  const out = new ArrayBuffer(zip.byteLength);
  new Uint8Array(out).set(zip);
  return out;
}

describe("normalizeStoryboardPath", () => {
  it("matches the frontend normalization", () => {
    expect(normalizeStoryboardPath('"SB\\Light.PNG"')).toBe("sb/light.png");
    expect(normalizeStoryboardPath("./bg.jpg")).toBe("bg.jpg");
  });
});

describe("collectStoryboardImagePaths", () => {
  it("collects sprite paths with variables and animation frames", () => {
    const osb = [
      "[Variables]",
      "$dir=SB\\fx",
      "[Events]",
      'Sprite,Background,Centre,"$dir\\glow.png",320,240',
      " F,0,0,1000,1",
      'Animation,Foreground,Centre,"$dir\\burst.png",0,0,3,50,LoopOnce',
      '4,3,1,"plain.jpg",0,0',
      'Sample,1000,0,"clap.wav",70',
    ].join("\n");
    const osu = ["[Events]", 'Sprite,Overlay,Centre,"osu-only.png",0,0'].join("\n");

    const paths = collectStoryboardImagePaths(osb, [osu]);
    expect([...paths].sort()).toEqual([
      "osu-only.png",
      "plain.jpg",
      "sb/fx/burst0.png",
      "sb/fx/burst1.png",
      "sb/fx/burst2.png",
      "sb/fx/glow.png",
    ]);
  });

  it("returns nothing without events", () => {
    expect(collectStoryboardImagePaths(null, ["[Metadata]\nTitle:x"]).size).toBe(0);
  });
});

describe("osuTextHasStoryboardElements", () => {
  it("detects sprites only inside [Events]", () => {
    expect(osuTextHasStoryboardElements('[Events]\nSprite,Foreground,Centre,"a.png",0,0')).toBe(true);
    expect(osuTextHasStoryboardElements('[Events]\n0,0,"bg.jpg",0,0\n2,100,200')).toBe(false);
    expect(osuTextHasStoryboardElements("[Metadata]\nTitle:Sprite,decoy")).toBe(false);
  });
});

describe("buildStoredZip deflate entries", () => {
  it("recognizes the durable empty-zip storyboard marker", () => {
    const empty = buildStoredZip([]);
    const populated = buildStoredZip([{ path: "storyboard.osb", data: Buffer.from("[Events]") }]);
    expect(empty.length).toBe(EMPTY_STORYBOARD_BUNDLE_SIZE_BYTES);
    expect(storyboardBundleHasContent(empty.length)).toBe(false);
    expect(storyboardBundleHasContent(populated.length)).toBe(true);
  });

  it("round-trips deflated text next to stored binaries", () => {
    const text = Buffer.from("[Events]\n".repeat(1000), "utf8");
    const image = Buffer.from([1, 2, 3, 4]);
    const zip = buildStoredZip([
      { path: "storyboard.osb", data: text, deflate: true },
      { path: "files/bg.jpg", data: image },
    ]);
    const read = readZip(zip);
    expect(read.map((file) => [file.path, file.method])).toEqual([
      ["storyboard.osb", 8],
      ["files/bg.jpg", 0],
    ]);
    expect(read[0].data).toEqual(text);
    expect(read[1].data).toEqual(image);
    // The deflated entry actually shrinks in the container.
    expect(zip.length).toBeLessThan(text.length);
  });
});

describe("__pickRootOsbEntryForTest", () => {
  it("prefers the largest root-level .osb and ignores nested ones", () => {
    const picked = __pickRootOsbEntryForTest([
      entry({ path: "sb/meta.osb", uncompressedSize: 5000 }),
      entry({ path: "Artist - Title (Creator).osb", uncompressedSize: 400 }),
      entry({ path: "Artist - Title (Creator) v2.osb", uncompressedSize: 900 }),
      entry({ path: "song.mp3", uncompressedSize: 100000 }),
    ]);
    expect(picked?.path).toBe("Artist - Title (Creator) v2.osb");
  });

  it("returns null when no root .osb exists", () => {
    expect(__pickRootOsbEntryForTest([entry({ path: "sb/meta.osb" })])).toBeNull();
  });
});

describe("__extractStoryboardFromArchiveBufferForTest", () => {
  const callbacks = {
    osuTextHasStoryboard: osuTextHasStoryboardElements,
    collectImagePaths: collectStoryboardImagePaths,
  };

  it("extracts the root .osb and referenced images by normalized path", () => {
    const osb = [
      "[Events]",
      'Sprite,Overlay,Centre,"SB\\arrow.png",320,240',
      " F,0,0,1000,1",
      'Sprite,Overlay,Centre,"missing.png",0,0',
      " F,0,0,1000,1",
    ].join("\n");
    const archive = buildTestArchive([
      { path: "Artist - Title (Creator).osb", data: Buffer.from(osb, "utf8") },
      { path: "sb/Arrow.png", data: Buffer.from([9, 9, 9]) },
      { path: "unreferenced.png", data: Buffer.from([1]) },
      { path: "audio.mp3", data: Buffer.from([2]) },
    ]);

    const result = __extractStoryboardFromArchiveBufferForTest(archive, callbacks);
    expect(result.osbText).toContain("SB\\arrow.png");
    expect(result.images.map((image) => image.path)).toEqual(["sb/arrow.png"]);
    expect(result.images[0].data).toEqual(Buffer.from([9, 9, 9]));
    expect(result.dropped).toBe(0);
  });

  it("pulls images referenced only by a .osu embedded storyboard", () => {
    const osu = [
      "[General]",
      "Mode: 3",
      "[Events]",
      'Sprite,Foreground,Centre,"fg.jpg",0,0',
      " F,0,0,1000,1",
      "[HitObjects]",
    ].join("\n");
    const archive = buildTestArchive([
      { path: "map [diff].osu", data: Buffer.from(osu, "utf8") },
      { path: "fg.jpg", data: Buffer.from([7]) },
    ]);

    const result = __extractStoryboardFromArchiveBufferForTest(archive, callbacks);
    expect(result.osbText).toBeNull();
    expect(result.images.map((image) => image.path)).toEqual(["fg.jpg"]);
  });

  it("returns an empty result when the set has no storyboard", () => {
    const osu = ["[General]", "Mode: 3", "[Events]", '0,0,"bg.jpg",0,0', "[HitObjects]"].join("\n");
    const archive = buildTestArchive([
      { path: "map [diff].osu", data: Buffer.from(osu, "utf8") },
      { path: "bg.jpg", data: Buffer.from([7]) },
    ]);

    const result = __extractStoryboardFromArchiveBufferForTest(archive, callbacks);
    expect(result.osbText).toBeNull();
    expect(result.images).toEqual([]);
  });

  it("counts oversized images as dropped", () => {
    const osb = ["[Events]", 'Sprite,Overlay,Centre,"big.png",0,0', " F,0,0,1000,1"].join("\n");
    const archive = buildTestArchive([
      { path: "Artist - Title (x).osb", data: Buffer.from(osb, "utf8") },
      { path: "big.png", data: Buffer.alloc(64, 1) },
    ]);

    const result = __extractStoryboardFromArchiveBufferForTest(archive, callbacks, 16);
    expect(result.images).toEqual([]);
    expect(result.dropped).toBe(1);
  });
});
