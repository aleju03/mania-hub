import { describe, expect, it } from "vitest";
import { getPublicImageKey } from "./public-image-store";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const OTHER_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9]);

describe("getPublicImageKey", () => {
  // The whole scheme rests on this: identical bytes must land on one key, or
  // the bucket collects duplicates and the immutable cache header starts lying.
  it("gives identical bytes an identical key and different bytes a different one", () => {
    expect(getPublicImageKey(PNG, "image/png")).toBe(getPublicImageKey(Buffer.from(PNG), "image/png"));
    expect(getPublicImageKey(PNG, "image/png")).not.toBe(getPublicImageKey(OTHER_PNG, "image/png"));
  });

  it("names the extension from the sniffed type, not the claimed one", () => {
    expect(getPublicImageKey(PNG, "image/png")).toMatch(/^bbcode\/[0-9a-f]{64}\.png$/);
    expect(getPublicImageKey(PNG, "image/jpeg")).toMatch(/\.jpg$/);
    expect(getPublicImageKey(PNG, "image/avif")).toMatch(/\.avif$/);
  });

  // Keys go straight into a public URL, so anything user-controlled leaking in
  // would be a path-traversal or cache-poisoning foothold. A hex digest can't.
  it("builds keys out of nothing but hex and a known extension", () => {
    expect(getPublicImageKey(PNG, "image/webp")).toMatch(/^bbcode\/[0-9a-f]+\.[a-z]+$/);
  });
});
