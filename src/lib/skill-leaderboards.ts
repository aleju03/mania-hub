// The skill and dan leaderboards on /rankings: "who are the best 7K chordjack
// players", "who is the best 4K jackspeed player". Every number is already
// stored per player by the backend's skill pipeline; these boards are a read
// over it.
//
// Types and URL parsing only. The reads are public and go browser-direct like
// the pp board does (fetchLiveSkillLeaderboard / fetchLiveDanLeaderboard in
// live-backend.ts).

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
  coverage: { current: number; total: number };
}

export interface SkillLeaderboardSnapshot extends LeaderboardSnapshotBase {
  axis: string;
  ranking: SkillLeaderboardEntry[];
  axes: LeaderboardAxisInfo[];
  // Per axis, not per board: false means this axis has no population median,
  // so its ratings are raw and will not match the profile page. Dan snapshots
  // carry no such flag, a dan is not shrunk at all.
  shrunk: boolean;
}

export interface DanLeaderboardSnapshot extends LeaderboardSnapshotBase {
  side: DanSide;
  ranking: DanLeaderboardEntry[];
  sides: Array<{ side: DanSide; players: number }>;
}
