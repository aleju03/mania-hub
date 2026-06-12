// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearPendingPack,
  consumePendingPackCard,
  PENDING_PACK_STORAGE_KEY,
  readPendingPack,
  writePendingPack,
} from "./pack-pending";
import type { PackPlayer } from "./packs";

function makePlayer(id: number): PackPlayer {
  return {
    user: {
      id,
      username: `player-${id}`,
      avatar_url: `https://a.ppy.sh/${id}`,
      country_code: "CR",
      statistics: { global_rank: id * 100, pp: 9000 - id },
    },
    globalRank: id * 100,
    pp: 9000 - id,
  };
}

describe("pack-pending", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("round-trips the unrevealed remainder", () => {
    const players = [makePlayer(1), makePlayer(2), makePlayer(3)];
    writePendingPack(players);
    expect(readPendingPack()).toEqual(players);
  });

  it("returns null when nothing is pending", () => {
    expect(readPendingPack()).toBeNull();
  });

  it("returns null for corrupted payloads", () => {
    localStorage.setItem(PENDING_PACK_STORAGE_KEY, "not json");
    expect(readPendingPack()).toBeNull();
    localStorage.setItem(PENDING_PACK_STORAGE_KEY, JSON.stringify([{ user: { id: "nope" } }]));
    expect(readPendingPack()).toBeNull();
    localStorage.setItem(PENDING_PACK_STORAGE_KEY, JSON.stringify([]));
    expect(readPendingPack()).toBeNull();
  });

  it("consumes revealed cards by id and empties out", () => {
    writePendingPack([makePlayer(1), makePlayer(2)]);
    consumePendingPackCard(1);
    expect(readPendingPack()).toEqual([makePlayer(2)]);
    // Unknown ids leave the remainder alone.
    consumePendingPackCard(99);
    expect(readPendingPack()).toEqual([makePlayer(2)]);
    consumePendingPackCard(2);
    expect(readPendingPack()).toBeNull();
    expect(localStorage.getItem(PENDING_PACK_STORAGE_KEY)).toBeNull();
  });

  it("writing an empty remainder clears the entry", () => {
    writePendingPack([makePlayer(1)]);
    writePendingPack([]);
    expect(localStorage.getItem(PENDING_PACK_STORAGE_KEY)).toBeNull();
  });

  it("clearPendingPack removes the entry", () => {
    writePendingPack([makePlayer(1)]);
    clearPendingPack();
    expect(readPendingPack()).toBeNull();
  });
});
