import { describe, expect, it } from "vitest";
import {
  getBeatmapAssetBlobKey,
  getPointerBlobKey,
  normalizeR2AdminObjectKey,
  normalizeR2AdminPrefix,
} from "./r2-cache";

describe("R2 admin key normalization", () => {
  it("defaults to the replay cache root prefix", () => {
    expect(normalizeR2AdminPrefix("")).toBe("replay-cache/");
    expect(normalizeR2AdminPrefix(null)).toBe("replay-cache/");
  });

  it("normalizes folder prefixes inside the replay cache", () => {
    expect(normalizeR2AdminPrefix("/replay-cache/audio")).toBe("replay-cache/audio/");
    expect(normalizeR2AdminPrefix("replay-cache/videos/abc/")).toBe("replay-cache/videos/abc/");
  });

  it("accepts the skins root and its subfolders", () => {
    expect(normalizeR2AdminPrefix("skins")).toBe("skins/");
    expect(normalizeR2AdminPrefix("/skins/some-id")).toBe("skins/some-id/");
  });

  it("rejects prefixes outside the browsable roots", () => {
    expect(() => normalizeR2AdminPrefix("other-cache/")).toThrow(/outside replay-cache\/ or skins\//);
    expect(() => normalizeR2AdminPrefix("skins-old/")).toThrow(/outside replay-cache\/ or skins\//);
  });

  it("accepts file keys and rejects folder keys", () => {
    expect(normalizeR2AdminObjectKey("/replay-cache/replays/123.osr")).toBe("replay-cache/replays/123.osr");
    expect(normalizeR2AdminObjectKey("skins/some-id/preview-4k.webp")).toBe("skins/some-id/preview-4k.webp");
    expect(() => normalizeR2AdminObjectKey("replay-cache/replays/")).toThrow(/file key/);
    expect(() => normalizeR2AdminObjectKey("outside.txt")).toThrow(/outside replay-cache\/ or skins\//);
  });
});

describe("content-addressed beatmap asset blobs", () => {
  it("derives the same blob key for identical content regardless of set/filename", () => {
    const buffer = Buffer.from("identical background bytes");
    expect(getBeatmapAssetBlobKey("background", buffer, "image/jpeg"))
      .toBe(getBeatmapAssetBlobKey("background", buffer, "image/jpeg"));
  });

  it("keys by content hash under the per-kind blob prefix with a mime-derived extension", () => {
    expect(getBeatmapAssetBlobKey("background", Buffer.from("x"), "image/jpeg"))
      .toMatch(/^replay-cache\/blob\/background\/[0-9a-f]{64}\.jpg$/);
    expect(getBeatmapAssetBlobKey("audio", Buffer.from("x"), "audio/mp4"))
      .toMatch(/^replay-cache\/blob\/audio\/[0-9a-f]{64}\.mp4$/);
    expect(getBeatmapAssetBlobKey("background", Buffer.from("x"), "text/weird")).toMatch(/\.bin$/);
  });

  it("differentiates blobs by content", () => {
    expect(getBeatmapAssetBlobKey("background", Buffer.from("a"), "image/png"))
      .not.toBe(getBeatmapAssetBlobKey("background", Buffer.from("b"), "image/png"));
  });

  it("resolves pointer metadata only for keys inside the matching kind's blob prefix", () => {
    const blobKey = getBeatmapAssetBlobKey("background", Buffer.from("a"), "image/png");
    expect(getPointerBlobKey("background", { blobkey: blobKey })).toBe(blobKey);
    expect(getPointerBlobKey("audio", { blobkey: blobKey })).toBeNull();
    expect(getPointerBlobKey("background", { blobkey: "replay-cache/replays/1.osr" })).toBeNull();
    expect(getPointerBlobKey("background", {})).toBeNull();
    expect(getPointerBlobKey("background", undefined)).toBeNull();
  });
});
