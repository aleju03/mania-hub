import { fetchLiveUserSearch, isLiveBackendConfigured } from "./live-backend";
import { searchUsers } from "./osu";

/* One place for "who is this player", because the search boxes are the site's
   most-typed control and osu!'s /search costs an API call per query out of the
   same ~45/min budget the ingest pipeline runs on. The backend already stores
   every roster member and everyone seen in ingest, so that answers almost every
   query for free.

   Untracked players are what the stored table cannot know, so the boxes whose
   job is to reach any osu! account (the nav, the By Player tab) fall back to
   the API only when the stored search comes back with nothing. Boxes that can
   only act on players we hold data for (the side by side picker) pass
   `fallbackToOsu: false` and stay entirely local. */

export interface PlayerSearchResult {
  id: number;
  username: string;
  avatar_url: string;
  country_code: string;
}

export async function searchPlayers(
  query: string,
  options: { limit?: number; fallbackToOsu?: boolean } = {},
): Promise<PlayerSearchResult[]> {
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];
  const limit = options.limit ?? 6;

  if (isLiveBackendConfigured()) {
    try {
      const stored = await fetchLiveUserSearch(trimmed, limit);
      if (stored.length > 0) {
        return stored.slice(0, limit).map((user) => ({
          id: user.id,
          username: user.username,
          avatar_url: user.avatarUrl,
          country_code: user.countryCode ?? "",
        }));
      }
    } catch {
      // Backend down or not reachable: fall through to whatever is allowed.
    }
  }

  if (options.fallbackToOsu === false) return [];

  const response = await searchUsers({ data: { query: trimmed } });
  return (response.user?.data ?? [])
    .slice(0, limit)
    .map((user: { id: number; username: string; avatar_url: string; country_code: string }) => ({
      id: user.id,
      username: user.username,
      avatar_url: user.avatar_url,
      country_code: user.country_code,
    }));
}
