import { createServerFn } from "@tanstack/react-start";

import { adminAuthHeaders } from "./live-backend-tokens";
import { getServerLiveBackendUrl } from "./live-backend";

/* /admin/supporters, backed by backend features/supporters.ts: every donation
   with who gave and how it was linked to an osu! account, the supporter list,
   and the owner's link, unlink, grant and Ko-fi CSV import actions. */

export type DonationLinkMethod = "lava_link" | "email_match" | "name_match" | "manual" | "unlinked";

export interface AdminDonationRow {
  provider: string;
  externalId: string;
  amount: number;
  currency: string;
  usdCents: number | null;
  occurredAt: number;
  donorName: string | null;
  message: string | null;
  imported: boolean;
  linkedUserId: number | null;
  linkedUsername: string | null;
  linkMethod: DonationLinkMethod | null;
}

export interface AdminSupporterRow {
  userId: number;
  username: string | null;
  expiresAt: number;
  firstSupportedAt: number;
  lastDonationAt: number | null;
  active: boolean;
}

export interface AdminSupportersView {
  donations: AdminDonationRow[];
  supporters: AdminSupporterRow[];
}

async function adminRequest<T>(path: string, body?: unknown): Promise<T> {
  const { requireAdminAccess } = await import("./auth");
  await requireAdminAccess("Manage supporters");
  const base = getServerLiveBackendUrl();
  if (!base) throw new Error("LIVE_BACKEND_URL is not configured.");
  const response = await fetch(`${base}${path}`, body === undefined
    ? { headers: adminAuthHeaders() }
    : { method: "POST", headers: adminAuthHeaders(true), body: JSON.stringify(body) });
  const json = await response.json().catch(() => null) as (T & { error?: unknown; missing?: unknown; headers?: unknown }) | null;
  if (!response.ok || !json) {
    const code = String(json?.error ?? `Server ${response.status}`);
    if (code === "user_not_found") throw new Error("No osu! account matches that username or ID.");
    if (code === "unrecognized_csv") {
      const missing = Array.isArray(json?.missing) ? json.missing.join(", ") : "";
      const headers = Array.isArray(json?.headers) ? json.headers.join(", ") : "";
      throw new Error(`Could not find the ${missing} column in that file. Its columns: ${headers || "none"}.`);
    }
    throw new Error(code);
  }
  return json;
}

export const loadAdminSupporters = createServerFn({ method: "GET" })
  .handler(() => adminRequest<AdminSupportersView>("/api/admin/supporters"));

function donationKey(data: { provider?: unknown; externalId?: unknown }) {
  const provider = typeof data?.provider === "string" ? data.provider : "";
  const externalId = typeof data?.externalId === "string" ? data.externalId : "";
  if (!provider || !externalId) throw new Error("Pick a donation.");
  return { provider, externalId };
}

export const linkAdminDonation = createServerFn({ method: "POST" })
  .validator((data: { provider?: unknown; externalId?: unknown; query?: unknown }) => {
    const query = typeof data?.query === "string" ? data.query.trim().slice(0, 64) : "";
    if (!query) throw new Error("Enter an osu! username or #user-id.");
    return { ...donationKey(data), query };
  })
  .handler(({ data }) => adminRequest<{ ok: true; userId: number; username: string | null }>("/api/admin/supporters/link", data));

export const unlinkAdminDonation = createServerFn({ method: "POST" })
  .validator(donationKey)
  .handler(({ data }) => adminRequest<{ ok: true }>("/api/admin/supporters/unlink", data));

export const grantAdminSupporterDays = createServerFn({ method: "POST" })
  .validator((data: { query?: unknown; days?: unknown; note?: unknown }) => {
    const query = typeof data?.query === "string" ? data.query.trim().slice(0, 64) : "";
    const days = Number(data?.days);
    const note = typeof data?.note === "string" ? data.note.trim().slice(0, 200) : "";
    if (!query) throw new Error("Enter an osu! username or #user-id.");
    if (!Number.isFinite(days) || days === 0 || Math.abs(days) > 3650) throw new Error("Enter a number of days.");
    return { query, days, note };
  })
  .handler(({ data }) => adminRequest<{ ok: true; userId: number; username: string | null }>("/api/admin/supporters/grant", data));

export const importAdminKofiCsv = createServerFn({ method: "POST" })
  .validator((data: { csv?: unknown }) => {
    const csv = typeof data?.csv === "string" ? data.csv : "";
    if (!csv.trim()) throw new Error("Pick a CSV file.");
    if (csv.length > 8 * 1024 * 1024) throw new Error("That file is too large.");
    return { csv };
  })
  .handler(({ data }) => adminRequest<{ ok: true; rows: number; inserted: number; linked: number }>("/api/admin/supporters/import", data));
