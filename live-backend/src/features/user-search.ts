import type { Db } from "../db.js";
import { exec } from "../db.js";

/* Username search over the players this backend already knows: roster members
   plus anyone seen in ingest. It exists so the site's player boxes stop
   spending an osu! API call per typed query - the budget in osu/client.ts is
   ~45/min for the whole service, and a search box can eat that on its own.

   Only what a picker needs is returned. A caller that wants the full profile
   still goes through the profile endpoints with the id this hands back. */

export interface UserSearchEntry {
  id: number;
  username: string;
  avatarUrl: string;
  countryCode: string | null;
  pp: number | null;
  globalRank: number | null;
}

export const USER_SEARCH_MAX_LIMIT = 25;
export const USER_SEARCH_DEFAULT_LIMIT = 8;
/** Longer than any osu! username, so the pattern can never be a scan bomb. */
const MAX_QUERY_LENGTH = 30;

export function normalizeUserSearchQuery(raw: string): string {
  return raw.trim().slice(0, MAX_QUERY_LENGTH);
}

/* Ordered the way a person reads their own typing: the exact name first, then
   the names that start with it, then the ones that merely contain it, and pp
   within each tier so the player being looked for is not below their own
   namesakes. `escape` keeps a typed % or _ literal instead of turning the
   query into a wildcard over the whole table. */
export async function searchUsers(db: Db, rawQuery: string, rawLimit?: number): Promise<UserSearchEntry[]> {
  const query = normalizeUserSearchQuery(rawQuery);
  if (query.length < 2) return [];
  const limit = clampLimit(rawLimit);
  const lowered = query.toLowerCase();
  const escaped = lowered.replace(/[\\%_]/g, (match) => `\\${match}`);

  const rows = (await exec(
    db,
    `select user_id, username, avatar_url, country_code, pp, global_rank
     from users
     where coalesce(is_active, 1) = 1
       and lower(username) like ? escape '\\'
     order by
       case
         when lower(username) = ? then 0
         when lower(username) like ? escape '\\' then 1
         else 2
       end,
       pp desc,
       username asc
     limit ?`,
    [`%${escaped}%`, lowered, `${escaped}%`, limit],
  )).rows;

  return rows.flatMap((row) => {
    const id = Number(row.user_id);
    const username = String(row.username ?? "");
    if (!Number.isSafeInteger(id) || id <= 0 || !username) return [];
    return [{
      id,
      username,
      avatarUrl: String(row.avatar_url ?? ""),
      countryCode: row.country_code == null ? null : String(row.country_code),
      pp: readNumber(row.pp),
      globalRank: readInteger(row.global_rank),
    }];
  });
}

function clampLimit(limit: number | undefined): number {
  if (limit == null || !Number.isFinite(limit)) return USER_SEARCH_DEFAULT_LIMIT;
  return Math.max(1, Math.min(USER_SEARCH_MAX_LIMIT, Math.floor(limit)));
}

function readNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function readInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
