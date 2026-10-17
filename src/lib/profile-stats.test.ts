import { describe, expect, it } from "vitest";
import { formatTopPercent, parseProfileStats, parseProfileStatsData } from "./profile-stats";

describe("profile stats", () => {
  it("takes four distinct known stats only", () => {
    expect(parseProfileStats(["ratio", "keySplit", "streak", "percentile"])).toEqual(["ratio", "keySplit", "streak", "percentile"]);
    expect(parseProfileStats(["ratio", "ratio", "streak", "percentile"])).toBeNull();
    expect(parseProfileStats(["ratio", "streak"])).toBeNull();
    expect(parseProfileStats(["ratio", "elo", "streak", "percentile"])).toBeNull();
  });

  it("keeps only well-formed data", () => {
    expect(parseProfileStatsData({ streak: { longest: 12, current: 3 }, percentile: { rank: 593, players: 28_000 } })).toEqual({ streak: { longest: 12, current: 3 }, percentile: { rank: 593, players: 28_000 } });
    expect(parseProfileStatsData({ streak: "x", percentile: { rank: 30, players: 20 } })).toEqual({});
    expect(parseProfileStatsData({ ratio: { perfect: 300, great: 100 }, lnSplit: { ln: 2, rice: 5 } })).toEqual({ ratio: { perfect: 300, great: 100 }, lnSplit: { ln: 2, rice: 5 } });
    expect(parseProfileStatsData({ ratio: { perfect: 0, great: 0 }, lnSplit: { ln: -1, rice: 5 } })).toEqual({});
  });

  it("shows enough digits to tell top players apart", () => {
    expect(formatTopPercent(12, 28_000)).toBe("0.043");
    expect(formatTopPercent(150, 28_000)).toBe("0.54");
    expect(formatTopPercent(593, 28_000)).toBe("2.1");
    expect(formatTopPercent(14_000, 28_000)).toBe("50");
    expect(formatTopPercent(0, 28_000)).toBeNull();
  });
});
