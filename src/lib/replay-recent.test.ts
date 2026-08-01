import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RECENT_REPLAYS_LIMIT,
  RECENT_REPLAYS_STORAGE_KEY,
  clearRecentReplays,
  readRecentReplays,
  recordRecentReplay,
  removeRecentReplay,
} from "./replay-recent";

function watched(overrides: Partial<Parameters<typeof recordRecentReplay>[0]> = {}) {
  return {
    scoreId: 1,
    title: "Freedom Dive",
    playerName: "cookiezi",
    viewedAt: 1_000,
    ...overrides,
  };
}

describe("recent replays", () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        clear: () => storage.clear(),
        getItem: (key: string) => storage.get(key) ?? null,
        removeItem: (key: string) => storage.delete(key),
        setItem: (key: string, value: string) => storage.set(key, value),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("starts empty and keeps the newest replay first", () => {
    expect(readRecentReplays()).toEqual([]);

    recordRecentReplay(watched({ scoreId: 1, viewedAt: 1_000 }));
    const list = recordRecentReplay(watched({ scoreId: 2, title: "Blue Zenith", viewedAt: 2_000 }));

    expect(list.map((entry) => entry.key)).toEqual(["score:2", "score:1"]);
    expect(readRecentReplays().map((entry) => entry.key)).toEqual(["score:2", "score:1"]);
  });

  it("moves a re-watched replay back to the front instead of duplicating it", () => {
    recordRecentReplay(watched({ scoreId: 1, viewedAt: 1_000 }));
    recordRecentReplay(watched({ scoreId: 2, title: "Blue Zenith", viewedAt: 2_000 }));
    const list = recordRecentReplay(watched({ scoreId: 1, viewedAt: 3_000 }));

    expect(list.map((entry) => entry.key)).toEqual(["score:1", "score:2"]);
    expect(list[0].viewedAt).toBe(3_000);
  });

  it("tracks score replays and uploaded replays under separate keys", () => {
    recordRecentReplay(watched({ scoreId: 1, viewedAt: 1_000 }));
    const list = recordRecentReplay({
      uploadId: "abcdefghijklmnop",
      title: "Local map",
      playerName: "aleju",
      viewedAt: 2_000,
    });

    expect(list.map((entry) => entry.key)).toEqual(["upload:abcdefghijklmnop", "score:1"]);
    expect(list[0].uploadId).toBe("abcdefghijklmnop");
    expect(list[0].scoreId).toBeUndefined();
  });

  it("caps the list so the key can never grow without bound", () => {
    for (let index = 0; index < RECENT_REPLAYS_LIMIT + 5; index += 1) {
      recordRecentReplay(watched({ scoreId: index + 1, viewedAt: 1_000 + index }));
    }

    const list = readRecentReplays();
    expect(list).toHaveLength(RECENT_REPLAYS_LIMIT);
    expect(list[0].scoreId).toBe(RECENT_REPLAYS_LIMIT + 5);
    // The oldest entries fell off the end.
    expect(list.some((entry) => entry.scoreId === 1)).toBe(false);
  });

  it("drops rows that no longer match the stored shape", () => {
    window.localStorage.setItem(RECENT_REPLAYS_STORAGE_KEY, JSON.stringify([
      { scoreId: 7, title: "Kept", playerName: "someone", viewedAt: 5 },
      { title: "No id", playerName: "someone", viewedAt: 5 },
      { scoreId: 8, title: "No timestamp", playerName: "someone" },
      "not an object",
    ]));

    expect(readRecentReplays().map((entry) => entry.key)).toEqual(["score:7"]);
  });

  it("survives unreadable storage", () => {
    window.localStorage.setItem(RECENT_REPLAYS_STORAGE_KEY, "{not json");
    expect(readRecentReplays()).toEqual([]);
  });

  it("removes one entry and clears the whole list", () => {
    recordRecentReplay(watched({ scoreId: 1, viewedAt: 1_000 }));
    recordRecentReplay(watched({ scoreId: 2, viewedAt: 2_000 }));

    expect(removeRecentReplay("score:2").map((entry) => entry.key)).toEqual(["score:1"]);
    expect(clearRecentReplays()).toEqual([]);
    expect(readRecentReplays()).toEqual([]);
    expect(window.localStorage.getItem(RECENT_REPLAYS_STORAGE_KEY)).toBeNull();
  });

  it("keeps mod acronyms with their rate for the badges", () => {
    const list = recordRecentReplay(watched({
      mods: [{ acronym: "DT", rate: 1.3 }, { acronym: "MR" }],
    }));

    expect(list[0].mods).toEqual([{ acronym: "DT", rate: 1.3 }, { acronym: "MR" }]);
  });
});
