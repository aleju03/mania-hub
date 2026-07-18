import type { LiveGlobalRankingEntry } from "./live-backend";

// v3: entries carry user.avatar_accent inline.
const GLOBAL_TOP_PLAYERS_STORAGE_KEY = "mania-hub-home-global-rankings-v3";

export type GlobalTopPlayersCache = {
  data: LiveGlobalRankingEntry[];
  fetchedAt: number;
};

let memoryCache: GlobalTopPlayersCache | null = null;

export function readGlobalTopPlayersMemoryCache(): GlobalTopPlayersCache | null {
  return memoryCache;
}

export function readGlobalTopPlayersCache(): GlobalTopPlayersCache | null {
  if (memoryCache) return memoryCache;

  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(GLOBAL_TOP_PLAYERS_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { data?: unknown; fetchedAt?: unknown };
    const fetchedAt = Number(parsed.fetchedAt);
    if (!Number.isFinite(fetchedAt) || !Array.isArray(parsed.data)) return null;

    const data = parsed.data.filter(isStoredGlobalRankingEntry);
    if (data.length === 0) return null;

    memoryCache = { data, fetchedAt };
    return memoryCache;
  } catch {
    return null;
  }
}

export function writeGlobalTopPlayersCache(data: LiveGlobalRankingEntry[], fetchedAt = Date.now()): GlobalTopPlayersCache {
  const cache = { data, fetchedAt };
  memoryCache = cache;

  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(GLOBAL_TOP_PLAYERS_STORAGE_KEY, JSON.stringify(cache));
    } catch {
      // Non-critical paint cache; the in-memory cache still covers this session.
    }
  }

  return cache;
}

function isStoredGlobalRankingEntry(value: unknown): value is LiveGlobalRankingEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as LiveGlobalRankingEntry;
  const user = entry.user;
  return Number.isFinite(entry.rank) &&
    Number.isFinite(entry.pp) &&
    !!user &&
    typeof user === "object" &&
    Number.isFinite(user.id) &&
    typeof user.username === "string" &&
    typeof user.avatar_url === "string" &&
    typeof user.country_code === "string";
}
