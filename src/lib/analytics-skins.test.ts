// @vitest-environment jsdom
//
// sessionStorage backs the name the card hands to the detail pageview.
import { describe, expect, it } from "vitest";

import {
  getSkinDetailPageviewProperties,
  getSkinsPageviewProperties,
  rememberSkinName,
  skinEventProperties,
  skinRefFromPath,
} from "./analytics-skins";

// The /skins route strips defaults out of the query string, so a param being
// present at all already means the visitor moved it.
const params = (query: string) => new URLSearchParams(query);

describe("getSkinsPageviewProperties", () => {
  it("says nothing about a default browse", () => {
    expect(getSkinsPageviewProperties(params(""))).toEqual({});
  });

  it("reports the search, keymode facet, sort and page the visitor sees", () => {
    expect(getSkinsPageviewProperties(params("q=arrow&k=7&sort=downloads&page=2"))).toEqual({
      skins_query: "arrow",
      skins_keys: "7K",
      skins_sort: "most downloaded",
      // The route counts pages from zero.
      skins_page: "3",
    });
  });

  it("names both directions of every sort toggle", () => {
    expect(getSkinsPageviewProperties(params("sort=oldest")).skins_sort).toBe("oldest");
    expect(getSkinsPageviewProperties(params("sort=downloads-asc")).skins_sort).toBe("least downloaded");
    expect(getSkinsPageviewProperties(params("sort=size")).skins_sort).toBe("largest");
    expect(getSkinsPageviewProperties(params("sort=size-asc")).skins_sort).toBe("smallest");
  });

  it("ignores a keymode outside the pickable range", () => {
    expect(getSkinsPageviewProperties(params("k=0"))).toEqual({});
    expect(getSkinsPageviewProperties(params("k=99"))).toEqual({});
  });

  it("calls the 7K+1 chip by its name instead of 8K", () => {
    expect(getSkinsPageviewProperties(params("k=8&special=true")).skins_keys).toBe("7K+1");
    expect(getSkinsPageviewProperties(params("k=8")).skins_keys).toBe("8K");
    // The flag refines nothing but an 8K filter, like the route.
    expect(getSkinsPageviewProperties(params("k=7&special=true")).skins_keys).toBe("7K");
  });

  it("joins the trait filters the way the page words them", () => {
    expect(getSkinsPageviewProperties(params("shape=arrow&cover=true&shots=true&lazer=true&res=1920x1080"))).toEqual({
      skins_filters: "arrows · lane cover · screenshots · lazer · 1920x1080",
    });
    expect(getSkinsPageviewProperties(params("shape=other&stage=true&stable=true&mine=true"))).toEqual({
      skins_filters: "other notes · mania stage · stable · their uploads",
    });
  });

  it("reads a legacy link carrying both client flags as no client filter", () => {
    expect(getSkinsPageviewProperties(params("lazer=true&stable=true"))).toEqual({});
  });

  it("caps a pasted-in search so one visitor cannot bloat the feed", () => {
    const props = getSkinsPageviewProperties(params(`q=${"a".repeat(200)}`));
    expect(String(props.skins_query)).toHaveLength(80);
  });
});

describe("skin detail pageviews", () => {
  it("pulls the slug out of the path", () => {
    expect(skinRefFromPath("/skins/pl0x-aleju03-mix")).toBe("pl0x-aleju03-mix");
    expect(skinRefFromPath("/skins")).toBe("");
  });

  it("carries the name the card stashed, and copes without one", () => {
    expect(getSkinDetailPageviewProperties("/skins/frost")).toEqual({ skin_ref: "frost" });

    rememberSkinName("frost", "Frost 4K");
    expect(getSkinDetailPageviewProperties("/skins/frost")).toEqual({
      skin_ref: "frost",
      skin_name: "Frost 4K",
    });
  });
});

describe("skinEventProperties", () => {
  it("identifies the skin by slug, name and keymodes", () => {
    expect(skinEventProperties({
      id: "8dc08d4f",
      slug: "invadey",
      name: "invadey",
      keymodes: [4, 7],
      oskSizeBytes: 42,
    })).toEqual({
      skin_ref: "invadey",
      skin_name: "invadey",
      skin_keymodes: "4K/7K",
      skin_size_bytes: 42,
    });
  });

  it("falls back to the row id for a skin published before slugs existed", () => {
    const props = skinEventProperties({ id: "8dc08d4f", slug: null, name: "old", keymodes: [], oskSizeBytes: null });
    expect(props.skin_ref).toBe("8dc08d4f");
    expect(props.skin_size_bytes).toBeUndefined();
  });
});
