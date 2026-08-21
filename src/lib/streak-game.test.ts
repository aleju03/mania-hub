// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { LiveGlobalRankingEntry } from "./live-backend";
import { getI18n } from "./i18n";
import {
  formatStreakMonth,
  formatStreakValue,
  isStreakGuessCorrect,
  pickStreakMetric,
  pickStreakPlayer,
  pickUnloadedPage,
  playableMetrics,
  STREAK_METRIC_COPY,
  STREAK_METRICS,
  STREAK_PAGE_SIZE,
  STREAK_POOL_PLAYERS,
  STREAK_POOL_PLAYERS_TIGHT,
  readBestStreak,
  streakMetricValue,
  streakPoolDepth,
  streakPageCount,
  streakPageSlice,
  streakPoolEntries,
  streakRankPage,
  streakShardValue,
  toStreakPlayer,
  writeBestStreak,
  type StreakPlayerExtras,
} from "./streak-game";

function entry(
  id: number,
  overrides: Partial<{ pp: number; globalRank: number | null; plays: number | null; score: number | null }> = {},
): LiveGlobalRankingEntry {
  return {
    rank: id,
    user: {
      id,
      username: `player${id}`,
      avatar_url: `https://a.ppy.sh/${id}`,
      cover_url: "",
      country_code: "CR",
      avatar_accent: null,
    },
    pp: overrides.pp ?? 12_000,
    global_rank: overrides.globalRank === undefined ? id : overrides.globalRank,
    country_rank: null,
    hit_accuracy: null,
    play_count: overrides.plays === undefined ? 20_000 : overrides.plays,
    ranked_score: overrides.score === undefined ? 1_000_000_000 : overrides.score,
    grade_counts: null,
    global_change: null,
    country_change: null,
  };
}

describe("streak draw", () => {
  it("reads a player off a ranking entry, falling back to the pool position", () => {
    expect(toStreakPlayer(entry(7, { pp: 12_345, plays: 40_000, score: 900 }))).toMatchObject({
      userId: 7,
      username: "player7",
      countryCode: "CR",
      globalRank: 7,
      pp: 12_345,
      plays: 40_000,
      score: 900,
    });
    // No osu! global rank stored: the pool position stands in so the board
    // still has a number to print.
    expect(toStreakPlayer(entry(7, { globalRank: null })).globalRank).toBe(7);
  });

  it("treats a missing or zero count as no answer rather than as zero", () => {
    const player = toStreakPlayer(entry(1, { plays: null, score: 0 }));
    expect(player.plays).toBeNull();
    expect(player.score).toBeNull();
    expect(playableMetrics(player)).toEqual([]);
    expect(streakMetricValue(player, "plays")).toBeNull();
  });

  it("covers the pool depth in pages without running off the end of the snapshot", () => {
    expect(streakPageCount(10_000)).toBe(STREAK_POOL_PLAYERS / STREAK_PAGE_SIZE);
    expect(streakPageCount(120)).toBe(3);
    expect(streakPageCount(0)).toBe(1);
  });

  it("opens the whole snapshot to the hard mode", () => {
    expect(streakPageCount(10_000, "anyone")).toBe(200);
    expect(pickUnloadedPage(10_000, new Set(), () => 0.999999, "anyone")).toBe(200);
    // The classic game still stops at the pool depth.
    expect(pickUnloadedPage(10_000, new Set(), () => 0.999999)).toBe(STREAK_POOL_PLAYERS / STREAK_PAGE_SIZE);
    // A snapshot smaller than the depth plays the same in both.
    expect(streakPageCount(120, "anyone")).toBe(3);
  });

  it("keeps a hard run's deep pages out of a top-1000 draw", () => {
    const entries = [entry(3), entry(1_200), entry(5_000)];
    expect(streakPoolEntries(entries, "top").map((e) => e.rank)).toEqual([3]);
    expect(streakPoolEntries(entries, "anyone")).toHaveLength(3);
  });

  it("draws the three pool depths apart", () => {
    // Pages are shared between the pools, so the tightest one has to filter
    // rather than trust what happens to be loaded.
    const entries = [entry(3), entry(640), entry(1_200)];
    expect(streakPoolEntries(entries, "top500").map((e) => e.rank)).toEqual([3]);
    expect(streakPoolEntries(entries, "top").map((e) => e.rank)).toEqual([3, 640]);
    expect(streakPoolEntries(entries, "anyone")).toHaveLength(3);

    expect(streakPoolDepth("top500")).toBe(STREAK_POOL_PLAYERS_TIGHT);
    expect(streakPoolDepth("top")).toBe(STREAK_POOL_PLAYERS);
    expect(streakPageCount(10_000, "top500")).toBe(STREAK_POOL_PLAYERS_TIGHT / STREAK_PAGE_SIZE);
    expect(pickUnloadedPage(10_000, new Set(), () => 0.999999, "top500")).toBe(10);
  });

  it("keeps one best per pool, so a tighter run cannot overwrite a deeper one", () => {
    writeBestStreak(11, "top500");
    writeBestStreak(22, "top");
    writeBestStreak(33, "anyone");
    expect(readBestStreak("top500")).toBe(11);
    expect(readBestStreak("top")).toBe(22);
    expect(readBestStreak("anyone")).toBe(33);
  });

  it("aims the hard draw at the page holding a pool position", () => {
    expect(streakRankPage(1)).toBe(1);
    expect(streakRankPage(50)).toBe(1);
    expect(streakRankPage(51)).toBe(2);
    expect(streakRankPage(9_001)).toBe(181);
    // Page 24 covers positions 1151-1200: only its own entries qualify.
    expect(streakPageSlice([entry(3), entry(1_200), entry(5_000)], 24).map((e) => e.rank)).toEqual([1_200]);
  });

  it("hands out a page nobody has loaded, then says so when they all are", () => {
    expect(pickUnloadedPage(150, new Set([1, 2]), () => 0)).toBe(3);
    expect(pickUnloadedPage(150, new Set([1, 2, 3]), () => 0)).toBeNull();
    // An rng at the very top of its range still lands inside the list.
    expect(pickUnloadedPage(150, new Set(), () => 0.999999)).toBe(3);
  });

  it("never puts the same player on the board twice in a run", () => {
    const entries = [entry(1), entry(2), entry(3)];
    expect(pickStreakPlayer(entries, new Set([1, 2]), () => 0)?.userId).toBe(3);
    expect(pickStreakPlayer(entries, new Set([1, 2, 3]), () => 0)).toBeNull();
  });

  it("skips players who cannot answer the question being asked", () => {
    const entries = [entry(1, { plays: null }), entry(2, { plays: 30_000 })];
    expect(pickStreakPlayer(entries, new Set(), () => 0, "plays")?.userId).toBe(2);
    // Nothing to ask about at all: not a candidate for any round.
    expect(pickStreakPlayer([entry(1, { plays: null, score: null })], new Set(), () => 0)).toBeNull();
  });
});

function extras(overrides: Partial<StreakPlayerExtras> = {}): StreakPlayerExtras {
  return {
    oldestTopAt: null,
    dtTop: null,
    k7Top: null,
    playTimeHours: null,
    joinedAt: null,
    followers: null,
    replayViews: null,
    ...overrides,
  };
}

describe("the projection-backed questions", () => {
  it("carries the extra numbers onto the player, keeping zero counts as answers", () => {
    const player = toStreakPlayer(entry(1), extras({ dtTop: 0, k7Top: 12, joinedAt: 0 }));
    expect(player.dtTop).toBe(0);
    expect(player.k7Top).toBe(12);
    // A zero timestamp is missing data, not the epoch.
    expect(player.joinedAt).toBeNull();
    expect(playableMetrics(player)).toEqual(["plays", "score", "dtTop", "k7Top"]);
  });

  it("plays on without them", () => {
    const player = toStreakPlayer(entry(1));
    expect(playableMetrics(player)).toEqual(["plays", "score"]);
  });

  it("hands the picked player their extras", () => {
    const byId = new Map([[2, extras({ playTimeHours: 480 })]]);
    const picked = pickStreakPlayer([entry(2)], new Set(), () => 0, undefined, byId);
    expect(picked?.playTimeHours).toBe(480);
  });

  it("has a full set of copy for every metric", () => {
    const en = getI18n("en");
    for (const metric of STREAK_METRICS) {
      const copy = STREAK_METRIC_COPY[metric];
      // The question is one whole sentence with both card names as named
      // placeholders, so a translation can put them wherever its word order needs.
      expect(copy.q.message).toContain("{hidden}");
      expect(copy.q.message).toContain("{shown}");
      expect(en._(copy.more)).not.toBe(en._(copy.less));
      expect(en._(copy.value(1_500_000_000))).not.toContain("NaN");
      expect(en._(copy.reveal("player", 1_500_000_000))).not.toContain("NaN");
    }
  });

  it("prints date metrics as a month, not a number", () => {
    const may2014 = Date.parse("2014-05-20T12:00:00Z");
    expect(formatStreakMonth(may2014)).toBe("May 2014");
    expect(formatStreakMonth(may2014, "es")).toBe("may 2014");
    const en = getI18n("en");
    expect(en._(STREAK_METRIC_COPY.joined.value(may2014))).toBe("joined May 2014");
    expect(en._(STREAK_METRIC_COPY.oldestTop.reveal("tyrcs", may2014))).toBe("tyrcs's oldest top play is from May 2014.");
  });

  it("scores date guesses by the clock: more means later", () => {
    const earlier = Date.parse("2014-05-20T00:00:00Z");
    const later = Date.parse("2019-10-05T00:00:00Z");
    // The hidden player joined later: "Later" (more) is the right call.
    expect(isStreakGuessCorrect("more", earlier, later)).toBe(true);
    const en = getI18n("en");
    expect(en._(STREAK_METRIC_COPY.joined.more)).toBe("Later");
    expect(en._(STREAK_METRIC_COPY.oldestTop.less)).toBe("Older");
  });
});

describe("the question", () => {
  it("only asks something both cards can answer", () => {
    const left = toStreakPlayer(entry(1, { score: null }));
    const right = toStreakPlayer(entry(2));
    expect(pickStreakMetric(left, right, () => 0)).toBe("plays");
    expect(pickStreakMetric(left, right, () => 0.99)).toBe("plays");

    const noOverlap = toStreakPlayer(entry(3, { plays: null }));
    expect(pickStreakMetric(left, noOverlap, () => 0)).toBeNull();
  });

  it("rotates between the questions when both are available", () => {
    const left = toStreakPlayer(entry(1));
    const right = toStreakPlayer(entry(2));
    expect(pickStreakMetric(left, right, () => 0)).toBe("plays");
    expect(pickStreakMetric(left, right, () => 0.9)).toBe("score");
  });

  it("prefers a question the two players differ on", () => {
    // Two 4K mains with zero 7K tops each: that question is a coin flip that
    // always pays, so it only comes up when nothing differs.
    const left = toStreakPlayer(entry(1, { plays: 10_000 }), extras({ k7Top: 0 }));
    const right = toStreakPlayer(entry(2, { plays: 90_000 }), extras({ k7Top: 0 }));
    const asked = new Set(
      Array.from({ length: 50 }, (_, i) => pickStreakMetric(left, right, () => i / 50)),
    );
    expect(asked.has("k7Top")).toBe(false);
    expect(asked.has("plays")).toBe(true);
  });
});

describe("what the cash-out button promises", () => {
  it("matches the backend's payout curve", () => {
    // Mirrored from pack-games.ts. If these drift, the button lies about what
    // stopping is worth, which is the one number a press-your-luck decision
    // rests on.
    expect(streakShardValue(0)).toBe(0);
    expect(streakShardValue(4)).toBe(32);
    expect(streakShardValue(5)).toBe(50);
    expect(streakShardValue(10)).toBe(110);
    expect(streakShardValue(20)).toBe(260);
  });
});

describe("streak guessing", () => {
  it("scores a guess against the number the card is hiding", () => {
    expect(isStreakGuessCorrect("more", 20_000, 30_000)).toBe(true);
    expect(isStreakGuessCorrect("more", 20_000, 10_000)).toBe(false);
    expect(isStreakGuessCorrect("less", 20_000, 10_000)).toBe(true);
    expect(isStreakGuessCorrect("less", 20_000, 30_000)).toBe(false);
  });

  it("gives a dead-even pair to the player", () => {
    expect(isStreakGuessCorrect("more", 20_000, 20_000)).toBe(true);
    expect(isStreakGuessCorrect("less", 20_000, 20_000)).toBe(true);
  });

  it("prints plays in full and ranked score short enough to compare at a glance", () => {
    expect(formatStreakValue(112_185, "plays")).toBe("112,185");
    expect(formatStreakValue(8_488_504_272, "score")).toBe("8.49B");
    expect(formatStreakValue(617_135_778, "score")).toBe("617.1M");
  });
});
