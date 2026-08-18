/* The "recent" row under a player picker: the handful of people you last
   looked at, kept in localStorage so the box is not blank every time you come
   back to the page.

   Keyed per surface rather than shared, because these lists mean different
   things. The farm helper's is who you last studied; the grant desk's is who
   you last gave something to, and mixing them would put strangers in front of
   whichever page you opened second. */

export interface RecentPlayer {
  userId: number;
  username: string;
  avatarUrl: string;
}

export const FARM_HELPER_RECENT_KEY = "mania-hub-farm-helper-recent-v1";
export const COLLECTIONS_RECENT_KEY = "mania-hub-collections-recent-v1";

const RECENT_MAX = 8;

export function readRecentPlayers(storageKey: string): RecentPlayer[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (p): p is RecentPlayer =>
          !!p && typeof p === "object" && Number.isFinite(p.userId) && typeof p.username === "string" && p.username.length > 0,
      )
      .slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

export function recordRecentPlayer(storageKey: string, player: RecentPlayer): void {
  if (typeof window === "undefined" || !player.username) return;
  try {
    const existing = readRecentPlayers(storageKey).filter((p) => p.userId !== player.userId);
    window.localStorage.setItem(storageKey, JSON.stringify([player, ...existing].slice(0, RECENT_MAX)));
  } catch {
    /* ignore quota / serialization errors */
  }
}

export function removeRecentPlayer(storageKey: string, userId: number): void {
  if (typeof window === "undefined") return;
  try {
    const existing = readRecentPlayers(storageKey).filter((p) => p.userId !== userId);
    window.localStorage.setItem(storageKey, JSON.stringify(existing));
  } catch {
    /* ignore */
  }
}
