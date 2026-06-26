import { createServerFn } from "@tanstack/react-start";

import type { LivePlayerActivitySnapshot } from "./live-backend";
import type { LeanTrackerScore } from "./types";

// Bridge to the live-backend My Data endpoints. Resolves the osu! viewer from the signed login
// cookie server-side and forwards it with the admin token, so the data is always the viewer's own.
// Returns null/empty when logged out or the live backend is not configured.

export const MY_DATA_PAGE_SIZE = 12;

export interface MyDataPage<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface MyDataTrackedPlay extends LeanTrackerScore {
  archived?: boolean;
  archivedExact?: boolean;
}

export interface MyDataDashboard {
  summary: MyDataSummary | null;
  trackedPage: MyDataPage<MyDataTrackedPlay>;
  topPlayPage: MyDataPage<MyDataTopPlay>;
  activity: LivePlayerActivitySnapshot | null;
}

export interface MyDataBeatmapRef {
  beatmapId: number;
  beatmapsetId: number | null;
  label: string | null;
}

export interface MyDataRecord {
  value: number;
  beatmap: MyDataBeatmapRef | null;
}

export interface MyDataModStat {
  mod: string;
  count: number;
  pct: number;
}

export interface MyDataKeyStat {
  keyCount: number;
  weightedPp: number;
  scoreCount: number;
}

export interface MyDataSummary {
  userId: number;
  username: string | null;
  avatarUrl: string | null;
  coverUrl: string | null;
  countryCode: string | null;
  pp: number | null;
  globalRank: number | null;
  countryRank: number | null;
  tracked: boolean;
  rankedMember: boolean;
  trackedCountries: string[];
  totalScores: number;
  passedScores: number;
  activeDays: number;
  sessions: number;
  firstTrackedDay: string | null;
  lastTrackedDay: string | null;
  topPlayCount: number;
  highlights: {
    topPlay: MyDataRecord | null;
    biggestDay: { count: number; day: string } | null;
    longestStreak: number;
    longestStreakRange: { startDay: string; endDay: string } | null;
    ppGainedTracked: number;
  };
  rhythm: {
    timezone: string;
    sampleSize: number;
    byHour: number[];
    byDay: number[];
    peakHour: number | null;
    peakDay: number | null;
  };
  mods: {
    sample: number;
    noModPct: number;
    top: MyDataModStat[];
  };
  keyStats: MyDataKeyStat[];
  cardsCollected: number;
  cardCopies: number;
  goalsOpen: number;
  goalsCompleted: number;
  generatedAt: string;
}

type MyDataBackendConfig = { base: string; headers: HeadersInit; userId: number };

async function myDataBackend(): Promise<MyDataBackendConfig | null> {
  const { readCurrentAuth } = await import("./auth-server");
  const auth = await readCurrentAuth();
  if (!auth.viewer) return null;
  const base = (process.env.LIVE_BACKEND_URL || process.env.VITE_LIVE_BACKEND_URL)?.trim().replace(/\/$/, "");
  if (!base) return null;
  const headers: HeadersInit = { "content-type": "application/json" };
  if (process.env.LIVE_ADMIN_TOKEN) headers.authorization = `Bearer ${process.env.LIVE_ADMIN_TOKEN}`;
  return { base, headers, userId: auth.viewer.id };
}

async function fetchMyDataSummaryRaw(cfg: MyDataBackendConfig): Promise<MyDataSummary | null> {
  try {
    const response = await fetch(`${cfg.base}/api/my-data/summary?userId=${cfg.userId}`, { headers: cfg.headers });
    if (!response.ok) return null;
    return (await response.json()) as MyDataSummary;
  } catch {
    return null;
  }
}

export const fetchMyDataSummary = createServerFn({ method: "GET" }).handler(async (): Promise<MyDataSummary | null> => {
  const { setResponseHeader } = await import("@tanstack/react-start/server");
  setResponseHeader("Cache-Control", "private, no-store");
  const cfg = await myDataBackend();
  if (!cfg) return null;
  return fetchMyDataSummaryRaw(cfg);
});

function emptyPage<T>(pageIndex: number): MyDataPage<T> {
  return { items: [], total: 0, limit: MY_DATA_PAGE_SIZE, offset: Math.max(0, pageIndex) * MY_DATA_PAGE_SIZE };
}

function readPageBody<T>(body: { items?: T[]; total?: number; limit?: number; offset?: number } | null | undefined, fallbackOffset: number): MyDataPage<T> {
  return {
    items: Array.isArray(body?.items) ? body.items : [],
    total: Number.isFinite(Number(body?.total)) ? Math.max(0, Number(body?.total)) : 0,
    limit: Number.isFinite(Number(body?.limit)) ? Math.max(1, Number(body?.limit)) : MY_DATA_PAGE_SIZE,
    offset: Number.isFinite(Number(body?.offset)) ? Math.max(0, Number(body?.offset)) : fallbackOffset,
  };
}

function emptyDashboard(): MyDataDashboard {
  return {
    summary: null,
    trackedPage: emptyPage<MyDataTrackedPlay>(0),
    topPlayPage: emptyPage<MyDataTopPlay>(0),
    activity: null,
  };
}

async function fetchMyDataFeedRaw(cfg: MyDataBackendConfig, pageIndex: number): Promise<MyDataPage<MyDataTrackedPlay>> {
  try {
    const offset = pageIndex * MY_DATA_PAGE_SIZE;
    const response = await fetch(`${cfg.base}/api/my-data/feed?userId=${cfg.userId}&limit=${MY_DATA_PAGE_SIZE}&offset=${offset}`, { headers: cfg.headers });
    if (!response.ok) return emptyPage(pageIndex);
    const body = (await response.json()) as { scores?: MyDataTrackedPlay[]; total?: number; limit?: number; offset?: number };
    return {
      items: Array.isArray(body.scores) ? body.scores : [],
      total: Number.isFinite(Number(body.total)) ? Math.max(0, Number(body.total)) : 0,
      limit: Number.isFinite(Number(body.limit)) ? Math.max(1, Number(body.limit)) : MY_DATA_PAGE_SIZE,
      offset: Number.isFinite(Number(body.offset)) ? Math.max(0, Number(body.offset)) : offset,
    };
  } catch {
    return emptyPage(pageIndex);
  }
}

async function fetchMyDataTopPlaysRaw(cfg: MyDataBackendConfig, pageIndex: number): Promise<MyDataPage<MyDataTopPlay>> {
  try {
    const offset = pageIndex * MY_DATA_PAGE_SIZE;
    const response = await fetch(`${cfg.base}/api/my-data/top-plays?userId=${cfg.userId}&limit=${MY_DATA_PAGE_SIZE}&offset=${offset}`, { headers: cfg.headers });
    if (!response.ok) return emptyPage(pageIndex);
    const body = (await response.json()) as { plays?: MyDataTopPlay[]; total?: number; limit?: number; offset?: number };
    return {
      items: Array.isArray(body.plays) ? body.plays : [],
      total: Number.isFinite(Number(body.total)) ? Math.max(0, Number(body.total)) : 0,
      limit: Number.isFinite(Number(body.limit)) ? Math.max(1, Number(body.limit)) : MY_DATA_PAGE_SIZE,
      offset: Number.isFinite(Number(body.offset)) ? Math.max(0, Number(body.offset)) : offset,
    };
  } catch {
    return emptyPage(pageIndex);
  }
}

async function fetchMyDataActivityRaw(cfg: MyDataBackendConfig, country: string, year: number): Promise<LivePlayerActivitySnapshot | null> {
  try {
    const query = new URLSearchParams({ country, year: String(year) });
    const response = await fetch(`${cfg.base}/api/profiles/${cfg.userId}/activity?${query.toString()}`, {
      headers: cfg.headers,
    });
    if (!response.ok) return null;
    return (await response.json()) as LivePlayerActivitySnapshot;
  } catch {
    return null;
  }
}

async function fetchMyDataDashboardFallback(cfg: MyDataBackendConfig, year: number): Promise<MyDataDashboard> {
  const summary = await fetchMyDataSummaryRaw(cfg);
  if (!summary?.tracked) {
    return {
      summary,
      trackedPage: emptyPage<MyDataTrackedPlay>(0),
      topPlayPage: emptyPage<MyDataTopPlay>(0),
      activity: null,
    };
  }
  const activityCountry = summary.countryCode ?? summary.trackedCountries[0] ?? "GLOBAL";
  const [trackedPage, topPlayPage, activity] = await Promise.all([
    fetchMyDataFeedRaw(cfg, 0),
    fetchMyDataTopPlaysRaw(cfg, 0),
    fetchMyDataActivityRaw(cfg, activityCountry, year),
  ]);
  return { summary, trackedPage, topPlayPage, activity };
}

function readPageIndex(value: unknown): number {
  const pageIndex = Number(value ?? 0);
  return Number.isInteger(pageIndex) && pageIndex > 0 ? Math.min(pageIndex, 100_000) : 0;
}

export const fetchMyDataFeed = createServerFn({ method: "GET" })
  .inputValidator((data: { pageIndex?: unknown } | undefined) => ({ pageIndex: readPageIndex(data?.pageIndex) }))
  .handler(async ({ data }): Promise<MyDataPage<MyDataTrackedPlay>> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    const cfg = await myDataBackend();
    if (!cfg) return emptyPage(data.pageIndex);
    return fetchMyDataFeedRaw(cfg, data.pageIndex);
  });

export const fetchMyDataDashboard = createServerFn({ method: "GET" })
  .handler(async (): Promise<MyDataDashboard> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    const cfg = await myDataBackend();
    if (!cfg) return emptyDashboard();
    try {
      const year = new Date().getFullYear();
      const query = new URLSearchParams({
        userId: String(cfg.userId),
        limit: String(MY_DATA_PAGE_SIZE),
        trackedOffset: "0",
        topOffset: "0",
        year: String(year),
      });
      const response = await fetch(`${cfg.base}/api/my-data/dashboard?${query.toString()}`, { headers: cfg.headers });
      if (!response.ok) return fetchMyDataDashboardFallback(cfg, year);
      const body = (await response.json()) as {
        summary?: MyDataSummary | null;
        trackedPage?: { items?: MyDataTrackedPlay[]; total?: number; limit?: number; offset?: number };
        topPlayPage?: { items?: MyDataTopPlay[]; total?: number; limit?: number; offset?: number };
        activity?: LivePlayerActivitySnapshot | null;
      };
      return {
        summary: body.summary ?? null,
        trackedPage: readPageBody(body.trackedPage, 0),
        topPlayPage: readPageBody(body.topPlayPage, 0),
        activity: body.activity ?? null,
      };
    } catch {
      return fetchMyDataDashboardFallback(cfg, new Date().getFullYear());
    }
  });

export interface MyDataTopPlay {
  score: LeanTrackerScore;
  ppGain: number;
}

export const fetchMyDataTopPlays = createServerFn({ method: "GET" })
  .inputValidator((data: { pageIndex?: unknown } | undefined) => ({ pageIndex: readPageIndex(data?.pageIndex) }))
  .handler(async ({ data }): Promise<MyDataPage<MyDataTopPlay>> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    const cfg = await myDataBackend();
    if (!cfg) return emptyPage(data.pageIndex);
    return fetchMyDataTopPlaysRaw(cfg, data.pageIndex);
  });

export const fetchMyDataActivity = createServerFn({ method: "GET" })
  .inputValidator((data: { country?: unknown; year?: unknown }) => {
    const rawCountry = typeof data?.country === "string" ? data.country.trim().toUpperCase() : "GLOBAL";
    const country = rawCountry === "GLOBAL" || /^[A-Z]{2}$/.test(rawCountry) ? rawCountry : "GLOBAL";
    const rawYear = Number(data?.year);
    const year = Number.isInteger(rawYear)
      ? Math.max(2007, Math.min(2100, rawYear))
      : new Date().getFullYear();
    return { country, year };
  })
  .handler(async ({ data }): Promise<LivePlayerActivitySnapshot | null> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    const cfg = await myDataBackend();
    if (!cfg) return null;
    return fetchMyDataActivityRaw(cfg, data.country, data.year);
  });
