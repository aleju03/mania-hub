import { describe, expect, it } from "vitest";
import {
  hasTopPlaysCache,
  selectCachedTopPlaysPage,
  shouldRefreshTopPlays,
} from "./top-plays-cache";
import type { CachedPopoff } from "../store";

function popoff(id: number, time: string, pp: number, ppGain: number, keys: number): CachedPopoff {
  return {
    user: { id, username: `user-${id}`, avatar_url: `https://a.ppy.sh/${id}` },
    score: { id, beatmap: { cs: keys } } as CachedPopoff["score"],
    pp,
    weightedPP: pp * 0.95,
    ppGain,
    time,
  };
}

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

  it("selects a matching cached page while the exact snapshot revalidates", () => {
    const now = new Date("2026-08-23T12:00:00.000Z").getTime();
    const cached = [
      popoff(1, "2026-08-23T11:00:00.000Z", 300, 2, 4),
      popoff(2, "2026-08-23T10:00:00.000Z", 500, 8, 7),
      popoff(3, "2026-08-23T09:00:00.000Z", 400, 4, 4),
      popoff(4, "2026-08-20T09:00:00.000Z", 900, 20, 4),
    ];

    expect(selectCachedTopPlaysPage(cached, {
      cachedWindow: "7d",
      range: "24h",
      sort: "pp",
      dir: "desc",
      keys: "4k",
      page: 0,
      pageSize: 1,
      now,
    }).map((entry) => entry.user.id)).toEqual([3]);

    expect(selectCachedTopPlaysPage(cached, {
      cachedWindow: "24h",
      range: "7d",
      sort: "recent",
      dir: "desc",
      keys: "all",
      page: 0,
      pageSize: 15,
      now,
    })).toEqual([]);
  });
});
