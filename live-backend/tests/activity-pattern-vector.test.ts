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

function repeatRows(pattern: number[][][], times: number): number[][][] {
  return Array.from({ length: times }).flatMap(() => pattern);
}

function makeOsu(rows: number[][][], intervalMs: number): string {
  const keyCount = 4;
  const hitObjects = rows.flatMap((row, index) => {
    const time = index * intervalMs;
    return row.map((columns) => columns).flat().map((column) => {
      const x = Math.floor(((column + 0.5) * 512) / keyCount);
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
    "Title:Activity pattern fixture",
    "Artist:mania-hub",
    "Creator:test",
    "Version:4K",
    "",
    "[Difficulty]",
    "CircleSize:4",
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
  const dir = await mkdtemp(join(tmpdir(), "mania-activity-patterns-"));
  dirs.push(dir);
  const db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
  const osu = { getBeatmapFile: vi.fn(async () => osuFile) };
  await computeBeatmapActivitySkillVector(db, osu, { beatmapId });
  const row = (await exec(
    db,
    "select skills_json from beatmap_skill_vectors where beatmap_id = ? and analysis_version = ?",
    [beatmapId, ACTIVITY_SKILL_ANALYSIS_VERSION],
  )).rows[0];
  return JSON.parse(String(row.skills_json)) as { primary: string; patterns: Record<string, number> };
}

// Hands alternating with their complement single (hand changes per block):
// the signature 4K hellstream shape that the previous heuristic misread as
// chordjack.
function handstreamRows(): number[][][] {
  const block = (hand: number[], single: number): number[][][] =>
    Array.from({ length: 6 }).flatMap(() => [[hand], [[single]]]);
  return repeatRows([
    ...block([0, 1, 2], 3),
    ...block([1, 2, 3], 0),
    ...block([0, 2, 3], 1),
    ...block([0, 1, 3], 2),
  ], 30);
}

// Dense same-column chords back to back: real chordjack.
function chordjackRows(): number[][][] {
  return repeatRows([
    [[0, 1, 2]], [[0, 1, 3]], [[1, 2, 3]], [[0, 2, 3]],
    [[0, 1, 2]], [[0, 2, 3]], [[0, 1, 3]], [[1, 2, 3]],
  ], 280);
}

// Jumps woven into a stream: jumpstream, not handstream.
function jumpstreamRows(): number[][][] {
  return repeatRows([
    [[0, 1]], [[2]], [[3]], [[2]],
    [[2, 3]], [[1]], [[0]], [[1]],
    [[1, 2]], [[0]], [[3]], [[0]],
    [[0, 3]], [[1]], [[2]], [[1]],
  ], 160);
}

describe("activity pattern vectors", () => {
  it("reads handstream as handstream, not chordjack", async () => {
    const vector = await analyzeFixture(201, makeOsu(handstreamRows(), 85));
    expect(vector.patterns.handstream ?? 0).toBeGreaterThan(vector.patterns.chordjack ?? 0);
    expect(vector.patterns.handstream ?? 0).toBeGreaterThan(0.4);
  });

  it("reads dense repeated chords as chordjack over handstream", async () => {
    const vector = await analyzeFixture(202, makeOsu(chordjackRows(), 150));
    expect(vector.patterns.chordjack ?? 0).toBeGreaterThan(vector.patterns.handstream ?? 0);
    expect(vector.patterns.chordjack ?? 0).toBeGreaterThan(0.4);
  });

  it("splits jumpstream from handstream by chord composition", async () => {
    const vector = await analyzeFixture(203, makeOsu(jumpstreamRows(), 85));
    expect(vector.patterns.jumpstream ?? 0).toBeGreaterThan(vector.patterns.handstream ?? 0);
  });
});
