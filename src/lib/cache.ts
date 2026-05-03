export const CLIENT_CACHE_TTL = {
  rankings: 5 * 60 * 1000,
  rankHistories: 5 * 60 * 1000,
  homeRecentScores: 60 * 1000,
  homePopoffs: 2 * 60 * 1000,
  popoffs: 90 * 1000,
  scoresFeed: 60 * 1000,
  mapsData: 7 * 24 * 60 * 60 * 1000,
  snipes: 6 * 60 * 60 * 1000,
} as const;

export function isCacheStale(fetchedAt: number | null | undefined, ttl: number): boolean {
  if (!fetchedAt) return true;
  return Date.now() - fetchedAt > ttl;
}
