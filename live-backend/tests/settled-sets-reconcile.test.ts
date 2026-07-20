import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import { ACTIVITY_SKILL_ANALYSIS_VERSION } from "../src/features/activity.js";
import { JobQueue } from "../src/jobs/queue.js";
import type { OsuApiClient } from "../src/osu/client.js";
import { runSettledSetsReconcile } from "../src/features/settled-sets-reconcile.js";

let dir = "";

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = "";
});

async function makeDb(): Promise<Db> {
  dir = await mkdtemp(join(tmpdir(), "mania-ssr-"));
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

// A stored beatmaps row (metadata the deleted-diff stamp must survive on).
async function seedBeatmapRow(db: Db, beatmapId: number, beatmapsetId: number, status: string): Promise<void> {
  await exec(
    db,
    `insert into beatmaps (beatmap_id, beatmapset_id, mode, status, version, metadata_json, updated_at)
     values (?, ?, 'mania', ?, 'Insane', ?, '2026-01-01T00:00:00Z')`,
    [beatmapId, beatmapsetId, status, JSON.stringify({ status, mode: "mania" })],
  );
}

// The settled set-level signal a farmed score already wrote for the maps surface.
async function seedMapsBeatmapset(db: Db, beatmapsetId: number, status: string): Promise<void> {
  await exec(
    db,
    `insert into maps_beatmapsets (beatmapset_id, title, artist, creator, status, updated_at)
     values (?, 'T', 'A', 'C', ?, '2026-01-01T00:00:00Z')`,
    [beatmapsetId, status],
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

async function indexStatuses(db: Db, beatmapsetId: number): Promise<Record<number, string>> {
  const rows = (await exec(db, "select beatmap_id, status from map_search_index where beatmapset_id = ?", [beatmapsetId])).rows;
  return Object.fromEntries(rows.map((r) => [Number(r.beatmap_id), String(r.status)]));
}

describe("runSettledSetsReconcile", () => {
  it("heals stale rows, drops upstream-deleted diffs, and stamps them against rebuilds", async () => {
    const db = await makeDb();
    const queue = new JobQueue(db);

    // Set 100: the revived-then-loved shape. Old diff 1000 was deleted upstream
    // when the set was revived (still graveyard here); 1001 survived and its
    // sibling row already flipped to loved (the candidate signal).
    await seedIndexRow(db, 1000, 100, "graveyard");
    await seedIndexRow(db, 1001, 100, "loved");
    await seedBeatmapRow(db, 1000, 100, "graveyard");

    // Set 200: whole set stale at graveyard, same diff ids upstream; the only
    // settled signal is the maps projection. Must be healed in place, NOT deleted.
    await seedIndexRow(db, 2000, 200, "graveyard");
    await seedMapsBeatmapset(db, 200, "loved");

    // Set 400: graveyard with no settled signal anywhere -> not a candidate,
    // the osu! stub throws if it is ever fetched.
    await seedIndexRow(db, 4000, 400, "graveyard");

    const fetched: number[] = [];
    const osu = {
      async getBeatmapset(id: number) {
        fetched.push(id);
        if (id === 100) return set(100, "loved", [maniaDiff(1001, 100, "loved"), maniaDiff(1002, 100, "loved")]);
        if (id === 200) return set(200, "loved", [maniaDiff(2000, 200, "loved")]);
        throw new Error(`unexpected getBeatmapset(${id})`);
      },
    } as unknown as OsuApiClient;

    const result = await runSettledSetsReconcile(db, osu, queue);
    expect(fetched.sort((a, b) => a - b)).toEqual([100, 200]);

    // Set 100: dead diff dropped, survivor untouched at loved.
    expect(await indexStatuses(db, 100)).toEqual({ 1001: "loved" });
    // The dead diff is stamped so a full index rebuild skips it, while the
    // status column keeps the last real osu! status for stored-score display.
    const dead = (await exec(db, "select status, metadata_json from beatmaps where beatmap_id = 1000")).rows[0];
    expect(String(dead.status)).toBe("graveyard");
    expect(JSON.parse(String(dead.metadata_json)).status).toBe("deleted");

    // Set 200: alive diff healed in place.
    expect(await indexStatuses(db, 200)).toEqual({ 2000: "loved" });
    // Fresh metadata persisted for the alive diff (future rebuilds see loved).
    const alive = (await exec(db, "select status, metadata_json from beatmaps where beatmap_id = 2000")).rows[0];
    expect(String(alive.status)).toBe("loved");
    expect(JSON.parse(String(alive.metadata_json)).status).toBe("loved");
    // Set-level signal reconciled too (kept in agreement with upstream).
    const mb = (await exec(db, "select status from maps_beatmapsets where beatmapset_id = 200")).rows[0];
    expect(String(mb.status)).toBe("loved");

    // Set 400 untouched.
    expect(await indexStatuses(db, 400)).toEqual({ 4000: "graveyard" });

    // The new upstream diff 1002 gets a chart-analysis job so it becomes searchable.
    const targets = (await exec(db, "select payload_json from jobs where type = 'analyze_beatmap_chart'")).rows
      .map((r) => Number(JSON.parse(String(r.payload_json)).beatmapId)).sort((a, b) => a - b);
    expect(targets).toContain(1002);

    expect(result.candidates).toBe(2);
    expect(result.resolved).toBe(2);
    expect(result.deletedRows).toBe(1);

    // Self-terminating: everything now agrees with upstream, second run is a no-op.
    const again = await runSettledSetsReconcile(db, osu, queue);
    expect(again.candidates).toBe(0);
    expect(fetched.sort((a, b) => a - b)).toEqual([100, 200]);
  });

  it("drops all index rows for a set deleted upstream (404)", async () => {
    const db = await makeDb();
    const queue = new JobQueue(db);
    await seedIndexRow(db, 9000, 900, "graveyard");
    await seedIndexRow(db, 9001, 900, "loved");
    await seedBeatmapRow(db, 9000, 900, "graveyard");

    const { OsuApiError } = await import("../src/osu/client.js");
    const osu = {
      async getBeatmapset() {
        throw new OsuApiError(404, "/beatmapsets/900");
      },
    } as unknown as OsuApiClient;

    const result = await runSettledSetsReconcile(db, osu, queue);
    expect(await indexStatuses(db, 900)).toEqual({});
    expect(result.deletedRows).toBe(2);
    const stamped = (await exec(db, "select metadata_json from beatmaps where beatmap_id = 9000")).rows[0];
    expect(JSON.parse(String(stamped.metadata_json)).status).toBe("deleted");
  });
});
