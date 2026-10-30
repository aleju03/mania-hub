import { createServerFn } from "@tanstack/react-start";

import { adminAuthHeaders } from "./live-backend-tokens";
import { getServerLiveBackendUrl } from "./live-backend";

/* Charts turned off for skill ratings (/admin/disabled-charts), backed by
   backend features/rating-disabled-charts.ts. */

export interface RatingDisabledChartMember {
  beatmapId: number;
  beatmapsetId: number | null;
  artist: string;
  title: string;
  version: string;
  creator: string;
  keyCount: number | null;
  status: string | null;
  stars: number | null;
}

export interface RatingDisabledChart {
  beatmapId: number;
  note: string | null;
  disabledAt: string;
  members: RatingDisabledChartMember[];
}

export interface RatingDisabledWalkState {
  generation: string;
  startedAt: string;
  finishedAt: string | null;
  cursor: number;
  scanned: number;
  rewritten: number;
}

export interface RatingDisabledChartsView {
  charts: RatingDisabledChart[];
  walk: RatingDisabledWalkState | null;
}

export interface RatingDisabledChartSearchResult extends RatingDisabledChartMember {
  playCount: number;
  sameNotes: number;
  disabled: boolean;
}

export interface RatingDisabledChartLookup {
  beatmapId: number;
  disabled: boolean;
  coveredBy: number | null;
  fingerprinted: boolean;
  members: RatingDisabledChartMember[];
}

/** A difficulty id from a bare id or an osu! / site beatmap link; a set link alone names no difficulty. */
export function parseBeatmapIdInput(text: string): number | null {
  const value = text.trim();
  const match = /^(\d+)$/.exec(value)
    ?? /#[a-z]+\/(\d+)/i.exec(value)
    ?? /\/(?:b|beatmaps)\/(\d+)/i.exec(value)
    ?? /[?&](?:b|beatmap|beatmapId)=(\d+)/i.exec(value);
  const id = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

async function adminRequest<T>(path: string, body?: unknown): Promise<T> {
  const { requireAdminAccess } = await import("./auth");
  await requireAdminAccess("Manage disabled charts");
  const base = getServerLiveBackendUrl();
  if (!base) throw new Error("LIVE_BACKEND_URL is not configured.");
  const response = await fetch(`${base}/api/admin/rating-disabled-charts${path}`, body === undefined
    ? { headers: adminAuthHeaders() }
    : { method: "POST", headers: adminAuthHeaders(true), body: JSON.stringify(body) });
  const parsed = await response.json().catch(() => null) as (T & { error?: unknown }) | null;
  if (!response.ok || !parsed) throw new Error(String(parsed?.error ?? `Server ${response.status}`));
  return parsed;
}

function validateBeatmapId(data: { beatmapId?: unknown }) {
  const beatmapId = Number(data?.beatmapId);
  if (!Number.isSafeInteger(beatmapId) || beatmapId <= 0) throw new Error("Enter a beatmap link or id.");
  return { beatmapId };
}

export const listRatingDisabledCharts = createServerFn({ method: "GET" })
  .handler(async (): Promise<RatingDisabledChartsView> => adminRequest<RatingDisabledChartsView>(""));

export const searchRatingDisabledCharts = createServerFn({ method: "GET" })
  .validator((data: { q?: unknown }) => ({ q: typeof data?.q === "string" ? data.q.trim().slice(0, 120) : "" }))
  .handler(async ({ data }): Promise<RatingDisabledChartSearchResult[]> =>
    (await adminRequest<{ results: RatingDisabledChartSearchResult[] }>(`/search?q=${encodeURIComponent(data.q)}`)).results);

export const lookupRatingDisabledChart = createServerFn({ method: "POST" })
  .validator(validateBeatmapId)
  .handler(async ({ data }): Promise<RatingDisabledChartLookup> => adminRequest<RatingDisabledChartLookup>("/lookup", data));

export const disableRatingChart = createServerFn({ method: "POST" })
  .validator((data: { beatmapId?: unknown; note?: unknown }) => ({
    ...validateBeatmapId(data),
    note: typeof data?.note === "string" ? data.note.trim().slice(0, 300) : "",
  }))
  .handler(async ({ data }): Promise<RatingDisabledChartsView> => adminRequest<RatingDisabledChartsView>("/disable", data));

export const enableRatingChart = createServerFn({ method: "POST" })
  .validator(validateBeatmapId)
  .handler(async ({ data }): Promise<RatingDisabledChartsView> => adminRequest<RatingDisabledChartsView>("/enable", data));
