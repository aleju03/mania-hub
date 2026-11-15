import { createServerFn } from "@tanstack/react-start";

import { adminAuthHeaders } from "./live-backend-tokens";
import { getServerLiveBackendUrl } from "./live-backend";
import { parseSubmittedCompanion, type SubmittedCompanion } from "./supporter-companions";
import { parseSubmittedFrames } from "./workshop-frames";

/* /admin/players?tab=supporters, backed by backend features/supporters.ts:
   every donation with who gave and how it was linked to an osu! account, the
   supporter list, and the owner's link, unlink, grant, Ko-fi CSV import and
   Google contributor export import actions. */

export type DonationLinkMethod = "lava_link" | "email_match" | "name_match" | "message_match" | "manual" | "unlinked" | "claim" | "email_claim" | "renewal";

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
  /** A Google claim awaiting the export, or one the export proved made up. */
  claimStatus?: "pending" | "revoked" | null;
}

export interface AdminSupporterRow {
  userId: number;
  username: string | null;
  expiresAt: number;
  firstSupportedAt: number;
  lastDonationAt: number | null;
  active: boolean;
  /** Their own card motif image, when they uploaded one. */
  customMotifUrl: string | null;
  /** A rank pinned for them (0 Amber .. 11 Holo, supporter-ranks.ts), or null for the real monthly count. */
  rankPin: number | null;
  /** Supporter for good (the backend's SUPPORTER_PERMANENT_USER_IDS): no countdown. */
  permanent?: boolean;
  /** Everything their linked donations came to, in US cents, refunds taken off. */
  paidCents?: number;
}

export interface AdminSupportersView {
  donations: AdminDonationRow[];
  supporters: AdminSupporterRow[];
  /** Money in, in US cents, refunds taken off; an older backend sends none. */
  totals?: { monthCents: number; allTimeCents: number };
}

export async function adminRequest<T>(path: string, body?: unknown): Promise<T> {
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

export const clearAdminSupporterMotif = createServerFn({ method: "POST" })
  .validator((data: { userId?: unknown }) => {
    const userId = Number(data?.userId);
    if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error("Pick a supporter.");
    return { userId };
  })
  .handler(({ data }) => adminRequest<{ ok: true; cleared: boolean }>("/api/admin/supporters/clear-motif", data));

/* Pins the rank a supporter shows whatever their run's length, or (null)
   goes back to counting the months. */
export const setAdminSupporterRank = createServerFn({ method: "POST" })
  .validator((data: { userId?: unknown; rank?: unknown }) => {
    const userId = Number(data?.userId);
    if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error("Pick a supporter.");
    const rank = data?.rank === null ? null : Number(data?.rank);
    if (rank !== null && !(Number.isInteger(rank) && rank >= 0 && rank < 12)) throw new Error("Pick a rank.");
    return { userId, rank };
  })
  .handler(({ data }) => adminRequest<{ ok: true }>("/api/admin/supporters/rank-pin", data));

/* Every submitted companion, listed or waiting for review. */
export const loadAdminCompanions = createServerFn({ method: "GET" })
  .handler(async () => {
    const { companions } = await adminRequest<{ companions: unknown[] }>("/api/admin/supporters/companions", {});
    return companions.map(parseSubmittedCompanion).filter((entry): entry is SubmittedCompanion => entry !== null);
  });

/* Puts a submitted companion on everyone's list, or takes it off (and off
   everyone wearing it but its submitter). */
export const setAdminCompanionListed = createServerFn({ method: "POST" })
  .validator((data: { id?: unknown; listed?: unknown }) => {
    const id = typeof data?.id === "string" && /^u\d{1,12}$/.test(data.id) ? data.id : null;
    if (!id) throw new Error("Pick a companion.");
    return { id, listed: data?.listed === true };
  })
  .handler(({ data }) => adminRequest<{ ok: true; updated: boolean }>("/api/admin/supporters/list-companion", data));

/* Takes a submitted companion off the list and off everyone wearing it. */
export const deleteAdminCompanion = createServerFn({ method: "POST" })
  .validator((data: { id?: unknown }) => {
    const id = typeof data?.id === "string" && /^u\d{1,12}$/.test(data.id) ? data.id : null;
    if (!id) throw new Error("Pick a companion.");
    return { id };
  })
  .handler(({ data }) => adminRequest<{ ok: true; deleted: boolean }>("/api/admin/supporters/delete-companion", data));

/* Every workshop frame, listed or waiting for review. */
export const loadAdminFrames = createServerFn({ method: "GET" })
  .handler(async () => {
    const { frames } = await adminRequest<{ frames: unknown[] }>("/api/admin/supporters/frames", {});
    return parseSubmittedFrames(frames);
  });

/* Puts a workshop frame on everyone's list, or takes it off (and off everyone
   wearing it but its maker). */
export const setAdminFrameListed = createServerFn({ method: "POST" })
  .validator((data: { id?: unknown; listed?: unknown }) => {
    const id = typeof data?.id === "string" && /^u\d{1,12}$/.test(data.id) ? data.id : null;
    if (!id) throw new Error("Pick a frame.");
    return { id, listed: data?.listed === true };
  })
  .handler(({ data }) => adminRequest<{ ok: true; updated: boolean }>("/api/admin/supporters/list-frame", data));

/* Marks a workshop frame as looked at, so the review list leads with new ones. */
export const setAdminFrameReviewed = createServerFn({ method: "POST" })
  .validator((data: { id?: unknown }) => {
    const id = typeof data?.id === "string" && /^u\d{1,12}$/.test(data.id) ? data.id : null;
    if (!id) throw new Error("Pick a frame.");
    return { id };
  })
  .handler(({ data }) => adminRequest<{ ok: true; updated: boolean }>("/api/admin/supporters/review-frame", data));

/* Takes a workshop frame off the list and off everyone wearing it. */
export const deleteAdminFrame = createServerFn({ method: "POST" })
  .validator((data: { id?: unknown }) => {
    const id = typeof data?.id === "string" && /^u\d{1,12}$/.test(data.id) ? data.id : null;
    if (!id) throw new Error("Pick a frame.");
    return { id };
  })
  .handler(({ data }) => adminRequest<{ ok: true; deleted: boolean }>("/api/admin/supporters/delete-frame", data));

/* Publisher Center's contributor export: confirms Google claims, adds unclaimed
   orders, revokes claims it does not list. */
export const importAdminGoogleExport = createServerFn({ method: "POST" })
  .validator((data: { csv?: unknown }) => {
    const csv = typeof data?.csv === "string" ? data.csv : "";
    if (!csv.trim()) throw new Error("Pick a CSV file.");
    if (csv.length > 8 * 1024 * 1024) throw new Error("That file is too large.");
    return { csv };
  })
  .handler(({ data }) => adminRequest<{ ok: true; rows: number; confirmed: number; added: number; renewed: number; revoked: number; pending: number }>("/api/admin/supporters/import-google", data));
