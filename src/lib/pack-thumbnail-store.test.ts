import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { getPackCardThumbnailStorageKey } from "./pack-thumbnail-store";

describe("getPackCardThumbnailStorageKey", () => {
  it("keeps legacy v1 objects at their existing flat address", () => {
    const cacheKey = "v1-w240-u4242-0123456789abcdef";
    const hash = crypto.createHash("sha256").update(cacheKey).digest("hex").slice(0, 40);

    expect(getPackCardThumbnailStorageKey(cacheKey)).toBe(`maniacards/${hash}.webp`);
  });

  it("groups v2 variants by renderer version and player", () => {
    const cacheKey = "v2-w240-u4242-0123456789abcdef";
    const hash = crypto.createHash("sha256").update(cacheKey).digest("hex").slice(0, 40);

    expect(getPackCardThumbnailStorageKey(cacheKey)).toBe(
      `maniacards/v2/4242/${hash}.webp`,
    );
  });

  it("rejects malformed direct callers", () => {
    expect(() => getPackCardThumbnailStorageKey("../../somewhere"))
      .toThrow("Invalid maniacard thumbnail cache key.");
  });
});
