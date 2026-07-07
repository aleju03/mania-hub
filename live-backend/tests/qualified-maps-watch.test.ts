import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import { ACTIVITY_SKILL_ANALYSIS_VERSION } from "../src/features/activity.js";
import { JobQueue } from "../src/jobs/queue.js";
import type { OsuApiClient } from "../src/osu/client.js";
import { runQualifiedMapsWatch } from "../src/features/qualified-maps-watch.js";

let dir = "";

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = "";
});

async function makeDb(): Promise<Db> {
  dir = await mkdtemp(join(tmpdir(), "mania-qmw-"));
  const db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
  return db;
}

// A pre-existing index row at a given status (the materialized truth /maps shows).
async function seedIndexRow(db: Db, beatmapId: number, beatmapsetId: number, status: string): Promise<void> {
  await exec(
    db,
    `insert into map_search_index (
       beatmap_id, beatmapset_id, analysis_version, title, artist, creator, version,
       search_text, key_count, stars, bpm, length, status, primary_pattern, updated_at)
     values (?, ?, ?, 'T', 'A', 'C', 'Insane', 't', 4, 4.5, 180, 120, ?, 'unknown', '2026-01-01T00:00:00Z')`,
    [beatmapId, beatmapsetId, ACTIVITY_SKILL_ANALYSIS_VERSION, status],
  );
}

function maniaDiff(id: number, setId: number, status: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, beatmapset_id: setId, mode: "mania", convert: false, status,
    difficulty_rating: 4.5, cs: 4, bpm: 180, max_combo: 1000, version: "Insane",
    url: `https://osu.ppy.sh/beatmaps/${id}`, count_sliders: 0, total_length: 120, playcount: 0, passcount: 0,
    ...extra,
  };
}

function set(id: number, status: string, beatmaps: Record<string, unknown>[]): Record<string, unknown> {
  return {
    id, status, title: `Set ${id}`, artist: "A", creator: "C", covers: {},
    last_updated: "2026-07-06T00:00:00Z", beatmaps,
  };
}

async function indexStatus(db: Db, beatmapsetId: number): Promise<string | null> {
  const row = (await exec(db, "select status from map_search_index where beatmapset_id = ? limit 1", [beatmapsetId])).rows[0];
  return row ? String(row.status) : null;
}

async function chartAnalysisTargets(db: Db): Promise<number[]> {
  const rows = (await exec(db, "select payload_json from jobs where type = 'analyze_beatmap_chart'")).rows;
  return rows.map((r) => Number(JSON.parse(String(r.payload_json)).beatmapId)).sort((a, b) => a - b);
}

describe("runQualifiedMapsWatch", () => {
  it("promotes, holds, resolves drop-offs, indexes new sets, and skips converts", async () => {
    const db = await makeDb();
    const queue = new JobQueue(db);

    // What /maps currently shows.
    await seedIndexRow(db, 1000, 100, "pending"); // will be promoted to qualified
    await seedIndexRow(db, 2000, 200, "qualified"); // dropped off the list -> ranks
    await seedIndexRow(db, 2500, 250, "qualified"); // dropped off -> dequalified to pending
    await seedIndexRow(db, 3000, 300, "qualified"); // stays qualified

    const osu = {
      async searchBeatmapsets() {
        return {
          beatmapsets: [
            set(100, "qualified", [maniaDiff(1000, 100, "qualified")]),
            set(300, "qualified", [maniaDiff(3000, 300, "qualified")]),
            // Brand-new set with a native mania diff plus a convert that must be ignored.
            set(400, "qualified", [
              maniaDiff(4000, 400, "qualified"),
              maniaDiff(4001, 400, "qualified", { convert: true }),
            ]),
            // std-only set that happens to match m=3 via a convert: fully skipped.
            set(500, "qualified", [maniaDiff(5000, 500, "qualified", { convert: true })]),
          ],
          cursor_string: null,
        };
      },
      async getBeatmapset(id: number) {
        if (id === 200) return set(200, "ranked", [maniaDiff(2000, 200, "ranked")]);
        if (id === 250) return set(250, "pending", [maniaDiff(2500, 250, "pending")]);
        throw new Error(`unexpected getBeatmapset(${id})`);
      },
    } as unknown as OsuApiClient;

    const result = await runQualifiedMapsWatch(db, osu, queue);

    // Current-list reconciliation.
    expect(await indexStatus(db, 100)).toBe("qualified"); // pending -> qualified
    expect(await indexStatus(db, 300)).toBe("qualified"); // unchanged
    // Drop-off resolution in both directions.
    expect(await indexStatus(db, 200)).toBe("ranked"); // qualified -> ranked
    expect(await indexStatus(db, 250)).toBe("pending"); // qualified -> pending (dequalify)
    // New set has no index row yet (awaits analysis) but its metadata is stored.
    expect(await indexStatus(db, 400)).toBeNull();

    // Metadata carries the fresh status for a future full rebuild (column + json).
    const b1000 = (await exec(db, "select status, metadata_json from beatmaps where beatmap_id = 1000")).rows[0];
    expect(String(b1000.status)).toBe("qualified");
    expect(JSON.parse(String(b1000.metadata_json)).status).toBe("qualified");

    // Analysis is enqueued for every native mania diff currently qualified, and
    // never for converts (4001, 5000).
    expect(await chartAnalysisTargets(db)).toEqual([1000, 3000, 4000]);

    expect(result.qualifiedSets).toBe(3); // 100, 300, 400 (500 had no native mania diff)
    expect(result.resolvedLeft).toBe(2); // 200, 250
    expect(result.maniaDiffs).toBe(3);
  });

  it("drops index rows for a qualified set deleted upstream (404)", async () => {
    const db = await makeDb();
    const queue = new JobQueue(db);
    await seedIndexRow(db, 9000, 900, "qualified");

    const { OsuApiError } = await import("../src/osu/client.js");
    const osu = {
      async searchBeatmapsets() {
        return { beatmapsets: [], cursor_string: null };
      },
      async getBeatmapset() {
        throw new OsuApiError(404, "/beatmapsets/900");
      },
    } as unknown as OsuApiClient;

    await runQualifiedMapsWatch(db, osu, queue);
    expect(await indexStatus(db, 900)).toBeNull();
  });
});
