// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  COLLECTIONS_RECENT_KEY,
  FARM_HELPER_RECENT_KEY,
  readRecentPlayers,
  recordRecentPlayer,
  removeRecentPlayer,
} from "./recent-players";

const KEY = "test-recent";

function player(userId: number) {
  return { userId, username: `player${userId}`, avatarUrl: "" };
}

beforeEach(() => window.localStorage.clear());

describe("recent players", () => {
  it("puts the newest first and never repeats a player", () => {
    recordRecentPlayer(KEY, player(1));
    recordRecentPlayer(KEY, player(2));
    recordRecentPlayer(KEY, player(1));
    expect(readRecentPlayers(KEY).map((p) => p.userId)).toEqual([1, 2]);
  });

  it("keeps only the last eight", () => {
    for (let id = 1; id <= 12; id += 1) recordRecentPlayer(KEY, player(id));
    expect(readRecentPlayers(KEY).map((p) => p.userId)).toEqual([12, 11, 10, 9, 8, 7, 6, 5]);
  });

  it("drops one without touching the rest", () => {
    recordRecentPlayer(KEY, player(1));
    recordRecentPlayer(KEY, player(2));
    removeRecentPlayer(KEY, 1);
    expect(readRecentPlayers(KEY).map((p) => p.userId)).toEqual([2]);
  });

  it("keeps each surface's list to itself", () => {
    // The two lists mean different things: who you last studied, and who you
    // last gave something to.
    recordRecentPlayer(FARM_HELPER_RECENT_KEY, player(1));
    recordRecentPlayer(COLLECTIONS_RECENT_KEY, player(2));
    expect(readRecentPlayers(FARM_HELPER_RECENT_KEY).map((p) => p.userId)).toEqual([1]);
    expect(readRecentPlayers(COLLECTIONS_RECENT_KEY).map((p) => p.userId)).toEqual([2]);
  });

  it("reads a missing, corrupt or wrong-shaped entry as empty rather than throwing", () => {
    expect(readRecentPlayers(KEY)).toEqual([]);
    window.localStorage.setItem(KEY, "{not json");
    expect(readRecentPlayers(KEY)).toEqual([]);
    window.localStorage.setItem(KEY, JSON.stringify({ userId: 1 }));
    expect(readRecentPlayers(KEY)).toEqual([]);
    window.localStorage.setItem(KEY, JSON.stringify([{ userId: 1 }, null, player(2)]));
    expect(readRecentPlayers(KEY).map((p) => p.userId)).toEqual([2]);
  });

  it("refuses to record a player with no name to show", () => {
    recordRecentPlayer(KEY, { userId: 1, username: "", avatarUrl: "" });
    expect(readRecentPlayers(KEY)).toEqual([]);
  });
});
