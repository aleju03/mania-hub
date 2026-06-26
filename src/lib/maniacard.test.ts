import { describe, expect, test } from "vitest";
import { computeKeymodePpPrestige, computeManiaSkills, getNextManiaCardTier } from "./maniacard";
import type { OsuScore } from "./types";

function score(overrides: Partial<OsuScore> = {}): OsuScore {
  return {
    id: 1,
    user_id: 1,
    accuracy: 0.9876,
    beatmap_id: 1,
    mods: [],
    score: 980000,
    max_combo: 900,
    passed: true,
    rank: "S",
    statistics: { count_miss: 0 },
    pp: 420,
    beatmap: {
      id: 1,
      beatmapset_id: 1,
      difficulty_rating: 6.2,
      mode: "mania",
      status: "ranked",
      total_length: 120,
      cs: 4,
      drain: 6,
      accuracy: 8,
      ar: 9,
      bpm: 180,
      convert: false,
      count_circles: 900,
      count_sliders: 0,
      count_spinners: 0,
      max_combo: 900,
      version: "Regular Difficulty",
      url: "",
    },
    beatmapset: {
      id: 1,
      title: "Plain Song",
      artist: "Plain Artist",
      creator: "Mapper",
      user_id: 1,
      covers: {} as OsuScore["beatmapset"]["covers"],
      status: "ranked",
      play_count: 0,
      favourite_count: 0,
      submitted_date: "",
      ranked_date: "",
      last_updated: "",
      bpm: 180,
      preview_url: "",
    },
    user: {
      id: 1,
      username: "player",
      avatar_url: "",
      country_code: "CR",
    },
    ...overrides,
  };
}

describe("computeManiaSkills", () => {
  test("uses rate-adjusted star estimates for tempo mods", () => {
    const nm = computeManiaSkills([score()]);
    const dt = computeManiaSkills([score({ mods: [{ acronym: "DT" }] })]);
    const ht = computeManiaSkills([score({ mods: [{ acronym: "HT" }] })]);

    expect(nm?.starAvg).toBeCloseTo(6.2, 5);
    expect(dt?.starAvg).toBeCloseTo(6.2 * Math.pow(1.5, 0.72), 5);
    expect(ht?.starAvg).toBeCloseTo(6.2 * Math.pow(0.75, 0.72), 5);
  });

  test("does not change skills based on map title or difficulty text", () => {
    const plain = computeManiaSkills([score()]);
    const tagged = computeManiaSkills([
      score({
        beatmap: {
          ...score().beatmap,
          version: "LN Tech Speed Jack Stamina Dump",
        },
        beatmapset: {
          ...score().beatmapset,
          title: "Long Note Stream Marathon",
          artist: "Hybrid Burst",
        },
      }),
    ]);

    expect(tagged).toEqual(plain);
  });

  test("keeps mid-accuracy precision readable instead of bottoming out", () => {
    const skills = computeManiaSkills([score({ accuracy: 0.955 })]);

    expect(skills?.accuracy).toBeGreaterThan(300);
    expect(skills?.accuracy).toBeLessThan(750);
  });

  test("lets elite display stats break four digits without changing card power scale", () => {
    const skills = computeManiaSkills(
      [
        score({
          accuracy: 0.995,
          pp: 1500,
          beatmap: {
            ...score().beatmap,
            difficulty_rating: 9,
            accuracy: 9.5,
            bpm: 260,
            total_length: 190,
            count_circles: 1600,
            max_combo: 1600,
          },
          max_combo: 1600,
        }),
      ],
      { globalPp: 20_000 },
    );

    expect(skills?.speed).toBeGreaterThan(1000);
    expect(skills?.fingerControl).toBeGreaterThan(1000);
    expect(skills?.cardPower).toBeLessThanOrEqual(1000);
  });

  test("keeps displayed stat totals aligned with card rating progression", () => {
    const specialist = computeManiaSkills(
      [
        score({
          accuracy: 0.995,
          pp: 900,
          beatmap: {
            ...score().beatmap,
            difficulty_rating: 9,
            accuracy: 9.5,
            bpm: 260,
            total_length: 190,
            count_circles: 1600,
            max_combo: 1600,
          },
          max_combo: 1600,
        }),
      ],
      { globalPp: 13_500 },
    );
    const higherRated = computeManiaSkills(
      [
        score({
          accuracy: 0.9876,
          pp: 900,
          beatmap: {
            ...score().beatmap,
            difficulty_rating: 7.2,
            bpm: 210,
            total_length: 160,
            count_circles: 1100,
            max_combo: 1100,
          },
          max_combo: 1100,
        }),
      ],
      { globalPp: 24_000 },
    );

    const displayTotal = (skills: NonNullable<ReturnType<typeof computeManiaSkills>>) =>
      skills.fingerControl + skills.speed + skills.accuracy;

    if (!specialist || !higherRated) throw new Error("expected both cards to be computable");
    expect(higherRated.cardPower).toBeGreaterThan(specialist.cardPower);
    expect(displayTotal(higherRated)).toBeGreaterThan(displayTotal(specialist));
  });

  test("lets elite total pp outrank a lower-pp trait specialist with similar peak strength", () => {
    const elitePp7k = computeManiaSkills(
      [
        score({
          accuracy: 0.96,
          pp: 900,
          beatmap: {
            ...score().beatmap,
            difficulty_rating: 10.8,
            accuracy: 8.8,
            bpm: 205,
            total_length: 596,
            cs: 7,
            count_circles: 8500,
            count_sliders: 6500,
            max_combo: 15000,
          },
          max_combo: 1400,
        }),
      ],
      { globalPp: 18_500 },
    );
    const lowerPp4kSpecialist = computeManiaSkills(
      [
        score({
          accuracy: 0.992,
          pp: 820,
          beatmap: {
            ...score().beatmap,
            difficulty_rating: 8.4,
            accuracy: 9.5,
            bpm: 245,
            total_length: 420,
            count_circles: 6000,
            max_combo: 6000,
          },
          max_combo: 4200,
        }),
      ],
      { globalPp: 15_995 },
    );

    if (!elitePp7k || !lowerPp4kSpecialist) throw new Error("expected both cards to be computable");
    expect(elitePp7k.cardPower).toBeGreaterThan(lowerPp4kSpecialist.cardPower);
  });

  test("scores PP standing on a per-keymode scale", () => {
    const pure7k = [{ keyMode: 7, weight: 1 }];
    const pure4k = [{ keyMode: 4, weight: 1 }];
    // A 7K main reaches a given competitive standing at a lower raw global PP
    // than a 4K main, so the same total PP is worth more prestige at 7K.
    expect(computeKeymodePpPrestige(16_000, pure7k)).toBeGreaterThan(computeKeymodePpPrestige(16_000, pure4k));
    // Bounds and empty/unknown-keymode fallback behave.
    expect(computeKeymodePpPrestige(40_000, pure7k)).toBe(1);
    expect(computeKeymodePpPrestige(0, pure4k)).toBe(0);
    expect(computeKeymodePpPrestige(15_000, [])).toBeGreaterThan(0);
  });

  test("blends a hybrid's prestige band smoothly instead of snapping on the main keymode", () => {
    const pp = 16_000;
    const pure7k = computeKeymodePpPrestige(pp, [{ keyMode: 7, weight: 1 }]);
    const pure4k = computeKeymodePpPrestige(pp, [{ keyMode: 4, weight: 1 }]);
    // An even hybrid lands between the two pure bands, not on either cliff.
    const evenHybrid = computeKeymodePpPrestige(pp, [
      { keyMode: 7, weight: 1 },
      { keyMode: 4, weight: 1 },
    ]);
    expect(evenHybrid).toBeGreaterThan(pure4k);
    expect(evenHybrid).toBeLessThan(pure7k);
    // One extra play of either keymode nudges the result, it doesn't flip a tier:
    // a hybrid whose biggest plays are 7K is weighted toward the 7K band.
    const sevenKLeaning = computeKeymodePpPrestige(pp, [
      { keyMode: 7, weight: 7 },
      { keyMode: 4, weight: 3 },
    ]);
    expect(sevenKLeaning).toBeGreaterThan(evenHybrid);
    expect(sevenKLeaning).toBeLessThan(pure7k);
  });

  test("does not let half-time density farm read as full-rate speed", () => {
    const denseMap = {
      ...score().beatmap,
      difficulty_rating: 9.4,
      bpm: 260,
      total_length: 150,
      count_circles: 1900,
      max_combo: 1900,
    };
    const nm = computeManiaSkills([
      score({ accuracy: 0.98, pp: 900, beatmap: denseMap, max_combo: 1900 }),
    ]);
    const ht = computeManiaSkills([
      score({
        accuracy: 0.98,
        pp: 900,
        beatmap: denseMap,
        max_combo: 1900,
        mods: [{ acronym: "HT" }],
      }),
    ]);

    expect(ht?.speed).toBeLessThan((nm?.speed ?? 0) * 0.85);
  });

  test("routes rice-heavy density toward speed and LN-heavy density toward control", () => {
    const sharedBeatmap = {
      ...score().beatmap,
      difficulty_rating: 8.2,
      bpm: 220,
      total_length: 150,
      max_combo: 2000,
    };
    const rice = computeManiaSkills([
      score({
        accuracy: 0.985,
        pp: 900,
        max_combo: 2000,
        beatmap: {
          ...sharedBeatmap,
          count_circles: 1800,
          count_sliders: 200,
        },
      }),
    ]);
    const ln = computeManiaSkills([
      score({
        accuracy: 0.985,
        pp: 900,
        max_combo: 2000,
        beatmap: {
          ...sharedBeatmap,
          count_circles: 200,
          count_sliders: 1800,
        },
      }),
    ]);

    expect(rice?.speed).toBeGreaterThan(ln?.speed ?? 0);
    expect(ln?.fingerControl).toBeGreaterThan(rice?.fingerControl ?? 0);
  });

  test("rewards standout clean plays in the visible precision trait", () => {
    const steady = computeManiaSkills([
      score({ id: 1, accuracy: 0.955, pp: 500 }),
      score({ id: 2, accuracy: 0.956, pp: 480 }),
    ]);
    const withCleanPeak = computeManiaSkills([
      score({ id: 1, accuracy: 0.955, pp: 500 }),
      score({ id: 2, accuracy: 0.995, pp: 480 }),
    ]);

    expect(withCleanPeak?.accuracy).toBeGreaterThan((steady?.accuracy ?? 0) + 200);
  });

  test("uses MAX to 300 judgement ratio as a precision signal when counts exist", () => {
    const lowMax = computeManiaSkills([
      score({
        accuracy: 0.99,
        statistics: { count_geki: 400, count_300: 600, count_miss: 0 },
        beatmap: {
          ...score().beatmap,
          difficulty_rating: 7.4,
          count_circles: 650,
          count_sliders: 450,
          max_combo: 1100,
        },
        max_combo: 1100,
      }),
    ]);
    const highMax = computeManiaSkills([
      score({
        accuracy: 0.99,
        statistics: { count_geki: 850, count_300: 150, count_miss: 0 },
        beatmap: {
          ...score().beatmap,
          difficulty_rating: 7.4,
          count_circles: 650,
          count_sliders: 450,
          max_combo: 1100,
        },
        max_combo: 1100,
      }),
    ]);

    expect(highMax?.accuracy).toBeGreaterThan(lowMax?.accuracy ?? 0);
  });

  test("fades the MAX-to-300 ratio signal on dense-LN lazer plays", () => {
    const lnMap = {
      ...score().beatmap,
      difficulty_rating: 7.4,
      count_circles: 200,
      count_sliders: 1800,
      max_combo: 2000,
    };
    const lnPlay = (statistics: OsuScore["statistics"]) =>
      computeManiaSkills([
        score({ accuracy: 1, max_combo: 2000, statistics, beatmap: lnMap }),
      ]);

    // On lazer, LN tails are separate, great-skewed judgements, so the MAX
    // ratio swings wildly on dense-LN maps without reflecting real precision.
    // The two plays should land close instead of one being punished.
    const lowRatio = lnPlay({ count_geki: 400, count_300: 1600, count_miss: 0 });
    const highRatio = lnPlay({ count_geki: 1600, count_300: 400, count_miss: 0 });

    const gap = Math.abs((highRatio?.accuracy ?? 0) - (lowRatio?.accuracy ?? 0));
    expect(gap).toBeLessThan(60);
  });

  test("does not over-credit low-star perfects as top-tier precision", () => {
    const cleanLowStar = computeManiaSkills([
      score({
        accuracy: 1,
        pp: 300,
        statistics: { count_geki: 900, count_300: 100, count_miss: 0 },
        beatmap: {
          ...score().beatmap,
          difficulty_rating: 5.1,
          accuracy: 8.5,
        },
      }),
    ]);
    const cleanHighStar = computeManiaSkills([
      score({
        accuracy: 1,
        pp: 900,
        statistics: { count_geki: 900, count_300: 100, count_miss: 0 },
        beatmap: {
          ...score().beatmap,
          difficulty_rating: 8.2,
          accuracy: 8.5,
        },
      }),
    ]);

    expect(cleanLowStar?.accuracy).toBeLessThan(1050);
    expect(cleanHighStar?.accuracy).toBeGreaterThan(cleanLowStar?.accuracy ?? 0);
  });

});

describe("getNextManiaCardTier", () => {
  test("reports the remaining power for the next tier", () => {
    expect(getNextManiaCardTier(500)).toMatchObject({
      tier: "mythic",
      label: "Mythic",
      threshold: 575,
      remaining: 75,
    });
  });

  test("returns null at the top tier", () => {
    expect(getNextManiaCardTier(700)).toBeNull();
  });

  test("balances upper-tier boundaries into distinct prestige ranks", () => {
    expect(getNextManiaCardTier(575)).toMatchObject({
      tier: "ascendant",
      threshold: 635,
    });
    expect(getNextManiaCardTier(635)).toMatchObject({
      tier: "worldClass",
      threshold: 700,
    });
  });

  test("reports progress through the current tier band", () => {
    expect(getNextManiaCardTier(60)).toMatchObject({
      tier: "rare",
      currentTier: "common",
      progress: 0.5,
    });
    const midSuperRare = getNextManiaCardTier(370);
    expect(midSuperRare?.currentTier).toBe("superRare");
    expect(midSuperRare?.progress).toBeCloseTo(0.5, 2);
  });

  test("maps calibrated mental-model breakpoints to expected tiers", () => {
    expect(getNextManiaCardTier(239)).toMatchObject({
      tier: "elite",
      threshold: 240,
    });
    expect(getNextManiaCardTier(329)).toMatchObject({
      tier: "superRare",
      threshold: 330,
    });
    expect(getNextManiaCardTier(409)).toMatchObject({
      tier: "ultraRare",
      threshold: 410,
    });
    expect(getNextManiaCardTier(574)).toMatchObject({
      tier: "mythic",
      threshold: 575,
    });
  });
});
