import { randomUUID } from "node:crypto";
import type { Db } from "../db.js";
import { exec } from "../db.js";

// Private owner todo list. This is a single-user admin surface (the site owner) for jotting down
// reminders, bugs found, and things left to do so nothing gets lost. Every endpoint is admin-token
// gated and there is no per-user scoping: there is exactly one owner. Timestamps are epoch ms
// (matching user_goals / pack tables). The table is durable, retention never touches it.

export type TodoCategory = "bug" | "feature" | "idea" | "chore" | "task";
export type TodoPriority = "low" | "normal" | "high";
export type TodoStatus = "open" | "done";

export const TODO_CATEGORIES: readonly TodoCategory[] = ["bug", "feature", "idea", "chore", "task"];
export const TODO_PRIORITIES: readonly TodoPriority[] = ["low", "normal", "high"];
export const TODO_STATUSES: readonly TodoStatus[] = ["open", "done"];

const TITLE_MAX = 500;
const NOTES_MAX = 5000;

export interface AdminTodo {
  id: string;
  title: string;
  notes: string | null;
  category: TodoCategory;
  priority: TodoPriority;
  status: TodoStatus;
  createdAt: number;
  updatedAt: number;
  doneAt: number | null;
}

// Inputs are intentionally loose (unknown): everything is normalized here so the HTTP layer can
// forward a parsed body straight through without re-validating each field.
export interface CreateTodoInput {
  title?: unknown;
  notes?: unknown;
  category?: unknown;
  priority?: unknown;
}

export interface UpdateTodoInput {
  id?: unknown;
  title?: unknown;
  notes?: unknown;
  category?: unknown;
  priority?: unknown;
  status?: unknown;
}

function normalizeCategory(value: unknown): TodoCategory {
  return TODO_CATEGORIES.includes(value as TodoCategory) ? (value as TodoCategory) : "task";
}

function normalizePriority(value: unknown): TodoPriority {
  return TODO_PRIORITIES.includes(value as TodoPriority) ? (value as TodoPriority) : "normal";
}

function normalizeStatus(value: unknown): TodoStatus {
  return TODO_STATUSES.includes(value as TodoStatus) ? (value as TodoStatus) : "open";
}

function normalizeTitle(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, TITLE_MAX) : "";
}

function normalizeNotes(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().slice(0, NOTES_MAX);
  return trimmed.length ? trimmed : null;
}

const SELECT_COLUMNS = "id, title, notes, category, priority, status, created_at, updated_at, done_at";

function rowToTodo(row: Record<string, unknown>): AdminTodo {
  return {
    id: String(row.id),
    title: String(row.title ?? ""),
    notes: row.notes == null ? null : String(row.notes),
    category: normalizeCategory(row.category),
    priority: normalizePriority(row.priority),
    status: normalizeStatus(row.status),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    doneAt: row.done_at == null ? null : Number(row.done_at),
  };
}

const PRIORITY_RANK: Record<TodoPriority, number> = { high: 0, normal: 1, low: 2 };

// Default order for the board: open before done; open items by priority then newest first (a
// freshly added task lands at the top of its band); done items by most-recently-completed. Sorted
// in JS because a personal list never grows past a few hundred rows and the mixed key is clearer
// here than a CASE-heavy ORDER BY.
function sortTodos(todos: AdminTodo[]): AdminTodo[] {
  return todos.slice().sort((a, b) => {
    if (a.status !== b.status) return a.status === "open" ? -1 : 1;
    if (a.status === "done") return (b.doneAt ?? 0) - (a.doneAt ?? 0);
    if (a.priority !== b.priority) return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    return b.createdAt - a.createdAt;
  });
}

export async function listAdminTodos(db: Db): Promise<AdminTodo[]> {
  const result = await exec(db, `select ${SELECT_COLUMNS} from admin_todos`);
  return sortTodos(result.rows.map((row) => rowToTodo(row as Record<string, unknown>)));
}

export async function getAdminTodo(db: Db, id: string): Promise<AdminTodo | null> {
  if (!id) return null;
  const result = await exec(db, `select ${SELECT_COLUMNS} from admin_todos where id = ? limit 1`, [id]);
  const row = result.rows[0];
  return row ? rowToTodo(row as Record<string, unknown>) : null;
}

export async function createAdminTodo(db: Db, input: CreateTodoInput): Promise<AdminTodo | null> {
  const title = normalizeTitle(input.title);
  if (!title) return null;
  const now = Date.now();
  const todo: AdminTodo = {
    id: randomUUID(),
    title,
    notes: normalizeNotes(input.notes),
    category: normalizeCategory(input.category),
    priority: normalizePriority(input.priority),
    status: "open",
    createdAt: now,
    updatedAt: now,
    doneAt: null,
  };
  await exec(
    db,
    `insert into admin_todos (${SELECT_COLUMNS}) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [todo.id, todo.title, todo.notes, todo.category, todo.priority, todo.status, todo.createdAt, todo.updatedAt, todo.doneAt],
  );
  return todo;
}

// Partial update: any field left undefined keeps its stored value, so a "toggle done" only needs to
// send { id, status }. done_at follows the status transition (stamped when flipped to done, cleared
// when reopened).
export async function updateAdminTodo(db: Db, input: UpdateTodoInput): Promise<AdminTodo | null> {
  const id = typeof input.id === "string" ? input.id : "";
  const existing = await getAdminTodo(db, id);
  if (!existing) return null;
  const now = Date.now();

  const title = input.title === undefined ? existing.title : (normalizeTitle(input.title) || existing.title);
  const notes = input.notes === undefined ? existing.notes : normalizeNotes(input.notes);
  const category = input.category === undefined ? existing.category : normalizeCategory(input.category);
  const priority = input.priority === undefined ? existing.priority : normalizePriority(input.priority);
  const status = input.status === undefined ? existing.status : normalizeStatus(input.status);
  let doneAt = existing.doneAt;
  if (status === "done" && existing.status !== "done") doneAt = now;
  else if (status === "open") doneAt = null;

  await exec(
    db,
    `update admin_todos
        set title = ?, notes = ?, category = ?, priority = ?, status = ?, updated_at = ?, done_at = ?
      where id = ?`,
    [title, notes, category, priority, status, now, doneAt, id],
  );
  return { ...existing, title, notes, category, priority, status, updatedAt: now, doneAt };
}

export async function deleteAdminTodo(db: Db, id: string): Promise<boolean> {
  if (!id) return false;
  const result = await exec(db, "delete from admin_todos where id = ?", [id]);
  return (result.rowsAffected ?? 0) > 0;
}

export async function clearDoneAdminTodos(db: Db): Promise<number> {
  const result = await exec(db, "delete from admin_todos where status = 'done'");
  return result.rowsAffected ?? 0;
}
