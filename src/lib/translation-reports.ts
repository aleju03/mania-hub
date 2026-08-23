import { createServerFn } from "@tanstack/react-start";

import { adminAuthHeaders, bridgeAuthHeaders } from "./live-backend-tokens";
import { getServerLiveBackendUrl } from "./live-backend";
import { reporterKeyFor } from "./reporter-key";

/* Reports about the site's own UI translations, filed from the language tab of
   the settings panel and read on /admin/translation-reports. The rows live in
   the live backend (translation_reports); everything here is the bridge.

   Submitting is open to signed-out visitors: someone reading the site in
   Chinese without an osu! login is exactly the person who notices a string is
   wrong. So the browser never names a reporter - this resolves the viewer from
   the login cookie server-side when there is one, and otherwise sends nothing.
   Two things bound the spam that opens up: the visitor's address is forwarded
   so the backend's per-IP window keys on the reporter rather than on this
   server, and the reporter key below gives the backend a stable per-reporter
   bucket for its daily cap without ever storing an address. */

export type TranslationReportStatus = "new" | "resolved" | "dismissed";

export interface TranslationReport {
  id: string;
  locale: string;
  status: TranslationReportStatus;
  sourceText: string;
  suggestion: string | null;
  note: string | null;
  pagePath: string | null;
  userId: number | null;
  username: string | null;
  adminNote: string | null;
  createdAt: number;
  updatedAt: number;
  reviewedAt: number | null;
}

export interface TranslationReportCounts {
  new: number;
  resolved: number;
  dismissed: number;
  total: number;
}

// "invalid_report" means the form was empty after trimming, "too_many_reports"
// is the backend's daily per-reporter cap, "rate_limited" its per-IP window,
// "failed" anything else (backend down or unconfigured).
export type TranslationReportFailReason = "invalid_report" | "too_many_reports" | "rate_limited" | "failed";

export type SubmitTranslationReportResult =
  | { ok: true; duplicate: boolean }
  | { ok: false; reason: TranslationReportFailReason };

export const TRANSLATION_REPORT_SOURCE_MAX = 600;
export const TRANSLATION_REPORT_SUGGESTION_MAX = 600;
export const TRANSLATION_REPORT_NOTE_MAX = 2000;

export const submitTranslationReport = createServerFn({ method: "POST" })
  .validator((data: { locale: string; sourceText: string; suggestion?: string; note?: string; pagePath?: string }) => data)
  .handler(async ({ data }): Promise<SubmitTranslationReportResult> => {
    const { getRequest, setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    const base = getServerLiveBackendUrl();
    if (!base) return { ok: false, reason: "failed" };

    const { readCurrentAuth } = await import("./auth-server");
    const viewer = (await readCurrentAuth()).viewer;
    const request = getRequest();
    const headers: Record<string, string> = { ...bridgeAuthHeaders(true) };
    // Lets the backend's per-IP window key on the visitor instead of on this
    // server, the same way country activation forwards it.
    const forwardedFor = request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for");
    if (forwardedFor) headers["x-forwarded-for"] = forwardedFor;

    try {
      const response = await fetch(`${base}/api/translation-reports/submit`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          locale: data.locale,
          sourceText: data.sourceText,
          suggestion: data.suggestion ?? null,
          note: data.note ?? null,
          pagePath: data.pagePath ?? null,
          userId: viewer?.id ?? null,
          username: viewer?.username ?? null,
          reporterKey: await reporterKeyFor(request, viewer?.id ?? null),
        }),
      });
      if (response.status === 429) return { ok: false, reason: "rate_limited" };
      const body = (await response.json().catch(() => ({}))) as { ok?: boolean; duplicate?: boolean; error?: string };
      if (response.ok && body.ok === true) return { ok: true, duplicate: body.duplicate === true };
      if (body.error === "too_many_reports" || body.error === "invalid_report") {
        return { ok: false, reason: body.error };
      }
      return { ok: false, reason: "failed" };
    } catch {
      return { ok: false, reason: "failed" };
    }
  });

/* ------------------------------------------------------------------ admin */

async function adminFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const base = getServerLiveBackendUrl();
  if (!base) throw new Error("LIVE_BACKEND_URL is not configured.");
  return fetch(`${base}${path}`, {
    ...init,
    headers: { ...adminAuthHeaders(init.method === "POST"), connection: "close", ...(init.headers ?? {}) },
  });
}

export interface TranslationReportPage {
  reports: TranslationReport[];
  counts: TranslationReportCounts;
  total: number;
}

export const listTranslationReports = createServerFn({ method: "GET" })
  .validator((data: { status?: string; locale?: string; search?: string; limit?: number; offset?: number } | undefined) => data ?? {})
  .handler(async ({ data }): Promise<TranslationReportPage> => {
    const { requireAdminAccess } = await import("./auth");
    await requireAdminAccess("Translation reports list");
    const query = new URLSearchParams();
    if (data.status) query.set("status", data.status);
    if (data.locale) query.set("locale", data.locale);
    if (data.search) query.set("search", data.search);
    if (data.limit != null) query.set("limit", String(data.limit));
    if (data.offset != null) query.set("offset", String(data.offset));
    const suffix = query.toString();
    const response = await adminFetch(`/api/admin/translation-reports${suffix ? `?${suffix}` : ""}`);
    if (!response.ok) throw new Error(`Translation reports list failed (${response.status}).`);
    return await response.json() as TranslationReportPage;
  });

export const updateTranslationReport = createServerFn({ method: "POST" })
  .validator((data: { id: string; status?: TranslationReportStatus; adminNote?: string | null }) => data)
  .handler(async ({ data }): Promise<{ report: TranslationReport }> => {
    const { requireAdminAccess } = await import("./auth");
    await requireAdminAccess("Translation report update");
    const response = await adminFetch("/api/admin/translation-reports/update", {
      method: "POST",
      body: JSON.stringify(data),
    });
    if (!response.ok) throw new Error(`Translation report update failed (${response.status}).`);
    return await response.json() as { report: TranslationReport };
  });

export const deleteTranslationReport = createServerFn({ method: "POST" })
  .validator((data: { id: string }) => data)
  .handler(async ({ data }): Promise<{ ok: boolean }> => {
    const { requireAdminAccess } = await import("./auth");
    await requireAdminAccess("Translation report delete");
    const response = await adminFetch("/api/admin/translation-reports/delete", {
      method: "POST",
      body: JSON.stringify(data),
    });
    if (!response.ok) throw new Error(`Translation report delete failed (${response.status}).`);
    return await response.json() as { ok: boolean };
  });

export const clearReviewedTranslationReports = createServerFn({ method: "POST" }).handler(
  async (): Promise<{ cleared: number }> => {
    const { requireAdminAccess } = await import("./auth");
    await requireAdminAccess("Translation reports clear");
    const response = await adminFetch("/api/admin/translation-reports/clear-reviewed", { method: "POST", body: "{}" });
    if (!response.ok) throw new Error(`Translation reports clear failed (${response.status}).`);
    return await response.json() as { cleared: number };
  },
);
