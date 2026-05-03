import type { TopPlaysRange } from "../store";

const RANGE_WIDTH: Record<TopPlaysRange, number> = {
  "24h": 0,
  "3d": 1,
  "7d": 2,
  "30d": 3,
};

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
