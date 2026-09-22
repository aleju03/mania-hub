import { useEffect, useState } from "react";
import { CLIENT_CACHE_TTL, isCacheStale } from "./cache";
import { fetchRestrictedPpRankingsDirect, isLiveBackendConfigured, type RestrictedPpRankingEntry } from "./live-backend";
import type { LeanRankingEntry } from "./types";

/* osu!'s country rankings leave out an account osu! turned away. The site
   puts its simulated standing (live-backend restricted-pp.ts) back in by pp,
   as a row like any other. */

const EMPTY_ENTRIES: RestrictedPpRankingEntry[] = [];

// Per country, so moving between the home page and /rankings does not repaint
// the list once the fetch lands. Only effects write it, so it stays empty on
// the server and on the hydration render.
const restrictedRankingsCache = new Map<string, { entries: RestrictedPpRankingEntry[]; fetchedAt: number }>();

export function toRestrictedPpRankingEntry(entry: RestrictedPpRankingEntry): LeanRankingEntry {
  return {
    user: {
      id: entry.user.id,
      username: entry.user.username,
      avatar_url: entry.user.avatar_url,
      cover_url: entry.user.cover_url,
      country_code: entry.user.country_code,
      is_online: false,
    },
    hit_accuracy: entry.hit_accuracy,
    play_count: entry.play_count,
    pp: entry.pp,
    global_rank: entry.global_rank,
    ranked_score: entry.ranked_score,
    grade_counts: { ...entry.grade_counts },
  };
}

/**
 * Inserts simulated standings into an osu! ranking by pp and keeps at most
 * `limit` rows: one enters when it beats the last row (a tie keeps the osu!
 * row ahead) or the list has room, and pushes the last row out. A player the
 * osu! list already has keeps that row. With nothing to insert, the osu! list
 * comes back as it was.
 */
export function mergeRestrictedPpRanking(
  ranking: LeanRankingEntry[],
  restricted: RestrictedPpRankingEntry[],
  limit: number,
): LeanRankingEntry[] {
  const seen = new Set<number>();
  // Two osu! pages fetched minutes apart can list the same player on both.
  const rows = ranking.filter((entry) => {
    if (seen.has(entry.user.id)) return false;
    seen.add(entry.user.id);
    return true;
  });
  const extras = restricted
    .filter((entry) => {
      if (!Number.isFinite(entry.pp) || entry.pp <= 0 || seen.has(entry.user.id)) return false;
      seen.add(entry.user.id);
      return true;
    })
    .map(toRestrictedPpRankingEntry)
    .sort((a, b) => b.pp - a.pp);
  if (extras.length === 0) return ranking;

  const merged: LeanRankingEntry[] = [];
  let next = 0;
  for (const row of rows) {
    while (next < extras.length && extras[next].pp > row.pp) merged.push(extras[next++]);
    merged.push(row);
  }
  merged.push(...extras.slice(next));
  return merged.slice(0, limit);
}

/** Simulated standings for one country's performance board; empty for null, without the live backend, or on a failed fetch. */
export function useRestrictedPpRankings(country: string | null): RestrictedPpRankingEntry[] {
  // The backend reads a missing country as "everywhere", so anything that is
  // not a country code (Global, a region) asks for nothing.
  const code = country?.trim().toUpperCase() ?? "";
  const key = /^[A-Z]{2}$/.test(code) ? code : null;
  const [state, setState] = useState(() => ({ key, entries: readCachedEntries(key) }));

  useEffect(() => {
    const show = (entries: RestrictedPpRankingEntry[]) =>
      setState((current) => (current.key === key && current.entries === entries ? current : { key, entries }));
    if (!key || !isLiveBackendConfigured()) {
      show(EMPTY_ENTRIES);
      return;
    }
    const cached = restrictedRankingsCache.get(key);
    show(cached?.entries ?? EMPTY_ENTRIES);
    if (cached && !isCacheStale(cached.fetchedAt, CLIENT_CACHE_TTL.rankings)) return;
    let cancelled = false;
    fetchRestrictedPpRankingsDirect(key)
      .then((fetched) => {
        // Most countries have nobody; the shared empty list keeps their boards
        // from recomputing.
        const entries = fetched.length > 0 ? fetched : EMPTY_ENTRIES;
        restrictedRankingsCache.set(key, { entries, fetchedAt: Date.now() });
        if (!cancelled) show(entries);
      })
      .catch(() => {
        // The osu! list stands on its own.
      });
    return () => { cancelled = true; };
  }, [key]);

  // A country switch renders once before the effect catches up.
  return state.key === key ? state.entries : readCachedEntries(key);
}

function readCachedEntries(key: string | null): RestrictedPpRankingEntry[] {
  return (key && restrictedRankingsCache.get(key)?.entries) || EMPTY_ENTRIES;
}
