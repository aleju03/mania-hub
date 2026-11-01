import type { PutObjectCommand } from "@aws-sdk/client-s3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAttachmentContentDisposition } from "./content-disposition";
import {
  getBeatmapAssetBlobKey,
  getPointerBlobKey,
  listR2AdminBuckets,
  normalizeR2AdminBucketId,
  normalizeR2AdminObjectKey,
  normalizeR2AdminPrefix,
} from "./r2-cache";

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn<(command: unknown) => Promise<unknown>>() }));

vi.mock("@aws-sdk/client-s3", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@aws-sdk/client-s3")>()),
  S3Client: class { send = sendMock; },
}));

describe("R2 admin key normalization", () => {
  it("defaults to each bucket's first root prefix", () => {
    expect(normalizeR2AdminPrefix("replay-cache", "")).toBe("replay-cache/");
    expect(normalizeR2AdminPrefix("replay-cache", null)).toBe("replay-cache/");
    expect(normalizeR2AdminPrefix("public", "")).toBe("bbcode/");
  });

  it("falls back to the replay cache bucket for an unknown bucket id", () => {
    expect(normalizeR2AdminBucketId("public")).toBe("public");
    expect(normalizeR2AdminBucketId("nope")).toBe("replay-cache");
    expect(normalizeR2AdminBucketId(undefined)).toBe("replay-cache");
    expect(normalizeR2AdminPrefix("nope", "")).toBe("replay-cache/");
  });

  it("normalizes folder prefixes inside the replay cache", () => {
    expect(normalizeR2AdminPrefix("replay-cache", "/replay-cache/audio")).toBe("replay-cache/audio/");
    expect(normalizeR2AdminPrefix("replay-cache", "replay-cache/videos/abc/")).toBe("replay-cache/videos/abc/");
  });

  it("accepts the skins root and its subfolders", () => {
    expect(normalizeR2AdminPrefix("replay-cache", "skins")).toBe("skins/");
    expect(normalizeR2AdminPrefix("replay-cache", "/skins/some-id")).toBe("skins/some-id/");
  });

  it("normalizes prefixes inside the public bucket", () => {
    expect(normalizeR2AdminPrefix("public", "bbcode")).toBe("bbcode/");
    expect(normalizeR2AdminPrefix("public", "/maniacards/v2/123")).toBe("maniacards/v2/123/");
  });

  it("rejects prefixes outside the browsable roots", () => {
    expect(() => normalizeR2AdminPrefix("replay-cache", "other-cache/")).toThrow(/outside replay-cache\/ or skins\//);
    expect(() => normalizeR2AdminPrefix("replay-cache", "skins-old/")).toThrow(/outside replay-cache\/ or skins\//);
  });

  it("keeps the buckets' roots apart", () => {
    expect(() => normalizeR2AdminPrefix("public", "replay-cache/replays/")).toThrow(/outside bbcode\/ or maniacards\//);
    expect(() => normalizeR2AdminPrefix("replay-cache", "bbcode/")).toThrow(/outside replay-cache\/ or skins\//);
  });

  it("accepts file keys and rejects folder keys", () => {
    expect(normalizeR2AdminObjectKey("replay-cache", "/replay-cache/replays/123.osr")).toBe("replay-cache/replays/123.osr");
    expect(normalizeR2AdminObjectKey("replay-cache", "skins/some-id/preview-4k.webp")).toBe("skins/some-id/preview-4k.webp");
    expect(normalizeR2AdminObjectKey("public", "bbcode/abc.png")).toBe("bbcode/abc.png");
    expect(() => normalizeR2AdminObjectKey("replay-cache", "replay-cache/replays/")).toThrow(/file key/);
    expect(() => normalizeR2AdminObjectKey("replay-cache", "outside.txt")).toThrow(/outside replay-cache\/ or skins\//);
  });
});

describe("R2 admin bucket registry", () => {
  it("lists both buckets with their roots", () => {
    const buckets = listR2AdminBuckets();
    expect(buckets.map((entry) => entry.id)).toEqual(["replay-cache", "public"]);
    expect(buckets[0]!.bucket).toBe("mania-hub-replay-cache");
    expect(buckets[1]!.bucket).toBe("mania-hub-public");
    expect(buckets[0]!.roots.map((root) => root.prefix)).toEqual(["replay-cache/", "skins/", "bug-reports/"]);
    expect(buckets[1]!.roots.map((root) => root.prefix)).toEqual(["bbcode/", "maniacards/"]);
  });

  it("warns before deleting anything without a second copy", () => {
    const roots = listR2AdminBuckets().flatMap((entry) => entry.roots);
    const warned = roots.filter((root) => root.deleteWarning).map((root) => root.prefix);
    expect(warned).toEqual(["skins/", "bug-reports/", "bbcode/"]);
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

describe("uploaded replay filenames", () => {
  const replayBytes = Buffer.from("stored replay bytes");
  const uploadId = "abcdefghijklmnopqrst";

  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("R2_ENDPOINT", "https://storage.example.invalid");
    vi.stubEnv("R2_BUCKET", "mania-hub-replay-cache");
    vi.stubEnv("R2_ACCESS_KEY_ID", "test-key");
    vi.stubEnv("R2_SECRET_ACCESS_KEY", "test-secret");
    sendMock.mockReset();
    sendMock.mockRejectedValue(new Error("Unexpected storage command."));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("preserves Unicode and emoji filenames through storage", async () => {
    const { putUploadedReplay, getUploadedReplay, headUploadedReplayOwner } = await import("./r2-cache");

    for (const filename of ["你好.osr", "💀.osr"]) {
      sendMock.mockResolvedValueOnce({});
      const uploaded = await putUploadedReplay(uploadId, replayBytes, { originalFilename: filename });
      const command = sendMock.mock.calls.at(-1)![0] as PutObjectCommand;
      expect(uploaded?.originalFilename).toBe(filename);
      expect(command.input.Metadata?.originalfilenameutf8).toBe(encodeURIComponent(filename));
      expect(command.input.ContentDisposition).toBe(buildAttachmentContentDisposition(filename));

      sendMock.mockResolvedValueOnce({
        Body: { transformToByteArray: async () => command.input.Body },
        Metadata: command.input.Metadata,
      });
      const replay = await getUploadedReplay(uploadId);
      expect(replay?.originalFilename).toBe(filename);
      expect(replay?.buffer).toEqual(replayBytes);

      sendMock.mockResolvedValueOnce({ Metadata: command.input.Metadata });
      expect((await headUploadedReplayOwner(uploadId))?.originalFilename).toBe(filename);
    }
  });

  it("keeps filenames from older uploads readable", async () => {
    const { getUploadedReplay } = await import("./r2-cache");
    sendMock.mockResolvedValueOnce({
      Body: { transformToByteArray: async () => replayBytes },
      Metadata: { originalfilename: "cool_.osr" },
    });
    expect((await getUploadedReplay(uploadId))?.originalFilename).toBe("cool_.osr");
  });

  it("supplies a basename when an older upload only kept the extension", async () => {
    const { getUploadedReplay, headUploadedReplayOwner } = await import("./r2-cache");
    const metadata = { originalfilename: ".osr" };
    sendMock.mockResolvedValueOnce({
      Body: { transformToByteArray: async () => replayBytes },
      Metadata: metadata,
    });
    expect((await getUploadedReplay(uploadId))?.originalFilename).toBe("replay.osr");
    sendMock.mockResolvedValueOnce({ Metadata: metadata });
    expect((await headUploadedReplayOwner(uploadId))?.originalFilename).toBe("replay.osr");
  });
});
