// Standalone localStorage cache for the /discord command showcase payload.
//
// The showcase pulls a real-data snapshot from the live backend (see
// fetchDiscordShowcase). That payload is sizable and non-critical, so it lives
// in its own storage key instead of the main persisted store blob: a stale or
// evicted entry just means one refetch, never quota pressure on real app state.
// Entries are keyed by country and carry a fetchedAt so the page reuses them
// across visits within the TTL instead of refetching.

import type { DiscordShowcase } from "./live-backend";

const STORAGE_KEY = "mania-hub-discord-showcase-v1";
const MAX_ENTRIES = 6;

interface CachedEntry {
  fetchedAt: number;
  data: DiscordShowcase;
}

type CacheShape = Record<string, CachedEntry>;

export function discordShowcaseCacheKey(country: string): string {
  return country.trim().toUpperCase();
}

function readAll(): CacheShape {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as CacheShape) : {};
  } catch {
    return {};
  }
}

function writeAll(cache: CacheShape): void {
  if (typeof localStorage === "undefined") return;
  try {
    // Keep only the most recent few entries so the key can't grow unbounded.
    const entries = Object.entries(cache).sort((a, b) => b[1].fetchedAt - a[1].fetchedAt).slice(0, MAX_ENTRIES);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Out of quota or disabled storage: caching is a nice-to-have, so ignore.
  }
}

export function readDiscordShowcaseCache(key: string): CachedEntry | null {
  const entry = readAll()[key];
  return entry && entry.data ? entry : null;
}

export function writeDiscordShowcaseCache(key: string, data: DiscordShowcase): void {
  const cache = readAll();
  cache[key] = { fetchedAt: Date.now(), data };
  writeAll(cache);
}
