import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, exec, migrate } from "../src/db.js";
import {
  PLAYER_SKILLS_SEED_VERSIONS,
  PLAYER_SKILLS_VERSION,
  aggregateSsrs,
  computePlayerSkillRatings,
  computePlayerSkillsJob,
  danClearAverageWindowFor,
  danIgnoredStrayCount,
  estimateWifeAccuracy,
  getPlayerSkillBreakdown,
  getPlayerSkillDanEvidence,
  getPlayRate,
  getRateModAcronym,
  getPlayerSkillPlays,
  loadArchivedTrackedEvidence,
  loadChartSkillInfo,
  loadBeatmapOds,
  parseNamedRate,
  ssrGoalForAccuracy,
  ssrGoalForScore,
} from "../src/features/player-skills.js";
import { storeCachedBeatmapFile } from "../src/osu/beatmap-file-cache.js";
import { JobQueue } from "../src/jobs/queue.js";
import type { OscScore } from "../src/shared/types.js";

async function withDb(run: (db: Awaited<ReturnType<typeof createDb>>) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "mania-live-skills-"));
  try {
    const db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
    await migrate(db);
    await run(db);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ~700 notes of 1/4 stream at 170 BPM, enough chart for MinaCalc to produce
// non-zero skillset values. The column order avoids a fixed 4-cycle: a perfect
// roll gets nerfed harder at higher rates, which would break the DT test.
function buildStreamBeatmapFile(): string {
  const pattern = [0, 1, 2, 3, 1, 3, 0, 2, 3, 0, 1, 3, 2, 0, 2, 1];
  const notes = Array.from({ length: 700 }, (_, index) => {
    const column = pattern[index % pattern.length];
    const x = 64 + column * 128;
    const time = 1000 + index * 88;
    return `${x},192,${time},1,0,0:0:0:0:`;
  }).join("\n");
  return `osu file format v14

[General]
AudioFilename: audio.mp3
Mode: 3

[Metadata]
Title: Player Skills Test
Artist: Test
Creator: Mapper
Version: 4K Stream

[Difficulty]
CircleSize:4
OverallDifficulty:8

[TimingPoints]
0,352.94,4,2,0,100,1,0

[HitObjects]
${notes}
`;
}

// The stream chart with every note turned into a ~250ms hold: same heads, so
// the head-only calc sees the identical chart, while the tail-aware pass sees
// the release rows.
function buildLnBeatmapFile(): string {
  const pattern = [0, 1, 2, 3, 1, 3, 0, 2, 3, 0, 1, 3, 2, 0, 2, 1];
  const notes = Array.from({ length: 700 }, (_, index) => {
    const column = pattern[index % pattern.length];
    const x = 64 + column * 128;
    const time = 1000 + index * 88;
    return `${x},192,${time},128,0,${time + 250}:0:0:0:0:`;
  }).join("\n");
  return `osu file format v14

[General]
AudioFilename: audio.mp3
Mode: 3

[Metadata]
Title: Player Skills LN Test
Artist: Test
Creator: Mapper
Version: 4K LN

[Difficulty]
CircleSize:4
OverallDifficulty:8

[TimingPoints]
0,352.94,4,2,0,100,1,0

[HitObjects]
${notes}
`;
}

function buildStdBeatmapFile(): string {
  return `osu file format v14

[General]
AudioFilename: audio.mp3
Mode: 0

[Metadata]
Title: Std Map
Artist: Test
Creator: Mapper
Version: Insane

[Difficulty]
CircleSize:4
OverallDifficulty:8

[HitObjects]
256,192,1000,1,0,0:0:0:0:
`;
}

const failingOsu = {
  getBeatmapFile: async (): Promise<string> => {
    throw new Error("no network in tests");
  },
};

function play(overrides: Partial<OscScore>): OscScore {
  return {
    id: 1,
    user_id: 99,
    accuracy: 0.97,
    mods: [],
    score: 900_000,
    max_combo: 500,
    passed: true,
    rank: "S",
    statistics: {},
    pp: 100,
    ended_at: "2026-07-01T00:00:00Z",
    ...overrides,
  };
}

describe("getRateModAcronym", () => {
  it("names the rate mod so NC/DC stay apart from DT/HT", () => {
    expect(getRateModAcronym([{ acronym: "NC" }])).toBe("NC");
    expect(getRateModAcronym([{ acronym: "DT", settings: { speed_change: 1.2 } }])).toBe("DT");
    expect(getRateModAcronym(["HD", "DC"])).toBe("DC");
    expect(getRateModAcronym([{ acronym: "HT" }])).toBe("HT");
    expect(getRateModAcronym([{ acronym: "MR" }, { acronym: "HD" }])).toBeNull();
    expect(getRateModAcronym([])).toBeNull();
    expect(getRateModAcronym(undefined)).toBeNull();
  });
});

describe("getPlayRate", () => {
  it("maps rate mods and leaves everything else at 1x", () => {
    expect(getPlayRate([])).toBe(1);
    expect(getPlayRate([{ acronym: "MR" }, { acronym: "HD" }])).toBe(1);
    expect(getPlayRate([{ acronym: "DT" }])).toBe(1.5);
    expect(getPlayRate([{ acronym: "NC" }])).toBe(1.5);
    expect(getPlayRate([{ acronym: "HT" }])).toBe(0.75);
    expect(getPlayRate([{ acronym: "DC" }])).toBe(0.75);
    expect(getPlayRate(["DT", "HD"])).toBe(1.5);
  });

  it("returns the exact custom speed_change a lazer rate mod carries", () => {
    expect(getPlayRate([{ acronym: "DT", settings: { speed_change: 1.1 } }])).toBe(1.1);
    expect(getPlayRate([{ acronym: "DT", settings: { speed_change: 1.15 } }])).toBe(1.15);
    expect(getPlayRate([{ acronym: "NC", settings: { speed_change: 1.5 } }])).toBe(1.5);
    expect(getPlayRate([{ acronym: "HT", settings: { speed_change: 0.9 } }])).toBe(0.9);
    expect(getPlayRate([{ acronym: "DC", settings: { speed_change: 0.88 } }])).toBe(0.88);
  });

  it("rejects variable rates and corrupt speeds instead of mis-rating them", () => {
    expect(getPlayRate([{ acronym: "WU" }])).toBeNull();
    expect(getPlayRate([{ acronym: "WD" }])).toBeNull();
    expect(getPlayRate([{ acronym: "AS" }])).toBeNull();
    expect(getPlayRate([{ acronym: "DT", settings: { speed_change: 37 } }])).toBeNull();
    expect(getPlayRate([{ acronym: "HT", settings: { speed_change: Number.NaN } }])).toBeNull();
  });
});

describe("ssrGoalForAccuracy", () => {
  it("clamps to the Etterna SSR cap and a sane floor", () => {
    expect(ssrGoalForAccuracy(0.93)).toBe(0.93);
    expect(ssrGoalForAccuracy(0.9999)).toBe(0.965);
    expect(ssrGoalForAccuracy(0.5)).toBe(0.8);
    expect(ssrGoalForAccuracy(Number.NaN)).toBe(0.93);
  });
});

describe("estimateWifeAccuracy", () => {
  it("splits high-accuracy plays by their MAX:300 ratio", () => {
    const allMax = estimateWifeAccuracy({ perfect: 1000 });
    const threeToOne = estimateWifeAccuracy({ perfect: 740, great: 247, good: 10, ok: 2, miss: 1 });
    const oneToOne = estimateWifeAccuracy({ perfect: 494, great: 494, good: 8, ok: 2, meh: 1, miss: 1 });
    expect(allMax).toBeGreaterThan(0.995);
    expect(threeToOne).toBeGreaterThan(0.965);
    expect(threeToOne).toBeLessThan(allMax!);
    expect(oneToOne).toBeLessThan(threeToOne!);
    expect(oneToOne).toBeGreaterThan(0.95);
  });

  it("punishes misses much harder than osu accuracy does", () => {
    const sloppy = estimateWifeAccuracy({ perfect: 550, great: 380, good: 50, ok: 10, miss: 10 });
    expect(sloppy).toBeLessThan(0.91);
    expect(sloppy).toBeGreaterThan(0.85);
  });

  it("reads stable-style judgement names and rejects empty counts", () => {
    const stable = estimateWifeAccuracy({ count_geki: 740, count_300: 247, count_katu: 10, count_100: 2, count_miss: 1 });
    const lazer = estimateWifeAccuracy({ perfect: 740, great: 247, good: 10, ok: 2, miss: 1 });
    expect(stable).toBe(lazer);
    expect(estimateWifeAccuracy({})).toBeNull();
    expect(estimateWifeAccuracy(undefined)).toBeNull();
  });

  it("reproduces the historical OD8 per-judgement values by default", () => {
    // The v15-and-earlier hardcoded table, now computed from the wife3 curve.
    expect(estimateWifeAccuracy({ perfect: 1 })).toBeCloseTo(0.9994, 3);
    expect(estimateWifeAccuracy({ great: 1 })).toBeCloseTo(0.9654, 3);
    expect(estimateWifeAccuracy({ good: 1 })).toBeCloseTo(0.3713, 3);
    expect(estimateWifeAccuracy({ ok: 1 })).toBeCloseTo(-0.55, 3);
    expect(estimateWifeAccuracy({ meh: 1 })).toBeCloseTo(-1.1957, 3);
    const counts = { perfect: 740, great: 247, good: 10, ok: 2, miss: 1 };
    expect(estimateWifeAccuracy(counts, { od: 8 })).toBe(estimateWifeAccuracy(counts));
  });

  it("derates wide-window judgements on low OD but keeps MAX at full value", () => {
    // The stable MAX window does not scale with OD, so real precision keeps
    // rating; a 300 inside OD0's +-64ms band is worth far less than OD8's.
    expect(estimateWifeAccuracy({ perfect: 1 }, { od: 0 })).toBeCloseTo(0.9994, 3);
    expect(estimateWifeAccuracy({ great: 1 }, { od: 0 })).toBeCloseTo(0.7511, 3);
    const counts = { perfect: 300, great: 650, good: 40, ok: 10 };
    const od0 = estimateWifeAccuracy(counts, { od: 0 })!;
    const od5 = estimateWifeAccuracy(counts, { od: 5 })!;
    const od8 = estimateWifeAccuracy(counts, { od: 8 })!;
    expect(od0).toBeLessThan(od5);
    expect(od5).toBeLessThan(od8);
  });

  it("widens windows for the windowScale option", () => {
    const counts = { perfect: 300, great: 700 };
    const scaled = estimateWifeAccuracy(counts, { od: 8, windowScale: 1.4 })!;
    expect(scaled).toBeLessThan(estimateWifeAccuracy(counts, { od: 8 })!);
  });
});

describe("ssrGoalForScore", () => {
  it("lets judgement-backed goals exceed the calc cap, bounded at 0.9975", () => {
    expect(ssrGoalForScore({ accuracy: 1, statistics: { perfect: 1000 } }, 0)).toBe(0.9975);
    const mixed = ssrGoalForScore({ accuracy: 0.995, statistics: { perfect: 740, great: 247, good: 10, ok: 2, miss: 1 } }, 0);
    expect(mixed).toBeGreaterThan(0.965);
    expect(mixed).toBeLessThan(0.9975);
  });

  it("falls back to capped accuracy when a score has no judgement counts", () => {
    expect(ssrGoalForScore({ accuracy: 0.9999, statistics: {} }, 0)).toBe(0.965);
    expect(ssrGoalForScore({ accuracy: 0.94, statistics: {} }, 0)).toBe(0.94);
  });

  it("refuses plays whose goal lands on the calc's 0.8 floor", () => {
    // The 61.56% DT scrape: clamped to goal 0.8 it rated near the chart's
    // full MSD; it must not rate at all.
    expect(ssrGoalForScore({ accuracy: 0.6156, statistics: {} }, 0)).toBeNull();
    expect(ssrGoalForScore({ accuracy: 0.8, statistics: {} }, 0)).toBeNull();
    expect(ssrGoalForScore({ accuracy: 0.81, statistics: {} }, 0)).toBe(0.81);
    // Judgement-backed: decent osu accuracy but a wife estimate the misses
    // drag below the floor is refused on the wife path too.
    const sloppy = {
      accuracy: 0.85,
      legacy_score_id: 12345,
      statistics: { count_geki: 200, count_300: 400, count_katu: 100, count_100: 100, count_miss: 200 },
    };
    expect(estimateWifeAccuracy(sloppy.statistics)).toBeLessThan(0.8);
    expect(ssrGoalForScore(sloppy, 0)).toBeNull();
  });

  it("fades the wife estimate toward plain accuracy by LN share for lazer plays", () => {
    // Same judgement counts: a rice chart keeps the full MAX:300 spread, an
    // LN-heavy chart mostly ignores it (lazer judges LN head+tail separately,
    // sagging the ratio), and an unknown chart trusts none of it.
    const score = { accuracy: 0.998, statistics: { perfect: 400, great: 580, good: 15, ok: 4, miss: 1 } };
    const rice = ssrGoalForScore(score, 0);
    const half = ssrGoalForScore(score, 0.5);
    const lnHeavy = ssrGoalForScore(score, 1);
    const unknown = ssrGoalForScore(score, null);
    const accGoal = ssrGoalForAccuracy(score.accuracy);
    expect(rice).toBeLessThan(accGoal);
    expect(half).toBeGreaterThan(rice!);
    expect(half).toBeLessThan(lnHeavy!);
    expect(lnHeavy).toBe(accGoal);
    expect(unknown).toBe(accGoal);
  });

  it("never fades stable scores: one judgement covers the whole hold", () => {
    const score = {
      accuracy: 0.998,
      legacy_score_id: 12345,
      statistics: { count_geki: 600, count_300: 380, count_katu: 15, count_100: 4, count_miss: 1 },
    };
    expect(ssrGoalForScore(score, 1)).toBe(ssrGoalForScore(score, 0));
  });

  it("values a 300-heavy play far lower on a 0 OD chart than on OD8", () => {
    const score = {
      accuracy: 0.997,
      legacy_score_id: 12345,
      statistics: { count_geki: 300, count_300: 700 },
    };
    const od0 = ssrGoalForScore(score, 0, 0);
    const od8 = ssrGoalForScore(score, 0, 8);
    expect(od8).toBeCloseTo(0.9756, 3);
    expect(od0).toBeCloseTo(0.8256, 3);
    expect(ssrGoalForScore(score, 0, null)).toBe(od8);
  });

  it("scales windows for EZ/HR on both clients", () => {
    // Lazer scales too: its mania EZ/HR matched stable's 1.4x window factor
    // in July 2025 (ppy/osu 8e53f47) and widened windows via effective OD
    // before that. It never left them alone.
    const statistics = { count_geki: 300, count_300: 700 };
    const stableEz = { accuracy: 0.997, legacy_score_id: 12345, statistics, mods: ["EZ"] };
    const stablePlain = { accuracy: 0.997, legacy_score_id: 12345, statistics, mods: [] };
    expect(ssrGoalForScore(stableEz, 0, 8)).toBeLessThan(ssrGoalForScore(stablePlain, 0, 8)!);
    const lazerStats = { perfect: 300, great: 700 };
    const lazerEz = { accuracy: 0.997, statistics: lazerStats, mods: ["EZ"] };
    const lazerPlain = { accuracy: 0.997, statistics: lazerStats, mods: [] };
    expect(ssrGoalForScore(lazerEz, 0, 8)).toBeLessThan(ssrGoalForScore(lazerPlain, 0, 8)!);
    expect(ssrGoalForScore(lazerEz, 0, 8)).toBe(ssrGoalForScore(stableEz, 0, 8));
  });
});

describe("loadBeatmapOds", () => {
  it("reads OD from beatmaps metadata and skips absent or absurd values", async () => {
    await withDb(async (db) => {
      const insert = "insert into beatmaps (beatmap_id, beatmapset_id, mode, version, metadata_json, updated_at) values (?, ?, 'mania', 'x', ?, ?)";
      const now = "2026-01-01T00:00:00Z";
      await exec(db, insert, [101, 1, JSON.stringify({ accuracy: 0 }), now]);
      await exec(db, insert, [102, 1, JSON.stringify({ accuracy: 8.5 }), now]);
      await exec(db, insert, [103, 1, JSON.stringify({}), now]);
      await exec(db, insert, [104, 1, JSON.stringify({ accuracy: 999 }), now]);
      const ods = await loadBeatmapOds(db, [101, 102, 103, 104, 105]);
      expect(ods.get(101)).toBe(0);
      expect(ods.get(102)).toBe(8.5);
      expect(ods.has(103)).toBe(false);
      expect(ods.has(104)).toBe(false);
      expect(ods.has(105)).toBe(false);
    });
  });
});

describe("aggregateSsrs", () => {
  it("returns 0 for no scores and stays below a lone SSR", () => {
    expect(aggregateSsrs([])).toBe(0);
    const single = aggregateSsrs([20]);
    expect(single).toBeGreaterThan(5);
    expect(single).toBeLessThan(20);
  });

  it("approaches the SSR level for a deep stack and is monotonic", () => {
    const stack = aggregateSsrs(Array.from({ length: 25 }, () => 25));
    expect(stack).toBeGreaterThan(22);
    expect(stack).toBeLessThan(28);
    const withBetterPlays = aggregateSsrs([...Array.from({ length: 25 }, () => 25), 30, 30]);
    expect(withBetterPlays).toBeGreaterThanOrEqual(stack);
  });
});

describe("computePlayerSkillRatings", () => {
  it("rates supported plays per keymode and classifies the rest", async () => {
    await withDb(async (db) => {
      await storeCachedBeatmapFile(db, 101, buildStreamBeatmapFile(), { source: "test" });
      await storeCachedBeatmapFile(db, 102, buildStdBeatmapFile(), { source: "test" });

      const scores: OscScore[] = [
        play({ id: 1, beatmap_id: 101, accuracy: 0.99, pp: 120 }),
        play({ id: 2, beatmap_id: 102, accuracy: 0.97, pp: 90 }),
        play({ id: 3, beatmap_id: 103, accuracy: 0.95, pp: 80 }),
        play({ id: 4, beatmap_id: 101, mods: [{ acronym: "DT", settings: { speed_change: 1.2 } }], pp: 70 }),
        play({ id: 5, beatmap_id: 101, pp: null }),
      ];
      const result = await computePlayerSkillRatings(db, failingOsu, scores, []);

      // The custom-rate DT play (1.2x) rates at its own (chart, rate) slot
      // beside the 1x play on the same chart; only the std convert is out.
      expect(result.summary.totalPlays).toBe(4);
      expect(result.summary.analyzedPlays).toBe(2);
      expect(result.summary.unsupportedPlays).toBe(1);
      expect(result.summary.pendingPlays).toBe(1);
      expect(result.summary.modes).toHaveLength(1);
      expect(result.summary.modes[0].keyCount).toBe(4);
      expect(result.summary.modes[0].ratings.Overall).toBeGreaterThan(0);
      expect(result.summary.modes[0].ratings.Stream).toBeGreaterThan(0);
    });
  });

  it("never counts a sub-floor play and evicts stored floor-rated ones", async () => {
    await withDb(async (db) => {
      await storeCachedBeatmapFile(db, 101, buildStreamBeatmapFile(), { source: "test" });

      // A low-accuracy scrape stays out whether it arrives tracked or top;
      // only the top-sourced one shows up in the unsupported count.
      const scrape = play({ id: 9, beatmap_id: 101, accuracy: 0.6156, mods: [{ acronym: "DT" }] });
      const tracked = await computePlayerSkillRatings(db, failingOsu, [], [], { trackedScores: [{ ...scrape, pp: null }] });
      expect(tracked.summary.analyzedPlays).toBe(0);
      expect(tracked.summary.totalPlays).toBe(0);
      const top = await computePlayerSkillRatings(db, failingOsu, [scrape], []);
      expect(top.summary.analyzedPlays).toBe(0);
      expect(top.summary.unsupportedPlays).toBe(1);

      // A floor-rated play stored before the exclusion existed drops on the
      // next compute instead of retaining forever.
      const healthy = await computePlayerSkillRatings(db, failingOsu, [play({ id: 11, beatmap_id: 101 })], []);
      expect(healthy.summary.analyzedPlays).toBe(1);
      const floorRated = { ...healthy.plays[0], identity: "legacy-scrape", goal: 0.8, accuracy: 0.6156 };
      const purged = await computePlayerSkillRatings(db, failingOsu, [], [floorRated], {});
      expect(purged.summary.analyzedPlays).toBe(0);
      // The same stored play above the floor retains as before.
      const aboveFloor = { ...healthy.plays[0] };
      const retained = await computePlayerSkillRatings(db, failingOsu, [], [aboveFloor], {});
      expect(retained.summary.analyzedPlays).toBe(1);
    });
  });

  it("skips Difficulty Adjust plays and evicts stored ones whose score still carries DA", async () => {
    await withDb(async (db) => {
      await storeCachedBeatmapFile(db, 101, buildStreamBeatmapFile(), { source: "test" });

      // DA rewrites the chart's own windows (OD -15 under Extended Limits),
      // so the play never becomes a candidate, tracked or top.
      const daPlay = play({ id: 21, beatmap_id: 101, mods: [{ acronym: "DA", settings: { overall_difficulty: -15 } }] });
      const top = await computePlayerSkillRatings(db, failingOsu, [daPlay], []);
      expect(top.summary.analyzedPlays).toBe(0);
      expect(top.summary.unsupportedPlays).toBe(1);
      const tracked = await computePlayerSkillRatings(db, failingOsu, [], [], { trackedScores: [{ ...daPlay, pp: null }] });
      expect(tracked.summary.totalPlays).toBe(0);

      // A DA play rated before the exclusion existed evicts on the next
      // compute while its score is still around to testify to the mods.
      const healthy = await computePlayerSkillRatings(db, failingOsu, [play({ id: 22, beatmap_id: 101 })], []);
      expect(healthy.summary.analyzedPlays).toBe(1);
      const sameScoreWithDa = play({ id: 22, beatmap_id: 101, mods: [{ acronym: "DA" }] });
      const purged = await computePlayerSkillRatings(db, failingOsu, [sameScoreWithDa], [{ ...healthy.plays[0] }]);
      expect(purged.summary.analyzedPlays).toBe(0);
    });
  });

  it("skips Hold Off/Invert/No Release plays: the judged chart is not the stored chart", async () => {
    await withDb(async (db) => {
      await storeCachedBeatmapFile(db, 101, buildStreamBeatmapFile(), { source: "test" });

      for (const acronym of ["HO", "IN", "NR"]) {
        const modded = play({ id: 31, beatmap_id: 101, mods: [{ acronym }] });
        const top = await computePlayerSkillRatings(db, failingOsu, [modded], []);
        expect(top.summary.analyzedPlays, acronym).toBe(0);
        expect(top.summary.unsupportedPlays, acronym).toBe(1);
        const tracked = await computePlayerSkillRatings(db, failingOsu, [], [], { trackedScores: [{ ...modded, pp: null }] });
        expect(tracked.summary.totalPlays, acronym).toBe(0);
      }

      // An HO play rated before the exclusion existed (an LN chart credited
      // as if the holds were played) evicts on the next compute while its
      // score is still around to testify to the mods.
      const healthy = await computePlayerSkillRatings(db, failingOsu, [play({ id: 32, beatmap_id: 101 })], []);
      expect(healthy.summary.analyzedPlays).toBe(1);
      const sameScoreWithHo = play({ id: 32, beatmap_id: 101, mods: [{ acronym: "HO" }] });
      const purged = await computePlayerSkillRatings(db, failingOsu, [sameScoreWithHo], [{ ...healthy.plays[0] }]);
      expect(purged.summary.analyzedPlays).toBe(0);
    });
  });

  it("rates DT plays at their real rate: 1.5x above 1.2x above 1x", async () => {
    await withDb(async (db) => {
      await storeCachedBeatmapFile(db, 101, buildStreamBeatmapFile(), { source: "test" });

      const nomod = await computePlayerSkillRatings(db, failingOsu, [play({ id: 1, beatmap_id: 101 })], []);
      const custom = await computePlayerSkillRatings(
        db,
        failingOsu,
        [play({ id: 2, beatmap_id: 101, mods: [{ acronym: "DT", settings: { speed_change: 1.2 } }] })],
        [],
      );
      const dt = await computePlayerSkillRatings(
        db,
        failingOsu,
        [play({ id: 3, beatmap_id: 101, mods: [{ acronym: "DT" }] })],
        [],
      );
      expect(custom.plays[0].rate).toBe(1.2);
      expect(dt.plays[0].rate).toBe(1.5);
      expect(custom.plays[0].values.Overall).toBeGreaterThan(nomod.plays[0].values.Overall);
      expect(dt.plays[0].values.Overall).toBeGreaterThan(custom.plays[0].values.Overall);
      expect(dt.plays[0].values.Overall).toBeGreaterThan(nomod.plays[0].values.Overall * 1.2);
    });
  });

  it("rates above-cap plays by MAX:300 ratio instead of flattening them", async () => {
    await withDb(async (db) => {
      // Same chart content under three ids (per-chart-and-rate dedup keeps
      // one play per slot, so the comparison needs distinct slots). The plays
      // are lazer-judged, so the MAX:300 spread only applies when the chart's
      // LN share is known (here: pure rice charts).
      const { CHART_ANALYSIS_VERSION } = await import("../src/features/chart-analysis.js");
      for (const beatmapId of [101, 102, 103]) {
        await storeCachedBeatmapFile(db, beatmapId, buildStreamBeatmapFile(), { source: "test" });
        await exec(
          db,
          `insert into beatmap_chart_analysis (beatmap_id, analysis_version, status, classification_json, updated_at)
           values (?, ?, 'ready', ?, ?)`,
          [beatmapId, CHART_ANALYSIS_VERSION, JSON.stringify({ lnRatio: 0, patterns: [] }), new Date().toISOString()],
        );
      }

      // All three plays sit above the 0.965 calc cap in osu accuracy terms;
      // without the wife estimate + extrapolation they would all rate equal.
      const scores = [
        play({ id: 1, beatmap_id: 101, accuracy: 1, statistics: { perfect: 700 } }),
        play({ id: 2, beatmap_id: 102, accuracy: 0.996, statistics: { perfect: 525, great: 172, good: 2, miss: 1 } }),
        play({ id: 3, beatmap_id: 103, accuracy: 0.993, statistics: { perfect: 346, great: 346, good: 6, ok: 1, miss: 1 } }),
      ];
      const result = await computePlayerSkillRatings(db, failingOsu, scores, []);
      expect(result.summary.analyzedPlays).toBe(3);
      const byId = new Map(result.plays.map((entry) => [entry.identity, entry]));
      const ss = byId.get("official:1")!;
      const high = byId.get("official:2")!;
      const mid = byId.get("official:3")!;
      expect(ss.goal).toBe(0.9975);
      expect(high.goal).toBeGreaterThan(0.965);
      expect(ss.values.Overall).toBeGreaterThan(high.values.Overall);
      expect(high.values.Overall).toBeGreaterThan(mid.values.Overall);
      // The extrapolation stays a nudge, not a runaway: an SS is worth a few
      // percent over a capped-goal play, not another difficulty tier.
      expect(ss.values.Overall).toBeLessThan(mid.values.Overall * 1.2);
    });
  });

  it("aggregates per-pattern ratings from chart-analysis tags", async () => {
    await withDb(async (db) => {
      const { CHART_ANALYSIS_VERSION } = await import("../src/features/chart-analysis.js");
      // Three tagged charts clear the min-plays bar (dedup keeps one play per
      // chart, so the bar needs distinct charts).
      for (const beatmapId of [101, 102, 103]) {
        await storeCachedBeatmapFile(db, beatmapId, buildStreamBeatmapFile(), { source: "test" });
        await exec(
          db,
          `insert into beatmap_chart_analysis (beatmap_id, analysis_version, status, classification_json, updated_at)
           values (?, ?, 'ready', ?, ?)`,
          [beatmapId, CHART_ANALYSIS_VERSION, JSON.stringify({ patterns: [{ id: "chordstream", score: 0.9 }, { id: "bracket", score: 0.6 }, { id: "ln", score: 0.2 }] }), new Date().toISOString()],
        );
      }
      await storeCachedBeatmapFile(db, 105, buildStreamBeatmapFile(), { source: "test" });

      // The play on the untagged chart contributes no pattern axis and is
      // reported back for chart-analysis enqueueing.
      const scores = [
        play({ id: 1, beatmap_id: 101, accuracy: 0.99 }),
        play({ id: 2, beatmap_id: 102, accuracy: 0.95 }),
        play({ id: 3, beatmap_id: 103, accuracy: 0.9 }),
        play({ id: 4, beatmap_id: 105, accuracy: 0.97 }),
      ];
      const result = await computePlayerSkillRatings(db, failingOsu, scores, []);

      expect(result.summary.analyzedPlays).toBe(4);
      expect(result.untaggedBeatmapIds).toEqual([105]);
      const mode = result.summary.modes[0];
      const patternIds = mode.patterns.map((entry) => entry.id).sort();
      expect(patternIds).toEqual(["bracket", "chordstream"]);
      expect(mode.patterns[0].plays).toBe(3);
      expect(mode.patterns[0].rating).toBeGreaterThan(0);
    });
  });

  it("vetoes the tech tag on jack charts and derives the whole-jack tag", async () => {
    await withDb(async (db) => {
      const { CHART_ANALYSIS_VERSION } = await import("../src/features/chart-analysis.js");
      // Pure jack charts carry a mid tech score from chord churn alone; only
      // the chart neither jack arm claims keeps its tech tag. 104 is the KKKC
      // shape: chordjack below the certainty bar (0.77) but LeoBlack jack
      // clusters carrying the chart (share 0.405), so the cluster arm both
      // tags it jack and evicts it from tech. 108 is the inverse: chordjack
      // certainty with stream-heavy clusters, so it stays a mixed chordjack +
      // tech chart instead of becoming whole-Jack.
      const kkkcClusters = [
        { pattern: "Jacks", importance: 41 },
        { pattern: "Chordstream", importance: 59 },
      ];
      const taggings = [
        [101, [{ id: "chordjack", score: 1 }, { id: "bracket", score: 1 }, { id: "tech", score: 0.6 }], null],
        [102, [{ id: "chordjack", score: 0.85 }, { id: "tech", score: 0.75 }], null],
        [103, [{ id: "chordjack", score: 0.4 }, { id: "tech", score: 0.7 }], null],
        [104, [{ id: "chordjack", score: 0.77 }, { id: "tech", score: 0.69 }], kkkcClusters],
        // Ningen shape: single-note jack at certainty vetoes tech on its own.
        [106, [{ id: "jack", score: 1 }, { id: "tech", score: 0.69 }], null],
        // EGOISM shape: a jack tag below the veto bar keeps the tech tag too.
        [107, [{ id: "jack", score: 0.67 }, { id: "tech", score: 0.7 }], null],
        [108, [
          { id: "chordjack", score: 0.93 },
          { id: "tech", score: 0.717 },
          { id: "jack", score: 0.38 },
          { id: "chordstream", score: 0.308 },
        ], [
          { pattern: "Chordstream", importance: 13_716_729 },
          { pattern: "Jacks", importance: 4_212_000 },
          { pattern: "Stream", importance: 875_000 },
        ]],
      ] as const;
      for (const [beatmapId, patterns, clusters] of taggings) {
        await storeCachedBeatmapFile(db, beatmapId, buildStreamBeatmapFile(), { source: "test" });
        await exec(
          db,
          `insert into beatmap_chart_analysis (beatmap_id, analysis_version, status, key_count, classification_json, updated_at)
           values (?, ?, 'ready', 7, ?, ?)`,
          [beatmapId, CHART_ANALYSIS_VERSION, JSON.stringify({ patterns, ...(clusters ? { clusters } : {}) }), new Date().toISOString()],
        );
      }

      const scores = [
        play({ id: 1, beatmap_id: 101, accuracy: 0.99 }),
        play({ id: 2, beatmap_id: 102, accuracy: 0.97 }),
        play({ id: 3, beatmap_id: 103, accuracy: 0.95 }),
        play({ id: 4, beatmap_id: 104, accuracy: 0.96 }),
        play({ id: 6, beatmap_id: 106, accuracy: 0.96 }),
        play({ id: 7, beatmap_id: 107, accuracy: 0.96 }),
        play({ id: 8, beatmap_id: 108, accuracy: 0.96 }),
      ];
      const result = await computePlayerSkillRatings(db, failingOsu, scores, []);
      const byBeatmap = new Map(result.plays.map((entry) => [entry.beatmapId, entry.patterns]));
      expect(byBeatmap.get(101)).toEqual(["chordjack", "bracket", "jack"]);
      expect(byBeatmap.get(102)).toEqual(["chordjack", "jack"]);
      expect(byBeatmap.get(103)).toEqual(["tech"]);
      expect(byBeatmap.get(104)).toEqual(["jack"]);
      expect(byBeatmap.get(106)).toEqual(["jack"]);
      expect(byBeatmap.get(107)).toEqual(["jack", "tech"]);
      expect(byBeatmap.get(108)).toEqual(["chordjack", "tech"]);
    });
  });

  it("positions player dan from a quorum of qualifying clears per verdict side", async () => {
    await withDb(async (db) => {
      await storeCachedBeatmapFile(db, 101, buildStreamBeatmapFile(), { source: "test" });
      await storeCachedBeatmapFile(db, 105, buildStreamBeatmapFile(), { source: "test" });
      const { CHART_ANALYSIS_VERSION } = await import("../src/features/chart-analysis.js");
      await exec(
        db,
        `insert into beatmap_chart_analysis (beatmap_id, analysis_version, status, classification_json, dan_dt_json, updated_at)
         values (101, ?, 'ready', ?, ?, ?)`,
        [
          CHART_ANALYSIS_VERSION,
          JSON.stringify({ lnRatio: 0, patterns: [], rc: { rawDan: 8.0 }, ln: { rawDan: 6.0 } }),
          JSON.stringify({ rawDan: 9.0, primaryFamily: "dan" }),
          new Date().toISOString(),
        ],
      );
      await exec(
        db,
        `insert into beatmap_chart_analysis (beatmap_id, analysis_version, status, classification_json, updated_at)
         values (105, ?, 'ready', ?, ?)`,
        [CHART_ANALYSIS_VERSION, JSON.stringify({ lnRatio: 0, patterns: [], rc: { rawDan: 7.4 }, ln: { rawDan: 5.4 } }), new Date().toISOString()],
      );

      await storeCachedBeatmapFile(db, 107, buildStreamBeatmapFile(), { source: "test" });
      await exec(
        db,
        `insert into beatmap_chart_analysis (beatmap_id, analysis_version, status, classification_json, updated_at)
         values (107, ?, 'ready', ?, ?)`,
        [CHART_ANALYSIS_VERSION, JSON.stringify({ lnRatio: 0, patterns: [], rc: { rawDan: 9.9 } }), new Date().toISOString()],
      );
      await storeCachedBeatmapFile(db, 108, buildStreamBeatmapFile(), { source: "test" });
      await exec(
        db,
        `insert into beatmap_chart_analysis (beatmap_id, analysis_version, status, classification_json, updated_at)
         values (108, ?, 'ready', ?, ?)`,
        [CHART_ANALYSIS_VERSION, JSON.stringify({ lnRatio: 0.7, patterns: [], ln: { rawDan: 6.3 } }), new Date().toISOString()],
      );
      await storeCachedBeatmapFile(db, 109, buildStreamBeatmapFile(), { source: "test" });
      await exec(
        db,
        `insert into beatmap_chart_analysis (beatmap_id, analysis_version, status, classification_json, updated_at)
         values (109, ?, 'ready', ?, ?)`,
        [CHART_ANALYSIS_VERSION, JSON.stringify({ lnRatio: 0.4, patterns: [], rc: { rawDan: 9.0 }, ln: { rawDan: 7.0 } }), new Date().toISOString()],
      );
      for (const [beatmapId, lnRawDan] of [[110, 5.4], [111, 6.0], [112, 7.0]] as const) {
        await storeCachedBeatmapFile(db, beatmapId, buildStreamBeatmapFile(), { source: "test" });
        await exec(
          db,
          `insert into beatmap_chart_analysis (beatmap_id, analysis_version, status, classification_json, updated_at)
           values (?, ?, 'ready', ?, ?)`,
          [beatmapId, CHART_ANALYSIS_VERSION, JSON.stringify({ lnRatio: 0.8, patterns: [], rc: { rawDan: 3.0 }, ln: { rawDan: lnRawDan } }), new Date().toISOString()],
        );
      }

      // Every clear sits exactly on its ladder's bar so the accuracy credit
      // is zero and this test stays about ROUTING (which side each chart
      // testifies for): 940/60 is exactly 96.00% stable, 3917/183 is exactly
      // 97.00% in ScoreV2's 305-weighted accuracy.
      const atRcBar = { perfect: 940, ok: 60 };
      const atLnBar = { perfect: 3917, ok: 183 };
      const scores = [
        play({ id: 1, beatmap_id: 101, accuracy: 0.96, statistics: atRcBar }),
        play({ id: 2, beatmap_id: 105, accuracy: 0.96, statistics: atRcBar }),
        // A DT clear counts only because the DT sweep stored a verdict, and
        // it lands on the verdict's primary side (rc here).
        play({ id: 3, beatmap_id: 101, mods: [{ acronym: "DT" }], accuracy: 0.96, statistics: atRcBar }),
        // Below the credit window entirely (91.9%, under the 92% edge):
        // analyzed, but credits nothing (if this 9.9 counted even decayed,
        // the rc dan would move). Count-free so the goal falls back to the
        // displayed accuracy and stays above the 0.8 floor: judgement counts
        // this bad wife-rate under the floor and would not rate at all.
        play({ id: 4, beatmap_id: 107, accuracy: 0.919 }),
        play({ id: 5, beatmap_id: 108, accuracy: 0.97, statistics: atLnBar }),
        // Hybrid below the LN cutoff (lnRatio 0.4): counts as a rice clear
        // only - its ln half (7.0) must never reach the LN ladder.
        play({ id: 6, beatmap_id: 109, accuracy: 0.96, statistics: atRcBar }),
        play({ id: 7, beatmap_id: 110, accuracy: 0.97, statistics: atLnBar }),
        play({ id: 8, beatmap_id: 111, accuracy: 0.97, statistics: atLnBar }),
        play({ id: 9, beatmap_id: 112, accuracy: 0.97, statistics: atLnBar }),
      ];
      const result = await computePlayerSkillRatings(db, failingOsu, scores, []);
      expect(result.summary.analyzedPlays).toBe(9);
      const dan = result.summary.modes[0].dan!;
      // rc evidence uses stable-formula accuracy from the judgement counts,
      // rice-primary charts only: 8.0, 9.0 (DT), 9.0 (hybrid counts rice),
      // 7.4. The dan is their average; the two 9.0s are the clears that reach it.
      expect(dan.rc?.rawDan).toBe(8.35);
      expect(dan.rc?.clears).toBe(2);
      expect(dan.rc?.label).toBeTruthy();
      // The LN side labels on the numeric LN ladder (never the rice greek
      // levels), LN-primary charts only, each crediting its chart's full dan:
      // 7.0 / 6.3 / 6.0 / 5.4 average to 6.18. If chart 109's ln half (7.0)
      // leaked in, the average would be 6.34 instead.
      expect(dan.ln?.rawDan).toBe(6.18);
      expect(dan.ln?.label).toBe("6+");
      expect(dan.ln?.clears).toBe(2);
    });
  });

  it("holds 4K LN clears to the course ladder's 97% ScoreV2 bar, not the displayed accuracy", async () => {
    await withDb(async (db) => {
      const { CHART_ANALYSIS_VERSION } = await import("../src/features/chart-analysis.js");
      for (const [beatmapId, lnRawDan] of [[201, 8.0], [202, 7.0], [203, 6.5], [204, 6.0], [205, 9.0]] as const) {
        await storeCachedBeatmapFile(db, beatmapId, buildStreamBeatmapFile(), { source: "test" });
        await exec(
          db,
          `insert into beatmap_chart_analysis (beatmap_id, analysis_version, status, classification_json, updated_at)
           values (?, ?, 'ready', ?, ?)`,
          [beatmapId, CHART_ANALYSIS_VERSION, JSON.stringify({ lnRatio: 0.8, patterns: [], rc: { rawDan: 3.0 }, ln: { rawDan: lnRawDan } }), new Date().toISOString()],
        );
      }

      // 956 max / 44 ok is 97.04% in ScoreV2's 305-weighted accuracy; 880/120
      // is 91.93%, below even the credit window. The clearing plays would read
      // as ~97.07% on stable's 300-weighted display accuracy, so a bar checked
      // in the wrong currency also credits the wrong bonus.
      const clearing = { perfect: 956, ok: 44 };
      const failing = { perfect: 880, ok: 120 };
      const scores = [
        play({ id: 1, beatmap_id: 201, accuracy: 0.9704, statistics: clearing }),
        play({ id: 2, beatmap_id: 202, accuracy: 0.9704, statistics: clearing }),
        play({ id: 3, beatmap_id: 203, accuracy: 0.9704, statistics: clearing }),
        play({ id: 4, beatmap_id: 204, accuracy: 0.9704, statistics: clearing }),
        play({ id: 5, beatmap_id: 205, accuracy: 0.9193, statistics: failing }),
      ];
      const dan = (await computePlayerSkillRatings(db, failingOsu, scores, [])).summary.modes[0].dan!;
      // 8.0 / 7.0 / 6.5 / 6.0 qualify, each a hair over the bar (+0.01 credit),
      // averaging to 6.88; the 9.0 sits under the credit window and credits
      // nothing at all.
      expect(dan.ln?.rawDan).toBe(6.88);
      expect(dan.ln?.clears).toBe(2);
    });
  });

  it("credits a chart's full dan for a bare pass at the bar, the way clearing a course does", async () => {
    await withDb(async (db) => {
      const { CHART_ANALYSIS_VERSION } = await import("../src/features/chart-analysis.js");
      for (const beatmapId of [211, 212, 213, 214]) {
        await storeCachedBeatmapFile(db, beatmapId, buildStreamBeatmapFile(), { source: "test" });
        await exec(
          db,
          `insert into beatmap_chart_analysis (beatmap_id, analysis_version, status, classification_json, updated_at)
           values (?, ?, 'ready', ?, ?)`,
          [beatmapId, CHART_ANALYSIS_VERSION, JSON.stringify({ lnRatio: 0, patterns: [], rc: { rawDan: 8.0 } }), new Date().toISOString()],
        );
      }

      // 940 max / 60 ok is exactly 96.00% stable, the 4K rice courses' bar.
      // This is the anchor regression for the accuracy credit curve too: the
      // bar is its zero point, so a bare pass credits exactly the chart's dan.
      const scores = [211, 212, 213, 214].map((beatmapId, index) =>
        play({ id: index + 1, beatmap_id: beatmapId, accuracy: 0.96, statistics: { perfect: 940, ok: 60 } }));
      const dan = (await computePlayerSkillRatings(db, failingOsu, scores, [])).summary.modes[0].dan!;
      expect(dan.rc?.rawDan).toBe(8);
      expect(dan.rc?.clears).toBe(4);
    });
  });

  it("carries the stored verdict label onto the clear instead of re-banding rawDan", async () => {
    await withDb(async (db) => {
      const { CHART_ANALYSIS_VERSION } = await import("../src/features/chart-analysis.js");
      // The Odoru case: LeoBlack names the tier ("alpha mid/high" -> alpha+)
      // and the numeric hint sets rawDan independently, so 11.29 wears alpha+
      // in the stored verdict while parseDan's credit bands would print
      // alpha++. The clear must keep the verdict's own words.
      await storeCachedBeatmapFile(db, 271, buildStreamBeatmapFile(), { source: "test" });
      await exec(
        db,
        `insert into beatmap_chart_analysis (beatmap_id, analysis_version, status, classification_json, updated_at)
         values (?, ?, 'ready', ?, ?)`,
        [271, CHART_ANALYSIS_VERSION, JSON.stringify({ lnRatio: 0, patterns: [], rc: { rawDan: 11.29, displayName: "alpha+" } }), new Date().toISOString()],
      );
      const { collectDanClearsForTest, loadChartSkillInfo } = await import("../src/features/player-skills.js");
      const info = await loadChartSkillInfo(db, [271]);
      expect(info.get(271)?.rcDanLabel).toBe("alpha+");
      const clears = collectDanClearsForTest(4, [{
        identity: "official:271",
        beatmapId: 271,
        keyCount: 4,
        rate: 1,
        goal: 0.95,
        pp: 100,
        values: { Overall: 26 },
        patterns: [],
        accuracy: 0.961,
        stableAccuracy: 0.961,
      }], info);
      expect(clears).toHaveLength(1);
      expect(clears[0].chartDanLabel).toBe("alpha+");
      // A hair over the bar is a bare clear: same number, so the evidence
      // surface will print the same words for chart and credit.
      expect(clears[0].creditedDan).toBe(clears[0].chartDan);
    });
  });

  it("does not credit a structurally dan-ineligible chart", async () => {
    await withDb(async (db) => {
      const { CHART_ANALYSIS_VERSION } = await import("../src/features/chart-analysis.js");
      await exec(
        db,
        `insert into beatmap_chart_analysis (beatmap_id, analysis_version, status, classification_json, updated_at)
         values (?, ?, 'ready', ?, ?)`,
        [
          215,
          CHART_ANALYSIS_VERSION,
          JSON.stringify({
            lnRatio: 0,
            patterns: [],
            rc: { rawDan: 14.5 },
            danEligibility: {
              eligible: false,
              reason: "stacked_same_column_heads",
              maxSameColumnHeadStack: 190,
              redundantSameColumnHeads: 189,
            },
          }),
          new Date().toISOString(),
        ],
      );
      const { collectDanClearsForTest, loadChartSkillInfo } = await import("../src/features/player-skills.js");
      const info = await loadChartSkillInfo(db, [215]);
      const eligibleLookingPlay = {
        identity: "official:215",
        beatmapId: 215,
        keyCount: 7,
        rate: 1,
        goal: 0.99,
        pp: 100,
        values: { Overall: 30 },
        patterns: [],
        accuracy: 0.999,
        stableAccuracy: 0.999,
      };

      expect(info.get(215)?.danEligible).toBe(false);
      expect(collectDanClearsForTest(7, [eligibleLookingPlay], info)).toEqual([]);
    });
  });

  it("credits no dan on a chart below the OD floor", async () => {
    await withDb(async (db) => {
      const { CHART_ANALYSIS_VERSION } = await import("../src/features/chart-analysis.js");
      const insertBeatmap = "insert into beatmaps (beatmap_id, beatmapset_id, mode, version, metadata_json, updated_at) values (?, ?, 'mania', 'x', ?, ?)";
      const now = new Date().toISOString();
      await exec(db, insertBeatmap, [281, 1, JSON.stringify({ accuracy: 5.4 }), now]);
      await exec(db, insertBeatmap, [282, 1, JSON.stringify({ accuracy: 5.5 }), now]);
      for (const beatmapId of [281, 282]) {
        await exec(
          db,
          `insert into beatmap_chart_analysis (beatmap_id, analysis_version, status, classification_json, updated_at)
           values (?, ?, 'ready', ?, ?)`,
          [beatmapId, CHART_ANALYSIS_VERSION, JSON.stringify({ lnRatio: 0, patterns: [], rc: { rawDan: 11 } }), now],
        );
      }
      const { collectDanClearsForTest, loadChartSkillInfo } = await import("../src/features/player-skills.js");
      const info = await loadChartSkillInfo(db, [281, 282]);
      expect(info.get(281)?.od).toBe(5.4);
      expect(info.get(282)?.od).toBe(5.5);
      const playOn = (beatmapId: number) => ({
        identity: `official:${beatmapId}`,
        beatmapId,
        keyCount: 4,
        rate: 1,
        goal: 0.95,
        pp: 100,
        values: { Overall: 26 },
        patterns: [],
        accuracy: 0.97,
        stableAccuracy: 0.97,
      });
      // The floor value itself still credits; below it the clear is out
      // while the chart's own verdict stays visible, like danEligible.
      expect(collectDanClearsForTest(4, [playOn(281)], info)).toEqual([]);
      expect(collectDanClearsForTest(4, [playOn(282)], info)).toHaveLength(1);

      // An EZ play earned its accuracy on 1.4x windows (both clients), so it
      // credits no dan; without EZ the same play stays eligible.
      expect(collectDanClearsForTest(4, [{ ...playOn(282), ezWindows: true }], info)).toEqual([]);
      expect(collectDanClearsForTest(4, [{ ...playOn(282), ezWindows: false }], info)).toHaveLength(1);
    });
  });

  it("credits a near-miss a decayed level, and a high-accuracy pass a bonus, from the same curve", async () => {
    await withDb(async (db) => {
      const { CHART_ANALYSIS_VERSION } = await import("../src/features/chart-analysis.js");
      for (const beatmapId of [261, 262, 263, 264]) {
        await storeCachedBeatmapFile(db, beatmapId, buildStreamBeatmapFile(), { source: "test" });
        await exec(
          db,
          `insert into beatmap_chart_analysis (beatmap_id, analysis_version, status, classification_json, updated_at)
           values (?, ?, 'ready', ?, ?)`,
          [beatmapId, CHART_ANALYSIS_VERSION, JSON.stringify({ lnRatio: 0, patterns: [], rc: { rawDan: 15.15 } }), new Date().toISOString()],
        );
      }
      const { collectDanClearsForTest, danSideFromClearsForTest, loadChartSkillInfo } = await import("../src/features/player-skills.js");
      const info = await loadChartSkillInfo(db, [261, 262, 263, 264]);
      const stablePlay = (beatmapId: number, accuracy: number) => ({
        identity: `official:${beatmapId}:${accuracy}`, beatmapId, keyCount: 4, rate: 1, goal: 0.95, pp: 100,
        values: { Overall: 20 }, patterns: [], accuracy, stableAccuracy: accuracy,
      });
      // The motivating cases: a 92% on an epsilon+ chart weighs a level and a
      // quarter down (plain delta, never delta+), a 99.5% weighs +1.1 up, and
      // 91.9% is off the window.
      const spread = collectDanClearsForTest(
        4,
        [stablePlay(261, 0.92), stablePlay(262, 0.995), stablePlay(263, 0.919)],
        info,
      );
      expect(spread.map((clear) => clear.play.beatmapId)).toEqual([261, 262]);
      expect(spread[0].creditedDan).toBeCloseTo(13.9, 6);
      expect(spread[0].chartDan).toBeCloseTo(15.15, 9);
      expect(spread[1].creditedDan).toBeCloseTo(16.25, 6);

      // Four sub-bar credits alone still meet the quorum and rate the side:
      // the decay already priced the misses, so they are clears, just cheaper.
      const scrapes = [261, 262, 263, 264].map((id) => stablePlay(id, 0.92));
      const side = danSideFromClearsForTest(4, "rc", scrapes, info)!;
      expect(side.rawDan).toBe(13.9);
    });
  });

  it("holds a stable submission with no stored ScoreV2 accuracy to the converted 4K LN bar", async () => {
    await withDb(async (db) => {
      const { CHART_ANALYSIS_VERSION } = await import("../src/features/chart-analysis.js");
      for (const beatmapId of [221, 222, 223, 224]) {
        await storeCachedBeatmapFile(db, beatmapId, buildStreamBeatmapFile(), { source: "test" });
        await exec(
          db,
          `insert into beatmap_chart_analysis (beatmap_id, analysis_version, status, classification_json, updated_at)
           values (?, ?, 'ready', ?, ?)`,
          [beatmapId, CHART_ANALYSIS_VERSION, JSON.stringify({ lnRatio: 0.8, patterns: [], ln: { rawDan: 7.0 } }), new Date().toISOString()],
        );
      }
      const { collectDanClearsForTest } = await import("../src/features/player-skills.js");
      const infoByBeatmap = await (await import("../src/features/player-skills.js")).loadChartSkillInfo(db, [221, 222, 223, 224]);
      // A stable submission displays the 300-weighted accuracy, so displayed
      // and stableAccuracy match and the play carries no ScoreV2 reading.
      const stablePlay = (beatmapId: number, accuracy: number) => ({
        identity: `official:${beatmapId}`, beatmapId, keyCount: 4, rate: 1, goal: 0.95, pp: 100,
        values: { Overall: 20 }, patterns: [], accuracy, stableAccuracy: accuracy,
      });
      // 97.2% stable converts to below the 97.5% stable-equivalent bar, so it
      // credits a decayed level: three tenths of a point under the converted
      // bar puts a 7.0 chart at 6.34. This also documents the
      // converted floor arithmetic: the credit window rides the converted bar,
      // so it ends at 95%, not 94.5%.
      const below = collectDanClearsForTest(4, [221, 222, 223, 224].map((id) => stablePlay(id, 0.972)), infoByBeatmap);
      expect(below.length).toBe(4);
      expect(below.every((clear) => clear.side === "ln" && clear.chartDan === 7)).toBe(true);
      for (const clear of below) expect(clear.creditedDan).toBeCloseTo(6.34, 9);
      const under = collectDanClearsForTest(4, [221, 222, 223, 224].map((id) => stablePlay(id, 0.949)), infoByBeatmap);
      expect(under.length).toBe(0);
      const above = collectDanClearsForTest(4, [221, 222, 223, 224].map((id) => stablePlay(id, 0.976)), infoByBeatmap);
      expect(above.length).toBe(4);
      expect(above.every((clear) => clear.side === "ln" && clear.chartDan === 7)).toBe(true);
      // 97.6% is over the converted bar but inside the flat zone, so it is a
      // bare clear of the chart's level: full credit, no bonus.
      for (const clear of above) expect(clear.creditedDan).toBeCloseTo(7, 9);
    });
  });

  it("lets a shared clear raise a second tile's dan but never open one on its own", async () => {
    await withDb(async (db) => {
      const { CHART_ANALYSIS_VERSION } = await import("../src/features/chart-analysis.js");
      const now = new Date().toISOString();
      // Four 4:13 jack marathons whose MSD argmax is Stamina: exactly the
      // shape that files jack AND stamina (resolveTilesForClear). Plus four short
      // stamina charts that file stamina outright.
      const charts: Array<[number, number, number, boolean]> = [
        [401, 12, 253, true], [402, 12, 253, true], [403, 12, 253, true], [404, 12, 253, true],
        [405, 6, 300, false], [406, 6, 300, false], [407, 6, 300, false], [408, 6, 300, false],
      ];
      for (const [beatmapId, rawDan, length, jackDemand] of charts) {
        await storeCachedBeatmapFile(db, beatmapId, buildStreamBeatmapFile(), { source: "test" });
        await exec(
          db,
          "insert into beatmaps (beatmap_id, beatmapset_id, mode, version, metadata_json, updated_at) values (?, ?, 'mania', 'x', ?, ?)",
          [beatmapId, 900, JSON.stringify({ total_length: length }), now],
        );
        await exec(
          db,
          `insert into beatmap_chart_analysis (beatmap_id, analysis_version, status, key_count, classification_json, updated_at)
           values (?, ?, 'ready', 4, ?, ?)`,
          [beatmapId, CHART_ANALYSIS_VERSION, JSON.stringify({
            lnRatio: 0, patterns: [], clusters: [], rc: { rawDan },
            ...(jackDemand ? { jackDemand: { detected: true } } : {}),
          }), now],
        );
      }
      const { danSideFromClearsForTest, loadChartSkillInfo, danSkillsetBucketsForValues } = await import("../src/features/player-skills.js");
      const info = await loadChartSkillInfo(db, charts.map(([beatmapId]) => beatmapId));
      const values = (top: string, rating: number) => ({ Overall: rating, Stream: 1, [top]: rating });
      const clearPlay = (beatmapId: number, top: string) => ({
        identity: `official:${beatmapId}`, beatmapId, keyCount: 4, rate: 1, goal: 0.95, pp: 100,
        values: values(top, 25), patterns: [], accuracy: 0.96, stableAccuracy: 0.96,
      });
      const marathons = [401, 402, 403, 404].map((id) => clearPlay(id, "Stamina"));
      const stamina = [405, 406, 407, 408].map((id) => clearPlay(id, "Stamina"));

      // The marathons really do carry both tiles.
      expect(danSkillsetBucketsForValues(4, "rc", values("Stamina", 25), 253, 1, info.get(401)))
        .toEqual(["jack", "stamina"]);

      // Four of them alone rate jack, their primary tile, and nothing else:
      // one body of work cannot light up two skills.
      const jackOnly = danSideFromClearsForTest(4, "rc", marathons, info)!;
      expect(Object.keys(jackOnly.skillsets ?? {})).toEqual(["jack"]);
      // And the window counts each clear once rather than twice.
      expect(jackOnly.clearWindow?.have).toBe(4);

      // Add four real stamina clears and the stamina tile opens on its own
      // primaries - then the marathons DO pull its dan up, from 6 to 9.
      const both = danSideFromClearsForTest(4, "rc", [...marathons, ...stamina], info)!;
      expect(Object.keys(both.skillsets ?? {}).sort()).toEqual(["jack", "stamina"]);
      expect(both.skillsets?.jack?.rawDan).toBe(12);
      expect(both.skillsets?.stamina?.rawDan).toBe(9);
      expect(both.clearWindow?.have).toBe(8);
    });
  });

  it("does not call a shared clear globally ignored when one of its tiles still counts it", async () => {
    await withDb(async (db) => {
      const { CHART_ANALYSIS_VERSION } = await import("../src/features/chart-analysis.js");
      const now = new Date().toISOString();
      const charts: Array<{ id: number; rawDan: number; length: number; jackDemand: boolean; top: "JackSpeed" | "Stamina" }> = [
        // Five strong jack-only clears establish the jack tile's reference.
        ...[501, 502, 503, 504, 505].map((id) => ({ id, rawDan: 12, length: 120, jackDemand: true, top: "JackSpeed" as const })),
        // This low marathon is shared. It is a stray beside the jack clears,
        // but ordinary evidence beside the stamina clears below.
        { id: 506, rawDan: 5, length: 253, jackDemand: true, top: "Stamina" },
        ...[507, 508, 509, 510].map((id) => ({ id, rawDan: 5, length: 300, jackDemand: false, top: "Stamina" as const })),
      ];
      for (const chart of charts) {
        await exec(
          db,
          "insert into beatmaps (beatmap_id, beatmapset_id, mode, version, metadata_json, updated_at) values (?, ?, 'mania', 'x', ?, ?)",
          [chart.id, 901, JSON.stringify({ total_length: chart.length }), now],
        );
        await exec(
          db,
          `insert into beatmap_chart_analysis (beatmap_id, analysis_version, status, key_count, classification_json, updated_at)
           values (?, ?, 'ready', 4, ?, ?)`,
          [chart.id, CHART_ANALYSIS_VERSION, JSON.stringify({
            lnRatio: 0,
            patterns: [],
            clusters: [],
            rc: { rawDan: chart.rawDan },
            ...(chart.jackDemand ? { jackDemand: { detected: true } } : {}),
          }), now],
        );
      }
      const plays = charts.map((chart) => ({
        identity: `official:${chart.id}`,
        beatmapId: chart.id,
        keyCount: 4,
        rate: 1,
        goal: 0.95,
        pp: 100,
        values: { Overall: 25, Stream: 1, [chart.top]: 25 },
        patterns: [],
        accuracy: 0.96,
        stableAccuracy: 0.96,
      }));
      await exec(
        db,
        `insert into player_skill_ratings
         (user_id, analysis_version, status, modes_json, plays_json, computed_at, updated_at)
         values (99, ?, 'ready', '{}', ?, ?, ?)`,
        [PLAYER_SKILLS_VERSION, JSON.stringify({ plays }), now, now],
      );

      const evidence = await getPlayerSkillDanEvidence(db, 99, 4, "rc");
      const allClear = evidence?.clears.find((clear) => clear.play.beatmapId === 506);
      const jackClear = evidence?.skillsets.find((skillset) => skillset.id === "jack")
        ?.plays.find((clear) => clear.play.beatmapId === 506);
      const staminaClear = evidence?.skillsets.find((skillset) => skillset.id === "stamina")
        ?.plays.find((clear) => clear.play.beatmapId === 506);
      expect(jackClear?.ignoredAsStray).toBe(true);
      expect(staminaClear?.ignoredAsStray).not.toBe(true);
      expect(allClear?.ignoredAsStray).not.toBe(true);
    });
  });

  it("averages the skillset dans into the side estimate instead of taking the best clears", async () => {
    await withDb(async (db) => {
      const { CHART_ANALYSIS_VERSION } = await import("../src/features/chart-analysis.js");
      // Four 12th-dan jack charts and four 6th-dan stamina ones. Sorted by
      // chart dan the side reads 12/12/12/12/6/6/6/6, so the old quorum-th
      // rule would call this player 12th dan off jack alone.
      const charts: Array<[number, number]> = [
        [301, 12], [302, 12], [303, 12], [304, 12],
        [305, 6], [306, 6], [307, 6], [308, 6],
      ];
      for (const [beatmapId, rawDan] of charts) {
        await storeCachedBeatmapFile(db, beatmapId, buildStreamBeatmapFile(), { source: "test" });
        await exec(
          db,
          `insert into beatmap_chart_analysis (beatmap_id, analysis_version, status, classification_json, updated_at)
           values (?, ?, 'ready', ?, ?)`,
          [beatmapId, CHART_ANALYSIS_VERSION, JSON.stringify({ lnRatio: 0, patterns: [], rc: { rawDan } }), new Date().toISOString()],
        );
      }
      const { danSideFromClearsForTest, loadChartSkillInfo } = await import("../src/features/player-skills.js");
      const info = await loadChartSkillInfo(db, charts.map(([beatmapId]) => beatmapId));
      // 4K buckets are an MSD argmax, so the vector picks the bucket. Stream
      // is held well clear of the winner so the near-tie rule cannot claim it.
      const values = (top: string, rating: number) => ({ Overall: rating, Stream: 1, [top]: rating });
      const clearPlay = (beatmapId: number, top: string) => ({
        identity: `official:${beatmapId}`, beatmapId, keyCount: 4, rate: 1, goal: 0.95, pp: 100,
        values: values(top, 25), patterns: [], accuracy: 0.96, stableAccuracy: 0.96,
      });
      const jackPlays = [301, 302, 303, 304].map((id) => clearPlay(id, "Chordjack"));
      const staminaPlays = [305, 306, 307, 308].map((id) => clearPlay(id, "Stamina"));

      const side = danSideFromClearsForTest(4, "rc", [...jackPlays, ...staminaPlays], info)!;
      expect(side.skillsets?.jack?.rawDan).toBe(12);
      expect(side.skillsets?.stamina?.rawDan).toBe(6);
      // The mean of the two rated skillsets, not the 4th best clear (12).
      expect(side.rawDan).toBe(9);
      // Only the four jack clears reach the estimate.
      expect(side.clears).toBe(4);
      // Every published skillset wants a window of its own, so four clears in
      // two of the four buckets leave the side 8 of 80 filled in. That is what
      // the badge's ring reads: this estimate is still thin, whatever it says.
      expect(side.clearWindow).toEqual({ have: 8, need: 80, skills: { full: 0, total: 4 } });
      expect(side.skillsets?.jack?.clearWindow).toEqual({ have: 4, need: 20 });

      // One rated skillset is not an average, so the side keeps the quorum-th
      // clear: this is the thin-evidence player, not a measured specialist.
      const jackOnly = danSideFromClearsForTest(4, "rc", jackPlays, info)!;
      expect(Object.keys(jackOnly.skillsets ?? {})).toEqual(["jack"]);
      expect(jackOnly.rawDan).toBe(12);
    });
  });

  it("floors the side estimate at a verified dan course clear without touching the skillsets", async () => {
    await withDb(async (db) => {
      const { CHART_ANALYSIS_VERSION } = await import("../src/features/chart-analysis.js");
      // Jack 12 / stamina 6 again: the averaged headline is 9, well under the
      // epsilon (15) course this player has actually cleared.
      const charts: Array<[number, number]> = [
        [301, 12], [302, 12], [303, 12], [304, 12],
        [305, 6], [306, 6], [307, 6], [308, 6],
      ];
      for (const [beatmapId, rawDan] of charts) {
        await storeCachedBeatmapFile(db, beatmapId, buildStreamBeatmapFile(), { source: "test" });
        await exec(
          db,
          `insert into beatmap_chart_analysis (beatmap_id, analysis_version, status, classification_json, updated_at)
           values (?, ?, 'ready', ?, ?)`,
          [beatmapId, CHART_ANALYSIS_VERSION, JSON.stringify({ lnRatio: 0, patterns: [], rc: { rawDan } }), new Date().toISOString()],
        );
      }
      const { danSideFromClearsForTest, loadChartSkillInfo, danClearBarFor } = await import("../src/features/player-skills.js");
      const { creditDanCoursePassesForTest } = await import("../src/features/dan-courses.js");
      const info = await loadChartSkillInfo(db, charts.map(([beatmapId]) => beatmapId));
      const values = (top: string, rating: number) => ({ Overall: rating, Stream: 1, [top]: rating });
      const clearPlay = (beatmapId: number, top: string) => ({
        identity: `official:${beatmapId}`, beatmapId, keyCount: 4, rate: 1, goal: 0.95, pp: 100,
        values: values(top, 25), patterns: [], accuracy: 0.96, stableAccuracy: 0.96,
      });
      const plays = [
        ...[301, 302, 303, 304].map((id) => clearPlay(id, "Chordjack")),
        ...[305, 306, 307, 308].map((id) => clearPlay(id, "Stamina")),
      ];
      const options = { barFor: danClearBarFor, stableEquivalentV2BarOffset: 0.005 };
      // Dan ~ REFORM ~ EXTRA-EPSILON, a bare pass at the 96% bar.
      const epsilon = creditDanCoursePassesForTest(
        [{ beatmapId: 2259547, mods: [], displayed: 0.961, stable: 0.961 }],
        options,
      );

      const plain = danSideFromClearsForTest(4, "rc", plays, info)!;
      expect(plain.rawDan).toBe(9);
      expect(plain.courseClear).toBeUndefined();
      expect(plain.clearWindow).toEqual({ have: 8, need: 80, skills: { full: 0, total: 4 } });

      const floored = danSideFromClearsForTest(4, "rc", plays, info, epsilon)!;
      expect(floored.label).toBe("epsilon");
      expect(floored.courseClear?.beatmapId).toBe(2259547);
      expect(floored.courseClear?.level).toBe("epsilon");
      // The override is a headline rule; the skill rows still measure the mix.
      expect(floored.skillsets).toEqual(plain.skillsets);
      // A pass is not an average, so a floored headline has no window to fill
      // and the badge marks nothing.
      expect(floored.clearWindow).toBeUndefined();

      // A course under the averaged estimate changes nothing: a clear is a
      // floor, never a ceiling.
      const gamma = creditDanCoursePassesForTest(
        [{ beatmapId: 2259503, mods: [], displayed: 0.99, stable: 0.99 }],
        options,
      );
      expect(danSideFromClearsForTest(4, "rc", plays, info, gamma)).toEqual(plain);
    });
  });

  it("rates a side that has no quorum at all from a course clear alone", async () => {
    const { danSideFromClearsForTest, danClearBarFor } = await import("../src/features/player-skills.js");
    const { creditDanCoursePassesForTest } = await import("../src/features/dan-courses.js");
    const clears = creditDanCoursePassesForTest(
      [{ beatmapId: 2259546, mods: [], displayed: 0.961, stable: 0.961 }],
      { barFor: danClearBarFor, stableEquivalentV2BarOffset: 0.005 },
    );
    // No rated plays: the ordinary rule has nothing to say, and the course
    // clear is the only evidence there is.
    expect(danSideFromClearsForTest(4, "rc", [], new Map())).toBeNull();
    const side = danSideFromClearsForTest(4, "rc", [], new Map(), clears)!;
    expect(side.label).toBe("delta");
    expect(side.skillsets).toBeUndefined();
    expect(side.courseClear?.courseName).toContain("EXTRA-DELTA");
  });

  it("keeps the side-wide best-clears average on a side whose keymode publishes no skillsets", async () => {
    await withDb(async (db) => {
      const { CHART_ANALYSIS_VERSION } = await import("../src/features/chart-analysis.js");
      for (const [beatmapId, lnRawDan] of [[311, 9.0], [312, 8.0], [313, 7.0], [314, 6.0]] as const) {
        await storeCachedBeatmapFile(db, beatmapId, buildStreamBeatmapFile(), { source: "test" });
        await exec(
          db,
          `insert into beatmap_chart_analysis (beatmap_id, analysis_version, status, classification_json, updated_at)
           values (?, ?, 'ready', ?, ?)`,
          [beatmapId, CHART_ANALYSIS_VERSION, JSON.stringify({ lnRatio: 0.8, patterns: [], ln: { rawDan: lnRawDan } }), new Date().toISOString()],
        );
      }
      const { danSideFromClearsForTest, loadChartSkillInfo } = await import("../src/features/player-skills.js");
      const info = await loadChartSkillInfo(db, [311, 312, 313, 314]);
      const lnPlay = (beatmapId: number) => ({
        identity: `official:${beatmapId}`, beatmapId, keyCount: 4, rate: 1, goal: 0.95, pp: 100,
        values: { Overall: 20, Stamina: 20, Stream: 1 }, patterns: [], accuracy: 0.97, stableAccuracy: 0.9723, scoreV2Accuracy: 0.97,
      });
      // 4K LN publishes no buckets at all, so the headline is the side-wide
      // average of the best clears: (9 + 8 + 7 + 6) / 4.
      const side = danSideFromClearsForTest(4, "ln", [311, 312, 313, 314].map(lnPlay), info)!;
      expect(side.skillsets).toBeUndefined();
      expect(side.rawDan).toBe(7.5);
      // One pool rather than four, so the window is the side's own.
      expect(side.clearWindow).toEqual({ have: 4, need: 20 });
    });
  });

  it("credits an HT clear the chart's 0.75x dan, not its 1.0x one", async () => {
    await withDb(async (db) => {
      const { CHART_ANALYSIS_VERSION } = await import("../src/features/chart-analysis.js");
      for (const beatmapId of [231, 232, 233, 234]) {
        await storeCachedBeatmapFile(db, beatmapId, buildStreamBeatmapFile(), { source: "test" });
        await exec(
          db,
          `insert into beatmap_chart_analysis (beatmap_id, analysis_version, status, classification_json, dan_ht_json, updated_at)
           values (?, ?, 'ready', ?, ?, ?)`,
          [
            beatmapId,
            CHART_ANALYSIS_VERSION,
            JSON.stringify({ lnRatio: 0, patterns: [], rc: { rawDan: 12.0 } }),
            JSON.stringify({ rawDan: 8.0, primaryFamily: "dan" }),
            new Date().toISOString(),
          ],
        );
      }
      const { collectDanClearsForTest, loadChartSkillInfo } = await import("../src/features/player-skills.js");
      const info = await loadChartSkillInfo(db, [231, 232, 233, 234]);
      const htPlay = (beatmapId: number) => ({
        identity: `official:${beatmapId}`, beatmapId, keyCount: 4, rate: 0.75, goal: 0.95, pp: 100,
        values: { Overall: 20 }, patterns: [], accuracy: 0.98, stableAccuracy: 0.98,
      });
      const clears = collectDanClearsForTest(4, [231, 232, 233, 234].map(htPlay), info);
      expect(clears.length).toBe(4);
      // 8.0 (the 0.75x verdict), never the chart's own 12.0; the accuracy
      // credit rides on the rate verdict too (98% stable is +0.117647).
      expect(clears.every((clear) => clear.chartDan === 8 && clear.side === "rc")).toBe(true);
      for (const clear of clears) expect(clear.creditedDan).toBeCloseTo(8.117647, 6);

      // A rate with no stored verdict still contributes nothing.
      const oddRate = collectDanClearsForTest(4, [231, 232, 233, 234].map((id) => ({ ...htPlay(id), rate: 1.2 })), info);
      expect(oddRate.length).toBe(0);
    });
  });

  it("credits a custom-rate clear the dan_estimates verdict at that rate", async () => {
    await withDb(async (db) => {
      const { CHART_ANALYSIS_VERSION } = await import("../src/features/chart-analysis.js");
      const { DAN_ESTIMATE_CACHE_VERSION } = await import("../src/dan/dan-estimator/cache-version.js");
      const { loadStoredRateDanVerdicts, rateDanVerdictKey } = await import("../src/features/dan-estimates.js");
      const now = new Date().toISOString();
      for (const beatmapId of [241, 242, 243, 244]) {
        await exec(
          db,
          `insert into beatmap_chart_analysis (beatmap_id, analysis_version, status, classification_json, updated_at)
           values (?, ?, 'ready', ?, ?)`,
          [beatmapId, CHART_ANALYSIS_VERSION, JSON.stringify({ lnRatio: 0, patterns: [], rc: { rawDan: 12.0 } }), now],
        );
      }
      const storeVerdict = (beatmapId: number, ratePercent: number, status: string, rawDan: number | null, family: string | null) => exec(
        db,
        `insert into dan_estimates (
           estimator_version, beatmap_id, rate_percent, status, label, display_name, raw_dan, family, confidence, computed_at, updated_at
         ) values (?, ?, ?, ?, 'x', 'x', ?, ?, 0.9, ?, ?)`,
        [DAN_ESTIMATE_CACHE_VERSION, beatmapId, ratePercent, status, rawDan, family, now, now],
      );
      await storeVerdict(241, 120, "ready", 9.5, "dan");
      await storeVerdict(242, 120, "ready", 9.5, "ln");
      await storeVerdict(243, 120, "unavailable", null, null);
      // 244 has no row at all. 241 also holds a 1.5x verdict, standing in for
      // a chart the DT sweep never covered (no dan_dt_json column).
      await storeVerdict(241, 150, "ready", 13.2, "dan");

      const stored = await loadStoredRateDanVerdicts(db, [
        { beatmapId: 241, ratePercent: 120 },
        { beatmapId: 242, ratePercent: 120 },
        { beatmapId: 243, ratePercent: 120 },
        { beatmapId: 244, ratePercent: 120 },
        { beatmapId: 241, ratePercent: 150 },
      ]);
      expect(stored.get(rateDanVerdictKey(241, 120))).toEqual({ rawDan: 9.5, family: "dan", displayName: "x" });
      expect(stored.get(rateDanVerdictKey(243, 120))).toBeNull();
      expect(stored.has(rateDanVerdictKey(244, 120))).toBe(false);

      const { collectDanClearsForTest, loadChartSkillInfo } = await import("../src/features/player-skills.js");
      const info = await loadChartSkillInfo(db, [241, 242, 243, 244]);
      const verdicts = new Map(
        [...stored].map(([key, verdict]) => [
          key,
          verdict ? { rawDan: verdict.rawDan, side: verdict.family === "ln" ? "ln" as const : "rc" as const } : null,
        ]),
      );
      const ratePlay = (beatmapId: number, rate: number) => ({
        identity: `official:${beatmapId}:${rate}`, beatmapId, keyCount: 4, rate, goal: 0.95, pp: 100,
        values: { Overall: 20 }, patterns: [], accuracy: 0.98, stableAccuracy: 0.98,
      });
      const clears = collectDanClearsForTest(4, [241, 242, 243, 244].map((id) => ratePlay(id, 1.2)), info, verdicts);
      // 9.5 at the played rate, never the chart's own 12.0; the terminal row
      // and the missing row contribute nothing; the ln-family verdict lands on
      // the ln side.
      expect(clears.map((clear) => [clear.play.beatmapId, clear.chartDan, clear.side])).toEqual([
        [241, 9.5, "rc"],
        [242, 9.5, "ln"],
      ]);
      // The accuracy credit applies to rate verdicts on the same terms: 98%
      // stable is +0.117647 over the rc bar, while the ln clear is judged on
      // the converted v2 bar (97.5%) against the window and sits inside the
      // flat zone, so it credits the bare level.
      expect(clears[0].creditedDan).toBeCloseTo(9.617647, 6);
      expect(clears[1].creditedDan).toBeCloseTo(9.5, 6);

      // A 1.5x play on a chart with no dan_dt_json falls back to the stored
      // 150 verdict instead of contributing nothing.
      const dtClears = collectDanClearsForTest(4, [ratePlay(241, 1.5)], info, verdicts);
      expect(dtClears.map((clear) => [clear.play.beatmapId, clear.chartDan, clear.side])).toEqual([[241, 13.2, "rc"]]);
    });
  });

  it("computes and stores a missing rate verdict during the skill compute, then credits it", async () => {
    await withDb(async (db) => {
      const { CHART_ANALYSIS_VERSION } = await import("../src/features/chart-analysis.js");
      const { DAN_ESTIMATE_CACHE_VERSION } = await import("../src/dan/dan-estimator/cache-version.js");
      const now = new Date().toISOString();
      const beatmapIds = [251, 252, 253, 254];
      for (const beatmapId of beatmapIds) {
        await storeCachedBeatmapFile(db, beatmapId, buildStreamBeatmapFile(), { source: "test" });
        await exec(
          db,
          `insert into beatmap_chart_analysis (beatmap_id, analysis_version, status, classification_json, updated_at)
           values (?, ?, 'ready', ?, ?)`,
          [beatmapId, CHART_ANALYSIS_VERSION, JSON.stringify({ lnRatio: 0, patterns: [], rc: { rawDan: 3 } }), now],
        );
      }
      const trackedScores = beatmapIds.map((beatmapId, index) => play({
        id: 9100 + index,
        beatmap_id: beatmapId,
        pp: undefined,
        mods: [{ acronym: "DT", settings: { speed_change: 1.2 } }],
        accuracy: 0.976,
        statistics: { perfect: 400, great: 250, good: 50 },
      }));
      const result = await computePlayerSkillRatings(db, failingOsu, [], [], { trackedScores });
      expect(result.plays.map((entry) => entry.rate)).toEqual([1.2, 1.2, 1.2, 1.2]);

      const rows = (await exec(
        db,
        "select beatmap_id, rate_percent, status, raw_dan from dan_estimates where estimator_version = ? order by beatmap_id",
        [DAN_ESTIMATE_CACHE_VERSION],
      )).rows;
      expect(rows.map((row) => [Number(row.beatmap_id), Number(row.rate_percent), String(row.status)])).toEqual(
        beatmapIds.map((beatmapId) => [beatmapId, 120, "ready"]),
      );
      expect(rows.every((row) => Number(row.raw_dan) > 0)).toBe(true);

      // The dan block written by this same pass already credits the four
      // clears the verdicts unlocked.
      const mode = result.summary.modes.find((entry) => entry.keyCount === 4)!;
      expect(mode.dan?.rc?.rawDan).toBeGreaterThan(0);
    });
  });

  it("rates tracked plays alongside top plays, deduped to the best per chart and rate", async () => {
    await withDb(async (db) => {
      await storeCachedBeatmapFile(db, 101, buildStreamBeatmapFile(), { source: "test" });
      await storeCachedBeatmapFile(db, 106, buildStreamBeatmapFile(), { source: "test" });

      const topScores = [play({ id: 1, beatmap_id: 101, accuracy: 0.99 })];
      // Tracked plays carry no pp; retries on the top-play chart collapse
      // into its slot, the new chart gets rated on its own.
      const trackedScores = [
        play({ id: 2, beatmap_id: 101, accuracy: 0.9, pp: null }),
        play({ id: 3, beatmap_id: 106, accuracy: 0.95, pp: null }),
        play({ id: 4, beatmap_id: 106, accuracy: 0.9, pp: null }),
      ];
      const result = await computePlayerSkillRatings(db, failingOsu, topScores, [], { trackedScores });
      expect(result.summary.analyzedPlays).toBe(2);
      const byBeatmap = new Map(result.plays.map((entry) => [entry.beatmapId, entry]));
      expect(byBeatmap.get(101)?.source).toBe("top");
      expect(byBeatmap.get(101)?.goal).toBe(0.965);
      expect(byBeatmap.get(106)?.source).toBe("tracked");
      expect(byBeatmap.get(106)?.goal).toBe(0.95);
    });
  });

  it("skips vibro charts for tracked plays but trusts pp-backed charts as misflags", async () => {
    await withDb(async (db) => {
      await storeCachedBeatmapFile(db, 101, buildStreamBeatmapFile(), { source: "test" });
      await storeCachedBeatmapFile(db, 106, buildStreamBeatmapFile(), { source: "test" });
      const { CHART_ANALYSIS_VERSION } = await import("../src/features/chart-analysis.js");
      for (const beatmapId of [101, 106]) {
        await exec(
          db,
          `insert into beatmap_chart_analysis (beatmap_id, analysis_version, status, classification_json, updated_at)
           values (?, ?, 'ready', ?, ?)`,
          [beatmapId, CHART_ANALYSIS_VERSION, JSON.stringify({ lnRatio: 0, vibro: true, patterns: [] }), new Date().toISOString()],
        );
      }
      // Chart 101 has a top play (pp-backed, so ranked - its vibro flag is a
      // misflag): both the top play and the tracked retry on it count. Chart
      // 106 is tracked-only, so its vibro flag stands and the play skips.
      const topScores = [play({ id: 1, beatmap_id: 101, accuracy: 0.9 })];
      const trackedScores = [
        play({ id: 2, beatmap_id: 101, accuracy: 0.99, pp: null }),
        play({ id: 3, beatmap_id: 106, accuracy: 0.99, pp: null }),
      ];
      const result = await computePlayerSkillRatings(db, failingOsu, topScores, [], { trackedScores });
      expect(result.summary.analyzedPlays).toBe(1);
      expect(result.summary.unsupportedPlays).toBe(0);
      expect(result.plays[0].beatmapId).toBe(101);
      expect(result.plays[0].source).toBe("tracked");

      // Retention: the top-sourced play keeps its pp-backed trust even after
      // dropping off the top-200, while the tracked-only chart stays out.
      const topSourced = { ...result.plays[0], source: "top" as const };
      const retained = await computePlayerSkillRatings(db, failingOsu, [], [topSourced], {});
      expect(retained.summary.analyzedPlays).toBe(1);
      const trackedSourced = { ...result.plays[0], beatmapId: 106, source: "tracked" as const };
      const dropped = await computePlayerSkillRatings(db, failingOsu, [], [trackedSourced], {});
      expect(dropped.summary.analyzedPlays).toBe(0);
    });
  });

  it("rates archived day-best evidence after the raw payload aged out", async () => {
    await withDb(async (db) => {
      await storeCachedBeatmapFile(db, 106, buildStreamBeatmapFile(), { source: "test" });
      await exec(
        db,
        `insert into beatmaps (beatmap_id, beatmapset_id, mode, version, updated_at) values (106, 60, 'mania', 'test diff', ?)`,
        [new Date().toISOString()],
      );
      // The durable trace of a pruned play: a day-best row plus a passed ref.
      // No score_events payload exists for it.
      await exec(
        db,
        `insert into player_activity_maps (country, user_id, day, beatmap_id, play_count, best_score_id, best_accuracy, best_rank, updated_at)
         values ('CR', 42, '2026-05-30', 106, 3, 991, 0.93, 'A', ?)`,
        [new Date().toISOString()],
      );
      await exec(
        db,
        `insert into player_activity_score_refs (country, score_identity, user_id, day, beatmap_id, passed, ended_at, created_at)
         values ('CR', 'official:991', 42, '2026-05-30', 106, 1, '2026-05-30T10:00:00Z', '2026-05-30T10:00:00Z')`,
      );

      // An enriched row (post best_mods_json/best_statistics_json): the rate
      // and the judgement counts survive archiving.
      await storeCachedBeatmapFile(db, 113, buildStreamBeatmapFile(), { source: "test" });
      await exec(
        db,
        `insert into beatmaps (beatmap_id, beatmapset_id, mode, version, updated_at) values (113, 60, 'mania', 'test diff dt', ?)`,
        [new Date().toISOString()],
      );
      await exec(
        db,
        `insert into player_activity_maps (country, user_id, day, beatmap_id, play_count, best_score_id, best_accuracy, best_rank, best_mods_json, best_statistics_json, updated_at)
         values ('CR', 42, '2026-05-31', 113, 1, 992, 0.97, 'S', ?, ?, ?)`,
        [JSON.stringify([{ acronym: "DT" }]), JSON.stringify({ perfect: 300, great: 80, miss: 4 }), new Date().toISOString()],
      );
      await exec(
        db,
        `insert into player_activity_score_refs (country, score_identity, user_id, day, beatmap_id, passed, ended_at, created_at)
         values ('CR', 'official:992', 42, '2026-05-31', 113, 1, '2026-05-31T10:00:00Z', '2026-05-31T10:00:00Z')`,
      );

      const archived = await loadArchivedTrackedEvidence(db, 42);
      // The mod-less legacy row cannot be rated at any honest rate (an HT/DC
      // original would inflate at an assumed 1.0x), so it yields no score -
      // only an untrusted identity.
      expect(archived.scores).toHaveLength(1);
      expect(archived.unknownModsIdentities).toEqual(new Set(["official:991"]));
      expect(archived.scores[0]?.beatmap_id).toBe(113);
      expect(archived.scores[0]?.mods).toEqual([{ acronym: "DT" }]);

      const result = await computePlayerSkillRatings(db, failingOsu, [], [], {
        trackedScores: archived.scores,
        untrustedIdentities: archived.unknownModsIdentities,
      });
      expect(result.summary.analyzedPlays).toBe(1);
      const plays = new Map(result.plays.map((entry) => [entry.beatmapId, entry]));
      expect(plays.has(106)).toBe(false);
      // Enriched row: real rate from the stored mods, miss share from the
      // stored judgement counts.
      expect(plays.get(113)?.rate).toBe(1.5);
      expect(plays.get(113)?.missShare).toBeCloseTo(4 / 384, 5);
      expect(result.summary.modes[0].dan?.rc ?? null).toBeNull();
    });
  });

  it("blends LN-chart SSRs toward the tail-aware calc pass", async () => {
    await withDb(async (db) => {
      const { CHART_ANALYSIS_VERSION } = await import("../src/features/chart-analysis.js");
      // Same chart twice: once as pure rice, once with every note a hold.
      // Identical heads mean the head-only calc rates them the same; the LN
      // copy must come out strictly higher once its lnRatio unlocks the
      // tail-aware blend. The rice copy's rating must not change at all.
      await storeCachedBeatmapFile(db, 301, buildStreamBeatmapFile(), { source: "test" });
      await storeCachedBeatmapFile(db, 302, buildLnBeatmapFile(), { source: "test" });
      for (const [beatmapId, lnRatio] of [[301, 0], [302, 1]] as const) {
        await exec(
          db,
          `insert into beatmap_chart_analysis (beatmap_id, analysis_version, status, classification_json, updated_at)
           values (?, ?, 'ready', ?, ?)`,
          [beatmapId, CHART_ANALYSIS_VERSION, JSON.stringify({ lnRatio, patterns: [] }), new Date().toISOString()],
        );
      }
      const scores = [
        play({ id: 11, beatmap_id: 301, accuracy: 0.95 }),
        play({ id: 12, beatmap_id: 302, accuracy: 0.95 }),
      ];
      const result = await computePlayerSkillRatings(db, failingOsu, scores, []);
      expect(result.summary.analyzedPlays).toBe(2);
      const byBeatmap = new Map(result.plays.map((entry) => [entry.beatmapId, entry]));
      const rice = byBeatmap.get(301);
      const ln = byBeatmap.get(302);
      expect(rice && ln).toBeTruthy();
      expect(ln!.values.Overall).toBeGreaterThan(rice!.values.Overall);

      // The rice play matches a no-analysis-row compute exactly (lnRatio 0
      // never triggers the second calc pass).
      const bare = await computePlayerSkillRatings(db, failingOsu, [play({ id: 13, beatmap_id: 301, accuracy: 0.95 })], []);
      expect(bare.plays[0].values.Overall).toBeCloseTo(rice!.values.Overall, 4);
    });
  });

  it("purges stored plays whose only evidence is a mod-less archived row", async () => {
    await withDb(async (db) => {
      await storeCachedBeatmapFile(db, 106, buildStreamBeatmapFile(), { source: "test" });
      const trackedScores = [play({ id: 991, beatmap_id: 106, accuracy: 0.93, pp: null })];
      const first = await computePlayerSkillRatings(db, failingOsu, [], [], { trackedScores });
      expect(first.summary.analyzedPlays).toBe(1);
      expect(first.plays[0].identity).toBe("official:991");

      // The raw payload ages out; the surviving archive row has no mods, so
      // the stored play drops instead of retaining at its unverifiable rate.
      const purged = await computePlayerSkillRatings(db, failingOsu, [], first.plays, {
        untrustedIdentities: new Set(["official:991"]),
      });
      expect(purged.summary.analyzedPlays).toBe(0);

      // A top-sourced play keeps its trust: its rate came from the real mods
      // at rating time, mod-less archive trace or not.
      const topSourced = [{ ...first.plays[0], source: "top" as const }];
      const kept = await computePlayerSkillRatings(db, failingOsu, [], topSourced, {
        untrustedIdentities: new Set(["official:991"]),
      });
      expect(kept.summary.analyzedPlays).toBe(1);
    });
  });

  it("drops a stored play contradicting a live candidate's rate for the same score", async () => {
    await withDb(async (db) => {
      await storeCachedBeatmapFile(db, 106, buildStreamBeatmapFile(), { source: "test" });
      // A stale assumed-1.0x phantom of score 991 sits in the cache while the
      // live tracked payload shows the score was really played on HT.
      const phantom = await computePlayerSkillRatings(db, failingOsu, [], [], {
        trackedScores: [play({ id: 991, beatmap_id: 106, accuracy: 0.93, pp: null })],
      });
      expect(phantom.plays[0].rate).toBe(1);
      const trackedScores = [play({ id: 991, beatmap_id: 106, accuracy: 0.93, pp: null, mods: [{ acronym: "HT" }] })];
      const result = await computePlayerSkillRatings(db, failingOsu, [], phantom.plays, { trackedScores });
      expect(result.summary.analyzedPlays).toBe(1);
      expect(result.plays[0].rate).toBe(0.75);
      expect(result.plays[0].identity).toBe("official:991");
    });
  });

  it("retains rated plays after their source score ages out of the tracked window", async () => {
    await withDb(async (db) => {
      await storeCachedBeatmapFile(db, 106, buildStreamBeatmapFile(), { source: "test" });
      const trackedScores = [play({ id: 3, beatmap_id: 106, accuracy: 0.95, pp: null })];
      const first = await computePlayerSkillRatings(db, failingOsu, [], [], { trackedScores });
      expect(first.summary.analyzedPlays).toBe(1);

      // Second run: the tracked play is gone from every input and the .osu is
      // gone too, so only the retained cache can keep it rated.
      await exec(db, "delete from beatmap_osu_files where beatmap_id = 106");
      const second = await computePlayerSkillRatings(db, failingOsu, [], first.plays, {});
      expect(second.summary.analyzedPlays).toBe(1);
      expect(second.summary.pendingPlays).toBe(0);
      expect(second.plays[0].values).toEqual(first.plays[0].values);
    });
  });

  it("reuses cached per-play SSRs so unchanged plays never re-run the calc", async () => {
    await withDb(async (db) => {
      await storeCachedBeatmapFile(db, 101, buildStreamBeatmapFile(), { source: "test" });
      const scores = [play({ id: 1, beatmap_id: 101, accuracy: 0.99 })];
      const first = await computePlayerSkillRatings(db, failingOsu, scores, []);
      expect(first.summary.analyzedPlays).toBe(1);

      // With the .osu gone, a fresh analysis would land in pendingPlays; the
      // cached SSR keeps the play analyzed without touching the calc.
      await exec(db, "delete from beatmap_osu_files where beatmap_id = 101");
      const second = await computePlayerSkillRatings(db, failingOsu, scores, first.plays);
      expect(second.summary.analyzedPlays).toBe(1);
      expect(second.summary.pendingPlays).toBe(0);
      expect(second.plays[0].values).toEqual(first.plays[0].values);

      // A different accuracy invalidates the cache entry for that play; with
      // the .osu gone the new goal cannot compute (pending), but the retained
      // better play keeps its chart slot rated meanwhile.
      const changed = await computePlayerSkillRatings(db, failingOsu, [play({ id: 1, beatmap_id: 101, accuracy: 0.9 })], first.plays);
      expect(changed.summary.analyzedPlays).toBe(1);
      expect(changed.summary.pendingPlays).toBe(1);
      expect(changed.plays[0].goal).toBe(first.plays[0].goal);
    });
  });
});

describe("getPlayerSkillBreakdown", () => {
  it("enqueues a compute for unknown players and reports pending", async () => {
    await withDb(async (db) => {
      const queue = new JobQueue(db);
      const breakdown = await getPlayerSkillBreakdown(db, queue, 99);
      expect(breakdown.status).toBe("pending");
      expect(breakdown.modes).toEqual([]);
      const jobs = (await exec(db, "select dedupe_key from jobs where type = 'compute_player_skills'")).rows;
      expect(jobs).toHaveLength(1);
      expect(String(jobs[0].dedupe_key)).toBe(`player-skills:${PLAYER_SKILLS_VERSION}:99`);
    });
  });

  it("serves ready rows and recomputes when newer top plays landed", async () => {
    await withDb(async (db) => {
      const queue = new JobQueue(db);
      const computedAt = new Date(Date.now() - 60_000).toISOString();
      const summary = {
        totalPlays: 10,
        analyzedPlays: 9,
        pendingPlays: 0,
        unsupportedPlays: 1,
        modes: [{ keyCount: 4, analyzedPlays: 9, ratings: { Overall: 21.5, Stream: 18 } }],
      };
      await exec(
        db,
        `insert into player_skill_ratings (user_id, analysis_version, status, modes_json, computed_at, updated_at)
         values (?, ?, 'ready', ?, ?, ?)`,
        [99, PLAYER_SKILLS_VERSION, JSON.stringify(summary), computedAt, computedAt],
      );

      const fresh = await getPlayerSkillBreakdown(db, queue, 99);
      expect(fresh.status).toBe("ready");
      expect(fresh.modes[0].ratings.Overall).toBe(21.5);
      expect(fresh.stale).toBeUndefined();
      expect(Number((await exec(db, "select count(*) as cnt from jobs where type = 'compute_player_skills'")).rows[0].cnt)).toBe(0);

      await exec(
        db,
        `insert into top_play_events (country, user_id, score_id, pp, weighted_pp, pp_gain, detected_at, payload_json)
         values ('CR', 99, 12345, 150, 150, 5, ?, '{}')`,
        [new Date().toISOString()],
      );
      const afterNewTopPlay = await getPlayerSkillBreakdown(db, queue, 99);
      expect(afterNewTopPlay.status).toBe("ready");
      // The served snapshot is known-superseded: clients get told instead of
      // being left to discover the swap on the next visit.
      expect(afterNewTopPlay.stale).toBe(true);
      expect(Number((await exec(db, "select count(*) as cnt from jobs where type = 'compute_player_skills'")).rows[0].cnt)).toBe(1);
    });
  });

  it("recomputes on a tracked play ingested since the compute, with no new top play", async () => {
    await withDb(async (db) => {
      const queue = new JobQueue(db);
      const computedAt = new Date(Date.now() - 60_000).toISOString();
      const summary = {
        totalPlays: 10,
        analyzedPlays: 9,
        pendingPlays: 0,
        unsupportedPlays: 1,
        modes: [{ keyCount: 4, analyzedPlays: 9, ratings: { Overall: 21.5, Stream: 18 } }],
      };
      await exec(
        db,
        `insert into player_skill_ratings (user_id, analysis_version, status, modes_json, computed_at, updated_at)
         values (?, ?, 'ready', ?, ?, ?)`,
        [99, PLAYER_SKILLS_VERSION, JSON.stringify(summary), computedAt, computedAt],
      );

      const insertScoreEvent = async (identity: string, opts: { passed: number; rulesetId: number; receivedAt: string }) => exec(
        db,
        `insert into score_events
           (score_id, score_identity, user_id, country, beatmap_id, ruleset_id, score_json, passed, is_lazer, has_replay, ended_at, received_at, source)
         values (?, ?, 99, 'CR', 555, ?, '{}', ?, 1, 0, ?, ?, 'test')`,
        [Math.floor(Math.random() * 1e9), identity, opts.rulesetId, opts.passed, opts.receivedAt, opts.receivedAt],
      );
      const afterCompute = new Date().toISOString();
      // None of these feed the rating: a fail, a non-mania pass, and a mania
      // pass the compute already read (received before computed_at).
      await insertScoreEvent("fail", { passed: 0, rulesetId: 3, receivedAt: afterCompute });
      await insertScoreEvent("std", { passed: 1, rulesetId: 0, receivedAt: afterCompute });
      await insertScoreEvent("old", { passed: 1, rulesetId: 3, receivedAt: new Date(Date.now() - 120_000).toISOString() });

      const unaffected = await getPlayerSkillBreakdown(db, queue, 99);
      expect(unaffected.stale).toBeUndefined();
      expect(Number((await exec(db, "select count(*) as cnt from jobs where type = 'compute_player_skills'")).rows[0].cnt)).toBe(0);

      // A passed mania play ingested since the compute is rating evidence, so
      // a mid-session view recomputes now instead of waiting out the debounce.
      await insertScoreEvent("tracked", { passed: 1, rulesetId: 3, receivedAt: afterCompute });
      const afterTrackedPlay = await getPlayerSkillBreakdown(db, queue, 99);
      expect(afterTrackedPlay.status).toBe("ready");
      expect(afterTrackedPlay.stale).toBe(true);
      expect(Number((await exec(db, "select count(*) as cnt from jobs where type = 'compute_player_skills'")).rows[0].cnt)).toBe(1);
    });
  });

  it("relabels stored 6K/7K dan sides on their own ladders, not the 4K greek one", async () => {
    await withDb(async (db) => {
      const queue = new JobQueue(db);
      const computedAt = new Date().toISOString();
      const summary = {
        totalPlays: 300,
        analyzedPlays: 300,
        pendingPlays: 0,
        unsupportedPlays: 0,
        modes: [
          {
            keyCount: 7,
            analyzedPlays: 228,
            ratings: { Overall: 24.47 },
            patterns: [],
            // Stored labels are stale pre-fix garbage; the read path must
            // re-derive from rawDan (7K table scale: Gamma = 11).
            dan: {
              rc: { rawDan: 11.4, label: "alpha++", clears: 6 },
              ln: { rawDan: 11.4, label: "alpha++", clears: 5 },
            },
          },
          {
            keyCount: 6,
            analyzedPlays: 40,
            ratings: { Overall: 18 },
            patterns: [],
            dan: {
              // 6K RC is numeric only and caps at 9; 6K LN goes Terra(10)..Finish(14).
              rc: { rawDan: 9.4, label: "iota", clears: 4 },
              ln: { rawDan: 14, label: "delta", clears: 4 },
            },
          },
          {
            keyCount: 4,
            analyzedPlays: 32,
            ratings: { Overall: 20 },
            patterns: [],
            // 4K keeps its own ladders: rice greek via parseDan, LN numeric.
            dan: {
              rc: { rawDan: 11.4, label: "stale", clears: 4 },
              ln: { rawDan: 16.2, label: "16", clears: 4 },
            },
          },
        ],
      };
      await exec(
        db,
        `insert into player_skill_ratings (user_id, analysis_version, status, modes_json, computed_at, updated_at)
         values (?, ?, 'ready', ?, ?, ?)`,
        [99, PLAYER_SKILLS_VERSION, JSON.stringify(summary), computedAt, computedAt],
      );

      const breakdown = await getPlayerSkillBreakdown(db, queue, 99);
      const byKeyCount = new Map(breakdown.modes.map((mode) => [mode.keyCount, mode]));
      expect(byKeyCount.get(7)?.dan?.rc?.label).toBe("gamma++");
      expect(byKeyCount.get(7)?.dan?.ln?.label).toBe("gamma++");
      expect(byKeyCount.get(6)?.dan?.rc?.label).toBe("9++");
      expect(byKeyCount.get(6)?.dan?.ln?.label).toBe("finish");
      expect(byKeyCount.get(4)?.dan?.rc?.label).toBe("alpha++");
      // The 4K LN ladder runs to 17 (Yeehee), so a 16.2 is a real LN 16+
      // rather than something folded onto the old 15 ceiling.
      expect(byKeyCount.get(4)?.dan?.ln?.label).toBe("16+");
    });
  });

  it("keeps serving a superseded ready row after a version bump, flagged stale", async () => {
    await withDb(async (db) => {
      const queue = new JobQueue(db);
      const computedAt = new Date().toISOString();
      const summary = {
        totalPlays: 10,
        analyzedPlays: 9,
        pendingPlays: 0,
        unsupportedPlays: 1,
        modes: [{ keyCount: 4, analyzedPlays: 9, ratings: { Overall: 21.5 } }],
      };
      const storedPlay = {
        identity: "official:31", beatmapId: 106, keyCount: 4, rate: 1, goal: 0.93,
        pp: 90, values: { Overall: 21.5, Stream: 18 }, patterns: [], source: "top",
      };
      await exec(
        db,
        `insert into player_skill_ratings (user_id, analysis_version, status, modes_json, plays_json, computed_at, updated_at)
         values (?, ?, 'ready', ?, ?, ?, ?)`,
        [99, PLAYER_SKILLS_VERSION - 1, JSON.stringify(summary), JSON.stringify({ plays: [storedPlay] }), computedAt, computedAt],
      );

      // The bump queues the upgrade but must not blank the profile meanwhile.
      const breakdown = await getPlayerSkillBreakdown(db, queue, 99);
      expect(breakdown.status).toBe("ready");
      expect(breakdown.stale).toBe(true);
      expect(breakdown.version).toBe(PLAYER_SKILLS_VERSION - 1);
      expect(breakdown.modes[0].ratings.Overall).toBe(21.5);
      const jobs = (await exec(db, "select dedupe_key from jobs where type = 'compute_player_skills'")).rows;
      expect(jobs.map((row) => String(row.dedupe_key))).toEqual([`player-skills:${PLAYER_SKILLS_VERSION}:99`]);

      // The evidence lists explain the same superseded row the breakdown serves.
      const plays = await getPlayerSkillPlays(db, 99, 4, "Stream");
      expect(plays.total).toBe(1);
      expect(plays.items[0]?.beatmapId).toBe(106);

      // A failed current-version row falls back the same way instead of
      // reporting the profile as failed while the old rating still exists.
      await exec(
        db,
        `insert into player_skill_ratings (user_id, analysis_version, status, error, updated_at)
         values (?, ?, 'failed', 'boom', ?)`,
        [99, PLAYER_SKILLS_VERSION, computedAt],
      );
      const afterFailure = await getPlayerSkillBreakdown(db, queue, 99, { allowEnqueue: false });
      expect(afterFailure.status).toBe("ready");
      expect(afterFailure.stale).toBe(true);
      expect(afterFailure.modes[0].ratings.Overall).toBe(21.5);
    });
  });
});

describe("computePlayerSkillsJob", () => {
  it("seeds a version bump's first compute from the superseded row's plays", async () => {
    await withDb(async (db) => {
      const queue = new JobQueue(db);
      const now = new Date().toISOString();
      const jobOsu = {
        ...failingOsu,
        getUserByKey: async (): Promise<never> => { throw new Error("no network in tests"); },
        getUserBestScoresWindow: async (): Promise<never> => { throw new Error("no network in tests"); },
      };
      // A stored profile snapshot with one live top play (uncached chart, so it
      // lands as pending without a calc) keeps the job off the osu! API.
      await exec(
        db,
        `insert into profile_snapshots (user_id, username_key, user_json, best_scores_json, best_scores_limit, fetched_at, user_fetched_at, updated_at)
         values (99, '99', '{}', ?, 200, ?, ?, ?)`,
        [JSON.stringify([play({ id: 41, beatmap_id: 777 })]), now, now, now],
      );
      // Exercise the oldest still-compatible row, not merely the immediately
      // previous one: these are the players most likely to carry retained
      // evidence that has aged out of every live score source.
      const seededVersion = Math.min(...PLAYER_SKILLS_SEED_VERSIONS);
      expect(seededVersion).toBe(16);
      const storedPlay = {
        identity: "official:31", beatmapId: 106, keyCount: 4, rate: 1, goal: 0.93,
        pp: 90, values: { Overall: 20, Stream: 18 }, patterns: [], source: "top",
      };
      await exec(
        db,
        `insert into player_skill_ratings (user_id, analysis_version, status, modes_json, plays_json, computed_at, updated_at)
         values (99, ?, 'ready', '{}', ?, ?, ?)`,
        [seededVersion, JSON.stringify({ version: seededVersion, plays: [storedPlay] }), now, now],
      );

      await computePlayerSkillsJob(db, jobOsu, queue, { userId: 99 });

      // The recompute retained the superseded row's play (its score is long
      // gone from every live source) instead of starting from zero.
      const rows = (await exec(
        db,
        "select analysis_version, status, modes_json, plays_json from player_skill_ratings where user_id = 99",
      )).rows;
      expect(rows).toHaveLength(1);
      expect(Number(rows[0].analysis_version)).toBe(PLAYER_SKILLS_VERSION);
      expect(String(rows[0].status)).toBe("ready");
      const plays = JSON.parse(String(rows[0].plays_json)).plays as Array<{ identity: string; values: Record<string, number> }>;
      expect(plays.map((entry) => entry.identity)).toContain("official:31");
      expect(plays.find((entry) => entry.identity === "official:31")?.values.Overall).toBe(20);
      const summary = JSON.parse(String(rows[0].modes_json));
      expect(summary.analyzedPlays).toBe(1);
      expect(summary.pendingPlays).toBe(1);
    });
  });
});

describe("getPlayerSkillPlays", () => {
  it("keeps serving persisted breakdown and evidence while a refresh is running", async () => {
    await withDb(async (db) => {
      const now = new Date().toISOString();
      const summary = {
        totalPlays: 1,
        analyzedPlays: 1,
        pendingPlays: 0,
        unsupportedPlays: 0,
        modes: [{ keyCount: 4, analyzedPlays: 1, ratings: { Overall: 21.5, Stream: 18 } }],
      };
      const storedPlay = {
        identity: "official:31", beatmapId: 106, keyCount: 4, rate: 1, goal: 0.93,
        pp: 90, values: { Overall: 21.5, Stream: 18 }, patterns: [], source: "top",
      };
      await exec(
        db,
        `insert into player_skill_ratings
         (user_id, analysis_version, status, modes_json, plays_json, computed_at, updated_at)
         values (99, ?, 'running', ?, ?, ?, ?)`,
        [PLAYER_SKILLS_VERSION, JSON.stringify(summary), JSON.stringify({ plays: [storedPlay] }), now, now],
      );

      const breakdown = await getPlayerSkillBreakdown(db, new JobQueue(db), 99, { allowEnqueue: false });
      expect(breakdown.status).toBe("ready");
      expect(breakdown.stale).toBe(true);
      expect(breakdown.modes[0]?.ratings.Overall).toBe(21.5);

      const plays = await getPlayerSkillPlays(db, 99, 4, "Stream");
      expect(plays.total).toBe(1);
      expect(plays.items[0]?.beatmapId).toBe(106);

      const evidence = await getPlayerSkillDanEvidence(db, 99, 4, "rc");
      expect(evidence).not.toBeNull();
      expect(evidence?.keyCount).toBe(4);
    });
  });

  it("filters and paginates the durable plays behind a skill axis", async () => {
    await withDb(async (db) => {
      const now = new Date().toISOString();
      await exec(
        db,
        `insert into beatmapsets (beatmapset_id, title, artist, creator, status, covers_json, metadata_json, updated_at)
         values (10, 'Skill Song', 'Skill Artist', 'Skill Mapper', 'ranked', ?, '{}', ?)`,
        [JSON.stringify({ list: "https://example.com/list.jpg" }), now],
      );
      for (const [beatmapId, version] of [[101, "Stream A"], [102, "Stream B"], [103, "Seven Keys"], [104, "Fake LN"]] as const) {
        await exec(
          db,
          `insert into beatmaps
           (beatmap_id, beatmapset_id, mode, status, cs, difficulty_rating, bpm, max_combo, version, url, metadata_json, updated_at)
           values (?, 10, 'mania', 'ranked', ?, 5, 180, 1000, ?, null, '{}', ?)`,
          [beatmapId, beatmapId === 103 ? 7 : 4, version, now],
        );
      }
      // Stored tags arrive pre-gated (loadChartSkillInfo strips the ln tag off
      // charts the analyzer does not call LN), so 104 - a gamma-style rice
      // chart that merely cleared the tag's hold-pressure leg - carries no ln
      // tag here and cannot reach the top LN plays surface.
      const plays = [
        { identity: "official:1", beatmapId: 101, keyCount: 4, rate: 1, goal: 0.95, pp: 200, values: { Overall: 22, Stream: 24 }, patterns: ["stream"], source: "top", accuracy: 0.97, endedAt: "2026-08-01T00:00:00Z" },
        { identity: "official:2", beatmapId: 102, keyCount: 4, rate: 1.5, goal: 0.96, pp: 180, values: { Overall: 25, Stream: 29 }, patterns: ["stream", "ln"], source: "tracked", accuracy: 0.98, endedAt: "2026-08-02T00:00:00Z", rateMod: "NC" },
        { identity: "official:3", beatmapId: 103, keyCount: 7, rate: 1, goal: 0.94, pp: 250, values: { Overall: 30, Stream: 31 }, patterns: ["stream"], source: "top", accuracy: 0.96, endedAt: "2026-08-03T00:00:00Z" },
        { identity: "official:4", beatmapId: 104, keyCount: 4, rate: 1, goal: 0.97, pp: 210, values: { Overall: 27, Stream: 20 }, patterns: ["stamina"], source: "top", accuracy: 0.99, endedAt: "2026-08-04T00:00:00Z" },
      ];
      await exec(
        db,
        `insert into player_skill_ratings
         (user_id, analysis_version, status, modes_json, plays_json, computed_at, updated_at)
         values (99, ?, 'ready', '{}', ?, ?, ?)`,
        [PLAYER_SKILLS_VERSION, JSON.stringify({ version: PLAYER_SKILLS_VERSION, plays }), now, now],
      );

      const first = await getPlayerSkillPlays(db, 99, 4, "Stream", { limit: 1 });
      // Three 4K plays carry a Stream SSR; the ln-only play ranks last there.
      expect(first.total).toBe(3);
      expect(first.items).toHaveLength(1);
      expect(first.items[0]).toMatchObject({
        beatmapId: 102,
        title: "Skill Song",
        version: "Stream B",
        rating: 29,
        rate: 1.5,
        source: "tracked",
        scoreId: 2,
        // The play's own mod, not one inferred from the rate: 1.5x alone
        // cannot say whether the audio was pitched.
        rateMod: "NC",
      });

      const second = await getPlayerSkillPlays(db, 99, 4, "Stream", { limit: 1, offset: 1 });
      // Cached before the mod was stored beside the rate: null, and consumers
      // fall back to the rate's sign rather than a made-up acronym.
      expect(second.items[0]).toMatchObject({ beatmapId: 101, rating: 24, rateMod: null });

      const ln = await getPlayerSkillPlays(db, 99, 4, "pattern:ln");
      // The LN list is exactly the ln-tagged plays, ranked by Overall, so it
      // matches the set the LN pattern rating aggregates.
      expect(ln.total).toBe(1);
      expect(ln.items[0]).toMatchObject({ beatmapId: 102, rating: 25 });
    });
  });
});

describe("parseNamedRate", () => {
  it("reads an uprate a diff name states, in the forms mappers write it", () => {
    expect(parseNamedRate("[4K] NB5 Hard 54235 1.4x")).toBe(1.4);
    expect(parseNamedRate("[4K] [Lv.19] IcyWorld's Hard x1.4")).toBe(1.4);
    expect(parseNamedRate("[4K] Insane [1,1x Rate]")).toBe(1.1);
    expect(parseNamedRate("[4K] Challenge 1.4x (191bpm) OD8")).toBe(1.4);
  });

  it("stays silent on names that state no uprate", () => {
    expect(parseNamedRate("[4K] NB5 Hard 54235")).toBeNull();
    expect(parseNamedRate("[4K] Cool Gamer")).toBeNull();
    // A downrate lengthens the file, so the gate already judges it fairly.
    expect(parseNamedRate("[4K] x0.85")).toBeNull();
    // Out of the band a rate edit lives in.
    expect(parseNamedRate("[4K] Marathon 9x")).toBeNull();
  });
});

describe("the rate-edit base length", () => {
  const CLASSIFICATION = JSON.stringify({ lnRatio: 0, patterns: [] });

  // FUTURE DOMINATORS [4K] NB5 Hard 54235, beatmapset 1527020: five diffs of
  // one chart, all 40 holds, at 317 / 288 / 264 / 244 / 226 seconds.
  async function seedLadder(
    db: Awaited<ReturnType<typeof createDb>>,
    diffs: Array<{
      beatmapId: number;
      version: string;
      length: number;
      setId?: number;
      lnCount?: number;
      circleCount?: number;
    }>,
  ): Promise<void> {
    const now = "2026-01-01T00:00:00Z";
    const { CHART_ANALYSIS_VERSION } = await import("../src/features/chart-analysis.js");
    for (const diff of diffs) {
      const setId = diff.setId ?? 1527020;
      await exec(
        db,
        `insert into beatmaps (beatmap_id, beatmapset_id, mode, version, metadata_json, updated_at)
         values (?, ?, 'mania', ?, ?, ?)`,
        [
          diff.beatmapId,
          setId,
          diff.version,
          JSON.stringify({
            total_length: diff.length,
            count_circles: diff.circleCount ?? 6007,
            count_sliders: diff.lnCount ?? 40,
            count_spinners: 0,
          }),
          now,
        ],
      );
      await exec(
        db,
        `insert into beatmap_chart_analysis (beatmap_id, analysis_version, status, key_count, classification_json, updated_at)
         values (?, ?, 'ready', 4, ?, ?)`,
        [diff.beatmapId, CHART_ANALYSIS_VERSION, CLASSIFICATION, now],
      );
      await exec(
        db,
        `insert into map_search_index
           (beatmap_id, beatmapset_id, analysis_version, title, artist, creator, version, search_text,
            key_count, stars, bpm, length, status, primary_pattern, ln_count, updated_at)
         values (?, ?, 1, 'FUTURE DOMINATORS', 'DJ Sharpnel', 'IcyWorld', ?, '', 4, 5, 210, ?, 'loved', 'stream', ?, ?)`,
        [diff.beatmapId, setId, diff.version, diff.length, diff.lnCount ?? 40, now],
      );
    }
  }

  it("gives a confirmed rate edit the base length its own file no longer has", async () => {
    await withDb(async (db) => {
      await seedLadder(db, [
        { beatmapId: 3123873, version: "[4K] NB5 Hard 54235", length: 317 },
        { beatmapId: 3123872, version: "[4K] NB5 Hard 54235 1.4x", length: 226 },
        { beatmapId: 3123871, version: "[4K] NB5 Hard 54235 1.3x", length: 244 },
      ]);
      const info = await loadChartSkillInfo(db, [3123873, 3123872, 3123871]);
      // 226 x 1.4 predicts 316.4 and the set's measured 317s base confirms it.
      expect(info.get(3123872)?.lengthSeconds).toBe(317);
      // Already over the bar on its own file, so nothing is resolved.
      expect(info.get(3123871)?.lengthSeconds).toBe(244);
      // The base itself names no rate.
      expect(info.get(3123873)?.lengthSeconds).toBe(317);
    });
  });

  it("keeps the stored length when the set confirms nothing", async () => {
    await withDb(async (db) => {
      await seedLadder(db, [
        // A pack: the name says 1.4x but no sibling sits at 226 x 1.4, so the
        // name is not believed. This is the case a name-only rule gets wrong.
        { beatmapId: 401, version: "[4K] Some Song 1.4x", length: 226 },
        { beatmapId: 402, version: "[4K] An Unrelated Chart", length: 300, lnCount: 12 },
      ]);
      const info = await loadChartSkillInfo(db, [401, 402]);
      expect(info.get(401)?.lengthSeconds).toBe(226);
    });
  });

  it("does not read a sibling from another beatmapset", async () => {
    await withDb(async (db) => {
      await seedLadder(db, [
        { beatmapId: 411, version: "[4K] Song 1.4x", length: 226 },
        { beatmapId: 412, version: "[4K] Song", length: 317, setId: 999001 },
      ]);
      const info = await loadChartSkillInfo(db, [411, 412]);
      expect(info.get(411)?.lengthSeconds).toBe(226);
    });
  });

  it("does not let unrelated rice-pack diffs confirm each other", async () => {
    await withDb(async (db) => {
      await seedLadder(db, [
        // Captain Jack and Observation are unrelated songs in the same pack.
        // Both have zero holds and their lengths happen to fit 1.25x within 2%,
        // but their exact object counts expose the collision.
        { beatmapId: 421, version: "[4K] Captain Jack 1.25x", length: 196, lnCount: 0, circleCount: 4170 },
        { beatmapId: 422, version: "[4K] Observation 0.75x", length: 249, lnCount: 0, circleCount: 5092 },
      ]);
      const info = await loadChartSkillInfo(db, [421, 422]);
      expect(info.get(421)?.lengthSeconds).toBe(196);
    });
  });

  it("uses the confirmed sibling's measured length at the stamina boundary", async () => {
    await withDb(async (db) => {
      await seedLadder(db, [
        { beatmapId: 431, version: "[4K] Song 1.2x", length: 200 },
        // Within the 2% confirmation band of the predicted 240s, but the base
        // itself is still under the 240s stamina gate.
        { beatmapId: 432, version: "[4K] Song", length: 236 },
      ]);
      const info = await loadChartSkillInfo(db, [431, 432]);
      expect(info.get(431)?.lengthSeconds).toBe(236);
    });
  });
});

describe("loadChartSkillInfo", () => {
  it("keeps LN tags only on charts the analyzer calls LN", async () => {
    await withDb(async (db) => {
      const now = new Date().toISOString();
      const { CHART_ANALYSIS_VERSION } = await import("../src/features/chart-analysis.js");
      const charts: Array<[number, unknown]> = [
        // Genuinely LN-dominant: every tag survives.
        [201, { lnRatio: 0.8, patterns: [{ id: "ln", score: 0.9 }, { id: "lntech", score: 0.7 }, { id: "chordstream", score: 0.8 }] }],
        // Rice chart with a token hold section: the ln tags clear the score
        // bar but the analyzer never calls the chart LN, so they are stripped.
        [202, { lnRatio: 0.02, patterns: [{ id: "ln", score: 0.6 }, { id: "lninverse", score: 0.8 }, { id: "chordstream", score: 0.8 }] }],
        // No lnRatio at all cannot be verified as LN and is not trusted.
        [203, { patterns: [{ id: "ln", score: 0.9 }, { id: "chordstream", score: 0.8 }] }],
        // Just under half holds is still an LN chart (the floor sits below the
        // classifier's dan-side routing line for exactly this case).
        [204, { lnRatio: 0.476, patterns: [{ id: "ln", score: 1 }, { id: "chordstream", score: 0.8 }] }],
      ];
      for (const [beatmapId, classification] of charts) {
        await exec(
          db,
          `insert into beatmap_chart_analysis (beatmap_id, analysis_version, status, classification_json, updated_at)
           values (?, ?, 'ready', ?, ?)`,
          [beatmapId, CHART_ANALYSIS_VERSION, JSON.stringify(classification), now],
        );
      }

      const info = await loadChartSkillInfo(db, [201, 202, 203, 204]);
      expect(info.get(201)?.patterns.sort()).toEqual(["chordstream", "ln", "lntech"]);
      expect(info.get(202)?.patterns).toEqual(["chordstream"]);
      expect(info.get(203)?.patterns).toEqual(["chordstream"]);
      expect(info.get(203)?.lnRatio).toBeNull();
      expect(info.get(204)?.patterns.sort()).toEqual(["chordstream", "ln"]);
    });
  });

  it("uses bounded primary-key lookups and ignores non-ready chart rows", async () => {
    await withDb(async (db) => {
      const now = new Date().toISOString();
      const { CHART_ANALYSIS_VERSION } = await import("../src/features/chart-analysis.js");
      await exec(
        db,
        `insert into beatmap_chart_analysis (beatmap_id, analysis_version, status, classification_json, updated_at)
         values (?, ?, 'ready', ?, ?), (?, ?, 'pending', ?, ?)`,
        [301, CHART_ANALYSIS_VERSION, JSON.stringify({ lnRatio: 0, patterns: [] }), now,
          302, CHART_ANALYSIS_VERSION, JSON.stringify({ lnRatio: 0, patterns: [] }), now],
      );

      const client = db as unknown as { execute: (stmt: unknown) => Promise<unknown> };
      const realExecute = client.execute.bind(client);
      const chartQueries: string[] = [];
      client.execute = async (stmt: unknown) => {
        const sql = String((stmt as { sql?: unknown })?.sql ?? stmt ?? "");
        if (sql.includes("from beatmap_chart_analysis")) chartQueries.push(sql);
        return realExecute(stmt);
      };

      // 501 unique ids cross the 500-id pacing boundary without needing 501
      // seeded rows. The pending row may be returned by the PK lookup, but it
      // must not become usable chart information.
      const info = await loadChartSkillInfo(db, Array.from({ length: 501 }, (_, index) => index + 1));
      expect(chartQueries).toHaveLength(2);
      expect(chartQueries.every((sql) => !sql.includes("status = 'ready'"))).toBe(true);
      expect(info.has(301)).toBe(true);
      expect(info.has(302)).toBe(false);
    });
  });
});

describe("danTableLabelFor", () => {
  it("speaks each keymode's table ladder and clamps to its ends", async () => {
    const { danTableLabelFor } = await import("../src/dan/chart-classifier.js");
    // 7K: Regular 0-10 then Gamma(11), Azimuth(12), Zenith(13), Stellium(14).
    expect(danTableLabelFor(7, "rc", 7)).toBe("7");
    expect(danTableLabelFor(11.4, "rc", 7)).toBe("gamma++");
    expect(danTableLabelFor(12, "ln", 7)).toBe("azimuth");
    expect(danTableLabelFor(13.7, "ln", 7)).toBe("stellium-");
    expect(danTableLabelFor(99, "rc", 7)).toBe("stellium++");
    // 7K LN table starts at LN 3; anything below clamps up to its floor.
    expect(danTableLabelFor(1, "ln", 7)).toBe("3--");
    // 6K: RC numeric 0-9; LN Terra(10) Celestial(11) Mystery(12) Nihility(13) Finish(14).
    expect(danTableLabelFor(9.4, "rc", 6)).toBe("9++");
    expect(danTableLabelFor(10, "ln", 6)).toBe("terra");
    expect(danTableLabelFor(13, "ln", 6)).toBe("nihility");
    // No table for keymodes outside the index.
    expect(danTableLabelFor(5, "rc", 5)).toBeNull();
  });

  it("preserves the source table tiers when labeling chart verdicts", async () => {
    const { danTableLabelFor, danTableVerdictLabelFor } = await import("../src/dan/chart-classifier.js");
    // 6K LN Mystery is level 12: low/mid-low/mid/mid-high/high sit at these
    // exact raw offsets in the Sunny table and must round-trip to its suffixes.
    expect(danTableVerdictLabelFor(11.6, "ln", 6)).toBe("mystery--");
    expect(danTableVerdictLabelFor(11.8, "ln", 6)).toBe("mystery-");
    expect(danTableVerdictLabelFor(12, "ln", 6)).toBe("mystery");
    expect(danTableVerdictLabelFor(12.2, "ln", 6)).toBe("mystery+");
    expect(danTableVerdictLabelFor(12.4, "ln", 6)).toBe("mystery++");
    // Continuous credit labeling deliberately keeps the shared player bands.
    expect(danTableLabelFor(11.6, "ln", 6)).toBe("mystery-");
  });
});

describe("danIgnoredStrayCount", () => {
  const flat = (value: number, count: number) => Array.from({ length: count }, () => value);

  it("ignores the one joke clear under a body of work", () => {
    expect(danIgnoredStrayCount([...flat(12, 13), 5])).toBe(1);
  });

  it("leaves a window alone when nothing sits five levels under its best five", () => {
    expect(danIgnoredStrayCount([...flat(12, 13), 7.5])).toBe(0);
  });

  it("never ignores more than three, so a wide body of work keeps its shape", () => {
    expect(danIgnoredStrayCount([...flat(12, 4), ...flat(5, 12)])).toBe(3);
  });

  it("keeps a stray rather than trimming a thin pool under the quorum", () => {
    expect(danIgnoredStrayCount([12, 12, 12, 12, 5])).toBe(1);
    expect(danIgnoredStrayCount([12, 12, 12, 5])).toBe(0);
  });

  it("reads the cut off the best five, so one spike cannot set it alone", () => {
    // Best three average 16.67 and would cut at 11.67, taking the 11s with it;
    // the best five average 14.4 and cut at 9.4, which only the 5 falls under.
    expect(danIgnoredStrayCount([20, 15, 15, 11, 11, 11, 11, 5])).toBe(1);
  });
});

describe("danClearAverageWindowFor", () => {
  it("averages the best twenty clears on every ladder", () => {
    expect(danClearAverageWindowFor("ln", 4)).toBe(20);
    expect(danClearAverageWindowFor("rc", 4)).toBe(20);
    expect(danClearAverageWindowFor("ln", 6)).toBe(20);
    expect(danClearAverageWindowFor("ln", 7)).toBe(20);
  });
});
