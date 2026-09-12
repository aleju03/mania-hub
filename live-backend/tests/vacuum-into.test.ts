import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, exec, type Db } from "../src/db.js";
import { REBUILD_SUFFIX, RETIRED_SUFFIX, vacuumIntoAndSwap } from "../src/maintenance/vacuum-into.js";

let dir: string;
let path: string;
let url: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mania-vacuum-into-"));
  path = join(dir, "live.db");
  url = `file:${path}`;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ROWS_KEPT = 100;

// A table with an index, bloated by deleting most of its rows, so the rebuild
// has both free pages to drop and an index to sort.
async function seedBloatedDb(): Promise<Db> {
  const db = await createDb({ databaseUrl: url });
  await exec(db, "create table blobs (id integer primary key, tag text, body blob)");
  await exec(db, "create index blobs_tag on blobs (tag)");
  const chunk = new Uint8Array(4096).fill(7);
  for (let batch = 0; batch < 10; batch++) {
    await db.batch(
      Array.from({ length: 100 }, (_, i) => ({ sql: "insert into blobs (tag, body) values (?, ?)", args: [`t${batch}-${i}`, chunk] })),
      "write",
    );
  }
  await exec(db, "delete from blobs where id % 10 != 0");
  await exec(db, "pragma wal_checkpoint(TRUNCATE)");
  return db;
}

async function fileSize(file: string): Promise<number | null> {
  return stat(file).then((stats) => stats.size, () => null);
}

describe("vacuumIntoAndSwap", () => {
  it("swaps in a smaller rebuilt file, retires the old one, and leaves no stale WAL behind", async () => {
    const db = await seedBloatedDb();
    const lines: string[] = [];
    const result = await vacuumIntoAndSwap(db, url, (line) => lines.push(line));

    expect(result.bytesAfter).toBeLessThan(result.bytesBefore);
    expect(await fileSize(path)).toBe(result.bytesAfter);
    expect(await fileSize(path + RETIRED_SUFFIX)).toBe(result.bytesBefore);
    expect(result.retiredPath).toBe(path + RETIRED_SUFFIX);
    expect(await fileSize(path + REBUILD_SUFFIX)).toBeNull();
    // The retired copy's WAL/shm must not be sitting next to the new file.
    expect(await fileSize(path + "-wal")).toBeNull();
    expect(await fileSize(path + "-shm")).toBeNull();
    expect(lines.some((line) => line.includes("Swapped in"))).toBe(true);

    const reopened = await createDb({ databaseUrl: url });
    try {
      expect(Number((await exec(reopened, "select count(*) as n from blobs")).rows[0]?.n)).toBe(ROWS_KEPT);
      expect(String((await exec(reopened, "pragma journal_mode")).rows[0]?.journal_mode)).toBe("wal");
      expect(String((await exec(reopened, "pragma integrity_check")).rows[0]?.integrity_check)).toBe("ok");
      expect(Number((await exec(reopened, "select count(*) as n from blobs indexed by blobs_tag where tag like 't%'")).rows[0]?.n)).toBe(ROWS_KEPT);
    } finally {
      reopened.close();
    }
  });

  it("refuses to run over an earlier retired copy", async () => {
    const db = await seedBloatedDb();
    await writeFile(path + RETIRED_SUFFIX, "an older retired file");
    try {
      await expect(vacuumIntoAndSwap(db, url, () => {})).rejects.toThrow(/already exists/);
      // Nothing was swapped: the original still answers.
      expect(Number((await exec(db, "select count(*) as n from blobs")).rows[0]?.n)).toBe(ROWS_KEPT);
    } finally {
      db.close();
    }
  });

  it("clears the partial file an interrupted rebuild left behind", async () => {
    const db = await seedBloatedDb();
    await writeFile(path + REBUILD_SUFFIX, "half a database");
    const result = await vacuumIntoAndSwap(db, url, () => {});
    expect(await fileSize(path)).toBe(result.bytesAfter);
    expect(await fileSize(path + REBUILD_SUFFIX)).toBeNull();
  });

  it("only handles file: urls", async () => {
    const db = await seedBloatedDb();
    try {
      await expect(vacuumIntoAndSwap(db, "libsql://somewhere", () => {})).rejects.toThrow(/file: database url/);
    } finally {
      db.close();
    }
  });
});
