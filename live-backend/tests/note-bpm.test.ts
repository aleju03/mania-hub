import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import { computeNoteBpm } from "../src/dan/note-bpm.js";
import {
  CHART_ANALYSIS_VERSION,
  NOTE_BPM_RECOMPUTE_JOB,
  ensureNoteBpmRecomputeSeeded,
  readNoteBpms,
  recomputeNoteBpmChunk,
  runNoteBpmRecomputeJob,
} from "../src/features/chart-analysis.js";
import { JobQueue } from "../src/jobs/queue.js";

let dir = "";

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = "";
});

async function makeDb(): Promise<Db> {
  dir = await mkdtemp(join(tmpdir(), "mania-note-bpm-"));
  const db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
  return db;
}

function buildOsuFile(timingPoints: string[], hitObjects: string[]): string {
  return `osu file format v14

[General]
AudioFilename: audio.mp3
Mode: 3

[Metadata]
Title: Note BPM Test
Artist: Test
Creator: Mapper
Version: 4K

[Difficulty]
CircleSize:4
OverallDifficulty:8

[TimingPoints]
${timingPoints.join("\n")}

[HitObjects]
${hitObjects.join("\n")}
`;
}

function notesAt(times: number[]): string[] {
  return times.map((time) => `64,192,${time},1,0,0:0:0:0:`);
}

describe("computeNoteBpm", () => {
  it("reads a constant-BPM chart's tempo", () => {
    // beatLength 300 = 200 BPM.
    const osuText = buildOsuFile(
      ["0,300,4,2,0,100,1,0"],
      notesAt(Array.from({ length: 9 }, (_, i) => i * 150)),
    );
    expect(computeNoteBpm(osuText)).toBe(200);
  });

  it("follows the notes, not the wall clock, on a variable-BPM chart", () => {
    // 120 BPM section holds the first 10 wall-clock seconds but only 3 notes;
    // the 240 BPM section carries 47. The duration-dominant tempo (what the
    // nominal osu! bpm field reports) is 120; the note-weighted tempo is 240.
    // The negative-beatLength inherited point must be ignored.
    const osuText = buildOsuFile(
      ["0,500,4,2,0,100,1,0", "10000,250,4,2,0,100,1,0", "10500,-50,4,2,0,100,0,0"],
      notesAt([0, 1000, 2000, ...Array.from({ length: 47 }, (_, i) => 10000 + i * 125)]),
    );
    expect(computeNoteBpm(osuText)).toBe(240);
  });

  it("applies the first timing point retroactively to earlier notes", () => {
    const osuText = buildOsuFile(
      ["1000,400,4,2,0,100,1,0"],
      notesAt([0, 200, 1000, 1200, 1400]),
    );
    expect(computeNoteBpm(osuText)).toBe(150);
  });

  it("clamps timing-gimmick tempos to the playable band", () => {
    // beatLength 20 = 3000 BPM; clamp caps it at 1200.
    const osuText = buildOsuFile(
      ["0,20,4,2,0,100,1,0"],
      notesAt([0, 100, 200]),
    );
    expect(computeNoteBpm(osuText)).toBe(1200);
  });

  it("returns null without timing points or notes", () => {
    expect(computeNoteBpm(buildOsuFile([], notesAt([0, 100])))).toBe(null);
    expect(computeNoteBpm(buildOsuFile(["0,300,4,2,0,100,1,0"], []))).toBe(null);
  });

  it("folds inflated timing with coarse snaps down to the song tempo (Flandre-S shape)", () => {
    // Timed 666 (beatLength 90.09) with notes on 1/2 snaps: honest sibling
    // timings of the song read 333, inside the (300, 350] target band the /2
    // fold lands in.
    const osuText = buildOsuFile(
      ["0,90.09009,4,2,0,100,1,0"],
      notesAt(Array.from({ length: 40 }, (_, i) => i * 45)),
    );
    expect(computeNoteBpm(osuText)).toBe(333);
  });

  it("keeps dividing while the folded tempo stays implausible", () => {
    // Timed ~799.2 (a 3x upload of a 266.4 song): /2 = 399.6 still exceeds
    // the target band, so the fold lands on /3.
    const osuText = buildOsuFile(
      ["0,75.075,4,2,0,100,1,0"],
      notesAt(Array.from({ length: 40 }, (_, i) => i * 75)),
    );
    expect(computeNoteBpm(osuText)).toBe(266.4);
  });

  it("folds rate-edit chordjack timing by two and collapses chords to rows", () => {
    // Nominal 364 with chords every half beat - the corpus charts of this
    // shape title themselves "182 bpm".
    const rowTimes = Array.from({ length: 40 }, (_, i) => Math.round(i * 82.41758));
    const osuText = buildOsuFile(
      ["0,164.83516,4,2,0,100,1,0"],
      rowTimes.flatMap((time) => [`64,192,${time},1,0,0:0:0:0:`, `192,192,${time},1,0,0:0:0:0:`]),
    );
    expect(computeNoteBpm(osuText)).toBe(182);
  });

  it("keeps genuine speedcore that streams on fine snaps", () => {
    // 320 BPM with 1/4-snap streams (47ms gaps): real stamina content, no fold.
    const osuText = buildOsuFile(
      ["0,187.5,4,2,0,100,1,0"],
      notesAt(Array.from({ length: 40 }, (_, i) => i * 47)),
    );
    expect(computeNoteBpm(osuText)).toBe(320);
  });

  it("keeps the raw tempo when a sparse section has too little snap evidence", () => {
    // 400 BPM but only 5 notes: not enough gaps to call the timing inflated.
    const osuText = buildOsuFile(
      ["0,150,4,2,0,100,1,0"],
      notesAt([0, 300, 600, 900, 1200]),
    );
    expect(computeNoteBpm(osuText)).toBe(400);
  });
});

async function seedAnalyzedChart(
  db: Db,
  beatmapId: number,
  options: { osuText?: string | null; classification?: Record<string, unknown>; status?: string } = {},
): Promise<void> {
  const now = "2026-01-01T00:00:00Z";
  if (options.osuText != null) {
    await exec(
      db,
      "insert into beatmap_osu_files (beatmap_id, content, fetched_at, last_used_at) values (?, ?, ?, ?)",
      [beatmapId, options.osuText, now, now],
    );
  }
  await exec(
    db,
    `insert into beatmap_chart_analysis
       (beatmap_id, analysis_version, status, key_count, classification_json, computed_at, updated_at)
     values (?, ?, ?, 4, ?, ?, ?)`,
    [
      beatmapId,
      CHART_ANALYSIS_VERSION,
      options.status ?? "ready",
      JSON.stringify(options.classification ?? { keyCount: 4, vibro: false }),
      now,
      now,
    ],
  );
}

async function readStoredNoteBpm(db: Db, beatmapId: number): Promise<unknown> {
  const row = (await exec(
    db,
    "select classification_json from beatmap_chart_analysis where beatmap_id = ? and analysis_version = ?",
    [beatmapId, CHART_ANALYSIS_VERSION],
  )).rows[0];
  return JSON.parse(String(row?.classification_json))["noteBpm"];
}

describe("note-BPM recompute sweep", () => {
  it("patches stored classifications from the cached .osu corpus", async () => {
    const db = await makeDb();
    const constantChart = buildOsuFile(["0,300,4,2,0,100,1,0"], notesAt([0, 150, 300, 450, 600]));
    const timingLessChart = buildOsuFile([], notesAt([0, 150]));
    const inflatedChart = buildOsuFile(
      ["0,90.09009,4,2,0,100,1,0"],
      notesAt(Array.from({ length: 40 }, (_, i) => i * 45)),
    );

    await seedAnalyzedChart(db, 1, { osuText: constantChart });
    // Already patched with a plausible value: must not be scanned again.
    await seedAnalyzedChart(db, 2, { osuText: constantChart, classification: { keyCount: 4, noteBpm: 111 } });
    // No cached .osu: skipped, left unpatched.
    await seedAnalyzedChart(db, 3);
    // Unparseable tempo (no timing points): patched with an explicit null.
    await seedAnalyzedChart(db, 4, { osuText: timingLessChart });
    // Not ready: out of the candidate band.
    await seedAnalyzedChart(db, 5, { osuText: constantChart, status: "unavailable" });
    // Stored by an older sweep without the fold: rescanned and re-folded.
    await seedAnalyzedChart(db, 6, { osuText: inflatedChart, classification: { keyCount: 4, noteBpm: 666 } });

    const result = await recomputeNoteBpmChunk(db, 0, 50);
    expect(result.done).toBe(true);
    expect(result.scanned).toBe(4);
    expect(result.patched).toEqual([1, 6]);
    expect(await readStoredNoteBpm(db, 1)).toBe(200);
    expect(await readStoredNoteBpm(db, 2)).toBe(111);
    expect(await readStoredNoteBpm(db, 3)).toBe(undefined);
    expect(await readStoredNoteBpm(db, 4)).toBe(null);
    expect(await readStoredNoteBpm(db, 6)).toBe(333);

    const noteBpms = await readNoteBpms(db, [1, 2, 3, 4, 5, 6]);
    expect(noteBpms.get(1)).toBe(200);
    expect(noteBpms.get(2)).toBe(111);
    expect(noteBpms.has(3)).toBe(false);
    expect(noteBpms.has(4)).toBe(false);
    expect(noteBpms.has(5)).toBe(false);
    expect(noteBpms.get(6)).toBe(333);
  });

  it("runs once: chains chunks, marks itself done, never re-seeds", async () => {
    const db = await makeDb();
    const constantChart = buildOsuFile(["0,300,4,2,0,100,1,0"], notesAt([0, 150, 300]));
    for (let beatmapId = 1; beatmapId <= 3; beatmapId++) {
      await seedAnalyzedChart(db, beatmapId, { osuText: constantChart });
    }
    const queue = new JobQueue(db);

    await ensureNoteBpmRecomputeSeeded(db, queue);
    let [job] = await queue.claim("test-worker", 1);
    expect(job?.type).toBe(NOTE_BPM_RECOMPUTE_JOB);
    while (job) {
      await runNoteBpmRecomputeJob(db, queue, job.payload as { cursor?: number });
      await queue.complete(job.id);
      [job] = await queue.claim("test-worker", 1);
    }
    for (let beatmapId = 1; beatmapId <= 3; beatmapId++) {
      expect(await readStoredNoteBpm(db, beatmapId)).toBe(200);
    }

    // A restart re-runs the boot seed; the done marker must make it a no-op.
    await ensureNoteBpmRecomputeSeeded(db, queue);
    const pending = (await exec(
      db,
      "select count(*) as count from jobs where type = ? and status = 'queued'",
      [NOTE_BPM_RECOMPUTE_JOB],
    )).rows[0];
    expect(Number(pending?.count)).toBe(0);
  });
});
