import { describe, expect, it } from "vitest";
import type { CountryTopPlay, OscScore, SnipeEvent } from "../src/shared/types.js";
import {
  compareEmbed,
  danEmbed,
  errorBody,
  farmEmbed,
  helpEmbed,
  maniacardEmbed,
  noticeBody,
  playerEmbed,
  rankingsEmbed,
  recentScoresEmbed,
  snipeEmbed,
  snipesListEmbed,
  topPlayEmbed,
  topPlaysListEmbed,
} from "../src/discord/embeds.js";

const SITE = "https://mania-tracker.com";

function makeScore(overrides: Partial<OscScore> = {}): OscScore {
  return {
    id: 555,
    user_id: 42,
    accuracy: 0.9765,
    mods: [{ acronym: "DT" }, { acronym: "HD" }],
    score: 980_000,
    max_combo: 1234,
    passed: true,
    rank: "S",
    statistics: { count_300: 1000, count_miss: 2 },
    pp: 612.4,
    beatmap: {
      id: 99,
      beatmapset_id: 7,
      difficulty_rating: 6.12,
      mode: "mania",
      cs: 4,
      bpm: 180,
      version: "Insane",
      url: "https://osu.ppy.sh/b/99",
    },
    beatmapset: {
      id: 7,
      title: "Test Song",
      artist: "Test Artist",
      covers: { list: "https://img/list.jpg", cover: "https://img/cover.jpg" },
    },
    user: { id: 42, username: "Tester", avatar_url: "https://a/42.png", country_code: "CR" },
    ...overrides,
  };
}

function topPlay(): CountryTopPlay {
  return {
    user: { id: 42, username: "Tester", avatar_url: "https://a/42.png", country_code: "CR" },
    score: makeScore(),
    pp: 612.4,
    weightedPP: 480,
    ppGain: 35.2,
    time: "2026-06-26T00:00:00.000Z",
  };
}

function snipe(): SnipeEvent {
  return {
    beatmap_id: 99,
    beatmapset_id: 7,
    score_id: 555,
    sniper: { id: 42, username: "Sniper", avatar_url: "https://a/42.png" },
    victim: { id: 7, username: "Victim", avatar_url: "https://a/7.png" },
    beatmap: { version: "Insane", difficulty_rating: 6.12, cs: 4, url: "https://osu.ppy.sh/b/99" },
    beatmapset: { title: "Test Song", artist: "Test Artist", cover_url: "https://img/cover.jpg" },
    totalScore: 1_000_000,
    accuracy: 0.9912,
    mods: ["DT"],
    pp: 700,
    rank: "SH",
    isLazer: false,
    hasReplay: true,
    timestamp: "2026-06-26T00:00:00.000Z",
    victimTimestamp: "2026-06-25T00:00:00.000Z",
    detectedAt: 1_750_000_000_000,
    boardRank: 1,
    victimTotalScore: 999_000,
    victimPp: 690,
  };
}

function profile(username = "Tester"): { user: Record<string, unknown>; bestScores: OscScore[] } {
  return {
    user: {
      id: 42,
      username,
      country_code: "CR",
      avatar_url: "https://a/42.png",
      statistics: { global_rank: 1234, country_rank: 5, pp: 8123, hit_accuracy: 98.34, play_count: 50000, level: { current: 102 } },
    },
    bestScores: [makeScore()],
  };
}

describe("discord embeds", () => {
  it("renders a top play with pp, gain and mods", () => {
    const body = topPlayEmbed(topPlay(), "CR", SITE);
    const embed = body.embeds?.[0];
    expect(embed?.title).toContain("top play");
    expect(embed?.description).toContain("612pp");
    expect(embed?.description).toContain("+35pp");
    expect(embed?.description).toContain("+DTHD");
    expect(embed?.description).toContain("97.65%");
    // Has a beatmap link button.
    expect(JSON.stringify(body.components)).toContain("https://osu.ppy.sh/b/99");
  });

  it("renders a snipe with both players and accuracy", () => {
    const embed = snipeEmbed(snipe(), "CR", SITE).embeds?.[0];
    expect(embed?.author?.name).toContain("Sniper sniped Victim");
    expect(embed?.author?.name).toContain("from #1");
    expect(embed?.description).toContain("99.12%");
    expect(embed?.description).toContain("+DT");
  });

  it("renders a profile card with ranks and pp", () => {
    const embed = playerEmbed(profile(), SITE).embeds?.[0];
    expect(embed?.author?.name).toContain("Tester");
    const fieldText = JSON.stringify(embed?.fields);
    expect(fieldText).toContain("#1,234");
    expect(fieldText).toContain("#5");
    expect(embed?.description).toContain("Top plays");
  });

  it("renders rankings as a numbered leaderboard", () => {
    const embed = rankingsEmbed(
      [
        { rank: 1, user: { id: 1, username: "A", country_code: "CR" }, pp: 9000 },
        { rank: 2, user: { id: 2, username: "B", country_code: "CR" }, pp: 8000 },
      ],
      "CR",
      SITE,
    ).embeds?.[0];
    expect(embed?.description).toContain("#1");
    expect(embed?.description).toContain("A");
    expect(embed?.title).toContain("rankings");
  });

  it("renders a maniacard with the card image and links", () => {
    const body = maniacardEmbed(profile("Tester"), SITE);
    const embed = body.embeds?.[0];
    expect(embed?.author?.name).toBe("Tester");
    expect(embed?.image?.url).toContain("kind=maniacard");
    expect(embed?.image?.url).toContain("Tester");
    expect(JSON.stringify(body.components)).toContain("/player/Tester/maniacard");
  });

  it("renders recent scores list and an empty fallback", () => {
    const withScores = recentScoresEmbed("Tester", 42, [makeScore()], SITE).embeds?.[0];
    expect(withScores?.description).toContain("Test Song");
    const empty = recentScoresEmbed("Tester", 42, [], SITE).embeds?.[0];
    expect(empty?.description).toContain("No recent");
  });

  it("renders list embeds for /top and /snipes", () => {
    expect(topPlaysListEmbed([topPlay()], "CR", SITE).embeds?.[0]?.description).toContain("Tester");
    expect(snipesListEmbed([snipe()], "CR", SITE).embeds?.[0]?.description).toContain("Sniper");
  });

  it("renders a head-to-head compare", () => {
    const embed = compareEmbed(profile("A"), profile("B"), SITE).embeds?.[0];
    expect(embed?.title).toBe("A vs B");
    expect(embed?.description).toContain("pp");
  });

  it("renders dan estimate states and attaches an emblem", () => {
    const ready = danEmbed(99, { displayName: "10th Dan", label: "10", family: "jack", confidence: 0.8 }, false, SITE).embeds?.[0];
    expect(ready?.description).toContain("10th Dan");
    expect(ready?.description).toContain("Jack");
    // svg emblem (numeric dan) is rasterized through the og route.
    expect(ready?.thumbnail?.url).toContain("kind=dan-emblem");
    // webp emblem (greek dan) links straight to the asset.
    const greek = danEmbed(99, { displayName: "Gamma Dan", label: "gamma", family: "jack", confidence: 0.8 }, false, SITE).embeds?.[0];
    expect(greek?.thumbnail?.url).toContain("/images/dans/reform/gamma.webp");
    expect(danEmbed(99, null, true, SITE).embeds?.[0]?.description).toContain("Estimating");
    expect(danEmbed(99, null, false, SITE).embeds?.[0]?.description).toContain("No dan estimate");
  });

  it("does not throw on missing optional score fields", () => {
    const bare = makeScore({ beatmap: undefined, beatmapset: undefined, pp: null, mods: [] });
    const play: CountryTopPlay = { ...topPlay(), score: bare, ppGain: 0 };
    expect(() => topPlayEmbed(play, null, SITE)).not.toThrow();
    expect(() => recentScoresEmbed("X", 1, [bare], SITE)).not.toThrow();
  });

  it("keeps every embed free of decorative emoji and em dashes", () => {
    const farmSnapshot = {
      username: "Tester",
      userId: 42,
      pp: 8000,
      keyMode: "4k",
      recs: [{ title: "T", artist: "A", version: "V", keys: 4, stars: 5, estimatedPpGain: 42, recommendedMods: ["DT"], mapUrl: "https://x" }],
    };
    const bodies = [
      playerEmbed(profile(), SITE),
      maniacardEmbed(profile(), SITE),
      recentScoresEmbed("Tester", 42, [makeScore()], SITE),
      topPlayEmbed(topPlay(), "CR", SITE),
      snipeEmbed(snipe(), "CR", SITE),
      topPlaysListEmbed([topPlay()], "CR", SITE),
      snipesListEmbed([snipe()], "CR", SITE),
      rankingsEmbed([{ rank: 1, user: { id: 1, username: "A", country_code: "US" }, pp: 9000 }], "GLOBAL", SITE),
      farmEmbed(farmSnapshot, SITE),
      compareEmbed(profile("A"), profile("B"), SITE),
      danEmbed(99, { displayName: "10th Dan", label: "10", family: "jack", confidence: 0.8 }, false, SITE),
      helpEmbed(SITE),
      errorBody("oops"),
      noticeBody("hi"),
    ];
    // Pictographs, flags, tick/cross/warning, em dash and the pointer glyph. The
    // star rating glyph (U+2605) and bullet (U+2022) are intentionally allowed.
    const forbidden = /[\u{1F300}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}✅❌⚠]|—|▸/u;
    for (const body of bodies) {
      expect(JSON.stringify(body)).not.toMatch(forbidden);
    }
  });
});
