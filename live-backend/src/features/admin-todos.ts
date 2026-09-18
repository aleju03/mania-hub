import { randomUUID } from "node:crypto";
import type { Db } from "../db.js";
import { exec } from "../db.js";

// Private owner todo list. This is a single-user admin surface (the site owner) for jotting down
// reminders, bugs found, and things left to do so nothing gets lost. Every endpoint is admin-token
// gated and there is no per-user scoping: there is exactly one owner. Timestamps are epoch ms
// (matching user_goals / pack tables). The table is durable, retention never touches it.
//
// A task is open (on the board), hold (parked, off the board but not finished) or done.

export type TodoCategory = "bug" | "feature" | "idea" | "chore" | "task";
export type TodoPriority = "low" | "normal" | "high";
// "hold" is a task the owner has parked: still on the list, deliberately not on the board. It is
// not a completed task (nothing scores it, "Clear results" leaves it alone) and not an open one
// (it does not sit in a lane or the queue).
export type TodoStatus = "open" | "hold" | "done";
// Groups are the owner's own buckets ("LN work", "before the release") laid over the fixed
// categories: a task belongs to at most one, and the colour is what makes a group readable at a
// glance on the board. The palette is fixed so both sides paint the same chip.
export type TodoGroupColor = "pink" | "blue" | "green" | "yellow" | "purple" | "red" | "orange";

export const TODO_GROUP_COLORS: readonly TodoGroupColor[] = ["pink", "blue", "green", "yellow", "purple", "red", "orange"];

export const TODO_CATEGORIES: readonly TodoCategory[] = ["bug", "feature", "idea", "chore", "task"];
export const TODO_PRIORITIES: readonly TodoPriority[] = ["low", "normal", "high"];
export const TODO_STATUSES: readonly TodoStatus[] = ["open", "hold", "done"];

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
  // Manual drag-to-reorder key for the open list; lower sorts higher. Spaced by POSITION_STEP so a
  // reorder can drop an item at the midpoint of its two new neighbours without renumbering the rest.
  position: number;
  // Short handle the owner quotes to point at a task ("#7"). Allocated once, never reused: a
  // deleted task leaves a gap so an id always refers to the same thing.
  seq: number;
  // Owner-defined group, or null for ungrouped. Deleting a group ungroups its members.
  groupId: string | null;
}

export interface AdminTodoGroup {
  id: string;
  name: string;
  color: TodoGroupColor;
  createdAt: number;
  // Order the chips are listed in; new groups land at the end.
  position: number;
}

const GROUP_NAME_MAX = 60;

const POSITION_STEP = 1000;

// The `seq` high-water mark, kept in live_meta rather than derived from max(seq) so that deleting
// (or clearing) the newest task never hands its number to the next one. Ids are quoted in
// conversation and outlive the row, so reuse would silently point an old reference at a new task.
const SEQ_COUNTER_KEY = "admin_todos_seq";

async function allocateTodoSeq(db: Db): Promise<number> {
  const row = (await exec(db, "select value_json from live_meta where key = ?", [SEQ_COUNTER_KEY])).rows[0];
  const stored = row?.value_json == null ? NaN : Number(row.value_json);
  // The table's high-water mark seeds the counter the first time a todo is created after the
  // backfill migration, and backstops a live_meta row that somehow went missing.
  const maxRow = await exec(db, "select max(seq) as max_seq from admin_todos");
  const highWater = Number(maxRow.rows[0]?.max_seq ?? 0);
  const next = Math.max(Number.isFinite(stored) ? stored : 0, Number.isFinite(highWater) ? highWater : 0) + 1;
  await exec(
    db,
    "insert or replace into live_meta (key, value_json, updated_at) values (?, ?, ?)",
    [SEQ_COUNTER_KEY, JSON.stringify(next), new Date().toISOString()],
  );
  return next;
}

// Inputs are intentionally loose (unknown): everything is normalized here so the HTTP layer can
// forward a parsed body straight through without re-validating each field.
export interface CreateTodoInput {
  title?: unknown;
  notes?: unknown;
  category?: unknown;
  priority?: unknown;
  groupId?: unknown;
}

export interface UpdateTodoInput {
  id?: unknown;
  title?: unknown;
  notes?: unknown;
  category?: unknown;
  priority?: unknown;
  status?: unknown;
  position?: unknown;
  // null clears the group; undefined leaves it alone (partial update, like every other field).
  groupId?: unknown;
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

function normalizePosition(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeGroupColor(value: unknown): TodoGroupColor {
  return TODO_GROUP_COLORS.includes(value as TodoGroupColor) ? (value as TodoGroupColor) : "pink";
}

function normalizeGroupName(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, GROUP_NAME_MAX) : "";
}

/** A group id, or null for "no group". An unknown id is not rejected here; the caller checks. */
function normalizeGroupId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

const SELECT_COLUMNS = "id, title, notes, category, priority, status, created_at, updated_at, done_at, position, seq, group_id";

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
    position: Number(row.position ?? 0),
    seq: Number(row.seq ?? 0),
    groupId: row.group_id == null ? null : String(row.group_id),
  };
}

function rowToGroup(row: Record<string, unknown>): AdminTodoGroup {
  return {
    id: String(row.id),
    name: String(row.name ?? ""),
    color: normalizeGroupColor(row.color),
    createdAt: Number(row.created_at ?? 0),
    position: Number(row.position ?? 0),
  };
}

// Board order: open, then held, then done; open items follow the owner's manual drag order
// (position asc, newest first as a tiebreak); held items by most-recently-parked; done items by
// most-recently-completed. Sorted in JS because a personal list never grows past a few hundred
// rows and the mixed key is clearer here than a CASE-heavy ORDER BY.
const STATUS_ORDER: Record<TodoStatus, number> = { open: 0, hold: 1, done: 2 };

function sortTodos(todos: AdminTodo[]): AdminTodo[] {
  return todos.slice().sort((a, b) => {
    if (a.status !== b.status) return STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    if (a.status === "done") return (b.doneAt ?? 0) - (a.doneAt ?? 0);
    if (a.status === "hold") return b.updatedAt - a.updatedAt;
    if (a.position !== b.position) return a.position - b.position;
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
  // A freshly added task lands at the very top of the open list (one step above the current minimum)
  // so it's the first thing you see; drag it wherever it belongs afterwards.
  // Held rows count too: they keep their position while parked, so a new task must not be given
  // one a resumed task would later reappear on.
  const minRow = await exec(db, "select min(position) as min_pos from admin_todos where status != 'done'");
  const minPos = minRow.rows[0]?.min_pos;
  const position = minPos == null ? 0 : Number(minPos) - POSITION_STEP;
  const seq = await allocateTodoSeq(db);
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
    position,
    seq,
    groupId: normalizeGroupId(input.groupId),
  };
  await exec(
    db,
    `insert into admin_todos (${SELECT_COLUMNS}) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [todo.id, todo.title, todo.notes, todo.category, todo.priority, todo.status, todo.createdAt, todo.updatedAt, todo.doneAt, todo.position, todo.seq, todo.groupId],
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
  const position = input.position === undefined ? existing.position : normalizePosition(input.position, existing.position);
  const groupId = input.groupId === undefined ? existing.groupId : normalizeGroupId(input.groupId);
  // A held task keeps its position, so resuming it drops it back where it was in the order.
  let doneAt = existing.doneAt;
  if (status === "done") {
    if (existing.status !== "done") doneAt = now;
  } else {
    doneAt = null;
  }

  await exec(
    db,
    `update admin_todos
        set title = ?, notes = ?, category = ?, priority = ?, status = ?, updated_at = ?, done_at = ?, position = ?, group_id = ?
      where id = ?`,
    [title, notes, category, priority, status, now, doneAt, position, groupId, id],
  );
  return { ...existing, title, notes, category, priority, status, updatedAt: now, doneAt, position, groupId };
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

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

export async function listAdminTodoGroups(db: Db): Promise<AdminTodoGroup[]> {
  const result = await exec(db, "select id, name, color, created_at, position from admin_todo_groups order by position asc, created_at asc");
  return result.rows.map((row) => rowToGroup(row as Record<string, unknown>));
}

export interface SaveTodoGroupInput {
  id?: unknown;
  name?: unknown;
  color?: unknown;
}

/** Creates a group, or renames/recolors an existing one when `id` names one. Null on an empty name. */
export async function saveAdminTodoGroup(db: Db, input: SaveTodoGroupInput): Promise<AdminTodoGroup | null> {
  const name = normalizeGroupName(input.name);
  if (!name) return null;
  const color = normalizeGroupColor(input.color);
  const id = typeof input.id === "string" && input.id ? input.id : null;

  if (id) {
    const existing = (await exec(db, "select id, name, color, created_at, position from admin_todo_groups where id = ? limit 1", [id])).rows[0];
    if (!existing) return null;
    await exec(db, "update admin_todo_groups set name = ?, color = ? where id = ?", [name, color, id]);
    return { ...rowToGroup(existing as Record<string, unknown>), name, color };
  }

  const maxRow = await exec(db, "select max(position) as max_pos from admin_todo_groups");
  const maxPos = maxRow.rows[0]?.max_pos;
  const group: AdminTodoGroup = {
    id: randomUUID(),
    name,
    color,
    createdAt: Date.now(),
    position: maxPos == null ? 0 : Number(maxPos) + 1,
  };
  await exec(
    db,
    "insert into admin_todo_groups (id, name, color, created_at, position) values (?, ?, ?, ?, ?)",
    [group.id, group.name, group.color, group.createdAt, group.position],
  );
  return group;
}

/** Deleting a group ungroups its tasks; it never deletes the tasks themselves. */
export async function deleteAdminTodoGroup(db: Db, id: string): Promise<boolean> {
  if (!id) return false;
  const result = await exec(db, "delete from admin_todo_groups where id = ?", [id]);
  if ((result.rowsAffected ?? 0) === 0) return false;
  await exec(db, "update admin_todos set group_id = null, updated_at = ? where group_id = ?", [Date.now(), id]);
  return true;
}

/**
 * Puts every named task in `groupId` (null = ungroup) in one go, which is what a marquee selection
 * on the board turns into. Unknown ids are skipped; an unknown group id is treated as ungroup so a
 * group deleted in another tab can't strand rows pointing at nothing.
 */
export async function assignAdminTodosToGroup(db: Db, ids: unknown, groupId: unknown): Promise<AdminTodo[]> {
  const list = Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string" && id.length > 0) : [];
  if (list.length === 0) return [];
  let target = normalizeGroupId(groupId);
  if (target) {
    const known = (await exec(db, "select id from admin_todo_groups where id = ? limit 1", [target])).rows[0];
    if (!known) target = null;
  }
  const now = Date.now();
  const placeholders = list.map(() => "?").join(", ");
  await exec(
    db,
    `update admin_todos set group_id = ?, updated_at = ? where id in (${placeholders})`,
    [target, now, ...list],
  );
  const result = await exec(db, `select ${SELECT_COLUMNS} from admin_todos where id in (${placeholders})`, list);
  return result.rows.map((row) => rowToTodo(row as Record<string, unknown>));
}
