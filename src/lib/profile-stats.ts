import { msg } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";

/* The four insight cards under a profile's stats. Everyone sees the usual
   four; a supporter can swap any of them for another, in any order, each at
   most once. The backend keeps the same ids (SUPPORTER_PROFILE_STATS in
   features/supporters.ts) and serves what the extra cards need beside the
   pick (profileStatsData), counted over everything the site tracked of the
   player rather than the top plays osu! lists. */

export const PROFILE_STATS = ["keySplit", "mostUsedMod", "medianBpm", "ppRange", "ratio", "lnSplit", "streak", "percentile", "session"] as const;
export type ProfileStatId = (typeof PROFILE_STATS)[number];
export const PROFILE_STAT_SLOTS = 4;
export const DEFAULT_PROFILE_STATS: readonly ProfileStatId[] = PROFILE_STATS.slice(0, PROFILE_STAT_SLOTS);

export const PROFILE_STAT_LABELS: Record<ProfileStatId, MessageDescriptor> = {
  keySplit: msg`Key Split`,
  mostUsedMod: msg`Most Used Mod`,
  medianBpm: msg`Median BPM`,
  ppRange: msg`PP Range`,
  ratio: msg`Ratio`,
  lnSplit: msg`Rice / LN`,
  streak: msg`Longest streak`,
  percentile: msg`Percentile`,
  session: msg`Longest session`,
};

export function isProfileStatId(value: unknown): value is ProfileStatId {
  return typeof value === "string" && (PROFILE_STATS as readonly string[]).includes(value);
}

/* Four distinct known ids, or null for the usual four. */
export function parseProfileStats(value: unknown): ProfileStatId[] | null {
  if (!Array.isArray(value) || value.length !== PROFILE_STAT_SLOTS || !value.every(isProfileStatId)) return null;
  return new Set(value).size === value.length ? value : null;
}

/* From everything the site tracked of the player, not just their top
   plays: MAX and 300 judgements over every map's best score each day,
   plays on LN charts against the rest, the day streaks, their longest
   sitting, and their place among the players the site tracks. */
export interface ProfileStatsData {
  ratio?: { perfect: number; great: number };
  lnSplit?: { ln: number; rice: number };
  streak?: { longest: number; current: number };
  /* First play to last play of their longest sitting (plays under 45 minutes apart). */
  session?: { minutes: number; plays: number; startedAt: string };
  /* Their place among the players the site tracks, by pp. */
  percentile?: { rank: number; players: number };
}

function countPair<K extends string>(value: unknown, keys: [K, K]): Record<K, number> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const [a, b] = keys.map((key) => Number(raw[key]));
  if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b < 0 || a + b <= 0) return undefined;
  return { [keys[0]]: a, [keys[1]]: b } as Record<K, number>;
}

export function parseProfileStatsData(value: unknown): ProfileStatsData {
  if (!value || typeof value !== "object") return {};
  const raw = value as Record<string, unknown>;
  const data: ProfileStatsData = {};
  const ratio = countPair(raw.ratio, ["perfect", "great"]);
  if (ratio) data.ratio = ratio;
  const lnSplit = countPair(raw.lnSplit, ["ln", "rice"]);
  if (lnSplit) data.lnSplit = lnSplit;
  const streak = raw.streak as Record<string, unknown> | undefined;
  if (streak && Number.isFinite(Number(streak.longest)) && Number.isFinite(Number(streak.current))) {
    data.streak = { longest: Math.max(0, Number(streak.longest)), current: Math.max(0, Number(streak.current)) };
  }
  const session = raw.session as Record<string, unknown> | undefined;
  const minutes = Number(session?.minutes);
  const plays = Number(session?.plays);
  if (Number.isFinite(minutes) && minutes > 0 && Number.isInteger(plays) && plays > 0 && typeof session?.startedAt === "string") {
    data.session = { minutes, plays, startedAt: session.startedAt };
  }
  const percentile = raw.percentile as Record<string, unknown> | undefined;
  const rank = Number(percentile?.rank);
  const players = Number(percentile?.players);
  if (Number.isInteger(rank) && Number.isInteger(players) && rank > 0 && players >= rank) data.percentile = { rank, players };
  return data;
}

/* "Top 0.05%": enough digits to tell a top-500 player from a top-5000 one. */
export function formatTopPercent(rank: number, players: number): string | null {
  if (!(rank > 0) || !(players > 0)) return null;
  const share = Math.min(100, (rank / players) * 100);
  const digits = share < 0.1 ? 3 : share < 1 ? 2 : share < 10 ? 1 : 0;
  return share.toFixed(digits).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

/* "4.5" hours, or whole minutes under an hour. */
export function sessionLength(minutes: number): { value: string; hours: boolean } {
  if (minutes < 60) return { value: String(Math.max(1, Math.round(minutes))), hours: false };
  const hours = minutes / 60;
  return { value: (hours >= 10 ? Math.round(hours) : Math.round(hours * 10) / 10).toString(), hours: true };
}
