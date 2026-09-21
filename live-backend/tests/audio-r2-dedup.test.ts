import { describe, expect, it } from "vitest";
import { getAudioBlobKey, getBeatmapAudioStorageKey, getPointerBlobKey } from "../src/audio/r2-assets.js";

describe("content-addressed audio blobs", () => {
  it("separates timestamped Ogg playback from the old cached source", () => {
    const current = getBeatmapAudioStorageKey("1900729", "audio.ogg");
    const legacy = getBeatmapAudioStorageKey("1900729", "audio.ogg", true);
    expect(current).toMatch(/\/audio\/1900729\/[a-f0-9]{16}-audio\.seek-v1\.ogg$/);
    expect(legacy).toBe(current.replace(".seek-v1.ogg", ".ogg"));
    expect(getBeatmapAudioStorageKey("1", "SONG.OGG")).toMatch(/-SONG\.seek-v1\.ogg$/);
    expect(getBeatmapAudioStorageKey("1", "song.mp3")).toMatch(/-song\.mp4$/);
    expect(getBeatmapAudioStorageKey("1", "song.wav")).toMatch(/-song\.wav$/);
  });

  it("derives the same blob key for identical content regardless of set/filename", () => {
    const buffer = Buffer.from("identical audio bytes");
    expect(getAudioBlobKey(buffer, "audio/mp4")).toBe(getAudioBlobKey(buffer, "audio/mp4"));
  });

  it("keys by content hash under the blob prefix with a mime-derived extension", () => {
    const key = getAudioBlobKey(Buffer.from("x"), "audio/mp4");
    expect(key).toMatch(/^replay-cache\/blob\/audio\/[0-9a-f]{64}\.mp4$/);
    expect(getAudioBlobKey(Buffer.from("x"), "application/zip")).toMatch(/\.zip$/);
    expect(getAudioBlobKey(Buffer.from("x"), "audio/ogg")).toMatch(/\.ogg$/);
    expect(getAudioBlobKey(Buffer.from("x"), "text/weird")).toMatch(/\.bin$/);
  });

  it("differentiates blobs by content", () => {
    expect(getAudioBlobKey(Buffer.from("a"), "audio/mp4"))
      .not.toBe(getAudioBlobKey(Buffer.from("b"), "audio/mp4"));
  });

  it("resolves pointer metadata only for keys inside the blob prefix", () => {
    const blobKey = getAudioBlobKey(Buffer.from("a"), "audio/mp4");
    expect(getPointerBlobKey({ blobkey: blobKey })).toBe(blobKey);
    expect(getPointerBlobKey({ blobkey: "replay-cache/replays/1.osr" })).toBeNull();
    expect(getPointerBlobKey({})).toBeNull();
    expect(getPointerBlobKey(undefined)).toBeNull();
  });
});
