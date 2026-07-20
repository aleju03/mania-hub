// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SEARCH_SORT,
  isPersistableSearchSort,
  readSearchSortPreference,
  savedSearchSortToRestore,
  writeSearchSortPreference,
} from "./searchSortPreference";

const STORAGE_KEY = "mania-hub-maps-search-sort-v1";

beforeEach(() => {
  localStorage.clear();
});

describe("search sort preference storage", () => {
  it("round-trips a persistable sort", () => {
    writeSearchSortPreference({ sort: "stars", dir: "asc" });
    expect(readSearchSortPreference()).toEqual({ sort: "stars", dir: "asc" });
  });

  it("drops relevance and unknown sorts on read, keeping a valid dir", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ sort: "relevance", dir: "asc" }));
    expect(readSearchSortPreference()).toEqual({ dir: "asc" });
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ sort: "nonsense", dir: "sideways" }));
    expect(readSearchSortPreference()).toEqual({});
  });

  it("ignores malformed storage", () => {
    localStorage.setItem(STORAGE_KEY, "{not json");
    expect(readSearchSortPreference()).toEqual({});
    localStorage.setItem(STORAGE_KEY, JSON.stringify(["stars"]));
    expect(readSearchSortPreference()).toEqual({});
  });

  it("classifies persistable sorts", () => {
    expect(isPersistableSearchSort("playcount")).toBe(true);
    expect(isPersistableSearchSort("relevance")).toBe(false);
    expect(isPersistableSearchSort(7)).toBe(false);
  });
});

describe("savedSearchSortToRestore", () => {
  it("is false with no stored preference", () => {
    expect(savedSearchSortToRestore(DEFAULT_SEARCH_SORT)).toBe(false);
  });

  it("is true when the URL is at the default and the stored sort differs", () => {
    writeSearchSortPreference({ sort: "stars", dir: "desc" });
    expect(savedSearchSortToRestore(DEFAULT_SEARCH_SORT)).toBe(true);
  });

  it("is true when only the stored direction differs", () => {
    writeSearchSortPreference({ sort: DEFAULT_SEARCH_SORT.sort, dir: "asc" });
    expect(savedSearchSortToRestore(DEFAULT_SEARCH_SORT)).toBe(true);
  });

  it("is false when the URL carries an explicit sort (restore won't run)", () => {
    writeSearchSortPreference({ sort: "stars", dir: "desc" });
    expect(savedSearchSortToRestore({ sort: "bpm", dir: "desc" })).toBe(false);
  });

  it("is false when the stored preference matches the default", () => {
    writeSearchSortPreference({ sort: DEFAULT_SEARCH_SORT.sort, dir: DEFAULT_SEARCH_SORT.dir });
    expect(savedSearchSortToRestore(DEFAULT_SEARCH_SORT)).toBe(false);
  });
});
