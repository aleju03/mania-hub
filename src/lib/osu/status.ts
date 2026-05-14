import {
  beatmapScoreLookupPartialKey,
  beatmapScoreLookupStatusKey,
  sortBeatmapScores
} from "../beatmap-score-progress";
import { setPersistentCache } from "../api";
import type {
  BeatmapScoreLookupStatus,
  CountryTopPlay,
  OsuScore,
  SnipeEvent,
  SnipesScanStatus,
  TopPlaysRefreshStatus
} from "../types";
import {
  COUNTRY_TOP_PLAYS_QUERY_LIMIT,
  SNIPES_STATUS_THROTTLE_MS,
  SNIPES_STATUS_TTL,
  TOP_PLAYS_STATUS_THROTTLE_MS,
  TOP_PLAYS_STATUS_TTL,
  beatmapScoreLookupLastWriteByKey,
  snipesStatusLastWriteByCountry,
  topPlaysStatusLastWriteByCountry
} from "./constants";

export function snipesStatusKey(country: string): string {
  return `snipes-scan-status:${country}`;
}

export function writeSnipesScanStatus(
  country: string,
  status: Omit<SnipesScanStatus, "updatedAt">,
  options: { force?: boolean } = {},
): void {
  const now = Date.now();
  const last = snipesStatusLastWriteByCountry.get(country) ?? 0;
  if (!options.force && now - last < SNIPES_STATUS_THROTTLE_MS) return;
  snipesStatusLastWriteByCountry.set(country, now);
  // Fire-and-forget: status updates must not block the scan, and a failed
  // write just means the client briefly sees stale status.
  void setPersistentCache(snipesStatusKey(country), { ...status, updatedAt: now }, SNIPES_STATUS_TTL);
}

export function clearSnipesScanStatus(country: string): void {
  snipesStatusLastWriteByCountry.delete(country);
  // Overwrite with a 1s-TTL marker so the client's next poll sees it gone.
  void setPersistentCache(snipesStatusKey(country), null, 1000);
}

export function snipesPartialEventsKey(country: string): string {
  return `snipes-partial-events:v2:${country}`;
}

export function writePartialSnipeEvents(country: string, events: SnipeEvent[]): void {
  if (events.length === 0) return;
  const sorted = [...events].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );
  void setPersistentCache(snipesPartialEventsKey(country), sorted, SNIPES_STATUS_TTL);
}

export function clearPartialSnipeEvents(country: string): void {
  void setPersistentCache(snipesPartialEventsKey(country), null, 1000);
}

export function topPlaysStatusKey(country: string): string {
  return `top-plays-refresh-status:${country}`;
}

export function writeTopPlaysRefreshStatus(
  country: string,
  status: Omit<TopPlaysRefreshStatus, "updatedAt">,
  options: { force?: boolean } = {},
): void {
  const now = Date.now();
  const last = topPlaysStatusLastWriteByCountry.get(country) ?? 0;
  if (!options.force && now - last < TOP_PLAYS_STATUS_THROTTLE_MS) return;
  topPlaysStatusLastWriteByCountry.set(country, now);
  void setPersistentCache(topPlaysStatusKey(country), { ...status, updatedAt: now }, TOP_PLAYS_STATUS_TTL);
}

export function clearTopPlaysRefreshStatus(country: string): void {
  topPlaysStatusLastWriteByCountry.delete(country);
  void setPersistentCache(topPlaysStatusKey(country), null, 1000);
}

export function writeBeatmapScoreLookupStatus(
  beatmapId: number,
  country: string,
  status: Omit<BeatmapScoreLookupStatus, "updatedAt">,
  options: { force?: boolean } = {},
): void {
  const key = beatmapScoreLookupStatusKey(beatmapId, country);
  const now = Date.now();
  const last = beatmapScoreLookupLastWriteByKey.get(key) ?? 0;
  if (!options.force && now - last < 350) return;
  beatmapScoreLookupLastWriteByKey.set(key, now);
  void setPersistentCache(key, { ...status, updatedAt: now }, TOP_PLAYS_STATUS_TTL);
}

export function writePartialBeatmapScores(beatmapId: number, country: string, scores: OsuScore[]): void {
  void setPersistentCache(
    beatmapScoreLookupPartialKey(beatmapId, country),
    sortBeatmapScores(scores),
    TOP_PLAYS_STATUS_TTL,
  );
}

export function clearBeatmapScoreLookupStatus(beatmapId: number, country: string): void {
  const key = beatmapScoreLookupStatusKey(beatmapId, country);
  beatmapScoreLookupLastWriteByKey.delete(key);
  void setPersistentCache(key, null, 1000);
}

export function topPlaysPartialKey(country: string): string {
  return `top-plays-partial:v1:${country}`;
}

export function writePartialTopPlays(country: string, popoffs: CountryTopPlay[]): void {
  if (popoffs.length === 0) return;
  void setPersistentCache(
    topPlaysPartialKey(country),
    [...popoffs].sort((a, b) => b.pp - a.pp || new Date(b.time).getTime() - new Date(a.time).getTime()).slice(0, COUNTRY_TOP_PLAYS_QUERY_LIMIT),
    TOP_PLAYS_STATUS_TTL,
  );
}

export function clearPartialTopPlays(country: string): void {
  void setPersistentCache(topPlaysPartialKey(country), null, 1000);
}
