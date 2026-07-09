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

  it("orders open before done, newest open on top, and honors manual position", async () => {
    const first = await createAdminTodo(db, { title: "first" });
    await createAdminTodo(db, { title: "second" });
    const third = await createAdminTodo(db, { title: "third" });
    await updateAdminTodo(db, { id: first!.id, status: "done" });

    // Each new task lands at the top of the open list; done drops to the bottom.
    let list = await listAdminTodos(db);
    expect(list.map((t) => t.title)).toEqual(["third", "second", "first"]);
    expect(list[2].status).toBe("done");

    // Dragging "third" below "second" is just a smaller-to-larger position bump.
    const second = list.find((t) => t.title === "second")!;
    await updateAdminTodo(db, { id: third!.id, position: second.position + 1 });
    list = await listAdminTodos(db);
    expect(list.map((t) => t.title)).toEqual(["second", "third", "first"]);
  });

  it("assigns a numeric position and stacks new open todos above older ones", async () => {
    const a = await createAdminTodo(db, { title: "a" });
    const b = await createAdminTodo(db, { title: "b" });
    expect(typeof a!.position).toBe("number");
    expect(b!.position).toBeLessThan(a!.position);
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
