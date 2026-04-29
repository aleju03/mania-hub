import { describe, expect, it } from "vitest";
import {
  hasTopPlaysCache,
  shouldRefreshTopPlays,
} from "./top-plays-cache";

describe("top plays cache", () => {
  it("treats a fresh empty response as cached data", () => {
    const fetchedAt = Date.now();

    expect(hasTopPlaysCache(fetchedAt, "24h")).toBe(true);
    expect(shouldRefreshTopPlays({
      fetchedAt,
      cachedWindow: "24h",
      selectedRange: "24h",
      cacheTtlMs: 60_000,
      now: fetchedAt + 1000,
    })).toBe(false);
  });
});
