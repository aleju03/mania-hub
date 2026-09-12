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
   `fallbackToOsu: false` and stay entirely local.

   A stored hit is not proof the player was found: the stored match is a
   substring one, so an untracked "anchr" is hidden behind a tracked "danchree"
   and the automatic fallback never fires. Firing it on every non-exact query
   would put the typing cost back on the API, so instead the box offers an
   explicit osu! search (`searchPlayersOnOsu`) whenever nothing in the list is
   the name as typed (`hasExactPlayerMatch`). */

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

  return searchPlayersOnOsu(trimmed, limit);
}

/** The osu! API search alone: one API call, any account. */
export async function searchPlayersOnOsu(query: string, limit = 6): Promise<PlayerSearchResult[]> {
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];
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

/** Whether one of the results is the query itself, ignoring case, so the box
    knows the typed name was found rather than merely contained in another. */
export function hasExactPlayerMatch(results: readonly { username: string }[], query: string): boolean {
  const wanted = query.trim().toLowerCase();
  return results.some((user) => user.username.toLowerCase() === wanted);
}
