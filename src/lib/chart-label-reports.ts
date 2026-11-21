import { createServerFn } from "@tanstack/react-start";

import { adminAuthHeaders, bridgeAuthHeaders } from "./live-backend-tokens";
import { getServerLiveBackendUrl } from "./live-backend";

// A player's report that a chart is filed wrong (backend
// features/chart-label-reports.ts). Same bridge as the farm helper marks: the
// viewer comes from the signed login cookie server-side, so a player only
// ever reads or edits their own report. Reports feed a labelled dataset and
// the admin Labels tab; they never change a verdict.

export type ChartLabelRateable = "yes" | "no";

export interface ChartLabelReport {
  id: string;
  beatmapId: number;
  rate: number;
  suggestedTile: string | null;
  suggestedLevel: number | null;
  suggestedTier: string | null;
  suggestedFamily: "dan" | "ln" | null;
  rateable: ChartLabelRateable | null;
  rateableReasons: string[];
  note: string | null;
  updatedAt: number;
}

export interface ChartLabelReportDraft {
  beatmapId: number;
  rate: number;
  seenLabel: string | null;
  seenFamily: string | null;
  seenTile: string | null;
  seenUnrated: boolean;
  suggestedTile: string | null;
  suggestedLevel: number | null;
  /** The tier within the level: "--", "-", "" (mid), "+", "++". */
  suggestedTier: string | null;
  suggestedFamily: "dan" | "ln" | null;
  rateable: ChartLabelRateable | null;
  rateableReasons: string[];
  note: string | null;
}

export type ChartLabelFailReason = "not_logged_in" | "too_many_reports" | "rate_limited" | "failed";

async function resolveBackend() {
  const { readCurrentAuth } = await import("./auth-server");
  const auth = await readCurrentAuth();
  if (!auth.viewer) return { ok: false as const, reason: "not_logged_in" as const };
  const base = getServerLiveBackendUrl();
  if (!base) return { ok: false as const, reason: "failed" as const };
  const headers: Record<string, string> = { ...bridgeAuthHeaders(true) };
  // The visitor's address, so the backend's per-address window keys on the reporter.
  const { getRequest } = await import("@tanstack/react-start/server");
  const request = getRequest();
  const forwardedFor = request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for");
  if (forwardedFor) headers["x-forwarded-for"] = forwardedFor;
  return { ok: true as const, base, headers, viewer: auth.viewer };
}

export const getMyChartLabelReport = createServerFn({ method: "GET" })
  .validator((data: { beatmapId: number; rate: number }) => data)
  .handler(async ({ data }): Promise<{ ok: boolean; report: ChartLabelReport | null }> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    const cfg = await resolveBackend();
    if (!cfg.ok) return { ok: cfg.reason === "not_logged_in", report: null };
    try {
      const query = new URLSearchParams({ userId: String(cfg.viewer.id), beatmapId: String(data.beatmapId), rate: String(data.rate) });
      const response = await fetch(`${cfg.base}/api/chart-label-reports/mine?${query}`, { headers: cfg.headers });
      if (!response.ok) return { ok: false, report: null };
      const body = (await response.json()) as { report?: ChartLabelReport | null };
      return { ok: true, report: body.report ?? null };
    } catch {
      return { ok: false, report: null };
    }
  });

export const submitChartLabelReport = createServerFn({ method: "POST" })
  .validator((data: ChartLabelReportDraft) => data)
  .handler(async ({ data }): Promise<{ ok: true; report: ChartLabelReport } | { ok: false; reason: ChartLabelFailReason }> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    const cfg = await resolveBackend();
    if (!cfg.ok) return { ok: false, reason: cfg.reason };
    try {
      const response = await fetch(`${cfg.base}/api/chart-label-reports/submit`, {
        method: "POST",
        headers: cfg.headers,
        body: JSON.stringify({ ...data, userId: cfg.viewer.id, username: cfg.viewer.username }),
      });
      const body = (await response.json().catch(() => ({}))) as { ok?: boolean; report?: ChartLabelReport; error?: string };
      if (response.ok && body.ok && body.report) return { ok: true, report: body.report };
      if (body.error === "too_many_reports") return { ok: false, reason: "too_many_reports" };
      if (response.status === 429) return { ok: false, reason: "rate_limited" };
      return { ok: false, reason: "failed" };
    } catch {
      return { ok: false, reason: "failed" };
    }
  });

export const withdrawChartLabelReport = createServerFn({ method: "POST" })
  .validator((data: { beatmapId: number; rate: number }) => data)
  .handler(async ({ data }): Promise<{ ok: boolean }> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    const cfg = await resolveBackend();
    if (!cfg.ok) return { ok: false };
    try {
      const response = await fetch(`${cfg.base}/api/chart-label-reports/withdraw`, {
        method: "POST",
        headers: cfg.headers,
        body: JSON.stringify({ userId: cfg.viewer.id, beatmapId: data.beatmapId, rate: data.rate }),
      });
      return { ok: response.ok };
    } catch {
      return { ok: false };
    }
  });

/* ------------------------------------------------------------------ admin */

export type ChartLabelStatus = "open" | "resolved" | "dismissed";

export interface ChartLabelCount {
  value: string;
  count: number;
}

export interface ChartLabelGroupReport extends ChartLabelReport {
  userId: number;
  username: string | null;
  played: boolean;
  reporterOverall: number | null;
  seenLabel: string | null;
  seenTile: string | null;
  seenUnrated: boolean;
  suggestedRawDan: number | null;
  createdAt: number;
}

export interface ChartLabelGroup {
  beatmapId: number;
  beatmapsetId: number | null;
  rate: number;
  keyCount: number | null;
  title: string | null;
  artist: string | null;
  version: string | null;
  seen: { label: string | null; family: string | null; tiles: string[]; vibro: boolean; analysisVersion: number | null };
  current: { label: string | null; family: string | null; rawDan: number | null; tiles: string[]; vibro: boolean } | null;
  tiles: ChartLabelCount[];
  levels: ChartLabelCount[];
  rateable: ChartLabelCount[];
  reasons: ChartLabelCount[];
  reporters: number;
  played: number;
  status: ChartLabelStatus;
  closedBy: "auto" | "admin" | null;
  closedAt: number | null;
  firstAt: number;
  lastAt: number;
  reports: ChartLabelGroupReport[];
}

/** What a report asks to change. */
export type ChartLabelKind = "skillset" | "level" | "rateable";

export interface ChartLabelPage {
  groups: ChartLabelGroup[];
  total: number;
  counts: Record<ChartLabelStatus, number>;
  /** Charts per filter option, with the other filters on. */
  facets: { keys: ChartLabelCount[]; kinds: ChartLabelCount[]; withNote: number };
}

export interface ChartLabelListQuery {
  status?: ChartLabelStatus;
  limit?: number;
  offset?: number;
  keys?: number | null;
  kind?: ChartLabelKind | null;
  withNote?: boolean;
}

async function adminFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const base = getServerLiveBackendUrl();
  if (!base) throw new Error("LIVE_BACKEND_URL is not configured.");
  return fetch(`${base}${path}`, {
    ...init,
    headers: { ...adminAuthHeaders(init.method === "POST"), connection: "close", ...(init.headers ?? {}) },
  });
}

export const listChartLabelGroups = createServerFn({ method: "GET" })
  .validator((data: ChartLabelListQuery | undefined) => data ?? {})
  .handler(async ({ data }): Promise<ChartLabelPage> => {
    const { requireAdminAccess } = await import("./auth");
    await requireAdminAccess("Chart label reports");
    const query = new URLSearchParams();
    if (data.status) query.set("status", data.status);
    if (data.limit != null) query.set("limit", String(data.limit));
    if (data.offset != null) query.set("offset", String(data.offset));
    if (data.keys != null) query.set("keys", String(data.keys));
    if (data.kind) query.set("kind", data.kind);
    if (data.withNote) query.set("withNote", "1");
    const response = await adminFetch(`/api/admin/chart-label-reports?${query}`);
    if (!response.ok) throw new Error(`Chart label reports failed (${response.status}).`);
    return await response.json() as ChartLabelPage;
  });

export const setChartLabelGroupStatus = createServerFn({ method: "POST" })
  .validator((data: { beatmapId: number; rate: number; status: ChartLabelStatus }) => data)
  .handler(async ({ data }): Promise<{ ok: boolean }> => {
    const { requireAdminAccess } = await import("./auth");
    await requireAdminAccess("Chart label report status");
    const response = await adminFetch("/api/admin/chart-label-reports/status", { method: "POST", body: JSON.stringify(data) });
    return { ok: response.ok };
  });
