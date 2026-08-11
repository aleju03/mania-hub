// @vitest-environment jsdom
//
// sessionStorage backs the name a card hands to the detail pageview.
import { describe, expect, it } from "vitest";

import {
  communityEventProperties,
  communityIdFromPath,
  getCommunitiesPageviewProperties,
  getCommunityDetailPageviewProperties,
  rememberCommunityName,
} from "./analytics-communities";

// The /communities route strips defaults out of the query string, so a param
// being present at all already means the visitor moved it.
const params = (query: string) => new URLSearchParams(query);

describe("getCommunitiesPageviewProperties", () => {
  it("says nothing about a default browse", () => {
    expect(getCommunitiesPageviewProperties(params(""))).toEqual({});
  });

  it("reports the search and every filter behind it", () => {
    expect(getCommunitiesPageviewProperties(params("q=vsrg&country=FR&lang=fr&tag=7k&sort=newest&page=1"))).toEqual({
      communities_query: "vsrg",
      communities_country: "France",
      communities_language: "French",
      communities_tag: "7k",
      communities_sort: "newest",
      // The route counts pages from zero.
      communities_page: "2",
    });
  });

  it("names the international scope rather than printing its code", () => {
    expect(getCommunitiesPageviewProperties(params("country=INTL")).communities_country).toBe("international");
  });

  it("caps a pasted-in search so one visitor cannot bloat the feed", () => {
    const props = getCommunitiesPageviewProperties(params(`q=${"a".repeat(200)}`));
    expect(String(props.communities_query)).toHaveLength(80);
  });
});

describe("community detail pageviews", () => {
  it("pulls the id out of the path, and knows the review queue is not one", () => {
    expect(communityIdFromPath("/communities/2b0f1c8e-9a1d-4f2b-8e11-9a0d6b7c1e33")).toBe(
      "2b0f1c8e-9a1d-4f2b-8e11-9a0d6b7c1e33",
    );
    expect(communityIdFromPath("/communities/review")).toBe("");
    expect(communityIdFromPath("/communities")).toBe("");
  });

  it("carries the name the card stashed, and copes without one", () => {
    expect(getCommunityDetailPageviewProperties("/communities/abc-123")).toEqual({ community_id: "abc-123" });

    rememberCommunityName("abc-123", "7K VSRG FR");
    expect(getCommunityDetailPageviewProperties("/communities/abc-123")).toEqual({
      community_id: "abc-123",
      community_name: "7K VSRG FR",
    });
  });
});

describe("communityEventProperties", () => {
  it("identifies the listing by id, name and where it is for", () => {
    expect(communityEventProperties({ id: "abc-123", name: "7K VSRG FR", countryCode: "FR" })).toEqual({
      community_id: "abc-123",
      community_name: "7K VSRG FR",
      community_country: "France",
    });
  });

  it("leaves the country out when the listing has none", () => {
    expect(communityEventProperties({ id: "abc-123", name: "7K GLOBAL", countryCode: null })).toEqual({
      community_id: "abc-123",
      community_name: "7K GLOBAL",
      community_country: undefined,
    });
  });
});
