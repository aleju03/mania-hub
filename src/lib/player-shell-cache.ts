import type { LeanRankingEntry, OsuUser } from "./types";

// v2 invalidates shells written before rankings presence was stripped. Those
// v1 entries may contain osu!'s `is_online: true`, which profiles must not use.
const PLAYER_SHELL_CACHE_KEY = "mania-hub-player-shell-cache-v2";
const PLAYER_SHELL_CACHE_TTL_MS = 10 * 60 * 1000;
const PLAYER_SHELL_CACHE_MAX_ENTRIES = 150;

type PlayerShellCacheEntry = {
  user: OsuUser;
  expiresAt: number;
};

const memoryCache = new Map<string, PlayerShellCacheEntry>();

const PLAYER_RECENT_PLAY_CACHE_KEY = "mania-hub-player-recent-play-cache-v1";
const PLAYER_RECENT_PLAY_MAX_ENTRIES = 150;

/**
 * osu! derives `is_online` / `last_visit` from website and bancho presence, so a
 * player grinding maps without ever opening the site keeps a weeks-old
 * `last_visit`. Surfaces that watch scores land (the tracker) know better, so
 * they seed the play time here and the profile trusts it as presence this long.
 */
export const RECENT_PLAY_ONLINE_WINDOW_MS = 10 * 60 * 1000;

const recentPlayMemoryCache = new Map<string, string>();

/**
 * A direct osu! user read is only a metadata fallback when the live profile
 * snapshot is unavailable. It has no database-backed presence provenance, so
 * neither osu!'s Bancho/site online flag nor its last_visit belongs in the
 * profile hero.
 */
export function stripUntrackedProfilePresence(user: OsuUser): OsuUser {
  return { ...user, is_online: false, last_visit: null };
}

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

/** Records that `username` was seen setting a play, for the profile to read on arrival. */
export function seedPlayerRecentPlay(username: string, playedAt: string): void {
  const key = normalizeUsernameKey(username);
  if (!key || !Number.isFinite(Date.parse(playedAt))) return;
  recentPlayMemoryCache.set(key, playedAt);

  const stored = readStoredRecentPlays();
  stored[key] = playedAt;
  writeStoredRecentPlays(stored);
}

/** The seeded play time for `username`, or null once it falls outside the online window. */
export function readPlayerRecentPlay(username: string): string | null {
  const key = normalizeUsernameKey(username);
  if (!key) return null;
  const playedAt = recentPlayMemoryCache.get(key) ?? readStoredRecentPlays()[key];
  return typeof playedAt === "string" && playedWithinOnlineWindow(playedAt) ? playedAt : null;
}

export function playedWithinOnlineWindow(playedAt: string, now: number = Date.now()): boolean {
  const parsed = Date.parse(playedAt);
  if (!Number.isFinite(parsed)) return false;
  // Clock skew between the ingest host and the browser can date a play that
  // just landed slightly in the future, so bound the gap from both sides.
  const age = now - parsed;
  return age < RECENT_PLAY_ONLINE_WINDOW_MS && age > -RECENT_PLAY_ONLINE_WINDOW_MS;
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
    // Presence is deliberately dropped. The rankings pages get `is_online` from
    // the osu! API, but the profile reports presence from our own ingest (a
    // tracked play inside the session window), so carrying the ranking's flag
    // over would flash a green dot the profile snapshot then contradicts - and
    // would leave it standing for good if that snapshot never arrives.
    is_online: false,
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

function readStoredRecentPlays(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(PLAYER_RECENT_PLAY_CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, string>;
  } catch {
    return {};
  }
}

function writeStoredRecentPlays(plays: Record<string, string>): void {
  if (typeof window === "undefined") return;
  try {
    const pruned = Object.fromEntries(
      Object.entries(plays)
        .filter(([, playedAt]) => playedWithinOnlineWindow(playedAt))
        .slice(-PLAYER_RECENT_PLAY_MAX_ENTRIES),
    );
    window.localStorage.setItem(PLAYER_RECENT_PLAY_CACHE_KEY, JSON.stringify(pruned));
  } catch {
    // Best-effort navigation cache only.
  }
}

function normalizeUsernameKey(username: string): string {
  return username.trim().toLowerCase();
}
