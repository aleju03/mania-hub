import { getServerLiveBackendUrl } from "./live-backend";

// One sitemap row per ranked player whose profile page server-renders its
// stats. The backend decides who qualifies
// (live-backend/src/features/player-sitemap.ts).
export interface PlayerSitemapEntry {
  path: string;
  // ISO instant of the profile's last refresh, or null when unknown; the
  // caller turns it into a lastmod hint.
  lastmod: string | null;
}

const PLAYER_SITEMAP_TIMEOUT_MS = 8000;

// Throws when the backend cannot answer, so the sitemap can tell a failed
// fetch from an empty list and try again sooner.
export async function fetchPlayerSitemapEntries(): Promise<PlayerSitemapEntry[]> {
  const base = getServerLiveBackendUrl();
  if (!base) return [];
  const response = await fetch(`${base}/api/sitemap/players`, {
    signal: AbortSignal.timeout(PLAYER_SITEMAP_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Server ${response.status} for the player sitemap`);
  const body = (await response.json()) as { players?: Array<{ username?: unknown; lastmod?: unknown }> };
  const entries: PlayerSitemapEntry[] = [];
  for (const player of Array.isArray(body?.players) ? body.players : []) {
    const username = typeof player?.username === "string" ? player.username.trim() : "";
    if (!username) continue;
    entries.push({
      // The same encoding as the profile page's canonical URL.
      path: `/player/${encodeURIComponent(username)}`,
      lastmod: typeof player.lastmod === "string" ? player.lastmod : null,
    });
  }
  return entries;
}
