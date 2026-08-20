import { describe, expect, it } from "vitest";

import {
  collectionsCardProperties,
  collectionsDirectoryProperties,
  collectionsShelfProperties,
  getCollectionsPageviewProperties,
} from "./analytics-collections";

const params = (query: string) => new URLSearchParams(query);

describe("getCollectionsPageviewProperties", () => {
  it("names the tab, with the default one spelled out rather than left off", () => {
    // The route keeps the default tab out of the URL, so a bare path is the
    // showcase and has to be reported as such.
    expect(getCollectionsPageviewProperties(params(""))).toEqual({ collections_tab: "Showcase" });
    expect(getCollectionsPageviewProperties(params("tab=collectors"))).toEqual({
      collections_tab: "Collectors",
    });
  });

  it("reports the collector alone, since a shelf is what is on screen", () => {
    expect(getCollectionsPageviewProperties(params("collector=manolo&tab=collectors"))).toEqual({
      collections_collector: "manolo",
    });
  });

  it("caps a pasted-in collector name", () => {
    const props = getCollectionsPageviewProperties(params(`collector=${"a".repeat(200)}`));
    expect(String(props.collections_collector)).toHaveLength(60);
  });
});

describe("collectionsShelfProperties", () => {
  it("reports the state a move landed on, counting pages from one", () => {
    expect(
      collectionsShelfProperties({ collector: "manolo", tierLabel: "GOAT", query: "", page: 2 }),
    ).toEqual({
      collections_collector: "manolo",
      collections_tier: "GOAT",
      collections_page: "3",
    });
  });

  it("leaves out the tier filter sitting where it started, and the first page", () => {
    expect(
      collectionsShelfProperties({ collector: "manolo", tierLabel: "All", query: "", page: 0 }),
    ).toEqual({ collections_collector: "manolo" });
  });

  it("carries the player search", () => {
    expect(
      collectionsShelfProperties({ collector: "manolo", tierLabel: null, query: " jakads ", page: 0 })
        .collections_query,
    ).toBe("jakads");
  });
});

describe("collectionsDirectoryProperties", () => {
  it("names the sorted column by what it puts on top", () => {
    expect(collectionsDirectoryProperties({ query: "", sort: "goats", page: 1 })).toEqual({
      collections_sort: "most GOATs",
      collections_page: "2",
    });
  });

  it("passes an unknown sort through rather than dropping it", () => {
    expect(collectionsDirectoryProperties({ query: "", sort: "shards", page: 0 }).collections_sort).toBe("shards");
  });
});

describe("collectionsCardProperties", () => {
  it("names the card by its player, with the shelf it was opened from", () => {
    expect(collectionsCardProperties({ player: "jakads", tierLabel: "Mythic", collector: "manolo" })).toEqual({
      collections_card: "jakads",
      collections_tier: "Mythic",
      collections_collector: "manolo",
    });
  });

  it("says nothing about a collector it was not given", () => {
    expect(collectionsCardProperties({ player: "jakads", tierLabel: null })).toEqual({
      collections_card: "jakads",
    });
  });
});
