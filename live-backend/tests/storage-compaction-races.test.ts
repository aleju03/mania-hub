import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, exec, execBatch, migrate, type Db } from "../src/db.js";
import { compactCountryMapsSnapshots } from "../src/features/maps.js";
import { invalidateOsuFileRepairDerivatives } from "../src/features/chart-analysis.js";
import { PLAYER_SKILLS_VERSION, recomputePlayerSkillPoisonChunk, scanStoredPlayerSkillRows } from "../src/features/player-skills.js";
import { JobQueue } from "../src/jobs/queue.js";
import { compressPlayerSkillPlays } from "../src/maintenance/player-skill-compaction.js";
import { packJson, unpackJson } from "../src/shared/compressed-json.js";

let dir: string;
let db: Db;
let writer: Db;
const stamp = "2026-09-11T00:00:00.000Z";
const good = { beatmapId: 11, values: { Stream: 10, Technical: 11, Chordjack: 12 } };
const bad = { beatmapId: 10, values: { Stream: 10, Technical: 10, Chordjack: 10 } };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mania-storage-compaction-"));
  const databaseUrl = `file:${join(dir, "test.db")}`;
  db = await createDb({ databaseUrl });
  await migrate(db);
  writer = await createDb({ databaseUrl });
});

afterEach(async () => {
  vi.restoreAllMocks();
  writer?.close();
  db?.close();
  await rm(dir, { recursive: true, force: true });
});

function snapshot() {
  return {
    schemaVersion: 2, farmed: [], mostPlayed: [], favourites: [],
    favouritesByPlayer: [{ id: 42, beatmapsetIds: [123] }], beatmapsetsPool: [],
    generatedAt: stamp, farmedGeneratedAt: stamp, favouritesGeneratedAt: stamp,
  };
}

async function seedSnapshot(value: unknown) {
  await exec(db, "insert into country_maps_snapshots (country, payload_json, generated_at, refreshed_at) values ('CR', ?, ?, ?)", [JSON.stringify(value), stamp, stamp]);
}

function afterReadOnce(match: string, write: () => Promise<void>) {
  const original = db.execute.bind(db);
  let interleaved = false;
  vi.spyOn(db, "execute").mockImplementation(async (statement) => {
    const result = await original(statement);
    const sql = typeof statement === "string" ? statement : (statement as { sql: string }).sql;
    if (!interleaved && sql.includes(match)) {
      interleaved = true;
      await write();
    }
    return result;
  });
  return () => expect(interleaved).toBe(true);
}

const snapshotSelect = "select country, payload_json, generated_at, refreshed_at from country_maps_snapshots";

async function seedSkills(userId: number, version: number, plays: unknown[], packed = false) {
  const payload = { version, plays };
  await exec(db, `insert into player_skill_ratings (user_id, analysis_version, status, plays_json, updated_at)
    values (?, ?, 'ready', ?, ?)`, [userId, version, packed ? packJson(payload) : JSON.stringify(payload), stamp]);
}

describe("maps snapshot compaction under concurrent writes", () => {
  it.each([false, true])("preserves a concurrent wipe stored as gzip=%s, even with unchanged stamps", async (packed) => {
    await seedSnapshot(snapshot());
    const scrubbed = { ...snapshot(), favouritesByPlayer: [] };
    const assertInterleaved = afterReadOnce(snapshotSelect, async () => {
      await exec(writer, "update country_maps_snapshots set payload_json = ? where country = 'CR'", [packed ? packJson(scrubbed) : JSON.stringify(scrubbed)]);
    });

    expect(await compactCountryMapsSnapshots(db)).toEqual({ scanned: 1, compacted: packed ? 0 : 1, skipped: packed ? 1 : 0 });
    assertInterleaved();
    const row = (await exec(db, "select payload_json, generated_at, refreshed_at from country_maps_snapshots where country='CR'")).rows[0];
    expect(unpackJson(row.payload_json, null)).toEqual(scrubbed);
    expect(row.generated_at).toBe(stamp);
    expect(row.refreshed_at).toBe(stamp);
    expect(row.payload_json).toBeInstanceOf(ArrayBuffer);
  });

  it("does not resurrect a snapshot deleted during conversion", async () => {
    await seedSnapshot(snapshot());
    const assertInterleaved = afterReadOnce(snapshotSelect, async () => {
      await exec(writer, "delete from country_maps_snapshots where country = 'CR'");
    });
    expect(await compactCountryMapsSnapshots(db)).toEqual({ scanned: 1, compacted: 0, skipped: 1 });
    assertInterleaved();
    expect((await exec(db, "select country from country_maps_snapshots")).rows).toHaveLength(0);
  });

  it("also protects a legacy snapshot while converting its schema", async () => {
    await seedSnapshot({ ...snapshot(), schemaVersion: undefined, beatmapsetsPool: {}, favouritesByPlayer: [{ id: 42, username: "Player", avatarUrl: "", beatmapsetIds: [123] }] });
    const freshStamp = "2026-09-12T00:00:00.000Z";
    const fresh = { ...snapshot(), generatedAt: freshStamp, favouritesByPlayer: [] };
    const assertInterleaved = afterReadOnce(snapshotSelect, async () => {
      await exec(writer, "update country_maps_snapshots set payload_json = ?, generated_at = ?, refreshed_at = ? where country = 'CR'", [packJson(fresh), freshStamp, freshStamp]);
    });
    expect(await compactCountryMapsSnapshots(db)).toEqual({ scanned: 1, compacted: 0, skipped: 1 });
    assertInterleaved();
    const row = (await exec(db, "select payload_json, generated_at, refreshed_at from country_maps_snapshots where country='CR'")).rows[0];
    expect(unpackJson(row.payload_json, null)).toEqual(fresh);
    expect(row.generated_at).toBe(freshStamp);
    expect(row.refreshed_at).toBe(freshStamp);
  });

  it("bounds retries when a country changes on every read", async () => {
    await seedSnapshot(snapshot());
    const original = db.execute.bind(db);
    let writes = 0;
    vi.spyOn(db, "execute").mockImplementation(async (statement) => {
      const result = await original(statement);
      const sql = typeof statement === "string" ? statement : (statement as { sql: string }).sql;
      if (sql.includes(snapshotSelect)) {
        await exec(writer, "update country_maps_snapshots set payload_json = ? where country = 'CR'", [JSON.stringify({ ...snapshot(), revision: ++writes })]);
      }
      return result;
    });
    expect(await compactCountryMapsSnapshots(db)).toEqual({ scanned: 1, compacted: 0, skipped: 1 });
    expect(writes).toBe(3);
    const row = (await exec(db, "select payload_json from country_maps_snapshots where country='CR'")).rows[0];
    expect(unpackJson(row.payload_json, null)).toMatchObject({ revision: 3 });
  });
});

describe("player version boundaries", () => {
  it("repairs current evidence when a clean prior version fills the page boundary", async () => {
    await seedSkills(42, PLAYER_SKILLS_VERSION - 1, [good]);
    await seedSkills(42, PLAYER_SKILLS_VERSION, [bad], true);
    await seedSkills(43, PLAYER_SKILLS_VERSION, [bad]);
    const first = await recomputePlayerSkillPoisonChunk(db, 0, 1);
    expect(first).toMatchObject({ nextCursor: 42, cleaned: [42], droppedPlays: 1, done: false });
    const second = await recomputePlayerSkillPoisonChunk(db, first.nextCursor, 1);
    expect(second).toMatchObject({ nextCursor: 43, cleaned: [43], droppedPlays: 1 });
    expect(await recomputePlayerSkillPoisonChunk(db, second.nextCursor, 1)).toMatchObject({ done: true });
    const rows = (await exec(db, "select plays_json from player_skill_ratings order by user_id, analysis_version")).rows;
    expect(rows.map((row) => unpackJson<{ plays: unknown[] }>(row.plays_json, { plays: [] }).plays)).toEqual([[good], [], []]);
  });

  it("applies version filters to both user selection and fetched rows", async () => {
    await seedSkills(1, PLAYER_SKILLS_VERSION - 1, [good]);
    await seedSkills(42, PLAYER_SKILLS_VERSION - 1, [good]);
    await seedSkills(42, PLAYER_SKILLS_VERSION, [bad], true);
    const rows = await scanStoredPlayerSkillRows(db, 0, 1, { sql: "and analysis_version = ?", args: [PLAYER_SKILLS_VERSION] });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: 42, analysisVersion: PLAYER_SKILLS_VERSION, stored: { plays: [bad] } });
  });

  it("purges repaired chart evidence across the 200-row boundary", async () => {
    await execBatch(db, Array.from({ length: 199 }, (_, index) => ({
      sql: "insert into player_skill_ratings (user_id, analysis_version, status, plays_json, updated_at) values (?, ?, 'ready', ?, ?)",
      args: [index + 1, PLAYER_SKILLS_VERSION, packJson({ plays: [good] }), stamp],
    })));
    await seedSkills(200, PLAYER_SKILLS_VERSION - 1, [good]);
    await seedSkills(200, PLAYER_SKILLS_VERSION, [bad, good], true);
    await seedSkills(201, PLAYER_SKILLS_VERSION, [bad], true);
    await invalidateOsuFileRepairDerivatives(db, new JobQueue(db), [bad.beatmapId], { includePlayerSkills: true });
    const rows = (await exec(db, "select user_id, analysis_version, plays_json from player_skill_ratings where user_id >= 200 order by user_id, analysis_version")).rows;
    expect(rows.map((row) => unpackJson<{ plays: unknown[] }>(row.plays_json, { plays: [] }).plays)).toEqual([[good], [good], []]);
  });

  it("compresses every version with one user per page and preserves existing blobs", async () => {
    await seedSkills(42, PLAYER_SKILLS_VERSION - 1, [good]);
    await seedSkills(42, PLAYER_SKILLS_VERSION, [bad]);
    await seedSkills(43, PLAYER_SKILLS_VERSION, [good]);
    await seedSkills(44, PLAYER_SKILLS_VERSION, [good], true);
    const before = (await exec(db, "select plays_json from player_skill_ratings where user_id = 44")).rows[0].plays_json;
    expect(await compressPlayerSkillPlays(db, 1)).toEqual({ scanned: 3, compressed: 3, failed: 0 });
    const rows = (await exec(db, "select plays_json, typeof(plays_json) as kind from player_skill_ratings order by user_id, analysis_version")).rows;
    expect(rows.map((row) => row.kind)).toEqual(["blob", "blob", "blob", "blob"]);
    expect(rows.map((row) => unpackJson<{ plays: unknown[] }>(row.plays_json, { plays: [] }).plays)).toEqual([[good], [bad], [good], [good]]);
    expect(rows[3].plays_json).toEqual(before);
    expect(await compressPlayerSkillPlays(db, 1)).toEqual({ scanned: 0, compressed: 0, failed: 0 });
  });

  it.each([false, true])("preserves a concurrent skill update stored as gzip=%s", async (packed) => {
    await seedSkills(42, PLAYER_SKILLS_VERSION, [bad]);
    const newer = { version: PLAYER_SKILLS_VERSION, plays: [good] };
    const assertInterleaved = afterReadOnce("select plays_json from player_skill_ratings where user_id = ?", async () => {
      await exec(writer, "update player_skill_ratings set plays_json = ? where user_id = 42", [packed ? packJson(newer) : JSON.stringify(newer)]);
    });
    expect(await compressPlayerSkillPlays(db, 1)).toEqual({ scanned: 1, compressed: 0, failed: 0 });
    assertInterleaved();
    const row = (await exec(db, "select plays_json from player_skill_ratings where user_id = 42")).rows[0];
    expect(unpackJson(row.plays_json, null)).toEqual(newer);
  });
});
