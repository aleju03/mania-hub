import type { CountryTopPlay, LeanTrackerScore, SnipeEvent } from "./types";

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

export function getLiveBackendUrl(): string | null {
  const value = import.meta.env.VITE_LIVE_BACKEND_URL || import.meta.env.LIVE_BACKEND_URL;
  if (typeof value !== "string" || value.trim() === "") return null;
  return value.replace(/\/+$/, "");
}

export function isLiveBackendConfigured(): boolean {
  return getLiveBackendUrl() !== null;
}

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

export function openLiveEventSource(country: string): EventSource | null {
  const base = getLiveBackendUrl();
  if (!base || typeof EventSource === "undefined") return null;
  return new EventSource(`${base}/api/live?country=${encodeURIComponent(country)}`);
}

async function fetchLiveJson<T>(path: string): Promise<T> {
  const base = getLiveBackendUrl();
  if (!base) throw new Error("Live backend is not configured.");
  const response = await fetch(`${base}${path}`, { credentials: "omit" });
  if (!response.ok) throw new Error(`Live backend ${response.status}`);
  return response.json() as Promise<T>;
}
