import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, exec, json, migrate, type Db } from "../src/db.js";
import {
  creditDanCoursePassesForTest,
  danCourseCreditOffset,
  danCourseLevelFor,
  danCourseModsAllowed,
  listDanCourses,
  loadDanCourseClears,
  type DanCourseCreditOptions,
} from "../src/features/dan-courses.js";
import { danClearBarFor, danLabelForTest, loadPlayerDanCourseClears } from "../src/features/player-skills.js";

let dir = "";

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = "";
});

async function makeDb(): Promise<Db> {
  dir = await mkdtemp(join(tmpdir(), "mania-dan-courses-"));
  const db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
  return db;
}

const OPTIONS: DanCourseCreditOptions = { barFor: danClearBarFor, stableEquivalentV2BarOffset: 0.005 };

// Dan ~ REFORM ~ EXTRA-EPSILON (15), EXTRA-GAMMA (13), EXTRA-DELTA (14).
const EPSILON = 2259547;
const GAMMA = 2259548;
const DELTA = 2259546;

describe("the dan course registry", () => {
  it("resolves every course onto the same ladder its label is printed back from", () => {
    for (const course of listDanCourses()) {
      const level = danCourseLevelFor(course);
      expect(level, `${course.courseName} (${course.beatmapId}) is not on its ladder`).not.toBeNull();
      expect(
        danLabelForTest(level!, course.side, course.keyCount),
        `${course.courseName} (${course.beatmapId}) relabels wrong`,
      ).toBe(course.level);
    }
  });

  it("registers no beatmap twice", () => {
    const ids = listDanCourses().map((course) => course.beatmapId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("covers all six ladders", () => {
    const ladders = new Set(listDanCourses().map((course) => `${course.keyCount}${course.side}`));
    expect([...ladders].sort()).toEqual(["4ln", "4rc", "6ln", "6rc", "7ln", "7rc"]);
  });
});

describe("course accuracy tiers", () => {
  // The anchors the ladders' own +/- tiers are placed on, at the 4K rice bar.
  it("puts each accuracy on the tier the community names", () => {
    const bar = 0.96;
    const tier = (accuracy: number) => danLabelForTest(14 + danCourseCreditOffset(accuracy, bar, true)!, "rc", 4);
    expect(tier(0.94)).toBe("delta--");
    // Anything under the bar keeps a minus: a run that missed the pass mark
    // must never print as a bare level.
    // The knee sits a full point under the bar, so "--" is not squeezed into
    // the first fraction of a point: 94.63% is a point and a half short.
    expect(tier(0.9463)).toBe("delta--");
    expect(tier(0.95)).toBe("delta-");
    expect(tier(0.9599)).toBe("delta-");
    expect(tier(0.96)).toBe("delta");
    expect(tier(0.975)).toBe("delta+");
    expect(tier(0.98)).toBe("delta++");
    expect(tier(0.995)).toBe("delta++");
  });

  it("never prints a bare level for a run that missed the bar", () => {
    // 94.59% on the 7K LN ladder's 95% bar: 0.41 short, and it used to round
    // into the no-variant band and read as a clean 8th dan clear.
    const offset = danCourseCreditOffset(0.945913, 0.95, true)!;
    expect(danLabelForTest(8 + offset, "ln", 7)).toBe("8-");
  });

  it("credits nothing below the bottom anchor", () => {
    expect(danCourseCreditOffset(0.939, 0.96, true)).toBeNull();
    expect(danCourseCreditOffset(0.5, 0.96, true)).toBeNull();
  });

  it("caps under half a level so an overclear never reads as the next course", () => {
    const offset = danCourseCreditOffset(1, 0.96, true)!;
    expect(offset).toBeLessThan(0.5);
    expect(danLabelForTest(14 + offset, "rc", 4)).toBe("delta++");
  });

  it("credits from the bar up only when the ladder says so (4K LN)", () => {
    expect(danCourseCreditOffset(0.95, 0.97, false)).toBeNull();
    expect(danCourseCreditOffset(0.97, 0.97, false)).toBe(0);
  });
});

describe("course mods", () => {
  it("rejects the mods that make the run a different exam", () => {
    for (const acronym of ["EZ", "NF", "HT", "DC", "DA", "HO", "IN", "NR", "RD", "AT", "CN", "SO", "RX", "WU", "WD", "AS", "DP", "7K"]) {
      expect(danCourseModsAllowed([{ acronym }]), acronym).toBe(false);
    }
    expect(danCourseModsAllowed([{ acronym: "DT", settings: { speed_change: 0.95 } }])).toBe(false);
  });

  it("allows what the course rules allow", () => {
    expect(danCourseModsAllowed([])).toBe(true);
    for (const acronym of ["CL", "MR", "HD", "FI", "FL", "HR", "SD", "PF", "DT", "NC"]) {
      expect(danCourseModsAllowed([{ acronym }]), acronym).toBe(true);
    }
    expect(danCourseModsAllowed([{ acronym: "DT", settings: { speed_change: 1.3 } }])).toBe(true);
  });

  it("treats unrecorded mods as unverifiable rather than as no mods", () => {
    expect(danCourseModsAllowed(null)).toBe(false);
    expect(danCourseModsAllowed(undefined)).toBe(false);
  });
});

describe("crediting a pass", () => {
  it("credits an epsilon clear at epsilon", () => {
    const [clear] = creditDanCoursePassesForTest(
      [{ beatmapId: EPSILON, mods: [], displayed: 0.964, stable: 0.964 }],
      OPTIONS,
    );
    expect(clear.level).toBe("epsilon");
    expect(danLabelForTest(clear.rawDan, "rc", 4)).toBe("epsilon");
  });

  it("credits an HT epsilon pass at nothing", () => {
    expect(creditDanCoursePassesForTest(
      [{ beatmapId: EPSILON, mods: [{ acronym: "HT" }], displayed: 0.976, stable: 0.976 }],
      OPTIONS,
    )).toEqual([]);
  });

  it("keeps the strongest run per course and sorts strongest first", () => {
    const clears = creditDanCoursePassesForTest(
      [
        { beatmapId: GAMMA, mods: [], displayed: 0.96, stable: 0.96 },
        { beatmapId: GAMMA, mods: [], displayed: 0.985, stable: 0.985 },
        { beatmapId: DELTA, mods: [], displayed: 0.96, stable: 0.96 },
      ],
      OPTIONS,
    );
    expect(clears.map((clear) => clear.beatmapId)).toEqual([DELTA, GAMMA]);
    expect(danLabelForTest(clears[1].rawDan, "rc", 4)).toBe("gamma++");
  });
});

async function seedActivityPass(
  db: Db,
  userId: number,
  beatmapId: number,
  accuracy: number,
  mods: unknown[] | null,
  day = "2026-08-01",
): Promise<void> {
  await exec(
    db,
    `insert into player_activity_maps (country, user_id, day, beatmap_id, play_count, best_accuracy, best_mods_json, updated_at)
     values ('CR', ?, ?, ?, 1, ?, ${mods == null ? "null" : "json(?)"}, ?)`,
    mods == null
      ? [userId, day, beatmapId, accuracy, "2026-08-01T00:00:00.000Z"]
      : [userId, day, beatmapId, accuracy, json(mods), "2026-08-01T00:00:00.000Z"],
  );
  await exec(
    db,
    `insert into player_activity_score_refs (country, score_identity, user_id, day, beatmap_id, passed, ended_at, created_at)
     values ('CR', ?, ?, ?, ?, 1, ?, ?)`,
    [`${userId}:${beatmapId}:${day}`, userId, day, beatmapId, `${day}T00:00:00.000Z`, "2026-08-01T00:00:00.000Z"],
  );
}

describe("loadDanCourseClears", () => {
  it("finds a course pass the SSR play pool never kept", async () => {
    const db = await makeDb();
    await seedActivityPass(db, 42, EPSILON, 0.964, []);
    const clears = await loadDanCourseClears(db, 42, OPTIONS);
    expect(clears).toHaveLength(1);
    expect(clears[0].beatmapId).toBe(EPSILON);
    expect(danLabelForTest(clears[0].rawDan, "rc", 4)).toBe("epsilon");
  });

  it("ignores a pass whose mods were never recorded", async () => {
    const db = await makeDb();
    await seedActivityPass(db, 43, EPSILON, 0.99, null);
    expect(await loadDanCourseClears(db, 43, OPTIONS)).toEqual([]);
  });

  it("ignores an activity row with no passed score behind it", async () => {
    const db = await makeDb();
    await exec(
      db,
      `insert into player_activity_maps (country, user_id, day, beatmap_id, play_count, best_accuracy, best_mods_json, updated_at)
       values ('CR', 44, '2026-08-01', ?, 1, 0.99, json('[]'), '2026-08-01T00:00:00.000Z')`,
      [EPSILON],
    );
    expect(await loadDanCourseClears(db, 44, OPTIONS)).toEqual([]);
  });

  it("reads the fresh score_events window too", async () => {
    const db = await makeDb();
    await exec(
      db,
      `insert into score_events
         (score_id, score_identity, user_id, country, beatmap_id, ruleset_id, score_json, passed, processed, is_lazer, has_replay, ended_at, received_at, source)
       values (900, 'official:900', 45, 'CR', ?, 3, json(?), 1, 1, 0, 0, '2026-08-20T00:00:00Z', '2026-08-20T00:00:00Z', 'osc')`,
      [
        GAMMA,
        json({
          id: 900, user_id: 45, beatmap_id: GAMMA, accuracy: 0.982, mods: [], passed: true,
          rank: "S", score: 0, max_combo: 0, pp: null,
          statistics: { great: 982, ok: 18 }, ended_at: "2026-08-20T00:00:00Z",
        }),
      ],
    );
    const clears = await loadPlayerDanCourseClears(db, 45);
    expect(clears).toHaveLength(1);
    expect(clears[0].level).toBe("gamma");
  });

  it("grades a fresh play whose payload carries osu!'s placeholder rank", async () => {
    // A run on an unranked map comes back from /scores/recent with accuracy 0,
    // total_score 0 and rank "D" beside intact judgement counts.
    const db = await makeDb();
    await exec(
      db,
      `insert into score_events
         (score_id, score_identity, user_id, country, beatmap_id, ruleset_id, score_json, passed, processed, is_lazer, has_replay, ended_at, received_at, source)
       values (901, 'official:901', 47, 'CR', ?, 3, json(?), 1, 1, 0, 0, '2026-08-25T00:00:00Z', '2026-08-25T00:00:00Z', 'osu_recent')`,
      [
        GAMMA,
        json({
          id: 901, user_id: 47, beatmap_id: GAMMA, accuracy: 0, mods: [], passed: true,
          rank: "D", total_score: 0, legacy_total_score: 840256, legacy_score_id: 0,
          max_combo: 807, pp: null, type: "solo_score",
          statistics: { great: 982, ok: 18 }, ended_at: "2026-08-25T00:00:00Z",
        }),
      ],
    );
    const clears = await loadPlayerDanCourseClears(db, 47);
    expect(clears).toHaveLength(1);
    expect(clears[0].play.rank).toBe("S");
  });

  it("finds nothing for a player with no course passes", async () => {
    const db = await makeDb();
    expect(await loadPlayerDanCourseClears(db, 46)).toEqual([]);
  });
});
