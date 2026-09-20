import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import { compressScoreJson } from "../src/maintenance/score-json-compaction.js";
import { migrateScoreJsonStorage } from "../src/maintenance/score-json-schema.js";
import { packJson, unpackJson } from "../src/shared/compressed-json.js";
import { readJsonTextStrict } from "../src/shared/dict-json.js";

let dir: string;
let db: Db;
let writer: Db;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "score-json-compaction-"));
  const databaseUrl = `file:${join(dir, "test.db")}`;
  db = await createDb({ databaseUrl });
  await migrate(db);
  writer = await createDb({ databaseUrl });
});
afterEach(async () => {
  vi.restoreAllMocks(); writer?.close(); db?.close();
  await rm(dir, { recursive: true, force: true });
});
async function seed(id: number, cell: string | Buffer) {
  await exec(db, `insert into user_top_scores (user_id, score_id, position, score_json, pp, refreshed_at)
    values (1, ?, ?, ?, 12.5, 'original')`, [id, id, cell]);
}
describe("lossless score compaction", () => {
  it("preserves exact text, ids and other columns across pages and repeated runs", async () => {
    const original = ' {"id": 1, "beatmap_id": 5, "mods":[{"acronym":"NC"}], "unknown":9007199254740993, "pp":1.2300}\n';
    await seed(1, original);
    await seed(2, packJson({ id: 2, beatmap_id: 6, mods: [] }));
    const before = (await exec(db, "select rowid, user_id, score_id, position, pp, refreshed_at from user_top_scores order by rowid")).rows;
    const result = await compressScoreJson(db, { batchSize: 1 });
    expect(result[0]).toMatchObject({ scanned: 2, compressed: 2, skipped: 0 });
    const rows = (await exec(db, "select score_json, beatmap_id, has_dt from user_top_scores order by rowid")).rows;
    expect(readJsonTextStrict(rows[0].score_json)).toBe(original);
    expect(rows[0]).toMatchObject({ beatmap_id: 5, has_dt: 1 });
    expect(unpackJson(rows[1].score_json, null)).toEqual({ id: 2, beatmap_id: 6, mods: [] });
    expect((await exec(db, "select rowid, user_id, score_id, position, pp, refreshed_at from user_top_scores order by rowid")).rows).toEqual(before);
    expect((await compressScoreJson(db))[0]).toMatchObject({ compressed: 0, alreadyPacked: 2 });
    expect((await exec(db, "pragma integrity_check")).rows[0].integrity_check).toBe("ok");
  });

  it("never overwrites a concurrent replacement, and a later pass picks it up", async () => {
    await seed(1, '{"id":1,"beatmap_id":5,"mods":[]}');
    const updated = '{"id":1,"beatmap_id":9,"mods":[{"acronym":"DT"}]}';
    const execute = db.execute.bind(db);
    let interleaved = false;
    vi.spyOn(db, "execute").mockImplementation(async (statement) => {
      const result = await execute(statement);
      const sql = typeof statement === "string" ? statement : (statement as { sql: string }).sql;
      if (!interleaved && sql.includes("select rowid as cursor, score_json as cell from user_top_scores")) {
        interleaved = true;
        await exec(writer, "update user_top_scores set score_json = ?, refreshed_at = 'newer' where score_id = 1", [updated]);
      }
      return result;
    });
    expect((await compressScoreJson(db))[0]).toMatchObject({ compressed: 0, skipped: 1 });
    expect(interleaved).toBe(true);
    expect((await exec(db, "select score_json from user_top_scores")).rows[0].score_json).toBe(updated);
    expect((await compressScoreJson(db))[0].compressed).toBe(1);
    expect((await exec(db, "select beatmap_id, refreshed_at from user_top_scores")).rows[0]).toEqual({ beatmap_id: 9, refreshed_at: "newer" });
  });

  it("stops on invalid data, preserves the failed row and resumes committed pages", async () => {
    await seed(1, '{"id":1,"mods":[]}');
    await seed(2, 'broken');
    await expect(compressScoreJson(db, { batchSize: 1 })).rejects.toThrow();
    const rows = (await exec(db, "select typeof(score_json) as kind, score_json from user_top_scores order by score_id")).rows;
    expect(rows[0].kind).toBe('blob'); expect(rows[1].score_json).toBe('broken');
    await exec(db, "update user_top_scores set score_json = ? where score_id = 2", ['{"id":2,"mods":[]}']);
    expect((await compressScoreJson(db, { batchSize: 1 }))[0]).toMatchObject({ compressed: 1, alreadyPacked: 1 });
  });

  it("preserves SQLite LIKE semantics for legacy lowercase mod names", async () => {
    await seed(1, '{"id":1,"mods":[{"acronym":"dt"}]}');
    await compressScoreJson(db);
    expect((await exec(db, "select has_dt from user_top_scores")).rows[0].has_dt).toBe(1);
  });

  it("stores restore dictionaries and refuses a changed dictionary at migration", async () => {
    expect((await exec(db, "select length(bytes) as size from codec_dictionaries")).rows[0].size).toBeGreaterThan(20000);
    await exec(db, "update codec_dictionaries set bytes = x'00' where version = 1");
    await expect(migrateScoreJsonStorage(db)).rejects.toThrow(/dictionary/);
  });
});
