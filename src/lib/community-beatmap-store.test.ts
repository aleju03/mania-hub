import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Keep the store off the real Turso/R2 cache: an in-memory map stands in for the
// persistent layer so the checksum-verification logic is what gets exercised.
const cacheStore = new Map<string, unknown>();
vi.mock("./api", () => ({
  getPersistentCacheEntry: vi.fn(async (key: string) =>
    cacheStore.has(key) ? { hit: true, value: cacheStore.get(key) } : { hit: false },
  ),
  setPersistentCache: vi.fn(async (key: string, data: unknown) => {
    cacheStore.set(key, data);
  }),
}));

import { getCommunityBeatmapFile, putCommunityBeatmap } from "./community-beatmap-store";

function md5(content: string): string {
  return createHash("md5").update(content, "utf8").digest("hex");
}

const OSU_FILE = "osu file format v14\n\n[HitObjects]\n256,192,1000,1,0,0:0:0:0:\n";

describe("community beatmap store", () => {
  beforeEach(() => {
    cacheStore.clear();
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
});
