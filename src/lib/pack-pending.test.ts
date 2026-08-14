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
    expect(readPendingPack()).toEqual({ players, damage: null });
  });

  it("round-trips the cut a slash through the pack's middle left", () => {
    const players = [makePlayer(1), makePlayer(2)];
    writePendingPack(players, { path: [0.4, 0.5, 0.45, 0.6] });
    expect(readPendingPack()).toEqual({ players, damage: { path: [0.4, 0.5, 0.45, 0.6] } });
    // A resumed pack stays cut as its cards are consumed one at a time.
    consumePendingPackCard(1);
    expect(readPendingPack()).toEqual({
      players: [makePlayer(2)],
      damage: { path: [0.4, 0.5, 0.45, 0.6] },
    });
  });

  it("resumes a pack stored before cut packs existed as an intact one", () => {
    const players = [makePlayer(1)];
    localStorage.setItem(PENDING_PACK_STORAGE_KEY, JSON.stringify(players));
    expect(readPendingPack()).toEqual({ players, damage: null });
  });

  it("drops damage it cannot trust", () => {
    localStorage.setItem(
      PENDING_PACK_STORAGE_KEY,
      JSON.stringify({ players: [makePlayer(1)], damage: { path: ["half", 0.5] } }),
    );
    expect(readPendingPack()).toEqual({ players: [makePlayer(1)], damage: null });
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
    expect(readPendingPack()).toEqual({ players: [makePlayer(2)], damage: null });
    // Unknown ids leave the remainder alone.
    consumePendingPackCard(99);
    expect(readPendingPack()).toEqual({ players: [makePlayer(2)], damage: null });
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
