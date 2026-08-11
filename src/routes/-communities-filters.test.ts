import { describe, expect, it } from "vitest";
import { parseCommunitiesSearch, visibleFacets } from "./communities";

/* Every filter on /communities is checked against its own vocabulary on read,
   so a hand-edited URL cannot put a value into the querystring that the page
   then hands to the backend or echoes back into a select. */

describe("parseCommunitiesSearch", () => {
  it("falls back to the defaults for an empty search", () => {
    expect(parseCommunitiesSearch({})).toEqual({
      q: "",
      page: 0,
      sort: "members",
      country: "",
      lang: "",
      tag: "",
      discord: "",
    });
  });

  it("keeps the values it recognises", () => {
    expect(parseCommunitiesSearch({
      q: "mania",
      page: 3,
      sort: "newest",
      country: "cr",
      lang: "es",
    })).toEqual({
      q: "mania",
      page: 3,
      sort: "newest",
      country: "CR",
      lang: "es",
      tag: "",
      discord: "",
    });
  });

  it("cleans a tag the same way the input box does", () => {
    // Free text, so there is no vocabulary to check a hand-edited URL against;
    // the cleaning is what makes one safe to hand to the backend and echo back.
    expect(parseCommunitiesSearch({ tag: "  Tournaments!! " }).tag).toBe("tournaments");
    expect(parseCommunitiesSearch({ tag: "x".repeat(80) }).tag).toHaveLength(24);
    expect(parseCommunitiesSearch({ tag: 7 }).tag).toBe("");
  });

  it("keeps the Discord connection flag long enough to be read", () => {
    // It rides back on the callback's redirect, and validateSearch drops
    // anything not in the schema, so it has to be part of it.
    expect(parseCommunitiesSearch({ discord: "connected" }).discord).toBe("connected");
    expect(parseCommunitiesSearch({ discord: "failed" }).discord).toBe("failed");
    expect(parseCommunitiesSearch({ discord: "whatever" }).discord).toBe("");
  });

  it("treats international as a country of its own", () => {
    expect(parseCommunitiesSearch({ country: "intl" }).country).toBe("INTL");
  });

  it("drops values outside each vocabulary", () => {
    const parsed = parseCommunitiesSearch({
      sort: "members-asc",
      country: "COSTARICA",
      lang: "klingon",
    });
    expect(parsed.sort).toBe("members");
    expect(parsed.country).toBe("");
    expect(parsed.lang).toBe("");
  });

  it("ignores a filter that no longer exists", () => {
    // Keys and purpose tags were dropped before the directory opened. An old
    // link carrying them must still parse to a clean search rather than
    // smuggling the value through.
    const parsed = parseCommunitiesSearch({ k: "7K", purpose: "tournaments" }) as Record<string, unknown>;
    expect(parsed.k).toBeUndefined();
    expect(parsed.purpose).toBeUndefined();
  });

  it("refuses a page that is not a positive whole number", () => {
    expect(parseCommunitiesSearch({ page: -2 }).page).toBe(0);
    expect(parseCommunitiesSearch({ page: 1.5 }).page).toBe(0);
    expect(parseCommunitiesSearch({ page: "nope" }).page).toBe(0);
  });

  it("reads a page number that arrived from the URL as a string", () => {
    expect(parseCommunitiesSearch({ page: "4" }).page).toBe(4);
  });

  it("caps the search text", () => {
    expect(parseCommunitiesSearch({ q: "x".repeat(200) }).q).toHaveLength(80);
  });
});

/* The filter rows are the directory describing itself, which only reads well
   while there are few values behind it. A hundred countries listed is a wall of
   flags with the servers pushed off the screen, so a collapsed row keeps the
   most-listed few and puts a count on the rest. */

describe("visibleFacets", () => {
  const facets = Array.from({ length: 30 }, (_, index) => ({ value: `c${index}`, count: 30 - index }));

  it("keeps the most-listed few", () => {
    expect(visibleFacets(facets, { limit: 8 }).map((facet) => facet.value)).toEqual([
      "c0", "c1", "c2", "c3", "c4", "c5", "c6", "c7",
    ]);
  });

  it("shows everything when there is less than the limit", () => {
    expect(visibleFacets(facets.slice(0, 3), { limit: 8 })).toHaveLength(3);
  });

  it("leads with the picked one when it sits past the cut", () => {
    // Otherwise a filter is on with nothing on screen saying so.
    const shown = visibleFacets(facets, { active: "c20", limit: 8 });
    expect(shown.map((facet) => facet.value)).toEqual(["c20", "c0", "c1", "c2", "c3", "c4", "c5", "c6"]);
  });

  it("leaves the row alone when the picked one is already in it", () => {
    // Clicking something in the row must not reshuffle it under the cursor.
    expect(visibleFacets(facets, { active: "c3", limit: 8 })).toEqual(visibleFacets(facets, { limit: 8 }));
  });

  it("keeps the viewer's own country in the row", () => {
    const shown = visibleFacets(facets, { pin: "c25", limit: 8 });
    expect(shown[0]?.value).toBe("c25");
    expect(shown).toHaveLength(8);
  });

  it("keeps both the picked one and the viewer's own country", () => {
    const shown = visibleFacets(facets, { active: "c19", pin: "c25", limit: 8 });
    expect(shown.map((facet) => facet.value).slice(0, 2)).toEqual(["c19", "c25"]);
    expect(shown).toHaveLength(8);
  });

  it("counts a value once when it is both", () => {
    const shown = visibleFacets(facets, { active: "c25", pin: "c25", limit: 8 });
    expect(shown.filter((facet) => facet.value === "c25")).toHaveLength(1);
    expect(shown).toHaveLength(8);
  });

  it("ignores a country with nothing listed for it", () => {
    // The viewer's country is pinned whether or not any server picked it.
    expect(visibleFacets(facets, { pin: "ZZ", limit: 8 })).toEqual(visibleFacets(facets, { limit: 8 }));
  });
});
