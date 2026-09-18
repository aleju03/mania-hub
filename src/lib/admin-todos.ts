import { createServerFn } from "@tanstack/react-start";
import { requireAdminAccess } from "./auth";
import { getServerLiveBackendUrl } from "./live-backend";

// Server fns for the /admin/todos page: the site owner's private todo list. All data lives in the
// live backend (admin_todos table); these proxy through with the shared admin token, gated so only
// an admin viewer (or local dev) can reach them. Mirrors the dan-classifier-admin proxy shape.

export type TodoCategory = "bug" | "feature" | "idea" | "chore" | "task";
export type TodoPriority = "low" | "normal" | "high";
// "hold" is a parked task: still on the list, off the board, never scored.
export type TodoStatus = "open" | "hold" | "done";
// Owner-defined buckets laid over the fixed categories, each painted in one of a fixed palette.
export type TodoGroupColor = "pink" | "blue" | "green" | "yellow" | "purple" | "red" | "orange";

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
  // Manual drag-to-reorder key for the open list; lower sorts higher.
  position: number;
  // Short handle shown on the card ("#7") so a task can be named in conversation. Never reused.
  seq: number;
  // The group this task was put in, or null. Deleting a group ungroups its tasks.
  groupId: string | null;
}

export interface AdminTodoGroup {
  id: string;
  name: string;
  color: TodoGroupColor;
  createdAt: number;
  position: number;
}

function liveBackendHeaders(): HeadersInit {
  // connection: close sidesteps keep-alive socket reuse between the frontend server and the live
  // backend, which intermittently dies mid-response ("other side closed"); localhost setup is free.
  const headers: HeadersInit = { connection: "close" };
  if (process.env.LIVE_ADMIN_TOKEN) {
    headers.authorization = `Bearer ${process.env.LIVE_ADMIN_TOKEN}`;
  }
  return headers;
}

async function fetchLiveBackend(url: string, init: RequestInit, attempts = 2): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetch(url, init);
    } catch (error) {
      if (attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

function requireLiveBackendBase(): string {
  const base = getServerLiveBackendUrl();
  if (!base) throw new Error("LIVE_BACKEND_URL is not configured.");
  return base;
}

async function postAdminTodos(path: string, payload: unknown): Promise<Response> {
  const base = requireLiveBackendBase();
  return fetchLiveBackend(`${base}${path}`, {
    method: "POST",
    headers: { ...liveBackendHeaders(), "content-type": "application/json" },
    body: JSON.stringify(payload ?? {}),
  });
}

export const listAdminTodos = createServerFn({ method: "GET" }).handler(async (): Promise<{ todos: AdminTodo[]; groups: AdminTodoGroup[] }> => {
  await requireAdminAccess("Admin todos list");
  const base = requireLiveBackendBase();
  const response = await fetchLiveBackend(`${base}/api/admin/todos`, { headers: liveBackendHeaders() });
  if (!response.ok) throw new Error(`Todos list failed (${response.status}).`);
  const body = await response.json() as { todos: AdminTodo[]; groups?: AdminTodoGroup[] };
  return { todos: body.todos, groups: body.groups ?? [] };
});

export const createAdminTodo = createServerFn({ method: "POST" })
  .validator((data: { title?: unknown; notes?: unknown; category?: unknown; priority?: unknown }) => ({
    title: typeof data?.title === "string" ? data.title : "",
    notes: typeof data?.notes === "string" ? data.notes : null,
    category: typeof data?.category === "string" ? data.category : "task",
    priority: typeof data?.priority === "string" ? data.priority : "normal",
  }))
  .handler(async ({ data }): Promise<{ todo: AdminTodo }> => {
    await requireAdminAccess("Admin todo create");
    const response = await postAdminTodos("/api/admin/todos/create", data);
    if (!response.ok) throw new Error(`Todo create failed (${response.status}).`);
    return await response.json() as { todo: AdminTodo };
  });

export const updateAdminTodo = createServerFn({ method: "POST" })
  .validator((data: { id?: unknown; title?: unknown; notes?: unknown; category?: unknown; priority?: unknown; status?: unknown; position?: unknown; groupId?: unknown }) => {
    // Only forward keys that were actually provided, so a "toggle done" ({ id, status }) never
    // overwrites the title/notes/etc. the backend applies a partial update from exactly these keys.
    const patch: Record<string, unknown> = { id: typeof data?.id === "string" ? data.id : "" };
    if (data && "title" in data) patch.title = typeof data.title === "string" ? data.title : "";
    if (data && "notes" in data) patch.notes = typeof data.notes === "string" ? data.notes : null;
    if (data && "category" in data) patch.category = data.category;
    if (data && "priority" in data) patch.priority = data.priority;
    if (data && "status" in data) patch.status = data.status;
    if (data && "position" in data) patch.position = typeof data.position === "number" ? data.position : undefined;
    // null is meaningful here (ungroup), so the key is forwarded as-is once it was provided.
    if (data && "groupId" in data) patch.groupId = typeof data.groupId === "string" ? data.groupId : null;
    return patch;
  })
  .handler(async ({ data }): Promise<{ todo: AdminTodo }> => {
    await requireAdminAccess("Admin todo update");
    const response = await postAdminTodos("/api/admin/todos/update", data);
    if (!response.ok) throw new Error(`Todo update failed (${response.status}).`);
    return await response.json() as { todo: AdminTodo };
  });

export const deleteAdminTodo = createServerFn({ method: "POST" })
  .validator((data: { id?: unknown }) => ({ id: typeof data?.id === "string" ? data.id : "" }))
  .handler(async ({ data }): Promise<{ ok: boolean }> => {
    await requireAdminAccess("Admin todo delete");
    const response = await postAdminTodos("/api/admin/todos/delete", data);
    if (!response.ok) throw new Error(`Todo delete failed (${response.status}).`);
    return await response.json() as { ok: boolean };
  });

export const clearDoneAdminTodos = createServerFn({ method: "POST" }).handler(async (): Promise<{ ok: boolean; cleared: number }> => {
  await requireAdminAccess("Admin todos clear done");
  const response = await postAdminTodos("/api/admin/todos/clear-done", {});
  if (!response.ok) throw new Error(`Todos clear failed (${response.status}).`);
  return await response.json() as { ok: boolean; cleared: number };
});

// Groups: the owner's own buckets over the board. Saving with an id renames/recolors, without one
// creates; assigning takes a whole marquee selection at once so one bulk edit is one request.

export const saveAdminTodoGroup = createServerFn({ method: "POST" })
  .validator((data: { id?: unknown; name?: unknown; color?: unknown }) => ({
    id: typeof data?.id === "string" ? data.id : undefined,
    name: typeof data?.name === "string" ? data.name : "",
    color: typeof data?.color === "string" ? data.color : "pink",
  }))
  .handler(async ({ data }): Promise<{ group: AdminTodoGroup }> => {
    await requireAdminAccess("Admin todo group save");
    const response = await postAdminTodos("/api/admin/todos/group-save", data);
    if (!response.ok) throw new Error(`Group save failed (${response.status}).`);
    return await response.json() as { group: AdminTodoGroup };
  });

export const deleteAdminTodoGroup = createServerFn({ method: "POST" })
  .validator((data: { id?: unknown }) => ({ id: typeof data?.id === "string" ? data.id : "" }))
  .handler(async ({ data }): Promise<{ ok: boolean }> => {
    await requireAdminAccess("Admin todo group delete");
    const response = await postAdminTodos("/api/admin/todos/group-delete", data);
    if (!response.ok) throw new Error(`Group delete failed (${response.status}).`);
    return await response.json() as { ok: boolean };
  });

export const assignAdminTodosToGroup = createServerFn({ method: "POST" })
  .validator((data: { ids?: unknown; groupId?: unknown }) => ({
    ids: Array.isArray(data?.ids) ? data.ids.filter((id): id is string => typeof id === "string") : [],
    groupId: typeof data?.groupId === "string" ? data.groupId : null,
  }))
  .handler(async ({ data }): Promise<{ todos: AdminTodo[] }> => {
    await requireAdminAccess("Admin todos assign group");
    const response = await postAdminTodos("/api/admin/todos/assign-group", data);
    if (!response.ok) throw new Error(`Group assign failed (${response.status}).`);
    return await response.json() as { todos: AdminTodo[] };
  });
