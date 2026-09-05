import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createDb, RECONNECT, type Db } from "../src/db.js";
import { createInlineWriteExecutor, runWriteGroups, type WriteGroup } from "../src/write-coalescer.js";

it.each(["single", "batch", "merged"])("commits durably after a contended %s flush without retaining the write lock", async (shape) => {
  const dir = await mkdtemp(join(tmpdir(), "mania-coalescer-contention-"));
  const config = { databaseUrl: `file:${join(dir, "test.db")}`, sqliteBusyTimeoutMs: 0 };
  const connections: Db[] = [];
  try {
    const writer = await createDb(config);
    connections.push(writer);
    await writer.execute("create table t (id integer primary key)");
    const holder = await createDb(config);
    connections.push(holder);
    const observer = await createDb(config);
    connections.push(observer);
    const execute = createInlineWriteExecutor(writer);
    const statement = (id: number) => ({ sql: "insert into t values (?)", args: [id] });
    const groups: WriteGroup[] = shape === "single"
      ? [{ statements: [statement(1)], mode: "write" }]
      : shape === "batch"
        ? [{ statements: [statement(1), statement(2)], mode: "write" }]
        : [{ statements: [statement(1)], mode: "write" }, { statements: [statement(2)], mode: "write" }];

    await holder.execute("begin immediate");
    const refused = await execute(groups);
    expect(refused.every((outcome) => !outcome.ok && /busy|locked/i.test(outcome.error.message))).toBe(true);
    await holder.execute("rollback");

    const retried = await execute(groups);
    expect(retried.every((outcome) => outcome.ok)).toBe(true);
    // A successful result is insufficient: the old writer could acknowledge
    // a write visible only inside its leaked transaction, blocking all peers.
    expect((await observer.execute("select * from t")).rows).toHaveLength(shape === "single" ? 1 : 2);
    await holder.execute("insert into t values (3)");
    writer.close();
    expect((await observer.execute("select * from t")).rows).toHaveLength(shape === "single" ? 2 : 3);
  } finally {
    for (const db of connections) db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

const emptyResult = { columns: [], columnTypes: [], rows: [], rowsAffected: 0, lastInsertRowid: undefined };
const group = (sql: string): WriteGroup => ({ mode: "write", statements: [{ sql, args: [] }] });

it("stops isolation at a busy group while preserving groups that already committed", async () => {
  let failures = 0;
  const statements: string[] = [];
  const db = { execute: async (statement: string | { sql: string }) => {
    const sql = typeof statement === "string" ? statement : statement.sql;
    statements.push(sql);
    if (sql === "second") {
      failures += 1;
      throw new Error(failures === 1 ? "SQLITE_CONSTRAINT: unique" : "SQLITE_BUSY: database is locked");
    }
    return emptyResult;
  } } as unknown as Db;
  const result = await runWriteGroups(db, [group("first"), group("second"), group("third")]);
  expect(result.poisoned).toBe(true);
  expect(result.outcomes.map((outcome) => outcome.ok)).toEqual([true, false, false]);
  expect(statements).toEqual(["begin immediate", "first", "second", "rollback", "first", "second"]);
});

it("does not isolate a busy merged transaction even if rollback reports success", async () => {
  const statements: string[] = [];
  const db = { execute: async (statement: string | { sql: string }) => {
    const sql = typeof statement === "string" ? statement : statement.sql;
    statements.push(sql);
    if (sql === "second") throw new Error("SQLITE_BUSY: cannot commit transaction - SQL statements in progress");
    return emptyResult;
  } } as unknown as Db;
  const result = await runWriteGroups(db, [group("first"), group("second"), group("third")]);
  expect(result.poisoned).toBe(true);
  expect(result.outcomes.every((outcome) => !outcome.ok)).toBe(true);
  expect(statements).toEqual(["begin immediate", "first", "second", "rollback"]);
});

it("closes the damaged connection if recovery cannot replace it", async () => {
  const close = vi.fn();
  const reconnect = vi.fn(async () => false);
  const db = {
    execute: async () => { throw new Error("SQLITE_BUSY: database is locked"); },
    [RECONNECT]: reconnect,
    close,
  } as unknown as Db;
  const result = await createInlineWriteExecutor(db)([group("first")]);
  expect(result[0].ok).toBe(false);
  expect(reconnect).toHaveBeenCalledWith("batch");
  expect(close).toHaveBeenCalledOnce();
});
