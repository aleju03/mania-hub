import { fetchLiveDanLeaderboard, fetchLiveSkillLeaderboard } from "./live-backend";
import type { DanLeaderboardSnapshot, DanSide, SkillLeaderboardSnapshot } from "./skill-leaderboards";

/**
 * Module-level snapshot cache for the /rankings skill and dan boards.
 *
 * The endpoint carries an HTTP cache, but a browser cache hit still costs a
 * round trip and a repaint: without this, every axis chip and every tab flip
 * would show the skeleton again for a board the visitor was looking at a second
 * earlier. Entries hold the in-flight promise rather than only the settled
 * value, so React's Strict Mode double-mount and a fast double-click issue one
 * request between them.
 *
 * Same shape as farm-helper-snapshot-cache.ts, with the TTL matched to the
 * backend board's own 5-minute rebuild instead of an endpoint max-age.
 */

// The backend rebuilds its board every 5 minutes; asking again inside that
// window can only return the identical payload (its own max-age says the same).
const SNAPSHOT_TTL_MS = 5 * 60_000;
// One scope+keymode holds up to ~10 axes plus 2 dan sides; this covers a few
// scopes of browsing and nothing like a session history.
const MAX_ENTRIES = 40;

// Browser-only, and not a soft preference: one Node process serves every SSR
// request, so a module-level map filled during SSR would hand one visitor
// another visitor's board.
const isBrowser = typeof window !== "undefined";

interface CacheEntry<T> {
  promise: Promise<T>;
  // Set once the promise resolves, so a synchronous first render can paint
  // without waiting a tick.
  snapshot: T | null;
  storedAt: number;
}

const entries = new Map<string, CacheEntry<unknown>>();

function evictOverflow(): void {
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
}

function isFresh(entry: CacheEntry<unknown>): boolean {
  return Date.now() - entry.storedAt < SNAPSHOT_TTL_MS;
}

function load<T>(key: string, fetchSnapshot: () => Promise<T>): Promise<T> {
  // On the server: fetch, never store.
  if (!isBrowser) return fetchSnapshot();

  const existing = entries.get(key) as CacheEntry<T> | undefined;
  if (existing && isFresh(existing)) {
    // Refresh LRU position without restarting the request.
    entries.delete(key);
    entries.set(key, existing);
    return existing.promise;
  }

  const entry: CacheEntry<T> = { promise: Promise.resolve() as Promise<T>, snapshot: null, storedAt: Date.now() };
  entry.promise = fetchSnapshot().then(
    (snapshot) => {
      entry.snapshot = snapshot;
      return snapshot;
    },
    (error) => {
      // A failed request must not be cached as an answer.
      if (entries.get(key) === (entry as CacheEntry<unknown>)) entries.delete(key);
      throw error;
    },
  );
  entries.delete(key);
  entries.set(key, entry as CacheEntry<unknown>);
  evictOverflow();
  return entry.promise;
}

function peek<T>(key: string): T | null {
  if (!isBrowser) return null;
  const entry = entries.get(key) as CacheEntry<T> | undefined;
  if (!entry || !entry.snapshot || !isFresh(entry)) return null;
  return entry.snapshot;
}

export interface SkillBoardRequest {
  country: string;
  keys: number;
  axis: string;
  page: number;
}

export interface DanBoardRequest {
  country: string;
  keys: number;
  side: DanSide;
  page: number;
}

function skillKey(request: SkillBoardRequest): string {
  return `skill ${request.country} ${request.keys} ${request.axis} ${request.page}`;
}

function danKey(request: DanBoardRequest): string {
  return `dan ${request.country} ${request.keys} ${request.side} ${request.page}`;
}

/** A settled, still-fresh board, or null. Never triggers a request. */
export function peekSkillBoard(request: SkillBoardRequest): SkillLeaderboardSnapshot | null {
  return peek<SkillLeaderboardSnapshot | null>(skillKey(request));
}

export function peekDanBoard(request: DanBoardRequest): DanLeaderboardSnapshot | null {
  return peek<DanLeaderboardSnapshot | null>(danKey(request));
}

/**
 * The board for this request, fetching only when nothing usable is cached.
 *
 * No abort signal by design: the response populates the cache and is useful to
 * whoever asks next even if this caller has navigated away. Callers guard their
 * own render with a cancelled flag, which is what keeps a stale axis from being
 * shown as current.
 */
export function loadSkillBoard(request: SkillBoardRequest): Promise<SkillLeaderboardSnapshot> {
  return load(skillKey(request), () => fetchLiveSkillLeaderboard(request));
}

export function loadDanBoard(request: DanBoardRequest): Promise<DanLeaderboardSnapshot> {
  return load(danKey(request), () => fetchLiveDanLeaderboard(request));
}
