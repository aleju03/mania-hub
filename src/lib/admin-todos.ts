import { createServerFn } from "@tanstack/react-start";
import { requireAdminAccess } from "./auth";
import { getServerLiveBackendUrl } from "./live-backend";

// Server fns for the /admin/todos page: the site owner's private todo list. All data lives in the
// live backend (admin_todos table); these proxy through with the shared admin token, gated so only
// an admin viewer (or local dev) can reach them. Mirrors the dan-classifier-admin proxy shape.

export type TodoCategory = "bug" | "feature" | "idea" | "chore" | "task";
export type TodoPriority = "low" | "normal" | "high";
export type TodoStatus = "open" | "done";

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

export const listAdminTodos = createServerFn({ method: "GET" }).handler(async (): Promise<{ todos: AdminTodo[] }> => {
  await requireAdminAccess("Admin todos list");
  const base = requireLiveBackendBase();
  const response = await fetchLiveBackend(`${base}/api/admin/todos`, { headers: liveBackendHeaders() });
  if (!response.ok) throw new Error(`Todos list failed (${response.status}).`);
  return await response.json() as { todos: AdminTodo[] };
});

export const createAdminTodo = createServerFn({ method: "POST" })
  .inputValidator((data: { title?: unknown; notes?: unknown; category?: unknown; priority?: unknown }) => ({
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
  .inputValidator((data: { id?: unknown; title?: unknown; notes?: unknown; category?: unknown; priority?: unknown; status?: unknown; position?: unknown }) => {
    // Only forward keys that were actually provided, so a "toggle done" ({ id, status }) never
    // overwrites the title/notes/etc. the backend applies a partial update from exactly these keys.
    const patch: Record<string, unknown> = { id: typeof data?.id === "string" ? data.id : "" };
    if (data && "title" in data) patch.title = typeof data.title === "string" ? data.title : "";
    if (data && "notes" in data) patch.notes = typeof data.notes === "string" ? data.notes : null;
    if (data && "category" in data) patch.category = data.category;
    if (data && "priority" in data) patch.priority = data.priority;
    if (data && "status" in data) patch.status = data.status;
    if (data && "position" in data) patch.position = typeof data.position === "number" ? data.position : undefined;
    return patch;
  })
  .handler(async ({ data }): Promise<{ todo: AdminTodo }> => {
    await requireAdminAccess("Admin todo update");
    const response = await postAdminTodos("/api/admin/todos/update", data);
    if (!response.ok) throw new Error(`Todo update failed (${response.status}).`);
    return await response.json() as { todo: AdminTodo };
  });

export const deleteAdminTodo = createServerFn({ method: "POST" })
  .inputValidator((data: { id?: unknown }) => ({ id: typeof data?.id === "string" ? data.id : "" }))
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
