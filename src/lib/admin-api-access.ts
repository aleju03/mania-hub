import { createServerFn } from "@tanstack/react-start";
import { requireAdminAccess } from "./auth";
import { getServerLiveBackendUrl } from "./live-backend";

/* Admin view of who may use the Mania Tracker API (backend
   /api/admin/api-access): requests, granted and paused players, with grant,
   pause and revoke. Admin-gated; the admin token is injected server-side. */

export type AdminApiAccessStatus = "requested" | "active" | "paused";

export interface AdminApiAccessEntry {
  userId: number;
  username: string | null;
  status: AdminApiAccessStatus;
  note: string | null;
  requestedAt: number | null;
  grantedAt: number | null;
  pausedAt: number | null;
  activeKeys: number;
  webhooks: number;
  requests: number;
  lastUsedAt: number | null;
}

export interface AdminApiAccessReport {
  entries: AdminApiAccessEntry[];
  capturedAt: number;
}

async function callBackend(init: RequestInit = {}): Promise<AdminApiAccessReport | null> {
  const base = getServerLiveBackendUrl();
  if (!base) throw new Error("LIVE_BACKEND_URL is not configured.");
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (process.env.LIVE_ADMIN_TOKEN) headers.authorization = `Bearer ${process.env.LIVE_ADMIN_TOKEN}`;
  const response = await fetch(`${base}/api/admin/api-access`, { ...init, headers });
  if (response.status === 404 && !init.method) return null;
  const body = (await response.json().catch(() => null)) as (AdminApiAccessReport & { error?: unknown }) | null;
  if (!response.ok || !body) {
    if (body?.error === "user_not_found") throw new Error("No stored player has that id or name.");
    throw new Error(body?.error ? String(body.error) : `Server ${response.status} for /api/admin/api-access`);
  }
  return { ...body, entries: Array.isArray(body.entries) ? body.entries : [] };
}

export const fetchAdminApiAccess = createServerFn({ method: "GET" }).handler(
  async (): Promise<AdminApiAccessReport | null> => {
    await requireAdminAccess("API access");
    return callBackend();
  },
);

export const mutateAdminApiAccess = createServerFn({ method: "POST" })
  .validator((input: { action?: unknown; user?: unknown }) => {
    const user = typeof input?.user === "string" || typeof input?.user === "number" ? String(input.user).trim().slice(0, 40) : "";
    if (!user) throw new Error("Enter an osu! id or username.");
    if (input?.action !== "grant" && input?.action !== "pause" && input?.action !== "revoke") throw new Error("Invalid action.");
    return { action: input.action, user };
  })
  .handler(async ({ data }): Promise<AdminApiAccessReport | null> => {
    await requireAdminAccess("API access");
    return callBackend({ method: "POST", body: JSON.stringify(data) });
  });
