import { describe, expect, it } from "vitest";
import { getRequiredScoreCountForPage, getTrackerWindowCount } from "./tracker";

const TRACKER_PAGE_SIZE = 45;

// The feed shows skeletons while it holds fewer scores than the current page
// needs, so this pair reproduces the real stuck-skeleton condition.
function showsSkeletons(options: {
  displayableCount: number;
  selectedCountry: string;
  liveTrackerTotal: number | null;
  drained: boolean;
}): boolean {
  const trackerWindowCount = getTrackerWindowCount({
    liveFilteredTotal: null,
    liveBackendEnabled: true,
    hasActiveScoreFilters: false,
    useLiveBackendFilteredScores: false,
    ...options,
  });
  const required = getRequiredScoreCountForPage({
    currentPage: 0,
    trackerWindowCount,
    liveBackendEnabled: true,
    hasActiveScoreFilters: false,
  });
  return options.displayableCount < required;
}

describe("tracker feed window count", () => {
  // CW: 9 stored passes, two of them D ranks that getScoreDisplayValues hides,
  // so the feed can only ever render 7. Before the fix the backend total acted
  // as a floor (9) and the page waited forever for two rows it would never
  // show -- an infinite skeleton on a country whose feed had already loaded.
  it("does not wait on scores the feed hides once the backend is drained", () => {
    expect(showsSkeletons({
      displayableCount: 7,
      selectedCountry: "CW",
      liveTrackerTotal: 9,
      drained: true,
    })).toBe(false);

    // The same feed before the snapshot proves the backend is drained: the
    // floor is still correct there, since more scores may yet arrive.
    expect(showsSkeletons({
      displayableCount: 7,
      selectedCountry: "CW",
      liveTrackerTotal: 9,
      drained: false,
    })).toBe(true);

    expect(getTrackerWindowCount({
      displayableCount: 7,
      selectedCountry: "CW",
      liveTrackerTotal: 9,
      liveFilteredTotal: null,
      liveBackendEnabled: true,
      hasActiveScoreFilters: false,
      useLiveBackendFilteredScores: false,
      drained: true,
    })).toBe(7);
  });

  // The floor still has to apply while the backend has more to give, otherwise
  // pagination collapses to whatever the first snapshot happened to return.
  it("keeps the backend total as a floor until the feed is drained", () => {
    expect(getTrackerWindowCount({
      displayableCount: 90,
      selectedCountry: "US",
      liveTrackerTotal: 400,
      liveFilteredTotal: null,
      liveBackendEnabled: true,
      hasActiveScoreFilters: false,
      useLiveBackendFilteredScores: false,
      drained: false,
    })).toBe(400);
  });

  // A big country hits the page-size cap long before the hidden-score gap
  // matters, which is why this only ever showed up on tiny countries.
  it("is unaffected on a country with more than a page of scores", () => {
    expect(showsSkeletons({
      displayableCount: 120,
      selectedCountry: "US",
      liveTrackerTotal: 500,
      drained: false,
    })).toBe(false);
  });

  it("still paginates a drained country across multiple pages", () => {
    const trackerWindowCount = getTrackerWindowCount({
      displayableCount: 100,
      selectedCountry: "CR",
      liveTrackerTotal: 104,
      liveFilteredTotal: null,
      liveBackendEnabled: true,
      hasActiveScoreFilters: false,
      useLiveBackendFilteredScores: false,
      drained: true,
    });
    expect(trackerWindowCount).toBe(100);
    expect(Math.ceil(trackerWindowCount / TRACKER_PAGE_SIZE)).toBe(3);
    expect(getRequiredScoreCountForPage({
      currentPage: 2,
      trackerWindowCount,
      liveBackendEnabled: true,
      hasActiveScoreFilters: false,
    })).toBe(100);
  });

  it("defers to the backend-filtered total when filters run server-side", () => {
    expect(getTrackerWindowCount({
      displayableCount: 0,
      selectedCountry: "US",
      liveTrackerTotal: 500,
      liveFilteredTotal: 12,
      liveBackendEnabled: true,
      hasActiveScoreFilters: true,
      useLiveBackendFilteredScores: true,
      drained: false,
    })).toBe(12);
  });
});
