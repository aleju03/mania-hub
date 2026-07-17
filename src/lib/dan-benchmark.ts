import { createServerFn } from "@tanstack/react-start";
import { requireAdminAccess } from "./auth";
import { getServerLiveBackendUrl } from "./live-backend";
import type { DanBenchmarkFamily } from "./dan-benchmark-sets";

// Server fns for the /admin/dan-classifier page. The benchmark ground truth (owner-curated labels
// and hidden diffs) lives in the live backend (dan_benchmark_labels / dan_benchmark_hidden_diffs);
// these proxy through with the shared admin token. Mirrors the admin-todos proxy shape.

export interface DanBenchmarkLabel {
  beatmapId: number;
  expectedLabel: string;
  family: DanBenchmarkFamily;
  updatedAt: number;
}

function isBenchmarkFamily(value: unknown): value is DanBenchmarkFamily {
  return value === "normal" || value === "ln" || value === "ranked";
}

function normalizeListPayload(input: unknown): { family: DanBenchmarkFamily } {
  if (!input || typeof input !== "object") throw new Error("Invalid payload.");
  const data = input as { family?: unknown };
  if (!isBenchmarkFamily(data.family)) throw new Error("Invalid family.");
  return { family: data.family };
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

export const getDanBenchmarkLabels = createServerFn({ method: "GET" })
  .inputValidator(normalizeListPayload)
  .handler(async ({ data }: { data: { family: DanBenchmarkFamily } }): Promise<DanBenchmarkLabel[]> => {
    await requireAdminAccess("getDanBenchmarkLabels");
    const base = requireLiveBackendBase();
    const response = await fetchLiveBackend(
      `${base}/api/admin/dan-benchmark/labels?family=${data.family}`,
      { headers: liveBackendHeaders() },
    );
    if (!response.ok) throw new Error(`Dan benchmark labels failed (${response.status}).`);
    const payload = await response.json() as { labels: DanBenchmarkLabel[] };
    return payload.labels;
  });

export const getDanBenchmarkHiddenDiffs = createServerFn({ method: "GET" })
  .inputValidator(normalizeListPayload)
  .handler(async ({ data }: { data: { family: DanBenchmarkFamily } }): Promise<number[]> => {
    await requireAdminAccess("getDanBenchmarkHiddenDiffs");
    const base = requireLiveBackendBase();
    const response = await fetchLiveBackend(
      `${base}/api/admin/dan-benchmark/hidden?family=${data.family}`,
      { headers: liveBackendHeaders() },
    );
    if (!response.ok) throw new Error(`Dan benchmark hidden diffs failed (${response.status}).`);
    const payload = await response.json() as { hidden: number[] };
    return payload.hidden;
  });

function normalizeHidePayload(input: unknown): {
  beatmapId: number;
  family: DanBenchmarkFamily;
  hidden: boolean;
} {
  if (!input || typeof input !== "object") throw new Error("Invalid payload.");
  const data = input as { beatmapId?: unknown; family?: unknown; hidden?: unknown };
  const beatmapId = Number(data.beatmapId);
  if (!Number.isSafeInteger(beatmapId) || beatmapId <= 0) throw new Error("Invalid beatmapId.");
  if (!isBenchmarkFamily(data.family)) throw new Error("Invalid family.");
  return { beatmapId, family: data.family, hidden: data.hidden === true };
}

function normalizeSavePayload(input: unknown): {
  beatmapId: number;
  family: DanBenchmarkFamily;
  expectedLabel: string | null;
} {
  if (!input || typeof input !== "object") throw new Error("Invalid payload.");
  const data = input as { beatmapId?: unknown; family?: unknown; expectedLabel?: unknown };
  const beatmapId = Number(data.beatmapId);
  if (!Number.isSafeInteger(beatmapId) || beatmapId <= 0) throw new Error("Invalid beatmapId.");
  if (!isBenchmarkFamily(data.family)) throw new Error("Invalid family.");
  const expectedLabel = data.expectedLabel === null || data.expectedLabel === ""
    ? null
    : typeof data.expectedLabel === "string" && data.expectedLabel.length <= 32
      ? data.expectedLabel
      : null;
  return { beatmapId, family: data.family, expectedLabel };
}

async function postDanBenchmark(path: string, payload: unknown): Promise<void> {
  const base = requireLiveBackendBase();
  const response = await fetchLiveBackend(`${base}${path}`, {
    method: "POST",
    headers: { ...liveBackendHeaders(), "content-type": "application/json" },
    body: JSON.stringify(payload ?? {}),
  });
  if (!response.ok) throw new Error(`Dan benchmark update failed (${response.status}).`);
}

export const setDanBenchmarkHiddenDiff = createServerFn({ method: "POST" })
  .inputValidator(normalizeHidePayload)
  .handler(async ({ data }: { data: { beatmapId: number; family: DanBenchmarkFamily; hidden: boolean } }): Promise<{ ok: true }> => {
    await requireAdminAccess("setDanBenchmarkHiddenDiff");
    await postDanBenchmark("/api/admin/dan-benchmark/set-hidden", data);
    return { ok: true };
  });

export const setDanBenchmarkLabel = createServerFn({ method: "POST" })
  .inputValidator(normalizeSavePayload)
  .handler(async ({ data }: { data: { beatmapId: number; family: DanBenchmarkFamily; expectedLabel: string | null } }): Promise<{ ok: true }> => {
    await requireAdminAccess("setDanBenchmarkLabel");
    await postDanBenchmark("/api/admin/dan-benchmark/set-label", data);
    return { ok: true };
  });
