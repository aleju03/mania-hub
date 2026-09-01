import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Keep the store off real R2: an in-memory map stands in for the object store so
// the checksum-verification logic is what gets exercised.
const objectStore = new Map<string, string>();
const assetStore = new Map<string, { mimeType: string; sizeBytes: number }>();
vi.mock("./r2-cache", () => ({
  getCommunityBeatmapObject: vi.fn(async (checksum: string) => objectStore.get(checksum) ?? null),
  putCommunityBeatmapObject: vi.fn(async (checksum: string, content: string) => {
    objectStore.set(checksum, content);
    return true;
  }),
  headCommunityBeatmapAsset: vi.fn(async (checksum: string, kind: string) => assetStore.get(`${checksum}/${kind}`) ?? null),
  putCommunityBeatmapAsset: vi.fn(async (checksum: string, kind: string, mimeType: string, buffer: Buffer) => {
    const key = `${checksum}/${kind}`;
    if (assetStore.has(key)) return false;
    assetStore.set(key, { mimeType, sizeBytes: buffer.length });
    return true;
  }),
}));

import {
  getCommunityBeatmapAssets,
  getCommunityBeatmapFile,
  putCommunityBeatmap,
  putCommunityBeatmapAssetFile,
  sniffCommunityAssetMimeType,
} from "./community-beatmap-store";

function md5(content: string): string {
  return createHash("md5").update(content, "utf8").digest("hex");
}

const OSU_FILE = "osu file format v14\n\n[HitObjects]\n256,192,1000,1,0,0:0:0:0:\n";

describe("community beatmap store", () => {
  beforeEach(() => {
    objectStore.clear();
    assetStore.clear();
  });

  it("stores a verified .osu and serves it back by checksum", async () => {
    const checksum = md5(OSU_FILE);
    expect(await putCommunityBeatmap(checksum, OSU_FILE)).toEqual({ stored: true });
    expect(await getCommunityBeatmapFile(checksum)).toBe(OSU_FILE);
  });

  it("rejects content that does not hash to the claimed checksum", async () => {
    const wrong = md5("something else entirely");
    expect(await putCommunityBeatmap(wrong, OSU_FILE)).toEqual({
      stored: false,
      reason: "checksum-mismatch",
    });
    // Nothing was stored, so a later read is a clean miss.
    expect(await getCommunityBeatmapFile(wrong)).toBeNull();
  });

  it("rejects payloads that are not beatmap files even if the hash matches", async () => {
    const junk = "totally not a beatmap";
    expect(await putCommunityBeatmap(md5(junk), junk)).toEqual({
      stored: false,
      reason: "invalid-file",
    });
  });

  it("returns null for a malformed checksum or an unknown map", async () => {
    expect(await getCommunityBeatmapFile("not-a-checksum")).toBeNull();
    expect(await getCommunityBeatmapFile(md5("never uploaded"))).toBeNull();
  });

  it("refuses to serve a stored object whose content no longer matches its key", async () => {
    const checksum = md5(OSU_FILE);
    // Simulate a corrupted or mis-keyed object landing in the store.
    objectStore.set(checksum, "osu file format v14\n\n[HitObjects]\ncorrupted\n");
    expect(await getCommunityBeatmapFile(checksum)).toBeNull();
  });
});

// A chart naming its song and background, the way an .osz's .osu does.
const OSU_WITH_ASSETS = [
  "osu file format v14",
  "",
  "[General]",
  "AudioFilename: audio.mp3",
  "",
  "[Events]",
  '0,0,"bg.jpg",0,0',
  "",
  "[HitObjects]",
  "256,192,1000,1,0,0:0:0:0:",
  "",
].join("\n");

const MP3 = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(64)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);

describe("community beatmap assets", () => {
  beforeEach(() => {
    objectStore.clear();
    assetStore.clear();
  });

  it("stores the song and background the stored .osu names, once", async () => {
    const checksum = md5(OSU_WITH_ASSETS);
    await putCommunityBeatmap(checksum, OSU_WITH_ASSETS);
    expect(await getCommunityBeatmapAssets(checksum)).toEqual({ audio: false, background: false });

    expect(await putCommunityBeatmapAssetFile({ checksum, kind: "audio", filename: "songs/Audio.MP3", buffer: MP3 })).toEqual({ stored: true });
    expect(await putCommunityBeatmapAssetFile({ checksum, kind: "background", filename: "bg.jpg", buffer: JPG })).toEqual({ stored: true });
    expect(await getCommunityBeatmapAssets(checksum)).toEqual({ audio: true, background: true });
    expect(assetStore.get(`${checksum}/audio`)?.mimeType).toBe("audio/mpeg");

    // First write wins; a second contributor can't replace the song.
    expect(await putCommunityBeatmapAssetFile({ checksum, kind: "audio", filename: "audio.mp3", buffer: MP3 })).toEqual({
      stored: false,
      reason: "already-stored",
    });
  });

  it("refuses assets for a map whose .osu was never contributed", async () => {
    expect(await putCommunityBeatmapAssetFile({ checksum: md5("nothing"), kind: "audio", filename: "audio.mp3", buffer: MP3 })).toEqual({
      stored: false,
      reason: "no-beatmap",
    });
  });

  it("refuses a file the chart does not name", async () => {
    const checksum = md5(OSU_WITH_ASSETS);
    await putCommunityBeatmap(checksum, OSU_WITH_ASSETS);
    expect(await putCommunityBeatmapAssetFile({ checksum, kind: "audio", filename: "other.mp3", buffer: MP3 })).toEqual({
      stored: false,
      reason: "filename-mismatch",
    });
  });

  it("refuses bytes that are not the kind they claim to be", async () => {
    const checksum = md5(OSU_WITH_ASSETS);
    await putCommunityBeatmap(checksum, OSU_WITH_ASSETS);
    expect(await putCommunityBeatmapAssetFile({ checksum, kind: "audio", filename: "audio.mp3", buffer: JPG })).toEqual({
      stored: false,
      reason: "invalid-file",
    });
    expect(await putCommunityBeatmapAssetFile({ checksum, kind: "background", filename: "bg.jpg", buffer: Buffer.from("<html>") })).toEqual({
      stored: false,
      reason: "invalid-file",
    });
  });

  it("sniffs the formats osu! maps actually ship", () => {
    expect(sniffCommunityAssetMimeType("audio", Buffer.from([0xff, 0xfb, 0x90, 0x00]))).toBe("audio/mpeg");
    expect(sniffCommunityAssetMimeType("audio", Buffer.from("OggS...."))).toBe("audio/ogg");
    expect(sniffCommunityAssetMimeType("audio", Buffer.from("RIFF....WAVE"))).toBe("audio/wav");
    expect(sniffCommunityAssetMimeType("background", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image/png");
    expect(sniffCommunityAssetMimeType("background", Buffer.from("RIFF....WEBP"))).toBe("image/webp");
    expect(sniffCommunityAssetMimeType("background", Buffer.from("RIFF....WAVE"))).toBeNull();
  });
});
