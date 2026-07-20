// The Search tab's chosen sort, persisted so a return visit lands on it
// instead of the default (Most played). Only the five user-selectable sorts
// are remembered; "relevance" is query-only and meaningless on a fresh visit.
//
// Shared between the maps route (which validates URL params, applies the
// stored preference after hydration, and writes it on sort changes) and
// MapSearchSection (which holds its first fetch while a restore is pending).

const SEARCH_SORT_STORAGE_KEY = "mania-hub-maps-search-sort-v1";

export const SEARCH_SORT_VALUES = ["playcount", "stars", "bpm", "length", "date", "relevance"];

export const DEFAULT_SEARCH_SORT: SearchSortPreference = { sort: "playcount", dir: "desc" };

export type SearchSortPreference = { sort: string; dir: string };

export function isPersistableSearchSort(value: unknown): value is string {
  return typeof value === "string" && value !== "relevance" && SEARCH_SORT_VALUES.includes(value);
}

export function readSearchSortPreference(): Partial<SearchSortPreference> {
  if (typeof window === "undefined") return {};

  let parsed: unknown;
  try {
    const raw = localStorage.getItem(SEARCH_SORT_STORAGE_KEY);
    if (!raw) return {};
    parsed = JSON.parse(raw);
  } catch (error) {
    console.warn("[maps] failed to read search sort preference", error);
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

  const { sort, dir } = parsed as Record<string, unknown>;
  const pref: Partial<SearchSortPreference> = {};
  if (isPersistableSearchSort(sort)) pref.sort = sort;
  if (dir === "asc" || dir === "desc") pref.dir = dir;
  return pref;
}

export function writeSearchSortPreference(pref: SearchSortPreference): void {
  if (typeof window === "undefined") return;

  try {
    localStorage.setItem(SEARCH_SORT_STORAGE_KEY, JSON.stringify(pref));
  } catch (error) {
    console.warn("[maps] failed to write search sort preference", error);
  }
}

// Whether the post-hydration restore in maps.tsx is about to replace `current`
// with a stored preference: only when the URL carried no explicit sort (both
// halves at the default) and the stored preference resolves elsewhere. Mirrors
// the guard in the route's restore effect; keep the two in step.
export function savedSearchSortToRestore(current: { sort: string; dir: string }): boolean {
  if (current.sort !== DEFAULT_SEARCH_SORT.sort || current.dir !== DEFAULT_SEARCH_SORT.dir) return false;
  const pref = readSearchSortPreference();
  return (
    (pref.sort ?? DEFAULT_SEARCH_SORT.sort) !== current.sort ||
    (pref.dir ?? DEFAULT_SEARCH_SORT.dir) !== current.dir
  );
}
