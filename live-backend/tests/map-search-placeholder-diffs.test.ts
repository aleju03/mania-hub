import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, exec, json, migrate, type Db } from "../src/db.js";
import { ACTIVITY_SKILL_ANALYSIS_VERSION } from "../src/features/activity.js";
import { pruneMapSearchPlaceholderRows, upsertMapSearchIndexRow } from "../src/features/map-search.js";

let dir = "";

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = "";
});

async function makeDb(): Promise<Db> {
  dir = await mkdtemp(join(tmpdir(), "mania-mapsearch-"));
  const db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
  await exec(
    db,
    `insert into beatmapsets (beatmapset_id, title, artist, creator, status, covers_json, metadata_json, updated_at)
     values (1, 'Set', 'Artist', 'Mapper', 'loved', '{}', ?, '2026-01-01T00:00:00Z')`,
    [json({ status: "loved" })],
  );
  return db;
}

// Seed one difficulty (beatmap + a ready skill vector) so upsertMapSearchIndexRow
// has a full source row to materialize. `status` is written to both the column
// and metadata_json.$.status, matching how the ingest path stores it.
async function seedDiff(
  db: Db,
  opts: { beatmapId: number; version: string; stars: number; status: string | null },
): Promise<void> {
  const meta: Record<string, unknown> = { mode: "mania" };
  if (opts.status != null) meta.status = opts.status;
  await exec(
    db,
    `insert into beatmaps (beatmap_id, beatmapset_id, mode, status, cs, difficulty_rating, bpm, max_combo, version, url, metadata_json, updated_at)
     values (?, 1, 'mania', ?, 4, ?, 180, 1000, ?, '', ?, '2026-01-01T00:00:00Z')`,
    [opts.beatmapId, opts.status, opts.stars, opts.version, json(meta)],
  );
  await exec(
    db,
    `insert into beatmap_skill_vectors (beatmap_id, analysis_version, status, skills_json, updated_at)
     values (?, ?, 'ready', '{}', '2026-01-01T00:00:00Z')`,
    [opts.beatmapId, ACTIVITY_SKILL_ANALYSIS_VERSION],
  );
}

async function indexedIds(db: Db): Promise<number[]> {
  const rows = (await exec(db, "select beatmap_id from map_search_index order by beatmap_id")).rows;
  return rows.map((r) => Number(r.beatmap_id));
}

describe("placeholder-diff exclusion (SOURCE_SELECT star floor)", () => {
  it("keeps real diffs but drops sub-0.2* in-flux stubs", async () => {
    const db = await makeDb();
    // Real playable diff -> indexed.
    await seedDiff(db, { beatmapId: 10, version: "Insane", stars: 4.5, status: "pending" });
    // Placeholder "delete" stub inside the loved set -> excluded.
    await seedDiff(db, { beatmapId: 11, version: "00.delete upon download", stars: 0.05, status: "pending" });
    // Non-"delete" sub-0.2 stub (separator diff) -> also excluded by the floor.
    await seedDiff(db, { beatmapId: 12, version: "~", stars: 0.0, status: "graveyard" });
    // Null-status sub-0.2 stub -> treated as graveyard, excluded.
    await seedDiff(db, { beatmapId: 13, version: "asd", stars: 0.1, status: null });

    for (const id of [10, 11, 12, 13]) await upsertMapSearchIndexRow(db, id);

    expect(await indexedIds(db)).toEqual([10]);
  });

  it("never hides a sub-0.2* diff a nominator ranked/loved/qualified", async () => {
    const db = await makeDb();
    // A settled meme diff below the floor must survive (the status guard).
    await seedDiff(db, { beatmapId: 20, version: "Delete", stars: 0.1, status: "loved" });
    await seedDiff(db, { beatmapId: 21, version: "meme", stars: 0.15, status: "ranked" });
    await seedDiff(db, { beatmapId: 22, version: "0", stars: 0.05, status: "qualified" });

    for (const id of [20, 21, 22]) await upsertMapSearchIndexRow(db, id);

    expect(await indexedIds(db)).toEqual([20, 21, 22]);
  });

  it("self-heals: re-touching an already-indexed stub deletes it", async () => {
    const db = await makeDb();
    await seedDiff(db, { beatmapId: 30, version: "Normal", stars: 4.0, status: "pending" });
    await upsertMapSearchIndexRow(db, 30);
    expect(await indexedIds(db)).toEqual([30]);

    // The mapper trims the chart down to an empty stub; the next upsert drops it.
    await exec(db, "update beatmaps set difficulty_rating = 0.0 where beatmap_id = 30");
    await upsertMapSearchIndexRow(db, 30);
    expect(await indexedIds(db)).toEqual([]);
  });
});

describe("pruneMapSearchPlaceholderRows", () => {
  async function insertIndexRow(db: Db, id: number, stars: number, status: string): Promise<void> {
    await exec(
      db,
      `insert into map_search_index (
         beatmap_id, beatmapset_id, analysis_version, title, artist, creator, version,
         search_text, key_count, stars, bpm, length, status, primary_pattern, updated_at)
       values (?, 1, ?, 'T', 'A', 'C', 'V', 't a c v', 4, ?, 180, 60, ?, 'unknown', '2026-01-01T00:00:00Z')`,
      [id, ACTIVITY_SKILL_ANALYSIS_VERSION, stars, status],
    );
  }

  it("removes pre-existing sub-0.2* in-flux rows and is idempotent", async () => {
    const db = await makeDb();
    await insertIndexRow(db, 1, 0.05, "pending"); // stub -> pruned
    await insertIndexRow(db, 2, 0.0, "graveyard"); // stub -> pruned
    await insertIndexRow(db, 3, 4.5, "pending"); // real -> kept
    await insertIndexRow(db, 4, 0.1, "loved"); // settled stub -> kept

    const removed = await pruneMapSearchPlaceholderRows(db);
    expect(removed).toBe(2);
    expect(await indexedIds(db)).toEqual([3, 4]);

    // Second pass is a no-op.
    expect(await pruneMapSearchPlaceholderRows(db)).toBe(0);
  });
});
