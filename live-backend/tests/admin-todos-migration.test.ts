import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import { createAdminTodo, deleteAdminTodo, listAdminTodos } from "../src/features/admin-todos.js";

// Guards the `position` backfill in migrateAdminTodos: a DB created before the column existed gets
// spaced positions that reproduce the *old* default order (open before done; open by priority then
// newest; done by most-recently-completed) so the board looks identical the first time it loads.
// The regular admin-todos suite can't reach this path because its fresh DBs already have the column.

let dir = "";
let db: Db;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mania-todos-mig-"));
  db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  // Recreate the pre-position schema, then seed rows out of natural order.
  await exec(
    db,
    `create table admin_todos (
       id text primary key,
       title text not null,
       notes text,
       category text not null default 'task',
       priority text not null default 'normal',
       status text not null default 'open',
       created_at integer not null,
       updated_at integer not null,
       done_at integer
     )`,
  );
  const rows: [string, string, string, number, number | null][] = [
    // id, priority, status, created_at, done_at
    ["a", "low", "open", 50, null],
    ["b", "high", "open", 100, null],
    ["c", "normal", "open", 300, null],
    ["d", "high", "open", 200, null],
    ["e", "normal", "done", 0, 500],
    ["f", "normal", "done", 0, 900],
  ];
  for (const [id, priority, status, createdAt, doneAt] of rows) {
    await exec(
      db,
      `insert into admin_todos (id, title, notes, category, priority, status, created_at, updated_at, done_at)
       values (?, ?, null, 'task', ?, ?, ?, ?, ?)`,
      [id, id, priority, status, createdAt, createdAt, doneAt],
    );
  }
});

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("admin todos position backfill", () => {
  it("adds the column and seeds positions matching the old sort", async () => {
    await migrate(db);

    const list = await listAdminTodos(db);
    // Open by priority then newest first (d before b within high), then done by newest completion.
    expect(list.map((t) => t.id)).toEqual(["d", "b", "c", "a", "f", "e"]);
    // Spaced by 1000 and strictly increasing so a later midpoint insert has room.
    expect(list.map((t) => t.position)).toEqual([1000, 2000, 3000, 4000, 5000, 6000]);
  });

  it("numbers pre-existing todos oldest-first, independent of board order", async () => {
    await migrate(db);

    const list = await listAdminTodos(db);
    // created_at asc (e/f share 0, broken by id), so: e=1 f=2 a=3 b=4 d=5 c=6.
    expect(Object.fromEntries(list.map((t) => [t.id, t.seq]))).toEqual({ e: 1, f: 2, a: 3, b: 4, d: 5, c: 6 });
    // A newly added todo continues past the highest backfilled number.
    expect((await createAdminTodo(db, { title: "after backfill" }))!.seq).toBe(7);
  });

  it("does not reuse a backfilled id when the newest todo is removed before anything is created", async () => {
    await migrate(db);

    // The migration has to seed the allocator itself: nothing has been *created* yet, so a counter
    // left absent here would fall back to max(seq) and re-issue #6.
    const list = await listAdminTodos(db);
    const newest = list.find((t) => t.seq === 6)!;
    await deleteAdminTodo(db, newest.id);

    expect((await createAdminTodo(db, { title: "after delete" }))!.seq).toBe(7);
  });

  it("leaves an already-running counter alone", async () => {
    await migrate(db);
    expect((await createAdminTodo(db, { title: "first" }))!.seq).toBe(7);

    // A later boot re-runs the seed; it must not rewind the counter to max(seq).
    await migrate(db);
    expect((await createAdminTodo(db, { title: "second" }))!.seq).toBe(8);
  });

  it("is idempotent: a second migrate leaves positions and ids untouched", async () => {
    await migrate(db);
    const before = (await listAdminTodos(db)).map((t) => [t.id, t.position, t.seq]);
    await migrate(db);
    const after = (await listAdminTodos(db)).map((t) => [t.id, t.position, t.seq]);
    expect(after).toEqual(before);
  });
});
