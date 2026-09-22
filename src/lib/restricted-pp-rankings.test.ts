import { describe, expect, it } from "vitest";

import { mergeRestrictedPpRanking, toRestrictedPpRankingEntry } from "./restricted-pp-rankings";
import type { RestrictedPpRankingEntry } from "./live-backend";
import type { LeanRankingEntry } from "./types";

function osuRow(id: number, pp: number): LeanRankingEntry {
  return {
    user: { id, username: `player${id}`, avatar_url: "", cover_url: "", country_code: "CR", is_online: true },
    hit_accuracy: 97,
    play_count: 1000,
    pp,
    global_rank: 1000 + id,
    ranked_score: 1,
    grade_counts: { ss: 0, ssh: 0, s: 0, sh: 0, a: 0 },
  };
}

function simulated(id: number, pp: number, globalRank = 500): RestrictedPpRankingEntry {
  return {
    user: { id, username: `gone${id}`, avatar_url: "avatar", cover_url: "cover", country_code: "CR" },
    pp,
    global_rank: globalRank,
    country_rank: null,
    hit_accuracy: 98.5,
    play_count: 42,
    ranked_score: 123,
    grade_counts: { ss: 1, ssh: 2, s: 3, sh: 4, a: 5 },
  };
}

const ids = (rows: LeanRankingEntry[]) => rows.map((row) => row.user.id);

describe("mergeRestrictedPpRanking", () => {
  it("inserts by pp so the positions after it move down one", () => {
    const merged = mergeRestrictedPpRanking([osuRow(1, 9000), osuRow(2, 8000), osuRow(3, 7000)], [simulated(9, 8500)], 3);
    expect(ids(merged)).toEqual([1, 9, 2]);
  });

  it("keeps a full list at its length and leaves out a player below the last row", () => {
    const ranking = [osuRow(1, 9000), osuRow(2, 8000)];
    expect(ids(mergeRestrictedPpRanking(ranking, [simulated(9, 7000)], 2))).toEqual([1, 2]);
  });

  it("appends below the last row while the list has room", () => {
    const merged = mergeRestrictedPpRanking([osuRow(1, 9000), osuRow(2, 8000)], [simulated(9, 7000)], 50);
    expect(ids(merged)).toEqual([1, 2, 9]);
  });

  it("keeps the osu! row ahead on a tie", () => {
    const merged = mergeRestrictedPpRanking([osuRow(1, 9000), osuRow(2, 8000)], [simulated(9, 8000)], 2);
    expect(ids(merged)).toEqual([1, 2]);
  });

  it("orders several simulated players by pp", () => {
    const merged = mergeRestrictedPpRanking(
      [osuRow(1, 9000), osuRow(2, 6000)],
      [simulated(8, 7000), simulated(9, 9500)],
      10,
    );
    expect(ids(merged)).toEqual([9, 1, 8, 2]);
  });

  it("keeps the osu! row of a player it already lists", () => {
    const ranking = [osuRow(1, 9000), osuRow(2, 8000)];
    const merged = mergeRestrictedPpRanking(ranking, [simulated(2, 9999)], 2);
    expect(merged).toBe(ranking);
  });

  it("returns the osu! list untouched with nothing to insert", () => {
    const ranking = [osuRow(1, 9000), osuRow(2, 8000)];
    expect(mergeRestrictedPpRanking(ranking, [], 1)).toBe(ranking);
    expect(mergeRestrictedPpRanking(ranking, [simulated(9, 0)], 1)).toBe(ranking);
  });

  it("carries a row pushed off page 1 onto the head of page 2", () => {
    const pageOne = Array.from({ length: 50 }, (_, i) => osuRow(i + 1, 10_000 - i * 10));
    const pageTwo = Array.from({ length: 50 }, (_, i) => osuRow(i + 51, 9000 - i * 10));
    const combined = mergeRestrictedPpRanking([...pageOne, ...pageTwo], [simulated(999, 9995)], 100);
    const shownPageOne = mergeRestrictedPpRanking(pageOne, [simulated(999, 9995)], 50);
    expect(ids(combined.slice(0, 50))).toEqual(ids(shownPageOne));
    expect(shownPageOne[1].user.id).toBe(999);
    expect(combined[50].user.id).toBe(50);
    expect(combined).toHaveLength(100);
    expect(combined[99].user.id).toBe(99);
  });
});

describe("toRestrictedPpRankingEntry", () => {
  it("fills a ranking row with the estimated global rank", () => {
    const row = toRestrictedPpRankingEntry(simulated(9, 8123.4, 321));
    expect(row).toEqual({
      user: { id: 9, username: "gone9", avatar_url: "avatar", cover_url: "cover", country_code: "CR", is_online: false },
      hit_accuracy: 98.5,
      play_count: 42,
      pp: 8123.4,
      global_rank: 321,
      ranked_score: 123,
      grade_counts: { ss: 1, ssh: 2, s: 3, sh: 4, a: 5 },
    });
  });
});
