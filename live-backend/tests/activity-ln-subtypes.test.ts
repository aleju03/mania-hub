import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDb, exec, migrate } from "../src/db.js";
import { ACTIVITY_SKILL_ANALYSIS_VERSION, computeBeatmapActivitySkillVector } from "../src/features/activity.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  dirs.length = 0;
});

function repeatRows<T>(pattern: T[][], times: number): T[][] {
  return Array.from({ length: times }).flatMap(() => pattern);
}

function makeOsu(rows: Array<Array<number | { column: number; holdMs?: number }>>, intervalMs: number): string {
  const keyCount = 7;
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
    "CircleSize:7",
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
  it("stores the strongest 7K LN subtype score", async () => {
    const releaseRows = Array.from({ length: 7 * 36 }, (_, index) => [
      { column: index % 7, holdMs: 45 },
      { column: (index + 3) % 7, holdMs: 45 },
    ]);
    const techRows = repeatRows<number | { column: number; holdMs?: number }>([
      [{ column: 0, holdMs: 110 }, 4],
      [{ column: 2, holdMs: 55 }, { column: 5, holdMs: 55 }],
      [{ column: 1, holdMs: 110 }, 6],
      [{ column: 3, holdMs: 55 }, { column: 4, holdMs: 55 }],
      [{ column: 0, holdMs: 165 }, { column: 2, holdMs: 165 }, 5],
      [{ column: 1, holdMs: 55 }, { column: 6, holdMs: 55 }],
    ], 34);

    const release = await analyzeFixture(101, makeOsu(releaseRows, 60));
    expect(Number(release.ln_release_score)).toBeGreaterThan(0.5);
    expect(Number(release.ln_release_score)).toBeGreaterThan(Number(release.ln_tech_score));

    const tech = await analyzeFixture(102, makeOsu(techRows, 55));
    expect(Number(tech.ln_tech_score)).toBeGreaterThan(0.5);
    expect(Number(tech.ln_tech_score)).toBeGreaterThan(Number(tech.ln_release_score));
  });
});
