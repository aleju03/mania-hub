/* The browser derives a thumbnail's object key with WebCrypto so it can ask the
   CDN whether the pool already holds it, while the server derives the same key
   with node:crypto. If those two ever disagree the probe asks about an address
   nobody writes: every reveal would read as missing and re-upload, quietly
   putting back the per-reveal R2 cost this whole path exists to remove. */
import crypto from "node:crypto";
import { webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getPackCardThumbnailStorageKey } from "./pack-thumbnail-store";
import { buildPackThumbnailStorageKey } from "./pack-thumbnail-shared";

// Mirrors poolUrlForKey's derivation in components/packs/cardThumbnailCache.ts.
async function browserStorageKey(cacheKey: string): Promise<string> {
  const digest = await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(cacheKey));
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return buildPackThumbnailStorageKey(cacheKey, hex);
}

describe("pack thumbnail storage keys", () => {
  it("derives the same object key in the browser as on the server", async () => {
    for (const cacheKey of [
      "v1-w240-u4242-0123456789abcdef",
      "v2-w240-u4242-0123456789abcdef",
      "v2-w600-u17-fedcba9876543210",
      "v3-w240-u999999-00000000000000ff",
    ]) {
      expect(await browserStorageKey(cacheKey)).toBe(getPackCardThumbnailStorageKey(cacheKey));
    }
  });

  it("keeps legacy v1 objects flat and groups newer ones by version and player", () => {
    const hash = crypto.createHash("sha256").update("v1-w240-u4242-0123456789abcdef").digest("hex").slice(0, 40);
    expect(getPackCardThumbnailStorageKey("v1-w240-u4242-0123456789abcdef")).toBe(`maniacards/${hash}.webp`);
    expect(getPackCardThumbnailStorageKey("v2-w240-u4242-0123456789abcdef")).toMatch(
      /^maniacards\/v2\/4242\/[0-9a-f]{40}\.webp$/,
    );
  });

  it("rejects malformed cache keys instead of minting an address for them", () => {
    expect(() => buildPackThumbnailStorageKey("../../somewhere", "0".repeat(64)))
      .toThrow("Invalid maniacard thumbnail cache key.");
  });
});
