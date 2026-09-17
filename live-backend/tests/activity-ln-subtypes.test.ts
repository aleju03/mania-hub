import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDb, exec, migrate } from "../src/db.js";
import { parseManiaBeatmap } from "../src/dan/beatmap-parser.js";
import { analyzeManiaPatterns } from "../src/dan/dan-estimator/patterns.js";
import type { ManiaPatternId } from "../src/dan/dan-estimator/types.js";
import { ACTIVITY_SKILL_ANALYSIS_VERSION, computeBeatmapActivitySkillVector } from "../src/features/activity.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  dirs.length = 0;
});

function makeOsu(
  rows: Array<Array<number | { column: number; holdMs?: number }>>,
  intervalMs: number,
  options: { circleSize?: number; keyCount?: number } = {},
): string {
  const keyCount = options.keyCount ?? 7;
  const hitObjects = rows.flatMap((row, index) => {
    const time = index * intervalMs;
    return row.map((entry) => {
      const column = typeof entry === "number" ? entry : entry.column;
      const holdMs = typeof entry === "number" ? 0 : (entry.holdMs ?? 0);
      const x = Math.floor(((column + 0.5) * 512) / keyCount);
      if (holdMs > 0) return `${x},192,${time},128,0,${time + holdMs}:0:0:0:0:`;
      return `${x},192,${time},1,0,0:0:0:0:`;
    });
  });

  return [
    "osu file format v14",
    "",
    "[General]",
    "Mode:3",
    "",
    "[Metadata]",
    "Title:Activity LN subtype fixture",
    "Artist:mania-hub",
    "Creator:test",
    "Version:7K",
    "",
    "[Difficulty]",
    `CircleSize:${options.circleSize ?? keyCount}`,
    "OverallDifficulty:8",
    "",
    "[TimingPoints]",
    "0,500,4,1,0,100,1,0",
    "",
    "[HitObjects]",
    ...hitObjects,
  ].join("\n");
}

async function analyzeFixture(beatmapId: number, osuFile: string) {
  const dir = await mkdtemp(join(tmpdir(), "mania-activity-ln-"));
  dirs.push(dir);
  const db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
  const osu = { getBeatmapFile: vi.fn(async () => osuFile) };
  await computeBeatmapActivitySkillVector(db, osu, { beatmapId });
  return (await exec(
    db,
    "select * from beatmap_skill_vectors where beatmap_id = ? and analysis_version = ?",
    [beatmapId, ACTIVITY_SKILL_ANALYSIS_VERSION],
  )).rows[0];
}

describe("activity LN subtype vectors", () => {
  it("handles fractional mania key counts without fractional note columns", async () => {
    const rightEdgeHolds = Array.from({ length: 32 }, () => [{ column: 6, holdMs: 120 }]);
    const row = await analyzeFixture(100, makeOsu(rightEdgeHolds, 80, { circleSize: 6.8, keyCount: 7 }));

    expect(row.status).toBe("ready");
    expect(JSON.parse(String(row.skills_json))).toMatchObject({ primary: expect.any(String) });
  });

  // The LN axis is the shared pattern analyzer's, not a second scorer living in
  // the activity feature: a chart has to read the same on the activity page as
  // it does on its chart page and in the /maps chips.
  it("carries the shared analyzer's LN scores", async () => {
    const osuFile = makeOsu(
      Array.from({ length: 300 }, (_, index) => [
        { column: index % 7, holdMs: 100 },
        { column: (index + 2) % 7, holdMs: 100 },
        { column: (index + 4) % 7, holdMs: 100 },
      ]),
      120,
    );
    const row = await analyzeFixture(103, osuFile);
    const patterns = JSON.parse(String(row.skills_json)).patterns as Record<string, number>;

    const map = parseManiaBeatmap(osuFile);
    const analysis = analyzeManiaPatterns(map, {
      totalLength: map.totalLength > 0 ? map.totalLength / 1000 : undefined,
      version: map.version,
    });
    const shared = new Map(analysis.allPatterns.map((hit) => [hit.id, hit.score]));
    const ids: Array<[ManiaPatternId, string]> = [
      ["ln", "ln"],
      ["lngeneral", "lnGeneral"],
      ["lnrelease", "lnRelease"],
      ["lninverse", "lnInverse"],
      ["lntech", "lnTech"],
    ];
    for (const [sharedId, activityId] of ids) {
      const score = shared.get(sharedId) ?? 0;
      if (score >= 0.01) expect(patterns[activityId]).toBeCloseTo(score, 5);
      else expect(patterns[activityId]).toBeUndefined();
    }
  });

  it("gives an LN-led chart an LN headline instead of a rice family", async () => {
    const sevenKey = await analyzeFixture(
      104,
      makeOsu(
        Array.from({ length: 300 }, (_, index) => [
          { column: index % 7, holdMs: 100 },
          { column: (index + 2) % 7, holdMs: 100 },
          { column: (index + 4) % 7, holdMs: 100 },
        ]),
        120,
      ),
    );
    expect(String(JSON.parse(String(sevenKey.skills_json)).primary)).toMatch(/^ln/);

    // 4K used to have no LN subtypes at all here, so every 4K LN chart either
    // flattened to "ln" or fell through to a rice family.
    const fourKey = await analyzeFixture(
      105,
      makeOsu(
        Array.from({ length: 300 }, (_, index) => [
          { column: index % 4, holdMs: 100 },
          { column: (index + 2) % 4, holdMs: 100 },
        ]),
        120,
        { keyCount: 4 },
      ),
    );
    const fourKeyVector = JSON.parse(String(fourKey.skills_json));
    expect(String(fourKeyVector.primary)).toMatch(/^ln/);
    expect(fourKeyVector.patterns.lnGeneral).toBeGreaterThan(0);
  });
});
