import { describe, expect, test } from "vitest";
import {
  buildManiaCardRenderData,
  buildManiaCardRenderDataFromSkills,
  getManiaCardRenderDataSignature,
  parseCssRgba,
  parseGradientStops,
} from "./renderData";
import type { OsuScore, OsuUser } from "#/lib/types";

const user = {
  id: 123,
  username: "PlayerWithAVeryLongName",
  avatar_url: "https://example.test/avatar.png",
  country_code: "US",
  statistics: { global_rank: 4567 },
} as OsuUser;

function score(starRating: number, pp: number): OsuScore {
  return {
    pp,
    accuracy: 0.9876,
    max_combo: 900,
    mods: [],
    beatmap: {
      difficulty_rating: starRating,
      bpm: 180,
      total_length: 120,
      accuracy: 8,
      drain: 6,
      count_circles: 900,
      count_sliders: 0,
      count_spinners: 0,
      max_combo: 900,
      cs: 4,
      ar: 9,
      od: 8,
      hp: 6,
      version: "Test",
    },
  } as unknown as OsuScore;
}

describe("buildManiaCardRenderData", () => {
  test("computes one shared dynamic data object for ThreeJS and admin comparison", () => {
    const data = buildManiaCardRenderData({ user, scores: [score(6.2, 420)] });

    expect(data.status).toBe("ready");
    if (data.status !== "ready") throw new Error("expected ready data");
    expect(data.user.id).toBe(123);
    expect(data.user.username).toBe("PlayerWithAVeryLongName");
    expect(data.avatarUrl).toBe("/api/avatar?u=123");
  });

  // Card textures need the CORS proxy, so every thumbnail render is an origin
  // fetch unless the URL is stable. Carrying osu!'s version token through makes
  // the proxy URL immutable and cacheable for good.
  test("carries the osu! avatar version into the proxy URL", () => {
    const versioned = { ...user, avatar_url: "https://a.ppy.sh/123?1730000000.jpeg" } as OsuUser;
    const data = buildManiaCardRenderData({ user: versioned, scores: [score(6.2, 420)] });

    if (data.status !== "ready") throw new Error("expected ready data");
    expect(data.avatarUrl).toBe("/api/avatar?u=123&v=1730000000.jpeg");
    expect(data.stats).toEqual([
      { label: "Control", value: data.skills.fingerControl },
      { label: "Speed", value: data.skills.speed },
      { label: "Precision", value: data.skills.accuracy },
    ]);
    expect(data.tier).toBeTypeOf("string");
    expect(data.tierStyle.label.length).toBeGreaterThan(0);
    if (data.nextTier) {
      expect(data.nextTier.remaining).toBeGreaterThan(0);
      expect(data.nextTier.label.length).toBeGreaterThan(0);
    }
  });

  test("returns empty status when no ranked play can mint a card", () => {
    const data = buildManiaCardRenderData({ user, scores: [] });

    expect(data).toEqual({
      status: "empty",
      message: "Need at least one ranked play with full beatmap data to mint a card.",
    });
  });

  test("rebuilds the same card from precomputed full-window skills without raw scores", () => {
    const computed = buildManiaCardRenderData({ user, scores: [score(6.2, 420)] });
    if (computed.status !== "ready") throw new Error("expected ready data");

    const rebuilt = buildManiaCardRenderDataFromSkills({
      user,
      skills: computed.skills,
      scores: [],
    });

    expect(getManiaCardRenderDataSignature(rebuilt)).toBe(getManiaCardRenderDataSignature(computed));
  });
});

describe("getManiaCardRenderDataSignature", () => {
  test("stays stable when equivalent profile data is rebuilt", () => {
    const firstScore = score(6.2, 420);
    const rebuiltScore = {
      ...firstScore,
      beatmap: { ...firstScore.beatmap },
      statistics: { ...firstScore.statistics },
    } as OsuScore;
    const rebuiltUser = {
      ...user,
      statistics: { ...user.statistics },
    } as OsuUser;

    const first = buildManiaCardRenderData({ user, scores: [firstScore] });
    const rebuilt = buildManiaCardRenderData({ user: rebuiltUser, scores: [rebuiltScore] });

    expect(getManiaCardRenderDataSignature(first)).toBe(getManiaCardRenderDataSignature(rebuilt));
  });

  test("changes when rendered skill data changes", () => {
    const baseline = buildManiaCardRenderData({ user, scores: [score(6.2, 420)] });
    const stronger = buildManiaCardRenderData({ user, scores: [score(6.8, 560)] });

    expect(getManiaCardRenderDataSignature(baseline)).not.toBe(getManiaCardRenderDataSignature(stronger));
  });
});

describe("honorary card art", () => {
  function cardFor(id: number, username: string) {
    const data = buildManiaCardRenderData({
      user: { ...user, id, username } as OsuUser,
      scores: [score(6.2, 420)],
    });
    if (data.status !== "ready") throw new Error("expected ready data");
    return data;
  }

  test("prints the name the community knows the player by", () => {
    // The osu! account is still [Crz]Player, and the profile link still uses
    // that: only the card art carries the old name.
    expect(cardFor(1089335, "[Crz]Player").user.username).toBe("Attang");
  });

  test("keeps the personalised badge on its own card only", () => {
    expect(cardFor(2288363, "SillyFangirl").tierStyle.label).toBe("Manip GOAT");
    expect(cardFor(10083439, "bojii").tierStyle.label).toBe("GOAT");
    expect(cardFor(123, "PlayerWithAVeryLongName").user.username).toBe("PlayerWithAVeryLongName");
  });

  test("drops the override when something else forces the tier", () => {
    const data = buildManiaCardRenderData({
      user: { ...user, id: 2288363, username: "SillyFangirl" } as OsuUser,
      scores: [score(6.2, 420)],
      tierOverride: "mythic",
    });
    if (data.status !== "ready") throw new Error("expected ready data");
    expect(data.tierStyle.label).toBe("Mythic");
  });
});

describe("style parsing helpers", () => {
  test("parses rgba tier colors into normalized channels", () => {
    expect(parseCssRgba("rgba(251, 113, 133, 0.4)")).toEqual({
      r: 251,
      g: 113,
      b: 133,
      a: 0.4,
    });
  });

  test("parses badge gradient stops for canvas and shader use", () => {
    expect(parseGradientStops("linear-gradient(142deg, #ff8ec4 0%, #ff3d8a 44%, #b81f68 100%)")).toEqual([
      { color: "#ff8ec4", offset: 0 },
      { color: "#ff3d8a", offset: 0.44 },
      { color: "#b81f68", offset: 1 },
    ]);
  });
});
