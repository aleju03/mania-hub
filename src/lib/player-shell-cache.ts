import type { LeanRankingEntry, OsuUser } from "./types";

const PLAYER_SHELL_CACHE_KEY = "mania-hub-player-shell-cache-v1";
const PLAYER_SHELL_CACHE_TTL_MS = 10 * 60 * 1000;
const PLAYER_SHELL_CACHE_MAX_ENTRIES = 150;

type PlayerShellCacheEntry = {
  user: OsuUser;
  expiresAt: number;
};

const memoryCache = new Map<string, PlayerShellCacheEntry>();

export function seedPlayerShellFromRankingEntry(entry: LeanRankingEntry, countryRank?: number | null): void {
  writePlayerShell(buildPlayerShellFromRankingEntry(entry, countryRank));
}

export function seedPlayerShellsFromRankingEntries(entries: LeanRankingEntry[], startRank: number): void {
  entries.forEach((entry, index) => seedPlayerShellFromRankingEntry(entry, startRank + index));
}

export function readPlayerShell(username: string): OsuUser | null {
  const key = normalizeUsernameKey(username);
  if (!key) return null;

  const memoryEntry = memoryCache.get(key);
  if (memoryEntry) {
    if (memoryEntry.expiresAt > Date.now()) return memoryEntry.user;
    memoryCache.delete(key);
  }

  const stored = readStoredShells();
  const storedEntry = stored[key];
  if (!storedEntry) return null;
  if (storedEntry.expiresAt <= Date.now()) {
    delete stored[key];
    writeStoredShells(stored);
    return null;
  }

  memoryCache.set(key, storedEntry);
  return storedEntry.user;
}

function writePlayerShell(user: OsuUser): void {
  const key = normalizeUsernameKey(user.username);
  if (!key) return;
  const entry = {
    user,
    expiresAt: Date.now() + PLAYER_SHELL_CACHE_TTL_MS,
  };
  memoryCache.set(key, entry);

  const stored = readStoredShells();
  stored[key] = entry;
  writeStoredShells(stored);
}

function buildPlayerShellFromRankingEntry(entry: LeanRankingEntry, countryRank?: number | null): OsuUser {
  const countryCode = entry.user.country_code || "";
  const coverUrl = entry.user.cover_url || entry.user.avatar_url || "";
  return {
    id: entry.user.id,
    username: entry.user.username,
    avatar_url: entry.user.avatar_url,
    cover_url: coverUrl,
    cover: {
      custom_url: null,
      url: coverUrl,
      id: null,
    },
    country_code: countryCode,
    country: { code: countryCode, name: countryCode },
    join_date: "",
    last_visit: null,
    is_active: entry.user.is_active ?? true,
    is_online: entry.user.is_online,
    is_supporter: false,
    statistics: {
      count_300: 0,
      count_100: 0,
      count_50: 0,
      count_miss: 0,
      global_rank: entry.global_rank,
      country_rank: countryRank ?? null,
      pp: entry.pp,
      ranked_score: entry.ranked_score,
      hit_accuracy: entry.hit_accuracy,
      play_count: entry.play_count,
      play_time: null,
      total_score: 0,
      total_hits: 0,
      maximum_combo: 0,
      replays_watched_by_others: 0,
      is_ranked: true,
      grade_counts: {
        ss: entry.grade_counts.ss,
        ssh: entry.grade_counts.ssh,
        s: entry.grade_counts.s,
        sh: entry.grade_counts.sh,
        a: entry.grade_counts.a,
      },
      level: { current: 1, progress: 0 },
    },
    rank_history: null,
    rank_highest: null,
    page: null,
    badges: [],
    user_achievements: [],
    follower_count: 0,
    mapping_follower_count: 0,
    previous_usernames: [],
    playmode: "mania",
    playstyle: null,
    post_count: 0,
    comments_count: 0,
  };
}

function readStoredShells(): Record<string, PlayerShellCacheEntry> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(PLAYER_SHELL_CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, PlayerShellCacheEntry>;
  } catch {
    return {};
  }
}

function writeStoredShells(shells: Record<string, PlayerShellCacheEntry>): void {
  if (typeof window === "undefined") return;
  try {
    const now = Date.now();
    const pruned = Object.fromEntries(
      Object.entries(shells)
        .filter(([, entry]) => entry.expiresAt > now)
        .slice(-PLAYER_SHELL_CACHE_MAX_ENTRIES),
    );
    window.localStorage.setItem(PLAYER_SHELL_CACHE_KEY, JSON.stringify(pruned));
  } catch {
    // Best-effort navigation cache only.
  }
}

function normalizeUsernameKey(username: string): string {
  return username.trim().toLowerCase();
}
