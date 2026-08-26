import { createServerFn } from "@tanstack/react-start";
import { getServerLiveBackendUrl } from "./live-backend";
import { bridgeAuthHeaders } from "./live-backend-tokens";

// The skill and dan leaderboards on /rankings: "who are the best 7K chordjack
// players", "who is the best 4K jackspeed player". Every number is already
// stored per player by the backend's skill pipeline; these boards are a read
// over it.
//
// While the feature is in development the backend routes are bridge-gated and
// 404 to anyone else, so the read cannot go browser-direct like the pp board
// does. It travels through the server functions below, which prove admin off
// the osu!-verified login cookie before spending the shared token. Un-gating
// means dropping the backend's isBridge guard and adding a fetchLiveJson
// fetcher in live-backend.ts; the component's fetcher is the only other line
// that changes.

export type LeaderboardTab = "pp" | "skills" | "dan";
export type DanSide = "rc" | "ln";

export const LEADERBOARD_KEY_COUNTS = [4, 7, 6] as const;
export type LeaderboardKeyCount = (typeof LEADERBOARD_KEY_COUNTS)[number];

export const LEADERBOARD_PAGE_SIZE = 50;

export const DEFAULT_LEADERBOARD_TAB: LeaderboardTab = "pp";
// The "no particular skill" board: the aggregate every keymode rates, and what
// an unset axis means. Picking a specialty is opt-in, not a prerequisite.
export const DEFAULT_LEADERBOARD_AXIS = "Overall";
export const DEFAULT_LEADERBOARD_KEYS: LeaderboardKeyCount = 4;
export const DEFAULT_DAN_SIDE: DanSide = "rc";

export function parseLeaderboardTab(value: unknown): LeaderboardTab {
  return value === "skills" || value === "dan" ? value : DEFAULT_LEADERBOARD_TAB;
}

export function parseLeaderboardKeys(value: unknown): LeaderboardKeyCount {
  const keys = Number(value);
  return (LEADERBOARD_KEY_COUNTS as readonly number[]).includes(keys)
    ? (keys as LeaderboardKeyCount)
    : DEFAULT_LEADERBOARD_KEYS;
}

export function parseDanSide(value: unknown): DanSide {
  return value === "ln" ? "ln" : DEFAULT_DAN_SIDE;
}

/* The axis travels in the URL, so it is bounded here rather than trusted: the
   backend whitelists it per keymode anyway, but a garbage value should not
   reach a fetch at all. */
export function parseLeaderboardAxis(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const axis = value.trim();
  return /^(pattern:)?[A-Za-z]{1,24}$/.test(axis) ? axis : undefined;
}

export interface LeaderboardUser {
  id: number;
  username: string;
  avatar_url: string;
  country_code: string;
  global_rank: number | null;
}

export interface SkillLeaderboardEntry {
  rank: number;
  user: LeaderboardUser;
  value: number;
  plays: number;
  analyzedPlays: number;
  provisional?: boolean;
  percentile?: number;
}

export interface DanLeaderboardEntry {
  rank: number;
  user: LeaderboardUser;
  rawDan: number;
  label: string;
  analyzedPlays: number;
  beyondTable?: boolean;
}

export interface LeaderboardAxisInfo {
  axis: string;
  players: number;
}

interface LeaderboardSnapshotBase {
  total: number;
  page: number;
  pageSize: number;
  keyCount: number;
  fetchedAt: number;
  shrunk: boolean;
  coverage: { current: number; total: number };
}

export interface SkillLeaderboardSnapshot extends LeaderboardSnapshotBase {
  axis: string;
  ranking: SkillLeaderboardEntry[];
  axes: LeaderboardAxisInfo[];
}

export interface DanLeaderboardSnapshot extends LeaderboardSnapshotBase {
  side: DanSide;
  ranking: DanLeaderboardEntry[];
  sides: Array<{ side: DanSide; players: number }>;
}

async function readAsAdmin<T>(path: string, params: URLSearchParams): Promise<T | null> {
  const { setResponseHeader } = await import("@tanstack/react-start/server");
  setResponseHeader("Cache-Control", "private, no-store");
  const { readCurrentAuth } = await import("./auth-server");
  const { canUseAdminFeatures } = await import("./auth-shared");
  const auth = await readCurrentAuth();
  if (!canUseAdminFeatures(auth)) return null;
  const base = getServerLiveBackendUrl();
  if (!base) return null;
  try {
    const response = await fetch(`${base}${path}?${params.toString()}`, { headers: bridgeAuthHeaders() });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

export const fetchSkillLeaderboard = createServerFn({ method: "GET" })
  .validator((data: { country: string; keys: number; axis: string; page?: number }) => data)
  .handler(async ({ data }): Promise<SkillLeaderboardSnapshot | null> => {
    return readAsAdmin<SkillLeaderboardSnapshot>(
      "/api/snapshots/skill-leaderboard",
      new URLSearchParams({
        country: data.country,
        keys: String(data.keys),
        axis: data.axis,
        page: String(Math.max(1, Math.floor(data.page ?? 1))),
        pageSize: String(LEADERBOARD_PAGE_SIZE),
      }),
    );
  });

export const fetchDanLeaderboard = createServerFn({ method: "GET" })
  .validator((data: { country: string; keys: number; side: DanSide; page?: number }) => data)
  .handler(async ({ data }): Promise<DanLeaderboardSnapshot | null> => {
    return readAsAdmin<DanLeaderboardSnapshot>(
      "/api/snapshots/dan-leaderboard",
      new URLSearchParams({
        country: data.country,
        keys: String(data.keys),
        side: data.side,
        page: String(Math.max(1, Math.floor(data.page ?? 1))),
        pageSize: String(LEADERBOARD_PAGE_SIZE),
      }),
    );
  });
