import type { Db } from "../db.js";
import { selectRowsByIntegerSet } from "../shared/score-storage.js";
import type { AnalyticsViewerRow } from "./analytics.js";

/* Who the signed-in roster actually is, in osu! terms.

   The roster lives in the analytics database and the pp/rank figures live in
   the main one, two separate SQLite files on separate connections, so there is
   no join to write: the ids come back from one and are looked up in the other.

   Only players the backend has ingested (a tracked country's roster, or anyone
   whose score came through the feed) have a `users` row at all. Everyone else
   comes back unranked rather than at zero, and sorts to the bottom instead of
   pretending to be the worst player on the site. */

export type AnalyticsViewerSort = "recent" | "pp" | "rank";

const SORTS: readonly AnalyticsViewerSort[] = ["recent", "pp", "rank"];

export interface RankedAnalyticsViewerRow extends AnalyticsViewerRow {
  /* null when the backend has never ingested this player. */
  pp: number | null;
  globalRank: number | null;
}

export function normalizeAnalyticsViewerSort(value: unknown): AnalyticsViewerSort {
  const candidate = typeof value === "string" ? value.toLowerCase() : "";
  return SORTS.includes(candidate as AnalyticsViewerSort) ? candidate as AnalyticsViewerSort : "recent";
}

export async function attachViewerRanks(
  db: Db,
  rows: readonly AnalyticsViewerRow[],
): Promise<RankedAnalyticsViewerRow[]> {
  if (rows.length === 0) return [];
  const known = await selectRowsByIntegerSet(
    db,
    "select user_id, pp, global_rank from users where user_id in",
    rows.map((row) => row.viewerId),
  );
  const byId = new Map(known.map((row) => [Number(row.user_id), row]));
  return rows.map((row) => {
    const user = byId.get(row.viewerId);
    return {
      ...row,
      pp: finiteOrNull(user?.pp),
      globalRank: positiveIntegerOrNull(user?.global_rank),
    };
  });
}

/* Sorts a whole roster in place of the caller's copy. Ties break on last seen
   so the order is total: two unranked players would otherwise swap places
   between requests for no reason the reader can see. */
export function sortRankedViewers(
  rows: readonly RankedAnalyticsViewerRow[],
  sort: AnalyticsViewerSort,
): RankedAnalyticsViewerRow[] {
  const sorted = [...rows];
  if (sort === "pp") {
    sorted.sort((a, b) => (unknownLast(a.pp, b.pp) ?? b.pp! - a.pp!) || b.lastSeen - a.lastSeen);
  } else if (sort === "rank") {
    // Rank counts the other way: 1 is the best, so the smaller number wins.
    sorted.sort((a, b) =>
      (unknownLast(a.globalRank, b.globalRank) ?? a.globalRank! - b.globalRank!) || b.lastSeen - a.lastSeen);
  } else {
    sorted.sort((a, b) => b.lastSeen - a.lastSeen);
  }
  return sorted;
}

/* Settles a pair when either side is unknown, and hands back to the caller
   (null) when both are known and the direction is the caller's business. */
function unknownLast(a: number | null, b: number | null): number | null {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return null;
}

function finiteOrNull(value: unknown): number | null {
  const next = Number(value);
  return value != null && Number.isFinite(next) ? next : null;
}

function positiveIntegerOrNull(value: unknown): number | null {
  const next = Math.floor(Number(value));
  return value != null && Number.isSafeInteger(next) && next > 0 ? next : null;
}
