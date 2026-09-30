// The Search tab's Vibro chip, persisted so a player who hides vibro charts
// keeps them hidden on every visit. Unlike the other filters it is a standing
// preference, like the sort (searchSortPreference.ts): Clear all leaves it,
// and the maps route applies it after hydration when the URL carries none.

const SEARCH_VIBRO_STORAGE_KEY = "mania-hub-maps-search-vibro-v1";

export type SearchVibroPreference = "only" | "hide" | "";

export function readSearchVibroPreference(): SearchVibroPreference {
  if (typeof window === "undefined") return "";
  try {
    const raw = localStorage.getItem(SEARCH_VIBRO_STORAGE_KEY);
    return raw === "only" || raw === "hide" ? raw : "";
  } catch (error) {
    console.warn("[maps] failed to read search vibro preference", error);
    return "";
  }
}

export function writeSearchVibroPreference(pref: SearchVibroPreference): void {
  if (typeof window === "undefined") return;
  try {
    if (pref) localStorage.setItem(SEARCH_VIBRO_STORAGE_KEY, pref);
    else localStorage.removeItem(SEARCH_VIBRO_STORAGE_KEY);
  } catch (error) {
    console.warn("[maps] failed to write search vibro preference", error);
  }
}

// Whether the post-hydration restore in maps.tsx is about to replace `current`
// with the stored preference: only when the URL carried none. Mirrors the
// guard in the route's restore effect; keep the two in step.
export function savedSearchVibroToRestore(current: SearchVibroPreference): boolean {
  return current === "" && readSearchVibroPreference() !== "";
}
