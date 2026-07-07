import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, migrate, type Db } from "../src/db.js";
import {
  clearDoneAdminTodos,
  createAdminTodo,
  deleteAdminTodo,
  getAdminTodo,
  listAdminTodos,
  updateAdminTodo,
} from "../src/features/admin-todos.js";

let dir = "";
let db: Db;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mania-todos-"));
  db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
});

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("admin todos", () => {
  it("creates a todo with defaults and normalized fields", async () => {
    const todo = await createAdminTodo(db, { title: "  fix map search  " });
    expect(todo).not.toBeNull();
    expect(todo!.title).toBe("fix map search");
    expect(todo!.category).toBe("task");
    expect(todo!.priority).toBe("normal");
    expect(todo!.status).toBe("open");
    expect(todo!.notes).toBeNull();
    expect(todo!.doneAt).toBeNull();

    const stored = await getAdminTodo(db, todo!.id);
    expect(stored?.title).toBe("fix map search");
  });

  it("rejects an empty title", async () => {
    expect(await createAdminTodo(db, { title: "   " })).toBeNull();
    expect(await createAdminTodo(db, {})).toBeNull();
    expect(await listAdminTodos(db)).toHaveLength(0);
  });

  it("coerces unknown category / priority to safe defaults and keeps valid ones", async () => {
    const good = await createAdminTodo(db, { title: "a", category: "bug", priority: "high" });
    expect(good!.category).toBe("bug");
    expect(good!.priority).toBe("high");

    const bad = await createAdminTodo(db, { title: "b", category: "nonsense", priority: 5 });
    expect(bad!.category).toBe("task");
    expect(bad!.priority).toBe("normal");
  });

  it("toggles done and back, stamping and clearing done_at", async () => {
    const todo = await createAdminTodo(db, { title: "ship it" });
    const done = await updateAdminTodo(db, { id: todo!.id, status: "done" });
    expect(done!.status).toBe("done");
    expect(done!.doneAt).toBeGreaterThan(0);

    const reopened = await updateAdminTodo(db, { id: todo!.id, status: "open" });
    expect(reopened!.status).toBe("open");
    expect(reopened!.doneAt).toBeNull();
  });

  it("applies partial updates without clobbering untouched fields", async () => {
    const todo = await createAdminTodo(db, { title: "keep me", notes: "context", priority: "low" });
    const updated = await updateAdminTodo(db, { id: todo!.id, priority: "high" });
    expect(updated!.priority).toBe("high");
    expect(updated!.title).toBe("keep me");
    expect(updated!.notes).toBe("context");
  });

  it("keeps the existing title when an update sends a blank one", async () => {
    const todo = await createAdminTodo(db, { title: "original" });
    const updated = await updateAdminTodo(db, { id: todo!.id, title: "   " });
    expect(updated!.title).toBe("original");
  });

  it("returns null when updating a missing todo", async () => {
    expect(await updateAdminTodo(db, { id: "nope", title: "x" })).toBeNull();
  });

  it("orders open before done, open by priority then newest", async () => {
    const low = await createAdminTodo(db, { title: "low", priority: "low" });
    const high = await createAdminTodo(db, { title: "high", priority: "high" });
    const normal = await createAdminTodo(db, { title: "normal", priority: "normal" });
    await updateAdminTodo(db, { id: low!.id, status: "done" });

    const list = await listAdminTodos(db);
    expect(list.map((t) => t.title)).toEqual(["high", "normal", "low"]);
    expect(list[2].status).toBe("done");
    // high (added before normal) still leads its band by priority, normal follows.
    expect(list[0].id).toBe(high!.id);
    expect(list[1].id).toBe(normal!.id);
  });

  it("deletes a single todo and reports whether a row was removed", async () => {
    const todo = await createAdminTodo(db, { title: "gone soon" });
    expect(await deleteAdminTodo(db, todo!.id)).toBe(true);
    expect(await deleteAdminTodo(db, todo!.id)).toBe(false);
    expect(await getAdminTodo(db, todo!.id)).toBeNull();
  });

  it("clears only done todos and returns the count", async () => {
    const a = await createAdminTodo(db, { title: "a" });
    await createAdminTodo(db, { title: "b" });
    await updateAdminTodo(db, { id: a!.id, status: "done" });

    expect(await clearDoneAdminTodos(db)).toBe(1);
    const remaining = await listAdminTodos(db);
    expect(remaining.map((t) => t.title)).toEqual(["b"]);
  });
});
