// Request shape for the server-side Random draw (`/api/snapshots/maps-random-draw`).
// The Random tab used to download the whole favourites pool and filter it in the
// browser; now the filters ride along with each draw, so this module owns the
// translation from the r-prefixed URL params to the wire params.
import { parseTriStateCsv } from "./maps-random-filter";

export const RANDOM_STATUS_OPTIONS = ["ranked", "loved", "graveyard", "other"] as const;
export const RANDOM_KEY_OPTIONS = ["4k", "7k", "other"] as const;
export const RANDOM_PATTERN_OPTIONS = [
  "jack",
  "chordjack",
  "stream",
  "jumpstream",
  "stamina",
  "tech",
  "ln",
  "sv",
  "tiebreaker",
] as const;

export type RandomStatus = (typeof RANDOM_STATUS_OPTIONS)[number];
export type RandomKey = (typeof RANDOM_KEY_OPTIONS)[number];
export type RandomPattern = (typeof RANDOM_PATTERN_OPTIONS)[number];
export type RandomWeight = "players" | "favourites";

// Umbrella filters expand to their specific siblings so "Jack" also matches
// chordjack/longjack/etc and "Stream" also matches jumpstream/handstream/etc.
// The server matches canonical names verbatim, so the expansion stays here.
export const RANDOM_PATTERN_MATCHES: Record<RandomPattern, string[]> = {
  jack: ["jack", "chordjack", "longjack", "speedjack", "minijack"],
  chordjack: ["chordjack"],
  stream: ["stream", "jumpstream", "chordstream", "handstream", "dumpstream"],
  jumpstream: ["jumpstream"],
  stamina: ["stamina"],
  tech: ["tech"],
  ln: ["ln"],
  sv: ["sv"],
  tiebreaker: ["tiebreaker"],
};

// Hidden users ride in the query string, so the list is bounded; anything past
// the cap is dropped client-side from the arriving picks instead.
export const RANDOM_DRAW_HIDE_USERS_MAX = 100;
// Recency + already-queued exclusions, matching the server's caps.
export const RANDOM_DRAW_EXCLUDE_USERS_MAX = 8;
export const RANDOM_DRAW_EXCLUDE_SETS_MAX = 16;

// The filter half of a draw request: everything derived from the URL params and
// user preferences. Stable across rerolls, so it doubles as the request key.
export interface LiveMapsRandomDrawFilters {
  weight: RandomWeight;
  status: string[];
  statusExclude: string[];
  keys: string[];
  keysExclude: string[];
  patterns: string[];
  patternsExclude: string[];
  starMin: number;
  starMax: number;
  hideUsers: number[];
}

export interface LiveMapsRandomDrawParams extends LiveMapsRandomDrawFilters {
  // 0 asks for counts only (used to refresh the header after a filter change).
  count: number;
  excludeUsers: number[];
  excludeSets: number[];
}

export interface RandomDrawFiltersInput {
  rStatus: string;
  rKey: string;
  rPattern: string;
  rStars: number;
  rStarsMax: number;
  rWeight: RandomWeight;
  hiddenUserIds?: Iterable<number>;
}

function expandPatterns(selected: Iterable<RandomPattern>): string[] {
  const expanded = new Set<string>();
  for (const pattern of selected) for (const canonical of RANDOM_PATTERN_MATCHES[pattern]) expanded.add(canonical);
  return [...expanded];
}

function boundedIds(ids: Iterable<number> | undefined, max: number): number[] {
  if (!ids) return [];
  const unique = new Set<number>();
  for (const id of ids) {
    if (!Number.isFinite(id) || id <= 0) continue;
    unique.add(Math.trunc(id));
    if (unique.size >= max) break;
  }
  return [...unique];
}

export function buildRandomDrawFilters(input: RandomDrawFiltersInput): LiveMapsRandomDrawFilters {
  const status = parseTriStateCsv(input.rStatus, RANDOM_STATUS_OPTIONS);
  const keys = parseTriStateCsv(input.rKey, RANDOM_KEY_OPTIONS);
  const patterns = parseTriStateCsv(input.rPattern, RANDOM_PATTERN_OPTIONS);

  return {
    weight: input.rWeight === "players" ? "players" : "favourites",
    status: [...status.includes],
    statusExclude: [...status.excludes],
    keys: [...keys.includes],
    keysExclude: [...keys.excludes],
    patterns: expandPatterns(patterns.includes),
    patternsExclude: expandPatterns(patterns.excludes),
    starMin: input.rStars > 0 ? input.rStars : 0,
    starMax: input.rStarsMax > 0 ? input.rStarsMax : 0,
    hideUsers: boundedIds(input.hiddenUserIds, RANDOM_DRAW_HIDE_USERS_MAX),
  };
}

export function buildRandomDrawParams(
  filters: LiveMapsRandomDrawFilters,
  draw: { count: number; excludeUsers?: Iterable<number>; excludeSets?: Iterable<number> },
): LiveMapsRandomDrawParams {
  return {
    ...filters,
    count: Math.max(0, Math.trunc(draw.count)),
    excludeUsers: boundedIds(draw.excludeUsers, RANDOM_DRAW_EXCLUDE_USERS_MAX),
    excludeSets: boundedIds(draw.excludeSets, RANDOM_DRAW_EXCLUDE_SETS_MAX),
  };
}

// Empty lists and zero ranges are omitted so a counts-only request for the
// default filters stays short (and cacheable) on the server side.
export function buildRandomDrawQuery(country: string, params: LiveMapsRandomDrawParams): string {
  const query = new URLSearchParams({ country, count: String(params.count), weight: params.weight });
  const setCsv = (key: string, values: Array<string | number>) => {
    if (values.length > 0) query.set(key, values.join(","));
  };
  setCsv("status", params.status);
  setCsv("statusExclude", params.statusExclude);
  setCsv("keys", params.keys);
  setCsv("keysExclude", params.keysExclude);
  setCsv("patterns", params.patterns);
  setCsv("patternsExclude", params.patternsExclude);
  if (params.starMin > 0) query.set("starMin", String(params.starMin));
  if (params.starMax > 0) query.set("starMax", String(params.starMax));
  setCsv("excludeUsers", params.excludeUsers);
  setCsv("excludeSets", params.excludeSets);
  setCsv("hideUsers", params.hideUsers);
  return query.toString();
}
