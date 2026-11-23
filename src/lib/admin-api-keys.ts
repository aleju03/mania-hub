import { createServerFn } from "@tanstack/react-start";
import { requireAdminAccess } from "./auth";
import { getServerLiveBackendUrl } from "./live-backend";

/* Admin view of every self-serve Mania Tracker API key (backend
   /api/admin/api-keys): owner, use, the per-key rate override and revoke.
   Admin-gated; the admin token is injected server-side. */

export interface AdminApiKey {
  id: number;
  ownerUserId: number;
  ownerUsername: string | null;
  label: string;
  prefix: string;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
  requests: number;
  ratePerMinute: number | null;
}

export interface AdminApiKeysReport {
  keys: AdminApiKey[];
  ratePerMinute: number;
  globalRatePerMinute: number;
  capturedAt: number;
}

async function callBackend(init: RequestInit = {}): Promise<AdminApiKeysReport | null> {
  const base = getServerLiveBackendUrl();
  if (!base) throw new Error("LIVE_BACKEND_URL is not configured.");
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (process.env.LIVE_ADMIN_TOKEN) headers.authorization = `Bearer ${process.env.LIVE_ADMIN_TOKEN}`;
  const response = await fetch(`${base}/api/admin/api-keys`, { ...init, headers });
  if (response.status === 404 && !init.method) return null;
  const body = (await response.json().catch(() => null)) as (AdminApiKeysReport & { error?: unknown }) | null;
  if (!response.ok || !body) throw new Error(body?.error ? String(body.error) : `Server ${response.status} for /api/admin/api-keys`);
  return { ...body, keys: Array.isArray(body.keys) ? body.keys : [] };
}

export const fetchAdminApiKeys = createServerFn({ method: "GET" }).handler(
  async (): Promise<AdminApiKeysReport | null> => {
    await requireAdminAccess("API keys");
    return callBackend();
  },
);

export const mutateAdminApiKey = createServerFn({ method: "POST" })
  .validator((input: { action?: unknown; id?: unknown; ratePerMinute?: unknown }) => {
    const id = Math.floor(Number(input?.id) || 0);
    if (id <= 0) throw new Error("Invalid key.");
    if (input?.action === "revoke") return { action: "revoke" as const, id };
    if (input?.action !== "set-rate") throw new Error("Invalid action.");
    const rate = input.ratePerMinute == null || input.ratePerMinute === "" ? null : Math.floor(Number(input.ratePerMinute));
    if (rate != null && (!Number.isFinite(rate) || rate <= 0)) throw new Error("Invalid rate.");
    return { action: "set-rate" as const, id, ratePerMinute: rate };
  })
  .handler(async ({ data }): Promise<AdminApiKeysReport | null> => {
    await requireAdminAccess("API keys");
    return callBackend({ method: "POST", body: JSON.stringify(data) });
  });
