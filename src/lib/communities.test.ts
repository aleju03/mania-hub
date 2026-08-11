// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearCommunitiesCache,
  communitiesListCacheKey,
  countCommunityQueue,
  readCachedCommunities,
  readCachedMyCommunities,
  writeCachedCommunities,
  writeCachedMyCommunities,
  type CommunitiesListResult,
} from "./communities";

/* What the directory keeps between visits. Walking into a server's page and
   back remounts /communities, and without this the grid went to skeletons for
   the length of a refetch that returned the page already on screen. */

function list(total: number): CommunitiesListResult {
  return {
    communities: [],
    total,
    page: 0,
    pageSize: 24,
    facets: { countries: [], languages: [], tags: [] },
  };
}

describe("communitiesListCacheKey", () => {
  it("gives an unfiltered query and its defaults the same key", () => {
    expect(communitiesListCacheKey({})).toBe(communitiesListCacheKey({ page: 0, sort: "members" }));
  });

  it("separates every filter", () => {
    const base = communitiesListCacheKey({});
    for (const query of [
      { q: "7k" },
      { page: 2 },
      { sort: "newest" as const },
      { country: "CR" },
      { lang: "french" },
      { tag: "tournaments" },
    ]) {
      expect(communitiesListCacheKey(query)).not.toBe(base);
    }
  });

  it("ignores the whitespace around a search", () => {
    expect(communitiesListCacheKey({ q: "  vsrg " })).toBe(communitiesListCacheKey({ q: "vsrg" }));
  });
});

// The number on the Review button. A moderator should know a server is waiting
// without opening the page, so this counts every list the page shows.
describe("countCommunityQueue", () => {
  it("adds up the three lists", () => {
    expect(countCommunityQueue({
      pending: [{ id: "a" }, { id: "b" }] as never,
      edited: [{ id: "c" }] as never,
      reported: [{ id: "d" }] as never,
      reports: {},
    })).toBe(4);
  });

  it("counts an empty or half-shaped queue as nothing waiting", () => {
    expect(countCommunityQueue({ pending: [], edited: [], reported: [], reports: {} })).toBe(0);
    expect(countCommunityQueue({})).toBe(0);
  });
});

describe("the communities list cache", () => {
  beforeEach(() => {
    clearCommunitiesCache();
  });

  it("hands a written page back under its own key and nothing back under another", () => {
    writeCachedCommunities(communitiesListCacheKey({ country: "CR" }), list(3));
    expect(readCachedCommunities(communitiesListCacheKey({ country: "CR" }))?.total).toBe(3);
    expect(readCachedCommunities(communitiesListCacheKey({ country: "FR" }))).toBeNull();
  });

  it("drops the oldest pages rather than growing across a long browse", () => {
    for (let page = 0; page < 40; page += 1) {
      writeCachedCommunities(communitiesListCacheKey({ page }), list(page));
    }
    expect(readCachedCommunities(communitiesListCacheKey({ page: 0 }))).toBeNull();
    expect(readCachedCommunities(communitiesListCacheKey({ page: 39 }))?.total).toBe(39);
  });

  // A posted, edited, taken-down or reviewed listing changes what the directory
  // lists, so a page from before it would repaint the old grid for a moment.
  it("forgets everything, its own listings included, once a listing changes", () => {
    writeCachedCommunities(communitiesListCacheKey({}), list(5));
    writeCachedMyCommunities([{ id: "a" } as never]);
    clearCommunitiesCache();
    expect(readCachedCommunities(communitiesListCacheKey({}))).toBeNull();
    expect(readCachedMyCommunities()).toBeNull();
  });
});
