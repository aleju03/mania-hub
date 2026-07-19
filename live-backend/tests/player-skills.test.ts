import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, exec, migrate } from "../src/db.js";
import {
  PLAYER_SKILLS_VERSION,
  aggregateSsrs,
  computePlayerSkillRatings,
  estimateWifeAccuracy,
  getPlayerSkillBreakdown,
  getRankedPlayRate,
  loadArchivedTrackedEvidence,
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

describe("getRankedPlayRate", () => {
  it("maps ranked rate mods and leaves everything else at 1x", () => {
    expect(getRankedPlayRate([])).toBe(1);
    expect(getRankedPlayRate([{ acronym: "MR" }, { acronym: "HD" }])).toBe(1);
    expect(getRankedPlayRate([{ acronym: "DT" }])).toBe(1.5);
    expect(getRankedPlayRate([{ acronym: "NC" }])).toBe(1.5);
    expect(getRankedPlayRate([{ acronym: "HT" }])).toBe(0.75);
    expect(getRankedPlayRate([{ acronym: "DC" }])).toBe(0.75);
    expect(getRankedPlayRate(["DT", "HD"])).toBe(1.5);
  });

  it("rejects custom and variable rates instead of mis-rating them", () => {
    expect(getRankedPlayRate([{ acronym: "DT", settings: { speed_change: 1.1 } }])).toBeNull();
    expect(getRankedPlayRate([{ acronym: "HT", settings: { speed_change: 0.9 } }])).toBeNull();
    expect(getRankedPlayRate([{ acronym: "WU" }])).toBeNull();
    expect(getRankedPlayRate([{ acronym: "DT", settings: { speed_change: 1.5 } }])).toBe(1.5);
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
    expect(half).toBeGreaterThan(rice);
    expect(half).toBeLessThan(lnHeavy);
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

      expect(result.summary.totalPlays).toBe(4);
      expect(result.summary.analyzedPlays).toBe(1);
      expect(result.summary.unsupportedPlays).toBe(2);
      expect(result.summary.pendingPlays).toBe(1);
      expect(result.summary.modes).toHaveLength(1);
      expect(result.summary.modes[0].keyCount).toBe(4);
      expect(result.summary.modes[0].ratings.Overall).toBeGreaterThan(0);
      expect(result.summary.modes[0].ratings.Stream).toBeGreaterThan(0);
    });
  });

  it("rates DT plays at 1.5x, above the same play at 1x", async () => {
    await withDb(async (db) => {
      await storeCachedBeatmapFile(db, 101, buildStreamBeatmapFile(), { source: "test" });

      const nomod = await computePlayerSkillRatings(db, failingOsu, [play({ id: 1, beatmap_id: 101 })], []);
      const dt = await computePlayerSkillRatings(
        db,
        failingOsu,
        [play({ id: 2, beatmap_id: 101, mods: [{ acronym: "DT" }] })],
        [],
      );
      expect(dt.plays[0].rate).toBe(1.5);
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

      const scores = [
        play({ id: 1, beatmap_id: 101, accuracy: 0.995, statistics: { perfect: 660, great: 20 } }),
        play({ id: 2, beatmap_id: 105, accuracy: 0.995, statistics: { perfect: 680, great: 10 } }),
        // A DT clear counts only because the DT sweep stored a verdict, and
        // it lands on the verdict's primary side (rc here).
        play({ id: 3, beatmap_id: 101, mods: [{ acronym: "DT" }], accuracy: 0.96, statistics: { perfect: 350, great: 330 } }),
        // Below the accuracy bar: analyzed, but never a qualifying clear (if
        // this 9.9 counted, the rc dan would land higher).
        play({ id: 4, beatmap_id: 107, accuracy: 0.9, statistics: { perfect: 300, great: 300, ok: 60, miss: 10 } }),
        play({ id: 5, beatmap_id: 108, accuracy: 0.96, statistics: { perfect: 400, great: 260 } }),
        // Hybrid below the LN cutoff (lnRatio 0.4): counts as a rice clear
        // only - its ln half (7.0) must never reach the LN ladder.
        play({ id: 6, beatmap_id: 109, accuracy: 0.96, statistics: { perfect: 380, great: 280 } }),
        play({ id: 7, beatmap_id: 110, accuracy: 0.995, statistics: { perfect: 650, great: 20 } }),
        play({ id: 8, beatmap_id: 111, accuracy: 0.995, statistics: { perfect: 640, great: 25 } }),
        play({ id: 9, beatmap_id: 112, accuracy: 0.96, statistics: { perfect: 390, great: 270 } }),
      ];
      const result = await computePlayerSkillRatings(db, failingOsu, scores, []);
      expect(result.summary.analyzedPlays).toBe(9);
      const dan = result.summary.modes[0].dan!;
      // rc evidence uses stable-formula accuracy from the judgement counts
      // (these fixtures are all perfect/great = stable 100%, so full credit),
      // rice-primary charts only: 8.0, 9.0 (DT), 9.0 (hybrid counts rice),
      // 7.4. The quorum-th (4th) best credited clear IS the dan.
      expect(dan.rc?.rawDan).toBe(7.4);
      expect(dan.rc?.clears).toBe(4);
      expect(dan.rc?.label).toBeTruthy();
      // The LN side labels on the numeric LN ladder (never the rice greek
      // levels), LN-primary charts only: credited 6.0 / 5.5 / 5.4 / 4.8
      // position 4.8 -> "5". If chart 109's ln half leaked in, the 4th-best
      // would be 5.4 instead.
      expect(dan.ln?.rawDan).toBe(4.8);
      expect(dan.ln?.label).toBe("5");
      expect(dan.ln?.clears).toBe(4);
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
      expect(archived).toHaveLength(2);
      const byBeatmap = new Map(archived.map((score) => [score.beatmap_id, score]));
      expect(byBeatmap.get(106)?.accuracy).toBe(0.93);
      expect(byBeatmap.get(106)?.mods).toEqual([]);
      expect(byBeatmap.get(113)?.mods).toEqual([{ acronym: "DT" }]);

      const result = await computePlayerSkillRatings(db, failingOsu, [], [], { trackedScores: archived });
      expect(result.summary.analyzedPlays).toBe(2);
      const plays = new Map(result.plays.map((entry) => [entry.beatmapId, entry]));
      // Acc-only legacy row: plain-accuracy goal, assumed 1.0x, and never a
      // dan clear (no miss share).
      expect(plays.get(106)?.source).toBe("tracked");
      expect(plays.get(106)?.rate).toBe(1);
      expect(plays.get(106)?.goal).toBe(0.93);
      expect(plays.get(106)?.missShare).toBeNull();
      // Enriched row: real rate from the stored mods, miss share from the
      // stored judgement counts.
      expect(plays.get(113)?.rate).toBe(1.5);
      expect(plays.get(113)?.missShare).toBeCloseTo(4 / 384, 5);
      expect(result.summary.modes[0].dan?.rc ?? null).toBeNull();
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
      expect(Number((await exec(db, "select count(*) as cnt from jobs where type = 'compute_player_skills'")).rows[0].cnt)).toBe(0);

      await exec(
        db,
        `insert into top_play_events (country, user_id, score_id, pp, weighted_pp, pp_gain, detected_at, payload_json)
         values ('CR', 99, 12345, 150, 150, 5, ?, '{}')`,
        [new Date().toISOString()],
      );
      const afterNewTopPlay = await getPlayerSkillBreakdown(db, queue, 99);
      expect(afterNewTopPlay.status).toBe("ready");
      expect(Number((await exec(db, "select count(*) as cnt from jobs where type = 'compute_player_skills'")).rows[0].cnt)).toBe(1);
    });
  });
});
