import type { Db } from "../db.js";
import { exec } from "../db.js";
import { logWarn } from "../logger.js";
import type { OscScore } from "../shared/types.js";

/* Short-lived process cache for a player's top-200 window.
 *
 * `refresh_user_top_scores` and `refresh_user_maps_farmed_scores` both call
 * getUserBestScoresWindow(userId, 200), which is two upstream requests
 * (offset 0 and offset 100) for the exact same bytes. In a 7-day production
 * sample they were the #2 and #3 osu! API callers (182,487 calls, 26k/day),
 * and 99% of the farmed calls had a top-scores call for the same user and
 * page within 30 minutes. The client's in-flight coalescing only covers
 * requests that overlap in time; these two jobs are minutes apart, so the
 * duplication survives it.
 *
 * The rules below are deliberately strict, because "the window did not
 * change" is not something a clock can prove:
 *
 * - The TTL is hard and never slides. A hit does not extend the entry, so an
 *   entry can serve for at most TTL after the fetch that created it.
 * - Any score event received for that user after the fetch started drops the
 *   entry. osu! processing lag and oSC gaps mean a new event is a lower bound
 *   on "something changed", not proof of no change, which is why the TTL cap
 *   stays on top of it.
 * - A caller that is confirming a specific score passes it in
 *   `requireScoreIds`. If the cached window does not contain it, the entry is
 *   not used. Without this a too-early window would be replayed to every
 *   pending top-play retry, which is the one case where a cache could turn a
 *   transient miss into a permanent one.
 * - Failures are never cached: a throwing fetch drops the entry and rethrows,
 *   so 404 handling (markUserMissing) stays exactly where it was.
 */

export const USER_BEST_SCORES_CACHE_TTL_MS = 10 * 60_000;

// The measured working set is ~95 distinct users per 10-minute window in
// production, so this holds a full window with room to spare. The byte cap is
// the real guard: the worker already runs near its MemoryHigh, and a top-200
// window with beatmap/beatmapset objects attached is not small.
const MAX_ENTRIES = 128;
const MAX_BYTES = 64 * 1024 * 1024;
const APPROX_BYTES_PER_SCORE = 3 * 1024;

interface CacheEntry {
  /** Taken before the request is issued, so a score that lands mid-flight invalidates. */
  fetchedAt: number;
  fetchedAtIso: string;
  scores: OscScore[];
  bytes: number;
}

const entries = new Map<number, CacheEntry>();
let totalBytes = 0;

const stats = { hits: 0, misses: 0 };

function dropEntry(userId: number): void {
  const entry = entries.get(userId);
  if (!entry) return;
  entries.delete(userId);
  totalBytes -= entry.bytes;
}

function storeEntry(userId: number, entry: CacheEntry): void {
  dropEntry(userId);
  entries.set(userId, entry);
  totalBytes += entry.bytes;
  // Insertion order is eviction order: oldest fetch goes first.
  for (const oldest of entries.keys()) {
    if (entries.size <= MAX_ENTRIES && totalBytes <= MAX_BYTES) break;
    dropEntry(oldest);
  }
}

function scoreIdCandidates(score: OscScore): number[] {
  const ids: number[] = [];
  if (Number.isSafeInteger(score.id) && score.id > 0) ids.push(score.id);
  const legacyId = score.legacy_score_id;
  if (legacyId != null && Number.isSafeInteger(legacyId) && legacyId > 0) ids.push(legacyId);
  return ids;
}

function windowContainsAny(scores: OscScore[], requiredIds: Set<number>): boolean {
  return scores.some((score) => scoreIdCandidates(score).some((id) => requiredIds.has(id)));
}

function normalizeRequiredIds(requireScoreIds: Iterable<number | string> | undefined): Set<number> | null {
  if (!requireScoreIds) return null;
  const ids = new Set<number>();
  let sawValue = false;
  for (const raw of requireScoreIds) {
    sawValue = true;
    const id = Number(raw);
    // A trigger we cannot match against the window (a score-identity fallback
    // key, say) must never be treated as "no requirement": fetch instead.
    if (!Number.isSafeInteger(id) || id <= 0) return new Set<number>();
    ids.add(id);
  }
  return sawValue ? ids : null;
}

/** True when a score for this user was received after the cached window was fetched. */
async function hasScoreEventSince(db: Db, userId: number, sinceIso: string): Promise<boolean> {
  try {
    const row = (await exec(
      db,
      "select 1 as fresh from score_events where user_id = ? and received_at > ? limit 1",
      [userId, sinceIso],
    )).rows[0];
    return !!row;
  } catch (error) {
    // Unknown means unsafe: fall through to a real fetch.
    logWarn("user_best_scores_cache_event_check_failed", {
      user_id: userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return true;
  }
}

export interface UserBestScoresCacheOptions {
  /**
   * Score ids the caller is confirming. When set, a cached window that does
   * not contain one of them is refetched rather than served.
   */
  requireScoreIds?: Iterable<number | string>;
  /**
   * Whether a caller that names no trigger score may still be served from
   * cache. Off by default: a refresh with nothing to check the window against
   * has no way to tell a current window from one fetched a minute too early,
   * so it fetches (and still populates the entry for callers that do check).
   */
  reuseWithoutTrigger?: boolean;
}

/**
 * Returns the user's top-200 window, reusing a recent one when it is provably
 * still the same data. `fetchWindow` is the caller's own fetch (the two jobs
 * differ in the caller tag they bill the call to, and one has a legacy
 * single-page fallback), so nothing about the request shape moves in here.
 *
 * The returned array is a fresh array, but the score objects inside it are
 * shared with other callers: treat them as read-only.
 */
export async function getUserBestScoresWindowCached(
  db: Db,
  userId: number,
  fetchWindow: () => Promise<OscScore[]>,
  options: UserBestScoresCacheOptions = {},
): Promise<OscScore[]> {
  const requiredIds = normalizeRequiredIds(options.requireScoreIds);
  const mayReuse = requiredIds != null || options.reuseWithoutTrigger === true;
  const cached = mayReuse ? entries.get(userId) : undefined;

  if (cached) {
    const expired = Date.now() - cached.fetchedAt >= USER_BEST_SCORES_CACHE_TTL_MS;
    const missingTrigger = requiredIds != null && !windowContainsAny(cached.scores, requiredIds);
    if (expired || missingTrigger) {
      dropEntry(userId);
    } else if (await hasScoreEventSince(db, userId, cached.fetchedAtIso)) {
      dropEntry(userId);
    } else {
      stats.hits += 1;
      return [...cached.scores];
    }
  }

  stats.misses += 1;
  const fetchedAt = Date.now();
  let scores: OscScore[];
  try {
    scores = await fetchWindow();
  } catch (error) {
    dropEntry(userId);
    throw error;
  }
  storeEntry(userId, {
    fetchedAt,
    fetchedAtIso: new Date(fetchedAt).toISOString(),
    scores,
    bytes: scores.length * APPROX_BYTES_PER_SCORE,
  });
  return [...scores];
}

export function getUserBestScoresCacheStats(): { hits: number; misses: number; entries: number; bytes: number } {
  return { hits: stats.hits, misses: stats.misses, entries: entries.size, bytes: totalBytes };
}

export function resetUserBestScoresCache(): void {
  entries.clear();
  totalBytes = 0;
  stats.hits = 0;
  stats.misses = 0;
}
