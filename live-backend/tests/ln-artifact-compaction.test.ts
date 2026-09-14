import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, exec, type Db } from "../src/db.js";
import { compactLnArtifacts } from "../src/maintenance/ln-artifact-compaction.js";
import { compactMsdForStorage } from "../src/shared/msd-storage.js";

let dir: string;
let db: Db;
let writer: Db;
const tables = {
  map_search_index: ["msd_json", "msd_ln_json"],
  beatmap_chart_analysis: ["msd_json", "msd_dt_json", "msd_ht_json", "msd_ln_json"],
  dan_estimates: ["msd_json"],
  dan_mod_estimates: ["msd_json"],
};
const scalar = { version: 7, eligible: true, rating: 12.345, strain: 6, effectiveRatio: 0.8, effectiveHolds: 200, rate: 1.5, od: 8, scoreGoal: 0.93 };
const retained = { values: { Overall: 15.25, LN: 12.345 }, lnSkill: scalar, vibroAnalysis: { sections: [1, 2] }, futureField: { structure: [42] } };
const bulky = { ...retained, lnSkill: { ...scalar, structure: { detections: Array(128).fill({ objectIds: [1, 2, 3] }) } } };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mania-ln-compaction-"));
  const config = { databaseUrl: `file:${join(dir, "test.db")}` };
  db = await createDb(config);
  writer = await createDb(config);
  for (const [table, columns] of Object.entries(tables)) {
    await exec(db, `create table ${table} (beatmap_id integer, version integer, updated_at text,
      ${columns.map(column => `${column} text`).join(", ")}${table === "map_search_index" ? ", pattern_tags text" : ""})`);
  }
});
afterEach(async () => {
  vi.restoreAllMocks();
  db?.close();
  writer?.close();
  await rm(dir, { recursive: true, force: true });
});

const noPause = async () => {};

describe("LN artifact cleanup", () => {
  it("preserves every non-preview field across tables, rates and versions; is restartable and idempotent", async () => {
    for (const [table, columns] of Object.entries(tables)) {
      for (const version of [1, 2]) {
        await exec(db, `insert into ${table} (beatmap_id, version, updated_at, ${columns.join(", ")}
          ${table === "map_search_index" ? ", pattern_tags" : ""})
          values (123, ?, 'unchanged', ${columns.map(() => "?").join(", ")}${table === "map_search_index" ? ", ' lnshield speedjack lnreverseshield ln '" : ""})`,
        [version, ...columns.map(() => JSON.stringify(bulky))]);
      }
    }
    // Interrupt between committed batches, then resume from the beginning.
    await expect(compactLnArtifacts(db, { batchSize: 1, betweenBatches: async () => { throw new Error("interrupted"); } })).rejects.toThrow("interrupted");
    await compactLnArtifacts(db, { batchSize: 1, betweenBatches: noPause });
    for (const [table, columns] of Object.entries(tables)) {
      const rows = (await exec(db, `select * from ${table} order by version`)).rows;
      expect(rows).toHaveLength(2);
      for (const [index, row] of rows.entries()) {
        expect(row.beatmap_id).toBe(123);
        expect(row.version).toBe(index + 1);
        expect(row.updated_at).toBe("unchanged");
        for (const column of columns) expect(JSON.parse(String(row[column]))).toEqual(retained);
        if (table === "map_search_index") expect(row.pattern_tags).toBe(" speedjack ln ");
      }
    }
    const second = await compactLnArtifacts(db, { batchSize: 1, betweenBatches: noPause });
    expect(second.every(result => result.strippedCells === 0 && result.strippedTags === 0)).toBe(true);
  });

  it("does not overwrite a concurrent refresh or rewrite malformed, null, or already compact JSON", async () => {
    const cells = [JSON.stringify(bulky), null, "{broken", "null", "[]", JSON.stringify(retained, null, 2)];
    for (const [index, cell] of cells.entries()) await exec(db,
      "insert into dan_estimates (beatmap_id, msd_json) values (?, ?)", [index + 1, cell]);
    const newer = { ...bulky, values: { Overall: 99, LN: 55 }, lnSkill: { ...bulky.lnSkill, rating: 55 } };
    const original = db.execute.bind(db);
    let refreshed = false;
    vi.spyOn(db, "execute").mockImplementation(async (statement) => {
      const result = await original(statement);
      const sql = typeof statement === "string" ? statement : (statement as { sql: string }).sql;
      if (!refreshed && sql.startsWith("select rowid as id from dan_estimates")) {
        refreshed = true;
        await exec(writer, "update dan_estimates set msd_json = ?, updated_at = 'new' where beatmap_id = 1", [JSON.stringify(newer)]);
      }
      return result;
    });
    await compactLnArtifacts(db, { batchSize: 2, betweenBatches: noPause });
    expect(refreshed).toBe(true);
    const rows = (await exec(db, "select * from dan_estimates order by beatmap_id")).rows;
    expect(JSON.parse(String(rows[0].msd_json))).toEqual({ ...retained, values: newer.values, lnSkill: { ...scalar, rating: 55 } });
    expect(rows[0].updated_at).toBe("new");
    expect(rows.slice(1).map(row => row.msd_json)).toEqual(cells.slice(1));
  });

  it("prevents a copied legacy rating from restoring a preview", () => {
    expect(JSON.parse(compactMsdForStorage(JSON.stringify(bulky))!)).toEqual(retained);
    for (const cell of [null, "{broken", "null", "[]", JSON.stringify(retained, null, 2)]) {
      expect(compactMsdForStorage(cell)).toBe(cell);
    }
  });
});
