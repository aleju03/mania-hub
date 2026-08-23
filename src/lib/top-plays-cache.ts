import type { CachedPopoff, TopPlaysRange } from "../store";

const RANGE_WIDTH: Record<TopPlaysRange, number> = {
  "24h": 0,
  "3d": 1,
  "7d": 2,
  "30d": 3,
};

const RANGE_MS: Record<TopPlaysRange, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "3d": 3 * 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

type CachedTopPlaysSort = "recent" | "pp" | "gain";
type CachedTopPlaysDirection = "desc" | "asc";
type CachedTopPlaysKeyFilter = "all" | "4k" | "other";

export function windowCoversTopPlaysRange(cached: TopPlaysRange | null, selected: TopPlaysRange): boolean {
  if (!cached) return false;
  return RANGE_WIDTH[cached] >= RANGE_WIDTH[selected];
}

export function hasTopPlaysCache(fetchedAt: number | null, cachedWindow: TopPlaysRange | null): boolean {
  return fetchedAt != null && cachedWindow != null;
}

export function shouldRefreshTopPlays({
  fetchedAt,
  cachedWindow,
  selectedRange,
  cacheTtlMs,
  now = Date.now(),
}: {
  fetchedAt: number | null;
  cachedWindow: TopPlaysRange | null;
  selectedRange: TopPlaysRange;
  cacheTtlMs: number;
  now?: number;
}): boolean {
  if (!hasTopPlaysCache(fetchedAt, cachedWindow)) return true;
  if (fetchedAt == null || cachedWindow == null) return true;
  if (now - fetchedAt > cacheTtlMs) return true;
  return !windowCoversTopPlaysRange(cachedWindow, selectedRange);
}

/**
 * Builds a provisional page from the durable feed cache while the exact,
 * server-paginated snapshot revalidates. The cache can contain rows merged
 * from several pages, so this is display fallback only; totals and the final
 * ordering still come from the backend response.
 */
export function selectCachedTopPlaysPage(
  popoffs: CachedPopoff[],
  options: {
    cachedWindow: TopPlaysRange | null;
    range: TopPlaysRange;
    sort: CachedTopPlaysSort;
    dir: CachedTopPlaysDirection;
    keys: CachedTopPlaysKeyFilter;
    page: number;
    pageSize: number;
    userIds?: number[];
    now?: number;
  },
): CachedPopoff[] {
  if (!windowCoversTopPlaysRange(options.cachedWindow, options.range)) return [];

  const now = options.now ?? Date.now();
  const cutoff = now - RANGE_MS[options.range];
  const userIds = options.userIds?.length ? new Set(options.userIds) : null;
  const page = Math.max(0, Math.floor(options.page));
  const pageSize = Math.max(1, Math.floor(options.pageSize));

  const filtered = popoffs.filter((popoff) => {
    const playedAt = new Date(popoff.time).getTime();
    if (!Number.isFinite(playedAt) || playedAt < cutoff) return false;
    if (userIds && !userIds.has(popoff.user.id)) return false;

    const rawKeyCount = Number(popoff.score.beatmap?.cs);
    const keyCount = Number.isFinite(rawKeyCount) && rawKeyCount > 0 ? rawKeyCount : null;
    if (options.keys === "4k") return keyCount === 4;
    if (options.keys === "other") return keyCount != null && keyCount !== 4;
    return true;
  });

  filtered.sort((a, b) => {
    const aTime = new Date(a.time).getTime();
    const bTime = new Date(b.time).getTime();
    const aPrimary = options.sort === "recent" ? aTime : options.sort === "gain" ? a.ppGain : a.pp;
    const bPrimary = options.sort === "recent" ? bTime : options.sort === "gain" ? b.ppGain : b.pp;
    const primaryDiff = aPrimary - bPrimary;
    if (primaryDiff !== 0) return options.dir === "asc" ? primaryDiff : -primaryDiff;
    if (bTime !== aTime) return bTime - aTime;
    return b.pp - a.pp;
  });

  const offset = page * pageSize;
  return filtered.slice(offset, offset + pageSize);
}
