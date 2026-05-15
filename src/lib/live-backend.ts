import { createServerFn } from "@tanstack/react-start";
import { requireAdminAccess } from "./auth";
import type { CountryMapsData, CountryTopPlay, LeanDanEstimate, LeanTrackerScore, SnipeEvent } from "./types";

export type LiveEventName =
  | "hello"
  | "heartbeat"
  | "status"
  | "tracker_score"
  | "score_gain"
  | "top_play"
  | "snipe"
  | "job_status";

export interface LiveTrackerSnapshot {
  country: string;
  scores: LeanTrackerScore[];
  gains: Record<number, number>;
  fetchedAt: number;
}

export interface LiveTopPlaysSnapshot {
  popoffs: CountryTopPlay[];
  scannedAt: number;
  window: "24h" | "3d" | "7d" | "30d";
}

export interface LiveSnipesSnapshot {
  events: SnipeEvent[];
  scannedAt: number;
}

export interface LiveMapsSnapshot {
  value: CountryMapsData | null;
  generatedAt: string | null;
  refreshedAt: string | null;
  isStale: boolean;
  refreshQueued: boolean;
}

export interface LiveDanEstimateRequest {
  beatmapId: number;
  starRating?: number;
  rate?: number;
}

export interface LiveDanEstimateBatch {
  results: Record<string, LeanDanEstimate | null>;
  pending: string[];
  estimatorVersion: number;
}

export interface LiveRankDelta {
  userId: number;
  globalChange: number | null;
  countryChange: number | null;
  oldGlobalRank: number | null;
  oldCountryRank: number | null;
  capturedAt: string;
}

export interface LiveRankDeltaSnapshot {
  country: string;
  windowDays: number;
  targetAt: string;
  deltas: Record<number, LiveRankDelta>;
}

export function getLiveBackendUrl(): string | null {
  const value = import.meta.env.VITE_LIVE_BACKEND_URL || import.meta.env.LIVE_BACKEND_URL;
  if (typeof value !== "string" || value.trim() === "") return null;
  return value.replace(/\/+$/, "");
}

export function isLiveBackendConfigured(): boolean {
  return getLiveBackendUrl() !== null;
}

function getServerLiveBackendUrl(): string | null {
  const value = process.env.LIVE_BACKEND_URL || process.env.VITE_LIVE_BACKEND_URL;
  if (typeof value !== "string" || value.trim() === "") return null;
  return value.replace(/\/+$/, "");
}

function normalizeAdminPath(input: unknown): string {
  if (typeof input !== "string") throw new Error("Invalid live backend admin path.");
  const url = new URL(input, "http://live-backend.local");
  const path = `${url.pathname}${url.search}`;
  const exact = new Set([
    "/api/admin/clear-failed-jobs",
    "/api/admin/pause-workers",
    "/api/admin/resume-workers",
    "/api/admin/run-retention",
    "/api/admin/osc-smoke",
    "/api/admin/run-osc-backfill",
    "/api/admin/reset-local-db",
  ]);
  if (exact.has(path)) return path;
  if (url.pathname === "/api/admin/refresh-roster") {
    const country = url.searchParams.get("country");
    if (country && /^[A-Za-z]{2}$/.test(country)) return `/api/admin/refresh-roster?country=${country.toUpperCase()}`;
  }
  if (url.pathname === "/api/admin/refresh-maps") {
    const country = url.searchParams.get("country");
    if (country && /^[A-Za-z]{2}$/.test(country)) return `/api/admin/refresh-maps?country=${country.toUpperCase()}`;
  }
  throw new Error("Unsupported live backend admin action.");
}

export const runLiveBackendAdminAction = createServerFn({ method: "POST" })
  .inputValidator((data: { path?: unknown }) => ({
    path: normalizeAdminPath(data?.path),
  }))
  .handler(async ({ data }): Promise<{ ok: boolean; body: string | null }> => {
    await requireAdminAccess("Live backend admin action");
    const base = getServerLiveBackendUrl();
    if (!base) throw new Error("LIVE_BACKEND_URL is not configured.");
    const headers: HeadersInit = {};
    if (process.env.LIVE_ADMIN_TOKEN) {
      headers.authorization = `Bearer ${process.env.LIVE_ADMIN_TOKEN}`;
    }
    const response = await fetch(`${base}${data.path}`, {
      method: "POST",
      headers,
    });
    const text = await response.text();
    const body = text ? JSON.parse(text) as Record<string, unknown> : null;
    if (!response.ok) {
      const message = body && typeof body === "object" && "error" in body
        ? String((body as { error?: unknown }).error)
        : `Live backend ${response.status} for ${data.path}`;
      throw new Error(message);
    }
    return { ok: true, body: text || null };
  });

export const fetchLiveBackendAdminStatus = createServerFn({ method: "GET" })
  .handler(async (): Promise<any> => {
    await requireAdminAccess("Live backend admin status");
    const base = getServerLiveBackendUrl();
    if (!base) throw new Error("LIVE_BACKEND_URL is not configured.");
    const headers: HeadersInit = {};
    if (process.env.LIVE_ADMIN_TOKEN) {
      headers.authorization = `Bearer ${process.env.LIVE_ADMIN_TOKEN}`;
    }
    let response = await fetch(`${base}/api/admin/status`, { headers });
    if (response.status === 404) {
      response = await fetch(`${base}/api/status`);
    }
    const body = await response.json() as any;
    if (!response.ok) {
      const message = body && typeof body === "object" && "error" in body
        ? String((body as { error?: unknown }).error)
        : `Live backend ${response.status} for /api/admin/status`;
      throw new Error(message);
    }
    return body;
  });

export async function fetchLiveTrackerSnapshot(country: string, limit = 100): Promise<LiveTrackerSnapshot> {
  return fetchLiveJson(`/api/snapshots/tracker?country=${encodeURIComponent(country)}&limit=${limit}`);
}

export async function activateLiveCountry(country: string): Promise<void> {
  const base = getLiveBackendUrl();
  if (!base) return;
  await fetch(`${base}/api/countries/activate?country=${encodeURIComponent(country)}`, {
    method: "POST",
    credentials: "omit",
  }).catch(() => {});
}

export async function fetchLiveTopPlaysSnapshot(country: string, window: LiveTopPlaysSnapshot["window"]): Promise<LiveTopPlaysSnapshot> {
  return fetchLiveJson(`/api/snapshots/top-plays?country=${encodeURIComponent(country)}&window=${window}`);
}

export async function fetchLiveSnipesSnapshot(country: string, limit = 500): Promise<LiveSnipesSnapshot> {
  return fetchLiveJson(`/api/snapshots/snipes?country=${encodeURIComponent(country)}&limit=${limit}`);
}

export async function fetchLiveMapsSnapshot(country: string): Promise<LiveMapsSnapshot> {
  return fetchLiveJson(`/api/snapshots/maps?country=${encodeURIComponent(country)}`);
}

export async function fetchLiveRankDeltas(country: string, userIds: number[]): Promise<LiveRankDeltaSnapshot> {
  const uniqueUserIds = [...new Set(userIds)]
    .filter((id) => Number.isInteger(id) && id > 0)
    .slice(0, 100);
  return fetchLiveJson(`/api/snapshots/rank-deltas?country=${encodeURIComponent(country)}&userIds=${uniqueUserIds.join(",")}`);
}

export async function fetchLiveDanEstimates(items: LiveDanEstimateRequest[], estimatorVersion: number): Promise<LiveDanEstimateBatch> {
  return fetchLiveJson("/api/dan-estimates", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ items, estimatorVersion, computeMissing: true }),
  });
}

export function openLiveEventSource(country: string): EventSource | null {
  const base = getLiveBackendUrl();
  if (!base || typeof EventSource === "undefined") return null;
  return new EventSource(`${base}/api/live?country=${encodeURIComponent(country)}`);
}

async function fetchLiveJson<T>(path: string, init?: RequestInit): Promise<T> {
  const base = getLiveBackendUrl();
  if (!base) throw new Error("Live backend is not configured.");
  const response = await fetch(`${base}${path}`, { credentials: "omit", ...init });
  if (!response.ok) throw new Error(`Live backend ${response.status}`);
  return response.json() as Promise<T>;
}
