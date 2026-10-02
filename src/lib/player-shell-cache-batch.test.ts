import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LeanRankingEntry } from "./types";

const CACHE_KEY = "mania-hub-player-shell-cache-v2";
const NOW = Date.parse("2026-10-02T12:00:00Z");
const stored = new Map<string, string>();
const storage = {
  getItem: vi.fn((key: string) => stored.get(key) ?? null),
  setItem: vi.fn((key: string, value: string) => { stored.set(key, value); }),
};
const readStored = () => JSON.parse(stored.get(CACHE_KEY) ?? "{}");
let cache: typeof import("./player-shell-cache");

function rankingEntry(id: number): LeanRankingEntry {
  return {
    user: { id, username: `Ranker${id}`, avatar_url: `https://a.ppy.sh/${id}`, cover_url: "", country_code: "CR", is_online: true },
    hit_accuracy: 98.5,
    play_count: 1234,
    pp: 5000,
    global_rank: id,
    ranked_score: 1,
    grade_counts: { ss: 0, ssh: 0, s: 0, sh: 0, a: 0 },
  };
}

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  stored.clear();
  storage.getItem.mockClear();
  storage.setItem.mockClear();
  vi.stubGlobal("window", { localStorage: storage });
  cache = await import("./player-shell-cache");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("ranking snapshot shell seeding", () => {
  it("persists a complete page once and keeps ranks around excluded accounts", () => {
    const entries = Array.from({ length: 50 }, (_, index) => rankingEntry(index + 1));
    cache.seedPlayerShellsFromRankingEntries(entries, 50, new Set([2]));

    expect(storage.getItem).toHaveBeenCalledTimes(1);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    expect(Object.keys(readStored())).toHaveLength(49);
    expect(cache.readPlayerShell("ranker2")).toBeNull();
    const first = cache.readPlayerShell(" RANKER1 ")!;
    expect(first.statistics?.country_rank).toBe(51);
    expect(first.is_online).toBe(false);
    expect(first.last_visit).toBeNull();
    expect(cache.readPlayerShell("ranker3")?.statistics?.country_rank).toBe(53);
    expect(cache.readPlayerShell("ranker50")?.statistics?.country_rank).toBe(100);
  });

  it("does no storage work for empty or fully excluded snapshots", () => {
    cache.seedPlayerShellsFromRankingEntries([]);
    cache.seedPlayerShellsFromRankingEntries([rankingEntry(1)], 0, new Set([1]));
    expect(storage.getItem).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("retains insertion-order eviction when an evicted name is seeded later in the same batch", () => {
    cache.seedPlayerShellsFromRankingEntries(Array.from({ length: 150 }, (_, index) => rankingEntry(index)));
    cache.seedPlayerShellsFromRankingEntries([rankingEntry(150), rankingEntry(0)]);
    const keys = Object.keys(readStored());
    expect(keys).toHaveLength(150);
    expect(keys[0]).toBe("ranker2");
    expect(keys.slice(-2)).toEqual(["ranker150", "ranker0"]);
    expect(readStored().ranker0.user.statistics.country_rank).toBe(2);
  });

  it("refreshes an expired entry in its original position before pruning other expired entries", () => {
    cache.seedPlayerShellsFromRankingEntries([rankingEntry(0), rankingEntry(1)]);
    vi.setSystemTime(NOW + 300_000);
    cache.seedPlayerShellFromRankingEntry(rankingEntry(2), 3);
    vi.setSystemTime(NOW + 600_000);
    cache.seedPlayerShellsFromRankingEntries([rankingEntry(0)]);
    expect(Object.keys(readStored())).toEqual(["ranker0", "ranker2"]);
    expect(readStored().ranker0.expiresAt).toBe(NOW + 1_200_000);
    expect(cache.readPlayerShell("ranker1")).toBeNull();
    vi.setSystemTime(NOW + 1_200_000);
    expect(cache.readPlayerShell("ranker0")).toBeNull();
  });

  it("keeps the in-memory navigation shell when browser persistence is unavailable", () => {
    storage.setItem.mockImplementationOnce(() => { throw new Error("Quota exceeded"); });
    expect(() => cache.seedPlayerShellsFromRankingEntries([rankingEntry(1)])).not.toThrow();
    expect(cache.readPlayerShell("ranker1")?.id).toBe(1);
  });
});
