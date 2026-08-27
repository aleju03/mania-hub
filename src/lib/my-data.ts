import { createServerFn } from "@tanstack/react-start";

import type { LeanTrackerScore } from "./types";
import { liveBridgeToken } from "./live-backend-tokens";

// Bridge to the live-backend My Data endpoints. Resolves the osu! viewer from the signed login
// cookie server-side and forwards it with the bridge token, so the data is always the viewer's own.
// Returns null/empty when logged out or the live backend is not configured.

export const MY_DATA_PAGE_SIZE = 12;

export interface MyDataPage<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export type MyDataModFilter = "all" | "nomod" | "modded";
export type MyDataArchiveFilter = "all" | "current" | "archived";
export type MyDataTrackedSort = "recent_desc" | "recent_asc" | "pp_desc" | "accuracy_desc" | "stars_desc";
export type MyDataTopPlaySort = "pp_desc" | "pp_asc" | "recent_desc" | "recent_asc" | "gain_desc" | "accuracy_desc";

export interface MyDataFeedFilters {
  query?: string;
  key?: string;
  mods?: MyDataModFilter;
}

export interface MyDataTrackedFeedParams extends MyDataFeedFilters {
  archive?: MyDataArchiveFilter;
  sort?: MyDataTrackedSort;
}

export interface MyDataTopPlaysParams extends MyDataFeedFilters {
  sort?: MyDataTopPlaySort;
}

export interface MyDataTrackedPlay extends LeanTrackerScore {
  archived?: boolean;
  archivedExact?: boolean;
}

export interface MyDataDashboard {
  summary: MyDataSummary | null;
  trackedPage: MyDataPage<MyDataTrackedPlay>;
  topPlayPage: MyDataPage<MyDataTopPlay>;
  skills: MyDataSkillBreakdown | null;
}

// Player dan positioning per verdict side (RC vs LN), on the chart-dan scale.
export interface MyDataSkillDanSide {
  rawDan: number;
  label: string;
  clears: number;
  // The estimate pins at the top of this keymode's dan ladder (6K regular
  // ends at 9th, 7K at stellium), so the label is a floor, not a reading.
  beyondTable?: boolean;
  // Set when a verified clear of a real dan course raised this headline above
  // the averaged estimate; names the course that did it.
  courseClear?: MyDataSkillDanCourseClear;
}

export interface MyDataSkillDanCourseClear {
  beatmapId: number;
  courseName: string;
  level: string;
  accuracy: number;
  currency: "stable" | "v2";
  bar: number;
  displayedAccuracy?: number | null;
}

// Share of the tracked population rating below the subject (0-100), from the
// backend's approximate-SSR baseline curves.
export interface MyDataSkillPercentile {
  value: number;
  population: number;
}

export interface MyDataSkillMode {
  keyCount: number;
  analyzedPlays: number;
  ratings: Record<string, number>;
  // Per-pattern ratings in the in-house pattern vocabulary (Overall SSRs
  // aggregated over chart-analysis tags); the keymode-honest axes for non-4K.
  patterns: Array<{ id: string; rating: number; plays: number }>;
  dan?: { rc: MyDataSkillDanSide | null; ln: MyDataSkillDanSide | null };
  // Keys are skillset names or `pattern:{id}` axes.
  percentiles?: Record<string, MyDataSkillPercentile>;
  // Thin evidence base (few analyzed plays): ratings are served shrunk toward
  // the population median and should read as rough estimates.
  provisional?: boolean;
}

// Etterna-style skillset ratings aggregated from the player's top plays by the
// live backend's chart analyzer (MinaCalc SSRs at the played rate).
export interface MyDataSkillBreakdown {
  status: "pending" | "ready" | "failed";
  version: number;
  computedAt: string | null;
  totalPlays: number;
  analyzedPlays: number;
  pendingPlays: number;
  unsupportedPlays: number;
  modes: MyDataSkillMode[];
  // Present when the population baseline has been computed; users counts the
  // tracked players behind each keymode's percentile curves.
  baseline?: { computedAt: string; users: Record<string, number> } | null;
  // Non-ready only: where the compute sits in the backend's analyzer lane.
  // position is 1-based among waiting jobs; null while the job is running.
  queue?: { state: "queued" | "running"; position: number | null; waiting: number } | null;
  // Ready only: the served snapshot is known-superseded and a recompute is on
  // its way; present the numbers as refreshing, not final.
  stale?: boolean;
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
  const bridgeToken = liveBridgeToken();
  if (bridgeToken) headers.authorization = `Bearer ${bridgeToken}`;
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
    skills: null,
  };
}

function appendMyDataFilters(query: URLSearchParams, filters: MyDataTrackedFeedParams | MyDataTopPlaysParams | undefined): void {
  const search = filters?.query?.trim();
  if (search) query.set("q", search.slice(0, 80));
  if (filters?.key && filters.key !== "all") query.set("key", filters.key);
  if (filters?.mods && filters.mods !== "all") query.set("mods", filters.mods);
  const archive = filters && "archive" in filters ? filters.archive : undefined;
  if (archive && archive !== "all") query.set("archive", archive);
  if (filters?.sort) query.set("sort", filters.sort);
}

async function fetchMyDataFeedRaw(cfg: MyDataBackendConfig, pageIndex: number, filters?: MyDataTrackedFeedParams): Promise<MyDataPage<MyDataTrackedPlay>> {
  try {
    const offset = pageIndex * MY_DATA_PAGE_SIZE;
    const query = new URLSearchParams({ userId: String(cfg.userId), limit: String(MY_DATA_PAGE_SIZE), offset: String(offset) });
    appendMyDataFilters(query, filters);
    const response = await fetch(`${cfg.base}/api/my-data/feed?${query.toString()}`, { headers: cfg.headers });
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

async function fetchMyDataTopPlaysRaw(cfg: MyDataBackendConfig, pageIndex: number, filters?: MyDataTopPlaysParams): Promise<MyDataPage<MyDataTopPlay>> {
  try {
    const offset = pageIndex * MY_DATA_PAGE_SIZE;
    const query = new URLSearchParams({ userId: String(cfg.userId), limit: String(MY_DATA_PAGE_SIZE), offset: String(offset) });
    appendMyDataFilters(query, filters);
    const response = await fetch(`${cfg.base}/api/my-data/top-plays?${query.toString()}`, { headers: cfg.headers });
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

async function fetchMyDataSkillsRaw(cfg: MyDataBackendConfig): Promise<MyDataSkillBreakdown | null> {
  try {
    const response = await fetch(`${cfg.base}/api/my-data/skills?userId=${cfg.userId}`, { headers: cfg.headers });
    if (!response.ok) return null;
    return (await response.json()) as MyDataSkillBreakdown;
  } catch {
    return null;
  }
}

async function fetchMyDataDashboardFallback(cfg: MyDataBackendConfig): Promise<MyDataDashboard> {
  const summary = await fetchMyDataSummaryRaw(cfg);
  if (!summary?.tracked) {
    return {
      summary,
      trackedPage: emptyPage<MyDataTrackedPlay>(0),
      topPlayPage: emptyPage<MyDataTopPlay>(0),
      skills: null,
    };
  }
  const [trackedPage, topPlayPage, skills] = await Promise.all([
    fetchMyDataFeedRaw(cfg, 0),
    fetchMyDataTopPlaysRaw(cfg, 0),
    fetchMyDataSkillsRaw(cfg),
  ]);
  return { summary, trackedPage, topPlayPage, skills };
}

function readPageIndex(value: unknown): number {
  const pageIndex = Number(value ?? 0);
  return Number.isInteger(pageIndex) && pageIndex > 0 ? Math.min(pageIndex, 100_000) : 0;
}

function readQuery(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 80) : undefined;
}

function readKeyFilter(value: unknown): string | undefined {
  if (value === "all" || value == null) return undefined;
  const key = Number(value);
  return Number.isInteger(key) && key >= 1 && key <= 18 ? String(key) : undefined;
}

function readModFilter(value: unknown): MyDataModFilter | undefined {
  return value === "nomod" || value === "modded" ? value : undefined;
}

function readArchiveFilter(value: unknown): MyDataArchiveFilter | undefined {
  return value === "current" || value === "archived" ? value : undefined;
}

function readTrackedSort(value: unknown): MyDataTrackedSort | undefined {
  return value === "recent_asc" || value === "pp_desc" || value === "accuracy_desc" || value === "stars_desc" ? value : undefined;
}

function readTopPlaySort(value: unknown): MyDataTopPlaySort | undefined {
  return value === "pp_asc" || value === "recent_desc" || value === "recent_asc" || value === "gain_desc" || value === "accuracy_desc" ? value : undefined;
}

function readTrackedParams(data: { pageIndex?: unknown; query?: unknown; key?: unknown; mods?: unknown; archive?: unknown; sort?: unknown } | undefined): MyDataTrackedFeedParams & { pageIndex: number } {
  return {
    pageIndex: readPageIndex(data?.pageIndex),
    query: readQuery(data?.query),
    key: readKeyFilter(data?.key),
    mods: readModFilter(data?.mods),
    archive: readArchiveFilter(data?.archive),
    sort: readTrackedSort(data?.sort),
  };
}

function readTopPlayParams(data: { pageIndex?: unknown; query?: unknown; key?: unknown; mods?: unknown; sort?: unknown } | undefined): MyDataTopPlaysParams & { pageIndex: number } {
  return {
    pageIndex: readPageIndex(data?.pageIndex),
    query: readQuery(data?.query),
    key: readKeyFilter(data?.key),
    mods: readModFilter(data?.mods),
    sort: readTopPlaySort(data?.sort),
  };
}

export const fetchMyDataFeed = createServerFn({ method: "GET" })
  .validator(readTrackedParams)
  .handler(async ({ data }): Promise<MyDataPage<MyDataTrackedPlay>> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    const cfg = await myDataBackend();
    if (!cfg) return emptyPage(data.pageIndex);
    return fetchMyDataFeedRaw(cfg, data.pageIndex, data);
  });

export const fetchMyDataDashboard = createServerFn({ method: "GET" })
  .handler(async (): Promise<MyDataDashboard> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    const cfg = await myDataBackend();
    if (!cfg) return emptyDashboard();
    try {
      const query = new URLSearchParams({
        userId: String(cfg.userId),
        limit: String(MY_DATA_PAGE_SIZE),
        trackedOffset: "0",
        topOffset: "0",
      });
      const response = await fetch(`${cfg.base}/api/my-data/dashboard?${query.toString()}`, { headers: cfg.headers });
      if (!response.ok) return fetchMyDataDashboardFallback(cfg);
      const body = (await response.json()) as {
        summary?: MyDataSummary | null;
        trackedPage?: { items?: MyDataTrackedPlay[]; total?: number; limit?: number; offset?: number };
        topPlayPage?: { items?: MyDataTopPlay[]; total?: number; limit?: number; offset?: number };
        skills?: MyDataSkillBreakdown | null;
      };
      return {
        summary: body.summary ?? null,
        trackedPage: readPageBody(body.trackedPage, 0),
        topPlayPage: readPageBody(body.topPlayPage, 0),
        skills: body.skills ?? null,
      };
    } catch {
      return fetchMyDataDashboardFallback(cfg);
    }
  });

export interface MyDataTopPlay {
  score: LeanTrackerScore;
  ppGain: number;
}

export const fetchMyDataTopPlays = createServerFn({ method: "GET" })
  .validator(readTopPlayParams)
  .handler(async ({ data }): Promise<MyDataPage<MyDataTopPlay>> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    const cfg = await myDataBackend();
    if (!cfg) return emptyPage(data.pageIndex);
    return fetchMyDataTopPlaysRaw(cfg, data.pageIndex, data);
  });

export const fetchMyDataSkills = createServerFn({ method: "GET" })
  .handler(async (): Promise<MyDataSkillBreakdown | null> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    const cfg = await myDataBackend();
    if (!cfg) return null;
    return fetchMyDataSkillsRaw(cfg);
  });
