import { describe, expect, it } from "vitest";
import { inflateRawSync } from "node:zlib";
import { buildStoredZip } from "../src/audio/hitsound-bundle.js";
import { selectHitsoundArchiveEntries, type ZipDirectoryEntry } from "../src/audio/beatmap-archive.js";

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

// Minimal store-only zip reader used to verify round-trips without adding a
// zip dependency.
function readStoredZip(buffer: Buffer): Array<{ path: string; data: Buffer }> {
  const eocdOffset = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(eocdOffset).toBeGreaterThanOrEqual(0);
  const count = buffer.readUInt16LE(eocdOffset + 10);
  const centralOffset = buffer.readUInt32LE(eocdOffset + 16);

  const files: Array<{ path: string; data: Buffer }> = [];
  let offset = centralOffset;
  for (let i = 0; i < count; i++) {
    expect(buffer.readUInt32LE(offset)).toBe(0x02014b50);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
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
    files.push({ path, data: method === 0 ? Buffer.from(raw) : inflateRawSync(raw) });

    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

describe("buildStoredZip", () => {
  it("round-trips files through a store-only zip", () => {
    const files = [
      { path: "soft-hitnormal2.wav", data: Buffer.from([1, 2, 3, 4, 5]) },
      { path: "keysounds/ピアノ.ogg", data: Buffer.from("hello sounds") },
    ];
    const zip = buildStoredZip(files);
    const readBack = readStoredZip(zip);

    expect(readBack.map((file) => file.path)).toEqual(["soft-hitnormal2.wav", "keysounds/ピアノ.ogg"]);
    expect(readBack[0].data).toEqual(files[0].data);
    expect(readBack[1].data).toEqual(files[1].data);
  });

  it("builds a valid empty zip when there are no files", () => {
    const zip = buildStoredZip([]);
    expect(zip.length).toBe(22);
    expect(readStoredZip(zip)).toEqual([]);
  });

  it("allocates exactly the zip size once", () => {
    const files = [
      { path: "a.wav", data: Buffer.alloc(9, 1) },
      { path: "nested/b.ogg", data: Buffer.alloc(17, 2) },
    ];
    const expected = files.reduce(
      (sum, file) => sum + 30 + Buffer.byteLength(file.path) + file.data.length + 46 + Buffer.byteLength(file.path),
      22,
    );

    expect(buildStoredZip(files).length).toBe(expected);
  });
});

describe("selectHitsoundArchiveEntries", () => {
  it("keeps only hitsound-sized audio files", () => {
    const { selected, dropped } = selectHitsoundArchiveEntries([
      entry({ path: "soft-hitnormal.wav" }),
      entry({ path: "bg.jpg" }),
      entry({ path: "audio.mp3", uncompressedSize: 5 * 1024 * 1024 }),
      entry({ path: "empty.wav", uncompressedSize: 0 }),
      entry({ path: "folder/", uncompressedSize: 0 }),
      entry({ path: "../escape.wav" }),
      entry({ path: "chart.osu" }),
      entry({ path: "keysound.ogg" }),
    ]);

    expect(selected.map((item) => item.path)).toEqual(["keysound.ogg", "soft-hitnormal.wav"]);
    expect(dropped).toBe(0);
  });

  it("excludes the music track by stem regardless of extension", () => {
    const { selected } = selectHitsoundArchiveEntries([
      entry({ path: "Audio.OGG", uncompressedSize: 900 * 1024 }),
      entry({ path: "audio.mp3", uncompressedSize: 900 * 1024 }),
      entry({ path: "nested/audio.wav", uncompressedSize: 900 * 1024 }),
      entry({ path: "drum-hitclap.wav" }),
    ], "audio.mp3");

    expect(selected.map((item) => item.path)).toEqual(["drum-hitclap.wav"]);
  });

  it("skips encrypted and unsupported-compression entries", () => {
    const { selected } = selectHitsoundArchiveEntries([
      entry({ path: "encrypted.wav", flags: 0x1 }),
      entry({ path: "weird.wav", compressionMethod: 12 }),
      entry({ path: "ok.wav" }),
    ]);

    expect(selected.map((item) => item.path)).toEqual(["ok.wav"]);
  });

  it("prefers smaller files under the count cap and reports drops", () => {
    const entries = Array.from({ length: 405 }, (_, index) =>
      entry({ path: `key${String(index).padStart(3, "0")}.wav`, uncompressedSize: 100 + index }),
    );
    const { selected, dropped } = selectHitsoundArchiveEntries(entries);

    expect(selected).toHaveLength(400);
    expect(dropped).toBe(5);
    // The smallest files survive.
    expect(selected[0].uncompressedSize).toBe(100);
    expect(selected.every((item) => item.uncompressedSize < 100 + 400)).toBe(true);
  });

  it("respects an injected total size budget", () => {
    const entries = Array.from({ length: 10 }, (_, index) =>
      entry({ path: `sample${index}.wav`, uncompressedSize: 1000 }),
    );
    const { selected, dropped } = selectHitsoundArchiveEntries(entries, null, { maxTotalBytes: 3_500 });

    expect(selected).toHaveLength(3);
    expect(dropped).toBe(7);
  });

  it("stops before exceeding the total size budget", () => {
    const big = Math.floor(1.4 * 1024 * 1024);
    const entries = Array.from({ length: 30 }, (_, index) =>
      entry({ path: `sample${String(index).padStart(2, "0")}.wav`, uncompressedSize: big }),
    );
    const { selected, dropped } = selectHitsoundArchiveEntries(entries);

    const total = selected.reduce((sum, item) => sum + item.uncompressedSize, 0);
    expect(total).toBeLessThanOrEqual(24 * 1024 * 1024);
    expect(selected.length + dropped).toBe(30);
    expect(dropped).toBeGreaterThan(0);
  });
});
