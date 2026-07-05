import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, exec, migrate } from "../src/db.js";
import {
  PLAYER_SKILLS_VERSION,
  aggregateSsrs,
  computePlayerSkillRatings,
  getPlayerSkillBreakdown,
  getRankedPlayRate,
  ssrGoalForAccuracy,
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

  it("aggregates per-pattern ratings from chart-analysis tags", async () => {
    await withDb(async (db) => {
      await storeCachedBeatmapFile(db, 101, buildStreamBeatmapFile(), { source: "test" });
      await storeCachedBeatmapFile(db, 105, buildStreamBeatmapFile(), { source: "test" });
      const { CHART_ANALYSIS_VERSION } = await import("../src/features/chart-analysis.js");
      await exec(
        db,
        `insert into beatmap_chart_analysis (beatmap_id, analysis_version, status, classification_json, updated_at)
         values (101, ?, 'ready', ?, ?)`,
        [CHART_ANALYSIS_VERSION, JSON.stringify({ patterns: [{ id: "chordstream", score: 0.9 }, { id: "bracket", score: 0.6 }, { id: "ln", score: 0.2 }] }), new Date().toISOString()],
      );

      // Three plays on the tagged chart clear the min-plays bar; the play on
      // the untagged chart contributes no pattern axis and is reported back
      // for chart-analysis enqueueing.
      const scores = [
        play({ id: 1, beatmap_id: 101, accuracy: 0.99 }),
        play({ id: 2, beatmap_id: 101, accuracy: 0.95 }),
        play({ id: 3, beatmap_id: 101, accuracy: 0.9 }),
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

      // A different accuracy invalidates the cache entry for that play.
      const changed = await computePlayerSkillRatings(db, failingOsu, [play({ id: 1, beatmap_id: 101, accuracy: 0.9 })], first.plays);
      expect(changed.summary.analyzedPlays).toBe(0);
      expect(changed.summary.pendingPlays).toBe(1);
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
