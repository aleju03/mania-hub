import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDb, exec, execBatch, migrate, withWriteTurn, type Db } from "../src/db.js";
import { createCoalescedDb, createInlineWriteExecutor, runWriteGroups, WriteCoalescer } from "../src/write-coalescer.js";

// The coalescer over a real libsql file: merged flushes commit, a failing
// group is isolated from its neighbours, and results come back in libsql's
// row shape.
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  dirs.length = 0;
});

async function setup(): Promise<{ raw: Db; write: Db; reader: Db }> {
  const dir = await mkdtemp(join(tmpdir(), "mania-write-coalescer-"));
  dirs.push(dir);
  const databaseUrl = `file:${join(dir, "test.db")}`;
  const raw = await createDb({ databaseUrl });
  await migrate(raw);
  await exec(raw, "create table if not exists t (id integer primary key, v text not null unique)");
  const reader = await createDb({ databaseUrl });
  const write = createCoalescedDb(new WriteCoalescer(createInlineWriteExecutor(raw)));
  return { raw, write, reader };
}

describe("write coalescer over sqlite", () => {
  it("commits a merged flush and reports each statement's own result", async () => {
    const { write, reader } = await setup();
    const [a, b, c] = await Promise.all([
      exec(write, "insert into t (v) values (?)", ["a"]),
      exec(write, "insert into t (v) values (?)", ["b"]),
      execBatch(write, [{ sql: "insert into t (v) values (?)", args: ["c1"] }, { sql: "insert into t (v) values (?)", args: ["c2"] }]),
    ]);
    expect(Number(a.lastInsertRowid)).toBe(1);
    expect(Number(b.lastInsertRowid)).toBe(2);
    expect(c.map((r) => Number(r.lastInsertRowid))).toEqual([3, 4]);
    const rows = (await exec(reader, "select v from t order by id")).rows.map((row) => row.v);
    expect(rows).toEqual(["a", "b", "c1", "c2"]);
  });

  it("isolates a failing group so its neighbours still land", async () => {
    const { write, reader } = await setup();
    await exec(write, "insert into t (v) values (?)", ["taken"]);
    const outcomes = await Promise.allSettled([
      exec(write, "insert into t (v) values (?)", ["x"]),
      exec(write, "insert into t (v) values (?)", ["taken"]),
      execBatch(write, [{ sql: "insert into t (v) values (?)", args: ["y1"] }, { sql: "insert into t (v) values (?)", args: ["taken"] }]),
      exec(write, "insert into t (v) values (?)", ["z"]),
    ]);
    expect(outcomes.map((o) => o.status)).toEqual(["fulfilled", "rejected", "rejected", "fulfilled"]);
    const rows = (await exec(reader, "select v from t order by id")).rows.map((row) => row.v);
    // The atomic batch lost y1 with its failing sibling; x and z survived.
    expect(rows).toEqual(["taken", "x", "z"]);
  });

  it("hands a write turn the connection immediately, reads included", async () => {
    const { write } = await setup();
    const seen = await withWriteTurn(write, async () => {
      await exec(write, "insert into t (v) values (?)", ["turn"]);
      return (await exec(write, "select count(*) as n from t")).rows[0].n;
    });
    expect(Number(seen)).toBe(1);
  });

  it("runWriteGroups: a busy BEGIN fails every group without re-running them alone", async () => {
    const { raw } = await setup();
    // Hold the write lock on another connection for the duration.
    const holder = await createDb({ databaseUrl: `file:${dirs[0]}/test.db`, sqliteBusyTimeoutMs: 0 });
    await holder.execute("begin immediate");
    const busyDb = await createDb({ databaseUrl: `file:${dirs[0]}/test.db`, sqliteBusyTimeoutMs: 0 });
    const result = await runWriteGroups(busyDb, [
      { statements: [{ sql: "insert into t (v) values ('p')", args: [] }], mode: "write" },
      { statements: [{ sql: "insert into t (v) values ('q')", args: [] }], mode: "write" },
    ]);
    await holder.execute("rollback");
    expect(result.outcomes.every((o) => !o.ok && /busy|locked/i.test(o.error.message))).toBe(true);
    expect(result.poisoned).toBe(true);
    expect(Number((await exec(raw, "select count(*) as n from t")).rows[0].n)).toBe(0);
  });
});
