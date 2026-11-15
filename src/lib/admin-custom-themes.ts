import { createServerFn } from "@tanstack/react-start";

import { adminRequest } from "./admin-supporters";
import { parseCustomTheme, type CustomTheme } from "./custom-themes";

/* The Themes tab of /admin/players, backed by backend features/custom-themes.ts:
   every supporter's own theme, unseen changes and reported ones first, with
   the moderation actions. Themes go live without review, so this is where
   they get looked at. */

export type AdminCustomThemeReportKind = "crash" | "content" | "rights";

export interface AdminCustomTheme {
  id: number;
  name: string;
  author: { id: number; username: string };
  visibility: "private" | "gallery";
  state: "live" | "auto_hidden" | "taken_down";
  credits: string | null;
  remixedFrom: number | null;
  liveRevision: number | null;
  stillUrl: string | null;
  wearers: number;
  updatedAt: number;
  publishedAt: number | null;
  seen: boolean;
  deleted: boolean;
  authorBlocked: boolean;
  source: string | null;
  previousSource: string | null;
  costRatio: number | null;
  revision: CustomTheme | null;
  reports: { kind: AdminCustomThemeReportKind; rev: number; note: string | null; reportedAt: number }[];
}

export interface AdminCustomThemesView {
  themes: AdminCustomTheme[];
  disabled: boolean;
}

function parseEntry(raw: unknown): AdminCustomTheme | null {
  if (!raw || typeof raw !== "object") return null;
  const entry = raw as Record<string, unknown>;
  const id = Number(entry.id);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const author = (entry.author ?? {}) as Record<string, unknown>;
  const reports = Array.isArray(entry.reports) ? entry.reports : [];
  return {
    id,
    name: String(entry.name ?? ""),
    author: { id: Number(author.id) || 0, username: String(author.username ?? "") },
    visibility: entry.visibility === "gallery" ? "gallery" : "private",
    state: entry.state === "auto_hidden" || entry.state === "taken_down" ? entry.state : "live",
    credits: typeof entry.credits === "string" ? entry.credits : null,
    remixedFrom: entry.remixedFrom == null ? null : Number(entry.remixedFrom),
    liveRevision: entry.liveRevision == null ? null : Number(entry.liveRevision),
    stillUrl: typeof entry.stillUrl === "string" ? entry.stillUrl : null,
    wearers: Number(entry.wearers) || 0,
    updatedAt: Number(entry.updatedAt) || 0,
    publishedAt: entry.publishedAt == null ? null : Number(entry.publishedAt),
    seen: entry.seen === true,
    deleted: entry.deleted === true,
    authorBlocked: entry.authorBlocked === true,
    source: typeof entry.source === "string" ? entry.source : null,
    previousSource: typeof entry.previousSource === "string" ? entry.previousSource : null,
    costRatio: typeof entry.costRatio === "number" ? entry.costRatio : null,
    revision: parseCustomTheme(entry.revision),
    reports: reports.flatMap((report) => {
      const value = (report ?? {}) as Record<string, unknown>;
      const kind = value.kind === "crash" || value.kind === "content" || value.kind === "rights" ? value.kind : null;
      return kind ? [{ kind, rev: Number(value.rev) || 0, note: typeof value.note === "string" ? value.note : null, reportedAt: Number(value.reportedAt) || 0 }] : [];
    }),
  };
}

export const loadAdminCustomThemes = createServerFn({ method: "GET" })
  .handler(async (): Promise<AdminCustomThemesView> => {
    const body = await adminRequest<{ themes?: unknown[]; disabled?: unknown }>("/api/admin/custom-themes");
    return {
      themes: (body.themes ?? []).map(parseEntry).filter((entry): entry is AdminCustomTheme => entry !== null),
      disabled: body.disabled === true,
    };
  });

function themeId(data: { themeId?: unknown }): number {
  const id = Number(data?.themeId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Pick a theme.");
  return id;
}

function userId(data: { userId?: unknown }): number {
  const id = Number(data?.userId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Pick a supporter.");
  return id;
}

const reason = (value: unknown) => (typeof value === "string" ? value.trim().slice(0, 500) : "");

export const markAdminCustomThemeSeen = createServerFn({ method: "POST" })
  .validator((data: { themeId?: unknown }) => ({ themeId: themeId(data) }))
  .handler(({ data }) => adminRequest<{ ok: true }>("/api/admin/custom-themes/seen", data));

/* Off every profile and out of the gallery; its code and images can't be saved again. */
export const takeDownAdminCustomTheme = createServerFn({ method: "POST" })
  .validator((data: { themeId?: unknown; reason?: unknown }) => ({ themeId: themeId(data), reason: reason(data?.reason) }))
  .handler(({ data }) => adminRequest<{ ok: true }>("/api/admin/custom-themes/take-down", data));

/* Undoes a takedown or a crash auto-hide. */
export const restoreAdminCustomTheme = createServerFn({ method: "POST" })
  .validator((data: { themeId?: unknown }) => ({ themeId: themeId(data) }))
  .handler(({ data }) => adminRequest<{ ok: true }>("/api/admin/custom-themes/restore", data));

export const blockAdminCustomThemeAuthor = createServerFn({ method: "POST" })
  .validator((data: { userId?: unknown; reason?: unknown; takeDownAll?: unknown }) => ({ userId: userId(data), reason: reason(data?.reason), takeDownAll: data?.takeDownAll === true }))
  .handler(({ data }) => adminRequest<{ ok: true }>("/api/admin/custom-themes/block", data));

export const unblockAdminCustomThemeAuthor = createServerFn({ method: "POST" })
  .validator((data: { userId?: unknown }) => ({ userId: userId(data) }))
  .handler(({ data }) => adminRequest<{ ok: true }>("/api/admin/custom-themes/unblock", data));

/* Every custom theme shows only its still while this is on. */
export const setAdminCustomThemesDisabled = createServerFn({ method: "POST" })
  .validator((data: { disabled?: unknown }) => {
    if (typeof data?.disabled !== "boolean") throw new Error("Pick on or off.");
    return { disabled: data.disabled };
  })
  .handler(({ data }) => adminRequest<{ ok: true }>("/api/admin/custom-themes/switch", data));
