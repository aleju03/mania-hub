import { createServerFn } from "@tanstack/react-start";
import { requireDevFeatureAccess } from "./auth";
import { getServerLiveBackendUrl } from "./live-backend";

// Server fns for the /admin/dan-classifier page. All chart data comes from the
// live backend's local projections (beatmap_osu_files / beatmaps / beatmapsets):
// nothing here touches the osu! API unless the caller explicitly opts in with
// allowOsuFetch for a chart that is not cached.

export interface DanClassifierDiffMeta {
  beatmapId: number;
  beatmapsetId: number;
  version: string;
  starRating: number | null;
  keyCount: number | null;
  mode: string;
  cached: boolean;
}

export interface DanClassifierSetMeta {
  beatmapsetId: number;
  title: string | null;
  artist: string | null;
  diffs: DanClassifierDiffMeta[];
}

export interface DanClassifierSetsResult {
  sets: DanClassifierSetMeta[];
  missingBeatmapsetIds: number[];
  missingBeatmapIds: number[];
}

function liveBackendHeaders(): HeadersInit {
  // connection: close sidesteps keep-alive socket reuse between the frontend
  // server and the live backend, which intermittently dies mid-response on
  // large payloads ("other side closed"); localhost connection setup is free.
  const headers: HeadersInit = { connection: "close" };
  if (process.env.LIVE_ADMIN_TOKEN) {
    headers.authorization = `Bearer ${process.env.LIVE_ADMIN_TOKEN}`;
  }
  return headers;
}

// Network-level failures (socket reuse races, backend restarts) get one retry;
// HTTP error statuses do not, those are real answers.
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

function normalizeIdList(value: unknown, limit: number): number[] {
  if (!Array.isArray(value)) return [];
  const out: number[] = [];
  for (const entry of value) {
    const id = Math.floor(Number(entry));
    if (Number.isFinite(id) && id > 0 && !out.includes(id)) out.push(id);
  }
  return out.slice(0, limit);
}

// Chart text for one beatmap. Cached-only by default; allowOsuFetch=true lets the
// live backend hit the osu! API for this one chart (the explicit opt-in path).
export const getDanClassifierChartFile = createServerFn({ method: "POST" })
  .inputValidator((data: { beatmapId?: unknown; allowOsuFetch?: unknown }) => ({
    beatmapId: Math.floor(Number(data?.beatmapId)),
    allowOsuFetch: data?.allowOsuFetch === true,
  }))
  .handler(async ({ data }): Promise<{ content: string | null; notCached: boolean }> => {
    await requireDevFeatureAccess("Dan classifier chart file");
    if (!Number.isFinite(data.beatmapId) || data.beatmapId <= 0) throw new Error("Invalid beatmap id.");
    const base = requireLiveBackendBase();
    const params = new URLSearchParams({ beatmapId: String(data.beatmapId), caller: "dan_classifier_admin" });
    if (!data.allowOsuFetch) params.set("cachedOnly", "1");
    const response = await fetchLiveBackend(`${base}/api/osu/beatmap-file?${params.toString()}`, { headers: liveBackendHeaders() });
    if (response.status === 404 && !data.allowOsuFetch) {
      return { content: null, notCached: true };
    }
    if (!response.ok) {
      throw new Error(`Beatmap file request failed (${response.status}).`);
    }
    const content = await response.text();
    if (!content.startsWith("osu file format")) {
      throw new Error("Live backend returned an invalid .osu file.");
    }
    return { content, notCached: false };
  });

// Batch cached chart texts for the benchmark tab. Never fetches from osu!.
export const getDanClassifierChartBatch = createServerFn({ method: "POST" })
  .inputValidator((data: { ids?: unknown }) => ({
    ids: normalizeIdList(data?.ids, 50),
  }))
  .handler(async ({ data }): Promise<{ files: Array<{ beatmapId: number; content: string }>; missing: number[] }> => {
    await requireDevFeatureAccess("Dan classifier chart batch");
    if (!data.ids.length) return { files: [], missing: [] };
    const base = requireLiveBackendBase();
    const response = await fetchLiveBackend(`${base}/api/admin/dan-classifier/files`, {
      method: "POST",
      headers: { ...liveBackendHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ ids: data.ids }),
    });
    if (!response.ok) {
      throw new Error(`Chart batch request failed (${response.status}).`);
    }
    return await response.json() as { files: Array<{ beatmapId: number; content: string }>; missing: number[] };
  });

// Set/diff metadata from the live backend's beatmaps/beatmapsets projections.
export const getDanClassifierSets = createServerFn({ method: "POST" })
  .inputValidator((data: { beatmapsetIds?: unknown; beatmapIds?: unknown }) => ({
    beatmapsetIds: normalizeIdList(data?.beatmapsetIds, 100),
    beatmapIds: normalizeIdList(data?.beatmapIds, 400),
  }))
  .handler(async ({ data }): Promise<DanClassifierSetsResult> => {
    await requireDevFeatureAccess("Dan classifier set lookup");
    if (!data.beatmapsetIds.length && !data.beatmapIds.length) {
      return { sets: [], missingBeatmapsetIds: [], missingBeatmapIds: [] };
    }
    const base = requireLiveBackendBase();
    const response = await fetchLiveBackend(`${base}/api/admin/dan-classifier/sets`, {
      method: "POST",
      headers: { ...liveBackendHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ beatmapsetIds: data.beatmapsetIds, beatmapIds: data.beatmapIds }),
    });
    if (!response.ok) {
      throw new Error(`Set lookup failed (${response.status}).`);
    }
    return await response.json() as DanClassifierSetsResult;
  });
