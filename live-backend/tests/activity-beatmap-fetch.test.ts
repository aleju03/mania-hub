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

async function createTestDb() {
  const dir = await mkdtemp(join(tmpdir(), "mania-activity-fetch-"));
  dirs.push(dir);
  const db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
  return db;
}

describe("activity beatmap file fetch failures", () => {
  it("stores terminal missing beatmap files as unavailable without throwing", async () => {
    const db = await createTestDb();
    const error = "Failed to fetch .osu file for beatmap 5713398: osu (invalid .osu file); catboy (404)";
    const osu = { getBeatmapFile: vi.fn(async () => { throw new Error(error); }) };

    await expect(computeBeatmapActivitySkillVector(db, osu, { beatmapId: 5713398 })).resolves.toBeUndefined();

    const row = (await exec(
      db,
      "select status, error from beatmap_skill_vectors where beatmap_id = ? and analysis_version = ?",
      [5713398, ACTIVITY_SKILL_ANALYSIS_VERSION],
    )).rows[0];
    expect(row.status).toBe("unavailable");
    expect(row.error).toBe(error);
  });

  it("still throws transient beatmap file fetch failures for retry", async () => {
    const db = await createTestDb();
    const error = "Failed to fetch .osu file for beatmap 123: osu (500); catboy (404)";
    const osu = { getBeatmapFile: vi.fn(async () => { throw new Error(error); }) };

    await expect(computeBeatmapActivitySkillVector(db, osu, { beatmapId: 123 })).rejects.toThrow(error);

    const row = (await exec(
      db,
      "select status, error from beatmap_skill_vectors where beatmap_id = ? and analysis_version = ?",
      [123, ACTIVITY_SKILL_ANALYSIS_VERSION],
    )).rows[0];
    expect(row.status).toBe("failed");
    expect(row.error).toBe(error);
  });
});
