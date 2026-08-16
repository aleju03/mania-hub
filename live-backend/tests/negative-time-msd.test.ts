import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import { computeMsd } from "../src/dan/msd.js";
import {
  CHART_ANALYSIS_JOB,
  CHART_ANALYSIS_VERSION,
  ensureNegativeTimeMsdRecoverySeeded,
} from "../src/features/chart-analysis.js";
import { JobQueue } from "../src/jobs/queue.js";

let dir = "";

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = "";
});

async function makeDb(): Promise<Db> {
  dir = await mkdtemp(join(tmpdir(), "mania-negative-time-msd-"));
  const db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
  return db;
}

// osu! allows notes before the audio leads in; MinaCalc's interval walk
// indexed out of bounds on the negative row times and threw (prod chart
// 4038663, four notes at -1050ms). The harness now shifts such charts to
// start at zero, so the same chart offset anywhere on the clock must rate
// identically.
function chartStartingAt(startMs: number): string {
  const pattern = [0, 1, 2, 3, 1, 3, 0, 2];
  const notes = Array.from({ length: 700 }, (_, index) => {
    const x = 64 + pattern[index % pattern.length] * 128;
    return `${x},192,${startMs + index * 88},1,0,0:0:0:0:`;
  }).join("\n");
  return `osu file format v14

[General]
AudioFilename: audio.mp3
Mode: 3

[Metadata]
Title: Negative Time Test
Artist: Test
Creator: Mapper
Version: 4K

[Difficulty]
CircleSize:4
OverallDifficulty:8

[TimingPoints]
0,352.94,4,2,0,100,1,0

[HitObjects]
${notes}
`;
}

async function seedAnalysisRow(
  db: Db,
  beatmapId: number,
  options: { status?: string; keyCount?: number; msdJson?: string | null; version?: number } = {},
): Promise<void> {
  const now = new Date().toISOString();
  await exec(
    db,
    `insert into beatmap_chart_analysis
       (beatmap_id, analysis_version, status, key_count, msd_json, updated_at)
     values (?, ?, ?, ?, ?, ?)`,
    [
      beatmapId,
      options.version ?? CHART_ANALYSIS_VERSION,
      options.status ?? "ready",
      options.keyCount ?? 4,
      options.msdJson ?? null,
      now,
    ],
  );
}

describe("negative-timestamp MSD", () => {
  it("rates a chart with pre-audio notes instead of crashing, same as its shifted twin", async () => {
    const negative = await computeMsd(chartStartingAt(-1000), { keyCount: 4 });
    const shifted = await computeMsd(chartStartingAt(0), { keyCount: 4 });

    expect(negative).not.toBeNull();
    expect(negative?.values.Overall).toBeGreaterThan(0);
    // The shift preserves every gap, so the row arrays are identical and the
    // ratings must be too.
    expect(negative?.values).toEqual(shifted?.values);
  });

  it("boot heal re-enqueues exactly the ready supported-keymode rows missing MSD, once", async () => {
    const db = await makeDb();
    await seedAnalysisRow(db, 1);
    await seedAnalysisRow(db, 2, { msdJson: JSON.stringify({ values: { Overall: 20 } }) });
    // Unsupported keymodes never run MinaCalc; their null MSD is not a crash.
    await seedAnalysisRow(db, 3, { keyCount: 5 });
    await seedAnalysisRow(db, 4, { status: "unavailable" });
    await seedAnalysisRow(db, 5, { version: CHART_ANALYSIS_VERSION + 1 });
    const queue = new JobQueue(db);

    await ensureNegativeTimeMsdRecoverySeeded(db, queue);
    const jobs = await queue.claim("test-worker", 10);
    expect(jobs.map((job) => job.type)).toEqual([CHART_ANALYSIS_JOB]);
    expect((jobs[0].payload as { beatmapId: number }).beatmapId).toBe(1);
    for (const job of jobs) await queue.complete(job.id);

    const done = (await exec(db, "select 1 from live_meta where key = ?", ["negative_time_msd_recovery_done:v1"])).rows[0];
    expect(done).toBeTruthy();

    // Done key wins even if a matching row appears later: the heal is one-shot.
    await seedAnalysisRow(db, 6);
    await ensureNegativeTimeMsdRecoverySeeded(db, queue);
    expect((await queue.claim("test-worker", 10)).length).toBe(0);
  });
});
