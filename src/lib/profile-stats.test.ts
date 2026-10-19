import { describe, expect, it } from "vitest";
import { formatTopPercent, parseProfileStats, parseProfileStatsData, sessionLength } from "./profile-stats";

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
    expect(parseProfileStatsData({ session: { minutes: 270, plays: 88, startedAt: "2026-10-01T10:00:00.000Z" } })).toEqual({ session: { minutes: 270, plays: 88, startedAt: "2026-10-01T10:00:00.000Z" } });
    expect(parseProfileStatsData({ session: { minutes: 0, plays: 1, startedAt: "2026-10-01T10:00:00.000Z" } })).toEqual({});
  });

  it("reads a session in hours past the first hour", () => {
    expect(sessionLength(42)).toEqual({ value: "42", hours: false });
    expect(sessionLength(270)).toEqual({ value: "4.5", hours: true });
    expect(sessionLength(731)).toEqual({ value: "12", hours: true });
  });

  it("shows enough digits to tell top players apart", () => {
    expect(formatTopPercent(12, 28_000)).toBe("0.043");
    expect(formatTopPercent(150, 28_000)).toBe("0.54");
    expect(formatTopPercent(593, 28_000)).toBe("2.1");
    expect(formatTopPercent(14_000, 28_000)).toBe("50");
    expect(formatTopPercent(0, 28_000)).toBeNull();
  });
});
