// Unrated plays: the board for the plays the skill ratings leave out.
//
// Everywhere else on the site a play on a vibro chart (or at a rate that makes
// the chart vibro) leaves a player's pool, and a play on a chart whose note
// structure makes its dan verdict unsafe can never credit a dan. This board,
// and the matching view on the profile Skills tab, is where those plays are
// listed on their own terms: a pp the site computes itself from the chart's
// star rating (osu! pays none on an unranked chart), the MSD with every note
// counted, and the chart's dan at the played rate. One row per player and
// chart, their best play by whichever number the board is sorted on.
//
// Types and URL parsing only; the read is public and goes browser-direct
// (fetchLiveUnratedPlays in live-backend.ts), like the other boards.

import { LEADERBOARD_KEY_COUNTS, type LeaderboardKeyCount, type LeaderboardUser } from "./skill-leaderboards";

export const UNRATED_PLAYS_SORTS = ["pp", "msd", "dan"] as const;
export type UnratedPlaysSort = (typeof UNRATED_PLAYS_SORTS)[number];
export const DEFAULT_UNRATED_PLAYS_SORT: UnratedPlaysSort = "pp";

export const UNRATED_PLAYS_RANGES = ["all", "week"] as const;
export type UnratedPlaysRange = (typeof UNRATED_PLAYS_RANGES)[number];
export const DEFAULT_UNRATED_PLAYS_RANGE: UnratedPlaysRange = "all";

export type UnratedPlayReason = "chart_vibro" | "rate_vibro" | "chart_ineligible";

/** A plays board mixes keymodes by default; a specific one is a narrowing. */
export type UnratedPlaysKeys = LeaderboardKeyCount | "all";
export const DEFAULT_UNRATED_PLAYS_KEYS: UnratedPlaysKeys = "all";

export function parseUnratedPlaysKeys(value: unknown): UnratedPlaysKeys {
  const keys = Number(value);
  return (LEADERBOARD_KEY_COUNTS as readonly number[]).includes(keys)
    ? (keys as LeaderboardKeyCount)
    : DEFAULT_UNRATED_PLAYS_KEYS;
}

export function parseUnratedPlaysSort(value: unknown): UnratedPlaysSort {
  return typeof value === "string" && (UNRATED_PLAYS_SORTS as readonly string[]).includes(value)
    ? (value as UnratedPlaysSort)
    : DEFAULT_UNRATED_PLAYS_SORT;
}

export function parseUnratedPlaysRange(value: unknown): UnratedPlaysRange {
  return typeof value === "string" && (UNRATED_PLAYS_RANGES as readonly string[]).includes(value)
    ? (value as UnratedPlaysRange)
    : DEFAULT_UNRATED_PLAYS_RANGE;
}

export interface UnratedPlayDan {
  rawDan: number;
  side: "rc" | "ln";
  label: string | null;
}

export interface UnratedPlayEntry {
  rank: number;
  user: LeaderboardUser;
  beatmapId: number;
  beatmapsetId: number | null;
  title: string;
  artist: string;
  creator: string | null;
  version: string;
  coverUrl: string | null;
  beatmapStatus: string | null;
  keyCount: number;
  rate: number;
  rateMod: string | null;
  mods: string[] | null;
  accuracy: number | null;
  playedAt: string | null;
  scoreId: number | null;
  reason: UnratedPlayReason;
  pp: number | null;
  msd: number | null;
  dan: UnratedPlayDan | null;
}

export interface UnratedPlaysSnapshot {
  /** Null when the board mixes every keymode. */
  keyCount: number | null;
  sort: UnratedPlaysSort;
  range: UnratedPlaysRange;
  ranking: UnratedPlayEntry[];
  keyCounts?: LeaderboardKeyCount[];
  total: number;
  page: number;
  pageSize: number;
  fetchedAt: number;
}
