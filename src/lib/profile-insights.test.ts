import { describe, expect, it } from "vitest";
import { calculateUserProfileInsights } from "./profile-insights";
import type { OsuScore } from "./types";

interface TestScoreInput {
  id: number;
  cs: number;
  bpm: number;
  note_bpm?: number | null;
  created_at: string;
  pp: number;
  mods?: OsuScore["mods"];
  mode?: string;
  title?: string;
  convert?: boolean;
}

function createScore(overrides: TestScoreInput): OsuScore {
  const title = overrides.title ?? `Song ${overrides.id}`;
  return {
    accuracy: 1,
    beatmap: {
      id: 10_000 + overrides.id,
      beatmapset_id: 20_000 + overrides.id,
      bpm: overrides.bpm,
      note_bpm: overrides.note_bpm,
      cs: overrides.cs,
      convert: overrides.convert ?? false,
      mode: overrides.mode ?? "mania",
      url: `https://osu.ppy.sh/beatmaps/${10_000 + overrides.id}`,
      version: `${overrides.cs}K Another`,
    } as OsuScore["beatmap"],
    beatmapset: {
      artist: "Tester",
      covers: { cover: `https://assets.example/${overrides.id}.jpg` },
      id: 20_000 + overrides.id,
      title,
    } as OsuScore["beatmapset"],
    created_at: overrides.created_at,
    id: overrides.id,
    max_combo: 1,
    mods: overrides.mods ?? [],
    passed: true,
    pp: overrides.pp,
    rank: "S",
    score: 1,
    statistics: {},
    type: "score_best_mania",
    user: {
      id: 1,
      username: "test",
      avatar_url: "",
      country_code: "CR",
    },
    user_id: 1,
  };
}

describe("calculateUserProfileInsights", () => {
  it("summarizes key split, mods, BPM, top play dates, and PP range", () => {
    const insights = calculateUserProfileInsights([
      createScore({
        id: 1,
        cs: 4,
        bpm: 180,
        created_at: "2025-01-01T00:00:00Z",
        pp: 500,
        mods: [{ acronym: "DT" }],
        title: "Old DT",
      }),
      createScore({
        id: 2,
        cs: 7,
        bpm: 120,
        created_at: "2025-02-01T00:00:00Z",
        pp: 700,
        mods: [{ acronym: "HD" }],
        title: "Middle HD",
      }),
      createScore({
        id: 3,
        cs: 4,
        bpm: 200,
        created_at: "2025-03-01T00:00:00Z",
        pp: 450,
        title: "Newest NM",
      }),
      createScore({
        id: 5,
        cs: 7,
        bpm: 170,
        created_at: "2025-02-15T00:00:00Z",
        pp: 350,
        title: "Lower PP",
      }),
      createScore({
        id: 4,
        cs: 4,
        bpm: 90,
        created_at: "2025-04-01T00:00:00Z",
        pp: 900,
        mode: "osu",
        mods: [{ acronym: "HR" }],
      }),
    ]);

    expect(insights.sampleSize).toBe(4);
    expect(insights.keySplit).toEqual([
      { keyCount: 4, count: 2 },
      { keyCount: 7, count: 2 },
    ]);
    expect(insights.mostUsedMod).toEqual({ label: "DT", count: 1, total: 2 });
    expect(insights.modBreakdown).toEqual([
      { label: "DT", count: 1, total: 4 },
      { label: "HD", count: 1, total: 4 },
    ]);
    // Weighted median (0.95^index decay over the pp-descending list): the
    // smallest BPM whose cumulative weight reaches half the total.
    expect(insights.medianBpm).toBe(200);
    expect(insights.bpmByKeyMode).toEqual([
      { keyCount: 4, median: 270, count: 2 },
      { keyCount: 7, median: 120, count: 2 },
    ]);
    expect(insights.bpmRange?.min).toBe(120);
    expect(insights.bpmRange?.minScore.title).toBe("Middle HD");
    expect(insights.bpmRange?.max).toBe(270);
    expect(insights.bpmRange?.maxScore.title).toBe("Old DT");
    expect(insights.oldestTopPlay?.title).toBe("Old DT");
    expect(insights.oldestTopPlay?.scoreUrl).toBe("https://osu.ppy.sh/scores/mania/1");
    expect(insights.newestTopPlay?.title).toBe("Newest NM");
    expect(insights.newestTopPlay?.scoreUrl).toBe("https://osu.ppy.sh/scores/mania/3");
    expect(insights.ppRange).toEqual({ top: 700, bottom: 350 });
    expect(insights.ppDistribution).toEqual([
      { min: 700, max: null, count: 1, total: 4 },
      { min: 500, max: 599, count: 1, total: 4 },
      { min: 400, max: 499, count: 1, total: 4 },
      { min: 300, max: 399, count: 1, total: 4 },
    ]);
  });

  it("keeps the headline at the top plays' tempo when a larger stale tail sits elsewhere", () => {
    // 20 defining plays at 250 BPM, then 30 stale tail plays at 100 BPM. An
    // unweighted median over the 50 plays would read 100; the 0.95^i decay
    // keeps more than half the total weight in the top 20.
    const scores = [
      ...Array.from({ length: 20 }, (_, i) =>
        createScore({ id: i + 1, cs: 4, bpm: 250, created_at: "2025-06-01T00:00:00Z", pp: 900 - i }),
      ),
      ...Array.from({ length: 30 }, (_, i) =>
        createScore({ id: i + 21, cs: 4, bpm: 100, created_at: "2025-01-01T00:00:00Z", pp: 500 - i }),
      ),
    ];

    const insights = calculateUserProfileInsights(scores);
    expect(insights.medianBpm).toBe(250);
    expect(insights.bpmByKeyMode).toEqual([{ keyCount: 4, median: 250, count: 50 }]);
  });

  it("prefers note-derived BPM over the nominal field and falls back when absent", () => {
    const insights = calculateUserProfileInsights([
      // Nominal 666 is a timing gimmick; the note-derived tempo is the real one.
      createScore({ id: 1, cs: 4, bpm: 666, note_bpm: 222, created_at: "2025-03-01T00:00:00Z", pp: 700, title: "Gimmick" }),
      createScore({ id: 2, cs: 4, bpm: 180, note_bpm: null, created_at: "2025-02-01T00:00:00Z", pp: 600, title: "Null Note" }),
      createScore({ id: 3, cs: 4, bpm: 140, created_at: "2025-01-01T00:00:00Z", pp: 500, title: "No Note" }),
    ]);

    expect(insights.medianBpm).toBe(180);
    expect(insights.bpmRange?.max).toBe(222);
    expect(insights.bpmRange?.maxScore.title).toBe("Gimmick");
    expect(insights.bpmRange?.min).toBe(140);
  });

  it("uses smaller pp bands for lower-pp profiles", () => {
    const insights = calculateUserProfileInsights([
      createScore({
        id: 1,
        cs: 4,
        bpm: 120,
        created_at: "2025-01-01T00:00:00Z",
        pp: 138,
      }),
      createScore({
        id: 2,
        cs: 4,
        bpm: 130,
        created_at: "2025-01-02T00:00:00Z",
        pp: 103,
      }),
      createScore({
        id: 3,
        cs: 4,
        bpm: 140,
        created_at: "2025-01-03T00:00:00Z",
        pp: 77,
      }),
      createScore({
        id: 4,
        cs: 4,
        bpm: 150,
        created_at: "2025-01-04T00:00:00Z",
        pp: 28,
      }),
    ]);

    expect(insights.ppRange).toEqual({ top: 138, bottom: 28 });
    expect(insights.ppDistribution).toEqual([
      { min: 100, max: null, count: 2, total: 4 },
      { min: 50, max: 99, count: 1, total: 4 },
      { min: null, max: 49, count: 1, total: 4 },
    ]);
  });

  it("totals pp per keymode against that keymode's own list, strongest first", () => {
    const insights = calculateUserProfileInsights([
      createScore({ id: 1, cs: 4, bpm: 180, created_at: "2025-01-01T00:00:00Z", pp: 500 }),
      createScore({ id: 2, cs: 7, bpm: 180, created_at: "2025-01-02T00:00:00Z", pp: 400 }),
      createScore({ id: 3, cs: 4, bpm: 180, created_at: "2025-01-03T00:00:00Z", pp: 300 }),
      createScore({ id: 4, cs: 5, bpm: 180, created_at: "2025-01-04T00:00:00Z", pp: 200 }),
    ]);

    // Each keymode is weighted from its own index, not its place in the
    // profile-wide list: the second 4K play decays by 0.95, not by 0.95^2.
    expect(insights.keyPp).toEqual([
      { keyCount: 4, weightedPp: 500 + 300 * 0.95, count: 2, trackedCount: 0, missingBound: 0 },
      { keyCount: 7, weightedPp: 400, count: 1, trackedCount: 0, missingBound: 0 },
      { keyCount: 5, weightedPp: 200, count: 1, trackedCount: 0, missingBound: 0 },
    ]);
    // A window this short is the player's whole ranked history, so nothing
    // hides below it.
    expect(insights.keyPpCutoff).toBe(0);
    expect(insights.keyPpConverts).toBe(0);
  });

  it("leaves converts out of keymode pp, the way osu! leaves them out of 4K and 7K", () => {
    const insights = calculateUserProfileInsights([
      createScore({ id: 1, cs: 7, bpm: 180, created_at: "2025-01-01T00:00:00Z", pp: 500, convert: true }),
      createScore({ id: 2, cs: 7, bpm: 180, created_at: "2025-01-02T00:00:00Z", pp: 300 }),
    ]);

    expect(insights.keyPp).toEqual([
      { keyCount: 7, weightedPp: 300, count: 1, trackedCount: 0, missingBound: 0 },
    ]);
    expect(insights.keyPpConverts).toBe(1);
    // The play still happened, so the key split keeps counting it.
    expect(insights.keySplit).toEqual([{ keyCount: 7, count: 2 }]);
  });

  it("bounds what a capped window hides, so a side keymode reads as a floor", () => {
    const scores = [
      ...Array.from({ length: 190 }, (_, i) =>
        createScore({ id: i + 1, cs: 4, bpm: 180, created_at: "2025-01-01T00:00:00Z", pp: 600 - i }),
      ),
      ...Array.from({ length: 10 }, (_, i) =>
        createScore({ id: 500 + i, cs: 5, bpm: 180, created_at: "2025-01-01T00:00:00Z", pp: 405 - i }),
      ),
    ];

    const insights = calculateUserProfileInsights(scores);
    const fourKey = insights.keyPp.find((bucket) => bucket.keyCount === 4)!;
    const fiveKey = insights.keyPp.find((bucket) => bucket.keyCount === 5)!;

    // The 200th play is the cutoff: plays worth less than it exist and no osu!
    // call returns them.
    expect(insights.keyPpCutoff).toBe(396);
    // 190 plays deep, the decayed remainder cannot move the 4K total; 10 plays
    // in, the invisible 5K tail is worth more than the visible part.
    expect(fourKey.missingBound).toBeLessThan(fourKey.weightedPp * 0.02);
    expect(fiveKey.missingBound).toBeGreaterThan(fiveKey.weightedPp * 0.02);
    expect(fiveKey.missingBound).toBeCloseTo((396 * 0.95 ** 10) / 0.05, 6);
  });
  it("folds tracked plays into the keymode they were played on", () => {
    const insights = calculateUserProfileInsights(
      [
        createScore({ id: 1, cs: 4, bpm: 180, created_at: "2025-01-01T00:00:00Z", pp: 500 }),
        createScore({ id: 2, cs: 6, bpm: 180, created_at: "2025-01-02T00:00:00Z", pp: 400 }),
      ],
      {
        plays: [
          { beatmapId: 90_001, keyCount: 6, pp: 300 },
          { beatmapId: 90_002, keyCount: 6, pp: 200 },
        ],
        trackedFrom: "2026-05-27",
      },
    );

    const sixKey = insights.keyPp.find((bucket) => bucket.keyCount === 6)!;
    // 6K had one play in the window; the two tracked ones extend its own list.
    expect(sixKey.weightedPp).toBeCloseTo(400 + 300 * 0.95 + 200 * 0.95 ** 2, 6);
    expect(sixKey.count).toBe(3);
    expect(sixKey.trackedCount).toBe(2);
    expect(insights.keyPpTracked).toBe(2);
    expect(insights.keyPpTrackedFrom).toBe("2026-05-27");
  });

  it("counts a map in both the window and the tail once, at the window's pp", () => {
    const insights = calculateUserProfileInsights(
      [createScore({ id: 3, cs: 7, bpm: 180, created_at: "2025-01-01T00:00:00Z", pp: 500 })],
      // Same beatmap the window play is on (createScore ids are 10_000 + id),
      // carrying whatever the ingest last saw there.
      { plays: [{ beatmapId: 10_003, keyCount: 7, pp: 420 }] },
    );

    expect(insights.keyPp).toEqual([
      { keyCount: 7, weightedPp: 500, count: 1, trackedCount: 0, missingBound: 0 },
    ]);
    expect(insights.keyPpTracked).toBe(0);
  });

  it("gives each keymode its own list of 200 rather than one shared budget", () => {
    const insights = calculateUserProfileInsights(
      [createScore({ id: 4, cs: 5, bpm: 180, created_at: "2025-01-01T00:00:00Z", pp: 400 })],
      {
        plays: Array.from({ length: 250 }, (_, i) => ({
          beatmapId: 80_000 + i,
          keyCount: 5,
          pp: 399 - i,
        })),
      },
    );

    const fiveKey = insights.keyPp.find((bucket) => bucket.keyCount === 5)!;
    expect(fiveKey.count).toBe(200);
    expect(fiveKey.trackedCount).toBe(199);
  });

  it("leaves the missing bound measured from the window alone", () => {
    const scores = Array.from({ length: 200 }, (_, i) =>
      createScore({
        id: i + 1,
        cs: i < 190 ? 4 : 5,
        bpm: 180,
        created_at: "2025-01-01T00:00:00Z",
        pp: 600 - i,
      }),
    );
    const trackedPlays = Array.from({ length: 40 }, (_, i) => ({
      beatmapId: 70_000 + i,
      keyCount: 5,
      pp: 395 - i,
    }));

    const withTail = calculateUserProfileInsights(scores, { plays: trackedPlays });
    const fiveKey = withTail.keyPp.find((bucket) => bucket.keyCount === 5)!;

    // The tail raises the total, because those plays are real and were unseen.
    expect(fiveKey.weightedPp).toBeGreaterThan(
      calculateUserProfileInsights(scores).keyPp.find((bucket) => bucket.keyCount === 5)!.weightedPp,
    );
    // It does not narrow what is still unseen: a play the ingest never saw is
    // only known to be under the cutoff, so it could outrank every tracked one.
    expect(fiveKey.missingBound).toBeCloseTo((401 * 0.95 ** 10) / 0.05, 6);
  });

  it("ignores tracked plays that carry no usable keymode, map or pp", () => {
    const insights = calculateUserProfileInsights(
      [createScore({ id: 5, cs: 4, bpm: 180, created_at: "2025-01-01T00:00:00Z", pp: 300 })],
      {
        plays: [
          { beatmapId: 60_001, keyCount: 0, pp: 250 },
          { beatmapId: 0, keyCount: 4, pp: 250 },
          { beatmapId: 60_002, keyCount: 4, pp: 0 },
        ],
      },
    );

    expect(insights.keyPpTracked).toBe(0);
    expect(insights.keyPp).toEqual([
      { keyCount: 4, weightedPp: 300, count: 1, trackedCount: 0, missingBound: 0 },
    ]);
  });
  it("weights a tracked play by where it lands in its keymode's own list", () => {
    const scores = [
      createScore({ id: 1, cs: 7, bpm: 180, created_at: "2025-01-01T00:00:00Z", pp: 600 }),
      createScore({ id: 2, cs: 7, bpm: 180, created_at: "2025-01-02T00:00:00Z", pp: 450 }),
    ];
    const tracked = { plays: [{ beatmapId: 40_001, keyCount: 7, pp: 500 }] };

    const bucket = calculateUserProfileInsights(scores, tracked).keyPp.find((entry) => entry.keyCount === 7)!;

    // The tracked 500 sits second, so the window's 450 is pushed to third.
    expect(bucket.weightedPp).toBeCloseTo(600 + 500 * 0.95 + 450 * 0.95 ** 2, 10);
  });
});
