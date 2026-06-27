import { describe, expect, it } from "vitest";
import type { CountryTopPlay, OscScore, SnipeEvent } from "../src/shared/types.js";
import {
  activityEmbed,
  beatmapEmbed,
  compareEmbed,
  danEmbed,
  errorBody,
  farmEmbed,
  goalsEmbed,
  helpEmbed,
  maniacardEmbed,
  mapsListEmbed,
  meEmbed,
  newMapAlertEmbed,
  noticeBody,
  pbEmbed,
  playerEmbed,
  randomFarmEmbed,
  randomFavEmbed,
  rankingsEmbed,
  recentScoresEmbed,
  replayEmbed,
  snipeEmbed,
  snipesListEmbed,
  topPlayEmbed,
  topPlaysListEmbed,
  trackerListEmbed,
  whoamiEmbed,
} from "../src/discord/embeds.js";
import type { LeanTrackerScore } from "../src/shared/types.js";
import { FLAG_IS_COMPONENTS_V2, toComponentsV2Body } from "../src/discord/components.js";
import type { DiscordComponent, DiscordMessageBody } from "../src/discord/rest.js";

const SITE = "https://mania-tracker.com";

// Mirrors the converter's own component-count accounting so the test verifies the
// real V2 payload stays inside Discord's structural caps.
function countV2(component: DiscordComponent): number {
  let count = 1;
  for (const child of component.components ?? []) count += countV2(child);
  if (component.accessory) count += countV2(component.accessory);
  for (const item of component.items ?? []) {
    if (item.media?.url) count += 1;
  }
  return count;
}
function v2Text(components: DiscordComponent[] | undefined): string {
  let text = "";
  for (const component of components ?? []) {
    if (typeof component.content === "string") text += component.content;
    if (component.components) text += v2Text(component.components);
    if (component.accessory) text += v2Text([component.accessory]);
  }
  return text;
}

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
    const map = { id: 99, url: "https://osu.ppy.sh/b/99", title: "Test Artist - Test Song", version: "Insane" };
    const ready = danEmbed(map, { displayName: "10th Dan", label: "10", family: "jack", confidence: 0.8 }, false, SITE).embeds?.[0];
    expect(ready?.description).toContain("10th Dan");
    expect(ready?.description).toContain("Jack");
    // The map name becomes the embed title and links to the canonical URL.
    expect(ready?.title).toContain("Test Song");
    expect(ready?.url).toBe("https://osu.ppy.sh/b/99");
    // svg emblem (numeric dan) is rasterized through the og route.
    expect(ready?.thumbnail?.url).toContain("kind=dan-emblem");
    // webp emblem (greek dan) links straight to the asset.
    const greek = danEmbed(map, { displayName: "Gamma Dan", label: "gamma", family: "jack", confidence: 0.8 }, false, SITE).embeds?.[0];
    expect(greek?.thumbnail?.url).toContain("/images/dans/reform/gamma.webp");
    expect(danEmbed(map, null, true, SITE).embeds?.[0]?.description).toContain("Estimating");
    expect(danEmbed(map, null, false, SITE).embeds?.[0]?.description).toContain("No dan estimate");
  });

  it("renders a personal best on the last map, and a no-score fallback", () => {
    const beatmap = { id: 99, title: "Test Artist - Test Song", version: "Insane" };
    const withScore = pbEmbed({ username: "Tester", userId: 42, beatmap, score: makeScore(), siteOrigin: SITE }).embeds?.[0];
    expect(withScore?.title).toContain("Test Song");
    expect(withScore?.description).toContain("612pp");
    expect(withScore?.description).toContain("97.65%");
    const none = pbEmbed({ username: "Tester", userId: 42, beatmap, score: null, siteOrigin: SITE }).embeds?.[0];
    expect(none?.description).toContain("no score");
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
      danEmbed({ id: 99, url: "https://osu.ppy.sh/b/99", title: "Test Artist - Test Song", version: "Insane" }, { displayName: "10th Dan", label: "10", family: "jack", confidence: 0.8 }, false, SITE),
      pbEmbed({ username: "Tester", userId: 42, beatmap: { id: 99, title: "Test Artist - Test Song", version: "Insane" }, score: makeScore(), siteOrigin: SITE }),
      helpEmbed(SITE),
      helpEmbed(SITE, "players"),
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

describe("newer surface embeds", () => {
  const leanScore: LeanTrackerScore = {
    id: 9001,
    user_id: 42,
    accuracy: 0.9912,
    mods: [{ acronym: "DT" }],
    score: 980000,
    max_combo: 1500,
    passed: true,
    rank: "S",
    statistics: {},
    pp: 612,
    beatmap_id: 501,
    beatmap: { id: 501, beatmapset_id: 9001, difficulty_rating: 6.2, mode: "mania", cs: 4, bpm: 200, max_combo: 1500, version: "4K Another", url: "https://osu.ppy.sh/b/501", convert: false },
    beatmapset: { id: 9001, title: "Blue Zenith", artist: "xi", covers: { cover: "https://img/cover.jpg" } },
    user: { id: 42, username: "Kalkai", avatar_url: "https://a/42.png", country_code: "KR" },
    ended_at: "2026-06-26T00:00:00Z",
  };

  const meSummary = {
    userId: 42,
    username: "Kalkai",
    avatarUrl: "https://a/42.png",
    countryCode: "KR",
    pp: 13204,
    globalRank: 42,
    countryRank: 3,
    tracked: true,
    rankedMember: true,
    activeDays: 120,
    sessions: 340,
    topPlayCount: 87,
    highlights: { biggestDay: { count: 210, day: "2026-05-01" }, longestStreak: 14, ppGainedTracked: 540 },
    goalsOpen: 2,
    goalsCompleted: 5,
  };

  const activitySnapshot = {
    year: 2026,
    totalScores: 5000,
    activeDays: 120,
    totalSessions: 340,
    typicalSession: 15,
    currentStreak: 6,
    days: [
      { skills: { patterns: { stream: 40, jack: 20, chordjack: 10 } as Record<string, number> } },
      { skills: { patterns: { stream: 10, ln: 30 } as Record<string, number> } },
    ],
  };

  const goals = [
    { kind: "reach_pp", beatmapLabel: null, targetValue: 14000, targetGrade: null, status: "open", progress: { pct: 94, detail: "13204pp" } },
    { kind: "accuracy", beatmapLabel: "Blue Zenith [4K Another]", targetValue: 0.99, targetGrade: null, status: "open", progress: { pct: 80, detail: "best 98.20%" } },
    { kind: "pass", beatmapLabel: "Freedom Dive", targetValue: null, targetGrade: null, status: "completed", progress: null },
  ];

  const farmed = [{ beatmapId: 501, version: "4K Another", difficultyRating: 6.2, title: "Blue Zenith", artist: "xi", playerCount: 12, avgPp: 700, maxPp: 850 }];
  const popular = [{ beatmapId: 502, version: "4K Master", title: "Aleph-0", artist: "DJ Noriken", totalPlays: 4200, playerCount: 80 }];

  const beatmap = { id: 501, version: "4K Another", difficulty_rating: 6.2, cs: 4, bpm: 200, total_length: 245, status: "ranked", url: "https://osu.ppy.sh/b/501", beatmapset: { title: "Blue Zenith", artist: "xi", creator: "Mapper", covers: { cover: "https://img/cover.jpg" } } };

  const bodies = [
    meEmbed(meSummary, SITE),
    activityEmbed("Kalkai", 42, activitySnapshot, SITE),
    goalsEmbed("Kalkai", 42, goals, SITE),
    trackerListEmbed([leanScore], "CR", SITE),
    mapsListEmbed({ farmed, popular, tab: "farmed", country: "CR", keys: "4k", siteOrigin: SITE }),
    mapsListEmbed({ farmed, popular, tab: "popular", country: "GLOBAL", keys: "", siteOrigin: SITE }),
    randomFarmEmbed(
      { beatmapId: 501, version: "4K Another", difficultyRating: 6.2, cs: 4, bpm: 200, status: "ranked", title: "Blue Zenith", artist: "xi", creator: "Mapper", covers: { cover: "https://img/cover.jpg" }, playerCount: 12, avgPp: 700, maxPp: 850, dominantMod: "DT" },
      "GLOBAL",
      SITE,
    ),
    randomFavEmbed(
      { id: 9001, title: "Blue Zenith", artist: "xi", creator: "Mapper", status: "loved", covers: { cover: "https://img/cover.jpg" }, maniaKeys: [4, 7], starMin: 5.2, starMax: 6.4, bpm: 200, patterns: ["jack", "chordjack"], globalFavouriteCount: 4200 },
      "Kalkai",
      3,
      "CR",
      SITE,
    ),
    beatmapEmbed(beatmap, { displayName: "10th Dan", label: "10", family: "jack" }, SITE),
    replayEmbed(123456, SITE),
    newMapAlertEmbed({ beatmapId: 501, beatmapsetId: 9001, title: "Blue Zenith", artist: "xi", version: "4K Another", difficultyRating: 6.2, cs: 4, coverUrl: "https://img/c.jpg", rankedAtMs: Date.parse("2026-06-20T00:00:00Z") }, SITE),
    whoamiEmbed({ osuUsername: "Kalkai", osuUserId: 42, countryCode: "KR" }, SITE),
    pbEmbed({ username: "Kalkai", userId: 42, beatmap: { id: 501, title: "xi - Blue Zenith", version: "4K Another" }, score: leanScore as unknown as OscScore, siteOrigin: SITE }),
  ];

  it("each produces at least one embed", () => {
    for (const body of bodies) {
      expect(Array.isArray(body.embeds)).toBe(true);
      expect((body.embeds ?? []).length).toBeGreaterThanOrEqual(1);
    }
  });

  it("stays within the 6000-char combined embed budget", () => {
    for (const body of bodies) {
      const embed = (body.embeds ?? [])[0] ?? {};
      const total = JSON.stringify(embed).length;
      expect(total).toBeLessThan(6000);
    }
  });

  it("contains no emojis or em dashes", () => {
    const forbidden = /[\u{1F300}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}✅❌⚠]|—|▸/u;
    for (const body of bodies) {
      expect(JSON.stringify(body)).not.toMatch(forbidden);
    }
  });

  it("renders aggregated playstyle patterns strongest-first", () => {
    const body = activityEmbed("Kalkai", 42, activitySnapshot, SITE);
    const description = body.embeds?.[0]?.description ?? "";
    expect(description).toContain("Stream");
    expect(description.indexOf("Stream")).toBeLessThan(description.indexOf("LN"));
  });

  // The bot ships every message through toComponentsV2Body at the REST layer, so
  // each real surface must produce a valid Components V2 payload: the flag set,
  // legacy fields cleared, and inside Discord's structural and text caps.
  it("converts every surface to a valid components v2 payload", () => {
    for (const body of bodies as DiscordMessageBody[]) {
      const v2 = toComponentsV2Body(body, { clearLegacy: true });
      expect((v2.flags ?? 0) & FLAG_IS_COMPONENTS_V2).toBe(FLAG_IS_COMPONENTS_V2);
      expect(v2.content).toBeNull();
      expect(v2.embeds).toBeNull();
      expect((v2.components ?? []).length).toBeGreaterThan(0);
      const total = (v2.components ?? []).reduce((sum, component) => sum + countV2(component), 0);
      expect(total).toBeLessThanOrEqual(40);
      expect(v2Text(v2.components).length).toBeLessThanOrEqual(4000);
    }
  });

  it("keeps converted sections and containers within Discord's structural rules", () => {
    for (const body of bodies as DiscordMessageBody[]) {
      const v2 = toComponentsV2Body(body, { clearLegacy: true });
      const all: DiscordComponent[] = [];
      const visit = (component: DiscordComponent): void => {
        all.push(component);
        for (const child of component.components ?? []) visit(child);
        if (component.accessory) visit(component.accessory);
      };
      for (const component of v2.components ?? []) visit(component);
      for (const component of all) {
        if (component.type === 9) {
          const texts = (component.components ?? []).filter((child) => child.type === 10);
          expect(texts.length).toBeGreaterThanOrEqual(1);
          expect(texts.length).toBeLessThanOrEqual(3);
          expect(component.accessory).toBeTruthy();
          expect([2, 11]).toContain(component.accessory?.type);
        }
        if (component.type === 17) {
          expect((component.components ?? []).length).toBeLessThanOrEqual(10);
          expect((component.components ?? []).some((child) => child.type === 17)).toBe(false);
        }
      }
    }
  });

  it("converted payloads contain no emojis or em dashes", () => {
    const forbidden = /[\u{1F300}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}✅❌⚠]|—|▸/u;
    for (const body of bodies as DiscordMessageBody[]) {
      const v2 = toComponentsV2Body(body, { clearLegacy: true });
      expect(JSON.stringify(v2.components)).not.toMatch(forbidden);
    }
  });
});
