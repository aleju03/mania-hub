import { describe, expect, it } from "vitest";
import { buildLazerLeaderboardRows, formatLazerLeaderboardAccuracy, lazerOutElastic, lazerOutQuint } from "./replay-leaderboard";
import type { ReplayLeaderboardEntry } from "./replay-leaderboard";

const player = (score: number): ReplayLeaderboardEntry => ({ name: "You", score, combo: 250 });
const entries: ReplayLeaderboardEntry[] = [
  { name: "Top", score: 900000, combo: 999, rank: 1, accuracy: 0.99, avatarUrl: "/api/avatar?u=2" },
  { name: "Second", score: 800000, combo: 888, rank: 2, accuracy: 0.9 },
  { name: "Third", score: 700000, combo: 777, rank: 3, accuracy: 0.88 },
];

describe("lazer solo gameplay leaderboard", () => {
  it("includes the watched score in the live ranks and moves displaced players down", () => {
    const rows = buildLazerLeaderboardRows(entries, player(850000), false);
    expect(rows.map((row) => [row.name, row.position])).toEqual([["Top", 1], ["You", 2], ["Second", 3], ["Third", 4]]);
    expect(rows[0]).toMatchObject({ accuracy: 0.99, avatarUrl: "/api/avatar?u=2" });
  });

  it("keeps the watched play below an existing score when tied", () => {
    const rows = buildLazerLeaderboardRows(entries, player(900000), false);
    expect(rows.slice(0, 2).map((row) => [row.name, row.position])).toEqual([["Top", 1], ["You", 2]]);
  });

  it("does not invent a rank below the last known score of a partial board", () => {
    const rows = buildLazerLeaderboardRows(entries, player(500000), true);
    expect(rows.at(-1)).toMatchObject({ name: "You", position: null });
    expect(rows.slice(0, 3).map((row) => row.position)).toEqual([1, 2, 3]);
  });

  it("only inserts a known rank into a partial board when its neighbours are consecutive", () => {
    const sparse = entries.map((entry, index) => ({ ...entry, rank: [1, 49, 50][index] }));
    expect(buildLazerLeaderboardRows(sparse, player(850000), true).find((row) => row.tracked)?.position).toBeNull();
    expect(buildLazerLeaderboardRows(sparse, player(750000), true).map((row) => row.position)).toEqual([1, 49, 50, 51]);
    expect(buildLazerLeaderboardRows(sparse, player(950000), true).map((row) => row.position)).toEqual([1, 2, 50, 51]);
  });

  it("floors accuracy so a near-perfect play never displays 100%", () => {
    expect(formatLazerLeaderboardAccuracy(0.9999999)).toBe("99.99%");
    expect(formatLazerLeaderboardAccuracy(0.8999999)).toBe("89.99%");
    expect(formatLazerLeaderboardAccuracy(1)).toBe("100.00%");
    expect(formatLazerLeaderboardAccuracy(undefined)).toBe("–");
  });

  it("settles row movement exactly and lets the leader's panel extension overshoot", () => {
    expect(lazerOutQuint(0)).toBe(0);
    expect(lazerOutQuint(1)).toBe(1);
    expect(lazerOutQuint(2)).toBe(1);
    expect(lazerOutElastic(0)).toBe(0);
    expect(lazerOutElastic(0.2)).toBeGreaterThan(1);
    expect(lazerOutElastic(1)).toBe(1);
  });
});
