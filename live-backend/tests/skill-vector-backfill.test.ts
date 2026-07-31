import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, exec, json, migrate, type Db } from "../src/db.js";
import { ACTIVITY_SKILL_ANALYSIS_VERSION } from "../src/features/activity.js";
import {
  ensureSkillVectorBackfillSeeded,
  readSkillVectorBackfillProgress,
  runSkillVectorBackfillJob,
  selectSkillVectorBackfillBeatmapIds,
  SKILL_VECTOR_BACKFILL_DONE_META_KEY,
  SKILL_VECTOR_BACKFILL_JOB,
  SKILL_VECTOR_BACKFILL_PROGRESS_META_KEY,
} from "../src/features/skill-vector-backfill.js";
import { JobQueue } from "../src/jobs/queue.js";

let dir = "";
let db: Db;
let queue: JobQueue;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mania-skill-vector-backfill-"));
  db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
  queue = new JobQueue(db);
});

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = "";
});

const VERSION = ACTIVITY_SKILL_ANALYSIS_VERSION;
const NOW = "2026-01-01T00:00:00Z";

// A real 4K chart with enough notes for the pattern analyzer: alternating
// single notes across the columns, the same fixture shape the activity
// pattern-vector tests parse through the actual compute path.
function makeOsuFixture(): string {
  const keyCount = 4;
  const hitObjects = Array.from({ length: 200 }, (_, index) => {
    const column = index % keyCount;
    const x = Math.floor(((column + 0.5) * 512) / keyCount);
    return `${x},192,${index * 150},1,0,0:0:0:0:`;
  });
  return [
    "osu file format v14",
    "",
    "[General]",
    "Mode:3",
    "",
    "[Metadata]",
    "Title:Backfill fixture",
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

async function seedIndexRow(beatmapId: number): Promise<void> {
  await exec(
    db,
    `insert into map_search_index (
       beatmap_id, beatmapset_id, analysis_version, title, artist, creator, version,
       search_text, key_count, stars, bpm, length, status, primary_pattern, updated_at
     ) values (?, ?, ?, 'Title', 'Artist', 'Mapper', '4K', 'title artist mapper 4k', 4, 3.5, 180, 60, 'ranked', 'stream', ?)`,
    [beatmapId, beatmapId * 10, VERSION - 1, NOW],
  );
}

async function seedVector(beatmapId: number, version: number, status: string): Promise<void> {
  await exec(
    db,
    `insert into beatmap_skill_vectors (beatmap_id, analysis_version, status, skills_json, updated_at)
     values (?, ?, ?, ?, ?)`,
    [beatmapId, version, status, status === "ready" ? json({ primary: "stream", patterns: { stream: 1 } }) : null, NOW],
  );
}

// Full source rows so the compute path's incremental search-index upsert has
// something to join against (SOURCE_SELECT requires mania metadata).
async function seedSearchableBeatmap(beatmapId: number): Promise<void> {
  const beatmapsetId = beatmapId * 10;
  await exec(
    db,
    `insert or replace into beatmapsets (beatmapset_id, title, artist, creator, status, covers_json, metadata_json, updated_at)
     values (?, 'Title', 'Artist', 'Mapper', 'ranked', ?, ?, ?)`,
    [beatmapsetId, json({ card: `https://example/${beatmapsetId}.jpg` }), json({ ranked_date: "2020-01-01T00:00:00Z" }), NOW],
  );
  await exec(
    db,
    `insert or replace into beatmaps (beatmap_id, beatmapset_id, mode, status, cs, difficulty_rating, bpm, max_combo, version, url, metadata_json, updated_at)
     values (?, ?, 'mania', 'ranked', 4, 4.5, 180, 1000, '4K', '', ?, ?)`,
    [beatmapId, beatmapsetId, json({ mode: "mania", convert: 0, status: "ranked", playcount: 100, passcount: 10, count_sliders: 0, total_length: 60 }), NOW],
  );
}

interface MockOsuOptions {
  terminalFor?: Set<number>;
  transientFor?: Set<number>;
}

function mockOsu(options: MockOsuOptions = {}) {
  const fetched: number[] = [];
  const fixture = makeOsuFixture();
  return {
    fetched,
    getBeatmapFile: async (beatmapId: number) => {
      fetched.push(beatmapId);
      if (options.terminalFor?.has(beatmapId)) {
        throw new Error(`Failed to fetch .osu file for beatmap ${beatmapId}: osu (invalid .osu file); catboy (404)`);
      }
      if (options.transientFor?.has(beatmapId)) {
        throw new Error(`Failed to fetch .osu file for beatmap ${beatmapId}: osu (500); catboy (503)`);
      }
      return fixture;
    },
  };
}

async function backfillJobRows() {
  return (await exec(db, "select dedupe_key, status, payload_json from jobs where type = ? order by id asc", [SKILL_VECTOR_BACKFILL_JOB])).rows;
}

async function vectorStatus(beatmapId: number): Promise<string | undefined> {
  const row = (await exec(
    db,
    "select status from beatmap_skill_vectors where beatmap_id = ? and analysis_version = ?",
    [beatmapId, VERSION],
  )).rows[0];
  return row ? String(row.status) : undefined;
}

describe("skill vector backfill sweep", () => {
  it("derives the meta keys from the analysis version", () => {
    expect(SKILL_VECTOR_BACKFILL_DONE_META_KEY).toBe(`skill_vector_backfill_done:v${VERSION}`);
    expect(SKILL_VECTOR_BACKFILL_PROGRESS_META_KEY).toBe(`skill_vector_backfill_progress:v${VERSION}`);
  });

  it("selects searchable maps and old-version ready vectors lacking a settled current-version row", async () => {
    await seedIndexRow(1); // searchable, no current-version row: eligible
    await seedIndexRow(2); // searchable but current version ready: skipped
    await seedVector(2, VERSION, "ready");
    await seedIndexRow(3); // searchable but current version unavailable: skipped
    await seedVector(3, VERSION, "unavailable");
    await seedVector(4, VERSION - 1, "ready"); // old ready vector, not searchable: eligible
    await seedVector(5, VERSION - 2, "unavailable"); // old vector not ready: not eligible
    await seedIndexRow(6); // searchable with a stale failed current-version row: still eligible
    await seedVector(6, VERSION, "failed");
    await seedVector(7, VERSION, "ready"); // current version only: nothing to do

    expect(await selectSkillVectorBackfillBeatmapIds(db, 0, 10)).toEqual([1, 4, 6]);
    expect(await selectSkillVectorBackfillBeatmapIds(db, 1, 10)).toEqual([4, 6]);
    expect(await selectSkillVectorBackfillBeatmapIds(db, 6, 10)).toEqual([]);
    expect(await selectSkillVectorBackfillBeatmapIds(db, 0, 2)).toEqual([1, 4]);
  });

  it("computes a chunk through the real compute path, advances the cursor, chains, and writes progress", async () => {
    // 26 eligible maps: one full 25-map chunk plus a remainder.
    for (let beatmapId = 1; beatmapId <= 26; beatmapId += 1) await seedVector(beatmapId, VERSION - 1, "ready");
    const osu = mockOsu();

    const result = await runSkillVectorBackfillJob(db, queue, osu, { cursor: 0 });

    expect(result).toMatchObject({ nextCursor: 25, processed: 25, computed: 25, unavailable: 0, failed: 0, done: false });
    expect(osu.fetched).toHaveLength(25);
    for (let beatmapId = 1; beatmapId <= 25; beatmapId += 1) {
      expect(await vectorStatus(beatmapId)).toBe("ready");
    }
    expect(await vectorStatus(26)).toBeUndefined();
    // Old-version rows stay in place; only the compaction scripts prune them.
    const oldRows = (await exec(db, "select count(*) as count from beatmap_skill_vectors where analysis_version < ?", [VERSION])).rows;
    expect(Number(oldRows[0].count)).toBe(26);

    const jobs = await backfillJobRows();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ dedupe_key: `${SKILL_VECTOR_BACKFILL_JOB}:25`, status: "queued" });
    expect(JSON.parse(String(jobs[0].payload_json))).toMatchObject({ cursor: 25 });

    const progress = await readSkillVectorBackfillProgress(db);
    expect(progress).toMatchObject({ cursor: 25, processed: 25, computed: 25, unavailable: 0, failed: 0 });
    expect(progress.updatedAt).not.toBe("");
  });

  it("marks a terminally unfetchable map unavailable and keeps sweeping the chunk", async () => {
    await seedVector(1, VERSION - 1, "ready");
    await seedVector(2, VERSION - 1, "ready");
    await seedVector(3, VERSION - 1, "ready");
    const osu = mockOsu({ terminalFor: new Set([2]) });

    const result = await runSkillVectorBackfillJob(db, queue, osu, { cursor: 0 });

    expect(result).toMatchObject({ nextCursor: 3, processed: 3, computed: 2, unavailable: 1, failed: 0, done: true });
    expect(await vectorStatus(1)).toBe("ready");
    expect(await vectorStatus(2)).toBe("unavailable");
    expect(await vectorStatus(3)).toBe("ready");
    // The unavailable map is settled: no longer eligible for future passes.
    expect(await selectSkillVectorBackfillBeatmapIds(db, 0, 10)).toEqual([]);
  });

  it("counts a transient per-map failure, leaves it failed, and never stalls the chain", async () => {
    await seedVector(1, VERSION - 1, "ready");
    await seedVector(2, VERSION - 1, "ready");
    await seedVector(3, VERSION - 1, "ready");
    const osu = mockOsu({ transientFor: new Set([2]) });

    const result = await runSkillVectorBackfillJob(db, queue, osu, { cursor: 0 });

    expect(result).toMatchObject({ nextCursor: 3, processed: 3, computed: 2, unavailable: 0, failed: 1, done: true });
    expect(await vectorStatus(2)).toBe("failed");
    const progress = await readSkillVectorBackfillProgress(db);
    expect(progress).toMatchObject({ processed: 3, computed: 2, unavailable: 0, failed: 1 });
  });

  it("writes the versioned done key on completion and never rechains", async () => {
    await seedVector(1, VERSION - 1, "ready");
    await seedVector(2, VERSION - 1, "ready");
    const osu = mockOsu();

    const result = await runSkillVectorBackfillJob(db, queue, osu, { cursor: 0 });

    expect(result).toMatchObject({ processed: 2, computed: 2, done: true });
    const doneRow = (await exec(db, "select value_json from live_meta where key = ?", [SKILL_VECTOR_BACKFILL_DONE_META_KEY])).rows[0];
    expect(doneRow).toBeTruthy();
    const done = JSON.parse(String(doneRow.value_json));
    expect(done).toMatchObject({ processed: 2, computed: 2, unavailable: 0, failed: 0 });
    expect(typeof done.finishedAt).toBe("string");
    expect(await backfillJobRows()).toHaveLength(0);
  });

  it("finishes immediately when nothing is eligible", async () => {
    const result = await runSkillVectorBackfillJob(db, queue, mockOsu(), { cursor: 0 });
    expect(result).toMatchObject({ processed: 0, done: true });
    expect((await exec(db, "select 1 from live_meta where key = ?", [SKILL_VECTOR_BACKFILL_DONE_META_KEY])).rows).toHaveLength(1);
    expect(await backfillJobRows()).toHaveLength(0);
  });

  it("flows a newly computed vector into map_search_index at the current version", async () => {
    await seedSearchableBeatmap(1);
    await seedIndexRow(1); // stale row built from the previous version's vector
    const osu = mockOsu();

    await runSkillVectorBackfillJob(db, queue, osu, { cursor: 0 });

    expect(await vectorStatus(1)).toBe("ready");
    const indexRow = (await exec(db, "select analysis_version, primary_pattern from map_search_index where beatmap_id = 1")).rows[0];
    expect(indexRow).toBeTruthy();
    expect(Number(indexRow.analysis_version)).toBe(VERSION);
    expect(String(indexRow.primary_pattern)).not.toBe("");
  });

  it("seeds once at boot, resumes from stored progress, and schedules nothing once done", async () => {
    await seedIndexRow(1);

    // No done key, no pending link: seed at cursor 0.
    await ensureSkillVectorBackfillSeeded(db, queue);
    let jobs = await backfillJobRows();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ dedupe_key: `${SKILL_VECTOR_BACKFILL_JOB}:0`, status: "queued" });

    // A pending link means a second boot must not add another chain.
    await ensureSkillVectorBackfillSeeded(db, queue);
    expect(await backfillJobRows()).toHaveLength(1);

    // A dead chain resumes from the persisted progress cursor, not from 0.
    await exec(db, "delete from jobs where type = ?", [SKILL_VECTOR_BACKFILL_JOB]);
    await exec(
      db,
      "insert or replace into live_meta (key, value_json, updated_at) values (?, ?, ?)",
      [SKILL_VECTOR_BACKFILL_PROGRESS_META_KEY, JSON.stringify({ cursor: 42, processed: 10, computed: 9, unavailable: 1, failed: 0, updatedAt: NOW }), NOW],
    );
    await ensureSkillVectorBackfillSeeded(db, queue);
    jobs = await backfillJobRows();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ dedupe_key: `${SKILL_VECTOR_BACKFILL_JOB}:42` });
    expect(JSON.parse(String(jobs[0].payload_json))).toMatchObject({ cursor: 42 });

    // Done key present: boots schedule nothing, ever.
    await exec(db, "delete from jobs where type = ?", [SKILL_VECTOR_BACKFILL_JOB]);
    await exec(
      db,
      "insert or replace into live_meta (key, value_json, updated_at) values (?, ?, ?)",
      [SKILL_VECTOR_BACKFILL_DONE_META_KEY, JSON.stringify({ finishedAt: NOW, processed: 10, computed: 9, unavailable: 1, failed: 0 }), NOW],
    );
    await ensureSkillVectorBackfillSeeded(db, queue);
    expect(await backfillJobRows()).toHaveLength(0);
  });
});
