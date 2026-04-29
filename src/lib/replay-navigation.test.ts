import { describe, expect, test } from "vitest";
import { getReplayBackNavigation, getReplaySearch } from "./replay-navigation";

describe("getReplayBackNavigation", () => {
  test("uses browser history when the replay page has an in-app previous entry", () => {
    expect(getReplayBackNavigation({ canGoBack: true })).toEqual({ type: "history" });
  });

  test("falls back to the replay player browser when there is no previous entry", () => {
    expect(getReplayBackNavigation({ canGoBack: false, playerParam: "Aleju03" })).toEqual({
      type: "route",
      search: { player: "Aleju03" },
    });
  });

  test("falls back to the beatmap browser tab when opened directly from beatmap mode", () => {
    expect(getReplayBackNavigation({ canGoBack: false, tab: "beatmap" })).toEqual({
      type: "route",
      search: { tab: "beatmap" },
    });
  });

  test("falls back to the replay landing browser for direct score URLs", () => {
    expect(getReplayBackNavigation({ canGoBack: false })).toEqual({
      type: "route",
      search: {},
    });
  });
});

describe("getReplaySearch", () => {
  test("creates typed replay search params for score links", () => {
    expect(getReplaySearch(6542962488, 2513401)).toEqual({
      scoreId: 6542962488,
      beatmapsetId: 2513401,
    });
  });

  test("omits missing beatmapset ids", () => {
    expect(getReplaySearch(6542962488, undefined)).toEqual({
      scoreId: 6542962488,
      beatmapsetId: undefined,
    });
  });
});
