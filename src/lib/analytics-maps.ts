// Detail for /maps pageviews: which lens the visitor is on, what they typed,
// which filters they set and how they sorted - so the admin activity feed reads
// `Maps / Search · "camellia" · 7K · 4.5-6★` instead of a bare `Maps / Search`.
//
// Everything is derived from the URL. maps.tsx strips defaults out of the query
// string (stripSearchParams(DEFAULT_MAPS_SEARCH)), so a param being present at
// all already means the visitor moved it off its default.

import { danScaleLabel, type DanScaleContext } from "./dan-images";
import { formatDuration } from "./format";
import { MANIA_PATTERN_LABELS } from "./mania-patterns";

// Mirrors `type Tab` in maps.tsx.
const MAPS_TABS = ["search", "collections", "farmed", "popular", "favourites", "random"];

const KEY_LABELS: Record<string, string> = { "4k": "4K", "7k": "7K", other: "other keys" };
const STATUS_LABELS: Record<string, string> = {
  ranked: "ranked",
  qualified: "qualified",
  loved: "loved",
  graveyard: "graveyard",
  other: "pending",
};
const SEARCH_SORT_LABELS: Record<string, string> = {
  playcount: "most played",
  stars: "difficulty",
  bpm: "bpm",
  length: "length",
  date: "newest",
};
const BEATMAP_SORT_LABELS: Record<string, string> = {
  plays: "plays",
  players: "players",
  stars: "stars",
  length: "length",
};
const FARMED_SORT_LABELS: Record<string, string> = {
  players: "players",
  "avg-pp": "avg pp",
  "max-pp": "max pp",
  stars: "stars",
  recent: "recent",
};
const MOD_LABELS: Record<string, string> = { dt: "DT", ht: "HT", nm: "NM" };
const RANDOM_WEIGHT_LABELS: Record<string, string> = {
  players: "by players",
  favourites: "by favourites",
};

const MAX_QUERY_CHARS = 80;
const MAX_FILTERS_CHARS = 220;

// Collection ids are opaque, so the tile that starts the navigation stashes the
// pack's label here and the pageview reads it back - same trick the farm-helper
// list uses for map titles.
const COLLECTION_CONTEXT_KEY_PREFIX = "mania-hub-maps-collection-context-v1:";

export function rememberMapsCollection(id: string, label: string): void {
  if (!id || !label || typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(`${COLLECTION_CONTEXT_KEY_PREFIX}${id}`, label);
  } catch {
    // sessionStorage can be unavailable; the id-only label still works
  }
}

function readMapsCollectionLabel(id: string): string | null {
  if (!id || typeof window === "undefined") return null;
  try {
    const stored = window.sessionStorage.getItem(`${COLLECTION_CONTEXT_KEY_PREFIX}${id}`);
    return stored && stored.trim() ? stored : null;
  } catch {
    return null;
  }
}

function csv(value: string | null): string[] {
  return value ? value.split(",").filter(Boolean) : [];
}

function number(params: URLSearchParams, key: string): number {
  const parsed = Number(params.get(key));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

// Dan levels are the one range where 0 is a real pick (the 7K ladder starts at
// 0), so absence has to come from the param, not from the value.
function danLevel(params: URLSearchParams, key: string): number | null {
  if (!params.has(key)) return null;
  const parsed = Number(params.get(key));
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
}

function labelList(ids: string[], labels: Record<string, string>): string | null {
  if (ids.length === 0) return null;
  return ids.map((id) => labels[id] ?? id).join("/");
}

function stars(value: number): string {
  return String(Math.round(value * 10) / 10);
}

function formatRange(min: number, max: number, format: (value: number) => string, unit: string): string | null {
  if (min <= 0 && max <= 0) return null;
  if (min > 0 && max > 0) return `${format(min)}-${format(max)}${unit}`;
  if (min > 0) return `${format(min)}${unit}+`;
  return `up to ${format(max)}${unit}`;
}

// Which dan ladder the picked levels sit on, mirroring danLadderGroups() in
// MapSearchSection: the keymode's own ladder when the key facet is exactly 4K
// or 7K (4K otherwise, as the picker shows), swapped for the LN courses when
// the pattern facet is LN-flavoured.
function danContext(keys: string[], patterns: string[]): DanScaleContext {
  const lnFlavoured = patterns.some((pattern) => pattern === "ln" || pattern.startsWith("ln"));
  const only = keys.length === 1 ? keys[0] : null;
  if (only === "7k") return lnFlavoured ? "7k-ln" : "7k";
  return lnFlavoured ? "ln" : "reform";
}

function describeDanRange(params: URLSearchParams, keys: string[], patterns: string[]): string | null {
  const min = danLevel(params, "sDanMin");
  const max = danLevel(params, "sDanMax");
  if (min == null && max == null) return null;
  const context = danContext(keys, patterns);
  const lo = min != null ? danScaleLabel(min, context) : null;
  const hi = max != null ? danScaleLabel(max, context) : null;
  if (lo && hi) return lo === hi ? `dan ${lo}` : `dan ${lo}-${hi}`;
  if (lo) return `dan ${lo}+`;
  return `dan up to ${hi}`;
}

function patternList(patterns: string[]): string | null {
  if (patterns.length === 0) return null;
  return patterns.map((pattern) => MANIA_PATTERN_LABELS[pattern] ?? pattern).join("/");
}

// Global catalog search: the s-prefixed facets.
function describeSearchFilters(params: URLSearchParams): (string | null)[] {
  const keys = csv(params.get("sKeys"));
  const patterns = csv(params.get("sPatterns"));
  return [
    labelList(keys, KEY_LABELS),
    labelList(csv(params.get("sStatuses")), STATUS_LABELS),
    formatRange(number(params, "sStarMin"), number(params, "sStarMax"), stars, "★"),
    formatRange(number(params, "sBpmMin"), number(params, "sBpmMax"), (value) => String(Math.round(value)), " bpm"),
    formatRange(number(params, "sLenMin"), number(params, "sLenMax"), (value) => formatDuration(Math.round(value)), ""),
    describeDanRange(params, keys, patterns),
    patternList(patterns),
  ];
}

// Country-scoped lenses (farmed / popular / favourites).
function describeBrowseFilters(params: URLSearchParams): (string | null)[] {
  const key = params.get("key");
  const status = params.get("status");
  const mod = params.get("mod");
  const minPp = number(params, "pp");
  return [
    key ? (KEY_LABELS[key] ?? key) : null,
    status ? (STATUS_LABELS[status] ?? status) : null,
    mod ? (MOD_LABELS[mod] ?? mod) : null,
    minPp > 0 ? `${Math.round(minPp)}pp+ players` : null,
  ];
}

function describeRandomFilters(params: URLSearchParams): (string | null)[] {
  const key = params.get("rKey");
  const status = params.get("rStatus");
  const pattern = params.get("rPattern");
  const weight = params.get("rWeight");
  return [
    key ? (KEY_LABELS[key] ?? key) : null,
    status ? (STATUS_LABELS[status] ?? status) : null,
    formatRange(number(params, "rStars"), number(params, "rStarsMax"), stars, "★"),
    pattern ? (MANIA_PATTERN_LABELS[pattern] ?? pattern) : null,
    weight ? (RANDOM_WEIGHT_LABELS[weight] ?? weight) : null,
    params.get("rAvoidRepeats") === "true" ? "no repeats" : null,
  ];
}

function describeFilters(tab: string, params: URLSearchParams): (string | null)[] {
  if (tab === "search") return describeSearchFilters(params);
  if (tab === "random") return describeRandomFilters(params);
  if (tab === "farmed" || tab === "popular" || tab === "favourites") return describeBrowseFilters(params);
  return [];
}

function describeSort(tab: string, params: URLSearchParams): string | null {
  if (tab === "search") {
    const sort = params.get("sSort");
    if (!sort) return null;
    const dir = params.get("sDir") === "asc" ? " asc" : "";
    return `${SEARCH_SORT_LABELS[sort] ?? sort}${dir}`;
  }
  if (tab === "farmed" || tab === "popular" || tab === "favourites") {
    const labels = tab === "farmed" ? FARMED_SORT_LABELS : BEATMAP_SORT_LABELS;
    const sort = params.get(tab === "farmed" ? "farmedSort" : "beatmapSort");
    const asc = params.get("dir") === "asc";
    if (!sort && !asc) return null;
    // Both lenses default to sorting by players, so a lone `dir=asc` means that.
    const resolved = sort ?? "players";
    return `${labels[resolved] ?? resolved}${asc ? " asc" : ""}`;
  }
  return null;
}

/**
 * Pageview properties for /maps, keyed the way the admin activity feed reads
 * them back (maps_tab, maps_query, maps_filters, maps_sort, ...).
 */
export function getMapsPageviewProperties(params: URLSearchParams): Record<string, unknown> {
  // No `?tab=` param means the default view, which is search (not farmed) - the
  // old fallback mis-recorded every search/collections visit as farmed.
  const rawTab = params.get("tab");
  const tab = rawTab && MAPS_TABS.includes(rawTab) ? rawTab : "search";
  const props: Record<string, unknown> = { maps_tab: tab };

  const query = (tab === "search" ? params.get("sQ") : params.get("q"))?.trim();
  if (query) props.maps_query = query.slice(0, MAX_QUERY_CHARS);

  const filters = describeFilters(tab, params).filter((part): part is string => Boolean(part));
  if (filters.length > 0) props.maps_filters = filters.join(" · ").slice(0, MAX_FILTERS_CHARS);

  const sort = describeSort(tab, params);
  if (sort) props.maps_sort = sort;

  if (tab === "collections") {
    const id = params.get("col");
    if (id) props.maps_collection = readMapsCollectionLabel(id) ?? `#${id}`;
  }

  // The route's page param is 0-based; report the page the visitor sees.
  const page = number(params, "page");
  if (page > 0) props.maps_page = page + 1;

  // Set when a map's detail modal is open (shared link or a card click).
  const beatmapId = number(params, "map");
  if (beatmapId > 0) props.maps_beatmap_id = String(Math.round(beatmapId));

  return props;
}
