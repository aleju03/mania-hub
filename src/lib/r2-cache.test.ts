import { describe, expect, it } from "vitest";
import { normalizeR2AdminObjectKey, normalizeR2AdminPrefix } from "./r2-cache";

describe("R2 admin key normalization", () => {
  it("defaults to the replay cache root prefix", () => {
    expect(normalizeR2AdminPrefix("")).toBe("replay-cache/");
    expect(normalizeR2AdminPrefix(null)).toBe("replay-cache/");
  });

  it("normalizes folder prefixes inside the replay cache", () => {
    expect(normalizeR2AdminPrefix("/replay-cache/audio")).toBe("replay-cache/audio/");
    expect(normalizeR2AdminPrefix("replay-cache/videos/abc/")).toBe("replay-cache/videos/abc/");
  });

  it("rejects prefixes outside the replay cache", () => {
    expect(() => normalizeR2AdminPrefix("other-cache/")).toThrow(/non replay-cache/);
  });

  it("accepts file keys and rejects folder keys", () => {
    expect(normalizeR2AdminObjectKey("/replay-cache/replays/123.osr")).toBe("replay-cache/replays/123.osr");
    expect(() => normalizeR2AdminObjectKey("replay-cache/replays/")).toThrow(/file key/);
    expect(() => normalizeR2AdminObjectKey("outside.txt")).toThrow(/non replay-cache/);
  });
});
